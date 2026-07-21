import { describe, expect, it, vi } from 'vitest';
import facadeWorker from '../../../cloudflare/developer-api-facade-worker.js';

const ROOM_CODE = '000001';
const KEY_ID = 'A'.repeat(16);
const COMMAND_ID = `cmd_${'C'.repeat(22)}`;
const IDEMPOTENCY_KEY = 'request.command-0001';
const QUEUE_ITEM_ID = '123e4567-e89b-42d3-a456-426614174000';
const ASSET_ID = `asset_${'D'.repeat(32)}`;
const UPLOAD_URL =
  'https://01353882e4eea3a5acaa0c45e8336af4.r2.cloudflarestorage.com/musixquare-pro-media/staging?X-Amz-Signature=' +
  'a'.repeat(64);

function effectsPayload() {
  return {
    schemaVersion: 1,
    view: 'effects',
    roomCode: ROOM_CODE,
    revision: 5,
    updatedAtMs: 1_784_262_910_000,
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

function effectsPayloadV2() {
  return {
    ...effectsPayload(),
    schemaVersion: 2,
    effects: {
      ...effectsPayload().effects,
      virtualTreble: { enabled: true },
    },
  };
}

function queueModePayload() {
  return {
    schemaVersion: 1,
    view: 'queue-mode',
    roomCode: ROOM_CODE,
    revision: 6,
    playlistRevision: 4,
    updatedAtMs: 1_784_262_910_000,
    repeatMode: 'all',
    shuffleEnabled: true,
  };
}

function request(body: unknown, options: RequestInit = {}, path = '/internal/v1/read'): Request {
  const headers = new Headers(options.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(`https://developer-api-facade.internal${path}`, {
    method: 'POST',
    ...options,
    headers,
    body: JSON.stringify(body),
  });
}

function namespace(responseFactory: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  return {
    seen,
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((_id: string) => ({
      fetch: vi.fn(async (incoming: Request) => {
        seen.push(incoming.clone());
        return responseFactory(incoming);
      }),
    })),
  };
}

describe('private Developer API facade', () => {
  it('forwards one fixed caller-relative projection intent without bearer credentials or paths', async () => {
    const rooms = namespace(() =>
      Response.json({
        schemaVersion: 1,
        view: 'room',
        roomCode: ROOM_CODE,
        status: 'active',
        runtime: 'awake',
        revision: 8,
        participantCount: 2,
        controlAvailable: false,
        quota: {
          limitBytes: 1_073_741_824,
          perAssetLimitBytes: 209_715_200,
          usedBytes: 512,
          reservedBytes: 0,
        },
        participants: [{ participantId: 'private', displayName: 'Private' }],
        ownerMemberId: 'private-owner',
      }),
    );
    const response = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'room' }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      view: 'room',
      roomCode: ROOM_CODE,
      status: 'active',
      runtime: 'awake',
      revision: 8,
      participantCount: 2,
      controlAvailable: false,
      quota: {
        limitBytes: 1_073_741_824,
        perAssetLimitBytes: 209_715_200,
        usedBytes: 512,
        reservedBytes: 0,
      },
    });
    expect(rooms.idFromName).toHaveBeenCalledWith(ROOM_CODE);
    expect(rooms.seen).toHaveLength(1);
    const forwarded = rooms.seen[0]!;
    expect(new URL(forwarded.url).pathname).toBe('/internal/developer/v1/read');
    expect(forwarded.headers.get('x-mxqr-pro-room-code')).toBe(ROOM_CODE);
    expect(forwarded.headers.has('authorization')).toBe(false);
    expect(forwarded.headers.has('cookie')).toBe(false);
    await expect(forwarded.json()).resolves.toEqual({ keyId: KEY_ID, projection: 'room' });
  });

  it('keeps read forwarding compatible while the public API rolls out caller-relative provenance', async () => {
    const rooms = namespace(() =>
      Response.json({
        schemaVersion: 1,
        view: 'room',
        roomCode: ROOM_CODE,
        status: 'active',
        runtime: 'sleeping',
        revision: 1,
        participantCount: 0,
        controlAvailable: false,
        quota: {
          limitBytes: 1_073_741_824,
          perAssetLimitBytes: 209_715_200,
          usedBytes: 0,
          reservedBytes: 0,
        },
      }),
    );
    const response = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, projection: 'room' }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(200);
    await expect(rooms.seen[0]!.json()).resolves.toEqual({ projection: 'room' });
  });

  it('forwards and sanitizes the exact effects projection', async () => {
    const rooms = namespace(() =>
      Response.json({ ...effectsPayload(), privatePresetId: 'never-public' }),
    );
    const response = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'effects' }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_BACKEND_RESPONSE' });

    const validRooms = namespace(() => Response.json(effectsPayload()));
    const valid = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'effects' }),
      { PRO_ROOM_DEVELOPER_ROOMS: validRooms },
    );
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toEqual(effectsPayload());
    await expect(validRooms.seen[0]!.json()).resolves.toEqual({
      keyId: KEY_ID,
      projection: 'effects',
    });
  });

  it('forwards an explicit effects v2 negotiation and rejects a downgraded backend', async () => {
    const rooms = namespace(() => Response.json(effectsPayloadV2()));
    const response = await facadeWorker.fetch(
      request({
        roomCode: ROOM_CODE,
        keyId: KEY_ID,
        projection: 'effects',
        effectsVersion: 2,
      }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(effectsPayloadV2());
    await expect(rooms.seen[0]!.json()).resolves.toEqual({
      keyId: KEY_ID,
      projection: 'effects',
      effectsVersion: 2,
    });

    const downgradedRooms = namespace(() => Response.json(effectsPayload()));
    const downgraded = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, projection: 'effects', effectsVersion: 2 }),
      { PRO_ROOM_DEVELOPER_ROOMS: downgradedRooms },
    );
    expect(downgraded.status).toBe(503);
    await expect(downgraded.json()).resolves.toEqual({ error: 'INVALID_BACKEND_RESPONSE' });
  });

  it('normalizes an explicit effects v1 request to the rollback-compatible room hop', async () => {
    const rooms = namespace(() => Response.json(effectsPayload()));
    const response = await facadeWorker.fetch(
      request({
        roomCode: ROOM_CODE,
        keyId: KEY_ID,
        projection: 'effects',
        effectsVersion: 1,
      }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(effectsPayload());
    await expect(rooms.seen[0]!.json()).resolves.toEqual({
      keyId: KEY_ID,
      projection: 'effects',
    });
  });

  it('forwards and sanitizes the exact queue-mode projection', async () => {
    const rooms = namespace(() => Response.json(queueModePayload()));
    const response = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'queue-mode' }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(queueModePayload());
    await expect(rooms.seen[0]!.json()).resolves.toEqual({
      keyId: KEY_ID,
      projection: 'queue-mode',
    });
  });

  it('forwards one exact queue-mode update and never exposes private shuffle order', async () => {
    const rooms = namespace(() => Response.json(queueModePayload()));
    const queueMode = { baseRevision: 5, repeatMode: 'all', shuffleEnabled: true };
    const response = await facadeWorker.fetch(
      request(
        { roomCode: ROOM_CODE, keyId: KEY_ID, idempotencyKey: IDEMPOTENCY_KEY, queueMode },
        {},
        '/internal/v1/queue-mode/update',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(queueModePayload());
    expect(rooms.seen).toHaveLength(1);
    const forwarded = rooms.seen[0]!;
    expect(new URL(forwarded.url).pathname).toBe('/internal/developer/v1/queue-mode/update');
    expect([...forwarded.headers.keys()].sort()).toEqual(['content-type', 'x-mxqr-pro-room-code']);
    await expect(forwarded.json()).resolves.toEqual({
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      queueMode,
    });

    const privateRooms = namespace(() =>
      Response.json({ ...queueModePayload(), shuffleOrder: [QUEUE_ITEM_ID] }),
    );
    const privateResponse = await facadeWorker.fetch(
      request(
        { roomCode: ROOM_CODE, keyId: KEY_ID, idempotencyKey: IDEMPOTENCY_KEY, queueMode },
        {},
        '/internal/v1/queue-mode/update',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: privateRooms },
    );
    expect(privateResponse.status).toBe(503);
    await expect(privateResponse.json()).resolves.toEqual({ error: 'INVALID_BACKEND_RESPONSE' });
  });

  it('rejects malformed queue-mode updates before the PRO room boundary', async () => {
    const invalidQueueModes = [
      { repeatMode: 'all', shuffleEnabled: true },
      { baseRevision: -1, repeatMode: 'all', shuffleEnabled: true },
      { baseRevision: 1.5, repeatMode: 'all', shuffleEnabled: true },
      { baseRevision: 5, repeatMode: 'invalid', shuffleEnabled: true },
      { baseRevision: 5, repeatMode: 'all', shuffleEnabled: 'true' },
      { baseRevision: 5, repeatMode: 'all', shuffleEnabled: true, shuffleOrder: [] },
    ];
    for (const queueMode of invalidQueueModes) {
      const rooms = namespace(() => Response.json(queueModePayload()));
      const response = await facadeWorker.fetch(
        request(
          { roomCode: ROOM_CODE, keyId: KEY_ID, idempotencyKey: IDEMPOTENCY_KEY, queueMode },
          {},
          '/internal/v1/queue-mode/update',
        ),
        { PRO_ROOM_DEVELOPER_ROOMS: rooms },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
      expect(rooms.seen).toHaveLength(0);
    }
  });

  it('maps queue-mode revision conflicts without leaking backend payloads', async () => {
    const rooms = namespace(() =>
      Response.json(
        { error: 'QUEUE_MODE_REVISION_CONFLICT', queueMode: queueModePayload() },
        { status: 409 },
      ),
    );
    const response = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          queueMode: { baseRevision: 5, repeatMode: 'one', shuffleEnabled: false },
        },
        {},
        '/internal/v1/queue-mode/update',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'BACKEND_UNAVAILABLE' });

    const exactRooms = namespace(() =>
      Response.json({ error: 'QUEUE_MODE_REVISION_CONFLICT' }, { status: 409 }),
    );
    const exact = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          queueMode: { baseRevision: 5, repeatMode: 'one', shuffleEnabled: false },
        },
        {},
        '/internal/v1/queue-mode/update',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: exactRooms },
    );
    expect(exact.status).toBe(409);
    await expect(exact.json()).resolves.toEqual({ error: 'QUEUE_MODE_REVISION_CONFLICT' });
  });

  it('forwards a canonical command to one fixed PRO room path and strips private response fields', async () => {
    const createdAtMs = 1_784_262_910_000;
    const rooms = namespace(() =>
      Response.json(
        {
          schemaVersion: 1,
          roomCode: ROOM_CODE,
          commandId: COMMAND_ID,
          status: 'pending',
          createdAtMs,
          expiresAtMs: createdAtMs + 30_000,
          coordinatorParticipantId: 'private-participant',
          attempts: 1,
        },
        { status: 202 },
      ),
    );
    const response = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          command: { type: 'play_item', queueItemId: QUEUE_ITEM_ID },
        },
        {},
        '/internal/v1/commands/create',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      commandId: COMMAND_ID,
      status: 'pending',
      createdAtMs,
      expiresAtMs: createdAtMs + 30_000,
    });
    expect(rooms.seen).toHaveLength(1);
    const forwarded = rooms.seen[0]!;
    expect(new URL(forwarded.url).pathname).toBe('/internal/developer/v1/commands/create');
    expect(forwarded.headers.get('x-mxqr-pro-room-code')).toBe(ROOM_CODE);
    expect([...forwarded.headers.keys()].sort()).toEqual(['content-type', 'x-mxqr-pro-room-code']);
    await expect(forwarded.json()).resolves.toEqual({
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      command: { type: 'play_item', queueItemId: QUEUE_ITEM_ID },
    });
  });

  it('forwards only the exact next command to the PRO room boundary', async () => {
    const createdAtMs = 1_784_262_910_000;
    const rooms = namespace(() =>
      Response.json(
        {
          schemaVersion: 1,
          roomCode: ROOM_CODE,
          commandId: COMMAND_ID,
          status: 'pending',
          createdAtMs,
          expiresAtMs: createdAtMs + 30_000,
        },
        { status: 202 },
      ),
    );
    const base = {
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      idempotencyKey: 'request.playback-next-0001',
    };
    const response = await facadeWorker.fetch(
      request({ ...base, command: { type: 'next' } }, {}, '/internal/v1/commands/create'),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(202);
    expect(rooms.seen).toHaveLength(1);
    await expect(rooms.seen[0]!.json()).resolves.toEqual({
      ...base,
      command: { type: 'next' },
    });

    const rejected = await facadeWorker.fetch(
      request(
        {
          ...base,
          idempotencyKey: 'request.playback-next-0002',
          command: { type: 'next', force: true },
        },
        {},
        '/internal/v1/commands/create',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    expect(rooms.seen).toHaveLength(1);
  });

  it('forwards a strictly validated partial effects command', async () => {
    const createdAtMs = 1_784_262_910_000;
    const rooms = namespace(() =>
      Response.json(
        {
          schemaVersion: 1,
          roomCode: ROOM_CODE,
          commandId: COMMAND_ID,
          status: 'pending',
          createdAtMs,
          expiresAtMs: createdAtMs + 30_000,
        },
        { status: 202 },
      ),
    );
    const command = {
      type: 'set_effects',
      effects: {
        reverb: { mixPercent: 0, decaySeconds: 30, preDelaySeconds: 1 },
        equalizer: { bandsDb: [-12, -6, 0, 6, 12] },
        virtualBass: { strengthPercent: 100 },
        virtualSurround: { widthPercent: 200 },
        virtualTreble: { enabled: true },
      },
    };
    const response = await facadeWorker.fetch(
      request(
        { roomCode: ROOM_CODE, keyId: KEY_ID, idempotencyKey: IDEMPOTENCY_KEY, command },
        {},
        '/internal/v1/commands/create',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(202);
    await expect(rooms.seen[0]!.json()).resolves.toEqual({
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      command,
    });
  });

  it('rejects malformed effects commands before the PRO room boundary', async () => {
    const invalidCommands = [
      { type: 'set_effects', effects: {} },
      { type: 'set_effects', effects: { reverb: {} } },
      { type: 'set_effects', effects: { reverb: { lowCutPercent: 101 } } },
      { type: 'set_effects', effects: { equalizer: { bandsDb: [0, 0, 0, 0] } } },
      { type: 'set_effects', effects: { virtualBass: { strengthPercent: Number.NaN } } },
      { type: 'set_effects', effects: { virtualSurround: { widthPercent: -1 } } },
      { type: 'set_effects', effects: { virtualTreble: { enabled: 'yes' } } },
      { type: 'set_effects', effects: { preset: 'private' } },
    ];
    for (const command of invalidCommands) {
      const rooms = namespace(() => Response.json({}));
      const response = await facadeWorker.fetch(
        request(
          { roomCode: ROOM_CODE, keyId: KEY_ID, idempotencyKey: IDEMPOTENCY_KEY, command },
          {},
          '/internal/v1/commands/create',
        ),
        { PRO_ROOM_DEVELOPER_ROOMS: rooms },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
      expect(rooms.seen).toHaveLength(0);
    }
  });

  it('preserves a terminal command when an accepted response is retried idempotently', async () => {
    const createdAtMs = 1_784_262_910_000;
    const rooms = namespace(() =>
      Response.json(
        {
          commandId: COMMAND_ID,
          status: 'applied',
          createdAtMs,
          expiresAtMs: createdAtMs + 30_000,
          completedAtMs: createdAtMs + 100,
          resultCode: 'already_applied',
          keyId: 'private-key-id',
        },
        { status: 202 },
      ),
    );
    const response = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          command: { type: 'play' },
        },
        {},
        '/internal/v1/commands/create',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      commandId: COMMAND_ID,
      status: 'applied',
      createdAtMs,
      expiresAtMs: createdAtMs + 30_000,
      completedAtMs: createdAtMs + 100,
      resultCode: 'already_applied',
    });
  });

  it('forwards only canonical queue mutation intents and returns a sanitized queue projection', async () => {
    const rooms = namespace(() =>
      Response.json(
        {
          schemaVersion: 1,
          view: 'queue',
          roomCode: ROOM_CODE,
          playlistRevision: 5,
          currentQueueItemId: QUEUE_ITEM_ID,
          items: [
            {
              queueItemId: QUEUE_ITEM_ID,
              kind: 'youtube',
              name: 'API track',
              title: 'API track',
              addedBy: 'current_api_key',
              keyId: 'private-key-id',
              privateSource: { videoId: 'dQw4w9WgXcQ' },
            },
          ],
          ownerMemberId: 'private-owner',
        },
        { status: 201 },
      ),
    );
    const mutation = {
      type: 'add_youtube',
      videoId: 'dQw4w9WgXcQ',
      name: 'API track',
      title: 'API track',
    };
    const response = await facadeWorker.fetch(
      request(
        { roomCode: ROOM_CODE, keyId: KEY_ID, idempotencyKey: IDEMPOTENCY_KEY, mutation },
        {},
        '/internal/v1/queue/mutate',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload).toEqual({
      schemaVersion: 1,
      view: 'queue',
      roomCode: ROOM_CODE,
      playlistRevision: 5,
      currentQueueItemId: QUEUE_ITEM_ID,
      items: [
        {
          queueItemId: QUEUE_ITEM_ID,
          kind: 'youtube',
          name: 'API track',
          title: 'API track',
          addedBy: 'current_api_key',
        },
      ],
    });
    expect(rooms.seen).toHaveLength(1);
    const forwarded = rooms.seen[0]!;
    expect(new URL(forwarded.url).pathname).toBe('/internal/developer/v1/queue/mutate');
    expect([...forwarded.headers.keys()].sort()).toEqual(['content-type', 'x-mxqr-pro-room-code']);
    await expect(forwarded.json()).resolves.toEqual({
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      mutation,
    });
    expect(JSON.stringify(payload)).not.toContain('private-key-id');
  });

  it('forwards one exact bounded YouTube batch and sanitizes its queue response', async () => {
    const rooms = namespace(() =>
      Response.json(
        {
          schemaVersion: 1,
          view: 'queue',
          roomCode: ROOM_CODE,
          playlistRevision: 8,
          currentQueueItemId: null,
          items: [
            {
              queueItemId: QUEUE_ITEM_ID,
              kind: 'youtube',
              name: 'First API track',
              addedBy: 'current_api_key',
              developerOwnerKeyId: KEY_ID,
            },
          ],
          privateRoomState: true,
        },
        { status: 201 },
      ),
    );
    const mutation = {
      type: 'add_youtube_batch',
      items: [
        { videoId: 'dQw4w9WgXcQ', name: 'First API track' },
        {
          videoId: 'M7lc1UVf-VE',
          playlistId: 'PL1234567890',
          videoIds: ['dQw4w9WgXcQ', 'M7lc1UVf-VE'],
          name: 'Second API track',
          artist: 'API artist',
        },
      ],
    };
    const response = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          actorName: 'Friend integration',
          idempotencyKey: 'request.queue-batch-0001',
          mutation,
        },
        {},
        '/internal/v1/queue/mutate',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      view: 'queue',
      roomCode: ROOM_CODE,
      playlistRevision: 8,
      currentQueueItemId: null,
      items: [
        {
          queueItemId: QUEUE_ITEM_ID,
          kind: 'youtube',
          name: 'First API track',
          addedBy: 'current_api_key',
        },
      ],
    });
    expect(rooms.seen).toHaveLength(1);
    await expect(rooms.seen[0]!.json()).resolves.toEqual({
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      actorName: 'Friend integration',
      idempotencyKey: 'request.queue-batch-0001',
      mutation,
    });
  });

  it('normalizes repeated playlist aggregates and preserves ordered video IDs', async () => {
    const rooms = namespace(() =>
      Response.json(
        {
          schemaVersion: 1,
          view: 'queue',
          roomCode: ROOM_CODE,
          playlistRevision: 9,
          currentQueueItemId: null,
          items: [],
        },
        { status: 201 },
      ),
    );
    const items = [
      {
        videoId: 'dQw4w9WgXcQ',
        playlistId: 'PL_ALPHA',
        videoIds: ['dQw4w9WgXcQ', '9bZkp7q19f0', 'dQw4w9WgXcQ'],
        name: 'Playlist alpha first',
      },
      { videoId: 'M7lc1UVf-VE', name: 'Standalone one' },
      {
        videoId: '9bZkp7q19f0',
        playlistId: 'PL_ALPHA',
        videoIds: ['dQw4w9WgXcQ', '9bZkp7q19f0', 'dQw4w9WgXcQ'],
        name: 'Playlist alpha duplicate',
      },
      {
        videoId: 'aqz-KE-bpKQ',
        playlistId: 'PL_BETA',
        name: 'Playlist beta first',
      },
      { videoId: 'ScMzIvxBSi4', name: 'Standalone two' },
      {
        videoId: 'jNQXAC9IVRw',
        playlistId: 'PL_BETA',
        name: 'Playlist beta duplicate',
      },
    ];

    const response = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          actorName: 'Friend integration',
          idempotencyKey: 'request.queue-batch-playlist-dedupe',
          mutation: { type: 'add_youtube_batch', items },
        },
        {},
        '/internal/v1/queue/mutate',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(201);
    expect(rooms.seen).toHaveLength(1);
    await expect(rooms.seen[0]!.json()).resolves.toEqual({
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      actorName: 'Friend integration',
      idempotencyKey: 'request.queue-batch-playlist-dedupe',
      mutation: {
        type: 'add_youtube_batch',
        items: [
          {
            ...items[0],
            videoIds: ['dQw4w9WgXcQ', '9bZkp7q19f0', 'dQw4w9WgXcQ'],
          },
          items[1],
          { ...items[3], videoIds: ['aqz-KE-bpKQ', 'jNQXAC9IVRw'] },
          items[4],
        ],
      },
    });
  });

  it('rejects malformed, oversized, or untrusted-label YouTube batches before the room boundary', async () => {
    const mutations = [
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
          { videoId: 'not-valid', name: 'Invalid' },
        ],
      },
      {
        type: 'add_youtube_batch',
        items: [{ videoId: 'dQw4w9WgXcQ', name: 'Unexpected', private: true }],
      },
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            videoIds: ['dQw4w9WgXcQ'],
            name: 'Manifest without playlist',
          },
        ],
      },
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            playlistId: 'PL_MIXED',
            videoIds: ['dQw4w9WgXcQ', 'M7lc1UVf-VE'],
            name: 'Manifest row',
          },
          {
            videoId: 'M7lc1UVf-VE',
            playlistId: 'PL_MIXED',
            name: 'Manifest-less row',
          },
        ],
      },
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            playlistId: 'PL_TOO_LARGE',
            videoIds: Array.from({ length: 5_001 }, () => 'dQw4w9WgXcQ'),
            name: 'Too large manifest',
          },
        ],
      },
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            playlistId: 'PL_MISMATCH',
            videoIds: ['M7lc1UVf-VE'],
            name: 'Mismatched manifest entry',
          },
        ],
      },
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            playlistId: 'PL_OVERFLOW',
            videoIds: Array.from({ length: 3_000 }, () => 'dQw4w9WgXcQ'),
            name: 'First half',
          },
          {
            videoId: 'M7lc1UVf-VE',
            playlistId: 'PL_OVERFLOW',
            videoIds: Array.from({ length: 3_000 }, () => 'M7lc1UVf-VE'),
            name: 'Second half',
          },
        ],
      },
    ];
    for (const [index, mutation] of mutations.entries()) {
      const rooms = namespace(() => Response.json({}));
      const response = await facadeWorker.fetch(
        request(
          {
            roomCode: ROOM_CODE,
            keyId: KEY_ID,
            idempotencyKey: `request.queue-batch-invalid-${index}`,
            mutation,
          },
          {},
          '/internal/v1/queue/mutate',
        ),
        { PRO_ROOM_DEVELOPER_ROOMS: rooms },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
      expect(rooms.seen).toHaveLength(0);
    }

    const rooms = namespace(() => Response.json({}));
    const invalidActor = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          actorName: 'A'.repeat(65),
          idempotencyKey: 'request.queue-batch-invalid-actor',
          mutation: {
            type: 'add_youtube_batch',
            items: [{ videoId: 'dQw4w9WgXcQ', name: 'Valid' }],
          },
        },
        {},
        '/internal/v1/queue/mutate',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(invalidActor.status).toBe(400);
    await expect(invalidActor.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    expect(rooms.seen).toHaveLength(0);
  });

  it('accepts a wrapped manifest above 64 KiB at the private boundary', async () => {
    const rooms = namespace(() =>
      Response.json(
        {
          schemaVersion: 1,
          view: 'queue',
          roomCode: ROOM_CODE,
          playlistRevision: 1,
          currentQueueItemId: null,
          items: [],
        },
        { status: 201 },
      ),
    );
    const videoIds = [...Array.from({ length: 4_999 }, () => 'dQw4w9WgXcQ'), 'M7lc1UVf-VE'];
    const items = [
      {
        videoId: 'M7lc1UVf-VE',
        playlistId: 'PL_LARGE_MANIFEST',
        videoIds,
        name: 'Large playlist manifest',
      },
    ];
    const body = {
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      actorName: 'A'.repeat(64),
      idempotencyKey: 'request.queue-batch-boundary',
      mutation: { type: 'add_youtube_batch', items },
    };
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeGreaterThan(64 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(192 * 1024);

    const response = await facadeWorker.fetch(request(body, {}, '/internal/v1/queue/mutate'), {
      PRO_ROOM_DEVELOPER_ROOMS: rooms,
    });
    expect(response.status).toBe(201);
    expect(rooms.seen).toHaveLength(1);
    await expect(rooms.seen[0]!.json()).resolves.toEqual(body);
  });

  it('keeps the 192-KiB envelope allowance scoped to queue mutations only', async () => {
    const queueRooms = namespace(() =>
      Response.json(
        {
          schemaVersion: 1,
          view: 'queue',
          roomCode: ROOM_CODE,
          playlistRevision: 1,
          currentQueueItemId: null,
          items: [],
        },
        { status: 201 },
      ),
    );
    const queueResponse = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: 'request.queue-declared-envelope',
          mutation: {
            type: 'add_youtube_batch',
            items: [{ videoId: 'dQw4w9WgXcQ', name: 'Declared envelope' }],
          },
        },
        { headers: { 'content-length': String(150 * 1024) } },
        '/internal/v1/queue/mutate',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: queueRooms },
    );
    expect(queueResponse.status).toBe(201);
    expect(queueRooms.seen).toHaveLength(1);

    const readRooms = namespace(() => Response.json({}));
    const oversizedRead = await facadeWorker.fetch(
      request(
        { roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'room' },
        { headers: { 'content-length': String(70 * 1024) } },
        '/internal/v1/read',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: readRooms },
    );
    expect(oversizedRead.status).toBe(400);
    await expect(oversizedRead.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    expect(readRooms.seen).toHaveLength(0);
  });

  it('forwards only the exact atomic queue-clear mutation', async () => {
    const rooms = namespace(() =>
      Response.json({
        schemaVersion: 1,
        view: 'queue',
        roomCode: ROOM_CODE,
        playlistRevision: 6,
        currentQueueItemId: null,
        items: [],
      }),
    );
    const response = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: 'request.queue-clear-0001',
          mutation: { type: 'clear' },
        },
        {},
        '/internal/v1/queue/mutate',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      view: 'queue',
      roomCode: ROOM_CODE,
      playlistRevision: 6,
      currentQueueItemId: null,
      items: [],
    });
    expect(rooms.seen).toHaveLength(1);
    await expect(rooms.seen[0]!.json()).resolves.toEqual({
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      idempotencyKey: 'request.queue-clear-0001',
      mutation: { type: 'clear' },
    });

    const invalidRooms = namespace(() => Response.json({}));
    const invalid = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: 'request.queue-clear-0002',
          mutation: { type: 'clear', unexpected: true },
        },
        {},
        '/internal/v1/queue/mutate',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: invalidRooms },
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    expect(invalidRooms.seen).toHaveLength(0);
  });

  it('forwards only the exact caller-owned queue-clear mutation', async () => {
    const rooms = namespace(() =>
      Response.json({
        schemaVersion: 1,
        view: 'queue',
        roomCode: ROOM_CODE,
        playlistRevision: 7,
        currentQueueItemId: QUEUE_ITEM_ID,
        items: [
          {
            queueItemId: QUEUE_ITEM_ID,
            kind: 'youtube',
            name: 'Participant track',
            addedBy: 'participant',
          },
        ],
      }),
    );
    const response = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: 'request.queue-clear-owned-0001',
          mutation: { type: 'clear_owned' },
        },
        {},
        '/internal/v1/queue/mutate',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      playlistRevision: 7,
      items: [{ queueItemId: QUEUE_ITEM_ID, addedBy: 'participant' }],
    });
    expect(rooms.seen).toHaveLength(1);
    await expect(rooms.seen[0]!.json()).resolves.toEqual({
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      idempotencyKey: 'request.queue-clear-owned-0001',
      mutation: { type: 'clear_owned' },
    });

    const invalidRooms = namespace(() => Response.json({}));
    const invalid = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: 'request.queue-clear-owned-0002',
          mutation: { type: 'clear_owned', queueItemId: QUEUE_ITEM_ID },
        },
        {},
        '/internal/v1/queue/mutate',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: invalidRooms },
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    expect(invalidRooms.seen).toHaveLength(0);
  });

  it('sanitizes direct-upload reservations and completions across fixed internal paths', async () => {
    const quota = {
      limitBytes: 1_073_741_824,
      perAssetLimitBytes: 209_715_200,
      usedBytes: 0,
      reservedBytes: 4_096,
    };
    const rooms = namespace((incoming) => {
      const path = new URL(incoming.url).pathname;
      if (path.endsWith('/create')) {
        return Response.json(
          {
            schemaVersion: 1,
            roomCode: ROOM_CODE,
            assetId: ASSET_ID,
            queueItemId: QUEUE_ITEM_ID,
            byteLength: 4_096,
            uploadExpiresAtMs: 1_784_263_810_000,
            completionExpiresAtMs: 1_784_263_990_000,
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
            quota,
          },
          { status: 201 },
        );
      }
      return Response.json(
        {
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
            byteLength: 4_096,
          },
          playlistRevision: 8,
          quota: { ...quota, usedBytes: 4_096, reservedBytes: 0 },
        },
        { status: 201 },
      );
    });
    const media = { name: 'Orchestra.flac', byteLength: 4_096, mime: 'audio/flac' };
    const create = await facadeWorker.fetch(
      request(
        { roomCode: ROOM_CODE, keyId: KEY_ID, idempotencyKey: IDEMPOTENCY_KEY, media },
        {},
        '/internal/v1/media/uploads/create',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(create.status).toBe(201);
    const created = await create.json();
    expect(created).toMatchObject({
      assetId: ASSET_ID,
      queueItemId: QUEUE_ITEM_ID,
      upload: {
        method: 'PUT',
        url: UPLOAD_URL,
        headers: { 'content-length': '4096', 'content-type': 'audio/flac' },
      },
    });

    const complete = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: 'request.upload-complete-0001',
          assetId: ASSET_ID,
        },
        {},
        '/internal/v1/media/uploads/complete',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(complete.status).toBe(201);
    const completed = await complete.json();
    expect(completed).toMatchObject({
      asset: { assetId: ASSET_ID, kind: 'pro-r2', mime: 'audio/flac' },
      queueItem: { queueItemId: QUEUE_ITEM_ID, kind: 'audio', byteLength: 4_096 },
      playlistRevision: 8,
    });
    expect(rooms.seen.map((seen) => new URL(seen.url).pathname)).toEqual([
      '/internal/developer/v1/media/uploads/create',
      '/internal/developer/v1/media/uploads/complete',
    ]);
  });

  it('fails closed when an upload reservation contains a non-R2 URL or unsigned headers', async () => {
    const rooms = namespace(() =>
      Response.json(
        {
          schemaVersion: 1,
          roomCode: ROOM_CODE,
          assetId: ASSET_ID,
          queueItemId: QUEUE_ITEM_ID,
          byteLength: 4_096,
          uploadExpiresAtMs: 1_784_263_810_000,
          completionExpiresAtMs: 1_784_263_990_000,
          upload: {
            method: 'PUT',
            url: 'https://example.invalid/upload?X-Amz-Signature=stolen',
            headers: { 'content-length': '4096', 'content-type': 'audio/flac' },
          },
          quota: {
            limitBytes: 1_073_741_824,
            perAssetLimitBytes: 209_715_200,
            usedBytes: 0,
            reservedBytes: 4_096,
          },
        },
        { status: 201 },
      ),
    );
    const response = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          media: { name: 'Orchestra.flac', byteLength: 4_096, mime: 'audio/flac' },
        },
        {},
        '/internal/v1/media/uploads/create',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_BACKEND_RESPONSE' });
  });

  it('fails closed when upload responses do not echo the requested media or asset identity', async () => {
    const quota = {
      limitBytes: 1_073_741_824,
      perAssetLimitBytes: 209_715_200,
      usedBytes: 0,
      reservedBytes: 4_097,
    };
    const mismatchedCreate = namespace(() =>
      Response.json(
        {
          schemaVersion: 1,
          roomCode: ROOM_CODE,
          assetId: ASSET_ID,
          queueItemId: QUEUE_ITEM_ID,
          byteLength: 4_097,
          uploadExpiresAtMs: 1_784_263_810_000,
          completionExpiresAtMs: 1_784_263_990_000,
          upload: {
            method: 'PUT',
            url: UPLOAD_URL,
            headers: {
              'content-length': '4097',
              'content-type': 'audio/flac',
              'x-amz-meta-mxqr-room': ROOM_CODE,
              'x-amz-meta-mxqr-asset': ASSET_ID,
              'x-amz-meta-mxqr-version': '1',
              'x-amz-meta-mxqr-bytes': '4097',
            },
          },
          quota,
        },
        { status: 201 },
      ),
    );
    const create = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          media: { name: 'Orchestra.flac', byteLength: 4_096, mime: 'audio/flac' },
        },
        {},
        '/internal/v1/media/uploads/create',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: mismatchedCreate },
    );
    expect(create.status).toBe(503);
    await expect(create.json()).resolves.toEqual({ error: 'INVALID_BACKEND_RESPONSE' });

    const otherAssetId = `asset_${'E'.repeat(32)}`;
    const mismatchedComplete = namespace(() =>
      Response.json(
        {
          schemaVersion: 1,
          roomCode: ROOM_CODE,
          asset: {
            kind: 'pro-r2',
            assetId: otherAssetId,
            version: 1,
            byteLength: 4_096,
            mime: 'audio/flac',
          },
          queueItem: {
            queueItemId: QUEUE_ITEM_ID,
            kind: 'audio',
            name: 'Orchestra.flac',
            byteLength: 4_096,
          },
          playlistRevision: 8,
          quota: { ...quota, usedBytes: 4_096, reservedBytes: 0 },
        },
        { status: 201 },
      ),
    );
    const complete = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: 'request.upload-complete-mismatch',
          assetId: ASSET_ID,
        },
        {},
        '/internal/v1/media/uploads/complete',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: mismatchedComplete },
    );
    expect(complete.status).toBe(503);
    await expect(complete.json()).resolves.toEqual({ error: 'INVALID_BACKEND_RESPONSE' });
  });

  it('delegates command ownership lookup and returns a bounded terminal status', async () => {
    const createdAtMs = 1_784_262_910_000;
    const rooms = namespace(() =>
      Response.json({
        commandId: COMMAND_ID,
        status: 'applied',
        createdAtMs,
        expiresAtMs: createdAtMs + 30_000,
        completedAtMs: createdAtMs + 250,
        resultCode: 'already_applied',
        keyId: 'private-key-id',
      }),
    );
    const response = await facadeWorker.fetch(
      request(
        { roomCode: ROOM_CODE, keyId: KEY_ID, commandId: COMMAND_ID },
        {},
        '/internal/v1/commands/status',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      commandId: COMMAND_ID,
      status: 'applied',
      createdAtMs,
      expiresAtMs: createdAtMs + 30_000,
      completedAtMs: createdAtMs + 250,
      resultCode: 'already_applied',
    });
    await expect(rooms.seen[0]!.json()).resolves.toEqual({
      roomCode: ROOM_CODE,
      keyId: KEY_ID,
      commandId: COMMAND_ID,
    });
  });

  it('rejects non-canonical commands and normalizes private backend errors', async () => {
    const unusedRooms = namespace(() => Response.json({}));
    for (const command of [
      { type: 'play', expectedQueueItemId: QUEUE_ITEM_ID },
      { type: 'seek', positionSeconds: -1 },
      { type: 'play_item', queueItemId: 'queue_item_000001' },
    ]) {
      const response = await facadeWorker.fetch(
        request(
          {
            roomCode: ROOM_CODE,
            keyId: KEY_ID,
            idempotencyKey: IDEMPOTENCY_KEY,
            command,
          },
          {},
          '/internal/v1/commands/create',
        ),
        { PRO_ROOM_DEVELOPER_ROOMS: unusedRooms },
      );
      expect(response.status).toBe(400);
    }
    expect(unusedRooms.get).not.toHaveBeenCalled();

    const unavailable = namespace(() => Response.json({ error: 'ROOM_SLEEPING' }, { status: 409 }));
    const response = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          command: { type: 'play' },
        },
        {},
        '/internal/v1/commands/create',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: unavailable },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'ROOM_SLEEPING' });

    const exhausted = namespace(() =>
      Response.json({ error: 'PLAYBACK_REVISION_EXHAUSTED' }, { status: 409 }),
    );
    const exhaustedResponse = await facadeWorker.fetch(
      request(
        {
          roomCode: ROOM_CODE,
          keyId: KEY_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          mutation: { type: 'clear_owned' },
        },
        {},
        '/internal/v1/queue/mutate',
      ),
      { PRO_ROOM_DEVELOPER_ROOMS: exhausted },
    );
    expect(exhaustedResponse.status).toBe(409);
    await expect(exhaustedResponse.json()).resolves.toEqual({
      error: 'ROOM_STATE_CAPACITY_EXCEEDED',
    });
  });

  it('reconstructs queue items without asset IDs, object keys, or raw sources', async () => {
    const rooms = namespace(() =>
      Response.json({
        schemaVersion: 1,
        view: 'queue',
        roomCode: ROOM_CODE,
        playlistRevision: 3,
        currentQueueItemId: 'queue_item_000001',
        items: [
          {
            queueItemId: 'queue_item_000001',
            kind: 'audio',
            name: 'Music.flac',
            title: 'Music',
            byteLength: 1_024,
            assetId: 'private-asset-id',
            objectKey: 'rooms/000001/private.flac',
            source: { kind: 'pro-r2', assetId: 'private-asset-id' },
          },
        ],
      }),
    );
    const response = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'queue' }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toEqual({
      schemaVersion: 1,
      view: 'queue',
      roomCode: ROOM_CODE,
      playlistRevision: 3,
      currentQueueItemId: 'queue_item_000001',
      items: [
        {
          queueItemId: 'queue_item_000001',
          kind: 'audio',
          name: 'Music.flac',
          title: 'Music',
          byteLength: 1_024,
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('private-asset-id');
    expect(JSON.stringify(payload)).not.toContain('objectKey');
    expect(JSON.stringify(payload)).not.toContain('source');
  });

  it.each(['participant', 'current_api_key', 'another_api_key'])(
    'passes through the bounded caller-relative queue provenance %s',
    async (addedBy) => {
      const rooms = namespace(() =>
        Response.json({
          schemaVersion: 1,
          view: 'queue',
          roomCode: ROOM_CODE,
          playlistRevision: 1,
          currentQueueItemId: QUEUE_ITEM_ID,
          items: [
            {
              queueItemId: QUEUE_ITEM_ID,
              kind: 'youtube',
              name: 'Track',
              addedBy,
            },
          ],
        }),
      );
      const response = await facadeWorker.fetch(
        request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'queue' }),
        { PRO_ROOM_DEVELOPER_ROOMS: rooms },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ items: [{ addedBy }] });
    },
  );

  it('accepts a rolling-deploy queue item without provenance but rejects an invalid value', async () => {
    const payload = {
      schemaVersion: 1,
      view: 'queue',
      roomCode: ROOM_CODE,
      playlistRevision: 1,
      currentQueueItemId: QUEUE_ITEM_ID,
      items: [
        {
          queueItemId: QUEUE_ITEM_ID,
          kind: 'youtube',
          name: 'Track',
        },
      ],
    };
    const legacyRooms = namespace(() => Response.json(payload));
    const compatible = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'queue' }),
      { PRO_ROOM_DEVELOPER_ROOMS: legacyRooms },
    );
    expect(compatible.status).toBe(200);
    await expect(compatible.json()).resolves.toEqual(payload);

    const invalidRooms = namespace(() =>
      Response.json({
        ...payload,
        items: [{ ...payload.items[0], addedBy: KEY_ID }],
      }),
    );
    const invalid = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'queue' }),
      { PRO_ROOM_DEVELOPER_ROOMS: invalidRooms },
    );
    expect(invalid.status).toBe(503);
    await expect(invalid.json()).resolves.toEqual({ error: 'INVALID_BACKEND_RESPONSE' });
  });

  it('bounds long metadata without splitting a surrogate pair', async () => {
    const longName = `${'a'.repeat(511)}😀${'b'.repeat(1_000)}`;
    const rooms = namespace(() =>
      Response.json({
        schemaVersion: 1,
        view: 'queue',
        roomCode: ROOM_CODE,
        playlistRevision: 1,
        currentQueueItemId: 'queue_item_000001',
        items: [
          {
            queueItemId: 'queue_item_000001',
            kind: 'audio',
            name: longName,
            title: 't'.repeat(2_048),
            byteLength: 1,
          },
        ],
      }),
    );
    const response = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'queue' }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { items: Array<{ name: string; title: string }> };
    expect(payload.items[0]?.name).toBe('a'.repeat(511));
    expect(payload.items[0]?.title).toBe('t'.repeat(512));
  });

  it('accepts only the exact internal path and exact projection body', async () => {
    const rooms = namespace(() => Response.json({}));
    const wrongPath = await facadeWorker.fetch(
      new Request('https://developer-api-facade.internal/internal/admin/provision', {
        method: 'POST',
      }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(wrongPath.status).toBe(404);

    const extraField = await facadeWorker.fetch(
      request({
        roomCode: ROOM_CODE,
        keyId: KEY_ID,
        projection: 'room',
        path: '/internal/admin/provision',
      }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(extraField.status).toBe(400);

    const wrongProjection = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'admin' }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(wrongProjection.status).toBe(400);
    expect(rooms.get).not.toHaveBeenCalled();
  });

  it('rejects requests carrying browser or caller credentials', async () => {
    const rooms = namespace(() => Response.json({}));
    for (const headers of [
      { authorization: 'Bearer secret' },
      { cookie: 'session=secret' },
      { origin: 'https://attacker.example' },
    ]) {
      const response = await facadeWorker.fetch(
        request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'room' }, { headers }),
        { PRO_ROOM_DEVELOPER_ROOMS: rooms },
      );
      expect(response.status).toBe(404);
    }
    expect(rooms.get).not.toHaveBeenCalled();
  });

  it('fails closed on missing bindings, backend failures, and malformed projections', async () => {
    const missing = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'room' }),
      {},
    );
    expect(missing.status).toBe(503);

    const unavailableRooms = namespace(() =>
      Response.json({ error: 'ROOM_STATE_INVALID' }, { status: 503 }),
    );
    const unavailable = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'room' }),
      { PRO_ROOM_DEVELOPER_ROOMS: unavailableRooms },
    );
    expect(unavailable.status).toBe(503);

    const malformedRooms = namespace(() =>
      Response.json({
        schemaVersion: 1,
        view: 'playback',
        roomCode: ROOM_CODE,
        revision: 1,
        playlistRevision: 1,
        state: 'playing',
        queueItemId: 'queue_item_000001',
        positionSeconds: -1,
        observedAtMs: Date.now(),
        item: null,
      }),
    );
    const malformed = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'playback' }),
      { PRO_ROOM_DEVELOPER_ROOMS: malformedRooms },
    );
    expect(malformed.status).toBe(503);
  });

  it('enforces playback state invariants and string queue identities', async () => {
    const base = {
      schemaVersion: 1,
      view: 'playback',
      roomCode: ROOM_CODE,
      revision: 1,
      playlistRevision: 1,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      observedAtMs: Date.now(),
      item: null,
    };
    for (const payload of [
      { ...base, state: 'idle', positionSeconds: 1 },
      {
        ...base,
        state: 'playing',
        queueItemId: null,
        item: null,
      },
      {
        ...base,
        state: 'paused',
        queueItemId: 1234567890123456,
        item: {
          queueItemId: 1234567890123456,
          kind: 'audio',
          name: 'Music',
          byteLength: 1,
        },
      },
    ]) {
      const rooms = namespace(() => Response.json(payload));
      const response = await facadeWorker.fetch(
        request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'playback' }),
        { PRO_ROOM_DEVELOPER_ROOMS: rooms },
      );
      expect(response.status).toBe(503);
    }
  });

  it('maps an unavailable or suspended room to the same private 404', async () => {
    const rooms = namespace(() => Response.json({ error: 'ROOM_NOT_FOUND' }, { status: 404 }));
    const response = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, keyId: KEY_ID, projection: 'room' }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'NOT_FOUND' });
  });
});
