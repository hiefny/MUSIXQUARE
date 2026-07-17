import { afterEach, describe, expect, it, vi } from 'vitest';
import developerApiWorker, {
  DeveloperApiRateLimiter,
  deriveDeveloperApiKeyDigest,
  developerApiScopes,
  isDeveloperApiRequestId,
  parseDeveloperApiKey,
} from '../../../cloudflare/developer-api-worker.js';

const ROOM_CODE = '000001';
const KEY_ID = 'A'.repeat(16);
const KEY_SECRET = 'B'.repeat(43);
const API_KEY = `mxqr_live_${KEY_ID}.${KEY_SECRET}`;
const KEY_PEPPER = 'p'.repeat(32);
const RATE_SECRET = 'r'.repeat(32);
const OBSERVED_AT_MS = 1_784_262_910_000;

afterEach(() => {
  vi.useRealTimers();
});

type KeyRow = {
  key_id: string;
  room_code: string;
  label: string;
  secret_digest: string;
  digest_version: number;
  scope_mask: number;
  status: 'active' | 'revoked';
  created_at: number;
  updated_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_hour: number | null;
};

function roomPayload() {
  return {
    schemaVersion: 1,
    view: 'room',
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 7,
    participantCount: 2,
    controlAvailable: false,
    quota: {
      limitBytes: 1_073_741_824,
      perAssetLimitBytes: 209_715_200,
      usedBytes: 1_024,
      reservedBytes: 0,
    },
  };
}

function playbackPayload() {
  return {
    schemaVersion: 1,
    view: 'playback',
    roomCode: ROOM_CODE,
    revision: 3,
    playlistRevision: 4,
    state: 'playing',
    queueItemId: 'queue_item_000001',
    positionSeconds: 12.5,
    observedAtMs: OBSERVED_AT_MS,
    item: {
      queueItemId: 'queue_item_000001',
      kind: 'audio',
      name: 'Orchestra.flac',
      title: 'Orchestra',
      byteLength: 1_024,
    },
  };
}

function queuePayload() {
  return {
    schemaVersion: 1,
    view: 'queue',
    roomCode: ROOM_CODE,
    playlistRevision: 4,
    currentQueueItemId: 'queue_item_000001',
    items: [playbackPayload().item],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function limiterNamespace(options: { block?: (name: string) => boolean } = {}) {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  return {
    calls,
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((name: string) => ({
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        calls.push({ name, body });
        const blocked = options.block?.(name) === true;
        return jsonResponse({
          allowed: !blocked,
          limit: name.startsWith('room:') ? 60 : 120,
          remaining: blocked ? 0 : 59,
          resetAtMs: Date.now() + 60_000,
          retryAfterSeconds: blocked ? 60 : 0,
        });
      }),
    })),
  };
}

function fakeDatabase(row: KeyRow | null, options: { fail?: boolean } = {}) {
  const first = vi.fn(async () => {
    if (options.fail) throw new Error('D1 unavailable');
    return row ? { ...row } : null;
  });
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const prepare = vi.fn((_sql: string) => ({
    bind: vi.fn((..._values: unknown[]) => ({ first, run })),
  }));
  return { prepare, first, run };
}

async function createEnvironment(
  options: {
    row?: KeyRow | null;
    scopeMask?: number;
    status?: 'active' | 'revoked';
    expiresAt?: number;
    dbFail?: boolean;
    limiter?: ReturnType<typeof limiterNamespace>;
    facadePayload?: unknown;
    facadeStatus?: number;
    mode?: string;
  } = {},
) {
  const now = Date.now();
  const digest = await deriveDeveloperApiKeyDigest(KEY_PEPPER, KEY_ID, KEY_SECRET);
  const defaultRow: KeyRow = {
    key_id: KEY_ID,
    room_code: ROOM_CODE,
    label: 'Friend integration',
    secret_digest: digest,
    digest_version: 1,
    scope_mask:
      options.scopeMask ??
      developerApiScopes['room:read'] |
        developerApiScopes['playback:read'] |
        developerApiScopes['queue:read'],
    status: options.status ?? 'active',
    created_at: now - 1_000,
    updated_at: now - 1_000,
    expires_at: options.expiresAt ?? now + 86_400_000,
    revoked_at: options.status === 'revoked' ? now - 100 : null,
    last_used_hour: null,
  };
  const row = options.row === undefined ? defaultRow : options.row;
  const database = fakeDatabase(row, { fail: options.dbFail });
  const limiter = options.limiter ?? limiterNamespace();
  const facadeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { projection?: string };
    const payload =
      options.facadePayload ??
      (body.projection === 'playback'
        ? playbackPayload()
        : body.projection === 'queue'
          ? queuePayload()
          : roomPayload());
    return jsonResponse(payload, options.facadeStatus ?? 200);
  });
  return {
    env: {
      DEVELOPER_API_MODE: options.mode ?? 'canary',
      DEVELOPER_API_CANARY_ROOMS: ROOM_CODE,
      MXQR_DEVELOPER_API_KEY_PEPPER: KEY_PEPPER,
      MXQR_DEVELOPER_API_RATE_SECRET: RATE_SECRET,
      DEVELOPER_API_DB: database,
      DEVELOPER_API_LIMITERS: limiter,
      DEVELOPER_API_FACADE: { fetch: facadeFetch },
    },
    database,
    limiter,
    facadeFetch,
  };
}

function apiRequest(path = `/v1/rooms/${ROOM_CODE}`, options: RequestInit = {}): Request {
  const headers = new Headers(options.headers);
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${API_KEY}`);
  headers.set('cf-connecting-ip', '203.0.113.10');
  return new Request(`https://api.musixquare.com${path}`, { ...options, headers });
}

async function errorCode(response: Response): Promise<string | undefined> {
  const value = (await response.json()) as { error?: { code?: string } };
  return value.error?.code;
}

describe('Developer API key credentials', () => {
  it('parses only the exact 96-bit id and 256-bit secret envelope', () => {
    expect(parseDeveloperApiKey(API_KEY)).toEqual({ keyId: KEY_ID, secret: KEY_SECRET });
    expect(parseDeveloperApiKey(`${API_KEY}.extra`)).toBeNull();
    expect(parseDeveloperApiKey(`mxqr_test_${KEY_ID}.${KEY_SECRET}`)).toBeNull();
    expect(parseDeveloperApiKey(`mxqr_live_${KEY_ID.slice(1)}.${KEY_SECRET}`)).toBeNull();
  });

  it('derives the versioned domain-separated HMAC known vector', async () => {
    await expect(deriveDeveloperApiKeyDigest(KEY_PEPPER, KEY_ID, KEY_SECRET)).resolves.toBe(
      't-WvXWz3W0zg8BS5_vRbRl-hNe2ZlGHHq2vCek5CogE',
    );
  });
});

describe('Developer API read-only public Worker', () => {
  it('publishes a versioned health envelope without opening API data', async () => {
    const response = await developerApiWorker.fetch(
      new Request('https://api.musixquare.com/health'),
      { CF_VERSION_METADATA: { id: 'api-version-1' } },
    );
    expect(response.status).toBe(200);
    expect(isDeveloperApiRequestId(response.headers.get('x-request-id'))).toBe(true);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: 'musixquare-developer-api',
      workerVersionId: 'api-version-1',
    });
  });

  it('authenticates a room-bound key and returns a private ETag response', async () => {
    const { env, database, limiter, facadeFetch } = await createEnvironment();
    const waits: Promise<unknown>[] = [];
    const response = await developerApiWorker.fetch(apiRequest(), env, {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toMatch(/^"mxqr-room-[A-Za-z0-9_-]{43}"$/);
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(isDeveloperApiRequestId(response.headers.get('x-request-id'))).toBe(true);
    await expect(response.json()).resolves.toEqual(roomPayload());
    expect(database.first).toHaveBeenCalledTimes(1);
    expect(limiter.calls).toHaveLength(2);
    expect(limiter.calls[0]?.name).toMatch(/^ingress:[A-Za-z0-9_-]{43}$/);
    expect(limiter.calls[0]?.name).not.toContain('203.0.113.10');
    expect(limiter.calls[1]?.name).toBe(`room:${ROOM_CODE}`);
    expect(facadeFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(facadeFetch.mock.calls)).not.toContain(API_KEY);
    await Promise.all(waits);
    expect(database.run).toHaveBeenCalledTimes(1);
  });

  it('supports separate playback and queue scopes and revision ETags', async () => {
    const { env } = await createEnvironment();
    const playback = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/playback`),
      env,
    );
    expect(playback.status).toBe(200);
    expect(playback.headers.get('etag')).toMatch(/^"mxqr-playback-[A-Za-z0-9_-]{43}"$/);
    await expect(playback.json()).resolves.toEqual(playbackPayload());

    const queue = await developerApiWorker.fetch(apiRequest(`/v1/rooms/${ROOM_CODE}/queue`), env);
    expect(queue.status).toBe(200);
    expect(queue.headers.get('etag')).toMatch(/^"mxqr-queue-[A-Za-z0-9_-]{43}"$/);
    await expect(queue.json()).resolves.toEqual(queuePayload());
  });

  it('returns 304 for the current projection ETag without a body', async () => {
    const { env, facadeFetch } = await createEnvironment();
    const initial = await developerApiWorker.fetch(apiRequest(), env);
    const etag = initial.headers.get('etag');
    if (!etag) throw new Error('missing ETag');
    const response = await developerApiWorker.fetch(
      apiRequest(undefined, { headers: { 'if-none-match': etag } }),
      env,
    );
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get('etag')).toBe(etag);
    expect(facadeFetch).toHaveBeenCalledTimes(2);
  });

  it('changes ETags whenever a response representation changes without a revision bump', async () => {
    const playbackSetup = await createEnvironment({
      facadePayload: { ...playbackPayload(), observedAtMs: OBSERVED_AT_MS },
    });
    const firstPlayback = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/playback`),
      playbackSetup.env,
    );
    const firstPlaybackEtag = firstPlayback.headers.get('etag');
    playbackSetup.env.DEVELOPER_API_FACADE.fetch = vi.fn(async () =>
      jsonResponse({ ...playbackPayload(), observedAtMs: OBSERVED_AT_MS + 1 }),
    );
    const changedPlayback = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/playback`, {
        headers: { 'if-none-match': firstPlaybackEtag || '' },
      }),
      playbackSetup.env,
    );
    expect(changedPlayback.status).toBe(200);
    expect(changedPlayback.headers.get('etag')).not.toBe(firstPlaybackEtag);

    const secondQueueItem = {
      queueItemId: 'queue_item_000002',
      kind: 'youtube',
      name: 'Second item',
    };
    const queueSetup = await createEnvironment({
      facadePayload: {
        ...queuePayload(),
        currentQueueItemId: secondQueueItem.queueItemId,
        items: [...queuePayload().items, secondQueueItem],
      },
    });
    const firstQueue = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue`),
      queueSetup.env,
    );
    const firstQueueEtag = firstQueue.headers.get('etag');
    queueSetup.env.DEVELOPER_API_FACADE.fetch = vi.fn(async () =>
      jsonResponse({
        ...queuePayload(),
        currentQueueItemId: 'queue_item_000001',
        items: [...queuePayload().items, secondQueueItem],
      }),
    );
    const changedQueue = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue`, {
        headers: { 'if-none-match': firstQueueEtag || '' },
      }),
      queueSetup.env,
    );
    expect(changedQueue.status).toBe(200);
    expect(changedQueue.headers.get('etag')).not.toBe(firstQueueEtag);
  });

  it('uses one indistinguishable 401 contract for unknown, wrong, revoked, and expired keys', async () => {
    const cases: Array<{ env: Awaited<ReturnType<typeof createEnvironment>>['env']; key: string }> =
      [];
    cases.push({ env: (await createEnvironment({ row: null })).env, key: API_KEY });
    cases.push({
      env: (await createEnvironment()).env,
      key: `mxqr_live_${KEY_ID}.${'C'.repeat(43)}`,
    });
    cases.push({ env: (await createEnvironment({ status: 'revoked' })).env, key: API_KEY });
    cases.push({
      env: (await createEnvironment({ expiresAt: Date.now() - 1 })).env,
      key: API_KEY,
    });

    for (const entry of cases) {
      const response = await developerApiWorker.fetch(
        apiRequest(undefined, { headers: { authorization: `Bearer ${entry.key}` } }),
        entry.env,
      );
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe('UNAUTHORIZED');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('does not positively cache a key after it is revoked', async () => {
    const setup = await createEnvironment();
    const first = await developerApiWorker.fetch(apiRequest(), setup.env);
    expect(first.status).toBe(200);
    const row = await setup.database.first();
    if (!row) throw new Error('missing test row');
    row.status = 'revoked';
    row.revoked_at = Date.now();
    setup.database.first.mockResolvedValue(row);
    const second = await developerApiWorker.fetch(apiRequest(), setup.env);
    expect(second.status).toBe(401);
    expect(setup.database.first).toHaveBeenCalledTimes(3);
  });

  it('fails closed on D1 errors before calling the facade', async () => {
    const { env, facadeFetch } = await createEnvironment({ dbFail: true });
    const response = await developerApiWorker.fetch(apiRequest(), env);
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('BACKEND_UNAVAILABLE');
    expect(facadeFetch).not.toHaveBeenCalled();
  });

  it('fails closed on malformed scope, expiry, and revocation rows', async () => {
    const now = Date.now();
    const base = (await createEnvironment()).database.first.mock.results;
    expect(base).toEqual([]);
    for (const mutation of [
      { scope_mask: 0 },
      { scope_mask: 64 },
      { scope_mask: 4_294_967_297 },
      { scope_mask: 1.5 },
      { expires_at: null },
      { expires_at: now - 2_000, created_at: now - 1_000 },
      { status: 'active', revoked_at: now },
      { status: 'revoked', revoked_at: null },
    ]) {
      const valid = await createEnvironment();
      const row = (await valid.database.first()) as KeyRow;
      valid.database.first.mockResolvedValue({ ...row, ...mutation });
      const response = await developerApiWorker.fetch(apiRequest(), valid.env);
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe('UNAUTHORIZED');
    }
  });

  it('hides room existence across room binding and enforces same-room scopes', async () => {
    const mismatch = await createEnvironment();
    const otherRoom = await developerApiWorker.fetch(apiRequest('/v1/rooms/000000'), mismatch.env);
    expect(otherRoom.status).toBe(404);
    expect(await errorCode(otherRoom)).toBe('NOT_FOUND');
    expect(mismatch.facadeFetch).not.toHaveBeenCalled();

    const noQueueScope = await createEnvironment({ scopeMask: developerApiScopes['room:read'] });
    const forbidden = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue`),
      noQueueScope.env,
    );
    expect(forbidden.status).toBe(403);
    expect(await errorCode(forbidden)).toBe('FORBIDDEN');
    expect(noQueueScope.facadeFetch).not.toHaveBeenCalled();
  });

  it('keeps write routes closed even when mode is enabled', async () => {
    const { env, database, facadeFetch } = await createEnvironment({ mode: 'enabled' });
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/commands`, { method: 'POST' }),
      env,
    );
    expect(response.status).toBe(404);
    expect(database.first).not.toHaveBeenCalled();
    expect(facadeFetch).not.toHaveBeenCalled();
  });

  it('rejects arbitrary browser origins without emitting CORS headers', async () => {
    const { env, database } = await createEnvironment();
    const response = await developerApiWorker.fetch(
      apiRequest(undefined, { headers: { origin: 'https://attacker.example' } }),
      env,
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('BROWSER_ORIGIN_FORBIDDEN');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(database.first).not.toHaveBeenCalled();
  });

  it('applies the HMAC ingress limiter before D1 and returns Retry-After', async () => {
    const limiter = limiterNamespace({ block: (name) => name.startsWith('ingress:') });
    const { env, database } = await createEnvironment({ limiter });
    const response = await developerApiWorker.fetch(apiRequest(), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await errorCode(response)).toBe('RATE_LIMITED');
    expect(database.first).not.toHaveBeenCalled();
  });

  it('fails closed when the facade adds a private or unknown field', async () => {
    const { env } = await createEnvironment({
      facadePayload: { ...roomPayload(), participants: [{ displayName: 'Private' }] },
    });
    const response = await developerApiWorker.fetch(apiRequest(), env);
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('INTERNAL_RESPONSE_INVALID');
  });

  it('keeps canary keys confined to the configured room and defaults to off', async () => {
    const canary = await createEnvironment();
    canary.env.DEVELOPER_API_CANARY_ROOMS = '000000';
    const hidden = await developerApiWorker.fetch(apiRequest(), canary.env);
    expect(hidden.status).toBe(404);
    expect(await errorCode(hidden)).toBe('NOT_FOUND');

    const off = await createEnvironment({ mode: 'off' });
    const disabled = await developerApiWorker.fetch(apiRequest(), off.env);
    expect(disabled.status).toBe(503);
    expect(await errorCode(disabled)).toBe('API_DISABLED');
    expect(off.database.first).not.toHaveBeenCalled();
  });
});

class FakeStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;
  deleteAllCalls = 0;

  async get(key: string): Promise<unknown> {
    return structuredClone(this.values.get(key));
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarmAt = timestamp;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  async deleteAll(): Promise<void> {
    this.deleteAllCalls += 1;
    this.values.clear();
  }
}

describe('Developer API atomic room limiter', () => {
  it('does not partially charge the room bucket when the key bucket is blocked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    const storage = new FakeStorage();
    const limiter = new DeveloperApiRateLimiter({ storage } as never);
    const body = { operation: 'authenticated-read', keyId: KEY_ID };
    const request = () =>
      new Request('https://developer-api-rate.internal/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    for (let index = 0; index < 60; index += 1) {
      const allowed = await limiter.fetch(request());
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ allowed: true });
    }
    const blocked = await limiter.fetch(request());
    expect(await blocked.json()).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    const stored = storage.values.get('buckets') as Record<string, { count: number }>;
    expect(stored[`key:${KEY_ID}:read`]?.count).toBe(60);
    expect(stored['room:read']?.count).toBe(60);

    vi.advanceTimersByTime(60_000);
    const reset = await limiter.fetch(request());
    expect(await reset.json()).toMatchObject({ allowed: true, remaining: 59 });
  });

  it('rejects caller-selected bucket policies', async () => {
    const limiter = new DeveloperApiRateLimiter({ storage: new FakeStorage() } as never);
    const response = await limiter.fetch(
      new Request('https://developer-api-rate.internal/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'authenticated-read',
          keyId: KEY_ID,
          buckets: [{ id: 'bypass', limit: 1_000_000, windowMs: 1_000, cost: 1 }],
        }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('deletes expired per-IP limiter storage on its alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    const storage = new FakeStorage();
    const limiter = new DeveloperApiRateLimiter({ storage } as never);
    const response = await limiter.fetch(
      new Request('https://developer-api-rate.internal/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'ingress-read' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(storage.alarmAt).toBe(Date.now() + 60_000);
    vi.advanceTimersByTime(60_000);
    await limiter.alarm();
    expect(storage.values.size).toBe(0);
    expect(storage.deleteAllCalls).toBe(1);
    expect(storage.alarmAt).toBeNull();
  });
});
