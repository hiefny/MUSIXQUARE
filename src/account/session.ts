import {
  deleteAccount,
  getAccountSession,
  logoutAccount,
  logoutAllAccounts,
  updateAccountProfile,
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

let _operationGeneration = 0;
let _sessionFence = 0;
let _refreshInFlight: Promise<void> | null = null;
let _refreshFollowUp = false;
let _externalRefreshInFlight: Promise<void> | null = null;
let _externalRefreshFollowUp = false;
const _recentExternalRefreshIds = new Set<string>();
let _mutationDepth = 0;
let _lastRefreshStartedAt = 0;
let _lifecycleBound = false;
let _syncChannel: BroadcastChannel | null = null;

const ACCOUNT_REFRESH_DEBOUNCE_MS = 30_000;
const ACCOUNT_SYNC_CHANNEL = 'mxqr-account-v1';
const ACCOUNT_SYNC_STORAGE_KEY = 'mxqr-account-refresh';
const MAX_RECENT_EXTERNAL_REFRESH_IDS = 32;

type AccountRefreshPulse = Readonly<{ id: string | null }>;

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
  };
}

function createAccountRefreshMessage(): { type: 'refresh'; id: string } {
  return {
    type: 'refresh',
    id: `refresh:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
  };
}

function rememberExternalRefreshId(id: string | null): boolean {
  if (id === null) return true;
  if (_recentExternalRefreshIds.has(id)) return false;
  _recentExternalRefreshIds.add(id);
  if (_recentExternalRefreshIds.size > MAX_RECENT_EXTERNAL_REFRESH_IDS) {
    const oldest = _recentExternalRefreshIds.values().next().value;
    if (typeof oldest === 'string') _recentExternalRefreshIds.delete(oldest);
  }
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

function refreshAfterUserReturns(): void {
  if (Date.now() - _lastRefreshStartedAt < ACCOUNT_REFRESH_DEBOUNCE_MS) return;
  void refreshAccountSession();
}

function refreshAfterPopupMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) return;
  const pulse = parseAccountRefreshMessage(event.data);
  if (pulse) reconcileExternalAccountChange(pulse.id);
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
  reconcileExternalAccountChange(pulse?.id ?? null);
}

function refreshAfterVisibilityChange(): void {
  if (document.visibilityState === 'visible') refreshAfterUserReturns();
}

function refreshAfterBroadcastMessage(event: MessageEvent): void {
  const pulse = parseAccountRefreshMessage(event.data);
  if (pulse) reconcileExternalAccountChange(pulse.id);
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

function reconcileExternalAccountChange(refreshId: string | null): void {
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
  void refreshAccountSession();
}

/**
 * Read the cookie session after an OAuth popup has demonstrably completed.
 * This request receives a fresh operation generation, so any older focus or
 * BroadcastChannel refresh cannot overwrite its result. The response is also
 * returned to the popup owner so it can classify this exact post-completion
 * read even if a still-newer, equally authoritative refresh starts later.
 */
export async function reconcileAccountLoginSession(): Promise<AccountSessionResponse> {
  const generation = ++_operationGeneration;
  const sessionFence = _sessionFence;
  _lastRefreshStartedAt = Date.now();
  try {
    const response = await getAccountSession();
    if (sessionFence === _sessionFence && generation === _operationGeneration) {
      applyAccountSession(response);
    }
    return response;
  } catch (error) {
    if (sessionFence === _sessionFence && generation === _operationGeneration) {
      setAccountUnavailable();
    }
    throw error;
  }
}

function drainRefreshFollowUp(): void {
  if (!_refreshFollowUp || _mutationDepth > 0 || _refreshInFlight) return;
  _refreshFollowUp = false;
  // A completed mutation already supplied the visible authoritative state.
  // Reconcile any refresh requested during it without flashing that state back
  // to "loading" while the post-mutation cookie check is in flight.
  void refreshAccountSession(false);
}

function refreshAccountSession(showLoading = true): Promise<void> {
  if (_mutationDepth > 0) {
    _refreshFollowUp = true;
    return Promise.resolve();
  }
  if (_refreshInFlight) {
    _refreshFollowUp = true;
    return _refreshInFlight;
  }
  _lastRefreshStartedAt = Date.now();
  const generation = ++_operationGeneration;
  const sessionFence = _sessionFence;
  if (showLoading) setAccountLoading();
  const operation = (async () => {
    try {
      const response = await getAccountSession();
      if (sessionFence !== _sessionFence || generation !== _operationGeneration) return;
      applyAccountSession(response);
    } catch {
      if (sessionFence !== _sessionFence || generation !== _operationGeneration) return;
      setAccountUnavailable();
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
    if (sessionFence === _sessionFence && generation === _operationGeneration) {
      applyAccountSession(response);
    }
    broadcastAccountChange();
    return response.account;
  } finally {
    _mutationDepth -= 1;
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
    if (sessionFence === _sessionFence && generation === _operationGeneration) {
      setAccountAnonymous(true);
    }
    broadcastAccountChange();
  } finally {
    _mutationDepth -= 1;
    drainRefreshFollowUp();
  }
}

export async function removeAccount(): Promise<AccountDeletionResult> {
  const generation = ++_operationGeneration;
  const sessionFence = _sessionFence;
  _mutationDepth += 1;
  try {
    const result = await deleteAccount();
    if (sessionFence === _sessionFence && generation === _operationGeneration) {
      if (result.pending) bus.emit('account:deletion-pending');
      else bus.emit('account:deleted');
      setAccountAnonymous(true);
    }
    broadcastAccountChange();
    return result;
  } finally {
    _mutationDepth -= 1;
    drainRefreshFollowUp();
  }
}

/** Reset async coordination only after every mocked request has settled. */
export function __resetAccountSessionForTests(): void {
  if (_lifecycleBound && typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.removeEventListener('focus', refreshAfterUserReturns);
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
  _lifecycleBound = false;
  // Never reset an async generation to a reusable value: a late operation
  // from the previous lifecycle could otherwise collide with generation 1 of
  // the next lifecycle and overwrite the fresh account state.
  _sessionFence += 1;
  _operationGeneration += 1;
  _refreshInFlight = null;
  _refreshFollowUp = false;
  _externalRefreshInFlight = null;
  _externalRefreshFollowUp = false;
  _recentExternalRefreshIds.clear();
  _mutationDepth = 0;
  _lastRefreshStartedAt = 0;
}
