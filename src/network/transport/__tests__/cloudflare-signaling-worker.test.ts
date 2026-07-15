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

type ProTicketPayload = {
  v: 1;
  kind: 'pro-signaling';
  roomCode: string;
  participantId: string;
  role: 'coordinator' | 'member';
  coordinatorEpoch: number;
  presenceIncarnationId: string;
  ticketSequence: number;
  jti: string;
  iat: number;
  exp: number;
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
  waitUntilTasks: Promise<unknown>[] = [];

  acceptWebSocket(ws: FakeSocket, tags: string[] = []): void {
    ws.accepted = true;
    ws.tags = tags;
    this.sockets.push(ws);
  }

  getWebSockets(): FakeSocket[] {
    return this.sockets.filter((ws) => !ws.closed);
  }

  waitUntil(task: Promise<unknown>): void {
    this.waitUntilTasks.push(Promise.resolve(task));
  }

  async flushWaitUntil(): Promise<void> {
    while (this.waitUntilTasks.length > 0) {
      const tasks = this.waitUntilTasks.splice(0);
      await Promise.all(tasks);
    }
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

const PRO_SIGNALING_SECRET = 'pro-signaling-test-secret-with-at-least-32-bytes';

function base64Url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function proTicket(
  overrides: Partial<ProTicketPayload> = {},
  secret = PRO_SIGNALING_SECRET,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: ProTicketPayload = {
    v: 1,
    kind: 'pro-signaling',
    roomCode: '000001',
    participantId: 'pro-member-1',
    role: 'member',
    coordinatorEpoch: 1,
    presenceIncarnationId: 'presence-incarnation-0001',
    ticketSequence: 1,
    jti: 'ticket-identifier-0001',
    iat: now - 1,
    exp: now + 60,
    ...overrides,
  };
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload)),
  );
  return `${encodedPayload}.${base64Url(signature)}`;
}

async function proWsRequest(
  overrides: Partial<ProTicketPayload> = {},
  query: Record<string, string> = {},
): Promise<Request> {
  const ticket = await proTicket(overrides);
  const roomCode = overrides.roomCode ?? '000001';
  const url = new URL(`https://signal.example.test/api/pro-rooms/${roomCode}/ws`);
  url.searchParams.set('ticket', ticket);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return requestLike(url.toString(), { Upgrade: 'websocket' });
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

function workerEnv(): {
  env: Record<string, unknown>;
  idFromName: ReturnType<typeof vi.fn>;
  roomFetch: ReturnType<typeof vi.fn>;
} {
  const roomFetch = vi.fn(async () => new Response(null, { status: 101 }));
  const room = { fetch: roomFetch };
  const idFromName = vi.fn(() => 'room-object-id');
  return {
    env: {
      MUSIXQUARE_ROOMS: {
        idFromName,
        get: vi.fn(() => room),
      },
    },
    idFromName,
    roomFetch,
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

const DEFAULT_RECONNECT_SECRET = 's'.repeat(43);
const OTHER_RECONNECT_SECRET = 'x'.repeat(43);
const RECENT_RECONNECT_SECRET = 'r'.repeat(43);

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

async function joinGuest(
  room: InstanceType<WorkerModule['MusixquareRoom']>,
  peerId: string,
  options: { password?: string; reconnectSecret?: string | null } = {},
): Promise<FakeSocket> {
  await room.fetch(wsRequest('123456', 'guest', peerId));
  const guest = lastServer();
  const reconnectSecret =
    options.reconnectSecret === undefined ? DEFAULT_RECONNECT_SECRET : options.reconnectSecret;
  await room.webSocketMessage(
    guest,
    JSON.stringify({
      type: 'guest-auth',
      password: options.password ?? '',
      ...(reconnectSecret ? { reconnectSecret } : {}),
    }),
  );
  return guest;
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

  it.each([
    ['000000', 'host', 'secret-a'],
    ['000000', 'guest', undefined],
    ['000001', 'host', 'secret-a'],
    ['000001', 'guest', undefined],
    ['000002', 'host', 'secret-a'],
    ['000002', 'guest', undefined],
  ] as const)(
    'rejects reserved room %s %s claims before Durable Object lookup',
    async (roomId, role, secret) => {
      const { env, idFromName, roomFetch } = workerEnv();
      const url = new URL(`https://signal.example.test/api/rooms/${roomId}/ws`);
      url.searchParams.set('role', role);
      url.searchParams.set('peerId', `${role}-peer`);
      if (secret) url.searchParams.set('secret', secret);

      const response = await workerModule.default.fetch(
        requestLike(url.toString(), {
          Origin: 'https://musixquare.com',
          Upgrade: 'websocket',
        }),
        env,
      );

      expect(response.status).toBe(403);
      expect(idFromName).not.toHaveBeenCalled();
      expect(roomFetch).not.toHaveBeenCalled();
      expect(FakeWebSocketPair.pairs).toHaveLength(0);
    },
  );

  it.each([
    ['100000', 'host', 'secret-a'],
    ['100000', 'guest', undefined],
    ['999999', 'host', 'secret-a'],
    ['999999', 'guest', undefined],
  ] as const)(
    'keeps ordinary room %s %s routing to its Durable Object',
    async (roomId, role, secret) => {
      const { env, idFromName, roomFetch } = workerEnv();
      const url = new URL(`https://signal.example.test/api/rooms/${roomId}/ws`);
      url.searchParams.set('role', role);
      url.searchParams.set('peerId', `${role}-${roomId}`);
      if (secret) url.searchParams.set('secret', secret);
      const response = await workerModule.default.fetch(
        requestLike(url.toString(), {
          Origin: 'https://musixquare.com',
          Upgrade: 'websocket',
        }),
        env,
      );

      expect(response.status).toBe(101);
      expect(idFromName).toHaveBeenCalledWith(roomId);
      expect(roomFetch).toHaveBeenCalledTimes(1);
    },
  );

  it('does not let a provisioning allowlist seize an ordinary room code', async () => {
    const { env, idFromName, roomFetch } = workerEnv();
    env.PRO_PROVISIONED_ROOM_CODES = '000000, 000001 234567';

    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/rooms/234567/ws?role=guest&peerId=guest-peer', {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
      }),
      env,
    );

    expect(response.status).toBe(101);
    expect(idFromName).toHaveBeenCalledWith('234567');
    expect(roomFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an unprovisioned future PRO room before ticket parsing or Durable Object lookup', async () => {
    const { env, idFromName, roomFetch } = workerEnv();
    env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/pro-rooms/000002/ws?ticket=not-a-ticket', {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
      }),
      env,
    );

    expect(response.status).toBe(404);
    expect(idFromName).not.toHaveBeenCalled();
    expect(roomFetch).not.toHaveBeenCalled();
  });

  it('defends reserved codes inside the Durable Object before WebSocket acceptance', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state);

    const response = await room.fetch(wsRequest('000000', 'host', 'host-1', 'secret-a'));

    expect(response.status).toBe(403);
    expect(state.sockets).toHaveLength(0);
    expect(FakeWebSocketPair.pairs).toHaveLength(0);
  });

  it('routes a valid signed PRO ticket without trusting unsigned role query fields', async () => {
    const { env, idFromName, roomFetch } = workerEnv();
    env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const ticket = await proTicket({ role: 'member', participantId: 'signed-member' });
    const url = new URL('https://signal.example.test/api/pro-rooms/000001/ws');
    url.searchParams.set('ticket', ticket);
    url.searchParams.set('role', 'host');
    url.searchParams.set('peerId', 'unsigned-attacker-id');

    const response = await workerModule.default.fetch(
      requestLike(url.toString(), {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
      }),
      env,
    );

    expect(response.status).toBe(101);
    expect(idFromName).toHaveBeenCalledWith('000001');
    expect(roomFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong signature', async () => proTicket({}, 'wrong-signing-secret')],
    [
      'expired ticket',
      async () => {
        const now = Math.floor(Date.now() / 1000);
        return proTicket({ iat: now - 120, exp: now - 60 });
      },
    ],
    ['room mismatch', async () => proTicket({ roomCode: '000000' })],
  ] as const)('rejects a PRO %s before Durable Object lookup', async (_label, makeTicket) => {
    const { env, idFromName, roomFetch } = workerEnv();
    env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const ticket = await makeTicket();
    const url = new URL('https://signal.example.test/api/pro-rooms/000001/ws');
    url.searchParams.set('ticket', ticket);

    const response = await workerModule.default.fetch(
      requestLike(url.toString(), {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(idFromName).not.toHaveBeenCalled();
    expect(roomFetch).not.toHaveBeenCalled();
  });

  it('re-verifies a PRO ticket inside the Durable Object boundary', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const ticket = await proTicket(
      {
        role: 'coordinator',
        participantId: 'coordinator-device',
        jti: 'coordinator-ticket-0001',
      },
      'wrong-signing-secret',
    );
    const url = new URL('https://signal.example.test/api/pro-rooms/000001/ws');
    url.searchParams.set('ticket', ticket);

    const response = await room.fetch(
      requestLike(url.toString(), {
        Upgrade: 'websocket',
      }),
    );

    expect(response.status).toBe(401);
    expect(state.sockets).toHaveLength(0);
    expect(FakeWebSocketPair.pairs).toHaveLength(0);
  });

  it('admits PRO coordinator/member sockets directly with signed identity and epoch attachments', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      PRO_SIGNALING_SECRET,
    });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'coordinator-device',
        jti: 'coordinator-ticket-0001',
      }),
    );
    const coordinator = lastServer();
    await room.fetch(
      await proWsRequest(
        { role: 'member', participantId: 'signed-member', jti: 'member-ticket-0000001' },
        { role: 'host', peerId: 'unsigned-attacker-id' },
      ),
    );
    const member = lastServer();

    expect(coordinator.deserializeAttachment()).toMatchObject({
      roomKind: 'pro',
      role: 'host',
      roomId: '000001',
      peerId: '000001',
      participantId: 'coordinator-device',
      coordinatorEpoch: 1,
    });
    expect(member.deserializeAttachment()).toMatchObject({
      roomKind: 'pro',
      role: 'guest',
      peerId: 'signed-member',
      participantId: 'signed-member',
      coordinatorEpoch: 1,
      auth: 'ok',
    });
    expect(sent(member)[0]).toMatchObject({
      type: 'peer-open',
      peerId: 'signed-member',
      roomId: '000001',
    });
    expect(await state.storage.get('proRoomMeta')).toMatchObject({
      kind: 'pro',
      roomId: '000001',
      coordinatorEpoch: 1,
      coordinatorParticipantId: 'coordinator-device',
    });
  });

  it('advancing a PRO coordinator epoch closes every prior-epoch socket and rejects stale tickets', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'coordinator-one',
        jti: 'coordinator-ticket-0001',
      }),
    );
    const oldCoordinator = lastServer();
    await room.fetch(
      await proWsRequest({
        role: 'member',
        participantId: 'member-one',
        jti: 'member-ticket-0000001',
      }),
    );
    const oldMember = lastServer();

    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'coordinator-two',
        coordinatorEpoch: 2,
        jti: 'coordinator-ticket-0002',
      }),
    );
    const newCoordinator = lastServer();

    expect(oldCoordinator.closeEvents.at(-1)?.reason).toBe('PRO_COORDINATOR_EPOCH_ADVANCED');
    expect(oldMember.closeEvents.at(-1)?.reason).toBe('PRO_COORDINATOR_EPOCH_ADVANCED');
    expect(newCoordinator.closed).toBe(false);

    await room.fetch(
      await proWsRequest({
        role: 'member',
        participantId: 'stale-member',
        jti: 'stale-member-ticket01',
      }),
    );
    const staleMember = lastServer();
    expect(staleMember.closed).toBe(true);
    expect(sent(staleMember)[0]).toMatchObject({ message: 'PRO_COORDINATOR_EPOCH_STALE' });
  });

  it('reconnects the same coordinator after a PIN security epoch and closes revoked members', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'pin-owner',
        presenceIncarnationId: 'pin-owner-incarnation01',
        ticketSequence: 1,
        jti: 'pin-owner-old-ticket-01',
      }),
    );
    const oldOwner = lastServer();
    await room.fetch(
      await proWsRequest({
        role: 'member',
        participantId: 'pin-revoked-member',
        presenceIncarnationId: 'pin-member-incarnation1',
        ticketSequence: 1,
        jti: 'pin-member-old-ticket01',
      }),
    );
    const revokedMember = lastServer();

    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'pin-owner',
        coordinatorEpoch: 2,
        presenceIncarnationId: 'pin-owner-incarnation01',
        ticketSequence: 2,
        jti: 'pin-owner-new-ticket-02',
      }),
    );
    const reconnectedOwner = lastServer();

    expect(oldOwner.closeEvents.at(-1)?.reason).toBe('PRO_COORDINATOR_EPOCH_ADVANCED');
    expect(revokedMember.closeEvents.at(-1)?.reason).toBe('PRO_COORDINATOR_EPOCH_ADVANCED');
    expect(reconnectedOwner.closed).toBe(false);
    expect(reconnectedOwner.deserializeAttachment()).toMatchObject({
      participantId: 'pin-owner',
      coordinatorEpoch: 2,
      ticketSequence: 2,
    });

    await room.fetch(
      await proWsRequest({
        role: 'member',
        participantId: 'pin-revoked-member',
        presenceIncarnationId: 'pin-member-incarnation1',
        ticketSequence: 2,
        coordinatorEpoch: 1,
        jti: 'pin-member-stale-ticket2',
      }),
    );
    const staleMember = lastServer();
    expect(staleMember.closed).toBe(true);
    expect(sent(staleMember)[0]).toMatchObject({ message: 'PRO_COORDINATOR_EPOCH_STALE' });
    expect(reconnectedOwner.closed).toBe(false);
  });

  it('rejects a replayed member ticket without replacing the live participant', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'coordinator-one',
        jti: 'coordinator-ticket-0001',
      }),
    );
    const memberRequest = await proWsRequest({
      role: 'member',
      participantId: 'same-member',
      jti: 'replayed-member-ticket',
    });
    await room.fetch(memberRequest);
    const first = lastServer();
    const rehydratedRoom = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await rehydratedRoom.fetch(memberRequest);
    const replay = lastServer();

    expect(first.closed).toBe(false);
    expect(replay.closed).toBe(true);
    expect(sent(replay)[0]).toMatchObject({ message: 'PRO_SIGNALING_TICKET_REPLAYED' });
    expect(
      state.sockets.filter(
        (socket) =>
          !socket.closed &&
          (socket.deserializeAttachment() as { participantId?: string } | null)?.participantId ===
            'same-member',
      ),
    ).toHaveLength(1);
  });

  it('accepts a fresh member ticket for a legitimate reconnect after rejecting a replay', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'coordinator-one',
        jti: 'coordinator-ticket-0001',
      }),
    );
    const firstRequest = await proWsRequest({
      role: 'member',
      participantId: 'same-member',
      jti: 'first-member-ticket-0001',
    });
    await room.fetch(firstRequest);
    const first = lastServer();
    await room.fetch(firstRequest);
    expect(lastServer().closed).toBe(true);

    await room.fetch(
      await proWsRequest({
        role: 'member',
        participantId: 'same-member',
        jti: 'fresh-member-ticket-0002',
        ticketSequence: 2,
      }),
    );
    const reconnect = lastServer();

    expect(first.closeEvents.at(-1)?.reason).toBe('GUEST_REPLACED');
    expect(reconnect.closed).toBe(false);
    expect(sent(reconnect)[0]).toMatchObject({ type: 'peer-open', peerId: 'same-member' });
  });

  it('never lets a delayed lower-sequence member ticket reverse-replace a newer socket', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'coordinator-one',
        jti: 'coordinator-high-water',
      }),
    );
    const delayed = await proWsRequest({
      role: 'member',
      participantId: 'sequenced-member',
      presenceIncarnationId: 'presence-incarnation-old1',
      ticketSequence: 1,
      jti: 'delayed-member-ticket-01',
    });
    await room.fetch(
      await proWsRequest({
        role: 'member',
        participantId: 'sequenced-member',
        presenceIncarnationId: 'presence-incarnation-new2',
        ticketSequence: 2,
        jti: 'newer-member-ticket-0002',
      }),
    );
    const live = lastServer();

    await room.fetch(delayed);
    const stale = lastServer();
    expect(stale.closed).toBe(true);
    expect(sent(stale)[0]).toMatchObject({ message: 'PRO_SIGNALING_TICKET_STALE' });
    expect(live.closed).toBe(false);

    await room.fetch(
      await proWsRequest({
        role: 'member',
        participantId: 'sequenced-member',
        presenceIncarnationId: 'presence-incarnation-new2',
        ticketSequence: 3,
        jti: 'higher-member-ticket-0003',
      }),
    );
    const reconnected = lastServer();
    expect(live.closeEvents.at(-1)?.reason).toBe('GUEST_REPLACED');
    expect(reconnected.closed).toBe(false);
  });

  it('never lets a delayed lower-sequence coordinator ticket reverse-replace a newer socket', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const delayed = await proWsRequest({
      role: 'coordinator',
      participantId: 'sequenced-coordinator',
      presenceIncarnationId: 'presence-incarnation-old1',
      ticketSequence: 1,
      jti: 'delayed-host-ticket-0001',
    });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'sequenced-coordinator',
        presenceIncarnationId: 'presence-incarnation-new2',
        ticketSequence: 2,
        jti: 'newer-host-ticket-00002',
      }),
    );
    const live = lastServer();

    await room.fetch(delayed);
    const stale = lastServer();
    expect(stale.closed).toBe(true);
    expect(sent(stale)[0]).toMatchObject({ message: 'PRO_SIGNALING_TICKET_STALE' });
    expect(live.closed).toBe(false);
  });

  it('recovers participant sequence high-water from a hibernated socket', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'hibernated-coordinator',
        ticketSequence: 1,
        jti: 'hibernated-host-ticket-01',
      }),
    );
    await room.fetch(
      await proWsRequest({
        role: 'member',
        participantId: 'hibernated-member',
        presenceIncarnationId: 'presence-incarnation-new2',
        ticketSequence: 2,
        jti: 'hibernated-member-ticket2',
      }),
    );
    const live = lastServer();
    expect(live.closed).toBe(false);

    // Simulate a rolling upgrade from a build that persisted attachments but
    // did not yet have the participant high-water storage record.
    state.storage.data.delete('proSignalingParticipantHighWater');
    const rehydrated = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await rehydrated.fetch(
      await proWsRequest({
        role: 'member',
        participantId: 'hibernated-member',
        presenceIncarnationId: 'presence-incarnation-old1',
        ticketSequence: 1,
        jti: 'delayed-after-hibernate-01',
      }),
    );
    const stale = lastServer();

    expect(stale.closed).toBe(true);
    expect(sent(stale)[0]).toMatchObject({ message: 'PRO_SIGNALING_TICKET_STALE' });
    expect(live.closed).toBe(false);
    expect(await state.storage.get('proSignalingParticipantHighWater')).toMatchObject({
      entries: [
        expect.objectContaining({ participantId: 'hibernated-coordinator', ticketSequence: 1 }),
        expect.objectContaining({ participantId: 'hibernated-member', ticketSequence: 2 }),
      ],
    });
  });

  it('admits one PRO coordinator plus at most 32 distinct members', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'coordinator-one',
        jti: 'coordinator-ticket-0001',
      }),
    );
    const coordinator = lastServer();

    for (let index = 0; index < 32; index++) {
      await room.fetch(
        await proWsRequest({
          role: 'member',
          participantId: `pro-member-${index}`,
          jti: `capacity-member-ticket-${String(index).padStart(4, '0')}`,
        }),
      );
      expect(lastServer().closed).toBe(false);
    }

    await room.fetch(
      await proWsRequest({
        role: 'member',
        participantId: 'pro-member-over-limit',
        jti: 'capacity-member-ticket-over-limit',
      }),
    );
    const rejected = lastServer();

    expect(rejected.closeEvents.at(-1)?.reason).toBe('ROOM_GUEST_LIMIT_REACHED');
    expect(sent(rejected)[0]).toMatchObject({ message: 'ROOM_GUEST_LIMIT_REACHED' });
    expect(coordinator.closed).toBe(false);
  });

  it('rejects an older same-epoch coordinator ticket after a newer ticket has connected', async () => {
    const now = Math.floor(Date.now() / 1000);
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const oldRequest = await proWsRequest({
      role: 'coordinator',
      participantId: 'same-coordinator',
      jti: 'older-coordinator-ticket',
      iat: now - 10,
      exp: now + 60,
    });
    await room.fetch(oldRequest);
    const first = lastServer();
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'same-coordinator',
        jti: 'newer-coordinator-ticket',
        ticketSequence: 2,
        iat: now - 5,
        exp: now + 60,
      }),
    );
    const newer = lastServer();
    expect(first.closeEvents.at(-1)?.reason).toBe('HOST_REPLACED');
    expect(newer.closed).toBe(false);

    await room.fetch(oldRequest);
    const replay = lastServer();
    expect(replay.closed).toBe(true);
    expect(sent(replay)[0]).toMatchObject({ message: 'PRO_SIGNALING_TICKET_REPLAYED' });
    expect(newer.closed).toBe(false);
  });

  it('drops stale PRO attachments after hibernation before accepting the current epoch', async () => {
    const state = new FakeDurableObjectState();
    state.storage.data.set('proRoomMeta', {
      v: 1,
      kind: 'pro',
      roomId: '000001',
      coordinatorEpoch: 2,
      coordinatorParticipantId: 'current-coordinator',
      coordinatorJti: 'current-coordinator-ticket',
      coordinatorTicketIat: 0,
    });
    const staleCoordinator = new FakeSocket();
    staleCoordinator.serializeAttachment({
      v: 1,
      roomKind: 'pro',
      role: 'host',
      roomId: '000001',
      peerId: '000001',
      participantId: 'old-coordinator',
      coordinatorEpoch: 1,
      ticketJti: 'old-coordinator-ticket01',
      auth: 'ok',
    });
    const staleMember = new FakeSocket();
    staleMember.serializeAttachment({
      v: 1,
      roomKind: 'pro',
      role: 'guest',
      roomId: '000001',
      peerId: 'old-member',
      participantId: 'old-member',
      coordinatorEpoch: 1,
      ticketJti: 'old-member-ticket-0001',
      auth: 'ok',
    });
    state.sockets.push(staleCoordinator, staleMember);

    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'current-coordinator',
        coordinatorEpoch: 2,
        jti: 'current-coordinator-ticket',
      }),
    );
    const currentCoordinator = lastServer();

    expect(staleCoordinator.closeEvents.at(-1)?.reason).toBe('PRO_COORDINATOR_EPOCH_STALE');
    expect(staleMember.closeEvents.at(-1)?.reason).toBe('PRO_COORDINATOR_EPOCH_STALE');
    expect(currentCoordinator.closed).toBe(false);
    expect(currentCoordinator.deserializeAttachment()).toMatchObject({
      roomKind: 'pro',
      coordinatorEpoch: 2,
      participantId: 'current-coordinator',
    });
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
    const { room, state } = await createHostRoom();

    const guest = await joinGuest(room, 'guest-1');

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
    const bindings = await state.storage.get('guestReconnectBindings');
    expect(bindings).toMatchObject({
      v: 1,
      entries: [
        {
          peerId: 'guest-1',
          secretHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
          updatedAt: expect.any(Number),
        },
      ],
    });
    expect(JSON.stringify(bindings)).not.toContain(DEFAULT_RECONNECT_SECRET);
  });

  it('includes the deployed Worker version in every peer-open when metadata is bound', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      CF_VERSION_METADATA: { id: 'worker-version-123' },
    });

    await room.fetch(wsRequest('123456', 'host', 'host-1', 'secret-a'));
    const host = lastServer();
    const guest = await joinGuest(room, 'guest-1');

    expect(sent(host)[0]).toEqual({
      type: 'peer-open',
      peerId: '123456',
      roomId: '123456',
      workerVersionId: 'worker-version-123',
    });
    expect(sent(guest)[0]).toEqual({
      type: 'peer-open',
      peerId: 'guest-1',
      roomId: '123456',
      workerVersionId: 'worker-version-123',
    });
  });

  it('keeps peer-open compatible when Worker version metadata is unavailable', async () => {
    const { room, host } = await createHostRoom();
    const guest = await joinGuest(room, 'guest-1');

    expect(sent(host)[0]).not.toHaveProperty('workerVersionId');
    expect(sent(guest)[0]).not.toHaveProperty('workerVersionId');
  });

  it('records aggregate room and guest metrics when a D1 binding exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    const metrics = createMetricsEnv();
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, metrics.env);

    await room.fetch(wsRequest('123456', 'host', 'host-1', 'secret-a'));
    await joinGuest(room, 'guest-1');
    await state.flushWaitUntil();

    expect(metrics.events).toEqual([
      { bucketMinute: Math.floor(Date.now() / 60000), event: 'room_opened' },
      { bucketMinute: Math.floor(Date.now() / 60000), event: 'guest_joined' },
    ]);
  });

  it('does not delay peer-open while a D1 metric write is pending', async () => {
    let finishMetric!: () => void;
    const pendingMetric = new Promise<void>((resolve) => {
      finishMetric = resolve;
    });
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MUSIXQUARE_ADMIN_DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            run: vi.fn(() => pendingMetric),
          })),
        })),
      },
    });

    await room.fetch(wsRequest('123456', 'host', 'host-1', 'secret-a'));
    const host = lastServer();
    const guest = await joinGuest(room, 'guest-1');

    expect(sent(host)[0]).toEqual({ type: 'peer-open', peerId: '123456', roomId: '123456' });
    expect(sent(guest)[0]).toEqual({ type: 'peer-open', peerId: 'guest-1', roomId: '123456' });
    expect(state.waitUntilTasks.length).toBeGreaterThan(0);

    finishMetric();
    await state.flushWaitUntil();
  });

  it('preserves guest-to-host and host-to-guest signaling wire shapes', async () => {
    const { room, host } = await createHostRoom();
    const guest = await joinGuest(room, 'guest-1');

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
    const guest = await joinGuest(room, 'guest-1');
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
    const guest = await joinGuest(room, 'guest-1');

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
    const guest = await joinGuest(room, 'guest-1');

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
    const noisy = await joinGuest(room, 'noisy');
    const healthy = await joinGuest(room, 'healthy');

    for (let index = 0; index < 119; index++) {
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
    const noisy = await joinGuest(room, 'noisy');
    const ignoredFrame = JSON.stringify({ type: 'future-client-hint', to: 'host' });

    for (let index = 0; index < 119; index++) {
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
    const firstSocket = await joinGuest(room, 'noisy');
    const ignoredFrame = JSON.stringify({ type: 'future-client-hint', to: 'host' });

    for (let index = 0; index < 119; index++) {
      await room.webSocketMessage(firstSocket, ignoredFrame);
    }
    const replacement = await joinGuest(room, 'noisy');
    await room.webSocketMessage(replacement, ignoredFrame);

    expect(firstSocket.closeEvents.at(-1)?.reason).toBe('GUEST_REPLACED');
    expect(replacement.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'SIGNALING_RATE_LIMITED',
    });
  });

  it('rejects a same-peer replacement without its guest reconnect secret', async () => {
    const { room, host } = await createHostRoom();
    const original = await joinGuest(room, 'guest-1');
    const attacker = await joinGuest(room, 'guest-1', { reconnectSecret: null });

    expect(original.closed).toBe(false);
    expect(sent(attacker).at(-1)).toEqual({
      type: 'error',
      errorType: 'guest-reconnect-denied',
      message: 'GUEST_RECONNECT_DENIED',
    });
    expect(attacker.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'GUEST_RECONNECT_DENIED',
    });

    await room.webSocketMessage(
      original,
      JSON.stringify({
        type: 'signal-candidate',
        to: 'host',
        candidate: { candidate: 'original-still-live' },
      }),
    );
    expect(sent(host).at(-1)).toMatchObject({
      type: 'signal-candidate',
      from: 'guest-1',
      candidate: { candidate: 'original-still-live' },
    });
  });

  it('allows a same-peer replacement only with the matching reconnect secret', async () => {
    const { room } = await createHostRoom();
    const original = await joinGuest(room, 'guest-1');
    const wrongSecret = await joinGuest(room, 'guest-1', {
      reconnectSecret: OTHER_RECONNECT_SECRET,
    });
    expect(wrongSecret.closeEvents.at(-1)?.reason).toBe('GUEST_RECONNECT_DENIED');
    expect(original.closed).toBe(false);

    const replacement = await joinGuest(room, 'guest-1');

    expect(original.closeEvents.at(-1)?.reason).toBe('GUEST_REPLACED');
    expect(replacement.closed).toBe(false);
  });

  it('preserves reconnect-secret ownership across socket close and DO hibernation', async () => {
    const { room, state } = await createHostRoom();
    const original = await joinGuest(room, 'guest-1');
    original.close();
    await room.webSocketClose(original);

    const rehydratedRoom = new workerModule.MusixquareRoom(state);
    const attacker = await joinGuest(rehydratedRoom, 'guest-1', {
      reconnectSecret: OTHER_RECONNECT_SECRET,
    });
    expect(attacker.closeEvents.at(-1)?.reason).toBe('GUEST_RECONNECT_DENIED');
    const legacyDowngrade = await joinGuest(rehydratedRoom, 'guest-1', {
      reconnectSecret: null,
    });
    expect(legacyDowngrade.closeEvents.at(-1)?.reason).toBe('GUEST_RECONNECT_DENIED');

    const replacement = await joinGuest(rehydratedRoom, 'guest-1');

    expect(replacement.closed).toBe(false);
  });

  it('retains the room epoch and guest ownership when its last guest leaves during host grace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:00:00.000Z'));
    const { room, state, host } = await createHostRoom();
    const originalGuest = await joinGuest(room, 'guest-1');

    await room.webSocketClose(host);
    originalGuest.close();
    await room.webSocketClose(originalGuest);

    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'secret-a',
      hostPeerId: null,
      hostReleaseAt: Date.now() + 60_000,
    });
    expect(await state.storage.get('guestReconnectBindings')).toMatchObject({
      entries: [{ peerId: 'guest-1' }],
    });
    expect(state.storage.alarmTime).toBe(Date.now() + 60_000);

    await room.fetch(wsRequest('123456', 'host', 'host-2', 'secret-b'));
    expect(lastServer().closeEvents.at(-1)?.reason).toBe('ROOM_ALREADY_ACTIVE');

    await room.fetch(wsRequest('123456', 'host', 'host-1', 'secret-a'));
    expect(sent(lastServer()).at(-1)).toMatchObject({ type: 'peer-open', roomId: '123456' });

    const attacker = await joinGuest(room, 'guest-1', {
      reconnectSecret: OTHER_RECONNECT_SECRET,
    });
    expect(attacker.closeEvents.at(-1)?.reason).toBe('GUEST_RECONNECT_DENIED');

    const recoveredGuest = await joinGuest(room, 'guest-1');
    expect(recoveredGuest.closed).toBe(false);
    expect(sent(recoveredGuest)[0]).toMatchObject({ type: 'peer-open' });
  });

  it('does not clear room ownership when the host reconnects during last-guest cleanup', async () => {
    const { room, state, host } = await createHostRoom();
    const guest = await joinGuest(room, 'guest-1');
    await room.webSocketClose(host);

    const internals = room as unknown as {
      loadRoomMeta(): Promise<RoomMeta>;
    };
    const originalLoadRoomMeta = internals.loadRoomMeta.bind(room);
    let releaseCleanup!: () => void;
    let markCleanupEntered!: () => void;
    const cleanupEntered = new Promise<void>((resolve) => {
      markCleanupEntered = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let blockNextLoad = true;
    internals.loadRoomMeta = async () => {
      const meta = await originalLoadRoomMeta();
      if (blockNextLoad) {
        blockNextLoad = false;
        markCleanupEntered();
        await cleanupGate;
      }
      return meta;
    };

    guest.close();
    const cleanup = room.webSocketClose(guest);
    await cleanupEntered;

    await room.fetch(wsRequest('123456', 'host', 'host-1', 'secret-a'));
    const reconnectedHost = lastServer();
    expect(sent(reconnectedHost).at(-1)).toMatchObject({ type: 'peer-open' });

    releaseCleanup();
    await cleanup;

    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'secret-a',
      hostPeerId: 'host-1',
      hostReleaseAt: 0,
    });
    expect(await state.storage.get('guestReconnectBindings')).toMatchObject({
      entries: [{ peerId: 'guest-1' }],
    });
    expect(sent(reconnectedHost).at(-1)).toEqual({ type: 'peer-left', peerId: 'guest-1' });
  });

  it('protects a disconnected binding for five minutes, then releases its inactive identity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:00:00.000Z'));
    const { room, state } = await createHostRoom();
    const original = await joinGuest(room, 'guest-1');
    // The reconnect window begins when a guest actually disconnects, not when
    // it first joined what may be a many-hour listening session.
    vi.advanceTimersByTime(60 * 60_000);
    original.close();
    await room.webSocketClose(original);

    vi.advanceTimersByTime(5 * 60_000 - 1);
    const rehydratedRoom = new workerModule.MusixquareRoom(state);
    const attacker = await joinGuest(rehydratedRoom, 'guest-1', {
      reconnectSecret: OTHER_RECONNECT_SECRET,
    });
    expect(attacker.closeEvents.at(-1)?.reason).toBe('GUEST_RECONNECT_DENIED');

    const recovered = await joinGuest(rehydratedRoom, 'guest-1');
    expect(recovered.closed).toBe(false);
    recovered.close();
    await rehydratedRoom.webSocketClose(recovered);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    const reclaimed = await joinGuest(rehydratedRoom, 'guest-1', {
      reconnectSecret: OTHER_RECONNECT_SECRET,
    });
    expect(reclaimed.closed).toBe(false);
  });

  it('returns a retryable conflict while a rolling-deploy legacy guest owns the live ID', async () => {
    const { room } = await createHostRoom();
    const legacy = await joinGuest(room, 'legacy-guest', { reconnectSecret: null });
    const liveReplacement = await joinGuest(room, 'legacy-guest');

    expect(sent(liveReplacement).at(-1)).toEqual({
      type: 'error',
      errorType: 'guest-reconnect-conflict',
      message: 'GUEST_RECONNECT_CONFLICT',
    });
    expect(liveReplacement.closeEvents.at(-1)).toEqual({
      code: 1013,
      reason: 'GUEST_RECONNECT_CONFLICT',
    });
    expect(legacy.closed).toBe(false);

    legacy.close();
    await room.webSocketClose(legacy);
    const replacement = await joinGuest(room, 'legacy-guest');

    expect(replacement.closed).toBe(false);
  });

  it('keeps legacy-to-legacy reconnect compatible after the old socket is gone', async () => {
    const { room } = await createHostRoom();
    const legacy = await joinGuest(room, 'legacy-guest', { reconnectSecret: null });
    legacy.close();
    await room.webSocketClose(legacy);

    const replacement = await joinGuest(room, 'legacy-guest', { reconnectSecret: null });
    expect(replacement.closed).toBe(false);
  });

  it('fails closed at identity capacity, then admits new guests after inactive bindings expire', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:00:00.000Z'));
    const { room, state } = await createHostRoom();
    const active = await joinGuest(room, 'active-guest');

    // Make the live binding older than the reconnect TTL. Hibernation recovery
    // must still identify it from the accepted WebSocket attachment and keep it.
    vi.advanceTimersByTime(5 * 60_000 + 1);
    const recent = await joinGuest(room, 'recent-guest', {
      reconnectSecret: RECENT_RECONNECT_SECRET,
    });
    recent.close();
    await room.webSocketClose(recent);

    // Fill the bounded store with unexpired ownership. A new identity must be
    // rejected rather than evicting a guest that is still inside its promise.
    for (let index = 0; index < 254; index++) {
      const churnGuest = await joinGuest(room, `departed-${index}`);
      churnGuest.close();
      await room.webSocketClose(churnGuest);
      vi.advanceTimersByTime(1);
    }

    const rehydratedRoom = new workerModule.MusixquareRoom(state);
    const capacityBlocked = await joinGuest(rehydratedRoom, 'capacity-blocked');
    expect(capacityBlocked.closeEvents.at(-1)?.reason).toBe('ROOM_IDENTITY_LIMIT_REACHED');

    const activeAttacker = await joinGuest(rehydratedRoom, 'active-guest', {
      reconnectSecret: OTHER_RECONNECT_SECRET,
    });
    expect(activeAttacker.closeEvents.at(-1)?.reason).toBe('GUEST_RECONNECT_DENIED');
    expect(active.closed).toBe(false);

    const recentAttacker = await joinGuest(rehydratedRoom, 'recent-guest', {
      reconnectSecret: OTHER_RECONNECT_SECRET,
    });
    expect(recentAttacker.closeEvents.at(-1)?.reason).toBe('GUEST_RECONNECT_DENIED');

    const recentReconnect = await joinGuest(rehydratedRoom, 'recent-guest', {
      reconnectSecret: RECENT_RECONNECT_SECRET,
    });
    expect(recentReconnect.closed).toBe(false);
    recentReconnect.close();
    await rehydratedRoom.webSocketClose(recentReconnect);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    const legitimateNewGuest = await joinGuest(rehydratedRoom, 'legitimate-new-guest');
    expect(legitimateNewGuest.closed).toBe(false);
    expect(await state.storage.get('guestReconnectBindings')).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ peerId: 'active-guest' }),
        expect.objectContaining({ peerId: 'legitimate-new-guest' }),
      ]),
    });
  });

  it('treats __proto__ as an ordinary peerId without corrupting binding storage', async () => {
    const { room, state } = await createHostRoom();
    const original = await joinGuest(room, '__proto__');
    const attacker = await joinGuest(room, '__proto__', {
      reconnectSecret: OTHER_RECONNECT_SECRET,
    });

    expect(original.closed).toBe(false);
    expect(attacker.closeEvents.at(-1)?.reason).toBe('GUEST_RECONNECT_DENIED');
    expect(await state.storage.get('guestReconnectBindings')).toMatchObject({
      entries: [{ peerId: '__proto__', secretHash: expect.any(String) }],
    });
  });

  it('caps duplicate pending sockets even when they reuse one peerId', async () => {
    const { room, host } = await createHostRoom();
    for (let index = 0; index < 64; index++) {
      await room.fetch(wsRequest('123456', 'guest', 'same-peer'));
      expect(lastServer().closed).toBe(false);
    }

    await room.fetch(wsRequest('123456', 'guest', 'same-peer'));
    const rejected = lastServer();

    expect(sent(rejected).at(-1)).toEqual({
      type: 'error',
      errorType: 'room-full',
      message: 'ROOM_PENDING_LIMIT_REACHED',
    });
    expect(rejected.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'ROOM_PENDING_LIMIT_REACHED',
    });
    expect(host.closed).toBe(false);
  });

  it('allows a bound guest to reconnect while all 32 unique room slots are occupied', async () => {
    const { room } = await createHostRoom();
    const guests: FakeSocket[] = [];
    for (let index = 0; index < 32; index++) {
      guests.push(await joinGuest(room, `guest-${index}`));
    }

    const replacement = await joinGuest(room, 'guest-0');

    expect(guests[0].closeEvents.at(-1)?.reason).toBe('GUEST_REPLACED');
    expect(replacement.closed).toBe(false);

    await room.fetch(wsRequest('123456', 'guest', 'guest-over-limit'));
    const rejected = lastServer();
    expect(rejected.closeEvents.at(-1)?.reason).toBe('ROOM_GUEST_LIMIT_REACHED');
  });

  it('does not let an unauthenticated pending candidate displace a valid reconnect', async () => {
    const { room } = await createHostRoom();
    const original = await joinGuest(room, 'guest-1');

    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const attacker = lastServer();
    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const reconnect = lastServer();
    await room.webSocketMessage(
      reconnect,
      JSON.stringify({
        type: 'guest-auth',
        password: '',
        reconnectSecret: DEFAULT_RECONNECT_SECRET,
      }),
    );

    expect(attacker.closeEvents.at(-1)?.reason).toBe('GUEST_REPLACED');
    expect(original.closeEvents.at(-1)?.reason).toBe('GUEST_REPLACED');
    expect(reconnect.closed).toBe(false);
    expect(sent(reconnect)[0]).toMatchObject({ type: 'peer-open' });
  });

  it('serializes simultaneous first claims so exactly one secret owns the peerId', async () => {
    const { room } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'racing-peer'));
    const first = lastServer();
    await room.fetch(wsRequest('123456', 'guest', 'racing-peer'));
    const second = lastServer();

    await Promise.all([
      room.webSocketMessage(
        first,
        JSON.stringify({
          type: 'guest-auth',
          password: '',
          reconnectSecret: DEFAULT_RECONNECT_SECRET,
        }),
      ),
      room.webSocketMessage(
        second,
        JSON.stringify({
          type: 'guest-auth',
          password: '',
          reconnectSecret: OTHER_RECONNECT_SECRET,
        }),
      ),
    ]);

    expect(
      [first, second].filter((socket) =>
        sent(socket).some((item) => (item as { type?: string }).type === 'peer-open'),
      ),
    ).toHaveLength(1);
    expect([first, second].filter((socket) => socket.closed)).toHaveLength(1);
  });

  it('fails closed when the reconnect binding cannot be persisted', async () => {
    const { room, state } = await createHostRoom();
    const originalPut = state.storage.put.bind(state.storage);
    state.storage.put = vi.fn(async (key: string, value: unknown) => {
      if (key === 'guestReconnectBindings') throw new Error('storage unavailable');
      await originalPut(key, value);
    });

    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const guest = lastServer();
    await expect(
      room.webSocketMessage(
        guest,
        JSON.stringify({
          type: 'guest-auth',
          password: '',
          reconnectSecret: DEFAULT_RECONNECT_SECRET,
        }),
      ),
    ).rejects.toThrow('storage unavailable');

    expect(sent(guest)).toEqual([]);
    expect(guest.deserializeAttachment()).toMatchObject({ auth: 'pending' });
    expect(await state.storage.get('guestReconnectBindings')).toEqual({ v: 1, entries: [] });

    state.storage.put = originalPut;
    await room.webSocketMessage(
      guest,
      JSON.stringify({
        type: 'guest-auth',
        password: '',
        reconnectSecret: OTHER_RECONNECT_SECRET,
      }),
    );
    expect(sent(guest)[0]).toMatchObject({ type: 'peer-open' });
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
      JSON.stringify({
        type: 'guest-auth',
        password: '12345678',
        reconnectSecret: DEFAULT_RECONNECT_SECRET,
      }),
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

  it('does not evict an accepted password-room guest before replacement auth succeeds', async () => {
    const { room } = await createPasswordRoom();
    const original = await joinGuest(room, 'guest-1', { password: '12345678' });

    await room.fetch(wsRequest('123456', 'guest', 'guest-1'));
    const replacement = lastServer();
    await room.webSocketMessage(
      replacement,
      JSON.stringify({
        type: 'guest-auth',
        password: 'wrong-password',
        reconnectSecret: DEFAULT_RECONNECT_SECRET,
      }),
    );

    expect(replacement.closeEvents.at(-1)?.reason).toBe('ROOM_PASSWORD_INVALID');
    expect(original.closed).toBe(false);
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

  it('clears host-only room secrets with an alarm after reconnect grace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:00:00.000Z'));
    const { room, state, host } = await createPasswordRoom();

    await room.webSocketClose(host);
    expect(state.storage.alarmTime).toBe(Date.now() + 60_000);

    vi.advanceTimersByTime(60_000);
    await room.alarm();

    expect(await state.storage.get('roomMeta')).toEqual({
      v: 1,
      roomSecret: null,
      roomPassword: '',
      hostPeerId: null,
      hostReleaseAt: 0,
    });
    expect(state.storage.alarmTime).toBeNull();
  });

  it('closes prior-epoch guests when host reconnect grace expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:00:00.000Z'));
    const { room, state, host } = await createHostRoom();
    const guest = await joinGuest(room, 'guest-1');

    await room.webSocketClose(host);
    expect(await state.storage.get('guestReconnectBindings')).toMatchObject({
      entries: [{ peerId: 'guest-1' }],
    });
    vi.advanceTimersByTime(60_000);
    await room.alarm();

    expect(guest.closed).toBe(true);
    expect(guest.closeEvents.at(-1)).toEqual({ code: 1012, reason: 'ROOM_EXPIRED' });
    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: null,
      hostReleaseAt: 0,
    });
    expect(await state.storage.get('guestReconnectBindings')).toEqual({ v: 1, entries: [] });

    await room.fetch(wsRequest('123456', 'host', 'host-2', 'secret-b'));
    const newEpochGuest = await joinGuest(room, 'guest-1', {
      reconnectSecret: OTHER_RECONNECT_SECRET,
    });
    expect(newEpochGuest.closed).toBe(false);
    expect(sent(newEpochGuest)[0]).toMatchObject({ type: 'peer-open' });
  });

  it('shares one alarm between pending auth timeout and host metadata cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:00:00.000Z'));
    const startedAt = Date.now();
    const { room, state, host } = await createPasswordRoom();

    await room.fetch(wsRequest('123456', 'guest', 'silent-guest'));
    const guest = lastServer();
    await state.flushWaitUntil();
    expect(state.storage.alarmTime).toBe(startedAt + 11_000);

    await room.webSocketClose(host);
    expect(state.storage.alarmTime).toBe(startedAt + 11_000);

    vi.setSystemTime(startedAt + 12_000);
    await room.alarm();
    expect(guest.closed).toBe(true);
    expect(state.storage.alarmTime).toBe(startedAt + 60_000);

    vi.setSystemTime(startedAt + 60_000);
    await room.alarm();
    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: null,
      roomPassword: '',
      hostReleaseAt: 0,
    });
    expect(state.storage.alarmTime).toBeNull();
  });

  it('does not use non-hibernatable WebSocket or timer APIs', async () => {
    const source = await readFile(resolve(process.cwd(), 'cloudflare/signaling-worker.js'), 'utf8');

    expect(source).not.toContain('server.accept(');
    expect(source).not.toContain('addEventListener(');
    expect(source).not.toContain('setTimeout(');
    expect(source).toContain('acceptWebSocket(');
  });
});
