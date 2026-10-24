/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../core/log.ts';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { __cloudflareSignalingForTests, CloudflareSignalingPeer } from '../cloudflare-signaling.ts';
import type { TransportPeerOptions } from '../types.ts';

/**
 * Baseline for an open owner decision (Phase 4 default 11): the one-shot
 * setup route-retry barrier installs the route's fresh RTC configuration
 * without its credential expiry. Today that drops the known expiry to
 * "unknown", so the very next due-renewal check renews: a guest's first offer
 * waits for it, a host's first incoming offer waits for it, a background
 * resume starts it, and otherwise the renewal timer runs it 30 s later
 * instead of shortly before the real expiry. That renewal restores a real
 * expiry (self-healing). Nothing records whether this is accepted or a bug:
 * change these expectations only with that owner decision.
 */
const PRIMARY_SIGNALING_URL = 'wss://signal.example.test/api/rooms';
const FALLBACK_SIGNALING_URL = 'wss://signal-alt.example.test/api/rooms';
const RTC_CREDENTIAL_RETRY_MS = 30_000;
const LONG_LEASE_MS = 48 * 60 * 60 * 1_000;

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
  constructor(readonly url: string) {
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
    this.dispatch('close', reason, code, true);
  }
  dispatch(event: string, reason?: string, code = 1006, wasClean = false, data?: unknown): void {
    if (event === 'open') this.readyState = FakeWebSocket.OPEN;
    if (event === 'close') this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ data, reason, code, wasClean });
    }
  }
}

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  binaryType: BinaryType = 'blob';
  constructor(readonly label: string) {
    super();
  }
  send(): void {}
  close(): void {
    this.readyState = 'closed';
  }
}

/** Records the configuration each RTC connection was created with or given. */
class FakeRTCPeerConnection extends EventTarget {
  static instances: FakeRTCPeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: (RTCSessionDescriptionInit & { toJSON(): RTCSessionDescriptionInit }) | null =
    null;
  readonly createdWith?: RTCConfiguration;
  constructor(public configuration?: RTCConfiguration) {
    super();
    this.createdWith = configuration;
    FakeRTCPeerConnection.instances.push(this);
  }
  setConfiguration(configuration: RTCConfiguration): void {
    this.configuration = configuration;
  }
  createDataChannel(label: string): FakeDataChannel {
    return new FakeDataChannel(label);
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer' };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = { ...description, toJSON: () => description };
  }
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  getSenders(): RTCRtpSender[] {
    return [];
  }
  close(): void {
    this.connectionState = 'closed';
  }
}

type Renewal = NonNullable<TransportPeerOptions['rtcConfigurationProvider']>;

function username(configuration: RTCConfiguration | undefined): unknown {
  return (configuration?.iceServers?.[0] as RTCIceServer | undefined)?.username;
}

/** Peer-open on the current socket ends setup, so no further route is tried. */
async function admit(peer: CloudflareSignalingPeer, role: 'host' | 'guest'): Promise<void> {
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.dispatch('open');
  await vi.advanceTimersByTimeAsync(0);
  socket.dispatch(
    'message',
    undefined,
    undefined,
    undefined,
    JSON.stringify({
      type: 'peer-open',
      peerId: role === 'host' ? '123456' : peer.id,
      roomId: '123456',
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
}

function configuration(username: string): RTCConfiguration {
  return {
    iceServers: [{ urls: 'turn:turn.example.test:3478', username, credential: 'test-only' }],
  };
}

/**
 * A Standard setup peer whose first signaling socket fails before admission.
 * The barrier resolves with `routeConfiguration` (or null) like
 * prepareStandardRoomNetworkRouteRetry does after its route probe.
 */
async function failFirstRoute(role: 'host' | 'guest', routeConfiguration: RTCConfiguration | null) {
  const start = Date.now();
  const renewal = vi.fn<Renewal>(async () => ({
    configuration: configuration('renewed'),
    expiresAt: Date.now() + LONG_LEASE_MS,
  }));
  const prepare = vi.fn(async () => routeConfiguration);
  const peer = new CloudflareSignalingPeer(role === 'host' ? '123456' : null, {
    provider: 'cloudflare',
    signalingUrl: PRIMARY_SIGNALING_URL,
    signalingFallbackUrl: FALLBACK_SIGNALING_URL,
    config: configuration('initial'),
    rtcConfigurationExpiresAt: start + LONG_LEASE_MS,
    rtcConfigurationProvider: renewal,
    prepareNetworkRouteRetry: prepare,
  });
  if (role === 'guest') peer.connect('123456');
  await vi.advanceTimersByTimeAsync(0);
  const first = FakeWebSocket.instances[0]!;
  first.dispatch('open');
  await vi.advanceTimersByTimeAsync(0);
  first.dispatch('error');
  await vi.advanceTimersByTimeAsync(0);
  expect(prepare).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledWith(expect.any(AbortSignal), FALLBACK_SIGNALING_URL);
  // The barrier's successor socket proves the retry completed.
  expect(FakeWebSocket.instances).toHaveLength(2);
  expect(new URL(FakeWebSocket.instances[1]!.url).origin).toBe('wss://signal-alt.example.test');
  return { peer, renewal };
}

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
});

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

describe('setup route-retry barrier and the RTC credential expiry', () => {
  it('keeps a known long lease without renewal when no barrier runs', async () => {
    const renewal = vi.fn<Renewal>();
    const peer = new CloudflareSignalingPeer(null, {
      provider: 'cloudflare',
      signalingUrl: PRIMARY_SIGNALING_URL,
      signalingFallbackUrl: FALLBACK_SIGNALING_URL,
      config: configuration('initial'),
      rtcConfigurationExpiresAt: Date.now() + LONG_LEASE_MS,
      rtcConfigurationProvider: renewal,
      prepareNetworkRouteRetry: vi.fn(async () => null),
    });
    peer.connect('123456');
    await vi.advanceTimersByTimeAsync(0);
    await admit(peer, 'guest');
    expect(username(FakeRTCPeerConnection.instances[0]?.createdWith)).toBe('initial');
    peer.recoverAfterBackground(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(renewal).not.toHaveBeenCalled();
    peer.destroy();
  });

  it.each(['guest', 'host'] as const)(
    'treats a %s renewal as due at once after the barrier',
    async (role) => {
      const { peer, renewal } = await failFirstRoute(role, configuration('route'));
      peer.recoverAfterBackground(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(renewal).toHaveBeenCalledOnce();
      peer.destroy();
    },
  );

  it('renews a host 30 s after the barrier when nothing needs RTC sooner, then keeps the lease', async () => {
    const { peer, renewal } = await failFirstRoute('host', configuration('route'));
    await admit(peer, 'host');
    await vi.advanceTimersByTimeAsync(RTC_CREDENTIAL_RETRY_MS - 1);
    expect(renewal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renewal).toHaveBeenCalledOnce();
    // The renewal restores a real expiry: no further renewal for a long time.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    peer.recoverAfterBackground(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(renewal).toHaveBeenCalledOnce();
    peer.destroy();
  });

  it('makes a guest offer that reaches the host before that renewal wait for it', async () => {
    const { peer, renewal } = await failFirstRoute('host', configuration('route'));
    await admit(peer, 'host');
    FakeWebSocket.instances.at(-1)!.dispatch(
      'message',
      undefined,
      undefined,
      undefined,
      JSON.stringify({
        type: 'signal-offer',
        from: 'guest-after-route-retry',
        negotiationId: 'negotiation_test_000001',
        sdp: { type: 'offer', sdp: 'guest-data-offer' },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(renewal).toHaveBeenCalledOnce();
    expect(username(FakeRTCPeerConnection.instances[0]?.createdWith)).toBe('renewed');
    peer.destroy();
  });

  it('makes a guest wait for a renewal before creating its first RTC connection', async () => {
    const { peer, renewal } = await failFirstRoute('guest', configuration('route'));
    await admit(peer, 'guest');
    expect(renewal).toHaveBeenCalledOnce();
    expect(username(FakeRTCPeerConnection.instances[0]?.createdWith)).toBe('renewed');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(renewal).toHaveBeenCalledOnce();
    peer.destroy();
  });

  it.each(['guest', 'host'] as const)(
    'keeps the known expiry for a %s when the barrier yields no configuration',
    async (role) => {
      const { peer, renewal } = await failFirstRoute(role, null);
      await admit(peer, role);
      if (role === 'guest') {
        expect(username(FakeRTCPeerConnection.instances[0]?.createdWith)).toBe('initial');
      }
      peer.recoverAfterBackground(0);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(renewal).not.toHaveBeenCalled();
      peer.destroy();
    },
  );
});
