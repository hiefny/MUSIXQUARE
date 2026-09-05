/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';
import { setPeer } from '../../network/peer-state.ts';
import { updateCurrentAccountNickname } from '../nickname.ts';
import {
  __resetAccountSessionForTests,
  reconcileAccountLoginResult,
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('account session mutation ordering', () => {
  it.each([
    ['logout', false],
    ['logout', true],
    ['delete', false],
    ['delete', true],
  ] as const)(
    'reconciles %s after a reachable nickname retry overtakes it (retry settles first=%s)',
    async (action, retrySettlesFirst) => {
      const { readFile } = await import('node:fs/promises');
      const { initAccount, __resetAccountUiForTests } = await import('../../ui/account.ts');
      const { closeDialog } = await import('../../ui/dialog.ts');
      const { initOverlayObservers, __resetModalStackForTests } = await import('../../ui/dom.ts');
      const html = await readFile('index.html', 'utf8');
      document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)![1]!;
      vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
      vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.closest('[hidden]') ? null : this.parentElement;
      });
      const firstPatch = deferred<Response>();
      const retryPatch = deferred<Response>();
      const mutationResponse = deferred<Response>();
      let cookieSession: typeof AUTHENTICATED_OLD | typeof ANONYMOUS = AUTHENTICATED_OLD;
      let patches = 0;
      let mutationStarted = false;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === '/api/auth/session') return Promise.resolve(jsonResponse(cookieSession));
        if (path === '/api/auth/stats') {
          return Promise.resolve(
            jsonResponse({ stats: { sessionCount: 1, listeningSeconds: 1, trackCount: 1 } }),
          );
        }
        if (path === '/api/auth/profile') {
          expect(new Headers(init?.headers).get('X-MXQR-Account-Expected-Scope')).toBe(
            AUTHENTICATED_OLD.statsScope,
          );
          patches += 1;
          return patches === 1 ? firstPatch.promise : retryPatch.promise;
        }
        if (path === (action === 'logout' ? '/api/auth/logout' : '/api/auth/account')) {
          mutationStarted = true;
          cookieSession = ANONYMOUS;
          return mutationResponse.promise;
        }
        throw new Error(`Unexpected account request: ${path}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      const submitNickname = (nickname: string): void => {
        const editor = document.querySelector<HTMLElement>('#dialog-message [role="textbox"]')!;
        expect(editor).not.toBeNull();
        expect(document.getElementById('dialog-overlay')!.hasAttribute('inert')).toBe(false);
        editor.textContent = nickname;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        (document.getElementById('btn-dialog-ok') as HTMLButtonElement).click();
      };
      try {
        initOverlayObservers();
        initAccount();
        await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
        bus.emit('account:open');
        document.getElementById('btn-account-title-edit')!.click();
        submitNickname('New');
        await vi.waitFor(() => expect(patches).toBe(1));
        // Submission closes the generic prompt; the account control is reachable again.
        bus.emit('account:open');
        const button = document.getElementById(`btn-account-${action}`) as HTMLButtonElement;
        expect(button.disabled).toBe(false);
        button.click();
        if (action === 'delete') document.getElementById('btn-dialog-ok')!.click();
        await vi.waitFor(() => expect(mutationStarted).toBe(true));
        // The earlier uniqueness conflict can reopen its actual retry prompt above
        // the pending account action. Its captured account scope is still current.
        firstPatch.resolve(jsonResponse({ error: 'NICKNAME_TAKEN' }, 409));
        await vi.waitFor(() =>
          expect(document.getElementById('dialog-overlay')!.classList.contains('show')).toBe(true),
        );
        submitNickname('Next');
        await vi.waitFor(() => expect(patches).toBe(2));
        const settleRetry = () => retryPatch.resolve(jsonResponse({ error: 'UNAUTHORIZED' }, 401));
        const settleMutation = () => mutationResponse.resolve(jsonResponse({ ok: true }));
        if (retrySettlesFirst) {
          settleRetry();
          await new Promise((resolve) => setTimeout(resolve, 0));
          settleMutation();
        } else {
          settleMutation();
          await new Promise((resolve) => setTimeout(resolve, 0));
          settleRetry();
        }
        await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
        expect(getAccountStatsScope()).toBeNull();
        expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/session')).toHaveLength(
          2,
        );
      } finally {
        closeDialog();
        __resetAccountUiForTests();
        __resetModalStackForTests();
        document.body.innerHTML = '';
      }
    },
  );

  it.each(['failed', 'network-failed', 'successful', 'new-account'] as const)(
    'reconciles a submitted nickname after a newer %s logout without reviving old identity',
    async (outcome) => {
      const { readFile } = await import('node:fs/promises');
      const { initAccount, __resetAccountUiForTests } = await import('../../ui/account.ts');
      const { closeDialog } = await import('../../ui/dialog.ts');
      const { setState } = await import('../../core/state.ts');
      const accountApi = await import('../api.ts');
      const profileUpdate = vi.spyOn(accountApi, 'updateAccountProfile');
      const { initAccountRoomIdentity, __resetAccountRoomIdentityForTests } =
        await import('../room-identity.ts');
      const html = await readFile('index.html', 'utf8');
      document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)![1]!;
      vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
      const oldAccount = {
        ...AUTHENTICATED_OLD,
        account: { nickname: 'Old', profileComplete: true },
      };
      const savedAccount = { ...oldAccount, account: { nickname: 'New', profileComplete: true } };
      let cookieSession = oldAccount as typeof oldAccount | typeof ANONYMOUS;
      const patchResponse = deferred<Response>();
      const projectedNicknames: Array<string | undefined> = [];
      const refreshStandardRoomIdentity = vi.fn(() => {
        projectedNicknames.push(getAccountSnapshot().account?.nickname);
      });
      setPeer({ refreshStandardRoomIdentity } as unknown as Parameters<typeof setPeer>[0]);
      setState('setup.sessionStarted', true);
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        switch (String(input)) {
          case '/api/auth/session':
            return Promise.resolve(jsonResponse(cookieSession));
          case '/api/auth/stats':
            return Promise.resolve(
              jsonResponse({ stats: { sessionCount: 1, listeningSeconds: 1, trackCount: 1 } }),
            );
          case '/api/auth/profile':
            expect(new Headers(init?.headers).get('X-MXQR-Account-Expected-Scope')).toBe(
              oldAccount.statsScope,
            );
            expect(JSON.parse(String(init?.body))).toEqual({ nickname: 'New' });
            // The server committed the rename; only this response body is delayed.
            cookieSession = savedAccount;
            return patchResponse.promise;
          case '/api/auth/logout':
            if (outcome === 'failed')
              return Promise.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
            if (outcome === 'network-failed')
              return Promise.reject(new TypeError('network disconnected'));
            cookieSession = ANONYMOUS;
            return Promise.resolve(jsonResponse({ ok: true }));
          default:
            throw new Error(`Unexpected account request: ${String(input)}`);
        }
      });
      vi.stubGlobal('fetch', fetchMock);
      try {
        initAccountRoomIdentity();
        initAccount();
        await vi.waitFor(() => expect(getAccountSnapshot().account?.nickname).toBe('Old'));
        bus.emit('account:open');
        document.getElementById('btn-account-title-edit')!.click();
        const editor = document.querySelector<HTMLElement>('#dialog-message [role="textbox"]')!;
        editor.textContent = 'New';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btn-dialog-ok')!.click();
        await vi.waitFor(() =>
          expect(fetchMock.mock.calls.some(([path]) => path === '/api/auth/profile')).toBe(true),
        );
        expect(document.getElementById('dialog-overlay')?.classList.contains('show')).toBe(false);
        // The submitted prompt is closed, so the actual account action remains reachable.
        bus.emit('account:open');
        const logoutButton = document.getElementById('btn-account-logout') as HTMLButtonElement;
        expect(logoutButton.disabled).toBe(false);
        logoutButton.click();
        await vi.waitFor(() => expect(logoutButton.disabled).toBe(false));
        if (outcome === 'new-account') {
          cookieSession = AUTHENTICATED_NEW;
          window.dispatchEvent(
            new MessageEvent('message', {
              origin: window.location.origin,
              data: {
                type: 'refresh',
                accountAuth: 'success',
                id: 'result:after-overlapping-logout',
              },
            }),
          );
        }
        const sessionReadsBeforePatch = fetchMock.mock.calls.filter(
          ([path]) => path === '/api/auth/session',
        ).length;
        patchResponse.resolve(jsonResponse(savedAccount));
        await profileUpdate.mock.results[0]!.value;
        if (outcome === 'failed' || outcome === 'network-failed') {
          // A read of the real API proves server state differs from the stale client projection.
          await expect(accountApi.getAccountSession()).resolves.toMatchObject({
            account: { nickname: 'New' },
          });
          await vi.waitFor(() => expect(getAccountSnapshot().account?.nickname).toBe('New'));
          expect(document.getElementById('account-dialog-title-edit-label')?.textContent).toBe(
            'New',
          );
          expect(projectedNicknames.at(-1)).toBe('New');
        } else if (outcome === 'successful') {
          await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
          expect(projectedNicknames.at(-1)).toBeUndefined();
        } else {
          await vi.waitFor(() => expect(getAccountSnapshot().account?.nickname).toBe('Minsu'));
          expect(getAccountStatsScope()).toBe(AUTHENTICATED_NEW.statsScope);
          expect(projectedNicknames.at(-1)).toBe('Minsu');
        }
        expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/session')).toHaveLength(
          sessionReadsBeforePatch + (outcome === 'failed' || outcome === 'network-failed' ? 2 : 1),
        );
      } finally {
        closeDialog();
        __resetAccountRoomIdentityForTests();
        __resetAccountUiForTests();
        document.body.innerHTML = '';
      }
    },
  );

  it.each([false, true])(
    'preserves a successor profile refresh when mutation settled before old Retry: %s',
    async (mutationSettlesFirst) => {
      vi.useFakeTimers();
      const automaticRead = deferred<Response>();
      const profileWrite = deferred<Response>();
      const followUpRead = deferred<Response>();
      const incomplete = {
        ...AUTHENTICATED_NEW,
        account: { nickname: '', profileComplete: false },
      };
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError('initial connection failed'))
        .mockReturnValueOnce(automaticRead.promise)
        .mockResolvedValueOnce(jsonResponse(incomplete))
        .mockReturnValueOnce(profileWrite.promise)
        .mockReturnValueOnce(followUpRead.promise);
      vi.stubGlobal('fetch', fetchMock);
      startAccountSessionRefresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(getAccountSnapshot().status).toBe('unavailable');
      await vi.advanceTimersByTimeAsync(1_000);
      const retry = retryAccountSessionRefresh();

      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          data: {
            type: 'refresh',
            accountAuth: 'success',
            id: 'result:retry-profile-success-0001',
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(getAccountSnapshot().account?.profileComplete).toBe(false);
      // The account subscriber opens first-login nickname completion even while
      // the old account-panel Retry remains pending. Its submit owns this PATCH.
      const profile = updateCurrentAccountNickname('Minsu', AUTHENTICATED_NEW.statsScope);
      expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/auth/profile');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'mxqr-account-refresh',
          newValue: JSON.stringify({ type: 'refresh', id: 'refresh:later-cookie-change-0001' }),
        }),
      );

      if (mutationSettlesFirst) {
        profileWrite.resolve(jsonResponse(AUTHENTICATED_NEW));
        await profile;
      }
      automaticRead.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
      await retry;
      if (!mutationSettlesFirst) {
        profileWrite.resolve(jsonResponse(AUTHENTICATED_NEW));
        await profile;
      }
      expect(fetchMock.mock.calls.filter(([input]) => input === '/api/auth/session')).toHaveLength(
        4,
      );
      followUpRead.resolve(jsonResponse(ANONYMOUS));
      await vi.advanceTimersByTimeAsync(0);
      expect(getAccountSnapshot().status).toBe('anonymous');
    },
  );

  it('discards only the pre-click generic follow-up when a later login result owns the session', async () => {
    vi.useFakeTimers();
    const automaticRead = deferred<Response>();
    const loginRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial connection failed'))
      .mockReturnValueOnce(automaticRead.promise)
      .mockReturnValueOnce(loginRead.promise);
    vi.stubGlobal('fetch', fetchMock);
    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    startAccountSessionRefresh();
    const retry = retryAccountSessionRefresh();
    const login = reconcileAccountLoginResult('result:owns-after-retry-0001');
    automaticRead.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
    await retry;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    loginRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await login;
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

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

  it('waits for Retry-After plus jitter before recovering an initial session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'AUTH_RATE_LIMITED' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(AUTHENTICATED_NEW));
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(getAccountSnapshot().status).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new PageTransitionEvent('pageshow'));
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_499);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets an explicit Retry override a pending server Retry-After once', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'AUTH_RATE_LIMITED' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(AUTHENTICATED_NEW));
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();

    await retryAccountSessionRefresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAccountSnapshot().status).toBe('authenticated');

    await vi.advanceTimersByTimeAsync(61_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a low-rate recovery tail after the bounded fast backoff is exhausted', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial failure'))
      .mockRejectedValueOnce(new TypeError('one-second failure'))
      .mockRejectedValueOnce(new TypeError('three-second failure'))
      .mockRejectedValueOnce(new TypeError('ten-second failure'))
      .mockResolvedValueOnce(jsonResponse(AUTHENTICATED_NEW));
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    expect(fetchMock).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('pauses an exhausted recovery tail while hidden and resumes when visible', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial failure'))
      .mockRejectedValueOnce(new TypeError('one-second failure'))
      .mockRejectedValueOnce(new TypeError('three-second failure'))
      .mockRejectedValueOnce(new TypeError('ten-second failure'))
      .mockResolvedValueOnce(jsonResponse(AUTHENTICATED_NEW));
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('pauses an exhausted recovery tail while offline and resumes when online', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial failure'))
      .mockRejectedValueOnce(new TypeError('one-second failure'))
      .mockRejectedValueOnce(new TypeError('three-second failure'))
      .mockRejectedValueOnce(new TypeError('ten-second failure'))
      .mockResolvedValueOnce(jsonResponse(AUTHENTICATED_NEW));
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    expect(fetchMock).toHaveBeenCalledTimes(5);
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

    const firstExplicitRetry = retryAccountSessionRefresh();
    const coalescedExplicitRetry = retryAccountSessionRefresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAccountSnapshot().account?.nickname).toBe('Old');

    retryRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await vi.waitFor(() => expect(getAccountSnapshot().account?.nickname).toBe('Minsu'));
    await Promise.all([firstExplicitRetry, coalescedExplicitRetry]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits behind a pending automatic retry before making one fresh explicit read', async () => {
    vi.useFakeTimers();
    const automaticRead = deferred<Response>();
    const explicitRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial connection failed'))
      .mockReturnValueOnce(automaticRead.promise)
      .mockReturnValueOnce(explicitRead.promise);
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(getAccountSnapshot().status).toBe('unavailable');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const retry = retryAccountSessionRefresh();
    expect(getAccountSnapshot().status).toBe('loading');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    automaticRead.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(getAccountSnapshot().status).toBe('loading');

    explicitRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await retry;

    expect(getAccountSnapshot().status).toBe('authenticated');
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('still makes a fresh explicit read when the pre-click request fails non-transiently', async () => {
    vi.useFakeTimers();
    const automaticRead = deferred<Response>();
    const explicitRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial connection failed'))
      .mockReturnValueOnce(automaticRead.promise)
      .mockReturnValueOnce(explicitRead.promise);
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const retry = retryAccountSessionRefresh();
    automaticRead.resolve(jsonResponse({ error: 'ACCOUNT_SESSION_REJECTED' }, 403));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(getAccountSnapshot().status).toBe('loading');

    explicitRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await retry;
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');
  });

  it('does not let later external refresh pulses starve an explicit Retry', async () => {
    vi.useFakeTimers();
    const automaticRead = deferred<Response>();
    const firstExternalRead = deferred<Response>();
    const secondExternalRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial connection failed'))
      .mockReturnValueOnce(automaticRead.promise)
      .mockReturnValueOnce(firstExternalRead.promise)
      .mockReturnValueOnce(secondExternalRead.promise);
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = retryAccountSessionRefresh();

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'refresh', id: 'result:retry-race-external-0001' },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'refresh', id: 'result:retry-race-external-0002' },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);

    automaticRead.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
    await retry;
    // The later external operation owns the generation, so Retry yields to it
    // instead of waiting through an unbounded chain of future pulses.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    firstExternalRead.resolve(jsonResponse(ANONYMOUS));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    secondExternalRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await vi.waitFor(() => expect(getAccountSnapshot().account?.nickname).toBe('Minsu'));
  });

  it('re-arms bounded recovery when a newer external read fails during an explicit wait', async () => {
    vi.useFakeTimers();
    const automaticRead = deferred<Response>();
    const externalRead = deferred<Response>();
    const recoveredRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial connection failed'))
      .mockReturnValueOnce(automaticRead.promise)
      .mockReturnValueOnce(externalRead.promise)
      .mockReturnValueOnce(recoveredRead.promise);
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = retryAccountSessionRefresh();

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'refresh', id: 'result:retry-external-failed-0001' },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);

    externalRead.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('unavailable'));
    automaticRead.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
    await retry;

    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    recoveredRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await vi.waitFor(() => expect(getAccountSnapshot().account?.nickname).toBe('Minsu'));
  });

  it('does not start a fresh explicit read after the session lifecycle resets', async () => {
    vi.useFakeTimers();
    const automaticRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial connection failed'))
      .mockReturnValueOnce(automaticRead.promise);
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = retryAccountSessionRefresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    __resetAccountSessionForTests();
    automaticRead.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
    await retry;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces repeated explicit Retry clicks onto one fresh read and promise', async () => {
    vi.useFakeTimers();
    const explicitRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial connection failed'))
      .mockReturnValueOnce(explicitRead.promise);
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);

    const firstRetry = retryAccountSessionRefresh();
    const secondRetry = retryAccountSessionRefresh();
    const thirdRetry = retryAccountSessionRefresh();

    expect(secondRetry).toBe(firstRetry);
    expect(thirdRetry).toBe(firstRetry);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    explicitRead.resolve(jsonResponse(ANONYMOUS));
    await Promise.all([firstRetry, secondRetry, thirdRetry]);

    expect(getAccountSnapshot().status).toBe('anonymous');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not let an explicit recovery result overwrite a newer popup reconciliation', async () => {
    vi.useFakeTimers();
    const explicitRead = deferred<Response>();
    const popupRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial connection failed'))
      .mockReturnValueOnce(explicitRead.promise)
      .mockReturnValueOnce(popupRead.promise);
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);

    const retry = retryAccountSessionRefresh();
    const reconciliation = reconcileAccountLoginSession();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    popupRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await expect(reconciliation).resolves.toEqual(AUTHENTICATED_NEW);
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');

    explicitRead.resolve(jsonResponse(ANONYMOUS));
    await retry;

    expect(getAccountSnapshot().status).toBe('authenticated');
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('restarts bounded backoff at one second when the fresh explicit read fails', async () => {
    vi.useFakeTimers();
    const pendingAutomaticRead = deferred<Response>();
    const pendingExplicitRead = deferred<Response>();
    const recoveredRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('initial connection failed'))
      .mockReturnValueOnce(pendingAutomaticRead.promise)
      .mockReturnValueOnce(pendingExplicitRead.promise)
      .mockReturnValueOnce(recoveredRead.promise);
    vi.stubGlobal('fetch', fetchMock);

    startAccountSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const retry = retryAccountSessionRefresh();
    pendingAutomaticRead.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    pendingExplicitRead.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
    await retry;
    expect(getAccountSnapshot().status).toBe('unavailable');

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    recoveredRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await vi.waitFor(() => expect(getAccountSnapshot().account?.nickname).toBe('Minsu'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
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

  it('shares an identified result read when the session listener receives it before the UI', async () => {
    const completedLoginRead = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ANONYMOUS))
      .mockReturnValueOnce(completedLoginRead.promise);
    vi.stubGlobal('fetch', fetchMock);

    // Bind the lower-level lifecycle first, matching the inverse of the usual
    // UI initialization order.
    startAccountSessionRefresh();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    const completedPulse = {
      type: 'refresh',
      accountAuth: 'success',
      id: 'result:listener-first-0001',
    };
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: completedPulse,
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const uiOperation = reconcileAccountLoginResult(completedPulse.id);
    const duplicateOperation = reconcileAccountLoginResult(completedPulse.id);
    expect(uiOperation).not.toBeNull();
    expect(duplicateOperation).toBe(uiOperation);

    completedLoginRead.resolve(jsonResponse(AUTHENTICATED_NEW));
    await expect(uiOperation).resolves.toEqual(AUTHENTICATED_NEW);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'mxqr-account-refresh',
        newValue: JSON.stringify(completedPulse),
      }),
    );
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('binds later account lifecycle pulses from a same-tab login reconciliation', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(AUTHENTICATED_NEW))
      .mockResolvedValueOnce(jsonResponse(ANONYMOUS));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reconcileAccountLoginResult('result:same-tab-0001')).resolves.toEqual(
      AUTHENTICATED_NEW,
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'refresh',
          accountAuth: 'success',
          id: 'result:later-lifecycle-0002',
        },
      }),
    );

    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it('defers an exact login-success result until an in-flight logout commits', async () => {
    applyAccountSession(AUTHENTICATED_NEW);
    const logout = deferred<Response>();
    const postMutationRead = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/logout') return logout.promise;
      if (path === '/api/auth/session') return postMutationRead.promise;
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const logoutOperation = signOutAccount();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'refresh',
          accountAuth: 'success',
          id: 'result:during-logout-0001',
        },
      }),
    );
    const resultOperation = reconcileAccountLoginResult('result:during-logout-0001');
    expect(resultOperation).not.toBeNull();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(['/api/auth/logout']);

    logout.resolve(jsonResponse({ ok: true }));
    await logoutOperation;
    expect(getAccountSnapshot().status).toBe('anonymous');
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/auth/logout',
      '/api/auth/session',
    ]);

    postMutationRead.resolve(jsonResponse(ANONYMOUS));
    await expect(resultOperation).resolves.toEqual(ANONYMOUS);
    expect(getAccountSnapshot().status).toBe('anonymous');
  });

  it('shares one post-mutation read across queued success IDs and a generic refresh', async () => {
    applyAccountSession(AUTHENTICATED_NEW);
    const logout = deferred<Response>();
    const postMutationRead = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/logout') return logout.promise;
      if (path === '/api/auth/session') return postMutationRead.promise;
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const logoutOperation = signOutAccount();
    const first = reconcileAccountLoginResult('result:queued-batch-0001');
    const second = reconcileAccountLoginResult('result:queued-batch-0002');
    startAccountSessionRefresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    logout.resolve(jsonResponse({ ok: true }));
    await logoutOperation;
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/auth/logout',
      '/api/auth/session',
    ]);

    postMutationRead.resolve(jsonResponse(ANONYMOUS));
    await expect(first).resolves.toEqual(ANONYMOUS);
    await expect(second).resolves.toEqual(ANONYMOUS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects every queued success result from one failed post-mutation read', async () => {
    applyAccountSession(AUTHENTICATED_NEW);
    const logout = deferred<Response>();
    const postMutationRead = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/logout') return logout.promise;
      if (path === '/api/auth/session') return postMutationRead.promise;
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const logoutOperation = signOutAccount();
    const first = reconcileAccountLoginResult('result:failed-batch-0001');
    const second = reconcileAccountLoginResult('result:failed-batch-0002');
    startAccountSessionRefresh();
    logout.resolve(jsonResponse({ ok: true }));
    await logoutOperation;

    postMutationRead.resolve(jsonResponse({ error: 'ACCOUNT_REQUEST_FAILED' }, 503));
    await expect(first).rejects.toMatchObject({ status: 503 });
    await expect(second).rejects.toMatchObject({ status: 503 });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/auth/logout',
      '/api/auth/session',
    ]);
  });

  it('does not evict an active result promise when the recent-ID window overflows', async () => {
    const logout = deferred<Response>();
    const postMutationRead = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/auth/logout') return logout.promise;
        if (path === '/api/auth/session') return postMutationRead.promise;
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    const logoutOperation = signOutAccount();
    const operations = Array.from({ length: 40 }, (_, index) =>
      reconcileAccountLoginResult(`result:overflow-${String(index).padStart(4, '0')}`),
    );
    expect(reconcileAccountLoginResult('result:overflow-0000')).toBe(operations[0]);
    expect(reconcileAccountLoginResult('result:overflow-0039')).toBe(operations[39]);

    logout.resolve(jsonResponse({ ok: true }));
    await logoutOperation;
    postMutationRead.resolve(jsonResponse(ANONYMOUS));
    await Promise.all(operations);
  });

  it('always emits local account deletion after an overlapping stale read', async () => {
    applyAccountSession(AUTHENTICATED_OLD);
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
    applyAccountSession(AUTHENTICATED_OLD);
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
        statsScope: 'n'.repeat(43),
      }),
    );

    await expect(operation).resolves.toMatchObject({ nickname: 'New' });
    expect(getAccountSnapshot().account?.nickname).toBe('New');

    reconciledRead.resolve(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'New', profileComplete: true },
        statsScope: 'n'.repeat(43),
      }),
    );
    await vi.waitFor(() => expect(getAccountSnapshot().account?.nickname).toBe('New'));
  });
});
