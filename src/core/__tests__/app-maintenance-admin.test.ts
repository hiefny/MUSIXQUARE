import { afterEach, describe, expect, it, vi } from 'vitest';

import appWorker from '../../../cloudflare/app-worker.ts';
import {
  ABUSE_RATE_CONSUME_PATH,
  ABUSE_RATE_IDEMPOTENT_CONSUME_PATH,
  ADMIN_ANNOUNCEMENT_STATUS_PATH,
  SERVICE_CONTROL_HISTORY_PATH,
  SERVICE_CONTROL_STATE_PATH,
  SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER,
  SERVICE_CONTROL_STATUS_ENABLED_HEADER,
  SERVICE_CONTROL_STATUS_PATH,
  SERVICE_CONTROL_STATUS_REVISION_HEADER,
  SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER,
  SERVICE_CONTROL_STATUS_VERSION_HEADER,
  STATUS_NOTE_CONTROL_OBJECT_NAME,
  clearServiceMaintenanceCacheForTests,
} from '../../../cloudflare/service-maintenance.ts';
import {
  STATUS_CLAIM_PATH,
  STATUS_PUBLIC_PATH,
  STATUS_REPORT_PATH,
} from '../../../cloudflare/status-contract.ts';
import { STATUS_NOTE_MESSAGE_MAX_LENGTH } from '../../../cloudflare/status-note-text.ts';
import { createAtomicRateControlBinding } from './service-control-rate-limit-fixture.ts';

interface ControlState {
  enabled: boolean;
  revision: number;
  updatedAt: number | null;
  activatedAt: number | null;
}

function createServiceControl(initialEnabled = false) {
  const rateControl = createAtomicRateControlBinding();
  let state: ControlState = {
    enabled: initialEnabled,
    revision: initialEnabled ? 1 : 0,
    updatedAt: initialEnabled ? Date.now() : null,
    activatedAt: initialEnabled ? Date.now() : null,
  };
  const requests = new Map<string, { enabled: boolean; revision: number }>();
  const history: ControlState[] = initialEnabled ? [state] : [];
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === SERVICE_CONTROL_STATUS_PATH) {
      return Response.json({ serviceStatus: state });
    }
    if (request.method === 'GET' && url.pathname === SERVICE_CONTROL_HISTORY_PATH) {
      return Response.json({
        history: history.map(({ enabled, revision, updatedAt }) => ({
          enabled,
          revision,
          updatedAt,
        })),
        truncated: false,
      });
    }
    if (request.method !== 'POST' || url.pathname !== SERVICE_CONTROL_STATE_PATH) {
      return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    const body = (await request.json()) as {
      enabled?: unknown;
      expectedRevision?: unknown;
      requestId?: unknown;
    };
    if (
      typeof body.enabled !== 'boolean' ||
      !Number.isSafeInteger(body.expectedRevision) ||
      typeof body.requestId !== 'string'
    ) {
      return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    const replay = requests.get(body.requestId);
    if (replay) {
      return replay.enabled === body.enabled && replay.revision === state.revision
        ? Response.json({ serviceStatus: state })
        : Response.json(
            { error: 'SERVICE_MAINTENANCE_REQUEST_SUPERSEDED', serviceStatus: state },
            { status: 409 },
          );
    }
    if (body.expectedRevision !== state.revision) {
      return Response.json(
        { error: 'SERVICE_MAINTENANCE_REVISION_CONFLICT', serviceStatus: state },
        { status: 409 },
      );
    }
    const now = Date.now();
    if (body.enabled !== state.enabled) {
      state = {
        enabled: body.enabled,
        revision: state.revision + 1,
        updatedAt: now,
        activatedAt: body.enabled ? now : null,
      };
      history.unshift(state);
    }
    requests.set(body.requestId, { enabled: body.enabled, revision: state.revision });
    return Response.json({ ok: true, serviceStatus: state });
  });
  return {
    binding: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn((id: string) => {
        const rateStub = rateControl.binding.get(id);
        return {
          fetch: (request: Request) => {
            const pathname = new URL(request.url).pathname;
            return pathname === ABUSE_RATE_CONSUME_PATH ||
              pathname === ABUSE_RATE_IDEMPOTENT_CONSUME_PATH
              ? rateStub.fetch(request)
              : fetch(request);
          },
        };
      }),
    },
    fetch,
    state: () => state,
  };
}

function adminMutationHeaders(extra: Record<string, string> = {}) {
  return {
    Origin: 'https://musixquare.com',
    'Content-Type': 'application/json',
    'X-MXQR-Admin-CSRF': '1',
    ...extra,
  };
}

async function login(env: Record<string, unknown>) {
  const response = await appWorker.fetch(
    new Request('https://musixquare.com/api/admin/login', {
      method: 'POST',
      headers: adminMutationHeaders({ 'CF-Connecting-IP': '203.0.113.199' }),
      body: JSON.stringify({ password: 'admin-password-strong' }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  return response.headers.get('Set-Cookie')?.split(';')[0] || '';
}

function deferControlRead(control: ReturnType<typeof createServiceControl>, pathname: string) {
  let resolveResponse: (response: Response) => void = () => undefined;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const originalFetch = control.fetch.getMockImplementation();
  if (!originalFetch) throw new Error('Missing control fixture implementation');
  const read = vi.fn(() => response.then((value) => value.clone()));
  control.fetch.mockImplementation((request: Request) =>
    new URL(request.url).pathname === pathname ? read() : originalFetch(request),
  );
  return { read, resolve: resolveResponse };
}

function maintenanceStatusResponse(enabled: boolean) {
  return new Response(null, {
    headers: {
      [SERVICE_CONTROL_STATUS_VERSION_HEADER]: '1',
      [SERVICE_CONTROL_STATUS_ENABLED_HEADER]: enabled ? '1' : '0',
      [SERVICE_CONTROL_STATUS_REVISION_HEADER]: '1',
      [SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER]: String(Date.now()),
      [SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER]: enabled ? String(Date.now()) : '',
    },
  });
}

afterEach(() => {
  clearServiceMaintenanceCacheForTests();
  vi.useRealTimers();
});

describe('app maintenance administration', () => {
  it.each(['public', 'admin'] as const)(
    'owns a delayed %s announcement read shared by a public request burst',
    async (leader) => {
      const control = createServiceControl();
      const env = {
        MXQR_ADMIN_PASSWORD: 'admin-password-strong',
        MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret-at-least-32',
        MUSIXQUARE_SERVICE_CONTROL: control.binding,
      };
      const cookie = await login(env);
      // Keep the background maintenance refresh separate from announcement ownership.
      const status = await appWorker.fetch(
        new Request('https://musixquare.com/api/admin/service-status', {
          headers: { Cookie: cookie },
        }),
        env,
      );
      expect(status.status).toBe(200);
      const delayed = deferControlRead(control, ADMIN_ANNOUNCEMENT_STATUS_PATH);
      const waits: Promise<unknown>[] = [];
      const context = {
        waitUntil: vi.fn(function (this: unknown, promise: Promise<unknown>) {
          expect(this).toBe(context);
          waits.push(promise);
        }),
      };
      const unauthorized = await appWorker.fetch(
        new Request('https://musixquare.com/api/admin/announcement'),
        env,
        context,
      );
      expect(unauthorized.status).toBe(401);
      expect(delayed.read).not.toHaveBeenCalled();
      expect(context.waitUntil).not.toHaveBeenCalled();

      const first = appWorker.fetch(
        new Request(
          leader === 'admin'
            ? 'https://musixquare.com/api/admin/announcement'
            : 'https://musixquare.com/api/announcement/current',
          { headers: leader === 'admin' ? { Cookie: cookie } : {} },
        ),
        env,
        context,
      );
      await vi.waitFor(() => expect(context.waitUntil).toHaveBeenCalledOnce());
      const followers = Array.from({ length: 7 }, () =>
        appWorker.fetch(
          new Request('https://musixquare.com/api/announcement/current'),
          env,
          context,
        ),
      );
      const announcement = {
        id: 'owned-announcement',
        message: 'Shared public notice',
        enabled: true,
        expiresAt: null,
        updatedAt: new Date().toISOString(),
      };
      delayed.resolve(
        Response.json({
          announcementState: {
            revision: 1,
            announcement,
            history: [{ ...announcement, action: 'published' }],
          },
        }),
      );
      const [firstResponse, ...publicResponses] = await Promise.all([first, ...followers]);
      expect(firstResponse.status).toBe(200);
      if (leader === 'admin') {
        await expect(firstResponse.json()).resolves.toMatchObject({ revision: 1, announcement });
      }
      for (const response of publicResponses) {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          enabled: true,
          id: announcement.id,
          message: announcement.message,
          expiresAt: null,
          revision: 1,
        });
      }
      await Promise.all(waits);
      expect(delayed.read).toHaveBeenCalledOnce();
      expect(context.waitUntil).toHaveBeenCalledOnce();
    },
  );

  it('owns the authenticated maintenance read shared with scheduled events', async () => {
    const control = createServiceControl(true);
    const env = {
      MXQR_ADMIN_PASSWORD: 'admin-password-strong',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret-at-least-32',
      MUSIXQUARE_SERVICE_CONTROL: control.binding,
    };
    const cookie = await login(env);
    const delayed = deferControlRead(control, SERVICE_CONTROL_STATUS_PATH);
    const waits: Promise<unknown>[] = [];
    const context = { waitUntil: vi.fn((promise: Promise<unknown>) => waits.push(promise)) };
    const endpoint = 'https://musixquare.com/api/admin/service-status';
    const unauthorized = await appWorker.fetch(new Request(endpoint), env, context);
    expect(unauthorized.status).toBe(401);
    expect(delayed.read).not.toHaveBeenCalled();
    expect(context.waitUntil).not.toHaveBeenCalled();

    const response = appWorker.fetch(
      new Request(endpoint, { headers: { Cookie: cookie } }),
      env,
      context,
    );
    await vi.waitFor(() => expect(context.waitUntil).toHaveBeenCalledOnce());
    const scheduled = Array.from({ length: 7 }, () =>
      appWorker.scheduled({ cron: '* * * * *' }, env, context),
    );
    delayed.resolve(maintenanceStatusResponse(true));
    const result = await response;
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      serviceStatus: { enabled: true, revision: 1 },
    });
    await Promise.all([...scheduled, ...waits]);
    expect(delayed.read).toHaveBeenCalledOnce();
    expect(context.waitUntil).toHaveBeenCalledOnce();
  });

  it('requires an admin session for read-only history, keeps it available during maintenance, and returns no-store records', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
    const control = createServiceControl(true);
    const env = {
      MXQR_ADMIN_PASSWORD: 'admin-password-strong',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret-at-least-32',
      MUSIXQUARE_SERVICE_CONTROL: control.binding,
    };
    const endpoint = 'https://musixquare.com/api/admin/service-status/history';
    const unauthorized = await appWorker.fetch(new Request(endpoint), env);
    expect(unauthorized.status).toBe(401);
    expect(control.fetch).not.toHaveBeenCalled();
    const cookie = await login(env);
    const response = await appWorker.fetch(
      new Request(endpoint, { headers: { Cookie: cookie } }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({
      generatedAt: '2026-09-08T12:00:00.000Z',
      history: [{ enabled: true, revision: 1, updatedAt: '2026-09-08T12:00:00.000Z' }],
      truncated: false,
    });
    expect(control.state().enabled).toBe(true);
    const head = await appWorker.fetch(
      new Request(endpoint, { method: 'HEAD', headers: { Cookie: cookie } }),
      env,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    control.fetch.mockClear();
    const mutation = await appWorker.fetch(
      new Request(endpoint, {
        method: 'POST',
        headers: adminMutationHeaders({ Cookie: cookie }),
        body: '{}',
      }),
      env,
    );
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get('Allow')).toBe('GET, HEAD');
    expect(control.fetch).not.toHaveBeenCalled();

    control.fetch.mockImplementationOnce(async () =>
      Response.json({ history: null }, { status: 200 }),
    );
    const unavailable = await appWorker.fetch(
      new Request(endpoint, { headers: { Cookie: cookie } }),
      env,
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Cache-Control')).toContain('no-store');
    expect(await unavailable.json()).toEqual({ error: 'SERVICE_CONTROL_HISTORY_UNAVAILABLE' });
  });

  it('never waits for a cold maintenance refresh before serving public traffic', async () => {
    vi.useFakeTimers();
    const statusFetch = vi.fn((_request: Request) => new Promise<Response>(() => {}));
    const waitUntilPromises: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });
    const env = {
      ASSETS: { fetch: vi.fn(() => Promise.resolve(new Response('icon'))) },
      MUSIXQUARE_SERVICE_CONTROL: {
        getByName: vi.fn(() => ({ fetch: statusFetch })),
      },
    };

    const response = await appWorker.fetch(new Request('https://musixquare.com/favicon.ico'), env, {
      waitUntil,
    });

    expect(response.status).toBe(200);
    expect(statusFetch).not.toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntilPromises).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(statusFetch).toHaveBeenCalledOnce();
    expect(statusFetch.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ method: 'HEAD' }));
    // The detached launch and the shareable control read each retain their
    // complete chain; later requests must reuse that owned in-flight read.
    expect(waitUntil).toHaveBeenCalledTimes(2);

    const second = await appWorker.fetch(new Request('https://musixquare.com/favicon.ico'), env, {
      waitUntil,
    });
    expect(second.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(2);
    expect(statusFetch).toHaveBeenCalledOnce();
  });

  it('applies a completed background maintenance refresh to the next public request', async () => {
    vi.useFakeTimers();
    const statusFetch = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          headers: {
            [SERVICE_CONTROL_STATUS_VERSION_HEADER]: '1',
            [SERVICE_CONTROL_STATUS_ENABLED_HEADER]: '1',
            [SERVICE_CONTROL_STATUS_REVISION_HEADER]: '7',
            [SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER]: '1800000000000',
            [SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER]: '1799999999000',
          },
        }),
      ),
    );
    const waitUntilPromises: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });
    const assetFetch = vi.fn(() => Promise.resolve(new Response('icon')));
    const env = {
      ASSETS: { fetch: assetFetch },
      MUSIXQUARE_SERVICE_CONTROL: {
        getByName: vi.fn(() => ({ fetch: statusFetch })),
      },
    };

    const first = await appWorker.fetch(new Request('https://musixquare.com/favicon.ico'), env, {
      waitUntil,
    });
    expect(first.status).toBe(200);
    expect(assetFetch).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(0);
    await expect(waitUntilPromises[0]).resolves.toBeUndefined();

    const second = await appWorker.fetch(new Request('https://musixquare.com/favicon.ico'), env, {
      waitUntil,
    });
    expect(second.status).toBe(503);
    expect(second.headers.get('Cache-Control')).toContain('no-store');
    expect(assetFetch).toHaveBeenCalledOnce();
  });

  it('keeps admin control available while pausing public documents and APIs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    const control = createServiceControl();
    const assetFetch = vi.fn(async () => new Response('clearable runtime'));
    const env = {
      ASSETS: { fetch: assetFetch },
      MXQR_ADMIN_PASSWORD: 'admin-password-strong',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret-at-least-32',
      MUSIXQUARE_SERVICE_CONTROL: control.binding,
    };

    const unauthorized = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/service-status'),
      env,
    );
    expect(unauthorized.status).toBe(401);

    const unauthorizedPreview = await appWorker.fetch(
      new Request('https://musixquare.com/admin/maintenance-preview', {
        headers: { Accept: 'text/html' },
      }),
      env,
    );
    expect(unauthorizedPreview.status).toBe(401);

    const cookie = await login(env);
    const preview = await appWorker.fetch(
      new Request('https://musixquare.com/admin/maintenance-preview', {
        headers: {
          Accept: 'text/html',
          'Accept-Language': 'ko-KR, en;q=0.8',
          Cookie: cookie,
        },
      }),
      env,
    );
    const previewBody = await preview.text();
    expect(preview.status).toBe(200);
    expect(preview.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(preview.headers.get('X-MXQR-Maintenance-Preview')).toBe('1');
    expect(preview.headers.get('Retry-After')).toBeNull();
    expect(previewBody).toContain(
      '<span class="sr-only">MUSIXQUARE is temporarily unavailable.</span>',
    );
    expect(previewBody).toContain('<span class="headline" aria-hidden="true">');
    expect(previewBody).toContain('<span class="headline-lead"><svg class="wordmark"');
    expect(previewBody.match(/class="wordmark"/gu)).toHaveLength(1);
    expect(previewBody).not.toContain('role="img" aria-label="MUSIXQUARE"');
    expect(control.state().enabled).toBe(false);
    expect(control.fetch).not.toHaveBeenCalled();

    const previewMutation = await appWorker.fetch(
      new Request('https://musixquare.com/admin/maintenance-preview', {
        method: 'POST',
        headers: adminMutationHeaders({ Cookie: cookie }),
        body: '{}',
      }),
      env,
    );
    expect(previewMutation.status).toBe(405);
    expect(previewMutation.headers.get('Allow')).toBe('GET, HEAD');
    expect(control.state().enabled).toBe(false);
    expect(control.fetch).not.toHaveBeenCalled();

    const status = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/service-status', {
        headers: { Cookie: cookie },
      }),
      env,
    );
    await expect(status.json()).resolves.toMatchObject({
      serviceStatus: { enabled: false, revision: 0 },
    });

    const csrfRejected = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/service-status', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          expectedRevision: 0,
          requestId: '123e4567-e89b-42d3-a456-426614174000',
        }),
      }),
      env,
    );
    expect(csrfRejected.status).toBe(403);

    const enabled = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/service-status', {
        method: 'POST',
        headers: adminMutationHeaders({ Cookie: cookie }),
        body: JSON.stringify({
          enabled: true,
          expectedRevision: 0,
          requestId: '123e4567-e89b-42d3-a456-426614174000',
        }),
      }),
      env,
    );
    const enabledPayload = (await enabled.json()) as {
      serviceStatus?: Record<string, unknown>;
    };
    expect(enabled.status).toBe(200);
    expect(enabledPayload.serviceStatus).toMatchObject({
      enabled: true,
      revision: 1,
      updatedAt: '2026-08-02T12:00:00.000Z',
      activatedAt: '2026-08-02T12:00:00.000Z',
      settlesAt: '2026-08-02T12:00:02.000Z',
    });

    const page = await appWorker.fetch(
      new Request('https://musixquare.com/000002', {
        headers: { Accept: 'text/html', 'Accept-Language': 'ko-KR, en;q=0.8' },
      }),
      env,
    );
    const pageBody = await page.text();
    expect(page.status).toBe(503);
    expect(page.headers.get('Cache-Control')).toContain('no-store');
    expect(page.headers.get('Content-Language')).toBe('ko');
    expect(pageBody).toContain('MUSIXQUARE is temporarily unavailable.');
    expect(pageBody).toContain('안전한 서비스를 위해 점검을 진행 중이에요.');
    expect(pageBody).toBe(previewBody);

    const activePreviewHead = await appWorker.fetch(
      new Request('https://musixquare.com/admin/maintenance-preview', {
        method: 'HEAD',
        headers: { 'Accept-Language': 'ko-KR', Cookie: cookie },
      }),
      env,
    );
    expect(activePreviewHead.status).toBe(200);
    expect(activePreviewHead.headers.get('X-MXQR-Maintenance-Preview')).toBe('1');
    expect(await activePreviewHead.text()).toBe('');

    const api = await appWorker.fetch(
      new Request('https://musixquare.com/api/security-config'),
      env,
    );
    expect(api.status).toBe(503);
    await expect(api.json()).resolves.toMatchObject({
      error: 'SERVICE_MAINTENANCE',
      maintenance: true,
    });

    const admin = await appWorker.fetch(new Request('https://musixquare.com/admin'), env);
    const adminBody = await admin.text();
    expect(admin.status).toBe(200);
    expect(adminBody).toContain('data-service-status-trigger');
    expect(adminBody).toContain('data-admin-view="maintenance"');
    expect(adminBody).toContain('data-service-history-list');
    expect(adminBody).not.toContain('data-service-status-dialog');
    expect(adminBody).toContain('data-service-status-preview');
    expect(adminBody).not.toContain('Global service status');
    expect(adminBody).toContain('data-admin-tab="operations">Analytics');
    // The status page note is edited in the Maintenance view, the one view that
    // keeps working during maintenance, between the overview and the history.
    const maintenanceView =
      /<section class="admin-view" data-admin-view="maintenance" hidden>[\s\S]*?(?=<section class="admin-view[^"]*" data-admin-view="operations")/u.exec(
        adminBody,
      )?.[0] ?? '';
    expect(maintenanceView).toContain('data-status-note-panel');
    expect(adminBody.match(/data-status-note-panel/gu)).toHaveLength(1);
    expect(maintenanceView.indexOf('class="maintenance-overview"')).toBeLessThan(
      maintenanceView.indexOf('data-status-note-panel'),
    );
    expect(maintenanceView.indexOf('data-status-note-panel')).toBeLessThan(
      maintenanceView.indexOf('service-history-panel'),
    );
    for (const hook of [
      'data-status-note-form',
      'data-status-note-message',
      'data-status-note-expires',
      'data-status-note-publish',
      'data-status-note-clear',
      'data-status-note-status',
      'data-status-note-error',
      'data-status-note-preview',
      'data-status-note-history-status',
      'data-status-note-history-list',
    ]) {
      expect(maintenanceView, hook).toContain(hook);
    }
    expect(maintenanceView).toContain(`maxlength="${STATUS_NOTE_MESSAGE_MAX_LENGTH}"`);
    expect(maintenanceView).toContain('Write it in English.');
    expect(maintenanceView).toContain(
      'The status page keeps recording maintenance while maintenance mode is on.',
    );

    const clearableAsset = await appWorker.fetch(
      new Request('https://musixquare.com/clearable-editors.js?v=8.3.72'),
      env,
    );
    expect(clearableAsset.status).toBe(200);
    expect(await clearableAsset.text()).toBe('clearable runtime');
    expect(clearableAsset.headers.get('Cache-Control')).toBe(
      'no-store, max-age=0, must-revalidate',
    );
    expect(assetFetch).toHaveBeenCalledOnce();

    const disabled = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/service-status', {
        method: 'POST',
        headers: adminMutationHeaders({ Cookie: cookie }),
        body: JSON.stringify({
          enabled: false,
          expectedRevision: 1,
          requestId: '123e4567-e89b-42d3-a456-426614174001',
        }),
      }),
      env,
    );
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      serviceStatus: { enabled: false, revision: 2 },
    });
  });

  it('does not enqueue scheduled data work while maintenance is active', async () => {
    const control = createServiceControl(true);
    const delayed = deferControlRead(control, SERVICE_CONTROL_STATUS_PATH);
    const waits: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => waits.push(promise));
    const prepare = vi.fn();
    const env = {
      MUSIXQUARE_SERVICE_CONTROL: control.binding,
      MUSIXQUARE_AUTH_DB: { prepare },
      MUSIXQUARE_ADMIN_DB: { prepare },
    };
    const events = Array.from({ length: 8 }, () =>
      appWorker.scheduled({ cron: '0 */6 * * *' }, env, { waitUntil }),
    );
    await vi.waitFor(() => expect(delayed.read).toHaveBeenCalledOnce());
    expect(waitUntil).toHaveBeenCalledOnce();
    delayed.resolve(maintenanceStatusResponse(true));
    await Promise.all([...events, ...waits]);
    expect(delayed.read).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps the status page, its API, the monitor report and the note editor up during maintenance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T05:31:00.000Z'));
    const control = createServiceControl(true);
    // The status note is its own named object of the real service-control class.
    const noteControl = createAtomicRateControlBinding();
    const assetFetch = vi.fn(
      async (request: Request) => new Response(`asset ${new URL(request.url).pathname}`),
    );
    const env = {
      ASSETS: { fetch: assetFetch },
      MXQR_ADMIN_PASSWORD: 'admin-password-strong',
      MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret-at-least-32',
      MUSIXQUARE_SERVICE_CONTROL: {
        idFromName: (name: string) => name,
        get: (id: string) =>
          id === STATUS_NOTE_CONTROL_OBJECT_NAME
            ? noteControl.binding.get(id)
            : control.binding.get(id),
      },
    };
    const cookie = await login(env);
    const serviceStatus = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/service-status', {
        headers: { Cookie: cookie },
      }),
      env,
    );
    await expect(serviceStatus.json()).resolves.toMatchObject({
      serviceStatus: { enabled: true },
    });
    const sitemap = await appWorker.fetch(
      new Request('https://musixquare.com/sitemap', { headers: { Accept: 'text/html' } }),
      env,
    );
    expect(sitemap.status).toBe(503);
    const security = await appWorker.fetch(
      new Request('https://musixquare.com/api/security-config'),
      env,
    );
    expect(security.status).toBe(503);

    for (const [path, asset] of [
      ['/status', '/status.html'],
      ['/status-page.js', '/status-page.js'],
      ['/legal-pages.css', '/legal-pages.css'],
      ['/analytics-bootstrap.js', '/analytics-bootstrap.js'],
      ['/og-status.png', '/og-status.png'],
    ] as const) {
      const response = await appWorker.fetch(new Request(`https://musixquare.com${path}`), env);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(`asset ${asset}`);
    }
    for (const path of ['/status/', '/status.html']) {
      const response = await appWorker.fetch(new Request(`https://musixquare.com${path}`), env);
      expect(response.status, path).toBe(301);
      expect(response.headers.get('Location'), path).toBe('https://musixquare.com/status');
    }

    // The status API reads maintenance itself, since the bypass skips the
    // gate's refresh, and shows it; without the ledger it still answers 200.
    const api = await appWorker.fetch(
      new Request(`https://musixquare.com${STATUS_PUBLIC_PATH}`),
      env,
    );
    expect(api.status).toBe(200);
    expect(api.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    await expect(api.json()).resolves.toMatchObject({
      schemaVersion: 1,
      overall: { state: 'maintenance', reason: 'maintenance', since: '2026-11-26T05:31:00.000Z' },
      maintenance: { active: true, since: '2026-11-26T05:31:00.000Z' },
      announcement: null,
    });

    // The report route reaches its own checks (here the missing token), while
    // the claim route stays behind the gate: no check opens a room now.
    const reportHeaders = {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.71',
    };
    const report = await appWorker.fetch(
      new Request(`https://musixquare.com${STATUS_REPORT_PATH}`, {
        method: 'POST',
        headers: reportHeaders,
        body: '{}',
      }),
      env,
    );
    expect(report.status).toBe(401);
    await expect(report.json()).resolves.toEqual({ error: 'OIDC_TOKEN_INVALID' });
    const claim = await appWorker.fetch(
      new Request(`https://musixquare.com${STATUS_CLAIM_PATH}`, {
        method: 'POST',
        headers: reportHeaders,
        body: '{}',
      }),
      env,
    );
    expect(claim.status).toBe(503);
    await expect(claim.json()).resolves.toMatchObject({ error: 'SERVICE_MAINTENANCE' });

    const unauthorizedNote = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/status-note'),
      env,
    );
    expect(unauthorizedNote.status).toBe(401);
    const message = 'Checks show maintenance until the work ends.';
    const published = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/status-note', {
        method: 'POST',
        headers: adminMutationHeaders({ Cookie: cookie }),
        body: JSON.stringify({
          message,
          expiresAt: null,
          expectedRevision: 0,
          requestId: '123e4567-e89b-42d3-a456-426614174090',
        }),
      }),
      env,
    );
    expect(published.status).toBe(200);
    await expect(published.json()).resolves.toMatchObject({
      ok: true,
      revision: 1,
      active: true,
      note: { message, enabled: true, expiresAt: null },
    });
    const withNote = await appWorker.fetch(
      new Request(`https://musixquare.com${STATUS_PUBLIC_PATH}`),
      env,
    );
    await expect(withNote.json()).resolves.toMatchObject({
      overall: { state: 'maintenance' },
      announcement: { message, postedAt: '2026-11-26T05:31:00.000Z', expiresAt: null },
    });
    expect(control.state().enabled).toBe(true);
  });
});
