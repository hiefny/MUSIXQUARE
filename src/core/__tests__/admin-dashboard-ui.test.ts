// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const adminScript = readFileSync(resolve(process.cwd(), 'public/admin.js'), 'utf8');

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('admin PRO room claim lifecycle', () => {
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
        return Response.json({
          roomCode: '000000',
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
});
