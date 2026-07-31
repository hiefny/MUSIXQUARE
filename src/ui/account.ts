/** Optional Google account UI. Authentication never gates room playback. */

import { bus, createBusScope } from '../core/events.ts';
import { buildGoogleLoginUrl, getAccountStats, type AccountStats } from '../account/api.ts';
import { flushAccountActivityStatsForRead } from '../account/activity-stats.ts';
import {
  getAccountSnapshot,
  isAccountAuthenticated,
  subscribeAccount,
  type AccountSnapshot,
} from '../account/state.ts';
import { removeAccount, signOutAccount, startAccountSessionRefresh } from '../account/session.ts';
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
const ACCOUNT_LOGIN_POPUP_POLL_MS = 250;
const ACCOUNT_STATS_PLACEHOLDER = '—';
type AccountAuthOutcome = 'cancelled' | 'error';
type CompletedAccount = NonNullable<AccountSnapshot['account']>;

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
let _accountLoginNavigationGuard: ReturnType<typeof setTimeout> | null = null;
let _accountResultChannel: BroadcastChannel | null = null;
let _accountResultLifecycleBound = false;
let _profilePromptVisibilityBound = false;
let _accountStats: AccountStats | null = null;
let _accountStatsOwner: CompletedAccount | null = null;
let _accountStatsLoading = false;
let _accountStatsRequestId = 0;
const _handledAccountResultIds = new Set<string>();

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
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
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

function formatAccountListeningTime(listeningSeconds: number): string {
  if (listeningSeconds < 60) {
    return t('account.stats_seconds_value', {
      seconds: formatAccountStatNumber(listeningSeconds),
    });
  }

  const totalMinutes = Math.floor(listeningSeconds / 60);
  if (totalMinutes < 60) {
    return t('account.stats_minutes_value', {
      minutes: formatAccountStatNumber(totalMinutes),
    });
  }

  return t('account.stats_hours_minutes_value', {
    hours: formatAccountStatNumber(Math.floor(totalMinutes / 60)),
    minutes: formatAccountStatNumber(totalMinutes % 60),
  });
}

function renderAccountStats(snapshot: Readonly<AccountSnapshot>): void {
  const stats = byId<HTMLElement>('account-dialog-stats');
  if (!stats) return;

  const completedAccount =
    snapshot.status === 'authenticated' &&
    snapshot.account?.profileComplete === true &&
    snapshot.account
      ? snapshot.account
      : null;
  stats.hidden = completedAccount === null;
  stats.setAttribute(
    'aria-busy',
    String(
      completedAccount !== null && _accountStatsOwner === completedAccount && _accountStatsLoading,
    ),
  );

  const sessionsLabel = byId<HTMLElement>('account-stats-sessions-label');
  const listeningLabel = byId<HTMLElement>('account-stats-listening-label');
  const tracksLabel = byId<HTMLElement>('account-stats-tracks-label');
  if (sessionsLabel) sessionsLabel.textContent = t('account.stats_sessions_label');
  if (listeningLabel) listeningLabel.textContent = t('account.stats_listening_label');
  if (tracksLabel) tracksLabel.textContent = t('account.stats_tracks_label');

  const currentStats =
    completedAccount !== null && _accountStatsOwner === completedAccount ? _accountStats : null;
  const sessionCount = byId<HTMLElement>('account-stats-session-count');
  const listeningTime = byId<HTMLElement>('account-stats-listening-time');
  const trackCount = byId<HTMLElement>('account-stats-track-count');
  if (sessionCount) {
    sessionCount.textContent = currentStats
      ? t('account.stats_count_value', {
          count: formatAccountStatNumber(currentStats.sessionCount),
        })
      : ACCOUNT_STATS_PLACEHOLDER;
  }
  if (listeningTime) {
    listeningTime.textContent = currentStats
      ? formatAccountListeningTime(currentStats.listeningSeconds)
      : ACCOUNT_STATS_PLACEHOLDER;
  }
  if (trackCount) {
    trackCount.textContent = currentStats
      ? t('account.stats_count_value', {
          count: formatAccountStatNumber(currentStats.trackCount),
        })
      : ACCOUNT_STATS_PLACEHOLDER;
  }
}

async function loadAccountStats(account: CompletedAccount, requestId: number): Promise<void> {
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
    getAccountSnapshot().account !== account ||
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

function beginAccountStatsLoad(account: CompletedAccount): void {
  const requestId = ++_accountStatsRequestId;
  if (_accountStatsOwner !== account) _accountStats = null;
  _accountStatsOwner = account;
  _accountStatsLoading = true;
  renderAccountStats(getAccountSnapshot());
  void loadAccountStats(account, requestId);
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
    (message.accountAuth !== 'cancelled' && message.accountAuth !== 'error') ||
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

function handleAccountAuthOutcome(outcome: AccountAuthOutcome, id: string): void {
  if (_handledAccountResultIds.has(id)) return;
  _handledAccountResultIds.add(id);
  if (_handledAccountResultIds.size > 16) {
    const oldest = _handledAccountResultIds.values().next().value;
    if (typeof oldest === 'string') _handledAccountResultIds.delete(oldest);
  }
  _accountLoginPopup = null;
  stopAccountLoginPopupMonitor();
  openAccountDialog();
  showToast(t(outcome === 'cancelled' ? 'account.login_cancelled' : 'account.login_failed'));
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

function consumeAccountAuthOutcomeFromUrl(): { outcome: AccountAuthOutcome; id: string } | null {
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
  if (outcome !== 'cancelled' && outcome !== 'error') return null;
  return {
    outcome,
    id: `url:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
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
  title.hidden = false;
  titleEditLabel.textContent = '';
  content.hidden = false;
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

  title.textContent = t('account.login_title');
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
  _previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  renderAccountDialog(snapshot);
  const content = byId<HTMLElement>('account-dialog-content');
  if (content) content.scrollTop = 0;
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  syncOverlayState('account-dialog-overlay');
  if (snapshot.status === 'authenticated' && snapshot.account?.profileComplete === true) {
    beginAccountStatsLoad(snapshot.account);
  }
  queueMicrotask(() => {
    focusWithoutScroll(getPreferredAccountDialogFocus(snapshot));
  });
}

export async function requestAccountNicknameChange(): Promise<void> {
  if (!isAccountAuthenticated()) {
    openAccountDialog();
    return;
  }
  if (_profilePromptActive) return;
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
      if (result.action !== 'ok') return;
      try {
        const nickname = await updateCurrentAccountNickname(result.inputValue || '');
        showToast(t('account.nickname_saved', { name: nickname }));
        return;
      } catch (error) {
        const message = accountNicknameMutationErrorMessage(error);
        showToast(message);
        if (!isAccountNicknameTakenError(error)) return;
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

  byId<HTMLButtonElement>('btn-account-login-close')?.addEventListener('click', closeAccountDialog);
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

    let loginUrl: string;
    let popup: Window | null;
    try {
      loginUrl = buildGoogleLoginUrl(
        location,
        `${ACCOUNT_COMPLETION_PATH}?accountClient=${encodeURIComponent(ACCOUNT_CLIENT_ID)}`,
      );
      // Start with a same-origin blank document so the opener can be severed
      // before Google owns the popup. Opening the OAuth URL directly can race
      // its redirect and make `popup.opener = null` a cross-origin access.
      popup = window.open(
        'about:blank',
        `mxqr-google-login-${ACCOUNT_CLIENT_ID}`,
        'popup=yes,width=520,height=720,resizable=yes,scrollbars=yes',
      );
    } catch {
      preserveActiveRoomOrPrepareSameTabAccountLogin(anchor, event);
      return;
    }
    if (!popup) {
      preserveActiveRoomOrPrepareSameTabAccountLogin(anchor, event);
      return;
    }
    try {
      // The completion page uses BroadcastChannel/storage, so it does not
      // need a live opener reference while visiting the OAuth provider.
      popup.opener = null;
      popup.location.replace(loginUrl);
    } catch {
      // If a constrained browser rejects the isolated-popup bootstrap, close
      // its blank window before considering the same-tab fallback.
      try {
        popup.close();
      } catch {
        // Best-effort cleanup only.
      }
      preserveActiveRoomOrPrepareSameTabAccountLogin(anchor, event);
      return;
    }
    event.preventDefault();
    _accountLoginPopup = popup;
    monitorAccountLoginPopup(popup);
    focusAccountLoginPopup(popup);
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
    void requestAccountNicknameChange();
  });
  byId<HTMLButtonElement>('btn-account-logout')?.addEventListener('click', async () => {
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
  });
  byId<HTMLButtonElement>('btn-account-delete')?.addEventListener('click', async () => {
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
      await removeAccount();
      setPending(false);
    } catch {
      setPending(false);
      showToast(t('account.action_failed'));
    }
  });
}

function handleAccountState(snapshot: Readonly<AccountSnapshot>): void {
  const overlay = byId<HTMLElement>('account-dialog-overlay');
  const dialog = byId<HTMLElement>('account-dialog');
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
    snapshot.status === 'authenticated' &&
    snapshot.account?.profileComplete === true &&
    _accountStatsOwner !== snapshot.account
  ) {
    beginAccountStatsLoad(snapshot.account);
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
  if (
    !_profilePromptShown &&
    (typeof document === 'undefined' || document.visibilityState !== 'hidden')
  ) {
    _profilePromptShown = true;
    // Popup OAuth leaves the account dialog open in the source tab. Replace
    // it with the first-login nickname dialog instead of stacking two modal
    // focus traps over each other.
    closeAccountDialog();
    void requestAccountNicknameChange();
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
  startAccountSessionRefresh();
  if (returnedAuthOutcome) {
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
  _accountLoginPopup = null;
  stopAccountLoginPopupMonitor();
  stopAccountLoginNavigationGuard();
  _handledAccountResultIds.clear();
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
