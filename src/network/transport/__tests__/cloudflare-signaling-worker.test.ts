import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type WorkerModule = {
  MusixquareRoom: new (state: FakeDurableObjectState) => {
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

    expect(guest.deserializeAttachment()).toEqual({
      v: 1,
      role: 'guest',
      roomId: '123456',
      peerId: 'guest-1',
      auth: 'ok',
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
