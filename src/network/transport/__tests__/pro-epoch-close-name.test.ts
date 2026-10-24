/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../core/log.ts';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { __cloudflareSignalingForTests, CloudflareSignalingPeer } from '../cloudflare-signaling.ts';
import type { TransportDataConnection } from '../types.ts';

/**
 * Characterization of the PRO epoch close-name mismatch, as found before
 * Phase 4. When a PRO room's epoch advances, the signaling Worker closes every
 * PRO socket with 1012 PRO_ROOM_EPOCH_ADVANCED (renamed 2026-07-20; its own
 * tests pin that close). The client's two close handlers still compare the
 * old name PRO_COORDINATOR_EPOCH_ADVANCED, so the Worker's real close takes
 * the ordinary signaling-loss path: no 'pro-epoch-advanced', the RTC facades
 * stay open and 'disconnected' starts peer.ts's ticketed reconnect. Only the
 * diagnostic allow-list knows the new name. The PRO runtime is out of scope;
 * change these expectations only together with a decision on the fix.
 */
const CURRENT_NAME = 'PRO_ROOM_EPOCH_ADVANCED';
const LEGACY_NAME = 'PRO_COORDINATOR_EPOCH_ADVANCED';
const SIGNALING_URL = 'wss://signal.example.test/api/rooms';
const ROOM = '000001';

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
  private readonly listeners = new Map<string, Set<ChannelListener>>();
  constructor(readonly label: string) {}
  addEventListener(event: string, listener: ChannelListener): void {
    const listeners = this.listeners.get(event) ?? new Set<ChannelListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  send(): void {}
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    for (const listener of this.listeners.get('close') ?? []) listener({});
  }
}

type RTCListener = (event: unknown) => void;

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'connected';
  signalingState: RTCSignalingState = 'stable';
  localDescription: { type: RTCSdpType; sdp: string; toJSON(): RTCSessionDescriptionInit } | null =
    null;
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
    return new FakeDataChannel(label);
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer' };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const type = description.type ?? 'offer';
    const sdp = description.sdp ?? '';
    this.localDescription = { type, sdp, toJSON: () => ({ type, sdp }) };
  }
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  getSenders(): RTCRtpSender[] {
    return [];
  }
  close(): void {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed';
    this.dispatch('connectionstatechange', {});
  }
  dispatch(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function proTicket(participantId: string, role: 'coordinator' | 'member'): string {
  const payload = btoa(
    JSON.stringify({
      v: 1,
      kind: 'pro-signaling',
      roomCode: ROOM,
      participantId,
      role,
      coordinatorEpoch: 7,
      presenceIncarnationId: 'presence-incarnation-0001',
      ticketSequence: 1,
      jti: `${role}-epoch-close-ticket`,
      iat: 1,
      exp: 2,
    }),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${payload}.${'s'.repeat(43)}`;
}

function proPeer(role: 'coordinator' | 'member'): CloudflareSignalingPeer {
  return new CloudflareSignalingPeer(role === 'coordinator' ? ROOM : null, {
    provider: 'cloudflare',
    signalingUrl: SIGNALING_URL,
    config: { iceServers: [] },
    proSignaling: {
      roomCode: ROOM,
      ticket: proTicket(`${role}-device`, role),
      role,
      coordinatorEpoch: 7,
      presenceIncarnationId: 'presence-incarnation-0001',
      ticketSequence: 1,
    },
  });
}

/** A coordinator with one live member data connection, reached publicly. */
async function coordinatorWithMember() {
  const peer = proPeer('coordinator');
  const connections: TransportDataConnection[] = [];
  peer.on('connection', (conn) => connections.push(conn));
  await Promise.resolve();
  const socket = FakeWebSocket.instances[0]!;
  socket.dispatch('open');
  socket.dispatch('message', JSON.stringify({ type: 'peer-open', peerId: ROOM, roomId: ROOM }));
  await vi.waitFor(() => expect(peer.open).toBe(true));
  socket.dispatch(
    'message',
    JSON.stringify({
      type: 'signal-offer',
      from: 'member-device',
      negotiationId: 'negotiation_test_000001',
      sdp: { type: 'offer', sdp: 'member-data-offer' },
    }),
  );
  await vi.waitFor(() => expect(FakeRTCPeerConnection.instances).toHaveLength(1));
  const pc = FakeRTCPeerConnection.instances[0]!;
  await vi.waitFor(() =>
    expect(
      socket.sent.some((raw) => (JSON.parse(raw) as { type: string }).type === 'signal-answer'),
    ).toBe(true),
  );
  pc.dispatch('datachannel', { channel: new FakeDataChannel('musixquare-data') });
  pc.dispatch('datachannel', { channel: new FakeDataChannel('musixquare-control') });
  await vi.waitFor(() => expect(connections[0]?.open).toBe(true));
  return { peer, socket, conn: connections[0]! };
}

/** A member whose data connection to the coordinator is open. */
async function memberWithCoordinator() {
  const peer = proPeer('member');
  const conn = peer.connect(ROOM);
  await Promise.resolve();
  const socket = FakeWebSocket.instances[0]!;
  socket.dispatch('open');
  socket.dispatch('message', JSON.stringify({ type: 'peer-open', peerId: peer.id, roomId: ROOM }));
  await vi.waitFor(() => expect(FakeRTCPeerConnection.instances).toHaveLength(1));
  await vi.waitFor(() => expect(conn.open).toBe(true));
  return { peer, socket, conn };
}

beforeEach(() => {
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
});

afterEach(() => {
  clearAllManagedTimers();
  __cloudflareSignalingForTests.resetPageSignalingSocketHandles();
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    value: originalRTCPeerConnection,
  });
});

describe('PRO epoch close name', () => {
  it('uses the current name only in the Worker and the old name only in the client handlers', () => {
    const worker = readFileSync('cloudflare/signaling-worker.ts', 'utf8');
    const client = readFileSync('src/network/transport/cloudflare-signaling.ts', 'utf8');
    // The Worker's epoch reset is the only sender of either name.
    expect(worker.match(/closeSocket\(socket, 1012, 'PRO_ROOM_EPOCH_ADVANCED'\)/gu)).toHaveLength(
      1,
    );
    expect(worker).not.toContain(LEGACY_NAME);
    // The host-socket and guest-socket close handlers compare the old name.
    expect(
      client.match(/\(event as CloseEvent\)\.reason === 'PRO_COORDINATOR_EPOCH_ADVANCED'/gu),
    ).toHaveLength(2);
    expect(client.match(/'PRO_ROOM_EPOCH_ADVANCED'/gu)).toHaveLength(1);
    expect(client).toMatch(
      /const RECOGNIZED_SIGNALING_CLOSE_REASONS = \[[^\]]*'PRO_ROOM_EPOCH_ADVANCED'/u,
    );
  });

  it.each([
    { role: 'coordinator', setup: coordinatorWithMember },
    { role: 'member', setup: memberWithCoordinator },
  ] as const)(
    "treats the Worker's real epoch close as ordinary signaling loss on a $role socket",
    async ({ role, setup }) => {
      const { peer, socket, conn } = await setup();
      const advanced = vi.fn();
      const disconnected = vi.fn();
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      peer.on('pro-epoch-advanced', advanced);
      peer.on('disconnected', disconnected);

      socket.dispatch('close', undefined, CURRENT_NAME, 1012, true);

      expect(advanced).not.toHaveBeenCalled();
      expect(disconnected).toHaveBeenCalledOnce();
      expect(peer.disconnected).toBe(true);
      expect(conn.open).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        role === 'coordinator'
          ? '[Transport] Admitted host signaling socket closed; RTC channels retain their own lifecycle'
          : '[Transport] Established guest signaling socket closed; RTC channels retain their own lifecycle',
        expect.objectContaining({ closeCode: 1012, closeReason: CURRENT_NAME }),
      );
      // The reconnect owner can open a fresh socket for the same peer.
      peer.reconnect();
      expect(FakeWebSocket.instances).toHaveLength(2);
      peer.destroy();
    },
  );

  it.each([
    { role: 'coordinator', setup: coordinatorWithMember },
    { role: 'member', setup: memberWithCoordinator },
  ] as const)(
    'rebuilds only for the old name, which no Worker sends, on a $role socket',
    async ({ setup }) => {
      const { peer, socket, conn } = await setup();
      const advanced = vi.fn();
      const disconnected = vi.fn();
      peer.on('pro-epoch-advanced', advanced);
      peer.on('disconnected', disconnected);

      socket.dispatch('close', undefined, LEGACY_NAME, 1012, true);

      expect(advanced).toHaveBeenCalledOnce();
      expect(disconnected).not.toHaveBeenCalled();
      expect(conn.open).toBe(false);
      peer.destroy();
    },
  );
});
