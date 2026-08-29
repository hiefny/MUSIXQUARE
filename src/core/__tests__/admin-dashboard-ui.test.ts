// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileClassicRuntimeForBrowserTest } from './classic-runtime-test-asset.ts';

const adminScript = compileClassicRuntimeForBrowserTest('admin.js');
const adminStyles = readFileSync(resolve(process.cwd(), 'public/admin.css'), 'utf8');

function installAdminDom(): void {
  document.body.innerHTML = `
    <main class="admin-shell" data-admin-configured="true">
      <section data-login-panel>
        <form data-login-form><input name="password"><button type="submit">Login</button></form>
        <p data-login-status></p>
      </section>
      <section data-dashboard hidden>
        <h1 data-dashboard-title></h1><p data-updated-at></p>
        <button data-refresh>Refresh</button><button data-logout>Logout</button>
        <nav>
          <button data-admin-tab="operations">Operations</button>
          <button data-admin-tab="pro-rooms">PRO Rooms</button>
        </nav>
        <section data-admin-view="operations">
          <div data-metric-cards></div><div data-hourly-chart></div>
          <div data-daily-list></div><div data-monthly-chart></div><div data-signal-grid></div>
        </section>
        <section data-admin-view="pro-rooms" hidden>
          <form data-pro-room-form>
            <input data-pro-room-code><input data-pro-room-label>
            <button data-pro-room-register type="submit">Register</button>
          </form>
          <p data-pro-room-status></p><p data-pro-room-list-status></p>
          <div data-pro-room-list></div>
          <section data-pro-room-claim hidden>
            <strong data-pro-room-claim-title></strong><span data-pro-room-claim-expiry></span>
            <input data-pro-room-claim-url><button data-pro-room-claim-copy>Copy</button>
            <button data-pro-room-claim-dismiss>Dismiss</button>
          </section>
        </section>
      </section>
    </main>`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('admin PRO room claim lifecycle', () => {
  it('filters registered rooms by room code or administrator label', async () => {
    installAdminDom();
    const listStatus = document.querySelector('[data-pro-room-list-status]');
    const search = document.createElement('input');
    search.type = 'search';
    search.dataset.proRoomSearch = '';
    listStatus?.before(search);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          rooms: [
            {
              roomCode: '000101',
              roomGeneration: 0,
              label: 'Spring campaign',
              status: 'registered',
              activationState: 'unactivated',
            },
            {
              roomCode: '000202',
              roomGeneration: 0,
              label: 'Partner index B',
              status: 'registered',
              activationState: 'unactivated',
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/pro-grants/campaigns') {
        return Response.json({ campaigns: [] });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Spring campaign'));

    search.value = 'partner';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-pro-room-list-status]')?.textContent).toBe(
        '1 of 2 rooms',
      );
    });
    expect(document.body.textContent).not.toContain('Spring campaign');
    expect(document.body.textContent).toContain('Partner index B');

    search.value = '0101';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Spring campaign'));
    expect(document.body.textContent).not.toContain('Partner index B');

    search.value = 'missing';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('No rooms match “missing”.'),
    );
  });

  it('renders account totals and accessible cumulative room and guest-join lines', async () => {
    installAdminDom();
    const operations = document.querySelector('[data-admin-view="operations"]');
    const accounts = document.createElement('div');
    accounts.dataset.accountMetrics = '';
    const lifetimeMetrics = document.createElement('div');
    lifetimeMetrics.dataset.lifetimeMetrics = '';
    const lifetimeChart = document.createElement('div');
    lifetimeChart.dataset.lifetimeChart = '';
    operations?.prepend(accounts);
    operations?.append(lifetimeMetrics, lifetimeChart);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
        if (url.pathname === '/api/admin/session') {
          return Response.json({ authenticated: true, configured: true });
        }
        if (url.pathname === '/api/admin/metrics') {
          return Response.json({
            generatedAt: '2026-08-28T00:00:00.000Z',
            accounts: {
              totalAccounts: 321,
              nicknameCompleteAccounts: 210,
              inactiveAccounts: 45,
              inactiveDays: 30,
            },
            lifetime: {
              startedAt: '2026-06-18T00:00:00.000Z',
              totals: { roomsOpened: 1_600, guestJoins: 3_250 },
              points: [
                { start: '2026-06-18T00:00:00.000Z', roomsOpened: 10, guestJoins: 25 },
                { start: '2026-08-28T00:00:00.000Z', roomsOpened: 1_600, guestJoins: 3_250 },
              ],
            },
            cards: [],
            summary: { hourly: [], daily: [], daily30: [], last24: {} },
          });
        }
        return Response.json({ ok: true });
      }),
    );

    window.eval(adminScript);
    await vi.waitFor(() => expect(accounts.textContent).toContain('321'));
    expect(accounts.textContent).toContain('Active accounts');
    expect(accounts.textContent).toContain('210');
    expect(accounts.textContent).toContain('45');
    expect(lifetimeMetrics.textContent).toContain('1,600');
    expect(lifetimeMetrics.textContent).toContain('3,250');
    expect(lifetimeMetrics.textContent).toContain('repeats included');
    expect(lifetimeChart.querySelectorAll('path.lifetime-line')).toHaveLength(2);
    expect(lifetimeChart.getAttribute('role')).toBe('img');
    expect(lifetimeChart.getAttribute('aria-label')).toContain('repeat connections included');
  });

  it('fails closed when an admin response exceeds the bounded body size', async () => {
    installAdminDom();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return new Response('{}', {
          headers: { 'Content-Length': String(1_048_577) },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-login-status]')?.textContent).toContain(
        'unexpectedly large response',
      );
    });
    expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(true);
  });

  it('warns that a timed-out mutation may already have completed', async () => {
    installAdminDom();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
        if (url.pathname === '/api/admin/session') {
          return Response.json({ authenticated: false, configured: true });
        }
        if (url.pathname === '/api/admin/login') {
          return new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new DOMException('Aborted', 'AbortError'));
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        return Response.json({ ok: true });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Let init finish consuming the anonymous session response before the
    // login mutation starts; otherwise init intentionally invalidates it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.useFakeTimers();
    const form = document.querySelector<HTMLFormElement>('[data-login-form]');
    form
      ?.querySelector<HTMLInputElement>('input[name="password"]')
      ?.setAttribute('value', 'secret');
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(20_001);
    expect(document.querySelector('[data-login-status]')?.textContent).toContain(
      'may have completed',
    );
    vi.useRealTimers();
  });

  it('keeps an in-flight dashboard response from reappearing after logout', async () => {
    installAdminDom();
    let metricsReads = 0;
    let resolveDelayedMetrics: ((response: Response) => void) | undefined;
    const delayedMetrics = new Promise<Response>((resolve) => {
      resolveDelayedMetrics = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        metricsReads += 1;
        if (metricsReads > 1) return delayedMetrics;
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });

    document.querySelector<HTMLButtonElement>('[data-refresh]')?.click();
    await vi.waitFor(() => expect(metricsReads).toBe(2));
    document.querySelector<HTMLButtonElement>('[data-logout]')?.click();
    expect(document.querySelector<HTMLElement>('[data-login-panel]')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(true);

    resolveDelayedMetrics?.(
      Response.json({
        generatedAt: new Date().toISOString(),
        cards: [{ label: 'stale-secret-card', value: 1 }],
        summary: { hourly: [], daily: [], daily30: [], last24: {} },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(true);
    expect(document.body.textContent).not.toContain('stale-secret-card');
  });

  it('does not let a new login race ahead of the pending logout cookie clear', async () => {
    installAdminDom();
    let resolveLogout: ((response: Response) => void) | undefined;
    const pendingLogout = new Promise<Response>((resolve) => {
      resolveLogout = resolve;
    });
    let loginReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/logout') return pendingLogout;
      if (url.pathname === '/api/admin/login') {
        loginReads += 1;
        return Response.json({ authenticated: true });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });

    document.querySelector<HTMLButtonElement>('[data-logout]')?.click();
    const loginForm = document.querySelector<HTMLFormElement>('[data-login-form]');
    const loginButton = loginForm?.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(loginButton?.disabled).toBe(true);
    loginForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(loginReads).toBe(0);

    resolveLogout?.(Response.json({ ok: true }));
    await vi.waitFor(() => expect(loginButton?.disabled).toBe(false));
    loginForm
      ?.querySelector<HTMLInputElement>('input[name="password"]')
      ?.setAttribute('value', 'new-password');
    loginForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(loginReads).toBe(1));
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
  });

  it('renders only the latest overlapping PRO-room list response', async () => {
    installAdminDom();
    let proRoomReads = 0;
    let resolveFirst: ((response: Response) => void) | undefined;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        proRoomReads += 1;
        if (proRoomReads === 1) return first;
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '000002',
              roomGeneration: 3,
              label: 'Latest room',
              status: 'registered',
              activationState: 'active',
              ownerAccountLinked: true,
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();
    await vi.waitFor(() => expect(proRoomReads).toBe(1));
    document.querySelector<HTMLButtonElement>('[data-refresh]')?.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Latest room');
    });

    resolveFirst?.(
      Response.json({
        generatedAt: new Date().toISOString(),
        rooms: [
          {
            roomCode: '000001',
            roomGeneration: 1,
            label: 'Stale room',
            status: 'registered',
            activationState: 'active',
            ownerAccountLinked: true,
            createdAt: Date.now(),
          },
        ],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).toContain('Latest room');
    expect(document.body.textContent).not.toContain('Stale room');
  });

  it('clears the credential and its issuance state immediately when the admin session expires', async () => {
    installAdminDom();
    let expired = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/login') {
        expired = false;
        return Response.json({ ok: true });
      }
      if (expired) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '000000',
              roomGeneration: 0,
              label: 'Developer room',
              status: 'registered',
              activationState: 'unactivated',
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/pro-rooms/000000/activation-claim') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ roomGeneration: 0 });
        return Response.json({
          roomCode: '000000',
          roomGeneration: 0,
          activationUrl: 'https://musixquare.com/000000#pro-claim=sensitive-claim',
          expiresAt: Date.now() + 15 * 60 * 1000,
        });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });

    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('.pro-room-item')).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>('.pro-room-actions button')?.click();
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLInputElement>('[data-pro-room-claim-url]')?.value,
      ).toContain('sensitive-claim');
    });

    expired = true;
    document.querySelector<HTMLButtonElement>('[data-refresh]')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-login-panel]')?.hidden).toBe(false);
      expect(document.querySelector<HTMLElement>('[data-pro-room-claim]')?.hidden).toBe(true);
      expect(document.querySelector<HTMLInputElement>('[data-pro-room-claim-url]')?.value).toBe('');
      expect(document.querySelector('[data-pro-room-claim-title]')?.textContent).toBe(
        'Owner activation link',
      );
    });

    const password = document.querySelector<HTMLInputElement>('[data-login-form] input');
    if (password) password.value = 'admin-pass';
    document
      .querySelector<HTMLFormElement>('[data-login-form]')
      ?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-refresh]')?.click();
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>('.pro-room-actions button')?.textContent,
      ).toBe('Issue activation link');
    });

    document.querySelector<HTMLButtonElement>('.pro-room-actions button')?.click();
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLInputElement>('[data-pro-room-claim-url]')?.value,
      ).toContain('sensitive-claim');
    });
    window.dispatchEvent(new Event('pagehide'));
    expect(document.querySelector<HTMLElement>('[data-pro-room-claim]')?.hidden).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[data-pro-room-claim-url]')?.value).toBe('');
  });

  it('issues an active room owner recovery link in the existing sensitive-link panel', async () => {
    installAdminDom();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '000001',
              roomGeneration: 4,
              label: 'Friends room',
              status: 'registered',
              activationState: 'active',
              ownerAccountLinked: true,
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/pro-rooms/000001/owner-recovery-claim') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ roomGeneration: 4 });
        expect(new Headers(init?.headers).get('X-MXQR-Admin-CSRF')).toBe('1');
        return Response.json({
          roomCode: '000001',
          roomGeneration: 4,
          recoveryUrl: 'https://musixquare.com/000001#pro-recovery=v1.payload.signature',
          expiresAt: Date.now() + 10 * 60 * 1000,
          ownerAccountLinked: true,
        });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();

    const issueButton = await vi.waitFor(() => {
      const value = [
        ...document.querySelectorAll<HTMLButtonElement>('.pro-room-actions button'),
      ].find((button) => button.textContent === 'Issue owner recovery link');
      expect(value).not.toBeUndefined();
      return value!;
    });
    expect(issueButton.title).toContain('same account already linked as owner');
    expect(issueButton.title).toContain('use ownership transfer');
    issueButton.click();

    await vi.waitFor(() => {
      expect(document.querySelector('[data-pro-room-claim-title]')?.textContent).toBe(
        '000001 owner recovery link',
      );
      expect(document.querySelector<HTMLInputElement>('[data-pro-room-claim-url]')?.value).toBe(
        'https://musixquare.com/000001#pro-recovery=v1.payload.signature',
      );
      expect(
        document
          .querySelector<HTMLInputElement>('[data-pro-room-claim-url]')
          ?.getAttribute('aria-label'),
      ).toBe('Owner recovery link');
      expect(issueButton.textContent).toBe('Issue another owner recovery link');
    });
  });

  it('routes an active room without a linked owner account directly to ownership assignment', async () => {
    installAdminDom();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '000001',
              roomGeneration: 0,
              label: 'Legacy owner room',
              status: 'registered',
              activationState: 'active',
              ownerAccountLinked: false,
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();

    const assignButton = await vi.waitFor(() => {
      const value = [
        ...document.querySelectorAll<HTMLButtonElement>('.pro-room-actions button'),
      ].find((button) => button.textContent === 'Assign a new owner');
      expect(value).not.toBeUndefined();
      return value!;
    });
    const roomState = document.querySelector<HTMLElement>('.pro-room-state');
    expect(roomState?.textContent).toBe('Ownership transfer required');
    expect(roomState?.classList.contains('is-suspended')).toBe(true);
    expect(document.body.textContent).not.toContain('Issue owner recovery link');
    expect(document.body.textContent).not.toContain('Transfer ownership');

    assignButton.click();
    const dialog = document.querySelector<HTMLDialogElement>('.pro-room-transfer-dialog');
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(dialog?.querySelector('input'));
  });

  it('keeps a pending transfer visible and lets the operator replace it after expiry', async () => {
    installAdminDom();
    const targetAccountId = 'acct_0123456789abcdefghijkl';
    let existingTransferExpired = false;
    const submitted: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '000002',
              roomGeneration: 6,
              label: 'Pending transfer room',
              status: 'suspended',
              suspensionReason: 'ownership_transfer_pending',
              ownerTransferPrepared: true,
              activationState: 'active',
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/pro-rooms/000002/owner-transfer-claim') {
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('X-MXQR-Admin-CSRF')).toBe('1');
        submitted.push(JSON.parse(String(init?.body)));
        if (!existingTransferExpired) {
          return Response.json(
            { error: 'PRO_ROOM_OWNER_TRANSFER_RECONCILIATION_REQUIRED' },
            { status: 409 },
          );
        }
        return Response.json({
          roomCode: '000002',
          roomGeneration: 6,
          targetAccountId,
          targetNickname: 'New owner',
          transferUrl: 'https://musixquare.com/000002#pro-transfer=v1.payload.signature',
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();

    const replaceButton = await vi.waitFor(() => {
      const value = [
        ...document.querySelectorAll<HTMLButtonElement>('.pro-room-actions button'),
      ].find((button) => button.textContent === 'Replace expired transfer link');
      expect(value).not.toBeUndefined();
      return value!;
    });
    expect(replaceButton.disabled).toBe(false);
    expect(replaceButton.title).toContain('still valid');
    replaceButton.click();

    const dialog = document.querySelector<HTMLDialogElement>('.pro-room-transfer-dialog')!;
    const input = dialog.querySelector<HTMLInputElement>('input')!;
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    input.value = targetAccountId;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(dialog.querySelector('.pro-room-transfer-error')?.textContent).toContain(
        'already pending',
      );
      expect(dialog.hasAttribute('open')).toBe(true);
    });

    existingTransferExpired = true;
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-pro-room-claim-title]')?.textContent).toBe(
        '000002 owner transfer link',
      );
      expect(document.querySelector<HTMLInputElement>('[data-pro-room-claim-url]')?.value).toBe(
        'https://musixquare.com/000002#pro-transfer=v1.payload.signature',
      );
      expect(dialog.hasAttribute('open')).toBe(false);
    });
    expect(submitted).toEqual([
      { roomGeneration: 6, targetAccount: targetAccountId },
      { roomGeneration: 6, targetAccount: targetAccountId },
    ]);
  });

  it('routes an ownerless transfer-pending room without a prepared transfer to assignment', async () => {
    installAdminDom();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '031108',
              roomGeneration: 0,
              label: 'Legacy ownerless room',
              status: 'suspended',
              suspensionReason: 'ownership_transfer_pending',
              ownerTransferPrepared: false,
              activationState: 'active',
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();

    const assignButton = await vi.waitFor(() => {
      const value = [
        ...document.querySelectorAll<HTMLButtonElement>('.pro-room-actions button'),
      ].find((button) => button.textContent === 'Assign a new owner');
      expect(value).not.toBeUndefined();
      return value!;
    });
    expect(document.querySelector('.pro-room-state')?.textContent).toBe(
      'Ownership transfer required',
    );
    expect(assignButton.title).toContain('Ownership transfer required');
    expect(document.body.textContent).not.toContain('Replace expired transfer link');

    assignButton.click();
    const dialog = document.querySelector<HTMLDialogElement>('.pro-room-transfer-dialog');
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(dialog?.querySelector('input'));
  });

  it('keeps an owner-deletion transfer secret in memory and clears it on dismiss', async () => {
    installAdminDom();
    localStorage.clear();
    sessionStorage.clear();
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const targetAccountId = 'acct_abcdefghijkl0123456789';
    const transferUrl = 'https://musixquare.com/000003#pro-transfer=v1.private.signature';
    let submittedBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '000003',
              roomGeneration: 9,
              label: 'Deleted owner room',
              status: 'suspended',
              suspensionReason: 'owner_account_deleted',
              activationState: 'active',
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/pro-rooms/000003/owner-transfer-claim') {
        submittedBody = JSON.parse(String(init?.body));
        return Response.json({
          roomCode: '000003',
          roomGeneration: 9,
          targetAccountId,
          targetNickname: 'Launch owner',
          transferUrl,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();
    const assignButton = await vi.waitFor(() => {
      const value = [
        ...document.querySelectorAll<HTMLButtonElement>('.pro-room-actions button'),
      ].find((button) => button.textContent === 'Assign a new owner');
      expect(value).not.toBeUndefined();
      return value!;
    });
    expect(document.body.textContent).toContain('Ownership transfer required');
    expect(assignButton.title).toContain('ownership transfer link');
    assignButton.click();

    const dialog = document.querySelector<HTMLDialogElement>('.pro-room-transfer-dialog')!;
    const input = dialog.querySelector<HTMLInputElement>('input')!;
    const issueButton = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(document.activeElement).toBe(input);
    expect(input.autocomplete).toBe('off');
    expect(input.maxLength).toBe(128);
    expect(input.placeholder).toContain('Nickname');
    expect(dialog.textContent).toContain('Target nickname or account ID');
    expect(dialog.textContent).toContain('No account search or suggestions');
    expect(dialog.getAttribute('aria-labelledby')).toBe('pro-room-transfer-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('pro-room-transfer-description');
    input.value = 'Launch owner';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(issueButton.disabled).toBe(false);
    dialog
      .querySelector<HTMLFormElement>('form')
      ?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(submittedBody).toEqual({ roomGeneration: 9, targetAccount: 'Launch owner' });
      expect(document.querySelector<HTMLInputElement>('[data-pro-room-claim-url]')?.value).toBe(
        transferUrl,
      );
      expect(input.value).toBe('');
      expect(document.activeElement).toBe(
        document.querySelector<HTMLInputElement>('[data-pro-room-claim-url]'),
      );
    });
    const storedWrites = JSON.stringify(storageWrite.mock.calls);
    expect(storedWrites).not.toContain(targetAccountId);
    expect(storedWrites).not.toContain(transferUrl);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    document.querySelector<HTMLButtonElement>('[data-pro-room-claim-dismiss]')?.click();
    expect(document.querySelector<HTMLElement>('[data-pro-room-claim]')?.hidden).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[data-pro-room-claim-url]')?.value).toBe('');
    expect(document.body.textContent).not.toContain(transferUrl);
    expect(adminStyles).toMatch(
      /@media \(max-width: 560px\)[\s\S]*\.pro-room-transfer-dialog\s*\{[\s\S]*width:\s*min\(100vw - 24px, 440px\);/,
    );
    expect(adminStyles).toMatch(
      /\.pro-room-transfer-actions\s*\{[\s\S]*flex-direction:\s*column;[\s\S]*\.pro-room-transfer-actions button\s*\{[\s\S]*min-height:\s*44px;/,
    );
  });
});

describe('admin PRO room operations dashboard', () => {
  it('edits the exact room generation label and matches the app accordion styling', async () => {
    installAdminDom();
    let currentLabel = 'Friends room';
    let submittedBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms/000001/label') {
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('X-MXQR-Admin-CSRF')).toBe('1');
        submittedBody = JSON.parse(String(init?.body));
        currentLabel = String((submittedBody as { label?: string }).label || '');
        return Response.json({
          ok: true,
          roomCode: '000001',
          roomGeneration: 7,
          label: currentLabel,
          changed: true,
        });
      }
      if (url.pathname === '/api/admin/pro-rooms/000001/api-keys') {
        return Response.json({
          roomCode: '000001',
          roomGeneration: 7,
          keys: [],
          maxActiveKeys: 3,
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '000001',
              roomGeneration: 7,
              label: currentLabel,
              status: 'registered',
              activationState: 'active',
              ownerAccountLinked: true,
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();

    const room = await vi.waitFor(() => {
      const item = document.querySelector<HTMLDetailsElement>('[data-pro-room-item="000001"]');
      expect(item).not.toBeNull();
      return item!;
    });
    expect(room.querySelector('.pro-room-chevron')?.textContent).toBe('');
    expect(room.querySelector('.pro-room-chevron path')?.getAttribute('d')).toBe(
      'm6.5 9 5.5 5.5L17.5 9',
    );
    expect(adminStyles).toMatch(
      /\.pro-room-item\[open\]\s*\{\s*background:\s*rgba\(var\(--primary-rgb\),\s*0\.08\)/,
    );
    expect(adminStyles).toMatch(
      /\.pro-room-chevron svg\s*\{[^}]*stroke-width:\s*1\.8;[^}]*stroke-linecap:\s*butt;[^}]*stroke-linejoin:\s*miter;/s,
    );

    room.open = true;
    room.dispatchEvent(new Event('toggle'));
    const input = room.querySelector<HTMLInputElement>('[data-pro-room-label-form] input')!;
    const save = room.querySelector<HTMLButtonElement>('[data-pro-room-label-form] button')!;
    input.value = 'Late night room';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(save.disabled).toBe(false);
    room
      .querySelector<HTMLFormElement>('[data-pro-room-label-form]')
      ?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(submittedBody).toEqual({ roomGeneration: 7, label: 'Late night room' });
      expect(room.querySelector('[data-pro-room-label-value]')?.textContent).toBe(
        'Late night room',
      );
      expect(room.querySelector('.pro-room-label-status')?.textContent).toBe('Label saved.');
    });
  });

  it('binds room state changes to the exact rendered generation', async () => {
    installAdminDom();
    let stateBody: unknown;
    let suspended = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms/000001/state') {
        stateBody = JSON.parse(String(init?.body));
        suspended = true;
        return Response.json({
          ok: true,
          roomCode: '000001',
          roomGeneration: 12,
          status: 'suspended',
          changed: true,
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '000001',
              roomGeneration: 12,
              label: 'Reused room',
              status: suspended ? 'suspended' : 'registered',
              activationState: 'active',
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();

    const suspendButton = await vi.waitFor(() => {
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>('.pro-room-actions button'),
      ].find((candidate) => candidate.textContent === 'Suspend room');
      expect(button).not.toBeUndefined();
      return button!;
    });
    suspendButton.click();

    await vi.waitFor(() => {
      expect(stateBody).toEqual({ roomGeneration: 12, status: 'suspended' });
      expect(document.querySelector('.pro-room-state')?.textContent).toBe('Suspended');
    });
  });

  it('fails closed when a registry row has no valid room generation', async () => {
    installAdminDom();
    let apiKeyRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '000001',
              label: 'Invalid registry row',
              status: 'registered',
              activationState: 'active',
              ownerAccountLinked: true,
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname.includes('/api-keys')) apiKeyRequests += 1;
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();

    const room = await vi.waitFor(() => {
      const item = document.querySelector<HTMLDetailsElement>('[data-pro-room-item="000001"]');
      expect(item).not.toBeNull();
      return item!;
    });
    expect(room.querySelector('.pro-room-actions')).toBeNull();
    expect(room.querySelector('[data-pro-room-destroy]')).toBeNull();
    expect(room.textContent).toContain('Room generation is unavailable');
    room.open = true;
    room.dispatchEvent(new Event('toggle'));
    await Promise.resolve();
    expect(apiKeyRequests).toBe(0);
  });

  it('expands one room, manages API keys, and clears a one-time key when collapsed', async () => {
    installAdminDom();
    const apiKey = 'mxqr_live_one-time-secret';
    const keyRecord = {
      keyId: 'ActiveKeyId00001',
      label: 'Friend bot',
      scopes: ['room:read', 'queue:read'],
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
      revokedAt: null,
      lastUsedAt: null,
    };
    let issuedBody: unknown;
    let revoked = false;
    let apiKeyListReads = 0;
    let resolveInitialApiKeys: ((response: Response) => void) | undefined;
    const initialApiKeys = new Promise<Response>((resolve) => {
      resolveInitialApiKeys = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '000001',
              roomGeneration: 4,
              label: 'Friends room',
              status: 'registered',
              activationState: 'active',
              ownerAccountLinked: true,
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/pro-rooms/000001/api-keys') {
        if (init?.method === 'POST') {
          expect(new Headers(init.headers).get('X-MXQR-Admin-CSRF')).toBe('1');
          issuedBody = JSON.parse(String(init.body));
          return Response.json({
            roomCode: '000001',
            roomGeneration: 4,
            apiKey,
            key: keyRecord,
          });
        }
        apiKeyListReads += 1;
        if (apiKeyListReads === 1) return initialApiKeys;
        return Response.json({
          roomCode: '000001',
          roomGeneration: 4,
          maxActiveKeys: 3,
          keys: revoked ? [] : [keyRecord],
        });
      }
      if (url.pathname === '/api/admin/pro-rooms/000001/api-keys/ActiveKeyId00001') {
        expect(init?.method).toBe('DELETE');
        expect(new Headers(init?.headers).get('X-MXQR-Admin-CSRF')).toBe('1');
        expect(JSON.parse(String(init?.body))).toEqual({ roomGeneration: 4 });
        revoked = true;
        return Response.json({
          ok: true,
          roomCode: '000001',
          roomGeneration: 4,
          keyId: 'ActiveKeyId00001',
        });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();

    const room = await vi.waitFor(() => {
      const value = document.querySelector<HTMLDetailsElement>('[data-pro-room-item="000001"]');
      expect(value).not.toBeNull();
      return value!;
    });
    expect(room.open).toBe(false);
    expect(room.querySelector('.pro-room-actions')?.textContent).toContain('Suspend room');

    room.open = true;
    room.dispatchEvent(new Event('toggle'));
    const loadingPanel = room.querySelector<HTMLElement>('[data-pro-room-api-panel="000001"]');
    expect(loadingPanel?.getAttribute('aria-busy')).toBe('true');
    expect(loadingPanel?.querySelector('.pro-room-api-form.is-loading')).not.toBeNull();
    expect(loadingPanel?.querySelector('.pro-room-api-key.is-loading')).not.toBeNull();
    expect(loadingPanel?.querySelector('[role="status"]')?.textContent).toBe('Loading API keys...');
    expect(loadingPanel?.querySelector('[data-pro-room-api-form="000001"]')).toBeNull();
    resolveInitialApiKeys?.(
      Response.json({
        roomCode: '000001',
        roomGeneration: 4,
        maxActiveKeys: 3,
        keys: [keyRecord],
      }),
    );
    await vi.waitFor(() => {
      expect(
        room.querySelector<HTMLFormElement>('[data-pro-room-api-form="000001"]'),
      ).not.toBeNull();
      expect(room.querySelector('.pro-room-api-key')?.textContent).toContain('Friend bot');
    });
    expect(loadingPanel?.hasAttribute('aria-busy')).toBe(false);
    expect(loadingPanel?.querySelector('.pro-room-api-form.is-loading')).toBeNull();

    const form = room.querySelector<HTMLFormElement>('[data-pro-room-api-form="000001"]');
    const label = form?.elements.namedItem('label') as HTMLInputElement | null;
    const preset = form?.elements.namedItem('preset') as HTMLSelectElement | null;
    const days = form?.elements.namedItem('days') as HTMLSelectElement | null;
    if (label) label.value = 'Cafe controller';
    if (preset) preset.value = 'playlist';
    if (days) days.value = '365';
    form?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(
        room.querySelector<HTMLInputElement>('[aria-label="000001 Developer API key"]')?.value,
      ).toBe(apiKey);
    });
    expect(issuedBody).toMatchObject({
      roomGeneration: 4,
      label: 'Cafe controller',
      days: 365,
      scopes: [
        'room:read',
        'playback:read',
        'playback:control',
        'queue:read',
        'queue:write',
        'media:upload',
        'effects:read',
      ],
    });
    expect((issuedBody as { requestId?: string }).requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    room.open = false;
    room.dispatchEvent(new Event('toggle'));
    expect(room.querySelector('[aria-label="000001 Developer API key"]')).toBeNull();

    room.open = true;
    room.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => {
      expect(
        room.querySelector<HTMLButtonElement>('.pro-room-api-key-actions button'),
      ).not.toBeNull();
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    room.querySelector<HTMLButtonElement>('.pro-room-api-key-actions button')?.click();
    await vi.waitFor(() => {
      expect(revoked).toBe(true);
      expect(room.querySelector('.pro-room-api-key')).toBeNull();
      expect(room.querySelector('.pro-room-api-empty')?.textContent).toContain('No API keys');
    });
  });

  it('discards a room-code-only API-key response before rendering a reused room generation', async () => {
    installAdminDom();
    let apiKeyListReads = 0;
    const keyRecord = (keyId: string, label: string) => ({
      keyId,
      label,
      scopes: ['room:read'],
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
      revokedAt: null,
      lastUsedAt: null,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '000002',
              roomGeneration: 1,
              label: 'Reused room',
              status: 'registered',
              activationState: 'active',
              ownerAccountLinked: true,
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/pro-rooms/000002/api-keys') {
        apiKeyListReads += 1;
        return apiKeyListReads === 1
          ? Response.json({
              roomCode: '000002',
              maxActiveKeys: 3,
              keys: [keyRecord('StaleKeyId000001', 'stale generation-zero key')],
            })
          : Response.json({
              roomCode: '000002',
              roomGeneration: 1,
              maxActiveKeys: 3,
              keys: [keyRecord('FreshKeyId000001', 'fresh generation-one key')],
            });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();
    const room = await vi.waitFor(() => {
      const value = document.querySelector<HTMLDetailsElement>('[data-pro-room-item="000002"]');
      expect(value).not.toBeNull();
      return value!;
    });
    room.open = true;
    room.dispatchEvent(new Event('toggle'));

    await vi.waitFor(() => {
      expect(apiKeyListReads).toBeGreaterThanOrEqual(2);
      expect(document.body.textContent).toContain('fresh generation-one key');
    });
    expect(document.body.textContent).not.toContain('stale generation-zero key');
  });

  it('requires both exact room codes before detaching a legacy duplicate owner', async () => {
    installAdminDom();
    let detached = false;
    const detachRequests: Array<RequestInit> = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms/031108/legacy-owner-detach') {
        detachRequests.push(init || {});
        if (detachRequests.length === 1) {
          return Response.json({ error: 'PRO_ROOM_OWNER_DETACH_AUDIT_PENDING' }, { status: 503 });
        }
        detached = true;
        return Response.json({
          ok: true,
          roomCode: '031108',
          roomGeneration: 12,
          status: 'suspended',
          suspensionReason: 'ownership_transfer_pending',
          ownerAccountLinked: false,
          retainedRoomCode: '000001',
          changed: true,
        });
      }
      if (url.pathname === '/api/admin/pro-rooms/031108/owner-recovery-claim') {
        return Response.json({
          roomCode: '031108',
          roomGeneration: 12,
          recoveryUrl: 'https://musixquare.com/031108#pro-recovery=stale-secret',
          expiresAt: Date.now() + 10 * 60 * 1000,
          ownerAccountLinked: true,
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [
            {
              roomCode: '000001',
              roomGeneration: 4,
              label: 'Retained owner room',
              status: 'registered',
              activationState: 'active',
              ownerAccountLinked: true,
              createdAt: Date.now(),
            },
            {
              roomCode: '031108',
              roomGeneration: 12,
              label: 'Legacy duplicate room',
              status: detached ? 'suspended' : 'registered',
              suspensionReason: detached ? 'ownership_transfer_pending' : null,
              activationState: 'active',
              ownerAccountLinked: !detached,
              ownerTransferPrepared: false,
              createdAt: Date.now(),
            },
            {
              roomCode: '000002',
              roomGeneration: 2,
              label: 'Already ownerless room',
              status: 'registered',
              activationState: 'active',
              ownerAccountLinked: false,
              createdAt: Date.now(),
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();

    const detachButton = await vi.waitFor(() => {
      const value = document.querySelector<HTMLButtonElement>(
        '[data-pro-room-owner-detach="031108"]',
      );
      expect(value?.textContent).toBe('Detach legacy owner');
      return value!;
    });
    expect(document.querySelector('[data-pro-room-owner-detach="000002"]')).toBeNull();
    expect(detachButton.closest('.pro-room-owner-repair')?.textContent).toContain(
      'This is not transfer or deletion',
    );
    const targetRow = detachButton.closest('[data-pro-room-item="031108"]')!;
    const recoveryButton = [...targetRow.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Issue owner recovery link',
    )!;
    recoveryButton.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-pro-room-claim]')?.hidden).toBe(false);
      expect(
        document.querySelector<HTMLInputElement>('[data-pro-room-claim-url]')?.value,
      ).toContain('stale-secret');
    });
    detachButton.focus();
    detachButton.click();

    const dialog = document.querySelector<HTMLDialogElement>(
      '[data-pro-room-owner-detach-dialog]',
    )!;
    const retainedInput = dialog.querySelector<HTMLInputElement>(
      '[data-pro-room-owner-detach-retained]',
    )!;
    const targetInput = dialog.querySelector<HTMLInputElement>(
      '[data-pro-room-owner-detach-target]',
    )!;
    const confirm = dialog.querySelector<HTMLButtonElement>(
      '[data-pro-room-owner-detach-confirm]',
    )!;
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(retainedInput);
    expect(confirm.disabled).toBe(true);
    expect(dialog.textContent).toContain(
      'room number, playlist, uploads, and settings stay intact',
    );

    window.dispatchEvent(new Event('pagehide'));
    expect(dialog.open).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-pro-room-claim]')?.hidden).toBe(true);
    expect(detachRequests).toHaveLength(0);
    recoveryButton.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-pro-room-claim]')?.hidden).toBe(false);
    });
    detachButton.click();
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(retainedInput);

    retainedInput.value = '031108';
    retainedInput.dispatchEvent(new Event('input', { bubbles: true }));
    targetInput.value = '031108';
    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(confirm.disabled).toBe(true);
    expect(detachRequests).toHaveLength(0);

    retainedInput.value = '000001';
    retainedInput.dispatchEvent(new Event('input', { bubbles: true }));
    targetInput.value = '031107';
    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(confirm.disabled).toBe(true);

    targetInput.value = '031108';
    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(confirm.disabled).toBe(false);
    confirm.click();

    await vi.waitFor(() => {
      expect(detachRequests).toHaveLength(1);
      expect(dialog.open).toBe(true);
      expect(dialog.querySelector('[data-pro-room-owner-detach-error]')?.textContent).toContain(
        'retry the same repair',
      );
      expect(dialog.querySelector('[data-pro-room-owner-detach-error]')?.textContent).toContain(
        'Do not refresh',
      );
      expect(confirm.disabled).toBe(false);
    });
    confirm.click();

    await vi.waitFor(() => {
      expect(detachRequests).toHaveLength(2);
      expect(dialog.open).toBe(false);
      expect(document.querySelector('[data-pro-room-owner-detach="031108"]')).toBeNull();
      expect(document.querySelector('[data-pro-room-item="031108"]')?.textContent).toContain(
        'Ownership transfer required',
      );
      expect(document.querySelector<HTMLElement>('[data-pro-room-claim]')?.hidden).toBe(true);
      expect(document.querySelector<HTMLInputElement>('[data-pro-room-claim-url]')?.value).toBe('');
    });
    const request = detachRequests[0];
    expect(request.method).toBe('POST');
    expect(new Headers(request.headers).get('X-MXQR-Admin-CSRF')).toBe('1');
    expect(JSON.parse(String(request.body))).toEqual({
      roomGeneration: 12,
      retainRoomCode: '000001',
      confirmRoomCode: '031108',
    });
    expect(document.querySelector('[data-pro-room-status]')?.textContent).toContain(
      'owner authority detached',
    );
    expect(adminStyles).toMatch(
      /\.pro-room-owner-detach-dialog[\s\S]*@media \(max-width: 560px\)[\s\S]*\.pro-room-owner-detach-dialog/,
    );
  });

  it('requires an exact room-code confirmation before permanently deleting a room', async () => {
    installAdminDom();
    let deleted = false;
    let deleteAttempts = 0;
    const deleteRequests: Array<RequestInit> = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (
        url.pathname === '/api/admin/pro-rooms/000001' &&
        String(init?.method || 'GET').toUpperCase() === 'DELETE'
      ) {
        deleteAttempts += 1;
        deleteRequests.push(init || {});
        if (deleteAttempts === 1) {
          return Response.json({ error: 'DELETE_TEMPORARILY_UNAVAILABLE' }, { status: 503 });
        }
        deleted = true;
        return Response.json({
          ok: true,
          roomCode: '000001',
          roomGeneration: 9,
          status: 'destroyed',
        });
      }
      if (url.pathname === '/api/admin/pro-rooms') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: deleted
            ? []
            : [
                {
                  roomCode: '000001',
                  roomGeneration: 9,
                  label: 'Friends room',
                  status: 'registered',
                  activationState: 'active',
                  ownerAccountLinked: true,
                  createdAt: Date.now(),
                },
              ],
        });
      }
      if (url.pathname === '/api/admin/articles') {
        return Response.json({ generatedAt: new Date().toISOString(), articles: [] });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          announcement: {},
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();

    const destroyButton = await vi.waitFor(() => {
      const value = document.querySelector<HTMLButtonElement>('[data-pro-room-destroy="000001"]');
      expect(value?.textContent).toBe('Delete room permanently');
      return value!;
    });
    destroyButton.focus();
    destroyButton.click();

    const dialog = document.querySelector<HTMLDialogElement>('[data-pro-room-destroy-dialog]')!;
    const input = dialog.querySelector<HTMLInputElement>('[data-pro-room-destroy-input]')!;
    const confirm = dialog.querySelector<HTMLButtonElement>('[data-pro-room-destroy-confirm]')!;
    const cancel = dialog.querySelector<HTMLButtonElement>('[data-pro-room-destroy-cancel]')!;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('pro-room-destroy-title');
    expect(document.activeElement).toBe(input);
    expect(confirm.disabled).toBe(true);
    expect(deleteAttempts).toBe(0);

    input.value = '000002';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(confirm.disabled).toBe(true);
    input.value = '000001';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(confirm.disabled).toBe(false);

    cancel.click();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(destroyButton);
    expect(deleteAttempts).toBe(0);

    destroyButton.click();
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(dialog.open).toBe(false);
    expect(deleteAttempts).toBe(0);

    destroyButton.click();
    input.value = '000001';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    confirm.click();
    await vi.waitFor(() => {
      expect(deleteAttempts).toBe(1);
      expect(dialog.querySelector('[data-pro-room-destroy-error]')?.textContent).toContain(
        'DELETE_TEMPORARILY_UNAVAILABLE',
      );
    });
    expect(dialog.open).toBe(true);
    expect(confirm.disabled).toBe(false);

    const firstRequest = deleteRequests[0];
    expect(new Headers(firstRequest.headers).get('X-MXQR-Admin-CSRF')).toBe('1');
    const firstBody = JSON.parse(String(firstRequest.body)) as {
      confirmRoomCode?: string;
      roomGeneration?: number;
      requestId?: string;
    };
    expect(firstBody.confirmRoomCode).toBe('000001');
    expect(firstBody.roomGeneration).toBe(9);
    expect(firstBody.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    confirm.click();
    await vi.waitFor(() => {
      expect(deleteAttempts).toBe(2);
      expect(dialog.open).toBe(false);
      expect(document.querySelector('[data-pro-room-item="000001"]')).toBeNull();
    });
    const secondBody = JSON.parse(String(deleteRequests[1].body)) as { requestId?: string };
    expect(secondBody.requestId).toBe(firstBody.requestId);
    expect(document.activeElement).toBe(
      document.querySelector<HTMLElement>('[data-pro-room-list-status]'),
    );
  });

  it('keeps ASAMO voucher plaintext memory-only while operating inside PRO Rooms', async () => {
    installAdminDom();
    const proView = document.querySelector<HTMLElement>('[data-admin-view="pro-rooms"]')!;
    const form = document.querySelector<HTMLFormElement>('[data-pro-room-form]')!;
    const registerPanel = document.createElement('section');
    registerPanel.className = 'panel pro-room-register-panel';
    proView.insertBefore(registerPanel, form);
    registerPanel.appendChild(form);

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:mxqr-vouchers'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const voucherMutations: Array<any> = [];
    const registeredEventRooms = new Map<string, any>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      const method = String(init?.method || 'GET').toUpperCase();
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({ announcement: {}, history: [] });
      }
      if (url.pathname === '/api/admin/pro-rooms' && method === 'GET') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          rooms: [...registeredEventRooms.values()],
        });
      }
      if (url.pathname === '/api/admin/pro-rooms' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        const room = {
          roomCode: body.roomCode,
          roomGeneration: 0,
          label: body.label,
          status: 'registered',
          activationState: 'unactivated',
        };
        registeredEventRooms.set(room.roomCode, room);
        return Response.json({ room }, { status: 201 });
      }
      if (url.pathname === '/api/admin/pro-grants/campaigns/asamo-0/status' && method === 'GET') {
        return Response.json({ campaign: null, counts: {} });
      }
      if (url.pathname === '/api/admin/pro-grants/campaigns' && method === 'POST') {
        return Response.json({ campaign: { slug: 'asamo-0' } });
      }
      if (
        url.pathname === '/api/admin/pro-grants/campaigns/asamo-0/vouchers' &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}'));
        voucherMutations.push(body);
        if (body.dryRun) {
          return Response.json({ dryRun: true, validatedCount: 50 });
        }
        return Response.json({
          requestId: body.requestId,
          campaign: { slug: 'asamo-0' },
          count: 50,
          mappings: body.vouchers.map((voucher: any, index: number) => ({
            voucherId: `voucher_${String(index).padStart(22, 'A')}`,
            roomCode: voucher.roomCode,
            roomGeneration: 0,
            status: 'available',
          })),
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();
    const campaignPanel = document.querySelector<HTMLElement>('[data-pro-grant-campaign]');
    expect(campaignPanel).not.toBeNull();
    expect(campaignPanel?.closest('[data-admin-view]')?.getAttribute('data-admin-view')).toBe(
      'pro-rooms',
    );

    const verifyButton = campaignPanel?.querySelector<HTMLButtonElement>('[data-pro-grant-verify]');
    await vi.waitFor(() => expect(verifyButton?.disabled).toBe(false));
    verifyButton?.click();
    await vi.waitFor(() => {
      expect(campaignPanel?.textContent).toContain(
        '50 rooms will be provisioned during the apply step',
      );
    });
    expect(voucherMutations).toHaveLength(0);
    expect(registeredEventRooms.size).toBe(0);

    campaignPanel?.querySelector<HTMLButtonElement>('[data-pro-grant-create]')?.click();
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(voucherMutations).toHaveLength(0);
    expect(registeredEventRooms.size).toBe(0);
    campaignPanel?.querySelector<HTMLButtonElement>('[data-pro-grant-apply]')?.click();
    await vi.waitFor(() => expect(voucherMutations).toHaveLength(1));
    expect(registeredEventRooms.size).toBe(50);
    for (const [roomCode, room] of registeredEventRooms) {
      expect(room.label).toBe(`ASAMO 0 · ${roomCode}`);
      expect(room.status).toBe('registered');
      expect(room.activationState).toBe('unactivated');
    }
    const issued = voucherMutations[0];
    expect(issued.vouchers).toHaveLength(50);
    expect(new Set(issued.vouchers.map((voucher: any) => voucher.code))).toHaveLength(50);
    for (const voucher of issued.vouchers) {
      expect(voucher.code).toMatch(/^MXQ(?:-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    }
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(campaignPanel?.textContent).not.toContain('MXQ-');
    expect(document.body.textContent).not.toContain(issued.vouchers[0].code);
    expect(campaignPanel?.querySelector<HTMLElement>('[data-pro-grant-export]')?.hidden).toBe(
      false,
    );

    window.dispatchEvent(new Event('pagehide'));
    campaignPanel?.querySelector<HTMLButtonElement>('[data-pro-grant-copy]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(campaignPanel?.textContent).toContain('Clipboard access is unavailable');
  });

  it('lists campaigns and separates pause, terminal end, and unused-code revocation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 6, 1, 9, 30).getTime());
    installAdminDom();
    const proView = document.querySelector<HTMLElement>('[data-admin-view="pro-rooms"]')!;
    const form = document.querySelector<HTMLFormElement>('[data-pro-room-form]')!;
    const registerPanel = document.createElement('section');
    registerPanel.className = 'panel pro-room-register-panel';
    proView.insertBefore(registerPanel, form);
    registerPanel.appendChild(form);

    let campaignStatus = 'active';
    let recoveryStatus = 'draft';
    let available = 8;
    const statusMutations: string[] = [];
    let revokeMutations = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      const method = String(init?.method || 'GET').toUpperCase();
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-rooms' && method === 'GET') {
        return Response.json({ rooms: [] });
      }
      if (url.pathname === '/api/admin/pro-grants/campaigns' && method === 'GET') {
        return Response.json({
          campaigns: [
            {
              campaign: {
                slug: 'asamo-0',
                title: 'MUSIXQUARE 아사모 이벤트',
                status: campaignStatus,
                startsAt: Date.now() - 1_000,
                endsAt: null,
                perAccountLimit: 1,
              },
              counts: { total: 10, available, redeemed: 2, revoked: 0 },
              pool: {
                roomCount: 10,
                firstRoomCode: '000100',
                lastRoomCode: '000109',
              },
            },
            {
              campaign: {
                slug: 'broken-pool',
                title: '잘못된 범위',
                status: 'draft',
                startsAt: Date.now(),
                endsAt: null,
                perAccountLimit: 1,
              },
              counts: { total: 3, available: 3, redeemed: 0, revoked: 0 },
              pool: {
                roomCount: 3,
                firstRoomCode: '000200',
                lastRoomCode: '000205',
              },
            },
            {
              campaign: {
                slug: 'recover-draft',
                title: '시작 복구 이벤트',
                status: recoveryStatus,
                startsAt: Date.now() - 1_000,
                endsAt: null,
                perAccountLimit: 1,
              },
              counts: { total: 3, available: 3, redeemed: 0, revoked: 0 },
              pool: {
                roomCount: 3,
                firstRoomCode: '000300',
                lastRoomCode: '000302',
              },
            },
            {
              campaign: {
                slug: 'ended-empty',
                title: '빈 종료 이벤트',
                status: 'ended',
                startsAt: Date.now() - 1_000,
                endsAt: null,
                perAccountLimit: 1,
              },
              counts: { total: 0, available: 0, redeemed: 0, revoked: 0 },
              pool: { roomCount: 0, firstRoomCode: null, lastRoomCode: null },
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/pro-grants/campaigns/asamo-0/status' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        statusMutations.push(body.status);
        campaignStatus = body.status;
        return Response.json({ ok: true });
      }
      if (
        url.pathname === '/api/admin/pro-grants/campaigns/recover-draft/status' &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}'));
        statusMutations.push(body.status);
        recoveryStatus = body.status;
        return Response.json({ ok: true });
      }
      if (url.pathname === '/api/admin/pro-grants/campaigns/asamo-0/revoke' && method === 'POST') {
        revokeMutations += 1;
        available = 0;
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();
    const panel = document.querySelector<HTMLElement>('[data-pro-grant-campaign]')!;
    await vi.waitFor(() => {
      expect(panel.textContent).toContain('10 issued · 8 available · 2 redeemed · 0 revoked');
    });
    expect(panel.textContent).toContain('MUSIXQUARE ASAMO Event');
    expect(panel.textContent).not.toContain('MUSIXQUARE 아사모 이벤트');
    expect(panel.querySelector<HTMLAnchorElement>('[data-pro-grant-event-link] a')?.pathname).toBe(
      '/events/asamo/0/',
    );

    panel.querySelector<HTMLButtonElement>('[data-pro-grant-pause]')?.click();
    await vi.waitFor(() => expect(statusMutations).toEqual(['paused']));
    await vi.waitFor(() => {
      expect(panel.querySelector('[data-pro-grant-state]')?.textContent).toBe('Paused');
    });

    panel.querySelector<HTMLButtonElement>('[data-pro-grant-pause]')?.click();
    await vi.waitFor(() => expect(statusMutations).toEqual(['paused', 'active']));
    await vi.waitFor(() => {
      expect(panel.querySelector('[data-pro-grant-state]')?.textContent).toBe('Active');
    });

    confirmSpy.mockReturnValueOnce(false);
    panel.querySelector<HTMLButtonElement>('[data-pro-grant-end]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusMutations).toEqual(['paused', 'active']);

    panel.querySelector<HTMLButtonElement>('[data-pro-grant-end]')?.click();
    await vi.waitFor(() => expect(statusMutations).toEqual(['paused', 'active', 'ended']));
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('Unused codes will be preserved'),
    );

    const revokeButton = panel.querySelector<HTMLButtonElement>('[data-pro-grant-revoke]')!;
    await vi.waitFor(() => expect(revokeButton.disabled).toBe(false));
    revokeButton.click();
    await vi.waitFor(() => expect(revokeMutations).toBe(1));
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('Permanently revoke'));
    const newEventButton = panel.querySelector<HTMLButtonElement>('[data-pro-grant-new]')!;
    await vi.waitFor(() => expect(newEventButton.disabled).toBe(false));

    panel
      .querySelector<HTMLButtonElement>('[data-pro-grant-campaign-select="broken-pool"]')
      ?.click();
    expect(panel.textContent).toContain('Room range unavailable');
    expect(panel.querySelector<HTMLButtonElement>('[data-pro-grant-verify]')?.disabled).toBe(true);

    const recoveryButton = panel.querySelector<HTMLButtonElement>(
      '[data-pro-grant-campaign-select="recover-draft"]',
    )!;
    recoveryButton.focus();
    recoveryButton.click();
    expect(panel.querySelector<HTMLButtonElement>('[data-pro-grant-pause]')?.textContent).toBe(
      'Start event',
    );
    expect((document.activeElement as HTMLElement)?.dataset.proGrantCampaignSelect).toBe(
      'recover-draft',
    );
    panel.querySelector<HTMLButtonElement>('[data-pro-grant-pause]')?.click();
    await vi.waitFor(() =>
      expect(statusMutations).toEqual(['paused', 'active', 'ended', 'active']),
    );
    await vi.waitFor(() => expect(newEventButton.disabled).toBe(false));

    panel
      .querySelector<HTMLButtonElement>('[data-pro-grant-campaign-select="ended-empty"]')
      ?.click();
    expect(panel.querySelector<HTMLButtonElement>('[data-pro-grant-verify]')?.disabled).toBe(true);
    expect(panel.querySelector<HTMLButtonElement>('[data-pro-grant-create]')?.disabled).toBe(true);

    newEventButton.click();
    const createForm = panel.querySelector<HTMLFormElement>('[data-pro-grant-create-form]')!;
    const fill = (name: string, value: string) => {
      const input = createForm.elements.namedItem(name) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    fill('title', '겹치는 이벤트');
    fill('slug', 'overlap-1');
    fill('roomStartCode', '000105');
    fill('roomCount', '2');
    fill('startsAt', '2026-08-10T10:00');
    createForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(panel.querySelector('[data-pro-grant-status]')?.textContent).toContain(
      'Room 000105 overlaps with “MUSIXQUARE ASAMO Event”.',
    );
    panel.querySelector<HTMLButtonElement>('[data-pro-grant-form-cancel]')?.click();
    newEventButton.click();
    expect((createForm.elements.namedItem('title') as HTMLInputElement).value).toBe('');
    expect((createForm.elements.namedItem('roomCount') as HTMLInputElement).value).toBe('50');
    expect((createForm.elements.namedItem('startsAt') as HTMLInputElement).value).toBe(
      '2026-07-01T09:30',
    );
    expect(adminStyles).toContain('.pro-grant-campaign-layout');
    expect(adminStyles).toMatch(
      /@media \(max-width: 560px\)[\s\S]*\.pro-grant-form-grid,[\s\S]*grid-template-columns: 1fr;/,
    );
    expect(adminStyles).toMatch(
      /\.pro-grant-campaign-actions,[\s\S]*display: flex;[\s\S]*flex-wrap: wrap;/,
    );
    expect(adminStyles).not.toMatch(
      /@media \(max-width: 560px\)[\s\S]*\.pro-grant-campaign-actions button,[\s\S]*width: 100%;/,
    );
    expect(adminStyles).toMatch(
      /\.pro-grant-campaign-item\[aria-pressed='true'\][\s\S]*?background: rgba\(var\(--primary-rgb\), 0\.08\) !important;/,
    );
    expect(adminStyles).not.toMatch(
      /\.pro-grant-campaign-item\[aria-pressed='true'\][^{]*\{[^}]*box-shadow: inset/,
    );
    expect(adminStyles).toMatch(/\.article-item\s*\{[^}]*background: var\(--surface-1\);/);
    expect(adminScript).not.toMatch(/[가-힣]/u);
  });

  it('creates a generic campaign through verify, local export, and exact apply', async () => {
    installAdminDom();
    const proView = document.querySelector<HTMLElement>('[data-admin-view="pro-rooms"]')!;
    const roomForm = document.querySelector<HTMLFormElement>('[data-pro-room-form]')!;
    const registerPanel = document.createElement('section');
    registerPanel.className = 'panel pro-room-register-panel';
    proView.insertBefore(registerPanel, roomForm);
    registerPanel.appendChild(roomForm);

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:generic-event-vouchers'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const registeredRooms = new Map<string, any>();
    const campaignMutations: Array<any> = [];
    const voucherMutations: Array<any> = [];
    let applied = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      const method = String(init?.method || 'GET').toUpperCase();
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-grants/campaigns' && method === 'GET') {
        return Response.json({
          campaigns: applied
            ? [
                {
                  campaign: {
                    slug: 'launch-2',
                    title: '출시 기념 이벤트',
                    status: 'active',
                    startsAt: new Date('2026-08-10T10:00').getTime(),
                    endsAt: null,
                    perAccountLimit: 1,
                  },
                  counts: { total: 3, available: 3, redeemed: 0, revoked: 0 },
                  pool: {
                    roomCount: 3,
                    firstRoomCode: '000200',
                    lastRoomCode: '000202',
                  },
                },
              ]
            : [],
        });
      }
      if (url.pathname === '/api/admin/pro-rooms' && method === 'GET') {
        return Response.json({ rooms: [...registeredRooms.values()] });
      }
      if (url.pathname === '/api/admin/pro-rooms' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        const room = {
          roomCode: body.roomCode,
          roomGeneration: 0,
          label: body.label,
          status: 'registered',
          activationState: 'unactivated',
        };
        registeredRooms.set(room.roomCode, room);
        return Response.json({ room }, { status: 201 });
      }
      if (url.pathname === '/api/admin/pro-grants/campaigns' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        campaignMutations.push(body);
        return Response.json({ campaign: { slug: body.slug }, dryRun: body.dryRun });
      }
      if (
        url.pathname === '/api/admin/pro-grants/campaigns/launch-2/vouchers' &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}'));
        voucherMutations.push(body);
        return Response.json({
          requestId: body.requestId,
          campaign: { slug: 'launch-2' },
          count: body.vouchers.length,
          mappings: body.vouchers.map((voucher: any, index: number) => ({
            voucherId: `voucher_${String(index).padStart(22, 'A')}`,
            roomCode: voucher.roomCode,
            roomGeneration: 0,
            status: 'available',
          })),
        });
      }
      if (url.pathname === '/api/admin/pro-grants/campaigns/launch-2/status' && method === 'POST') {
        applied = true;
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();
    const panel = document.querySelector<HTMLElement>('[data-pro-grant-campaign]')!;
    await vi.waitFor(() => expect(panel.textContent).toContain('No events yet'));
    panel.querySelector<HTMLButtonElement>('[data-pro-grant-new]')?.click();
    const createForm = panel.querySelector<HTMLFormElement>('[data-pro-grant-create-form]')!;
    const setValue = (name: string, value: string) => {
      const input = createForm.elements.namedItem(name) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue('title', '출시 기념 이벤트');
    setValue('slug', 'launch-2');
    setValue('roomStartCode', '000200');
    setValue('roomCount', '3');
    setValue('startsAt', '2026-08-10T10:00');
    createForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(panel.querySelector<HTMLAnchorElement>('[data-pro-grant-event-link] a')?.pathname).toBe(
      '/events/launch/2/',
    );

    const verify = panel.querySelector<HTMLButtonElement>('[data-pro-grant-verify]')!;
    expect(verify.disabled).toBe(false);
    verify.click();
    await vi.waitFor(() => expect(campaignMutations).toHaveLength(1));
    expect(Object.keys(campaignMutations[0]).sort()).toEqual(
      ['dryRun', 'endsAt', 'perAccountLimit', 'slug', 'startsAt', 'title'].sort(),
    );
    expect(campaignMutations[0]).toMatchObject({
      slug: 'launch-2',
      perAccountLimit: 1,
      dryRun: true,
    });

    const prepare = panel.querySelector<HTMLButtonElement>('[data-pro-grant-create]')!;
    await vi.waitFor(() => expect(prepare.disabled).toBe(false));
    prepare.click();
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    const newEventButton = panel.querySelector<HTMLButtonElement>('[data-pro-grant-new]')!;
    expect(newEventButton.disabled).toBe(true);
    newEventButton.disabled = false;
    newEventButton.click();
    expect(createForm.hidden).toBe(true);
    expect(panel.querySelector('[data-pro-grant-status]')?.textContent).toContain(
      'A code file for “출시 기념 이벤트” is waiting to be applied',
    );
    createForm.hidden = false;
    setValue('title', '덮어쓰기 시도');
    setValue('slug', 'blocked-3');
    setValue('roomStartCode', '000400');
    setValue('roomCount', '2');
    createForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(panel.querySelector<HTMLAnchorElement>('[data-pro-grant-event-link] a')?.pathname).toBe(
      '/events/launch/2/',
    );
    createForm.hidden = true;

    panel.querySelector<HTMLButtonElement>('[data-pro-grant-apply]')?.click();
    await vi.waitFor(() => expect(voucherMutations).toHaveLength(1));
    expect(registeredRooms.size).toBe(3);
    expect(voucherMutations[0].vouchers.map((voucher: any) => voucher.roomCode)).toEqual([
      '000200',
      '000201',
      '000202',
    ]);
    expect(campaignMutations).toHaveLength(2);
    expect(Object.keys(campaignMutations[1]).sort()).toEqual(
      ['dryRun', 'endsAt', 'perAccountLimit', 'slug', 'startsAt', 'title'].sort(),
    );
    expect(campaignMutations[1].dryRun).toBe(false);
    expect(panel.textContent).not.toContain(voucherMutations[0].vouchers[0].code);
    expect(panel.textContent).toContain('3 codes were applied');
    const nextEventButton = panel.querySelector<HTMLButtonElement>('[data-pro-grant-new]')!;
    expect(nextEventButton.disabled).toBe(false);
    nextEventButton.click();
    expect(createForm.hidden).toBe(false);
    expect(panel.querySelector<HTMLElement>('[data-pro-grant-export]')?.hidden).toBe(true);
  });

  it('imports a strict saved voucher file and resumes a partially created campaign', async () => {
    installAdminDom();
    const proView = document.querySelector<HTMLElement>('[data-admin-view="pro-rooms"]')!;
    const roomForm = document.querySelector<HTMLFormElement>('[data-pro-room-form]')!;
    const registerPanel = document.createElement('section');
    registerPanel.className = 'panel pro-room-register-panel';
    proView.insertBefore(registerPanel, roomForm);
    registerPanel.appendChild(roomForm);

    const startsAt = 1;
    let campaignStatus = 'draft';
    let vouchersCommitted = false;
    const registeredRooms = new Map<string, any>();
    const voucherMutations: any[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      const method = String(init?.method || 'GET').toUpperCase();
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/pro-grants/campaigns' && method === 'GET') {
        return Response.json({
          campaigns: [
            {
              campaign: {
                slug: 'recovery-4',
                title: '복구 이벤트',
                status: campaignStatus,
                startsAt,
                endsAt: null,
                perAccountLimit: 1,
              },
              counts: vouchersCommitted
                ? { total: 2, available: 2, redeemed: 0, revoked: 0 }
                : { total: 0, available: 0, redeemed: 0, revoked: 0 },
              pool: vouchersCommitted
                ? { roomCount: 2, firstRoomCode: '000400', lastRoomCode: '000401' }
                : { roomCount: 0, firstRoomCode: null, lastRoomCode: null },
            },
          ],
        });
      }
      if (url.pathname === '/api/admin/pro-rooms' && method === 'GET') {
        return Response.json({ rooms: [...registeredRooms.values()] });
      }
      if (url.pathname === '/api/admin/pro-rooms' && method === 'POST') {
        const requestBody = JSON.parse(String(init?.body || '{}'));
        const room = {
          roomCode: requestBody.roomCode,
          roomGeneration: 0,
          label: requestBody.label,
          status: 'registered',
          activationState: 'unactivated',
        };
        registeredRooms.set(room.roomCode, room);
        return Response.json({ room }, { status: 201 });
      }
      if (url.pathname === '/api/admin/pro-grants/campaigns' && method === 'POST') {
        return Response.json({ campaign: { slug: 'recovery-4' }, created: false });
      }
      if (
        url.pathname === '/api/admin/pro-grants/campaigns/recovery-4/vouchers' &&
        method === 'POST'
      ) {
        const requestBody = JSON.parse(String(init?.body || '{}'));
        voucherMutations.push(requestBody);
        vouchersCommitted = true;
        return Response.json({
          requestId: requestBody.requestId,
          campaign: { slug: 'recovery-4' },
          count: requestBody.vouchers.length,
          mappings: requestBody.vouchers.map((voucher: any, index: number) => ({
            voucherId: `voucher_${String(index).padStart(22, 'A')}`,
            roomCode: voucher.roomCode,
            roomGeneration: 0,
            status: 'available',
          })),
        });
      }
      if (
        url.pathname === '/api/admin/pro-grants/campaigns/recovery-4/status' &&
        method === 'POST'
      ) {
        campaignStatus = 'active';
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')?.click();
    const panel = document.querySelector<HTMLElement>('[data-pro-grant-campaign]')!;
    const importInput = panel.querySelector<HTMLInputElement>('[data-pro-grant-import-input]')!;
    const artifact = {
      format: 'mxqr-pro-grant-vouchers-v1',
      warning: 'PLAINTEXT VOUCHER CODES. Store and distribute securely.',
      exportedAt: '2026-08-09T00:00:00.000Z',
      requestId: `batch_${'Z'.repeat(22)}`,
      campaign: {
        slug: 'recovery-4',
        title: '복구 이벤트',
        startsAt,
        endsAt: null,
        perAccountLimit: 1,
      },
      pool: { firstRoomCode: '000400', lastRoomCode: '000401', roomCount: 2 },
      roomLabelPrefix: '복구 이벤트',
      vouchers: [
        { roomCode: '000400', code: 'MXQ-AAAAA-BBBBB-CCCCC-DDDDD' },
        { roomCode: '000401', code: 'MXQ-EEEEE-FFFFF-GGGGG-HHHHH' },
      ],
    };
    const setImportFile = (value: unknown) => {
      const json = JSON.stringify(value);
      Object.defineProperty(importInput, 'files', {
        configurable: true,
        value: [{ size: new TextEncoder().encode(json).byteLength, text: async () => json }],
      });
      importInput.dispatchEvent(new Event('change', { bubbles: true }));
    };

    setImportFile({ ...artifact, applied: true });
    await vi.waitFor(() => {
      expect(panel.querySelector('[data-pro-grant-status]')?.textContent).toContain(
        'The code file is unsupported or corrupted',
      );
    });
    expect(panel.querySelector<HTMLButtonElement>('[data-pro-grant-apply]')?.disabled).toBe(true);

    setImportFile({
      ...artifact,
      campaign: { ...artifact.campaign, slug: 123 },
    });
    await vi.waitFor(() => {
      expect(panel.querySelector('[data-pro-grant-status]')?.textContent).toContain(
        'The event details in the code file are invalid',
      );
    });
    expect(panel.querySelector<HTMLButtonElement>('[data-pro-grant-apply]')?.disabled).toBe(true);

    const { pool: _pool, roomLabelPrefix: _roomLabelPrefix, ...cliCompatibleArtifact } = artifact;
    setImportFile(cliCompatibleArtifact);
    await vi.waitFor(() => {
      expect(panel.querySelector('[data-pro-grant-status]')?.textContent).toContain(
        'Loaded 2 codes for “복구 이벤트” into memory',
      );
    });
    expect(panel.querySelector<HTMLButtonElement>('[data-pro-grant-apply]')?.disabled).toBe(false);
    expect(panel.textContent).not.toContain(artifact.vouchers[0].code);

    panel.querySelector<HTMLButtonElement>('[data-pro-grant-apply]')?.click();
    await vi.waitFor(() => expect(voucherMutations).toHaveLength(1));
    await vi.waitFor(() => expect(campaignStatus).toBe('active'));
    expect(registeredRooms.size).toBe(2);
    expect(voucherMutations[0].requestId).toBe(artifact.requestId);
    expect(panel.textContent).not.toContain(artifact.vouchers[1].code);

    setImportFile({
      ...artifact,
      requestId: `batch_${'Y'.repeat(22)}`,
      campaign: { ...artifact.campaign, slug: 'constructor', title: '예약어 이벤트' },
    });
    await vi.waitFor(() => {
      expect(panel.querySelector('[data-pro-grant-status]')?.textContent).toContain(
        'Loaded 2 codes for “예약어 이벤트” into memory',
      );
    });
    expect(panel.querySelector<HTMLAnchorElement>('[data-pro-grant-event-link] a')?.pathname).toBe(
      '/events/constructor/',
    );
  });
});
