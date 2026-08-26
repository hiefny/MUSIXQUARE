import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type WorkerModule = {
  MusixquareRoom: new (
    state: FakeDurableObjectState,
    env?: Record<string, unknown>,
  ) => {
    fetch(request: Request): Promise<Response>;
    alarm(): Promise<void>;
  };
  default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
};

const BRIDGE_PREFIX = 'mxqr-standard-http-bridge-v1:';
const BRIDGE_INTERNAL_PREFIX = '/internal/standard-http-bridge/v1';
const BRIDGE_HEADER = 'X-MXQR-Standard-HTTP-Bridge';
const SESSION_ID = 'S'.repeat(32);
const GENERATION = 'G'.repeat(22);
const ROOM_ID = '123456';
const PEER_ID = 'bridge-peer-1';
const META_KEY = 'standard-http-bridge-meta-v1';
const originalResponse = globalThis.Response;
let workerModule: WorkerModule;

class FakeResponse {
  readonly body: unknown;
  readonly status: number;
  readonly headers: Headers;
  readonly webSocket?: FakeOutboundSocket;

  constructor(
    body: unknown,
    init: { status?: number; headers?: HeadersInit; webSocket?: FakeOutboundSocket } = {},
  ) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
    this.webSocket = init.webSocket;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }
}

type SocketListener = (event: unknown) => void;

class FakeOutboundSocket {
  accepted = false;
  closed = false;
  readyState = 1;
  readonly sent: string[] = [];
  readonly closeEvents: { code?: number; reason?: string }[] = [];
  private readonly listeners = new Map<string, SocketListener[]>();

  accept(): void {
    this.accepted = true;
  }

  send(message: string): void {
    if (this.closed) throw new Error('SOCKET_CLOSED');
    this.sent.push(message);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.readyState = 3;
    this.closeEvents.push({ code, reason });
  }

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emitMessage(data: unknown): void {
    this.emit('message', { data });
  }

  emitClose(code = 1000, reason = ''): void {
    this.closed = true;
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  emitError(): void {
    this.emit('error', {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeStorage {
  readonly data = new Map<string, unknown>();
  alarmTime: number | null = null;
  deleteBarrier: Promise<void> | null = null;
  deleteError: Error | null = null;

  async get(key: string): Promise<unknown> {
    return structuredClone(this.data.get(key));
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    if (this.deleteBarrier) await this.deleteBarrier;
    if (this.deleteError) throw this.deleteError;
    return this.data.delete(key);
  }

  async list(): Promise<Map<string, unknown>> {
    return new Map([...this.data].map(([key, value]) => [key, structuredClone(value)]));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmTime;
  }

  async setAlarm(value: number): Promise<void> {
    this.alarmTime = value;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmTime = null;
  }
}

class FakeDurableObjectState {
  readonly id: { readonly name: string };
  readonly storage = new FakeStorage();
  private readonly waitUntilTasks: Promise<unknown>[] = [];

  constructor(name = `${BRIDGE_PREFIX}${SESSION_ID}`) {
    this.id = { name };
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  acceptWebSocket(): void {
    throw new Error('BRIDGE_MUST_NOT_ACCEPT_INBOUND_WEBSOCKETS');
  }

  getWebSockets(): [] {
    return [];
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

class FakeRoomNamespace {
  readonly sockets: FakeOutboundSocket[] = [];
  readonly requests: Request[] = [];
  readonly names: string[] = [];
  responseStatus = 101;

  idFromName(name: string): string {
    this.names.push(name);
    return name;
  }

  get(): { fetch: (request: Request) => Promise<Response> } {
    return {
      fetch: async (request: Request): Promise<Response> => {
        this.requests.push(request);
        const socket = new FakeOutboundSocket();
        this.sockets.push(socket);
        return new FakeResponse(null, {
          status: this.responseStatus,
          ...(this.responseStatus === 101 ? { webSocket: socket } : {}),
        }) as unknown as Response;
      },
    };
  }
}

const envelope = (request?: unknown, overrides: Record<string, unknown> = {}) => ({
  v: 1,
  sessionId: SESSION_ID,
  generation: GENERATION,
  roomId: ROOM_ID,
  role: 'host',
  peerId: PEER_ID,
  ...(request === undefined ? {} : { request }),
  ...overrides,
});

function bridgeRequest(
  operation: 'open' | 'send' | 'poll' | 'close',
  body: unknown,
  marker = true,
): Request {
  return new Request(`https://signaling.internal${BRIDGE_INTERNAL_PREFIX}/${operation}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(marker ? { [BRIDGE_HEADER]: 'v1' } : {}),
    },
    body: JSON.stringify(body),
  });
}

function responseJson(response: Response): Record<string, unknown> {
  const body = (response as unknown as FakeResponse).body;
  return JSON.parse(String(body)) as Record<string, unknown>;
}

function createBridge() {
  const state = new FakeDurableObjectState();
  const namespace = new FakeRoomNamespace();
  const room = new workerModule.MusixquareRoom(state, { MUSIXQUARE_ROOMS: namespace });
  return { state, namespace, room };
}

async function openBridge(room: InstanceType<WorkerModule['MusixquareRoom']>): Promise<Response> {
  return room.fetch(bridgeRequest('open', envelope()));
}

beforeAll(async () => {
  Object.defineProperty(globalThis, 'Response', {
    configurable: true,
    value: FakeResponse,
  });
  workerModule =
    (await import('../../../cloudflare/signaling-worker.ts')) as unknown as WorkerModule;
});

afterAll(() => {
  Object.defineProperty(globalThis, 'Response', {
    configurable: true,
    value: originalResponse,
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Cloudflare Standard HTTP signaling bridge', () => {
  it('keeps bridge mode, internal marker, Standard namespace, and public boundaries exact', async () => {
    const { namespace, room } = createBridge();
    const missingMarker = await room.fetch(bridgeRequest('open', envelope(), false));
    expect(missingMarker.status).toBe(404);

    const reservedPro = await room.fetch(
      bridgeRequest('open', envelope(undefined, { roomId: '012345' })),
    );
    expect(reservedPro.status).toBe(400);
    expect(namespace.requests).toHaveLength(0);

    const normalPath = await room.fetch(
      new Request(`https://signaling.internal/api/rooms/${ROOM_ID}/ws`, {
        headers: { Upgrade: 'websocket' },
      }),
    );
    expect(normalPath.status).toBe(404);

    const malformedBridge = new workerModule.MusixquareRoom(
      new FakeDurableObjectState(`${BRIDGE_PREFIX}malformed`),
      { MUSIXQUARE_ROOMS: namespace },
    );
    const malformedNormalPath = await malformedBridge.fetch(
      new Request(`https://signaling.internal/api/rooms/${ROOM_ID}/ws`, {
        headers: { Upgrade: 'websocket' },
      }),
    );
    expect(malformedNormalPath.status).toBe(404);

    const ordinaryState = new FakeDurableObjectState(ROOM_ID);
    const ordinaryRoom = new workerModule.MusixquareRoom(ordinaryState, {
      MUSIXQUARE_ROOMS: namespace,
    });
    const bridgePathOnRoom = await ordinaryRoom.fetch(bridgeRequest('open', envelope()));
    expect(bridgePathOnRoom.status).toBe(404);

    const publicInternal = await workerModule.default.fetch(bridgeRequest('open', envelope()), {
      MUSIXQUARE_ROOMS: namespace,
    });
    expect(publicInternal.status).toBe(404);
  });

  it('accepts the inner socket before open succeeds and never persists the auth frame', async () => {
    const { state, namespace, room } = createBridge();
    const opened = await openBridge(room);
    expect(opened.status).toBe(200);
    expect(responseJson(opened)).toEqual({ ok: true });
    expect(namespace.names).toEqual([ROOM_ID]);
    expect(namespace.requests[0] && new URL(namespace.requests[0].url).pathname).toBe(
      `/api/rooms/${ROOM_ID}/ws`,
    );
    expect(namespace.requests[0]?.headers.get('Upgrade')).toBe('websocket');
    expect(namespace.sockets[0]?.accepted).toBe(true);

    const authFrame = JSON.stringify({ type: 'host-auth', secret: 'never-persist-this-secret' });
    const sent = await room.fetch(
      bridgeRequest('send', envelope({ v: 1, cseq: 1, frame: authFrame })),
    );
    expect(sent.status).toBe(200);
    expect(responseJson(sent)).toEqual({ v: 1, ack: 1 });
    expect(namespace.sockets[0]?.sent).toEqual([authFrame]);
    const sensitiveDownlink = JSON.stringify({
      type: 'offer',
      sdp: 'candidate:192.0.2.10 relay-secret',
    });
    namespace.sockets[0]?.emitMessage(sensitiveDownlink);
    await state.flushWaitUntil();
    const persisted = JSON.stringify(state.storage.data.get(META_KEY));
    expect(persisted).not.toContain('never-persist-this-secret');
    expect(persisted).not.toContain('host-auth');
    expect(persisted).not.toContain('192.0.2.10');
    expect(persisted).not.toContain('relay-secret');
    expect(Object.keys(state.storage.data.get(META_KEY) as object).sort()).toEqual(
      [
        'generation',
        'lastClientSeq',
        'lastServerAck',
        'lastServerSeq',
        'leaseExpiresAt',
        'peerId',
        'requestEpoch',
        'role',
        'roomId',
        'sessionId',
        'v',
      ].sort(),
    );
  });

  it('makes send sequence replay idempotent and rejects mismatch or gaps', async () => {
    const { namespace, room } = createBridge();
    await openBridge(room);
    const socket = namespace.sockets[0];
    expect(socket).toBeDefined();

    const first = envelope({ v: 1, cseq: 1, frame: '{"type":"host-auth"}' });
    expect((await room.fetch(bridgeRequest('send', first))).status).toBe(200);
    expect((await room.fetch(bridgeRequest('send', first))).status).toBe(200);
    expect(socket?.sent).toEqual(['{"type":"host-auth"}']);

    const mismatch = await room.fetch(
      bridgeRequest('send', envelope({ v: 1, cseq: 1, frame: '{"type":"other"}' })),
    );
    expect(mismatch.status).toBe(409);
    expect(responseJson(mismatch).error).toBe('STANDARD_HTTP_BRIDGE_SEQUENCE_REPLAY_MISMATCH');

    const gap = await room.fetch(
      bridgeRequest('send', envelope({ v: 1, cseq: 3, frame: '{"type":"offer"}' })),
    );
    expect(gap.status).toBe(409);
    expect(responseJson(gap).error).toBe('STANDARD_HTTP_BRIDGE_SEQUENCE_GAP');

    const second = await room.fetch(
      bridgeRequest('send', envelope({ v: 1, cseq: 2, frame: '{"type":"offer"}' })),
    );
    expect(second.status).toBe(200);
    expect(socket?.sent).toHaveLength(2);
  });

  it('orders server events with sseq and releases only explicitly acknowledged frames', async () => {
    const { state, namespace, room } = createBridge();
    await openBridge(room);
    namespace.sockets[0]?.emitMessage('{"type":"one"}');
    namespace.sockets[0]?.emitMessage('{"type":"two"}');
    await state.flushWaitUntil();

    const firstPoll = await room.fetch(
      bridgeRequest('poll', envelope({ v: 1, requestEpoch: 1, ack: 0, waitMs: 0 })),
    );
    expect(responseJson(firstPoll)).toEqual({
      v: 1,
      events: [
        { sseq: 1, data: '{"type":"one"}' },
        { sseq: 2, data: '{"type":"two"}' },
      ],
    });

    const acknowledgeOne = await room.fetch(
      bridgeRequest('poll', envelope({ v: 1, requestEpoch: 2, ack: 1, waitMs: 0 })),
    );
    expect(responseJson(acknowledgeOne)).toEqual({
      v: 1,
      events: [{ sseq: 2, data: '{"type":"two"}' }],
    });
    const acknowledgeAll = await room.fetch(
      bridgeRequest('poll', envelope({ v: 1, requestEpoch: 3, ack: 2, waitMs: 0 })),
    );
    expect(responseJson(acknowledgeAll)).toEqual({ v: 1, events: [] });
    const ahead = await room.fetch(
      bridgeRequest('poll', envelope({ v: 1, requestEpoch: 4, ack: 3, waitMs: 0 })),
    );
    expect(ahead.status).toBe(409);
  });

  it('lets a newer request epoch supersede the one active long poll', async () => {
    const { state, room } = createBridge();
    await openBridge(room);
    const oldPoll = room.fetch(
      bridgeRequest('poll', envelope({ v: 1, requestEpoch: 1, ack: 0, waitMs: 15_000 })),
    );
    await vi.waitFor(() => {
      expect(
        (state.storage.data.get(META_KEY) as { requestEpoch?: number } | undefined)?.requestEpoch,
      ).toBe(1);
    });
    const newPoll = await room.fetch(
      bridgeRequest('poll', envelope({ v: 1, requestEpoch: 2, ack: 0, waitMs: 0 })),
    );
    expect(newPoll.status).toBe(200);
    const superseded = await oldPoll;
    expect(superseded.status).toBe(409);
    expect(responseJson(superseded).error).toBe('STANDARD_HTTP_BRIDGE_POLL_SUPERSEDED');
  });

  it('fences events from an old outbound socket after close and re-open', async () => {
    const { state, namespace, room } = createBridge();
    await openBridge(room);
    const oldSocket = namespace.sockets[0];
    await room.fetch(bridgeRequest('close', envelope()));
    await openBridge(room);
    expect(namespace.sockets).toHaveLength(2);

    oldSocket?.emitMessage('{"type":"late-old-socket"}');
    oldSocket?.emitClose(1000, 'late');
    await state.flushWaitUntil();
    const poll = await room.fetch(
      bridgeRequest('poll', envelope({ v: 1, requestEpoch: 1, ack: 0, waitMs: 0 })),
    );
    expect(responseJson(poll)).toEqual({ v: 1, events: [] });
  });

  it('closes the exact socket when the bounded in-memory queue overflows', async () => {
    const { state, namespace, room } = createBridge();
    await openBridge(room);
    const socket = namespace.sockets[0];
    for (let index = 0; index < 257; index += 1) {
      socket?.emitMessage(JSON.stringify({ type: 'candidate', index }));
    }
    await state.flushWaitUntil();
    expect(socket?.closed).toBe(true);
    expect(socket?.closeEvents.at(-1)?.code).toBe(1013);

    const firstPoll = await room.fetch(
      bridgeRequest('poll', envelope({ v: 1, requestEpoch: 1, ack: 0, waitMs: 0 })),
    );
    const firstPayload = responseJson(firstPoll);
    expect(firstPayload.events).toHaveLength(128);
    expect(firstPayload.terminal).toBeUndefined();
    const secondPoll = await room.fetch(
      bridgeRequest('poll', envelope({ v: 1, requestEpoch: 2, ack: 128, waitMs: 0 })),
    );
    expect(responseJson(secondPoll).terminal).toEqual({
      code: 1013,
      reason: 'HTTP bridge receive queue overflow',
    });
  });

  it('expires the 45 second lease and closes only its live outbound socket', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { state, namespace, room } = createBridge();
    await openBridge(room);
    expect(state.storage.alarmTime).toBe(now + 45_000);
    vi.mocked(Date.now).mockReturnValue(now + 45_001);
    await room.alarm();
    expect(namespace.sockets[0]?.closeEvents.at(-1)).toEqual({
      code: 1001,
      reason: 'HTTP bridge lease expired',
    });
    expect(state.storage.data.has(META_KEY)).toBe(false);
    expect(state.storage.alarmTime).toBeNull();
  });

  it('revokes and closes the exact socket before delayed or failed storage cleanup', async () => {
    const { state, namespace, room } = createBridge();
    await openBridge(room);
    let releaseDelete: () => void = () => {};
    state.storage.deleteBarrier = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const delayedClose = room.fetch(bridgeRequest('close', envelope()));
    await vi.waitFor(() => expect(namespace.sockets[0]?.closed).toBe(true));
    expect(state.storage.data.has(META_KEY)).toBe(true);
    releaseDelete();
    expect((await delayedClose).status).toBe(200);

    await openBridge(room);
    const secondSocket = namespace.sockets[1];
    state.storage.deleteBarrier = null;
    state.storage.deleteError = new Error('simulated storage deletion failure');
    await expect(room.fetch(bridgeRequest('close', envelope()))).rejects.toThrow(
      'simulated storage deletion failure',
    );
    expect(secondSocket?.closed).toBe(true);
  });

  it('fails closed with REAUTH_REQUIRED after an isolate restart and clears cursor state', async () => {
    const { state, namespace, room } = createBridge();
    await openBridge(room);
    const secretFrame = JSON.stringify({ type: 'host-auth', secret: 'restart-secret' });
    await room.fetch(bridgeRequest('send', envelope({ v: 1, cseq: 1, frame: secretFrame })));
    expect(JSON.stringify(state.storage.data)).not.toContain('restart-secret');

    const restarted = new workerModule.MusixquareRoom(state, { MUSIXQUARE_ROOMS: namespace });
    const response = await restarted.fetch(
      bridgeRequest('send', envelope({ v: 1, cseq: 1, frame: secretFrame })),
    );
    expect(response.status).toBe(409);
    expect(responseJson(response).error).toBe('STANDARD_HTTP_BRIDGE_REAUTH_REQUIRED');
    expect(state.storage.data.has(META_KEY)).toBe(false);
    expect(namespace.sockets).toHaveLength(1);
  });
});
