/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../../core/constants.ts';
import { log } from '../../../core/log.ts';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { __cloudflareSignalingForTests, CloudflareSignalingPeer } from '../cloudflare-signaling.ts';

/**
 * Characterization of a Standard guest's link liveness at the signaling peer,
 * before Phase 4 moves it into one owner: the one-restart-per-interruption
 * gate and the three PR #471 room-expiry rules that must survive the move:
 * no original-route ICE restart after expiry, a resume check after expiry
 * treated as signaling loss, and the live RTC kept until its own evidence ends.
 * (peer.ts's outer-loop expiry checks are pinned in
 * src/network/__tests__/signaling-expiry-short-circuits.test.ts.)
 */
const GRACE_MS = 15_000;
const RESUME_DISCONNECTED_PROBE_MS = 1_000;
const RESUME_LIVENESS_TIMEOUT_MS = 3_000;
const SIGNALING_URL = 'wss://signal.example.test/api/rooms';
const ROOM = '123456';

const originalWebSocket = globalThis.WebSocket;
const originalRTCPeerConnection = globalThis.RTCPeerConnection;

type SocketListener = (event: {
  data?: unknown;
  reason?: string;
  code?: number;
  wasClean?: boolean;
}) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private readonly listeners = new Map<string, Set<SocketListener>>();
  readonly protocols: string[];
  constructor(
    readonly url: string,
    protocols: string | string[] = [],
  ) {
    this.protocols = typeof protocols === 'string' ? [protocols] : [...protocols];
    FakeWebSocket.instances.push(this);
  }
  addEventListener(event: string, listener: SocketListener): void {
    const listeners = this.listeners.get(event) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  removeEventListener(event: string, listener: SocketListener): void {
    this.listeners.get(event)?.delete(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.dispatch('close', undefined, reason, code, true);
  }
  dispatch(event: string, data?: unknown, reason?: string, code = 1006, wasClean = false): void {
    if (event === 'open') this.readyState = FakeWebSocket.OPEN;
    if (event === 'close') this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ data, reason, code, wasClean });
    }
  }
}

type ChannelListener = (event: { data?: unknown; error?: unknown }) => void;

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  binaryType: BinaryType = 'blob';
  sent: unknown[] = [];
  private readonly listeners = new Map<string, Set<ChannelListener>>();
  constructor(readonly label: string) {}
  addEventListener(event: string, listener: ChannelListener): void {
    const listeners = this.listeners.get(event) ?? new Set<ChannelListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatch('close');
  }
  dispatch(event: string, data?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(event === 'error' ? { error: data } : { data });
    }
  }
}

type RTCListener = (event: unknown) => void;

/** Global RTCPeerConnection fake with a modelled signaling state. */
class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'connected';
  signalingState: RTCSignalingState = 'stable';
  localDescription: { type: RTCSdpType; sdp: string; toJSON(): RTCSessionDescriptionInit } | null =
    null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly channels: FakeDataChannel[] = [];
  rollbackCount = 0;
  private readonly listeners = new Map<string, Set<RTCListener>>();
  constructor(public configuration?: RTCConfiguration) {
    FakeRTCPeerConnection.instances.push(this);
  }
  setConfiguration(configuration: RTCConfiguration): void {
    this.configuration = configuration;
  }
  addEventListener(event: string, listener: RTCListener): void {
    const listeners = this.listeners.get(event) ?? new Set<RTCListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  removeEventListener(event: string, listener: RTCListener): void {
    this.listeners.get(event)?.delete(listener);
  }
  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'fake-offer' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'fake-answer' };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === 'rollback') {
      this.rollbackCount++;
      this.localDescription = null;
      this.setSignalingState('stable');
      return;
    }
    const type = description.type ?? 'offer';
    const sdp = description.sdp ?? '';
    this.localDescription = { type, sdp, toJSON: () => ({ type, sdp }) };
    if (type === 'offer') this.setSignalingState('have-local-offer');
    else if (type === 'answer') this.setSignalingState('stable');
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === 'rollback') {
      this.rollbackCount++;
      this.setSignalingState('stable');
      return;
    }
    this.remoteDescription = description;
    if (description.type === 'offer') this.setSignalingState('have-remote-offer');
    else if (description.type === 'answer') this.setSignalingState('stable');
  }
  async addIceCandidate(): Promise<void> {}
  getSenders(): RTCRtpSender[] {
    return [];
  }
  close(): void {
    this.connectionState = 'closed';
    this.setSignalingState('closed');
    this.dispatch('connectionstatechange', {});
  }
  state(value: RTCPeerConnectionState): void {
    this.connectionState = value;
    this.dispatch('connectionstatechange', {});
  }
  private setSignalingState(state: RTCSignalingState): void {
    if (this.signalingState === state) return;
    this.signalingState = state;
    this.dispatch('signalingstatechange', {});
  }
  dispatch(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
  control(): FakeDataChannel {
    return this.channels.find((channel) => channel.label === 'musixquare-control')!;
  }
}

function install(): void {
  FakeWebSocket.instances = [];
  FakeRTCPeerConnection.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: FakeWebSocket as unknown as typeof WebSocket,
  });
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    value: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
  });
}

function sentOfType(socket: FakeWebSocket, type: string): Array<Record<string, unknown>> {
  return socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === type);
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** An admitted guest whose data connection is open; `restartable` marks the host's first answer. */
async function guest(restartable: boolean) {
  install();
  const peer = new CloudflareSignalingPeer(null, {
    provider: 'cloudflare',
    signalingUrl: SIGNALING_URL,
    config: { iceServers: [] },
  });
  const conn = peer.connect(ROOM);
  const socket = FakeWebSocket.instances[0]!;
  socket.dispatch('open');
  await flushAsync();
  socket.dispatch('message', JSON.stringify({ type: 'peer-open', peerId: peer.id, roomId: ROOM }));
  await flushAsync();
  const pc = FakeRTCPeerConnection.instances[0]!;
  const dataOffer = sentOfType(socket, 'signal-offer')[0];
  socket.dispatch(
    'message',
    JSON.stringify({
      type: 'signal-answer',
      from: 'host',
      negotiationId: dataOffer?.negotiationId,
      sdp: { type: 'answer', sdp: 'data-answer' },
      ...(restartable ? { iceRestartVersion: 1 } : {}),
    }),
  );
  await vi.waitFor(() => expect(pc.signalingState).toBe('stable'));
  await vi.waitFor(() => expect(conn.open).toBe(true));
  const closed = vi.fn();
  conn.on('close', closed);
  const offers = () => sentOfType(socket, 'signal-offer').length;
  const expire = () => socket.dispatch('close', undefined, 'ROOM_EXPIRED', 1012, true);
  const probes = () =>
    pc
      .control()
      .sent.filter((data): data is string => typeof data === 'string')
      .map((data) => JSON.parse(data) as { type: string; pingId: number })
      .filter((frame) => frame.type === MSG.SYNC_PING);
  return { peer, conn, socket, pc, closed, offers, expire, probes };
}

afterEach(() => {
  clearAllManagedTimers();
  __cloudflareSignalingForTests.resetPageSignalingSocketHandles();
  __cloudflareSignalingForTests.resetStandardHttpPreference();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    value: originalRTCPeerConnection,
  });
});

describe('Standard guest restart gate', () => {
  it('sends one restart offer per interruption and closes at its 15 s deadline without an answer', async () => {
    const g = await guest(true);
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    vi.useFakeTimers();
    const start = Date.now();
    g.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(0);
    expect(g.offers()).toBe(2);
    expect(g.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    g.pc.state('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(g.offers()).toBe(2);
    expect(
      info.mock.calls.filter(
        ([message]) =>
          message ===
          '[Transport] Restarting established Standard-room ICE within disconnect grace',
      ),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(g.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.closed).toHaveBeenCalledOnce();
    expect(g.offers()).toBe(2);
    g.peer.destroy();
  });

  it('restarts a guest whose host answered without the ICE restart marker', async () => {
    // The marker has not gated the restart since old-version removal train 2
    // (survey OV-F04 stage 1), and a host from train 3 on (stage 2) sends none.
    const g = await guest(false);
    vi.useFakeTimers();
    const start = Date.now();
    g.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(0);
    expect(g.offers()).toBe(2);
    expect(g.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(g.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.closed).toHaveBeenCalledOnce();
    g.peer.destroy();
  });
});

describe('PR #471 room-expiry rows', () => {
  it('does not restart the original route after expiry and still closes it at the 15 s grace', async () => {
    const g = await guest(true);
    vi.useFakeTimers();
    g.expire();
    expect(g.peer.getSignalingRecoveryBlockReason()).toBe('room-expired');
    const start = Date.now();
    g.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(0);
    expect(g.offers()).toBe(1);
    expect(g.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    g.pc.state('failed');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(g.conn.open).toBe(true);
    expect(g.offers()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.closed).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(1);
    g.peer.destroy();
  });

  it.each([
    { signaling: 'expired', status: 'stale-connection-closed', closesAtMs: 0 },
    { signaling: 'lost', status: 'stale-connection-closed', closesAtMs: 0 },
    { signaling: 'healthy', status: 'monitoring', closesAtMs: RESUME_DISCONNECTED_PROBE_MS },
  ] as const)(
    'resolves a resume check on a disconnected route with $signaling signaling as $status',
    async ({ signaling, status, closesAtMs }) => {
      const g = await guest(true);
      vi.useFakeTimers();
      if (signaling === 'expired') g.expire();
      if (signaling === 'lost') g.socket.dispatch('close', undefined, 'network blip', 1006, false);
      // WebKit may report the stale route without delivering a transition.
      g.pc.connectionState = 'disconnected';
      expect(g.peer.recoverAfterBackground(60_000)).toEqual({ status });
      if (closesAtMs > 0) {
        await vi.advanceTimersByTimeAsync(closesAtMs - 1);
        expect(g.conn.open).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(g.closed).toHaveBeenCalledOnce();
      g.peer.destroy();
    },
  );

  it('keeps a connected route after expiry until its resume challenge goes unanswered', async () => {
    const g = await guest(true);
    vi.useFakeTimers();
    g.expire();
    expect(g.peer.recoverAfterBackground(60_000)).toEqual({ status: 'monitoring' });
    expect(g.probes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS - 1);
    expect(g.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.closed).toHaveBeenCalledOnce();
    g.peer.destroy();
  });

  it('keeps a connected route after expiry once the exact pong arrives', async () => {
    const g = await guest(true);
    vi.useFakeTimers();
    g.expire();
    g.peer.recoverAfterBackground(60_000);
    g.pc.control().dispatch(
      'message',
      JSON.stringify({
        type: MSG.SYNC_PONG,
        pingId: g.probes()[0]!.pingId,
        hostTime: Date.now(),
        position: 0,
        mode: null,
        activity: 'idle',
        queueItemId: null,
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(g.conn.open).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);
    g.peer.destroy();
  });

  it.each([
    { signaling: 'expired', closesAtMs: 0 },
    { signaling: 'healthy', closesAtMs: RESUME_DISCONNECTED_PROBE_MS },
  ] as const)(
    'closes an armed resume probe whose route then disconnects, with $signaling signaling, after $closesAtMs ms',
    async ({ signaling, closesAtMs }) => {
      const g = await guest(true);
      vi.useFakeTimers();
      if (signaling === 'expired') g.expire();
      expect(g.peer.recoverAfterBackground(60_000)).toEqual({ status: 'monitoring' });
      g.pc.state('disconnected');
      if (closesAtMs > 0) {
        expect(g.conn.open).toBe(true);
        await vi.advanceTimersByTimeAsync(closesAtMs);
      }
      expect(g.closed).toHaveBeenCalledOnce();
      g.peer.destroy();
    },
  );
});
