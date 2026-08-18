import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStandardRoomAccountAssertion,
  createStandardRoomAccountDeletionAssertion,
} from '../../../../cloudflare/standard-room-account-assertion.ts';
import {
  REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_PREFIX,
  verifyRemoteShareUploadAssertion,
} from '../../../../cloudflare/remote-share-upload-assertion.ts';
import {
  ABUSE_RATE_CONSUME_PATH,
  SERVICE_CONTROL_READ_TIMEOUT_MS,
  SERVICE_CONTROL_STATUS_PATH,
} from '../../../../cloudflare/service-maintenance.ts';

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
    fetch(
      request: Request,
      env: Record<string, unknown>,
      context?: { waitUntil(task: Promise<unknown>): void },
    ): Promise<Response>;
  };
};

type SignalingProtocolModule = {
  WS_MESSAGE_MAX_BYTES: number;
  hasExactKeys(value: unknown, required: string[], optional?: string[]): boolean;
  isRecord(value: unknown): boolean;
  isStandardRoomIdentityMutation(message: unknown): boolean;
  isValidPeerId(peerId: unknown): boolean;
  normalizeProBroadcastTargets(value: unknown): string[] | null;
  normalizeProRealtimeFrame(value: unknown): unknown;
  normalizeProServerEvent(value: unknown): unknown;
  rawMessageByteLength(raw: unknown): number | null;
  validateIncomingMessage(message: unknown, role: string): 'valid' | 'ignore' | 'oversized';
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
  roomGeneration: number;
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
const NEGOTIATION_ID = 'negotiation_test_000001';
const PRO_SIGNALING_WEBSOCKET_PROTOCOL = 'mxqr.pro-signaling.v1';
const PRO_SIGNALING_TICKET_PROTOCOL_PREFIX = 'mxqr.ticket.';
const REMOTE_SHARE_UPLOAD_ASSERTION_SECRET =
  'remote-share-upload-assertion-secret-for-signaling-tests';
const REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING = `${REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_PREFIX}${JSON.stringify(
  {
    v: 1,
    current: {
      kid: '2026-09-current',
      secret: 'next-remote-share-upload-assertion-secret-for-signaling-tests',
    },
    previous: { kid: '2026-08-old', secret: REMOTE_SHARE_UPLOAD_ASSERTION_SECRET },
  },
)}`;
const REMOTE_SHARE_UPLOAD_ASSERTION_DUPLICATE_SECRET_KEYRING = `${REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_PREFIX}${JSON.stringify(
  {
    v: 1,
    current: { kid: 'current', secret: REMOTE_SHARE_UPLOAD_ASSERTION_SECRET },
    previous: { kid: 'previous', secret: REMOTE_SHARE_UPLOAD_ASSERTION_SECRET },
  },
)}`;
const REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST = Object.freeze({
  type: 'remote-share-upload-assertion-request',
  correlationId: `rsaq_${'c'.repeat(32)}`,
  actorId: `rsa_${'a'.repeat(43)}`,
  requestId: `rs3_${'r'.repeat(43)}`,
  sessionId: 1_800_000_000_000,
  queueItemId: '10000000-0000-4000-8000-000000000001',
  size: 4,
  bodySha256: 'A'.repeat(43),
});
const originalWebSocketPair = (globalThis as typeof globalThis & { WebSocketPair?: unknown })
  .WebSocketPair;
let workerModule: WorkerModule;
let signalingProtocol: SignalingProtocolModule;

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
  id: { name?: string };
  storage = new FakeStorage();
  sockets: FakeSocket[] = [];
  waitUntilTasks: Promise<unknown>[] = [];

  constructor(name?: string) {
    this.id = name ? { name } : {};
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

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

function wsRequest(roomId: string, role: 'host' | 'guest', peerId: string): Request {
  const url = new URL(`https://signal.example.test/api/rooms/${roomId}/ws`);
  url.searchParams.set('role', role);
  url.searchParams.set('peerId', peerId);

  return {
    url: url.toString(),
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'upgrade' ? 'websocket' : null;
      },
    },
  } as Request;
}

function wsRequestWithLegacyHostSecret(roomId: string, peerId: string, secret: string): Request {
  const request = wsRequest(roomId, 'host', peerId);
  const url = new URL(request.url);
  url.searchParams.set('secret', secret);
  return { ...request, url: url.toString() } as Request;
}

const PRO_SIGNALING_SECRET = 'pro-signaling-test-secret-with-at-least-32-bytes';
const STANDARD_WS_RATE_OBJECT_PREFIX = 'musixquare-standard-ws-open-rate-v1:';
const STANDARD_WS_RATE_STATE_KEY = 'standard-ws-open-rate-state-v1';
const STANDARD_WS_RATE_CONSUME_PATH = '/internal/standard-ws-open-rate/v1/consume';
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
    roomGeneration: 0,
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
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return requestLike(url.toString(), {
    Upgrade: 'websocket',
    'Sec-WebSocket-Protocol': proProtocolHeader(ticket),
  });
}

function proProtocolHeader(ticket: string): string {
  return `${PRO_SIGNALING_WEBSOCKET_PROTOCOL}, ${PRO_SIGNALING_TICKET_PROTOCOL_PREFIX}${ticket}`;
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

function workerEnv(options: { rateStateSeed?: unknown; rateFetchError?: Error } = {}): {
  env: Record<string, unknown>;
  idFromName: ReturnType<typeof vi.fn>;
  roomGet: ReturnType<typeof vi.fn>;
  roomFetch: ReturnType<typeof vi.fn>;
  rateObjectStates: Map<string, FakeDurableObjectState>;
} {
  const roomFetch = vi.fn(async () => new Response(null, { status: 101 }));
  const room = { fetch: roomFetch };
  const rateObjectStates = new Map<string, FakeDurableObjectState>();
  const rateObjects = new Map<string, InstanceType<WorkerModule['MusixquareRoom']>>();
  const idFromName = vi.fn((name: string) => name);
  const roomGet = vi.fn((id: string) => {
    const name = String(id);
    if (!name.startsWith(STANDARD_WS_RATE_OBJECT_PREFIX)) return room;
    if (options.rateFetchError) {
      return {
        fetch: vi.fn(async () => {
          throw options.rateFetchError;
        }),
      };
    }
    let rateObject = rateObjects.get(name);
    if (!rateObject) {
      const state = new FakeDurableObjectState(name);
      if (Object.prototype.hasOwnProperty.call(options, 'rateStateSeed')) {
        state.storage.data.set(STANDARD_WS_RATE_STATE_KEY, structuredClone(options.rateStateSeed));
      }
      rateObject = new workerModule.MusixquareRoom(state);
      rateObjects.set(name, rateObject);
      rateObjectStates.set(name, state);
    }
    return rateObject;
  });
  return {
    env: {
      MUSIXQUARE_ROOMS: {
        idFromName,
        get: roomGet,
      },
    },
    idFromName,
    roomGet,
    roomFetch,
    rateObjectStates,
  };
}

function maintenanceBinding(enabled = true): Record<string, unknown> {
  const serviceStatus = {
    enabled,
    revision: enabled ? 1 : 0,
    updatedAt: enabled ? Date.now() : null,
    activatedAt: enabled ? Date.now() : null,
  };
  return {
    getByName: vi.fn(() => ({
      fetch: vi.fn(async () => originalResponse.json({ serviceStatus })),
    })),
  };
}

function atomicRateBinding(
  barrierCalls: number,
  initialCount = 0,
): {
  binding: Record<string, unknown>;
  rateFetchCount(): number;
} {
  const counts = new Map<string, number>();
  const tails = new Map<string, Promise<void>>();
  let rateFetches = 0;
  let releaseBarrier: (() => void) | null = null;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  return {
    binding: {
      getByName: vi.fn((name: string) => ({
        fetch: async (request: Request): Promise<Response> => {
          const path = new URL(request.url).pathname;
          if (path === SERVICE_CONTROL_STATUS_PATH) {
            return originalResponse.json({
              serviceStatus: {
                enabled: false,
                revision: 0,
                updatedAt: null,
                activatedAt: null,
              },
            });
          }
          expect(path).toBe(ABUSE_RATE_CONSUME_PATH);
          rateFetches += 1;
          if (rateFetches === barrierCalls) releaseBarrier?.();
          await barrier;
          const body = (await request.json()) as { limit: number; windowMs: number; cost: number };
          const previous = tails.get(name) || Promise.resolve();
          let release!: () => void;
          const next = new Promise<void>((resolve) => {
            release = resolve;
          });
          tails.set(
            name,
            previous.then(() => next),
          );
          await previous;
          try {
            const count = counts.get(name) ?? initialCount;
            const allowed = count + body.cost <= body.limit;
            const nextCount = allowed ? count + body.cost : count;
            counts.set(name, nextCount);
            return originalResponse.json({
              allowed,
              limit: body.limit,
              remaining: body.limit - nextCount,
              resetAtMs: Date.now() + body.windowMs,
              retryAfterSeconds: allowed ? 0 : Math.ceil(body.windowMs / 1_000),
            });
          } finally {
            release();
          }
        },
      })),
    },
    rateFetchCount: () => rateFetches,
  };
}

function hangingMaintenanceBinding(): {
  binding: Record<string, unknown>;
  fetch: ReturnType<typeof vi.fn>;
} {
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  return {
    binding: {
      getByName: vi.fn(() => ({ fetch })),
    },
    fetch,
  };
}

function gatedInactiveMaintenanceBinding(): {
  binding: Record<string, unknown>;
  entered: Promise<void>;
  release(): void;
} {
  let markEntered!: () => void;
  let releaseGate!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  return {
    binding: {
      getByName: vi.fn(() => ({
        fetch: vi.fn(async () => {
          markEntered();
          await gate;
          return originalResponse.json({
            serviceStatus: {
              enabled: false,
              revision: 0,
              updatedAt: null,
              activatedAt: null,
            },
          });
        }),
      })),
    },
    entered,
    release: releaseGate,
  };
}

function proAuthorityNamespace(
  handler: (request: Request) => Promise<Response> = async () =>
    new originalResponse(
      JSON.stringify({
        allowed: true,
        roomCode: '000001',
        roomGeneration: 0,
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
  const host = await authenticateHost(room, 'host-1', 'secret-a');
  return { room, state, host };
}

async function authenticateHost(
  room: InstanceType<WorkerModule['MusixquareRoom']>,
  peerId: string,
  secret: string,
  accountAssertion?: string,
): Promise<FakeSocket> {
  await room.fetch(wsRequest('123456', 'host', peerId));
  const host = lastServer();
  await room.webSocketMessage(
    host,
    JSON.stringify({
      type: 'host-auth',
      secret,
      ...(accountAssertion === undefined ? {} : { accountAssertion }),
    }),
  );
  return host;
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
  const signalingWorkerModulePath = '../../../../cloudflare/signaling-worker.ts';
  workerModule = (await import(signalingWorkerModulePath)) as WorkerModule;
  signalingProtocol = await vi.importActual<SignalingProtocolModule>(
    '../../../../cloudflare/signaling-protocol.ts',
  );
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

describe('Cloudflare signaling protocol validation boundaries', () => {
  it('measures every supported WebSocket frame representation without coercion', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);

    expect(signalingProtocol.rawMessageByteLength('한')).toBe(3);
    expect(
      signalingProtocol.rawMessageByteLength(
        'x'.repeat(signalingProtocol.WS_MESSAGE_MAX_BYTES + 1),
      ),
    ).toBe(signalingProtocol.WS_MESSAGE_MAX_BYTES + 1);
    expect(signalingProtocol.rawMessageByteLength(bytes.buffer)).toBe(4);
    expect(signalingProtocol.rawMessageByteLength(bytes.subarray(1, 3))).toBe(2);
    expect(signalingProtocol.rawMessageByteLength({ byteLength: 4 })).toBeNull();
  });

  it('keeps record, exact-key, peer-id, and identity-mutation checks fail closed', () => {
    expect(signalingProtocol.isRecord({})).toBe(true);
    expect(signalingProtocol.isRecord(null)).toBe(false);
    expect(signalingProtocol.isRecord([])).toBe(false);
    expect(signalingProtocol.hasExactKeys({ required: 1 }, ['required'])).toBe(true);
    expect(
      signalingProtocol.hasExactKeys({ required: 1, optional: 2 }, ['required'], ['optional']),
    ).toBe(true);
    expect(signalingProtocol.hasExactKeys({ required: 1, extra: 2 }, ['required'])).toBe(false);
    expect(signalingProtocol.hasExactKeys({}, ['required'])).toBe(false);
    expect(signalingProtocol.isValidPeerId('peer_01-valid')).toBe(true);
    expect(signalingProtocol.isValidPeerId('bad.peer')).toBe(false);
    expect(signalingProtocol.isValidPeerId(42)).toBe(false);

    for (const type of [
      'account-identity-refresh',
      'account-identity-clear',
      'account-identity-delete',
    ]) {
      expect(signalingProtocol.isStandardRoomIdentityMutation({ type })).toBe(true);
    }
    expect(signalingProtocol.isStandardRoomIdentityMutation({ type: 'signal-offer' })).toBe(false);
    expect(signalingProtocol.isStandardRoomIdentityMutation(null)).toBe(false);
  });

  it('normalizes bounded PRO server events and rejects dangerous object keys', () => {
    const event = {
      type: 'pro-playback-commit',
      sequence: 3,
      nested: { enabled: true, value: null },
      items: [1, 'two'],
    };
    expect(signalingProtocol.normalizeProServerEvent(event)).toEqual(event);

    for (const forbiddenKey of ['', '__proto__', 'prototype', 'constructor', 'x'.repeat(65)]) {
      const candidate: Record<string, unknown> = { type: 'pro-playback-commit', safe: true };
      Object.defineProperty(candidate, forbiddenKey, { enumerable: true, value: true });
      expect(signalingProtocol.normalizeProServerEvent(candidate)).toBeNull();
    }
    expect(
      signalingProtocol.normalizeProServerEvent({
        type: 'pro-presence-snapshot',
        presenceRevision: -1,
      }),
    ).toBeNull();
    expect(
      signalingProtocol.normalizeProServerEvent({
        type: 'pro-playback-commit',
        value: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
  });

  it('validates PRO broadcast targets and each realtime channel boundary', () => {
    const incarnation = 'presence-boundary-0001';
    const eventId = 'protocol-event-0001';
    const commandId = 'protocol-command-0001';
    const frame = (channel: string, payload: Record<string, unknown>) => ({
      type: 'pro-realtime',
      version: 1,
      eventId,
      channel,
      payload,
    });

    expect(signalingProtocol.normalizeProBroadcastTargets([incarnation])).toEqual([incarnation]);
    expect(signalingProtocol.normalizeProBroadcastTargets('not-an-array')).toBeNull();
    expect(signalingProtocol.normalizeProBroadcastTargets(Array(101).fill(incarnation))).toBeNull();
    expect(signalingProtocol.normalizeProBroadcastTargets([incarnation, incarnation])).toBeNull();
    expect(signalingProtocol.normalizeProBroadcastTargets([42])).toBeNull();

    expect(
      signalingProtocol.normalizeProRealtimeFrame(frame('presence', { state: 'active' })),
    ).toMatchObject({ channel: 'presence', payload: { state: 'active' } });
    expect(
      signalingProtocol.normalizeProRealtimeFrame(
        frame('control-ready', { commandId, sequence: 0, ready: true }),
      ),
    ).toMatchObject({ channel: 'control-ready', payload: { commandId, sequence: 0, ready: true } });
    expect(
      signalingProtocol.normalizeProRealtimeFrame(
        frame('clock', { requestId: 0, clientSentAtMs: 1 }),
      ),
    ).toMatchObject({ channel: 'clock', payload: { requestId: 0, clientSentAtMs: 1 } });

    const invalidFrames = [
      frame('chat', { kind: 'unknown' }),
      frame('chat', {
        kind: 'bot-result',
        requestId: 'protocol-request-0001',
        result: { kind: 'unknown' },
      }),
      frame('presence', { state: 'idle' }),
      frame('presence', { state: 'active', extra: true }),
      frame('control-ready', { commandId: 'short', sequence: 0, ready: true }),
      frame('control-ready', { commandId, sequence: -1, ready: true }),
      frame('control-ready', { commandId, sequence: 0, ready: 'yes' }),
      frame('clock', { requestId: -1, clientSentAtMs: 1 }),
      frame('clock', { requestId: 0, clientSentAtMs: Number.NaN }),
      frame('clock', { requestId: 0, clientSentAtMs: -1 }),
      frame('future-channel', {}),
      { ...frame('presence', { state: 'active' }), extra: true },
      { ...frame('presence', { state: 'active' }), eventId: 'short' },
      { ...frame('presence', { state: 'active' }), payload: [] },
    ];
    for (const invalidFrame of invalidFrames) {
      expect(signalingProtocol.normalizeProRealtimeFrame(invalidFrame)).toBeNull();
    }
  });

  it('normalizes the strict targeted PRO system-audio signaling union', () => {
    const frame = (payload: Record<string, unknown>) => ({
      type: 'pro-realtime',
      version: 1,
      eventId: 'system-audio-event-0001',
      channel: 'system-audio-signal',
      payload,
    });
    const common = {
      targetParticipantId: 'system-audio-target-0001',
      generation: 7,
      publicationId: 'system-audio-publication-0001',
      negotiationId: 'system-audio-negotiation-0001',
    };
    const probeOffer = {
      ...common,
      kind: 'offer',
      direction: 'publisher',
      phase: 'probe',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    };
    const offer = {
      ...probeOffer,
      phase: 'media',
      trackIds: { L: 'captured-left-track', R: 'captured-right-track' },
    };
    const answer = {
      ...common,
      kind: 'answer',
      direction: 'subscriber',
      phase: 'media',
      description: { type: 'answer', sdp: 'v=0\r\n' },
    };
    const candidate = {
      ...common,
      kind: 'candidate',
      direction: 'publisher',
      candidate: {
        candidate: 'candidate:1 1 UDP 1 123e4567-e89b-42d3-a456-426614174000.local 9 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: null,
      },
    };
    const close = {
      ...common,
      kind: 'close',
      direction: 'subscriber',
      reason: 'fallback',
    };

    expect(signalingProtocol.normalizeProRealtimeFrame(frame(probeOffer))).toMatchObject({
      channel: 'system-audio-signal',
      payload: probeOffer,
    });
    expect(signalingProtocol.normalizeProRealtimeFrame(frame(offer))).toMatchObject({
      channel: 'system-audio-signal',
      payload: offer,
    });
    expect(signalingProtocol.normalizeProRealtimeFrame(frame(answer))).toMatchObject({
      channel: 'system-audio-signal',
      payload: answer,
    });
    expect(signalingProtocol.normalizeProRealtimeFrame(frame(candidate))).toMatchObject({
      channel: 'system-audio-signal',
      payload: candidate,
    });
    expect(
      signalingProtocol.normalizeProRealtimeFrame(
        frame({
          ...candidate,
          candidate: {
            ...candidate.candidate,
            candidate: `${candidate.candidate.candidate} generation 0 raddr 192.168.1.20 rport 5000`,
          },
        }),
      ),
    ).toMatchObject({
      channel: 'system-audio-signal',
      payload: candidate,
    });
    expect(signalingProtocol.normalizeProRealtimeFrame(frame(close))).toMatchObject({
      channel: 'system-audio-signal',
      payload: close,
    });

    const invalidPayloads = [
      { ...offer, direction: 'subscriber' },
      { ...answer, direction: 'publisher' },
      { ...probeOffer, trackIds: { L: 'left', R: 'right' } },
      { ...offer, phase: 'probe' },
      { ...probeOffer, phase: 'media' },
      { ...offer, phase: 'unknown' },
      { ...answer, phase: 'unknown' },
      (({ phase: _phase, ...withoutPhase }) => withoutPhase)(offer),
      (({ phase: _phase, ...withoutPhase }) => withoutPhase)(answer),
      { ...offer, trackIds: { L: 'same-track', R: 'same-track' } },
      { ...offer, trackIds: { L: 'left', R: 'right', extra: true } },
      { ...offer, trackIds: { L: 'x'.repeat(161), R: 'right' } },
      { ...answer, trackIds: { L: 'left', R: 'right' } },
      {
        ...probeOffer,
        description: {
          type: 'offer',
          sdp: 'v=0\r\na=candidate:1 1 udp 1 192.168.1.20 5000 typ host\r\n',
        },
      },
      {
        ...answer,
        description: {
          type: 'answer',
          sdp: 'v=0\r\na=remote-candidates:1 192.168.1.20 5000\r\n',
        },
      },
      {
        ...answer,
        description: { type: 'answer', sdp: 'v=0\r\na=end-of-candidates\r\n' },
      },
      {
        ...probeOffer,
        description: { type: 'offer', sdp: 'v=0\r\nc=IN IP4 192.168.1.20\r\n' },
      },
      {
        ...answer,
        description: { type: 'answer', sdp: 'v=0\r\nc=IN IP6 fd00::20\r\n' },
      },
      { ...candidate, phase: 'probe' },
      {
        ...candidate,
        candidate: {
          ...candidate.candidate,
          candidate: 'candidate:1 1 TCP 1 192.168.1.20 9 typ host tcptype active',
        },
      },
      {
        ...candidate,
        candidate: {
          ...candidate.candidate,
          candidate: 'candidate:1 2 UDP 1 192.168.1.20 5000 typ host',
        },
      },
      {
        ...candidate,
        candidate: {
          ...candidate.candidate,
          candidate: 'candidate:1 1 UDP 1 192.168.1.20 5000 typ srflx',
        },
      },
      {
        ...candidate,
        candidate: {
          ...candidate.candidate,
          candidate: 'candidate:1 1 UDP 1 192.168.1.20 5000 typ host',
        },
      },
      {
        ...candidate,
        candidate: {
          ...candidate.candidate,
          candidate: 'candidate:1 1 UDP 1 arbitrary.local 5000 typ host',
        },
      },
      { ...close, phase: 'media' },
      { ...candidate, candidate: { candidate: 'candidate:1', extra: true } },
      { ...candidate, candidate: { candidate: 'x'.repeat(4 * 1024) } },
      { ...close, reason: 'unknown' },
      { ...close, generation: 0 },
      { ...close, publicationId: 'short' },
      { ...close, negotiationId: 'short' },
      { ...close, extra: true },
    ];
    for (const payload of invalidPayloads) {
      expect(signalingProtocol.normalizeProRealtimeFrame(frame(payload))).toBeNull();
    }
    expect(
      signalingProtocol.normalizeProRealtimeFrame(
        frame({
          ...offer,
          description: { type: 'offer', sdp: 'x'.repeat(48 * 1024 + 1) },
        }),
      ),
    ).toBeNull();
  });

  it('rejects malformed ICE metadata and covers role-specific terminal messages', () => {
    const guestCandidate = (candidate: Record<string, unknown>) => ({
      type: 'signal-candidate',
      to: 'host',
      negotiationId: NEGOTIATION_ID,
      candidate,
    });
    expect(
      signalingProtocol.validateIncomingMessage(
        guestCandidate({
          candidate: 'candidate:1',
          sdpMid: null,
          sdpMLineIndex: null,
          usernameFragment: null,
        }),
        'guest',
      ),
    ).toBe('valid');
    for (const candidate of [
      { candidate: 'candidate:1', sdpMid: 1 },
      { candidate: 'candidate:1', sdpMLineIndex: -1 },
      { candidate: 'candidate:1', sdpMLineIndex: 1.5 },
      { candidate: 'candidate:1', usernameFragment: 1 },
    ]) {
      expect(signalingProtocol.validateIncomingMessage(guestCandidate(candidate), 'guest')).toBe(
        'ignore',
      );
    }

    expect(
      signalingProtocol.validateIncomingMessage(
        { type: 'media-close', to: 'host', callId: 'call-1' },
        'guest',
      ),
    ).toBe('valid');
    expect(
      signalingProtocol.validateIncomingMessage(
        { type: 'media-close', to: 'host', callId: 'bad.call' },
        'guest',
      ),
    ).toBe('ignore');
    expect(
      signalingProtocol.validateIncomingMessage(
        {
          type: 'guest-auth',
          password: '',
          reconnectSecret: 'r'.repeat(43),
          accountAssertion: 'x'.repeat(2049),
        },
        'pending',
      ),
    ).toBe('ignore');

    const hostIdentityFrames = [
      { type: 'account-identity-refresh', accountAssertion: 'assertion' },
      { type: 'account-identity-clear' },
      { type: 'account-identity-delete', deletionAssertion: 'assertion' },
    ];
    for (const message of hostIdentityFrames) {
      expect(signalingProtocol.validateIncomingMessage(message, 'host')).toBe('valid');
      expect(signalingProtocol.validateIncomingMessage({ ...message, extra: true }, 'host')).toBe(
        'ignore',
      );
    }
    expect(
      signalingProtocol.validateIncomingMessage(
        { type: 'media-close', to: 'guest-1', callId: 'call-1' },
        'host',
      ),
    ).toBe('valid');
    expect(
      signalingProtocol.validateIncomingMessage(
        { type: 'media-close', to: 'guest-1', callId: 'bad.call' },
        'host',
      ),
    ).toBe('ignore');
    expect(
      signalingProtocol.validateIncomingMessage({ type: 'future-message', to: 'guest-1' }, 'host'),
    ).toBe('ignore');
    expect(
      signalingProtocol.validateIncomingMessage({ type: 'future-message' }, 'future-role'),
    ).toBe('ignore');
    for (const malformed of [null, [], {}, { type: 1 }, { type: 'x'.repeat(65) }]) {
      expect(signalingProtocol.validateIncomingMessage(malformed, 'host')).toBe('ignore');
    }
  });

  it('keeps Remote Share authority frames exact, scalar-typed, and host-only', () => {
    expect(
      signalingProtocol.validateIncomingMessage(REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST, 'host'),
    ).toBe('valid');
    expect(
      signalingProtocol.validateIncomingMessage(REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST, 'guest'),
    ).toBe('ignore');

    for (const mutation of [
      { correlationId: { toString: () => REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST.correlationId } },
      { actorId: 1 },
      { requestId: null },
      { sessionId: String(REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST.sessionId) },
      { queueItemId: {} },
      { size: 4.5 },
      { bodySha256: ['A'.repeat(43)] },
      { extraCapability: true },
    ]) {
      expect(
        signalingProtocol.validateIncomingMessage(
          { ...REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST, ...mutation },
          'host',
        ),
      ).toBe('ignore');
    }
  });
});

describe('Cloudflare signaling Remote Share host assertions', () => {
  it('advertises and issues an exact request-bound assertion only to the current host', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET: REMOTE_SHARE_UPLOAD_ASSERTION_SECRET,
    });
    const host = await authenticateHost(room, 'host-1', 'secret-a');
    expect(sent(host)[0]).toMatchObject({
      type: 'peer-open',
      roomId: '123456',
      remoteShareUploadAssertionVersion: 1,
      remoteShareUploadAssertionKeyringVersion: 1,
    });

    host.sent.length = 0;
    await room.webSocketMessage(host, JSON.stringify(REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST));
    const response = sent(host)[0];
    expect(response).toMatchObject({
      type: 'remote-share-upload-assertion',
      correlationId: REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST.correlationId,
      expiresAt: expect.any(Number),
      assertion: expect.any(String),
    });
    const verified = await verifyRemoteShareUploadAssertion(
      String(response.assertion),
      REMOTE_SHARE_UPLOAD_ASSERTION_SECRET,
      {
        roomId: '123456',
        sessionId: REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST.sessionId,
        queueItemId: REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST.queueItemId,
        size: REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST.size,
        actorId: REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST.actorId,
        requestId: REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST.requestId,
        bodySha256: REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST.bodySha256,
      },
    );
    expect(verified).toMatchObject({ roomId: '123456', hostPeerId: 'host-1' });
  });

  it('does not advertise the feature with a weak or ambiguous dedicated secret', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET: 'too-short',
    });
    const host = await authenticateHost(room, 'host-1', 'secret-a');
    expect(sent(host)[0]).not.toHaveProperty('remoteShareUploadAssertionVersion');
    expect(sent(host)[0]).not.toHaveProperty('remoteShareUploadAssertionKeyringVersion');

    const ambiguousState = new FakeDurableObjectState();
    const ambiguousRoom = new workerModule.MusixquareRoom(ambiguousState, {
      MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET:
        REMOTE_SHARE_UPLOAD_ASSERTION_DUPLICATE_SECRET_KEYRING,
    });
    const ambiguousHost = await authenticateHost(ambiguousRoom, 'host-2', 'secret-b');
    expect(sent(ambiguousHost)[0]).not.toHaveProperty('remoteShareUploadAssertionVersion');
    expect(sent(ambiguousHost)[0]).not.toHaveProperty('remoteShareUploadAssertionKeyringVersion');
  });

  it('signs new assertions with the keyring current kid while retaining previous verification', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET: REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING,
    });
    const host = await authenticateHost(room, 'host-1', 'secret-a');
    host.sent.length = 0;

    await room.webSocketMessage(host, JSON.stringify(REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST));
    const response = sent(host)[0];
    const verified = await verifyRemoteShareUploadAssertion(
      String(response.assertion),
      REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING,
    );

    expect(response).toMatchObject({ type: 'remote-share-upload-assertion' });
    expect(verified).toMatchObject({
      roomId: '123456',
      hostPeerId: 'host-1',
      kid: '2026-09-current',
    });
  });

  it('ignores guest, malformed, and replaced-host assertion requests without relaying them', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET: REMOTE_SHARE_UPLOAD_ASSERTION_SECRET,
    });
    const host = await authenticateHost(room, 'host-1', 'secret-a');
    const guest = await joinGuest(room, 'guest-1');
    host.sent.length = 0;
    guest.sent.length = 0;

    await room.webSocketMessage(guest, JSON.stringify(REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST));
    await room.webSocketMessage(
      host,
      JSON.stringify({ ...REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST, unexpected: true }),
    );
    expect(sent(host)).toEqual([]);
    expect(sent(guest)).toEqual([]);

    const replacement = await authenticateHost(room, 'host-2', 'secret-a');
    expect(replacement).not.toBe(host);
    host.sent.length = 0;
    await room.webSocketMessage(host, JSON.stringify(REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST));
    expect(sent(host)).toEqual([]);
    expect(sent(guest)).toEqual([]);
  });

  it('does not answer a host replaced while assertion signing is in flight', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET: REMOTE_SHARE_UPLOAD_ASSERTION_SECRET,
    });
    const host = await authenticateHost(room, 'host-1', 'secret-a');
    host.sent.length = 0;

    const originalSign = crypto.subtle.sign.bind(crypto.subtle);
    let releaseSigning!: () => void;
    let signingStarted!: () => void;
    const signingGate = new Promise<void>((resolve) => {
      releaseSigning = resolve;
    });
    const enteredSigning = new Promise<void>((resolve) => {
      signingStarted = resolve;
    });
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(
      async (algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) => {
        signingStarted();
        await signingGate;
        return originalSign(algorithm, key, data);
      },
    );

    const issuance = room.webSocketMessage(
      host,
      JSON.stringify(REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST),
    );
    await enteredSigning;
    const replacement = await authenticateHost(room, 'host-2', 'secret-a');
    expect(replacement).not.toBe(host);
    releaseSigning();
    await issuance;

    expect(sent(host)).toEqual([]);
    expect(sent(replacement)).not.toContainEqual(
      expect.objectContaining({ type: 'remote-share-upload-assertion' }),
    );
  });

  it('bounds assertion signing bursts per authenticated host socket', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET: REMOTE_SHARE_UPLOAD_ASSERTION_SECRET,
    });
    const host = await authenticateHost(room, 'host-1', 'secret-a');
    host.serializeAttachment({
      ...(host.deserializeAttachment() as Record<string, unknown>),
      remoteShareUploadAssertionTokens: 2,
      remoteShareUploadAssertionUpdatedAt: Date.now(),
    });
    host.sent.length = 0;

    for (let index = 0; index < 3; index += 1) {
      await room.webSocketMessage(
        host,
        JSON.stringify({
          ...REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST,
          correlationId: `rsaq_${String(index).padStart(32, '0')}`,
        }),
      );
    }

    expect(
      sent(host).filter((message) => message.type === 'remote-share-upload-assertion'),
    ).toHaveLength(2);
    expect(sent(host).at(-1)).toEqual({
      type: 'remote-share-upload-assertion-error',
      correlationId: `rsaq_${'2'.padStart(32, '0')}`,
      errorType: 'REMOTE_SHARE_UPLOAD_ASSERTION_RATE_LIMITED',
    });
    expect(host.deserializeAttachment()).toMatchObject({
      remoteShareUploadAssertionTokens: 0,
      remoteShareUploadAssertionUpdatedAt: Date.now(),
    });
  });
});

describe('Cloudflare signaling Worker hibernation behavior', () => {
  it('blocks top-level and room-object admission while service maintenance is active', async () => {
    const routed = workerEnv();
    routed.env.MUSIXQUARE_SERVICE_CONTROL = maintenanceBinding();
    const topLevel = await workerModule.default.fetch(
      wsRequest('123456', 'host', 'host-maintenance'),
      routed.env,
    );
    expect(topLevel.status).toBe(503);
    expect(routed.idFromName).not.toHaveBeenCalled();

    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MUSIXQUARE_SERVICE_CONTROL: maintenanceBinding(),
    });
    const objectResponse = await room.fetch(wsRequest('123456', 'host', 'host-maintenance'));
    expect(objectResponse.status).toBe(503);
    expect(FakeWebSocketPair.pairs).toHaveLength(0);
  });

  it('keeps an alarm alive while blocking pending websocket work in maintenance', async () => {
    const state = new FakeDurableObjectState();
    const env: Record<string, unknown> = {};
    const room = new workerModule.MusixquareRoom(state, env);
    await room.fetch(wsRequest('123456', 'host', 'host-maintenance'));
    const socket = lastServer();
    const beforeStorage = structuredClone([...state.storage.data.entries()]);

    env.MUSIXQUARE_SERVICE_CONTROL = maintenanceBinding();
    await room.webSocketMessage(socket, JSON.stringify({ type: 'host-auth', secret: 'ignored' }));
    expect(socket.closed).toBe(true);
    expect(socket.closeEvents.at(-1)).toEqual({ code: 1012, reason: 'SERVICE_MAINTENANCE' });
    await room.webSocketClose(socket);
    expect([...state.storage.data.entries()]).toEqual(beforeStorage);

    state.storage.alarmTime = null;
    const beforeAlarm = Date.now();
    await room.alarm();
    expect(state.storage.alarmTime).toBeGreaterThanOrEqual(beforeAlarm + 59_000);
  });

  it('persists host departure and expires stale guests during maintenance idempotently', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'));
    const state = new FakeDurableObjectState();
    const env: Record<string, unknown> = {};
    const room = new workerModule.MusixquareRoom(state, env);
    const host = await authenticateHost(room, 'host-maintenance', 'secret-maintenance');
    const guest = await joinGuest(room, 'guest-maintenance');
    env.MUSIXQUARE_SERVICE_CONTROL = maintenanceBinding();

    host.close();
    await room.webSocketClose(host);
    const released = (await state.storage.get('roomMeta')) as RoomMeta;
    expect(released).toMatchObject({
      roomSecret: 'secret-maintenance',
      hostPeerId: null,
      hostReleaseAt: Date.now() + 60_000,
    });
    expect(state.storage.alarmTime).toBe(released.hostReleaseAt);

    await room.webSocketClose(host);
    expect(await state.storage.get('roomMeta')).toEqual(released);
    expect(state.storage.alarmTime).toBe(released.hostReleaseAt);

    vi.advanceTimersByTime(60_000);
    await room.alarm();

    expect(guest.closeEvents.at(-1)).toEqual({ code: 1012, reason: 'ROOM_EXPIRED' });
    expect(await state.storage.get('roomMeta')).toEqual({
      v: 1,
      roomSecret: null,
      roomPassword: '',
      hostPeerId: null,
      hostReleaseAt: 0,
    });
    expect(await state.storage.get('guestReconnectBindings')).toEqual({ v: 1, entries: [] });
    expect(state.storage.alarmTime).toBe(Date.now() + 60_000);
  });

  it('does not wait for service control on close and converges after a bounded failed read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T01:00:00.000Z'));
    const state = new FakeDurableObjectState();
    const env: Record<string, unknown> = {};
    const room = new workerModule.MusixquareRoom(state, env);
    const host = await authenticateHost(room, 'host-hanging-control', 'secret-hanging-control');
    const guest = await joinGuest(room, 'guest-hanging-control');
    const hanging = hangingMaintenanceBinding();
    env.MUSIXQUARE_SERVICE_CONTROL = hanging.binding;

    host.close();
    await room.webSocketClose(host);
    expect(hanging.fetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    const alarm = room.alarm();
    await Promise.resolve();
    expect(hanging.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SERVICE_CONTROL_READ_TIMEOUT_MS);
    await alarm;

    expect(guest.closeEvents.at(-1)).toEqual({ code: 1012, reason: 'ROOM_EXPIRED' });
    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: null,
      hostPeerId: null,
      hostReleaseAt: 0,
    });
    expect(state.storage.alarmTime).toBe(Date.now() + 60_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries host close persistence after an interrupted storage write', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T02:00:00.000Z'));
    const { room, state, host } = await createHostRoom();
    const internals = room as unknown as {
      saveRoomMeta(meta: RoomMeta): Promise<RoomMeta>;
    };
    vi.spyOn(internals, 'saveRoomMeta').mockRejectedValueOnce(
      new Error('simulated close persistence failure'),
    );

    host.close();
    await expect(room.webSocketClose(host)).rejects.toThrow('simulated close persistence failure');
    expect(await state.storage.get('roomMeta')).toMatchObject({
      hostPeerId: 'host-1',
      hostReleaseAt: 0,
    });

    await expect(room.webSocketClose(host)).resolves.toBeUndefined();
    expect(await state.storage.get('roomMeta')).toMatchObject({
      hostPeerId: null,
      hostReleaseAt: Date.now() + 60_000,
    });
    expect(state.storage.alarmTime).toBe(Date.now() + 60_000);
  });

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

  it('hard-limits barrier-concurrent WebSocket opens across room codes before routing', async () => {
    const routed = workerEnv();
    const control = atomicRateBinding(121);
    routed.env.MUSIXQUARE_SERVICE_CONTROL = control.binding;
    routed.env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const open = (index: number) => {
      const roomId = String(100_000 + index);
      return workerModule.default.fetch(
        requestLike(
          `https://signal.example.test/api/rooms/${roomId}/ws?role=guest&peerId=rate-peer-${index}`,
          {
            Origin: 'https://musixquare.com',
            Upgrade: 'websocket',
            'CF-Connecting-IP': '203.0.113.121',
          },
        ),
        routed.env,
      );
    };

    const responses = await Promise.all(Array.from({ length: 121 }, (_, index) => open(index)));

    expect(responses.filter((response) => response.status === 101)).toHaveLength(120);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
    expect(routed.roomFetch).toHaveBeenCalledTimes(120);
    expect(routed.rateObjectStates.size).toBe(1);
    expect(control.rateFetchCount()).toBe(0);
  });

  it('isolates standard WebSocket-open limits by HMAC-protected client IP', async () => {
    const routed = workerEnv();
    routed.env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const open = (ip: string, peerId: string) =>
      workerModule.default.fetch(
        requestLike(`https://signal.example.test/api/rooms/123456/ws?role=guest&peerId=${peerId}`, {
          Origin: 'https://musixquare.com',
          Upgrade: 'websocket',
          'CF-Connecting-IP': ip,
        }),
        routed.env,
      );

    const firstIp = await Promise.all(
      Array.from({ length: 120 }, (_, index) => open('203.0.113.10', `first-ip-${index}`)),
    );
    const firstIpDenied = await open('203.0.113.10', 'first-ip-denied');
    const secondIpAllowed = await open('203.0.113.11', 'second-ip-allowed');

    expect(firstIp.every((response) => response.status === 101)).toBe(true);
    expect(firstIpDenied.status).toBe(429);
    expect(secondIpAllowed.status).toBe(101);
    expect(routed.rateObjectStates.size).toBe(2);
    expect(
      [...routed.rateObjectStates.keys()].every(
        (name) =>
          name.startsWith(STANDARD_WS_RATE_OBJECT_PREFIX) &&
          !name.includes('203.0.113.10') &&
          !name.includes('203.0.113.11'),
      ),
    ).toBe(true);
  });

  it('fails standard admission closed on corrupt local rate state or a local rate fetch failure', async () => {
    const corrupt = workerEnv({
      rateStateSeed: { v: 1, windowStartMs: 0, resetAtMs: 60_000, count: 'corrupt' },
    });
    corrupt.env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const corruptResponse = await workerModule.default.fetch(
      requestLike(
        'https://signal.example.test/api/rooms/123456/ws?role=guest&peerId=corrupt-rate',
        {
          Origin: 'https://musixquare.com',
          Upgrade: 'websocket',
          'CF-Connecting-IP': '203.0.113.12',
        },
      ),
      corrupt.env,
    );
    expect(corruptResponse.status).toBe(503);
    expect(corrupt.roomFetch).not.toHaveBeenCalled();

    const failed = workerEnv({ rateFetchError: new Error('simulated local rate failure') });
    failed.env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const failedResponse = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/rooms/123456/ws?role=guest&peerId=failed-rate', {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
        'CF-Connecting-IP': '203.0.113.13',
      }),
      failed.env,
    );
    expect(failedResponse.status).toBe(503);
    expect(failed.roomFetch).not.toHaveBeenCalled();
  });

  it('keeps the reserved standard rate object unreachable through public room paths', async () => {
    const routed = workerEnv();
    const reservedName = `${STANDARD_WS_RATE_OBJECT_PREFIX}${'A'.repeat(43)}`;
    const reservedObject = new workerModule.MusixquareRoom(
      new FakeDurableObjectState(reservedName),
    );

    const publicResponse = await workerModule.default.fetch(
      requestLike(
        `https://signal.example.test/api/rooms/${reservedName}/ws?role=guest&peerId=reserved-probe`,
        { Origin: 'https://musixquare.com', Upgrade: 'websocket' },
      ),
      routed.env,
    );
    const internalResponse = await workerModule.default.fetch(
      requestLike(`https://signal.example.test${STANDARD_WS_RATE_CONSUME_PATH}`, {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
      }),
      routed.env,
    );
    const directRoomResponse = await reservedObject.fetch(
      wsRequest('123456', 'guest', 'reserved-direct-probe'),
    );

    expect(publicResponse.status).toBe(200);
    expect(internalResponse.status).toBe(404);
    expect(directRoomResponse.status).toBe(404);
    expect(routed.idFromName).not.toHaveBeenCalled();
    expect(routed.roomGet).not.toHaveBeenCalled();
  });

  it('expires a reserved standard rate object through its persistent alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
    const state = new FakeDurableObjectState(`${STANDARD_WS_RATE_OBJECT_PREFIX}${'B'.repeat(43)}`);
    const rateObject = new workerModule.MusixquareRoom(state);

    const consumed = await rateObject.fetch(
      new Request(`https://signaling-rate.internal${STANDARD_WS_RATE_CONSUME_PATH}`, {
        method: 'POST',
      }),
    );
    expect(consumed.status).toBe(204);
    expect(await state.storage.get(STANDARD_WS_RATE_STATE_KEY)).toMatchObject({ count: 1 });
    expect(state.storage.alarmTime).toBe(Date.now() + 60_000);

    vi.advanceTimersByTime(30_000);
    await rateObject.alarm();
    expect(await state.storage.get(STANDARD_WS_RATE_STATE_KEY)).toMatchObject({ count: 1 });
    expect(state.storage.alarmTime).toBe(Date.now() + 30_000);

    vi.advanceTimersByTime(30_000);
    await rateObject.alarm();
    expect(await state.storage.get(STANDARD_WS_RATE_STATE_KEY)).toBeUndefined();
    expect(state.storage.alarmTime).toBeNull();
  });

  it('uses Service-Control only for maintenance, not standard WebSocket-open consumption', async () => {
    const routed = workerEnv();
    routed.env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const paths: string[] = [];
    routed.env.MUSIXQUARE_SERVICE_CONTROL = {
      getByName: vi.fn(() => ({
        fetch: vi.fn(async (request: Request) => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path !== SERVICE_CONTROL_STATUS_PATH) throw new Error('unexpected abuse consume');
          return originalResponse.json({
            serviceStatus: {
              enabled: false,
              revision: 0,
              updatedAt: null,
              activatedAt: null,
            },
          });
        }),
      })),
    };

    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/rooms/123456/ws?role=host&peerId=local-rate', {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
        'CF-Connecting-IP': '203.0.113.14',
      }),
      routed.env,
    );

    expect(response.status).toBe(101);
    expect(paths).toEqual([SERVICE_CONTROL_STATUS_PATH]);
    expect(paths).not.toContain(ABUSE_RATE_CONSUME_PATH);
  });

  it('does not interpret a retired host secret query at the edge', async () => {
    const { env, idFromName, roomFetch } = workerEnv();
    const request = requestLike(
      'https://signal.example.test/api/rooms/123456/ws?role=host&peerId=host&secret=bad!secret',
      {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
      },
    );

    const response = await workerModule.default.fetch(request, env);

    expect(response.status).toBe(101);
    expect(idFromName).toHaveBeenCalledWith('123456');
    expect(roomFetch).toHaveBeenCalledWith(request);
  });

  it.each([
    ['000000', 'host'],
    ['000000', 'guest'],
    ['000001', 'host'],
    ['000001', 'guest'],
    ['000002', 'host'],
    ['000002', 'guest'],
  ] as const)(
    'rejects reserved room %s %s claims before Durable Object lookup',
    async (roomId, role) => {
      const { env, idFromName, roomFetch } = workerEnv();
      const url = new URL(`https://signal.example.test/api/rooms/${roomId}/ws`);
      url.searchParams.set('role', role);
      url.searchParams.set('peerId', `${role}-peer`);

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
    ['100000', 'host'],
    ['100000', 'guest'],
    ['999999', 'host'],
    ['999999', 'guest'],
  ] as const)('keeps ordinary room %s %s routing to its Durable Object', async (roomId, role) => {
    const { env, idFromName, roomFetch } = workerEnv();
    const url = new URL(`https://signal.example.test/api/rooms/${roomId}/ws`);
    url.searchParams.set('role', role);
    url.searchParams.set('peerId', `${role}-${roomId}`);
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
  });

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
      requestLike('https://signal.example.test/api/pro-rooms/000002/ws', {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': proProtocolHeader('not-a-ticket'),
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

    const response = await room.fetch(wsRequest('000000', 'host', 'host-1'));

    expect(response.status).toBe(403);
    expect(state.sockets).toHaveLength(0);
    expect(FakeWebSocketPair.pairs).toHaveLength(0);
  });

  it('rejects URL query fields even when the PRO subprotocol ticket is valid', async () => {
    const { env, idFromName, roomFetch } = workerEnv();
    env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const ticket = await proTicket({ role: 'member', participantId: 'signed-member' });
    const url = new URL('https://signal.example.test/api/pro-rooms/000001/ws');
    url.searchParams.set('role', 'host');
    url.searchParams.set('peerId', 'unsigned-attacker-id');

    const response = await workerModule.default.fetch(
      requestLike(url.toString(), {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': proProtocolHeader(ticket),
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(idFromName).not.toHaveBeenCalled();
    expect(roomFetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing stable marker',
      (ticket: string) => `${PRO_SIGNALING_TICKET_PROTOCOL_PREFIX}${ticket}`,
    ],
    [
      'reversed order',
      (ticket: string) =>
        `${PRO_SIGNALING_TICKET_PROTOCOL_PREFIX}${ticket}, ${PRO_SIGNALING_WEBSOCKET_PROTOCOL}`,
    ],
    ['extra protocol', (ticket: string) => `${proProtocolHeader(ticket)}, unrelated.protocol`],
    [
      'duplicate stable marker',
      (ticket: string) => `${PRO_SIGNALING_WEBSOCKET_PROTOCOL}, ${proProtocolHeader(ticket)}`,
    ],
  ] as const)('rejects a PRO WebSocket with %s', async (_label, protocolHeader) => {
    const { env, idFromName, roomFetch } = workerEnv();
    env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const ticket = await proTicket({ participantId: 'strict-protocol-member' });
    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/pro-rooms/000001/ws', {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': protocolHeader(ticket),
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(idFromName).not.toHaveBeenCalled();
    expect(roomFetch).not.toHaveBeenCalled();
  });

  it('rejects an untrusted PRO WebSocket origin before Durable Object lookup', async () => {
    const { env, idFromName, roomFetch } = workerEnv();
    env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const ticket = await proTicket({ participantId: 'origin-probe-member' });
    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/pro-rooms/000001/ws', {
        Origin: 'https://evil.example',
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': proProtocolHeader(ticket),
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(idFromName).not.toHaveBeenCalled();
    expect(roomFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['valid signed ticket', true],
    ['opaque value', false],
  ] as const)('rejects a URL ticket credential permanently: %s', async (_label, signed) => {
    const routed = workerEnv();
    routed.env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const ticket = signed
      ? await proTicket({ participantId: 'query-credential-member' })
      : 'opaque';
    const url = new URL('https://signal.example.test/api/pro-rooms/000001/ws');
    url.searchParams.set('ticket', ticket);

    const response = await workerModule.default.fetch(
      requestLike(url.toString(), {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
      }),
      routed.env,
    );

    expect(response.status).toBe(401);
    expect(JSON.parse(String(response.body))).toEqual({ error: 'INVALID_PRO_SIGNALING_TICKET' });
    expect(routed.idFromName).not.toHaveBeenCalled();
    expect(routed.roomFetch).not.toHaveBeenCalled();
  });

  it('rejects URL ticket credentials inside the Durable Object boundary too', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const ticket = await proTicket({ participantId: 'direct-query-credential-member' });
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

  it('selects only the stable PRO protocol and never echoes the bearer ticket', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const ticket = await proTicket({ participantId: 'selected-protocol-member' });
    const response = await room.fetch(
      requestLike('https://signal.example.test/api/pro-rooms/000001/ws', {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': proProtocolHeader(ticket),
      }),
    );

    expect(response.status).toBe(101);
    expect(response.headers).toEqual({
      'Sec-WebSocket-Protocol': PRO_SIGNALING_WEBSOCKET_PROTOCOL,
    });
    expect(JSON.stringify(response.headers)).not.toContain(ticket);
  });

  it('applies the atomic outer limiter to a valid PRO ticket before room routing', async () => {
    const { env, idFromName, roomFetch } = workerEnv();
    const control = atomicRateBinding(1, 120);
    env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    env.MUSIXQUARE_SERVICE_CONTROL = control.binding;
    const ticket = await proTicket({ participantId: 'rate-limited-pro-member' });

    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/pro-rooms/000001/ws', {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
        'CF-Connecting-IP': '203.0.113.122',
        'Sec-WebSocket-Protocol': proProtocolHeader(ticket),
      }),
      env,
    );

    expect(response.status).toBe(429);
    expect(idFromName).not.toHaveBeenCalled();
    expect(roomFetch).not.toHaveBeenCalled();
    expect(control.rateFetchCount()).toBe(1);
  });

  it('routes each reusable PRO room generation to an isolated Durable Object name', async () => {
    const { env, idFromName, roomFetch } = workerEnv();
    env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const ticket = await proTicket({
      roomGeneration: 17,
      participantId: 'generation-seventeen-member',
    });

    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/pro-rooms/000001/ws', {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': proProtocolHeader(ticket),
      }),
      env,
    );

    expect(response.status).toBe(101);
    expect(idFromName).toHaveBeenCalledWith('000001:generation:17');
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

    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/pro-rooms/000002/ws', {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': proProtocolHeader(ticket),
      }),
      env,
    );

    expect(response.status).toBe(101);
    expect(idFromName).toHaveBeenCalledWith('000002:generation:0');
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
    ['blank-filler display name', async () => proTicket({ displayName: '\u3164' })],
    ['zero-width display name', async () => proTicket({ displayName: 'Peer\u200bOne' })],
    ['nonbreaking-space display name', async () => proTicket({ displayName: 'Peer\u00a0One' })],
    ['invalid room generation', async () => proTicket({ roomGeneration: -1 })],
    ['negative presence revision', async () => proTicket({ presenceRevision: -1 })],
  ] as const)('rejects a PRO %s before Durable Object lookup', async (_label, makeTicket) => {
    const { env, idFromName, roomFetch } = workerEnv();
    env.PRO_SIGNALING_SECRET = PRO_SIGNALING_SECRET;
    const ticket = await makeTicket();

    const response = await workerModule.default.fetch(
      requestLike('https://signal.example.test/api/pro-rooms/000001/ws', {
        Origin: 'https://musixquare.com',
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': proProtocolHeader(ticket),
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

    const response = await room.fetch(
      requestLike('https://signal.example.test/api/pro-rooms/000001/ws', {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': proProtocolHeader(ticket),
      }),
    );

    expect(response.status).toBe(401);
    expect(state.sockets).toHaveLength(0);
    expect(FakeWebSocketPair.pairs).toHaveLength(0);
  });

  it('admits every signed PRO participant as an equal member and ignores the signed legacy role', async () => {
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
      await proWsRequest({
        role: 'member',
        participantId: 'signed-member',
        jti: 'member-ticket-0000001',
      }),
    );
    const member = lastServer();

    expect(coordinator.deserializeAttachment()).toMatchObject({
      roomKind: 'pro',
      role: 'member',
      roomId: '000001',
      roomGeneration: 0,
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
      roomGeneration: 0,
      coordinatorEpoch: 1,
      auth: 'ok',
    });
    expect(sent(member)[0]).toMatchObject({
      type: 'peer-open',
      peerId: 'signed-member',
      roomId: '000001',
      roomGeneration: 0,
    });
    expect(await state.storage.get('proRoomMeta')).toMatchObject({
      v: 2,
      kind: 'pro',
      roomId: '000001',
      roomGeneration: 0,
      coordinatorEpoch: 1,
    });
    expect(await state.storage.get('proSignalingTicketUses')).toMatchObject({ roomGeneration: 0 });
    expect(await state.storage.get('proSignalingParticipantHighWater')).toMatchObject({
      roomGeneration: 0,
    });
  });

  it('binds PRO signaling state, broadcasts, and decommission tombstones to one generation', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const generation = 23;
    const presenceIncarnationId = 'generation-bound-presence-01';
    const member = await joinProMember(room, {
      roomGeneration: generation,
      participantId: 'generation-bound-member',
      presenceIncarnationId,
      jti: 'generation-bound-ticket-001',
    });

    expect(member.deserializeAttachment()).toMatchObject({
      roomKind: 'pro',
      roomId: '000001',
      roomGeneration: generation,
    });
    expect(await state.storage.get('proRoomMeta')).toMatchObject({
      roomId: '000001',
      roomGeneration: generation,
    });
    expect(await state.storage.get('proSignalingTicketUses')).toMatchObject({
      roomGeneration: generation,
      entries: [{ jti: 'generation-bound-ticket-001' }],
    });
    expect(await state.storage.get('proSignalingParticipantHighWater')).toMatchObject({
      roomGeneration: generation,
      entries: [{ participantId: 'generation-bound-member' }],
    });

    await room.fetch(
      await proWsRequest({
        roomGeneration: generation + 1,
        participantId: 'wrong-generation-member',
        presenceIncarnationId: 'wrong-generation-presence-01',
        jti: 'wrong-generation-ticket-0001',
      }),
    );
    expect(lastServer().closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'PRO_ROOM_GENERATION_MISMATCH',
    });

    const broadcast = (roomGeneration: number) =>
      room.fetch(
        new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': '000001',
            'x-mxqr-pro-room-generation': String(roomGeneration),
          },
          body: JSON.stringify({
            roomCode: '000001',
            roomGeneration,
            coordinatorEpoch: 1,
            targets: [presenceIncarnationId],
            event: { type: 'pro-presence-snapshot', presenceRevision: 1 },
          }),
        }),
      );

    expect((await broadcast(generation + 1)).status).toBe(409);
    expect((await broadcast(generation)).status).toBe(200);
    expect(await state.storage.get('proSignalingPresenceAuthority')).toMatchObject({
      roomId: '000001',
      roomGeneration: generation,
      activeIncarnationIds: [presenceIncarnationId],
    });
    expect(sent(member).at(-1)).toMatchObject({
      type: 'pro-server-event',
      roomCode: '000001',
      roomGeneration: generation,
    });

    const requestId = '32345678-1234-4123-8123-123456789abc';
    const decommission = (roomGeneration: number) =>
      room.fetch(
        new Request('https://signaling.internal/internal/admin/v1/decommission', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': '000001',
            'x-mxqr-pro-room-generation': String(roomGeneration),
          },
          body: JSON.stringify({ roomCode: '000001', roomGeneration, requestId }),
        }),
      );

    expect((await decommission(generation + 1)).status).toBe(409);
    const deleted = await decommission(generation);
    expect(deleted.status).toBe(200);
    expect(JSON.parse(String(deleted.body))).toMatchObject({
      ok: true,
      roomCode: '000001',
      roomGeneration: generation,
      status: 'decommissioned',
    });
    expect(await state.storage.get('proRoomDecommissioned')).toMatchObject({
      roomCode: '000001',
      roomGeneration: generation,
    });
  });

  it('initializes an empty PRO signaling namespace from the first authoritative presence snapshot', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const presenceIncarnationId = 'initial-presence-incarnation-01';

    const initialized = await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
      roomGeneration: 0,
      coordinatorEpoch: 3,
    });
    expect(await state.storage.get('proSignalingPresenceAuthority')).toEqual({
      v: 1,
      roomId: '000001',
      roomGeneration: 0,
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
      roomGeneration: 0,
      coordinatorEpoch: 2,
    });
    expect(await state.storage.get('proSignalingPresenceAuthority')).toEqual({
      v: 1,
      roomId: '000001',
      roomGeneration: 0,
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
      roomGeneration: 0,
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
      roomGeneration: 0,
      coordinatorEpoch: 1,
      presenceRevision: 9,
      activeIncarnationIds: ['race-presence-alice-0001', 'race-presence-bob-000001'],
    });

    const rejectedRollback = await room.fetch(
      new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': '000001',
            'x-mxqr-pro-room-generation': '0',
          },
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
      roomGeneration: 0,
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

  it('relays a large authorized PRO system-audio offer only to its exact target', async () => {
    const authorityBodies: Record<string, unknown>[] = [];
    const authority = proAuthorityNamespace(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      authorityBodies.push(body);
      return new originalResponse(
        JSON.stringify({
          allowed: true,
          roomCode: '000001',
          roomGeneration: 0,
          memberId: 'owner_systemaudiosender0001',
          role: 'owner',
          permission: 'system-audio.signal',
          targetParticipantId: body.targetParticipantId,
          targetPresenceIncarnationId: body.targetPresenceIncarnationId,
          direction: body.direction,
          generation: body.generation,
          publicationId: body.publicationId,
          negotiationId: body.negotiationId,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    });
    const publisher = await joinProMember(room, {
      participantId: 'system-audio-publisher-0001',
      memberId: 'owner_systemaudiosender0001',
      displayName: 'Publisher',
      presenceIncarnationId: 'system-audio-publisher-presence-0001',
      jti: 'system-audio-publisher-ticket-0001',
    });
    const subscriber = await joinProMember(room, {
      participantId: 'system-audio-subscriber-0001',
      displayName: 'Subscriber',
      presenceIncarnationId: 'system-audio-subscriber-presence-0001',
      jti: 'system-audio-subscriber-ticket-0001',
    });
    const bystander = await joinProMember(room, {
      participantId: 'system-audio-bystander-0001',
      displayName: 'Bystander',
      presenceIncarnationId: 'system-audio-bystander-presence-0001',
      jti: 'system-audio-bystander-ticket-0001',
    });
    const counts = [publisher.sent.length, subscriber.sent.length, bystander.sent.length];
    const signalFrame = {
      type: 'pro-realtime',
      version: 1,
      eventId: 'system-audio-offer-event-0001',
      channel: 'system-audio-signal',
      payload: {
        kind: 'offer',
        targetParticipantId: 'system-audio-subscriber-0001',
        direction: 'publisher',
        phase: 'media',
        generation: 9,
        publicationId: 'system-audio-publication-0001',
        negotiationId: 'system-audio-negotiation-0001',
        description: { type: 'offer', sdp: `v=0\r\n${'a=x\r\n'.repeat(1_500)}` },
        trackIds: { L: 'captured-left-track', R: 'captured-right-track' },
      },
    };
    const raw = JSON.stringify(signalFrame);
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(8 * 1024);

    await room.webSocketMessage(publisher, raw);

    expect(authorityBodies).toEqual([
      {
        roomGeneration: 0,
        participantId: 'system-audio-publisher-0001',
        presenceIncarnationId: 'system-audio-publisher-presence-0001',
        permission: 'system-audio.signal',
        targetParticipantId: 'system-audio-subscriber-0001',
        targetPresenceIncarnationId: 'system-audio-subscriber-presence-0001',
        direction: 'publisher',
        generation: 9,
        publicationId: 'system-audio-publication-0001',
        negotiationId: 'system-audio-negotiation-0001',
      },
    ]);
    expect(publisher.sent).toHaveLength(counts[0]);
    expect(subscriber.sent).toHaveLength(counts[1] + 1);
    expect(bystander.sent).toHaveLength(counts[2]);
    expect(sent(subscriber).at(-1)).toMatchObject({
      ...signalFrame,
      roomCode: '000001',
      roomGeneration: 0,
      coordinatorEpoch: 1,
      sender: {
        participantId: 'system-audio-publisher-0001',
        presenceIncarnationId: 'system-audio-publisher-presence-0001',
      },
    });
    expect(publisher.closed).toBe(false);
  });

  it('fails PRO system-audio signaling closed for self, missing, and replaced targets', async () => {
    let releaseAuthority!: () => void;
    const authorityGate = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    let authorityEnteredResolve: (() => void) | null = null;
    const authorityEntered = new Promise<void>((resolve) => {
      authorityEnteredResolve = resolve;
    });
    const authority = proAuthorityNamespace(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      authorityEnteredResolve?.();
      await authorityGate;
      return new originalResponse(
        JSON.stringify({
          allowed: true,
          roomCode: '000001',
          roomGeneration: 0,
          memberId: 'owner_systemaudiorace000001',
          role: 'owner',
          permission: 'system-audio.signal',
          targetParticipantId: body.targetParticipantId,
          targetPresenceIncarnationId: body.targetPresenceIncarnationId,
          direction: body.direction,
          generation: body.generation,
          publicationId: body.publicationId,
          negotiationId: body.negotiationId,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    });
    const publisher = await joinProMember(room, {
      participantId: 'system-audio-race-publisher',
      memberId: 'owner_systemaudiorace000001',
      presenceIncarnationId: 'system-audio-race-publisher-presence',
      jti: 'system-audio-race-publisher-ticket',
    });
    const originalTarget = await joinProMember(room, {
      participantId: 'system-audio-race-target-0001',
      presenceIncarnationId: 'system-audio-race-target-presence-0001',
      ticketSequence: 1,
      jti: 'system-audio-race-target-ticket-0001',
    });
    const commonPayload = {
      kind: 'candidate',
      direction: 'publisher',
      generation: 11,
      publicationId: 'system-audio-race-publication-0001',
      negotiationId: 'system-audio-race-negotiation-0001',
      candidate: {
        candidate: 'candidate:1 1 UDP 1 123e4567-e89b-42d3-a456-426614174000.local 5000 typ host',
      },
    };
    const sendTo = (targetParticipantId: string, eventId: string) =>
      room.webSocketMessage(
        publisher,
        JSON.stringify({
          type: 'pro-realtime',
          version: 1,
          eventId,
          channel: 'system-audio-signal',
          payload: { ...commonPayload, targetParticipantId },
        }),
      );

    await sendTo('system-audio-race-publisher', 'system-audio-self-event-0001');
    await sendTo('system-audio-missing-target', 'system-audio-missing-event-0001');
    expect(authority.roomFetch).not.toHaveBeenCalled();

    const originalCount = originalTarget.sent.length;
    const pendingRelay = sendTo('system-audio-race-target-0001', 'system-audio-race-event-0001');
    await authorityEntered;
    const replacementTarget = await joinProMember(room, {
      participantId: 'system-audio-race-target-0001',
      presenceIncarnationId: 'system-audio-race-target-presence-0002',
      ticketSequence: 2,
      jti: 'system-audio-race-target-ticket-0002',
    });
    const replacementCount = replacementTarget.sent.length;
    releaseAuthority();
    await pendingRelay;

    expect(originalTarget.sent).toHaveLength(originalCount);
    expect(replacementTarget.sent).toHaveLength(replacementCount);
    expect(publisher.closed).toBe(false);
  });

  it('preserves per-sender PRO system-audio signal order across delayed authority checks', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEnteredResolve!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      firstEnteredResolve = resolve;
    });
    let authorityCalls = 0;
    const authority = proAuthorityNamespace(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      authorityCalls += 1;
      if (authorityCalls === 1) {
        firstEnteredResolve();
        await firstGate;
      }
      return new originalResponse(
        JSON.stringify({
          allowed: true,
          roomCode: '000001',
          roomGeneration: 0,
          memberId: 'owner_systemaudioorder000001',
          role: 'owner',
          permission: 'system-audio.signal',
          targetParticipantId: body.targetParticipantId,
          targetPresenceIncarnationId: body.targetPresenceIncarnationId,
          direction: body.direction,
          generation: body.generation,
          publicationId: body.publicationId,
          negotiationId: body.negotiationId,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const room = new workerModule.MusixquareRoom(new FakeDurableObjectState(), {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    });
    const publisher = await joinProMember(room, {
      participantId: 'system-audio-order-publisher',
      memberId: 'owner_systemaudioorder000001',
      presenceIncarnationId: 'system-audio-order-publisher-presence',
      jti: 'system-audio-order-publisher-ticket',
    });
    const subscriber = await joinProMember(room, {
      participantId: 'system-audio-order-subscriber',
      presenceIncarnationId: 'system-audio-order-subscriber-presence',
      jti: 'system-audio-order-subscriber-ticket',
    });
    const targetParticipantId = 'system-audio-order-subscriber';
    const publicationId = 'system-audio-order-publication-0001';
    const firstNegotiationId = 'system-audio-order-negotiation-0001';
    const secondNegotiationId = 'system-audio-order-negotiation-0002';
    const frame = (eventId: string, payload: Record<string, unknown>) =>
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId,
        channel: 'system-audio-signal',
        payload,
      });
    const common = {
      targetParticipantId,
      direction: 'publisher',
      generation: 12,
      publicationId,
    };
    const before = subscriber.sent.length;
    const firstOffer = room.webSocketMessage(
      publisher,
      frame('system-audio-order-event-0001', {
        ...common,
        kind: 'offer',
        phase: 'probe',
        negotiationId: firstNegotiationId,
        description: { type: 'offer', sdp: 'v=0\r\nc=IN IP4 0.0.0.0\r\n' },
      }),
    );
    await firstEntered;
    const close = room.webSocketMessage(
      publisher,
      frame('system-audio-order-event-0002', {
        ...common,
        kind: 'close',
        negotiationId: firstNegotiationId,
        reason: 'superseded',
      }),
    );
    const secondOffer = room.webSocketMessage(
      publisher,
      frame('system-audio-order-event-0003', {
        ...common,
        kind: 'offer',
        phase: 'probe',
        negotiationId: secondNegotiationId,
        description: { type: 'offer', sdp: 'v=0\r\nc=IN IP4 0.0.0.0\r\n' },
      }),
    );
    await Promise.resolve();
    expect(authority.roomFetch).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([firstOffer, close, secondOffer]);

    const ordered = sent(subscriber)
      .slice(before)
      .filter((message) => message.channel === 'system-audio-signal')
      .map((message) => {
        const payload = message.payload as Record<string, unknown>;
        return [payload.kind, payload.negotiationId];
      });
    expect(ordered).toEqual([
      ['offer', firstNegotiationId],
      ['close', firstNegotiationId],
      ['offer', secondNegotiationId],
    ]);
  });

  it('bounds a sender signal backlog while an authority check is delayed', async () => {
    let releaseAuthority!: () => void;
    const authorityGate = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    let authorityEnteredResolve!: () => void;
    const authorityEntered = new Promise<void>((resolve) => {
      authorityEnteredResolve = resolve;
    });
    const authority = proAuthorityNamespace(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      authorityEnteredResolve();
      await authorityGate;
      return new originalResponse(
        JSON.stringify({
          allowed: true,
          roomCode: '000001',
          roomGeneration: 0,
          memberId: 'owner_systemaudiobacklog0001',
          role: 'owner',
          permission: 'system-audio.signal',
          targetParticipantId: body.targetParticipantId,
          targetPresenceIncarnationId: body.targetPresenceIncarnationId,
          direction: body.direction,
          generation: body.generation,
          publicationId: body.publicationId,
          negotiationId: body.negotiationId,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const room = new workerModule.MusixquareRoom(new FakeDurableObjectState(), {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    });
    const publisher = await joinProMember(room, {
      participantId: 'system-audio-backlog-publisher',
      memberId: 'owner_systemaudiobacklog0001',
      presenceIncarnationId: 'system-audio-backlog-publisher-presence',
      jti: 'system-audio-backlog-publisher-ticket',
    });
    const subscriber = await joinProMember(room, {
      participantId: 'system-audio-backlog-subscriber',
      presenceIncarnationId: 'system-audio-backlog-subscriber-presence',
      jti: 'system-audio-backlog-subscriber-ticket',
    });
    const signal = (index: number) =>
      room.webSocketMessage(
        publisher,
        JSON.stringify({
          type: 'pro-realtime',
          version: 1,
          eventId: `system-audio-backlog-event-${String(index).padStart(4, '0')}`,
          channel: 'system-audio-signal',
          payload: {
            kind: 'offer',
            targetParticipantId: 'system-audio-backlog-subscriber',
            direction: 'publisher',
            phase: 'probe',
            generation: 13,
            publicationId: 'system-audio-backlog-publication-0001',
            negotiationId: `system-audio-backlog-negotiation-${String(index).padStart(4, '0')}`,
            description: { type: 'offer', sdp: 'v=0\r\nc=IN IP4 0.0.0.0\r\n' },
          },
        }),
      );

    const first = signal(0);
    await authorityEntered;
    const queued = Array.from({ length: 15 }, (_, index) => signal(index + 1));
    await vi.waitFor(() => {
      const attachment = publisher.deserializeAttachment() as Record<string, unknown>;
      expect(attachment.realtimeMessageTokens).toEqual(expect.any(Number));
      expect(attachment.realtimeMessageTokens as number).toBeLessThan(105);
    });

    expect(authority.roomFetch).toHaveBeenCalledTimes(1);
    expect(publisher.closed).toBe(false);
    const overflow = signal(16);
    await vi.waitFor(() => expect(publisher.closed).toBe(true));
    releaseAuthority();
    await Promise.all([first, ...queued, overflow]);
    expect(sent(subscriber).filter((message) => message.channel === 'system-audio-signal')).toEqual(
      [],
    );
  });

  it('bounds all PRO ingress before a delayed maintenance read retains frame bodies', async () => {
    const env: Record<string, unknown> = { PRO_SIGNALING_SECRET };
    const room = new workerModule.MusixquareRoom(new FakeDurableObjectState(), env);
    const publisher = await joinProMember(room, {
      participantId: 'system-audio-maintenance-backlog-publisher',
      memberId: 'owner_systemaudiomaintenance001',
      presenceIncarnationId: 'system-audio-maintenance-backlog-presence',
      jti: 'system-audio-maintenance-backlog-ticket',
    });
    const delayedMaintenance = gatedInactiveMaintenanceBinding();
    env.MUSIXQUARE_SERVICE_CONTROL = delayedMaintenance.binding;
    const paddedSdp = `v=0\r\nc=IN IP4 0.0.0.0\r\n${'a=x\r\n'.repeat(6_000)}`;
    const signal = (index: number) =>
      room.webSocketMessage(
        publisher,
        JSON.stringify({
          type: 'pro-realtime',
          version: 1,
          eventId: `system-audio-maintenance-event-${String(index).padStart(4, '0')}`,
          channel: 'system-audio-signal',
          payload: {
            kind: 'offer',
            targetParticipantId: 'system-audio-maintenance-target',
            direction: 'publisher',
            phase: 'probe',
            generation: 14,
            publicationId: 'system-audio-maintenance-publication-0001',
            negotiationId: `system-audio-maintenance-negotiation-${String(index).padStart(4, '0')}`,
            description: { type: 'offer', sdp: paddedSdp },
          },
        }),
      );

    const first = signal(0);
    await delayedMaintenance.entered;
    const admitted = Array.from({ length: 31 }, (_, index) => signal(index + 1));
    expect(publisher.closed).toBe(false);
    const overflow = signal(32);
    expect(publisher.closed).toBe(true);

    delayedMaintenance.release();
    await Promise.all([first, ...admitted, overflow]);
  });

  it('authorizes PRO notices with the admitted participant and exact presence incarnation', async () => {
    const authority = proAuthorityNamespace(async (request) => {
      expect(new URL(request.url).pathname).toBe('/internal/authority/check');
      expect(request.method).toBe('POST');
      expect(request.headers.get('x-mxqr-pro-room-code')).toBe('000001');
      expect(request.headers.get('x-mxqr-pro-room-generation')).toBe('0');
      expect(await request.json()).toEqual({
        roomGeneration: 0,
        participantId: 'notice-authorized',
        presenceIncarnationId: 'notice-presence-authorized',
        permission: 'chat.notice',
      });
      return new originalResponse(
        JSON.stringify({
          allowed: true,
          roomCode: '000001',
          roomGeneration: 0,
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

    expect(authority.binding.idFromName).toHaveBeenCalledWith('000001:generation:0');
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

  it('routes PRO authority checks by generation and rejects a mismatched authority response', async () => {
    const authority = proAuthorityNamespace(async (request) => {
      expect(request.headers.get('x-mxqr-pro-room-code')).toBe('000001');
      expect(request.headers.get('x-mxqr-pro-room-generation')).toBe('31');
      expect(await request.json()).toEqual({
        roomGeneration: 31,
        participantId: 'generation-authority-sender',
        presenceIncarnationId: 'generation-authority-presence',
        permission: 'chat.notice',
      });
      return new originalResponse(
        JSON.stringify({
          allowed: true,
          roomCode: '000001',
          roomGeneration: 30,
          memberId: 'member_generationauthority001',
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
      roomGeneration: 31,
      participantId: 'generation-authority-sender',
      presenceIncarnationId: 'generation-authority-presence',
      jti: 'generation-authority-ticket1',
    });
    const recipient = await joinProMember(room, {
      roomGeneration: 31,
      participantId: 'generation-authority-target',
      presenceIncarnationId: 'generation-authority-target-presence',
      jti: 'generation-authority-ticket2',
    });
    const recipientCount = recipient.sent.length;

    await room.webSocketMessage(
      sender,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'generation-authority-event1',
        channel: 'chat',
        payload: { kind: 'notice', text: 'must not relay' },
      }),
    );

    expect(authority.binding.idFromName).toHaveBeenCalledWith('000001:generation:31');
    expect(recipient.sent).toHaveLength(recipientCount);
    expect(sender.closed).toBe(false);
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
    let timeoutRequest: Request | null = null;
    const timeoutAuthority = proAuthorityNamespace((request) => {
      timeoutRequest = request;
      return new Promise<Response>(() => {});
    });
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
    expect((timeoutRequest as Request | null)?.signal.aborted).toBe(true);
    expect(timeoutRecipient.sent).toHaveLength(timeoutRecipientCount);
    expect(timeoutSender.closed).toBe(false);
  });

  it('bounds and cancels a stalled PRO authority response body', async () => {
    const timeoutController = new AbortController();
    const timeoutSignal = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((milliseconds: number) => {
        expect(milliseconds).toBe(1_000);
        return timeoutController.signal;
      });
    const cancel = vi.fn();
    const authority = proAuthorityNamespace(
      async () =>
        new originalResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"allowed":true'));
            },
            cancel,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const room = new workerModule.MusixquareRoom(new FakeDurableObjectState(), {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    });
    const sender = await joinProMember(room, {
      participantId: 'body-timeout-notice-sender',
      presenceIncarnationId: 'body-timeout-notice-incarnation',
      jti: 'body-timeout-notice-ticket1',
    });
    const recipient = await joinProMember(room, {
      participantId: 'body-timeout-notice-target',
      presenceIncarnationId: 'body-timeout-notice-target1',
      jti: 'body-timeout-target-ticket1',
    });
    const recipientCount = recipient.sent.length;
    const pending = room.webSocketMessage(
      sender,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId: 'body-timeout-notice-event1',
        channel: 'chat',
        payload: { kind: 'notice', text: 'must time out closed' },
      }),
    );
    await vi.waitFor(() => expect(authority.roomFetch).toHaveBeenCalledOnce());
    timeoutController.abort(new DOMException('authority body timeout', 'TimeoutError'));
    await pending;
    timeoutSignal.mockRestore();

    expect(cancel).toHaveBeenCalledOnce();
    expect(recipient.sent).toHaveLength(recipientCount);
    expect(sender.closed).toBe(false);
  });

  it.each([
    {
      label: 'oversized',
      bytes: new Uint8Array(4 * 1024 + 1),
      eventId: 'oversized-authority-response1',
    },
    {
      label: 'malformed UTF-8',
      bytes: new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]),
      eventId: 'utf8-authority-response-event1',
    },
  ])('rejects a $label PRO authority response', async ({ bytes, eventId }) => {
    const authority = proAuthorityNamespace(
      async () =>
        new originalResponse(bytes, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const room = new workerModule.MusixquareRoom(new FakeDurableObjectState(), {
      PRO_SIGNALING_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: authority.binding,
    });
    const sender = await joinProMember(room, {
      participantId: `${eventId}-sender`.slice(0, 80),
      presenceIncarnationId: `${eventId}-sender-presence`.slice(0, 80),
      jti: `${eventId}-sender-ticket`.slice(0, 80),
    });
    const recipient = await joinProMember(room, {
      participantId: `${eventId}-target`.slice(0, 80),
      presenceIncarnationId: `${eventId}-target-presence`.slice(0, 80),
      jti: `${eventId}-target-ticket`.slice(0, 80),
    });
    const recipientCount = recipient.sent.length;

    await room.webSocketMessage(
      sender,
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        eventId,
        channel: 'chat',
        payload: { kind: 'notice', text: 'must fail closed' },
      }),
    );

    expect(authority.roomFetch).toHaveBeenCalledOnce();
    expect(recipient.sent).toHaveLength(recipientCount);
    expect(sender.closed).toBe(false);
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
          roomCode: '000001',
          roomGeneration: 0,
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
                roomCode: '000001',
                roomGeneration: 0,
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
      roomGeneration: 0,
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
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': '000001',
            'x-mxqr-pro-room-generation': '0',
          },
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
                roomCode: '000001',
                roomGeneration: 0,
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
      roomGeneration: 0,
      participantId: 'provenance-sender',
      presenceIncarnationId: 'provenance-presence-send',
      permission: 'system.broadcast',
      i18nKey: 'chat.decode_skip_system_message',
    });
    expect(authorityBodies).toContainEqual({
      roomGeneration: 0,
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
      roomGeneration: 0,
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
      roomGeneration: 0,
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

  it('durably fences owner-deleted PRO signaling until a newer non-empty authority snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'));
    const state = new FakeDurableObjectState();
    let room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const owner = await joinProMember(room, {
      participantId: 'deleted-owner',
      memberId: 'owner_0123456789abcdef',
      coordinatorEpoch: 1,
      presenceRevision: 1,
      presenceIncarnationId: 'deleted-owner-presence',
      jti: 'deleted-owner-ticket-01',
    });
    const removalId = 'removal_abcdefghijklmnopqrstuv';
    const removedOwnerAuthorityEpoch = 7;
    const fenceRequest = () =>
      new Request('https://signaling.internal/internal/admin/v1/owner-account-deleted', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
        body: JSON.stringify({
          roomCode: '000001',
          roomGeneration: 0,
          removalId,
          removedOwnerAuthorityEpoch,
          fencedCoordinatorEpoch: 1,
        }),
      });

    const fenced = await room.fetch(fenceRequest());
    expect(fenced.status).toBe(200);
    expect(JSON.parse(String(fenced.body))).toEqual({
      ok: true,
      roomCode: '000001',
      roomGeneration: 0,
      status: 'suspended',
      reason: 'owner_account_deleted',
      fenceStatus: 'installed',
      changed: true,
      removalId,
      removedOwnerAuthorityEpoch,
      fencedCoordinatorEpoch: 1,
      effectiveCoordinatorEpoch: 1,
    });
    expect(owner.closeEvents).toEqual([{ code: 1008, reason: 'PRO_OWNER_ACCOUNT_DELETED' }]);
    expect(await state.storage.get('proOwnerAccountDeletionFence')).toEqual({
      v: 2,
      roomCode: '000001',
      roomGeneration: 0,
      removalId,
      removedOwnerAuthorityEpoch,
      fencedCoordinatorEpoch: 1,
      installedAtMs: Date.now(),
    });
    expect(JSON.parse(String((await room.fetch(fenceRequest())).body))).toMatchObject({
      fenceStatus: 'installed',
      changed: false,
      removalId,
      effectiveCoordinatorEpoch: 1,
    });

    room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const pairCount = FakeWebSocketPair.pairs.length;
    const blocked = await room.fetch(
      await proWsRequest({
        participantId: 'future-owner',
        coordinatorEpoch: 2,
        presenceRevision: 2,
        presenceIncarnationId: 'future-owner-presence',
        jti: 'future-owner-ticket-001',
      }),
    );
    expect(blocked.status).toBe(423);
    expect(JSON.parse(String(blocked.body))).toEqual({ error: 'PRO_OWNER_ACCOUNT_DELETED' });
    expect(FakeWebSocketPair.pairs).toHaveLength(pairCount);

    const broadcast = (coordinatorEpoch: number, presenceRevision: number, targets: string[]) =>
      room.fetch(
        new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': '000001',
            'x-mxqr-pro-room-generation': '0',
          },
          body: JSON.stringify({
            roomCode: '000001',
            roomGeneration: 0,
            coordinatorEpoch,
            targets,
            event: { type: 'pro-presence-snapshot', presenceRevision },
          }),
        }),
      );

    expect((await broadcast(1, 2, ['deleted-owner-presence'])).status).toBe(200);
    expect(await state.storage.get('proOwnerAccountDeletionFence')).toBeTruthy();
    expect((await broadcast(2, 3, [])).status).toBe(200);
    expect(await state.storage.get('proOwnerAccountDeletionFence')).toBeTruthy();

    expect((await broadcast(2, 4, ['future-owner-presence'])).status).toBe(200);
    expect(await state.storage.get('proOwnerAccountDeletionFence')).toBeUndefined();
    const admitted = await room.fetch(
      await proWsRequest({
        participantId: 'future-owner',
        coordinatorEpoch: 2,
        presenceRevision: 4,
        presenceIncarnationId: 'future-owner-presence',
        jti: 'future-owner-ticket-001',
      }),
    );
    expect(admitted.status).toBe(101);
  });

  it('treats an exact removal behind newer signaling authority as a stale no-op', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const currentOwner = await joinProMember(room, {
      participantId: 'current-owner',
      memberId: 'owner_0123456789abcdef',
      coordinatorEpoch: 3,
      presenceRevision: 3,
      presenceIncarnationId: 'current-owner-presence',
      jti: 'current-owner-ticket-001',
    });
    const exactRequest = (
      fencedCoordinatorEpoch: number,
      removalId = 'removal_abcdefghijklmnopqrstuv',
      removedOwnerAuthorityEpoch = 7,
    ) =>
      new Request('https://signaling.internal/internal/admin/v1/owner-account-deleted', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
        body: JSON.stringify({
          roomCode: '000001',
          roomGeneration: 0,
          removalId,
          removedOwnerAuthorityEpoch,
          fencedCoordinatorEpoch,
        }),
      });

    const stale = await room.fetch(exactRequest(2));
    expect(stale.status).toBe(200);
    expect(JSON.parse(String(stale.body))).toMatchObject({
      fenceStatus: 'stale',
      changed: false,
      removalId: 'removal_abcdefghijklmnopqrstuv',
      fencedCoordinatorEpoch: 2,
      effectiveCoordinatorEpoch: 3,
    });
    expect(currentOwner.closeEvents).toEqual([]);
    expect(await state.storage.get('proOwnerAccountDeletionFence')).toBeUndefined();

    const installed = await room.fetch(exactRequest(3));
    expect(JSON.parse(String(installed.body))).toMatchObject({
      fenceStatus: 'installed',
      changed: true,
      effectiveCoordinatorEpoch: 3,
    });
    expect(currentOwner.closeEvents).toEqual([{ code: 1008, reason: 'PRO_OWNER_ACCOUNT_DELETED' }]);
    const stored = await state.storage.get('proOwnerAccountDeletionFence');

    const conflict = await room.fetch(exactRequest(3, 'removal_qrstuvwxyzABCDEFGHIJKL', 8));
    expect(conflict.status).toBe(409);
    expect(JSON.parse(String(conflict.body))).toEqual({
      error: 'PRO_OWNER_ACCOUNT_DELETION_FENCE_CONFLICT',
    });
    expect(await state.storage.get('proOwnerAccountDeletionFence')).toEqual(stored);
  });

  it('keeps rollout-era room-only deletion requests fail-closed until a newer epoch', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const owner = await joinProMember(room, {
      participantId: 'legacy-owner',
      memberId: 'owner_0123456789abcdef',
      coordinatorEpoch: 4,
      presenceRevision: 1,
      presenceIncarnationId: 'legacy-owner-presence',
      jti: 'legacy-owner-ticket-001',
    });
    const legacyRequest = new Request(
      'https://signaling.internal/internal/admin/v1/owner-account-deleted',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
        body: JSON.stringify({ roomCode: '000001', roomGeneration: 0 }),
      },
    );

    const fenced = await room.fetch(legacyRequest);
    expect(fenced.status).toBe(200);
    expect(JSON.parse(String(fenced.body))).toEqual({
      ok: true,
      roomCode: '000001',
      roomGeneration: 0,
      status: 'suspended',
      reason: 'owner_account_deleted',
      changed: true,
    });
    expect(owner.closeEvents).toEqual([{ code: 1008, reason: 'PRO_OWNER_ACCOUNT_DELETED' }]);
    expect(await state.storage.get('proOwnerAccountDeletionFence')).toMatchObject({
      v: 1,
      fencedCoordinatorEpoch: 4,
    });

    const broadcast = (coordinatorEpoch: number, presenceRevision: number) =>
      room.fetch(
        new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': '000001',
            'x-mxqr-pro-room-generation': '0',
          },
          body: JSON.stringify({
            roomCode: '000001',
            roomGeneration: 0,
            coordinatorEpoch,
            targets: ['replacement-owner-presence'],
            event: { type: 'pro-presence-snapshot', presenceRevision },
          }),
        }),
      );
    expect((await broadcast(4, 2)).status).toBe(200);
    expect(await state.storage.get('proOwnerAccountDeletionFence')).toBeTruthy();

    const upgraded = await room.fetch(
      new Request('https://signaling.internal/internal/admin/v1/owner-account-deleted', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
        body: JSON.stringify({
          roomCode: '000001',
          roomGeneration: 0,
          removalId: 'removal_abcdefghijklmnopqrstuv',
          removedOwnerAuthorityEpoch: 7,
          fencedCoordinatorEpoch: 4,
        }),
      }),
    );
    expect(JSON.parse(String(upgraded.body))).toMatchObject({
      fenceStatus: 'installed',
      changed: true,
      effectiveCoordinatorEpoch: 4,
    });
    expect(await state.storage.get('proOwnerAccountDeletionFence')).toMatchObject({
      v: 2,
      removalId: 'removal_abcdefghijklmnopqrstuv',
      removedOwnerAuthorityEpoch: 7,
      fencedCoordinatorEpoch: 4,
    });
    expect((await broadcast(5, 3)).status).toBe(200);
    expect(await state.storage.get('proOwnerAccountDeletionFence')).toBeUndefined();
  });

  it('closes existing PRO sockets even when persisting the deletion fence must be retried', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });
    const owner = await joinProMember(room, {
      participantId: 'deleted-owner',
      memberId: 'owner_0123456789abcdef',
      presenceIncarnationId: 'deleted-owner-presence',
      jti: 'deleted-owner-ticket-01',
    });
    const originalPut = state.storage.put.bind(state.storage);
    state.storage.put = vi.fn(async (key: string, value: unknown) => {
      if (key === 'proOwnerAccountDeletionFence') throw new Error('transient storage failure');
      return originalPut(key, value);
    });
    const request = new Request(
      'https://signaling.internal/internal/admin/v1/owner-account-deleted',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
        body: JSON.stringify({
          roomCode: '000001',
          roomGeneration: 0,
          removalId: 'removal_abcdefghijklmnopqrstuv',
          removedOwnerAuthorityEpoch: 7,
          fencedCoordinatorEpoch: 1,
        }),
      },
    );

    await expect(room.fetch(request)).rejects.toThrow('transient storage failure');
    expect(owner.closeEvents).toEqual([{ code: 1008, reason: 'PRO_OWNER_ACCOUNT_DELETED' }]);
  });

  it('bounds and cancels a stalled private signaling JSON body', async () => {
    const timeoutController = new AbortController();
    const timeoutSignal = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => timeoutController.signal);
    const room = new workerModule.MusixquareRoom(new FakeDurableObjectState(), {
      PRO_SIGNALING_SECRET,
    });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"roomCode":"000001"'));
      },
      cancel,
    });
    const pending = room.fetch(
      new Request('https://signaling.internal/internal/admin/v1/decommission', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    timeoutController.abort(new DOMException('private body timeout', 'TimeoutError'));

    const response = await pending;
    timeoutSignal.mockRestore();
    expect(response.status).toBe(400);
    expect(JSON.parse(String(response.body))).toEqual({ error: 'INVALID_REQUEST' });
    expect(cancel).toHaveBeenCalledOnce();
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
          'x-mxqr-pro-room-generation': '0',
        },
        body: JSON.stringify({ roomCode: '000001', requestId }),
      });

    const wrongMethod = await room.fetch(
      new Request('https://signaling.internal/internal/admin/v1/decommission', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
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
      roomGeneration: 0,
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
      roomGeneration: 0,
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
      roomGeneration: 0,
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
      roomGeneration: 0,
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
          'x-mxqr-pro-room-generation': '0',
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
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': '000001',
            'x-mxqr-pro-room-generation': '0',
          },
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
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': '000001',
          'x-mxqr-pro-room-generation': '0',
        },
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
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': '000001',
            'x-mxqr-pro-room-generation': '0',
          },
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
      roomGeneration: 0,
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
        roomGeneration: 0,
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
      roomGeneration: 0,
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

  it('closes an invisible-name PRO attachment during hibernation rehydration', () => {
    const state = new FakeDurableObjectState();
    const hiddenNameMember = new FakeSocket();
    hiddenNameMember.serializeAttachment({
      v: 1,
      roomKind: 'pro',
      role: 'member',
      roomId: '000001',
      roomGeneration: 0,
      peerId: 'hidden-name-member',
      participantId: 'hidden-name-member',
      displayName: '\u3164',
      coordinatorEpoch: 1,
      ticketJti: 'hidden-name-ticket-00001',
      presenceIncarnationId: 'hidden-name-presence-0001',
      ticketSequence: 1,
      auth: 'ok',
    });
    state.sockets.push(hiddenNameMember);

    new workerModule.MusixquareRoom(state, { PRO_SIGNALING_SECRET });

    expect(hiddenNameMember.closeEvents).toEqual([
      { code: 1012, reason: 'PRO_ROOM_PROTOCOL_UPGRADED' },
    ]);
  });

  it('drops stale PRO attachments after hibernation before accepting the current epoch', async () => {
    const state = new FakeDurableObjectState();
    state.storage.data.set('proRoomMeta', {
      v: 2,
      kind: 'pro',
      roomId: '000001',
      roomGeneration: 0,
      coordinatorEpoch: 2,
    });
    const staleCoordinator = new FakeSocket();
    staleCoordinator.serializeAttachment({
      v: 1,
      roomKind: 'pro',
      role: 'member',
      roomId: '000001',
      roomGeneration: 0,
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
      roomGeneration: 0,
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

  it('treats a retired query secret as inert until first-frame host auth arrives', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state);

    await room.fetch(wsRequestWithLegacyHostSecret('123456', 'legacy-host', 'legacy-secret'));
    const host = lastServer();

    expect(host.accepted).toBe(true);
    expect(sent(host)).toEqual([]);
    expect(host.deserializeAttachment()).toMatchObject({
      role: 'host',
      peerId: 'legacy-host',
      auth: 'pending',
    });
    expect(await state.storage.get('roomMeta')).toBeUndefined();

    await room.webSocketMessage(
      host,
      JSON.stringify({ type: 'host-auth', secret: 'first-frame-secret' }),
    );

    expect(sent(host)[0]).toEqual({ type: 'peer-open', peerId: '123456', roomId: '123456' });
    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'first-frame-secret',
      hostPeerId: 'legacy-host',
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
    const host = await authenticateHost(room, 'host-1', 'room-secret-one');
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
        negotiationId: NEGOTIATION_ID,
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
      negotiationId: NEGOTIATION_ID,
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

  it('keeps a newer identity clear authoritative after an older refresh storage write is delayed', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    const host = await authenticateHost(room, 'host-1', 'room-secret-one');
    const guest = await joinGuest(room, 'refresh-then-clear', {
      reconnectSecret: 'u'.repeat(43),
    });
    const assertion = await standardAccountAssertion({
      peerId: 'refresh-then-clear',
      role: 'guest',
    });

    const originalPut = state.storage.put.bind(state.storage);
    let releaseRefreshWrite!: () => void;
    let markRefreshWriteEntered!: () => void;
    const refreshWriteEntered = new Promise<void>((resolve) => {
      markRefreshWriteEntered = resolve;
    });
    const refreshWriteGate = new Promise<void>((resolve) => {
      releaseRefreshWrite = resolve;
    });
    let delayed = false;
    state.storage.put = vi.fn(async (key: string, value: unknown) => {
      const entries = (value as { entries?: unknown[] } | null)?.entries;
      if (key === 'standardRoomAccountMembers' && entries?.length === 1 && !delayed) {
        delayed = true;
        markRefreshWriteEntered();
        await refreshWriteGate;
      }
      await originalPut(key, value);
    });

    const refresh = room.webSocketMessage(
      guest,
      JSON.stringify({ type: 'account-identity-refresh', accountAssertion: assertion }),
    );
    await refreshWriteEntered;
    const clear = room.webSocketMessage(guest, JSON.stringify({ type: 'account-identity-clear' }));

    host.sent.length = 0;
    const ordinarySignal = room.webSocketMessage(
      guest,
      JSON.stringify({
        type: 'signal-offer',
        to: 'host',
        negotiationId: NEGOTIATION_ID,
        sdp: { type: 'offer', sdp: 'ordinary-frame-during-identity-refresh' },
      }),
    );
    const ordinarySignalWasNotBlocked = await Promise.race([
      ordinarySignal.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);

    releaseRefreshWrite();
    await Promise.all([refresh, clear, ordinarySignal]);

    expect(ordinarySignalWasNotBlocked).toBe(true);
    expect(sent(host)).toContainEqual({
      type: 'signal-offer',
      from: 'refresh-then-clear',
      negotiationId: NEGOTIATION_ID,
      sdp: { type: 'offer', sdp: 'ordinary-frame-during-identity-refresh' },
    });
    expect(guest.deserializeAttachment()).not.toHaveProperty('memberId');
    expect(sent(guest).at(-1)).toEqual({
      type: 'account-identity',
      memberIdentity: null,
      clearReason: 'explicit',
    });
  });

  it('keeps a newer valid deletion authoritative after an older refresh write is delayed', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    const host = await authenticateHost(room, 'host-1', 'room-secret-one');
    const guest = await joinGuest(room, 'refresh-then-delete', {
      reconnectSecret: 'v'.repeat(43),
    });
    const [assertion, deletionAssertion] = await Promise.all([
      standardAccountAssertion({ peerId: 'refresh-then-delete', role: 'guest' }),
      standardAccountDeletionAssertion({ peerId: 'refresh-then-delete', role: 'guest' }),
    ]);

    const originalPut = state.storage.put.bind(state.storage);
    let releaseRefreshWrite!: () => void;
    let markRefreshWriteEntered!: () => void;
    const refreshWriteEntered = new Promise<void>((resolve) => {
      markRefreshWriteEntered = resolve;
    });
    const refreshWriteGate = new Promise<void>((resolve) => {
      releaseRefreshWrite = resolve;
    });
    let delayed = false;
    state.storage.put = vi.fn(async (key: string, value: unknown) => {
      const entries = (value as { entries?: unknown[] } | null)?.entries;
      if (key === 'standardRoomAccountMembers' && entries?.length === 1 && !delayed) {
        delayed = true;
        markRefreshWriteEntered();
        await refreshWriteGate;
      }
      await originalPut(key, value);
    });

    const refresh = room.webSocketMessage(
      guest,
      JSON.stringify({ type: 'account-identity-refresh', accountAssertion: assertion }),
    );
    await refreshWriteEntered;
    const deletion = room.webSocketMessage(
      guest,
      JSON.stringify({ type: 'account-identity-delete', deletionAssertion }),
    );

    releaseRefreshWrite();
    await Promise.all([refresh, deletion]);

    expect(guest.deserializeAttachment()).not.toHaveProperty('memberId');
    expect(await state.storage.get('standardRoomAccountMembers')).toEqual({ v: 1, entries: [] });
    expect(sent(guest).at(-1)).toEqual({
      type: 'account-identity',
      memberIdentity: null,
      clearReason: 'deleted',
    });
    expect(sent(host)).toContainEqual(expect.objectContaining({ type: 'account-member-deleted' }));
  });

  it('preserves receive order when a clear maintenance read is slower than a newer refresh', async () => {
    const state = new FakeDurableObjectState();
    const env: Record<string, unknown> = {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    };
    const room = new workerModule.MusixquareRoom(state, env);
    const host = await authenticateHost(room, 'host-1', 'room-secret-one');
    const guest = await joinGuest(room, 'clear-then-refresh', {
      reconnectSecret: 'y'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'clear-then-refresh',
        role: 'guest',
        nickname: 'Before Clear',
      }),
    });
    const refreshed = await standardAccountAssertion({
      peerId: 'clear-then-refresh',
      role: 'guest',
      nickname: 'After Clear',
    });

    const delayedMaintenance = gatedInactiveMaintenanceBinding();
    env.MUSIXQUARE_SERVICE_CONTROL = delayedMaintenance.binding;

    const clear = room.webSocketMessage(guest, JSON.stringify({ type: 'account-identity-clear' }));
    await delayedMaintenance.entered;
    env.MUSIXQUARE_SERVICE_CONTROL = maintenanceBinding(false);
    const refresh = room.webSocketMessage(
      guest,
      JSON.stringify({ type: 'account-identity-refresh', accountAssertion: refreshed }),
    );

    host.sent.length = 0;
    await room.webSocketMessage(
      guest,
      JSON.stringify({
        type: 'signal-offer',
        to: 'host',
        negotiationId: NEGOTIATION_ID,
        sdp: { type: 'offer', sdp: 'not-blocked-by-maintenance-read' },
      }),
    );
    expect(sent(host).at(-1)).toMatchObject({
      type: 'signal-offer',
      sdp: { type: 'offer', sdp: 'not-blocked-by-maintenance-read' },
    });

    delayedMaintenance.release();
    await Promise.all([clear, refresh]);

    expect(guest.deserializeAttachment()).toMatchObject({
      memberNickname: 'After Clear',
    });
    expect(sent(guest).at(-1)).toMatchObject({
      type: 'account-identity',
      memberIdentity: { nickname: 'After Clear' },
    });
  });

  it('serializes a pre-minted admission identity ahead of a newer account deletion', async () => {
    const state = new FakeDurableObjectState();
    const env: Record<string, unknown> = {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    };
    const room = new workerModule.MusixquareRoom(state, env);
    const host = await authenticateHost(room, 'host-1', 'room-secret-one');
    const first = await joinGuest(room, 'delete-before-admission-finishes', {
      reconnectSecret: '1'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'delete-before-admission-finishes',
        role: 'guest',
      }),
    });
    const admissionAssertion = await standardAccountAssertion({
      peerId: 'preminted-admission',
      role: 'guest',
    });
    const deletionAssertion = await standardAccountDeletionAssertion({
      peerId: 'delete-before-admission-finishes',
      role: 'guest',
    });

    await room.fetch(wsRequest('123456', 'guest', 'preminted-admission'));
    const pending = lastServer();
    const delayedMaintenance = gatedInactiveMaintenanceBinding();
    env.MUSIXQUARE_SERVICE_CONTROL = delayedMaintenance.binding;

    const admission = room.webSocketMessage(
      pending,
      JSON.stringify({
        type: 'guest-auth',
        password: '',
        reconnectSecret: '2'.repeat(43),
        accountAssertion: admissionAssertion,
      }),
    );
    await delayedMaintenance.entered;
    env.MUSIXQUARE_SERVICE_CONTROL = maintenanceBinding(false);
    const deletion = room.webSocketMessage(
      first,
      JSON.stringify({ type: 'account-identity-delete', deletionAssertion }),
    );

    delayedMaintenance.release();
    await Promise.all([admission, deletion]);

    expect(first.deserializeAttachment()).not.toHaveProperty('memberId');
    expect(pending.deserializeAttachment()).not.toHaveProperty('memberId');
    expect(await state.storage.get('standardRoomAccountMembers')).toEqual({ v: 1, entries: [] });
    expect(sent(host)).toContainEqual(expect.objectContaining({ type: 'account-member-deleted' }));
  });

  it('clears an expired identity before relaying the next guest frame', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-08-09T00:00:00.000Z').getTime();
    vi.setSystemTime(startedAt);
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    const host = await authenticateHost(room, 'host-1', 'room-secret-one');
    const guest = await joinGuest(room, 'lease-bound-guest', {
      reconnectSecret: 'q'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'lease-bound-guest',
        role: 'guest',
      }),
    });
    expect(guest.deserializeAttachment()).toHaveProperty('identityExpiresAt', startedAt + 60_000);
    expect(state.storage.alarmTime).toBe(startedAt + 60_000);

    host.sent.length = 0;
    vi.setSystemTime(startedAt + 60_000);
    await room.webSocketMessage(
      guest,
      JSON.stringify({
        type: 'signal-offer',
        to: 'host',
        negotiationId: NEGOTIATION_ID,
        sdp: { type: 'offer', sdp: 'expired-identity-offer' },
        metadata: { label: 'data' },
      }),
    );

    expect(guest.deserializeAttachment()).not.toHaveProperty('memberId');
    expect(sent(guest)).toContainEqual({
      type: 'account-identity',
      memberIdentity: null,
      clearReason: 'expired',
    });
    expect(sent(host)).toContainEqual({
      type: 'account-member-updated',
      peerId: 'lease-bound-guest',
      memberIdentity: null,
      clearReason: 'expired',
    });
    expect(sent(host).at(-1)).toEqual({
      type: 'signal-offer',
      from: 'lease-bound-guest',
      negotiationId: NEGOTIATION_ID,
      sdp: { type: 'offer', sdp: 'expired-identity-offer' },
      metadata: { label: 'data' },
    });
  });

  it('re-arms a missing identity alarm on wake and clears an already-expired attachment', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-08-09T00:00:00.000Z').getTime();
    vi.setSystemTime(startedAt);
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    const host = await authenticateHost(room, 'host-1', 'room-secret-one');
    const guest = await joinGuest(room, 'rehydrated-identity-guest', {
      reconnectSecret: 'w'.repeat(43),
      accountAssertion: await standardAccountAssertion({
        peerId: 'rehydrated-identity-guest',
        role: 'guest',
      }),
    });
    const identityExpiresAt = startedAt + 60_000;
    expect(state.storage.alarmTime).toBe(identityExpiresAt);

    state.storage.alarmTime = null;
    vi.setSystemTime(startedAt + 10_000);
    new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    await state.flushWaitUntil();
    expect(state.storage.alarmTime).toBe(identityExpiresAt);

    host.sent.length = 0;
    guest.sent.length = 0;
    state.storage.alarmTime = null;
    vi.setSystemTime(identityExpiresAt);
    new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    await state.flushWaitUntil();

    expect(guest.deserializeAttachment()).not.toHaveProperty('memberId');
    expect(sent(guest)).toContainEqual({
      type: 'account-identity',
      memberIdentity: null,
      clearReason: 'expired',
    });
    expect(sent(host)).toContainEqual({
      type: 'account-member-updated',
      peerId: 'rehydrated-identity-guest',
      memberIdentity: null,
      clearReason: 'expired',
    });
    expect(state.storage.alarmTime).toBeNull();
  });

  it('deletes only the caller-bound account identity and clears every live device for it', async () => {
    const state = new FakeDurableObjectState();
    const room = new workerModule.MusixquareRoom(state, {
      MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ACCOUNT_ASSERTION_SECRET,
    });
    const host = await authenticateHost(room, 'host-1', 'room-secret-one');
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
    const host = await authenticateHost(room, 'host-1', 'room-secret-one');
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
    const host = await authenticateHost(room, 'host-1', 'room-secret-one');
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
    await authenticateHost(room, 'host-1', 'room-secret-one');
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
    const host = await authenticateHost(room, 'host-1', 'room-secret-one');
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
    await authenticateHost(room, 'host-1', 'room-secret-one');
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
    await authenticateHost(room, 'host-1', 'room-secret-one');

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

  it('does not let a later valid guest auth overtake an invalid first frame in maintenance', async () => {
    const state = new FakeDurableObjectState();
    const env: Record<string, unknown> = {};
    const room = new workerModule.MusixquareRoom(state, env);
    await authenticateHost(room, 'host-1', 'secret-a');
    await room.fetch(wsRequest('123456', 'guest', 'invalid-first-maintenance-guest'));
    const guest = lastServer();

    const delayedMaintenance = gatedInactiveMaintenanceBinding();
    env.MUSIXQUARE_SERVICE_CONTROL = delayedMaintenance.binding;

    const invalidFirst = room.webSocketMessage(
      guest,
      JSON.stringify({ type: 'signal-offer', to: 'host' }),
    );
    await delayedMaintenance.entered;
    env.MUSIXQUARE_SERVICE_CONTROL = maintenanceBinding(false);
    await room.webSocketMessage(
      guest,
      JSON.stringify({
        type: 'guest-auth',
        password: '',
        reconnectSecret: '3'.repeat(43),
      }),
    );

    expect(sent(guest)).not.toContainEqual(expect.objectContaining({ type: 'peer-open' }));
    delayedMaintenance.release();
    await invalidFirst;

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

    const host = await authenticateHost(room, 'host-1', 'secret-a');
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

    await authenticateHost(room, 'host-1', 'secret-a');
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

    const host = await authenticateHost(room, 'host-1', 'secret-a');
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
        negotiationId: NEGOTIATION_ID,
        sdp: { type: 'offer', sdp: 'offer-sdp' },
        metadata: { label: 'data' },
      }),
    );
    await room.webSocketMessage(
      host,
      JSON.stringify({
        type: 'signal-answer',
        to: 'guest-1',
        negotiationId: NEGOTIATION_ID,
        sdp: { type: 'answer', sdp: 'answer-sdp' },
      }),
    );
    await room.webSocketMessage(
      host,
      JSON.stringify({
        type: 'media-offer',
        to: 'guest-1',
        negotiationId: NEGOTIATION_ID,
        callId: 'call-1',
        sdp: { type: 'offer', sdp: 'media-sdp' },
      }),
    );

    expect(sent(host).at(-1)).toEqual({
      type: 'signal-offer',
      from: 'guest-1',
      negotiationId: NEGOTIATION_ID,
      sdp: { type: 'offer', sdp: 'offer-sdp' },
      metadata: { label: 'data' },
    });
    expect(sent(guest).slice(-2)).toEqual([
      {
        type: 'signal-answer',
        from: 'host-1',
        negotiationId: NEGOTIATION_ID,
        sdp: { type: 'answer', sdp: 'answer-sdp' },
      },
      {
        type: 'media-offer',
        from: 'host-1',
        negotiationId: NEGOTIATION_ID,
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
        negotiationId: NEGOTIATION_ID,
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
        negotiationId: NEGOTIATION_ID,
        sdp: { type: 'offer', sdp: 'offer-sdp', futureSdpField: true },
        metadata: { label: 'data' },
        futureMessageField: 'preserved',
      }),
    );

    expect(guest.closed).toBe(false);
    expect(sent(host).at(-1)).toEqual({
      type: 'signal-offer',
      from: 'guest-1',
      negotiationId: NEGOTIATION_ID,
      sdp: { type: 'offer', sdp: 'offer-sdp', futureSdpField: true },
      metadata: { label: 'data' },
      futureMessageField: 'preserved',
    });

    await room.webSocketMessage(
      host,
      JSON.stringify({
        type: 'signal-answer',
        to: 'guest-1',
        negotiationId: NEGOTIATION_ID,
        sdp: { type: 'answer', sdp: 'answer-sdp', futureSdpField: true },
        futureMessageField: 'preserved',
      }),
    );
    expect(sent(guest).at(-1)).toEqual({
      type: 'signal-answer',
      from: 'host-1',
      negotiationId: NEGOTIATION_ID,
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
        negotiationId: NEGOTIATION_ID,
        sdp: { type: 'offer', sdp: 's'.repeat(48 * 1024 + 1) },
      },
    },
    {
      label: 'ICE candidate',
      message: {
        type: 'signal-candidate',
        to: 'host',
        negotiationId: NEGOTIATION_ID,
        candidate: { candidate: 'c'.repeat(4 * 1024 + 1) },
      },
    },
    {
      label: 'ICE candidate metadata',
      message: {
        type: 'signal-candidate',
        to: 'host',
        negotiationId: NEGOTIATION_ID,
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
          negotiationId: NEGOTIATION_ID,
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
        negotiationId: NEGOTIATION_ID,
        candidate: { candidate: 'candidate-after-refill' },
      }),
    );
    expect(noisy.closed).toBe(false);

    await room.webSocketMessage(
      noisy,
      JSON.stringify({
        type: 'signal-candidate',
        to: 'host',
        negotiationId: NEGOTIATION_ID,
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
        negotiationId: NEGOTIATION_ID,
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

  it('rejects a guest auth frame without its reconnect secret', async () => {
    const { room, host } = await createHostRoom();
    const original = await joinGuest(room, 'guest-1');
    const attacker = await joinGuest(room, 'guest-1', { reconnectSecret: null });

    expect(original.closed).toBe(false);
    expect(sent(attacker).at(-1)).toEqual({
      type: 'error',
      errorType: 'invalid-id',
      message: 'GUEST_AUTH_FIRST_FRAME_INVALID',
    });
    expect(attacker.closeEvents.at(-1)).toEqual({
      code: 1008,
      reason: 'GUEST_AUTH_FIRST_FRAME_INVALID',
    });

    await room.webSocketMessage(
      original,
      JSON.stringify({
        type: 'signal-candidate',
        to: 'host',
        negotiationId: NEGOTIATION_ID,
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
    expect(legacyDowngrade.closeEvents.at(-1)?.reason).toBe('GUEST_AUTH_FIRST_FRAME_INVALID');

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

    const rejectedHost = await authenticateHost(room, 'host-2', 'secret-b');
    expect(rejectedHost.closeEvents.at(-1)?.reason).toBe('ROOM_ALREADY_ACTIVE');

    const restoredHost = await authenticateHost(room, 'host-1', 'secret-a');
    expect(sent(restoredHost).at(-1)).toMatchObject({ type: 'peer-open', roomId: '123456' });

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

    await room.fetch(wsRequest('123456', 'host', 'host-1'));
    const reconnectedHost = lastServer();
    const reconnect = room.webSocketMessage(
      reconnectedHost,
      JSON.stringify({ type: 'host-auth', secret: 'secret-a' }),
    );

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

  it('alarms an idle disconnected guest binding out of durable storage after five minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T00:00:00.000Z'));
    const { room, state } = await createHostRoom();
    const guest = await joinGuest(room, 'idle-binding-guest');
    const disconnectedAt = Date.now();

    guest.close();
    await room.webSocketClose(guest);

    expect(state.storage.alarmTime).toBe(disconnectedAt + 5 * 60_000 + 1);
    expect(await state.storage.get('guestReconnectBindings')).toMatchObject({
      entries: [{ peerId: 'idle-binding-guest', updatedAt: disconnectedAt }],
    });

    vi.advanceTimersByTime(5 * 60_000 + 1);
    await room.alarm();

    expect(await state.storage.get('guestReconnectBindings')).toEqual({ v: 1, entries: [] });
    expect(state.storage.alarmTime).toBeNull();
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
    await room.webSocketMessage(
      missing,
      JSON.stringify({
        type: 'guest-auth',
        password: '',
        reconnectSecret: DEFAULT_RECONNECT_SECRET,
      }),
    );

    await room.fetch(wsRequest('123456', 'guest', 'invalid'));
    const invalid = lastServer();
    await room.webSocketMessage(
      invalid,
      JSON.stringify({
        type: 'guest-auth',
        password: 'bad',
        reconnectSecret: DEFAULT_RECONNECT_SECRET,
      }),
    );

    await room.fetch(wsRequest('123456', 'guest', 'expired'));
    const expired = lastServer();
    expired.serializeAttachment({
      ...(expired.deserializeAttachment() as Record<string, unknown>),
      authDeadline: Date.now() - 1,
    });
    await room.webSocketMessage(
      expired,
      JSON.stringify({
        type: 'guest-auth',
        password: '12345678',
        reconnectSecret: DEFAULT_RECONNECT_SECRET,
      }),
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
      JSON.stringify({
        type: 'signal-offer',
        to: 'host',
        negotiationId: NEGOTIATION_ID,
        sdp: { type: 'offer', sdp: 'x' },
      }),
    );

    expect(sent(host).at(-1)).toEqual({
      type: 'signal-offer',
      from: 'guest-1',
      negotiationId: NEGOTIATION_ID,
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

    const rejected = await authenticateHost(room, 'host-2', 'secret-b');
    expect(sent(rejected).at(-1)).toEqual({
      type: 'error',
      errorType: 'id-taken',
      message: 'ROOM_ALREADY_ACTIVE',
    });

    vi.setSystemTime(new Date('2026-05-16T00:01:01.000Z'));
    const reclaimed = await authenticateHost(room, 'host-3', 'secret-b');
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

    await authenticateHost(room, 'host-2', 'secret-b');
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
    const source = await readFile(resolve(process.cwd(), 'cloudflare/signaling-worker.ts'), 'utf8');

    expect(source).not.toContain('server.accept(');
    expect(source).not.toContain('addEventListener(');
    expect(source).not.toContain('setTimeout(');
    expect(source).toContain('acceptWebSocket(');
  });
});
