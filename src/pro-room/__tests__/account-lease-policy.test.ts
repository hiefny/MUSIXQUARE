import { describe, expect, it } from 'vitest';
import type { AccountSnapshot } from '../../account/state.ts';
import { ProRoomApiError } from '../api.ts';
import {
  classifyProAccountIdentityLeaseFailure,
  planProAccountIdentityLease,
  PRO_ACCOUNT_IDENTITY_LEASE_RENEW_INTERVAL_MS,
} from '../account-lease-policy.ts';

const authenticated: AccountSnapshot = {
  status: 'authenticated',
  configured: true,
  account: { nickname: 'Minsu', profileComplete: true },
};

describe('PRO account identity lease policy', () => {
  it('renews a normal signed-in room identity every 40 seconds', () => {
    expect(PRO_ACCOUNT_IDENTITY_LEASE_RENEW_INTERVAL_MS).toBe(40_000);
    expect(planProAccountIdentityLease(authenticated, { isAuthenticated: true })).toBe('renew');
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
