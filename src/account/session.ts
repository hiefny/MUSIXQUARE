import {
  deleteAccount,
  getAccountSession,
  logoutAccount,
  logoutAllAccounts,
  updateAccountProfile,
  type AccountProfile,
} from './api.ts';
import {
  applyAccountSession,
  setAccountAnonymous,
  setAccountLoading,
  setAccountUnavailable,
} from './state.ts';
import { bus } from '../core/events.ts';

let _operationGeneration = 0;
let _refreshInFlight: Promise<void> | null = null;
let _refreshFollowUp = false;
let _mutationDepth = 0;
let _lastRefreshStartedAt = 0;
let _lifecycleBound = false;
let _syncChannel: BroadcastChannel | null = null;

const ACCOUNT_REFRESH_DEBOUNCE_MS = 30_000;
const ACCOUNT_SYNC_CHANNEL = 'mxqr-account-v1';
const ACCOUNT_SYNC_STORAGE_KEY = 'mxqr-account-refresh';

function isAccountRefreshMessage(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'refresh';
}

function broadcastAccountChange(): void {
  try {
    _syncChannel?.postMessage({ type: 'refresh' });
  } catch {
    // Cross-tab refresh is an optimization. The HttpOnly session remains the
    // authority and will be checked on the next navigation/focus.
  }
  try {
    // BroadcastChannel is absent in some older WebViews/private contexts.
    // Storage events do not fire in this tab (which already applied the
    // mutation) but wake every other same-origin tab through the listener
    // registered below. The pulse carries no account data.
    window.localStorage.setItem(
      ACCOUNT_SYNC_STORAGE_KEY,
      `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
    );
  } catch {
    // Storage may be disabled. Focus/visibility refresh remains the fallback.
  }
}

function refreshAfterUserReturns(): void {
  if (Date.now() - _lastRefreshStartedAt < ACCOUNT_REFRESH_DEBOUNCE_MS) return;
  void refreshAccountSession();
}

function refreshAfterPopupMessage(event: MessageEvent): void {
  if (event.origin === window.location.origin && isAccountRefreshMessage(event.data)) {
    void refreshAccountSession();
  }
}

function refreshAfterStoragePulse(event: StorageEvent): void {
  if (event.key === ACCOUNT_SYNC_STORAGE_KEY) void refreshAccountSession();
}

function refreshAfterVisibilityChange(): void {
  if (document.visibilityState === 'visible') refreshAfterUserReturns();
}

function refreshAfterBroadcastMessage(event: MessageEvent): void {
  if (isAccountRefreshMessage(event.data)) void refreshAccountSession();
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
  if (showLoading) setAccountLoading();
  const operation = (async () => {
    try {
      const response = await getAccountSession();
      if (generation !== _operationGeneration) return;
      applyAccountSession(response);
    } catch {
      if (generation !== _operationGeneration) return;
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
  _mutationDepth += 1;
  try {
    const response = await updateAccountProfile(nickname);
    if (!response.authenticated || !response.account) throw new Error('ACCOUNT_INVALID_RESPONSE');
    if (generation === _operationGeneration) applyAccountSession(response);
    broadcastAccountChange();
    return response.account;
  } finally {
    _mutationDepth -= 1;
    drainRefreshFollowUp();
  }
}

export async function signOutAccount(everywhere = false): Promise<void> {
  const generation = ++_operationGeneration;
  _mutationDepth += 1;
  try {
    if (everywhere) await logoutAllAccounts();
    else await logoutAccount();
    if (generation === _operationGeneration) setAccountAnonymous(true);
    broadcastAccountChange();
  } finally {
    _mutationDepth -= 1;
    drainRefreshFollowUp();
  }
}

export async function removeAccount(): Promise<void> {
  const generation = ++_operationGeneration;
  _mutationDepth += 1;
  try {
    await deleteAccount();
    if (generation === _operationGeneration) {
      bus.emit('account:deleted');
      setAccountAnonymous(true);
    }
    broadcastAccountChange();
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
  _operationGeneration = 0;
  _refreshInFlight = null;
  _refreshFollowUp = false;
  _mutationDepth = 0;
  _lastRefreshStartedAt = 0;
}
