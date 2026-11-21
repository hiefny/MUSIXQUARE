/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../core/log.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  __cloudflareSignalingForTests,
  CloudflareSignalingPeer,
} from '../transport/cloudflare-signaling.ts';
import { isOfflineSignalingSetupFailure } from '../setup-offline-failure.ts';

// Offline room guidance: a Standard room setup failure names the network only
// when the browser reports no network AND no server answered it. The transport
// rows run the real transport, so their verdicts are about the object setup
// receives.

const PRIMARY_SIGNALING_URL = 'wss://signal.example.test/api/rooms';
const FALLBACK_SIGNALING_URL = 'wss://signal-alt.example.test/api/rooms';
const ROOM_CODE = '482913';

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('FAKE_SOCKET_NOT_OPEN');
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', Object.assign(new Event('close'), { code, reason, wasClean: true }));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', new Event('open'));
  }

  message(data: string): void {
    this.emit('message', Object.assign(new Event('message'), { data }));
  }

  /** A connection that never gets an answer, as offline: CLOSED, error, then close 1006. */
  failWithoutAnswer(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('error', new Event('error'));
    this.emit(
      'close',
      Object.assign(new Event('close'), { code: 1006, reason: '', wasClean: false }),
    );
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

const options = {
  provider: 'cloudflare' as const,
  signalingUrl: PRIMARY_SIGNALING_URL,
  signalingFallbackUrl: FALLBACK_SIGNALING_URL,
  config: { iceServers: [] },
  // Offline, the route probe before the alternate origin fails every probe and
  // resolves null; the provider then retries anyway.
  prepareNetworkRouteRetry: async () => null,
};

/** The browser's own network report, as navigator.onLine gives it. */
function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

/** The verdict for one failure with the browser offline, then online. */
function verdicts(error: unknown): { offline: boolean; online: boolean } {
  setOnline(false);
  const offline = isOfflineSignalingSetupFailure(error);
  setOnline(true);
  const online = isOfflineSignalingSetupFailure(error);
  return { offline, online };
}

async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function rejectEveryFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  );
}

/** A guest whose primary and alternate sockets get no answer, then the HTTPS bridge's verdict. */
async function guestSetupFailure(): Promise<unknown> {
  const errors: unknown[] = [];
  const peer = new CloudflareSignalingPeer(null, options);
  const conn = peer.connect(ROOM_CODE);
  conn.on('error', (error: unknown) => errors.push(error));
  FakeWebSocket.instances[0]!.failWithoutAnswer();
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
  FakeWebSocket.instances[1]!.failWithoutAnswer();
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  await settle();
  peer.destroy();
  return errors[0];
}

/** A guest admitted to a socket that then reports one Worker error frame. */
async function guestFrameFailure(frame: Record<string, unknown>): Promise<unknown> {
  rejectEveryFetch();
  const errors: unknown[] = [];
  const peer = new CloudflareSignalingPeer(null, options);
  const conn = peer.connect(ROOM_CODE);
  conn.on('error', (error: unknown) => errors.push(error));
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  await settle();
  socket.message(JSON.stringify({ type: 'error', ...frame }));
  await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(1));
  socket.close(1008, String(frame.message ?? ''));
  await settle();
  peer.destroy();
  return errors[0];
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  vi.spyOn(log, 'info').mockImplementation(() => undefined);
  vi.spyOn(log, 'debug').mockImplementation(() => undefined);
  vi.spyOn(log, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearAllManagedTimers();
  __cloudflareSignalingForTests.resetPageSignalingSocketHandles();
  __cloudflareSignalingForTests.resetStandardHttpPreference();
  Reflect.deleteProperty(navigator, 'onLine');
});

describe('a Standard room setup failure that no server answered', () => {
  it('counts a guest whose every setup route failed without an answer, only while offline', async () => {
    rejectEveryFetch();

    const error = await guestSetupFailure();

    expect(error).toBeInstanceOf(Event);
    expect(error).toMatchObject({ phase: 'open', status: null });
    expect(verdicts(error)).toEqual({ offline: true, online: false });
  });

  it('counts a host whose every setup route failed without an answer, only while offline', async () => {
    rejectEveryFetch();
    const errors: unknown[] = [];
    const peer = new CloudflareSignalingPeer(ROOM_CODE, options);
    peer.on('error', (error: unknown) => errors.push(error));
    await settle(1);
    FakeWebSocket.instances[0]!.failWithoutAnswer();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    FakeWebSocket.instances[1]!.failWithoutAnswer();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    await settle();
    peer.destroy();

    expect(errors[0]).toBeInstanceOf(Event);
    expect(errors[0]).toMatchObject({ phase: 'open', status: null });
    expect(verdicts(errors[0])).toEqual({ offline: true, online: false });
  });

  it('counts a raw WebSocket error event, only while offline', () => {
    expect(verdicts(new Event('error'))).toEqual({ offline: true, online: false });
  });

  it('counts a host admission timeout on a network that hangs, only while offline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    );
    const errors: unknown[] = [];
    const peer = new CloudflareSignalingPeer(ROOM_CODE, options);
    peer.on('error', (error: unknown) => errors.push(error));
    await vi.advanceTimersByTimeAsync(20_000);
    peer.destroy();

    expect(errors[0]).toMatchObject({
      type: 'network',
      message: 'SIGNALING_HOST_ADMISSION_TIMEOUT',
    });
    expect(verdicts(errors[0])).toEqual({ offline: true, online: false });
  });

  it.each([
    ['the peer-open deadline', 'PEER_OPEN_TIMEOUT'],
    ['the guest join deadline', 'HOST_UNREACHABLE'],
  ])('counts %s, only while offline', (_label, message) => {
    expect(verdicts(new Error(message))).toEqual({ offline: true, online: false });
  });
});

describe('a failure the server answered with a type or a status, or a local teardown, never names the network', () => {
  it('keeps an HTTPS bridge answer with an HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } }),
        ),
      ),
    );

    const error = await guestSetupFailure();

    expect(error).toMatchObject({ phase: 'open', status: 503 });
    expect(verdicts(error)).toEqual({ offline: false, online: false });
  });

  it.each([
    ['room-full', { errorType: 'room-full', message: 'ROOM_GUEST_LIMIT_REACHED' }],
    ['server-error', { errorType: 'server-error', message: 'SIGNALING_ERROR' }],
    ['peer-unavailable', { errorType: 'peer-unavailable', message: 'HOST_NOT_AVAILABLE' }],
    [
      'app-update-required',
      { errorType: 'app-update-required', message: 'APP_UPDATE_REQUIRED', minAppBuild: 9999 },
    ],
  ])('keeps a Worker %s frame', async (_label, frame) => {
    const error = await guestFrameFailure(frame);

    expect(error).toMatchObject({ type: frame.errorType });
    expect(verdicts(error)).toEqual({ offline: false, online: false });
  });

  it('keeps a wrapped network init failure', () => {
    expect(verdicts(new Error('NETWORK_INIT_FAILED'))).toEqual({ offline: false, online: false });
  });

  it('keeps a local teardown', () => {
    const peer = new CloudflareSignalingPeer(null, options);
    peer.destroy();
    let teardown: unknown;
    try {
      peer.connect(ROOM_CODE);
    } catch (error) {
      teardown = error;
    }

    expect(teardown).toMatchObject({ type: 'disconnected', message: 'PEER_DESTROYED' });
    expect(verdicts(teardown)).toEqual({ offline: false, online: false });
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a bare message', 'HOST_UNREACHABLE'],
  ])('keeps %s', (_label, value) => {
    expect(verdicts(value)).toEqual({ offline: false, online: false });
  });
});
