import type { AccountSnapshot } from '../account/state.ts';
import { ProRoomApiError } from './api.ts';

// The Worker grants 120 seconds. Renew with roughly half of the lease left so
// normal tabs make one request per minute while still retaining a bounded
// retry budget before only this physical session is demoted.
export const PRO_ACCOUNT_IDENTITY_LEASE_RENEW_INTERVAL_MS = 60_000;
const PRO_ACCOUNT_IDENTITY_LEASE_RENEW_REMAINING_MS = 60_000;
const PRO_ACCOUNT_IDENTITY_LEASE_MIN_RENEW_DELAY_MS = 5_000;
const PRO_ACCOUNT_IDENTITY_LEASE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;
const PRO_ACCOUNT_IDENTITY_LEASE_RETRY_EXPIRY_GUARD_MS = 5_000;

type ProAccountIdentityLeaseAction = 'none' | 'renew' | 'reattach';
type ProAccountIdentityLeaseFailure =
  | 'terminal-room-session'
  | 'reattach'
  | 'revoke-local'
  | 'grace';

/**
 * Convert the server-authoritative expiry into a duration-based renewal timer.
 * The clamp keeps a skewed client clock from producing either a hot loop or a
 * renewal later than the established one-minute safety cadence.
 */
export function getProAccountIdentityLeaseRenewDelayMs(
  nowMs: number,
  leaseExpiresAtMs: number | null | undefined,
): number {
  if (
    !Number.isFinite(nowMs) ||
    typeof leaseExpiresAtMs !== 'number' ||
    !Number.isFinite(leaseExpiresAtMs)
  ) {
    return PRO_ACCOUNT_IDENTITY_LEASE_RENEW_INTERVAL_MS;
  }
  const desiredDelay = leaseExpiresAtMs - nowMs - PRO_ACCOUNT_IDENTITY_LEASE_RENEW_REMAINING_MS;
  return Math.max(
    PRO_ACCOUNT_IDENTITY_LEASE_MIN_RENEW_DELAY_MS,
    Math.min(PRO_ACCOUNT_IDENTITY_LEASE_RENEW_INTERVAL_MS, desiredDelay),
  );
}

/**
 * Retry transient failures only a few times and never schedule a retry that
 * would knowingly cross the server lease fence. Expiry remains fail-closed:
 * failed requests cannot extend it.
 */
export function getProAccountIdentityLeaseRetryDelayMs(
  retryAttempt: number,
  nowMs: number,
  leaseExpiresAtMs: number | null | undefined,
): number | null {
  const delay = PRO_ACCOUNT_IDENTITY_LEASE_RETRY_DELAYS_MS[retryAttempt];
  if (delay === undefined) return null;
  if (
    Number.isFinite(nowMs) &&
    typeof leaseExpiresAtMs === 'number' &&
    Number.isFinite(leaseExpiresAtMs) &&
    nowMs + delay + PRO_ACCOUNT_IDENTITY_LEASE_RETRY_EXPIRY_GUARD_MS >= leaseExpiresAtMs
  ) {
    return null;
  }
  return delay;
}

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
