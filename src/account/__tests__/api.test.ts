/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGoogleLoginUrl,
  deleteAccount,
  getAccountSession,
  getStandardRoomIdentityAssertions,
  updateAccountProfile,
} from '../api.ts';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('account API client', () => {
  it('parses an authenticated session without exposing transport-only fields', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
        session: { expiresAt: 1234 },
      }),
    );

    await expect(getAccountSession()).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: { nickname: 'Minsu', profileComplete: true },
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('sends the account CSRF marker on profile mutations', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Jisu', profileComplete: true },
      }),
    );

    await updateAccountProfile('Jisu');

    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/profile',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-MXQR-Account-CSRF': '1',
        }),
        body: JSON.stringify({ nickname: 'Jisu' }),
      }),
    );
  });

  it('requires explicit confirmation for account deletion', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));

    await deleteAccount();

    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/account',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ confirm: true }) }),
    );
  });

  it('parses attach and deletion room assertions without confusing their authority', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ assertion: 'attach-proof' }))
      .mockResolvedValueOnce(jsonResponse({ assertion: null, deletionAssertion: 'delete-proof' }));
    const request = { roomCode: '123456', peerId: 'guest-a', role: 'guest' as const };

    await expect(getStandardRoomIdentityAssertions(request)).resolves.toEqual({
      accountAssertion: 'attach-proof',
      deletionAssertion: null,
    });
    await expect(getStandardRoomIdentityAssertions(request)).resolves.toEqual({
      accountAssertion: null,
      deletionAssertion: 'delete-proof',
    });
  });

  it('rejects a room assertion response that grants attach and delete at once', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ assertion: 'attach-proof', deletionAssertion: 'delete-proof' }),
    );

    await expect(
      getStandardRoomIdentityAssertions({
        roomCode: '123456',
        peerId: 'guest-a',
        role: 'guest',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_INVALID_RESPONSE' });
  });

  it('preserves a server error code and status', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'ACCOUNT_NICKNAME_INVALID' }, 400));

    await expect(updateAccountProfile('x')).rejects.toMatchObject({
      code: 'ACCOUNT_NICKNAME_INVALID',
      status: 400,
    });
  });

  it('keeps OAuth returnTo on the current origin path', () => {
    expect(buildGoogleLoginUrl({ pathname: '/000001', search: '?tab=chat', hash: '#latest' })).toBe(
      '/api/auth/google/start?returnTo=%2F000001%3Ftab%3Dchat%23latest',
    );
    expect(
      buildGoogleLoginUrl(
        { pathname: '/000001', search: '?tab=chat', hash: '#latest' },
        '/account-complete.html',
      ),
    ).toBe('/api/auth/google/start?returnTo=%2Faccount-complete.html');
  });
});
