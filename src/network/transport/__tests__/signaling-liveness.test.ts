/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { CloudflareSignalingPeer } from '../cloudflare-signaling.ts';
const SIGNALING_LIVENESS_INTERVAL_MS = 10_000;
const SIGNALING_LIVENESS_TIMEOUT_MS = 8_000;
const SIGNALING_LIVENESS_PING = '{"type":"signaling-liveness-ping","version":1}';
const SIGNALING_LIVENESS_PONG = '{"type":"signaling-liveness-pong","version":1}';

const originalWebSocket = globalThis.WebSocket;

type FakeSocketListener = (event: { data?: unknown; reason?: string }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  closeCount = 0;
  sent: string[] = [];
  private readonly listeners = new Map<string, Set<FakeSocketListener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: FakeSocketListener): void {
    const listeners = this.listeners.get(event) ?? new Set<FakeSocketListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('SOCKET_NOT_OPEN');
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closeCount += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close');
  }

  dispatch(event: string, data?: unknown, reason?: string): void {
    if (event === 'open') this.readyState = FakeWebSocket.OPEN;
    if (event === 'close') this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get(event) ?? []) listener({ data, reason });
  }
}

function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: FakeWebSocket as unknown as typeof WebSocket,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function admittedHost(advertiseLiveness = true): Promise<{
  peer: CloudflareSignalingPeer;
  socket: FakeWebSocket;
}> {
  installFakeWebSocket();
  const peer = new CloudflareSignalingPeer('123456', {
    provider: 'cloudflare',
    signalingUrl: 'wss://signal.example.test/api/rooms',
    config: { iceServers: [] },
  });
  await flushMicrotasks();
  const socket = FakeWebSocket.instances[0]!;
  socket.dispatch('open');
  socket.dispatch(
    'message',
    JSON.stringify({
      type: 'peer-open',
      peerId: '123456',
      roomId: '123456',
      ...(advertiseLiveness ? { signalingLivenessVersion: 1 } : {}),
    }),
  );
  await flushMicrotasks();
  return { peer, socket };
}

class WorkerSocket {
  readyState = 1;
  sent: string[] = [];
  private attachment: unknown = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

class WorkerState {
  readonly storage = {
    get: async (): Promise<undefined> => undefined,
    put: async (): Promise<void> => {},
    delete: async (): Promise<boolean> => false,
    list: async (): Promise<Map<string, unknown>> => new Map(),
    getAlarm: async (): Promise<null> => null,
    setAlarm: async (): Promise<void> => {},
    deleteAlarm: async (): Promise<void> => {},
  };

  acceptWebSocket(): void {}

  getWebSockets(): WorkerSocket[] {
    return [];
  }
}

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: originalWebSocket,
  });
});

describe('signaling WebSocket liveness', () => {
  it('retires a half-open host socket when the Worker stops answering', async () => {
    vi.useFakeTimers();
    const { peer, socket } = await admittedHost();
    const disconnected = vi.fn();
    peer.on('disconnected', disconnected);

    await vi.advanceTimersByTimeAsync(SIGNALING_LIVENESS_INTERVAL_MS);
    expect(socket.sent).toContain(SIGNALING_LIVENESS_PING);

    await vi.advanceTimersByTimeAsync(SIGNALING_LIVENESS_TIMEOUT_MS);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(peer.disconnected).toBe(true);
    expect(socket.closeCount).toBe(1);
    peer.destroy();
  });

  it('accepts pong activity and keeps the exact socket healthy', async () => {
    vi.useFakeTimers();
    const { peer, socket } = await admittedHost();
    const disconnected = vi.fn();
    peer.on('disconnected', disconnected);

    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(SIGNALING_LIVENESS_INTERVAL_MS);
      socket.dispatch('message', SIGNALING_LIVENESS_PONG);
      await flushMicrotasks();
    }

    expect(disconnected).not.toHaveBeenCalled();
    expect(peer.disconnected).toBe(false);
    peer.destroy();
  });

  it('does not probe a legacy Worker that did not advertise the capability', async () => {
    vi.useFakeTimers();
    const { peer, socket } = await admittedHost(false);
    const disconnected = vi.fn();
    peer.on('disconnected', disconnected);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.sent).not.toContain(SIGNALING_LIVENESS_PING);
    expect(disconnected).not.toHaveBeenCalled();
    peer.destroy();
  });

  it('retires the current socket immediately on an operating-system offline hint', async () => {
    vi.useFakeTimers();
    const { peer, socket } = await admittedHost();
    const disconnected = vi.fn();
    peer.on('disconnected', disconnected);

    expect(peer.markSignalingUnavailable()).toBe(true);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(peer.disconnected).toBe(true);
    expect(socket.closeCount).toBe(1);
    expect(peer.markSignalingUnavailable()).toBe(false);
    peer.destroy();
  });

  it('ignores a late close and pong from a superseded socket generation', async () => {
    vi.useFakeTimers();
    const { peer, socket: oldSocket } = await admittedHost();
    const disconnected = vi.fn();
    peer.on('disconnected', disconnected);

    peer.markSignalingUnavailable();
    peer.reconnect();
    const replacement = FakeWebSocket.instances.at(-1)!;
    expect(replacement).not.toBe(oldSocket);
    replacement.dispatch('open');
    replacement.dispatch(
      'message',
      JSON.stringify({
        type: 'peer-open',
        peerId: '123456',
        roomId: '123456',
        signalingLivenessVersion: 1,
      }),
    );
    await flushMicrotasks();

    oldSocket.dispatch('message', SIGNALING_LIVENESS_PONG);
    oldSocket.dispatch('close');
    await flushMicrotasks();

    expect(peer.disconnected).toBe(false);
    expect(disconnected).toHaveBeenCalledTimes(1);
    peer.destroy();
  });

  it('mirrors the exact DO-wide transport echo in the Worker fallback path', async () => {
    const workerModulePath = '../../../../cloudflare/signaling-worker.ts';
    const workerModule = (await import(workerModulePath)) as unknown as {
      MusixquareRoom: new (state: WorkerState) => {
        webSocketMessage(socket: WorkerSocket, raw: unknown): Promise<void>;
      };
    };
    const room = new workerModule.MusixquareRoom(new WorkerState());
    const socket = new WorkerSocket();

    await room.webSocketMessage(socket, SIGNALING_LIVENESS_PING);
    expect(socket.sent).toEqual([SIGNALING_LIVENESS_PONG]);
  });
});
