/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';
import { setPeer } from '../../network/peer-state.ts';
import {
  __resetAccountSessionForTests,
  reconcileAccountLoginSession,
  removeAccount,
  saveAccountNickname,
  signOutAccount,
  startAccountSessionRefresh,
} from '../session.ts';
import {
  __resetAccountStateForTests,
  applyAccountSession,
  getAccountSnapshot,
  getAccountStatsScope,
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
  setPeer(null);
  vi.unstubAllGlobals();
});

describe('account session mutation ordering', () => {
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
