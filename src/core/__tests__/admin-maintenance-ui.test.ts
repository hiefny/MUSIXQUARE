// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileClassicRuntimeForBrowserTest } from './classic-runtime-test-asset.ts';

const adminScript = compileClassicRuntimeForBrowserTest('admin.js');

function installDom(): void {
  document.body.innerHTML = `
    <main class="admin-shell" data-admin-configured="true">
      <section data-login-panel>
        <form data-login-form><input name="password"><button type="submit">Login</button></form>
        <p data-login-status></p>
      </section>
      <section data-dashboard hidden>
        <h1 data-dashboard-title>Analytics</h1><p data-updated-at></p>
        <button data-service-status-trigger>
          <span data-service-status-dot></span><span data-service-status-label></span>
        </button>
        <button data-refresh>Refresh</button><button data-logout>Logout</button>
        <dialog data-service-status-dialog>
          <h2 data-service-status-state></h2>
          <p data-service-status-description></p><p data-service-status-updated></p>
          <p data-service-status-error></p>
          <button type="button" data-service-status-preview>Preview page</button>
          <button type="button" data-service-status-cancel>Cancel</button>
          <button type="button" data-service-status-confirm>Change</button>
        </dialog>
        <nav>
          <button data-admin-tab="operations">Analytics</button>
          <button data-admin-tab="announcements">Announcements</button>
        </nav>
        <section data-admin-view="operations">
          <div data-metric-cards></div><div data-hourly-chart></div>
          <div data-daily-list></div><div data-monthly-chart></div><div data-signal-grid></div>
        </section>
        <section data-admin-view="announcements" hidden>
          <form data-announcement-form>
            <input type="checkbox" data-announcement-enabled>
            <textarea data-announcement-message></textarea>
            <input data-announcement-expires>
            <button type="submit">Save</button><button type="button" data-announcement-clear>Clear</button>
          </form>
          <p data-announcement-status></p><article data-announcement-preview></article>
          <small data-announcement-history-status></small>
          <div data-announcement-history-list></div>
        </section>
      </section>
    </main>`;
}

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('admin maintenance status UI', () => {
  it('shows the global status, toggles maintenance, and marks an active announcement', async () => {
    installDom();
    const openPreview = vi.spyOn(window, 'open').mockImplementation(() => null);
    const now = Date.now();
    let status = {
      enabled: false,
      revision: 0,
      updatedAt: null as string | null,
      activatedAt: null as string | null,
      settlesAt: null as string | null,
    };
    let mutationBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/service-status') {
        if (init?.method === 'POST') {
          mutationBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          const changedAt = new Date().toISOString();
          status = {
            enabled: true,
            revision: 1,
            updatedAt: changedAt,
            activatedAt: changedAt,
            settlesAt: new Date(Date.now() + 400).toISOString(),
          };
        }
        return Response.json({ generatedAt: new Date().toISOString(), serviceStatus: status });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          revision: 1,
          active: true,
          announcement: {
            id: 'launch-notice',
            enabled: true,
            message: 'Launch soon',
            expiresAt: new Date(now + 60_000).toISOString(),
            updatedAt: new Date(now).toISOString(),
          },
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
      expect(document.querySelector('[data-service-status-label]')?.textContent).toBe(
        'Operational',
      );
      expect(
        document
          .querySelector('[data-admin-tab="announcements"]')
          ?.classList.contains('has-active-announcement'),
      ).toBe(true);
    });

    document.querySelector<HTMLButtonElement>('[data-service-status-preview]')?.click();
    expect(openPreview).toHaveBeenCalledWith('/admin/maintenance-preview', '_blank', 'noopener');

    document.querySelector<HTMLButtonElement>('[data-service-status-trigger]')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLDialogElement>('[data-service-status-dialog]')?.open).toBe(
        true,
      );
      expect(
        document.querySelector<HTMLButtonElement>('[data-service-status-confirm]')?.disabled,
      ).toBe(false);
    });
    document.querySelector<HTMLButtonElement>('[data-service-status-confirm]')?.click();

    await vi.waitFor(() => {
      expect(mutationBody).toMatchObject({ enabled: true, expectedRevision: 0 });
      expect(String(mutationBody?.requestId)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(document.querySelector('[data-service-status-label]')?.textContent).toBe(
        'Activating...',
      );
    });
    await vi.waitFor(
      () => {
        expect(document.querySelector('[data-service-status-label]')?.textContent).toBe(
          'Maintenance',
        );
      },
      { timeout: 1_500 },
    );
  });

  it('keeps announcement Save and Clear single-flight until the mutation settles', async () => {
    installDom();
    let resolveSave!: (response: Response) => void;
    const saveResponse = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const announcementBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), location.origin);
      if (url.pathname === '/api/admin/session') {
        return Response.json({ authenticated: true, configured: true });
      }
      if (url.pathname === '/api/admin/service-status') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          serviceStatus: {
            enabled: false,
            revision: 0,
            updatedAt: null,
            activatedAt: null,
            settlesAt: null,
          },
        });
      }
      if (url.pathname === '/api/admin/metrics') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          cards: [],
          summary: { hourly: [], daily: [], daily30: [], last24: {} },
        });
      }
      if (url.pathname === '/api/admin/announcement' && init?.method === 'POST') {
        announcementBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return saveResponse;
      }
      if (url.pathname === '/api/admin/announcement') {
        return Response.json({
          generatedAt: new Date().toISOString(),
          revision: 0,
          active: false,
          announcement: {
            id: '',
            enabled: false,
            message: '',
            expiresAt: null,
            updatedAt: '',
          },
          history: [],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    window.eval(adminScript);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
      expect(
        document.querySelector<HTMLTextAreaElement>('[data-announcement-message]')?.value,
      ).toBe('');
    });

    const form = document.querySelector<HTMLFormElement>('[data-announcement-form]');
    const message = document.querySelector<HTMLTextAreaElement>('[data-announcement-message]');
    const enabled = document.querySelector<HTMLInputElement>('[data-announcement-enabled]');
    const clear = document.querySelector<HTMLButtonElement>('[data-announcement-clear]');
    if (!form || !message || !enabled || !clear) throw new Error('announcement form unavailable');
    message.value = 'One ordered notice';
    enabled.checked = true;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(announcementBodies).toHaveLength(1);
      expect(message.disabled).toBe(true);
      expect(clear.disabled).toBe(true);
    });
    clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(announcementBodies).toHaveLength(1);

    expect(announcementBodies[0]).toMatchObject({
      message: 'One ordered notice',
      enabled: true,
      expiresAt: null,
      expectedRevision: 0,
    });
    expect(String(announcementBodies[0].requestId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const updatedAt = new Date().toISOString();
    resolveSave(
      Response.json({
        revision: 1,
        active: true,
        announcement: {
          id: 'ordered-notice',
          message: 'One ordered notice',
          enabled: true,
          expiresAt: null,
          updatedAt,
        },
        history: [
          {
            id: 'ordered-notice',
            message: 'One ordered notice',
            enabled: true,
            expiresAt: null,
            updatedAt,
            action: 'published',
          },
        ],
      }),
    );
    await vi.waitFor(() => {
      expect(message.disabled).toBe(false);
      expect(clear.disabled).toBe(false);
      expect(document.querySelector('[data-announcement-status]')?.textContent).toContain('Active');
    });
  });
});
