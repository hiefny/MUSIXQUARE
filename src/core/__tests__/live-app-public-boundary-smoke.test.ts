import { describe, expect, it, vi } from 'vitest';

import {
  APP_PUBLIC_BOUNDARY_TIMEOUT_MS,
  verifyAnonymousAccountSessionBoundary,
} from '../../../scripts/live-app-public-boundary-smoke.mjs';

describe('live app public boundary smoke', () => {
  it('accepts only the no-store anonymous account-session projection', async () => {
    const read = vi.fn(async () => ({
      status: 200,
      cacheControl: 'no-store, max-age=0',
      setCookie: null,
      payload: { configured: true, authenticated: false, account: null },
    }));

    await expect(verifyAnonymousAccountSessionBoundary({ read })).resolves.toEqual({
      configured: true,
      anonymousSessionRejected: true,
    });
    expect(read).toHaveBeenCalledOnce();
    expect(APP_PUBLIC_BOUNDARY_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it.each([
    {
      status: 200,
      cacheControl: 'no-store',
      setCookie: null,
      payload: { configured: true, authenticated: true, account: {} },
    },
    {
      status: 200,
      cacheControl: 'public, max-age=60',
      setCookie: null,
      payload: { configured: true, authenticated: false, account: null },
    },
    {
      status: 200,
      cacheControl: 'no-store',
      setCookie: '__Host-mxqr_account=unexpected',
      payload: { configured: true, authenticated: false, account: null },
    },
  ])('rejects a permissive or cacheable boundary %#', async (result) => {
    await expect(
      verifyAnonymousAccountSessionBoundary({ read: async () => result }),
    ).rejects.toThrow();
  });

  it('allows unrelated infrastructure cookies', async () => {
    const read = vi.fn(async () => ({
      status: 200,
      cacheControl: 'private, no-store',
      setCookie: '__cf_bm=opaque; Path=/; Secure; HttpOnly',
      payload: { configured: true, authenticated: false, account: null },
    }));

    await expect(verifyAnonymousAccountSessionBoundary({ read })).resolves.toEqual({
      configured: true,
      anonymousSessionRejected: true,
    });
  });
});
