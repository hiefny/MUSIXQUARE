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
const COMMAND_ID = `cmd_${'C'.repeat(22)}`;
const IDEMPOTENCY_KEY = 'request.command-0001';
const QUEUE_ITEM_ID = '123e4567-e89b-42d3-a456-426614174000';
const ASSET_ID = `asset_${'D'.repeat(32)}`;
const UPLOAD_URL =
  'https://01353882e4eea3a5acaa0c45e8336af4.r2.cloudflarestorage.com/musixquare-pro-media/staging?X-Amz-Signature=' +
  'a'.repeat(64);

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

function effectsPayload() {
  return {
    schemaVersion: 1,
    view: 'effects',
    roomCode: ROOM_CODE,
    revision: 5,
    updatedAtMs: OBSERVED_AT_MS,
    effects: {
      reverb: {
        mixPercent: 20,
        decaySeconds: 2.5,
        preDelaySeconds: 0.04,
        lowCutPercent: 5,
        highCutPercent: 90,
      },
      equalizer: { bandsDb: [-6, -3, 0, 3, 6] },
      virtualBass: { strengthPercent: 40 },
      virtualSurround: { widthPercent: 125 },
    },
  };
}

function commandPayload(
  status: 'pending' | 'dispatched' | 'applied' | 'rejected' | 'expired' = 'pending',
) {
  const createdAtMs = OBSERVED_AT_MS;
  const base = {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    commandId: COMMAND_ID,
    status,
    createdAtMs,
    expiresAtMs: createdAtMs + 30_000,
  };
  return status === 'applied'
    ? {
        ...base,
        completedAtMs: createdAtMs + 100,
        resultCode: 'applied',
      }
    : base;
}

function uploadPayload() {
  return {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    assetId: ASSET_ID,
    queueItemId: QUEUE_ITEM_ID,
    byteLength: 4_096,
    uploadExpiresAtMs: OBSERVED_AT_MS + 600_000,
    completionExpiresAtMs: OBSERVED_AT_MS + 900_000,
    upload: {
      method: 'PUT',
      url: UPLOAD_URL,
      headers: {
        'content-length': '4096',
        'content-type': 'audio/flac',
        'x-amz-meta-mxqr-room': ROOM_CODE,
        'x-amz-meta-mxqr-asset': ASSET_ID,
        'x-amz-meta-mxqr-version': '1',
        'x-amz-meta-mxqr-bytes': '4096',
      },
    },
    quota: {
      limitBytes: 1_073_741_824,
      perAssetLimitBytes: 209_715_200,
      usedBytes: 0,
      reservedBytes: 4_096,
    },
  };
}

function uploadCompletionPayload() {
  return {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    asset: {
      kind: 'pro-r2',
      assetId: ASSET_ID,
      version: 1,
      byteLength: 4_096,
      mime: 'audio/flac',
    },
    queueItem: {
      queueItemId: QUEUE_ITEM_ID,
      kind: 'audio',
      name: 'Orchestra.flac',
      title: 'Orchestra',
      byteLength: 4_096,
    },
    playlistRevision: 5,
    quota: {
      limitBytes: 1_073_741_824,
      perAssetLimitBytes: 209_715_200,
      usedBytes: 4_096,
      reservedBytes: 0,
    },
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
    label?: string;
  } = {},
) {
  const now = Date.now();
  const digest = await deriveDeveloperApiKeyDigest(KEY_PEPPER, KEY_ID, KEY_SECRET);
  const defaultRow: KeyRow = {
    key_id: KEY_ID,
    room_code: ROOM_CODE,
    label: options.label ?? 'Friend integration',
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
  const facadeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    const body = JSON.parse(String(init?.body || '{}')) as {
      projection?: string;
      mutation?: { type?: string };
    };
    const payload =
      options.facadePayload ??
      (path === '/internal/v1/commands/create'
        ? commandPayload()
        : path === '/internal/v1/commands/status'
          ? commandPayload('applied')
          : path === '/internal/v1/media/uploads/create'
            ? uploadPayload()
            : path === '/internal/v1/media/uploads/complete'
              ? uploadCompletionPayload()
              : path === '/internal/v1/queue/mutate'
                ? queuePayload()
                : body.projection === 'playback'
                  ? playbackPayload()
                  : body.projection === 'queue'
                    ? queuePayload()
                    : body.projection === 'effects'
                      ? effectsPayload()
                      : roomPayload());
    const defaultStatus =
      path === '/internal/v1/commands/create'
        ? 202
        : path === '/internal/v1/media/uploads/create' ||
            path === '/internal/v1/media/uploads/complete' ||
            (path === '/internal/v1/queue/mutate' &&
              (body.mutation?.type === 'add_youtube' ||
                body.mutation?.type === 'add_youtube_batch'))
          ? 201
          : 200;
    return jsonResponse(payload, options.facadeStatus ?? defaultStatus);
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

  it('accepts a 64-character key label as the private actor name and rejects unsafe labels', async () => {
    const actorName = 'A'.repeat(64);
    const accepted = await createEnvironment({
      label: actorName,
      scopeMask: developerApiScopes['queue:write'],
    });
    const acceptedResponse = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.actor-name-max',
        },
        body: JSON.stringify({ videoId: 'dQw4w9WgXcQ', name: 'Actor test' }),
      }),
      accepted.env,
    );
    expect(acceptedResponse.status).toBe(201);
    expect(JSON.parse(String(accepted.facadeFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      actorName,
    });

    const unsafe = await createEnvironment({
      label: 'Unsafe\nlabel',
      scopeMask: developerApiScopes['queue:write'],
    });
    const rejected = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.actor-name-unsafe',
        },
        body: JSON.stringify({ videoId: 'dQw4w9WgXcQ', name: 'Actor test' }),
      }),
      unsafe.env,
    );
    expect(rejected.status).toBe(401);
    expect(await errorCode(rejected)).toBe('UNAUTHORIZED');
    expect(unsafe.facadeFetch).not.toHaveBeenCalled();
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
    const [facadeInput, facadeInit] = facadeFetch.mock.calls[0]!;
    expect(new URL(String(facadeInput)).pathname).toBe('/internal/v1/read');
    expect(JSON.parse(String(facadeInit?.body))).toEqual({
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      projection: 'room',
    });
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

  it('returns a strictly bounded effects projection through effects:read', async () => {
    const setup = await createEnvironment({ scopeMask: developerApiScopes['effects:read'] });
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/effects`),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toMatch(/^"mxqr-effects-[A-Za-z0-9_-]{43}"$/);
    await expect(response.json()).resolves.toEqual(effectsPayload());
    expect(JSON.parse(String(setup.facadeFetch.mock.calls[0]?.[1]?.body))).toEqual({
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      projection: 'effects',
    });

    const playbackOnly = await createEnvironment({
      scopeMask: developerApiScopes['playback:read'],
    });
    const forbidden = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/effects`),
      playbackOnly.env,
    );
    expect(forbidden.status).toBe(403);
    expect(playbackOnly.facadeFetch).not.toHaveBeenCalled();
  });

  it('fails closed when the effects facade projection is partial or carries private fields', async () => {
    for (const payload of [
      {
        ...effectsPayload(),
        effects: { ...effectsPayload().effects, equalizer: { bandsDb: [0, 0, 0, 0] } },
      },
      {
        ...effectsPayload(),
        effects: { ...effectsPayload().effects, privatePresetId: 'secret' },
      },
      { ...effectsPayload(), revision: -1 },
    ]) {
      const setup = await createEnvironment({
        scopeMask: developerApiScopes['effects:read'],
        facadePayload: payload,
      });
      const response = await developerApiWorker.fetch(
        apiRequest(`/v1/rooms/${ROOM_CODE}/effects`),
        setup.env,
      );
      expect(response.status).toBe(503);
      expect(await errorCode(response)).toBe('INTERNAL_RESPONSE_INVALID');
    }
  });

  it.each(['participant', 'current_api_key', 'another_api_key'])(
    'returns the bounded caller-relative queue provenance %s without a raw key identifier',
    async (addedBy) => {
      const payload = {
        ...queuePayload(),
        items: [{ ...queuePayload().items[0], addedBy }],
      };
      const { env } = await createEnvironment({ facadePayload: payload });
      const response = await developerApiWorker.fetch(
        apiRequest(`/v1/rooms/${ROOM_CODE}/queue`),
        env,
      );

      expect(response.status).toBe(200);
      const value = await response.json();
      expect(value).toEqual(payload);
      expect(JSON.stringify(value)).not.toContain(KEY_ID);
    },
  );

  it('accepts missing queue provenance during a rolling deploy and rejects invalid or extra fields', async () => {
    const compatible = await createEnvironment({ facadePayload: queuePayload() });
    const compatibleResponse = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue`),
      compatible.env,
    );
    expect(compatibleResponse.status).toBe(200);
    await expect(compatibleResponse.json()).resolves.toEqual(queuePayload());

    for (const item of [
      { ...queuePayload().items[0], addedBy: KEY_ID },
      { ...queuePayload().items[0], addedBy: 'current_api_key', keyId: KEY_ID },
    ]) {
      const invalid = await createEnvironment({
        facadePayload: { ...queuePayload(), items: [item] },
      });
      const response = await developerApiWorker.fetch(
        apiRequest(`/v1/rooms/${ROOM_CODE}/queue`),
        invalid.env,
      );
      expect(response.status).toBe(503);
      const errorPayload = await response.json();
      expect(errorPayload).toMatchObject({ error: { code: 'INTERNAL_RESPONSE_INVALID' } });
      expect(JSON.stringify(errorPayload)).not.toContain(KEY_ID);
    }
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

  it.each([
    ['a weak validator', (etag: string) => `W/${etag}`],
    ['a validator list', (etag: string) => ` "unrelated" , W/${etag} `],
  ])('returns 304 when If-None-Match contains %s for the current projection', async (_, header) => {
    const { env } = await createEnvironment();
    const initial = await developerApiWorker.fetch(apiRequest(), env);
    const etag = initial.headers.get('etag');
    if (!etag) throw new Error('missing ETag');

    const response = await developerApiWorker.fetch(
      apiRequest(undefined, { headers: { 'if-none-match': header(etag) } }),
      env,
    );

    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get('etag')).toBe(etag);
  });

  it('does not match a malformed or stale If-None-Match validator', async () => {
    const { env } = await createEnvironment();
    const malformed = await developerApiWorker.fetch(
      apiRequest(undefined, { headers: { 'if-none-match': 'W/ "mxqr-room-stale"' } }),
      env,
    );
    const stale = await developerApiWorker.fetch(
      apiRequest(undefined, { headers: { 'if-none-match': 'W/"mxqr-room-stale"' } }),
      env,
    );

    expect(malformed.status).toBe(200);
    expect(stale.status).toBe(200);
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
      { scope_mask: 256 },
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

  it('keeps write routes closed in read-only mode before authentication', async () => {
    const { env, database, facadeFetch } = await createEnvironment({ mode: 'read-only' });
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/commands`, { method: 'POST' }),
      env,
    );
    expect(response.status).toBe(404);
    expect(database.first).not.toHaveBeenCalled();
    expect(facadeFetch).not.toHaveBeenCalled();
  });

  it('adds YouTube queue items through the queue-write scope and dedicated limiter', async () => {
    const setup = await createEnvironment({ scopeMask: developerApiScopes['queue:write'] });
    const item = {
      videoId: 'dQw4w9WgXcQ',
      name: 'Never Gonna Give You Up',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
    };
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.queue-add-0001',
        },
        body: JSON.stringify(item),
      }),
      setup.env,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(queuePayload());
    expect(setup.limiter.calls.map((call) => call.body.operation)).toEqual([
      'ingress-read',
      'authenticated-queue-write',
    ]);
    expect(setup.facadeFetch).toHaveBeenCalledTimes(1);
    const [input, init] = setup.facadeFetch.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/internal/v1/queue/mutate');
    expect(JSON.parse(String(init?.body))).toEqual({
      keyId: KEY_ID,
      roomCode: ROOM_CODE,
      actorName: 'Friend integration',
      idempotencyKey: 'request.queue-add-0001',
      mutation: { type: 'add_youtube', ...item },
    });

    const readOnlyKey = await createEnvironment({ scopeMask: developerApiScopes['queue:read'] });
    const forbidden = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.queue-add-0002',
        },
        body: JSON.stringify(item),
      }),
      readOnlyKey.env,
    );
    expect(forbidden.status).toBe(403);
    expect(await errorCode(forbidden)).toBe('FORBIDDEN');
    expect(readOnlyKey.facadeFetch).not.toHaveBeenCalled();
  });

  it('atomically adds a bounded YouTube batch through one queue write and audit event', async () => {
    const setup = await createEnvironment({ scopeMask: developerApiScopes['queue:write'] });
    const waits: Promise<unknown>[] = [];
    const items = [
      { videoId: 'dQw4w9WgXcQ', name: 'First', title: 'First title' },
      {
        videoId: 'M7lc1UVf-VE',
        playlistId: 'PL1234567890',
        name: 'Second',
        artist: 'Second artist',
      },
    ];
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items/batch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.queue-batch-0001',
        },
        body: JSON.stringify({ items }),
      }),
      setup.env,
      { waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(queuePayload());
    expect(setup.limiter.calls.map((call) => call.body.operation)).toEqual([
      'ingress-read',
      'authenticated-queue-write',
    ]);
    const [input, init] = setup.facadeFetch.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/internal/v1/queue/mutate');
    expect(JSON.parse(String(init?.body))).toEqual({
      keyId: KEY_ID,
      roomCode: ROOM_CODE,
      actorName: 'Friend integration',
      idempotencyKey: 'request.queue-batch-0001',
      mutation: { type: 'add_youtube_batch', items },
    });

    await Promise.all(waits);
    const auditIndex = setup.database.prepare.mock.calls.findIndex(([sql]) =>
      String(sql).includes('INSERT INTO mxqr_developer_api_audit'),
    );
    const auditStatement = setup.database.prepare.mock.results[auditIndex]?.value;
    expect(auditStatement.bind).toHaveBeenCalledWith(
      expect.stringMatching(/^req_/),
      KEY_ID,
      ROOM_CODE,
      'queue.add_youtube_batch',
      'applied',
      201,
      expect.any(Number),
    );
  });

  it('rejects an empty, oversized, malformed, or unscoped YouTube batch before forwarding', async () => {
    const invalidBodies = [
      { items: [] },
      {
        items: Array.from({ length: 101 }, (_, index) => ({
          videoId: 'dQw4w9WgXcQ',
          name: `Track ${index}`,
        })),
      },
      {
        items: Array.from({ length: 100 }, (_, index) => ({
          videoId: 'dQw4w9WgXcQ',
          name: `${index}`.padEnd(305, 'N'),
          title: 'T'.repeat(305),
        })),
      },
      {
        items: [
          { videoId: 'dQw4w9WgXcQ', name: 'Valid' },
          { videoId: 'invalid', name: 'Invalid' },
        ],
      },
      { items: [{ videoId: 'dQw4w9WgXcQ', name: 'Valid', unexpected: true }] },
    ];
    expect(new TextEncoder().encode(JSON.stringify(invalidBodies[2])).byteLength).toBeGreaterThan(
      64 * 1024,
    );
    for (const [index, body] of invalidBodies.entries()) {
      const setup = await createEnvironment({ scopeMask: developerApiScopes['queue:write'] });
      const response = await developerApiWorker.fetch(
        apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items/batch`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `request.queue-batch-invalid-${index}`,
          },
          body: JSON.stringify(body),
        }),
        setup.env,
      );
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('INVALID_REQUEST');
      expect(setup.facadeFetch).not.toHaveBeenCalled();
    }

    const unscoped = await createEnvironment({ scopeMask: developerApiScopes['queue:read'] });
    const forbidden = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items/batch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.queue-batch-unscoped',
        },
        body: JSON.stringify({
          items: [{ videoId: 'dQw4w9WgXcQ', name: 'Forbidden' }],
        }),
      }),
      unscoped.env,
    );
    expect(forbidden.status).toBe(403);
    expect(await errorCode(forbidden)).toBe('FORBIDDEN');
    expect(unscoped.facadeFetch).not.toHaveBeenCalled();
  });

  it('allows a valid near-64-KiB public batch to gain its private authentication envelope', async () => {
    const setup = await createEnvironment({ scopeMask: developerApiScopes['queue:write'] });
    const items = Array.from({ length: 100 }, (_, index) => ({
      videoId: 'dQw4w9WgXcQ',
      name: `${index}`.padEnd(304, 'N'),
      title: 'T'.repeat(304),
    }));
    const publicBody = JSON.stringify({ items });
    expect(new TextEncoder().encode(publicBody).byteLength).toBeLessThanOrEqual(64 * 1024);

    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items/batch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.queue-batch-boundary',
        },
        body: publicBody,
      }),
      setup.env,
    );
    expect(response.status).toBe(201);
    const forwarded = String(setup.facadeFetch.mock.calls[0]?.[1]?.body);
    expect(new TextEncoder().encode(forwarded).byteLength).toBeGreaterThan(64 * 1024);
  });

  it('removes and reorders queue items through canonical mutation envelopes', async () => {
    const setup = await createEnvironment({ scopeMask: developerApiScopes['queue:write'] });
    const removed = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items/${QUEUE_ITEM_ID}`, {
        method: 'DELETE',
        headers: { 'idempotency-key': 'request.queue-remove-0001' },
      }),
      setup.env,
    );
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual(queuePayload());

    const reordered = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/order`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.queue-reorder-0001',
        },
        body: JSON.stringify({ basePlaylistRevision: 4, queueItemIds: [QUEUE_ITEM_ID] }),
      }),
      setup.env,
    );
    expect(reordered.status).toBe(200);
    await expect(reordered.json()).resolves.toEqual(queuePayload());

    expect(setup.facadeFetch).toHaveBeenCalledTimes(2);
    const forwarded = setup.facadeFetch.mock.calls.map(([input, init]) => ({
      path: new URL(String(input)).pathname,
      body: JSON.parse(String(init?.body)),
    }));
    expect(forwarded).toEqual([
      {
        path: '/internal/v1/queue/mutate',
        body: {
          keyId: KEY_ID,
          roomCode: ROOM_CODE,
          idempotencyKey: 'request.queue-remove-0001',
          mutation: { type: 'remove', queueItemId: QUEUE_ITEM_ID },
        },
      },
      {
        path: '/internal/v1/queue/mutate',
        body: {
          keyId: KEY_ID,
          roomCode: ROOM_CODE,
          idempotencyKey: 'request.queue-reorder-0001',
          mutation: {
            type: 'reorder',
            basePlaylistRevision: 4,
            queueItemIds: [QUEUE_ITEM_ID],
          },
        },
      },
    ]);
  });

  it('clears the queue atomically with queue-write scope, idempotency, rate, and audit controls', async () => {
    const setup = await createEnvironment({ scopeMask: developerApiScopes['queue:write'] });
    const waits: Promise<unknown>[] = [];
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items`, {
        method: 'DELETE',
        headers: { 'idempotency-key': 'request.queue-clear-0001' },
      }),
      setup.env,
      { waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(queuePayload());
    expect(setup.limiter.calls.map((call) => call.body.operation)).toEqual([
      'ingress-read',
      'authenticated-queue-write',
    ]);
    expect(setup.facadeFetch).toHaveBeenCalledTimes(1);
    const [input, init] = setup.facadeFetch.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/internal/v1/queue/mutate');
    expect(JSON.parse(String(init?.body))).toEqual({
      keyId: KEY_ID,
      roomCode: ROOM_CODE,
      idempotencyKey: 'request.queue-clear-0001',
      mutation: { type: 'clear' },
    });

    await Promise.all(waits);
    const auditIndex = setup.database.prepare.mock.calls.findIndex(([sql]) =>
      String(sql).includes('INSERT INTO mxqr_developer_api_audit'),
    );
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    const auditStatement = setup.database.prepare.mock.results[auditIndex]?.value;
    expect(auditStatement.bind).toHaveBeenCalledWith(
      expect.stringMatching(/^req_/),
      KEY_ID,
      ROOM_CODE,
      'queue.clear',
      'applied',
      200,
      expect.any(Number),
    );
  });

  it('clears only caller-owned queue items with queue-write rate, idempotency, and audit controls', async () => {
    const payload = {
      ...queuePayload(),
      items: [{ ...queuePayload().items[0], addedBy: 'participant' }],
    };
    const setup = await createEnvironment({
      scopeMask: developerApiScopes['queue:write'],
      facadePayload: payload,
    });
    const waits: Promise<unknown>[] = [];
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items/owned`, {
        method: 'DELETE',
        headers: { 'idempotency-key': 'request.queue-clear-owned-0001' },
      }),
      setup.env,
      { waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(payload);
    expect(setup.limiter.calls.map((call) => call.body.operation)).toEqual([
      'ingress-read',
      'authenticated-queue-write',
    ]);
    expect(setup.facadeFetch).toHaveBeenCalledTimes(1);
    const [input, init] = setup.facadeFetch.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/internal/v1/queue/mutate');
    expect(JSON.parse(String(init?.body))).toEqual({
      keyId: KEY_ID,
      roomCode: ROOM_CODE,
      idempotencyKey: 'request.queue-clear-owned-0001',
      mutation: { type: 'clear_owned' },
    });
    expect(JSON.stringify(setup.facadeFetch.mock.calls)).not.toContain(API_KEY);

    await Promise.all(waits);
    const auditIndex = setup.database.prepare.mock.calls.findIndex(([sql]) =>
      String(sql).includes('INSERT INTO mxqr_developer_api_audit'),
    );
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    const auditStatement = setup.database.prepare.mock.results[auditIndex]?.value;
    expect(auditStatement.bind).toHaveBeenCalledWith(
      expect.stringMatching(/^req_/),
      KEY_ID,
      ROOM_CODE,
      'queue.clear_owned',
      'applied',
      200,
      expect.any(Number),
    );
  });

  it('preserves the stable 409 contract when an owned clear exhausts room revisions', async () => {
    const setup = await createEnvironment({
      scopeMask: developerApiScopes['queue:write'],
      facadePayload: { error: 'ROOM_STATE_CAPACITY_EXCEEDED' },
      facadeStatus: 409,
    });
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items/owned`, {
        method: 'DELETE',
        headers: { 'idempotency-key': 'request.queue-clear-owned-overflow' },
      }),
      setup.env,
    );

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('ROOM_STATE_CAPACITY_EXCEEDED');
  });

  it('fails closed for unauthorized, unscoped, rate-limited, non-idempotent, or bodyful owned clears', async () => {
    const unauthorizedSetup = await createEnvironment({
      scopeMask: developerApiScopes['queue:write'],
    });
    const unauthorized = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items/owned`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer mxqr_live_${KEY_ID}.${'C'.repeat(43)}`,
          'idempotency-key': 'request.queue-clear-owned-0002',
        },
      }),
      unauthorizedSetup.env,
    );
    expect(unauthorized.status).toBe(401);
    expect(await errorCode(unauthorized)).toBe('UNAUTHORIZED');
    expect(unauthorizedSetup.facadeFetch).not.toHaveBeenCalled();

    const noScope = await createEnvironment({ scopeMask: developerApiScopes['queue:read'] });
    const forbidden = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items/owned`, {
        method: 'DELETE',
        headers: { 'idempotency-key': 'request.queue-clear-owned-0003' },
      }),
      noScope.env,
    );
    expect(forbidden.status).toBe(403);
    expect(await errorCode(forbidden)).toBe('FORBIDDEN');
    expect(noScope.facadeFetch).not.toHaveBeenCalled();

    const missingKey = await createEnvironment({ scopeMask: developerApiScopes['queue:write'] });
    const missing = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items/owned`, { method: 'DELETE' }),
      missingKey.env,
    );
    expect(missing.status).toBe(400);
    expect(await errorCode(missing)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(missingKey.facadeFetch).not.toHaveBeenCalled();

    const bodyful = await createEnvironment({ scopeMask: developerApiScopes['queue:write'] });
    const invalidBody = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items/owned`, {
        method: 'DELETE',
        headers: {
          'content-length': '0',
          'content-type': 'application/json',
          'idempotency-key': 'request.queue-clear-owned-0004',
        },
        body: '{}',
      }),
      bodyful.env,
    );
    expect(invalidBody.status).toBe(400);
    expect(await errorCode(invalidBody)).toBe('INVALID_REQUEST');
    expect(bodyful.database.first).not.toHaveBeenCalled();
    expect(bodyful.facadeFetch).not.toHaveBeenCalled();

    const limiter = limiterNamespace({ block: (name) => name === `room:${ROOM_CODE}` });
    const rateLimited = await createEnvironment({
      scopeMask: developerApiScopes['queue:write'],
      limiter,
    });
    const limited = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items/owned`, {
        method: 'DELETE',
        headers: { 'idempotency-key': 'request.queue-clear-owned-0005' },
      }),
      rateLimited.env,
    );
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe('RATE_LIMITED');
    expect(rateLimited.facadeFetch).not.toHaveBeenCalled();
  });

  it('rejects queue clear without queue-write scope, idempotency, or an empty body', async () => {
    const noScope = await createEnvironment({ scopeMask: developerApiScopes['queue:read'] });
    const forbidden = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items`, {
        method: 'DELETE',
        headers: { 'idempotency-key': 'request.queue-clear-0002' },
      }),
      noScope.env,
    );
    expect(forbidden.status).toBe(403);
    expect(await errorCode(forbidden)).toBe('FORBIDDEN');
    expect(noScope.facadeFetch).not.toHaveBeenCalled();

    const missingIdempotency = await createEnvironment({
      scopeMask: developerApiScopes['queue:write'],
    });
    const missing = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items`, { method: 'DELETE' }),
      missingIdempotency.env,
    );
    expect(missing.status).toBe(400);
    expect(await errorCode(missing)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(missingIdempotency.facadeFetch).not.toHaveBeenCalled();

    const withBody = await createEnvironment({ scopeMask: developerApiScopes['queue:write'] });
    const invalidBody = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items`, {
        method: 'DELETE',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.queue-clear-0003',
        },
        body: '{}',
      }),
      withBody.env,
    );
    expect(invalidBody.status).toBe(400);
    expect(await errorCode(invalidBody)).toBe('INVALID_REQUEST');
    expect(withBody.database.first).not.toHaveBeenCalled();
    expect(withBody.facadeFetch).not.toHaveBeenCalled();

    const forgedLength = await createEnvironment({
      scopeMask: developerApiScopes['queue:write'],
    });
    const forgedLengthBody = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items`, {
        method: 'DELETE',
        headers: {
          'content-length': '0',
          'content-type': 'application/json',
          'idempotency-key': 'request.queue-clear-0004',
        },
        body: '{}',
      }),
      forgedLength.env,
    );
    expect(forgedLengthBody.status).toBe(400);
    expect(await errorCode(forgedLengthBody)).toBe('INVALID_REQUEST');
    expect(forgedLength.database.first).not.toHaveBeenCalled();
    expect(forgedLength.facadeFetch).not.toHaveBeenCalled();

    const emptyStream = await createEnvironment({
      scopeMask: developerApiScopes['queue:write'],
    });
    const zeroByteStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const emptyStreamResponse = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items`, {
        method: 'DELETE',
        headers: {
          'content-length': '0',
          'idempotency-key': 'request.queue-clear-0005',
        },
        body: zeroByteStream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      emptyStream.env,
    );
    expect(emptyStreamResponse.status).toBe(200);
    expect(emptyStream.facadeFetch).toHaveBeenCalledTimes(1);
  });

  it('reserves and completes direct uploads through media and queue scopes without proxying bytes', async () => {
    const setup = await createEnvironment({
      scopeMask: developerApiScopes['media:upload'] | developerApiScopes['queue:write'],
    });
    const media = {
      name: 'Orchestra.flac',
      byteLength: 4_096,
      mime: 'audio/flac',
      title: 'Orchestra',
    };
    const reserved = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/media/uploads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.upload-reserve-0001',
        },
        body: JSON.stringify(media),
      }),
      setup.env,
    );
    expect(reserved.status).toBe(201);
    await expect(reserved.json()).resolves.toEqual(uploadPayload());
    expect(uploadPayload().upload.headers['content-length']).toBe(String(media.byteLength));

    const completed = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/media/uploads/${ASSET_ID}/complete`, {
        method: 'POST',
        headers: { 'idempotency-key': 'request.upload-complete-0001' },
      }),
      setup.env,
    );
    expect(completed.status).toBe(201);
    await expect(completed.json()).resolves.toEqual(uploadCompletionPayload());
    expect(setup.limiter.calls.map((call) => call.body.operation)).toEqual([
      'ingress-read',
      'authenticated-media-upload-create',
      'ingress-read',
      'authenticated-media-upload-complete',
    ]);

    expect(setup.facadeFetch).toHaveBeenCalledTimes(2);
    const forwarded = setup.facadeFetch.mock.calls.map(([input, init]) => ({
      path: new URL(String(input)).pathname,
      body: JSON.parse(String(init?.body)),
    }));
    expect(forwarded).toEqual([
      {
        path: '/internal/v1/media/uploads/create',
        body: {
          keyId: KEY_ID,
          roomCode: ROOM_CODE,
          idempotencyKey: 'request.upload-reserve-0001',
          media,
        },
      },
      {
        path: '/internal/v1/media/uploads/complete',
        body: {
          keyId: KEY_ID,
          roomCode: ROOM_CODE,
          actorName: 'Friend integration',
          idempotencyKey: 'request.upload-complete-0001',
          assetId: ASSET_ID,
        },
      },
    ]);

    const queueOnlyKey = await createEnvironment({ scopeMask: developerApiScopes['queue:write'] });
    const forbidden = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/media/uploads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.upload-reserve-0002',
        },
        body: JSON.stringify(media),
      }),
      queueOnlyKey.env,
    );
    expect(forbidden.status).toBe(403);
    expect(await errorCode(forbidden)).toBe('FORBIDDEN');
    expect(queueOnlyKey.facadeFetch).not.toHaveBeenCalled();

    const mediaOnlyKey = await createEnvironment({ scopeMask: developerApiScopes['media:upload'] });
    const mediaOnlyForbidden = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/media/uploads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.upload-reserve-0003',
        },
        body: JSON.stringify(media),
      }),
      mediaOnlyKey.env,
    );
    expect(mediaOnlyForbidden.status).toBe(403);
    expect(await errorCode(mediaOnlyForbidden)).toBe('FORBIDDEN');
    expect(mediaOnlyKey.facadeFetch).not.toHaveBeenCalled();
  });

  it('requires idempotency for every queue and upload mutation', async () => {
    const queue = await createEnvironment({ scopeMask: developerApiScopes['queue:write'] });
    const missingQueueKey = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/queue/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId: 'dQw4w9WgXcQ', name: 'Track' }),
      }),
      queue.env,
    );
    expect(missingQueueKey.status).toBe(400);
    expect(await errorCode(missingQueueKey)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(queue.facadeFetch).not.toHaveBeenCalled();

    const media = await createEnvironment({
      scopeMask: developerApiScopes['media:upload'] | developerApiScopes['queue:write'],
    });
    const missingCompletionKey = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/media/uploads/${ASSET_ID}/complete`, {
        method: 'POST',
      }),
      media.env,
    );
    expect(missingCompletionKey.status).toBe(400);
    expect(await errorCode(missingCompletionKey)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(media.facadeFetch).not.toHaveBeenCalled();
  });

  it('marks an incomplete direct upload as retryable with a short retry hint', async () => {
    const setup = await createEnvironment({
      scopeMask: developerApiScopes['media:upload'] | developerApiScopes['queue:write'],
      facadePayload: { error: 'UPLOAD_INCOMPLETE' },
      facadeStatus: 409,
    });
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/media/uploads/${ASSET_ID}/complete`, {
        method: 'POST',
        headers: { 'idempotency-key': 'request.upload-complete-retry' },
      }),
      setup.env,
    );
    expect(response.status).toBe(409);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UPLOAD_INCOMPLETE', retryable: true },
    });
  });

  it('creates an allowlisted playback command with idempotency, rate, and audit controls', async () => {
    const setup = await createEnvironment({
      mode: 'enabled',
      scopeMask: developerApiScopes['playback:control'],
    });
    const waits: Promise<unknown>[] = [];
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ type: 'seek', positionSeconds: 42.5 }),
      }),
      setup.env,
      { waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(commandPayload());
    expect(setup.limiter.calls.map((call) => call.body.operation)).toEqual([
      'ingress-read',
      'authenticated-command',
    ]);
    expect(setup.facadeFetch).toHaveBeenCalledTimes(1);
    const [input, init] = setup.facadeFetch.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/internal/v1/commands/create');
    expect(JSON.parse(String(init?.body))).toEqual({
      keyId: KEY_ID,
      roomCode: ROOM_CODE,
      idempotencyKey: IDEMPOTENCY_KEY,
      command: { type: 'seek', positionSeconds: 42.5 },
    });
    expect(JSON.stringify(init)).not.toContain(API_KEY);
    await Promise.all(waits);
    expect(setup.database.run).toHaveBeenCalledTimes(2);
  });

  it('creates a partial effects command with effects:control without granting playback control', async () => {
    const setup = await createEnvironment({
      mode: 'enabled',
      scopeMask: developerApiScopes['effects:control'],
    });
    const command = {
      type: 'set_effects',
      effects: {
        reverb: { mixPercent: 35, preDelaySeconds: 0.2 },
        equalizer: { bandsDb: [-12, -6, 0, 6, 12] },
        virtualBass: { strengthPercent: 75 },
        virtualSurround: { widthPercent: 200 },
      },
    };
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        body: JSON.stringify(command),
      }),
      setup.env,
    );

    expect(response.status).toBe(202);
    const [, init] = setup.facadeFetch.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      keyId: KEY_ID,
      roomCode: ROOM_CODE,
      idempotencyKey: IDEMPOTENCY_KEY,
      command,
    });

    const playback = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'request.playback-with-effects-key',
        },
        body: JSON.stringify({ type: 'play' }),
      }),
      setup.env,
    );
    expect(playback.status).toBe(403);
  });

  it('keeps playback and effects command scopes independent', async () => {
    const playbackOnly = await createEnvironment({
      mode: 'enabled',
      scopeMask: developerApiScopes['playback:control'],
    });
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({
          type: 'set_effects',
          effects: { virtualBass: { strengthPercent: 50 } },
        }),
      }),
      playbackOnly.env,
    );
    expect(response.status).toBe(403);
    expect(playbackOnly.facadeFetch).not.toHaveBeenCalled();
  });

  it('rejects empty, out-of-range, incomplete, and extra effects command fields', async () => {
    const invalidCommands = [
      { type: 'set_effects', effects: {} },
      { type: 'set_effects', effects: { reverb: {} } },
      { type: 'set_effects', effects: { reverb: { decaySeconds: 0.09 } } },
      { type: 'set_effects', effects: { reverb: { preDelaySeconds: 1.01 } } },
      { type: 'set_effects', effects: { equalizer: { bandsDb: [0, 0, 0, 0] } } },
      { type: 'set_effects', effects: { equalizer: { bandsDb: [0, 0, 0, 0, 12.1] } } },
      { type: 'set_effects', effects: { virtualBass: { strengthPercent: -1 } } },
      { type: 'set_effects', effects: { virtualSurround: { widthPercent: 201 } } },
      {
        type: 'set_effects',
        effects: { virtualBass: { strengthPercent: 50, privatePreset: true } },
      },
      {
        type: 'set_effects',
        effects: { virtualBass: { strengthPercent: 50 } },
        unexpected: true,
      },
    ];
    for (const command of invalidCommands) {
      const setup = await createEnvironment({
        mode: 'enabled',
        scopeMask: developerApiScopes['effects:control'],
      });
      const response = await developerApiWorker.fetch(
        apiRequest(`/v1/rooms/${ROOM_CODE}/commands`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': IDEMPOTENCY_KEY,
          },
          body: JSON.stringify(command),
        }),
        setup.env,
      );
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('INVALID_REQUEST');
      expect(setup.facadeFetch).not.toHaveBeenCalled();
    }
  });

  it('returns the canonical terminal result when an accepted command response was lost', async () => {
    const setup = await createEnvironment({
      mode: 'enabled',
      scopeMask: developerApiScopes['playback:control'],
      facadePayload: commandPayload('applied'),
    });
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ type: 'play' }),
      }),
      setup.env,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(commandPayload('applied'));
  });

  it('accepts only exact public command bodies and UUID v4 queue item identities', async () => {
    const invalidCommands = [
      { type: 'play', expectedQueueItemId: QUEUE_ITEM_ID },
      { type: 'pause', extra: true },
      { type: 'seek' },
      { type: 'seek', positionSeconds: 604_801 },
      { type: 'play_item', queueItemId: 'queue_item_000001' },
    ];
    for (const command of invalidCommands) {
      const setup = await createEnvironment({
        mode: 'enabled',
        scopeMask: developerApiScopes['playback:control'],
      });
      const response = await developerApiWorker.fetch(
        apiRequest(`/v1/rooms/${ROOM_CODE}/commands`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': IDEMPOTENCY_KEY,
          },
          body: JSON.stringify(command),
        }),
        setup.env,
      );
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('INVALID_REQUEST');
      expect(setup.facadeFetch).not.toHaveBeenCalled();
    }

    const valid = await createEnvironment({
      mode: 'enabled',
      scopeMask: developerApiScopes['playback:control'],
    });
    const accepted = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ type: 'play_item', queueItemId: QUEUE_ITEM_ID }),
      }),
      valid.env,
    );
    expect(accepted.status).toBe(202);
  });

  it('requires a bounded Idempotency-Key and a body no larger than 1 KiB', async () => {
    for (const headers of [
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', 'idempotency-key': 'short' },
    ]) {
      const setup = await createEnvironment({
        mode: 'enabled',
        scopeMask: developerApiScopes['playback:control'],
      });
      const response = await developerApiWorker.fetch(
        apiRequest(`/v1/rooms/${ROOM_CODE}/commands`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ type: 'play' }),
        }),
        setup.env,
      );
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe(
        'idempotency-key' in headers ? 'INVALID_REQUEST' : 'IDEMPOTENCY_KEY_REQUIRED',
      );
    }

    const oversized = await createEnvironment({
      mode: 'enabled',
      scopeMask: developerApiScopes['playback:control'],
    });
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ type: 'play', padding: 'x'.repeat(1_100) }),
      }),
      oversized.env,
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('INVALID_REQUEST');
    expect(oversized.facadeFetch).not.toHaveBeenCalled();
  });

  it('delegates command ownership to the facade and permits status reads in read-only mode', async () => {
    const setup = await createEnvironment({
      mode: 'read-only',
      scopeMask: developerApiScopes['effects:read'],
    });
    const response = await developerApiWorker.fetch(
      apiRequest(`/v1/rooms/${ROOM_CODE}/commands/${COMMAND_ID}`),
      setup.env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(commandPayload('applied'));
    const [input, init] = setup.facadeFetch.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/internal/v1/commands/status');
    await expect(Promise.resolve(JSON.parse(String(init?.body)))).resolves.toEqual({
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      commandId: COMMAND_ID,
    });
    expect(setup.limiter.calls[1]?.body.operation).toBe('authenticated-read');
  });

  it('rejects arbitrary browser origins without emitting CORS headers', async () => {
    const cases: Array<{
      setup: Awaited<ReturnType<typeof createEnvironment>>;
      path?: string;
      options: RequestInit;
    }> = [
      { setup: await createEnvironment(), path: undefined, options: {} },
      {
        setup: await createEnvironment({ scopeMask: developerApiScopes['queue:write'] }),
        path: `/v1/rooms/${ROOM_CODE}/queue/items`,
        options: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'request.browser-write-0001',
          },
          body: JSON.stringify({ videoId: 'dQw4w9WgXcQ', name: 'Track' }),
        },
      },
    ];
    for (const entry of cases) {
      const headers = new Headers(entry.options.headers);
      headers.set('origin', 'https://attacker.example');
      const response = await developerApiWorker.fetch(
        apiRequest(entry.path, { ...entry.options, headers }),
        entry.setup.env,
      );
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('BROWSER_ORIGIN_FORBIDDEN');
      expect(response.headers.has('access-control-allow-origin')).toBe(false);
      expect(entry.setup.database.first).not.toHaveBeenCalled();
      expect(entry.setup.facadeFetch).not.toHaveBeenCalled();
    }
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

  it('applies atomic playback-control limits per key and room', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    const storage = new FakeStorage();
    const limiter = new DeveloperApiRateLimiter({ storage } as never);
    const request = () =>
      new Request('https://developer-api-rate.internal/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'authenticated-command', keyId: KEY_ID }),
      });

    for (let index = 0; index < 30; index += 1) {
      const allowed = await limiter.fetch(request());
      expect(await allowed.json()).toMatchObject({ allowed: true });
    }
    const blocked = await limiter.fetch(request());
    expect(await blocked.json()).toMatchObject({
      allowed: false,
      limit: 30,
      retryAfterSeconds: 60,
    });
    const stored = storage.values.get('buckets') as Record<string, { count: number }>;
    expect(stored[`key:${KEY_ID}:playback-control`]?.count).toBe(30);
    expect(stored['room:playback-control']?.count).toBe(30);
  });

  it('applies independent atomic limits to queue writes and media uploads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    for (const policy of [
      {
        operation: 'authenticated-queue-write',
        keyBucket: `key:${KEY_ID}:queue-write`,
        roomBucket: 'room:queue-write',
        keyLimit: 10,
        roomLimit: 30,
        retryAfterSeconds: 60,
      },
      {
        operation: 'authenticated-media-upload-create',
        keyBucket: `key:${KEY_ID}:media-upload`,
        roomBucket: 'room:media-upload',
        keyLimit: 10,
        roomLimit: 30,
        retryAfterSeconds: 3_600,
      },
      {
        operation: 'authenticated-media-upload-complete',
        keyBucket: `key:${KEY_ID}:media-upload-complete`,
        roomBucket: 'room:media-upload-complete',
        keyLimit: 30,
        roomLimit: 90,
        retryAfterSeconds: 3_600,
      },
    ]) {
      const storage = new FakeStorage();
      const limiter = new DeveloperApiRateLimiter({ storage } as never);
      const request = () =>
        new Request('https://developer-api-rate.internal/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operation: policy.operation, keyId: KEY_ID }),
        });

      for (let index = 0; index < policy.keyLimit; index += 1) {
        const allowed = await limiter.fetch(request());
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toMatchObject({
          allowed: true,
          limit: policy.keyLimit,
        });
      }
      const blocked = await limiter.fetch(request());
      expect(await blocked.json()).toMatchObject({
        allowed: false,
        limit: policy.keyLimit,
        retryAfterSeconds: policy.retryAfterSeconds,
      });
      const stored = storage.values.get('buckets') as Record<
        string,
        { count: number; limit: number }
      >;
      expect(stored[policy.keyBucket]).toMatchObject({
        count: policy.keyLimit,
        limit: policy.keyLimit,
      });
      expect(stored[policy.roomBucket]).toMatchObject({
        count: policy.keyLimit,
        limit: policy.roomLimit,
      });
    }
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
