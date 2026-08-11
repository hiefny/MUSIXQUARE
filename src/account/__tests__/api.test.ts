/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAccountStats,
  buildGoogleLoginUrl,
  deleteAccount,
  getAccountSession,
  getAccountStats,
  getStandardRoomIdentityAssertions,
  updateAccountProfile,
} from '../api.ts';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const STATS_SCOPE = 'a'.repeat(43);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('account API client', () => {
  it('parses an authenticated session without exposing transport-only fields', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
        statsScope: STATS_SCOPE,
        session: { expiresAt: 1234 },
      }),
    );

    await expect(getAccountSession()).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: { nickname: 'Minsu', profileComplete: true },
      statsScope: STATS_SCOPE,
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('bounds a stalled session read to five seconds without shortening mutation deadlines', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });

    const sessionResult = getAccountSession().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(sessionResult).resolves.toMatchObject({
      code: 'ACCOUNT_NETWORK_ERROR',
      status: 0,
    });

    const mutationResult = updateAccountProfile('Jisu').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(mutationResult).resolves.toMatchObject({
      code: 'ACCOUNT_NETWORK_ERROR',
      status: 0,
    });
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

  it('reads aggregate account stats and sends bounded deltas with the CSRF marker', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          stats: { sessionCount: 7, listeningSeconds: 3_661, trackCount: 42 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          stats: { sessionCount: 8, listeningSeconds: 3_691, trackCount: 43 },
        }),
      );

    await expect(getAccountStats()).resolves.toEqual({
      sessionCount: 7,
      listeningSeconds: 3_661,
      trackCount: 42,
    });
    await expect(
      addAccountStats(
        {
          sessionCountDelta: 1,
          listeningSecondsDelta: 30,
          trackCountDelta: 1,
        },
        STATS_SCOPE,
      ),
    ).resolves.toEqual({
      sessionCount: 8,
      listeningSeconds: 3_691,
      trackCount: 43,
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/auth/stats',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/auth/stats',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-MXQR-Account-CSRF': '1',
          'X-MXQR-Account-Stats-Scope': STATS_SCOPE,
        }),
        body: JSON.stringify({
          sessionCountDelta: 1,
          listeningSecondsDelta: 30,
          trackCountDelta: 1,
        }),
      }),
    );
  });

  it('rejects malformed aggregate account stats', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        stats: { sessionCount: 1, listeningSeconds: -1, trackCount: 2 },
      }),
    );

    await expect(getAccountStats()).rejects.toMatchObject({
      code: 'ACCOUNT_INVALID_RESPONSE',
      status: 502,
    });
  });

  it('fails closed before sending an aggregate write without a valid session scope', async () => {
    await expect(
      addAccountStats(
        {
          sessionCountDelta: 1,
          listeningSecondsDelta: 0,
          trackCountDelta: 0,
        },
        'not-a-valid-scope',
      ),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_STATS_SCOPE_INVALID',
      status: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation for account deletion', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));

    await expect(deleteAccount()).resolves.toEqual({ pending: false });

    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/account',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ confirm: true }) }),
    );
  });

  it('reports a 202 account deletion as pending instead of completed', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true, pending: true }, 202));

    await expect(deleteAccount()).resolves.toEqual({ pending: true });
  });

  it('parses attach and deletion room assertions without confusing their authority', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ assertion: 'attach-proof', deletionAssertion: null }))
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
