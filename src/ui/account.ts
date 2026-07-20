/** Optional Google account UI. Authentication never gates room playback. */

import { bus, createBusScope } from '../core/events.ts';
import { buildGoogleLoginUrl } from '../account/api.ts';
import {
  getAccountSnapshot,
  isAccountAuthenticated,
  subscribeAccount,
  type AccountSnapshot,
} from '../account/state.ts';
import { removeAccount, signOutAccount, startAccountSessionRefresh } from '../account/session.ts';
import {
  ACCOUNT_NICKNAME_MAX_CODE_POINTS,
  updateCurrentAccountNickname,
  validateAccountNickname,
} from '../account/nickname.ts';
import {
  rememberAccountLoginReturn,
  restoreAccountLoginReturnPath,
} from '../account/login-return.ts';
import { clearIntentionalNav, markIntentionalNav } from '../core/page-lifecycle.ts';
import { t } from '../i18n/index.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { showDialog } from './dialog.ts';
import { syncOverlayState } from './dom.ts';
import { showToast } from './toast.ts';

const _busScope = createBusScope();
const ACCOUNT_COMPLETION_PATH = '/account-complete.html';
const ACCOUNT_SYNC_CHANNEL = 'mxqr-account-v1';
const ACCOUNT_SYNC_STORAGE_KEY = 'mxqr-account-refresh';
const ACCOUNT_LOGIN_POPUP_POLL_MS = 250;
type AccountAuthOutcome = 'cancelled' | 'error';

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
let _accountResultChannel: BroadcastChannel | null = null;
let _accountResultLifecycleBound = false;
let _profilePromptVisibilityBound = false;
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

function setPending(pending: boolean): void {
  _accountActionPending = pending;
  const dialog = byId<HTMLElement>('account-dialog');
  if (dialog) dialog.setAttribute('aria-busy', String(pending));
  for (const button of document.querySelectorAll<HTMLElement>(
    '#account-dialog button, #account-dialog .account-google-button',
  )) {
    if (button instanceof HTMLButtonElement) button.disabled = pending;
    else button.setAttribute('aria-disabled', String(pending));
  }
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
  const title = byId<HTMLElement>('account-dialog-title');
  const message = byId<HTMLElement>('account-dialog-message');
  const nickname = byId<HTMLElement>('account-dialog-nickname');
  const content = byId<HTMLElement>('account-dialog-content');
  const google = byId<HTMLAnchorElement>('btn-account-google');
  const legal = byId<HTMLElement>('account-legal-links');
  const actions = byId<HTMLElement>('account-dialog-actions');
  const rename = byId<HTMLButtonElement>('btn-account-rename');
  const logout = byId<HTMLButtonElement>('btn-account-logout');
  const remove = byId<HTMLButtonElement>('btn-account-delete');
  if (!title || !message || !nickname || !content || !google || !legal || !actions) return;

  content.hidden = false;
  message.hidden = false;
  nickname.hidden = true;
  google.hidden = true;
  legal.hidden = true;
  actions.hidden = true;

  if (snapshot.status === 'authenticated' && snapshot.account) {
    title.textContent = snapshot.account.profileComplete
      ? snapshot.account.nickname
      : t('account.nickname_title');
    message.textContent = snapshot.account.profileComplete ? '' : t('account.nickname_message');
    message.hidden = snapshot.account.profileComplete;
    content.hidden = snapshot.account.profileComplete;
    nickname.textContent = '';
    actions.hidden = false;
    if (rename) {
      rename.textContent = snapshot.account.profileComplete
        ? t('account.change_nickname')
        : t('account.nickname_title');
    }
    if (logout) logout.textContent = t('account.logout');
    if (remove) remove.textContent = t('account.delete_account');
    return;
  }

  title.textContent = t('account.login_title');
  if (snapshot.status === 'loading') {
    message.textContent = t('common.wait');
    return;
  }

  if (snapshot.status === 'unavailable' || snapshot.configured === false) {
    message.textContent = t('account.unavailable');
    return;
  }

  message.textContent = t('account.login_message');
  google.textContent = t('account.google_continue');
  google.href = buildGoogleLoginUrl();
  google.hidden = false;
  legal.hidden = false;
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
  syncOverlayState();
  const focus = _previousFocus;
  _previousFocus = null;
  focus?.focus?.();
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
  queueMicrotask(() => {
    const preferred =
      snapshot.status === 'anonymous' && snapshot.configured
        ? byId<HTMLElement>('btn-account-google')
        : byId<HTMLElement>('btn-account-close');
    focusWithoutScroll(preferred);
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
    const result = await showDialog({
      title: t('account.nickname_title'),
      message: t('account.nickname_message'),
      inputField: {
        placeholder: t('account.nickname_placeholder'),
        defaultValue: account?.profileComplete ? account.nickname : account?.nickname || '',
        // HTML maxLength counts UTF-16 code units. Leave room for 12 astral
        // code points (for example emoji); the validator enforces the exact
        // server-side code-point contract.
        maxLength: ACCOUNT_NICKNAME_MAX_CODE_POINTS * 2,
        hint: t('account.nickname_hint'),
        validator: validateAccountNickname,
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
    } catch {
      showToast(t('account.action_failed'));
    }
  } finally {
    _profilePromptActive = false;
  }
}

function bindAccountDialog(): void {
  const overlay = byId<HTMLElement>('account-dialog-overlay');
  if (!overlay || overlay.dataset.accountBound === '1') return;
  overlay.dataset.accountBound = '1';

  byId<HTMLButtonElement>('btn-account-close')?.addEventListener('click', closeAccountDialog);
  byId<HTMLAnchorElement>('btn-account-google')?.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) {
      const context = getRoomContext();
      const pathnameRoomCode = window.location.pathname.match(/^\/(\d{6})$/)?.[1] ?? null;
      const roomCode =
        context.kind === 'pro' && context.roomId && /^\d{6}$/.test(context.roomId)
          ? context.roomId
          : pathnameRoomCode;
      const returnTo = roomCode
        ? `/${roomCode}${window.location.search}${window.location.hash}`
        : `${window.location.pathname}${window.location.search}${window.location.hash}`;
      rememberAccountLoginReturn(returnTo, roomCode);
      // The href was initially rendered before the room context necessarily
      // existed. Refresh it at the activation gesture so a PWA always returns
      // to the live room rather than the install start URL.
      (event.currentTarget as HTMLAnchorElement).href = buildGoogleLoginUrl(location, returnTo);
      markIntentionalNav();
      // If a browser/extension cancels the anchor navigation after this
      // handler, do not leave the active room without its ordinary unload
      // protection for the rest of the document lifetime.
      globalThis.setTimeout(clearIntentionalNav, 2_000);
      return;
    }
    try {
      if (_accountLoginPopup && !_accountLoginPopup.closed) {
        event.preventDefault();
        _accountLoginPopup.focus?.();
        return;
      }
      const loginUrl = buildGoogleLoginUrl(
        location,
        `${ACCOUNT_COMPLETION_PATH}?accountClient=${encodeURIComponent(ACCOUNT_CLIENT_ID)}`,
      );
      // Start with a same-origin blank document so the opener can be severed
      // before Google owns the popup. Opening the OAuth URL directly can race
      // its redirect and make `popup.opener = null` a cross-origin access.
      const popup = window.open(
        'about:blank',
        `mxqr-google-login-${ACCOUNT_CLIENT_ID}`,
        'popup=yes,width=520,height=720,resizable=yes,scrollbars=yes',
      );
      if (!popup) return;
      try {
        // The completion page uses BroadcastChannel/storage, so it does not
        // need a live opener reference while visiting the OAuth provider.
        popup.opener = null;
        popup.location.replace(loginUrl);
      } catch {
        // If a constrained browser rejects the isolated-popup bootstrap,
        // close the blank window and preserve the anchor's same-tab fallback.
        try {
          popup.close();
        } catch {
          // Best-effort cleanup only; the same-tab anchor remains available.
        }
        return;
      }
      event.preventDefault();
      _accountLoginPopup = popup;
      monitorAccountLoginPopup(popup);
      popup.focus?.();
    } catch {
      // Popup blocking and constrained installed-app browsers fall back to the
      // anchor's ordinary same-tab OAuth navigation.
    }
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
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (
      event.shiftKey &&
      (document.activeElement === first || !overlay.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !overlay.contains(document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  });

  byId<HTMLButtonElement>('btn-account-rename')?.addEventListener('click', () => {
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
  const google = byId<HTMLAnchorElement>('btn-account-google');
  const focusedLoginAction =
    overlay?.classList.contains('show') === true && document.activeElement === google;
  renderAccountDialog(snapshot);
  bus.emit('network:role-badge-update');
  if (
    snapshot.status !== 'authenticated' ||
    !snapshot.account ||
    snapshot.account.profileComplete
  ) {
    // A later Google account in the same tab must still receive its own first
    // nickname prompt after the previous account signed out or was deleted.
    _profilePromptShown = false;
    if (
      focusedLoginAction &&
      snapshot.status === 'authenticated' &&
      snapshot.account?.profileComplete
    ) {
      queueMicrotask(() => focusWithoutScroll(byId<HTMLButtonElement>('btn-account-rename')));
    }
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
  _accountLoginPopup = null;
  stopAccountLoginPopupMonitor();
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
