import {
  deleteAccount,
  getAccountSession,
  logoutAccount,
  logoutAllAccounts,
  updateAccountProfile,
  AccountApiError,
  type AccountDeletionResult,
  type AccountProfile,
  type AccountSessionResponse,
} from './api.ts';
import {
  applyAccountSession,
  setAccountAnonymous,
  setAccountLoading,
  setAccountUnavailable,
} from './state.ts';
import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';

let _operationGeneration = 0;
let _sessionFence = 0;
let _refreshInFlight: Promise<void> | null = null;
let _refreshFollowUp = false;
let _explicitRecoveryInFlight: Promise<void> | null = null;
let _explicitRecoveryWaitingForFreshRead = false;
let _explicitRecoveryPreClickGeneration: number | null = null;
let _externalRefreshInFlight: Promise<void> | null = null;
let _externalRefreshFollowUp = false;
const _recentExternalRefreshIds = new Set<string>();
const _accountLoginResultOperations = new Map<string, Promise<AccountSessionResponse>>();
const _activeAccountLoginResultIds = new Set<string>();
const _pendingAccountLoginResultIds: string[] = [];
const _pendingAccountLoginResultResolvers = new Map<
  string,
  {
    resolve: (response: AccountSessionResponse) => void;
    reject: (error: unknown) => void;
  }
>();
const _pendingAccountLoginResultBatches: Array<{
  pendingResults: Array<{
    resolve: (response: AccountSessionResponse) => void;
    reject: (error: unknown) => void;
  }>;
}> = [];
let _accountLoginResultBatchInFlight = false;
let _mutationDepth = 0;
let _lastRefreshStartedAt = 0;
let _lifecycleBound = false;
let _syncChannel: BroadcastChannel | null = null;
let _recoveryTimer: number | null = null;
let _recoveryAttempt = 0;
let _recoveryNeeded = false;
let _recoveryNotBefore = 0;

const ACCOUNT_REFRESH_DEBOUNCE_MS = 30_000;
const ACCOUNT_RECOVERY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const ACCOUNT_RECOVERY_TAIL_DELAY_MS = 60_000;
const ACCOUNT_RECOVERY_JITTER_MAX_MS = 1_000;
const ACCOUNT_SYNC_CHANNEL = 'mxqr-account-v1';
const ACCOUNT_SYNC_STORAGE_KEY = 'mxqr-account-refresh';
const MAX_RECENT_EXTERNAL_REFRESH_IDS = 32;

type AccountRefreshPulse = Readonly<{ id: string | null; loginSuccess: boolean }>;

function observeAccountSessionOperation(
  operation: Promise<unknown> | null | undefined,
  source: string,
): void {
  if (!operation) return;
  operation.catch((error) => {
    log.warn(`[Account] ${source} reconciliation failed`, error);
  });
}

export type AccountLoginPopupOutcome =
  | 'authenticated'
  | 'profile-incomplete'
  | 'cancelled'
  | 'error'
  | 'blocked';

export type AccountLoginPopupOptions = {
  /**
   * Return the authenticated-but-incomplete account to the caller instead of
   * opening the ordinary first-login nickname flow. Bound claims can use this
   * to explain that the user selected an identity other than the pre-existing
   * account named by the claim.
   */
  acceptIncompleteProfile?: boolean;
  /** Open Google's account chooser even when this tab already has a session. */
  forceGoogleAccountChooser?: boolean;
};

type AccountLoginPopupHandler = (
  options?: Readonly<AccountLoginPopupOptions>,
) => Promise<AccountLoginPopupOutcome>;
let _accountLoginPopupHandler: AccountLoginPopupHandler | null = null;

/**
 * Register the UI-owned OAuth popup implementation behind an account-layer
 * bridge. Security-sensitive room flows can invoke it from a real user gesture
 * without importing a UI module back into the PRO domain.
 */
export function setAccountLoginPopupHandler(handler: AccountLoginPopupHandler): void {
  _accountLoginPopupHandler = handler;
}

export function requestAccountLoginPopup(
  options?: Readonly<AccountLoginPopupOptions>,
): Promise<AccountLoginPopupOutcome> {
  return _accountLoginPopupHandler?.(options) ?? Promise.resolve('error');
}

function parseAccountRefreshMessage(value: unknown): AccountRefreshPulse | null {
  if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'refresh') {
    return null;
  }
  const id = (value as { id?: unknown }).id;
  return {
    id: typeof id === 'string' && id.length >= 8 && id.length <= 160 ? id : null,
    loginSuccess: (value as { accountAuth?: unknown }).accountAuth === 'success',
  };
}

function createAccountRefreshMessage(): { type: 'refresh'; id: string } {
  return {
    type: 'refresh',
    id: `refresh:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
  };
}

function trimRecentExternalRefreshIds(): void {
  while (_recentExternalRefreshIds.size > MAX_RECENT_EXTERNAL_REFRESH_IDS) {
    const evictable = [..._recentExternalRefreshIds].find(
      (refreshId) => !_activeAccountLoginResultIds.has(refreshId),
    );
    if (!evictable) return;
    _recentExternalRefreshIds.delete(evictable);
    _accountLoginResultOperations.delete(evictable);
  }
}

function rememberExternalRefreshId(id: string | null): boolean {
  if (id === null) return true;
  if (_recentExternalRefreshIds.has(id)) return false;
  _recentExternalRefreshIds.add(id);
  trimRecentExternalRefreshIds();
  return true;
}

function broadcastAccountChange(): void {
  const message = createAccountRefreshMessage();
  try {
    _syncChannel?.postMessage(message);
  } catch {
    // Cross-tab refresh is an optimization. The HttpOnly session remains the
    // authority and will be checked on the next navigation/focus.
  }
  try {
    // BroadcastChannel is absent in some older WebViews/private contexts.
    // Storage events do not fire in this tab (which already applied the
    // mutation) but wake every other same-origin tab through the listener
    // registered below. The pulse carries no account data.
    window.localStorage.setItem(ACCOUNT_SYNC_STORAGE_KEY, JSON.stringify(message));
  } catch {
    // Storage may be disabled. Focus/visibility refresh remains the fallback.
  }
}

function clearAccountRecoveryTimer(): void {
  if (_recoveryTimer !== null) window.clearTimeout(_recoveryTimer);
  _recoveryTimer = null;
}

function clearAccountRecovery(): void {
  clearAccountRecoveryTimer();
  _recoveryAttempt = 0;
  _recoveryNeeded = false;
  _recoveryNotBefore = 0;
}

function canRunAccountRecovery(): boolean {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function isTransientAccountReadError(error: unknown): boolean {
  return (
    !(error instanceof AccountApiError) ||
    error.status === 0 ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500
  );
}

function rememberAccountRetryAfter(error: unknown): void {
  if (
    !(error instanceof AccountApiError) ||
    typeof error.retryAfterMs !== 'number' ||
    !Number.isSafeInteger(error.retryAfterMs) ||
    error.retryAfterMs <= 0
  ) {
    return;
  }
  const jitterMs = Math.floor(Math.random() * ACCOUNT_RECOVERY_JITTER_MAX_MS);
  _recoveryNotBefore = Math.max(_recoveryNotBefore, Date.now() + error.retryAfterMs + jitterMs);
}

function scheduleAccountRecovery(): void {
  clearAccountRecoveryTimer();
  if (!_recoveryNeeded) return;
  if (_explicitRecoveryWaitingForFreshRead) return;
  if (!canRunAccountRecovery()) return;

  const retryAfterDelay = Math.max(0, _recoveryNotBefore - Date.now());
  let delay = retryAfterDelay;
  if (delay === 0) {
    if (_recoveryAttempt < ACCOUNT_RECOVERY_DELAYS_MS.length) {
      delay = ACCOUNT_RECOVERY_DELAYS_MS[_recoveryAttempt]!;
      _recoveryAttempt += 1;
    } else {
      delay = ACCOUNT_RECOVERY_TAIL_DELAY_MS;
    }
  }
  _recoveryTimer = window.setTimeout(() => {
    _recoveryTimer = null;
    if (!_recoveryNeeded) return;
    if (!canRunAccountRecovery()) return;
    observeAccountSessionOperation(refreshAccountSession(false, false), 'scheduled recovery');
  }, delay);
}

function markAccountReadFailed(error: unknown): void {
  if (!isTransientAccountReadError(error)) {
    clearAccountRecovery();
    return;
  }
  _recoveryNeeded = true;
  rememberAccountRetryAfter(error);
  scheduleAccountRecovery();
}

function applyAccountReadFailure(error: unknown): void {
  // Keep the explicit Retry projection on loading while an older read drains.
  // This includes non-transient failures: they describe the pre-click request,
  // not the fresh request the user explicitly asked us to make.
  const belongsToPreClickRead =
    _explicitRecoveryWaitingForFreshRead &&
    _explicitRecoveryPreClickGeneration === _operationGeneration;
  if (!belongsToPreClickRead) setAccountUnavailable();
  markAccountReadFailed(error);
}

function requestImmediateAccountRecovery(
  resetBudget: boolean,
  showLoading = false,
  forceNetworkAttempt = false,
): Promise<void> {
  if (!_recoveryNeeded) return Promise.resolve();
  if (_explicitRecoveryWaitingForFreshRead && !forceNetworkAttempt) {
    return _explicitRecoveryInFlight ?? Promise.resolve();
  }
  if (resetBudget) _recoveryAttempt = 0;
  clearAccountRecoveryTimer();
  if (!forceNetworkAttempt && !canRunAccountRecovery()) return Promise.resolve();
  if (!forceNetworkAttempt && _recoveryNotBefore > Date.now()) {
    scheduleAccountRecovery();
    return Promise.resolve();
  }
  return refreshAccountSession(showLoading, false);
}

async function runExplicitAccountRecovery(
  sessionFence: number,
  operationGenerationAtClick: number,
  pendingRefreshAtClick: Promise<void> | null,
): Promise<void> {
  // A click may arrive while an automatic/focus read is still consuming its
  // five-second deadline. Joining that request made Retry appear broken: its
  // already-doomed result was returned to the UI and only the later backoff
  // could recover. Wait for the pre-click ordinary read to leave the slot,
  // then make one genuinely fresh bounded read.
  if (pendingRefreshAtClick) await pendingRefreshAtClick;
  // The explicit intent or any newer authoritative operation supersedes a
  // generic follow-up queued behind the pre-click read. Leaving it armed could
  // start after this function returns and incorrectly fence that newer work.
  _refreshFollowUp = false;

  // A lifecycle reset cancels this intent. A popup, cross-tab pulse, or
  // account mutation begun after the click is newer authoritative work and
  // owns the visible result instead; never let this older Retry fence it.
  if (sessionFence !== _sessionFence || operationGenerationAtClick !== _operationGeneration) {
    return;
  }

  _explicitRecoveryWaitingForFreshRead = false;
  // The pre-click read may have failed non-transiently and cleared automatic
  // recovery. Explicit user intent is independent of that classification and
  // still guarantees one genuinely fresh bounded read.
  _recoveryNeeded = true;
  // A failure from the request we waited behind may have consumed a backoff
  // step. Reset at the moment this fresh user-requested read starts so its own
  // failure restarts the bounded 1s / 3s / 10s recovery sequence.
  await requestImmediateAccountRecovery(true, true, true);
}

function refreshAfterUserReturns(): void {
  if (_recoveryNeeded) {
    observeAccountSessionOperation(requestImmediateAccountRecovery(false), 'foreground recovery');
    return;
  }
  if (Date.now() - _lastRefreshStartedAt < ACCOUNT_REFRESH_DEBOUNCE_MS) return;
  observeAccountSessionOperation(refreshAccountSession(true, false), 'foreground refresh');
}

function refreshAfterPopupMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) return;
  const pulse = parseAccountRefreshMessage(event.data);
  if (pulse) reconcileExternalAccountChange(pulse.id, pulse.loginSuccess);
}

function refreshAfterStoragePulse(event: StorageEvent): void {
  if (event.key !== ACCOUNT_SYNC_STORAGE_KEY) return;
  let pulse: AccountRefreshPulse | null = null;
  if (event.newValue) {
    try {
      pulse = parseAccountRefreshMessage(JSON.parse(event.newValue) as unknown);
    } catch {
      // Older clients stored an opaque token rather than the pulse payload.
    }
  }
  reconcileExternalAccountChange(pulse?.id ?? null, pulse?.loginSuccess === true);
}

function refreshAfterVisibilityChange(): void {
  if (document.visibilityState === 'visible') refreshAfterUserReturns();
}

function refreshAfterOnline(): void {
  observeAccountSessionOperation(requestImmediateAccountRecovery(true), 'online recovery');
}

function refreshAfterPageShow(): void {
  refreshAfterUserReturns();
}

function refreshAfterBroadcastMessage(event: MessageEvent): void {
  const pulse = parseAccountRefreshMessage(event.data);
  if (pulse) reconcileExternalAccountChange(pulse.id, pulse.loginSuccess);
}

/**
 * A popup/cross-tab pulse is evidence that the cookie may have changed after
 * an already-running session read began. It must therefore get a new
 * operation generation immediately instead of waiting behind that older read:
 * applying the older anonymous snapshot even briefly also tears down the
 * room-scoped account identity and its same-account device capabilities.
 */
function startExternalAccountReconciliation(): void {
  const operation = reconcileAccountLoginSession().then(
    () => undefined,
    () => undefined,
  );
  const wrapped = operation.finally(() => {
    if (_externalRefreshInFlight !== wrapped) return;
    _externalRefreshInFlight = null;
    if (!_externalRefreshFollowUp) return;
    _externalRefreshFollowUp = false;
    startExternalAccountReconciliation();
  });
  _externalRefreshInFlight = wrapped;
}

function reconcileExternalAccountChange(refreshId: string | null, loginSuccess = false): void {
  if (refreshId !== null && loginSuccess) {
    // Identified pulses can arrive through the UI and session listeners in
    // either order (and in separate tasks for BroadcastChannel/storage). Keep
    // one bounded, replayable operation per nonce so every consumer observes
    // the same authoritative response without starting another request.
    observeAccountSessionOperation(reconcileAccountLoginResult(refreshId), 'login-result');
    return;
  }
  if (!rememberExternalRefreshId(refreshId)) return;
  if (_mutationDepth > 0) {
    _refreshFollowUp = true;
    return;
  }
  if (_externalRefreshInFlight) {
    // A new identified pulse represents a genuinely later account change, so
    // fence the older read. Legacy clients did not include an ID: preserve
    // that first post-cookie result, then reconcile once more, because their
    // opener/BroadcastChannel/storage copies cannot be distinguished safely.
    if (refreshId !== null) _operationGeneration += 1;
    _externalRefreshFollowUp = true;
    return;
  }
  startExternalAccountReconciliation();
}

function bindAccountSessionLifecycle(): void {
  if (_lifecycleBound || typeof window === 'undefined' || typeof document === 'undefined') return;
  _lifecycleBound = true;
  window.addEventListener('focus', refreshAfterUserReturns);
  window.addEventListener('online', refreshAfterOnline);
  window.addEventListener('pageshow', refreshAfterPageShow);
  window.addEventListener('message', refreshAfterPopupMessage);
  window.addEventListener('storage', refreshAfterStoragePulse);
  document.addEventListener('visibilitychange', refreshAfterVisibilityChange);
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      _syncChannel = new BroadcastChannel(ACCOUNT_SYNC_CHANNEL);
      _syncChannel.addEventListener('message', refreshAfterBroadcastMessage);
    } catch {
      _syncChannel = null;
    }
  }
}

export function startAccountSessionRefresh(): void {
  bindAccountSessionLifecycle();
  observeAccountSessionOperation(refreshAccountSession(), 'startup');
}

/** Retry an unavailable account read from an explicit user action. */
export function retryAccountSessionRefresh(): Promise<void> {
  _recoveryNeeded = true;
  if (_explicitRecoveryInFlight) return _explicitRecoveryInFlight;
  // navigator.onLine is only a network-interface hint and can remain false
  // after WebKit's radio path has recovered. A user-requested retry is already
  // bounded by the five-second session-read deadline, so always make one real
  // attempt while automatic background retries continue to respect offline.
  clearAccountRecoveryTimer();
  setAccountLoading();
  _explicitRecoveryWaitingForFreshRead = true;
  _explicitRecoveryPreClickGeneration = _operationGeneration;
  const operation = runExplicitAccountRecovery(
    _sessionFence,
    _operationGeneration,
    _refreshInFlight,
  );
  const wrapped = operation.finally(() => {
    if (_explicitRecoveryInFlight !== wrapped) return;
    _explicitRecoveryInFlight = null;
    _explicitRecoveryWaitingForFreshRead = false;
    _explicitRecoveryPreClickGeneration = null;
    drainRefreshFollowUp();
    // A newer external reconciliation can fail transiently while the explicit
    // intent is still holding automatic work. Re-arm the bounded recovery once
    // that hold is released; a fresh explicit failure already owns a timer.
    if (_recoveryNeeded && _recoveryTimer === null) scheduleAccountRecovery();
  });
  _explicitRecoveryInFlight = wrapped;
  return wrapped;
}

/**
 * Read the cookie session after an OAuth popup has demonstrably completed.
 * This request receives a fresh operation generation, so any older focus or
 * BroadcastChannel refresh cannot overwrite its result. The response is also
 * returned to the popup owner so it can classify this exact post-completion
 * read even if a still-newer, equally authoritative refresh starts later.
 */
export async function reconcileAccountLoginSession(): Promise<AccountSessionResponse> {
  // A popup/cross-tab reconciliation is already the authoritative recovery
  // attempt. Do not let an older backoff timer start a competing generation
  // and fence this exact post-login response.
  clearAccountRecoveryTimer();
  const generation = ++_operationGeneration;
  const sessionFence = _sessionFence;
  _lastRefreshStartedAt = Date.now();
  try {
    const response = await getAccountSession();
    if (sessionFence === _sessionFence && generation === _operationGeneration) {
      clearAccountRecovery();
      applyAccountSession(response);
    }
    return response;
  } catch (error) {
    if (sessionFence === _sessionFence && generation === _operationGeneration) {
      applyAccountReadFailure(error);
    }
    throw error;
  }
}

/**
 * Reconcile one identified OAuth completion exactly once across the account
 * session lifecycle and UI. Duplicate opener/BroadcastChannel/storage copies
 * share this promise, so callers can classify the same authoritative result
 * without issuing or racing a second session read.
 */
export function reconcileAccountLoginResult(
  refreshId: string,
): Promise<AccountSessionResponse> | null {
  // A same-tab OAuth return enters through this path without the ordinary
  // startup refresh. It still needs all later focus/online/cross-tab hooks.
  bindAccountSessionLifecycle();
  const existing = _accountLoginResultOperations.get(refreshId);
  if (existing) return existing;
  // Protect this nonce before the bounded recent-ID set trims. Otherwise the
  // newly added 33rd concurrent result is the only apparently inactive entry
  // and can evict itself before its shared promise is published.
  _activeAccountLoginResultIds.add(refreshId);
  if (!rememberExternalRefreshId(refreshId)) {
    _activeAccountLoginResultIds.delete(refreshId);
    return null;
  }
  let operation: Promise<AccountSessionResponse>;
  if (_mutationDepth > 0) {
    // The mutation owns both the cookie transition and visible projection.
    // Delay the post-OAuth read until its finally block releases that boundary
    // while still publishing one promise immediately to every result listener.
    operation = new Promise<AccountSessionResponse>((resolve, reject) => {
      _pendingAccountLoginResultIds.push(refreshId);
      _pendingAccountLoginResultResolvers.set(refreshId, { resolve, reject });
    });
  } else {
    operation = reconcileAccountLoginSession();
  }
  _accountLoginResultOperations.set(refreshId, operation);
  void operation.then(
    () => {
      _activeAccountLoginResultIds.delete(refreshId);
      trimRecentExternalRefreshIds();
    },
    () => {
      _activeAccountLoginResultIds.delete(refreshId);
      trimRecentExternalRefreshIds();
    },
  );
  // A lifecycle listener has no response consumer of its own. Retain the raw
  // promise for the UI result listener, but always attach a rejection handler
  // here so an offline completion cannot become an unhandled rejection.
  void operation.catch(() => undefined);
  return operation;
}

function drainPendingAccountLoginResults(): void {
  if (_mutationDepth > 0) return;
  const pendingResults: Array<{
    resolve: (response: AccountSessionResponse) => void;
    reject: (error: unknown) => void;
  }> = [];
  while (_pendingAccountLoginResultIds.length > 0) {
    const refreshId = _pendingAccountLoginResultIds.shift()!;
    const pending = _pendingAccountLoginResultResolvers.get(refreshId);
    if (!pending) continue;
    _pendingAccountLoginResultResolvers.delete(refreshId);
    pendingResults.push(pending);
  }
  if (pendingResults.length === 0) return;
  // All success pulses observed during one mutation describe the cookie state
  // after that same serialization boundary. One exact read resolves the whole
  // batch and supersedes any generic refresh queued while the mutation ran.
  _refreshFollowUp = false;
  _pendingAccountLoginResultBatches.push({
    pendingResults,
  });
  drainAccountLoginResultBatches();
}

function drainAccountLoginResultBatches(): void {
  if (_accountLoginResultBatchInFlight || _mutationDepth > 0) return;
  const batch = _pendingAccountLoginResultBatches.shift();
  if (!batch) return;
  _accountLoginResultBatchInFlight = true;
  void reconcileAccountLoginSession()
    .then(
      (response) => {
        for (const pending of batch.pendingResults) pending.resolve(response);
      },
      (error) => {
        for (const pending of batch.pendingResults) pending.reject(error);
      },
    )
    .finally(() => {
      _accountLoginResultBatchInFlight = false;
      drainAccountLoginResultBatches();
    });
}

function drainRefreshFollowUp(): void {
  if (
    !_refreshFollowUp ||
    _explicitRecoveryWaitingForFreshRead ||
    _mutationDepth > 0 ||
    _refreshInFlight
  ) {
    return;
  }
  _refreshFollowUp = false;
  // A completed mutation already supplied the visible authoritative state.
  // Reconcile any refresh requested during it without flashing that state back
  // to "loading" while the post-mutation cookie check is in flight.
  observeAccountSessionOperation(refreshAccountSession(false), 'post-mutation follow-up');
}

function refreshAccountSession(showLoading = true, followUpIfBusy = true): Promise<void> {
  if (_mutationDepth > 0) {
    _refreshFollowUp = true;
    return Promise.resolve();
  }
  if (_refreshInFlight) {
    if (followUpIfBusy) _refreshFollowUp = true;
    return _refreshInFlight;
  }
  clearAccountRecoveryTimer();
  _lastRefreshStartedAt = Date.now();
  const generation = ++_operationGeneration;
  const sessionFence = _sessionFence;
  if (showLoading) setAccountLoading();
  const operation = (async () => {
    try {
      const response = await getAccountSession();
      if (sessionFence !== _sessionFence || generation !== _operationGeneration) return;
      clearAccountRecovery();
      applyAccountSession(response);
    } catch (error) {
      if (sessionFence !== _sessionFence || generation !== _operationGeneration) return;
      applyAccountReadFailure(error);
    }
  })();
  const wrapped = operation.finally(() => {
    if (_refreshInFlight !== wrapped) return;
    _refreshInFlight = null;
    drainRefreshFollowUp();
  });
  _refreshInFlight = wrapped;
  return wrapped;
}

export async function saveAccountNickname(nickname: string): Promise<AccountProfile> {
  const generation = ++_operationGeneration;
  const sessionFence = _sessionFence;
  _mutationDepth += 1;
  try {
    const response = await updateAccountProfile(nickname);
    if (!response.authenticated || !response.account) throw new Error('ACCOUNT_INVALID_RESPONSE');
    clearAccountRecovery();
    if (sessionFence === _sessionFence && generation === _operationGeneration) {
      applyAccountSession(response);
    }
    broadcastAccountChange();
    return response.account;
  } finally {
    _mutationDepth -= 1;
    drainPendingAccountLoginResults();
    drainRefreshFollowUp();
  }
}

export async function signOutAccount(everywhere = false): Promise<void> {
  const generation = ++_operationGeneration;
  const sessionFence = _sessionFence;
  _mutationDepth += 1;
  try {
    if (everywhere) await logoutAllAccounts();
    else await logoutAccount();
    clearAccountRecovery();
    if (sessionFence === _sessionFence && generation === _operationGeneration) {
      setAccountAnonymous(true);
    }
    broadcastAccountChange();
  } finally {
    _mutationDepth -= 1;
    drainPendingAccountLoginResults();
    drainRefreshFollowUp();
  }
}

export async function removeAccount(): Promise<AccountDeletionResult> {
  const generation = ++_operationGeneration;
  const sessionFence = _sessionFence;
  _mutationDepth += 1;
  try {
    const result = await deleteAccount();
    clearAccountRecovery();
    if (sessionFence === _sessionFence && generation === _operationGeneration) {
      if (result.pending) bus.emit('account:deletion-pending');
      else bus.emit('account:deleted');
      setAccountAnonymous(true);
    }
    broadcastAccountChange();
    return result;
  } finally {
    _mutationDepth -= 1;
    drainPendingAccountLoginResults();
    drainRefreshFollowUp();
  }
}

/** Reset async coordination only after every mocked request has settled. */
export function __resetAccountSessionForTests(): void {
  if (_lifecycleBound && typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.removeEventListener('focus', refreshAfterUserReturns);
    window.removeEventListener('online', refreshAfterOnline);
    window.removeEventListener('pageshow', refreshAfterPageShow);
    window.removeEventListener('message', refreshAfterPopupMessage);
    window.removeEventListener('storage', refreshAfterStoragePulse);
    document.removeEventListener('visibilitychange', refreshAfterVisibilityChange);
  }
  try {
    _syncChannel?.removeEventListener('message', refreshAfterBroadcastMessage);
    _syncChannel?.close();
  } catch {
    // A mocked or already-closed channel is harmless during test teardown.
  }
  _syncChannel = null;
  clearAccountRecovery();
  _lifecycleBound = false;
  // Never reset an async generation to a reusable value: a late operation
  // from the previous lifecycle could otherwise collide with generation 1 of
  // the next lifecycle and overwrite the fresh account state.
  _sessionFence += 1;
  _operationGeneration += 1;
  _refreshInFlight = null;
  _refreshFollowUp = false;
  _explicitRecoveryInFlight = null;
  _explicitRecoveryWaitingForFreshRead = false;
  _explicitRecoveryPreClickGeneration = null;
  _externalRefreshInFlight = null;
  _externalRefreshFollowUp = false;
  _recentExternalRefreshIds.clear();
  _accountLoginResultOperations.clear();
  _activeAccountLoginResultIds.clear();
  _pendingAccountLoginResultIds.length = 0;
  _pendingAccountLoginResultResolvers.clear();
  _pendingAccountLoginResultBatches.length = 0;
  _accountLoginResultBatchInFlight = false;
  _mutationDepth = 0;
  _lastRefreshStartedAt = 0;
}
