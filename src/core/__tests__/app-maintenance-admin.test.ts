import { afterEach, describe, expect, it, vi } from 'vitest';

import appWorker from '../../../cloudflare/app-worker.ts';
import {
  ABUSE_RATE_CONSUME_PATH,
  ABUSE_RATE_IDEMPOTENT_CONSUME_PATH,
  SERVICE_CONTROL_STATE_PATH,
  SERVICE_CONTROL_STATUS_PATH,
  clearServiceMaintenanceCacheForTests,
} from '../../../cloudflare/service-maintenance.ts';
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
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === SERVICE_CONTROL_STATUS_PATH) {
      return Response.json({ serviceStatus: state });
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

afterEach(() => {
  clearServiceMaintenanceCacheForTests();
  vi.useRealTimers();
});

describe('app maintenance administration', () => {
  it('keeps admin control available while pausing public documents and APIs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    const control = createServiceControl();
    const env = {
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
    expect(pageBody).toContain('안전한 서비스 점검을 진행 중이에요.');
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
    expect(adminBody).toContain('data-service-status-dialog');
    expect(adminBody).toContain('data-service-status-preview');
    expect(adminBody).toContain('data-admin-tab="operations">Analytics');

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
    const waitUntil = vi.fn();
    await appWorker.scheduled(
      { cron: '* * * * *' },
      { MUSIXQUARE_SERVICE_CONTROL: control.binding },
      { waitUntil },
    );
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
