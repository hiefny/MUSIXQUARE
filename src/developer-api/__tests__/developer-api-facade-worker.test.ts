import { describe, expect, it, vi } from 'vitest';
import facadeWorker from '../../../cloudflare/developer-api-facade-worker.js';

const ROOM_CODE = '000001';
const KEY_ID = 'A'.repeat(16);
const COMMAND_ID = `cmd_${'C'.repeat(22)}`;
const IDEMPOTENCY_KEY = 'request.command-0001';
const QUEUE_ITEM_ID = '123e4567-e89b-42d3-a456-426614174000';

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
  it('forwards one fixed projection intent without caller credentials or paths', async () => {
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
      request({ roomCode: ROOM_CODE, projection: 'room' }),
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
    await expect(forwarded.json()).resolves.toEqual({ projection: 'room' });
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
      request({ roomCode: ROOM_CODE, projection: 'queue' }),
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
      request({ roomCode: ROOM_CODE, projection: 'queue' }),
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
      request({ roomCode: ROOM_CODE, projection: 'room', path: '/internal/admin/provision' }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(extraField.status).toBe(400);

    const wrongProjection = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, projection: 'admin' }),
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
        request({ roomCode: ROOM_CODE, projection: 'room' }, { headers }),
        { PRO_ROOM_DEVELOPER_ROOMS: rooms },
      );
      expect(response.status).toBe(404);
    }
    expect(rooms.get).not.toHaveBeenCalled();
  });

  it('fails closed on missing bindings, backend failures, and malformed projections', async () => {
    const missing = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, projection: 'room' }),
      {},
    );
    expect(missing.status).toBe(503);

    const unavailableRooms = namespace(() =>
      Response.json({ error: 'ROOM_STATE_INVALID' }, { status: 503 }),
    );
    const unavailable = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, projection: 'room' }),
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
      request({ roomCode: ROOM_CODE, projection: 'playback' }),
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
        request({ roomCode: ROOM_CODE, projection: 'playback' }),
        { PRO_ROOM_DEVELOPER_ROOMS: rooms },
      );
      expect(response.status).toBe(503);
    }
  });

  it('maps an unavailable or suspended room to the same private 404', async () => {
    const rooms = namespace(() => Response.json({ error: 'ROOM_NOT_FOUND' }, { status: 404 }));
    const response = await facadeWorker.fetch(
      request({ roomCode: ROOM_CODE, projection: 'room' }),
      { PRO_ROOM_DEVELOPER_ROOMS: rooms },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'NOT_FOUND' });
  });
});
