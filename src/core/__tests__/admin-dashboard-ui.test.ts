// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const adminScript = readFileSync(resolve(process.cwd(), 'public/admin.js'), 'utf8');
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
          ownerAccountLinked: false,
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
    expect(issueButton.title).toContain('replaces the room owner credential');
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
});
