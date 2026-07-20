import type { AccountSnapshot } from '../account/state.ts';
import { ProRoomApiError } from './api.ts';

// The Worker grants 120 seconds. Re-prove well inside that window so two
// transient failures can occur before only this physical session is demoted.
export const PRO_ACCOUNT_IDENTITY_LEASE_RENEW_INTERVAL_MS = 40_000;

type ProAccountIdentityLeaseAction = 'none' | 'renew' | 'reattach';
type ProAccountIdentityLeaseFailure =
  | 'terminal-room-session'
  | 'reattach'
  | 'revoke-local'
  | 'grace';

export function planProAccountIdentityLease(
  account: Readonly<AccountSnapshot>,
  viewer: { isAuthenticated?: boolean } | null | undefined,
): ProAccountIdentityLeaseAction {
  if (
    account.status !== 'authenticated' ||
    !account.account?.profileComplete ||
    !account.account.nickname ||
    !viewer
  ) {
    return 'none';
  }
  return viewer.isAuthenticated === true ? 'renew' : 'reattach';
}

export function classifyProAccountIdentityLeaseFailure(
  error: unknown,
): ProAccountIdentityLeaseFailure {
  if (!(error instanceof ProRoomApiError)) return 'grace';
  if (
    error.code === 'SESSION_REQUIRED' ||
    error.code === 'PRESENCE_SUPERSEDED' ||
    error.status === 423 ||
    error.code === 'ROOM_SUSPENDED'
  ) {
    return 'terminal-room-session';
  }
  if (error.code === 'ACCOUNT_REATTACH_REQUIRED' || error.code === 'SESSION_ACCOUNT_CONFLICT') {
    return 'reattach';
  }
  if (error.code === 'ACCOUNT_SESSION_REQUIRED' || error.code === 'ACCOUNT_ASSERTION_INVALID') {
    return 'revoke-local';
  }
  return 'grace';
}
