/** Optional Google account UI. Authentication never gates room playback. */

import { bus, createBusScope } from '../core/events.ts';
import {
  buildGoogleLoginUrl,
  getAccountStats,
  type AccountSessionResponse,
  type AccountStats,
} from '../account/api.ts';
import { flushAccountActivityStatsForRead } from '../account/activity-stats.ts';
import {
  getAccountStatsScope,
  getAccountSnapshot,
  isAccountAuthenticated,
  subscribeAccount,
  type AccountSnapshot,
} from '../account/state.ts';
import {
  removeAccount,
  reconcileAccountLoginSession,
  reconcileAccountLoginResult,
  retryAccountSessionRefresh,
  setAccountLoginPopupHandler,
  signOutAccount,
  startAccountSessionRefresh,
  type AccountLoginPopupOptions,
  type AccountLoginPopupOutcome,
} from '../account/session.ts';
import {
  accountNicknameMutationErrorMessage,
  ACCOUNT_NICKNAME_MAX_CODE_POINTS,
  isAccountNicknameTakenError,
  updateCurrentAccountNickname,
  validateAccountNickname,
} from '../account/nickname.ts';
import {
  clearAccountLoginReturn,
  rememberAccountLoginReturn,
  restoreAccountLoginReturnPath,
  sanitizeAccountLoginReturnPath,
} from '../account/login-return.ts';
import { clearIntentionalNav, markIntentionalNav } from '../core/page-lifecycle.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { getResolvedLanguage, t } from '../i18n/index.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { showDialog } from './dialog.ts';
import { syncOverlayState } from './dom.ts';
import { showToast } from './toast.ts';
import { applyUserTextFontFallback } from './user-text-font.ts';

const _busScope = createBusScope();
const ACCOUNT_COMPLETION_PATH = '/account-complete.html';
const ACCOUNT_SYNC_CHANNEL = 'mxqr-account-v1';
const ACCOUNT_SYNC_STORAGE_KEY = 'mxqr-account-refresh';
const ACCOUNT_SAME_TAB_WELCOME_INTENT_KEY = 'mxqr-account-welcome-intent-v1';
const ACCOUNT_SAME_TAB_WELCOME_INTENT_TTL_MS = 10 * 60 * 1000;
const ACCOUNT_LOGIN_POPUP_POLL_MS = 250;
const ACCOUNT_STATS_PLACEHOLDER = '—';
const ACCOUNT_STATS_COUNT_UP_DURATION_MS = 1_200;
type AccountAuthOutcome = 'success' | 'cancelled' | 'error';
type AccountNicknameChangeOutcome = 'completed' | 'cancelled' | 'error';
type CompletedAccount = NonNullable<AccountSnapshot['account']>;
type AccountStatsOwner = string;
type AccountStatValueElements = {
  sessionCount: HTMLElement | null;
  listeningTime: HTMLElement | null;
  trackCount: HTMLElement | null;
};

function createAccountClientId(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Fall through to a non-authoritative UI correlation token.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

const ACCOUNT_CLIENT_ID = createAccountClientId();

let _unsubscribeAccount: (() => void) | null = null;
let _previousFocus: HTMLElement | null = null;
let _profilePromptShown = false;
let _profilePromptActive = false;
let _accountActionPending = false;
let _accountLoginPopup: Window | null = null;
let _accountLoginPopupMonitor: ReturnType<typeof setInterval> | null = null;
let _accountLoginPopupAttempt: {
  popup: Window | null;
  popupClosed: boolean;
  acceptIncompleteProfile: boolean;
  waitsForPopupReconciliation: boolean;
  reconciliationStarted: boolean;
  successReconciliation: Promise<AccountSessionResponse> | null;
  promise: Promise<AccountLoginPopupOutcome>;
  resolve: (outcome: AccountLoginPopupOutcome) => void;
  unsubscribe: () => void;
} | null = null;
let _accountLoginNavigationGuard: ReturnType<typeof setTimeout> | null = null;
let _accountResultChannel: BroadcastChannel | null = null;
let _accountResultLifecycleBound = false;
let _profilePromptVisibilityBound = false;
let _accountStats: AccountStats | null = null;
let _accountStatsOwner: AccountStatsOwner | null = null;
let _accountStatsLoading = false;
let _accountStatsRequestId = 0;
let _accountStatsDialogEpoch = 0;
let _accountStatsAnimatedDialogEpoch: number | null = null;
let _accountStatsAnimationFrame: number | null = null;
let _accountStatsAnimationOwner: AccountStatsOwner | null = null;
let _accountStatsAnimationEpoch: number | null = null;
let _accountStatsAnimationTarget: AccountStats | null = null;
let _accountStatsReducedMotionQuery: MediaQueryList | null = null;
let _accountStatsNumberFormatterLocale: string | null = null;
let _accountStatsNumberFormatter: Intl.NumberFormat | null = null;
const _handledAccountResultIds = new Set<string>();
let _pendingWelcomeAccountResultId: string | null = null;

function armSameTabWelcomeIntent(): void {
  try {
    window.sessionStorage.setItem(
      ACCOUNT_SAME_TAB_WELCOME_INTENT_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
  } catch {
    // The login itself must remain available when session storage is blocked.
  }
}

function clearSameTabWelcomeIntent(): void {
  try {
    window.sessionStorage.removeItem(ACCOUNT_SAME_TAB_WELCOME_INTENT_KEY);
  } catch {
    // Nothing else relies on this optional UI correlation hint.
  }
}

function consumeSameTabWelcomeIntent(): boolean {
  let createdAt: unknown = null;
  try {
    const raw = window.sessionStorage.getItem(ACCOUNT_SAME_TAB_WELCOME_INTENT_KEY);
    window.sessionStorage.removeItem(ACCOUNT_SAME_TAB_WELCOME_INTENT_KEY);
    if (raw) createdAt = (JSON.parse(raw) as { createdAt?: unknown }).createdAt;
  } catch {
    clearSameTabWelcomeIntent();
    return false;
  }
  return (
    typeof createdAt === 'number' &&
    Number.isFinite(createdAt) &&
    createdAt <= Date.now() &&
    Date.now() - createdAt <= ACCOUNT_SAME_TAB_WELCOME_INTENT_TTL_MS
  );
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function getCompletedAccount(snapshot: Readonly<AccountSnapshot>): CompletedAccount | null {
  return snapshot.status === 'authenticated' && snapshot.account?.profileComplete === true
    ? snapshot.account
    : null;
}

function getAccountStatsOwner(snapshot: Readonly<AccountSnapshot>): AccountStatsOwner | null {
  if (!getCompletedAccount(snapshot)) return null;

  const statsScope = getAccountStatsScope();
  return statsScope ? `scope:${statsScope}` : null;
}

function focusWithoutScroll(element: HTMLElement | null): void {
  try {
    element?.focus({ preventScroll: true });
  } catch {
    element?.focus();
  }
}

function formatAccountStatNumber(value: number): string {
  const locale = document.documentElement.lang || getResolvedLanguage();
  if (_accountStatsNumberFormatterLocale !== locale) {
    _accountStatsNumberFormatterLocale = locale;
    try {
      _accountStatsNumberFormatter = new Intl.NumberFormat(locale);
    } catch {
      _accountStatsNumberFormatter = null;
    }
  }
  return _accountStatsNumberFormatter?.format(value) ?? String(value);
}

function formatAccountListeningTime(
  listeningSeconds: number,
  unitReferenceSeconds = listeningSeconds,
): string {
  if (unitReferenceSeconds < 60) {
    return t('account.stats_seconds_value', {
      seconds: formatAccountStatNumber(listeningSeconds),
    });
  }

  const totalMinutes = Math.floor(listeningSeconds / 60);
  if (unitReferenceSeconds < 60 * 60) {
    return t('account.stats_minutes_value', {
      minutes: formatAccountStatNumber(totalMinutes),
    });
  }

  return t('account.stats_hours_minutes_value', {
    hours: formatAccountStatNumber(Math.floor(totalMinutes / 60)),
    minutes: formatAccountStatNumber(totalMinutes % 60),
  });
}

function renderAccountStatValues(
  elements: AccountStatValueElements,
  stats: Readonly<AccountStats>,
  listeningTimeUnitReference = stats.listeningSeconds,
): void {
  if (elements.sessionCount) {
    elements.sessionCount.textContent = t('account.stats_count_value', {
      count: formatAccountStatNumber(stats.sessionCount),
    });
  }
  if (elements.listeningTime) {
    elements.listeningTime.textContent = formatAccountListeningTime(
      stats.listeningSeconds,
      listeningTimeUnitReference,
    );
  }
  if (elements.trackCount) {
    elements.trackCount.textContent = t('account.stats_count_value', {
      count: formatAccountStatNumber(stats.trackCount),
    });
  }
}

function renderAccountStatPlaceholders(elements: AccountStatValueElements): void {
  if (elements.sessionCount) elements.sessionCount.textContent = ACCOUNT_STATS_PLACEHOLDER;
  if (elements.listeningTime) elements.listeningTime.textContent = ACCOUNT_STATS_PLACEHOLDER;
  if (elements.trackCount) elements.trackCount.textContent = ACCOUNT_STATS_PLACEHOLDER;
}

function resetAccountStatsAnimation(): void {
  if (_accountStatsAnimationFrame !== null && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(_accountStatsAnimationFrame);
  }
  _accountStatsAnimationFrame = null;
  _accountStatsAnimationOwner = null;
  _accountStatsAnimationEpoch = null;
  _accountStatsAnimationTarget = null;
}

function supportsAccountStatsAnimation(): boolean {
  if (
    typeof window.requestAnimationFrame !== 'function' ||
    typeof window.cancelAnimationFrame !== 'function'
  ) {
    return false;
  }
  try {
    _accountStatsReducedMotionQuery ??=
      window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    return _accountStatsReducedMotionQuery?.matches !== true;
  } catch {
    return true;
  }
}

function animateAccountStatValues(
  owner: AccountStatsOwner,
  target: Readonly<AccountStats>,
  elements: AccountStatValueElements,
  statsContainer: HTMLElement,
): boolean {
  if (_accountStatsAnimationFrame !== null) {
    if (
      _accountStatsAnimationOwner === owner &&
      _accountStatsAnimationEpoch === _accountStatsDialogEpoch
    ) {
      // A refreshed aggregate belongs to the same visible opening. Let the
      // already-running curve pursue its latest target instead of replaying 0.
      _accountStatsAnimationTarget = { ...target };
      return true;
    }
    resetAccountStatsAnimation();
  }

  if (_accountStatsAnimatedDialogEpoch === _accountStatsDialogEpoch) return false;

  const animationEpoch = _accountStatsDialogEpoch;
  _accountStatsAnimatedDialogEpoch = animationEpoch;
  _accountStatsAnimationOwner = owner;
  _accountStatsAnimationEpoch = animationEpoch;
  _accountStatsAnimationTarget = { ...target };
  statsContainer.setAttribute('aria-busy', 'true');
  renderAccountStatValues(
    elements,
    {
      sessionCount: 0,
      listeningSeconds: 0,
      trackCount: 0,
    },
    target.listeningSeconds,
  );

  let startedAt: number | null = null;
  const step = (now: number): void => {
    const currentTarget = _accountStatsAnimationTarget;
    if (
      _accountStatsAnimationOwner !== owner ||
      _accountStatsAnimationEpoch !== animationEpoch ||
      _accountStatsDialogEpoch !== animationEpoch ||
      !currentTarget ||
      !byId<HTMLElement>('account-dialog-overlay')?.classList.contains('show')
    ) {
      return;
    }
    if (_accountStatsReducedMotionQuery?.matches === true) {
      _accountStatsAnimationFrame = null;
      renderAccountStatValues(elements, currentTarget);
      statsContainer.setAttribute(
        'aria-busy',
        String(_accountStatsOwner === owner && _accountStatsLoading),
      );
      return;
    }

    startedAt ??= now;
    const progress = Math.min(
      1,
      Math.max(0, (now - startedAt) / ACCOUNT_STATS_COUNT_UP_DURATION_MS),
    );
    // A quadratic ease-out keeps the opening responsive while letting the
    // values decelerate naturally, without holding back a forced final tick.
    const easedProgress = 1 - Math.pow(1 - progress, 2);
    renderAccountStatValues(
      elements,
      {
        sessionCount: Math.round(currentTarget.sessionCount * easedProgress),
        listeningSeconds: Math.round(currentTarget.listeningSeconds * easedProgress),
        trackCount: Math.round(currentTarget.trackCount * easedProgress),
      },
      currentTarget.listeningSeconds,
    );

    if (progress < 1) {
      _accountStatsAnimationFrame = window.requestAnimationFrame(step);
      return;
    }

    _accountStatsAnimationFrame = null;
    renderAccountStatValues(elements, currentTarget);
    statsContainer.setAttribute(
      'aria-busy',
      String(_accountStatsOwner === owner && _accountStatsLoading),
    );
  };

  try {
    _accountStatsAnimationFrame = window.requestAnimationFrame(step);
    return true;
  } catch {
    resetAccountStatsAnimation();
    return false;
  }
}

function renderAccountStats(snapshot: Readonly<AccountSnapshot>): void {
  const stats = byId<HTMLElement>('account-dialog-stats');
  if (!stats) return;

  const completedAccount = getCompletedAccount(snapshot);
  const statsOwner = getAccountStatsOwner(snapshot);
  stats.hidden = completedAccount === null;
  const loadingCurrentStats =
    statsOwner !== null && _accountStatsOwner === statsOwner && _accountStatsLoading;

  const sessionsLabel = byId<HTMLElement>('account-stats-sessions-label');
  const listeningLabel = byId<HTMLElement>('account-stats-listening-label');
  const tracksLabel = byId<HTMLElement>('account-stats-tracks-label');
  if (sessionsLabel) sessionsLabel.textContent = t('account.stats_sessions_label');
  if (listeningLabel) listeningLabel.textContent = t('account.stats_listening_label');
  if (tracksLabel) tracksLabel.textContent = t('account.stats_tracks_label');

  const currentStats =
    statsOwner !== null && _accountStatsOwner === statsOwner ? _accountStats : null;
  const valueElements: AccountStatValueElements = {
    sessionCount: byId<HTMLElement>('account-stats-session-count'),
    listeningTime: byId<HTMLElement>('account-stats-listening-time'),
    trackCount: byId<HTMLElement>('account-stats-track-count'),
  };
  if (!currentStats) {
    resetAccountStatsAnimation();
    renderAccountStatPlaceholders(valueElements);
    stats.setAttribute('aria-busy', String(loadingCurrentStats));
    return;
  }

  const dialogShown =
    byId<HTMLElement>('account-dialog-overlay')?.classList.contains('show') === true;
  if (dialogShown && statsOwner && supportsAccountStatsAnimation()) {
    if (animateAccountStatValues(statsOwner, currentStats, valueElements, stats)) return;
  } else {
    resetAccountStatsAnimation();
  }

  renderAccountStatValues(valueElements, currentStats);
  stats.setAttribute('aria-busy', String(loadingCurrentStats));
}

async function loadAccountStats(owner: AccountStatsOwner, requestId: number): Promise<void> {
  let stats: AccountStats | null = null;
  try {
    const flushResult = await flushAccountActivityStatsForRead();
    if (flushResult.status === 'updated') {
      stats = flushResult.stats;
    } else if (flushResult.status === 'idle') {
      stats = await getAccountStats();
    }
  } catch {
    // Account statistics are optional and never gate account or playback UI.
  }

  if (
    requestId !== _accountStatsRequestId ||
    getAccountStatsOwner(getAccountSnapshot()) !== owner ||
    !byId<HTMLElement>('account-dialog-overlay')?.classList.contains('show')
  ) {
    return;
  }

  if (stats) {
    _accountStats = stats;
  }
  _accountStatsLoading = false;
  renderAccountStats(getAccountSnapshot());
}

function beginAccountStatsLoad(owner: AccountStatsOwner): void {
  const requestId = ++_accountStatsRequestId;
  if (_accountStatsOwner !== owner) _accountStats = null;
  _accountStatsOwner = owner;
  _accountStatsLoading = true;
  renderAccountStats(getAccountSnapshot());
  loadAccountStats(owner, requestId).catch((error) => {
    log.warn('[Account] Statistics load escaped its request boundary', error);
  });
}

function setPending(pending: boolean): void {
  _accountActionPending = pending;
  const dialog = byId<HTMLElement>('account-dialog');
  if (dialog) dialog.setAttribute('aria-busy', String(pending));
  for (const button of document.querySelectorAll<HTMLElement>(
    '#account-dialog button, #account-dialog .account-google-button',
  )) {
    if (button instanceof HTMLButtonElement) {
      button.disabled = pending || button.dataset.accountStateDisabled === 'true';
    } else button.setAttribute('aria-disabled', String(pending));
  }
  const overlay = byId<HTMLElement>('account-dialog-overlay');
  if (pending && overlay?.classList.contains('show')) focusWithoutScroll(dialog);
}

function parseAccountAuthResultMessage(value: unknown): {
  outcome: AccountAuthOutcome;
  id: string;
  accountClient: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as {
    type?: unknown;
    accountAuth?: unknown;
    id?: unknown;
    accountClient?: unknown;
  };
  if (
    message.type !== 'refresh' ||
    (message.accountAuth !== 'success' &&
      message.accountAuth !== 'cancelled' &&
      message.accountAuth !== 'error') ||
    typeof message.id !== 'string' ||
    message.id.length < 8 ||
    message.id.length > 160 ||
    typeof message.accountClient !== 'string' ||
    message.accountClient.length < 8 ||
    message.accountClient.length > 160
  ) {
    return null;
  }
  return { outcome: message.accountAuth, id: message.id, accountClient: message.accountClient };
}

function handleAccountAuthOutcome(
  outcome: AccountAuthOutcome,
  id: string,
  welcomeEligible = true,
): void {
  if (_handledAccountResultIds.has(id)) return;
  _handledAccountResultIds.add(id);
  if (_handledAccountResultIds.size > 16) {
    const oldest = _handledAccountResultIds.values().next().value;
    if (typeof oldest === 'string') _handledAccountResultIds.delete(oldest);
  }
  if (outcome === 'success') {
    // This is only a per-tab correlation intent. The authoritative account
    // identity still comes from the session lifecycle's post-completion read.
    // In particular, never start a competing read or settle a protected popup
    // from the marker itself.
    // The ordinary Account Center popup has completed; disarm its close poll
    // now so auto-close cannot launch a second session GET. A protected popup
    // attempt deliberately keeps its close/reconciliation boundary.
    if (!_accountLoginPopupAttempt) {
      _accountLoginPopup = null;
      stopAccountLoginPopupMonitor();
    }
    _pendingWelcomeAccountResultId = welcomeEligible ? id : null;
    const reconciliation = reconcileAccountLoginResult(id);
    if (!reconciliation) {
      if (_pendingWelcomeAccountResultId === id) _pendingWelcomeAccountResultId = null;
      return;
    }
    const popupAttempt = _accountLoginPopupAttempt;
    if (popupAttempt && !popupAttempt.waitsForPopupReconciliation) {
      // A protected non-force popup normally settles from this exact
      // post-completion read. If the completion page auto-closes first, let the
      // close monitor reuse the same authority result instead of starting a
      // generic refresh that would advance the session generation and fence it.
      popupAttempt.successReconciliation = reconciliation;
    }
    // A same-tab marker without a live one-shot intent still reconciles the
    // HttpOnly session, but cannot produce a welcome from a crafted/stale URL.
    if (!welcomeEligible) {
      void reconciliation.catch(() => undefined);
      return;
    }
    void reconciliation.then(
      (response) => {
        if (_pendingWelcomeAccountResultId !== id) return;
        _pendingWelcomeAccountResultId = null;
        if (response.authenticated && response.account?.profileComplete === true) {
          showToast(t('account.welcome_back', { name: response.account.nickname }));
        }
      },
      () => {
        if (_pendingWelcomeAccountResultId === id) _pendingWelcomeAccountResultId = null;
      },
    );
    return;
  }
  _accountLoginPopup = null;
  stopAccountLoginPopupMonitor();
  _pendingWelcomeAccountResultId = null;
  if (_accountLoginPopupAttempt) {
    settleAccountLoginPopupAttempt(outcome);
    return;
  }
  openAccountDialog();
  showToast(t(outcome === 'cancelled' ? 'account.login_cancelled' : 'account.login_failed'));
}

function settleAccountLoginPopupAttempt(outcome: AccountLoginPopupOutcome): void {
  const attempt = _accountLoginPopupAttempt;
  if (!attempt) return;
  _accountLoginPopupAttempt = null;
  if (attempt.popup && _accountLoginPopup === attempt.popup) {
    _accountLoginPopup = null;
    stopAccountLoginPopupMonitor();
  }
  attempt.unsubscribe();
  attempt.resolve(outcome);
}

function observeAccountLoginPopupAttempt(snapshot: Readonly<AccountSnapshot>): void {
  const attempt = _accountLoginPopupAttempt;
  if (!attempt) return;
  if (attempt.waitsForPopupReconciliation) return;
  if (getCompletedAccount(snapshot)) {
    _accountLoginPopup = null;
    stopAccountLoginPopupMonitor();
    settleAccountLoginPopupAttempt('authenticated');
    return;
  }
  if (snapshot.status === 'authenticated' && snapshot.account) {
    if (!attempt.acceptIncompleteProfile) return;
    // The claim flow, rather than the ordinary first-login profile dialog,
    // owns this result. Keep the incomplete account usable from Account
    // Center, but do not stack or schedule a nickname prompt over the claim's
    // identity guidance.
    _profilePromptShown = true;
    _accountLoginPopup = null;
    stopAccountLoginPopupMonitor();
    settleAccountLoginPopupAttempt('profile-incomplete');
    return;
  }
  if (!attempt.popupClosed || snapshot.status === 'loading') return;
  settleAccountLoginPopupAttempt(snapshot.status === 'anonymous' ? 'cancelled' : 'error');
}

function accountSnapshotFromSessionResponse(
  response: Readonly<AccountSessionResponse>,
): Readonly<AccountSnapshot> {
  return response.authenticated && response.account
    ? { status: 'authenticated', configured: true, account: response.account }
    : { status: 'anonymous', configured: response.configured, account: null };
}

async function reconcileAccountLoginPopupAttempt(
  attempt: NonNullable<typeof _accountLoginPopupAttempt>,
): Promise<void> {
  if (_accountLoginPopupAttempt !== attempt || attempt.reconciliationStarted) return;
  attempt.reconciliationStarted = true;
  try {
    const response = await (attempt.successReconciliation ?? reconcileAccountLoginSession());
    if (_accountLoginPopupAttempt !== attempt) return;
    attempt.waitsForPopupReconciliation = false;
    observeAccountLoginPopupAttempt(accountSnapshotFromSessionResponse(response));
  } catch {
    if (_accountLoginPopupAttempt === attempt) settleAccountLoginPopupAttempt('error');
  }
}

function createAccountLoginPopupAttempt(
  popup: Window | null,
  options: Readonly<AccountLoginPopupOptions> = {},
): Promise<AccountLoginPopupOutcome> {
  let resolveAttempt!: (outcome: AccountLoginPopupOutcome) => void;
  const promise = new Promise<AccountLoginPopupOutcome>((resolve) => {
    resolveAttempt = resolve;
  });
  _accountLoginPopupAttempt = {
    popup,
    popupClosed: false,
    acceptIncompleteProfile: options.acceptIncompleteProfile === true,
    waitsForPopupReconciliation: popup !== null && options.forceGoogleAccountChooser === true,
    reconciliationStarted: false,
    successReconciliation: null,
    promise,
    resolve: resolveAttempt,
    unsubscribe: () => undefined,
  };
  _accountLoginPopupAttempt.unsubscribe = subscribeAccount(observeAccountLoginPopupAttempt);
  return promise;
}

function stopAccountLoginPopupMonitor(): void {
  if (_accountLoginPopupMonitor === null) return;
  globalThis.clearInterval(_accountLoginPopupMonitor);
  _accountLoginPopupMonitor = null;
}

function stopAccountLoginNavigationGuard(): void {
  if (_accountLoginNavigationGuard === null) return;
  globalThis.clearTimeout(_accountLoginNavigationGuard);
  _accountLoginNavigationGuard = null;
}

/** Prepare an anchor fallback that will replace this browsing context. */
function prepareSameTabAccountLogin(anchor: HTMLAnchorElement, activationEvent: MouseEvent): void {
  const context = getRoomContext();
  const pathnameRoomCode = window.location.pathname.match(/^\/(0\d{5})\/?$/)?.[1] ?? null;
  const roomCode =
    context.kind === 'pro' && context.roomId && /^0\d{5}$/.test(context.roomId)
      ? context.roomId
      : pathnameRoomCode;
  const rawReturnTo = roomCode
    ? `/${roomCode}${window.location.search}${window.location.hash}`
    : `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const returnTo = sanitizeAccountLoginReturnPath(rawReturnTo) ?? (roomCode ? `/${roomCode}` : '/');
  const attemptId = rememberAccountLoginReturn(returnTo, roomCode, {
    allowSilentTakeover:
      context.kind === 'pro' && context.roomId === roomCode && context.role !== 'idle',
  });
  // The href may have been rendered before room context projection completed.
  anchor.href = buildGoogleLoginUrl(location, returnTo);
  armSameTabWelcomeIntent();
  markIntentionalNav();
  stopAccountLoginNavigationGuard();
  // Some native shells can abandon an anchor activation without exposing
  // preventDefault(). Bound that otherwise-unobservable case to the same
  // lifetime as the OAuth return intent. The recovery hint remains available
  // for its own parser/TTL cleanup; only the unload-prompt exemption expires.
  _accountLoginNavigationGuard = globalThis.setTimeout(
    () => {
      _accountLoginNavigationGuard = null;
      clearIntentionalNav();
    },
    10 * 60 * 1000,
  );
  // Inspect cancellation only after every click listener has run. A timeout is
  // not a safe navigation signal: on a slow mobile network the old document
  // can remain alive for several seconds before its eventual pagehide. Keep
  // both the unload exemption and the TTL-bounded recovery hint until the
  // navigation actually commits, unless another listener explicitly cancels
  // this exact activation.
  globalThis.queueMicrotask(() => {
    if (!activationEvent.defaultPrevented) return;
    stopAccountLoginNavigationGuard();
    clearIntentionalNav();
    clearSameTabWelcomeIntent();
    if (attemptId) clearAccountLoginReturn(attemptId);
  });
}

function preserveActiveRoomOrPrepareSameTabAccountLogin(
  anchor: HTMLAnchorElement,
  activationEvent: MouseEvent,
): void {
  // Standard rooms retain an idle provider-neutral context, so
  // setup.sessionStarted is the cross-room signal that the live page owns a
  // joined session. The context check also covers a projected PRO room during
  // short lifecycle transitions around the shared setup flag.
  if (getState('setup.sessionStarted') || getRoomContext().role !== 'idle') {
    activationEvent.preventDefault();
    showToast(t('account.login_failed'));
    return;
  }
  prepareSameTabAccountLogin(anchor, activationEvent);
}

function focusAccountLoginPopup(popup: Window): void {
  try {
    popup.focus?.();
  } catch {
    // The provider may already own a cross-origin window. Login can continue
    // even when a constrained shell refuses to focus it.
  }
}

function openIsolatedAccountLoginPopup():
  | { outcome: 'opened'; popup: Window }
  | { outcome: 'blocked' | 'error' } {
  let loginUrl: string;
  let popup: Window | null;
  try {
    loginUrl = buildGoogleLoginUrl(
      location,
      `${ACCOUNT_COMPLETION_PATH}?accountClient=${encodeURIComponent(ACCOUNT_CLIENT_ID)}`,
    );
    // Start with a same-origin blank document so the opener can be severed
    // before Google owns the popup.
    popup = window.open(
      'about:blank',
      `mxqr-google-login-${ACCOUNT_CLIENT_ID}`,
      'popup=yes,width=520,height=720,resizable=yes,scrollbars=yes',
    );
  } catch {
    return { outcome: 'error' };
  }
  if (!popup) return { outcome: 'blocked' };

  try {
    // The completion page uses BroadcastChannel/storage, so it does not need
    // a live opener reference while visiting the OAuth provider.
    popup.opener = null;
    popup.location.replace(loginUrl);
  } catch {
    try {
      popup.close();
    } catch {
      // Best-effort cleanup only.
    }
    return { outcome: 'error' };
  }
  return { outcome: 'opened', popup };
}

/**
 * Open the existing account OAuth popup without any same-tab fallback. This
 * synchronous function is safe to call from a real click/Enter activation and
 * lets security-sensitive callers retain one-time credentials only in memory.
 */
function requestAccountLoginPopupOnly(
  options: Readonly<AccountLoginPopupOptions> = {},
): Promise<AccountLoginPopupOutcome> {
  bindAccountAuthResultLifecycle();
  const snapshot = getAccountSnapshot();
  if (getCompletedAccount(snapshot) && !options.forceGoogleAccountChooser) {
    return Promise.resolve('authenticated');
  }

  const pending = _accountLoginPopupAttempt;
  if (pending) {
    if (pending.popup) focusAccountLoginPopup(pending.popup);
    return pending.promise;
  }

  if (
    snapshot.status === 'authenticated' &&
    snapshot.account &&
    !options.forceGoogleAccountChooser
  ) {
    if (options.acceptIncompleteProfile) return Promise.resolve('profile-incomplete');
    const promise = createAccountLoginPopupAttempt(null, options);
    _profilePromptShown = true;
    requestAccountNicknameChange()
      .then((outcome) => {
        if (!_accountLoginPopupAttempt) return;
        if (outcome === 'completed') {
          observeAccountLoginPopupAttempt(getAccountSnapshot());
          return;
        }
        settleAccountLoginPopupAttempt(outcome === 'cancelled' ? 'cancelled' : 'error');
      })
      .catch((error) => {
        log.warn('[Account] Required nickname prompt failed', error);
        if (_accountLoginPopupAttempt) settleAccountLoginPopupAttempt('error');
      });
    return promise;
  }

  const existingPopup = _accountLoginPopup;
  if (existingPopup) {
    try {
      if (!existingPopup.closed) {
        const promise = createAccountLoginPopupAttempt(existingPopup, options);
        focusAccountLoginPopup(existingPopup);
        return promise;
      }
    } catch {
      // An unreadable provider-owned handle is still live enough to await.
      const promise = createAccountLoginPopupAttempt(existingPopup, options);
      focusAccountLoginPopup(existingPopup);
      return promise;
    }
    _accountLoginPopup = null;
    stopAccountLoginPopupMonitor();
  }

  const opened = openIsolatedAccountLoginPopup();
  if (opened.outcome !== 'opened') return Promise.resolve(opened.outcome);

  const promise = createAccountLoginPopupAttempt(opened.popup, options);
  _accountLoginPopup = opened.popup;
  monitorAccountLoginPopup(opened.popup);
  focusAccountLoginPopup(opened.popup);
  return promise;
}

setAccountLoginPopupHandler(requestAccountLoginPopupOnly);

function monitorAccountLoginPopup(popup: Window): void {
  stopAccountLoginPopupMonitor();
  const monitor = globalThis.setInterval(() => {
    if (_accountLoginPopup !== popup) {
      globalThis.clearInterval(monitor);
      if (_accountLoginPopupMonitor === monitor) _accountLoginPopupMonitor = null;
      return;
    }

    let closed: boolean;
    try {
      closed = popup.closed;
    } catch {
      // Reading `closed` is normally cross-origin safe, but constrained
      // WebViews can still reject access while the provider owns the window.
      return;
    }
    if (!closed) return;

    _accountLoginPopup = null;
    globalThis.clearInterval(monitor);
    if (_accountLoginPopupMonitor === monitor) _accountLoginPopupMonitor = null;
    // A manually closed provider window cannot run the completion page, so it
    // emits no BroadcastChannel/storage pulse. Reconcile the HttpOnly cookie
    // directly; startAccountSessionRefresh also queues a follow-up if another
    // account read happens to be in flight.
    if (_accountLoginPopupAttempt?.popup === popup) {
      const attempt = _accountLoginPopupAttempt;
      attempt.popupClosed = true;
      if (attempt.waitsForPopupReconciliation || attempt.successReconciliation) {
        reconcileAccountLoginPopupAttempt(attempt).catch((error) => {
          log.warn('[Account] Popup reconciliation escaped its request boundary', error);
          if (_accountLoginPopupAttempt === attempt) settleAccountLoginPopupAttempt('error');
        });
        return;
      }
    }
    startAccountSessionRefresh();
  }, ACCOUNT_LOGIN_POPUP_POLL_MS);
  _accountLoginPopupMonitor = monitor;
}

function handleAccountResultMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) return;
  const result = parseAccountAuthResultMessage(event.data);
  if (result?.accountClient === ACCOUNT_CLIENT_ID) {
    handleAccountAuthOutcome(result.outcome, result.id);
  }
}

function handleAccountResultStorage(event: StorageEvent): void {
  if (event.key !== ACCOUNT_SYNC_STORAGE_KEY || !event.newValue) return;
  try {
    const result = parseAccountAuthResultMessage(JSON.parse(event.newValue) as unknown);
    if (result?.accountClient === ACCOUNT_CLIENT_ID) {
      handleAccountAuthOutcome(result.outcome, result.id);
    }
  } catch {
    // Ordinary account refresh pulses are intentionally not JSON.
  }
}

function bindAccountAuthResultLifecycle(): void {
  if (_accountResultLifecycleBound) return;
  _accountResultLifecycleBound = true;
  window.addEventListener('message', handleAccountResultMessage);
  window.addEventListener('storage', handleAccountResultStorage);
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      _accountResultChannel = new BroadcastChannel(ACCOUNT_SYNC_CHANNEL);
      _accountResultChannel.addEventListener('message', (event) => {
        const result = parseAccountAuthResultMessage(event.data);
        if (result?.accountClient === ACCOUNT_CLIENT_ID) {
          handleAccountAuthOutcome(result.outcome, result.id);
        }
      });
    } catch {
      _accountResultChannel = null;
    }
  }
}

function consumeAccountAuthOutcomeFromUrl(): {
  outcome: AccountAuthOutcome;
  id: string;
  welcomeEligible: boolean;
} | null {
  const url = new URL(window.location.href);
  const markers = url.searchParams.getAll('accountAuth');
  if (markers.length === 0) return null;

  url.searchParams.delete('accountAuth');
  try {
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  } catch {
    // A stale marker is harmless if constrained WebViews deny History API.
  }

  const outcome = markers.length === 1 ? markers[0] : null;
  const welcomeEligible = consumeSameTabWelcomeIntent();
  if (outcome !== 'success' && outcome !== 'cancelled' && outcome !== 'error') return null;
  return {
    outcome,
    id: `url:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
    welcomeEligible: outcome === 'success' && welcomeEligible,
  };
}

function renderAccountDialog(snapshot: Readonly<AccountSnapshot> = getAccountSnapshot()): void {
  const dialog = byId<HTMLElement>('account-dialog');
  const title = byId<HTMLElement>('account-dialog-title');
  const titleEdit = byId<HTMLButtonElement>('btn-account-title-edit');
  const titleEditLabel = byId<HTMLElement>('account-dialog-title-edit-label');
  const message = byId<HTMLElement>('account-dialog-message');
  const nickname = byId<HTMLElement>('account-dialog-nickname');
  const content = byId<HTMLElement>('account-dialog-content');
  const loginActions = byId<HTMLElement>('account-dialog-login-actions');
  const google = byId<HTMLAnchorElement>('btn-account-google');
  const googleLabel = byId<HTMLElement>('account-google-label');
  const loginClose = byId<HTMLButtonElement>('btn-account-login-close');
  const legal = byId<HTMLElement>('account-legal-links');
  const actions = byId<HTMLElement>('account-dialog-actions');
  const logout = byId<HTMLButtonElement>('btn-account-logout');
  const remove = byId<HTMLButtonElement>('btn-account-delete');
  const centerClose = byId<HTMLButtonElement>('btn-account-center-close');
  if (
    !dialog ||
    !title ||
    !titleEdit ||
    !titleEditLabel ||
    !message ||
    !nickname ||
    !content ||
    !loginActions ||
    !google ||
    !googleLabel ||
    !loginClose ||
    !legal ||
    !actions ||
    !logout ||
    !remove ||
    !centerClose
  )
    return;

  const syncRenderedTextFonts = () => {
    applyUserTextFontFallback(title, title.textContent || '');
    applyUserTextFontFallback(titleEditLabel, titleEditLabel.textContent || '');
    applyUserTextFontFallback(message, message.textContent || '');
  };

  dialog.setAttribute('aria-labelledby', 'account-dialog-title');
  dialog.dataset.accountView =
    snapshot.status === 'authenticated' && snapshot.account ? 'account' : 'login';
  title.hidden = false;
  titleEditLabel.textContent = '';
  content.hidden = false;
  loginActions.hidden = true;
  message.hidden = false;
  nickname.hidden = true;
  google.hidden = true;
  loginClose.hidden = true;
  loginClose.textContent = t('common.close');
  loginClose.classList.remove('dialog-primary');
  loginClose.classList.add('dialog-secondary');
  legal.hidden = true;
  actions.hidden = true;
  centerClose.textContent = t('common.close');
  titleEdit.dataset.accountStateDisabled = 'true';
  titleEdit.disabled = true;
  titleEdit.hidden = true;
  titleEdit.removeAttribute('aria-label');
  renderAccountStats(snapshot);

  if (snapshot.status === 'authenticated' && snapshot.account) {
    const accountTitle = snapshot.account.profileComplete
      ? snapshot.account.nickname
      : t('account.nickname_title');
    title.textContent = accountTitle;
    title.hidden = true;
    titleEditLabel.textContent = accountTitle;
    dialog.setAttribute('aria-labelledby', 'account-dialog-title-edit-label');
    message.textContent = snapshot.account.profileComplete ? '' : t('account.nickname_message');
    message.hidden = snapshot.account.profileComplete;
    content.hidden = snapshot.account.profileComplete;
    nickname.textContent = '';
    actions.hidden = false;
    const editLabel = snapshot.account.profileComplete
      ? t('account.change_nickname')
      : t('account.nickname_title');
    titleEdit.dataset.accountStateDisabled = 'false';
    titleEdit.disabled = _accountActionPending;
    titleEdit.hidden = false;
    titleEdit.setAttribute('aria-label', editLabel);
    logout.textContent = t('account.logout');
    remove.textContent = t('account.delete_account');
    syncRenderedTextFonts();
    return;
  }

  // Only a resolved, configured anonymous snapshot is a login screen. During
  // initial reconciliation (or a temporary endpoint outage) presenting a
  // "Sign in" title falsely projects an authenticated cookie as logged out.
  const canOfferLogin = snapshot.status === 'anonymous' && snapshot.configured !== false;
  title.textContent = t(canOfferLogin ? 'account.login_title' : 'account.account_title');
  loginActions.hidden = false;
  loginClose.hidden = false;
  if (snapshot.status === 'loading') {
    message.textContent = t('common.wait');
    loginClose.classList.remove('dialog-secondary');
    loginClose.classList.add('dialog-primary');
    syncRenderedTextFonts();
    return;
  }

  if (snapshot.status === 'unavailable' || snapshot.configured === false) {
    message.textContent = t('account.unavailable');
    if (snapshot.status === 'unavailable') loginClose.textContent = t('common.retry');
    loginClose.classList.remove('dialog-secondary');
    loginClose.classList.add('dialog-primary');
    syncRenderedTextFonts();
    return;
  }

  message.textContent = t('account.login_message');
  googleLabel.textContent = t('account.google_continue');
  google.href = buildGoogleLoginUrl();
  google.hidden = false;
  legal.hidden = false;
  syncRenderedTextFonts();
}

function getFocusableElements(): HTMLElement[] {
  const dialog = byId<HTMLElement>('account-dialog');
  if (!dialog) return [];
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href]:not([aria-disabled="true"])',
    ),
  ).filter((element) => !element.hidden && element.offsetParent !== null);
}

function closeAccountDialog(): void {
  const overlay = byId<HTMLElement>('account-dialog-overlay');
  if (!overlay?.classList.contains('show') || _accountActionPending) return;
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  _accountStatsRequestId += 1;
  _accountStatsLoading = false;
  renderAccountStats(getAccountSnapshot());
  syncOverlayState();
  const focus = _previousFocus;
  _previousFocus = null;
  focus?.focus?.();
}

function getPreferredAccountDialogFocus(snapshot: Readonly<AccountSnapshot>): HTMLElement | null {
  if (snapshot.status === 'anonymous' && snapshot.configured) {
    return byId<HTMLElement>('btn-account-google');
  }
  if (snapshot.status === 'authenticated') {
    return byId<HTMLElement>('btn-account-title-edit');
  }
  return byId<HTMLElement>('btn-account-login-close');
}

export function openAccountDialog(): void {
  const snapshot = getAccountSnapshot();
  const overlay = byId<HTMLElement>('account-dialog-overlay');
  if (!overlay) return;
  const openingNewEpoch = !overlay.classList.contains('show');
  if (openingNewEpoch) _accountStatsDialogEpoch += 1;
  _previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  renderAccountDialog(snapshot);
  const content = byId<HTMLElement>('account-dialog-content');
  if (content) content.scrollTop = 0;
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  syncOverlayState('account-dialog-overlay');
  const statsOwner = getAccountStatsOwner(snapshot);
  if (openingNewEpoch && statsOwner) {
    beginAccountStatsLoad(statsOwner);
  }
  queueMicrotask(() => {
    focusWithoutScroll(getPreferredAccountDialogFocus(snapshot));
  });
}

export async function requestAccountNicknameChange(): Promise<AccountNicknameChangeOutcome> {
  if (!isAccountAuthenticated()) {
    openAccountDialog();
    return 'cancelled';
  }
  if (_profilePromptActive) return 'cancelled';
  _profilePromptActive = true;

  try {
    const account = getAccountSnapshot().account;
    let defaultValue = account?.profileComplete ? account.nickname : account?.nickname || '';
    let hint = t('account.nickname_hint');
    while (true) {
      const result = await showDialog({
        title: t('account.nickname_title'),
        message: t('account.nickname_message'),
        inputField: {
          placeholder: t('account.nickname_placeholder'),
          defaultValue,
          // HTML maxLength counts UTF-16 code units. Leave room for 12 astral
          // code points (for example emoji); the validator enforces the exact
          // server-side code-point contract.
          maxLength: ACCOUNT_NICKNAME_MAX_CODE_POINTS * 2,
          hint,
          validator: validateAccountNickname,
          preserveWhitespace: true,
        },
        buttonText: t('common.ok'),
        secondaryText: account?.profileComplete ? t('common.cancel') : t('common.later'),
        defaultFocus: 'primary',
        dismissible: true,
      });
      if (result.action !== 'ok') return 'cancelled';
      try {
        const nickname = await updateCurrentAccountNickname(result.inputValue || '');
        showToast(t('account.nickname_saved', { name: nickname }));
        return 'completed';
      } catch (error) {
        const message = accountNicknameMutationErrorMessage(error);
        showToast(message);
        if (!isAccountNicknameTakenError(error)) return 'error';
        // A race-safe UNIQUE constraint can reject a name after the local
        // validator passes. Keep the attempted spelling and immediately let
        // both first-login and later rename flows try another name.
        defaultValue = result.inputValue || '';
        hint = message;
      }
    }
  } finally {
    _profilePromptActive = false;
  }
}

function bindAccountDialog(): void {
  const overlay = byId<HTMLElement>('account-dialog-overlay');
  if (!overlay || overlay.dataset.accountBound === '1') return;
  overlay.dataset.accountBound = '1';

  const reportUnhandledAccountDialogAction = (error: unknown): void => {
    log.warn('[Account] Dialog action failed outside its operation boundary', error);
    setPending(false);
    showToast(t('account.action_failed'));
  };

  byId<HTMLButtonElement>('btn-account-login-close')?.addEventListener('click', () => {
    const closeLoginDialog = async (): Promise<void> => {
      if (getAccountSnapshot().status === 'unavailable') {
        setPending(true);
        try {
          await retryAccountSessionRefresh();
        } finally {
          setPending(false);
          if (getAccountSnapshot().status === 'unavailable') {
            focusWithoutScroll(byId<HTMLButtonElement>('btn-account-login-close'));
          }
        }
        return;
      }
      closeAccountDialog();
    };
    closeLoginDialog().catch(reportUnhandledAccountDialogAction);
  });
  byId<HTMLButtonElement>('btn-account-center-close')?.addEventListener(
    'click',
    closeAccountDialog,
  );
  byId<HTMLAnchorElement>('btn-account-google')?.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const anchor = event.currentTarget as HTMLAnchorElement;
    const existingPopup = _accountLoginPopup;
    if (existingPopup) {
      try {
        if (!existingPopup.closed) {
          event.preventDefault();
          focusAccountLoginPopup(existingPopup);
          return;
        }
      } catch {
        // Treat an unreadable provider-owned handle as live. Starting another
        // OAuth attempt could overwrite the first attempt's state.
        event.preventDefault();
        focusAccountLoginPopup(existingPopup);
        return;
      }
      _accountLoginPopup = null;
      stopAccountLoginPopupMonitor();
    }

    const opened = openIsolatedAccountLoginPopup();
    if (opened.outcome !== 'opened') {
      preserveActiveRoomOrPrepareSameTabAccountLogin(anchor, event);
      return;
    }
    event.preventDefault();
    _accountLoginPopup = opened.popup;
    monitorAccountLoginPopup(opened.popup);
    focusAccountLoginPopup(opened.popup);
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeAccountDialog();
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAccountDialog();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      focusWithoutScroll(byId<HTMLElement>('account-dialog'));
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!active || !focusable.includes(active)) {
      event.preventDefault();
      focusWithoutScroll(event.shiftKey ? last : first);
      return;
    }
    if (event.shiftKey && (active === first || !overlay.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !overlay.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  byId<HTMLButtonElement>('btn-account-title-edit')?.addEventListener('click', () => {
    if (!isAccountAuthenticated()) return;
    closeAccountDialog();
    requestAccountNicknameChange().catch(reportUnhandledAccountDialogAction);
  });
  byId<HTMLButtonElement>('btn-account-logout')?.addEventListener('click', () => {
    const signOut = async (): Promise<void> => {
      if (_accountActionPending) return;
      setPending(true);
      try {
        await signOutAccount();
        setPending(false);
        closeAccountDialog();
      } catch {
        setPending(false);
        focusWithoutScroll(byId<HTMLButtonElement>('btn-account-logout'));
        showToast(t('account.action_failed'));
      }
    };
    signOut().catch(reportUnhandledAccountDialogAction);
  });
  byId<HTMLButtonElement>('btn-account-delete')?.addEventListener('click', () => {
    const removeCurrentAccount = async (): Promise<void> => {
      if (_accountActionPending) return;
      closeAccountDialog();
      const confirmation = await showDialog({
        title: t('account.delete_confirm_title'),
        message: t('account.delete_confirm_message'),
        buttonText: t('account.delete_account'),
        secondaryText: t('common.cancel'),
        defaultFocus: 'secondary',
      });
      if (confirmation.action !== 'ok') return;
      setPending(true);
      try {
        const result = await removeAccount();
        setPending(false);
        if (result.pending) showToast(t('account.delete_pending'));
      } catch {
        setPending(false);
        showToast(t('account.action_failed'));
      }
    };
    removeCurrentAccount().catch(reportUnhandledAccountDialogAction);
  });
}

function handleAccountState(snapshot: Readonly<AccountSnapshot>): void {
  const overlay = byId<HTMLElement>('account-dialog-overlay');
  const dialog = byId<HTMLElement>('account-dialog');
  const statsOwner = getAccountStatsOwner(snapshot);
  const activeDialogElement =
    document.activeElement instanceof HTMLElement && dialog?.contains(document.activeElement)
      ? document.activeElement
      : null;
  renderAccountDialog(snapshot);
  if (activeDialogElement) {
    queueMicrotask(() => {
      if (
        overlay?.classList.contains('show') &&
        !getFocusableElements().includes(activeDialogElement)
      ) {
        focusWithoutScroll(getPreferredAccountDialogFocus(snapshot));
      }
    });
  }
  if (
    overlay?.classList.contains('show') === true &&
    statsOwner !== null &&
    _accountStatsOwner !== statsOwner
  ) {
    beginAccountStatsLoad(statsOwner);
  }
  bus.emit('network:role-badge-update');
  if (
    snapshot.status !== 'authenticated' ||
    !snapshot.account ||
    snapshot.account.profileComplete
  ) {
    // A later Google account in the same tab must still receive its own first
    // nickname prompt after the previous account signed out or was deleted.
    _profilePromptShown = false;
    return;
  }
  if (_accountLoginPopupAttempt?.acceptIncompleteProfile) {
    // A target-bound claim is waiting to classify this identity. Its caller
    // must be able to offer Google's account chooser before the generic
    // nickname flow turns an accidental identity into a second account.
    return;
  }
  if (
    !_profilePromptShown &&
    (typeof document === 'undefined' || document.visibilityState !== 'hidden')
  ) {
    _profilePromptShown = true;
    // Popup OAuth leaves the account dialog open in the source tab. Replace
    // it with the first-login nickname dialog instead of stacking two modal
    // focus traps over each other.
    closeAccountDialog();
    requestAccountNicknameChange()
      .then((outcome) => {
        if (!_accountLoginPopupAttempt || outcome === 'completed') return;
        settleAccountLoginPopupAttempt(outcome === 'cancelled' ? 'cancelled' : 'error');
      })
      .catch((error) => {
        log.warn('[Account] Profile completion prompt failed', error);
        if (_accountLoginPopupAttempt) settleAccountLoginPopupAttempt('error');
      });
  }
}

function handleProfilePromptVisibility(): void {
  if (document.visibilityState === 'visible') handleAccountState(getAccountSnapshot());
}

export function initAccount(): void {
  // initAccount runs before setup.ts. Recover a standalone-PWA room route now
  // so invite parsing and the automatic PRO resume see the intended room.
  restoreAccountLoginReturnPath();
  bindAccountAuthResultLifecycle();
  const returnedAuthOutcome = consumeAccountAuthOutcomeFromUrl();
  bindAccountDialog();
  _unsubscribeAccount?.();
  _unsubscribeAccount = subscribeAccount(handleAccountState);
  _busScope.dispose();
  _busScope.on('i18n:changed', () => renderAccountDialog());
  _busScope.on('account:open', openAccountDialog);
  if (!_profilePromptVisibilityBound) {
    document.addEventListener('visibilitychange', handleProfilePromptVisibility);
    _profilePromptVisibilityBound = true;
  }
  handleAccountState(getAccountSnapshot());
  if (returnedAuthOutcome?.outcome === 'success') {
    handleAccountAuthOutcome(
      returnedAuthOutcome.outcome,
      returnedAuthOutcome.id,
      returnedAuthOutcome.welcomeEligible,
    );
  } else {
    startAccountSessionRefresh();
  }
  if (returnedAuthOutcome && returnedAuthOutcome.outcome !== 'success') {
    handleAccountAuthOutcome(returnedAuthOutcome.outcome, returnedAuthOutcome.id);
  }
}

/** Reset module-owned UI guards between isolated DOM tests. */
export function __resetAccountUiForTests(): void {
  _unsubscribeAccount?.();
  _unsubscribeAccount = null;
  _busScope.dispose();
  _previousFocus = null;
  _profilePromptShown = false;
  _profilePromptActive = false;
  _accountActionPending = false;
  _accountStats = null;
  _accountStatsOwner = null;
  _accountStatsLoading = false;
  _accountStatsRequestId = 0;
  _accountStatsDialogEpoch = 0;
  _accountStatsAnimatedDialogEpoch = null;
  resetAccountStatsAnimation();
  _accountStatsReducedMotionQuery = null;
  _accountStatsNumberFormatterLocale = null;
  _accountStatsNumberFormatter = null;
  _accountLoginPopup = null;
  if (_accountLoginPopupAttempt) settleAccountLoginPopupAttempt('error');
  stopAccountLoginPopupMonitor();
  stopAccountLoginNavigationGuard();
  _handledAccountResultIds.clear();
  _pendingWelcomeAccountResultId = null;
  clearSameTabWelcomeIntent();
  if (_accountResultLifecycleBound && typeof window !== 'undefined') {
    window.removeEventListener('message', handleAccountResultMessage);
    window.removeEventListener('storage', handleAccountResultStorage);
  }
  _accountResultLifecycleBound = false;
  _accountResultChannel?.close();
  _accountResultChannel = null;
  if (_profilePromptVisibilityBound && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleProfilePromptVisibility);
  }
  _profilePromptVisibilityBound = false;
}
