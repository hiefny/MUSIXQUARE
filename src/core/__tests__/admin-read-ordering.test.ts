// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileClassicRuntimeForBrowserTest } from './classic-runtime-test-asset.ts';

const adminScript = compileClassicRuntimeForBrowserTest('admin.js');

function installDom(): void {
  document.body.innerHTML = `
    <main class="admin-shell" data-admin-configured="true">
      <section data-login-panel><form data-login-form></form><p data-login-status></p></section>
      <section data-dashboard hidden>
        <button data-refresh>Refresh</button><p data-updated-at></p>
        <button data-admin-tab="announcements">Announcements</button>
        <button data-admin-tab="pro-rooms">PRO rooms</button>
        <section data-admin-view="announcements">
          <form data-announcement-form><input type="checkbox" data-announcement-enabled>
            <textarea data-announcement-message></textarea><input data-announcement-expires>
            <button type="submit">Save</button></form><p data-announcement-status></p>
        </section>
        <section data-admin-view="pro-rooms"><section class="pro-room-register-panel"></section>
          <div data-pro-room-list></div><p data-pro-room-list-status></p></section>
      </section>
    </main>`;
}

function heldJson(payload: unknown, signal: AbortSignal | null | undefined) {
  let finish!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => controller.error(new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        finish = () => {
          signal?.removeEventListener('abort', abort);
          if (signal?.aborted) return;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
          controller.close();
        };
      },
    }),
  );
  return { response, finish: () => finish() };
}

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('admin reads crossing a mutation', () => {
  it.each(['success', 'failure'] as const)(
    'preserves a maintenance %s while an older dialog refresh body finishes later',
    async (outcome) => {
      installDom();
      document.querySelector('[data-dashboard]')!.insertAdjacentHTML(
        'afterbegin',
        `<button data-service-status-trigger><span data-service-status-label></span></button>
       <dialog data-service-status-dialog><h2 data-service-status-state></h2>
         <p data-service-status-description></p><p data-service-status-updated></p>
         <p data-service-status-error></p><div class="service-status-dialog-actions">
           <button data-service-status-cancel>Cancel</button>
           <button data-service-status-confirm>Change</button>
         </div>
       </dialog>`,
      );
      let reads = 0;
      let held: ReturnType<typeof heldJson> | undefined;
      let releaseMutation!: () => void;
      const mutationPending = new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      let status = {
        enabled: false,
        revision: 0,
        updatedAt: null as string | null,
        settlesAt: null as string | null,
      };
      const writes: unknown[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = String(input);
          if (path === '/api/admin/session') return Response.json({ authenticated: true });
          if (path === '/api/admin/service-status') {
            if (init?.method === 'POST') {
              const body = JSON.parse(String(init.body)) as {
                enabled: boolean;
                expectedRevision: number;
              };
              writes.push(body);
              if (writes.length === 1) await mutationPending;
              if (outcome === 'failure' && writes.length === 1) {
                return Response.json({ error: 'CONTROL_UNAVAILABLE' }, { status: 503 });
              }
              if (body.expectedRevision !== status.revision) {
                return Response.json(
                  { error: 'SERVICE_STATUS_REVISION_MISMATCH', serviceStatus: status },
                  { status: 409 },
                );
              }
              status = {
                enabled: body.enabled,
                revision: status.revision + 1,
                updatedAt: new Date().toISOString(),
                settlesAt: new Date(Date.now() + 30_000).toISOString(),
              };
            } else if (++reads === 2) {
              held = heldJson({ serviceStatus: { ...status } }, init?.signal);
              return held.response;
            }
            return Response.json({ serviceStatus: status });
          }
          return Response.json({ revision: 0, announcement: {}, cards: [], summary: {} });
        }),
      );
      window.eval(adminScript);
      const trigger = document.querySelector<HTMLButtonElement>('[data-service-status-trigger]')!;
      const confirm = document.querySelector<HTMLButtonElement>('[data-service-status-confirm]')!;
      const label = document.querySelector('[data-service-status-label]')!;
      const error = document.querySelector<HTMLElement>('[data-service-status-error]')!;
      await vi.waitFor(() => expect(label.textContent).toBe('Operational'));
      trigger.click();
      await vi.waitFor(() => expect(held).toBeDefined());
      expect(confirm.disabled).toBe(false);
      const focus = vi.spyOn(HTMLElement.prototype, 'focus');
      confirm.click();
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect.soft(error.textContent).toBe('');
      expect.soft(error.hidden).toBe(true);
      expect.soft(focus).not.toHaveBeenCalled();
      expect(confirm.disabled).toBe(true);
      releaseMutation();
      if (outcome === 'success') {
        await vi.waitFor(() => expect(label.textContent).toBe('Activating...'));
        expect(status).toMatchObject({ enabled: true, revision: 1 });
      } else {
        await vi.waitFor(() => expect(error.textContent).toBe('CONTROL_UNAVAILABLE'));
        expect(status).toMatchObject({ enabled: false, revision: 0 });
      }
      const acceptedError = error.textContent;
      held!.finish();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(label.textContent).toBe(outcome === 'success' ? 'Activating...' : 'Operational');
      expect(confirm.disabled).toBe(outcome === 'success');
      expect(error.textContent).toBe(acceptedError);
      expect(writes).toHaveLength(1);

      // A later real dialog read still accepts the current server revision and
      // targets it in the next change, including retry after a rejected mutation.
      document.querySelector<HTMLButtonElement>('[data-service-status-cancel]')!.click();
      status = { enabled: true, revision: 2, updatedAt: new Date().toISOString(), settlesAt: null };
      trigger.click();
      await vi.waitFor(() => expect(label.textContent).toBe('Maintenance'));
      expect(confirm.disabled).toBe(false);
      confirm.click();
      await vi.waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[1]).toMatchObject({ enabled: false, expectedRevision: 2 });
      await vi.waitFor(() => expect(label.textContent).toBe('Resuming...'));
      expect(status).toMatchObject({ enabled: false, revision: 3 });
    },
  );

  it.each(['metrics', 'service-status', 'legacy-metrics', 'unchanged'] as const)(
    'preserves initial dashboard navigation while %s completes',
    async (endpoint) => {
      installDom();
      document.querySelector('[data-dashboard]')!.insertAdjacentHTML(
        'afterbegin',
        `<button data-admin-tab="operations">Operations</button>
         <section data-admin-view="operations"></section>
         ${endpoint === 'legacy-metrics' ? '' : '<button data-service-status-trigger>Service status</button>'}`,
      );
      let held: ReturnType<typeof heldJson> | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = String(input);
          if (path === '/api/admin/session') return Response.json({ authenticated: true });
          const payload =
            path === '/api/admin/service-status'
              ? { serviceStatus: { enabled: false, revision: 0 } }
              : { revision: 0, announcement: {}, cards: [], summary: {} };
          const holdPath = endpoint === 'service-status' ? endpoint : 'metrics';
          if (path === `/api/admin/${holdPath}` && !held) {
            held = heldJson(payload, init?.signal);
            return held.response;
          }
          return Response.json(payload);
        }),
      );
      window.eval(adminScript);
      await vi.waitFor(() => expect(held).toBeDefined());
      expect(document.querySelector<HTMLElement>('[data-dashboard]')!.hidden).toBe(false);
      const target = endpoint === 'unchanged' ? 'operations' : 'announcements';
      const button = document.querySelector<HTMLButtonElement>(`[data-admin-tab="${target}"]`)!;
      if (endpoint !== 'unchanged') button.click();
      expect(button.getAttribute('aria-selected')).toBe('true');
      held!.finish();
      await vi.waitFor(() =>
        expect(document.querySelector('[data-updated-at]')!.textContent).toMatch(/^Updated /),
      );
      expect(button.getAttribute('aria-selected')).toBe('true');
      expect(document.querySelector<HTMLElement>(`[data-admin-view="${target}"]`)!.hidden).toBe(
        false,
      );
    },
  );

  it.each(['data', 'status-operational', 'status-maintenance', 'status-unavailable', 'unchanged'])(
    'preserves the selected tab through a delayed %s refresh',
    async (scenario) => {
      installDom();
      document
        .querySelector('[data-dashboard]')!
        .insertAdjacentHTML(
          'afterbegin',
          '<button data-service-status-trigger>Service status</button>',
        );
      let holdRefresh = false;
      let held: ReturnType<typeof heldJson> | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = String(input);
          if (path === '/api/admin/session') return Response.json({ authenticated: true });
          const payload =
            path === '/api/admin/service-status'
              ? {
                  serviceStatus: {
                    enabled: holdRefresh && scenario === 'status-maintenance',
                    revision: 0,
                  },
                }
              : {
                  revision: 0,
                  announcement: {},
                  campaigns: [],
                  rooms: [],
                  articles: [],
                  cards: [],
                  summary: {},
                };
          const holdPath = scenario.startsWith('status-')
            ? '/api/admin/service-status'
            : '/api/admin/metrics';
          if (holdRefresh && !held && path === holdPath) {
            held = heldJson(payload, init?.signal);
            return scenario === 'status-unavailable'
              ? new Response(held.response.body, { status: 503 })
              : held.response;
          }
          return Response.json(payload);
        }),
      );
      window.eval(adminScript);
      await vi.waitFor(() =>
        expect(document.querySelector('[data-announcement-status]')?.textContent).toBe('Disabled'),
      );
      const rooms = document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')!;
      const announcements = document.querySelector<HTMLButtonElement>(
        '[data-admin-tab="announcements"]',
      )!;
      rooms.click();
      await vi.waitFor(() =>
        expect(document.querySelector('[data-pro-room-list-status]')?.textContent).toBe('0 rooms'),
      );
      holdRefresh = true;
      document.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
      await vi.waitFor(() => expect(held).toBeDefined());
      if (scenario !== 'unchanged') announcements.click();
      const selected = scenario === 'unchanged' ? rooms : announcements;
      expect(selected.getAttribute('aria-selected')).toBe('true');
      held!.finish();
      await vi.waitFor(() =>
        expect(document.querySelector('[data-updated-at]')?.textContent).toMatch(
          /^(Updated |Maintenance active|Service status unavailable)/,
        ),
      );
      expect(selected.getAttribute('aria-selected')).toBe('true');
      expect(
        document.querySelector<HTMLElement>(`[data-admin-view="${selected.dataset.adminTab}"]`)
          ?.hidden,
      ).toBe(false);
    },
  );

  it('preserves a saved announcement when an older refresh body finishes later', async () => {
    installDom();
    let gets = 0;
    let held: ReturnType<typeof heldJson> | undefined;
    let revision = 1;
    let message = 'Old announcement';
    const writes: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === '/api/admin/session') return Response.json({ authenticated: true });
        if (path === '/api/admin/announcement') {
          if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body));
            writes.push(body);
            revision += 1;
            message = body.message;
          } else gets += 1;
          const payload = { revision, announcement: { message, enabled: true }, history: [] };
          if (init?.method !== 'POST' && gets === 2) {
            held = heldJson(payload, init?.signal);
            return held.response;
          }
          return Response.json(payload);
        }
        return Response.json({ campaigns: [], rooms: [], articles: [], cards: [], summary: {} });
      }),
    );
    window.eval(adminScript);
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false),
    );
    document.querySelector<HTMLButtonElement>('[data-admin-tab="announcements"]')!.click();
    const input = document.querySelector<HTMLTextAreaElement>('[data-announcement-message]')!;
    await vi.waitFor(() => expect(input.value).toBe('Old announcement'));
    document.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
    await vi.waitFor(() => expect(held).toBeDefined());
    input.value = 'New announcement';
    const form = document.querySelector<HTMLFormElement>('[data-announcement-form]')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    expect(writes).toHaveLength(1);
    held!.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(input.value).toBe('New announcement');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({ expectedRevision: 2, message: 'New announcement' });
  });

  it('preserves a paused campaign when an earlier refresh body finishes later', async () => {
    installDom();
    let gets = 0;
    let held: ReturnType<typeof heldJson> | undefined;
    let status = 'active';
    const writes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === '/api/admin/session') return Response.json({ authenticated: true });
        if (path === '/api/admin/pro-grants/campaigns/test/status') {
          status = JSON.parse(String(init?.body)).status;
          writes.push(status);
          return Response.json({ ok: true });
        }
        if (path === '/api/admin/pro-grants/campaigns') {
          gets += 1;
          const payload = {
            campaigns: [
              {
                campaign: {
                  slug: 'test',
                  title: 'Test event',
                  status,
                  startsAt: Date.now() - 1_000,
                  endsAt: null,
                  perAccountLimit: 1,
                },
                counts: { total: 1, available: 1 },
                roomCodes: ['000100'],
              },
            ],
          };
          if (gets === 2) {
            held = heldJson(payload, init?.signal);
            return held.response;
          }
          return Response.json(payload);
        }
        return Response.json({
          revision: 0,
          announcement: {},
          rooms: [],
          articles: [],
          cards: [],
          summary: {},
        });
      }),
    );
    window.eval(adminScript);
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false),
    );
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')!.click();
    const button = document.querySelector<HTMLButtonElement>('[data-pro-grant-pause]')!;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    document.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
    await vi.waitFor(() => expect(held).toBeDefined());
    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe('Resume'));
    held!.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(button.textContent).toBe('Resume');
    button.click();
    await vi.waitFor(() => expect(writes).toEqual(['paused', 'active']));
  });
});
