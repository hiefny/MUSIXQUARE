/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';
import { setPeer } from '../../network/peer-state.ts';
import {
  __resetAccountSessionForTests,
  reconcileAccountLoginSession,
  removeAccount,
  retryAccountSessionRefresh,
  saveAccountNickname,
  signOutAccount,
  startAccountSessionRefresh,
} from '../session.ts';
import {
  __resetAccountStateForTests,
  applyAccountSession,
  getAccountSnapshot,
  getAccountStatsScope,
  subscribeAccount,
} from '../state.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const AUTHENTICATED_OLD = {
  configured: true,
  authenticated: true,
  account: { nickname: 'Old', profileComplete: true },
  statsScope: 'o'.repeat(43),
};
const AUTHENTICATED_NEW = {
  configured: true,
  authenticated: true,
  account: { nickname: 'Minsu', profileComplete: true },
  statsScope: 'n'.repeat(43),
};
const ANONYMOUS = {
  configured: true,
  authenticated: false,
  account: null,
  statsScope: null,
};

beforeEach(() => {
  __resetAccountSessionForTests();
  __resetAccountStateForTests();
  resetState();
  setPeer(null);
  bus.clear();
});

afterEach(() => {
  __resetAccountSessionForTests();
  setPeer(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('account session mutation ordering', () => {
  it('recovers a failed initial session with bounded 1s, 3s, and 10s retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection aborted'))
      .mockRejectedValueOnce(new TypeError('service worker restarting'))
      .mockRejectedValueOnce(new TypeError('still reconnecting'))
      .mockResolvedValueOnce(jsonResponse(AUTHENTICATED_NEW));
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(getAccountSnapshot().status).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not automatically retry a non-transient account rejection', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: 'ACCOUNT_REQUEST_REJECTED' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(getAccountSnapshot().status).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('defers recovery while offline and resumes once without a focus storm', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const retryRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockReturnValueOnce(retryRead.promise);
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(getAccountSnapshot().status).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new PageTransitionEvent('pageshow'));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    retryRead.resolve(jsonResponse(ANONYMOUS));
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets an explicit retry probe once when navigator.onLine is stale false', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('radio path interrupted'))
      .mockResolvedValueOnce(jsonResponse(ANONYMOUS));
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(getAccountSnapshot().status).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledOnce();

    await retryAccountSessionRefresh();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAccountSnapshot().status).toBe('anonymous');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  it('defers background recovery until the page becomes visible', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('background fetch aborted'))
      .mockResolvedValueOnce(jsonResponse(ANONYMOUS));
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(getAccountSnapshot().status).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAccountSnapshot().status).toBe('anonymous');
  });

  it('keeps an authenticated snapshot during transient recovery and supports explicit retry', async () => {
    vi.useFakeTimers();
    applyAccountSession(AUTHENTICATED_OLD);
    const retryRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection aborted'))
      .mockReturnValueOnce(retryRead.promise);
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getAccountSnapshot().status).toBe('authenticated');
    expect(getAccountSnapshot().account?.nickname).toBe('Old');

    retryAccountSessionRefresh();
    retryAccountSessionRefresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAccountSnapshot().account?.nickname).toBe('Old');

    retryRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await vi.waitFor(() => expect(getAccountSnapshot().account?.nickname).toBe('Minsu'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets an exact popup reconciliation replace a pending recovery timer', async () => {
    vi.useFakeTimers();
    const popupRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial read aborted'))
      .mockReturnValueOnce(popupRead.promise);
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(getAccountSnapshot().status).toBe('unavailable');

    const reconciliation = reconcileAccountLoginSession();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    popupRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await expect(reconciliation).resolves.toEqual(AUTHENTICATED_NEW);
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');
  });

  it('cancels a pending account recovery at teardown', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(getAccountSnapshot().status).toBe('unavailable');
    __resetAccountSessionForTests();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps the aggregate-write fence outside the public account profile and clears it on logout', () => {
    const statsScope = 's'.repeat(43);
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Minsu', profileComplete: true },
      statsScope,
    });

    expect(getAccountStatsScope()).toBe(statsScope);
    expect(getAccountSnapshot().account).toEqual({
      nickname: 'Minsu',
      profileComplete: true,
    });

    applyAccountSession(ANONYMOUS);
    expect(getAccountStatsScope()).toBeNull();
  });

  it('refreshes the visible session after a same-origin login popup completes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ANONYMOUS))
      .mockResolvedValueOnce(jsonResponse(AUTHENTICATED_NEW));
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));

    // An unrelated window cannot force an account read. The OAuth completion
    // page sends this exact payload from the app's own origin.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://untrusted.example',
        data: { type: 'refresh', accountAuth: 'success' },
      }),
    );
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'refresh', accountAuth: 'success' },
      }),
    );

    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/auth/session',
      '/api/auth/session',
    ]);
  });

  it('deduplicates one popup completion across channels while fencing a pre-login read', async () => {
    applyAccountSession(AUTHENTICATED_OLD);
    const staleRead = deferred<Response>();
    const completedLoginRead = deferred<Response>();
    const laterFailedRead = deferred<Response>();
    const laterAnonymousRead = deferred<Response>();
    const sessionReads = [staleRead, completedLoginRead, laterFailedRead, laterAnonymousRead];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      expect(String(input)).toBe('/api/auth/session');
      return sessionReads.shift()!.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    const projectedStatuses: string[] = [];
    const unsubscribe = subscribeAccount((snapshot) => projectedStatuses.push(snapshot.status));

    startAccountSessionRefresh();
    const completedPulse = { type: 'refresh', id: 'result:completed-login-0001' };
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: completedPulse,
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: completedPulse,
      }),
    );
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'mxqr-account-refresh',
        newValue: JSON.stringify(completedPulse),
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    completedLoginRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await vi.waitFor(() => expect(getAccountSnapshot().account?.nickname).toBe('Minsu'));

    staleRead.resolve(jsonResponse(ANONYMOUS));
    await Promise.resolve();
    await Promise.resolve();

    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');
    expect(projectedStatuses).not.toContain('anonymous');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A delayed delivery of the same completion stays deduplicated even after
    // its read has settled. A genuinely later nonce still starts a fresh read.
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'mxqr-account-refresh',
        newValue: JSON.stringify(completedPulse),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'refresh', id: 'result:later-change-0002' },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    laterFailedRead.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'refresh', id: 'result:later-change-0003' },
      }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');
    laterAnonymousRead.resolve(jsonResponse(ANONYMOUS));
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    unsubscribe();
  });

  it('preserves a valid legacy pulse result when its duplicate follow-up fails', async () => {
    const initialRead = deferred<Response>();
    const completedLoginRead = deferred<Response>();
    const duplicateFollowUpRead = deferred<Response>();
    const sessionReads = [initialRead, completedLoginRead, duplicateFollowUpRead];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      expect(String(input)).toBe('/api/auth/session');
      return sessionReads.shift()!.promise;
    });
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    initialRead.resolve(jsonResponse(ANONYMOUS));
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));

    // Older completion pages sent equivalent pulses without an ID. The first
    // fresh response must remain applicable; later copies only queue a
    // compatibility follow-up rather than fencing it.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'refresh' },
      }),
    );
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'mxqr-account-refresh',
        newValue: 'legacy-opaque-pulse',
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    completedLoginRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await vi.waitFor(() => expect(getAccountSnapshot().account?.nickname).toBe('Minsu'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    duplicateFollowUpRead.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');
  });

  it('reconciles the exact popup session and fences an older account read', async () => {
    const oldRead = deferred<Response>();
    const reconciledRead = deferred<Response>();
    const sessionReads = [oldRead, reconciledRead];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      expect(String(input)).toBe('/api/auth/session');
      return sessionReads.shift()!.promise;
    });
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    const reconciliation = reconcileAccountLoginSession();
    reconciledRead.resolve(jsonResponse(AUTHENTICATED_NEW));

    await expect(reconciliation).resolves.toEqual(AUTHENTICATED_NEW);
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');

    oldRead.resolve(jsonResponse(AUTHENTICATED_OLD));
    await Promise.resolve();
    await Promise.resolve();
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marks an anonymous account unavailable when popup reconciliation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('session unavailable')));

    await expect(reconcileAccountLoginSession()).rejects.toThrow('ACCOUNT_NETWORK_ERROR');
    expect(getAccountSnapshot().status).toBe('unavailable');
  });

  it('emits a storage pulse for tabs without BroadcastChannel support', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe('/api/auth/logout');
        return jsonResponse({ ok: true });
      }),
    );

    await signOutAccount();

    expect(setItem).toHaveBeenCalledWith('mxqr-account-refresh', expect.any(String));
    const rawPulse = setItem.mock.calls.find(([key]) => key === 'mxqr-account-refresh')?.[1];
    expect(JSON.parse(String(rawPulse))).toMatchObject({
      type: 'refresh',
      id: expect.stringMatching(/^refresh:/),
    });
  });

  it('reuses one mutation nonce across BroadcastChannel and storage delivery', async () => {
    const broadcastMessages: unknown[] = [];
    class TestBroadcastChannel {
      constructor(_name: string) {}

      addEventListener(): void {}

      removeEventListener(): void {}

      postMessage(message: unknown): void {
        broadcastMessages.push(message);
      }

      close(): void {}
    }
    vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/auth/session') return jsonResponse(ANONYMOUS);
        if (path === '/api/auth/logout') return jsonResponse({ ok: true });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    startAccountSessionRefresh();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    await signOutAccount();

    const rawPulse = setItem.mock.calls.findLast(([key]) => key === 'mxqr-account-refresh')?.[1];
    const storedPulse = JSON.parse(String(rawPulse)) as Record<string, unknown>;
    expect(storedPulse).toMatchObject({
      type: 'refresh',
      id: expect.stringMatching(/^refresh:/),
    });
    expect(broadcastMessages).toEqual([storedPulse]);
  });

  it('does not let an older session read suppress or undo a completed logout', async () => {
    const oldRead = deferred<Response>();
    const logout = deferred<Response>();
    const reconciledRead = deferred<Response>();
    const sessionReads = [oldRead, reconciledRead];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/auth/session') return sessionReads.shift()!.promise;
        if (path === '/api/auth/logout') return logout.promise;
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    startAccountSessionRefresh();
    const operation = signOutAccount();
    // A focus/login completion refresh during the mutation must wait instead
    // of becoming a newer generation that suppresses logout completion.
    startAccountSessionRefresh();
    oldRead.resolve(jsonResponse(AUTHENTICATED_OLD));
    await Promise.resolve();
    logout.resolve(jsonResponse({ ok: true }));

    await operation;
    expect(getAccountSnapshot().status).toBe('anonymous');
    expect(sessionReads).toHaveLength(0);

    reconciledRead.resolve(jsonResponse(ANONYMOUS));
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
  });

  it('always emits local account deletion after an overlapping stale read', async () => {
    const oldRead = deferred<Response>();
    const deletion = deferred<Response>();
    const reconciledRead = deferred<Response>();
    const sessionReads = [oldRead, reconciledRead];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/auth/session') return sessionReads.shift()!.promise;
        if (path === '/api/auth/account') return deletion.promise;
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const deleted = vi.fn();
    bus.on('account:deleted', deleted);

    startAccountSessionRefresh();
    const operation = removeAccount();
    startAccountSessionRefresh();
    oldRead.resolve(jsonResponse(AUTHENTICATED_OLD));
    deletion.resolve(jsonResponse({ ok: true }));

    await expect(operation).resolves.toEqual({ pending: false });
    expect(deleted).toHaveBeenCalledOnce();
    expect(getAccountSnapshot().status).toBe('anonymous');

    reconciledRead.resolve(jsonResponse(ANONYMOUS));
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
  });

  it('keeps a 202 deletion pending while revoking local account and room identity state', async () => {
    applyAccountSession(AUTHENTICATED_NEW);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe('/api/auth/account');
        return jsonResponse({ ok: true, pending: true }, 202);
      }),
    );
    const deleted = vi.fn();
    const pending = vi.fn();
    bus.on('account:deleted', deleted);
    bus.on('account:deletion-pending', pending);

    await expect(removeAccount()).resolves.toEqual({ pending: true });

    expect(deleted).not.toHaveBeenCalled();
    expect(pending).toHaveBeenCalledOnce();
    expect(getAccountSnapshot().status).toBe('anonymous');
  });

  it('keeps a saved nickname authoritative over a read started before the save', async () => {
    const oldRead = deferred<Response>();
    const save = deferred<Response>();
    const reconciledRead = deferred<Response>();
    const sessionReads = [oldRead, reconciledRead];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/auth/session') return sessionReads.shift()!.promise;
        if (path === '/api/auth/profile') return save.promise;
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    startAccountSessionRefresh();
    const operation = saveAccountNickname('New');
    startAccountSessionRefresh();
    oldRead.resolve(jsonResponse(AUTHENTICATED_OLD));
    save.resolve(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'New', profileComplete: true },
      }),
    );

    await expect(operation).resolves.toMatchObject({ nickname: 'New' });
    expect(getAccountSnapshot().account?.nickname).toBe('New');

    reconciledRead.resolve(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'New', profileComplete: true },
      }),
    );
    await vi.waitFor(() => expect(getAccountSnapshot().account?.nickname).toBe('New'));
  });
});
