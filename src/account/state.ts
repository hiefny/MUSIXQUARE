import type { AccountProfile, AccountSessionResponse } from './api.ts';

type AccountStatus = 'loading' | 'anonymous' | 'authenticated' | 'unavailable';

export interface AccountSnapshot {
  status: AccountStatus;
  configured: boolean | null;
  account: AccountProfile | null;
}

type AccountListener = (snapshot: Readonly<AccountSnapshot>) => void;

const INITIAL_ACCOUNT_STATE: AccountSnapshot = {
  status: 'loading',
  configured: null,
  account: null,
};

let _snapshot: AccountSnapshot = { ...INITIAL_ACCOUNT_STATE };
const _listeners = new Set<AccountListener>();

function publish(next: AccountSnapshot): void {
  _snapshot = next;
  for (const listener of [..._listeners]) listener(_snapshot);
}

export function getAccountSnapshot(): Readonly<AccountSnapshot> {
  return _snapshot;
}

export function subscribeAccount(listener: AccountListener): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

export function setAccountLoading(): void {
  if (_snapshot.status === 'authenticated') return;
  publish({ status: 'loading', configured: _snapshot.configured, account: null });
}

export function applyAccountSession(response: AccountSessionResponse): void {
  if (response.authenticated && response.account) {
    publish({ status: 'authenticated', configured: true, account: response.account });
    return;
  }
  publish({ status: 'anonymous', configured: response.configured, account: null });
}

export function setAccountUnavailable(): void {
  if (_snapshot.status === 'authenticated') return;
  publish({ status: 'unavailable', configured: null, account: null });
}

export function setAccountAnonymous(configured = true): void {
  publish({ status: 'anonymous', configured, account: null });
}

export function isAccountAuthenticated(): boolean {
  return _snapshot.status === 'authenticated' && _snapshot.account !== null;
}

/** Test-only reset; production initialization immediately refreshes the session. */
export function __resetAccountStateForTests(): void {
  _snapshot = { ...INITIAL_ACCOUNT_STATE };
  _listeners.clear();
}
