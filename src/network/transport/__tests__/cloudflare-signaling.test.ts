/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareSignalingPeer } from '../cloudflare-signaling.ts';
import type { TransportDataConnection } from '../types.ts';
import { clearAllManagedTimers } from '../../../core/timers.ts';

const originalWebSocket = globalThis.WebSocket;

function createPeer(): CloudflareSignalingPeer {
  return new CloudflareSignalingPeer(null, {
    provider: 'cloudflare',
    signalingUrl: 'wss://signal.example.test/api/rooms',
    config: { iceServers: [] },
  });
}

type FakeSocketListener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCount = 0;
  private listeners = new Map<string, Set<FakeSocketListener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: FakeSocketListener): void {
    const listeners = this.listeners.get(event) ?? new Set<FakeSocketListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closeCount++;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close');
  }

  dispatch(event: string, data?: unknown): void {
    if (event === 'open') this.readyState = FakeWebSocket.OPEN;
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ data });
    }
  }
}

function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: FakeWebSocket as unknown as typeof WebSocket,
  });
}

function privateMaps(peer: CloudflareSignalingPeer): {
  connections: Map<string, TransportDataConnection>;
  roomSockets: Map<string, FakeWebSocket>;
} {
  return peer as unknown as {
    connections: Map<string, TransportDataConnection>;
    roomSockets: Map<string, FakeWebSocket>;
  };
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

describe('CloudflareSignalingPeer signaling lifecycle', () => {
  it('does not close a live data channel when only signaling reports peer-left', async () => {
    const peer = createPeer();
    const close = vi.fn();
    const conn = {
      open: true,
      close,
      peerConnection: { connectionState: 'connected' },
    };

    (peer as unknown as { connections: Map<string, unknown> }).connections.set('guest-1', conn);

    await (peer as unknown as { handleHostMessage(raw: string): Promise<void> }).handleHostMessage(
      JSON.stringify({ type: 'peer-left', peerId: 'guest-1' }),
    );

    expect(close).not.toHaveBeenCalled();
  });

  it('closes the data channel when signaling peer-left matches a failed transport', async () => {
    const peer = createPeer();
    const close = vi.fn();
    const conn = {
      open: true,
      close,
      peerConnection: { connectionState: 'failed' },
    };

    (peer as unknown as { connections: Map<string, unknown> }).connections.set('guest-1', conn);

    await (peer as unknown as { handleHostMessage(raw: string): Promise<void> }).handleHostMessage(
      JSON.stringify({ type: 'peer-left', peerId: 'guest-1' }),
    );

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reopens a guest signaling socket after the old socket closes while data channel survives', () => {
    installFakeWebSocket();
    const peer = createPeer();

    const conn = peer.connect('123456');
    const firstSocket = FakeWebSocket.instances[0];
    (conn as TransportDataConnection).peerConnection = {
      connectionState: 'connected',
    } as unknown as RTCPeerConnection;

    firstSocket.close();
    expect(privateMaps(peer).roomSockets.has('123456')).toBe(false);
    expect(privateMaps(peer).connections.has('123456')).toBe(true);

    peer.reconnect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(privateMaps(peer).roomSockets.get('123456')).toBe(FakeWebSocket.instances[1]);

    conn.close();
    expect(privateMaps(peer).connections.has('123456')).toBe(false);
  });

  it('closes and forgets the guest signaling socket when the data connection closes', () => {
    installFakeWebSocket();
    const peer = createPeer();

    const conn = peer.connect('123456');
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');

    conn.close();

    expect(socket.closeCount).toBe(1);
    expect(privateMaps(peer).roomSockets.has('123456')).toBe(false);
    expect(privateMaps(peer).connections.has('123456')).toBe(false);

    peer.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not close an open data channel just because RTCPeerConnection stays disconnected', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const peer = createPeer();
    const conn = peer.connect('123456');
    const onClose = vi.fn();
    conn.on('close', onClose);

    const pc = new EventTarget() as RTCPeerConnection & {
      connectionState: RTCPeerConnectionState;
      close: () => void;
    };
    Object.defineProperty(pc, 'connectionState', {
      configurable: true,
      writable: true,
      value: 'connected',
    });
    pc.close = vi.fn();

    const channel = new EventTarget() as RTCDataChannel & {
      binaryType: BinaryType;
      readyState: RTCDataChannelState;
      send: (data: string | ArrayBuffer) => void;
      close: () => void;
    };
    Object.defineProperty(channel, 'readyState', {
      configurable: true,
      writable: true,
      value: 'open',
    });
    channel.send = vi.fn();
    channel.close = vi.fn();

    (conn as unknown as { attach(pc: RTCPeerConnection, channel: RTCDataChannel): void }).attach(
      pc,
      channel,
    );

    pc.connectionState = 'disconnected';
    pc.dispatchEvent(new Event('connectionstatechange'));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(onClose).not.toHaveBeenCalled();
    expect(conn.open).toBe(true);

    channel.readyState = 'closed';
    pc.dispatchEvent(new Event('connectionstatechange'));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(conn.open).toBe(false);
  });
});
