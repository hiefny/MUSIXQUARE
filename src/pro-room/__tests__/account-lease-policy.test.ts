import { describe, expect, it } from 'vitest';
import type { AccountSnapshot } from '../../account/state.ts';
import { ProRoomApiError } from '../api.ts';
import {
  classifyProAccountIdentityLeaseFailure,
  getProAccountIdentityLeaseRenewDelayMs,
  getProAccountIdentityLeaseRetryDelayMs,
  planProAccountIdentityLease,
  PRO_ACCOUNT_IDENTITY_LEASE_RENEW_INTERVAL_MS,
} from '../account-lease-policy.ts';

const authenticated: AccountSnapshot = {
  status: 'authenticated',
  configured: true,
  account: { nickname: 'Minsu', profileComplete: true },
};

describe('PRO account identity lease policy', () => {
  it('renews a normal signed-in room identity roughly halfway through its server lease', () => {
    expect(PRO_ACCOUNT_IDENTITY_LEASE_RENEW_INTERVAL_MS).toBe(60_000);
    expect(getProAccountIdentityLeaseRenewDelayMs(1_000_000, 1_120_000)).toBe(60_000);
    expect(getProAccountIdentityLeaseRenewDelayMs(1_000_000, 1_090_000)).toBe(30_000);
    expect(getProAccountIdentityLeaseRenewDelayMs(1_000_000, null)).toBe(60_000);
    expect(planProAccountIdentityLease(authenticated, { isAuthenticated: true })).toBe('renew');
  });

  it('clamps clock-skewed expiries and bounds transient retries before expiry', () => {
    expect(getProAccountIdentityLeaseRenewDelayMs(1_000_000, 2_000_000)).toBe(60_000);
    expect(getProAccountIdentityLeaseRenewDelayMs(1_000_000, 1_010_000)).toBe(5_000);

    expect(getProAccountIdentityLeaseRetryDelayMs(0, 1_000_000, 1_120_000)).toBe(5_000);
    expect(getProAccountIdentityLeaseRetryDelayMs(1, 1_005_000, 1_120_000)).toBe(15_000);
    expect(getProAccountIdentityLeaseRetryDelayMs(2, 1_020_000, 1_120_000)).toBe(30_000);
    expect(getProAccountIdentityLeaseRetryDelayMs(3, 1_050_000, 1_120_000)).toBeNull();
    expect(getProAccountIdentityLeaseRetryDelayMs(2, 1_090_000, 1_120_000)).toBeNull();
  });

  it('reattaches a still-signed-in account after background lease expiry', () => {
    expect(planProAccountIdentityLease(authenticated, { isAuthenticated: false })).toBe('reattach');
  });

  it('does not renew after logout or while account state is uncertain', () => {
    expect(
      planProAccountIdentityLease(
        { status: 'anonymous', configured: true, account: null },
        { isAuthenticated: true },
      ),
    ).toBe('none');
    expect(
      planProAccountIdentityLease(
        { status: 'unavailable', configured: null, account: null },
        { isAuthenticated: true },
      ),
    ).toBe('none');
  });

  it('reattaches on an account switch but keeps transient App failures inside grace', () => {
    expect(
      classifyProAccountIdentityLeaseFailure(new ProRoomApiError('SESSION_ACCOUNT_CONFLICT', 409)),
    ).toBe('reattach');
    expect(classifyProAccountIdentityLeaseFailure(new Error('D1 temporarily unavailable'))).toBe(
      'grace',
    );
  });

  it('fails local account-only controls closed after logout-all proof disappears', () => {
    expect(
      classifyProAccountIdentityLeaseFailure(new ProRoomApiError('ACCOUNT_SESSION_REQUIRED', 401)),
    ).toBe('revoke-local');
    expect(
      classifyProAccountIdentityLeaseFailure(new ProRoomApiError('SESSION_REQUIRED', 401)),
    ).toBe('terminal-room-session');
  });
});
