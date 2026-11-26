import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STATUS_EDGE_CACHE_KEY_PATH,
  STATUS_EDGE_CACHE_TTL_S,
  STATUS_PUBLIC_PATH,
  STATUS_RESULT_RETENTION_MS,
  type StatusPublicNote,
} from '../../../cloudflare/status-contract.ts';
import {
  handleStatusApi,
  type StatusApiDependencies,
  type StatusEdgeCache,
  type StatusMaintenanceRead,
  type StatusNoteRead,
} from '../../../cloudflare/status-api.ts';
import type { StatusPayload } from '../../../cloudflare/status-payload.ts';
import type { StatusD1Database, StatusD1Value } from '../../../cloudflare/status-store.ts';

const ORIGIN = 'https://musixquare.com';
const T0 = Date.parse('2026-11-26T05:50:00.000Z');
const CACHE_KEY_URL = `${ORIGIN}${STATUS_EDGE_CACHE_KEY_PATH}`;
const NOTE: StatusPublicNote = {
  id: 'note-1',
  message: 'We are looking into slow joins.',
  postedAt: '2026-11-26T05:40:00.000Z',
  expiresAt: null,
};

/** D1 rows: rooms passed at 05:45; pro failed at 05:30 and 05:45, so pro has a problem. */
const D1_ROWS = [
  {
    component: 'rooms',
    slot_at: Date.parse('2026-11-26T05:45:00.000Z'),
    result: 'o',
    reason: 'passing',
    checked_at: Date.parse('2026-11-26T05:45:06.000Z'),
    source: 'cron',
    run_id: null,
  },
  {
    component: 'pro',
    slot_at: Date.parse('2026-11-26T05:30:00.000Z'),
    result: 'p',
    reason: 'pro_unreachable',
    checked_at: Date.parse('2026-11-26T05:30:07.000Z'),
    source: 'cron',
    run_id: null,
  },
  {
    component: 'pro',
    slot_at: Date.parse('2026-11-26T05:45:00.000Z'),
    result: 'p',
    reason: 'pro_unreachable',
    checked_at: Date.parse('2026-11-26T05:45:07.000Z'),
    source: 'cron',
    run_id: null,
  },
];

// The App's response helpers, as cloudflare/app-worker.ts defines them.
function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...headers,
    },
  });
}

function withoutBodyForHead(request: Request, response: Response) {
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

function methodAllowed(request: Request, methods: string[]) {
  return methods.includes(request.method)
    ? null
    : json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: methods.join(', ') });
}

class MemoryCache implements StatusEdgeCache {
  readonly entries = new Map<string, Response>();
  readonly match = vi.fn(async (request: Request) => this.entries.get(request.url)?.clone());
  readonly put = vi.fn(async (request: Request, response: Response) => {
    this.entries.set(request.url, response.clone());
  });
}

interface Harness {
  readonly deps: StatusApiDependencies;
  readonly cache: MemoryCache;
  readonly waits: Promise<unknown>[];
  readonly bound: StatusD1Value[][];
  readonly reads: { db: number; maintenance: number; note: number };
}

function harness(
  options: {
    rows?: () => Promise<unknown>;
    db?: boolean;
    maintenance?: () => Promise<StatusMaintenanceRead>;
    note?: () => Promise<StatusNoteRead>;
    cache?: boolean;
    waitUntil?: boolean;
  } = {},
): Harness {
  const cache = new MemoryCache();
  const waits: Promise<unknown>[] = [];
  const bound: StatusD1Value[][] = [];
  const reads = { db: 0, maintenance: 0, note: 0 };
  const rows = options.rows ?? (async () => ({ success: true, results: D1_ROWS }));
  const database: StatusD1Database = {
    prepare: () => ({
      bind(...values: StatusD1Value[]) {
        bound.push(values);
        return this;
      },
      run: async () => ({ success: true }),
      all: rows,
    }),
    batch: async () => [],
  };
  const deps: StatusApiDependencies = {
    json,
    withoutBodyForHead,
    methodAllowed,
    adminDb: () => {
      reads.db += 1;
      return options.db === false ? null : database;
    },
    readMaintenance: async () => {
      reads.maintenance += 1;
      return options.maintenance
        ? options.maintenance()
        : { enabled: false, activatedAt: null, controlUnavailable: false };
    },
    readStatusNote: async () => {
      reads.note += 1;
      return options.note ? options.note() : { status: 'ok', note: NOTE };
    },
    edgeCache: () => (options.cache === false ? null : cache),
    ...(options.waitUntil === false
      ? {}
      : { waitUntil: (promise: Promise<unknown>) => void waits.push(promise) }),
  };
  return { deps, cache, waits, bound, reads };
}

function get(path = STATUS_PUBLIC_PATH, method = 'GET') {
  return new Request(`${ORIGIN}${path}`, { method });
}

async function body(response: Response): Promise<StatusPayload> {
  return (await response.json()) as StatusPayload;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/status', () => {
  it('answers 405 with Allow for every other method, before any read', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const test = harness();
      const response = await handleStatusApi(get(STATUS_PUBLIC_PATH, method), test.deps);
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD');
      expect(await response.json()).toEqual({ error: 'METHOD_NOT_ALLOWED' });
      expect(test.reads).toEqual({ db: 0, maintenance: 0, note: 0 });
      expect(test.cache.match).not.toHaveBeenCalled();
    }
  });

  it('answers GET with the payload and HEAD with the same answer without a body', async () => {
    const test = harness();
    const response = await handleStatusApi(get(), test.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    const payload = await body(response);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-11-26T05:50:00.000Z',
      timeZone: 'UTC',
      maintenance: { active: false, since: null },
      announcement: NOTE,
    });
    expect(payload.components.map((entry) => entry.state)).toEqual([
      'stale',
      'ok',
      'stale',
      'problem',
    ]);
    // Rows are read for the retention window ending now.
    expect(test.bound).toEqual([[T0 - STATUS_RESULT_RETENTION_MS]]);

    const head = await handleStatusApi(get(STATUS_PUBLIC_PATH, 'HEAD'), harness().deps);
    expect(head.status).toBe(200);
    expect(head.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(head.body).toBeNull();
  });

  it('caches a fully read body for 30 seconds and stamps the serve time on every answer', async () => {
    const test = harness();
    const first = await body(await handleStatusApi(get(), test.deps));
    expect(test.reads).toEqual({ db: 1, maintenance: 1, note: 1 });
    expect(test.waits).toHaveLength(1);
    await Promise.all(test.waits);
    expect(test.cache.put).toHaveBeenCalledTimes(1);
    const [key, stored] = test.cache.put.mock.calls[0]!;
    expect(key.url).toBe(CACHE_KEY_URL);
    expect(key.method).toBe('GET');
    expect(stored.headers.get('Cache-Control')).toBe(`public, max-age=${STATUS_EDGE_CACHE_TTL_S}`);
    expect(STATUS_EDGE_CACHE_TTL_S).toBe(30);

    vi.setSystemTime(T0 + 12_345);
    // Query strings never change the answer or the cache key.
    const second = await handleStatusApi(get(`${STATUS_PUBLIC_PATH}?fixture=ok&x=1`), test.deps);
    expect(test.reads).toEqual({ db: 1, maintenance: 1, note: 1 });
    expect(test.cache.match.mock.lastCall?.[0].url).toBe(CACHE_KEY_URL);
    expect(test.cache.put).toHaveBeenCalledTimes(1);
    expect(second.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    const cached = await body(second);
    expect(cached.generatedAt).toBe('2026-11-26T05:50:12.345Z');
    expect({ ...cached, generatedAt: first.generatedAt }).toEqual(first);
    expect(Object.keys(cached)).toEqual(Object.keys(first));

    const head = await handleStatusApi(get(STATUS_PUBLIC_PATH, 'HEAD'), test.deps);
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(test.reads).toEqual({ db: 1, maintenance: 1, note: 1 });
  });

  it('awaits the cache write when there is no waitUntil', async () => {
    const test = harness({ waitUntil: false });
    await handleStatusApi(get(), test.deps);
    expect(test.cache.entries.has(CACHE_KEY_URL)).toBe(true);
  });

  it('serves without the cache when there is none, or when it fails', async () => {
    const uncached = harness({ cache: false });
    expect((await handleStatusApi(get(), uncached.deps)).status).toBe(200);
    expect(uncached.reads.db).toBe(1);

    const broken = harness();
    broken.cache.match.mockRejectedValueOnce(new Error('cache down'));
    broken.cache.put.mockRejectedValueOnce(new Error('cache down'));
    const response = await handleStatusApi(get(), broken.deps);
    expect(response.status).toBe(200);
    await expect(Promise.all(broken.waits)).resolves.toBeDefined();

    // A corrupt or foreign entry is a miss.
    const corrupt = harness();
    corrupt.cache.entries.set(CACHE_KEY_URL, new Response('{"schemaVersion":2,"components":[]}'));
    expect((await body(await handleStatusApi(get(), corrupt.deps))).schemaVersion).toBe(1);
    await Promise.all(corrupt.waits);
    corrupt.cache.entries.set(CACHE_KEY_URL, new Response('not json'));
    vi.setSystemTime(T0 + 1_000);
    expect((await handleStatusApi(get(), corrupt.deps)).status).toBe(200);
    expect(corrupt.reads.db).toBe(2);

    const throwing = harness();
    throwing.deps.edgeCache = () => {
      throw new Error('no caches');
    };
    expect((await handleStatusApi(get(), throwing.deps)).status).toBe(200);
  });

  it('answers 200 with results_unavailable when the store fails, and caches nothing', async () => {
    for (const test of [
      harness({ db: false }),
      harness({ rows: async () => Promise.reject(new Error('D1_ERROR: unavailable')) }),
      harness({ rows: async () => ({ success: false, results: [] }) }),
    ]) {
      const response = await handleStatusApi(get(), test.deps);
      expect(response.status).toBe(200);
      const payload = await body(response);
      expect(payload.overall).toEqual({
        state: 'stale',
        reason: 'results_unavailable',
        lastCheckedAt: null,
        since: null,
      });
      expect(new Set(payload.components.map((entry) => entry.reason))).toEqual(
        new Set(['results_unavailable']),
      );
      // The note and the maintenance state still come through.
      expect(payload.announcement).toEqual(NOTE);
      expect(payload.maintenance).toEqual({ active: false, since: null });
      await Promise.all(test.waits);
      expect(test.cache.put).not.toHaveBeenCalled();
    }
  });

  it('gives announcement null when the note cannot be read, and caches nothing', async () => {
    for (const test of [
      harness({ note: async () => ({ status: 'unavailable' }) }),
      harness({ note: async () => Promise.reject(new Error('control down')) }),
    ]) {
      const payload = await body(await handleStatusApi(get(), test.deps));
      expect(payload.announcement).toBeNull();
      expect(payload.overall.reason).toBe('component_problem');
      expect(test.cache.put).not.toHaveBeenCalled();
    }
    const none = harness({ note: async () => ({ status: 'ok', note: null }) });
    expect((await body(await handleStatusApi(get(), none.deps))).announcement).toBeNull();
    await Promise.all(none.waits);
    expect(none.cache.put).toHaveBeenCalledTimes(1);
  });

  it('shows maintenance only while it is enabled and the control object answered', async () => {
    const activatedAt = Date.parse('2026-11-26T05:30:00.000Z');
    const active = await body(
      await handleStatusApi(
        get(),
        harness({
          maintenance: async () => ({ enabled: true, controlUnavailable: false, activatedAt }),
        }).deps,
      ),
    );
    expect(active.maintenance).toEqual({ active: true, since: '2026-11-26T05:30:00.000Z' });
    expect(active.overall).toMatchObject({
      state: 'maintenance',
      reason: 'maintenance',
      since: '2026-11-26T05:30:00.000Z',
    });

    // A control-plane outage reads as enabled but unavailable: the checks
    // keep their own states and nothing says maintenance.
    const outage = harness({
      maintenance: async () => ({ enabled: true, controlUnavailable: true, activatedAt: null }),
    });
    const unavailable = await body(await handleStatusApi(get(), outage.deps));
    expect(unavailable.maintenance).toEqual({ active: false, since: null });
    expect(unavailable.overall).toMatchObject({ state: 'problem', reason: 'component_problem' });
    expect(unavailable.components.some((entry) => entry.state === 'maintenance')).toBe(false);

    // A maintenance read that throws is not maintenance, and is never cached.
    const failed = harness({ maintenance: async () => Promise.reject(new Error('down')) });
    const answer = await body(await handleStatusApi(get(), failed.deps));
    expect(answer.maintenance).toEqual({ active: false, since: null });
    expect(failed.cache.put).not.toHaveBeenCalled();
  });
});
