import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function read(path) {
  return readFileSync(path, 'utf8');
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function replaceOnce(path, before, after) {
  const source = read(path);
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${path}: expected exactly one patch anchor, found ${count}: ${before.slice(0, 120)}`);
  }
  write(path, source.replace(before, after));
}

function assertMissing(path) {
  try {
    readFileSync(path, 'utf8');
    throw new Error(`${path}: already exists`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const livenessModulePath = 'src/network/transport/signaling-liveness.ts';
assertMissing(livenessModulePath);
write(
  livenessModulePath,
  `import { clearManagedTimer, setManagedTimer } from '../../core/timers.ts';

export const SIGNALING_LIVENESS_VERSION = 1 as const;
export const SIGNALING_LIVENESS_PING =
  '{"type":"signaling-liveness-ping","version":1}';
export const SIGNALING_LIVENESS_PONG =
  '{"type":"signaling-liveness-pong","version":1}';
export const SIGNALING_LIVENESS_INTERVAL_MS = 5_000;
export const SIGNALING_LIVENESS_TIMEOUT_MS = 10_000;
const SIGNALING_LIVENESS_SUSPENSION_GAP_MS = 20_000;

interface SignalingProbe {
  readonly timerKey: string;
  awaitingSince: number | null;
  lastTickAt: number;
}

let nextMonitorId = 0;

/**
 * Application-level liveness for the exact signaling WebSocket.
 *
 * Browsers can leave a dead TCP/WebSocket path in OPEN for a long time,
 * especially after a Windows network-interface transition. The monitor starts
 * only after the signaling Worker advertises protocol version 1, so rolling
 * deployments remain compatible in either order.
 */
export class SignalingSocketLivenessMonitor {
  private readonly monitorId = ++nextMonitorId;
  private nextSocketId = 0;
  private readonly probes = new Map<WebSocket, SignalingProbe>();

  constructor(private readonly onUnresponsive: (socket: WebSocket) => void) {}

  start(socket: WebSocket): void {
    this.stop(socket);
    const probe: SignalingProbe = {
      timerKey: `signaling-liveness-${this.monitorId}-${++this.nextSocketId}`,
      awaitingSince: null,
      lastTickAt: Date.now(),
    };
    this.probes.set(socket, probe);
    setManagedTimer(
      probe.timerKey,
      () => this.tick(socket, probe),
      SIGNALING_LIVENESS_INTERVAL_MS,
      { interval: true },
    );
  }

  /** Returns true when the frame is the transport-owned pong and is consumed. */
  noteMessage(socket: WebSocket, raw: unknown): boolean {
    const isPong = raw === SIGNALING_LIVENESS_PONG;
    const probe = this.probes.get(socket);
    if (probe) {
      probe.awaitingSince = null;
      probe.lastTickAt = Date.now();
    }
    return isPong;
  }

  stop(socket: WebSocket): void {
    const probe = this.probes.get(socket);
    if (!probe) return;
    clearManagedTimer(probe.timerKey);
    this.probes.delete(socket);
  }

  stopAll(): void {
    for (const socket of Array.from(this.probes.keys())) this.stop(socket);
  }

  private fail(socket: WebSocket, probe: SignalingProbe): void {
    if (this.probes.get(socket) !== probe) return;
    this.stop(socket);
    this.onUnresponsive(socket);
  }

  private tick(socket: WebSocket, probe: SignalingProbe): void {
    if (this.probes.get(socket) !== probe) return;
    const now = Date.now();
    const tickGap = now - probe.lastTickAt;
    probe.lastTickAt = now;

    // A heavily throttled/backgrounded page is not proof of a dead server.
    // Re-arm from the foreground instead of declaring an outage from a timer
    // callback that itself arrived late.
    if (tickGap > SIGNALING_LIVENESS_SUSPENSION_GAP_MS) {
      probe.awaitingSince = null;
      return;
    }

    if (socket.readyState !== WebSocket.OPEN) {
      this.fail(socket, probe);
      return;
    }

    if (probe.awaitingSince !== null) {
      if (now - probe.awaitingSince >= SIGNALING_LIVENESS_TIMEOUT_MS) {
        this.fail(socket, probe);
      }
      return;
    }

    try {
      socket.send(SIGNALING_LIVENESS_PING);
      probe.awaitingSince = now;
    } catch {
      this.fail(socket, probe);
    }
  }
}
`,
);

const livenessTestPath = 'src/network/transport/__tests__/signaling-liveness.test.ts';
assertMissing(livenessTestPath);
write(
  livenessTestPath,
  `/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { CloudflareSignalingPeer } from '../cloudflare-signaling.ts';
import {
  SIGNALING_LIVENESS_INTERVAL_MS,
  SIGNALING_LIVENESS_PING,
  SIGNALING_LIVENESS_PONG,
  SIGNALING_LIVENESS_TIMEOUT_MS,
} from '../signaling-liveness.ts';

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

  it('answers the exact liveness frame in the Worker fallback path', async () => {
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
`,
);

replaceOnce(
  'src/network/transport/cloudflare-signaling.ts',
  "import { TinyEmitter } from './emitter.ts';\n",
  "import { TinyEmitter } from './emitter.ts';\nimport {\n  SIGNALING_LIVENESS_VERSION,\n  SignalingSocketLivenessMonitor,\n} from './signaling-liveness.ts';\n",
);
replaceOnce(
  'src/network/transport/cloudflare-signaling.ts',
  "      workerVersionId?: string;\n      memberIdentity?: StandardRoomMemberIdentity;\n",
  "      workerVersionId?: string;\n      signalingLivenessVersion?: 1;\n      memberIdentity?: StandardRoomMemberIdentity;\n",
);
replaceOnce(
  'src/network/transport/cloudflare-signaling.ts',
  "\n  private nextHostMessageSequence(): number {\n",
  "\n  private readonly signalingLiveness = new SignalingSocketLivenessMonitor((socket) => {\n    this.retireSignalingSocket(socket, true);\n  });\n\n  private nextHostMessageSequence(): number {\n",
);
replaceOnce(
  'src/network/transport/cloudflare-signaling.ts',
  "\n  reconnect(): void {\n",
  `
  private retireHostSignalingSocket(socket: WebSocket, closePhysical: boolean): boolean {
    this.signalingLiveness.stop(socket);
    this.rejectPendingRemoteShareUploadAssertions(
      socket,
      'REMOTE_SHARE_UPLOAD_ASSERTION_SOCKET_CLOSED',
    );
    if (this.hostSocket !== socket) return false;

    this.hostSocket = null;
    this.remoteShareUploadAssertionStatus = this.remoteShareUploadAssertionObserved
      ? 'unavailable'
      : 'unknown';
    this.open = false;
    const wasDisconnected = this.disconnected;
    this.disconnected = true;
    if (closePhysical) {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    }
    if (!wasDisconnected) this.emit('disconnected');
    return true;
  }

  private retireGuestSignalingSocket(
    roomId: string,
    socket: WebSocket,
    conn: CloudflareDataConnection,
    closePhysical: boolean,
  ): boolean {
    this.signalingLiveness.stop(socket);
    if (this.roomSockets.get(roomId) !== socket) return false;

    this.roomSockets.delete(roomId);
    const established = conn.peerConnection !== undefined;
    const wasDisconnected = this.disconnected;
    if (established) {
      this.disconnected = true;
      this.reconcileGuestBackgroundRecovery(roomId, true);
    }
    if (closePhysical) {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    }
    if (established && !wasDisconnected) this.emit('disconnected');
    return true;
  }

  private retireSignalingSocket(socket: WebSocket, closePhysical: boolean): boolean {
    if (this.hostSocket === socket) {
      return this.retireHostSignalingSocket(socket, closePhysical);
    }
    for (const [roomId, currentSocket] of this.roomSockets) {
      if (currentSocket !== socket) continue;
      const record = this.guestRooms.get(roomId);
      if (!record) {
        this.signalingLiveness.stop(socket);
        this.roomSockets.delete(roomId);
        if (closePhysical) {
          try {
            socket.close();
          } catch {
            /* noop */
          }
        }
        return true;
      }
      return this.retireGuestSignalingSocket(roomId, socket, record.conn, closePhysical);
    }
    this.signalingLiveness.stop(socket);
    return false;
  }

  markSignalingUnavailable(): boolean {
    if (this.destroyed) return false;
    let retired = false;
    const hostSocket = this.hostSocket;
    if (hostSocket) retired = this.retireHostSignalingSocket(hostSocket, true) || retired;
    for (const [roomId, socket] of Array.from(this.roomSockets.entries())) {
      const record = this.guestRooms.get(roomId);
      if (record) {
        retired = this.retireGuestSignalingSocket(roomId, socket, record.conn, true) || retired;
      } else {
        retired = this.retireSignalingSocket(socket, true) || retired;
      }
    }
    return retired;
  }

  reconnect(): void {
`,
);
replaceOnce(
  'src/network/transport/cloudflare-signaling.ts',
  "  destroy(): void {\n    this.destroyed = true;\n",
  "  destroy(): void {\n    this.destroyed = true;\n    this.signalingLiveness.stopAll();\n",
);
replaceOnce(
  'src/network/transport/cloudflare-signaling.ts',
  "    socket.addEventListener('message', (event) => {\n      const sequence = this.nextHostMessageSequence();\n",
  "    socket.addEventListener('message', (event) => {\n      if (this.signalingLiveness.noteMessage(socket, event.data)) return;\n      const sequence = this.nextHostMessageSequence();\n",
);
replaceOnce(
  'src/network/transport/cloudflare-signaling.ts',
  "    socket.addEventListener('message', (event) => {\n      this.handleGuestMessage(roomId, socket, conn, metadata, event.data).catch((error) =>\n",
  "    socket.addEventListener('message', (event) => {\n      if (this.signalingLiveness.noteMessage(socket, event.data)) return;\n      this.handleGuestMessage(roomId, socket, conn, metadata, event.data).catch((error) =>\n",
);
replaceOnce(
  'src/network/transport/cloudflare-signaling.ts',
  `    socket.addEventListener('close', (event) => {
      this.rejectPendingRemoteShareUploadAssertions(
        socket,
        'REMOTE_SHARE_UPLOAD_ASSERTION_SOCKET_CLOSED',
      );
      if (this.destroyed) return;
      if ((event as CloseEvent).reason === 'PRO_COORDINATOR_EPOCH_ADVANCED') {
        if (this.hostSocket === socket) this.hostSocket = null;
        this.handleProEpochAdvanced();
        return;
      }
      if (this.hostSocket === socket) {
        this.remoteShareUploadAssertionStatus = this.remoteShareUploadAssertionObserved
          ? 'unavailable'
          : 'unknown';
        this.open = false;
        const wasDisconnected = this.disconnected;
        this.disconnected = true;
        if (!wasDisconnected) this.emit('disconnected');
      }
    });
`,
  `    socket.addEventListener('close', (event) => {
      if (this.destroyed) {
        this.signalingLiveness.stop(socket);
        this.rejectPendingRemoteShareUploadAssertions(
          socket,
          'REMOTE_SHARE_UPLOAD_ASSERTION_SOCKET_CLOSED',
        );
        return;
      }
      if ((event as CloseEvent).reason === 'PRO_COORDINATOR_EPOCH_ADVANCED') {
        this.signalingLiveness.stop(socket);
        this.rejectPendingRemoteShareUploadAssertions(
          socket,
          'REMOTE_SHARE_UPLOAD_ASSERTION_SOCKET_CLOSED',
        );
        if (this.hostSocket === socket) this.hostSocket = null;
        this.handleProEpochAdvanced();
        return;
      }
      this.retireHostSignalingSocket(socket, false);
    });
`,
);
replaceOnce(
  'src/network/transport/cloudflare-signaling.ts',
  `    socket.addEventListener('close', (event) => {
      if (this.destroyed) return;
      if ((event as CloseEvent).reason === 'PRO_COORDINATOR_EPOCH_ADVANCED') {
        if (this.roomSockets.get(roomId) === socket) this.roomSockets.delete(roomId);
        this.handleProEpochAdvanced();
        return;
      }
      if (this.roomSockets.get(roomId) === socket) {
        this.roomSockets.delete(roomId);
        if (conn.peerConnection) {
          const wasDisconnected = this.disconnected;
          this.disconnected = true;
          this.reconcileGuestBackgroundRecovery(roomId, true);
          if (!wasDisconnected) this.emit('disconnected');
        }
      }
    });
`,
  `    socket.addEventListener('close', (event) => {
      if (this.destroyed) {
        this.signalingLiveness.stop(socket);
        return;
      }
      if ((event as CloseEvent).reason === 'PRO_COORDINATOR_EPOCH_ADVANCED') {
        this.signalingLiveness.stop(socket);
        if (this.roomSockets.get(roomId) === socket) this.roomSockets.delete(roomId);
        this.handleProEpochAdvanced();
        return;
      }
      this.retireGuestSignalingSocket(roomId, socket, conn, false);
    });
`,
);
replaceOnce(
  'src/network/transport/cloudflare-signaling.ts',
  "    if (message.type === 'peer-open') {\n      if (message.remoteShareUploadAssertionVersion === 1) {\n",
  "    if (message.type === 'peer-open') {\n      if (sourceSocket && message.signalingLivenessVersion === SIGNALING_LIVENESS_VERSION) {\n        this.signalingLiveness.start(sourceSocket);\n      }\n      if (message.remoteShareUploadAssertionVersion === 1) {\n",
);
replaceOnce(
  'src/network/transport/cloudflare-signaling.ts',
  "    if (message.type === 'peer-open') {\n      // Only the Worker's peer-open proves that guest-auth won admission for\n",
  "    if (message.type === 'peer-open') {\n      if (message.signalingLivenessVersion === SIGNALING_LIVENESS_VERSION) {\n        this.signalingLiveness.start(socket);\n      }\n      // Only the Worker's peer-open proves that guest-auth won admission for\n",
);

replaceOnce(
  'src/network/transport/types.ts',
  "  reconnect?(): void;\n",
  "  reconnect?(): void;\n  /** Retire a signaling path that the browser/OS has proven unavailable. */\n  markSignalingUnavailable?(): boolean;\n",
);

replaceOnce(
  'src/network/peer.ts',
  "import { requestProRoomTransportRecovery } from '../pro-room/transport-recovery.ts';\n",
  "import {\n  requestProRoomTransportRecovery,\n  restartProRoomTransportRecovery,\n} from '../pro-room/transport-recovery.ts';\n",
);
replaceOnce(
  'src/network/peer.ts',
  "const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];\n\nasync function performScheduledPeerReconnect",
  `const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
let _browserConnectivityRecoveryBound = false;

function bindBrowserConnectivityRecovery(): void {
  if (_browserConnectivityRecoveryBound || typeof window === 'undefined') return;
  _browserConnectivityRecoveryBound = true;

  window.addEventListener('offline', () => {
    if (!getState('setup.sessionStarted')) return;
    const peer = getPeer();
    if (!peer || peer.destroyed) return;
    if (peer.markSignalingUnavailable?.()) {
      log.warn('[Transport] Browser reported offline; signaling recovery started immediately');
    }
  });

  window.addEventListener('online', () => {
    if (!getState('setup.sessionStarted')) return;
    const peer = getPeer();
    if (!peer || peer.destroyed) return;
    const health = getState('network.signalingHealth').status;
    if (!peer.disconnected && health !== 'exhausted') return;

    clearManagedTimer('peer-signaling-reconnect');
    if (getRoomContext().kind === 'pro') {
      restartProRoomTransportRecovery();
      return;
    }
    retryPeerSignalingConnection();
  });
}

async function performScheduledPeerReconnect`,
);
replaceOnce(
  'src/network/peer.ts',
  "function setupPeerEvents(peer: PeerInstance): void {\n  peer.on('open', () => {\n",
  "function setupPeerEvents(peer: PeerInstance): void {\n  bindBrowserConnectivityRecovery();\n\n  peer.on('open', () => {\n",
);

replaceOnce(
  'cloudflare/signaling-worker.ts',
  "  getWebSockets?(): SocketPort[];\n  acceptWebSocket(socket: SocketPort, tags?: string[]): void;\n",
  "  getWebSockets?(): SocketPort[];\n  setWebSocketAutoResponse?(pair: unknown): void;\n  acceptWebSocket(socket: SocketPort, tags?: string[]): void;\n",
);
replaceOnce(
  'cloudflare/signaling-worker.ts',
  "const WS_RATE_LIMIT_PER_MINUTE = 120;\n",
  `const WS_RATE_LIMIT_PER_MINUTE = 120;
const SIGNALING_LIVENESS_VERSION = 1 as const;
const SIGNALING_LIVENESS_PING = '{"type":"signaling-liveness-ping","version":1}';
const SIGNALING_LIVENESS_PONG = '{"type":"signaling-liveness-pong","version":1}';
`,
);
replaceOnce(
  'cloudflare/signaling-worker.ts',
  `function workerVersionFields(env: SignalingEnvPort): { workerVersionId?: string } {
  const metadata = env.CF_VERSION_METADATA;
  const workerVersionId = isRecord(metadata) ? metadata.id : undefined;
  return typeof workerVersionId === 'string' && workerVersionId ? { workerVersionId } : {};
}
`,
  `function workerVersionFields(env: SignalingEnvPort): {
  workerVersionId?: string;
  signalingLivenessVersion: typeof SIGNALING_LIVENESS_VERSION;
} {
  const metadata = env.CF_VERSION_METADATA;
  const workerVersionId = isRecord(metadata) ? metadata.id : undefined;
  return {
    signalingLivenessVersion: SIGNALING_LIVENESS_VERSION,
    ...(typeof workerVersionId === 'string' && workerVersionId ? { workerVersionId } : {}),
  };
}
`,
);
replaceOnce(
  'cloudflare/signaling-worker.ts',
  "    this.state = state;\n    this.env = env;\n    this.standardRateOnly = STANDARD_WS_RATE_OBJECT_NAME_RE.test(String(state.id?.name || ''));\n",
  `    this.state = state;
    this.env = env;
    const requestResponsePair = (
      globalThis as typeof globalThis & {
        WebSocketRequestResponsePair?: new (request: string, response: string) => unknown;
      }
    ).WebSocketRequestResponsePair;
    if (typeof state.setWebSocketAutoResponse === 'function' && requestResponsePair) {
      try {
        state.setWebSocketAutoResponse(
          new requestResponsePair(SIGNALING_LIVENESS_PING, SIGNALING_LIVENESS_PONG),
        );
      } catch {
        // Local/test runtimes use the explicit webSocketMessage fallback below.
      }
    }
    this.standardRateOnly = STANDARD_WS_RATE_OBJECT_NAME_RE.test(String(state.id?.name || ''));
`,
);
replaceOnce(
  'cloudflare/signaling-worker.ts',
  "  webSocketMessage(ws: SocketPort, raw: unknown): Promise<void> {\n    const attachment = readAttachment(ws);\n",
  `  webSocketMessage(ws: SocketPort, raw: unknown): Promise<void> {
    // Production Durable Objects answer this exact frame without waking the
    // object. Keep a fallback for local tests and runtimes without auto-response.
    if (raw === SIGNALING_LIVENESS_PING) {
      try {
        ws.send(SIGNALING_LIVENESS_PONG);
      } catch {
        /* noop */
      }
      return Promise.resolve();
    }
    const attachment = readAttachment(ws);
`,
);

replaceOnce(
  '.github/workflows/ci.yml',
  "on:\n  push:\n    branches: [main]\n  pull_request:\n",
  "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n  pull_request:\n",
);
replaceOnce(
  '.github/workflows/ci.yml',
  "        if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n        env:\n",
  "        if: (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'\n        env:\n",
);
replaceOnce(
  '.github/workflows/ci.yml',
  "        if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n",
  "        if: (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'\n        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n",
);

replaceOnce(
  'scripts/release-evidence.mts',
  "  event: string;\n  prefix: string;\n",
  "  events: readonly string[];\n  prefix: string;\n",
);
replaceOnce(
  'scripts/release-evidence.mts',
  `async function waitForArtifact({
  workflow,
  event,
  prefix,
  outputPrefix,
  timeoutMs,
}: WaitForArtifactOptions): Promise<void> {`,
  `async function waitForArtifact({
  workflow,
  events,
  prefix,
  outputPrefix,
  timeoutMs,
}: WaitForArtifactOptions): Promise<void> {`,
);
replaceOnce(
  'scripts/release-evidence.mts',
  `  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await githubApi(workflowRunsPath(repository, workflow, sha, event), token);
    const skippedRunIds = new Set<number>();
    let run = selectLatestSuccessfulRun(runs, { sha, event }, skippedRunIds);
    while (run) {
      const artifacts = await githubApi(
        `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
        token,
      );
      const artifact = selectExactArtifact(artifacts, {
        prefix,
        sha,
        runId: run.id,
        runAttempt: run.run_attempt,
      });
      if (artifact) {
        appendGithubOutputs(output, {
          [`${outputPrefix}run_id`]: run.id,
          [`${outputPrefix}run_attempt`]: run.run_attempt,
          [`${outputPrefix}artifact_name`]: artifact.name,
          ...(outputPrefix === '' ? { validation_profile: 'main-ci' } : {}),
        });
        return;
      }
      skippedRunIds.add(run.id);
      run = selectLatestSuccessfulRun(runs, { sha, event }, skippedRunIds);
    }

    const hasCompletedRun = latestCompletedUrl(runs, sha, event).length > 0;
    if (!hasActiveExactRun(runs, sha, event) && hasCompletedRun) {
      if (skippedRunIds.size > 0) {
        throw new Error(
          `No successful ${workflow} run for the exact main commit has an unexpired exact-attempt artifact.`,
        );
      }
      throw new Error(`The exact main commit did not pass ${workflow}.`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }
`,
  `  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runSets = await Promise.all(
      events.map(async (event) => ({
        event,
        runs: await githubApi(workflowRunsPath(repository, workflow, sha, event), token),
      })),
    );
    let hasActiveRun = false;
    let hasCompletedRun = false;
    let sawSuccessfulRunWithoutArtifact = false;

    for (const { event, runs } of runSets) {
      const skippedRunIds = new Set<number>();
      let run = selectLatestSuccessfulRun(runs, { sha, event }, skippedRunIds);
      while (run) {
        const artifacts = await githubApi(
          `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
          token,
        );
        const artifact = selectExactArtifact(artifacts, {
          prefix,
          sha,
          runId: run.id,
          runAttempt: run.run_attempt,
        });
        if (artifact) {
          appendGithubOutputs(output, {
            [`${outputPrefix}run_id`]: run.id,
            [`${outputPrefix}run_attempt`]: run.run_attempt,
            [`${outputPrefix}artifact_name`]: artifact.name,
            ...(outputPrefix === '' ? { validation_profile: 'main-ci' } : {}),
          });
          return;
        }
        skippedRunIds.add(run.id);
        sawSuccessfulRunWithoutArtifact = true;
        run = selectLatestSuccessfulRun(runs, { sha, event }, skippedRunIds);
      }
      hasActiveRun ||= hasActiveExactRun(runs, sha, event);
      hasCompletedRun ||= latestCompletedUrl(runs, sha, event).length > 0;
    }

    if (!hasActiveRun && hasCompletedRun) {
      if (sawSuccessfulRunWithoutArtifact) {
        throw new Error(
          `No successful ${workflow} run for the exact main commit has an unexpired exact-attempt artifact.`,
        );
      }
      throw new Error(`The exact main commit did not pass ${workflow}.`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }
`,
);
replaceOnce(
  'scripts/release-evidence.mts',
  "      event: 'push',\n      prefix: 'production-candidate-',\n",
  "      events: ['push', 'workflow_dispatch'],\n      prefix: 'production-candidate-',\n",
);

replaceOnce(
  'scripts/service-worker-asset.ts',
  "export const SERVICE_WORKER_CACHE_VERSION = 'v459';\n",
  "export const SERVICE_WORKER_CACHE_VERSION = 'v460';\n",
);
replaceOnce(
  'index.html',
  '<script src="/bootstrap.js?cache=v459"></script>',
  '<script src="/bootstrap.js?cache=v460"></script>',
);

console.log('Applied signaling liveness, recovery, CI, and cache-generation patch.');
