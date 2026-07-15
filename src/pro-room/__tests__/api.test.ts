import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRO_ROOM_PRODUCTION_ENDPOINT,
  PRO_ROOM_R2_HOST,
  ProRoomApiClient,
  ProRoomApiError,
  resolveProRoomEndpoint,
} from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomCapability,
  type ProRoomSnapshot,
} from '../contracts.ts';

const ROOM_CODE = '000001';
const CLAIM_TOKEN = `v1.${'a'.repeat(32)}.${'B'.repeat(43)}`;
const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';
const ASSET_ID = 'asset_00000000001';
const IDEMPOTENCY_KEY = '018f977e-5df5-7c8f-bb80-55d847ddec0f';
const OWNER_CAPABILITIES: ProRoomCapability[] = [
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'coordinator.eligible',
  'members.manage',
  'room.configure',
];

function activeSnapshot(): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 3,
    playlistRevision: 1,
    playlist: [
      {
        queueItemId: QUEUE_ITEM_ID,
        name: 'Track',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
    ],
    currentQueueItemId: QUEUE_ITEM_ID,
    playback: {
      coordinatorEpoch: 1,
      revision: 2,
      state: 'paused',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 12.5,
      updatedAtMs: 1_800_000_000_000,
    },
    presence: {
      coordinatorEpoch: 1,
      revision: 1,
      coordinatorParticipantId: 'participant_00001',
      participants: [
        {
          participantId: 'participant_00001',
          displayName: 'Owner',
          role: 'owner',
          joinedAtMs: 1_800_000_000_000,
        },
      ],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: {
      memberId: 'member_0000000001',
      participantId: 'participant_00001',
      displayName: 'Owner',
      role: 'owner',
      capabilities: [...OWNER_CAPABILITIES],
      coordinatorEligible: true,
    },
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

function requestParts(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): {
  url: URL;
  init: RequestInit;
} {
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error('fetch was not called');
  return { url: new URL(String(call[0])), init: call[1] ?? {} };
}

function presignedUrl(): string {
  const url = new URL(`https://${PRO_ROOM_R2_HOST}/pro-media/private-object`);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', 'credential');
  url.searchParams.set('X-Amz-Date', '20260716T000000Z');
  url.searchParams.set('X-Amz-Expires', '900');
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  url.searchParams.set('X-Amz-Signature', 'a'.repeat(64));
  return url.toString();
}

function quota(reservedBytes = 0) {
  return {
    limitBytes: PRO_ROOM_QUOTA_BYTES,
    perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
    usedBytes: 0,
    reservedBytes,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PRO room endpoint boundary', () => {
  it('uses production by default and only accepts trusted HTTPS or loopback overrides', () => {
    expect(resolveProRoomEndpoint(undefined)).toBe(PRO_ROOM_PRODUCTION_ENDPOINT);
    expect(resolveProRoomEndpoint('https://pro-staging.musixquare.com/')).toBe(
      'https://pro-staging.musixquare.com',
    );
    expect(resolveProRoomEndpoint('http://127.0.0.1:8789')).toBe('http://127.0.0.1:8789');
    expect(resolveProRoomEndpoint('https://localhost:8789')).toBe('https://localhost:8789');

    expect(resolveProRoomEndpoint('http://pro.musixquare.com')).toBe(PRO_ROOM_PRODUCTION_ENDPOINT);
    expect(resolveProRoomEndpoint('https://musixquare.com')).toBe(PRO_ROOM_PRODUCTION_ENDPOINT);
    expect(resolveProRoomEndpoint('https://musixquare.com.evil.example')).toBe(
      PRO_ROOM_PRODUCTION_ENDPOINT,
    );
    expect(resolveProRoomEndpoint('https://pro.musixquare.com/path')).toBe(
      PRO_ROOM_PRODUCTION_ENDPOINT,
    );
    expect(resolveProRoomEndpoint('javascript:alert(1)')).toBe(PRO_ROOM_PRODUCTION_ENDPOINT);
  });

  it('bootstraps with cookies, no bearer, no query, and a bounded exact response', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ roomCode: ROOM_CODE, status: 'activation_required' }));
    const signal = new AbortController().signal;
    const client = new ProRoomApiClient({ fetch: fetchMock });

    await expect(client.getBootstrap(ROOM_CODE, signal)).resolves.toEqual({
      roomCode: ROOM_CODE,
      status: 'activation_required',
    });

    const { url, init } = requestParts(fetchMock);
    expect(url.toString()).toBe(`${PRO_ROOM_PRODUCTION_ENDPOINT}/v1/rooms/000001/bootstrap`);
    expect(url.search).toBe('');
    expect(init.credentials).toBe('include');
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBe(signal);
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('accept')).toBe('application/json');
  });

  it('rejects a bootstrap body that exceeds its declared bound before parsing it', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { roomCode: ROOM_CODE, status: 'pin_required' },
          { headers: { 'content-length': '9000' } },
        ),
      );
    const client = new ProRoomApiClient({ fetch: fetchMock });

    await expect(client.getBootstrap(ROOM_CODE)).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      status: 200,
    });
  });

  it('rejects any bootstrap response that tries to expose a claim credential', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        roomCode: ROOM_CODE,
        status: 'activation_required',
        claimToken: CLAIM_TOKEN,
      }),
    );
    const client = new ProRoomApiClient({ fetch: fetchMock });

    await expect(client.getBootstrap(ROOM_CODE)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});

describe('PRO room cookie session API', () => {
  it('keeps the one-time claim in the activation JSON body and returns a parsed snapshot', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ snapshot: activeSnapshot() }));
    const client = new ProRoomApiClient({ fetch: fetchMock });

    await expect(
      client.activate({
        code: ROOM_CODE,
        claimToken: CLAIM_TOKEN,
        temporaryPin: '00000001',
        newPin: '12345678',
        ownerName: ' Owner ',
      }),
    ).resolves.toEqual(activeSnapshot());

    const { url, init } = requestParts(fetchMock);
    expect(url.toString()).toBe(`${PRO_ROOM_PRODUCTION_ENDPOINT}/v1/rooms/000001/activation`);
    expect(url.toString()).not.toContain(CLAIM_TOKEN);
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
    expect(JSON.parse(String(init.body))).toEqual({
      claimToken: CLAIM_TOKEN,
      temporaryPin: '00000001',
      newPin: '12345678',
      ownerName: 'Owner',
    });
  });

  it('creates a member session without exposing a token to browser code', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        snapshot: activeSnapshot(),
        session: { expiresAtMs: 1_900_000_000_000 },
      }),
    );
    const client = new ProRoomApiClient({ fetch: fetchMock });

    await expect(
      client.createSession({ code: ROOM_CODE, pin: '12345678', displayName: ' Friend ' }),
    ).resolves.toEqual(activeSnapshot());

    const { url, init } = requestParts(fetchMock);
    expect(url.pathname).toBe('/v1/rooms/000001/sessions');
    expect(JSON.parse(String(init.body))).toEqual({ pin: '12345678', displayName: 'Friend' });
    expect(String(init.body)).not.toContain('token');
  });

  it('parses snapshot-returning methods and strict ok-only mutations', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ snapshot: activeSnapshot() }))
      .mockResolvedValueOnce(jsonResponse({ snapshot: activeSnapshot() }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new ProRoomApiClient({ fetch: fetchMock });

    await expect(client.getSnapshot(ROOM_CODE)).resolves.toEqual(activeSnapshot());
    await expect(client.heartbeat(ROOM_CODE)).resolves.toEqual(activeSnapshot());
    await expect(client.changePin(ROOM_CODE, '87654321')).resolves.toBeUndefined();
    await expect(client.closeSession(ROOM_CODE)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname)).toEqual([
      '/v1/rooms/000001/snapshot',
      '/v1/rooms/000001/presence/heartbeat',
      '/v1/rooms/000001/pin',
      '/v1/rooms/000001/sessions/current',
    ]);
  });

  it('rejects malformed or cross-room snapshots instead of admitting them to state', async () => {
    const malformed = activeSnapshot() as unknown as Record<string, unknown>;
    malformed.internalObjectKey = 'rooms/000001/private.flac';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ snapshot: malformed }))
      .mockResolvedValueOnce(
        jsonResponse({ snapshot: { ...activeSnapshot(), roomCode: '000000' } }),
      );
    const client = new ProRoomApiClient({ fetch: fetchMock });

    await expect(client.getSnapshot(ROOM_CODE)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    // The snapshot schema permits another PRO code, so the API boundary must
    // independently reject it before the caller can replace current room state.
    await expect(client.getSnapshot(ROOM_CODE)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('sends snapshot revisions with the caller-stable idempotency key', async () => {
    const snapshot = activeSnapshot();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ snapshot: { ...snapshot, revision: 4 } }));
    const client = new ProRoomApiClient({ fetch: fetchMock });

    await client.updateSnapshot({
      code: ROOM_CODE,
      baseRevision: snapshot.revision,
      playlist: snapshot.playlist,
      currentQueueItemId: snapshot.currentQueueItemId,
      playback: snapshot.playback,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    const { url, init } = requestParts(fetchMock);
    expect(url.pathname).toBe('/v1/rooms/000001/snapshot');
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('idempotency-key')).toBe(IDEMPOTENCY_KEY);
    expect(JSON.parse(String(init.body))).toEqual({
      baseRevision: snapshot.revision,
      playlist: snapshot.playlist,
      currentQueueItemId: snapshot.currentQueueItemId,
      playback: snapshot.playback,
    });
  });

  it('redacts server detail and submitted secrets from API errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: 'PIN_INVALID',
          message: 'PIN 12345678 and private claim leaked by upstream',
          claimToken: CLAIM_TOKEN,
        },
        { status: 401, headers: { 'retry-after': '12' } },
      ),
    );
    const client = new ProRoomApiClient({ fetch: fetchMock });

    const error = await client
      .createSession({ code: ROOM_CODE, pin: '12345678', displayName: 'Friend' })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProRoomApiError);
    expect(error).toMatchObject({ code: 'PIN_INVALID', status: 401, retryAfterSeconds: 12 });
    expect(String(error)).toBe('ProRoomApiError: PRO_ROOM_API_PIN_INVALID');
    expect(JSON.stringify(error)).not.toContain('12345678');
    expect(JSON.stringify(error)).not.toContain(CLAIM_TOKEN);
    expect(JSON.stringify(error)).not.toContain('private claim');
  });
});

describe('PRO room private media API', () => {
  it('accepts only a bounded reservation and exact R2 presigned upload URL', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        reservation: {
          assetId: ASSET_ID,
          version: 1,
          byteLength: 1024,
          expiresAtMs: 1_900_000_000_000,
          upload: {
            method: 'PUT',
            url: presignedUrl(),
            headers: { 'Content-Type': 'audio/flac' },
          },
        },
        quota: quota(1024),
      }),
    );
    const client = new ProRoomApiClient({ fetch: fetchMock });

    await expect(
      client.createMediaReservation({
        code: ROOM_CODE,
        byteLength: 1024,
        name: ' Live.flac ',
        mime: 'audio/flac',
        sha256: 'a'.repeat(64),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).resolves.toMatchObject({
      assetId: ASSET_ID,
      upload: { method: 'PUT', headers: { 'content-type': 'audio/flac' } },
    });

    const { url, init } = requestParts(fetchMock);
    expect(url.pathname).toBe('/v1/rooms/000001/media/reservations');
    expect(new Headers(init.headers).get('idempotency-key')).toBe(IDEMPOTENCY_KEY);
    expect(JSON.parse(String(init.body))).toMatchObject({
      byteLength: 1024,
      name: 'Live.flac',
      mime: 'audio/flac',
    });
  });

  it.each([
    'javascript:alert(1)',
    'http://01353882e4eea3a5acaa0c45e8336af4.r2.cloudflarestorage.com/object',
    'https://evil.example/object?X-Amz-Algorithm=AWS4-HMAC-SHA256',
  ])('rejects an untrusted returned upload URL: %s', async (uploadUrl) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        reservation: {
          assetId: ASSET_ID,
          version: 1,
          byteLength: 1024,
          expiresAtMs: 1_900_000_000_000,
          upload: { method: 'PUT', url: uploadUrl, headers: {} },
        },
        quota: quota(1024),
      }),
    );
    const client = new ProRoomApiClient({ fetch: fetchMock });

    await expect(
      client.createMediaReservation({
        code: ROOM_CODE,
        byteLength: 1024,
        name: 'track.flac',
        mime: 'audio/flac',
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('strictly parses complete, download, and delete media envelopes', async () => {
    const asset = {
      kind: 'pro-r2' as const,
      assetId: ASSET_ID,
      version: 1,
      byteLength: 1024,
      mime: 'audio/flac',
      sha256: 'a'.repeat(64),
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ asset, quota: quota() }))
      .mockResolvedValueOnce(
        jsonResponse({
          asset,
          download: { url: presignedUrl(), expiresAtMs: 1_900_000_000_000 },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, assetId: ASSET_ID, quota: quota() }));
    const client = new ProRoomApiClient({ fetch: fetchMock });

    await expect(
      client.completeMedia({ code: ROOM_CODE, assetId: ASSET_ID, idempotencyKey: IDEMPOTENCY_KEY }),
    ).resolves.toEqual({ asset, quota: quota() });
    await expect(client.getMediaDownload(ROOM_CODE, ASSET_ID)).resolves.toEqual({
      asset,
      url: presignedUrl(),
      expiresAtMs: 1_900_000_000_000,
    });
    await expect(
      client.deleteMedia({ code: ROOM_CODE, assetId: ASSET_ID, idempotencyKey: IDEMPOTENCY_KEY }),
    ).resolves.toEqual({ assetId: ASSET_ID, quota: quota() });

    expect(fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname)).toEqual([
      `/v1/rooms/000001/media/${ASSET_ID}/complete`,
      `/v1/rooms/000001/media/${ASSET_ID}/download`,
      `/v1/rooms/000001/media/${ASSET_ID}`,
    ]);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBe(
      IDEMPOTENCY_KEY,
    );
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('idempotency-key')).toBe(
      IDEMPOTENCY_KEY,
    );
  });
});
