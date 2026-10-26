import { afterEach, describe, expect, it, vi } from 'vitest';

import appWorker from '../../../cloudflare/app-worker.ts';
import {
  APP_BUILD_FLOOR_CLIENT_PATH,
  APP_BUILD_FLOOR_EDGE_CACHE_TTL_S,
  APP_BUILD_FLOOR_PUBLIC_STATUS_PATH,
  APP_BUILD_FLOOR_REPORT_STALE_MS,
} from '../../../cloudflare/app-build-floor-contract.ts';
import {
  APP_BUILD_FLOOR_LIVE_REPORT_PATH,
  APP_BUILD_FLOOR_STATE_PATH,
  APP_BUILD_FLOOR_STATUS_HEADERS,
  APP_BUILD_FLOOR_STATUS_PATH,
  SERVICE_CONTROL_OBJECT_NAME,
  SERVICE_CONTROL_STATE_PATH,
  clearServiceMaintenanceCacheForTests,
} from '../../../cloudflare/service-maintenance.ts';
import { createAtomicRateControlBinding } from './service-control-rate-limit-fixture.ts';

const ORIGIN = 'https://musixquare.com';
const ADMIN_PATH = '/api/admin/app-build-floor';
const FLOOR_STATUS_READ = `HEAD ${APP_BUILD_FLOOR_STATUS_PATH}`;
const LIVE_REPORT_WRITE = `POST ${APP_BUILD_FLOOR_LIVE_REPORT_PATH}`;
const FLOOR_STATE_WRITE = `POST ${APP_BUILD_FLOOR_STATE_PATH}`;
const T0 = Date.parse('2026-10-26T03:00:00.000Z');

type ServiceControlStub = { fetch(request: Request): Promise<Response> };

function serviceWorkerSource(...cacheVersions: string[]): string {
  return [
    '"use strict";',
    ...cacheVersions.map((version) => `const CACHE_VERSION = ${version};`),
    'const STATIC_CACHE = `musixquare-static-${CACHE_VERSION}`;',
  ].join('\n');
}

function createAssets(source: string | (() => Response)) {
  const fetch = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname !== '/service-worker.js') {
      return new Response('Not found', { status: 404 });
    }
    return typeof source === 'function'
      ? source()
      : new Response(source, { headers: { 'Content-Type': 'text/javascript' } });
  });
  const serviceWorkerReads = () =>
    fetch.mock.calls.filter(([request]) => new URL(request.url).pathname === '/service-worker.js')
      .length;
  return { fetch, serviceWorkerReads };
}

/** The real service-control object behind a binding that records every call. */
function createControl() {
  const control = createAtomicRateControlBinding();
  const calls: string[] = [];
  const harness = {
    calls,
    floorRoutes: 'live' as 'live' | 'down' | 'missing',
    binding: {
      idFromName: (name: string) => control.binding.idFromName(name),
      get: (id: string): ServiceControlStub => {
        const stub = control.binding.get(id);
        return {
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            calls.push(`${request.method} ${path}`);
            if (path.startsWith('/internal/app-build-floor/')) {
              if (harness.floorRoutes === 'down') return new Response(null, { status: 503 });
              // A service-control object older than the floor routes.
              if (harness.floorRoutes === 'missing') {
                return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
              }
            }
            return stub.fetch(request);
          },
        };
      },
    },
    object: (): ServiceControlStub =>
      control.binding.get(control.binding.idFromName(SERVICE_CONTROL_OBJECT_NAME)),
    count: (call: string) => calls.filter((entry) => entry === call).length,
  };
  return harness;
}

type Control = ReturnType<typeof createControl>;

async function writeFloor(
  control: Control,
  body: { minAppBuild: number; expectedRevision: number; liveAppBuild?: number; reason?: string },
) {
  const response = await control.object().fetch(
    new Request(`https://service-control.internal${APP_BUILD_FLOOR_STATE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: `floor-test-${body.minAppBuild}-${body.expectedRevision}`,
        reason: body.reason ?? 'App Worker floor test',
        ...body,
      }),
    }),
  );
  expect(response.status).toBe(200);
}

async function reportLive(control: Control, appBuild: number) {
  const response = await control.object().fetch(
    new Request(`https://service-control.internal${APP_BUILD_FLOOR_LIVE_REPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appBuild }),
    }),
  );
  expect(response.status).toBe(200);
}

async function objectFloor(control: Control) {
  const response = await control.object().fetch(
    new Request(`https://service-control.internal${APP_BUILD_FLOOR_STATUS_PATH}`, {
      method: 'HEAD',
    }),
  );
  const header = (name: keyof typeof APP_BUILD_FLOOR_STATUS_HEADERS) =>
    response.headers.get(APP_BUILD_FLOOR_STATUS_HEADERS[name]);
  return {
    minAppBuild: Number(header('minAppBuild')),
    effectiveMinAppBuild: Number(header('effectiveMinAppBuild')),
    revision: Number(header('revision')),
    liveAppBuild: header('liveAppBuild'),
    liveReportedAt: header('liveReportedAt'),
  };
}

async function enableMaintenance(control: Control) {
  const response = await control.object().fetch(
    new Request(`https://service-control.internal${SERVICE_CONTROL_STATE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        expectedRevision: 0,
        requestId: 'floor-test-maintenance',
      }),
    }),
  );
  expect(response.status).toBe(200);
}

function createContext() {
  const waits: Promise<unknown>[] = [];
  const context = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      waits.push(Promise.resolve(promise).catch(() => undefined));
    }),
  };
  const settle = async () => {
    // Settled work can schedule more; drain until nothing new arrives.
    for (let drained = 0; drained < waits.length;) {
      const batch = waits.slice(drained);
      drained = waits.length;
      await Promise.all(batch);
    }
  };
  return { context, settle };
}

/** A Cache API stand-in that honours the stored entry's max-age. */
function installEdgeCache() {
  const entries = new Map<
    string,
    { body: string; headers: Headers; storedAt: number; maxAgeMs: number }
  >();
  const keyOf = (request: Request | string) =>
    typeof request === 'string' ? request : request.url;
  const cache = {
    match: vi.fn(async (request: Request | string) => {
      const entry = entries.get(keyOf(request));
      if (!entry) return undefined;
      if (Date.now() - entry.storedAt >= entry.maxAgeMs) {
        entries.delete(keyOf(request));
        return undefined;
      }
      return new Response(entry.body, { headers: entry.headers });
    }),
    put: vi.fn(async (request: Request | string, response: Response) => {
      const maxAge = /(?:^|,)\s*max-age=(\d+)/u.exec(response.headers.get('Cache-Control') || '');
      entries.set(keyOf(request), {
        body: await response.text(),
        headers: new Headers(response.headers),
        storedAt: Date.now(),
        maxAgeMs: maxAge ? Number(maxAge[1]) * 1_000 : 0,
      });
    }),
  };
  vi.stubGlobal('caches', { default: cache });
  const floorKey = `${ORIGIN}/.well-known/mxqr-cache/app-build-floor/v1`;
  return { cache, entries, floorKey };
}

function useDateClock(at = T0) {
  // Only Date moves; the service-control read deadline keeps real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

async function clientRead(env: Record<string, unknown>, init: RequestInit = {}) {
  const { context, settle } = createContext();
  const response = await appWorker.fetch(
    new Request(`${ORIGIN}${APP_BUILD_FLOOR_CLIENT_PATH}`, init),
    env,
    context,
  );
  await settle();
  return response;
}

async function publicStatus(env: Record<string, unknown>, init: RequestInit = {}) {
  const { context, settle } = createContext();
  const response = await appWorker.fetch(
    new Request(`${ORIGIN}${APP_BUILD_FLOOR_PUBLIC_STATUS_PATH}`, init),
    env,
    context,
  );
  await settle();
  return response;
}

function adminHeaders(cookie: string, extra: Record<string, string> = {}) {
  return {
    Cookie: cookie,
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'X-MXQR-Admin-CSRF': '1',
    ...extra,
  };
}

async function login(env: Record<string, unknown>) {
  const response = await appWorker.fetch(
    new Request(`${ORIGIN}/api/admin/login`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'X-MXQR-Admin-CSRF': '1',
        'CF-Connecting-IP': '203.0.113.42',
      },
      body: JSON.stringify({ password: 'admin-password-strong' }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  return response.headers.get('Set-Cookie')?.split(';')[0] || '';
}

function floorEnv(control: Control, assets: ReturnType<typeof createAssets> | null) {
  return {
    MXQR_ADMIN_PASSWORD: 'admin-password-strong',
    MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret-at-least-32',
    MUSIXQUARE_SERVICE_CONTROL: control.binding,
    ...(assets ? { ASSETS: assets } : {}),
  };
}

afterEach(() => {
  clearServiceMaintenanceCacheForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App Worker live App build', () => {
  it('reads its own build once per assets binding from the deployed service worker', async () => {
    const control = createControl();
    const assets = createAssets(serviceWorkerSource("'v785'"));
    const env = floorEnv(control, assets);

    for (let request = 0; request < 3; request += 1) {
      const response = await publicStatus(env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ liveAppBuild: 785 });
    }
    expect(assets.serviceWorkerReads()).toBe(1);
    const assetRequest = assets.fetch.mock.calls[0]?.[0];
    expect(assetRequest?.method).toBe('GET');
    expect(assetRequest?.headers.get('If-None-Match')).toBeNull();

    // Another assets binding is another Worker version: it is read on its own.
    const nextAssets = createAssets(serviceWorkerSource('"v786"'));
    const next = await publicStatus(floorEnv(control, nextAssets));
    expect(await next.json()).toMatchObject({ liveAppBuild: 786 });
    expect(nextAssets.serviceWorkerReads()).toBe(1);
  });

  it.each([
    ['a missing service worker', () => new Response('Not found', { status: 404 })],
    ['a server error', () => new Response(serviceWorkerSource("'v785'"), { status: 500 })],
    ['no cache epoch', () => new Response('self.addEventListener("fetch", () => {});')],
    ['two cache epochs', () => new Response(serviceWorkerSource("'v785'", "'v786'"))],
    ['a leading zero', () => new Response(serviceWorkerSource("'v0785'"))],
    ['no v prefix', () => new Response(serviceWorkerSource("'785'"))],
    ['a build zero', () => new Response(serviceWorkerSource("'v0'"))],
    ['a build above the wire range', () => new Response(serviceWorkerSource("'v2147483648'"))],
    ['a template literal', () => new Response(serviceWorkerSource('`v785`'))],
    [
      'the build sentinel',
      () => new Response(serviceWorkerSource("'__MUSIXQUARE_CACHE_VERSION__'")),
    ],
  ])('treats %s as no live build and reads it again later', async (_label, unreadable) => {
    const control = createControl();
    let served = unreadable;
    const assets = createAssets(() => served());
    const env = floorEnv(control, assets);

    const first = await publicStatus(env);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ liveAppBuild: null });

    served = () => new Response(serviceWorkerSource("'v785'"));
    const second = await publicStatus(env);
    expect(await second.json()).toMatchObject({ liveAppBuild: 785 });
    expect(assets.serviceWorkerReads()).toBe(2);
  });
});

describe('App Worker minute cron live report', () => {
  it('reports the live build on the minute trigger before the maintenance return', async () => {
    useDateClock();
    const control = createControl();
    await enableMaintenance(control);
    const prepare = vi.fn();
    const env = {
      ...floorEnv(control, createAssets(serviceWorkerSource("'v785'"))),
      MUSIXQUARE_AUTH_DB: { prepare },
      MUSIXQUARE_ADMIN_DB: { prepare },
    };
    const { context, settle } = createContext();

    await appWorker.scheduled({ cron: '* * * * *' }, env, context);
    await settle();

    expect(control.count(LIVE_REPORT_WRITE)).toBe(1);
    expect(control.count(FLOOR_STATE_WRITE)).toBe(0);
    expect(await objectFloor(control)).toMatchObject({
      minAppBuild: 0,
      revision: 0,
      liveAppBuild: '785',
      liveReportedAt: String(T0),
    });
    // Maintenance still stops every scheduled data job.
    expect(prepare).not.toHaveBeenCalled();
  });

  it('bounds an older stored floor by the build it reports and never writes the floor', async () => {
    useDateClock();
    const control = createControl();
    await writeFloor(control, { minAppBuild: 785, expectedRevision: 0, liveAppBuild: 785 });
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v784'")));
    const { context, settle } = createContext();

    advance(60_000);
    await appWorker.scheduled({ cron: '* * * * *' }, env, context);
    await settle();

    expect(control.count(FLOOR_STATE_WRITE)).toBe(0);
    expect(await objectFloor(control)).toMatchObject({
      minAppBuild: 785,
      revision: 1,
      effectiveMinAppBuild: 784,
      liveAppBuild: '784',
      liveReportedAt: String(T0 + 60_000),
    });
  });

  it('reports nothing when its build is unreadable, on the six-hour trigger or without assets', async () => {
    const control = createControl();
    // Maintenance keeps the six-hour data jobs (feeds, cleanup) from running.
    await enableMaintenance(control);
    const unreadable = floorEnv(
      control,
      createAssets(() => new Response('', { status: 404 })),
    );
    const readable = floorEnv(control, createAssets(serviceWorkerSource("'v785'")));
    const withoutAssets = floorEnv(control, null);
    const { context, settle } = createContext();

    await appWorker.scheduled({ cron: '* * * * *' }, unreadable, context);
    await appWorker.scheduled({ cron: '0 */6 * * *' }, readable, context);
    await appWorker.scheduled({ cron: '* * * * *' }, withoutAssets, context);
    await settle();

    expect(control.count(LIVE_REPORT_WRITE)).toBe(0);
    expect(control.count(FLOOR_STATE_WRITE)).toBe(0);
    expect(await objectFloor(control)).toMatchObject({ liveAppBuild: 'null' });
  });
});

describe('App Worker public App build floor status', () => {
  it('answers the stored and effective floor with the live and reported builds, uncached', async () => {
    useDateClock();
    const control = createControl();
    await writeFloor(control, { minAppBuild: 785, expectedRevision: 0, liveAppBuild: 785 });
    advance(5_000);
    await reportLive(control, 786);
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v786'")));

    const response = await publicStatus(env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(await response.json()).toEqual({
      minAppBuild: 785,
      effectiveMinAppBuild: 785,
      revision: 1,
      updatedAt: T0,
      liveAppBuild: 786,
      reportedLiveAppBuild: 786,
      reportedAt: T0 + 5_000,
      state: 'valid',
      generatedAt: T0 + 5_000,
    });

    const head = await publicStatus(env, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    const post = await publicStatus(env, { method: 'POST', body: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET, HEAD');
  });

  it.each(['down', 'missing'] as const)(
    'refuses with 503 when the floor routes are %s',
    async (floorRoutes) => {
      const control = createControl();
      control.floorRoutes = floorRoutes;
      const response = await publicStatus(
        floorEnv(control, createAssets(serviceWorkerSource("'v785'"))),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(await response.json()).toEqual({ error: 'APP_BUILD_FLOOR_UNAVAILABLE' });
    },
  );
});

describe('App Worker client App build floor read', () => {
  it('answers exactly the effective floor, uncached in the browser and without cookies', async () => {
    const control = createControl();
    await writeFloor(control, { minAppBuild: 785, expectedRevision: 0, liveAppBuild: 785 });
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v785'")));

    const response = await clientRead(env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.text()).toBe('{"effectiveMinAppBuild":785}');
  });

  it('publishes 0 while the floor is off or once the live report is stale', async () => {
    useDateClock();
    const control = createControl();
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v785'")));
    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 0 });

    advance(2_000);
    await writeFloor(control, { minAppBuild: 785, expectedRevision: 0, liveAppBuild: 785 });
    advance(2_000);
    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 785 });

    advance(APP_BUILD_FLOOR_REPORT_STALE_MS);
    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 0 });
  });

  it('publishes 0 for an object without the floor routes, no binding or a failed read', async () => {
    useDateClock();
    const control = createControl();
    await writeFloor(control, { minAppBuild: 785, expectedRevision: 0, liveAppBuild: 785 });
    const assets = createAssets(serviceWorkerSource("'v785'"));
    const env = floorEnv(control, assets);
    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 785 });

    // A failed read keeps the isolate's last live value as stale; the gates
    // may use it, the client read publishes 0.
    control.floorRoutes = 'down';
    advance(2_000);
    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 0 });
    expect(control.count(FLOOR_STATUS_READ)).toBe(2);

    control.floorRoutes = 'missing';
    advance(2_000);
    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 0 });

    const unbound = { ASSETS: assets };
    expect(await (await clientRead(unbound)).json()).toEqual({ effectiveMinAppBuild: 0 });
  });

  it('clamps the floor to the build this App serves and memoizes that build', async () => {
    const control = createControl();
    await writeFloor(control, { minAppBuild: 785, expectedRevision: 0, liveAppBuild: 785 });
    const older = createAssets(serviceWorkerSource("'v784'"));
    const olderEnv = floorEnv(control, older);
    for (let request = 0; request < 3; request += 1) {
      expect(await (await clientRead(olderEnv)).json()).toEqual({ effectiveMinAppBuild: 784 });
    }
    expect(older.serviceWorkerReads()).toBe(1);

    const unreadable = createAssets(() => new Response('', { status: 404 }));
    expect(await (await clientRead(floorEnv(control, unreadable))).json()).toEqual({
      effectiveMinAppBuild: 0,
    });
    expect(await (await clientRead(floorEnv(control, null))).json()).toEqual({
      effectiveMinAppBuild: 0,
    });
  });

  it('serves a live value from the edge cache for its lifetime and clamps it on every request', async () => {
    useDateClock();
    const edge = installEdgeCache();
    const control = createControl();
    await writeFloor(control, { minAppBuild: 785, expectedRevision: 0, liveAppBuild: 785 });
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v785'")));

    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 785 });
    expect(control.count(FLOOR_STATUS_READ)).toBe(1);
    const stored = edge.entries.get(edge.floorKey);
    expect(stored?.headers.get('Cache-Control')).toBe(
      `public, max-age=${APP_BUILD_FLOOR_EDGE_CACHE_TTL_S}`,
    );
    expect(JSON.parse(stored?.body || 'null')).toEqual({ effectiveMinAppBuild: 785 });

    // A lower reaches the client read only when the cached entry expires.
    await writeFloor(control, { minAppBuild: 0, expectedRevision: 1 });
    advance(APP_BUILD_FLOOR_EDGE_CACHE_TTL_S * 1_000 - 1_000);
    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 785 });
    expect(control.count(FLOOR_STATUS_READ)).toBe(1);

    // The clamp runs after the cache: an older App never publishes above itself.
    const rolledBack = floorEnv(control, createAssets(serviceWorkerSource("'v784'")));
    expect(await (await clientRead(rolledBack)).json()).toEqual({ effectiveMinAppBuild: 784 });

    advance(1_000);
    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 0 });
    expect(control.count(FLOOR_STATUS_READ)).toBe(2);
  });

  it('never stores a floor it did not read live and falls through a corrupt entry', async () => {
    useDateClock();
    const edge = installEdgeCache();
    const control = createControl();
    await writeFloor(control, { minAppBuild: 785, expectedRevision: 0, liveAppBuild: 785 });
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v785'")));

    control.floorRoutes = 'down';
    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 0 });
    expect(edge.cache.put).not.toHaveBeenCalled();
    control.floorRoutes = 'missing';
    advance(2_000);
    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 0 });
    expect(edge.cache.put).not.toHaveBeenCalled();

    control.floorRoutes = 'live';
    for (const corrupt of ['not json', '{"effectiveMinAppBuild":"785"}', '{"other":785}', '-1']) {
      edge.entries.set(edge.floorKey, {
        body: corrupt,
        headers: new Headers({ 'Cache-Control': 'public, max-age=30' }),
        storedAt: Date.now(),
        maxAgeMs: 30_000,
      });
      advance(2_000);
      const reads = control.count(FLOOR_STATUS_READ);
      expect(await (await clientRead(env)).json(), corrupt).toEqual({ effectiveMinAppBuild: 785 });
      expect(control.count(FLOOR_STATUS_READ), corrupt).toBe(reads + 1);
    }
  });

  it('reads the object on every miss when the runtime has no edge cache', async () => {
    useDateClock();
    const control = createControl();
    await writeFloor(control, { minAppBuild: 785, expectedRevision: 0, liveAppBuild: 785 });
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v785'")));
    for (let request = 1; request <= 3; request += 1) {
      advance(2_000);
      expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 785 });
      expect(control.count(FLOOR_STATUS_READ)).toBe(request);
    }
  });

  it.each(['POST', 'HEAD', 'PUT', 'DELETE'])('refuses %s with 405', async (method) => {
    const control = createControl();
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v785'")));
    const response = await clientRead(env, {
      method,
      ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}),
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(control.count(FLOOR_STATUS_READ)).toBe(0);
  });
});

describe('App Worker App build floor during maintenance', () => {
  it('keeps the public status and admin view open and gates the client read', async () => {
    const control = createControl();
    await writeFloor(control, { minAppBuild: 785, expectedRevision: 0, liveAppBuild: 785 });
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v785'")));
    const cookie = await login(env);
    await enableMaintenance(control);

    // The first public request starts the background maintenance refresh.
    const { context, settle } = createContext();
    await appWorker.fetch(new Request(`${ORIGIN}/favicon.ico`), env, context);
    await vi.waitFor(async () => {
      await settle();
      const gated = await clientRead(env);
      expect(gated.status).toBe(503);
    });

    const gated = await clientRead(env);
    expect(gated.status).toBe(503);
    expect(gated.headers.get('Content-Type')).toContain('application/json');
    expect(await gated.json()).not.toHaveProperty('effectiveMinAppBuild');

    const status = await publicStatus(env);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ minAppBuild: 785, effectiveMinAppBuild: 785 });

    const admin = await appWorker.fetch(
      new Request(`${ORIGIN}${ADMIN_PATH}`, { headers: { Cookie: cookie } }),
      env,
    );
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ appBuildFloor: { minAppBuild: 785 } });
  });
});

describe('App Worker admin App build floor', () => {
  it('renders the floor panel in the maintenance view of the dashboard', async () => {
    const control = createControl();
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v785'")));
    const response = await appWorker.fetch(
      new Request(`${ORIGIN}/admin`, { headers: { Accept: 'text/html' } }),
      env,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    const start = html.indexOf('data-admin-view="maintenance"');
    const end = html.indexOf('data-admin-view="operations"');
    expect(start).toBeGreaterThan(0);
    const maintenanceView = html.slice(start, end);
    for (const attribute of [
      'data-app-build-floor-panel',
      'data-app-build-floor-state',
      'data-app-build-floor-refresh',
      'data-app-build-floor-summary',
      'data-app-build-floor-facts',
      'data-app-build-floor-form',
      'data-app-build-floor-input',
      'data-app-build-floor-lower',
      'data-app-build-floor-error',
      'data-app-build-floor-history-status',
      'data-app-build-floor-history-list',
    ]) {
      expect(maintenanceView, attribute).toContain(attribute);
    }
    expect(maintenanceView).not.toMatch(/font-weight:\s*[89]00/u);
  });

  it('requires an admin session for the view and the lower', async () => {
    const control = createControl();
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v785'")));
    const view = await appWorker.fetch(new Request(`${ORIGIN}${ADMIN_PATH}`), env);
    expect(view.status).toBe(401);
    const lower = await appWorker.fetch(
      new Request(`${ORIGIN}${ADMIN_PATH}`, {
        method: 'POST',
        headers: adminHeaders(''),
        body: JSON.stringify({
          minAppBuild: 0,
          expectedRevision: 0,
          requestId: '123e4567-e89b-42d3-a456-426614174000',
        }),
      }),
      env,
    );
    expect(lower.status).toBe(401);
    expect(control.count(FLOOR_STATE_WRITE)).toBe(0);
  });

  it('shows the stored and effective floor, the live and reported builds and the history', async () => {
    useDateClock();
    const control = createControl();
    await writeFloor(control, {
      minAppBuild: 785,
      expectedRevision: 0,
      liveAppBuild: 785,
      reason: 'Release 9.0.12 verified',
    });
    advance(60_000);
    await writeFloor(control, { minAppBuild: 0, expectedRevision: 1, reason: 'Rollback drill' });
    advance(1_000);
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v785'")));
    const cookie = await login(env);

    const response = await appWorker.fetch(
      new Request(`${ORIGIN}${ADMIN_PATH}`, { headers: { Cookie: cookie } }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({
      generatedAt: new Date(T0 + 61_000).toISOString(),
      appBuildFloor: {
        minAppBuild: 0,
        effectiveMinAppBuild: 0,
        revision: 2,
        updatedAt: T0 + 60_000,
        liveAppBuild: 785,
        reportedLiveAppBuild: 785,
        reportedAt: T0,
        state: 'valid',
        generatedAt: T0 + 61_000,
      },
      floorHistory: [
        {
          minAppBuild: 0,
          revision: 2,
          updatedAt: new Date(T0 + 60_000).toISOString(),
          reason: 'Rollback drill',
          note: null,
        },
        {
          minAppBuild: 785,
          revision: 1,
          updatedAt: new Date(T0).toISOString(),
          reason: 'Release 9.0.12 verified',
          note: null,
        },
      ],
      floorHistoryTruncated: false,
    });
  });

  it('lowers the floor, including to off, and refuses a raise', async () => {
    const control = createControl();
    await writeFloor(control, { minAppBuild: 786, expectedRevision: 0, liveAppBuild: 786 });
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v786'")));
    const cookie = await login(env);
    const post = (body: Record<string, unknown>, cookieValue = cookie) =>
      appWorker.fetch(
        new Request(`${ORIGIN}${ADMIN_PATH}`, {
          method: 'POST',
          headers: adminHeaders(cookieValue),
          body: JSON.stringify(body),
        }),
        env,
      );

    const raise = await post({
      minAppBuild: 787,
      expectedRevision: 1,
      requestId: '123e4567-e89b-42d3-a456-426614174001',
    });
    expect(raise.status).toBe(409);
    expect(await raise.json()).toMatchObject({
      error: 'APP_BUILD_FLOOR_LOWER_ONLY',
      appBuildFloor: { minAppBuild: 786, revision: 1 },
    });

    const stale = await post({
      minAppBuild: 785,
      expectedRevision: 0,
      requestId: '123e4567-e89b-42d3-a456-426614174002',
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: 'APP_BUILD_FLOOR_REVISION_CONFLICT',
      appBuildFloor: { minAppBuild: 786, revision: 1 },
    });

    const lowered = await post({
      minAppBuild: 785,
      expectedRevision: 1,
      requestId: '123e4567-e89b-42d3-a456-426614174003',
    });
    expect(lowered.status).toBe(200);
    expect(await lowered.json()).toMatchObject({
      ok: true,
      changed: true,
      replayed: false,
      appBuildFloor: { minAppBuild: 785, effectiveMinAppBuild: 785, revision: 2 },
    });

    const off = await post({
      minAppBuild: 0,
      expectedRevision: 2,
      requestId: '123e4567-e89b-42d3-a456-426614174004',
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({
      changed: true,
      appBuildFloor: { minAppBuild: 0, effectiveMinAppBuild: 0, revision: 3 },
    });
    expect(await objectFloor(control)).toMatchObject({ minAppBuild: 0, revision: 3 });

    for (const invalid of [
      { minAppBuild: -1, expectedRevision: 3, requestId: '123e4567-e89b-42d3-a456-426614174005' },
      { minAppBuild: '0', expectedRevision: 3, requestId: '123e4567-e89b-42d3-a456-426614174005' },
      { minAppBuild: 0, expectedRevision: 3, requestId: 'not-a-uuid' },
      { minAppBuild: 0, expectedRevision: 3 },
      {
        minAppBuild: 0,
        expectedRevision: 3,
        requestId: '123e4567-e89b-42d3-a456-426614174005',
        liveAppBuild: 900,
      },
    ]) {
      const response = await post(invalid);
      expect(response.status, JSON.stringify(invalid)).toBe(400);
    }
    expect(await objectFloor(control)).toMatchObject({ minAppBuild: 0, revision: 3 });

    const crossSite = await appWorker.fetch(
      new Request(`${ORIGIN}${ADMIN_PATH}`, {
        method: 'POST',
        headers: adminHeaders(cookie, { Origin: 'https://attacker.example' }),
        body: JSON.stringify({
          minAppBuild: 0,
          expectedRevision: 3,
          requestId: '123e4567-e89b-42d3-a456-426614174006',
        }),
      }),
      env,
    );
    expect(crossSite.status).toBe(403);
  });

  it('refreshes the isolate floor after its own lower, so the gates follow without a read', async () => {
    useDateClock();
    const control = createControl();
    await writeFloor(control, { minAppBuild: 785, expectedRevision: 0, liveAppBuild: 785 });
    const env = floorEnv(control, createAssets(serviceWorkerSource("'v785'")));
    const cookie = await login(env);
    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 785 });
    const reads = control.count(FLOOR_STATUS_READ);

    const response = await appWorker.fetch(
      new Request(`${ORIGIN}${ADMIN_PATH}`, {
        method: 'POST',
        headers: adminHeaders(cookie),
        body: JSON.stringify({
          minAppBuild: 0,
          expectedRevision: 1,
          requestId: '123e4567-e89b-42d3-a456-426614174020',
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await (await clientRead(env)).json()).toEqual({ effectiveMinAppBuild: 0 });
    expect(control.count(FLOOR_STATUS_READ)).toBe(reads);
  });

  it('lowers the floor while the live build is unreadable', async () => {
    const control = createControl();
    await writeFloor(control, { minAppBuild: 785, expectedRevision: 0, liveAppBuild: 785 });
    const env = floorEnv(
      control,
      createAssets(() => new Response('', { status: 404 })),
    );
    const cookie = await login(env);

    const response = await appWorker.fetch(
      new Request(`${ORIGIN}${ADMIN_PATH}`, {
        method: 'POST',
        headers: adminHeaders(cookie),
        body: JSON.stringify({
          minAppBuild: 0,
          expectedRevision: 1,
          requestId: '123e4567-e89b-42d3-a456-426614174010',
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      changed: true,
      appBuildFloor: { minAppBuild: 0, liveAppBuild: null },
    });
  });
});
