import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStandardRoomAccountAssertion,
  createStandardRoomAccountDeletionAssertion,
} from '../../../../cloudflare/standard-room-account-assertion.js';

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
  memberId?: string;
  displayName: string;
  role?: 'coordinator' | 'member';
  coordinatorEpoch: number;
  presenceRevision: number;
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
  readyState = 1;
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
    this.readyState = 3;
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
  deleteAllCalls = 0;
  transactionCalls = 0;

  async get(key: string): Promise<unknown> {
    return structuredClone(this.data.get(key));
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async transaction(
    callback: (transaction: {
      put(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<void>;
    }) => Promise<void>,
  ): Promise<void> {
    this.transactionCalls += 1;
    const staged = new Map(this.data);
    await callback({
      put: async (key: string, value: unknown): Promise<void> => {
        staged.set(key, structuredClone(value));
      },
      delete: async (key: string): Promise<void> => {
        staged.delete(key);
      },
    });
    this.data = staged;
  }

  async list(): Promise<Map<string, unknown>> {
    return new Map([...this.data.entries()].map(([key, value]) => [key, structuredClone(value)]));
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.deleteAllCalls += 1;
    this.data.clear();
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
const STANDARD_ACCOUNT_ASSERTION_SECRET =
  'standard-room-account-assertion-test-secret-at-least-32-bytes';
const STANDARD_ACCOUNT_ID = 'acct_0123456789abcdefghijkl';

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
    displayName: 'Peer 1',
    role: 'member',
    coordinatorEpoch: 1,
    presenceRevision: 1,
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

async function joinProMember(
  room: InstanceType<WorkerModule['MusixquareRoom']>,
  overrides: Partial<ProTicketPayload>,
): Promise<FakeSocket> {
  await room.fetch(await proWsRequest(overrides));
  return lastServer();
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

function proAuthorityNamespace(
  handler: (request: Request) => Promise<Response> = async () =>
    new originalResponse(
      JSON.stringify({
        allowed: true,
        memberId: 'member_authorized000000001',
        role: 'controller',
        permission: 'chat.notice',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
): {
  binding: {
    idFromName: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  roomFetch: ReturnType<typeof vi.fn>;
} {
  const roomFetch = vi.fn(handler);
  return {
    binding: {
      idFromName: vi.fn((roomCode: string) => `pro-room:${roomCode}`),
      get: vi.fn(() => ({ fetch: roomFetch })),
    },
    roomFetch,
  };
}

function lastServer(): FakeSocket {
  const pair = FakeWebSocketPair.pairs.at(-1);
  if (!pair) throw new Error('missing fake WebSocketPair');
  return pair.server;
}

function sent(ws: FakeSocket): Array<Record<string, unknown>> {
  return ws.sent.map((item) => {
    const parsed: unknown = JSON.parse(item);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Expected a JSON object frame');
    }
    return parsed as Record<string, unknown>;
  });
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
  options: {
    password?: string;
    reconnectSecret?: string | null;
    accountAssertion?: string;
  } = {},
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
      ...(options.accountAssertion ? { accountAssertion: options.accountAssertion } : {}),
    }),
  );
  return guest;
}

async function standardAccountAssertion(input: {
  peerId: string;
  role: 'host' | 'guest';
  nickname?: string;
  accountId?: string;
  roomCode?: string;
}): Promise<string> {
  const assertion = await createStandardRoomAccountAssertion(
    {
      accountId: input.accountId ?? STANDARD_ACCOUNT_ID,
      nickname: input.nickname ?? 'Minsu',
      roomCode: input.roomCode ?? '123456',
      peerId: input.peerId,
      role: input.role,
    },
    STANDARD_ACCOUNT_ASSERTION_SECRET,
  );
  if (!assertion) throw new Error('failed to create standard-room assertion');
  return assertion;
}

async function standardAccountDeletionAssertion(input: {
  peerId: string;
  role: 'host' | 'guest';
  accountId?: string;
  roomCode?: string;
}): Promise<string> {
  const assertion = await createStandardRoomAccountDeletionAssertion(
    {
      accountId: input.accountId ?? STANDARD_ACCOUNT_ID,
      roomCode: input.roomCode ?? '123456',
      peerId: input.peerId,
      role: input.role,
    },
    STANDARD_ACCOUNT_ASSERTION_SECRET,
  );
  if (!assertion) throw new Error('failed to create standard-room deletion assertion');
  return assertion;
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

  it('routes a standard host without requiring a secret in its URL', async () => {
    const { env, idFromName, roomFetch } = workerEnv();
    const request = requestLike(
      'https://signal.example.test/api/rooms/123456/ws?role=host&peerId=current-host',
      {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
      },
    );

    const response = await workerModule.default.fetch(request, env);

    expect(response.status).toBe(101);
    expect(idFromName).toHaveBeenCalledWith('123456');
    expect(roomFetch).toHaveBeenCalledWith(request);
    expect(new URL(request.url).searchParams.get('secret')).toBeNull();
  });

  it('still rejects a malformed non-empty legacy host secret at the edge', async () => {
    const { env, idFromName } = workerEnv();
    const response = await workerModule.default.fetch(
      requestLike(
        'https://signal.example.test/api/rooms/123456/ws?role=host&peerId=host&secret=bad!secret',
        {
          Origin: 'https://musixquare.com',
          Upgrade: 'websocket',
        },
      ),
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

  it('rejects a future PRO room without a signed provision ticket before Durable Object lookup', async () => {
    const { env, idFromName, roomFetch } = workerEnv();
    env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/pro-rooms/000002/ws?ticket=not-a-ticket', {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
      }),
      env,
    );

    expect(response.status).toBe(401);
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

  it('never exposes the private signaling dispatch route through the public Worker', async () => {
    const { env, idFromName, roomFetch } = workerEnv();
    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/internal/developer/v1/dispatch'),
      env,
    );

    expect(response.status).toBe(404);
    expect(idFromName).not.toHaveBeenCalled();
    expect(roomFetch).not.toHaveBeenCalled();
  });

  it('accepts a dynamically provisioned leading-zero room through its signed ticket proof', async () => {
    const { env, idFromName, roomFetch } = workerEnv();
    env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const ticket = await proTicket({ roomCode: '000002', participantId: 'dynamic-member' });
    const url = new URL('https://signal.example.test/api/pro-rooms/000002/ws');
    url.searchParams.set('ticket', ticket);

    const response = await workerModule.default.fetch(
      requestLike(url.toString(), {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
      }),
      env,
    );

    expect(response.status).toBe(101);
    expect(idFromName).toHaveBeenCalledWith('000002');
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
    ['blank display name', async () => proTicket({ displayName: '   ' })],
    ['oversized display name', async () => proTicket({ displayName: 'x'.repeat(65) })],
    ['control-character display name', async () => proTicket({ displayName: 'Peer\u0000One' })],
    ['negative presence revision', async () => proTicket({ presenceRevision: -1 })],
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

  it('admits every signed PRO participant as an equal member and ignores the legacy ticket role', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      PRO_SIGNALING_SECRET,
    });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'coordinator-device',
        displayName: 'Room owner',
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
      role: 'member',
      roomId: '000001',
      peerId: 'coordinator-device',
      participantId: 'coordinator-device',
      displayName: 'Room owner',
      coordinatorEpoch: 1,
    });
    expect(member.deserializeAttachment()).toMatchObject({
      roomKind: 'pro',
      role: 'member',
      peerId: 'signed-member',
      participantId: 'signed-member',
      displayName: 'Peer 1',
      coordinatorEpoch: 1,
      auth: 'ok',
    });
    expect(sent(member)[0]).toMatchObject({
      type: 'peer-open',
      peerId: 'signed-member',
      roomId: '000001',
    });
    expect(await state.storage.get('proRoomMeta')).toMatchObject({
      v: 2,
      kind: 'pro',
      roomId: '000001',
      coordinatorEpoch: 1,
    });
  });

  it('initializes an empty PRO signaling namespace from the first authoritative presence snapshot', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const presenceIncarnationId = 'initial-presence-incarnation-01';

    const initialized = await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 3,
          targets: [presenceIncarnationId],
          event: { type: 'pro-presence-snapshot', presenceRevision: 7 },
        }),
      }),
    );

    expect(initialized.status).toBe(200);
    expect(JSON.parse(String(initialized.body))).toEqual({
      broadcast: true,
      eligible: 0,
      sent: 0,
    });
    expect(await state.storage.get('proRoomMeta')).toEqual({
      v: 2,
      kind: 'pro',
      roomId: '000001',
      coordinatorEpoch: 3,
    });
    expect(await state.storage.get('proSignalingPresenceAuthority')).toEqual({
      v: 1,
      roomId: '000001',
      coordinatorEpoch: 3,
      presenceRevision: 7,
      activeIncarnationIds: [presenceIncarnationId],
    });

    const active = await joinProMember(room, {
      participantId: 'initial-active-member',
      coordinatorEpoch: 3,
      presenceRevision: 7,
      presenceIncarnationId,
      jti: 'initial-active-ticket-00001',
    });
    expect(active.closed).toBe(false);
    expect(sent(active)[0]).toMatchObject({ type: 'peer-open', peerId: 'initial-active-member' });

    await room.fetch(
      await proWsRequest({
        participantId: 'initial-inactive-member',
        coordinatorEpoch: 3,
        presenceRevision: 7,
        presenceIncarnationId: 'initial-inactive-presence-01',
        jti: 'initial-inactive-ticket-001',
      }),
    );
    const inactive = lastServer();
    expect(inactive.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'PRO_SIGNALING_PRESENCE_STALE',
    });

    await room.fetch(
      await proWsRequest({
        participantId: 'initial-stale-member',
        coordinatorEpoch: 3,
        presenceRevision: 6,
        presenceIncarnationId,
        jti: 'initial-stale-ticket-00001',
      }),
    );
    const stale = lastServer();
    expect(stale.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'PRO_SIGNALING_PRESENCE_STALE',
    });
  });

  it('advances a PRO signaling epoch only from an authoritative presence snapshot', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const oldIncarnationId = 'epoch-one-presence-000001';
    const oldMember = await joinProMember(room, {
      participantId: 'epoch-one-member',
      coordinatorEpoch: 1,
      presenceRevision: 3,
      presenceIncarnationId: oldIncarnationId,
      jti: 'epoch-one-ticket-0000001',
    });
    await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 1,
          targets: [oldIncarnationId],
          event: { type: 'pro-presence-snapshot', presenceRevision: 3 },
        }),
      }),
    );

    const rejectedFutureEvent = await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 2,
          targets: [oldIncarnationId],
          event: { type: 'pro-playback-commit' },
        }),
      }),
    );
    expect(rejectedFutureEvent.status).toBe(409);
    expect(oldMember.closed).toBe(false);
    expect(await state.storage.get('proRoomMeta')).toMatchObject({ coordinatorEpoch: 1 });

    const newIncarnationId = 'epoch-two-presence-000001';
    const advanced = await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 2,
          targets: [newIncarnationId],
          event: { type: 'pro-presence-snapshot', presenceRevision: 1 },
        }),
      }),
    );

    expect(advanced.status).toBe(200);
    expect(oldMember.closeEvents.at(-1)).toEqual({
      code: 1012,
      reason: 'PRO_ROOM_EPOCH_ADVANCED',
    });
    expect(await state.storage.get('proRoomMeta')).toEqual({
      v: 2,
      kind: 'pro',
      roomId: '000001',
      coordinatorEpoch: 2,
    });
    expect(await state.storage.get('proSignalingPresenceAuthority')).toEqual({
      v: 1,
      roomId: '000001',
      coordinatorEpoch: 2,
      presenceRevision: 1,
      activeIncarnationIds: [newIncarnationId],
    });

    await room.fetch(
      await proWsRequest({
        participantId: 'epoch-one-stale-member',
        coordinatorEpoch: 1,
        presenceRevision: 3,
        presenceIncarnationId: oldIncarnationId,
        jti: 'epoch-one-stale-ticket-01',
      }),
    );
    const staleMember = lastServer();
    expect(staleMember.closed).toBe(true);
    expect(sent(staleMember)[0]).toMatchObject({ message: 'PRO_COORDINATOR_EPOCH_STALE' });

    const newMember = await joinProMember(room, {
      participantId: 'epoch-two-member',
      coordinatorEpoch: 2,
      presenceRevision: 1,
      presenceIncarnationId: newIncarnationId,
      jti: 'epoch-two-ticket-0000001',
    });
    expect(newMember.closed).toBe(false);
    expect(sent(newMember)[0]).toMatchObject({ type: 'peer-open', peerId: 'epoch-two-member' });
  });

  it('broadcasts bounded server events only to exact current PRO presence incarnations', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const alice = await joinProMember(room, {
      participantId: 'member-alice',
      memberId: 'member_accountalice000000000001',
      displayName: 'Alice',
      presenceIncarnationId: 'presence-incarnation-alice',
      jti: 'ticket-identifier-alice',
    });
    const bob = await joinProMember(room, {
      participantId: 'member-bob',
      displayName: 'Bob',
      presenceIncarnationId: 'presence-incarnation-bob01',
      jti: 'ticket-identifier-bob01',
    });
    const carol = await joinProMember(room, {
      participantId: 'member-carol',
      displayName: 'Carol',
      presenceIncarnationId: 'presence-incarnation-carol',
      jti: 'ticket-identifier-carol',
    });
    const rehydratedRoom = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const event = {
      type: 'pro-playback-commit',
      transitionId: null,
      basePlaybackRevision: 6,
      playbackRevision: 7,
    };
    const counts = [alice.sent.length, bob.sent.length, carol.sent.length];

    const response = await rehydratedRoom.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 1,
          targets: ['presence-incarnation-alice', 'presence-incarnation-carol'],
          event,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual({ broadcast: true, eligible: 2, sent: 2 });
    const expected = {
      type: 'pro-server-event',
      version: 1,
      roomCode: '000001',
      coordinatorEpoch: 1,
      event,
    };
    expect(sent(alice).at(-1)).toEqual(expected);
    expect(bob.sent).toHaveLength(counts[1]);
    expect(sent(carol).at(-1)).toEqual(expected);
    expect(alice.sent).toHaveLength(counts[0] + 1);
    expect(carol.sent).toHaveLength(counts[2] + 1);
  });

  it('revokes an open PRO socket omitted from the authoritative presence snapshot', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const alice = await joinProMember(room, {
      participantId: 'member-alice',
      displayName: 'Alice',
      presenceIncarnationId: 'presence-incarnation-alice',
      jti: 'presence-revoke-ticket-alice',
    });
    const bob = await joinProMember(room, {
      participantId: 'member-bob',
      displayName: 'Bob',
      presenceIncarnationId: 'presence-incarnation-bob01',
      jti: 'presence-revoke-ticket-bob01',
    });
    const aliceSentBefore = alice.sent.length;

    const response = await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 1,
          targets: ['presence-incarnation-alice'],
          event: { type: 'pro-presence-snapshot', presenceRevision: 3, roomRevision: 9 },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual({ broadcast: true, eligible: 1, sent: 1 });
    expect(alice.sent).toHaveLength(aliceSentBefore + 1);
    expect(bob.closed).toBe(true);
    expect(bob.closeEvents.at(-1)).toEqual({ code: 1008, reason: 'PRO_PRESENCE_REVOKED' });
  });

  it('rejects an unused ticket issued before a later removal snapshot', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const removed = await joinProMember(room, {
      participantId: 'removed-member',
      presenceRevision: 3,
      presenceIncarnationId: 'presence-incarnation-removed',
      jti: 'removed-member-ticket-0001',
    });
    const issuedBeforeRemoval = await proWsRequest({
      participantId: 'removed-member',
      presenceRevision: 3,
      presenceIncarnationId: 'presence-incarnation-removed',
      ticketSequence: 2,
      jti: 'removed-member-ticket-0002',
    });

    const snapshot = await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 1,
          targets: [],
          event: { type: 'pro-presence-snapshot', presenceRevision: 4 },
        }),
      }),
    );
    expect(snapshot.status).toBe(200);
    expect(removed.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'PRO_PRESENCE_REVOKED',
    });

    const response = await room.fetch(issuedBeforeRemoval);
    const rejected = lastServer();
    expect(response.status).toBe(101);
    expect(rejected.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'PRO_SIGNALING_PRESENCE_STALE',
    });
  });

  it('rejects an inactive incarnation at the current authoritative presence revision', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await joinProMember(room, {
      participantId: 'active-member',
      presenceRevision: 5,
      presenceIncarnationId: 'presence-incarnation-active1',
      jti: 'active-member-ticket-00001',
    });
    await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 1,
          targets: ['presence-incarnation-active1'],
          event: { type: 'pro-presence-snapshot', presenceRevision: 5 },
        }),
      }),
    );

    const response = await room.fetch(
      await proWsRequest({
        participantId: 'inactive-member',
        presenceRevision: 5,
        presenceIncarnationId: 'presence-incarnation-inactive',
        jti: 'inactive-member-ticket-001',
      }),
    );
    const rejected = lastServer();
    expect(response.status).toBe(101);
    expect(rejected.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'PRO_SIGNALING_PRESENCE_STALE',
    });
  });

  it('allows a next-revision join race and then establishes its authoritative live-set', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const alice = await joinProMember(room, {
      participantId: 'race-member-alice',
      presenceRevision: 8,
      presenceIncarnationId: 'race-presence-alice-0001',
      jti: 'race-ticket-alice-000001',
    });
    await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 1,
          targets: ['race-presence-alice-0001'],
          event: { type: 'pro-presence-snapshot', presenceRevision: 8 },
        }),
      }),
    );

    const bob = await joinProMember(room, {
      participantId: 'race-member-bob',
      presenceRevision: 9,
      presenceIncarnationId: 'race-presence-bob-000001',
      jti: 'race-ticket-bob-00000001',
    });
    expect(bob.closed).toBe(false);
    expect(sent(bob)[0]).toMatchObject({ type: 'peer-open', peerId: 'race-member-bob' });

    // The client starts clock calibration immediately after OPEN. Its signed
    // next-revision ticket must remain usable while the matching authoritative
    // snapshot is still racing through the internal service binding.
    await room.webSocketMessage(
      bob,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'race-clock-event-0001',
        channel: 'clock',
        payload: { requestId: 1, clientSentAtMs: 1234 },
      }),
    );
    expect(bob.closed).toBe(false);
    expect(sent(bob).at(-1)).toMatchObject({ type: 'pro-clock', requestId: 1 });

    const snapshot = await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 1,
          targets: ['race-presence-bob-000001', 'race-presence-alice-0001'],
          event: { type: 'pro-presence-snapshot', presenceRevision: 9 },
        }),
      }),
    );
    expect(snapshot.status).toBe(200);
    expect(alice.closed).toBe(false);
    expect(bob.closed).toBe(false);
    expect(await state.storage.get('proSignalingPresenceAuthority')).toEqual({
      v: 1,
      roomId: '000001',
      coordinatorEpoch: 1,
      presenceRevision: 9,
      activeIncarnationIds: ['race-presence-alice-0001', 'race-presence-bob-000001'],
    });

    const rejectedRollback = await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 1,
          targets: [],
          event: { type: 'pro-presence-snapshot', presenceRevision: 8 },
        }),
      }),
    );
    const rejectedFork = await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 1,
          targets: ['race-presence-alice-0001'],
          event: { type: 'pro-presence-snapshot', presenceRevision: 9 },
        }),
      }),
    );
    expect(rejectedRollback.status).toBe(409);
    expect(rejectedFork.status).toBe(409);
    expect(alice.closed).toBe(false);
    expect(bob.closed).toBe(false);
  });

  it('rehydrates the authoritative presence fence from Durable Object storage', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const active = await joinProMember(room, {
      participantId: 'stored-active-member',
      presenceRevision: 12,
      presenceIncarnationId: 'stored-active-presence-01',
      jti: 'stored-active-ticket-00001',
    });
    await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 1,
          targets: ['stored-active-presence-01'],
          event: { type: 'pro-presence-snapshot', presenceRevision: 12 },
        }),
      }),
    );

    const rehydratedRoom = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const response = await rehydratedRoom.fetch(
      await proWsRequest({
        participantId: 'stored-inactive-member',
        presenceRevision: 12,
        presenceIncarnationId: 'stored-inactive-presence1',
        jti: 'stored-inactive-ticket-001',
      }),
    );
    const rejected = lastServer();

    expect(response.status).toBe(101);
    expect(active.closed).toBe(false);
    expect(rejected.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'PRO_SIGNALING_PRESENCE_STALE',
    });
  });

  it('rejects stale, malformed, duplicate-target, deep, and oversized server broadcasts', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const member = await joinProMember(room, {
      participantId: 'broadcast-member',
      presenceIncarnationId: 'broadcast-presence-0001',
      jti: 'broadcast-ticket-000001',
    });
    const initialSentCount = member.sent.length;
    const broadcast = (body: unknown) =>
      room.fetch(
        new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    const base = {
      roomCode: '000001',
      coordinatorEpoch: 1,
      targets: ['broadcast-presence-0001'],
      event: {
        type: 'pro-presence-snapshot',
        presenceRevision: 1,
        revision: 1,
        participants: [],
      },
    };

    expect(
      (
        await broadcast({
          ...base,
          coordinatorEpoch: 2,
          event: { type: 'pro-playback-commit' },
        })
      ).status,
    ).toBe(409);
    expect((await broadcast({ ...base, unexpected: true })).status).toBe(400);
    expect(
      (
        await broadcast({
          ...base,
          targets: ['broadcast-presence-0001', 'broadcast-presence-0001'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await broadcast({
          ...base,
          event: { type: 'unknown-event' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await broadcast({
          ...base,
          event: { type: 'pro-presence-snapshot', nested: { a: { b: { c: { d: 1 } } } } },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await broadcast({
          ...base,
          event: {
            type: 'pro-presence-snapshot',
            chunks: ['a'.repeat(1_600), 'b'.repeat(1_600)],
          },
        })
      ).status,
    ).toBe(400);
    expect(member.sent).toHaveLength(initialSentCount);
  });

  it('relays normalized PRO chat with server-authenticated identity and excludes the sender', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const alice = await joinProMember(room, {
      participantId: 'member-alice',
      memberId: 'member_accountalice000000000001',
      displayName: 'Alice',
      presenceIncarnationId: 'presence-incarnation-alice',
      jti: 'realtime-ticket-alice01',
    });
    const bob = await joinProMember(room, {
      participantId: 'member-bob',
      displayName: 'Bob',
      presenceIncarnationId: 'presence-incarnation-bob01',
      jti: 'realtime-ticket-bob0001',
    });
    const carol = await joinProMember(room, {
      participantId: 'member-carol',
      displayName: 'Carol',
      presenceIncarnationId: 'presence-incarnation-carol',
      jti: 'realtime-ticket-carol01',
    });
    const counts = [alice.sent.length, bob.sent.length, carol.sent.length];

    await room.webSocketMessage(
      alice,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'chat-event-00000001',
        channel: 'chat',
        payload: { kind: 'message', text: 'hello', clientTs: 123 },
        sender: { participantId: 'forged-member' },
      }),
    );
    expect(alice.sent).toHaveLength(counts[0]);
    expect(bob.sent).toHaveLength(counts[1]);
    expect(carol.sent).toHaveLength(counts[2]);

    await room.webSocketMessage(
      alice,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'chat-event-00000002',
        channel: 'chat',
        payload: { kind: 'message', text: 'hello', clientTs: 123 },
      }),
    );

    const relay = {
      type: 'pro-realtime',
      version: 1,
      eventId: 'chat-event-00000002',
      channel: 'chat',
      payload: { kind: 'message', text: 'hello', clientTs: 123 },
      roomCode: '000001',
      coordinatorEpoch: 1,
      sender: {
        participantId: 'member-alice',
        presenceIncarnationId: 'presence-incarnation-alice',
        memberId: 'member_accountalice000000000001',
        displayName: 'Alice',
      },
    };
    expect(alice.sent).toHaveLength(counts[0]);
    expect(sent(bob).at(-1)).toEqual(relay);
    expect(sent(carol).at(-1)).toEqual(relay);
  });

  it('authorizes PRO notices with the admitted participant and exact presence incarnation', async () => {
    const authority = proAuthorityNamespace(async (request) => {
      expect(new URL(request.url).pathname).toBe('/internal/authority/check');
      expect(request.method).toBe('POST');
      expect(request.headers.get('x-mxqr-pro-room-code')).toBe('000001');
      expect(await request.json()).toEqual({
        participantId: 'notice-authorized',
        presenceIncarnationId: 'notice-presence-authorized',
        permission: 'chat.notice',
      });
      return new originalResponse(
        JSON.stringify({
          allowed: true,
          memberId: 'member_noticeauthorized001',
          role: 'controller',
          permission: 'chat.notice',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    });
    const sender = await joinProMember(room, {
      participantId: 'notice-authorized',
      displayName: 'Authorized',
      presenceIncarnationId: 'notice-presence-authorized',
      jti: 'notice-authorized-ticket1',
    });
    const recipient = await joinProMember(room, {
      participantId: 'notice-recipient',
      displayName: 'Recipient',
      presenceIncarnationId: 'notice-presence-recipient1',
      jti: 'notice-recipient-ticket01',
    });
    const senderCount = sender.sent.length;

    await room.webSocketMessage(
      sender,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'notice-authorized-event1',
        channel: 'chat',
        payload: { kind: 'notice', text: 'Room announcement' },
      }),
    );

    expect(authority.binding.idFromName).toHaveBeenCalledWith('000001');
    expect(authority.roomFetch).toHaveBeenCalledTimes(1);
    expect(sender.sent).toHaveLength(senderCount);
    expect(sent(recipient).at(-1)).toMatchObject({
      channel: 'chat',
      payload: { kind: 'notice', text: 'Room announcement' },
      sender: {
        participantId: 'notice-authorized',
        presenceIncarnationId: 'notice-presence-authorized',
      },
    });
  });

  it('drops denied or superseded PRO notices but keeps ordinary chat and the socket alive', async () => {
    const authority = proAuthorityNamespace(async (request) => {
      expect(await request.json()).toEqual({
        participantId: 'stale-notice-sender',
        presenceIncarnationId: 'stale-notice-incarnation1',
        permission: 'chat.notice',
      });
      return new originalResponse(JSON.stringify({ error: 'PERMISSION_REQUIRED' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    });
    const sender = await joinProMember(room, {
      participantId: 'stale-notice-sender',
      presenceIncarnationId: 'stale-notice-incarnation1',
      jti: 'stale-notice-ticket-0001',
    });
    const recipient = await joinProMember(room, {
      participantId: 'stale-notice-target',
      presenceIncarnationId: 'stale-notice-target-inc1',
      jti: 'stale-notice-target-ticket',
    });
    const recipientCount = recipient.sent.length;

    await room.webSocketMessage(
      sender,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'stale-notice-event-0001',
        channel: 'chat',
        payload: { kind: 'notice', text: 'must not relay' },
      }),
    );
    expect(recipient.sent).toHaveLength(recipientCount);
    expect(sender.closed).toBe(false);

    await room.webSocketMessage(
      sender,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'ordinary-chat-after-denial',
        channel: 'chat',
        payload: { kind: 'message', text: 'ordinary chat survives', clientTs: 123 },
      }),
    );
    expect(authority.roomFetch).toHaveBeenCalledTimes(1);
    expect(sent(recipient).at(-1)).toMatchObject({
      payload: { kind: 'message', text: 'ordinary chat survives' },
    });
    expect(sender.closed).toBe(false);
  });

  it('fails PRO notices closed without disrupting sockets when authority fails or times out', async () => {
    const failedAuthority = proAuthorityNamespace(async () => {
      throw new Error('authority unavailable');
    });
    const failedState = new FakeDurableObjectState();
    const failedRoom = new workerModule.MusixquareRoom(failedState, {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: failedAuthority.binding,
    });
    const failedSender = await joinProMember(failedRoom, {
      participantId: 'failed-notice-sender',
      presenceIncarnationId: 'failed-notice-incarnation',
      jti: 'failed-notice-ticket-0001',
    });
    const failedRecipient = await joinProMember(failedRoom, {
      participantId: 'failed-notice-target',
      presenceIncarnationId: 'failed-notice-target-inc1',
      jti: 'failed-notice-target-ticket',
    });
    const failedRecipientCount = failedRecipient.sent.length;
    await failedRoom.webSocketMessage(
      failedSender,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'failed-notice-event-0001',
        channel: 'chat',
        payload: { kind: 'notice', text: 'must fail closed' },
      }),
    );
    expect(failedRecipient.sent).toHaveLength(failedRecipientCount);
    expect(failedSender.closed).toBe(false);

    const timeoutController = new AbortController();
    const timeoutSignal = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((milliseconds: number) => {
        expect(milliseconds).toBe(1_000);
        return timeoutController.signal;
      });
    const timeoutAuthority = proAuthorityNamespace(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          if (request.signal.aborted) {
            reject(request.signal.reason || new Error('authority timeout'));
            return;
          }
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason || new Error('authority timeout')),
            { once: true },
          );
        }),
    );
    const timeoutState = new FakeDurableObjectState();
    const timeoutRoom = new workerModule.MusixquareRoom(timeoutState, {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: timeoutAuthority.binding,
    });
    const timeoutSender = await joinProMember(timeoutRoom, {
      participantId: 'timeout-notice-sender',
      presenceIncarnationId: 'timeout-notice-incarnation',
      jti: 'timeout-notice-ticket-0001',
    });
    const timeoutRecipient = await joinProMember(timeoutRoom, {
      participantId: 'timeout-notice-target',
      presenceIncarnationId: 'timeout-notice-target-inc1',
      jti: 'timeout-notice-target-ticket',
    });
    const timeoutRecipientCount = timeoutRecipient.sent.length;
    const pending = timeoutRoom.webSocketMessage(
      timeoutSender,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'timeout-notice-event-0001',
        channel: 'chat',
        payload: { kind: 'notice', text: 'must time out closed' },
      }),
    );
    await vi.waitFor(() => expect(timeoutAuthority.roomFetch).toHaveBeenCalledTimes(1));
    timeoutController.abort(new DOMException('authority timeout', 'TimeoutError'));
    await pending;
    timeoutSignal.mockRestore();
    expect(timeoutRecipient.sent).toHaveLength(timeoutRecipientCount);
    expect(timeoutSender.closed).toBe(false);
  });

  it('keeps PRO clock replies point-to-point and whispers target-only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const alice = await joinProMember(room, {
      participantId: 'clock-alice',
      displayName: 'Alice',
      presenceIncarnationId: 'clock-presence-alice01',
      jti: 'clock-ticket-alice-0001',
    });
    const bob = await joinProMember(room, {
      participantId: 'clock-bob',
      displayName: 'Bob',
      presenceIncarnationId: 'clock-presence-bob0001',
      jti: 'clock-ticket-bob-000001',
    });
    const carol = await joinProMember(room, {
      participantId: 'clock-carol',
      displayName: 'Carol',
      presenceIncarnationId: 'clock-presence-carol01',
      jti: 'clock-ticket-carol-0001',
    });
    const bobCount = bob.sent.length;
    const carolCount = carol.sent.length;

    await room.webSocketMessage(
      alice,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'clock-event-0000001',
        channel: 'clock',
        payload: { requestId: 17, clientSentAtMs: 1234 },
      }),
    );
    expect(sent(alice).at(-1)).toEqual({
      type: 'pro-clock',
      version: 1,
      requestId: 17,
      clientSentAtMs: 1234,
      serverTimeMs: Date.now(),
    });
    expect(bob.sent).toHaveLength(bobCount);
    expect(carol.sent).toHaveLength(carolCount);

    await room.webSocketMessage(
      alice,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'whisper-event-0001',
        channel: 'chat',
        payload: { kind: 'whisper', targetParticipantId: 'clock-bob', text: 'secret' },
      }),
    );
    expect(sent(bob).at(-1)).toMatchObject({
      channel: 'chat',
      payload: { kind: 'whisper', targetParticipantId: 'clock-bob', text: 'secret' },
      sender: { participantId: 'clock-alice', displayName: 'Alice' },
    });
    expect(carol.sent).toHaveLength(carolCount);
  });

  it('normalizes every allowed PRO chat moderation and bot-result payload variant', async () => {
    const authority = proAuthorityNamespace(async (request) => {
      const body = (await request.json()) as { permission: string };
      return new originalResponse(
        JSON.stringify({
          allowed: true,
          memberId: 'member_authorized000000001',
          role: 'owner',
          permission: body.permission,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    });
    const sender = await joinProMember(room, {
      participantId: 'variant-sender',
      presenceIncarnationId: 'variant-presence-sender',
      jti: 'variant-ticket-sender01',
    });
    const recipient = await joinProMember(room, {
      participantId: 'variant-recipient',
      presenceIncarnationId: 'variant-presence-target',
      jti: 'variant-ticket-target01',
    });
    const payloads = [
      {
        kind: 'bot-result',
        requestId: 'bot-request-00000001',
        result: { kind: 'answer', text: 'done' },
      },
      {
        kind: 'system',
        text: 'System audio sharing started',
        i18nKey: 'chat.system_audio_started_system_message',
      },
      { kind: 'notice', text: 'notice' },
      { kind: 'clear' },
      { kind: 'freeze', on: true },
      { kind: 'filter', on: true },
      { kind: 'slowmode', seconds: 60 },
      { kind: 'mute', targetParticipantId: 'variant-recipient', on: true },
    ];

    for (const [index, payload] of payloads.entries()) {
      await room.webSocketMessage(
        sender,
        JSON.stringify({
          type: 'pro-realtime',
          version: 1,
          eventId: `variant-event-${String(index).padStart(8, '0')}`,
          channel: 'chat',
          payload,
        }),
      );
      expect(sent(recipient).at(-1)).toMatchObject({
        channel: 'chat',
        payload:
          payload.kind === 'system'
            ? {
                kind: 'system',
                text: 'chat.system_audio_started_system_message',
                i18nKey: 'chat.system_audio_started_system_message',
              }
            : payload,
      });
    }

    await room.webSocketMessage(
      sender,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'ready-event-00000001',
        channel: 'control-ready',
        payload: { commandId: 'command-id-00000001', sequence: 4, ready: true },
      }),
    );
    expect(sent(recipient).at(-1)).toMatchObject({
      channel: 'control-ready',
      payload: { commandId: 'command-id-00000001', sequence: 4, ready: true },
    });

    const sentCount = recipient.sent.length;
    const invalidPayloads = [
      { kind: 'message', text: 'hello', clientTs: 1, unexpected: true },
      {
        kind: 'bot-result',
        requestId: 'bot-request-00000001',
        result: { kind: 'added', count: 4, playbackChanged: false },
      },
      { kind: 'system', text: 'joined', i18nParams: { count: 2 } },
      {
        kind: 'system',
        text: 'An administrator changed your room settings',
        i18nKey: 'chat.fake_admin_message',
      },
      {
        kind: 'system',
        text: 'System audio sharing started',
        i18nKey: 'chat.system_audio_started_system_message',
        i18nParams: {},
      },
      {
        kind: 'system',
        text: 'tracks added',
        i18nKey: 'chat.tracks_added',
        i18nParams: { name: 'Mallory', count: 2, admin: 'true' },
      },
      {
        kind: 'system',
        text: 'track added',
        i18nKey: 'chat.track_added_named',
        i18nParams: { name: 'Mallory', count: 2, title: 'Not singular' },
      },
      {
        kind: 'system',
        text: 'tracks added',
        i18nKey: 'chat.tracks_added_named',
        i18nParams: { name: 'Mallory\u202e', count: 2, title: 'Hidden direction' },
      },
      JSON.parse(
        '{"kind":"system","text":"joined","i18nKey":"chat.joined","i18nParams":{"__proto__":"pollute"}}',
      ),
      {
        kind: 'system',
        text: 'joined',
        i18nKey: 'chat.joined',
        i18nParams: { count: Number.MAX_SAFE_INTEGER + 1 },
      },
      { kind: 'slowmode', seconds: 61 },
      { kind: 'mute', targetParticipantId: 'missing-member', on: true },
    ];
    for (const [index, payload] of invalidPayloads.entries()) {
      await room.webSocketMessage(
        sender,
        JSON.stringify({
          type: 'pro-realtime',
          version: 1,
          eventId: `invalid-event-${String(index).padStart(8, '0')}`,
          channel: 'chat',
          payload,
        }),
      );
    }
    expect(recipient.sent).toHaveLength(sentCount);
  });

  it('persists authoritative PRO chat controls, enforces them, and hydrates reconnects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));
    const authority = proAuthorityNamespace(async (request) => {
      const body = (await request.json()) as {
        participantId: string;
        permission: string;
      };
      const allowed =
        body.participantId === 'chat-owner' &&
        (body.permission === 'room.configure' || body.permission === 'chat.manage');
      return new originalResponse(
        JSON.stringify(
          allowed
            ? {
                allowed: true,
                memberId: 'owner_chatauthority000000001',
                role: 'owner',
                permission: body.permission,
              }
            : { error: 'PERMISSION_REQUIRED' },
        ),
        { status: allowed ? 200 : 403, headers: { 'content-type': 'application/json' } },
      );
    });
    const state = new FakeDurableObjectState();
    let room = new workerModule.MusixquareRoom(state, {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    });
    const owner = await joinProMember(room, {
      participantId: 'chat-owner',
      displayName: 'Owner',
      presenceIncarnationId: 'chat-owner-presence-0001',
      jti: 'chat-owner-ticket-000001',
    });
    const member = await joinProMember(room, {
      participantId: 'chat-member',
      displayName: 'Member',
      presenceIncarnationId: 'chat-member-presence-001',
      jti: 'chat-member-ticket-00001',
    });
    const sendChat = (
      targetRoom: InstanceType<WorkerModule['MusixquareRoom']>,
      socket: FakeSocket,
      eventId: string,
      payload: Record<string, unknown>,
    ) =>
      targetRoom.webSocketMessage(
        socket,
        JSON.stringify({ type: 'pro-realtime', version: 1, eventId, channel: 'chat', payload }),
      );

    await sendChat(room, owner, 'chat-freeze-event-0001', { kind: 'freeze', on: true });
    await sendChat(room, owner, 'chat-filter-event-0001', { kind: 'filter', on: true });
    await sendChat(room, owner, 'chat-slowmode-event-01', { kind: 'slowmode', seconds: 2 });
    await sendChat(room, owner, 'chat-mute-event-000001', {
      kind: 'mute',
      targetParticipantId: 'chat-member',
      on: true,
    });
    expect(await state.storage.get('proChatControlState')).toEqual({
      v: 1,
      roomId: '000001',
      coordinatorEpoch: 1,
      revision: 4,
      frozen: true,
      filterEnabled: true,
      slowmodeSeconds: 2,
      mutedParticipantIds: ['chat-member'],
    });

    // Simulate hibernation: control state is recovered from durable storage,
    // not from whichever browser happened to issue the commands.
    room = new workerModule.MusixquareRoom(state, {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    });
    const late = await joinProMember(room, {
      participantId: 'chat-late-member',
      displayName: 'Late',
      presenceIncarnationId: 'chat-late-presence-00001',
      jti: 'chat-late-ticket-0000001',
    });
    expect(
      sent(late)
        .slice(1)
        .map((frame: any) => ({ channel: frame.channel, payload: frame.payload })),
    ).toEqual([
      {
        channel: 'chat-control-snapshot',
        payload: {
          revision: 4,
          frozen: true,
          filterEnabled: true,
          slowmodeSeconds: 2,
          muted: false,
        },
      },
    ]);

    const reconnectedMember = await joinProMember(room, {
      participantId: 'chat-member',
      displayName: 'Member',
      presenceIncarnationId: 'chat-member-presence-001',
      ticketSequence: 2,
      jti: 'chat-member-ticket-00002',
    });
    expect(
      sent(reconnectedMember)
        .slice(1)
        .map((frame: any) => ({ channel: frame.channel, payload: frame.payload })),
    ).toEqual([
      {
        channel: 'chat-control-snapshot',
        payload: {
          revision: 4,
          frozen: true,
          filterEnabled: true,
          slowmodeSeconds: 2,
          muted: true,
        },
      },
    ]);

    // The replaced socket closing is not authoritative departure and must not
    // clear the successor participant's mute.
    await room.webSocketClose(member);
    expect(await state.storage.get('proChatControlState')).toMatchObject({
      mutedParticipantIds: ['chat-member'],
    });

    const lateCount = late.sent.length;
    await sendChat(room, reconnectedMember, 'chat-muted-message-0001', {
      kind: 'message',
      text: 'must be dropped',
      clientTs: 1,
    });
    expect(late.sent).toHaveLength(lateCount);

    // A frozen room admits only a current server-authorized chat manager.
    await sendChat(room, late, 'chat-frozen-message-001', {
      kind: 'message',
      text: 'also dropped',
      clientTs: 2,
    });
    expect(reconnectedMember.sent.at(-1)).not.toContain('also dropped');

    const beforeOwnerMessage = late.sent.length;
    await sendChat(room, owner, 'chat-owner-message-0001', {
      kind: 'message',
      text: 'authorized while frozen',
      clientTs: 3,
    });
    expect(late.sent).toHaveLength(beforeOwnerMessage + 1);

    // Slowmode is evaluated from a hibernation-safe socket attachment. The
    // second message is dropped; the same owner may speak after the interval.
    await sendChat(room, owner, 'chat-owner-message-0002', {
      kind: 'message',
      text: 'too soon',
      clientTs: 4,
    });
    expect(late.sent).toHaveLength(beforeOwnerMessage + 1);
    await vi.advanceTimersByTimeAsync(2_000);
    await sendChat(room, owner, 'chat-owner-message-0003', {
      kind: 'message',
      text: 'after slowmode',
      clientTs: 5,
    });
    expect(sent(late).at(-1)).toMatchObject({
      payload: { kind: 'message', text: 'after slowmode' },
    });

    const snapshotRequest = (presenceRevision: number, targets: string[]) =>
      room.fetch(
        new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            roomCode: '000001',
            coordinatorEpoch: 1,
            targets,
            event: { type: 'pro-presence-snapshot', presenceRevision },
          }),
        }),
      );
    expect(
      (
        await snapshotRequest(1, [
          'chat-owner-presence-0001',
          'chat-member-presence-001',
          'chat-late-presence-00001',
        ])
      ).status,
    ).toBe(200);
    expect(await state.storage.get('proChatControlState')).toMatchObject({
      mutedParticipantIds: ['chat-member'],
    });
    expect(
      (await snapshotRequest(2, ['chat-owner-presence-0001', 'chat-late-presence-00001'])).status,
    ).toBe(200);
    expect(await state.storage.get('proChatControlState')).toMatchObject({
      revision: 5,
      mutedParticipantIds: [],
    });
  });

  it('fails privileged PRO chat provenance closed and clears controls on an epoch advance', async () => {
    const authorityBodies: Record<string, unknown>[] = [];
    const authority = proAuthorityNamespace(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      authorityBodies.push(body);
      const allowed =
        (body.permission === 'system.broadcast' &&
          body.i18nKey === 'chat.decode_skip_system_message') ||
        (body.permission === 'bot.result' &&
          body.requestId === 'bot-proof-request-0001' &&
          JSON.stringify(body.result) === JSON.stringify({ kind: 'answer', text: 'verified' }));
      return new originalResponse(
        JSON.stringify(
          allowed
            ? {
                allowed: true,
                memberId: 'member_provenance000000001',
                role: 'controller',
                permission: body.permission,
              }
            : { error: 'PERMISSION_REQUIRED' },
        ),
        { status: allowed ? 200 : 403, headers: { 'content-type': 'application/json' } },
      );
    });
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    });
    const sender = await joinProMember(room, {
      participantId: 'provenance-sender',
      presenceIncarnationId: 'provenance-presence-send',
      jti: 'provenance-ticket-sender1',
    });
    const recipient = await joinProMember(room, {
      participantId: 'provenance-target',
      presenceIncarnationId: 'provenance-presence-target',
      jti: 'provenance-ticket-target1',
    });
    const sendPayload = (eventId: string, payload: Record<string, unknown>) =>
      room.webSocketMessage(
        sender,
        JSON.stringify({ type: 'pro-realtime', version: 1, eventId, channel: 'chat', payload }),
      );
    const start = recipient.sent.length;

    await sendPayload('provenance-system-good1', {
      kind: 'system',
      text: 'ignored client fallback',
      i18nKey: 'chat.decode_skip_system_message',
    });
    await sendPayload('provenance-bot-good-001', {
      kind: 'bot-result',
      requestId: 'bot-proof-request-0001',
      result: { kind: 'answer', text: 'verified' },
    });
    await sendPayload('provenance-bot-forged01', {
      kind: 'bot-result',
      requestId: 'bot-proof-request-0001',
      result: { kind: 'answer', text: 'forged' },
    });
    await sendPayload('provenance-moderation1', { kind: 'freeze', on: true });
    await room.webSocketMessage(
      sender,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'provenance-snapshot-forged',
        channel: 'chat-control-snapshot',
        payload: {
          revision: 999,
          frozen: true,
          filterEnabled: true,
          slowmodeSeconds: 60,
          muted: true,
        },
      }),
    );

    expect(recipient.sent).toHaveLength(start + 2);
    expect(authorityBodies).toContainEqual({
      participantId: 'provenance-sender',
      presenceIncarnationId: 'provenance-presence-send',
      permission: 'system.broadcast',
      i18nKey: 'chat.decode_skip_system_message',
    });
    expect(authorityBodies).toContainEqual({
      participantId: 'provenance-sender',
      presenceIncarnationId: 'provenance-presence-send',
      permission: 'bot.result',
      requestId: 'bot-proof-request-0001',
      result: { kind: 'answer', text: 'verified' },
    });
    expect(await state.storage.get('proChatControlState')).toBeUndefined();

    // A state from the old security epoch must not leak into the new room.
    await state.storage.put('proChatControlState', {
      v: 1,
      roomId: '000001',
      coordinatorEpoch: 1,
      revision: 1,
      frozen: true,
      filterEnabled: false,
      slowmodeSeconds: 0,
      mutedParticipantIds: [],
    });
    const advanced = await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 2,
          targets: [],
          event: { type: 'pro-presence-snapshot', presenceRevision: 1 },
        }),
      }),
    );
    expect(advanced.status).toBe(200);
    expect(await state.storage.get('proChatControlState')).toBeUndefined();
  });

  it('relays BOT failures only from a one-shot observed request across hibernation and reconnect', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
    const authority = proAuthorityNamespace(
      async () =>
        new originalResponse(JSON.stringify({ error: 'PERMISSION_REQUIRED' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const state = new FakeDurableObjectState();
    const env = {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    };
    let room = new workerModule.MusixquareRoom(state, env);
    const sender = await joinProMember(room, {
      participantId: 'bot-failure-sender',
      presenceIncarnationId: 'bot-failure-presence-01',
      jti: 'bot-failure-ticket-00001',
    });
    const attacker = await joinProMember(room, {
      participantId: 'bot-failure-attacker',
      presenceIncarnationId: 'bot-failure-presence-02',
      jti: 'bot-failure-ticket-00002',
    });
    const recipient = await joinProMember(room, {
      participantId: 'bot-failure-recipient',
      presenceIncarnationId: 'bot-failure-presence-03',
      jti: 'bot-failure-ticket-00003',
    });
    const sendChat = (
      targetRoom: InstanceType<WorkerModule['MusixquareRoom']>,
      socket: FakeSocket,
      eventId: string,
      payload: Record<string, unknown>,
    ) =>
      targetRoom.webSocketMessage(
        socket,
        JSON.stringify({ type: 'pro-realtime', version: 1, eventId, channel: 'chat', payload }),
      );

    const requestId = 'bot-terminal-request-0001';
    const recipientStart = recipient.sent.length;
    await sendChat(room, sender, 'bot-terminal-message-0001', {
      kind: 'message',
      text: '//play something',
      clientTs: Date.now(),
      botRequestId: requestId,
    });
    expect(recipient.sent).toHaveLength(recipientStart + 1);
    expect(await state.storage.get('proBotRequestProofs')).toMatchObject({
      roomId: '000001',
      coordinatorEpoch: 1,
      entries: [{ requestId, participantId: 'bot-failure-sender', status: 'pending' }],
    });

    // Another authenticated participant cannot terminate or consume the
    // requester's typing bubble.
    await sendChat(room, attacker, 'bot-terminal-forged-0001', {
      kind: 'bot-result',
      requestId,
      result: { kind: 'failed' },
    });
    expect(recipient.sent).toHaveLength(recipientStart + 1);

    // Recreate the Durable Object and replace the same participant's socket.
    // The proof is durable and participant-scoped rather than tied to the old
    // presence incarnation, so the terminal failure can still be delivered.
    room = new workerModule.MusixquareRoom(state, env);
    const reconnected = await joinProMember(room, {
      participantId: 'bot-failure-sender',
      presenceIncarnationId: 'bot-failure-presence-04',
      ticketSequence: 2,
      jti: 'bot-failure-ticket-00004',
    });
    await sendChat(room, reconnected, 'bot-terminal-failed-0001', {
      kind: 'bot-result',
      requestId,
      result: { kind: 'failed' },
    });
    expect(sent(recipient).at(-1)).toMatchObject({
      payload: { kind: 'bot-result', requestId, result: { kind: 'failed' } },
      sender: { participantId: 'bot-failure-sender' },
    });
    const afterFailure = recipient.sent.length;

    // The consumed tombstone rejects a replay without consulting PRO authority.
    await sendChat(room, reconnected, 'bot-terminal-replay-0001', {
      kind: 'bot-result',
      requestId,
      result: { kind: 'failed' },
    });
    expect(recipient.sent).toHaveLength(afterFailure);
    expect(authority.roomFetch).not.toHaveBeenCalled();

    const limitedRequestId = 'bot-terminal-request-0002';
    await sendChat(room, reconnected, 'bot-terminal-message-0002', {
      kind: 'message',
      text: '//play another song',
      clientTs: Date.now(),
      botRequestId: limitedRequestId,
    });
    await sendChat(room, reconnected, 'bot-terminal-limited-0001', {
      kind: 'bot-result',
      requestId: limitedRequestId,
      result: { kind: 'rate_limited', retryAfterSeconds: 30 },
    });
    expect(sent(recipient).at(-1)).toMatchObject({
      payload: {
        kind: 'bot-result',
        requestId: limitedRequestId,
        result: { kind: 'rate_limited', retryAfterSeconds: 30 },
      },
    });

    await vi.advanceTimersByTimeAsync(60_001);
    await room.alarm();
    await state.flushWaitUntil();
    expect(await state.storage.get('proBotRequestProofs')).toMatchObject({ entries: [] });
  });

  it('rate-limits PRO realtime frames and closes oversized senders without affecting peers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const sender = await joinProMember(room, {
      participantId: 'limited-sender',
      presenceIncarnationId: 'limited-presence-sender',
      jti: 'limited-ticket-sender01',
    });
    const recipient = await joinProMember(room, {
      participantId: 'limited-recipient',
      presenceIncarnationId: 'limited-presence-target',
      jti: 'limited-ticket-target01',
    });
    const recipientStart = recipient.sent.length;
    for (let index = 0; index < 120; index++) {
      await room.webSocketMessage(
        sender,
        JSON.stringify({
          type: 'pro-realtime',
          version: 1,
          eventId: `rate-event-${String(index).padStart(8, '0')}`,
          channel: 'presence',
          payload: { state: 'active' },
        }),
      );
    }
    expect(recipient.sent).toHaveLength(recipientStart + 120);

    await room.webSocketMessage(
      sender,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'rate-event-over-limit',
        channel: 'presence',
        payload: { state: 'active' },
      }),
    );
    expect(sender.closeEvents.at(-1)?.reason).toBe('SIGNALING_RATE_LIMITED');
    expect(recipient.closed).toBe(false);

    const oversized = await joinProMember(room, {
      participantId: 'oversized-sender',
      presenceIncarnationId: 'oversized-presence-send',
      jti: 'oversized-ticket-sender1',
    });
    await room.webSocketMessage(oversized, 'x'.repeat(8 * 1024 + 1));
    expect(oversized.closeEvents.at(-1)?.reason).toBe('SIGNALING_MESSAGE_TOO_LARGE');
    expect(recipient.closed).toBe(false);
  });

  it('decommissions every PRO socket, leaves only a tombstone, and rejects old tickets idempotently', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'));
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const coordinatorRequest = await proWsRequest({
      role: 'coordinator',
      participantId: 'coordinator-device',
      jti: 'coordinator-ticket-0001',
    });
    await room.fetch(coordinatorRequest);
    const coordinator = lastServer();
    await room.fetch(
      await proWsRequest({
        role: 'member',
        participantId: 'signed-member',
        jti: 'member-ticket-0000001',
      }),
    );
    const member = lastServer();
    await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 1,
          targets: ['presence-incarnation-0001'],
          event: { type: 'pro-presence-snapshot', presenceRevision: 1 },
        }),
      }),
    );
    await state.storage.put('unrelatedPersistedState', { shouldBeDeleted: true });
    await state.storage.setAlarm(Date.now() + 60_000);
    const requestId = '12345678-1234-4123-8123-123456789abc';
    const decommissionRequest = () =>
      new Request('https://signaling.internal/internal/admin/v1/decommission', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
        },
        body: JSON.stringify({ roomCode: '000001', requestId }),
      });

    const wrongMethod = await room.fetch(
      new Request('https://signaling.internal/internal/admin/v1/decommission', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
        },
        body: JSON.stringify({ roomCode: '000001', requestId }),
      }),
    );
    expect(wrongMethod.status).toBe(404);
    expect(coordinator.closed).toBe(false);
    expect(member.closed).toBe(false);

    const first = await room.fetch(decommissionRequest());

    expect(first.status).toBe(200);
    expect(JSON.parse(String(first.body))).toEqual({
      ok: true,
      roomCode: '000001',
      status: 'decommissioned',
      changed: true,
    });
    expect(coordinator.closeEvents).toEqual([{ code: 1012, reason: 'PRO_ROOM_DECOMMISSIONED' }]);
    expect(member.closeEvents).toEqual([{ code: 1012, reason: 'PRO_ROOM_DECOMMISSIONED' }]);
    expect(state.storage.deleteAllCalls).toBe(0);
    expect(state.storage.alarmTime).toBeNull();
    expect([...state.storage.data.keys()]).toEqual(['proRoomDecommissioned']);
    expect(await state.storage.get('proRoomDecommissioned')).toEqual({
      v: 1,
      roomCode: '000001',
      requestId,
      decommissionedAtMs: Date.now(),
    });

    const pairCount = FakeWebSocketPair.pairs.length;
    const rejected = await room.fetch(coordinatorRequest);
    expect(rejected.status).toBe(410);
    expect(JSON.parse(String(rejected.body))).toEqual({ error: 'PRO_ROOM_DECOMMISSIONED' });
    expect(FakeWebSocketPair.pairs).toHaveLength(pairCount);

    const residueSocket = new FakeSocket();
    residueSocket.serializeAttachment({
      v: 1,
      role: 'guest',
      roomKind: 'pro',
      roomId: '000001',
      peerId: 'late-residue',
    });
    state.sockets.push(residueSocket);
    await state.storage.put('lateResidue', { shouldBeDeleted: true });
    await state.storage.setAlarm(Date.now() + 60_000);

    const repeated = await room.fetch(decommissionRequest());
    expect(repeated.status).toBe(200);
    expect(JSON.parse(String(repeated.body))).toEqual({
      ok: true,
      roomCode: '000001',
      status: 'decommissioned',
      changed: false,
    });
    expect(state.storage.deleteAllCalls).toBe(0);
    expect([...state.storage.data.keys()]).toEqual(['proRoomDecommissioned']);
    expect(residueSocket.closeEvents).toEqual([{ code: 1012, reason: 'PRO_ROOM_DECOMMISSIONED' }]);
    expect(state.storage.alarmTime).toBeNull();
    expect(coordinator.closeEvents).toHaveLength(1);
    expect(member.closeEvents).toHaveLength(1);
  });

  it('serializes PRO admission behind permanent decommission', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const requestId = '22345678-1234-4123-8123-123456789abc';
    let releaseList!: () => void;
    let markListStarted!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const originalList = state.storage.list.bind(state.storage);
    state.storage.list = async (): Promise<Map<string, unknown>> => {
      markListStarted();
      await listGate;
      return originalList();
    };

    const decommission = room.fetch(
      new Request('https://signaling.internal/internal/admin/v1/decommission', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
        },
        body: JSON.stringify({ roomCode: '000001', requestId }),
      }),
    );
    await listStarted;
    const pairCount = FakeWebSocketPair.pairs.length;
    const lateAdmission = room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'late-coordinator',
        jti: 'late-coordinator-ticket-0001',
      }),
    );
    releaseList();

    expect((await decommission).status).toBe(200);
    const rejected = await lateAdmission;
    expect(rejected.status).toBe(410);
    expect(JSON.parse(String(rejected.body))).toEqual({ error: 'PRO_ROOM_DECOMMISSIONED' });
    expect(FakeWebSocketPair.pairs).toHaveLength(pairCount);
    expect([...state.storage.data.keys()]).toEqual(['proRoomDecommissioned']);
  });

  it('rejects the legacy coordinator developer-dispatch route without forwarding frames', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'coordinator-device',
        presenceIncarnationId: 'presence-incarnation-0001',
        jti: 'coordinator-ticket-0001',
      }),
    );
    const coordinator = lastServer();
    const frame = {
      type: 'developer-command',
      version: 2,
      roomCode: '000001',
      coordinatorEpoch: 1,
      commandId: 'cmd_1234567890123456789012',
      expiresAtMs: Date.now() + 30_000,
      expected: {
        queueItemId: '11111111-1111-4111-8111-111111111111',
        playlistRevision: 3,
        playbackRevision: 7,
      },
      command: {
        type: 'set_effects',
        effects: {
          reverb: { mixPercent: 40, decaySeconds: 1 },
          equalizer: { bandsDb: [0, -2, 0, 4, 6] },
          virtualBass: { strengthPercent: 60 },
          virtualSurround: { widthPercent: 120 },
        },
      },
    };
    const dispatch = (presenceIncarnationId: string) =>
      room.fetch(
        new Request('https://signaling.internal/internal/developer/v1/dispatch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            roomCode: '000001',
            coordinatorEpoch: 1,
            coordinatorParticipantId: 'coordinator-device',
            coordinatorPresenceIncarnationId: presenceIncarnationId,
            developerControlVersion: 2,
            frame,
          }),
        }),
      );

    const initialSentCount = coordinator.sent.length;
    const accepted = await dispatch('presence-incarnation-0001');
    expect(accepted.status).toBe(409);
    expect(JSON.parse(String(accepted.body))).toEqual({ error: 'PRO_COORDINATOR_REMOVED' });
    expect(coordinator.sent).toHaveLength(initialSentCount);

    const sentCount = coordinator.sent.length;
    const rejected = await dispatch('presence-incarnation-stale');
    expect(rejected.status).toBe(409);
    expect(coordinator.sent).toHaveLength(sentCount);
  });

  it('rejects the legacy v3 next-command route without forwarding frames', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'coordinator-device',
        presenceIncarnationId: 'presence-incarnation-0001',
        jti: 'coordinator-ticket-0001',
      }),
    );
    const coordinator = lastServer();
    const frame = {
      type: 'developer-command',
      version: 3,
      roomCode: '000001',
      coordinatorEpoch: 1,
      commandId: 'cmd_1234567890123456789012',
      expiresAtMs: Date.now() + 30_000,
      expected: {
        queueItemId: '11111111-1111-4111-8111-111111111111',
        playlistRevision: 3,
        playbackRevision: 7,
      },
      command: { type: 'next' },
    };
    const accepted = await room.fetch(
      new Request('https://signaling.internal/internal/developer/v1/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: '000001',
          coordinatorEpoch: 1,
          coordinatorParticipantId: 'coordinator-device',
          coordinatorPresenceIncarnationId: 'presence-incarnation-0001',
          developerControlVersion: 3,
          frame,
        }),
      }),
    );

    expect(accepted.status).toBe(409);
    expect(JSON.parse(String(accepted.body))).toEqual({ error: 'PRO_COORDINATOR_REMOVED' });
    expect(sent(coordinator)).not.toContainEqual(frame);
  });

  it('rejects the legacy coordinator invalidation route before parsing or forwarding', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    await room.fetch(
      await proWsRequest({
        role: 'coordinator',
        participantId: 'coordinator-device',
        presenceIncarnationId: 'presence-incarnation-0001',
        jti: 'coordinator-ticket-0001',
      }),
    );
    const coordinator = lastServer();
    const frame = {
      type: 'developer-invalidation',
      version: 1,
      roomCode: '000001',
      coordinatorEpoch: 1,
      revision: 9,
      playlistRevision: 4,
    };
    const addition = {
      type: 'pro-queue-addition',
      version: 1,
      roomCode: '000001',
      coordinatorEpoch: 1,
      playlistRevision: 4,
      eventId: 'qa_000001_4_9',
      actorName: 'Studio bot',
      count: 25,
      firstTitle: 'Gangnam Style',
    };
    const invalidate = (
      presenceIncarnationId: string,
      nextFrame: unknown = frame,
      nextAddition: unknown = undefined,
    ) =>
      room.fetch(
        new Request('https://signaling.internal/internal/developer/v1/invalidate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            roomCode: '000001',
            coordinatorEpoch: 1,
            coordinatorParticipantId: 'coordinator-device',
            coordinatorPresenceIncarnationId: presenceIncarnationId,
            developerControlVersion: 1,
            frame: nextFrame,
            ...(nextAddition === undefined ? {} : { addition: nextAddition }),
          }),
        }),
      );

    const initialSentCount = coordinator.sent.length;
    const accepted = await invalidate('presence-incarnation-0001');
    expect(accepted.status).toBe(409);
    expect(JSON.parse(String(accepted.body))).toEqual({ error: 'PRO_COORDINATOR_REMOVED' });
    expect(coordinator.sent).toHaveLength(initialSentCount);

    const withAddition = await invalidate('presence-incarnation-0001', frame, addition);
    expect(withAddition.status).toBe(409);
    expect(coordinator.sent).toHaveLength(initialSentCount);

    const sentCount = coordinator.sent.length;
    const stale = await invalidate('presence-incarnation-stale');
    expect(stale.status).toBe(409);
    expect(coordinator.sent).toHaveLength(sentCount);

    const malformed = await invalidate('presence-incarnation-0001', {
      ...frame,
      unexpected: true,
    });
    expect(malformed.status).toBe(409);
    expect(coordinator.sent).toHaveLength(sentCount);

    const malformedAddition = await invalidate('presence-incarnation-0001', frame, {
      ...addition,
      actorName: 'x'.repeat(31),
    });
    expect(malformedAddition.status).toBe(409);
    expect(coordinator.sent).toHaveLength(sentCount);

    const malformedTitle = await invalidate('presence-incarnation-0001', frame, {
      ...addition,
      firstTitle: 'bad\u202ename',
    });
    expect(malformedTitle.status).toBe(409);
    expect(coordinator.sent).toHaveLength(sentCount);

    const sendAttempts: unknown[] = [];
    const originalSend = coordinator.send.bind(coordinator);
    coordinator.send = (raw: string) => {
      sendAttempts.push(JSON.parse(raw));
      throw new Error('socket send failed');
    };
    const failedInvalidation = await invalidate('presence-incarnation-0001', frame, addition);
    expect(failedInvalidation.status).toBe(409);
    expect(sendAttempts).toEqual([]);
    coordinator.send = originalSend;
  });

  it('advancing a PRO room epoch closes every prior-epoch member and rejects stale tickets', async () => {
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

    expect(oldCoordinator.closeEvents.at(-1)?.reason).toBe('PRO_ROOM_EPOCH_ADVANCED');
    expect(oldMember.closeEvents.at(-1)?.reason).toBe('PRO_ROOM_EPOCH_ADVANCED');
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

  it('reconnects an owner identity after a PIN security epoch and closes revoked members', async () => {
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

    expect(oldOwner.closeEvents.at(-1)?.reason).toBe('PRO_ROOM_EPOCH_ADVANCED');
    expect(revokedMember.closeEvents.at(-1)?.reason).toBe('PRO_ROOM_EPOCH_ADVANCED');
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

    expect(first.closeEvents.at(-1)?.reason).toBe('PRO_MEMBER_REPLACED');
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
    expect(live.closeEvents.at(-1)?.reason).toBe('PRO_MEMBER_REPLACED');
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

  it('admits at most 100 equal PRO members', async () => {
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

    for (let index = 0; index < 99; index++) {
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

    expect(rejected.closeEvents.at(-1)?.reason).toBe('ROOM_MEMBER_LIMIT_REACHED');
    expect(sent(rejected)[0]).toMatchObject({ message: 'ROOM_MEMBER_LIMIT_REACHED' });
    expect(coordinator.closed).toBe(false);
  });

  it('rehydrates at most 100 equal PRO members', () => {
    const state = new FakeDurableObjectState();
    const coordinator = new FakeSocket();
    coordinator.serializeAttachment({
      v: 1,
      roomKind: 'pro',
      role: 'member',
      roomId: '000001',
      peerId: 'rehydrated-coordinator',
      participantId: 'rehydrated-coordinator',
      displayName: 'Peer 0',
      coordinatorEpoch: 1,
      ticketJti: 'rehydrated-coordinator-ticket',
      presenceIncarnationId: 'rehydrated-coordinator-presence',
      ticketSequence: 1,
      auth: 'ok',
    });
    const members = Array.from({ length: 100 }, (_, index) => {
      const member = new FakeSocket();
      member.serializeAttachment({
        v: 1,
        roomKind: 'pro',
        role: 'member',
        roomId: '000001',
        peerId: `rehydrated-member-${index}`,
        participantId: `rehydrated-member-${index}`,
        displayName: `Peer ${index + 1}`,
        coordinatorEpoch: 1,
        ticketJti: `rehydrated-member-ticket-${index}`,
        presenceIncarnationId: `rehydrated-member-presence-${index}`,
        ticketSequence: 1,
        auth: 'ok',
      });
      return member;
    });
    state.sockets.push(coordinator, ...members);

    new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });

    expect(members.slice(0, 99).every((member) => !member.closed)).toBe(true);
    expect(members[99]?.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'ROOM_MEMBER_LIMIT_REACHED',
    });
    expect(coordinator.closed).toBe(false);
  });

  it('rejects an older same-epoch member ticket after a newer ticket has connected', async () => {
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
    expect(first.closeEvents.at(-1)?.reason).toBe('PRO_MEMBER_REPLACED');
    expect(newer.closed).toBe(false);

    await room.fetch(oldRequest);
    const replay = lastServer();
    expect(replay.closed).toBe(true);
    expect(sent(replay)[0]).toMatchObject({ message: 'PRO_SIGNALING_TICKET_REPLAYED' });
    expect(newer.closed).toBe(false);
  });

  it('closes coordinator-era PRO attachments during hibernation rehydration', () => {
    const state = new FakeDurableObjectState();
    const legacyCoordinator = new FakeSocket();
    legacyCoordinator.serializeAttachment({
      v: 1,
      roomKind: 'pro',
      role: 'host',
      roomId: '000001',
      peerId: '000001',
      participantId: 'legacy-coordinator',
      coordinatorEpoch: 1,
      ticketJti: 'legacy-coordinator-ticket',
      auth: 'ok',
    });
    state.sockets.push(legacyCoordinator);

    new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });

    expect(legacyCoordinator.closeEvents).toEqual([
      { code: 1012, reason: 'PRO_ROOM_PROTOCOL_UPGRADED' },
    ]);
  });

  it('drops stale PRO attachments after hibernation before accepting the current epoch', async () => {
    const state = new FakeDurableObjectState();
    state.storage.data.set('proRoomMeta', {
      v: 2,
      kind: 'pro',
      roomId: '000001',
      coordinatorEpoch: 2,
    });
    const staleCoordinator = new FakeSocket();
    staleCoordinator.serializeAttachment({
      v: 1,
      roomKind: 'pro',
      role: 'member',
      roomId: '000001',
      peerId: 'old-coordinator',
      participantId: 'old-coordinator',
      displayName: 'Old peer 0',
      coordinatorEpoch: 1,
      ticketJti: 'old-coordinator-ticket01',
      presenceIncarnationId: 'old-coordinator-presence1',
      ticketSequence: 1,
      auth: 'ok',
    });
    const staleMember = new FakeSocket();
    staleMember.serializeAttachment({
      v: 1,
      roomKind: 'pro',
      role: 'member',
      roomId: '000001',
      peerId: 'old-member',
      participantId: 'old-member',
      displayName: 'Old peer 1',
      coordinatorEpoch: 1,
      ticketJti: 'old-member-ticket-0001',
      presenceIncarnationId: 'old-member-presence-0001',
      ticketSequence: 1,
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

    expect(staleCoordinator.closeEvents.at(-1)?.reason).toBe('PRO_ROOM_EPOCH_STALE');
    expect(staleMember.closeEvents.at(-1)?.reason).toBe('PRO_ROOM_EPOCH_STALE');
    expect(currentCoordinator.closed).toBe(false);
    expect(currentCoordinator.deserializeAttachment()).toMatchObject({
      roomKind: 'pro',
      coordinatorEpoch: 2,
      participantId: 'current-coordinator',
    });
  });

  it('retains the temporary legacy query-auth path for cached host clients', async () => {
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

  it('keeps a current host pending until its first-frame secret is authenticated', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state);

    await room.fetch(wsRequest('123456', 'host', 'host-frame'));
    const host = lastServer();

    expect(host.closed).toBe(false);
    expect(sent(host)).toEqual([]);
    expect(host.deserializeAttachment()).toMatchObject({
      role: 'host',
      peerId: 'host-frame',
      auth: 'pending',
      authDeadline: expect.any(Number),
    });
    expect(await state.storage.get('roomMeta')).toBeUndefined();

    await room.webSocketMessage(
      host,
      JSON.stringify({ type: 'host-auth', secret: 'frame-secret-a' }),
    );

    expect(host.deserializeAttachment()).toMatchObject({
      role: 'host',
      peerId: 'host-frame',
      secret: 'frame-secret-a',
      auth: 'ok',
    });
    expect(sent(host)[0]).toMatchObject({ type: 'peer-open', roomId: '123456' });
    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'frame-secret-a',
      hostPeerId: 'host-frame',
    });
  });

  it('closes a pending host whose first frame is not a valid host-auth message', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state);

    await room.fetch(wsRequest('123456', 'host', 'invalid-frame-host'));
    const host = lastServer();
    await room.webSocketMessage(host, JSON.stringify({ type: 'signal', to: 'guest-1' }));

    expect(host.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'HOST_AUTH_FIRST_FRAME_INVALID',
    });
    expect(await state.storage.get('roomMeta')).toBeUndefined();
  });

  it('never evicts the live host when a pending replacement proves the wrong secret', async () => {
    const { room, host } = await createHostRoom();

    await room.fetch(wsRequest('123456', 'host', 'attacker-host'));
    const attacker = lastServer();
    expect(host.closed).toBe(false);

    await room.webSocketMessage(
      attacker,
      JSON.stringify({ type: 'host-auth', secret: 'wrong-secret' }),
    );

    expect(attacker.closeEvents.at(-1)?.reason).toBe('ROOM_ALREADY_ACTIVE');
    expect(host.closed).toBe(false);
    const guest = await joinGuest(room, 'guest-after-attack');
    expect(guest.closed).toBe(false);
  });

  it('keeps the live host and metadata authoritative when replacement persistence fails', async () => {
    const { room, state, host } = await createHostRoom();
    const originalPut = state.storage.put.bind(state.storage);
    state.storage.put = vi.fn(async (key: string, value: unknown) => {
      if (key === 'roomMeta') throw new Error('room metadata unavailable');
      await originalPut(key, value);
    });
    await room.fetch(wsRequest('123456', 'host', 'retrying-host'));
    const candidate = lastServer();

    await expect(
      room.webSocketMessage(candidate, JSON.stringify({ type: 'host-auth', secret: 'secret-a' })),
    ).rejects.toThrow('room metadata unavailable');

    expect(host.closed).toBe(false);
    expect(candidate.deserializeAttachment()).toMatchObject({
      auth: 'pending',
      authStarted: false,
    });
    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'secret-a',
      hostPeerId: 'host-1',
    });

    state.storage.put = originalPut;
    await room.webSocketMessage(
      candidate,
      JSON.stringify({ type: 'host-auth', secret: 'secret-a' }),
    );
    expect(host.closeEvents.at(-1)?.reason).toBe('HOST_REPLACED');
    expect(candidate.closed).toBe(false);
  });

  it('restores the live host when a replacement socket closes during persistence', async () => {
    const { room, state, host } = await createHostRoom();
    const originalPut = state.storage.put.bind(state.storage);
    let releaseReplacementWrite!: () => void;
    let markReplacementWriteEntered!: () => void;
    const replacementWriteEntered = new Promise<void>((resolve) => {
      markReplacementWriteEntered = resolve;
    });
    const replacementWriteGate = new Promise<void>((resolve) => {
      releaseReplacementWrite = resolve;
    });
    state.storage.put = vi.fn(async (key: string, value: unknown) => {
      if (key === 'roomMeta' && (value as Partial<RoomMeta>)?.hostPeerId === 'closed-replacement') {
        markReplacementWriteEntered();
        await replacementWriteGate;
      }
      await originalPut(key, value);
    });

    await room.fetch(wsRequest('123456', 'host', 'closed-replacement'));
    const replacement = lastServer();
    const authenticate = room.webSocketMessage(
      replacement,
      JSON.stringify({ type: 'host-auth', secret: 'secret-a' }),
    );
    await replacementWriteEntered;
    replacement.close(1000, 'client disconnected');
    releaseReplacementWrite();
    await authenticate;

    expect(host.closed).toBe(false);
    expect(replacement.closeEvents.at(-1)?.reason).toBe('HOST_AUTH_SOCKET_CLOSED');
    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'secret-a',
      hostPeerId: 'host-1',
      hostReleaseAt: 0,
    });
  });

  it('replaces the live host only after a first-frame reconnect proves ownership', async () => {
    const { room, host } = await createHostRoom();

    await room.fetch(wsRequest('123456', 'host', 'host-frame-reconnect'));
    const reconnect = lastServer();
    expect(host.closed).toBe(false);

    await room.webSocketMessage(
      reconnect,
      JSON.stringify({ type: 'host-auth', secret: 'secret-a' }),
    );

    expect(host.closeEvents.at(-1)?.reason).toBe('HOST_REPLACED');
    expect(reconnect.closed).toBe(false);
    expect(sent(reconnect)[0]).toMatchObject({ type: 'peer-open', roomId: '123456' });
  });

  it('serializes a stale host close behind an authenticated replacement write', async () => {
    const { room, state, host } = await createHostRoom();
    const originalPut = state.storage.put.bind(state.storage);
    let releaseReplacementWrite!: () => void;
    let markReplacementWriteEntered!: () => void;
    const replacementWriteEntered = new Promise<void>((resolve) => {
      markReplacementWriteEntered = resolve;
    });
    const replacementWriteGate = new Promise<void>((resolve) => {
      releaseReplacementWrite = resolve;
    });
    state.storage.put = vi.fn(async (key: string, value: unknown) => {
      if (key === 'roomMeta' && (value as Partial<RoomMeta>)?.hostPeerId === 'replacement-host') {
        markReplacementWriteEntered();
        await replacementWriteGate;
      }
      await originalPut(key, value);
    });

    await room.fetch(wsRequest('123456', 'host', 'replacement-host'));
    const replacement = lastServer();
    const authenticate = room.webSocketMessage(
      replacement,
      JSON.stringify({ type: 'host-auth', secret: 'secret-a' }),
    );
    await replacementWriteEntered;
    const staleClose = room.webSocketClose(host);

    releaseReplacementWrite();
    await Promise.all([authenticate, staleClose]);

    expect(replacement.closed).toBe(false);
    expect(host.closeEvents.at(-1)?.reason).toBe('HOST_REPLACED');
    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'secret-a',
      hostPeerId: 'replacement-host',
      hostReleaseAt: 0,
    });
  });

  it('does not enqueue duplicate host-auth frames while persistence is in flight', async () => {
    const { room, state } = await createHostRoom();
    const originalPut = state.storage.put.bind(state.storage);
    let releaseReplacementWrite!: () => void;
    let markReplacementWriteEntered!: () => void;
    const replacementWriteEntered = new Promise<void>((resolve) => {
      markReplacementWriteEntered = resolve;
    });
    const replacementWriteGate = new Promise<void>((resolve) => {
      releaseReplacementWrite = resolve;
    });
    let replacementWriteCount = 0;
    state.storage.put = vi.fn(async (key: string, value: unknown) => {
      if (
        key === 'roomMeta' &&
        (value as Partial<RoomMeta>)?.hostPeerId === 'single-attempt-host'
      ) {
        replacementWriteCount += 1;
        markReplacementWriteEntered();
        await replacementWriteGate;
      }
      await originalPut(key, value);
    });

    await room.fetch(wsRequest('123456', 'host', 'single-attempt-host'));
    const candidate = lastServer();
    const frame = JSON.stringify({ type: 'host-auth', secret: 'secret-a' });
    const firstAttempt = room.webSocketMessage(candidate, frame);
    await replacementWriteEntered;
    await room.webSocketMessage(candidate, frame);

    expect(replacementWriteCount).toBe(1);
    releaseReplacementWrite();
    await firstAttempt;
    expect(sent(candidate)).toContainEqual({
      type: 'peer-open',
      peerId: '123456',
      roomId: '123456',
    });
  });

  it('serializes simultaneous first-frame host claims so only one secret owns the room', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state);
    await room.fetch(wsRequest('123456', 'host', 'first-host'));
    const first = lastServer();
    await room.fetch(wsRequest('123456', 'host', 'second-host'));
    const second = lastServer();

    await Promise.all([
      room.webSocketMessage(first, JSON.stringify({ type: 'host-auth', secret: 'first-secret' })),
      room.webSocketMessage(second, JSON.stringify({ type: 'host-auth', secret: 'second-secret' })),
    ]);

    expect([first, second].filter((socket) => !socket.closed)).toHaveLength(1);
    expect([first, second].filter((socket) => sent(socket)[0]?.type === 'peer-open')).toHaveLength(
      1,
    );
    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'first-secret',
      hostPeerId: 'first-host',
    });
  });

  it('bounds silent host candidates without touching an authenticated host', async () => {
    const { room, host } = await createHostRoom();
    const pending: FakeSocket[] = [];
    for (let index = 0; index < 5; index++) {
      await room.fetch(wsRequest('123456', 'host', `pending-host-${index}`));
      pending.push(lastServer());
    }

    expect(pending[0]?.closeEvents.at(-1)?.reason).toBe('HOST_AUTH_CANDIDATE_REPLACED');
    expect(pending.slice(1).every((socket) => !socket.closed)).toBe(true);
    expect(host.closed).toBe(false);
  });

  it('rejects overflow instead of rotating host candidates that already sent auth', async () => {
    const { room, host } = await createHostRoom();
    const authenticating: FakeSocket[] = [];
    for (let index = 0; index < 4; index++) {
      await room.fetch(wsRequest('123456', 'host', `auth-started-host-${index}`));
      const candidate = lastServer();
      candidate.serializeAttachment({
        ...(candidate.deserializeAttachment() as Record<string, unknown>),
        authStarted: true,
      });
      authenticating.push(candidate);
    }

    await room.fetch(wsRequest('123456', 'host', 'overflow-host'));
    const overflow = lastServer();

    expect(authenticating.every((socket) => !socket.closed)).toBe(true);
    expect(overflow.closeEvents.at(-1)?.reason).toBe('HOST_PENDING_LIMIT_REACHED');
    expect(host.closed).toBe(false);
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

  it('projects one verified member across account devices and strips spoofed identity metadata', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    await room.fetch(wsRequest('123456', 'host', 'host-1', 'room-secret-one'));
    const host = lastServer();
    const first = await joinGuest(room, 'minsu-phone', {
      reconnectSecret: 'a'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'minsu-phone',
        role: 'guest',
      }),
    });
    const second = await joinGuest(room, 'minsu-laptop', {
      reconnectSecret: 'b'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'minsu-laptop',
        role: 'guest',
      }),
    });

    const firstIdentity = first.deserializeAttachment() as Record<string, unknown>;
    const secondIdentity = second.deserializeAttachment() as Record<string, unknown>;
    expect(firstIdentity.memberId).toMatch(/^member_[A-Za-z0-9_-]{22}$/);
    expect(secondIdentity).toMatchObject({
      memberId: firstIdentity.memberId,
      memberDisplayNumber: firstIdentity.memberDisplayNumber,
      memberNickname: 'Minsu',
    });

    await room.webSocketMessage(
      first,
      JSON.stringify({
        type: 'signal-offer',
        to: 'host',
        sdp: { type: 'offer', sdp: 'offer-sdp' },
        metadata: { label: 'data' },
        memberIdentity: {
          memberId: 'member_spoofedxxxxxxxxxxxxxx',
          memberDisplayNumber: 99,
          nickname: 'Spoofed',
          isAuthenticated: true,
        },
        accountSubject: 'sub_spoofedxxxxxxxxxxxxxxxx',
      }),
    );
    expect(sent(host).at(-1)).toEqual({
      type: 'signal-offer',
      from: 'minsu-phone',
      sdp: { type: 'offer', sdp: 'offer-sdp' },
      metadata: { label: 'data' },
      memberIdentity: {
        memberId: firstIdentity.memberId,
        memberDisplayNumber: firstIdentity.memberDisplayNumber,
        nickname: 'Minsu',
        isAuthenticated: true,
      },
    });
  });

  it('deletes only the caller-bound account identity and clears every live device for it', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    await room.fetch(wsRequest('123456', 'host', 'host-1', 'room-secret-one'));
    const host = lastServer();
    const first = await joinGuest(room, 'delete-phone', {
      reconnectSecret: 'g'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'delete-phone',
        role: 'guest',
      }),
    });
    const second = await joinGuest(room, 'delete-laptop', {
      reconnectSecret: 'h'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'delete-laptop',
        role: 'guest',
      }),
    });

    await room.webSocketMessage(
      first,
      JSON.stringify({
        type: 'account-identity-delete',
        memberId: 'member_zyxwvutsrqponmlkjihgfe',
      }),
    );
    expect(first.deserializeAttachment()).toHaveProperty('memberId');

    await room.webSocketMessage(
      first,
      JSON.stringify({
        type: 'account-identity-delete',
        deletionAssertion: await standardAccountAssertion({
          peerId: 'delete-phone',
          role: 'guest',
        }),
      }),
    );
    expect(first.deserializeAttachment()).toHaveProperty('memberId');

    await room.webSocketMessage(
      first,
      JSON.stringify({
        type: 'account-identity-delete',
        deletionAssertion: await standardAccountDeletionAssertion({
          peerId: 'delete-phone',
          role: 'guest',
        }),
      }),
    );

    expect(first.deserializeAttachment()).not.toHaveProperty('memberId');
    expect(second.deserializeAttachment()).not.toHaveProperty('memberId');
    expect(await state.storage.get('standardRoomAccountMembers')).toEqual({ v: 1, entries: [] });
    const deletionFrames = sent(host).filter(
      (frame) => frame.type === 'account-member-updated' && frame.clearReason === 'deleted',
    );
    expect(deletionFrames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: 'delete-phone', memberIdentity: null }),
        expect.objectContaining({ peerId: 'delete-laptop', memberIdentity: null }),
      ]),
    );
  });

  it('deletes every account device after all signaling identity leases expire', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'));
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    await room.fetch(wsRequest('123456', 'host', 'host-1', 'room-secret-one'));
    const host = lastServer();
    const first = await joinGuest(room, 'expired-delete-phone', {
      reconnectSecret: 'i'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'expired-delete-phone',
        role: 'guest',
      }),
    });
    const second = await joinGuest(room, 'expired-delete-laptop', {
      reconnectSecret: 'j'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'expired-delete-laptop',
        role: 'guest',
      }),
    });
    const memberId = (first.deserializeAttachment() as Record<string, unknown>).memberId;
    expect(memberId).toMatch(/^member_[A-Za-z0-9_-]{22}$/);

    vi.advanceTimersByTime(61_001);
    await room.alarm();
    expect(first.deserializeAttachment()).not.toHaveProperty('memberId');
    expect(second.deserializeAttachment()).not.toHaveProperty('memberId');
    expect(await state.storage.get('standardRoomAccountMembers')).toMatchObject({
      entries: [expect.objectContaining({ memberId })],
    });
    host.sent.length = 0;

    const deletionProof = await standardAccountDeletionAssertion({
      peerId: 'expired-delete-phone',
      role: 'guest',
    });
    await room.webSocketMessage(
      first,
      JSON.stringify({
        type: 'account-identity-delete',
        deletionAssertion: deletionProof,
      }),
    );

    expect(await state.storage.get('standardRoomAccountMembers')).toEqual({ v: 1, entries: [] });
    expect(sent(host)).toContainEqual({
      type: 'account-member-deleted',
      memberId,
    });
  });

  it('cannot replay another account device proof to delete its room identity', async () => {
    const otherAccountId = 'acct_zyxwvutsrqponmlkjihgfe';
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    await room.fetch(wsRequest('123456', 'host', 'host-1', 'room-secret-one'));
    const host = lastServer();
    const first = await joinGuest(room, 'account-a-device', {
      reconnectSecret: 'k'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'account-a-device',
        role: 'guest',
      }),
    });
    const second = await joinGuest(room, 'account-b-device', {
      reconnectSecret: 'l'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'account-b-device',
        role: 'guest',
        accountId: otherAccountId,
        nickname: 'Jisu',
      }),
    });
    const firstMemberId = (first.deserializeAttachment() as Record<string, unknown>).memberId;
    const secondMemberId = (second.deserializeAttachment() as Record<string, unknown>).memberId;
    host.sent.length = 0;

    const otherDeviceProof = await standardAccountDeletionAssertion({
      peerId: 'account-b-device',
      role: 'guest',
      accountId: otherAccountId,
    });
    await room.webSocketMessage(
      first,
      JSON.stringify({
        type: 'account-identity-delete',
        deletionAssertion: otherDeviceProof,
      }),
    );

    expect(first.deserializeAttachment()).toHaveProperty('memberId', firstMemberId);
    expect(second.deserializeAttachment()).toHaveProperty('memberId', secondMemberId);
    expect(await state.storage.get('standardRoomAccountMembers')).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ memberId: firstMemberId }),
        expect.objectContaining({ memberId: secondMemberId }),
      ]),
    });
    expect(sent(host)).not.toContainEqual(
      expect.objectContaining({ type: 'account-member-deleted' }),
    );
  });

  it('does not accept the legacy shared assertion secret for a standard-room identity', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_AUTH_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    await room.fetch(wsRequest('123456', 'host', 'host-1', 'room-secret-one'));
    const guest = await joinGuest(room, 'legacy-secret-guest', {
      reconnectSecret: 'z'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'legacy-secret-guest',
        role: 'guest',
      }),
    });

    expect(guest.deserializeAttachment()).not.toHaveProperty('memberId');
    expect(sent(guest)[0]).not.toHaveProperty('memberIdentity');
  });

  it('keeps equal nicknames separate and propagates only signed profile refreshes', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    await room.fetch(wsRequest('123456', 'host', 'host-1', 'room-secret-one'));
    const host = lastServer();
    const minsu = await joinGuest(room, 'account-a-device', {
      reconnectSecret: 'c'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'account-a-device',
        role: 'guest',
        nickname: 'Same Name',
      }),
    });
    const other = await joinGuest(room, 'account-b-device', {
      reconnectSecret: 'd'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'account-b-device',
        role: 'guest',
        nickname: 'Same Name',
        accountId: 'acct_zyxwvutsrqponmlkjihgfe',
      }),
    });
    expect((minsu.deserializeAttachment() as Record<string, unknown>).memberId).not.toBe(
      (other.deserializeAttachment() as Record<string, unknown>).memberId,
    );

    const refreshed = await standardAccountAssertion({
      peerId: 'account-a-device',
      role: 'guest',
      nickname: 'New Name',
    });
    await room.webSocketMessage(
      minsu,
      JSON.stringify({ type: 'account-identity-refresh', accountAssertion: refreshed }),
    );
    expect(sent(minsu).at(-1)).toMatchObject({
      type: 'account-identity',
      memberIdentity: { nickname: 'New Name' },
    });
    expect(sent(host).at(-1)).toMatchObject({
      type: 'account-member-updated',
      peerId: 'account-a-device',
      memberIdentity: { nickname: 'New Name' },
    });
    expect((other.deserializeAttachment() as Record<string, unknown>).memberNickname).toBe(
      'Same Name',
    );
  });

  it('does not reuse a remembered member number for a different account after departure', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    await room.fetch(wsRequest('123456', 'host', 'host-1', 'room-secret-one'));
    const first = await joinGuest(room, 'departing-account', {
      reconnectSecret: 'e'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'departing-account',
        role: 'guest',
      }),
    });
    const firstNumber = (first.deserializeAttachment() as Record<string, unknown>)
      .memberDisplayNumber;
    await room.webSocketClose(first);

    const second = await joinGuest(room, 'new-account', {
      reconnectSecret: 'f'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'new-account',
        role: 'guest',
        accountId: 'acct_zyxwvutsrqponmlkjihgfe',
      }),
    });
    const secondNumber = (second.deserializeAttachment() as Record<string, unknown>)
      .memberDisplayNumber;

    expect(firstNumber).toBe(1);
    expect(secondNumber).toBe(2);
  });

  it('anchors account display numbers to the first physical join slot while every device consumes a slot', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    await room.fetch(wsRequest('123456', 'host', 'host-1', 'room-secret-one'));

    const minsuAccount = 'acct_abcdefghijklmnopqrstuv';
    const jisuAccount = 'acct_zyxwvutsrqponmlkjihgfe';
    const minsuSockets: FakeSocket[] = [];
    for (let index = 0; index < 3; index += 1) {
      const peerId = `minsu-device-${index}`;
      minsuSockets.push(
        await joinGuest(room, peerId, {
          reconnectSecret: String(index + 1).repeat(43),
          accountAssertion: await standardAccountAssertion({
            peerId,
            role: 'guest',
            accountId: minsuAccount,
            nickname: 'Minsu',
          }),
        }),
      );
    }
    const jisuSockets: FakeSocket[] = [];
    for (let index = 0; index < 2; index += 1) {
      const peerId = `jisu-device-${index}`;
      jisuSockets.push(
        await joinGuest(room, peerId, {
          reconnectSecret: String(index + 4).repeat(43),
          accountAssertion: await standardAccountAssertion({
            peerId,
            role: 'guest',
            accountId: jisuAccount,
            nickname: 'Jisu',
          }),
        }),
      );
    }
    const anonymous = await joinGuest(room, 'anonymous-peer', {
      reconnectSecret: '6'.repeat(43),
    });

    expect(
      minsuSockets.map(
        (socket) => (socket.deserializeAttachment() as Record<string, unknown>).memberDisplayNumber,
      ),
    ).toEqual([1, 1, 1]);
    expect(
      jisuSockets.map(
        (socket) => (socket.deserializeAttachment() as Record<string, unknown>).memberDisplayNumber,
      ),
    ).toEqual([4, 4]);
    expect(anonymous.deserializeAttachment()).not.toHaveProperty('memberDisplayNumber');
    expect(await state.storage.get('standardRoomAccountMembers')).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ memberDisplayNumber: 1 }),
        expect.objectContaining({ memberDisplayNumber: 4 }),
      ]),
    });
  });

  it('expires signed identity leases and atomically rotates reused room-code generations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'));
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });

    await room.fetch(wsRequest('123456', 'host', 'host-first'));
    const firstHost = lastServer();
    await room.webSocketMessage(
      firstHost,
      JSON.stringify({
        type: 'host-auth',
        secret: 'first-room-secret',
        accountAssertion: await standardAccountAssertion({
          peerId: 'host-first',
          role: 'host',
        }),
      }),
    );
    const firstMemberId = (firstHost.deserializeAttachment() as Record<string, unknown>).memberId;
    expect(firstMemberId).toMatch(/^member_[A-Za-z0-9_-]{22}$/);

    vi.advanceTimersByTime(61_001);
    await room.alarm();
    expect(firstHost.deserializeAttachment()).not.toHaveProperty('memberId');
    expect(sent(firstHost).at(-1)).toEqual({
      type: 'account-identity',
      memberIdentity: null,
      clearReason: 'expired',
    });

    await room.webSocketClose(firstHost);
    vi.advanceTimersByTime(61_001);
    await room.alarm();
    expect(await state.storage.get('roomMeta')).toEqual({
      v: 1,
      roomSecret: null,
      roomPassword: '',
      hostPeerId: null,
      hostReleaseAt: 0,
    });
    expect(await state.storage.get('standardRoomAccountMembers')).toEqual({ v: 1, entries: [] });
    expect(await state.storage.get('guestReconnectBindings')).toEqual({ v: 1, entries: [] });
    expect(state.storage.transactionCalls).toBeGreaterThan(0);

    await room.fetch(wsRequest('123456', 'host', 'host-second'));
    const secondHost = lastServer();
    await room.webSocketMessage(
      secondHost,
      JSON.stringify({
        type: 'host-auth',
        secret: 'second-room-secret',
        accountAssertion: await standardAccountAssertion({
          peerId: 'host-second',
          role: 'host',
        }),
      }),
    );
    const secondMemberId = (secondHost.deserializeAttachment() as Record<string, unknown>).memberId;
    expect(secondMemberId).toMatch(/^member_[A-Za-z0-9_-]{22}$/);
    expect(secondMemberId).not.toBe(firstMemberId);
  });

  it('closes a pending guest whose first frame is not a valid guest-auth message', async () => {
    const { room } = await createHostRoom();
    await room.fetch(wsRequest('123456', 'guest', 'invalid-frame-guest'));
    const guest = lastServer();

    await room.webSocketMessage(guest, JSON.stringify({ type: 'signal-offer', to: 'host' }));

    expect(guest.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'GUEST_AUTH_FIRST_FRAME_INVALID',
    });
    expect(sent(guest)).not.toContainEqual(expect.objectContaining({ type: 'peer-open' }));
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
      { bucketMinute: Math.floor(Date.now() / 60000), event: 'host_legacy_url_auth' },
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

  it('relays a valid optional negotiation ID and rejects malformed IDs on every SDP/ICE path', async () => {
    const { room, host } = await createHostRoom();
    const guest = await joinGuest(room, 'guest-1');
    const negotiationId = 'negotiation_0001';
    const guestFrames = [
      {
        type: 'signal-offer',
        to: 'host',
        sdp: { type: 'offer', sdp: 'offer-sdp' },
        negotiationId,
      },
      {
        type: 'signal-candidate',
        to: 'host',
        candidate: { candidate: 'candidate:guest' },
        negotiationId,
      },
      {
        type: 'media-answer',
        to: 'host',
        callId: 'call-1',
        sdp: { type: 'answer', sdp: 'media-answer-sdp' },
        negotiationId,
      },
    ];
    const hostFrames = [
      {
        type: 'signal-answer',
        to: 'guest-1',
        sdp: { type: 'answer', sdp: 'answer-sdp' },
        negotiationId,
      },
      {
        type: 'signal-candidate',
        to: 'guest-1',
        candidate: { candidate: 'candidate:host' },
        negotiationId,
      },
      {
        type: 'media-offer',
        to: 'guest-1',
        callId: 'call-1',
        sdp: { type: 'offer', sdp: 'media-offer-sdp' },
        negotiationId,
      },
    ];

    for (const frame of guestFrames) await room.webSocketMessage(guest, JSON.stringify(frame));
    for (const frame of hostFrames) await room.webSocketMessage(host, JSON.stringify(frame));
    expect(sent(host).filter((frame) => frame.negotiationId === negotiationId)).toHaveLength(3);
    expect(sent(guest).filter((frame) => frame.negotiationId === negotiationId)).toHaveLength(3);

    const hostMessageCount = host.sent.length;
    const guestMessageCount = guest.sent.length;
    for (const frame of guestFrames) {
      await room.webSocketMessage(guest, JSON.stringify({ ...frame, negotiationId: 'too-short' }));
    }
    for (const frame of hostFrames) {
      await room.webSocketMessage(
        host,
        JSON.stringify({ ...frame, negotiationId: 'contains.invalid.chars' }),
      );
    }
    expect(host.sent).toHaveLength(hostMessageCount);
    expect(guest.sent).toHaveLength(guestMessageCount);
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

    const reconnect = room.fetch(wsRequest('123456', 'host', 'host-1', 'secret-a'));
    const reconnectedHost = lastServer();

    releaseCleanup();
    await Promise.all([cleanup, reconnect]);

    expect(sent(reconnectedHost).at(-1)).toMatchObject({ type: 'peer-open' });

    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'secret-a',
      hostPeerId: 'host-1',
      hostReleaseAt: 0,
    });
    expect(await state.storage.get('guestReconnectBindings')).toMatchObject({
      entries: [{ peerId: 'guest-1' }],
    });
    expect(sent(reconnectedHost)).not.toContainEqual({ type: 'peer-left', peerId: 'guest-1' });
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

  it('keeps pending sockets bounded by rotating the oldest silent candidate', async () => {
    const { room, host } = await createHostRoom();
    let oldest!: FakeSocket;
    for (let index = 0; index < 99; index++) {
      await room.fetch(wsRequest('123456', 'guest', 'same-peer'));
      if (index === 0) oldest = lastServer();
      expect(lastServer().closed).toBe(false);
    }

    await room.fetch(wsRequest('123456', 'guest', 'same-peer'));
    const newest = lastServer();

    expect(oldest.closeEvents.at(-1)).toEqual({
      code: 1013,
      reason: 'PENDING_GUEST_SLOT_ROTATED',
    });
    expect(newest.closed).toBe(false);
    expect(sent(newest)).toEqual([]);
    expect(host.closed).toBe(false);
  });

  it('does not let 99 silent pending sockets starve a valid new guest', async () => {
    const { room } = await createHostRoom();
    const silent: FakeSocket[] = [];
    for (let index = 0; index < 99; index++) {
      await room.fetch(wsRequest('123456', 'guest', `silent-${index}`));
      silent.push(lastServer());
    }

    const valid = await joinGuest(room, 'valid-after-silent');

    expect(silent[0]?.closeEvents.at(-1)?.reason).toBe('PENDING_GUEST_SLOT_ROTATED');
    expect(valid.closed).toBe(false);
    expect(sent(valid)[0]).toMatchObject({ type: 'peer-open' });
  });

  it('preserves bounded guest auth already in flight instead of rotating it', async () => {
    const { room } = await createHostRoom();
    const authenticating: FakeSocket[] = [];
    for (let index = 0; index < 99; index++) {
      await room.fetch(wsRequest('123456', 'guest', `auth-started-${index}`));
      const candidate = lastServer();
      candidate.serializeAttachment({
        ...(candidate.deserializeAttachment() as Record<string, unknown>),
        authStarted: true,
      });
      authenticating.push(candidate);
    }

    await room.fetch(wsRequest('123456', 'guest', 'overflow-while-authenticating'));
    const overflow = lastServer();

    expect(authenticating.every((socket) => !socket.closed)).toBe(true);
    expect(overflow.closeEvents.at(-1)?.reason).toBe('ROOM_PENDING_LIMIT_REACHED');
  });

  it('does not let silent pending sockets starve an authenticated reconnect', async () => {
    const { room } = await createHostRoom();
    const original = await joinGuest(room, 'returning-guest');
    const silent: FakeSocket[] = [];
    for (let index = 0; index < 99; index++) {
      await room.fetch(wsRequest('123456', 'guest', `silent-reconnect-${index}`));
      silent.push(lastServer());
    }

    const reconnect = await joinGuest(room, 'returning-guest');

    expect(silent[0]?.closeEvents.at(-1)?.reason).toBe('PENDING_GUEST_SLOT_ROTATED');
    expect(original.closeEvents.at(-1)?.reason).toBe('GUEST_REPLACED');
    expect(reconnect.closed).toBe(false);
  });

  it('allows a bound guest to reconnect while all 99 unique room slots are occupied', async () => {
    const { room } = await createHostRoom();
    const guests: FakeSocket[] = [];
    for (let index = 0; index < 99; index++) {
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

  it('does not enqueue duplicate guest-auth frames while persistence is in flight', async () => {
    const { room, state } = await createHostRoom();
    const originalPut = state.storage.put.bind(state.storage);
    let releaseBindingWrite!: () => void;
    let markBindingWriteEntered!: () => void;
    const bindingWriteEntered = new Promise<void>((resolve) => {
      markBindingWriteEntered = resolve;
    });
    const bindingWriteGate = new Promise<void>((resolve) => {
      releaseBindingWrite = resolve;
    });
    let bindingWriteCount = 0;
    state.storage.put = vi.fn(async (key: string, value: unknown) => {
      if (key === 'guestReconnectBindings') {
        bindingWriteCount += 1;
        markBindingWriteEntered();
        await bindingWriteGate;
      }
      await originalPut(key, value);
    });

    await room.fetch(wsRequest('123456', 'guest', 'single-attempt-guest'));
    const guest = lastServer();
    const frame = JSON.stringify({
      type: 'guest-auth',
      password: '',
      reconnectSecret: DEFAULT_RECONNECT_SECRET,
    });
    const firstAttempt = room.webSocketMessage(guest, frame);
    await bindingWriteEntered;
    await room.webSocketMessage(guest, frame);

    expect(bindingWriteCount).toBe(1);
    releaseBindingWrite();
    await firstAttempt;
    expect(sent(guest)).toContainEqual({
      type: 'peer-open',
      peerId: 'single-attempt-guest',
      roomId: '123456',
    });
  });

  it('removes a guest that closes while its authentication write is in flight', async () => {
    const { room, state } = await createHostRoom();
    const originalPut = state.storage.put.bind(state.storage);
    let releaseBindingWrite!: () => void;
    let markBindingWriteEntered!: () => void;
    const bindingWriteEntered = new Promise<void>((resolve) => {
      markBindingWriteEntered = resolve;
    });
    const bindingWriteGate = new Promise<void>((resolve) => {
      releaseBindingWrite = resolve;
    });
    state.storage.put = vi.fn(async (key: string, value: unknown) => {
      if (key === 'guestReconnectBindings') {
        markBindingWriteEntered();
        await bindingWriteGate;
      }
      await originalPut(key, value);
    });

    await room.fetch(wsRequest('123456', 'guest', 'closing-during-auth'));
    const guest = lastServer();
    const authenticate = room.webSocketMessage(
      guest,
      JSON.stringify({
        type: 'guest-auth',
        password: '',
        reconnectSecret: DEFAULT_RECONNECT_SECRET,
      }),
    );
    await bindingWriteEntered;
    guest.close(1000, 'client disconnected');
    const close = room.webSocketClose(guest);

    releaseBindingWrite();
    await Promise.all([authenticate, close]);

    const internals = room as unknown as { guests: Map<string, FakeSocket> };
    expect(internals.guests.has('closing-during-auth')).toBe(false);
    const legitimateGuest = await joinGuest(room, 'legitimate-after-close-race');
    expect(legitimateGuest.closed).toBe(false);
    expect(sent(legitimateGuest)[0]).toMatchObject({ type: 'peer-open' });
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
    expect(guest.deserializeAttachment()).toMatchObject({ auth: 'pending', authStarted: false });
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

  it('keeps password-pending handshakes separate from admitted guest capacity', async () => {
    const { room, host } = await createHostRoom();

    for (let index = 0; index < 49; index++) {
      expect((await joinGuest(room, `guest-${index}`)).closed).toBe(false);
    }
    await room.webSocketMessage(
      host,
      JSON.stringify({ type: 'room-password-set', password: '12345678' }),
    );
    for (let index = 49; index < 99; index++) {
      await room.fetch(wsRequest('123456', 'guest', `guest-${index}`));
      expect(lastServer().closed).toBe(false);
    }

    await room.fetch(wsRequest('123456', 'guest', 'guest-over-limit'));
    const additionalPending = lastServer();

    expect(additionalPending.closed).toBe(false);
    expect(additionalPending.deserializeAttachment()).toMatchObject({ auth: 'pending' });
    expect(host.closed).toBe(false);
  });

  it('rechecks the 99-guest ceiling while simultaneous pending auth is serialized', async () => {
    const { room, host } = await createHostRoom();
    for (let index = 0; index < 98; index++) {
      expect((await joinGuest(room, `accepted-${index}`)).closed).toBe(false);
    }
    await room.webSocketMessage(
      host,
      JSON.stringify({ type: 'room-password-set', password: '12345678' }),
    );
    await room.fetch(wsRequest('123456', 'guest', 'candidate-a'));
    const first = lastServer();
    await room.fetch(wsRequest('123456', 'guest', 'candidate-b'));
    const second = lastServer();

    await Promise.all([
      room.webSocketMessage(
        first,
        JSON.stringify({
          type: 'guest-auth',
          password: '12345678',
          reconnectSecret: DEFAULT_RECONNECT_SECRET,
        }),
      ),
      room.webSocketMessage(
        second,
        JSON.stringify({
          type: 'guest-auth',
          password: '12345678',
          reconnectSecret: OTHER_RECONNECT_SECRET,
        }),
      ),
    ]);

    expect([first, second].filter((socket) => !socket.closed)).toHaveLength(1);
    expect([first, second].find((socket) => socket.closed)?.closeEvents.at(-1)?.reason).toBe(
      'ROOM_GUEST_LIMIT_REACHED',
    );
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

  it('sweeps an expired pending host without disturbing a later valid claim', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state);
    await room.fetch(wsRequest('123456', 'host', 'silent-host'));
    const silent = lastServer();
    silent.serializeAttachment({
      ...(silent.deserializeAttachment() as Record<string, unknown>),
      authDeadline: Date.now() - 1,
    });

    await room.alarm();

    expect(silent.closeEvents.at(-1)?.reason).toBe('host auth timeout (sweep)');
    await room.fetch(wsRequest('123456', 'host', 'valid-host'));
    const valid = lastServer();
    await room.webSocketMessage(
      valid,
      JSON.stringify({ type: 'host-auth', secret: 'valid-host-secret' }),
    );
    expect(valid.closed).toBe(false);
    expect(sent(valid)[0]).toMatchObject({ type: 'peer-open' });
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

  it('lets a current first-frame host claim the room as its prior epoch expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:00:00.000Z'));
    const { room, state, host } = await createHostRoom();

    await room.webSocketClose(host);
    vi.setSystemTime(new Date('2026-05-16T00:01:01.000Z'));
    await room.fetch(wsRequest('123456', 'host', 'host-frame-after-grace'));
    const reclaimed = lastServer();

    await room.webSocketMessage(
      reclaimed,
      JSON.stringify({ type: 'host-auth', secret: 'frame-secret-after-grace' }),
    );

    expect(reclaimed.closed).toBe(false);
    expect(sent(reclaimed)[0]).toMatchObject({ type: 'peer-open', roomId: '123456' });
    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'frame-secret-after-grace',
      hostPeerId: 'host-frame-after-grace',
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

  it('surfaces transient alarm storage failures, arms a durable retry, and later converges', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:00:00.000Z'));
    const now = Date.now();
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state);
    await room.fetch(wsRequest('123456', 'host', 'alarm-retry-host'));
    await state.flushWaitUntil();
    const internal = room as unknown as { scheduleMaintenanceAlarm(): Promise<void> };
    const authDeadlineAlarm = now + 11_000;
    expect(state.storage.alarmTime).toBe(authDeadlineAlarm);

    const originalGetAlarm = state.storage.getAlarm.bind(state.storage);
    let failGetOnce = true;
    state.storage.getAlarm = vi.fn(async () => {
      if (failGetOnce) {
        failGetOnce = false;
        throw new Error('transient getAlarm failure');
      }
      return originalGetAlarm();
    });
    await expect(internal.scheduleMaintenanceAlarm()).rejects.toThrow('transient getAlarm failure');
    expect(state.storage.alarmTime).toBe(now + 100);
    await internal.scheduleMaintenanceAlarm();
    expect(state.storage.alarmTime).toBe(authDeadlineAlarm);

    const originalSetAlarm = state.storage.setAlarm.bind(state.storage);
    state.storage.alarmTime = null;
    let failSetOnce = true;
    state.storage.setAlarm = vi.fn(async (time: number) => {
      if (failSetOnce) {
        failSetOnce = false;
        throw new Error('transient setAlarm failure');
      }
      return originalSetAlarm(time);
    });
    await expect(internal.scheduleMaintenanceAlarm()).rejects.toThrow('transient setAlarm failure');
    expect(state.storage.alarmTime).toBe(now + 100);
    await internal.scheduleMaintenanceAlarm();
    expect(state.storage.alarmTime).toBe(authDeadlineAlarm);

    const idleState = new FakeDurableObjectState();
    const idleRoom = new workerModule.MusixquareRoom(idleState) as unknown as {
      scheduleMaintenanceAlarm(): Promise<void>;
    };
    idleState.storage.alarmTime = now + 5_000;
    const originalDeleteAlarm = idleState.storage.deleteAlarm.bind(idleState.storage);
    let failDeleteOnce = true;
    idleState.storage.deleteAlarm = vi.fn(async () => {
      if (failDeleteOnce) {
        failDeleteOnce = false;
        throw new Error('transient deleteAlarm failure');
      }
      return originalDeleteAlarm();
    });
    await expect(idleRoom.scheduleMaintenanceAlarm()).rejects.toThrow(
      'transient deleteAlarm failure',
    );
    expect(idleState.storage.alarmTime).toBe(now + 100);
    await idleRoom.scheduleMaintenanceAlarm();
    expect(idleState.storage.alarmTime).toBeNull();
  });

  it('does not use non-hibernatable WebSocket or timer APIs', async () => {
    const source = await readFile(resolve(process.cwd(), 'cloudflare/signaling-worker.js'), 'utf8');

    expect(source).not.toContain('server.accept(');
    expect(source).not.toContain('addEventListener(');
    expect(source).not.toContain('setTimeout(');
    expect(source).toContain('acceptWebSocket(');
  });
});
