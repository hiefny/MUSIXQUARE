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
        <button data-admin-tab="maintenance" data-service-status-trigger>
          <span data-service-status-dot></span><span data-service-status-label></span>
        </button>
        <button data-refresh>Refresh</button><button data-logout>Logout</button>
        <section data-admin-view="maintenance" hidden><section data-service-status-panel>
          <h2 data-service-status-state></h2>
          <p data-service-status-description></p><p data-service-status-updated></p>
          <p data-service-status-error></p>
          <div class="service-status-actions">
            <button type="button" data-service-status-preview>Preview page</button>
            <button type="button" data-service-status-change>Change</button>
          </div>
          <div data-service-status-confirmation hidden><p data-service-status-confirmation-copy></p>
            <button type="button" data-service-status-cancel>Cancel</button>
            <button type="button" data-service-status-confirm>Change</button>
          </div>
        </section><section>
          <button data-service-history-refresh>Refresh history</button>
          <p data-service-history-status></p><ol data-service-history-list></ol>
        </section></section>
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
  it.each(['stable', 'settling', 'moved', 'failure'] as const)(
    'restores inline confirmation focus after browser disable-blur without stealing it: %s',
    async (outcome) => {
      installDom();
      let releaseMutation!: (response: Response) => void;
      const mutation = new Promise<Response>((resolve) => {
        releaseMutation = resolve;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input), location.origin).pathname;
          if (path === '/api/admin/session') return Response.json({ authenticated: true });
          if (path === '/api/admin/service-status') {
            if (init?.method === 'POST') return mutation;
            return Response.json({ serviceStatus: { enabled: false, revision: 0 } });
          }
          if (path === '/api/admin/service-status/history') {
            return Response.json({ history: [], truncated: false });
          }
          return Response.json({ revision: 0, announcement: {}, cards: [], summary: {} });
        }),
      );
      window.eval(adminScript);
      const trigger = document.querySelector<HTMLButtonElement>('[data-service-status-trigger]')!;
      const change = document.querySelector<HTMLButtonElement>('[data-service-status-change]')!;
      const confirm = document.querySelector<HTMLButtonElement>('[data-service-status-confirm]')!;
      const preview = document.querySelector<HTMLButtonElement>('[data-service-status-preview]')!;
      const disabled = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'disabled')!;
      Object.defineProperty(confirm, 'disabled', {
        configurable: true,
        get: () => disabled.get!.call(confirm),
        set: (value: boolean) => {
          // jsdom keeps disabled buttons focused; Chromium moves focus to body.
          if (value && document.activeElement === confirm) confirm.blur();
          disabled.set!.call(confirm, value);
        },
      });
      await vi.waitFor(() => expect(trigger.dataset.state).toBe('operational'));
      trigger.click();
      change.click();
      confirm.focus();
      confirm.click();
      expect(confirm.disabled).toBe(true);
      expect(document.activeElement).toBe(document.body);
      if (outcome === 'moved') preview.focus();
      releaseMutation(
        outcome === 'failure'
          ? Response.json({ error: 'CONTROL_UNAVAILABLE' }, { status: 503 })
          : Response.json({
              serviceStatus: {
                enabled: true,
                revision: 1,
                settlesAt:
                  outcome === 'settling' ? new Date(Date.now() + 30_000).toISOString() : null,
              },
            }),
      );
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-service-status-panel]')!.hasAttribute('aria-busy'),
        ).toBe(false);
        const expectedFocus =
          outcome === 'moved'
            ? preview
            : outcome === 'settling'
              ? trigger
              : outcome === 'failure'
                ? confirm
                : change;
        expect(document.activeElement).toBe(expectedFocus);
      });
      expect(
        document.querySelector<HTMLElement>('[data-service-status-confirmation]')!.hidden,
      ).toBe(outcome !== 'failure');
    },
  );

  it('keeps history independent and requires a current inline confirmation to change service', async () => {
    installDom();
    let status = { enabled: true, revision: 4, updatedAt: '2030-01-02T01:00:00Z' };
    let historyReads = 0;
    let failHistory = false;
    const writes: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), location.origin).pathname;
        if (path === '/api/admin/session') return Response.json({ authenticated: true });
        if (path === '/api/admin/service-status') {
          if (init?.method === 'POST') writes.push(JSON.parse(String(init.body)));
          return Response.json({ serviceStatus: status });
        }
        if (path === '/api/admin/service-status/history') {
          historyReads += 1;
          return failHistory
            ? Response.json({ error: 'SERVICE_CONTROL_HISTORY_UNAVAILABLE' }, { status: 503 })
            : Response.json({
                history: [
                  status,
                  { enabled: false, revision: 3, updatedAt: '2030-01-01T01:00:00Z' },
                ],
                truncated: false,
              });
        }
        return Response.json({ revision: 0, announcement: {}, cards: [], summary: {} });
      }),
    );
    window.eval(adminScript);
    const trigger = document.querySelector<HTMLButtonElement>('[data-service-status-trigger]')!;
    const change = document.querySelector<HTMLButtonElement>('[data-service-status-change]')!;
    const confirm = document.querySelector<HTMLButtonElement>('[data-service-status-confirm]')!;
    const confirmation = document.querySelector<HTMLElement>('[data-service-status-confirmation]')!;
    const history = document.querySelector<HTMLElement>('[data-service-history-list]')!;
    const historyStatus = document.querySelector<HTMLElement>('[data-service-history-status]')!;
    await vi.waitFor(() => expect(trigger.dataset.state).toBe('maintenance'));
    expect(historyReads).toBe(0);
    trigger.click();
    await vi.waitFor(() => expect(history.childElementCount).toBe(2));
    expect(history.textContent).toContain('Entered maintenance');
    expect(history.textContent).toContain('Service resumed');
    expect(history.querySelector('time')?.dateTime).toBe('2030-01-02T01:00:00Z');
    expect(confirm.disabled).toBe(true);
    change.click();
    expect(confirmation.hidden).toBe(false);
    expect(document.querySelector('[data-service-status-confirmation-copy]')?.textContent).toBe(
      'Resume service?',
    );
    expect(writes).toEqual([]);
    const announcements = document.querySelector<HTMLButtonElement>(
      '[data-admin-tab="announcements"]',
    )!;
    announcements.focus();
    announcements.click();
    expect(confirmation.hidden).toBe(true);
    expect(document.activeElement).toBe(announcements);
    confirm.click();
    expect(writes).toEqual([]);

    trigger.click();
    await vi.waitFor(() => expect(historyReads).toBe(2));
    change.click();
    failHistory = true;
    status = { ...status, revision: 5 };
    document.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
    await vi.waitFor(() => expect(historyStatus.dataset.state).toBe('error'));
    expect(historyStatus.textContent).toBe('History is temporarily unavailable. Try again.');
    expect(history.childElementCount).toBe(2);
    expect(historyReads).toBe(3);
    expect(trigger.dataset.state).toBe('maintenance');
    expect(change.disabled).toBe(false);
    expect(confirmation.hidden).toBe(true);
    expect(document.activeElement).toBe(change);
    expect(document.querySelector<HTMLElement>('[data-service-status-error]')!.hidden).toBe(true);
    change.click();
    expect(confirm.disabled).toBe(false);
    document.querySelector<HTMLButtonElement>('[data-service-status-cancel]')!.click();
    expect(confirmation.hidden).toBe(true);
    expect(document.activeElement).toBe(change);
    confirm.click();
    expect(writes).toEqual([]);
  });

  it('does not let an older history response overwrite the history fetched after a change', async () => {
    installDom();
    let status = { enabled: true, revision: 1, updatedAt: '2030-01-01T01:00:00Z' };
    let releaseHistory!: (response: Response) => void;
    const oldHistory = new Promise<Response>((resolve) => {
      releaseHistory = resolve;
    });
    let historyReads = 0;
    const writes: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), location.origin).pathname;
        if (path === '/api/admin/session') return Response.json({ authenticated: true });
        if (path === '/api/admin/service-status') {
          if (init?.method === 'POST') {
            writes.push(JSON.parse(String(init.body)));
            status = { enabled: false, revision: 2, updatedAt: '2030-01-02T01:00:00Z' };
          }
          return Response.json({ serviceStatus: status });
        }
        if (path === '/api/admin/service-status/history') {
          if (++historyReads === 1) return oldHistory;
          return Response.json({ history: [status], truncated: false });
        }
        return Response.json({
          revision: 0,
          rooms: [],
          articles: [],
          announcement: {},
          cards: [],
          summary: {},
        });
      }),
    );
    window.eval(adminScript);
    const trigger = document.querySelector<HTMLButtonElement>('[data-service-status-trigger]')!;
    const confirm = document.querySelector<HTMLButtonElement>('[data-service-status-confirm]')!;
    const history = document.querySelector<HTMLElement>('[data-service-history-list]')!;
    await vi.waitFor(() => expect(trigger.dataset.state).toBe('maintenance'));
    trigger.click();
    await vi.waitFor(() => expect(historyReads).toBe(1));
    document.querySelector<HTMLButtonElement>('[data-service-status-change]')!.click();
    confirm.click();
    await vi.waitFor(() => expect(history.textContent).toContain('Service resumed'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ enabled: false, expectedRevision: 1 });
    releaseHistory(
      Response.json({
        history: [{ enabled: true, revision: 1, updatedAt: '2030-01-01T01:00:00Z' }],
        truncated: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(history.textContent).not.toContain('Entered maintenance');
    expect(history.querySelector('time')?.dateTime).toBe('2030-01-02T01:00:00Z');
    expect(document.querySelector<HTMLElement>('[data-service-status-confirmation]')!.hidden).toBe(
      true,
    );
    expect(document.querySelector<HTMLElement>('[data-admin-view="maintenance"]')!.hidden).toBe(
      false,
    );
    expect(
      document.querySelector<HTMLButtonElement>('[data-service-history-refresh]')!.disabled,
    ).toBe(false);
  });

  it('clears maintenance history at logout and ignores a late history response', async () => {
    installDom();
    let historyReads = 0;
    let releaseHistory!: (response: Response) => void;
    const pendingHistory = new Promise<Response>((resolve) => {
      releaseHistory = resolve;
    });
    const entry = { enabled: true, revision: 1, updatedAt: '2030-01-01T01:00:00Z' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), location.origin).pathname;
        if (path === '/api/admin/session') return Response.json({ authenticated: true });
        if (path === '/api/admin/service-status') return Response.json({ serviceStatus: entry });
        if (path === '/api/admin/service-status/history') {
          if (++historyReads === 2) return pendingHistory;
          return Response.json({ history: [entry], truncated: false });
        }
        return Response.json({ ok: true });
      }),
    );
    window.eval(adminScript);
    const trigger = document.querySelector<HTMLButtonElement>('[data-service-status-trigger]')!;
    const history = document.querySelector<HTMLElement>('[data-service-history-list]')!;
    await vi.waitFor(() => expect(trigger.dataset.state).toBe('maintenance'));
    trigger.click();
    await vi.waitFor(() => expect(history.childElementCount).toBe(1));
    document.querySelector<HTMLButtonElement>('[data-service-history-refresh]')!.click();
    await vi.waitFor(() => expect(historyReads).toBe(2));
    document.querySelector<HTMLButtonElement>('[data-service-status-change]')!.click();
    document.querySelector<HTMLButtonElement>('[data-logout]')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-dashboard]')!.hidden).toBe(true),
    );
    expect(history.childElementCount).toBe(0);
    expect(document.querySelector('[data-service-history-status]')!.textContent).toBe('');
    expect(document.querySelector<HTMLElement>('[data-service-status-confirmation]')!.hidden).toBe(
      true,
    );
    releaseHistory(Response.json({ history: [entry], truncated: false }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(history.childElementCount).toBe(0);
    expect(document.querySelector('[data-service-history-status]')!.textContent).toBe('');
  });

  it.each(['2031-02-29 12:00', '2032-02-30 12:00', '2031-04-31', '2031-12-31 24:00'])(
    'does not publish an announcement with a rolled-over expiry: %s',
    async (invalidExpiry) => {
      installDom();
      vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2030, 0, 1));
      const writes: Array<Record<string, unknown>> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input), location.origin).pathname;
          if (path === '/api/admin/session') return Response.json({ authenticated: true });
          if (path === '/api/admin/service-status') {
            return Response.json({ serviceStatus: { enabled: false, revision: 0 } });
          }
          if (path === '/api/admin/announcement') {
            const body =
              init?.method === 'POST'
                ? (JSON.parse(String(init.body)) as Record<string, unknown>)
                : null;
            if (body) writes.push(body);
            return Response.json({
              revision: writes.length,
              announcement: body || { message: '', enabled: false },
              history: [],
            });
          }
          return Response.json({ cards: [], summary: {} });
        }),
      );
      window.eval(adminScript);
      const status = document.querySelector<HTMLElement>('[data-announcement-status]')!;
      await vi.waitFor(() => expect(status.textContent).toBe('Disabled'));
      document.querySelector<HTMLButtonElement>('[data-admin-tab="announcements"]')!.click();
      const message = document.querySelector<HTMLTextAreaElement>('[data-announcement-message]')!;
      const enabled = document.querySelector<HTMLInputElement>('[data-announcement-enabled]')!;
      const expires = document.querySelector<HTMLInputElement>('[data-announcement-expires]')!;
      const form = document.querySelector<HTMLFormElement>('[data-announcement-form]')!;
      message.value = 'Scheduled announcement';
      enabled.checked = true;
      expires.value = invalidExpiry;
      form.requestSubmit();
      await vi.waitFor(() => expect(status.textContent).toBe('Use YYYY-MM-DD HH:MM for Expires.'));
      expect(writes).toEqual([]);
      expect(expires.value).toBe(invalidExpiry);
      expect(message.disabled).toBe(false);

      // A valid leap day and an explicit UTC timestamp still use the existing form.
      for (const validExpiry of ['2032-02-29 12:00', '2031-04-30', '2031-05-01T10:30:00Z']) {
        expires.value = validExpiry;
        const expectedCount = writes.length + 1;
        form.requestSubmit();
        await vi.waitFor(() => {
          expect(writes).toHaveLength(expectedCount);
          expect(message.disabled).toBe(false);
        });
        const expectedDate =
          validExpiry === '2031-04-30' ? new Date(2031, 3, 30, 23, 59) : new Date(validExpiry);
        expect(writes.at(-1)?.expiresAt).toBe(expectedDate.toISOString());
      }
    },
  );

  it('keeps a newer service mutation locked when an earlier resume refresh finishes', async () => {
    installDom();
    let resolveMetrics!: (response: Response) => void;
    const metricsResponse = new Promise<Response>((resolve) => {
      resolveMetrics = resolve;
    });
    let resolveSecondMutation!: (response: Response) => void;
    const secondMutation = new Promise<Response>((resolve) => {
      resolveSecondMutation = resolve;
    });
    let mutationCount = 0;
    let metricsCount = 0;
    let serviceReads = 0;
    let status = {
      enabled: true,
      revision: 1,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      activatedAt: null,
      settlesAt: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), location.origin);
        if (url.pathname === '/api/admin/session') {
          return Response.json({ authenticated: true, configured: true });
        }
        if (url.pathname === '/api/admin/service-status') {
          if (init?.method === 'POST') {
            mutationCount += 1;
            if (mutationCount === 2) return secondMutation;
            status = { ...status, enabled: false, revision: 2 };
          } else serviceReads += 1;
          return Response.json({ serviceStatus: status });
        }
        if (url.pathname === '/api/admin/metrics') {
          metricsCount += 1;
          return metricsResponse;
        }
        return Response.json({ revision: 0, rooms: [], articles: [], announcement: {} });
      }),
    );
    window.eval(adminScript);
    const trigger = document.querySelector<HTMLButtonElement>('[data-service-status-trigger]')!;
    const confirm = document.querySelector<HTMLButtonElement>('[data-service-status-confirm]')!;
    const panel = document.querySelector<HTMLElement>('[data-admin-view="maintenance"]')!;
    const confirmation = document.querySelector<HTMLElement>('[data-service-status-confirmation]')!;
    const change = document.querySelector<HTMLButtonElement>('[data-service-status-change]')!;
    await vi.waitFor(() => expect(trigger.dataset.state).toBe('maintenance'));
    expect(trigger.textContent).toContain('Maintenance');
    trigger.click();
    change.click();
    await vi.waitFor(() => expect(confirm.disabled).toBe(false));
    confirm.click();
    await vi.waitFor(() => {
      expect(metricsCount).toBe(1);
      expect(confirmation.hidden).toBe(true);
      expect(panel.hidden).toBe(false);
    });
    trigger.click();
    change.click();
    await vi.waitFor(() => expect(confirm.disabled).toBe(false));
    confirm.click();
    await vi.waitFor(() => expect(mutationCount).toBe(2));
    expect(confirm.disabled).toBe(true);
    const readsDuringMutation = serviceReads;
    trigger.click();
    await Promise.resolve();
    expect(serviceReads).toBe(readsDuringMutation);
    expect(trigger.disabled).toBe(false);
    resolveMetrics(
      Response.json({ generatedAt: new Date().toISOString(), cards: [], summary: {} }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-updated-at]')?.textContent).toMatch(/^Updated /),
    );
    try {
      expect(confirm.disabled).toBe(true);
      expect(confirmation.hidden).toBe(false);
      expect(panel.hidden).toBe(false);
      confirm.click();
      expect(mutationCount).toBe(2);
    } finally {
      resolveSecondMutation(
        Response.json({ serviceStatus: { ...status, enabled: true, revision: 3 } }),
      );
      await vi.waitFor(() => expect(confirmation.hidden).toBe(true));
    }
  });

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
    const trigger = document.querySelector<HTMLButtonElement>('[data-service-status-trigger]')!;
    const label = document.querySelector('[data-service-status-label]')!;
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false);
      expect(trigger.dataset.state).toBe('operational');
      expect(label.textContent).toBe('Maintenance');
      expect(
        document
          .querySelector('[data-admin-tab="announcements"]')
          ?.classList.contains('has-active-announcement'),
      ).toBe(true);
    });

    document.querySelector<HTMLButtonElement>('[data-service-status-preview]')?.click();
    expect(openPreview).toHaveBeenCalledWith('/admin/maintenance-preview', '_blank', 'noopener');

    document.querySelector<HTMLButtonElement>('[data-service-status-trigger]')?.click();
    const change = document.querySelector<HTMLButtonElement>('[data-service-status-change]')!;
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-admin-view="maintenance"]')?.hidden).toBe(
        false,
      );
      expect(change.disabled).toBe(false);
    });
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-admin-view="operations"]')?.hidden).toBe(
      true,
    );
    expect(document.querySelector('[data-dashboard-title]')?.textContent).toBe('Maintenance');
    change.click();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        document.querySelector<HTMLButtonElement>('[data-service-status-cancel]'),
      );
    });
    document.querySelector<HTMLButtonElement>('[data-service-status-confirm]')?.click();

    await vi.waitFor(() => {
      expect(mutationBody).toMatchObject({ enabled: true, expectedRevision: 0 });
      expect(String(mutationBody?.requestId)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(trigger.dataset.state).toBe('activating');
      expect(label.textContent).toBe('Maintenance');
      expect(document.activeElement).toBe(trigger);
    });
    await vi.waitFor(
      () => {
        expect(trigger.dataset.state).toBe('maintenance');
        expect(label.textContent).toBe('Maintenance');
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
