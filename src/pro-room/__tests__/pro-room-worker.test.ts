import { describe, expect, it } from 'vitest';
import {
  MusixquareProRoom,
  issueProRoomActivationClaim,
  default as proRoomWorker,
} from '../../../cloudflare/pro-room-worker.js';
import { parseProRoomSnapshot } from '../snapshot.ts';

const ROOM_CODE = '000001';
const BASE_URL = `https://pro.musixquare.com/v1/rooms/${ROOM_CODE}`;
const ACTIVATION_SECRET = 'activation-secret-'.padEnd(48, 'a');
const PIN_PEPPER = 'pin-pepper-'.padEnd(48, 'p');
const SESSION_SECRET = 'session-secret-'.padEnd(48, 's');
const SIGNALING_SECRET = 'signaling-secret-'.padEnd(48, 'g');
const R2_ACCOUNT_ID = '01353882e4eea3a5acaa0c45e8336af4';
const IDEMPOTENCY_KEY = '018f977e-5df5-7c8f-bb80-55d847ddec0f';

type StoredRoom = {
  revision: number;
  playlist: unknown[];
  assets: Record<string, { objectKey: string; byteLength: number; mime: string }>;
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
  readonly objects = new Map<string, unknown>();
  readonly deleted: string[] = [];
  deleteError: Error | null = null;

  async head(key: string): Promise<unknown> {
    return structuredClone(this.objects.get(key)) ?? null;
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
  const headers = new Headers(init.headers);
  headers.set('x-mxqr-pro-room-code', ROOM_CODE);
  headers.set('x-mxqr-pro-ip-hash', 'hashed-client-address');
  if (cookie) headers.set('cookie', cookie);
  return new Request(`${BASE_URL}${path}`, { ...init, headers });
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

async function responseJson(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('missing session cookie');
  return setCookie.split(';')[0] ?? '';
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
    .find((value) => value.startsWith('__Host-mxqr_pro_owner='))
    ?.split(';')[0];
  expect(ownerRecoveryCookie).toBeTruthy();
  const activationEnvelope = await responseJson(activation);
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
    const { worker, ownerCookie } = await activatedRoom();
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
  });

  it('has no public claim-issuance endpoint', async () => {
    const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
    const response = await worker.fetch(request('/claims', { method: 'POST' }));
    expect(response.status).toBe(404);
    expect(await responseJson(response)).toEqual({ error: 'NOT_FOUND' });
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
    await worker.fetch(request('/sessions/current', { method: 'DELETE' }, ownerCookie));
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

  it('revokes controller sessions on owner PIN rotation while retaining the owner session', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const controller = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    expect(controller.status).toBe(200);
    const controllerCookie = cookieFrom(controller);
    expect(controllerCookie).toMatch(/^__Host-mxqr_pro_session=/);
    expect(controller.headers.get('set-cookie')).not.toMatch(/Domain=/i);
    const sessionEnvelope = await responseJson(controller);
    expect(Object.keys(sessionEnvelope)).toEqual(['snapshot', 'session']);
    expect(Object.keys(sessionEnvelope.session)).toEqual(['expiresAtMs']);

    const rotate = await worker.fetch(
      jsonRequest('/pin', 'POST', { pin: '87654321' }, ownerCookie),
    );
    expect(await responseJson(rotate)).toEqual({ ok: true });
    expect((await worker.fetch(request('/snapshot', {}, ownerCookie))).status).toBe(200);
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

    const awake = await worker.fetch(
      request('/presence/heartbeat', { method: 'POST' }, ownerCookie),
    );
    const awakeEnvelope = await responseJson(awake);
    expect(Object.keys(awakeEnvelope)).toEqual(['snapshot']);
    const awakeSnapshot = awakeEnvelope.snapshot;
    expect(awakeSnapshot).toMatchObject({ runtime: 'awake', presence: { coordinatorEpoch: 3 } });

    const access = await worker.fetch(
      request('/signaling-tickets', { method: 'POST' }, ownerCookie),
    );
    const envelope = await responseJson(access);
    expect(Object.keys(envelope)).toEqual(['ticket', 'expiresAtMs', 'role', 'coordinatorEpoch']);
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
    });
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(90);
  });

  it('keeps a multi-peer leave response contract-valid while electing the next coordinator', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const controller = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    const controllerCookie = cookieFrom(controller);
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
      },
    };
    const first = await worker.fetch(
      jsonRequest('/snapshot', 'PUT', body, ownerCookie, IDEMPOTENCY_KEY),
    );
    const replay = await worker.fetch(
      jsonRequest('/snapshot', 'PUT', body, ownerCookie, IDEMPOTENCY_KEY),
    );
    expect(first.status).toBe(200);
    expect(await responseJson(replay)).toEqual(await responseJson(first));
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
    bucket.objects.set(asset.objectKey, {
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
    bucket.objects.set(asset.objectKey, { staged: true });

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
    expect(bucket.deleted).toContain(asset.objectKey);
    expect(bucket.objects.has(asset.objectKey)).toBe(false);
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
    expect(bucket.deleted.filter((key) => key === asset.objectKey)).toHaveLength(1);
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
    bucket.objects.set(asset.objectKey, { staged: true });
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
    expect(bucket.deleted).toContain(asset.objectKey);
  });

  it('scopes idempotency replay records to one authenticated member', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const controller = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678', displayName: 'Friend' }),
    );
    const controllerCookie = cookieFrom(controller);
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
    const objectKey = asset.objectKey;
    asset.expiresAtMs = Date.now() - 1;
    await internal.alarm();
    expect(bucket.deleted).toContain(objectKey);
    expect(internal.room.assets[reservation.reservation.assetId]).toBeUndefined();
    expect(internal.room.quota.reservedBytes).toBe(0);
  });
});
