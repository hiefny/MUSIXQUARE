import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type WorkerModule = {
  MusixquareRoom: new (
    state: FakeDurableObjectState,
    env?: Record<string, unknown>,
  ) => {
    fetch(request: Request): Promise<Response>;
    webSocketMessage(ws: FakeSocket, raw: unknown): Promise<void>;
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
  if (secret !== undefined) url.searchParams.set('secret', secret);

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
      auth: 'ok',
    });
    expect(sent(guest)[0]).toEqual({ type: 'peer-open', peerId: 'guest-1', roomId: '123456' });
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

  it('allows forward-compatible extra fields and ignores one unknown or malformed message', async () => {
    const { room, host } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const guest = lastServer();
    const hostMessagesBefore = host.sent.length;

    await room.webSocketMessage(
      guest,
      JSON.stringify({ type: 'future-client-hint', to: 'host', enabled: true }),
    );
    await room.webSocketMessage(
      guest,
      JSON.stringify({ type: 'signal-candidate', to: 'host', candidate: { sdpMid: '0' } }),
    );
    await room.webSocketMessage(
      guest,
      JSON.stringify({
        type: 'signal-offer',
        to: 'host',
        sdp: { type: 'answer', sdp: 'wrong-required-type' },
      }),
    );

    expect(guest.closed).toBe(false);
    expect(host.sent).toHaveLength(hostMessagesBefore);

    await room.webSocketMessage(
      guest,
      JSON.stringify({
        type: 'signal-offer',
        to: 'host',
        sdp: { type: 'offer', sdp: 'offer-sdp', futureSdpField: true },
        metadata: { label: 'data' },
        futureMessageField: 'preserved',
      }),
    );

    expect(guest.closed).toBe(false);
    expect(sent(host).at(-1)).toEqual({
      type: 'signal-offer',
      from: 'guest-1',
      sdp: { type: 'offer', sdp: 'offer-sdp', futureSdpField: true },
      metadata: { label: 'data' },
      futureMessageField: 'preserved',
    });

    await room.webSocketMessage(
      host,
      JSON.stringify({
        type: 'signal-answer',
        to: 'guest-1',
        sdp: { type: 'answer', sdp: 'answer-sdp', futureSdpField: true },
        futureMessageField: 'preserved',
      }),
    );
    expect(sent(guest).at(-1)).toEqual({
      type: 'signal-answer',
      from: 'host-1',
      sdp: { type: 'answer', sdp: 'answer-sdp', futureSdpField: true },
      futureMessageField: 'preserved',
    });
  });

  it('closes an oversized UTF-8 WebSocket frame with an explicit policy code', async () => {
    const { room } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const guest = lastServer();

    await room.webSocketMessage(
      guest,
      // Fewer than 64 Ki JavaScript code units, but more than 64 Ki on wire.
      JSON.stringify({ type: 'future-message', padding: '가'.repeat(22 * 1024) }),
    );

    expect(sent(guest).at(-1)).toEqual({
      type: 'error',
      errorType: 'message-too-large',
      message: 'SIGNALING_MESSAGE_TOO_LARGE',
    });
    expect(guest.closeEvents.at(-1)).toEqual({
      code: 1009,
      reason: 'SIGNALING_MESSAGE_TOO_LARGE',
    });
  });

  it.each([
    {
      label: 'SDP',
      message: {
        type: 'signal-offer',
        to: 'host',
        sdp: { type: 'offer', sdp: 's'.repeat(48 * 1024 + 1) },
      },
    },
    {
      label: 'ICE candidate',
      message: {
        type: 'signal-candidate',
        to: 'host',
        candidate: { candidate: 'c'.repeat(4 * 1024 + 1) },
      },
    },
    {
      label: 'ICE candidate metadata',
      message: {
        type: 'signal-candidate',
        to: 'host',
        candidate: { candidate: 'candidate:1', sdpMid: 'm'.repeat(4 * 1024) },
      },
    },
  ])('closes an oversized $label payload instead of relaying it', async ({ message }) => {
    const { room, host } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const guest = lastServer();

    await room.webSocketMessage(guest, JSON.stringify(message));

    expect(
      sent(host).some(
        (relayed) => (relayed as { type?: string }).type === (message as { type: string }).type,
      ),
    ).toBe(false);
    expect(guest.closeEvents.at(-1)?.code).toBe(1009);
    expect(sent(guest).at(-1)).toMatchObject({
      type: 'error',
      errorType: 'message-too-large',
    });
  });

  it('rate-limits one abusive guest without closing the host or another guest', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
    const { room, host } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'noisy'));
    const noisy = lastServer();
    await room.fetch(wsRequest('123456', 'guest', 'healthy'));
    const healthy = lastServer();

    for (let index = 0; index < 120; index++) {
      await room.webSocketMessage(
        noisy,
        JSON.stringify({
          type: 'signal-candidate',
          to: 'host',
          candidate: { candidate: `candidate-${index}` },
        }),
      );
    }
    vi.advanceTimersByTime(500);
    await room.webSocketMessage(
      noisy,
      JSON.stringify({
        type: 'signal-candidate',
        to: 'host',
        candidate: { candidate: 'candidate-after-refill' },
      }),
    );
    expect(noisy.closed).toBe(false);

    await room.webSocketMessage(
      noisy,
      JSON.stringify({
        type: 'signal-candidate',
        to: 'host',
        candidate: { candidate: 'candidate-over-limit' },
      }),
    );

    expect(noisy.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'SIGNALING_RATE_LIMITED',
    });
    expect(host.closed).toBe(false);
    expect(healthy.closed).toBe(false);

    await room.webSocketMessage(
      healthy,
      JSON.stringify({
        type: 'signal-candidate',
        to: 'host',
        candidate: { candidate: 'healthy-candidate' },
      }),
    );
    expect(sent(host).at(-1)).toMatchObject({
      type: 'signal-candidate',
      from: 'healthy',
      candidate: { candidate: 'healthy-candidate' },
    });
  });

  it('preserves a depleted guest message bucket across DO hibernation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
    const { room, state } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'noisy'));
    const noisy = lastServer();
    const ignoredFrame = JSON.stringify({ type: 'future-client-hint', to: 'host' });

    for (let index = 0; index < 120; index++) {
      await room.webSocketMessage(noisy, ignoredFrame);
    }

    const rehydratedRoom = new workerModule.MusixquareRoom(state);
    await rehydratedRoom.webSocketMessage(noisy, ignoredFrame);

    expect(noisy.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'SIGNALING_RATE_LIMITED',
    });
  });

  it('carries a guest message bucket onto a same-peer replacement socket', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
    const { room } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'noisy'));
    const firstSocket = lastServer();
    const ignoredFrame = JSON.stringify({ type: 'future-client-hint', to: 'host' });

    for (let index = 0; index < 120; index++) {
      await room.webSocketMessage(firstSocket, ignoredFrame);
    }
    await room.fetch(wsRequest('123456', 'guest', 'noisy'));
    const replacement = lastServer();
    await room.webSocketMessage(replacement, ignoredFrame);

    expect(firstSocket.closeEvents.at(-1)?.reason).toBe('GUEST_REPLACED');
    expect(replacement.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'SIGNALING_RATE_LIMITED',
    });
  });

  it('admits at most 32 unique accepted or password-pending guests', async () => {
    const { room, host } = await createHostRoom();

    for (let index = 0; index < 16; index++) {
      await room.fetch(wsRequest('123456', 'guest', `guest-${index}`));
      expect(lastServer().closed).toBe(false);
    }
    await room.webSocketMessage(
      host,
      JSON.stringify({ type: 'room-password-set', password: '12345678' }),
    );
    for (let index = 16; index < 32; index++) {
      await room.fetch(wsRequest('123456', 'guest', `guest-${index}`));
      expect(lastServer().closed).toBe(false);
    }

    await room.fetch(wsRequest('123456', 'guest', 'guest-over-limit'));
    const rejected = lastServer();

    expect(sent(rejected).at(-1)).toEqual({
      type: 'error',
      errorType: 'room-full',
      message: 'ROOM_GUEST_LIMIT_REACHED',
    });
    expect(rejected.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'ROOM_GUEST_LIMIT_REACHED',
    });
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
      auth: 'pending',
    });

    await room.webSocketMessage(
      guest,
      JSON.stringify({ type: 'guest-auth', password: '12345678' }),
    );

    expect(guest.deserializeAttachment()).toMatchObject({
      v: 1,
      role: 'guest',
      roomId: '123456',
      peerId: 'guest-1',
      auth: 'ok',
      guestMessageTokens: 119,
      guestMessageUpdatedAt: expect.any(Number),
    });
    expect(sent(guest)[0]).toEqual({ type: 'peer-open', peerId: 'guest-1', roomId: '123456' });
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

    // Expire a silent guest without delivering another message; the alarm must
    // enforce the authentication deadline independently of socket traffic.
    guest.serializeAttachment({
      ...(guest.deserializeAttachment() as Record<string, unknown>),
      authDeadline: Date.now() - 1,
    });

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
