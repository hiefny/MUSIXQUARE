import { describe, expect, it } from 'vitest';
import {
  MusixquareProRoom,
  issueProRoomActivationClaim,
  issueProRoomOwnerRecoveryClaim,
  default as proRoomWorker,
} from '../../../cloudflare/pro-room-worker.js';
import { MAX_SYSTEM_AUDIO_DEVICES, SYSTEM_AUDIO_SHARE_LIMIT_MS } from '../../core/constants.ts';
import { parseProRoomSnapshot } from '../snapshot.ts';

const ROOM_CODE = '000001';
const BASE_URL = `https://pro.musixquare.com/v1/rooms/${ROOM_CODE}`;
const ACTIVATION_SECRET = 'activation-secret-'.padEnd(48, 'a');
const PIN_PEPPER = 'pin-pepper-'.padEnd(48, 'p');
const SESSION_SECRET = 'session-secret-'.padEnd(48, 's');
const SIGNALING_SECRET = 'signaling-secret-'.padEnd(48, 'g');
const R2_ACCOUNT_ID = '01353882e4eea3a5acaa0c45e8336af4';
const IDEMPOTENCY_KEY = '018f977e-5df5-7c8f-bb80-55d847ddec0f';
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

  async delete(key: string): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    this.deleted.push(key);
    this.objects.delete(key);
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

describe('persistent PRO room bootstrap and activation', () => {
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
    for (const path of ['/internal/admin/provision', '/v1/rooms/000002/internal/admin/provision']) {
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
