import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MusixquareProRoom,
  issueProRoomActivationClaim,
  issueProRoomOwnerRecoveryClaim,
  default as proRoomWorker,
} from '../../../cloudflare/pro-room-worker.js';
import developerApiFacadeWorker from '../../../cloudflare/developer-api-facade-worker.js';
import developerApiWorker, {
  deriveDeveloperApiKeyDigest,
  developerApiScopes,
} from '../../../cloudflare/developer-api-worker.js';
import { MAX_SYSTEM_AUDIO_DEVICES, SYSTEM_AUDIO_SHARE_LIMIT_MS } from '../../core/constants.ts';
import { parseProRoomSnapshot } from '../snapshot.ts';

afterEach(() => {
  vi.useRealTimers();
});

const ROOM_CODE = '000001';
const BASE_URL = `https://pro.musixquare.com/v1/rooms/${ROOM_CODE}`;
const ACTIVATION_SECRET = 'activation-secret-'.padEnd(48, 'a');
const PIN_PEPPER = 'pin-pepper-'.padEnd(48, 'p');
const SESSION_SECRET = 'session-secret-'.padEnd(48, 's');
const SIGNALING_SECRET = 'signaling-secret-'.padEnd(48, 'g');
const R2_ACCOUNT_ID = '01353882e4eea3a5acaa0c45e8336af4';
const IDEMPOTENCY_KEY = '018f977e-5df5-7c8f-bb80-55d847ddec0f';
const DEVELOPER_KEY_ID = 'D'.repeat(16);
const presenceByCookie = new Map<
  string,
  { participantId: string; presenceIncarnationId: string }
>();

type StoredRoom = {
  revision: number;
  playlist: unknown[];
  pin: {
    salt: string;
    iterations: number;
    hash: string;
  } | null;
  quota: {
    limitBytes: number;
    perAssetLimitBytes: number;
    usedBytes: number;
    reservedBytes: number;
  };
  assets: Record<
    string,
    {
      status: 'reserved' | 'ready';
      assetId: string;
      objectKey: string;
      stagingObjectKey: string;
      version: number;
      byteLength: number;
      mime: string;
      sha256?: string;
      expiresAtMs?: number;
      gcAfterMs?: number;
      stagingCleanupAfterMs?: number;
    }
  >;
};

class FakeStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;

  async get(key: string): Promise<unknown> {
    return structuredClone(this.data.get(key));
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async setAlarm(value: number): Promise<void> {
    this.alarm = value;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

class FakeState {
  readonly storage = new FakeStorage();
}

class FakeR2Bucket {
  readonly objects = new Map<string, any>();
  readonly deleted: string[] = [];
  deleteError: Error | null = null;

  async list(options: { prefix?: string; limit?: number } = {}): Promise<unknown> {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    const objects = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((key) => ({ key }));
    return { objects, truncated: objects.length === limit };
  }

  async head(key: string): Promise<unknown> {
    return structuredClone(this.objects.get(key)) ?? null;
  }

  async get(key: string): Promise<unknown> {
    const object = this.objects.get(key);
    return object ? { ...structuredClone(object), body: { size: object.size } } : null;
  }

  async put(
    key: string,
    body: { size?: number },
    options: { httpMetadata?: unknown; customMetadata?: unknown },
  ): Promise<void> {
    this.objects.set(key, {
      size: body.size ?? 0,
      httpMetadata: structuredClone(options.httpMetadata),
      customMetadata: structuredClone(options.customMetadata),
    });
  }

  async delete(key: string | string[]): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    for (const item of Array.isArray(key) ? key : [key]) {
      this.deleted.push(item);
      this.objects.delete(item);
    }
  }
}

function environment(bucket = new FakeR2Bucket()) {
  return {
    PRO_ROOM_ACTIVATION_SECRET: ACTIVATION_SECRET,
    PRO_ROOM_PIN_PEPPER: PIN_PEPPER,
    PRO_ROOM_SESSION_SECRET: SESSION_SECRET,
    PRO_SIGNALING_SECRET: SIGNALING_SECRET,
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key'.padEnd(40, 'k'),
    R2_BUCKET_NAME: 'musixquare-pro-media',
    PRO_MEDIA_BUCKET: bucket,
  };
}

function request(path: string, init: RequestInit = {}, cookie?: string): Request {
  return requestForRoom(ROOM_CODE, path, init, cookie);
}

describe('PRO room Worker health', () => {
  it('publishes the exact deployed Worker version for release readiness checks', async () => {
    const response = await proRoomWorker.fetch(new Request('https://pro.musixquare.com/health'), {
      ...environment(),
      CF_VERSION_METADATA: { id: 'pro-version-123' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: 'musixquare-pro-room',
      workerVersionId: 'pro-version-123',
    });
  });
});

function requestWithPresence(
  path: string,
  init: RequestInit,
  cookie: string,
  identity: { participantId: string; presenceIncarnationId: string },
): Request {
  const result = request(path, init, cookie);
  result.headers.set('x-mxqr-pro-participant-id', identity.participantId);
  result.headers.set('x-mxqr-pro-presence-incarnation', identity.presenceIncarnationId);
  return result;
}

function requestForRoom(
  roomCode: string,
  path: string,
  init: RequestInit = {},
  cookie?: string,
): Request {
  const headers = new Headers(init.headers);
  headers.set('x-mxqr-pro-room-code', roomCode);
  headers.set('x-mxqr-pro-ip-hash', 'hashed-client-address');
  if (cookie) headers.set('cookie', cookie);
  const presence = cookie ? presenceByCookie.get(cookie) : null;
  if (presence) {
    headers.set('x-mxqr-pro-participant-id', presence.participantId);
    headers.set('x-mxqr-pro-presence-incarnation', presence.presenceIncarnationId);
  }
  return new Request(`https://pro.musixquare.com/v1/rooms/${roomCode}${path}`, {
    ...init,
    headers,
  });
}

function jsonRequest(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: unknown,
  cookie?: string,
  idempotencyKey?: string,
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
  return request(path, { method, headers, body: JSON.stringify(body) }, cookie);
}

function unloadCloseRequest(
  body: Record<string, unknown>,
  cookie: string | undefined,
  key: string,
): Request {
  return request(
    '/presence/close',
    {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ idempotencyKey: key, ...body }),
    },
    cookie,
  );
}

function fencedSessionCloseRequest(
  body: Record<string, unknown>,
  cookie: string | undefined,
): Request {
  return request(
    '/sessions/current/close',
    {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(body),
    },
    cookie,
  );
}

function jsonRequestForRoom(
  roomCode: string,
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: unknown,
  cookie?: string,
  idempotencyKey?: string,
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
  return requestForRoom(roomCode, path, { method, headers, body: JSON.stringify(body) }, cookie);
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('missing session cookie');
  return setCookie.split(';')[0] ?? '';
}

function bindCookiePresence(cookie: string, envelope: Record<string, any>): void {
  const viewer = envelope.snapshot?.viewer;
  if (!viewer) throw new Error('missing viewer presence identity');
  presenceByCookie.set(cookie, {
    participantId: viewer.participantId,
    presenceIncarnationId: viewer.presenceIncarnationId,
  });
}

async function activatedRoom() {
  const state = new FakeState();
  const bucket = new FakeR2Bucket();
  const worker = new MusixquareProRoom(state as never, environment(bucket) as never);
  const claimToken = await issueProRoomActivationClaim(ROOM_CODE, ACTIVATION_SECRET, {
    nowMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 60_000,
    nonce: 'fixed-activation-nonce',
  });
  const activation = await worker.fetch(
    jsonRequest('/activation', 'POST', {
      claimToken,
      temporaryPin: '00000001',
      newPin: '12345678',
      ownerName: 'Owner',
    }),
  );
  expect(activation.status).toBe(200);
  const ownerCookie = cookieFrom(activation);
  const ownerRecoveryCookie = activation.headers
    .getSetCookie()
    .find((value) => value.startsWith(`__Host-mxqr_pro_owner_${ROOM_CODE}=`))
    ?.split(';')[0];
  expect(ownerRecoveryCookie).toBeTruthy();
  const activationEnvelope = await responseJson(activation);
  bindCookiePresence(ownerCookie, activationEnvelope);
  expect(Object.keys(activationEnvelope)).toEqual(['snapshot']);
  return {
    worker,
    state,
    bucket,
    ownerCookie,
    ownerRecoveryCookie: ownerRecoveryCookie!,
    activationEnvelope,
  };
}

async function completeReadyAsset(
  context: Awaited<ReturnType<typeof activatedRoom>>,
  suffix: string,
  byteLength = 4096,
) {
  const reservationResponse = await context.worker.fetch(
    jsonRequest(
      '/media/reservations',
      'POST',
      { byteLength, name: `${suffix}.flac`, mime: 'audio/flac' },
      context.ownerCookie,
      `${IDEMPOTENCY_KEY}-${suffix}-reserve`,
    ),
  );
  expect(reservationResponse.status).toBe(200);
  const reservationEnvelope = await responseJson(reservationResponse);
  const assetId = reservationEnvelope.reservation.assetId as string;
  const internal = context.worker as unknown as { room: StoredRoom };
  const asset = internal.room.assets[assetId]!;
  context.bucket.objects.set(asset.stagingObjectKey, {
    size: asset.byteLength,
    httpMetadata: { contentType: asset.mime },
    customMetadata: {
      'mxqr-room': ROOM_CODE,
      'mxqr-asset': asset.assetId,
      'mxqr-version': String(asset.version),
      'mxqr-bytes': String(asset.byteLength),
    },
  });
  const completeResponse = await context.worker.fetch(
    request(
      `/media/${assetId}/complete`,
      { method: 'POST', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-${suffix}-complete` } },
      context.ownerCookie,
    ),
  );
  expect(completeResponse.status).toBe(200);
  const completeEnvelope = await responseJson(completeResponse);
  return { assetId, asset, completeEnvelope };
}

async function replacePlaylist(
  context: Awaited<ReturnType<typeof activatedRoom>>,
  playlist: unknown[],
  suffix: string,
) {
  const current = await responseJson(
    await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
  );
  return context.worker.fetch(
    jsonRequest(
      '/snapshot',
      'PUT',
      {
        baseRevision: current.snapshot.revision,
        playlist,
        currentQueueItemId: null,
        playback: {
          coordinatorEpoch: current.snapshot.presence.coordinatorEpoch,
          revision: current.snapshot.playback.revision,
          state: 'idle',
          queueItemId: null,
          positionSeconds: 0,
          updatedAtMs: Date.now(),
          youtubeVideoId: null,
          youtubeSubIndex: null,
        },
      },
      context.ownerCookie,
      `${IDEMPOTENCY_KEY}-${suffix}-snapshot`,
    ),
  );
}

function playlistItem(
  queueItemId: string,
  asset: StoredRoom['assets'][string],
): Record<string, unknown> {
  return {
    queueItemId,
    name: 'Shared asset',
    source: {
      kind: 'pro-r2',
      assetId: asset.assetId,
      version: asset.version,
      byteLength: asset.byteLength,
      mime: asset.mime,
      ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
    },
  };
}

function internalDeveloperRead(
  worker: MusixquareProRoom,
  projection: 'room' | 'playback' | 'queue' | 'effects',
  keyId = DEVELOPER_KEY_ID,
): Promise<Response> {
  return worker.fetch(
    new Request('https://pro-room.internal/internal/developer/v1/read', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
      },
      body: JSON.stringify({ projection, keyId }),
    }),
  );
}

async function preparedDeveloperCommandRoom(
  dispatchFetch = vi.fn(async () => Response.json({ dispatched: true })),
) {
  const context = await activatedRoom();
  const internal = context.worker as unknown as {
    env: Record<string, any>;
    room: Record<string, any>;
  };
  internal.env.PRO_SIGNALING_ROOMS = {
    idFromName: vi.fn((value: string) => value),
    get: vi.fn(() => ({ fetch: dispatchFetch })),
  };
  const queueItemId = '44444444-4444-4444-8444-444444444444';
  internal.room.playlistRevision = 2;
  internal.room.playlist = [
    {
      queueItemId,
      name: 'Developer API test',
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    },
  ];
  internal.room.currentQueueItemId = queueItemId;
  internal.room.playback = {
    coordinatorEpoch: context.activationEnvelope.snapshot.presence.coordinatorEpoch,
    revision: 4,
    state: 'paused',
    queueItemId,
    positionSeconds: 8,
    updatedAtMs: Date.now(),
    youtubeVideoId: 'dQw4w9WgXcQ',
    youtubeSubIndex: 0,
  };
  const capability = await context.worker.fetch(
    jsonRequest('/signaling-tickets', 'POST', { developerControlVersion: 1 }, context.ownerCookie),
  );
  expect(capability.status).toBe(200);
  return { ...context, dispatchFetch, internal, queueItemId };
}

function createInternalDeveloperCommand(
  worker: MusixquareProRoom,
  keyId: string,
  idempotencyKey: string,
  command: Record<string, unknown>,
): Promise<Response> {
  return worker.fetch(
    new Request('https://pro-room.internal/internal/developer/v1/commands/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
      },
      body: JSON.stringify({ roomCode: ROOM_CODE, keyId, idempotencyKey, command }),
    }),
  );
}

function mutateInternalDeveloperQueue(
  worker: MusixquareProRoom,
  keyId: string,
  idempotencyKey: string,
  mutation: Record<string, unknown>,
  actorName?: string,
): Promise<Response> {
  return worker.fetch(
    new Request('https://pro-room.internal/internal/developer/v1/queue/mutate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
      },
      body: JSON.stringify({
        roomCode: ROOM_CODE,
        keyId,
        ...(actorName === undefined ? {} : { actorName }),
        idempotencyKey,
        mutation,
      }),
    }),
  );
}

function createInternalDeveloperUpload(
  worker: MusixquareProRoom,
  keyId: string,
  idempotencyKey: string,
  media: Record<string, unknown>,
): Promise<Response> {
  return worker.fetch(
    new Request('https://pro-room.internal/internal/developer/v1/media/uploads/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
      },
      body: JSON.stringify({ roomCode: ROOM_CODE, keyId, idempotencyKey, media }),
    }),
  );
}

function completeInternalDeveloperUpload(
  worker: MusixquareProRoom,
  keyId: string,
  idempotencyKey: string,
  assetId: string,
  actorName?: string,
): Promise<Response> {
  return worker.fetch(
    new Request('https://pro-room.internal/internal/developer/v1/media/uploads/complete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
      },
      body: JSON.stringify({
        roomCode: ROOM_CODE,
        keyId,
        idempotencyKey,
        assetId,
        ...(actorName === undefined ? {} : { actorName }),
      }),
    }),
  );
}

describe('PRO room private Developer API projections', () => {
  it('exposes only bounded room, playback, and queue fields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T01:00:00.000Z'));
    const { worker, activationEnvelope } = await activatedRoom();
    const internal = worker as unknown as {
      room: {
        revision: number;
        playlistRevision: number;
        playlist: Array<Record<string, any>>;
        currentQueueItemId: string | null;
        playback: Record<string, any>;
        assets: Record<string, Record<string, any>>;
        ownerMemberId: string;
      };
    };
    const queueItemId = '11111111-1111-4111-8111-111111111111';
    const assetId = 'asset_018f977e5df57c8f';
    internal.room.revision = 9;
    internal.room.playlistRevision = 4;
    internal.room.playlist = [
      {
        queueItemId,
        name: 'Private Orchestra.flac',
        title: 'Orchestra',
        artist: 'Private Artist',
        source: {
          kind: 'pro-r2',
          assetId,
          version: 1,
          byteLength: 1_024,
          mime: 'audio/flac',
        },
      },
    ];
    internal.room.currentQueueItemId = queueItemId;
    internal.room.playback = {
      coordinatorEpoch: activationEnvelope.snapshot.presence.coordinatorEpoch,
      revision: 3,
      state: 'playing',
      queueItemId,
      positionSeconds: 10,
      updatedAtMs: Date.now() - 2_000,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    };
    internal.room.assets[assetId] = {
      status: 'ready',
      assetId,
      objectKey: 'rooms/000001/private-object.flac',
      stagingObjectKey: 'staging/000001/private-object.flac',
      version: 1,
      byteLength: 1_024,
      mime: 'audio/flac',
    };
    internal.room.ownerMemberId = 'private-owner-member-id';

    const room = await responseJson(await internalDeveloperRead(worker, 'room'));
    expect(room).toEqual({
      schemaVersion: 1,
      view: 'room',
      roomCode: ROOM_CODE,
      status: 'active',
      runtime: 'awake',
      revision: 9,
      participantCount: 1,
      controlAvailable: false,
      quota: {
        limitBytes: 1_073_741_824,
        perAssetLimitBytes: 209_715_200,
        usedBytes: 0,
        reservedBytes: 0,
      },
    });

    const playback = await responseJson(await internalDeveloperRead(worker, 'playback'));
    expect(playback).toEqual({
      schemaVersion: 1,
      view: 'playback',
      roomCode: ROOM_CODE,
      revision: 3,
      playlistRevision: 4,
      state: 'playing',
      queueItemId,
      positionSeconds: 12,
      observedAtMs: Date.now(),
      item: {
        queueItemId,
        kind: 'audio',
        name: 'Private Orchestra.flac',
        addedBy: 'participant',
        title: 'Orchestra',
        artist: 'Private Artist',
        byteLength: 1_024,
      },
    });

    const queue = await responseJson(await internalDeveloperRead(worker, 'queue'));
    expect(queue).toEqual({
      schemaVersion: 1,
      view: 'queue',
      roomCode: ROOM_CODE,
      playlistRevision: 4,
      currentQueueItemId: queueItemId,
      items: [playback.item],
    });
    const serialized = JSON.stringify({ room, playback, queue });
    for (const privateValue of [
      assetId,
      'objectKey',
      'stagingObjectKey',
      'private-owner-member-id',
      activationEnvelope.snapshot.viewer.participantId,
      activationEnvelope.snapshot.viewer.displayName,
      'source',
      'mime',
    ]) {
      expect(serialized).not.toContain(String(privateValue));
    }
    vi.useRealTimers();
  });

  it('composes the public API through the private facade into a real PRO room projection', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as {
      room: {
        playlistRevision: number;
        playlist: Array<Record<string, any>>;
        currentQueueItemId: string | null;
      };
    };
    const queueItemId = '33333333-3333-4333-8333-333333333333';
    internal.room.playlistRevision = 5;
    internal.room.playlist = [
      {
        queueItemId,
        name: 'Facade Orchestra.flac',
        title: 'Facade Orchestra',
        source: {
          kind: 'pro-r2',
          assetId: 'private-composed-asset',
          version: 1,
          byteLength: 4_096,
          mime: 'audio/flac',
        },
      },
    ];
    internal.room.currentQueueItemId = queueItemId;

    const keyId = 'C'.repeat(16);
    const keySecret = 'D'.repeat(43);
    const pepper = 'developer-api-pepper'.padEnd(48, 'p');
    const nowMs = Date.now();
    const secretDigest = await deriveDeveloperApiKeyDigest(pepper, keyId, keySecret);
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => ({
            key_id: keyId,
            room_code: ROOM_CODE,
            label: 'Composed API',
            secret_digest: secretDigest,
            digest_version: 1,
            scope_mask:
              developerApiScopes['room:read'] |
              developerApiScopes['playback:read'] |
              developerApiScopes['queue:read'],
            status: 'active',
            created_at: nowMs - 1_000,
            updated_at: nowMs - 1_000,
            expires_at: nowMs + 86_400_000,
            revoked_at: null,
          })),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        })),
      })),
    };
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        fetch: vi.fn(async () =>
          Response.json({
            allowed: true,
            limit: 60,
            remaining: 59,
            resetAtMs: Date.now() + 60_000,
            retryAfterSeconds: 0,
          }),
        ),
      })),
    };
    const proNamespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch: (request: Request) => worker.fetch(request) })),
    };
    const facade = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        developerApiFacadeWorker.fetch(new Request(input, init), {
          PRO_ROOM_DEVELOPER_ROOMS: proNamespace,
        }),
    };
    const response = await developerApiWorker.fetch(
      new Request(`https://api.musixquare.com/v1/rooms/${ROOM_CODE}/queue`, {
        headers: {
          authorization: `Bearer mxqr_live_${keyId}.${keySecret}`,
          'cf-connecting-ip': '203.0.113.50',
        },
      }),
      {
        DEVELOPER_API_MODE: 'canary',
        DEVELOPER_API_CANARY_ROOMS: ROOM_CODE,
        MXQR_DEVELOPER_API_KEY_PEPPER: pepper,
        MXQR_DEVELOPER_API_RATE_SECRET: 'developer-api-rate'.padEnd(48, 'r'),
        DEVELOPER_API_DB: database,
        DEVELOPER_API_LIMITERS: limiter,
        DEVELOPER_API_FACADE: facade,
      },
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      schemaVersion: 1,
      view: 'queue',
      roomCode: ROOM_CODE,
      playlistRevision: 5,
      currentQueueItemId: queueItemId,
      items: [
        {
          queueItemId,
          kind: 'audio',
          name: 'Facade Orchestra.flac',
          addedBy: 'participant',
          title: 'Facade Orchestra',
          byteLength: 4_096,
        },
      ],
    });
    expect(response.headers.get('etag')).toMatch(/^"mxqr-queue-[A-Za-z0-9_-]{43}"$/);
    expect(JSON.stringify(payload)).not.toContain('private-composed-asset');
    expect(JSON.stringify(payload)).not.toContain('source');
    expect(JSON.stringify(payload)).not.toContain('mime');
  });

  it('freezes a sleeping room position instead of extrapolating it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T02:00:00.000Z'));
    const { worker } = await activatedRoom();
    const internal = worker as unknown as {
      room: {
        runtime: string;
        playlistRevision: number;
        playlist: Array<Record<string, any>>;
        currentQueueItemId: string;
        playback: Record<string, any>;
      };
    };
    const queueItemId = '22222222-2222-4222-8222-222222222222';
    internal.room.runtime = 'sleeping';
    internal.room.playlistRevision = 1;
    internal.room.playlist = [
      {
        queueItemId,
        name: 'Video',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
    ];
    internal.room.currentQueueItemId = queueItemId;
    internal.room.playback = {
      coordinatorEpoch: 1,
      revision: 1,
      state: 'playing',
      queueItemId,
      positionSeconds: 30,
      updatedAtMs: Date.now() - 60_000,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };
    const playback = await responseJson(await internalDeveloperRead(worker, 'playback'));
    expect(playback.positionSeconds).toBe(30);
    vi.useRealTimers();
  });

  it('clamps a frozen playback position to the persisted seven-day state bound', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T03:00:00.000Z'));
    const { worker } = await activatedRoom();
    const internal = worker as unknown as {
      room: { playback: Record<string, any> };
      freezePlayback(nowMs: number): void;
    };
    internal.room.playback.state = 'playing';
    internal.room.playback.positionSeconds = 604_799;
    internal.room.playback.updatedAtMs = Date.now() - 10_000;
    internal.freezePlayback(Date.now());
    expect(internal.room.playback.positionSeconds).toBe(604_800);
  });

  it('rejects non-active rooms and exact-body violations', async () => {
    const { worker } = await activatedRoom();
    const rollingCompatibleRead = await worker.fetch(
      new Request('https://pro-room.internal/internal/developer/v1/read', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({ projection: 'room' }),
      }),
    );
    expect(rollingCompatibleRead.status).toBe(200);
    await expect(responseJson(rollingCompatibleRead)).resolves.toMatchObject({
      view: 'room',
      roomCode: ROOM_CODE,
    });

    const invalid = await worker.fetch(
      new Request('https://pro-room.internal/internal/developer/v1/read', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({ projection: 'room', keyId: DEVELOPER_KEY_ID, admin: true }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await responseJson(invalid)).toEqual({ error: 'INVALID_REQUEST' });

    const internal = worker as unknown as { room: { status: string } };
    internal.room.status = 'suspended';
    const suspended = await internalDeveloperRead(worker, 'room');
    expect(suspended.status).toBe(404);
    expect(await responseJson(suspended)).toEqual({ error: 'ROOM_NOT_FOUND' });
  });

  it('accepts sleeping-room queue writes and replays an identical idempotent intent exactly once', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    internal.room.runtime = 'sleeping';
    internal.room.presence.coordinatorParticipantId = null;
    internal.room.presence.participants = {};
    const keyId = 'Q'.repeat(16);
    const mutation = {
      type: 'add_youtube',
      videoId: 'dQw4w9WgXcQ',
      name: 'Never Gonna Give You Up',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
    };

    const firstResponse = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-add-0001',
      mutation,
    );
    expect(firstResponse.status).toBe(201);
    const first = await responseJson(firstResponse);
    expect(first).toMatchObject({
      schemaVersion: 1,
      view: 'queue',
      roomCode: ROOM_CODE,
      playlistRevision: 1,
      currentQueueItemId: null,
      items: [
        {
          kind: 'youtube',
          name: mutation.name,
          title: mutation.title,
          artist: mutation.artist,
        },
      ],
    });
    expect(internal.room.runtime).toBe('sleeping');
    expect(internal.room.playlist).toHaveLength(1);
    expect(internal.room.playback).toMatchObject({ state: 'idle', queueItemId: null });
    const queueIdempotencyRecord = Object.values(internal.room.idempotency).find(
      (record: any) => record.kind === 'developer-queue',
    ) as Record<string, unknown> | undefined;
    expect(queueIdempotencyRecord).toMatchObject({ kind: 'developer-queue', status: 201 });
    expect(queueIdempotencyRecord).not.toHaveProperty('body');

    const replayResponse = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-add-0001',
      mutation,
    );
    expect(replayResponse.status).toBe(201);
    expect(await responseJson(replayResponse)).toEqual(first);
    expect(internal.room.playlist).toHaveLength(1);

    const conflict = await mutateInternalDeveloperQueue(worker, keyId, 'developer-queue-add-0001', {
      ...mutation,
      videoId: 'M7lc1UVf-VE',
    });
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toEqual({ error: 'IDEMPOTENCY_CONFLICT' });
    expect(internal.room.playlist).toHaveLength(1);
  });

  it('atomically appends one ordered YouTube batch with one revision and caller ownership', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    internal.room.runtime = 'sleeping';
    internal.room.presence.coordinatorParticipantId = null;
    internal.room.presence.participants = {};
    const keyId = 'B'.repeat(16);
    const mutation = {
      type: 'add_youtube_batch',
      items: [
        { videoId: 'dQw4w9WgXcQ', name: 'First', title: 'First title' },
        {
          videoId: 'M7lc1UVf-VE',
          playlistId: 'PL1234567890',
          name: 'Second',
          artist: 'Second artist',
        },
      ],
    };
    const before = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
    };

    const firstResponse = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-0001',
      mutation,
      'Friend integration',
    );
    expect(firstResponse.status).toBe(201);
    const first = await responseJson(firstResponse);
    expect(first).toMatchObject({
      playlistRevision: before.playlistRevision + 1,
      currentQueueItemId: null,
      items: [
        {
          kind: 'youtube',
          name: 'First',
          title: 'First title',
          addedBy: 'current_api_key',
        },
        {
          kind: 'youtube',
          name: 'Second',
          artist: 'Second artist',
          addedBy: 'current_api_key',
        },
      ],
    });
    expect(new Set(first.items.map((item: any) => item.queueItemId)).size).toBe(2);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);
    expect(internal.room.playlist.map((item: any) => item.source.videoId)).toEqual([
      'dQw4w9WgXcQ',
      'M7lc1UVf-VE',
    ]);
    expect(internal.room.playlist.every((item: any) => item.developerOwnerKeyId === keyId)).toBe(
      true,
    );
    expect(internal.room.runtime).toBe('sleeping');
    expect(internal.room.playback).toMatchObject({ state: 'idle', queueItemId: null });

    const replay = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-0001',
      mutation,
      'Friend integration',
    );
    expect(replay.status).toBe(201);
    expect(await responseJson(replay)).toEqual(first);
    expect(internal.room.playlist).toHaveLength(2);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);

    const conflict = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-0001',
      {
        ...mutation,
        items: [{ videoId: '9bZkp7q19f0', name: 'Different intent' }],
      },
      'Friend integration',
    );
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toEqual({ error: 'IDEMPOTENCY_CONFLICT' });
    expect(internal.room.playlist).toHaveLength(2);
  });

  it('rejects invalid or over-capacity YouTube batches without a partial append', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const keyId = 'B'.repeat(16);
    const invalidMutations = [
      { type: 'add_youtube_batch', items: [] },
      {
        type: 'add_youtube_batch',
        items: Array.from({ length: 101 }, (_, index) => ({
          videoId: 'dQw4w9WgXcQ',
          name: `Track ${index}`,
        })),
      },
      {
        type: 'add_youtube_batch',
        items: [
          { videoId: 'dQw4w9WgXcQ', name: 'Valid' },
          { videoId: 'invalid', name: 'Invalid' },
        ],
      },
    ];
    for (const [index, mutation] of invalidMutations.entries()) {
      const before = structuredClone(internal.room.playlist);
      const response = await mutateInternalDeveloperQueue(
        worker,
        keyId,
        `developer-queue-batch-invalid-${index}`,
        mutation,
      );
      expect(response.status).toBe(400);
      expect(await responseJson(response)).toEqual({ error: 'INVALID_REQUEST' });
      expect(internal.room.playlist).toEqual(before);
    }

    internal.room.playlist = Array.from({ length: 999 }, (_, index) => ({
      queueItemId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      name: `Existing ${index}`,
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    }));
    const playlistBeforeCapacity = structuredClone(internal.room.playlist);
    const revisionBeforeCapacity = internal.room.revision;
    const playlistRevisionBeforeCapacity = internal.room.playlistRevision;
    const overCapacity = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-over-capacity',
      {
        type: 'add_youtube_batch',
        items: [
          { videoId: 'M7lc1UVf-VE', name: 'Would fit alone' },
          { videoId: '9bZkp7q19f0', name: 'Makes batch overflow' },
        ],
      },
    );
    expect(overCapacity.status).toBe(409);
    expect(await responseJson(overCapacity)).toEqual({ error: 'PLAYLIST_CAPACITY_EXCEEDED' });
    expect(internal.room.playlist).toEqual(playlistBeforeCapacity);
    expect(internal.room.revision).toBe(revisionBeforeCapacity);
    expect(internal.room.playlistRevision).toBe(playlistRevisionBeforeCapacity);

    internal.room.playlist = [];
    internal.room.playlistRevision = Number.MAX_SAFE_INTEGER;
    const revisionOverflow = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-revision-overflow',
      {
        type: 'add_youtube_batch',
        items: [{ videoId: 'M7lc1UVf-VE', name: 'Must remain absent' }],
      },
    );
    expect(revisionOverflow.status).toBe(409);
    expect(await responseJson(revisionOverflow)).toEqual({
      error: 'ROOM_STATE_CAPACITY_EXCEEDED',
    });
    expect(internal.room.playlist).toEqual([]);
  });

  it('rolls back the entire batch when the bounded room-state persist rejects it', async () => {
    const { worker, state } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const stateLimitBytes = 1_200 * 1024;
    const paddingKey = 'batch-capacity-padding';
    internal.room.rateLimits[paddingKey] = {
      count: 0,
      resetAtMs: Date.now() + 60 * 60 * 1_000,
      padding: '',
    };
    const bytesBeforePadding = new TextEncoder().encode(JSON.stringify(internal.room)).byteLength;
    const paddingLength = stateLimitBytes - 256 - bytesBeforePadding;
    expect(paddingLength).toBeGreaterThan(4_096);
    internal.room.rateLimits[paddingKey].padding = 'P'.repeat(paddingLength);
    expect(new TextEncoder().encode(JSON.stringify(internal.room)).byteLength).toBeLessThan(
      stateLimitBytes,
    );
    await state.storage.put('pro-room:v1', structuredClone(internal.room));

    const before = {
      playlist: structuredClone(internal.room.playlist),
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
      idempotency: structuredClone(internal.room.idempotency),
    };
    const response = await mutateInternalDeveloperQueue(
      worker,
      'B'.repeat(16),
      'developer-queue-batch-state-capacity',
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            name: 'N'.repeat(512),
            title: 'T'.repeat(512),
            artist: 'A'.repeat(512),
            thumbnail: 'H'.repeat(512),
          },
          {
            videoId: 'M7lc1UVf-VE',
            name: 'M'.repeat(512),
            title: 'U'.repeat(512),
            artist: 'B'.repeat(512),
            thumbnail: 'I'.repeat(512),
          },
        ],
      },
      'State capacity test',
    );

    expect(response.status).toBe(409);
    expect(await responseJson(response)).toEqual({ error: 'ROOM_STATE_CAPACITY_EXCEEDED' });
    expect(internal.room.playlist).toEqual(before.playlist);
    expect(internal.room.revision).toBe(before.revision);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision);
    expect(internal.room.idempotency).toEqual(before.idempotency);
    expect(
      Object.keys(internal.room.idempotency).some((key) =>
        key.includes('developer-queue-batch-state-capacity'),
      ),
    ).toBe(false);

    const persisted = state.storage.data.get('pro-room:v1') as Record<string, any>;
    expect(persisted.playlist).toEqual(before.playlist);
    expect(persisted.revision).toBe(before.revision);
    expect(persisted.playlistRevision).toBe(before.playlistRevision);
    expect(persisted.idempotency).toEqual(before.idempotency);
  });

  it('accepts the authenticated envelope around a near-64-KiB public batch', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const items = Array.from({ length: 100 }, (_, index) => ({
      videoId: 'dQw4w9WgXcQ',
      name: `${index}`.padEnd(304, 'N'),
      title: 'T'.repeat(304),
    }));
    const response = await mutateInternalDeveloperQueue(
      worker,
      'B'.repeat(16),
      'developer-queue-batch-boundary',
      { type: 'add_youtube_batch', items },
      'A'.repeat(64),
    );

    expect(response.status).toBe(201);
    expect(internal.room.playlist).toHaveLength(100);
    expect(internal.room.playlistRevision).toBe(1);
    expect(internal.room.revision).toBe(2);
  });

  it('returns and replays a committed batch when the full queue projection exceeds 64 KiB', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    internal.room.playlist = Array.from({ length: 100 }, (_, index) => ({
      queueItemId: `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      name: `${index}`.padEnd(512, 'N'),
      title: 'T'.repeat(512),
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    }));
    internal.room.playlistRevision = 7;
    const before = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
    };
    const rooms = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch: (request: Request) => worker.fetch(request) })),
    };
    const facadeBody = {
      roomCode: ROOM_CODE,
      keyId: 'B'.repeat(16),
      actorName: 'Large response bot',
      idempotencyKey: 'developer-queue-batch-large-response',
      mutation: {
        type: 'add_youtube_batch',
        items: [
          { videoId: 'M7lc1UVf-VE', name: 'Batch item one' },
          { videoId: '9bZkp7q19f0', name: 'Batch item two' },
        ],
      },
    };
    const callFacade = () =>
      developerApiFacadeWorker.fetch(
        new Request('https://developer-api-facade.internal/internal/v1/queue/mutate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(facadeBody),
        }),
        { PRO_ROOM_DEVELOPER_ROOMS: rooms },
      );

    const first = await callFacade();
    expect(first.status).toBe(201);
    const firstText = await first.text();
    expect(new TextEncoder().encode(firstText).byteLength).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(firstText)).toMatchObject({
      playlistRevision: before.playlistRevision + 1,
      items: expect.arrayContaining([
        expect.objectContaining({ name: 'Batch item one', addedBy: 'current_api_key' }),
        expect.objectContaining({ name: 'Batch item two', addedBy: 'current_api_key' }),
      ]),
    });
    expect(internal.room.playlist).toHaveLength(102);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);

    const replay = await callFacade();
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstText);
    expect(internal.room.playlist).toHaveLength(102);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);
  });

  it('keeps API ownership private while classifying legacy, participant, and per-key additions', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const legacyQueueItemId = '10000000-0000-4000-8000-000000000001';
    const participantQueueItemId = '10000000-0000-4000-8000-000000000002';
    const firstKeyId = 'A'.repeat(16);
    const secondKeyId = 'B'.repeat(16);
    internal.room.playlist = [
      {
        queueItemId: legacyQueueItemId,
        name: 'Legacy participant item',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
    ];
    internal.room.playlistRevision = 1;
    internal.room.revision += 1;

    const firstAdded = await responseJson(
      await mutateInternalDeveloperQueue(worker, firstKeyId, 'developer-owner-first-add', {
        type: 'add_youtube',
        videoId: 'M7lc1UVf-VE',
        name: 'First integration item',
      }),
    );
    const firstOwnedId = firstAdded.items.at(-1).queueItemId;
    expect(firstAdded.items).toEqual([
      expect.objectContaining({ queueItemId: legacyQueueItemId, addedBy: 'participant' }),
      expect.objectContaining({ queueItemId: firstOwnedId, addedBy: 'current_api_key' }),
    ]);

    const secondAdded = await responseJson(
      await mutateInternalDeveloperQueue(worker, secondKeyId, 'developer-owner-second-add', {
        type: 'add_youtube',
        videoId: '9bZkp7q19f0',
        name: 'Second integration item',
      }),
    );
    const secondOwnedId = secondAdded.items.at(-1).queueItemId;
    expect(secondAdded.items).toEqual([
      expect.objectContaining({ queueItemId: legacyQueueItemId, addedBy: 'participant' }),
      expect.objectContaining({ queueItemId: firstOwnedId, addedBy: 'another_api_key' }),
      expect.objectContaining({ queueItemId: secondOwnedId, addedBy: 'current_api_key' }),
    ]);

    const publicBefore = await responseJson(
      await worker.fetch(request('/snapshot', {}, ownerCookie)),
    );
    expect(parseProRoomSnapshot(publicBefore.snapshot)).not.toBeNull();
    expect(JSON.stringify(publicBefore.snapshot)).not.toContain('developerOwnerKeyId');
    expect(JSON.stringify(publicBefore.snapshot)).not.toContain(firstKeyId);
    expect(JSON.stringify(publicBefore.snapshot)).not.toContain(secondKeyId);

    const unchangedRoundTrip = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: publicBefore.snapshot.revision,
          playlist: publicBefore.snapshot.playlist,
          currentQueueItemId: publicBefore.snapshot.currentQueueItemId,
          playback: publicBefore.snapshot.playback,
        },
        ownerCookie,
        'participant-unchanged-round-trip',
      ),
    );
    expect(unchangedRoundTrip.status).toBe(200);
    const unchangedEnvelope = await responseJson(unchangedRoundTrip);
    expect(unchangedEnvelope.snapshot.playlistRevision).toBe(
      publicBefore.snapshot.playlistRevision,
    );

    const participantPlaylist = [
      ...unchangedEnvelope.snapshot.playlist,
      {
        queueItemId: participantQueueItemId,
        name: 'New participant item',
        source: { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
      },
    ];
    const roundTrip = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: unchangedEnvelope.snapshot.revision,
          playlist: participantPlaylist,
          currentQueueItemId: unchangedEnvelope.snapshot.currentQueueItemId,
          playback: unchangedEnvelope.snapshot.playback,
        },
        ownerCookie,
        'participant-round-trip-ownership',
      ),
    );
    expect(roundTrip.status).toBe(200);
    const roundTripEnvelope = await responseJson(roundTrip);
    expect(parseProRoomSnapshot(roundTripEnvelope.snapshot)).not.toBeNull();
    expect(JSON.stringify(roundTripEnvelope.snapshot)).not.toContain('developerOwnerKeyId');

    expect(
      internal.room.playlist.find((item: any) => item.queueItemId === legacyQueueItemId),
    ).not.toHaveProperty('developerOwnerKeyId');
    expect(
      internal.room.playlist.find((item: any) => item.queueItemId === participantQueueItemId),
    ).not.toHaveProperty('developerOwnerKeyId');
    expect(
      internal.room.playlist.find((item: any) => item.queueItemId === firstOwnedId),
    ).toHaveProperty('developerOwnerKeyId', firstKeyId);
    expect(
      internal.room.playlist.find((item: any) => item.queueItemId === secondOwnedId),
    ).toHaveProperty('developerOwnerKeyId', secondKeyId);

    const firstKeyView = await responseJson(
      await internalDeveloperRead(worker, 'queue', firstKeyId),
    );
    expect(firstKeyView.items.map((item: any) => [item.queueItemId, item.addedBy])).toEqual([
      [legacyQueueItemId, 'participant'],
      [firstOwnedId, 'current_api_key'],
      [secondOwnedId, 'another_api_key'],
      [participantQueueItemId, 'participant'],
    ]);

    const rollingCompatibleView = await responseJson(
      await worker.fetch(
        new Request('https://pro-room.internal/internal/developer/v1/read', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': ROOM_CODE,
          },
          body: JSON.stringify({ projection: 'queue' }),
        }),
      ),
    );
    expect(
      rollingCompatibleView.items.every(
        (item: Record<string, unknown>) => !Object.prototype.hasOwnProperty.call(item, 'addedBy'),
      ),
    ).toBe(true);

    const forged = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: roundTripEnvelope.snapshot.revision,
          playlist: roundTripEnvelope.snapshot.playlist.map((item: any, index: number) =>
            index === 0 ? { ...item, developerOwnerKeyId: firstKeyId } : item,
          ),
          currentQueueItemId: roundTripEnvelope.snapshot.currentQueueItemId,
          playback: roundTripEnvelope.snapshot.playback,
        },
        ownerCookie,
        'participant-forged-ownership',
      ),
    );
    expect(forged.status).toBe(400);
    expect(await responseJson(forged)).toEqual({ error: 'INVALID_PLAYLIST' });
  });

  it('atomically clears the queue, current playback, and R2 references with one revision step', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T04:00:00.000Z'));
    const context = await activatedRoom();
    const { worker, state, ownerCookie } = context;
    const internal = worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    const { asset } = await completeReadyAsset(context, 'developer-clear');
    const audioQueueItemId = '55555555-5555-4555-8555-555555555555';
    const replace = await replacePlaylist(
      context,
      [playlistItem(audioQueueItemId, asset)],
      'developer-clear',
    );
    expect(replace.status).toBe(200);
    const add = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-seed',
      { type: 'add_youtube', videoId: 'dQw4w9WgXcQ', name: 'Clear with audio' },
    );
    expect(add.status).toBe(201);
    expect(asset.gcAfterMs).toBeUndefined();

    internal.room.currentQueueItemId = audioQueueItemId;
    internal.room.playback = {
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      revision: 7,
      state: 'playing',
      queueItemId: audioQueueItemId,
      positionSeconds: 12,
      updatedAtMs: Date.now() - 1_000,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    };
    const capability = await worker.fetch(
      jsonRequest('/signaling-tickets', 'POST', { developerControlVersion: 1 }, ownerCookie),
    );
    expect(capability.status).toBe(200);
    const dispatchedBodies: Array<Record<string, any>> = [];
    const dispatchFetch = vi.fn(async (request: Request) => {
      dispatchedBodies.push((await request.json()) as Record<string, any>);
      return Response.json({ dispatched: true });
    });
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatchFetch })),
    };
    const before = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
      playbackRevision: internal.room.playback.revision,
    };
    const clearMutation = { type: 'clear' };
    const clear = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-0001',
      clearMutation,
    );

    expect(clear.status).toBe(200);
    const clearedQueue = await responseJson(clear);
    expect(clearedQueue).toEqual({
      schemaVersion: 1,
      view: 'queue',
      roomCode: ROOM_CODE,
      playlistRevision: before.playlistRevision + 1,
      currentQueueItemId: null,
      items: [],
    });
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);
    expect(internal.room.playlist).toEqual([]);
    expect(internal.room.playback).toMatchObject({
      revision: before.playbackRevision + 1,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    });
    expect(asset.gcAfterMs).toBe(Date.now() + 15 * 60 * 1_000);
    expect((state.storage.data.get('pro-room:v1') as Record<string, any>).playlist).toEqual([]);
    await vi.waitFor(() => expect(dispatchedBodies).toHaveLength(1));
    expect(dispatchedBodies[0]).toMatchObject({
      roomCode: ROOM_CODE,
      frame: {
        type: 'developer-invalidation',
        revision: before.revision + 1,
        playlistRevision: before.playlistRevision + 1,
      },
    });

    const replay = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-0001',
      clearMutation,
    );
    expect(replay.status).toBe(200);
    expect(await responseJson(replay)).toEqual(clearedQueue);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);
    expect(internal.room.playback.revision).toBe(before.playbackRevision + 1);
    expect(dispatchFetch).toHaveBeenCalledTimes(1);

    const emptyNoOp = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-0002',
      clearMutation,
    );
    expect(emptyNoOp.status).toBe(200);
    expect(await responseJson(emptyNoOp)).toEqual(clearedQueue);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);
    expect(dispatchFetch).toHaveBeenCalledTimes(1);
  });

  it('clears only the current API key additions while preserving participant playback and replay safety', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const firstKeyId = 'A'.repeat(16);
    const secondKeyId = 'B'.repeat(16);
    const participantQueueItemId = '20000000-0000-4000-8000-000000000001';
    internal.room.playlist = [
      {
        queueItemId: participantQueueItemId,
        name: 'Participant keeps playing',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
    ];
    internal.room.playlistRevision = 1;
    internal.room.revision += 1;

    const firstAdd = await responseJson(
      await mutateInternalDeveloperQueue(worker, firstKeyId, 'owned-clear-first-add', {
        type: 'add_youtube',
        videoId: 'M7lc1UVf-VE',
        name: 'First key item',
      }),
    );
    const firstOwnedId = firstAdd.items.at(-1).queueItemId;
    const secondAdd = await responseJson(
      await mutateInternalDeveloperQueue(worker, secondKeyId, 'owned-clear-second-add', {
        type: 'add_youtube',
        videoId: '9bZkp7q19f0',
        name: 'Second key item',
      }),
    );
    const secondOwnedId = secondAdd.items.at(-1).queueItemId;
    internal.room.currentQueueItemId = participantQueueItemId;
    internal.room.playback = {
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      revision: 8,
      state: 'paused',
      queueItemId: participantQueueItemId,
      positionSeconds: 42,
      updatedAtMs: Date.now(),
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };
    const before = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
      playback: structuredClone(internal.room.playback),
    };

    const cleared = await mutateInternalDeveloperQueue(
      worker,
      firstKeyId,
      'owned-clear-current-key',
      { type: 'clear_owned' },
    );
    expect(cleared.status).toBe(200);
    expect(await responseJson(cleared)).toMatchObject({
      playlistRevision: before.playlistRevision + 1,
      currentQueueItemId: participantQueueItemId,
      items: [
        { queueItemId: participantQueueItemId, addedBy: 'participant' },
        { queueItemId: secondOwnedId, addedBy: 'another_api_key' },
      ],
    });
    expect(internal.room.playlist.map((item: any) => item.queueItemId)).toEqual([
      participantQueueItemId,
      secondOwnedId,
    ]);
    expect(internal.room.playlist.some((item: any) => item.queueItemId === firstOwnedId)).toBe(
      false,
    );
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playback).toEqual(before.playback);

    const addedAfterClear = await responseJson(
      await mutateInternalDeveloperQueue(worker, firstKeyId, 'owned-clear-later-add', {
        type: 'add_youtube',
        videoId: 'aqz-KE-bpKQ',
        name: 'Added after clear',
      }),
    );
    const laterOwnedId = addedAfterClear.items.at(-1).queueItemId;
    const beforeReplay = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
    };
    const replay = await mutateInternalDeveloperQueue(
      worker,
      firstKeyId,
      'owned-clear-current-key',
      { type: 'clear_owned' },
    );
    expect(replay.status).toBe(200);
    expect((await responseJson(replay)).items).toContainEqual(
      expect.objectContaining({ queueItemId: laterOwnedId, addedBy: 'current_api_key' }),
    );
    expect(internal.room.revision).toBe(beforeReplay.revision);
    expect(internal.room.playlistRevision).toBe(beforeReplay.playlistRevision);

    const noOp = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'owned-clear-empty-owner',
      { type: 'clear_owned' },
    );
    expect(noOp.status).toBe(200);
    expect(internal.room.revision).toBe(beforeReplay.revision);
    expect(internal.room.playlistRevision).toBe(beforeReplay.playlistRevision);
  });

  it('resets playback only when clear-owned removes the selected owner item', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const firstKeyId = 'A'.repeat(16);
    const secondKeyId = 'B'.repeat(16);
    const firstAdded = await responseJson(
      await mutateInternalDeveloperQueue(worker, firstKeyId, 'owned-current-first-add', {
        type: 'add_youtube',
        videoId: 'dQw4w9WgXcQ',
        name: 'Selected API item',
      }),
    );
    const firstOwnedId = firstAdded.items[0].queueItemId;
    const secondAdded = await responseJson(
      await mutateInternalDeveloperQueue(worker, secondKeyId, 'owned-current-second-add', {
        type: 'add_youtube',
        videoId: 'M7lc1UVf-VE',
        name: 'Other API item',
      }),
    );
    const secondOwnedId = secondAdded.items.at(-1).queueItemId;
    internal.room.currentQueueItemId = firstOwnedId;
    internal.room.playback = {
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      revision: 4,
      state: 'playing',
      queueItemId: firstOwnedId,
      positionSeconds: 9,
      updatedAtMs: Date.now() - 500,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };

    const cleared = await mutateInternalDeveloperQueue(worker, firstKeyId, 'owned-clear-selected', {
      type: 'clear_owned',
    });
    expect(cleared.status).toBe(200);
    expect(await responseJson(cleared)).toMatchObject({
      currentQueueItemId: null,
      items: [{ queueItemId: secondOwnedId, addedBy: 'another_api_key' }],
    });
    expect(internal.room.playback).toMatchObject({
      revision: 5,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    });
  });

  it('rejects clear-owned revision exhaustion without partial mutation', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const keyId = 'A'.repeat(16);
    const added = await responseJson(
      await mutateInternalDeveloperQueue(worker, keyId, 'owned-overflow-add', {
        type: 'add_youtube',
        videoId: 'dQw4w9WgXcQ',
        name: 'Overflow item',
      }),
    );
    const queueItemId = added.items[0].queueItemId;

    internal.room.playlistRevision = Number.MAX_SAFE_INTEGER;
    const playlistBefore = structuredClone(internal.room.playlist);
    const revisionOverflow = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'owned-overflow-playlist-revision',
      { type: 'clear_owned' },
    );
    expect(revisionOverflow.status).toBe(409);
    expect(await responseJson(revisionOverflow)).toEqual({ error: 'ROOM_STATE_CAPACITY_EXCEEDED' });
    expect(internal.room.playlist).toEqual(playlistBefore);

    internal.room.playlistRevision = 1;
    internal.room.revision = Number.MAX_SAFE_INTEGER;
    const roomRevisionOverflow = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'owned-overflow-room-revision',
      { type: 'clear_owned' },
    );
    expect(roomRevisionOverflow.status).toBe(409);
    expect(await responseJson(roomRevisionOverflow)).toEqual({
      error: 'ROOM_STATE_CAPACITY_EXCEEDED',
    });
    expect(internal.room.playlist).toEqual(playlistBefore);

    internal.room.revision = 1;
    internal.room.currentQueueItemId = queueItemId;
    internal.room.playback = {
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      revision: Number.MAX_SAFE_INTEGER,
      state: 'paused',
      queueItemId,
      positionSeconds: 1,
      updatedAtMs: Date.now(),
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };
    const playbackBefore = structuredClone(internal.room.playback);
    const playbackOverflow = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'owned-overflow-playback-revision',
      { type: 'clear_owned' },
    );
    expect(playbackOverflow.status).toBe(409);
    expect(await responseJson(playbackOverflow)).toEqual({ error: 'PLAYBACK_REVISION_EXHAUSTED' });
    expect(internal.room.playlist).toEqual(playlistBefore);
    expect(internal.room.playback).toEqual(playbackBefore);
  });

  it('rejects malformed or unsafe queue clears without partially mutating room state', async () => {
    const { worker, internal } = await preparedDeveloperCommandRoom();
    const before = structuredClone(internal.room);
    const malformed = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-invalid',
      { type: 'clear', basePlaylistRevision: internal.room.playlistRevision },
    );
    expect(malformed.status).toBe(400);
    expect(await responseJson(malformed)).toEqual({ error: 'INVALID_REQUEST' });
    expect(internal.room.playlist).toEqual(before.playlist);
    expect(internal.room.currentQueueItemId).toBe(before.currentQueueItemId);

    const malformedOwned = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-owned-invalid',
      { type: 'clear_owned', includeParticipants: true },
    );
    expect(malformedOwned.status).toBe(400);
    expect(await responseJson(malformedOwned)).toEqual({ error: 'INVALID_REQUEST' });
    expect(internal.room.playlist).toEqual(before.playlist);

    internal.room.playback.revision = Number.MAX_SAFE_INTEGER;
    const exhausted = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-exhausted',
      { type: 'clear' },
    );
    expect(exhausted.status).toBe(409);
    expect(await responseJson(exhausted)).toEqual({ error: 'PLAYBACK_REVISION_EXHAUSTED' });
    expect(internal.room.playlist).toEqual(before.playlist);
    expect(internal.room.currentQueueItemId).toBe(before.currentQueueItemId);
    expect(internal.room.playback).toMatchObject({
      revision: Number.MAX_SAFE_INTEGER,
      state: before.playback.state,
      queueItemId: before.playback.queueItemId,
    });

    internal.room.playback.revision = before.playback.revision;
    internal.room.playlistRevision = Number.MAX_SAFE_INTEGER;
    const playlistRevisionExhausted = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-playlist-revision-exhausted',
      { type: 'clear' },
    );
    expect(playlistRevisionExhausted.status).toBe(409);
    expect(await responseJson(playlistRevisionExhausted)).toEqual({
      error: 'ROOM_STATE_CAPACITY_EXCEEDED',
    });
    expect(internal.room.playlist).toEqual(before.playlist);
    expect(internal.room.currentQueueItemId).toBe(before.currentQueueItemId);
    expect(internal.room.playlistRevision).toBe(Number.MAX_SAFE_INTEGER);
    expect(internal.room.playback).toEqual(before.playback);

    internal.room.playlistRevision = before.playlistRevision;
    internal.room.revision = Number.MAX_SAFE_INTEGER;
    const roomRevisionExhausted = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-room-revision-exhausted',
      { type: 'clear' },
    );
    expect(roomRevisionExhausted.status).toBe(409);
    expect(await responseJson(roomRevisionExhausted)).toEqual({
      error: 'ROOM_STATE_CAPACITY_EXCEEDED',
    });
    expect(internal.room.playlist).toEqual(before.playlist);
    expect(internal.room.currentQueueItemId).toBe(before.currentQueueItemId);
    expect(internal.room.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision);
    expect(internal.room.playback).toEqual(before.playback);
  });

  it('fences stale or non-permutation Developer API reorders by playlist revision', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const keyId = 'R'.repeat(16);
    for (const [index, videoId] of ['dQw4w9WgXcQ', 'M7lc1UVf-VE'].entries()) {
      const response = await mutateInternalDeveloperQueue(
        worker,
        keyId,
        `developer-queue-seed-000${index}`,
        { type: 'add_youtube', videoId, name: `Track ${index + 1}` },
      );
      expect(response.status).toBe(201);
    }
    const [firstId, secondId] = internal.room.playlist.map(
      (item: Record<string, unknown>) => item.queueItemId,
    );

    const stale = await mutateInternalDeveloperQueue(worker, keyId, 'developer-queue-order-0001', {
      type: 'reorder',
      basePlaylistRevision: internal.room.playlistRevision - 1,
      queueItemIds: [secondId, firstId],
    });
    expect(stale.status).toBe(409);
    expect(await responseJson(stale)).toEqual({ error: 'PLAYLIST_REVISION_CONFLICT' });

    const invalidSet = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-order-0002',
      {
        type: 'reorder',
        basePlaylistRevision: internal.room.playlistRevision,
        queueItemIds: [firstId],
      },
    );
    expect(invalidSet.status).toBe(409);
    expect(await responseJson(invalidSet)).toEqual({ error: 'PLAYLIST_REVISION_CONFLICT' });

    const accepted = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-order-0003',
      {
        type: 'reorder',
        basePlaylistRevision: internal.room.playlistRevision,
        queueItemIds: [secondId, firstId],
      },
    );
    expect(accepted.status).toBe(200);
    expect(
      (await responseJson(accepted)).items.map((item: Record<string, unknown>) => item.queueItemId),
    ).toEqual([secondId, firstId]);
  });

  it('reserves a sleeping-room direct upload and completes it into one non-autoplaying queue row', async () => {
    const { worker, bucket } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    internal.room.runtime = 'sleeping';
    internal.room.presence.coordinatorParticipantId = null;
    internal.room.presence.participants = {};
    const keyId = 'U'.repeat(16);
    const media = {
      name: 'Orchestra.flac',
      byteLength: 4_096,
      mime: 'audio/flac',
      sha256: 'a'.repeat(64),
      title: 'Orchestra',
      artist: 'MUSIXQUARE',
    };

    const reservationResponse = await createInternalDeveloperUpload(
      worker,
      keyId,
      'developer-upload-reserve-0001',
      media,
    );
    expect(reservationResponse.status).toBe(201);
    const reservation = await responseJson(reservationResponse);
    expect(reservation).toMatchObject({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      assetId: expect.stringMatching(/^asset_[A-Za-z0-9_-]{32}$/),
      queueItemId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      byteLength: media.byteLength,
      upload: {
        method: 'PUT',
        url: expect.stringMatching(/^https:\/\/[a-f0-9]+\.r2\.cloudflarestorage\.com\//),
        headers: {
          'content-length': String(media.byteLength),
          'content-type': media.mime,
          'x-amz-meta-mxqr-room': ROOM_CODE,
          'x-amz-meta-mxqr-asset': expect.any(String),
          'x-amz-meta-mxqr-bytes': String(media.byteLength),
          'x-amz-meta-mxqr-sha256': media.sha256,
        },
      },
      quota: { reservedBytes: media.byteLength, usedBytes: 0 },
    });
    expect(reservation.uploadExpiresAtMs).toBeLessThan(reservation.completionExpiresAtMs);

    const asset = internal.room.assets[reservation.assetId];
    expect(asset).toMatchObject({
      status: 'reserved',
      reservedByDeveloperKeyId: keyId,
      developerQueueItemId: reservation.queueItemId,
    });
    expect(asset.uploadExpiresAtMs).toBe(reservation.uploadExpiresAtMs);
    expect(asset.expiresAtMs).toBe(reservation.completionExpiresAtMs);
    bucket.objects.set(asset.stagingObjectKey, {
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
      customMetadata: {
        'mxqr-room': ROOM_CODE,
        'mxqr-asset': asset.assetId,
        'mxqr-version': String(asset.version),
        'mxqr-bytes': String(asset.byteLength),
        'mxqr-sha256': asset.sha256,
      },
    });

    const wrongOwner = await completeInternalDeveloperUpload(
      worker,
      'V'.repeat(16),
      'developer-upload-complete-0000',
      reservation.assetId,
    );
    expect(wrongOwner.status).toBe(404);
    expect(await responseJson(wrongOwner)).toEqual({ error: 'ASSET_NOT_FOUND' });

    const completeResponse = await completeInternalDeveloperUpload(
      worker,
      keyId,
      'developer-upload-complete-0001',
      reservation.assetId,
    );
    expect(completeResponse.status).toBe(201);
    const completed = await responseJson(completeResponse);
    expect(completed).toMatchObject({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      asset: {
        kind: 'pro-r2',
        assetId: reservation.assetId,
        version: 1,
        byteLength: media.byteLength,
        mime: media.mime,
        sha256: media.sha256,
      },
      queueItem: {
        queueItemId: reservation.queueItemId,
        kind: 'audio',
        name: media.name,
        addedBy: 'current_api_key',
        title: media.title,
        artist: media.artist,
        byteLength: media.byteLength,
      },
      playlistRevision: 1,
      quota: { reservedBytes: 0, usedBytes: media.byteLength },
    });
    expect(internal.room.runtime).toBe('sleeping');
    expect(internal.room.playlist).toHaveLength(1);
    expect(internal.room.playlist[0]).toHaveProperty('developerOwnerKeyId', keyId);
    expect(internal.room.playback).toMatchObject({ state: 'idle', queueItemId: null });

    const replayResponse = await completeInternalDeveloperUpload(
      worker,
      keyId,
      'developer-upload-complete-0001',
      reservation.assetId,
    );
    expect(replayResponse.status).toBe(201);
    expect(await responseJson(replayResponse)).toEqual(completed);
    expect(internal.room.playlist).toHaveLength(1);

    const clearOwned = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-upload-clear-owned',
      { type: 'clear_owned' },
    );
    expect(clearOwned.status).toBe(200);
    expect(await responseJson(clearOwned)).toMatchObject({ items: [], currentQueueItemId: null });
    expect(internal.room.playlist).toEqual([]);
    expect(asset.gcAfterMs).toBeGreaterThan(Date.now());
  });

  it('hints the exact capable coordinator only after queue and upload completion commits', async () => {
    const { worker, state, bucket, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    const capability = await worker.fetch(
      jsonRequest('/signaling-tickets', 'POST', { developerControlVersion: 1 }, ownerCookie),
    );
    expect(capability.status).toBe(200);

    const dispatchedBodies: Array<Record<string, any>> = [];
    const dispatchFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, any>;
      dispatchedBodies.push(body);
      const persisted = state.storage.data.get('pro-room:v1') as Record<string, any>;
      expect(persisted.revision).toBe(body.frame.revision);
      expect(persisted.playlistRevision).toBe(body.frame.playlistRevision);
      return Response.json({ dispatched: true });
    });
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatchFetch })),
    };

    const queueResponse = await mutateInternalDeveloperQueue(
      worker,
      'H'.repeat(16),
      'developer-invalidation-queue-0001',
      { type: 'add_youtube', videoId: 'dQw4w9WgXcQ', name: 'Queue hint' },
      '🎧'.repeat(32),
    );
    expect(queueResponse.status).toBe(201);
    await vi.waitFor(() => expect(dispatchedBodies).toHaveLength(1));

    const firstRequest = dispatchFetch.mock.calls[0]?.[0];
    expect(new URL(firstRequest.url).pathname).toBe('/internal/developer/v1/invalidate');
    const firstBody = dispatchedBodies[0]!;
    expect(firstBody).toMatchObject({
      roomCode: ROOM_CODE,
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      coordinatorParticipantId: internal.room.presence.coordinatorParticipantId,
      developerControlVersion: 1,
      frame: {
        type: 'developer-invalidation',
        version: 1,
        roomCode: ROOM_CODE,
        coordinatorEpoch: internal.room.presence.coordinatorEpoch,
        revision: internal.room.revision,
        playlistRevision: internal.room.playlistRevision,
      },
      addition: {
        type: 'pro-queue-addition',
        version: 1,
        roomCode: ROOM_CODE,
        coordinatorEpoch: internal.room.presence.coordinatorEpoch,
        playlistRevision: internal.room.playlistRevision,
        actorName: '🎧'.repeat(15),
        count: 1,
      },
    });
    expect(firstBody.addition.actorName.length).toBe(30);
    expect(firstBody.addition.eventId).toMatch(/^qa_000001_\d+_\d+$/);
    expect(firstBody.coordinatorPresenceIncarnationId).toBe(
      internal.room.presence.participants[firstBody.coordinatorParticipantId].presenceIncarnationId,
    );

    const queueReplay = await mutateInternalDeveloperQueue(
      worker,
      'H'.repeat(16),
      'developer-invalidation-queue-0001',
      { type: 'add_youtube', videoId: 'dQw4w9WgXcQ', name: 'Queue hint' },
      '🎧'.repeat(32),
    );
    expect(queueReplay.status).toBe(201);
    await Promise.resolve();
    expect(dispatchedBodies).toHaveLength(1);

    const media = { name: 'Hint.wav', byteLength: 44, mime: 'audio/wav' };
    const reservation = await responseJson(
      await createInternalDeveloperUpload(
        worker,
        'H'.repeat(16),
        'developer-invalidation-upload-reserve',
        media,
      ),
    );
    expect(dispatchFetch).toHaveBeenCalledTimes(1);
    const asset = internal.room.assets[reservation.assetId];
    bucket.objects.set(asset.stagingObjectKey, {
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
      customMetadata: {
        'mxqr-room': ROOM_CODE,
        'mxqr-asset': asset.assetId,
        'mxqr-version': String(asset.version),
        'mxqr-bytes': String(asset.byteLength),
      },
    });

    const completion = await completeInternalDeveloperUpload(
      worker,
      'H'.repeat(16),
      'developer-invalidation-upload-complete',
      reservation.assetId,
      'Uploader bot',
    );
    expect(completion.status).toBe(201);
    await vi.waitFor(() => expect(dispatchedBodies).toHaveLength(2));
    const secondBody = dispatchedBodies[1]!;
    expect(secondBody.frame).toMatchObject({
      type: 'developer-invalidation',
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
    });
    expect(secondBody.addition).toMatchObject({
      type: 'pro-queue-addition',
      actorName: 'Uploader bot',
      count: 1,
      playlistRevision: internal.room.playlistRevision,
    });

    const batchResponse = await mutateInternalDeveloperQueue(
      worker,
      'H'.repeat(16),
      'developer-invalidation-batch-0001',
      {
        type: 'add_youtube_batch',
        items: [
          { videoId: 'M7lc1UVf-VE', name: 'Batch one' },
          { videoId: '9bZkp7q19f0', name: 'Batch two' },
        ],
      },
      'Batch bot',
    );
    expect(batchResponse.status).toBe(201);
    await vi.waitFor(() => expect(dispatchedBodies).toHaveLength(3));
    expect(dispatchedBodies[2]?.addition).toMatchObject({
      type: 'pro-queue-addition',
      actorName: 'Batch bot',
      count: 2,
      playlistRevision: internal.room.playlistRevision,
    });

    const current = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const participantQueueItemId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const participantMutation = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: current.snapshot.revision,
          playlist: [
            ...current.snapshot.playlist,
            {
              queueItemId: participantQueueItemId,
              name: 'Owner addition',
              source: { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
            },
          ],
          currentQueueItemId: current.snapshot.currentQueueItemId,
          playback: current.snapshot.playback,
        },
        ownerCookie,
        'participant-invalidation-addition-0001',
      ),
    );
    expect(participantMutation.status).toBe(200);
    await vi.waitFor(() => expect(dispatchedBodies).toHaveLength(4));
    expect(dispatchedBodies[3]?.addition).toMatchObject({
      type: 'pro-queue-addition',
      actorName: 'Owner',
      count: 1,
      playlistRevision: internal.room.playlistRevision,
    });
  });

  it('recovers a Developer API completion when the final object exists but staging cleanup already ran', async () => {
    const { worker, bucket } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const keyId = 'W'.repeat(16);
    const media = { name: 'Recovery.wav', byteLength: 44, mime: 'audio/wav' };
    const reserved = await responseJson(
      await createInternalDeveloperUpload(
        worker,
        keyId,
        'developer-upload-recovery-reserve',
        media,
      ),
    );
    const asset = internal.room.assets[reserved.assetId];
    bucket.objects.set(asset.objectKey, {
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
      customMetadata: {
        'mxqr-room': ROOM_CODE,
        'mxqr-asset': asset.assetId,
        'mxqr-version': String(asset.version),
        'mxqr-bytes': String(asset.byteLength),
      },
    });
    expect(bucket.objects.has(asset.stagingObjectKey)).toBe(false);

    const response = await completeInternalDeveloperUpload(
      worker,
      keyId,
      'developer-upload-recovery-complete',
      reserved.assetId,
    );
    expect(response.status).toBe(201);
    expect((await responseJson(response)).queueItem).toMatchObject({
      queueItemId: reserved.queueItemId,
      kind: 'audio',
      name: media.name,
    });
    expect(internal.room.assets[reserved.assetId].status).toBe('ready');
    expect(internal.room.playlist).toHaveLength(1);
  });

  it('keeps every root internal path unreachable on the public PRO hostname', async () => {
    const response = await proRoomWorker.fetch(
      new Request('https://pro.musixquare.com/internal/developer/v1/read', {
        method: 'POST',
        headers: { origin: 'https://musixquare.com', 'content-type': 'application/json' },
        body: JSON.stringify({ projection: 'room' }),
      }),
      environment(),
    );
    expect(response.status).toBe(404);
  });

  it('persists, dispatches, deduplicates, acknowledges, and fences Developer API commands', async () => {
    const { worker, state, ownerCookie, activationEnvelope } = await activatedRoom();
    const dispatchFetch = vi.fn(async () => Response.json({ dispatched: true }));
    const internal = worker as unknown as {
      env: Record<string, any>;
      room: {
        playlistRevision: number;
        playlist: Array<Record<string, any>>;
        currentQueueItemId: string | null;
        playback: Record<string, any>;
      };
    };
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatchFetch })),
    };
    const queueItemId = '44444444-4444-4444-8444-444444444444';
    internal.room.playlistRevision = 2;
    internal.room.playlist = [
      {
        queueItemId,
        name: 'Developer API test',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
    ];
    internal.room.currentQueueItemId = queueItemId;
    internal.room.playback = {
      coordinatorEpoch: activationEnvelope.snapshot.presence.coordinatorEpoch,
      revision: 4,
      state: 'paused',
      queueItemId,
      positionSeconds: 8,
      updatedAtMs: Date.now(),
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };

    const capability = await worker.fetch(
      jsonRequest('/signaling-tickets', 'POST', { developerControlVersion: 1 }, ownerCookie),
    );
    expect(capability.status).toBe(200);
    expect((await responseJson(await internalDeveloperRead(worker, 'room'))).controlAvailable).toBe(
      true,
    );

    const keyId = 'ApiKeyId12345678';
    const idempotencyKey = 'developer-command-0001';
    const createRequest = (command: Record<string, unknown>) =>
      worker.fetch(
        new Request('https://pro-room.internal/internal/developer/v1/commands/create', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': ROOM_CODE,
          },
          body: JSON.stringify({ roomCode: ROOM_CODE, keyId, idempotencyKey, command }),
        }),
      );
    const persistedSizes: number[] = [];
    const originalPut = state.storage.put.bind(state.storage);
    const putSpy = vi.spyOn(state.storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'pro-room:v1') {
        persistedSizes.push(new TextEncoder().encode(JSON.stringify(value)).byteLength);
      }
      await originalPut(key, value);
    });
    const createdResponse = await createRequest({ type: 'play' });
    putSpy.mockRestore();
    expect(createdResponse.status).toBe(202);
    const created = await responseJson(createdResponse);
    expect(created).toMatchObject({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      status: 'dispatched',
    });
    expect(created.commandId).toMatch(/^cmd_[A-Za-z0-9_-]{22}$/);
    expect(dispatchFetch).toHaveBeenCalledTimes(1);
    expect(persistedSizes).toHaveLength(2);
    // The persisted pre-dispatch capacity reserve is consumed before the
    // cross-DO send, so the post-send write can never be the larger state.
    expect(persistedSizes[1]).toBeLessThanOrEqual(persistedSizes[0]!);
    const dispatchedRequest = dispatchFetch.mock.calls[0]?.[0] as Request;
    await expect(dispatchedRequest.json()).resolves.toMatchObject({
      roomCode: ROOM_CODE,
      coordinatorParticipantId: activationEnvelope.snapshot.viewer.participantId,
      developerControlVersion: 1,
      frame: {
        commandId: created.commandId,
        expected: { queueItemId, playlistRevision: 2, playbackRevision: 4 },
        command: { type: 'play' },
      },
    });

    const replay = await responseJson(await createRequest({ type: 'play' }));
    expect(replay).toEqual(created);
    expect(dispatchFetch).toHaveBeenCalledTimes(1);
    const conflict = await createRequest({ type: 'pause' });
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toEqual({ error: 'IDEMPOTENCY_CONFLICT' });

    const ack = await worker.fetch(
      jsonRequest(
        `/developer-commands/${created.commandId}/ack`,
        'POST',
        { resultCode: 'applied' },
        ownerCookie,
      ),
    );
    expect(ack.status).toBe(200);
    expect(await responseJson(ack)).toEqual({ ok: true });
    const duplicateAck = await worker.fetch(
      jsonRequest(
        `/developer-commands/${created.commandId}/ack`,
        'POST',
        { resultCode: 'applied' },
        ownerCookie,
      ),
    );
    expect(duplicateAck.status).toBe(200);

    const status = await worker.fetch(
      new Request('https://pro-room.internal/internal/developer/v1/commands/status', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({ roomCode: ROOM_CODE, keyId, commandId: created.commandId }),
      }),
    );
    expect(await responseJson(status)).toMatchObject({ status: 'applied', resultCode: 'applied' });
  });

  it('keeps command idempotency isolated from a saturated browser ledger and exact after terminal eviction', async () => {
    const { worker, ownerCookie, dispatchFetch, internal } = await preparedDeveloperCommandRoom();
    const keyId = 'ApiKeyId12345678';
    const idempotencyKey = 'developer-command-1001';
    const nowMs = Date.now();
    for (let index = 0; index < 256; index += 1) {
      internal.room.idempotency[`browser-checkpoint:${index}`] = {
        fingerprint: 'f'.repeat(43),
        body: { snapshot: true },
        status: 200,
        expiresAtMs: nowMs + 24 * 60 * 60 * 1000 + index,
      };
    }

    const first = await responseJson(
      await createInternalDeveloperCommand(worker, keyId, idempotencyKey, { type: 'play' }),
    );
    const replayWhileLive = await responseJson(
      await createInternalDeveloperCommand(worker, keyId, idempotencyKey, { type: 'play' }),
    );
    expect(replayWhileLive).toEqual(first);
    expect(dispatchFetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(internal.room.idempotency)).toHaveLength(256);
    expect(Object.keys(internal.room.developerCommandIdempotency)).toHaveLength(1);

    const ack = await worker.fetch(
      jsonRequest(
        `/developer-commands/${first.commandId}/ack`,
        'POST',
        { resultCode: 'applied' },
        ownerCookie,
      ),
    );
    expect(ack.status).toBe(200);

    // Fill the bounded command-status ledger with newer terminal entries. The
    // oldest command may be evicted, but its dedicated idempotency record must
    // retain the terminal body rather than the original pending response.
    for (let index = 0; index < 63; index += 1) {
      const commandId = `cmd_${String(index).padStart(22, '0')}`;
      internal.room.developerCommands[commandId] = {
        roomCode: ROOM_CODE,
        commandId,
        keyId,
        idempotencyKey: `terminal-command-${String(index).padStart(3, '0')}`,
        command: { type: 'pause' },
        createdAtMs: nowMs + 1_000 + index,
        expiresAtMs: nowMs + 30_000,
        retainUntilMs: nowMs + 10 * 60 * 1000,
        coordinatorEpoch: internal.room.presence.coordinatorEpoch,
        coordinatorParticipantId: internal.room.presence.coordinatorParticipantId,
        coordinatorPresenceIncarnationId:
          internal.room.presence.participants[internal.room.presence.coordinatorParticipantId]
            .presenceIncarnationId,
        expected: {
          queueItemId: internal.room.currentQueueItemId,
          playlistRevision: internal.room.playlistRevision,
          playbackRevision: internal.room.playback.revision,
        },
        status: 'rejected',
        attempts: 1,
        resultCode: 'busy',
        completedAtMs: nowMs + 1_000 + index,
      };
    }
    expect(Object.keys(internal.room.developerCommands)).toHaveLength(64);

    await createInternalDeveloperCommand(worker, keyId, 'developer-command-1002', {
      type: 'pause',
    });
    expect(internal.room.developerCommands[first.commandId]).toBeUndefined();
    const terminalReplay = await responseJson(
      await createInternalDeveloperCommand(worker, keyId, idempotencyKey, { type: 'play' }),
    );
    expect(terminalReplay).toMatchObject({
      commandId: first.commandId,
      status: 'applied',
      resultCode: 'applied',
    });
    expect(dispatchFetch).toHaveBeenCalledTimes(2);

    const retainedStatusRequest = (requestedKeyId: string) =>
      worker.fetch(
        new Request('https://pro-room.internal/internal/developer/v1/commands/status', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': ROOM_CODE,
          },
          body: JSON.stringify({
            roomCode: ROOM_CODE,
            keyId: requestedKeyId,
            commandId: first.commandId,
          }),
        }),
      );
    const retainedStatus = await retainedStatusRequest(keyId);
    expect(retainedStatus.status).toBe(200);
    expect(await responseJson(retainedStatus)).toMatchObject({
      commandId: first.commandId,
      status: 'applied',
      resultCode: 'applied',
    });
    const otherKeyStatus = await retainedStatusRequest('B'.repeat(16));
    expect(otherKeyStatus.status).toBe(404);
  });

  it('bounds a stalled signaling dispatch and leaves a retryable tracked command', async () => {
    const stalledDispatch = vi.fn(
      (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const { worker, internal } = await preparedDeveloperCommandRoom(stalledDispatch);
    const startedAt = Date.now();
    const create = createInternalDeveloperCommand(
      worker,
      'ApiKeyId12345678',
      'developer-command-timeout',
      { type: 'play' },
    );
    const response = await create;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(response.status).toBe(202);
    const body = await responseJson(response);
    expect(body).toMatchObject({ status: 'pending' });
    expect(stalledDispatch).toHaveBeenCalledTimes(1);
    expect(internal.room.developerCommands[body.commandId]).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
  });

  it('accepts only an exact coordinator expired ACK after server-side expiry', async () => {
    const { worker, ownerCookie, internal } = await preparedDeveloperCommandRoom();
    const created = await responseJson(
      await createInternalDeveloperCommand(
        worker,
        'ApiKeyId12345678',
        'developer-command-expired',
        { type: 'play' },
      ),
    );
    internal.room.developerCommands[created.commandId].expiresAtMs = Date.now() - 1;

    const expiredAck = await worker.fetch(
      jsonRequest(
        `/developer-commands/${created.commandId}/ack`,
        'POST',
        { resultCode: 'expired' },
        ownerCookie,
      ),
    );
    expect(expiredAck.status).toBe(200);
    expect(internal.room.developerCommands[created.commandId]).toMatchObject({
      status: 'expired',
      resultCode: 'expired',
    });
    expect(
      Number.isSafeInteger(internal.room.developerCommands[created.commandId].acknowledgedAtMs),
    ).toBe(true);

    const conflictingAck = await worker.fetch(
      jsonRequest(
        `/developer-commands/${created.commandId}/ack`,
        'POST',
        { resultCode: 'applied' },
        ownerCookie,
      ),
    );
    expect(conflictingAck.status).toBe(409);
  });
});

describe('persistent PRO room bootstrap and activation', () => {
  it('suspends an active room without deleting durable content and resumes only for fresh sessions', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-07-18T01:00:00.000Z');
    vi.setSystemTime(startedAtMs);
    const context = await activatedRoom();
    const ready = await completeReadyAsset(context, 'admin-suspend');
    const queueItemId = '018f977e-5df5-4c8f-bb80-55d847ddec8f';
    expect(
      (
        await replacePlaylist(
          context,
          [playlistItem(queueItemId, ready.asset)],
          'admin-suspend-playlist',
        )
      ).status,
    ).toBe(200);

    const memberResponse = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    expect(memberResponse.status).toBe(200);
    const memberCookie = cookieFrom(memberResponse);
    bindCookiePresence(memberCookie, await responseJson(memberResponse));

    const acquiredResponse = await context.worker.fetch(
      jsonRequest('/system-audio/acquire', 'POST', {}, context.ownerCookie),
    );
    expect(acquiredResponse.status).toBe(200);
    const acquired = await responseJson(acquiredResponse);
    const internal = context.worker as unknown as { room: Record<string, any> };
    internal.room.currentQueueItemId = queueItemId;
    internal.room.playback = {
      ...internal.room.playback,
      state: 'playing',
      queueItemId,
      positionSeconds: 42,
      updatedAtMs: startedAtMs,
    };

    const preserved = structuredClone({
      playlist: internal.room.playlist,
      assets: internal.room.assets,
      quota: internal.room.quota,
      pin: internal.room.pin,
      ownerMemberId: internal.room.ownerMemberId,
      ownerCredentialHash: internal.room.ownerCredentialHash,
    });
    const authEpoch = internal.room.authEpoch as number;
    const coordinatorEpoch = internal.room.presence.coordinatorEpoch as number;
    const systemAudioGeneration = acquired.systemAudio.generation as number;
    expect(Object.keys(internal.room.sessions)).toHaveLength(2);
    expect(Object.keys(internal.room.presence.participants)).toHaveLength(2);

    vi.setSystemTime(startedAtMs + 5_000);
    const suspend = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/admin/suspend', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(suspend.status).toBe(200);
    expect(await responseJson(suspend)).toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      status: 'suspended',
      changed: true,
    });
    expect(internal.room).toMatchObject({
      status: 'suspended',
      runtime: 'sleeping',
      authEpoch: authEpoch + 1,
      currentQueueItemId: queueItemId,
      playback: {
        state: 'playing',
        queueItemId,
        positionSeconds: 47,
        updatedAtMs: startedAtMs + 5_000,
      },
      presence: {
        coordinatorEpoch: coordinatorEpoch + 1,
        coordinatorParticipantId: null,
        participants: {},
      },
      sessions: {},
      systemAudio: {
        generation: systemAudioGeneration + 1,
        status: 'idle',
        ownerParticipantId: null,
        publication: null,
      },
    });
    expect({
      playlist: internal.room.playlist,
      assets: internal.room.assets,
      quota: internal.room.quota,
      pin: internal.room.pin,
      ownerMemberId: internal.room.ownerMemberId,
      ownerCredentialHash: internal.room.ownerCredentialHash,
    }).toEqual(preserved);
    expect(await responseJson(await context.worker.fetch(request('/bootstrap')))).toEqual({
      roomCode: ROOM_CODE,
      status: 'suspended',
    });
    expect((await context.worker.fetch(request('/snapshot', {}, context.ownerCookie))).status).toBe(
      401,
    );
    expect(
      (
        await context.worker.fetch(
          jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Blocked' }),
        )
      ).status,
    ).toBe(423);

    const suspendedState = structuredClone(internal.room);
    const repeatedSuspend = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/admin/suspend', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(await responseJson(repeatedSuspend)).toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      status: 'suspended',
      changed: false,
    });
    expect(internal.room).toEqual(suspendedState);

    const resume = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/admin/resume', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(await responseJson(resume)).toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      status: 'active',
      changed: true,
    });
    expect(internal.room).toMatchObject({
      status: 'active',
      runtime: 'sleeping',
      sessions: {},
      presence: { coordinatorParticipantId: null, participants: {} },
    });
    expect((await context.worker.fetch(request('/snapshot', {}, context.ownerCookie))).status).toBe(
      401,
    );

    const resumedState = structuredClone(internal.room);
    const repeatedResume = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/admin/resume', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(await responseJson(repeatedResume)).toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      status: 'active',
      changed: false,
    });
    expect(internal.room).toEqual(resumedState);

    const freshSession = await context.worker.fetch(
      jsonRequest(
        '/sessions',
        'POST',
        { pin: '12345678', displayName: 'Fresh Owner' },
        context.ownerRecoveryCookie,
      ),
    );
    expect(freshSession.status).toBe(200);
    expect((await responseJson(freshSession)).snapshot).toMatchObject({
      status: 'active',
      runtime: 'awake',
      playback: { state: 'playing', positionSeconds: 47 },
      viewer: { role: 'owner', displayName: 'Fresh Owner' },
    });
  });

  it('permanently decommissions a room, sweeps late R2 uploads, and preserves its tombstone', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-07-18T02:00:00.000Z');
    vi.setSystemTime(startedAtMs);
    const context = await activatedRoom();
    const ready = await completeReadyAsset(context, 'admin-decommission');
    const queueItemId = '018f977e-5df5-4c8f-bb80-55d847ddec9f';
    expect(
      (
        await replacePlaylist(
          context,
          [playlistItem(queueItemId, ready.asset)],
          'admin-decommission-playlist',
        )
      ).status,
    ).toBe(200);
    const memberResponse = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    expect(memberResponse.status).toBe(200);
    bindCookiePresence(cookieFrom(memberResponse), await responseJson(memberResponse));

    const orphanKey = `rooms/${ROOM_CODE}/assets/orphan/v1/staging_orphan`;
    const otherRoomKey = 'rooms/000002/assets/keep/v1/object_keep';
    context.bucket.objects.set(orphanKey, { size: 17 });
    context.bucket.objects.set(otherRoomKey, { size: 23 });

    let registryStatus = 'decommissioning';
    const registryRun = vi.fn(async () => {
      registryStatus = 'decommissioned';
      return { meta: { changes: 1 } };
    });
    const adminDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: registryRun,
          first: vi.fn(async () => ({ status: registryStatus })),
          all: vi.fn(async () => ({ results: [{ status: registryStatus }] })),
        })),
      })),
    };
    const signalingFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/internal/admin/v1/decommission');
      await expect(request.json()).resolves.toEqual({
        roomCode: ROOM_CODE,
        requestId: '018f977e-5df5-4c8f-bb80-55d847ddec9f',
      });
      return Response.json({ ok: true, roomCode: ROOM_CODE, status: 'decommissioned' });
    });
    const developerQueries: Array<{ sql: string; values: unknown[] }> = [];
    const developerApiDb = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          run: vi.fn(async () => {
            developerQueries.push({ sql, values });
            return { meta: { changes: 1 } };
          }),
        })),
      })),
    };
    const limiterFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/internal/admin/v1/decommission');
      expect(request.headers.get('x-mxqr-pro-room-code')).toBe(ROOM_CODE);
      await expect(request.json()).resolves.toEqual({
        roomCode: ROOM_CODE,
        requestId: '018f977e-5df5-4c8f-bb80-55d847ddec9f',
      });
      return Response.json({ ok: true, roomCode: ROOM_CODE });
    });
    const limiterIdFromName = vi.fn((name: string) => name);
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
      alarm(): Promise<void>;
    };
    internal.env.MUSIXQUARE_ADMIN_DB = adminDb;
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((roomCode: string) => roomCode),
      get: vi.fn(() => ({ fetch: signalingFetch })),
    };
    internal.env.DEVELOPER_API_DB = developerApiDb;
    internal.env.DEVELOPER_API_LIMITERS = {
      idFromName: limiterIdFromName,
      get: vi.fn(() => ({ fetch: limiterFetch })),
    };
    internal.env.DECOMMISSION_FINAL_EMPTY_WINDOW_SECONDS = 60;

    expect(internal.room).toMatchObject({
      provisioned: true,
      status: 'active',
      pin: expect.any(Object),
    });
    expect(internal.room.playlist).toHaveLength(1);
    expect(Object.keys(internal.room.sessions)).toHaveLength(2);
    expect(Object.keys(internal.room.assets)).toHaveLength(1);

    const decommissionRequest = () =>
      new Request('https://pro-room.internal/internal/admin/decommission', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({
          roomCode: ROOM_CODE,
          requestId: '018f977e-5df5-4c8f-bb80-55d847ddec9f',
        }),
      });
    const decommissioned = await context.worker.fetch(decommissionRequest());
    expect(decommissioned.status).toBe(202);
    await expect(decommissioned.json()).resolves.toMatchObject({
      ok: true,
      roomCode: ROOM_CODE,
      status: 'decommissioning',
      changed: true,
      purgeAfterMs: expect.any(Number),
      completedAtMs: null,
    });

    expect(internal.room).toMatchObject({
      provisioned: false,
      status: 'decommissioning',
      runtime: 'sleeping',
      playlist: [],
      pin: null,
      ownerMemberId: null,
      ownerCredentialHash: null,
      sessions: {},
      assets: {},
      quota: { usedBytes: 0, reservedBytes: 0 },
      decommission: {
        signalingCleared: true,
        initialSweepCompleted: true,
        developerDataCleared: true,
        developerLimiterCleared: true,
        purgeAfterMs: expect.any(Number),
      },
    });
    expect(context.bucket.objects.has(ready.asset.objectKey)).toBe(false);
    expect(context.bucket.objects.has(orphanKey)).toBe(false);
    expect(context.bucket.objects.has(otherRoomKey)).toBe(true);
    expect(signalingFetch).toHaveBeenCalledTimes(1);
    const initialDeveloperDeletes = developerQueries.filter(({ sql }) => /^DELETE FROM /.test(sql));
    expect(initialDeveloperDeletes).toHaveLength(3);
    expect(
      developerQueries.filter(({ sql }) =>
        /INSERT INTO mxqr_developer_api_room_tombstones/.test(sql),
      ),
    ).toHaveLength(1);
    expect(
      initialDeveloperDeletes.map(
        ({ sql }) => sql.match(/^DELETE FROM (\S+) WHERE room_code = \?1$/)?.[1],
      ),
    ).toEqual([
      'mxqr_developer_api_keys',
      'mxqr_developer_api_audit',
      'mxqr_developer_api_admin_audit',
    ]);
    expect(initialDeveloperDeletes.every(({ values }) => values[0] === ROOM_CODE)).toBe(true);
    expect(limiterIdFromName).toHaveBeenCalledOnce();
    expect(limiterIdFromName).toHaveBeenCalledWith(`room:${ROOM_CODE}`);
    expect(limiterFetch).toHaveBeenCalledTimes(1);
    expect(registryStatus).toBe('decommissioning');

    const lateObjectKey = `rooms/${ROOM_CODE}/assets/late/v1/staging_late`;
    context.bucket.objects.set(lateObjectKey, { size: 29 });
    const purgeAfterMs = internal.room.decommission.purgeAfterMs as number;
    expect(context.state.storage.alarm).toBe(purgeAfterMs);
    vi.setSystemTime(purgeAfterMs + 1);
    await internal.alarm();

    expect(context.bucket.objects.has(lateObjectKey)).toBe(false);
    expect(context.bucket.objects.has(otherRoomKey)).toBe(true);
    expect(registryStatus).toBe('decommissioning');
    expect(internal.room.status).toBe('decommissioning');

    const quietWindowLateKey = `rooms/${ROOM_CODE}/assets/quiet-window/v1/staging_late`;
    context.bucket.objects.set(quietWindowLateKey, { size: 31 });
    vi.setSystemTime(purgeAfterMs + 60_001);
    await internal.alarm();
    expect(context.bucket.objects.has(quietWindowLateKey)).toBe(false);
    expect(internal.room.status).toBe('decommissioning');

    vi.setSystemTime(purgeAfterMs + 120_001);
    await internal.alarm();
    expect(registryStatus).toBe('decommissioned');
    expect(registryRun).toHaveBeenCalledTimes(1);
    expect(internal.room).toMatchObject({
      provisioned: false,
      status: 'decommissioned',
      playlist: [],
      pin: null,
      sessions: {},
      assets: {},
      decommission: {
        requestId: '018f977e-5df5-4c8f-bb80-55d847ddec9f',
        completedAtMs: purgeAfterMs + 120_001,
        maintenanceAtMs: purgeAfterMs + 120_001 + 24 * 60 * 60 * 1000,
      },
    });

    const postCompletionKey = `rooms/${ROOM_CODE}/assets/post-completion/v1/straggler`;
    context.bucket.objects.set(postCompletionKey, { size: 37 });
    const maintenanceAtMs = internal.room.decommission.maintenanceAtMs as number;
    vi.setSystemTime(maintenanceAtMs);
    await internal.alarm();
    expect(context.bucket.objects.has(postCompletionKey)).toBe(false);
    expect(internal.room).toMatchObject({
      status: 'decommissioned',
      decommission: {
        completedAtMs: purgeAfterMs + 120_001,
        maintenanceAtMs: maintenanceAtMs + 24 * 60 * 60 * 1000,
      },
    });

    const repeated = await context.worker.fetch(decommissionRequest());
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      status: 'decommissioned',
      changed: false,
      completedAtMs: purgeAfterMs + 120_001,
    });
    expect(signalingFetch).toHaveBeenCalledTimes(5);
    expect(
      developerQueries.filter(({ sql }) =>
        /INSERT INTO mxqr_developer_api_room_tombstones/.test(sql),
      ),
    ).toHaveLength(5);
    expect(developerApiDb.prepare).toHaveBeenCalledTimes(20);
    expect(limiterFetch).toHaveBeenCalledTimes(5);

    const restarted = new MusixquareProRoom(context.state as never, internal.env as never);
    const reprovision = await restarted.fetch(
      new Request('https://pro-room.internal/internal/admin/provision', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(reprovision.status).toBe(410);
    await expect(reprovision.json()).resolves.toEqual({
      error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED',
    });
  });

  it('rejects suspend and resume for rooms that have not been activated or provisioned', async () => {
    const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
    const internalRequest = (roomCode: string, operation: 'suspend' | 'resume') =>
      new Request(`https://pro-room.internal/internal/admin/${operation}`, {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': roomCode },
      });

    const inactiveSuspend = await worker.fetch(internalRequest(ROOM_CODE, 'suspend'));
    expect(inactiveSuspend.status).toBe(409);
    expect(await responseJson(inactiveSuspend)).toEqual({ error: 'ROOM_NOT_ACTIVE' });
    const inactiveResume = await worker.fetch(internalRequest(ROOM_CODE, 'resume'));
    expect(inactiveResume.status).toBe(409);
    expect(await responseJson(inactiveResume)).toEqual({ error: 'ROOM_NOT_SUSPENDED' });

    const unprovisioned = new MusixquareProRoom(new FakeState() as never, environment() as never);
    for (const operation of ['suspend', 'resume'] as const) {
      const response = await unprovisioned.fetch(internalRequest('000002', operation));
      expect(response.status).toBe(404);
      expect(await responseJson(response)).toEqual({ error: 'ROOM_NOT_FOUND' });
    }
  });

  it('fails a suspend fence atomically when its bounded revisions are exhausted', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    internal.room.playback.state = 'playing';
    internal.room.playback.updatedAtMs = Date.now();
    internal.room.playback.revision = Number.MAX_SAFE_INTEGER - 1;
    const before = structuredClone(internal.room);

    const response = await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/suspend', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );

    expect(response.status).toBe(409);
    expect(await responseJson(response)).toEqual({ error: 'REVISION_EXHAUSTED' });
    expect(internal.room).toEqual(before);
  });

  it('never exposes an owner claim in public bootstrap and rejects invalid activation uniformly', async () => {
    const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
    const bootstrap = await worker.fetch(request('/bootstrap'));
    expect(await responseJson(bootstrap)).toEqual({
      roomCode: ROOM_CODE,
      status: 'activation_required',
    });

    const invalidClaim = `v1.${'a'.repeat(32)}.${'b'.repeat(43)}`;
    const wrongClaim = await worker.fetch(
      jsonRequest('/activation', 'POST', {
        claimToken: invalidClaim,
        temporaryPin: '00000001',
        newPin: '12345678',
      }),
    );
    const wrongTemporaryPin = await worker.fetch(
      jsonRequest('/activation', 'POST', {
        claimToken: invalidClaim,
        temporaryPin: '99999999',
        newPin: '12345678',
      }),
    );
    expect(wrongClaim.status).toBe(401);
    expect(wrongTemporaryPin.status).toBe(401);
    expect(await responseJson(wrongClaim)).toEqual({ error: 'ACTIVATION_INVALID' });
    expect(await responseJson(wrongTemporaryPin)).toEqual({ error: 'ACTIVATION_INVALID' });
  });

  it('atomically activates an owner session and returns a contract-valid snapshot', async () => {
    const { worker, state, ownerCookie } = await activatedRoom();
    const response = await worker.fetch(request('/snapshot', {}, ownerCookie));
    const envelope = await responseJson(response);
    const snapshot = parseProRoomSnapshot(envelope.snapshot);
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      roomCode: ROOM_CODE,
      status: 'active',
      runtime: 'awake',
      viewer: { role: 'owner', displayName: 'Owner' },
      presence: { coordinatorEpoch: 1 },
    });
    expect(JSON.stringify(envelope)).not.toContain('objectKey');
    expect(JSON.stringify(envelope)).not.toContain(ACTIVATION_SECRET);
    const stored = state.storage.data.get('pro-room:v1') as StoredRoom;
    expect(stored.pin?.iterations).toBe(100_000);
  });

  it('fails closed instead of throwing for an over-limit stored PBKDF2 record', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: StoredRoom };
    expect(internal.room.pin).not.toBeNull();
    internal.room.pin!.iterations = 100_001;

    const response = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );

    expect(response.status).toBe(401);
    expect(await responseJson(response)).toEqual({ error: 'PIN_INVALID' });
  });

  it('has no public claim-issuance endpoint', async () => {
    const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
    const response = await worker.fetch(request('/claims', { method: 'POST' }));
    expect(response.status).toBe(404);
    expect(await responseJson(response)).toEqual({ error: 'NOT_FOUND' });
  });

  it('provisions a future leading-zero room only through its direct admin DO binding', async () => {
    const roomCode = '000002';
    const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
    const before = await worker.fetch(requestForRoom(roomCode, '/bootstrap'));
    expect(before.status).toBe(404);

    const provision = await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/provision', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': roomCode },
      }),
    );
    expect(provision.status).toBe(200);
    expect(await responseJson(provision)).toEqual({
      ok: true,
      roomCode,
      status: 'unactivated',
    });

    const after = await worker.fetch(requestForRoom(roomCode, '/bootstrap'));
    expect(after.status).toBe(200);
    expect(await responseJson(after)).toEqual({ roomCode, status: 'activation_required' });
  });

  it('rotates short-lived activation generations so only the newest admin link works', async () => {
    const roomCode = '000002';
    const state = new FakeState();
    const worker = new MusixquareProRoom(state as never, environment() as never);
    await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/provision', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': roomCode },
      }),
    );

    const issuedAt = Date.now();
    const first = await responseJson(
      await worker.fetch(
        new Request('https://pro-room.internal/internal/admin/activation-claim', {
          method: 'POST',
          headers: { 'x-mxqr-pro-room-code': roomCode },
        }),
      ),
    );
    const second = await responseJson(
      await worker.fetch(
        new Request('https://pro-room.internal/internal/admin/activation-claim', {
          method: 'POST',
          headers: { 'x-mxqr-pro-room-code': roomCode },
        }),
      ),
    );
    expect(second.expiresAt).toBeGreaterThan(issuedAt);
    expect(second.expiresAt).toBeLessThanOrEqual(issuedAt + 15 * 60 * 1000 + 1_000);

    const claimFrom = (activationUrl: string): string => {
      const encoded = new URL(activationUrl).hash.match(/^#pro-claim=(.+)$/)?.[1];
      if (!encoded) throw new Error('missing claim fragment');
      return decodeURIComponent(encoded);
    };
    const stale = await worker.fetch(
      jsonRequestForRoom(roomCode, '/activation', 'POST', {
        claimToken: claimFrom(first.activationUrl),
        temporaryPin: '00000002',
        newPin: '12345678',
      }),
    );
    expect(stale.status).toBe(401);
    expect(await responseJson(stale)).toEqual({ error: 'ACTIVATION_INVALID' });

    const current = await worker.fetch(
      jsonRequestForRoom(roomCode, '/activation', 'POST', {
        claimToken: claimFrom(second.activationUrl),
        temporaryPin: '00000002',
        newPin: '12345678',
      }),
    );
    expect(current.status).toBe(200);
    expect(JSON.stringify(await responseJson(current))).not.toContain('pro-claim');
  });

  it('refuses activation claims whose requested lifetime exceeds fifteen minutes', async () => {
    const nowMs = Date.now();
    await expect(
      issueProRoomActivationClaim('000002', ACTIVATION_SECRET, {
        nowMs,
        expiresAtMs: nowMs + 15 * 60 * 1000 + 1,
      }),
    ).rejects.toThrow('Invalid expiry');
  });

  it('never forwards direct admin DO paths through the public Worker router', async () => {
    const env = environment() as ReturnType<typeof environment> & {
      PRO_ROOM_RATE_LIMIT_SECRET: string;
      PRO_ROOMS: {
        idFromName(value: string): string;
        get(value: string): { fetch(request: Request): Promise<Response> };
      };
    };
    env.PRO_ROOM_RATE_LIMIT_SECRET = 'rate-limit-secret-'.padEnd(48, 'r');
    let forwarded = 0;
    env.PRO_ROOMS = {
      idFromName: (value) => value,
      get: () => ({
        fetch: async () => {
          forwarded += 1;
          return new Response(null, { status: 204 });
        },
      }),
    };
    for (const path of [
      '/internal/admin/provision',
      '/internal/admin/suspend',
      '/internal/admin/resume',
      '/v1/rooms/000002/internal/admin/provision',
      '/v1/rooms/000002/internal/admin/suspend',
      '/v1/rooms/000002/internal/admin/resume',
    ]) {
      const response = await proRoomWorker.fetch(
        new Request(`https://pro.musixquare.com${path}`, {
          method: 'POST',
          headers: { origin: 'https://musixquare.com' },
        }),
        env as never,
      );
      expect(response.status).toBe(404);
    }
    expect(forwarded).toBe(0);
  });

  it('cold-loads a bounded registered-code cache before creating a dynamic room DO', async () => {
    let registryReads = 0;
    const forwardedCodes: string[] = [];
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            registryReads += 1;
            return {
              results: [
                { room_code: '000010' },
                // A half-finished admin registration must not reach a DO.
                { room_code: '000011', status: 'provisioning' },
              ].filter((row) => row.status === undefined),
            };
          },
        }),
      }),
    };
    const env = {
      ...environment(),
      MUSIXQUARE_ADMIN_DB: db,
      PRO_ROOM_RATE_LIMIT_SECRET: 'rate-limit-secret-'.padEnd(48, 'r'),
      PRO_ROOMS: {
        idFromName: (value: string) => value,
        get: (value: string) => ({
          fetch: async () => {
            forwardedCodes.push(value);
            return new Response(
              JSON.stringify({ roomCode: value, status: 'activation_required' }),
              {
                headers: { 'content-type': 'application/json' },
              },
            );
          },
        }),
      },
    };
    const publicBootstrap = (roomCode: string) =>
      proRoomWorker.fetch(
        new Request(`https://pro.musixquare.com/v1/rooms/${roomCode}/bootstrap`, {
          headers: { origin: 'https://musixquare.com', 'cf-connecting-ip': '192.0.2.44' },
        }),
        env as never,
      );

    expect((await publicBootstrap('000010')).status).toBe(200);
    expect((await publicBootstrap('000011')).status).toBe(404);
    expect((await publicBootstrap('000010')).status).toBe(200);
    expect(registryReads).toBe(1);
    expect(forwardedCodes).toEqual(['000010', '000010']);
  });

  it('scopes session and owner cookies per room so fixed rooms can coexist', async () => {
    const cookies: string[] = [];
    for (const roomCode of ['000000', '000001']) {
      const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
      const claimToken = await issueProRoomActivationClaim(roomCode, ACTIVATION_SECRET, {
        nowMs: Date.now() - 1_000,
        expiresAtMs: Date.now() + 60_000,
        nonce: `fixed-cookie-nonce-${roomCode}`,
      });
      const response = await worker.fetch(
        jsonRequestForRoom(roomCode, '/activation', 'POST', {
          claimToken,
          temporaryPin: roomCode.padStart(8, '0'),
          newPin: roomCode === '000000' ? '11111111' : '22222222',
        }),
      );
      expect(response.status).toBe(200);
      const setCookies = response.headers.getSetCookie();
      expect(
        setCookies.some((value) => value.startsWith(`__Host-mxqr_pro_session_${roomCode}=`)),
      ).toBe(true);
      expect(
        setCookies.some((value) => value.startsWith(`__Host-mxqr_pro_owner_${roomCode}=`)),
      ).toBe(true);
      cookies.push(...setCookies.map((value) => value.split(';')[0]!));
    }
    expect(cookies).toHaveLength(4);
    expect(new Set(cookies.map((value) => value.split('=')[0])).size).toBe(4);
  });

  it('sets credentialed CORS only for an explicit allowlisted origin', async () => {
    const state = new FakeState();
    const env = environment() as ReturnType<typeof environment> & {
      PRO_ROOM_RATE_LIMIT_SECRET: string;
      PRO_ROOMS: {
        idFromName(value: string): string;
        get(value: string): { fetch(request: Request): Promise<Response> };
      };
    };
    env.PRO_ROOM_RATE_LIMIT_SECRET = 'rate-limit-secret-'.padEnd(48, 'r');
    const durable = new MusixquareProRoom(state as never, env as never);
    env.PRO_ROOMS = {
      idFromName: (value) => value,
      get: () => ({ fetch: (incoming) => durable.fetch(incoming) }),
    };
    const allowed = await proRoomWorker.fetch(
      new Request(`${BASE_URL}/bootstrap`, {
        headers: { origin: 'https://musixquare.com', 'cf-connecting-ip': '192.0.2.1' },
      }),
      env as never,
    );
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://musixquare.com');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    expect(allowed.headers.get('vary')).toBe('origin');
    const preflight = await proRoomWorker.fetch(
      new Request(`${BASE_URL}/snapshot`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://musixquare.com',
          'access-control-request-method': 'GET',
          'access-control-request-headers':
            'x-mxqr-pro-participant-id,x-mxqr-pro-presence-incarnation',
        },
      }),
      env as never,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toBe(
      'content-type,idempotency-key,authorization,x-mxqr-pro-participant-id,x-mxqr-pro-presence-incarnation',
    );

    for (const previewOrigin of ['http://localhost:4173', 'http://127.0.0.1:4173']) {
      const preview = await proRoomWorker.fetch(
        new Request(`${BASE_URL}/bootstrap`, {
          headers: { origin: previewOrigin, 'cf-connecting-ip': '192.0.2.2' },
        }),
        env as never,
      );
      expect(preview.headers.get('access-control-allow-origin')).toBe(previewOrigin);
    }

    const blocked = await proRoomWorker.fetch(
      new Request(`${BASE_URL}/bootstrap`, { headers: { origin: 'https://evil.example' } }),
      env as never,
    );
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('persistent PRO room authentication, presence, and state', () => {
  it('restores the owner role from the separate host-only owner credential', async () => {
    const { worker, ownerCookie, ownerRecoveryCookie, activationEnvelope } = await activatedRoom();
    const closed = await worker.fetch(
      request('/sessions/current', { method: 'DELETE' }, ownerCookie),
    );
    expect(closed.status).toBe(200);
    expect(closed.headers.get('set-cookie')).toBeNull();
    const restored = await worker.fetch(
      jsonRequest(
        '/sessions',
        'POST',
        { pin: '12345678', displayName: 'Owner Again' },
        ownerRecoveryCookie,
      ),
    );
    const restoredEnvelope = await responseJson(restored);
    expect(restoredEnvelope.snapshot.viewer).toMatchObject({
      role: 'owner',
      memberId: activationEnvelope.snapshot.viewer.memberId,
    });
  });

  it('redeems a short-lived owner recovery claim once and revokes prior owner credentials', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const controllerResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    const controllerCookie = cookieFrom(controllerResponse);
    bindCookiePresence(controllerCookie, await responseJson(controllerResponse));
    const nowMs = Date.now();
    const wrongRoomClaim = await issueProRoomOwnerRecoveryClaim('000000', ACTIVATION_SECRET, {
      nowMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
      nonce: 'wrong-room-recovery-nonce',
    });
    const wrongRoom = await worker.fetch(
      jsonRequest('/owner-recovery', 'POST', { claimToken: wrongRoomClaim }),
    );
    expect(wrongRoom.status).toBe(401);
    expect(await responseJson(wrongRoom)).toEqual({ error: 'RECOVERY_INVALID' });
    await expect(
      issueProRoomOwnerRecoveryClaim(ROOM_CODE, ACTIVATION_SECRET, {
        nowMs,
        expiresAtMs: nowMs + 16 * 60_000,
        nonce: 'too-long-recovery-nonce',
      }),
    ).rejects.toThrow('Invalid expiry');
    const claimToken = await issueProRoomOwnerRecoveryClaim(ROOM_CODE, ACTIVATION_SECRET, {
      nowMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
      nonce: 'fixed-owner-recovery-nonce',
    });
    const recovered = await worker.fetch(
      jsonRequest('/owner-recovery', 'POST', { claimToken, displayName: 'Recovered Owner' }),
    );
    expect(recovered.status).toBe(200);
    const recoveryEnvelope = await responseJson(recovered);
    expect(recoveryEnvelope.snapshot.viewer).toMatchObject({
      role: 'owner',
      displayName: 'Recovered Owner',
    });
    expect(recovered.headers.getSetCookie()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^__Host-mxqr_pro_session_000001=/),
        expect.stringMatching(/^__Host-mxqr_pro_owner_000001=/),
      ]),
    );
    expect((await worker.fetch(request('/snapshot', {}, ownerCookie))).status).toBe(401);
    expect((await worker.fetch(request('/snapshot', {}, controllerCookie))).status).toBe(200);

    const replay = await worker.fetch(
      jsonRequest('/owner-recovery', 'POST', { claimToken, displayName: 'Replay' }),
    );
    expect(replay.status).toBe(409);
    expect(await responseJson(replay)).toEqual({ error: 'RECOVERY_CLAIM_USED' });
  });

  it('revokes controller sessions on owner PIN rotation while retaining the owner session', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const controller = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    expect(controller.status).toBe(200);
    const controllerCookie = cookieFrom(controller);
    expect(controllerCookie).toMatch(/^__Host-mxqr_pro_session_000001=/);
    expect(controller.headers.get('set-cookie')).not.toMatch(/Domain=/i);
    const sessionEnvelope = await responseJson(controller);
    bindCookiePresence(controllerCookie, sessionEnvelope);
    expect(Object.keys(sessionEnvelope)).toEqual(['snapshot', 'session']);
    expect(Object.keys(sessionEnvelope.session)).toEqual(['expiresAtMs']);
    expect(sessionEnvelope.snapshot.viewer).toMatchObject({
      role: 'controller',
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'coordinator.eligible',
        'members.manage',
      ],
    });
    expect(sessionEnvelope.snapshot.viewer.capabilities).not.toContain('room.configure');
    const epochBeforeRotation = sessionEnvelope.snapshot.presence.coordinatorEpoch as number;

    const rotate = await worker.fetch(
      jsonRequest('/pin', 'POST', { pin: '87654321' }, ownerCookie),
    );
    expect(await responseJson(rotate)).toEqual({ ok: true });
    const ownerAfterRotationResponse = await worker.fetch(request('/snapshot', {}, ownerCookie));
    expect(ownerAfterRotationResponse.status).toBe(200);
    const ownerAfterRotation = await responseJson(ownerAfterRotationResponse);
    expect(ownerAfterRotation.snapshot.presence.coordinatorEpoch).toBe(epochBeforeRotation + 1);
    expect(ownerAfterRotation.snapshot.presence.coordinatorParticipantId).toBe(
      ownerAfterRotation.snapshot.viewer.participantId,
    );
    expect((await worker.fetch(request('/snapshot', {}, controllerCookie))).status).toBe(401);

    const oldPin = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Old' }),
    );
    const newPin = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '87654321', displayName: 'New' }),
    );
    expect(oldPin.status).toBe(401);
    expect(newPin.status).toBe(200);
  });

  it('bulk-revokes multiple controllers with exactly one PIN security epoch advance', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const firstMemberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'First Friend' }),
    );
    const firstMemberCookie = cookieFrom(firstMemberResponse);
    bindCookiePresence(firstMemberCookie, await responseJson(firstMemberResponse));
    const secondMemberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Second Friend' }),
    );
    const secondMemberCookie = cookieFrom(secondMemberResponse);
    bindCookiePresence(secondMemberCookie, await responseJson(secondMemberResponse));

    const leaveOwner = await worker.fetch(
      request('/presence/current', { method: 'DELETE' }, ownerCookie),
    );
    expect(leaveOwner.status).toBe(200);
    const memberAsCoordinator = await responseJson(
      await worker.fetch(request('/snapshot', {}, firstMemberCookie)),
    );
    expect(memberAsCoordinator.snapshot.presence.coordinatorParticipantId).toBe(
      memberAsCoordinator.snapshot.viewer.participantId,
    );

    const ownerReentryResponse = await worker.fetch(
      request('/presence/enter', { method: 'POST' }, ownerCookie),
    );
    expect(ownerReentryResponse.status).toBe(200);
    const ownerReentry = await responseJson(ownerReentryResponse);
    bindCookiePresence(ownerCookie, ownerReentry);
    const epochBeforeRotation = ownerReentry.snapshot.presence.coordinatorEpoch as number;
    const presenceRevisionBeforeRotation = ownerReentry.snapshot.presence.revision as number;
    const playbackRevisionBeforeRotation = ownerReentry.snapshot.playback.revision as number;
    expect(ownerReentry.snapshot.presence.participants).toHaveLength(3);
    expect(ownerReentry.snapshot.presence.coordinatorParticipantId).not.toBe(
      ownerReentry.snapshot.viewer.participantId,
    );

    const rotate = await worker.fetch(
      jsonRequest('/pin', 'POST', { pin: '87654321' }, ownerCookie),
    );
    expect(rotate.status).toBe(200);
    const ownerAfterRotation = await responseJson(
      await worker.fetch(request('/snapshot', {}, ownerCookie)),
    );
    expect(ownerAfterRotation.snapshot.presence.coordinatorEpoch).toBe(epochBeforeRotation + 1);
    expect(ownerAfterRotation.snapshot.presence.coordinatorParticipantId).toBe(
      ownerAfterRotation.snapshot.viewer.participantId,
    );
    expect(ownerAfterRotation.snapshot.presence.participants).toEqual([
      expect.objectContaining({ participantId: ownerAfterRotation.snapshot.viewer.participantId }),
    ]);
    expect(ownerAfterRotation.snapshot.presence.revision).toBe(presenceRevisionBeforeRotation + 1);
    expect(ownerAfterRotation.snapshot.playback).toMatchObject({
      coordinatorEpoch: epochBeforeRotation + 1,
      revision: playbackRevisionBeforeRotation + 1,
    });
    expect(ownerAfterRotation.snapshot.runtime).toBe('awake');
    expect((await worker.fetch(request('/snapshot', {}, firstMemberCookie))).status).toBe(401);
    expect((await worker.fetch(request('/snapshot', {}, secondMemberCookie))).status).toBe(401);
  });

  it('charges the IP limiter only for failed PIN verification', async () => {
    const { worker } = await activatedRoom();
    for (let index = 0; index < 10; index += 1) {
      const failedRequest = jsonRequest('/sessions', 'POST', {
        pin: '99999999',
        displayName: 'Wrong',
      });
      failedRequest.headers.set('x-mxqr-pro-ip-hash', 'failed-pin-address');
      expect((await worker.fetch(failedRequest)).status).toBe(401);
    }
    const blockedRequest = jsonRequest('/sessions', 'POST', {
      pin: '99999999',
      displayName: 'Blocked',
    });
    blockedRequest.headers.set('x-mxqr-pro-ip-hash', 'failed-pin-address');
    const blocked = await worker.fetch(blockedRequest);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);

    const validOtherAddress = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Valid' }),
    );
    expect(validOtherAddress.status).toBe(200);
  });

  it('freezes an empty room, wakes on return, and scopes signaling tickets to the coordinator epoch', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const asleep = await worker.fetch(
      request('/presence/current', { method: 'DELETE' }, ownerCookie),
    );
    const asleepEnvelope = await responseJson(asleep);
    expect(Object.keys(asleepEnvelope)).toEqual(['snapshot']);
    expect(asleepEnvelope.snapshot).toMatchObject({
      runtime: 'sleeping',
      presence: { coordinatorParticipantId: null },
    });

    const rejectedHeartbeat = await worker.fetch(
      request('/presence/heartbeat', { method: 'POST' }, ownerCookie),
    );
    expect(rejectedHeartbeat.status).toBe(409);
    expect(await responseJson(rejectedHeartbeat)).toEqual({ error: 'PRESENCE_SUPERSEDED' });
    // Cloudflare can expose an application-level empty POST as a non-null body
    // stream. Treat the zero-byte transport body exactly like an absent body.
    const awake = await worker.fetch(
      request('/presence/enter', { method: 'POST', body: '' }, ownerCookie),
    );
    const awakeEnvelope = await responseJson(awake);
    bindCookiePresence(ownerCookie, awakeEnvelope);
    expect(Object.keys(awakeEnvelope)).toEqual(['snapshot']);
    const awakeSnapshot = awakeEnvelope.snapshot;
    expect(awakeSnapshot).toMatchObject({ runtime: 'awake', presence: { coordinatorEpoch: 3 } });

    const access = await worker.fetch(
      request('/signaling-tickets', { method: 'POST' }, ownerCookie),
    );
    const envelope = await responseJson(access);
    expect(Object.keys(envelope)).toEqual([
      'ticket',
      'expiresAtMs',
      'role',
      'coordinatorEpoch',
      'presenceIncarnationId',
      'ticketSequence',
    ]);
    expect(envelope).toMatchObject({ role: 'coordinator', coordinatorEpoch: 3 });
    expect(envelope.ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(envelope.expiresAtMs).toBeGreaterThan(Date.now());
    const [payload] = String(envelope.ticket).split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(decoded)).toEqual([
      'v',
      'kind',
      'roomCode',
      'participantId',
      'role',
      'coordinatorEpoch',
      'presenceIncarnationId',
      'ticketSequence',
      'developerControlVersion',
      'jti',
      'iat',
      'exp',
    ]);
    expect(decoded).toMatchObject({
      v: 1,
      kind: 'pro-signaling',
      roomCode: ROOM_CODE,
      role: 'coordinator',
      coordinatorEpoch: 3,
      presenceIncarnationId: awakeSnapshot.viewer.presenceIncarnationId,
      ticketSequence: 1,
      developerControlVersion: 0,
    });
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(90);
  });

  it('keeps a multi-peer leave response contract-valid while electing the next coordinator', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const controller = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    const controllerCookie = cookieFrom(controller);
    bindCookiePresence(controllerCookie, await responseJson(controller));
    const leave = await responseJson(
      await worker.fetch(request('/presence/current', { method: 'DELETE' }, ownerCookie)),
    );
    expect(parseProRoomSnapshot(leave.snapshot)).not.toBeNull();
    const current = await responseJson(
      await worker.fetch(request('/snapshot', {}, controllerCookie)),
    );
    expect(current.snapshot.presence.participants).toHaveLength(1);
    expect(current.snapshot.presence.coordinatorParticipantId).toBe(
      current.snapshot.viewer.participantId,
    );
  });

  it('keeps the active coordinator stable until a confirmed tab takeover', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));

    const blockedResponse = await worker.fetch(
      request('/presence/enter', { method: 'POST' }, ownerCookie),
    );
    expect(blockedResponse.status).toBe(409);
    expect(await responseJson(blockedResponse)).toEqual({
      error: 'PRESENCE_ACTIVE_ELSEWHERE',
    });
    const blockedEmptyStreamResponse = await worker.fetch(
      request('/presence/enter', { method: 'POST', body: '' }, ownerCookie),
    );
    expect(blockedEmptyStreamResponse.status).toBe(409);
    expect(await responseJson(blockedEmptyStreamResponse)).toEqual({
      error: 'PRESENCE_ACTIVE_ELSEWHERE',
    });
    const rejectedUnconfirmedTakeover = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: false }, ownerCookie),
    );
    expect(rejectedUnconfirmedTakeover.status).toBe(400);
    expect(await responseJson(rejectedUnconfirmedTakeover)).toEqual({
      error: 'INVALID_REQUEST',
    });
    const rejectedNonJsonTakeover = await worker.fetch(
      request('/presence/enter', { method: 'POST', body: '{}' }, ownerCookie),
    );
    expect(rejectedNonJsonTakeover.status).toBe(400);
    expect(await responseJson(rejectedNonJsonTakeover)).toEqual({
      error: 'INVALID_REQUEST',
    });
    const unchanged = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    expect(unchanged.snapshot.viewer.presenceIncarnationId).toBe(
      before.snapshot.viewer.presenceIncarnationId,
    );
    expect(unchanged.snapshot.presence.coordinatorEpoch).toBe(
      before.snapshot.presence.coordinatorEpoch,
    );

    const enteredResponse = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: true }, ownerCookie),
    );
    expect(enteredResponse.status).toBe(200);
    const entered = await responseJson(enteredResponse);
    bindCookiePresence(ownerCookie, entered);
    expect(entered.snapshot.viewer.participantId).toBe(before.snapshot.viewer.participantId);
    expect(entered.snapshot.viewer.presenceIncarnationId).not.toBe(
      before.snapshot.viewer.presenceIncarnationId,
    );
    expect(entered.snapshot.presence.coordinatorEpoch).toBe(
      before.snapshot.presence.coordinatorEpoch + 1,
    );

    const refreshed = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    expect(refreshed.snapshot.viewer.presenceIncarnationId).toBe(
      entered.snapshot.viewer.presenceIncarnationId,
    );
  });

  it('requires confirmation to move a member tab without advancing coordinator authority', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const memberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    const memberCookie = cookieFrom(memberResponse);
    const memberBefore = await responseJson(memberResponse);
    bindCookiePresence(memberCookie, memberBefore);
    const ownerBefore = await responseJson(
      await worker.fetch(request('/snapshot', {}, ownerCookie)),
    );

    const blockedResponse = await worker.fetch(
      request('/presence/enter', { method: 'POST' }, memberCookie),
    );
    expect(blockedResponse.status).toBe(409);
    expect(await responseJson(blockedResponse)).toEqual({
      error: 'PRESENCE_ACTIVE_ELSEWHERE',
    });

    const enteredResponse = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: true }, memberCookie),
    );
    expect(enteredResponse.status).toBe(200);
    const entered = await responseJson(enteredResponse);
    bindCookiePresence(memberCookie, entered);

    expect(entered.snapshot.viewer.participantId).toBe(memberBefore.snapshot.viewer.participantId);
    expect(entered.snapshot.viewer.presenceIncarnationId).not.toBe(
      memberBefore.snapshot.viewer.presenceIncarnationId,
    );
    expect(entered.snapshot.presence.coordinatorEpoch).toBe(
      ownerBefore.snapshot.presence.coordinatorEpoch,
    );
    expect(entered.snapshot.presence.coordinatorParticipantId).toBe(
      ownerBefore.snapshot.viewer.participantId,
    );
  });

  it('fences every old-tab active request after a same-cookie tab enters', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const oldIdentity = {
      participantId: before.snapshot.viewer.participantId as string,
      presenceIncarnationId: before.snapshot.viewer.presenceIncarnationId as string,
    };
    const oldEpoch = before.snapshot.presence.coordinatorEpoch as number;

    // Pre-issue but do not deliver the old tab's signaling credential.
    const oldTicket = await responseJson(
      await worker.fetch(request('/signaling-tickets', { method: 'POST' }, ownerCookie)),
    );
    expect(oldTicket).toMatchObject({
      ticketSequence: 1,
      presenceIncarnationId: oldIdentity.presenceIncarnationId,
    });

    const enteredResponse = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: true }, ownerCookie),
    );
    const entered = await responseJson(enteredResponse);
    bindCookiePresence(ownerCookie, entered);
    expect(entered.snapshot.presence.coordinatorEpoch).toBe(oldEpoch + 1);

    const staleRequests = [
      requestWithPresence('/snapshot', {}, ownerCookie, oldIdentity),
      requestWithPresence('/presence/heartbeat', { method: 'POST' }, ownerCookie, oldIdentity),
      requestWithPresence('/signaling-tickets', { method: 'POST' }, ownerCookie, oldIdentity),
      requestWithPresence(
        '/pin',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pin: '87654321' }),
        },
        ownerCookie,
        oldIdentity,
      ),
      requestWithPresence(
        '/media/reservations',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `${IDEMPOTENCY_KEY}-stale-tab-reserve`,
          },
          body: JSON.stringify({ byteLength: 1024, name: 'stale.wav', mime: 'audio/wav' }),
        },
        ownerCookie,
        oldIdentity,
      ),
    ];
    for (const staleRequest of staleRequests) {
      const response = await worker.fetch(staleRequest);
      expect(response.status).toBe(409);
      expect(await responseJson(response)).toEqual({ error: 'PRESENCE_SUPERSEDED' });
    }

    const newTicket = await responseJson(
      await worker.fetch(request('/signaling-tickets', { method: 'POST' }, ownerCookie)),
    );
    expect(newTicket).toMatchObject({
      ticketSequence: 2,
      presenceIncarnationId: entered.snapshot.viewer.presenceIncarnationId,
      coordinatorEpoch: oldEpoch + 1,
    });
    expect(
      (await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie))).status,
    ).toBe(200);
  });

  it('revokes exactly the captured server session without a racy cookie tombstone', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const identity = {
      expectedParticipantId: before.snapshot.viewer.participantId,
      expectedPresenceIncarnationId: before.snapshot.viewer.presenceIncarnationId,
    };
    const atomic = await worker.fetch(
      unloadCloseRequest(
        {
          ...identity,
          baseRevision: before.snapshot.revision,
          currentQueueItemId: null,
          playback: null,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-atomic-before-fenced-session`,
      ),
    );
    expect(atomic.status).toBe(200);

    const fenced = await worker.fetch(fencedSessionCloseRequest(identity, ownerCookie));
    expect(fenced.status).toBe(200);
    expect(await responseJson(fenced)).toEqual({ ok: true });
    // A successful response can arrive after another tab installed a newer
    // same-name cookie, so even the success path must never clear it.
    expect(fenced.headers.get('set-cookie')).toBeNull();

    const internal = worker as unknown as {
      room: {
        presence: { participants: Record<string, unknown> };
        sessions: Record<string, unknown>;
      };
    };
    expect(Object.keys(internal.room.presence.participants)).toHaveLength(0);
    expect(Object.keys(internal.room.sessions)).toHaveLength(0);
  });

  it('preserves a resumed same-cookie tab against both delayed explicit-leave phases', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const oldIdentity = {
      expectedParticipantId: before.snapshot.viewer.participantId,
      expectedPresenceIncarnationId: before.snapshot.viewer.presenceIncarnationId,
    };

    const entered = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: true }, ownerCookie),
    );
    expect(entered.status).toBe(200);
    const enteredEnvelope = await responseJson(entered);
    bindCookiePresence(ownerCookie, enteredEnvelope);
    expect(enteredEnvelope.snapshot.viewer.participantId).toBe(oldIdentity.expectedParticipantId);
    expect(enteredEnvelope.snapshot.viewer.presenceIncarnationId).not.toBe(
      oldIdentity.expectedPresenceIncarnationId,
    );
    const resumedRevision = enteredEnvelope.snapshot.revision;

    const staleAtomic = await worker.fetch(
      unloadCloseRequest(
        {
          ...oldIdentity,
          baseRevision: before.snapshot.revision,
          currentQueueItemId: null,
          playback: null,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-stale-atomic-before-fenced-session`,
      ),
    );
    expect(staleAtomic.status).toBe(409);
    expect(await responseJson(staleAtomic)).toEqual({
      error: 'PRESENCE_IDENTITY_MISMATCH',
    });

    const staleFenced = await worker.fetch(fencedSessionCloseRequest(oldIdentity, ownerCookie));
    expect(staleFenced.status).toBe(409);
    expect(await responseJson(staleFenced)).toEqual({
      error: 'PRESENCE_IDENTITY_MISMATCH',
    });
    expect(staleFenced.headers.get('set-cookie')).toBeNull();

    const current = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    expect(current.snapshot.revision).toBe(resumedRevision);
    expect(current.snapshot.viewer.presenceIncarnationId).toBe(
      enteredEnvelope.snapshot.viewer.presenceIncarnationId,
    );
    expect(current.snapshot.presence.participants).toHaveLength(1);
    const internal = worker as unknown as {
      room: { sessions: Record<string, unknown> };
    };
    expect(Object.keys(internal.room.sessions)).toHaveLength(1);
  });

  it('atomically checkpoints and leaves on unload while retaining an idempotent resumable session', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const initial = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const queueItemId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const selected = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/snapshot',
          'PUT',
          {
            baseRevision: initial.snapshot.revision,
            playlist: [
              {
                queueItemId,
                name: 'Persistent video',
                source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
              },
            ],
            currentQueueItemId: queueItemId,
            playback: {
              coordinatorEpoch: initial.snapshot.presence.coordinatorEpoch,
              revision: initial.snapshot.playback.revision + 1,
              state: 'paused',
              queueItemId,
              positionSeconds: 10,
              updatedAtMs: Date.now(),
              youtubeVideoId: 'dQw4w9WgXcQ',
              youtubeSubIndex: 0,
            },
          },
          ownerCookie,
          `${IDEMPOTENCY_KEY}-unload-seed`,
        ),
      ),
    );
    const closeBody = {
      expectedParticipantId: selected.snapshot.viewer.participantId,
      expectedPresenceIncarnationId: selected.snapshot.viewer.presenceIncarnationId,
      baseRevision: selected.snapshot.revision,
      currentQueueItemId: queueItemId,
      playback: {
        coordinatorEpoch: selected.snapshot.presence.coordinatorEpoch,
        revision: selected.snapshot.playback.revision + 1,
        state: 'playing',
        queueItemId,
        positionSeconds: 42.25,
        updatedAtMs: Date.now(),
        youtubeVideoId: '9bZkp7q19f0',
        youtubeSubIndex: 7,
      },
    };
    // Simulate an already in-flight periodic checkpoint winning the Durable
    // Object queue after pagehide captured closeBody from the same base.
    const periodic = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: selected.snapshot.revision,
          playlist: selected.snapshot.playlist,
          currentQueueItemId: queueItemId,
          playback: {
            ...selected.snapshot.playback,
            revision: selected.snapshot.playback.revision + 1,
            state: 'playing',
            positionSeconds: 40,
            updatedAtMs: Date.now(),
          },
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-unload-periodic-race`,
      ),
    );
    expect(periodic.status).toBe(200);
    const closeKey = `${IDEMPOTENCY_KEY}-unload-close`;
    const first = await worker.fetch(unloadCloseRequest(closeBody, ownerCookie, closeKey));
    expect(first.status).toBe(200);
    expect(await responseJson(first)).toEqual({ ok: true });
    expect(first.headers.get('set-cookie')).toBeNull();

    const internal = worker as unknown as {
      room: {
        revision: number;
        runtime: string;
        playback: Record<string, any>;
        presence: { participants: Record<string, unknown> };
        sessions: Record<string, unknown>;
      };
    };
    expect(internal.room.runtime).toBe('sleeping');
    expect(Object.keys(internal.room.presence.participants)).toHaveLength(0);
    expect(Object.keys(internal.room.sessions)).toHaveLength(1);
    expect(internal.room.playback).toMatchObject({
      state: 'playing',
      youtubeVideoId: '9bZkp7q19f0',
      youtubeSubIndex: 7,
    });
    expect(internal.room.playback.positionSeconds).toBeGreaterThanOrEqual(42.25);
    const committedRevision = internal.room.revision;

    const replay = await worker.fetch(unloadCloseRequest(closeBody, ownerCookie, closeKey));
    expect(replay.status).toBe(200);
    expect(await responseJson(replay)).toEqual({ ok: true });
    expect(internal.room.revision).toBe(committedRevision);

    // Ordinary refresh must not resurrect a closed presence. Resume has one
    // explicit enter endpoint that rotates the server-issued incarnation.
    const refreshWhileClosed = await worker.fetch(request('/snapshot', {}, ownerCookie));
    expect(refreshWhileClosed.status).toBe(409);
    expect(await responseJson(refreshWhileClosed)).toEqual({ error: 'PRESENCE_SUPERSEDED' });

    const entered = await worker.fetch(request('/presence/enter', { method: 'POST' }, ownerCookie));
    expect(entered.status).toBe(200);
    const enteredEnvelope = await responseJson(entered);
    bindCookiePresence(ownerCookie, enteredEnvelope);
    expect(enteredEnvelope.snapshot.viewer.role).toBe('owner');
    expect(enteredEnvelope.snapshot.viewer.participantId).toBe(closeBody.expectedParticipantId);
    expect(enteredEnvelope.snapshot.viewer.presenceIncarnationId).not.toBe(
      closeBody.expectedPresenceIncarnationId,
    );
    const resumedRevision = internal.room.revision;

    // A retry of the already-processed old close replays harmlessly even
    // after enter rotated the incarnation.
    const oldReplayAfterEnter = await worker.fetch(
      unloadCloseRequest(closeBody, ownerCookie, closeKey),
    );
    expect(oldReplayAfterEnter.status).toBe(200);
    expect(await responseJson(oldReplayAfterEnter)).toEqual({ ok: true });
    expect(internal.room.revision).toBe(resumedRevision);

    // The same captured body under a never-processed key is stale and cannot
    // close or checkpoint the new incarnation.
    const staleUnprocessed = await worker.fetch(
      unloadCloseRequest(
        closeBody,
        ownerCookie,
        `${IDEMPOTENCY_KEY}-unload-close-stale-after-enter`,
      ),
    );
    expect(staleUnprocessed.status).toBe(409);
    expect(await responseJson(staleUnprocessed)).toEqual({
      error: 'PRESENCE_IDENTITY_MISMATCH',
    });
    expect(internal.room.revision).toBe(resumedRevision);
    expect(Object.keys(internal.room.presence.participants)).toHaveLength(1);
  });

  it('authorizes and validates unload checkpoint revisions and YouTube metadata before leaving', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const controllerResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    const controllerEnvelope = await responseJson(controllerResponse);
    const controllerCookie = cookieFrom(controllerResponse);
    bindCookiePresence(controllerCookie, controllerEnvelope);
    const current = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const baseBody = {
      expectedParticipantId: current.snapshot.viewer.participantId,
      expectedPresenceIncarnationId: current.snapshot.viewer.presenceIncarnationId,
      baseRevision: current.snapshot.revision,
      currentQueueItemId: null,
      playback: current.snapshot.playback,
    };

    const preflightShape = await worker.fetch(
      jsonRequest(
        '/presence/close',
        'POST',
        { idempotencyKey: `${IDEMPOTENCY_KEY}-json-close`, ...baseBody },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-json-close`,
      ),
    );
    expect(preflightShape.status).toBe(400);
    expect(await responseJson(preflightShape)).toEqual({ error: 'INVALID_REQUEST' });

    const nonStringKey = await worker.fetch(
      unloadCloseRequest(
        { ...baseBody, idempotencyKey: 1234567890123456 },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-ignored`,
      ),
    );
    expect(nonStringKey.status).toBe(400);
    expect(await responseJson(nonStringKey)).toEqual({ error: 'INVALID_REQUEST' });

    const unauthenticated = await worker.fetch(
      unloadCloseRequest(
        { ...baseBody, playback: null },
        undefined,
        `${IDEMPOTENCY_KEY}-unload-unauth`,
      ),
    );
    expect(unauthenticated.status).toBe(401);

    const wrongCookieIdentity = await worker.fetch(
      unloadCloseRequest(
        baseBody,
        controllerCookie,
        `${IDEMPOTENCY_KEY}-unload-wrong-cookie-identity`,
      ),
    );
    expect(wrongCookieIdentity.status).toBe(409);
    expect(await responseJson(wrongCookieIdentity)).toEqual({
      error: 'PRESENCE_IDENTITY_MISMATCH',
    });

    const unauthorized = await worker.fetch(
      unloadCloseRequest(
        {
          ...baseBody,
          expectedParticipantId: controllerEnvelope.snapshot.viewer.participantId,
          expectedPresenceIncarnationId: controllerEnvelope.snapshot.viewer.presenceIncarnationId,
        },
        controllerCookie,
        `${IDEMPOTENCY_KEY}-unload-member-playback`,
      ),
    );
    expect(unauthorized.status).toBe(403);
    expect(await responseJson(unauthorized)).toEqual({ error: 'COORDINATOR_REQUIRED' });

    const futureRevision = await worker.fetch(
      unloadCloseRequest(
        { ...baseBody, baseRevision: current.snapshot.revision + 1 },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-unload-future`,
      ),
    );
    expect(futureRevision.status).toBe(400);
    expect(await responseJson(futureRevision)).toEqual({ error: 'INVALID_REVISION' });

    const queueItemId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const selected = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/snapshot',
          'PUT',
          {
            baseRevision: current.snapshot.revision,
            playlist: [
              {
                queueItemId,
                name: 'Video',
                source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
              },
            ],
            currentQueueItemId: queueItemId,
            playback: {
              coordinatorEpoch: current.snapshot.presence.coordinatorEpoch,
              revision: current.snapshot.playback.revision + 1,
              state: 'paused',
              queueItemId,
              positionSeconds: 1,
              updatedAtMs: Date.now(),
              youtubeVideoId: 'dQw4w9WgXcQ',
              youtubeSubIndex: 0,
            },
          },
          ownerCookie,
          `${IDEMPOTENCY_KEY}-unload-validation-seed`,
        ),
      ),
    );
    const invalidPlayback = {
      expectedParticipantId: selected.snapshot.viewer.participantId,
      expectedPresenceIncarnationId: selected.snapshot.viewer.presenceIncarnationId,
      baseRevision: selected.snapshot.revision,
      currentQueueItemId: queueItemId,
      playback: {
        ...selected.snapshot.playback,
        revision: selected.snapshot.playback.revision + 1,
        positionSeconds: 2,
        updatedAtMs: Date.now(),
        youtubeVideoId: null,
      },
    };
    const invalidYouTube = await worker.fetch(
      unloadCloseRequest(invalidPlayback, ownerCookie, `${IDEMPOTENCY_KEY}-unload-invalid-youtube`),
    );
    expect(invalidYouTube.status).toBe(400);
    expect(await responseJson(invalidYouTube)).toEqual({ error: 'INVALID_PLAYBACK' });
    const stillPresent = await responseJson(
      await worker.fetch(request('/snapshot', {}, ownerCookie)),
    );
    expect(stillPresent.snapshot.presence.participants).toHaveLength(2);
  });

  it('allows 100 total same-NAT devices and evicts only inactive sessions during long churn', async () => {
    const { worker } = await activatedRoom();
    const activeCookies: string[] = [];
    // activatedRoom() already enters the owner/coordinator, leaving 99 member
    // places under the host-inclusive 100-device room ceiling.
    for (let index = 0; index < 99; index += 1) {
      const joined = await worker.fetch(
        jsonRequest('/sessions', 'POST', {
          pin: '12345678',
          displayName: `Friend ${index}`,
        }),
      );
      expect(joined.status).toBe(200);
      const cookie = cookieFrom(joined);
      bindCookiePresence(cookie, await responseJson(joined));
      activeCookies.push(cookie);
    }
    const full = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Too many' }),
    );
    expect(full.status).toBe(409);
    expect(await responseJson(full)).toEqual({ error: 'ROOM_FULL' });
    const internal = worker as unknown as {
      room: { sessions: Record<string, unknown>; rateLimits: Record<string, unknown> };
    };
    expect(Object.keys(internal.room.rateLimits)).not.toContain(
      'pin-failure:hashed-client-address',
    );

    for (const cookie of activeCookies) {
      await worker.fetch(request('/sessions/current', { method: 'DELETE' }, cookie));
    }
    for (let index = 0; index < 140; index += 1) {
      const joined = await worker.fetch(
        jsonRequest('/sessions', 'POST', {
          pin: '12345678',
          displayName: `Churn ${index}`,
        }),
      );
      expect(joined.status).toBe(200);
      const cookie = cookieFrom(joined);
      bindCookiePresence(cookie, await responseJson(joined));
      expect(
        (await worker.fetch(request('/presence/current', { method: 'DELETE' }, cookie))).status,
      ).toBe(200);
    }
    expect(Object.keys(internal.room.sessions).length).toBeLessThanOrEqual(128);
  }, 30_000);

  it('requires live presence for state/media mutations and for creator-only completion', async () => {
    const context = await activatedRoom();
    const reservation = await responseJson(
      await context.worker.fetch(
        jsonRequest(
          '/media/reservations',
          'POST',
          { byteLength: 2048, name: 'presence.wav', mime: 'audio/wav' },
          context.ownerCookie,
          `${IDEMPOTENCY_KEY}-presence-reserve`,
        ),
      ),
    );
    const assetId = reservation.reservation.assetId as string;
    const internal = context.worker as unknown as { room: StoredRoom };
    const asset = internal.room.assets[assetId]!;
    context.bucket.objects.set(asset.stagingObjectKey, {
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
      customMetadata: {
        'mxqr-room': ROOM_CODE,
        'mxqr-asset': asset.assetId,
        'mxqr-version': String(asset.version),
        'mxqr-bytes': String(asset.byteLength),
      },
    });
    const beforeLeave = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const controller = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    const controllerCookie = cookieFrom(controller);
    bindCookiePresence(controllerCookie, await responseJson(controller));
    const wrongCompleter = await context.worker.fetch(
      request(
        `/media/${assetId}/complete`,
        { method: 'POST', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-wrong-completer` } },
        controllerCookie,
      ),
    );
    expect(wrongCompleter.status).toBe(403);
    expect(await responseJson(wrongCompleter)).toEqual({
      error: 'RESERVATION_OWNER_REQUIRED',
    });
    await context.worker.fetch(
      request('/presence/current', { method: 'DELETE' }, context.ownerCookie),
    );
    const completeWhileAway = await context.worker.fetch(
      request(
        `/media/${assetId}/complete`,
        { method: 'POST', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-presence-complete` } },
        context.ownerCookie,
      ),
    );
    expect(completeWhileAway.status).toBe(409);
    expect(await responseJson(completeWhileAway)).toEqual({ error: 'PRESENCE_SUPERSEDED' });
    const mutateWhileAway = await context.worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: beforeLeave.snapshot.revision,
          playlist: [],
          currentQueueItemId: null,
          playback: beforeLeave.snapshot.playback,
        },
        context.ownerCookie,
        `${IDEMPOTENCY_KEY}-presence-away`,
      ),
    );
    expect(mutateWhileAway.status).toBe(409);
    expect(await responseJson(mutateWhileAway)).toEqual({ error: 'PRESENCE_SUPERSEDED' });

    expect((await context.worker.fetch(request('/snapshot', {}, context.ownerCookie))).status).toBe(
      409,
    );
    const reentered = await context.worker.fetch(
      request('/presence/enter', { method: 'POST' }, context.ownerCookie),
    );
    expect(reentered.status).toBe(200);
    bindCookiePresence(context.ownerCookie, await responseJson(reentered));
    const completed = await context.worker.fetch(
      request(
        `/media/${assetId}/complete`,
        { method: 'POST', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-presence-complete` } },
        context.ownerCookie,
      ),
    );
    expect(completed.status).toBe(200);
  });

  it('applies one exact revision and replays the same idempotent mutation', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const current = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const queueItemId = '11111111-1111-4111-8111-111111111111';
    const body = {
      baseRevision: current.snapshot.revision,
      playlist: [
        {
          queueItemId,
          name: 'Video',
          source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
        },
      ],
      currentQueueItemId: queueItemId,
      playback: {
        coordinatorEpoch: current.snapshot.presence.coordinatorEpoch,
        revision: current.snapshot.playback.revision + 1,
        state: 'paused',
        queueItemId,
        positionSeconds: 12.5,
        updatedAtMs: Date.now(),
        youtubeVideoId: 'dQw4w9WgXcQ',
        youtubeSubIndex: 0,
      },
    };
    const first = await worker.fetch(
      jsonRequest('/snapshot', 'PUT', body, ownerCookie, IDEMPOTENCY_KEY),
    );
    const firstEnvelope = await responseJson(first);
    const controller = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    expect(controller.status).toBe(200);
    const replay = await worker.fetch(
      jsonRequest('/snapshot', 'PUT', body, ownerCookie, IDEMPOTENCY_KEY),
    );
    expect(first.status).toBe(200);
    const replayEnvelope = await responseJson(replay);
    expect(replayEnvelope.snapshot.revision).toBeGreaterThan(firstEnvelope.snapshot.revision);
    expect(replayEnvelope.snapshot.playlist).toEqual(firstEnvelope.snapshot.playlist);
    const internal = worker as unknown as {
      room: { idempotency: Record<string, Record<string, unknown>> };
    };
    const record = Object.values(internal.room.idempotency).find(
      (candidate) => candidate.kind === 'snapshot',
    );
    expect(record).toMatchObject({
      kind: 'snapshot',
      committedRevision: firstEnvelope.snapshot.revision,
      status: 200,
    });
    expect(record).not.toHaveProperty('body');
  });

  it('rejects playback revision jumps, stale clocks, excessive positions, and invalid YouTube checkpoints', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const current = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const queueItemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const baseBody = {
      baseRevision: current.snapshot.revision,
      playlist: [
        {
          queueItemId,
          name: 'Video',
          source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
        },
      ],
      currentQueueItemId: queueItemId,
      playback: {
        coordinatorEpoch: current.snapshot.presence.coordinatorEpoch,
        revision: current.snapshot.playback.revision + 1,
        state: 'paused',
        queueItemId,
        positionSeconds: 42,
        updatedAtMs: Date.now(),
        youtubeVideoId: 'dQw4w9WgXcQ',
        youtubeSubIndex: 0,
      },
    };
    const attempts = [
      { ...baseBody.playback, revision: current.snapshot.playback.revision + 99 },
      { ...baseBody.playback, updatedAtMs: Date.now() + 5 * 60_000 },
      { ...baseBody.playback, positionSeconds: 8 * 24 * 60 * 60 },
      { ...baseBody.playback, youtubeVideoId: null },
      { ...baseBody.playback, youtubeSubIndex: null },
    ];
    for (const [index, playback] of attempts.entries()) {
      const rejected = await worker.fetch(
        jsonRequest(
          '/snapshot',
          'PUT',
          { ...baseBody, playback },
          ownerCookie,
          `${IDEMPOTENCY_KEY}-poison-${index}`,
        ),
      );
      expect(rejected.status).toBe(400);
      expect(await responseJson(rejected)).toEqual({ error: 'INVALID_PLAYBACK' });
    }
    const acceptedAt = Date.now();
    const accepted = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        { ...baseBody, playback: { ...baseBody.playback, updatedAtMs: acceptedAt } },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-playback-valid`,
      ),
    );
    expect(accepted.status).toBe(200);
    const envelope = await responseJson(accepted);
    expect(envelope.snapshot.playback).toMatchObject({
      revision: current.snapshot.playback.revision + 1,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    });
    expect(envelope.snapshot.playback.updatedAtMs).toBeGreaterThanOrEqual(acceptedAt);
    expect(envelope.snapshot.playback.updatedAtMs).toBeLessThanOrEqual(Date.now());
  });

  it('atomically rejects a legal-shape snapshot that exceeds the bounded DO state budget', async () => {
    const { worker, state, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const longText = 'x'.repeat(1_900);
    const playlist = Array.from({ length: 160 }, (_, index) => ({
      queueItemId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-${index
        .toString(16)
        .padStart(12, '0')}`,
      name: longText,
      title: longText,
      artist: longText,
      thumbnail: longText,
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    }));
    const rejected = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: before.snapshot.revision,
          playlist,
          currentQueueItemId: null,
          playback: before.snapshot.playback,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-state-budget`,
      ),
    );
    expect(rejected.status).toBe(409);
    expect(await responseJson(rejected)).toEqual({ error: 'ROOM_STATE_CAPACITY_EXCEEDED' });
    const after = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    expect(after.snapshot.revision).toBe(before.snapshot.revision);
    expect(after.snapshot.playlist).toEqual([]);
    const stored = state.storage.data.get('pro-room:v1') as StoredRoom;
    expect(stored.revision).toBe(before.snapshot.revision);
    expect(stored.playlist).toEqual([]);
  });
});

describe('persistent PRO room private media accounting', () => {
  it('reserves, HEAD-validates, downloads, and safely deletes a private R2 asset', async () => {
    const { worker, state, bucket, ownerCookie } = await activatedRoom();
    const reserve = await worker.fetch(
      jsonRequest(
        '/media/reservations',
        'POST',
        { byteLength: 1024, name: 'Track.flac', mime: 'audio/flac', sha256: 'a'.repeat(64) },
        ownerCookie,
        IDEMPOTENCY_KEY,
      ),
    );
    expect(reserve.status).toBe(200);
    const reservation = await responseJson(reserve);
    expect(Object.keys(reservation)).toEqual(['reservation', 'quota']);
    expect(Object.keys(reservation.reservation)).toEqual([
      'assetId',
      'version',
      'byteLength',
      'expiresAtMs',
      'upload',
    ]);
    expect(reservation.reservation.upload.url).toContain(
      `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/`,
    );
    expect(JSON.stringify(reservation)).not.toContain('objectKey');

    const stored = state.storage.data.get('pro-room:v1') as StoredRoom;
    const asset = stored.assets[reservation.reservation.assetId];
    bucket.objects.set(asset.stagingObjectKey, {
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
      customMetadata: {
        'mxqr-room': ROOM_CODE,
        'mxqr-asset': reservation.reservation.assetId,
        'mxqr-version': '1',
        'mxqr-bytes': String(asset.byteLength),
        'mxqr-sha256': 'a'.repeat(64),
      },
    });
    const complete = await worker.fetch(
      request(
        `/media/${reservation.reservation.assetId}/complete`,
        { method: 'POST', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-complete` } },
        ownerCookie,
      ),
    );
    expect(complete.status).toBe(200);
    const completeEnvelope = await responseJson(complete);
    expect(Object.keys(completeEnvelope)).toEqual(['asset', 'quota']);
    expect(completeEnvelope.quota).toMatchObject({
      usedBytes: 1024,
      reservedBytes: 0,
    });

    const download = await worker.fetch(
      request(`/media/${reservation.reservation.assetId}/download`, {}, ownerCookie),
    );
    const downloadEnvelope = await responseJson(download);
    expect(Object.keys(downloadEnvelope)).toEqual(['asset', 'download']);
    expect(downloadEnvelope.download.url).toContain(
      `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/`,
    );
    const remove = await worker.fetch(
      request(
        `/media/${reservation.reservation.assetId}`,
        { method: 'DELETE', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-delete` } },
        ownerCookie,
      ),
    );
    const deleteEnvelope = await responseJson(remove);
    expect(Object.keys(deleteEnvelope)).toEqual(['ok', 'assetId', 'quota']);
    expect(deleteEnvelope.quota).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect(bucket.deleted).toContain(asset.objectKey);
    expect(bucket.deleted).toContain(asset.stagingObjectKey);
  });

  it('serializes quota reservations so six 200 MiB requests cannot exceed 1 GiB', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const results: Response[] = [];
    for (let index = 0; index < 6; index += 1) {
      results.push(
        await worker.fetch(
          jsonRequest(
            '/media/reservations',
            'POST',
            { byteLength: 200 * 1024 * 1024, name: `${index}.wav`, mime: 'audio/wav' },
            ownerCookie,
            `${IDEMPOTENCY_KEY}-quota-${index}`,
          ),
        ),
      );
    }
    expect(results.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 409]);
    expect(await responseJson(results[5]!)).toEqual({ error: 'ROOM_QUOTA_EXCEEDED' });
  });

  it('cancels a staged reservation only after its R2 object is safely deleted', async () => {
    const { worker, state, bucket, ownerCookie } = await activatedRoom();
    const reservation = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/media/reservations',
          'POST',
          { byteLength: 4096, name: 'cancelled.wav', mime: 'audio/wav' },
          ownerCookie,
          IDEMPOTENCY_KEY,
        ),
      ),
    );
    const assetId = reservation.reservation.assetId as string;
    const asset = (state.storage.data.get('pro-room:v1') as StoredRoom).assets[assetId]!;
    bucket.objects.set(asset.stagingObjectKey, { staged: true });

    const remove = await worker.fetch(
      request(
        `/media/${assetId}`,
        { method: 'DELETE', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-cancel` } },
        ownerCookie,
      ),
    );
    expect(remove.status).toBe(200);
    const removeEnvelope = await responseJson(remove);
    expect(removeEnvelope).toMatchObject({
      ok: true,
      assetId,
      quota: { usedBytes: 0, reservedBytes: 0 },
    });
    expect(bucket.deleted).toContain(asset.stagingObjectKey);
    expect(bucket.objects.has(asset.stagingObjectKey)).toBe(false);
    const stored = state.storage.data.get('pro-room:v1') as StoredRoom & {
      quota: { usedBytes: number; reservedBytes: number };
    };
    expect(stored.assets[assetId]).toBeUndefined();
    expect(stored.quota).toMatchObject({ usedBytes: 0, reservedBytes: 0 });

    const replay = await worker.fetch(
      request(
        `/media/${assetId}`,
        { method: 'DELETE', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-cancel` } },
        ownerCookie,
      ),
    );
    expect(await responseJson(replay)).toEqual(removeEnvelope);
    expect(bucket.deleted.filter((key) => key === asset.stagingObjectKey)).toHaveLength(1);
  });

  it('keeps an abort tombstone until a reusable staging URL has expired and is cleaned again', async () => {
    const { worker, bucket, ownerCookie } = await activatedRoom();
    const reservation = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/media/reservations',
          'POST',
          { byteLength: 4096, name: 'replay.wav', mime: 'audio/wav' },
          ownerCookie,
          `${IDEMPOTENCY_KEY}-tombstone-reserve`,
        ),
      ),
    );
    const assetId = reservation.reservation.assetId as string;
    const internal = worker as unknown as {
      room: StoredRoom & {
        stagingTombstones: Record<string, { objectKey: string; cleanupAfterMs: number }>;
      };
      alarm(): Promise<void>;
    };
    const stagingObjectKey = internal.room.assets[assetId]!.stagingObjectKey;
    bucket.objects.set(stagingObjectKey, { staged: true });
    const removed = await worker.fetch(
      request(
        `/media/${assetId}`,
        {
          method: 'DELETE',
          headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-tombstone-delete` },
        },
        ownerCookie,
      ),
    );
    expect(removed.status).toBe(200);
    expect(internal.room.assets[assetId]).toBeUndefined();
    expect(internal.room.stagingTombstones[assetId]?.objectKey).toBe(stagingObjectKey);

    // Model a malicious reuse of the still-valid presigned PUT after abort.
    bucket.objects.set(stagingObjectKey, { staged: 'recreated' });
    internal.room.stagingTombstones[assetId]!.cleanupAfterMs = Date.now() - 1;
    await internal.alarm();
    expect(bucket.objects.has(stagingObjectKey)).toBe(false);
    expect(internal.room.stagingTombstones[assetId]).toBeUndefined();
  });

  it('promotes a verified staging upload to an immutable final key before exposing download', async () => {
    const context = await activatedRoom();
    const { assetId, asset } = await completeReadyAsset(context, 'immutable', 4096);
    const finalObjectKey = asset.objectKey;
    const stagingObjectKey = asset.stagingObjectKey;
    expect(finalObjectKey).toContain('/object_');
    expect(stagingObjectKey).toContain('/staging_');
    expect(context.bucket.objects.get(finalObjectKey)?.size).toBe(4096);
    expect(context.bucket.objects.has(stagingObjectKey)).toBe(false);

    // Reusing the upload URL can only recreate staging; it cannot overwrite
    // the fresh final key referenced by the ready asset and download URL.
    context.bucket.objects.set(stagingObjectKey, { size: 5 * 1024 * 1024 * 1024 });
    const download = await responseJson(
      await context.worker.fetch(request(`/media/${assetId}/download`, {}, context.ownerCookie)),
    );
    expect(download.download.url).toContain('/object_');
    expect(download.download.url).not.toContain('/staging_');
    expect(context.bucket.objects.get(finalObjectKey)?.size).toBe(4096);

    const internal = context.worker as unknown as { alarm(): Promise<void> };
    asset.stagingCleanupAfterMs = Date.now() - 1;
    await internal.alarm();
    expect(context.bucket.objects.has(stagingObjectKey)).toBe(false);
    expect(context.bucket.objects.get(finalObjectKey)?.size).toBe(4096);
  });

  it('keeps staged quota reserved when R2 deletion fails so cleanup can be retried', async () => {
    const { worker, state, bucket, ownerCookie } = await activatedRoom();
    const reservation = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/media/reservations',
          'POST',
          { byteLength: 8192, name: 'retry.wav', mime: 'audio/wav' },
          ownerCookie,
          IDEMPOTENCY_KEY,
        ),
      ),
    );
    const assetId = reservation.reservation.assetId as string;
    const asset = (state.storage.data.get('pro-room:v1') as StoredRoom).assets[assetId]!;
    bucket.objects.set(asset.stagingObjectKey, { staged: true });
    bucket.deleteError = new Error('temporary R2 failure');

    const failed = await worker.fetch(
      request(
        `/media/${assetId}`,
        { method: 'DELETE', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-retry` } },
        ownerCookie,
      ),
    );
    expect(failed.status).toBe(503);
    expect(await responseJson(failed)).toEqual({ error: 'MEDIA_STORAGE_UNAVAILABLE' });
    let stored = state.storage.data.get('pro-room:v1') as StoredRoom & {
      quota: { usedBytes: number; reservedBytes: number };
    };
    expect(stored.assets[assetId]).toBeDefined();
    expect(stored.quota).toMatchObject({ usedBytes: 0, reservedBytes: 8192 });

    const internal = worker as unknown as {
      room: {
        assets: Record<string, { expiresAtMs: number; objectKey: string }>;
        quota: { reservedBytes: number };
      };
      alarm(): Promise<void>;
    };
    internal.room.assets[assetId]!.expiresAtMs = Date.now() - 1;
    bucket.deleteError = null;
    await internal.alarm();
    stored = state.storage.data.get('pro-room:v1') as StoredRoom & {
      quota: { usedBytes: number; reservedBytes: number };
    };
    expect(stored.assets[assetId]).toBeUndefined();
    expect(stored.quota).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect(bucket.deleted).toContain(asset.stagingObjectKey);
  });

  it('scopes idempotency replay records to one authenticated member', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const controller = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    const controllerCookie = cookieFrom(controller);
    bindCookiePresence(controllerCookie, await responseJson(controller));
    const body = { byteLength: 1024, name: 'same.wav', mime: 'audio/wav' };
    const ownerReservation = await responseJson(
      await worker.fetch(
        jsonRequest('/media/reservations', 'POST', body, ownerCookie, IDEMPOTENCY_KEY),
      ),
    );
    const controllerReservation = await responseJson(
      await worker.fetch(
        jsonRequest('/media/reservations', 'POST', body, controllerCookie, IDEMPOTENCY_KEY),
      ),
    );
    expect(controllerReservation.reservation.assetId).not.toBe(
      ownerReservation.reservation.assetId,
    );
    expect(controllerReservation.quota.reservedBytes).toBe(2048);
  });

  it('cleans an expired staged object by alarm before releasing reserved quota', async () => {
    const { worker, bucket, ownerCookie } = await activatedRoom();
    const reservation = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/media/reservations',
          'POST',
          { byteLength: 4096, name: 'expired.wav', mime: 'audio/wav' },
          ownerCookie,
          IDEMPOTENCY_KEY,
        ),
      ),
    );
    const internal = worker as unknown as {
      room: {
        assets: Record<string, { expiresAtMs: number; objectKey: string }>;
        quota: { reservedBytes: number };
      };
      alarm(): Promise<void>;
    };
    const asset = internal.room.assets[reservation.reservation.assetId]!;
    const objectKey = asset.stagingObjectKey;
    asset.expiresAtMs = Date.now() - 1;
    await internal.alarm();
    expect(bucket.deleted).toContain(objectKey);
    expect(internal.room.assets[reservation.reservation.assetId]).toBeUndefined();
    expect(internal.room.quota.reservedBytes).toBe(0);
  });
});

describe('PRO room system-audio ownership lease', () => {
  const publication = {
    publicationId: 'publication_018f977e5df57c8f',
    sessionId: 'session_018f977e5df57c8fbb80',
    tracks: [
      { trackName: 'mxqr-system-audio-000001-L-track', channel: 'L' },
      { trackName: 'mxqr-system-audio-000001-R-track', channel: 'R', mid: '1' },
    ],
  } as const;

  async function acquireSystemAudio(
    worker: MusixquareProRoom,
    cookie: string,
  ): Promise<Record<string, any>> {
    const response = await worker.fetch(jsonRequest('/system-audio/acquire', 'POST', {}, cookie));
    expect(response.status).toBe(200);
    return responseJson(response);
  }

  it('keeps the v1 snapshot shape unchanged and exposes live state only through its own API', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const snapshotResponse = await worker.fetch(request('/snapshot', {}, ownerCookie));
    const snapshotEnvelope = await responseJson(snapshotResponse);
    expect(parseProRoomSnapshot(snapshotEnvelope.snapshot)).not.toBeNull();
    expect(snapshotEnvelope.snapshot).not.toHaveProperty('systemAudio');
    expect(snapshotEnvelope.snapshot.viewer.capabilities).not.toContain('system-audio.publish');

    const stateResponse = await worker.fetch(request('/system-audio', {}, ownerCookie));
    expect(stateResponse.status).toBe(200);
    expect(await responseJson(stateResponse)).toEqual({
      systemAudio: {
        generation: 0,
        status: 'idle',
        ownerParticipantId: null,
        claimExpiresAt: null,
        liveExpiresAt: null,
        publication: null,
      },
    });
  });

  it('requires an authenticated active presence and fences mutations by owner, generation, and lease', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    expect((await worker.fetch(jsonRequest('/system-audio/acquire', 'POST', {}))).status).toBe(401);

    const memberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    const memberCookie = cookieFrom(memberResponse);
    bindCookiePresence(memberCookie, await responseJson(memberResponse));
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const generation = acquired.systemAudio.generation as number;
    const leaseId = acquired.leaseId as string;
    expect(leaseId).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const wrongOwner = await worker.fetch(
      jsonRequest(
        '/system-audio/commit',
        'POST',
        { generation, leaseId, publication },
        memberCookie,
      ),
    );
    expect(wrongOwner.status).toBe(409);
    expect(await responseJson(wrongOwner)).toEqual({ error: 'SYSTEM_AUDIO_NOT_OWNER' });

    const wrongGeneration = await worker.fetch(
      jsonRequest(
        '/system-audio/heartbeat',
        'POST',
        { generation: generation + 1, leaseId },
        ownerCookie,
      ),
    );
    expect(wrongGeneration.status).toBe(409);
    expect(await responseJson(wrongGeneration)).toEqual({
      error: 'SYSTEM_AUDIO_GENERATION_MISMATCH',
    });

    const wrongLease = await worker.fetch(
      jsonRequest(
        '/system-audio/release',
        'POST',
        { generation, leaseId: 'x'.repeat(43) },
        ownerCookie,
      ),
    );
    expect(wrongLease.status).toBe(409);
    expect(await responseJson(wrongLease)).toEqual({ error: 'SYSTEM_AUDIO_LEASE_INVALID' });
  });

  it('returns the same private lease on an owner retry without extending the fixed claim', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const internal = worker as unknown as {
      room: {
        presence: {
          participants: Record<string, { lastSeenAtMs: number }>;
        };
      };
    };
    const participant =
      internal.room.presence.participants[acquired.systemAudio.ownerParticipantId]!;
    const staleButActiveLastSeenAtMs = Date.now() - 40_000;
    participant.lastSeenAtMs = staleButActiveLastSeenAtMs;

    const retry = await acquireSystemAudio(worker, ownerCookie);

    expect(retry.leaseId).toBe(acquired.leaseId);
    expect(retry.systemAudio).toEqual(acquired.systemAudio);
    expect(participant.lastSeenAtMs).toBeGreaterThan(staleButActiveLastSeenAtMs);
  });

  it('never publishes the lease, owner incarnation, or Cloudflare session owner token', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const generation = acquired.systemAudio.generation as number;
    const leaseId = acquired.leaseId as string;
    expect(Object.keys(acquired).sort()).toEqual(['leaseId', 'systemAudio']);
    expect(JSON.stringify(acquired.systemAudio)).not.toContain(leaseId);
    expect(acquired.systemAudio).not.toHaveProperty('ownerPresenceIncarnationId');

    const leakedToken = await worker.fetch(
      jsonRequest(
        '/system-audio/commit',
        'POST',
        {
          generation,
          leaseId,
          publication: { ...publication, sessionOwnerToken: 'must-never-be-stored' },
        },
        ownerCookie,
      ),
    );
    expect(leakedToken.status).toBe(400);
    expect(await responseJson(leakedToken)).toEqual({ error: 'INVALID_REQUEST' });

    const committed = await worker.fetch(
      jsonRequest(
        '/system-audio/commit',
        'POST',
        { generation, leaseId, publication },
        ownerCookie,
      ),
    );
    expect(committed.status).toBe(200);
    const committedEnvelope = await responseJson(committed);
    expect(committedEnvelope).toEqual({
      systemAudio: expect.objectContaining({ status: 'live', publication }),
    });
    expect(JSON.stringify(committedEnvelope)).not.toContain(leaseId);
    expect(JSON.stringify(committedEnvelope)).not.toContain('sessionOwnerToken');

    const observed = await responseJson(
      await worker.fetch(request('/system-audio', {}, ownerCookie)),
    );
    expect(JSON.stringify(observed)).not.toContain(leaseId);
    expect(observed.systemAudio).not.toHaveProperty('ownerPresenceIncarnationId');
  });

  it('makes commit response-loss retries idempotent without extending the two-hour deadline', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const body = {
      generation: acquired.systemAudio.generation,
      leaseId: acquired.leaseId,
      publication,
    };
    const first = await responseJson(
      await worker.fetch(jsonRequest('/system-audio/commit', 'POST', body, ownerCookie)),
    );
    const retry = await responseJson(
      await worker.fetch(jsonRequest('/system-audio/commit', 'POST', body, ownerCookie)),
    );
    expect(retry).toEqual(first);

    const conflicting = await worker.fetch(
      jsonRequest(
        '/system-audio/commit',
        'POST',
        {
          ...body,
          publication: { ...publication, publicationId: 'publication_018f977e5df57c9f' },
        },
        ownerCookie,
      ),
    );
    expect(conflicting.status).toBe(409);
    expect(await responseJson(conflicting)).toEqual({
      error: 'SYSTEM_AUDIO_ALREADY_COMMITTED',
    });
  });

  it('fails closed and durably fences malformed stored live state', async () => {
    const { worker, state, ownerCookie, activationEnvelope } = await activatedRoom();
    const internal = worker as unknown as {
      room: { systemAudio: Record<string, unknown> };
    };
    internal.room.systemAudio = {
      generation: 11,
      status: 'live',
      ownerParticipantId: activationEnvelope.snapshot.viewer.participantId,
      ownerPresenceIncarnationId: activationEnvelope.snapshot.viewer.presenceIncarnationId,
      leaseId: 'z'.repeat(43),
      claimExpiresAt: null,
      liveExpiresAt: Date.now() + 60_000,
      publication: { ...publication, sessionOwnerToken: 'must-not-survive-migration' },
    };

    const observed = await responseJson(
      await worker.fetch(request('/system-audio', {}, ownerCookie)),
    );
    expect(observed).toEqual({
      systemAudio: {
        generation: 12,
        status: 'idle',
        ownerParticipantId: null,
        claimExpiresAt: null,
        liveExpiresAt: null,
        publication: null,
      },
    });
    const stored = (await state.storage.get('pro-room:v1')) as {
      systemAudio: Record<string, unknown>;
    };
    expect(stored.systemAudio).toEqual(
      expect.objectContaining({ generation: 12, status: 'idle', leaseId: null }),
    );
    expect(JSON.stringify(stored.systemAudio)).not.toContain('sessionOwnerToken');
  });

  it('migrates an old stored room when its alarm fires before any HTTP request', async () => {
    const context = await activatedRoom();
    const legacyRoom = (await context.state.storage.get('pro-room:v1')) as Record<string, unknown>;
    delete legacyRoom.systemAudio;

    const reloadedState = new FakeState();
    reloadedState.storage.data.set('pro-room:v1', legacyRoom);
    const reloadedWorker = new MusixquareProRoom(
      reloadedState as never,
      environment(context.bucket) as never,
    ) as MusixquareProRoom & { alarm(): Promise<void> };

    await expect(reloadedWorker.alarm()).resolves.toBeUndefined();

    const migrated = (await reloadedState.storage.get('pro-room:v1')) as {
      systemAudio: Record<string, unknown>;
    };
    expect(migrated.systemAudio).toEqual({
      generation: 0,
      status: 'idle',
      ownerParticipantId: null,
      ownerPresenceIncarnationId: null,
      leaseId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    });
    expect(reloadedState.storage.alarm).toEqual(expect.any(Number));
  });

  it('holds preparing for at most 45 seconds and live for at most two hours without heartbeat extension', async () => {
    const { worker, state, ownerCookie } = await activatedRoom();
    const acquiredAt = Date.now();
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    expect(acquired.systemAudio.claimExpiresAt).toBeGreaterThanOrEqual(acquiredAt + 45_000);
    expect(acquired.systemAudio.claimExpiresAt).toBeLessThanOrEqual(Date.now() + 45_000);
    const claimExpiresAt = acquired.systemAudio.claimExpiresAt as number;

    const preparingHeartbeat = await worker.fetch(
      jsonRequest(
        '/system-audio/heartbeat',
        'POST',
        { generation: acquired.systemAudio.generation, leaseId: acquired.leaseId },
        ownerCookie,
      ),
    );
    expect((await responseJson(preparingHeartbeat)).systemAudio.claimExpiresAt).toBe(
      claimExpiresAt,
    );

    const committedAt = Date.now();
    const committed = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/system-audio/commit',
          'POST',
          {
            generation: acquired.systemAudio.generation,
            leaseId: acquired.leaseId,
            publication,
          },
          ownerCookie,
        ),
      ),
    );
    expect(committed.systemAudio.liveExpiresAt).toBeGreaterThanOrEqual(
      committedAt + SYSTEM_AUDIO_SHARE_LIMIT_MS,
    );
    expect(committed.systemAudio.liveExpiresAt).toBeLessThanOrEqual(
      Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
    );
    const liveExpiresAt = committed.systemAudio.liveExpiresAt as number;
    const liveHeartbeat = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/system-audio/heartbeat',
          'POST',
          { generation: acquired.systemAudio.generation, leaseId: acquired.leaseId },
          ownerCookie,
        ),
      ),
    );
    expect(liveHeartbeat.systemAudio.liveExpiresAt).toBe(liveExpiresAt);

    const internal = worker as unknown as {
      room: { systemAudio: { generation: number; liveExpiresAt: number } };
      alarm(): Promise<void>;
    };
    const liveGeneration = internal.room.systemAudio.generation;
    internal.room.systemAudio.liveExpiresAt = Date.now() - 1;
    await internal.alarm();
    expect(internal.room.systemAudio).toMatchObject({
      generation: liveGeneration + 1,
      status: 'idle',
    });
    expect(state.storage.alarm).not.toBe(liveExpiresAt);
  });

  it('expires an abandoned preparing claim and allows a new participant to acquire afterward', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const internal = worker as unknown as {
      room: {
        systemAudio: { generation: number; status: string; claimExpiresAt: number };
      };
      alarm(): Promise<void>;
    };
    internal.room.systemAudio.claimExpiresAt = Date.now() - 1;
    await internal.alarm();
    expect(internal.room.systemAudio).toMatchObject({
      generation: acquired.systemAudio.generation + 1,
      status: 'idle',
    });

    const memberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Next owner' }),
    );
    const memberCookie = cookieFrom(memberResponse);
    bindCookiePresence(memberCookie, await responseJson(memberResponse));
    const next = await acquireSystemAudio(worker, memberCookie);
    expect(next.systemAudio).toMatchObject({
      generation: acquired.systemAudio.generation + 2,
      status: 'preparing',
    });
  });

  it('rejects acquisition above four devices and revokes a live share when the fifth joins', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    for (let index = 1; index < MAX_SYSTEM_AUDIO_DEVICES; index += 1) {
      const response = await worker.fetch(
        jsonRequest('/sessions', 'POST', {
          pin: '12345678',
          displayName: `Member ${index}`,
        }),
      );
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, await responseJson(response));
    }
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const committed = await worker.fetch(
      jsonRequest(
        '/system-audio/commit',
        'POST',
        {
          generation: acquired.systemAudio.generation,
          leaseId: acquired.leaseId,
          publication,
        },
        ownerCookie,
      ),
    );
    expect(committed.status).toBe(200);

    const fifth = await worker.fetch(
      jsonRequest('/sessions', 'POST', {
        pin: '12345678',
        displayName: `Member ${MAX_SYSTEM_AUDIO_DEVICES}`,
      }),
    );
    expect(fifth.status).toBe(200);
    const fifthCookie = cookieFrom(fifth);
    bindCookiePresence(fifthCookie, await responseJson(fifth));

    const afterJoin = await responseJson(
      await worker.fetch(request('/system-audio', {}, ownerCookie)),
    );
    expect(afterJoin.systemAudio).toMatchObject({
      generation: acquired.systemAudio.generation + 1,
      status: 'idle',
      ownerParticipantId: null,
      publication: null,
    });
    const blocked = await worker.fetch(
      jsonRequest('/system-audio/acquire', 'POST', {}, fifthCookie),
    );
    expect(blocked.status).toBe(409);
    expect(await responseJson(blocked)).toEqual({ error: 'SYSTEM_AUDIO_DEVICE_LIMIT' });
  });

  it('revokes ownership when its exact presence leaves or is superseded', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const takeover = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: true }, ownerCookie),
    );
    expect(takeover.status).toBe(200);
    const takeoverEnvelope = await responseJson(takeover);
    bindCookiePresence(ownerCookie, takeoverEnvelope);
    expect(takeoverEnvelope.snapshot).not.toHaveProperty('systemAudio');
    const superseded = await responseJson(
      await worker.fetch(request('/system-audio', {}, ownerCookie)),
    );
    expect(superseded.systemAudio).toMatchObject({
      generation: acquired.systemAudio.generation + 1,
      status: 'idle',
    });

    const reacquired = await acquireSystemAudio(worker, ownerCookie);
    const left = await worker.fetch(
      request('/presence/current', { method: 'DELETE' }, ownerCookie),
    );
    expect(left.status).toBe(200);
    const internal = worker as unknown as {
      room: { systemAudio: { generation: number; status: string } };
    };
    expect(internal.room.systemAudio).toMatchObject({
      generation: reacquired.systemAudio.generation + 1,
      status: 'idle',
    });
  });
});

describe('persistent PRO room orphan asset garbage collection', () => {
  it('marks a completed orphan without sliding its grace deadline and schedules it', async () => {
    const context = await activatedRoom();
    const beforeCompleteMs = Date.now();
    const { asset } = await completeReadyAsset(context, 'gc-orphan');

    expect(asset.status).toBe('ready');
    expect(asset.gcAfterMs).toBeGreaterThanOrEqual(beforeCompleteMs + 15 * 60 * 1000);
    const originalDeadline = asset.gcAfterMs;

    const accepted = await replacePlaylist(context, [], 'gc-orphan-empty');
    expect(accepted.status).toBe(200);
    expect(asset.gcAfterMs).toBe(originalDeadline);

    await context.worker.fetch(
      request('/presence/current', { method: 'DELETE' }, context.ownerCookie),
    );
    expect(context.state.storage.alarm).toBe(asset.stagingCleanupAfterMs);
    expect(context.state.storage.alarm).toBeLessThan(originalDeadline!);
  });

  it('cancels orphan collection when an accepted snapshot references the asset', async () => {
    const context = await activatedRoom();
    const { asset } = await completeReadyAsset(context, 'gc-reference');
    expect(asset.gcAfterMs).toEqual(expect.any(Number));

    const response = await replacePlaylist(
      context,
      [playlistItem('11111111-1111-4111-8111-111111111111', asset)],
      'gc-reference-add',
    );
    expect(response.status).toBe(200);
    expect(asset.gcAfterMs).toBeUndefined();
    expect(context.bucket.objects.has(asset.objectKey)).toBe(true);
  });

  it('deletes an expired unreferenced asset before releasing used quota', async () => {
    const context = await activatedRoom();
    const { assetId, asset } = await completeReadyAsset(context, 'gc-success', 8192);
    const internal = context.worker as unknown as {
      room: StoredRoom;
      alarm(): Promise<void>;
    };
    const revisionBeforeGc = internal.room.revision;
    asset.gcAfterMs = Date.now() - 1;

    await internal.alarm();

    expect(context.bucket.deleted).toContain(asset.objectKey);
    expect(context.bucket.objects.has(asset.objectKey)).toBe(false);
    expect(internal.room.assets[assetId]).toBeUndefined();
    expect(internal.room.quota).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect(internal.room.revision).toBe(revisionBeforeGc + 1);
  });

  it('postpones failed R2 collection without releasing quota, then retries safely', async () => {
    const context = await activatedRoom();
    const { assetId, asset } = await completeReadyAsset(context, 'gc-retry', 16_384);
    const internal = context.worker as unknown as {
      room: StoredRoom;
      alarm(): Promise<void>;
    };
    await context.worker.fetch(
      request('/presence/current', { method: 'DELETE' }, context.ownerCookie),
    );
    const revisionBeforeFailure = internal.room.revision;
    asset.gcAfterMs = Date.now() - 1;
    context.bucket.deleteError = new Error('temporary R2 outage');

    await internal.alarm();

    expect(internal.room.assets[assetId]).toBe(asset);
    expect(internal.room.quota).toMatchObject({ usedBytes: 16_384, reservedBytes: 0 });
    expect(internal.room.quota.usedBytes + internal.room.quota.reservedBytes).toBeLessThanOrEqual(
      internal.room.quota.limitBytes,
    );
    expect(internal.room.revision).toBe(revisionBeforeFailure);
    expect(asset.gcAfterMs).toBeGreaterThan(Date.now());
    expect(context.state.storage.alarm).toBe(asset.gcAfterMs);

    context.bucket.deleteError = null;
    asset.gcAfterMs = Date.now() - 1;
    await internal.alarm();
    expect(internal.room.assets[assetId]).toBeUndefined();
    expect(internal.room.quota).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect(context.bucket.deleted).toContain(asset.objectKey);
  });

  it('keeps a shared asset until the final playlist reference is removed', async () => {
    const context = await activatedRoom();
    const { assetId, asset } = await completeReadyAsset(context, 'gc-shared');
    const first = playlistItem('22222222-2222-4222-8222-222222222222', asset);
    const second = playlistItem('33333333-3333-4333-8333-333333333333', asset);
    expect((await replacePlaylist(context, [first, second], 'gc-shared-two')).status).toBe(200);
    expect(asset.gcAfterMs).toBeUndefined();

    expect((await replacePlaylist(context, [second], 'gc-shared-one')).status).toBe(200);
    expect(asset.gcAfterMs).toBeUndefined();

    // Even a stale/corrupt marker is rechecked against every remaining
    // reference at collection time.
    asset.gcAfterMs = Date.now() - 1;
    const internal = context.worker as unknown as {
      room: StoredRoom;
      alarm(): Promise<void>;
    };
    await internal.alarm();
    expect(internal.room.assets[assetId]).toBe(asset);
    expect(asset.gcAfterMs).toBeUndefined();
    expect(context.bucket.deleted).not.toContain(asset.objectKey);

    expect((await replacePlaylist(context, [], 'gc-shared-none')).status).toBe(200);
    expect(asset.gcAfterMs).toEqual(expect.any(Number));
  });
});

describe('persistent PRO room audio effects', () => {
  const defaultEffects = {
    reverb: {
      mixPercent: 0,
      decaySeconds: 5,
      preDelaySeconds: 0.1,
      lowCutPercent: 0,
      highCutPercent: 0,
    },
    equalizer: { bandsDb: [0, 0, 0, 0, 0] },
    virtualBass: { strengthPercent: 0 },
    virtualSurround: { widthPercent: 100 },
  };
  const configuredEffects = {
    reverb: {
      mixPercent: 40,
      decaySeconds: 1,
      preDelaySeconds: 0.02,
      lowCutPercent: 0,
      highCutPercent: 0,
    },
    equalizer: { bandsDb: [0, -2, 0, 4, 6] },
    virtualBass: { strengthPercent: 60 },
    virtualSurround: { widthPercent: 120 },
  };

  it('persists one strict effects resource without changing snapshot v1', async () => {
    const context = await activatedRoom();
    const before = await responseJson(
      await context.worker.fetch(request('/effects', {}, context.ownerCookie)),
    );
    expect(before).toEqual({
      schemaVersion: 1,
      view: 'effects',
      roomCode: ROOM_CODE,
      revision: 0,
      updatedAtMs: 0,
      effects: defaultEffects,
    });

    const epoch = context.activationEnvelope.snapshot.presence.coordinatorEpoch as number;
    const updatedResponse = await context.worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        { coordinatorEpoch: epoch, effects: configuredEffects },
        context.ownerCookie,
      ),
    );
    expect(updatedResponse.status).toBe(200);
    const updated = await responseJson(updatedResponse);
    expect(updated).toMatchObject({
      schemaVersion: 1,
      view: 'effects',
      revision: 1,
      effects: configuredEffects,
    });
    expect(updated.updatedAtMs).toBeGreaterThan(0);

    const snapshot = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(parseProRoomSnapshot(snapshot.snapshot)).not.toBeNull();
    expect(snapshot.snapshot).not.toHaveProperty('effects');

    const developerRead = await internalDeveloperRead(context.worker, 'effects');
    expect(developerRead.status).toBe(200);
    await expect(developerRead.json()).resolves.toMatchObject({
      view: 'effects',
      revision: 1,
      effects: configuredEffects,
    });

    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    const afterRestart = await responseJson(
      await restarted.fetch(request('/effects', {}, context.ownerCookie)),
    );
    expect(afterRestart).toMatchObject({ revision: 1, effects: configuredEffects });
  });

  it('fences updates to the active coordinator and rejects malformed full state', async () => {
    const context = await activatedRoom();
    const epoch = context.activationEnvelope.snapshot.presence.coordinatorEpoch as number;

    const stale = await context.worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        { coordinatorEpoch: epoch + 1, effects: configuredEffects },
        context.ownerCookie,
      ),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: 'COORDINATOR_EPOCH_MISMATCH' });

    const malformed = await context.worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        {
          coordinatorEpoch: epoch,
          effects: { ...configuredEffects, virtualBass: { strengthPercent: 101 } },
        },
        context.ownerCookie,
      ),
    );
    expect(malformed.status).toBe(400);
    const unchanged = await responseJson(
      await context.worker.fetch(request('/effects', {}, context.ownerCookie)),
    );
    expect(unchanged).toMatchObject({ revision: 0, effects: defaultEffects });
  });

  it('migrates pre-effects rooms to a neutral dedicated resource', async () => {
    const context = await activatedRoom();
    const stored = structuredClone(context.state.storage.data.get('pro-room:v1')) as Record<
      string,
      unknown
    >;
    delete stored.effects;
    context.state.storage.data.set('pro-room:v1', stored);

    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    const response = await restarted.fetch(request('/effects', {}, context.ownerCookie));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      revision: 0,
      effects: defaultEffects,
    });
    expect(
      (context.state.storage.data.get('pro-room:v1') as Record<string, unknown>).effects,
    ).toBeDefined();
  });

  it('accepts set_effects in an empty but awake compatible room', async () => {
    const dispatchFetch = vi.fn(async () => Response.json({ dispatched: true }));
    const context = await activatedRoom();
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatchFetch })),
    };
    const legacyCapability = await context.worker.fetch(
      jsonRequest(
        '/signaling-tickets',
        'POST',
        { developerControlVersion: 1 },
        context.ownerCookie,
      ),
    );
    expect(legacyCapability.status).toBe(200);
    const legacyAttempt = await createInternalDeveloperCommand(
      context.worker,
      DEVELOPER_KEY_ID,
      'developer-effects-legacy-0001',
      { type: 'set_effects', effects: { virtualBass: { strengthPercent: 60 } } },
    );
    expect(legacyAttempt.status).toBe(409);
    await expect(legacyAttempt.json()).resolves.toEqual({ error: 'COORDINATOR_INCOMPATIBLE' });

    const capability = await context.worker.fetch(
      jsonRequest(
        '/signaling-tickets',
        'POST',
        { developerControlVersion: 2 },
        context.ownerCookie,
      ),
    );
    expect(capability.status).toBe(200);

    const created = await createInternalDeveloperCommand(
      context.worker,
      DEVELOPER_KEY_ID,
      'developer-effects-command-0001',
      { type: 'set_effects', effects: { virtualBass: { strengthPercent: 60 } } },
    );
    expect(created.status).toBe(202);
    const body = await responseJson(created);
    expect(body).toMatchObject({
      status: expect.stringMatching(/pending|dispatched/),
    });
    expect(internal.room.developerCommands[body.commandId].command).toEqual({
      type: 'set_effects',
      effects: { virtualBass: { strengthPercent: 60 } },
    });
    expect(internal.room.developerCommands[body.commandId].developerControlVersion).toBe(2);
    expect(dispatchFetch).toHaveBeenCalledOnce();
    await expect(
      (dispatchFetch.mock.calls[0]?.[0] as Request).clone().json(),
    ).resolves.toMatchObject({
      developerControlVersion: 2,
      frame: { version: 2, command: { type: 'set_effects' } },
    });

    const beforeAck = structuredClone(internal.room.effects);
    expect(beforeAck.effects.virtualBass.strengthPercent).toBe(0);
    const ack = await context.worker.fetch(
      jsonRequest(
        `/developer-commands/${body.commandId}/ack`,
        'POST',
        { resultCode: 'applied' },
        context.ownerCookie,
      ),
    );
    expect(ack.status).toBe(200);
    expect(internal.room.developerCommands[body.commandId]).toMatchObject({
      status: 'applied',
      resultCode: 'applied',
    });
    expect(internal.room.effects).toMatchObject({
      revision: beforeAck.revision + 1,
      effects: { virtualBass: { strengthPercent: 60 } },
    });
    const duplicateAck = await context.worker.fetch(
      jsonRequest(
        `/developer-commands/${body.commandId}/ack`,
        'POST',
        { resultCode: 'already_applied' },
        context.ownerCookie,
      ),
    );
    expect(duplicateAck.status).toBe(200);
    expect(internal.room.effects.revision).toBe(beforeAck.revision + 1);

    const rejected = await createInternalDeveloperCommand(
      context.worker,
      DEVELOPER_KEY_ID,
      'developer-effects-command-0002',
      { type: 'set_effects', effects: { reverb: { mixPercent: 40 } } },
    );
    expect(rejected.status).toBe(202);
    const rejectedBody = await responseJson(rejected);
    const rejectedAck = await context.worker.fetch(
      jsonRequest(
        `/developer-commands/${rejectedBody.commandId}/ack`,
        'POST',
        { resultCode: 'execution_failed' },
        context.ownerCookie,
      ),
    );
    expect(rejectedAck.status).toBe(200);
    expect(internal.room.effects).toMatchObject({
      revision: beforeAck.revision + 1,
      effects: { reverb: { mixPercent: 0 }, virtualBass: { strengthPercent: 60 } },
    });
  });
});
