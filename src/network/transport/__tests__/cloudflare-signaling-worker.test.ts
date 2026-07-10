import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type WorkerModule = {
  MusixquareRoom: new (
    state: FakeDurableObjectState,
    env?: Record<string, unknown>,
  ) => {
    fetch(request: Request): Promise<Response>;
    webSocketMessage(ws: FakeSocket, raw: string): Promise<void>;
    webSocketClose(ws: FakeSocket): Promise<void>;
    alarm(): Promise<void>;
  };
  default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
};

type RoomMeta = {
  v: 1;
  roomSecret: string | null;
  roomPassword: string;
  hostPeerId: string | null;
  hostReleaseAt: number;
};

const originalResponse = globalThis.Response;
const originalWebSocketPair = (globalThis as typeof globalThis & { WebSocketPair?: unknown })
  .WebSocketPair;
let workerModule: WorkerModule;
const GUEST_RECONNECT_SECRET = 'guest-reconnect-secret-00000000001';
const ATTACKER_RECONNECT_SECRET = 'attacker-reconnect-secret-000000001';

class FakeResponse {
  body: unknown;
  status: number;
  headers: unknown;
  webSocket?: FakeSocket;

  constructor(
    body: unknown,
    init: { status?: number; headers?: unknown; webSocket?: FakeSocket } = {},
  ) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers;
    this.webSocket = init.webSocket;
  }
}

class FakeSocket {
  accepted = false;
  closed = false;
  closeEvents: { code?: number; reason?: string }[] = [];
  sent: string[] = [];
  tags: string[] = [];
  private attachment: unknown = null;

  constructor(readonly side: 'client' | 'server' = 'server') {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeEvents.push({ code, reason });
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

class FakeWebSocketPair {
  static pairs: FakeWebSocketPair[] = [];

  client: FakeSocket;
  server: FakeSocket;

  constructor() {
    this.client = new FakeSocket('client');
    this.server = new FakeSocket('server');
    FakeWebSocketPair.pairs.push(this);
  }
}

class FakeStorage {
  data = new Map<string, unknown>();
  alarmTime: number | null = null;

  async get(key: string): Promise<unknown> {
    return structuredClone(this.data.get(key));
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async setAlarm(time: number): Promise<void> {
    this.alarmTime = time;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmTime = null;
  }
}

class FakeDurableObjectState {
  storage = new FakeStorage();
  sockets: FakeSocket[] = [];

  acceptWebSocket(ws: FakeSocket, tags: string[] = []): void {
    ws.accepted = true;
    ws.tags = tags;
    this.sockets.push(ws);
  }

  getWebSockets(): FakeSocket[] {
    return this.sockets.filter((ws) => !ws.closed);
  }
}

function installWorkerGlobals(): void {
  FakeWebSocketPair.pairs = [];
  Object.defineProperty(globalThis, 'Response', {
    configurable: true,
    value: FakeResponse,
  });
  Object.defineProperty(globalThis, 'WebSocketPair', {
    configurable: true,
    value: FakeWebSocketPair,
  });
}

function restoreWorkerGlobals(): void {
  Object.defineProperty(globalThis, 'Response', {
    configurable: true,
    value: originalResponse,
  });
  if (originalWebSocketPair === undefined) {
    delete (globalThis as typeof globalThis & { WebSocketPair?: unknown }).WebSocketPair;
  } else {
    Object.defineProperty(globalThis, 'WebSocketPair', {
      configurable: true,
      value: originalWebSocketPair,
    });
  }
}

function wsRequest(
  roomId: string,
  role: 'host' | 'guest',
  peerId: string,
  secret?: string,
): Request {
  const url = new URL(`https://signal.example.test/api/rooms/${roomId}/ws`);
  url.searchParams.set('role', role);
  url.searchParams.set('peerId', peerId);
  const connectionSecret = secret ?? (role === 'guest' ? GUEST_RECONNECT_SECRET : undefined);
  if (connectionSecret !== undefined) url.searchParams.set('secret', connectionSecret);

  return {
    url: url.toString(),
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'upgrade' ? 'websocket' : null;
      },
    },
  } as Request;
}

function requestLike(url: string, headers: Record<string, string> = {}): Request {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    url,
    headers: {
      get(name: string): string | null {
        return normalizedHeaders.get(name.toLowerCase()) ?? null;
      },
    },
  } as Request;
}

function workerEnv(): { env: Record<string, unknown>; idFromName: ReturnType<typeof vi.fn> } {
  const room = { fetch: vi.fn() };
  const idFromName = vi.fn(() => 'room-object-id');
  return {
    env: {
      MUSIXQUARE_ROOMS: {
        idFromName,
        get: vi.fn(() => room),
      },
    },
    idFromName,
  };
}

function lastServer(): FakeSocket {
  const pair = FakeWebSocketPair.pairs.at(-1);
  if (!pair) throw new Error('missing fake WebSocketPair');
  return pair.server;
}

function sent(ws: FakeSocket): unknown[] {
  return ws.sent.map((item) => JSON.parse(item));
}

function createMetricsEnv() {
  const events: Array<{ bucketMinute: number; event: string }> = [];
  return {
    events,
    env: {
      MUSIXQUARE_ADMIN_DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn((bucketMinute: number, event: string) => ({
            run: vi.fn(async () => {
              events.push({ bucketMinute, event });
            }),
          })),
        })),
      },
    },
  };
}

async function createHostRoom(): Promise<{
  room: InstanceType<WorkerModule['MusixquareRoom']>;
  state: FakeDurableObjectState;
  host: FakeSocket;
}> {
  const state = new FakeDurableObjectState();
  const room = new workerModule.MusixquareRoom(state);
  await room.fetch(wsRequest('123456', 'host', 'host-1', 'secret-a'));
  return { room, state, host: lastServer() };
}

async function createPasswordRoom(): Promise<{
  room: InstanceType<WorkerModule['MusixquareRoom']>;
  state: FakeDurableObjectState;
  host: FakeSocket;
}> {
  const setup = await createHostRoom();
  await setup.room.webSocketMessage(
    setup.host,
    JSON.stringify({ type: 'room-password-set', password: '12345678' }),
  );
  return setup;
}

beforeAll(async () => {
  workerModule = (await import('../../../../cloudflare/signaling-worker.js')) as WorkerModule;
});

beforeEach(() => {
  installWorkerGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  restoreWorkerGlobals();
});

afterAll(() => {
  restoreWorkerGlobals();
});

describe('Cloudflare signaling Worker hibernation behavior', () => {
  it('rejects non-WebSocket room requests before Durable Object lookup', async () => {
    const { env, idFromName } = workerEnv();
    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/rooms/123456/ws?role=guest&peerId=audit-probe'),
      env,
    );

    expect(response.status).toBe(426);
    expect(idFromName).not.toHaveBeenCalled();
  });

  it('rejects untrusted WebSocket origins before Durable Object lookup', async () => {
    const { env, idFromName } = workerEnv();
    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/rooms/123456/ws?role=guest&peerId=audit-probe', {
        Origin: 'https://evil.example',
        Upgrade: 'websocket',
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(idFromName).not.toHaveBeenCalled();
  });

  it('rejects malformed room peers before Durable Object lookup', async () => {
    const { env, idFromName } = workerEnv();
    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/rooms/123456/ws?role=guest&peerId=bad!peer', {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(idFromName).not.toHaveBeenCalled();
  });

  it('accepts a host with hibernation attachment and room metadata', async () => {
    const { state, host } = await createHostRoom();

    expect(host.accepted).toBe(true);
    expect(host.tags).toContain('role:host');
    expect(host.deserializeAttachment()).toEqual({
      v: 1,
      role: 'host',
      roomId: '123456',
      peerId: 'host-1',
      secret: 'secret-a',
      auth: 'ok',
    });
    expect(sent(host)[0]).toEqual({ type: 'peer-open', peerId: '123456', roomId: '123456' });
    expect(await state.storage.get('roomMeta')).toMatchObject({
      v: 1,
      roomSecret: 'secret-a',
      roomPassword: '',
      hostPeerId: 'host-1',
      hostReleaseAt: 0,
    });
  });

  it('accepts a guest with an active host', async () => {
    const { room } = await createHostRoom();

    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const guest = lastServer();

    expect(guest.deserializeAttachment()).toEqual({
      v: 1,
      role: 'guest',
      roomId: '123456',
      peerId: 'guest-1',
      secret: GUEST_RECONNECT_SECRET,
      auth: 'ok',
    });
    expect(sent(guest)[0]).toEqual({ type: 'peer-open', peerId: 'guest-1', roomId: '123456' });
  });

  it('requires a high-entropy reconnect secret for guest sockets', async () => {
    const { room } = await createHostRoom();
    const pairCount = FakeWebSocketPair.pairs.length;

    const missing = await room.fetch(wsRequest('123456', 'guest', 'guest-missing-secret', ''));
    const short = await room.fetch(wsRequest('123456', 'guest', 'guest-short-secret', 'short'));

    expect(missing.status).toBe(400);
    expect(short.status).toBe(400);
    expect(FakeWebSocketPair.pairs).toHaveLength(pairCount);
  });

  it('rejects a same-peer takeover with a different secret and keeps the owner socket', async () => {
    const { room, host } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'guest-owner', GUEST_RECONNECT_SECRET));
    const owner = lastServer();

    await room.fetch(wsRequest('123456', 'guest', 'guest-owner', ATTACKER_RECONNECT_SECRET));
    const attacker = lastServer();

    expect(attacker.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'GUEST_IDENTITY_MISMATCH',
    });
    expect(sent(attacker).at(-1)).toEqual({
      type: 'error',
      errorType: 'id-taken',
      message: 'GUEST_IDENTITY_MISMATCH',
    });
    expect(owner.closed).toBe(false);

    await room.webSocketMessage(
      owner,
      JSON.stringify({
        type: 'signal-offer',
        to: 'host',
        sdp: { type: 'offer', sdp: 'owner-still-routes' },
      }),
    );

    expect(sent(host).at(-1)).toEqual({
      type: 'signal-offer',
      from: 'guest-owner',
      sdp: { type: 'offer', sdp: 'owner-still-routes' },
    });
    const signalingPayloads = JSON.stringify([...sent(owner), ...sent(host)]);
    expect(signalingPayloads).not.toContain(GUEST_RECONNECT_SECRET);
    expect(signalingPayloads).not.toContain(ATTACKER_RECONNECT_SECRET);
  });

  it('records aggregate room and guest metrics when a D1 binding exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    const metrics = createMetricsEnv();
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, metrics.env);

    await room.fetch(wsRequest('123456', 'host', 'host-1', 'secret-a'));
    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));

    expect(metrics.events).toEqual([
      { bucketMinute: Math.floor(Date.now() / 60000), event: 'room_opened' },
      { bucketMinute: Math.floor(Date.now() / 60000), event: 'guest_joined' },
    ]);
  });

  it('preserves guest-to-host and host-to-guest signaling wire shapes', async () => {
    const { room, host } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const guest = lastServer();

    await room.webSocketMessage(
      guest,
      JSON.stringify({
        type: 'signal-offer',
        to: 'host',
        sdp: { type: 'offer', sdp: 'offer-sdp' },
        metadata: { label: 'data' },
      }),
    );
    await room.webSocketMessage(
      host,
      JSON.stringify({
        type: 'signal-answer',
        to: 'guest-1',
        sdp: { type: 'answer', sdp: 'answer-sdp' },
      }),
    );
    await room.webSocketMessage(
      host,
      JSON.stringify({
        type: 'media-offer',
        to: 'guest-1',
        callId: 'call-1',
        sdp: { type: 'offer', sdp: 'media-sdp' },
      }),
    );

    expect(sent(host).at(-1)).toEqual({
      type: 'signal-offer',
      from: 'guest-1',
      sdp: { type: 'offer', sdp: 'offer-sdp' },
      metadata: { label: 'data' },
    });
    expect(sent(guest).slice(-2)).toEqual([
      {
        type: 'signal-answer',
        from: 'host-1',
        sdp: { type: 'answer', sdp: 'answer-sdp' },
      },
      {
        type: 'media-offer',
        from: 'host-1',
        callId: 'call-1',
        sdp: { type: 'offer', sdp: 'media-sdp' },
      },
    ]);
  });

  it('closes a socket before relaying an oversized signaling frame', async () => {
    const { room, host } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const guest = lastServer();

    await room.webSocketMessage(guest, 'x'.repeat(64 * 1024 + 1));

    expect(guest.closed).toBe(true);
    expect(guest.closeEvents.at(-1)).toEqual({
      code: 1009,
      reason: 'SIGNALING_MESSAGE_TOO_LARGE',
    });
    expect(sent(guest).at(-1)).toEqual({
      type: 'error',
      errorType: 'message-too-large',
      message: 'SIGNALING_MESSAGE_TOO_LARGE',
    });
    expect(
      sent(host).some((message) => (message as { type?: string }).type === 'signal-offer'),
    ).toBe(false);
  });

  it('rejects signaling fields outside the role-specific schema and length bounds', async () => {
    const { room, host } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const guest = lastServer();

    await room.webSocketMessage(
      guest,
      JSON.stringify({
        type: 'signal-candidate',
        to: 'host',
        candidate: { candidate: 'c'.repeat(4097) },
      }),
    );

    expect(guest.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'INVALID_SIGNALING_MESSAGE',
    });
    expect(
      sent(host).some((message) => (message as { type?: string }).type === 'signal-candidate'),
    ).toBe(false);

    await room.fetch(wsRequest('123456', 'guest', 'guest-2'));
    const secondGuest = lastServer();
    await room.webSocketMessage(
      secondGuest,
      JSON.stringify({
        type: 'signal-offer',
        to: 'host',
        sdp: { type: 'offer', sdp: 'ok' },
        injected: true,
      }),
    );
    expect(secondGuest.closeEvents.at(-1)?.code).toBe(1008);
  });

  it('applies a token bucket independently to each signaling socket', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    const { room, host } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const guest = lastServer();

    for (let index = 0; index < 120; index += 1) {
      await room.webSocketMessage(
        guest,
        JSON.stringify({
          type: 'signal-candidate',
          to: 'host',
          candidate: { candidate: `candidate-${index}` },
        }),
      );
    }
    expect(
      sent(host).filter((message) => (message as { type?: string }).type === 'signal-candidate'),
    ).toHaveLength(120);

    await room.webSocketMessage(
      guest,
      JSON.stringify({
        type: 'signal-candidate',
        to: 'host',
        candidate: { candidate: 'candidate-over-limit' },
      }),
    );

    expect(guest.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'SIGNALING_RATE_LIMITED',
    });

    // A different socket gets its own full bucket.
    await room.fetch(wsRequest('123456', 'guest', 'guest-2'));
    const secondGuest = lastServer();
    await room.webSocketMessage(
      secondGuest,
      JSON.stringify({
        type: 'signal-candidate',
        to: 'host',
        candidate: { candidate: 'candidate-new-socket' },
      }),
    );
    expect(secondGuest.closed).toBe(false);
  });

  it('preserves guest rate debt across Durable Object hibernation rehydration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    const { room, state } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const guest = lastServer();

    for (let index = 0; index < 120; index += 1) {
      await room.webSocketMessage(
        guest,
        JSON.stringify({
          type: 'signal-candidate',
          to: 'host',
          candidate: { candidate: `candidate-${index}` },
        }),
      );
    }

    const rehydrated = new workerModule.MusixquareRoom(state);
    await rehydrated.webSocketMessage(
      guest,
      JSON.stringify({
        type: 'signal-candidate',
        to: 'host',
        candidate: { candidate: 'candidate-after-hibernation' },
      }),
    );

    expect(guest.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'SIGNALING_RATE_LIMITED',
    });
  });

  it('rate-limits one noisy host target without closing the shared host socket', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    const { room, host } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'guest-noisy'));
    const noisyGuest = lastServer();
    await room.fetch(wsRequest('123456', 'guest', 'guest-healthy'));
    const healthyGuest = lastServer();

    for (let index = 0; index < 120; index += 1) {
      await room.webSocketMessage(
        host,
        JSON.stringify({
          type: 'signal-candidate',
          to: 'guest-noisy',
          candidate: { candidate: `candidate-${index}` },
        }),
      );
    }
    await room.webSocketMessage(
      host,
      JSON.stringify({
        type: 'signal-candidate',
        to: 'guest-noisy',
        candidate: { candidate: 'candidate-over-target-limit' },
      }),
    );

    expect(host.closed).toBe(false);
    expect(noisyGuest.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'SIGNALING_PEER_RATE_LIMITED',
    });
    expect(healthyGuest.closed).toBe(false);
    expect(sent(host).at(-1)).toEqual({ type: 'peer-left', peerId: 'guest-noisy' });
  });

  it('keeps all 32 target buckets fair and never closes host at the aggregate cap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    const { room, host } = await createHostRoom();
    const guests: FakeSocket[] = [];
    for (let peer = 0; peer < 32; peer += 1) {
      await room.fetch(wsRequest('123456', 'guest', `guest-${peer}`));
      guests.push(lastServer());
    }

    // Every supported peer may consume its complete target bucket without one
    // shared host bucket turning a 32-way answer/ICE burst into host eviction.
    for (let round = 0; round < 120; round += 1) {
      for (let peer = 0; peer < 32; peer += 1) {
        await room.webSocketMessage(
          host,
          JSON.stringify({
            type: 'signal-candidate',
            to: `guest-${peer}`,
            candidate: { candidate: `candidate-${round}-${peer}` },
          }),
        );
      }
    }
    expect(host.closed).toBe(false);
    expect(guests.every((guest) => !guest.closed)).toBe(true);

    // The aggregate includes one independent host-control allowance.
    for (let index = 0; index < 120; index += 1) {
      await room.webSocketMessage(
        host,
        JSON.stringify({ type: 'room-password-set', password: index % 2 ? '12345678' : '' }),
      );
    }

    await room.webSocketMessage(
      host,
      JSON.stringify({
        type: 'signal-candidate',
        to: 'guest-0',
        candidate: { candidate: 'candidate-over-total-limit' },
      }),
    );

    expect(host.closed).toBe(false);
    expect(guests[0].closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'SIGNALING_PEER_RATE_LIMITED',
    });
    expect(guests.slice(1).every((guest) => !guest.closed)).toBe(true);
  });

  it('admits at most 32 unique accepted or password-pending guests', async () => {
    const { room, host } = await createHostRoom();
    const admitted: FakeSocket[] = [];
    for (let peer = 0; peer < 16; peer += 1) {
      await room.fetch(wsRequest('123456', 'guest', `accepted-${peer}`));
      admitted.push(lastServer());
    }
    await room.webSocketMessage(
      host,
      JSON.stringify({ type: 'room-password-set', password: '12345678' }),
    );
    for (let peer = 0; peer < 16; peer += 1) {
      await room.fetch(wsRequest('123456', 'guest', `pending-${peer}`));
      admitted.push(lastServer());
    }

    await room.fetch(wsRequest('123456', 'guest', 'guest-33'));
    const rejected = lastServer();

    expect(admitted.every((guest) => !guest.closed)).toBe(true);
    expect(rejected.accepted).toBe(true);
    expect(rejected.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'ROOM_GUEST_LIMIT_REACHED',
    });
    expect(sent(rejected).at(-1)).toEqual({
      type: 'error',
      errorType: 'room-full',
      message: 'ROOM_GUEST_LIMIT_REACHED',
    });
    expect(host.closed).toBe(false);
  });

  it('reserves password-pending capacity before concurrent metrics I/O yields', async () => {
    const metrics = createMetricsEnv();
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, metrics.env);
    await room.fetch(wsRequest('123456', 'host', 'host-1', 'secret-a'));
    const host = lastServer();
    await room.webSocketMessage(
      host,
      JSON.stringify({ type: 'room-password-set', password: '12345678' }),
    );
    const pairOffset = FakeWebSocketPair.pairs.length;

    await Promise.all(
      Array.from({ length: 33 }, (_, index) =>
        room.fetch(wsRequest('123456', 'guest', `concurrent-${index}`)),
      ),
    );

    const guests = FakeWebSocketPair.pairs.slice(pairOffset).map((pair) => pair.server);
    const rejected = guests.filter(
      (guest) => guest.closeEvents.at(-1)?.reason === 'ROOM_GUEST_LIMIT_REACHED',
    );
    expect(guests.filter((guest) => !guest.closed)).toHaveLength(32);
    expect(rejected).toHaveLength(1);
    expect(host.closed).toBe(false);
  });

  it('keeps password-protected guests pending until valid guest-auth', async () => {
    const { room } = await createPasswordRoom();

    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const guest = lastServer();

    expect(sent(guest)).toEqual([]);
    expect(guest.deserializeAttachment()).toMatchObject({
      v: 1,
      role: 'guest',
      roomId: '123456',
      peerId: 'guest-1',
      secret: GUEST_RECONNECT_SECRET,
      auth: 'pending',
    });

    await room.webSocketMessage(
      guest,
      JSON.stringify({ type: 'guest-auth', password: '12345678' }),
    );

    expect(guest.deserializeAttachment()).toEqual({
      v: 1,
      role: 'guest',
      roomId: '123456',
      peerId: 'guest-1',
      secret: GUEST_RECONNECT_SECRET,
      auth: 'ok',
    });
    expect(sent(guest)[0]).toEqual({ type: 'peer-open', peerId: 'guest-1', roomId: '123456' });
  });

  it('ignores auth from a replaced pending socket with the same peer identity', async () => {
    const { room } = await createPasswordRoom();

    await room.fetch(wsRequest('123456', 'guest', 'guest-replace'));
    const stale = lastServer();
    await room.fetch(wsRequest('123456', 'guest', 'guest-replace'));
    const current = lastServer();

    expect(stale.closeEvents.at(-1)).toEqual({ code: 1012, reason: 'GUEST_REPLACED' });
    await room.webSocketMessage(
      stale,
      JSON.stringify({ type: 'guest-auth', password: '12345678' }),
    );
    expect(sent(stale)).toEqual([]);
    expect(current.closed).toBe(false);
    expect(sent(current)).toEqual([]);

    await room.webSocketMessage(
      current,
      JSON.stringify({ type: 'guest-auth', password: '12345678' }),
    );
    expect(sent(current)[0]).toEqual({
      type: 'peer-open',
      peerId: 'guest-replace',
      roomId: '123456',
    });
  });

  it('returns existing password auth errors for missing, invalid, and expired auth', async () => {
    const { room } = await createPasswordRoom();

    await room.fetch(wsRequest('123456', 'guest', 'missing'));
    const missing = lastServer();
    await room.webSocketMessage(missing, JSON.stringify({ type: 'guest-auth', password: '' }));

    await room.fetch(wsRequest('123456', 'guest', 'invalid'));
    const invalid = lastServer();
    await room.webSocketMessage(invalid, JSON.stringify({ type: 'guest-auth', password: 'bad' }));

    await room.fetch(wsRequest('123456', 'guest', 'expired'));
    const expired = lastServer();
    expired.serializeAttachment({
      ...(expired.deserializeAttachment() as Record<string, unknown>),
      authDeadline: Date.now() - 1,
    });
    await room.webSocketMessage(
      expired,
      JSON.stringify({ type: 'guest-auth', password: '12345678' }),
    );

    expect(sent(missing).at(-1)).toEqual({
      type: 'error',
      errorType: 'room-password-required',
      message: 'ROOM_PASSWORD_REQUIRED',
    });
    expect(sent(invalid).at(-1)).toEqual({
      type: 'error',
      errorType: 'room-password-invalid',
      message: 'ROOM_PASSWORD_INVALID',
    });
    expect(sent(expired).at(-1)).toEqual({
      type: 'error',
      errorType: 'room-password-auth-timeout',
      message: 'ROOM_PASSWORD_AUTH_TIMEOUT',
    });
  });

  it('sweeps an expired pending guest via the DO alarm with no further messages', async () => {
    const { room } = await createPasswordRoom();

    await room.fetch(wsRequest('123456', 'guest', 'silent-guest'));
    const guest = lastServer();

    // Guest connected but never sent guest-auth. Force its deadline past, as if
    // GUEST_AUTH_TIMEOUT_MS elapsed with zero traffic — the case that previously
    // left the socket OPEN until something else happened to wake the DO.
    guest.serializeAttachment({
      ...(guest.deserializeAttachment() as Record<string, unknown>),
      authDeadline: Date.now() - 1,
    });

    // The DO alarm fires on its own; the guest sends nothing.
    await room.alarm();

    expect(guest.closed).toBe(true);
    expect(guest.closeEvents.at(-1)).toMatchObject({ reason: 'auth timeout (sweep)' });
  });

  it('rehydrates host and guest indexes from WebSocket attachments', async () => {
    const state = new FakeDurableObjectState();
    const host = new FakeSocket();
    const guest = new FakeSocket();
    host.serializeAttachment({
      v: 1,
      role: 'host',
      roomId: '123456',
      peerId: 'host-1',
      secret: 'secret-a',
      auth: 'ok',
    });
    guest.serializeAttachment({
      v: 1,
      role: 'guest',
      roomId: '123456',
      peerId: 'guest-1',
      secret: GUEST_RECONNECT_SECRET,
      auth: 'ok',
    });
    state.sockets.push(host, guest);
    await state.storage.put('roomMeta', {
      v: 1,
      roomSecret: 'secret-a',
      roomPassword: '',
      hostPeerId: 'host-1',
      hostReleaseAt: 0,
    } satisfies RoomMeta);

    const room = new workerModule.MusixquareRoom(state);
    await room.webSocketMessage(
      guest,
      JSON.stringify({ type: 'signal-offer', to: 'host', sdp: { type: 'offer', sdp: 'x' } }),
    );

    expect(sent(host).at(-1)).toEqual({
      type: 'signal-offer',
      from: 'guest-1',
      sdp: { type: 'offer', sdp: 'x' },
    });
  });

  it('stores host release deadline and lazily allows different-secret reclaim after grace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:00:00.000Z'));
    const { room, state, host } = await createHostRoom();

    await room.webSocketClose(host);
    const releasedMeta = (await state.storage.get('roomMeta')) as RoomMeta;
    expect(releasedMeta).toMatchObject({
      roomSecret: 'secret-a',
      hostPeerId: null,
      hostReleaseAt: Date.now() + 60_000,
    });

    await room.fetch(wsRequest('123456', 'host', 'host-2', 'secret-b'));
    const rejected = lastServer();
    expect(sent(rejected).at(-1)).toEqual({
      type: 'error',
      errorType: 'id-taken',
      message: 'ROOM_ALREADY_ACTIVE',
    });

    vi.setSystemTime(new Date('2026-05-16T00:01:01.000Z'));
    await room.fetch(wsRequest('123456', 'host', 'host-3', 'secret-b'));
    const reclaimed = lastServer();
    expect(sent(reclaimed).at(-1)).toEqual({
      type: 'peer-open',
      peerId: '123456',
      roomId: '123456',
    });
    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'secret-b',
      hostPeerId: 'host-3',
      hostReleaseAt: 0,
    });
  });

  it('does not use non-hibernatable WebSocket or timer APIs', async () => {
    const source = await readFile(resolve(process.cwd(), 'cloudflare/signaling-worker.js'), 'utf8');

    expect(source).not.toContain('server.accept(');
    expect(source).not.toContain('addEventListener(');
    expect(source).not.toContain('setTimeout(');
    expect(source).toContain('acceptWebSocket(');
  });
});
