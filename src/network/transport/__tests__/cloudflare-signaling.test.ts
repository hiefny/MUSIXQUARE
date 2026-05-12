/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { CloudflareSignalingPeer } from '../cloudflare-signaling.ts';
import type { TransportDataConnection } from '../types.ts';

const originalWebSocket = globalThis.WebSocket;

type FakeSocketListener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  closeCount = 0;
  sent: string[] = [];
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

function createGuestPeer(): CloudflareSignalingPeer {
  return new CloudflareSignalingPeer(null, {
    provider: 'cloudflare',
    signalingUrl: 'wss://signal.example.test/api/rooms',
    config: { iceServers: [] },
  });
}

function createHostPeer(): CloudflareSignalingPeer {
  return new CloudflareSignalingPeer('123456', {
    provider: 'cloudflare',
    signalingUrl: 'wss://signal.example.test/api/rooms',
    config: { iceServers: [] },
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
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: originalWebSocket,
  });
});

describe('Cloudflare signaling/data-channel boundary', () => {
  it('keeps a live guest data channel when only the signaling socket errors', () => {
    installFakeWebSocket();
    const peer = createGuestPeer();
    const conn = peer.connect('123456');
    const socket = FakeWebSocket.instances[0];
    const onError = vi.fn();
    const onDisconnected = vi.fn();
    conn.on('error', onError);
    peer.on('disconnected', onDisconnected);

    conn.open = true;
    conn.peerConnection = { connectionState: 'connected' } as RTCPeerConnection;

    socket.dispatch('error');

    expect(onError).not.toHaveBeenCalled();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(conn.open).toBe(true);
    expect(privateMaps(peer).roomSockets.has('123456')).toBe(false);
    expect(privateMaps(peer).connections.has('123456')).toBe(true);
  });

  it('surfaces guest signaling socket errors before a data channel exists', () => {
    installFakeWebSocket();
    const peer = createGuestPeer();
    const conn = peer.connect('123456');
    const socket = FakeWebSocket.instances[0];
    const onError = vi.fn();
    conn.on('error', onError);

    socket.dispatch('error');

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('treats host signaling socket errors after open as signaling loss only', async () => {
    installFakeWebSocket();
    const peer = createHostPeer();
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    const onError = vi.fn();
    const onDisconnected = vi.fn();
    peer.on('error', onError);
    peer.on('disconnected', onDisconnected);

    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await Promise.resolve();
    socket.dispatch('error');

    expect(onError).not.toHaveBeenCalled();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(peer.disconnected).toBe(true);
  });

  it('does not close a live data channel when signaling reports peer-left', async () => {
    const peer = createGuestPeer();
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
});
