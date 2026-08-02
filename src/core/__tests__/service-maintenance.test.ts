import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SERVICE_CONTROL_STATE_PATH,
  SERVICE_CONTROL_STATUS_PATH,
  clearServiceMaintenanceCacheForTests,
  gateServiceMaintenance,
  inactiveServiceMaintenanceState,
  normalizeServiceMaintenanceState,
  readServiceMaintenance,
  serviceMaintenanceResponse,
  updateServiceMaintenance,
  type ServiceMaintenanceState,
} from '../../../cloudflare/service-maintenance.js';

function activeState(overrides: Partial<ServiceMaintenanceState> = {}): ServiceMaintenanceState {
  return {
    enabled: true,
    revision: 4,
    updatedAt: 1_800_000_000_000,
    activatedAt: 1_799_999_999_000,
    settlesAt: 1_800_000_002_000,
    ...overrides,
  };
}

function serviceControlEnv(
  handler: (request: Request) => Response | Promise<Response>,
  options: { legacyNamespace?: boolean } = {},
): { env: Record<string, unknown>; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(handler);
  const stub = { fetch };
  const namespace = options.legacyNamespace
    ? {
        idFromName: vi.fn((name: string) => `id:${name}`),
        get: vi.fn(() => stub),
      }
    : { getByName: vi.fn(() => stub) };
  return { env: { MUSIXQUARE_SERVICE_CONTROL: namespace }, fetch };
}

afterEach(() => {
  clearServiceMaintenanceCacheForTests();
  vi.restoreAllMocks();
});

describe('shared service-maintenance control', () => {
  it('keeps an intentionally unbound local environment operational but observable', async () => {
    expect(inactiveServiceMaintenanceState()).toEqual({
      enabled: false,
      revision: 0,
      updatedAt: null,
      activatedAt: null,
      settlesAt: null,
      controlUnavailable: true,
    });
    await expect(readServiceMaintenance({})).resolves.toEqual(inactiveServiceMaintenanceState());
    await expect(
      gateServiceMaintenance(new Request('https://musixquare.com/api/security-config'), {}),
    ).resolves.toBeNull();
  });

  it('normalizes only complete canonical control states', () => {
    expect(
      normalizeServiceMaintenanceState({
        enabled: true,
        revision: 8,
        updatedAt: 1_800_000_000_000,
        activatedAt: 1_799_999_999_000,
      }),
    ).toEqual({
      enabled: true,
      revision: 8,
      updatedAt: 1_800_000_000_000,
      activatedAt: 1_799_999_999_000,
      settlesAt: 1_800_000_002_000,
    });
    expect(normalizeServiceMaintenanceState({ enabled: true, revision: 1 })).toBeNull();
    expect(normalizeServiceMaintenanceState({ enabled: false, revision: -1 })).toBeNull();
    expect(normalizeServiceMaintenanceState(null)).toBeNull();
  });

  it('deduplicates and caches ordinary reads while fresh reads bypass the cache', async () => {
    const first = activeState();
    const second = activeState({ revision: 5, updatedAt: 1_800_000_001_000 });
    const control = serviceControlEnv((request) => {
      expect(new URL(request.url).pathname).toBe(SERVICE_CONTROL_STATUS_PATH);
      return Response.json({
        serviceStatus: control.fetch.mock.calls.length === 1 ? first : second,
      });
    });

    const [left, right] = await Promise.all([
      readServiceMaintenance(control.env),
      readServiceMaintenance(control.env),
    ]);
    expect(left.revision).toBe(4);
    expect(right.revision).toBe(4);
    expect(control.fetch).toHaveBeenCalledTimes(1);

    expect((await readServiceMaintenance(control.env)).revision).toBe(4);
    expect(control.fetch).toHaveBeenCalledTimes(1);
    expect((await readServiceMaintenance(control.env, { fresh: true })).revision).toBe(5);
    expect(control.fetch).toHaveBeenCalledTimes(2);
  });

  it('supports the idFromName namespace shape and fails closed on bound RPC failure', async () => {
    const healthy = serviceControlEnv(() => Response.json({ serviceStatus: activeState() }), {
      legacyNamespace: true,
    });
    await expect(readServiceMaintenance(healthy.env)).resolves.toMatchObject({
      enabled: true,
      revision: 4,
    });

    const failing = serviceControlEnv(() => Promise.reject(new Error('control unavailable')));
    await expect(readServiceMaintenance(failing.env)).resolves.toEqual({
      enabled: true,
      revision: 0,
      updatedAt: null,
      activatedAt: null,
      settlesAt: null,
      controlUnavailable: true,
    });
  });

  it('forwards a bounded desired-state update and records successful and conflicting read-back', async () => {
    const current = activeState({ revision: 9 });
    const control = serviceControlEnv(async (request) => {
      expect(new URL(request.url).pathname).toBe(SERVICE_CONTROL_STATE_PATH);
      expect(request.method).toBe('POST');
      expect(request.headers.get('Content-Type')).toBe('application/json');
      expect(await request.json()).toEqual({
        enabled: true,
        expectedRevision: 8,
        requestId: 'maintenance-request-1',
      });
      return Response.json({ serviceStatus: current });
    });

    await expect(
      updateServiceMaintenance(control.env, {
        enabled: true,
        expectedRevision: 8,
        requestId: 'maintenance-request-1',
      }),
    ).resolves.toEqual({ status: 'ok', state: current });
    expect((await readServiceMaintenance(control.env)).revision).toBe(9);
    expect(control.fetch).toHaveBeenCalledTimes(1);

    clearServiceMaintenanceCacheForTests();
    const conflict = serviceControlEnv(() =>
      Response.json({ serviceStatus: current }, { status: 409 }),
    );
    await expect(
      updateServiceMaintenance(conflict.env, {
        enabled: false,
        expectedRevision: 8,
        requestId: 'maintenance-request-2',
      }),
    ).resolves.toEqual({ status: 'conflict', state: current });
  });

  it('returns the exact no-store JSON maintenance contract for APIs', async () => {
    const request = new Request('https://musixquare.com/api/security-config', {
      headers: { Accept: 'application/json', 'Accept-Language': 'en-US' },
    });
    const response = serviceMaintenanceResponse(request, activeState(), { format: 'json' });

    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(response.headers.get('Content-Language')).toBe('en');
    expect(response.headers.get('Vary')).toBe('Accept-Language');
    await expect(response.json()).resolves.toEqual({
      error: 'SERVICE_MAINTENANCE',
      maintenance: true,
      revision: 4,
      activatedAt: 1_799_999_999_000,
      settlesAt: 1_800_000_002_000,
    });
  });

  it('renders one fixed English line plus the weighted supported system language', async () => {
    const request = new Request('https://musixquare.com/000002', {
      headers: {
        Accept: 'text/html',
        'Accept-Language': 'fr-FR;q=0.4, ko-KR;q=0.9, en;q=0.7',
      },
    });
    const response = serviceMaintenanceResponse(request, activeState());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Content-Language')).toBe('ko');
    expect(body).toContain('<html lang="ko">');
    expect(body).toContain('Musixquare is temporarily unavailable.');
    expect(body).toContain('안전한 서비스 점검을 진행 중이에요. 잠시 후 다시 시도해 주세요.');
  });

  it('falls back to English for English, unsupported, wildcard, and missing language headers', () => {
    for (const language of ['en-GB', 'ar-SA', '*', '']) {
      const headers = new Headers({ Accept: 'text/html' });
      if (language) headers.set('Accept-Language', language);
      const response = serviceMaintenanceResponse(
        new Request('https://musixquare.com/', { headers }),
        activeState(),
      );
      expect(response.headers.get('Content-Language'), language || 'missing').toBe('en');
    }
  });

  it('returns headers without a response body for maintenance HEAD requests', async () => {
    const response = serviceMaintenanceResponse(
      new Request('https://musixquare.com/', {
        method: 'HEAD',
        headers: { Accept: 'text/html', 'Accept-Language': 'ja-JP' },
      }),
      activeState(),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Language')).toBe('ja');
    expect(await response.text()).toBe('');
  });
});
