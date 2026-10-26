// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileClassicRuntimeForBrowserTest } from './classic-runtime-test-asset.ts';

const adminScript = compileClassicRuntimeForBrowserTest('admin.js');
const T0 = Date.parse('2026-10-26T05:00:00.000Z');

function installDom(): void {
  document.body.innerHTML = `
    <main class="admin-shell" data-admin-configured="true">
      <section data-login-panel>
        <form data-login-form><input name="password"><button type="submit">Login</button></form>
        <p data-login-status></p>
      </section>
      <section data-dashboard hidden>
        <h1 data-dashboard-title>Analytics</h1><p data-updated-at></p>
        <button data-refresh>Refresh</button><button data-logout>Logout</button>
        <nav>
          <button data-admin-tab="operations">Analytics</button>
          <button data-admin-tab="maintenance" data-service-status-trigger>
            <span data-service-status-dot></span><span data-service-status-label></span>
          </button>
        </nav>
        <section data-admin-view="maintenance" hidden>
          <section data-service-status-panel>
            <h2 data-service-status-state></h2>
            <p data-service-status-description></p><p data-service-status-updated></p>
            <p data-service-status-error></p>
          </section>
          <section>
            <button data-service-history-refresh>Refresh history</button>
            <p data-service-history-status></p><ol data-service-history-list></ol>
          </section>
          <section data-app-build-floor-panel data-state="unknown">
            <h2 data-app-build-floor-state>Checking</h2>
            <button type="button" data-app-build-floor-refresh>Refresh</button>
            <p data-app-build-floor-summary></p>
            <dl data-app-build-floor-facts></dl>
            <form data-app-build-floor-form>
              <input type="number" data-app-build-floor-input>
              <button type="submit" data-app-build-floor-lower disabled>Lower</button>
            </form>
            <p role="alert" data-app-build-floor-error hidden></p>
            <p data-app-build-floor-history-status></p>
            <ol data-app-build-floor-history-list></ol>
          </section>
        </section>
        <section data-admin-view="operations">
          <div data-metric-cards></div><div data-hourly-chart></div>
          <div data-daily-list></div><div data-monthly-chart></div><div data-signal-grid></div>
        </section>
      </section>
    </main>`;
}

interface FloorState {
  minAppBuild: number;
  effectiveMinAppBuild: number;
  revision: number;
  updatedAt: number | null;
  liveAppBuild: number | null;
  reportedLiveAppBuild: number | null;
  reportedAt: number | null;
  state: 'valid' | 'invalid';
  generatedAt: number;
}

function floor(overrides: Partial<FloorState> = {}): FloorState {
  return {
    minAppBuild: 785,
    effectiveMinAppBuild: 785,
    revision: 1,
    updatedAt: T0 - 3_600_000,
    liveAppBuild: 785,
    reportedLiveAppBuild: 785,
    reportedAt: T0 - 30_000,
    state: 'valid',
    generatedAt: T0,
    ...overrides,
  };
}

function installFetch(options: {
  current: () => FloorState;
  onLower?: (body: Record<string, unknown>) => Response;
  view?: () => Response;
}) {
  const posts: Record<string, unknown>[] = [];
  const reads = { floor: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), location.origin).pathname;
      if (path === '/api/admin/session') return Response.json({ authenticated: true });
      if (path === '/api/admin/service-status') {
        return Response.json({ serviceStatus: { enabled: false, revision: 0 } });
      }
      if (path === '/api/admin/service-status/history') {
        return Response.json({ history: [], truncated: false });
      }
      if (path === '/api/admin/app-build-floor' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return options.onLower
          ? options.onLower(body)
          : Response.json({ ok: true, changed: true, appBuildFloor: options.current() });
      }
      if (path === '/api/admin/app-build-floor') {
        reads.floor += 1;
        if (options.view) return options.view();
        return Response.json({
          generatedAt: new Date(T0).toISOString(),
          appBuildFloor: options.current(),
          floorHistory: [
            {
              minAppBuild: 785,
              revision: 1,
              updatedAt: new Date(T0 - 3_600_000).toISOString(),
              reason: 'Release 9.0.12 verified',
              note: null,
            },
          ],
          floorHistoryTruncated: false,
        });
      }
      return Response.json({ cards: [], summary: {} });
    }),
  );
  return { posts, reads };
}

async function openMaintenance() {
  window.eval(adminScript);
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false),
  );
  document.querySelector<HTMLButtonElement>('[data-admin-tab="maintenance"]')!.click();
}

function text(selector: string) {
  return document.querySelector<HTMLElement>(selector)?.textContent?.trim() ?? '';
}

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('admin App build floor panel', () => {
  it('shows the stored and enforced floor, the live and reported builds and the history', async () => {
    installDom();
    const { reads } = installFetch({
      current: () => floor({ minAppBuild: 786, effectiveMinAppBuild: 785, revision: 2 }),
    });
    await openMaintenance();
    const panel = document.querySelector<HTMLElement>('[data-app-build-floor-panel]')!;
    await vi.waitFor(() => expect(panel.dataset.state).toBe('on'));
    expect(reads.floor).toBe(1);
    expect(text('[data-app-build-floor-state]')).toBe('Minimum build 786');
    const facts = text('[data-app-build-floor-facts]');
    expect(facts).toContain('Stored floor786');
    expect(facts).toContain('Enforced floor785');
    expect(facts).toContain('Revision2');
    expect(facts).toContain('This App build785');
    expect(facts).toMatch(/Reported App build785 \(30 s ago\)/u);
    const rows = document.querySelectorAll('[data-app-build-floor-history-list] li');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Minimum build 785');
    expect(rows[0]?.textContent).toContain('Release 9.0.12 verified');
    // Text stays at or below the dashboard's 700 weight; no inline weights.
    expect(panel.innerHTML).not.toMatch(/font-weight/u);
  });

  it('enables Lower only for a whole number below the stored floor and sends a guarded lower', async () => {
    installDom();
    let current = floor();
    const { posts, reads } = installFetch({
      current: () => current,
      onLower: (body) => {
        current = floor({
          minAppBuild: Number(body.minAppBuild),
          effectiveMinAppBuild: Number(body.minAppBuild),
          revision: 2,
        });
        return Response.json({ ok: true, changed: true, replayed: false, appBuildFloor: current });
      },
    });
    await openMaintenance();
    const panel = document.querySelector<HTMLElement>('[data-app-build-floor-panel]')!;
    await vi.waitFor(() => expect(panel.dataset.state).toBe('on'));
    const input = document.querySelector<HTMLInputElement>('[data-app-build-floor-input]')!;
    const lower = document.querySelector<HTMLButtonElement>('[data-app-build-floor-lower]')!;
    const form = document.querySelector<HTMLFormElement>('[data-app-build-floor-form]')!;

    for (const value of ['', '785', '786', '-1', '784.5', 'abc']) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(lower.disabled, value).toBe(true);
    }
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(lower.disabled).toBe(false);

    form.requestSubmit();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      minAppBuild: 0,
      expectedRevision: 1,
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    });
    await vi.waitFor(() => expect(panel.dataset.state).toBe('off'));
    expect(text('[data-app-build-floor-state]')).toBe('Off');
    expect(input.value).toBe('');
    expect(lower.disabled).toBe(true);
    // The history is read again after the change.
    await vi.waitFor(() => expect(reads.floor).toBe(2));
  });

  it('shows a refused lower and keeps the last verified floor', async () => {
    installDom();
    const { posts } = installFetch({
      current: () => floor(),
      onLower: () =>
        Response.json(
          {
            error: 'APP_BUILD_FLOOR_REVISION_CONFLICT',
            appBuildFloor: floor({ minAppBuild: 790, effectiveMinAppBuild: 785, revision: 3 }),
          },
          { status: 409 },
        ),
    });
    await openMaintenance();
    const panel = document.querySelector<HTMLElement>('[data-app-build-floor-panel]')!;
    await vi.waitFor(() => expect(panel.dataset.state).toBe('on'));
    const input = document.querySelector<HTMLInputElement>('[data-app-build-floor-input]')!;
    input.value = '700';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLFormElement>('[data-app-build-floor-form]')!.requestSubmit();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const error = document.querySelector<HTMLElement>('[data-app-build-floor-error]')!;
    await vi.waitFor(() => expect(error.hidden).toBe(false));
    expect(error.textContent).toMatch(/changed in another session/iu);
    // The conflict carries the newer state, which replaces the form's base.
    await vi.waitFor(() => expect(text('[data-app-build-floor-state]')).toBe('Minimum build 790'));
  });

  it('reports an unavailable floor without enabling Lower', async () => {
    installDom();
    installFetch({
      current: () => floor(),
      view: () => Response.json({ error: 'APP_BUILD_FLOOR_UNAVAILABLE' }, { status: 503 }),
    });
    await openMaintenance();
    const panel = document.querySelector<HTMLElement>('[data-app-build-floor-panel]')!;
    await vi.waitFor(() => expect(panel.dataset.state).toBe('unknown'));
    const error = document.querySelector<HTMLElement>('[data-app-build-floor-error]')!;
    await vi.waitFor(() => expect(error.hidden).toBe(false));
    expect(error.textContent).toMatch(/unavailable/iu);
    const input = document.querySelector<HTMLInputElement>('[data-app-build-floor-input]')!;
    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(
      document.querySelector<HTMLButtonElement>('[data-app-build-floor-lower]')!.disabled,
    ).toBe(true);
  });
});
