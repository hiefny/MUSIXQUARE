/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../../core/constants.ts';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { CloudflareDataConnection, CloudflareSignalingPeer } from '../cloudflare-signaling.ts';
import type { TransportDataConnection, TransportMediaConnection } from '../types.ts';

const originalWebSocket = globalThis.WebSocket;
const originalRTCPeerConnection = globalThis.RTCPeerConnection;
const originalMediaStream = globalThis.MediaStream;

type FakeSocketListener = (event: { data?: unknown }) => void;
type FakeChannelListener = (event: { data?: unknown }) => void;

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

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  binaryType: BinaryType = 'blob';
  sent: unknown[] = [];
  private listeners = new Map<string, Set<FakeChannelListener>>();

  constructor(readonly label: string) {}

  addEventListener(event: string, listener: FakeChannelListener): void {
    const listeners = this.listeners.get(event) ?? new Set<FakeChannelListener>();
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
      listener({ data });
    }
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'connected';
  private listeners = new Map<string, Set<FakeChannelListener>>();

  addEventListener(event: string, listener: FakeChannelListener): void {
    const listeners = this.listeners.get(event) ?? new Set<FakeChannelListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  close(): void {
    this.connectionState = 'closed';
    this.dispatch('connectionstatechange');
  }

  dispatch(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener({});
    }
  }
}

type FakeRTCListener = (event: unknown) => void;

interface FakeLocalDescription {
  type: RTCSdpType;
  sdp: string;
  toJSON(): RTCSessionDescriptionInit;
}

/**
 * Globally installable RTCPeerConnection fake (jsdom ships none). Unlike
 * FakePeerConnection above, dispatch FORWARDS the payload so icecandidate
 * listeners receive an event object. createDataChannel returns
 * FakeDataChannels whose default 'open' readyState marks the conn open via
 * attach()'s queueMicrotask — flush microtasks before asserting open state.
 */
class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];

  connectionState: RTCPeerConnectionState = 'connected';
  signalingState: RTCSignalingState = 'stable';
  localDescription: FakeLocalDescription | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly channels: FakeDataChannel[] = [];
  private listeners = new Map<string, Set<FakeRTCListener>>();

  constructor() {
    FakeRTCPeerConnection.instances.push(this);
  }

  addEventListener(event: string, listener: FakeRTCListener): void {
    const listeners = this.listeners.get(event) ?? new Set<FakeRTCListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, listener: FakeRTCListener): void {
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
    const type = description.type ?? 'offer';
    const sdp = description.sdp ?? '';
    this.localDescription = { type, sdp, toJSON: () => ({ type, sdp }) };
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  async addIceCandidate(): Promise<void> {
    /* noop */
  }

  getSenders(): RTCRtpSender[] {
    return [];
  }

  close(): void {
    this.connectionState = 'closed';
    this.dispatch('connectionstatechange', {});
  }

  dispatch(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
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

/** jsdom ships no MediaStream; CloudflareMediaConnection news one up. */
class FakeMediaStream {
  private readonly tracks: MediaStreamTrack[] = [];

  getTracks(): MediaStreamTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return [...this.tracks];
  }

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
  }
}

function installFakeRTCPeerConnection(): void {
  FakeRTCPeerConnection.instances = [];
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    value: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
  });
  Object.defineProperty(globalThis, 'MediaStream', {
    configurable: true,
    value: FakeMediaStream as unknown as typeof MediaStream,
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
  guestRooms: Map<string, { conn: TransportDataConnection; authFailed: boolean }>;
  pendingCandidates: Map<string, { candidates: RTCIceCandidateInit[]; bytes: number }>;
  pendingCandidateBytes: number;
} {
  return peer as unknown as {
    connections: Map<string, TransportDataConnection>;
    roomSockets: Map<string, FakeWebSocket>;
    guestRooms: Map<string, { conn: TransportDataConnection; authFailed: boolean }>;
    pendingCandidates: Map<string, { candidates: RTCIceCandidateInit[]; bytes: number }>;
    pendingCandidateBytes: number;
  };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function sentOfType(socket: FakeWebSocket, type: string): Array<Record<string, unknown>> {
  return socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === type);
}

/**
 * Drives a guest through the full join handshake with the global fakes
 * installed: connect -> socket open -> DO peer-open -> offer flow -> data
 * channel open (FakeDataChannel defaults to readyState 'open').
 */
async function establishGuest(roomPassword = ''): Promise<{
  peer: CloudflareSignalingPeer;
  conn: TransportDataConnection;
  socket: FakeWebSocket;
  pc: FakeRTCPeerConnection;
}> {
  installFakeWebSocket();
  installFakeRTCPeerConnection();
  const peer = createGuestPeer();
  const conn = peer.connect('123456', roomPassword ? { roomPassword } : undefined);
  const socket = FakeWebSocket.instances[0];
  socket.dispatch('open');
  socket.dispatch(
    'message',
    JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '123456' }),
  );
  await flushAsync();
  return { peer, conn, socket, pc: FakeRTCPeerConnection.instances[0] };
}

afterEach(() => {
  clearAllManagedTimers();
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: originalWebSocket,
  });
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    value: originalRTCPeerConnection,
  });
  Object.defineProperty(globalThis, 'MediaStream', {
    configurable: true,
    value: originalMediaStream,
  });
});

describe('Cloudflare signaling/data-channel boundary', () => {
  it('routes control frames away from the bulk chunk channel', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');

    expect(conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel)).toBe(
      true,
    );
    expect(
      conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel),
    ).toBe(false);

    await new Promise<void>((resolve) => queueMicrotask(resolve));

    conn.send({ type: MSG.PLAY, time: 0, index: 1 });
    conn.send({
      type: MSG.FILE_CHUNK,
      chunk: new Uint8Array([1, 2, 3]),
      index: 0,
      sessionId: 1,
      total: 1,
      name: 'track.mp3',
    });

    expect(control.sent).toHaveLength(1);
    expect(bulk.sent).toHaveLength(1);
    expect(typeof control.sent[0]).toBe('string');
    expect(bulk.sent[0]).toBeInstanceOf(ArrayBuffer);
  });

  it('falls back to the bulk channel for control frames until control is open', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');

    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    conn.send({ type: MSG.PAUSE, time: 12, reason: 'pause' });

    expect(bulk.sent).toHaveLength(1);
    expect(typeof bulk.sent[0]).toBe('string');
  });

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
    const maps = privateMaps(peer);
    maps.connections.set('guest-1', conn as unknown as TransportDataConnection);
    maps.pendingCandidates.set('guest-1', {
      candidates: [{ candidate: 'queued-before-departure' }],
      bytes: 32,
    });
    maps.pendingCandidateBytes = 32;

    await (peer as unknown as { handleHostMessage(raw: string): Promise<void> }).handleHostMessage(
      JSON.stringify({ type: 'peer-left', peerId: 'guest-1' }),
    );

    expect(close).not.toHaveBeenCalled();
    expect(maps.pendingCandidates.has('guest-1')).toBe(false);
    expect(maps.pendingCandidateBytes).toBe(0);
  });

  it('caps pre-offer ICE candidates by count and bytes per peer', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const peer = createHostPeer();
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );

    for (let index = 0; index < 100; index += 1) {
      socket.dispatch(
        'message',
        JSON.stringify({
          type: 'signal-candidate',
          from: 'guest-1',
          candidate: { candidate: `candidate-${index}` },
        }),
      );
    }
    await flushAsync();

    const queued = privateMaps(peer).pendingCandidates.get('guest-1');
    expect(queued?.candidates).toHaveLength(64);
    expect(queued?.bytes).toBeLessThanOrEqual(64 * 1024);

    // A second peer has an independent bounded queue.
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-candidate',
        from: 'guest-2',
        candidate: { candidate: 'other-peer' },
      }),
    );
    await flushAsync();
    expect(privateMaps(peer).pendingCandidates.get('guest-2')?.candidates).toHaveLength(1);
  });

  it('caps pending ICE peer identities and total bytes against peerId rotation', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const peer = createHostPeer();
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );

    for (let index = 0; index < 96; index += 1) {
      socket.dispatch(
        'message',
        JSON.stringify({
          type: 'signal-candidate',
          from: `rotating-${index}`,
          candidate: { candidate: `candidate-${index}` },
        }),
      );
    }
    await flushAsync();

    const maps = privateMaps(peer);
    expect(maps.pendingCandidates.size).toBe(32);
    expect(maps.pendingCandidates.has('rotating-31')).toBe(true);
    expect(maps.pendingCandidates.has('rotating-32')).toBe(false);
    expect(maps.pendingCandidateBytes).toBe(
      [...maps.pendingCandidates.values()].reduce((sum, queued) => sum + queued.bytes, 0),
    );
    expect(maps.pendingCandidateBytes).toBeLessThanOrEqual(32 * 64 * 1024);
  });

  it('clears pending ICE whenever the current signaling socket closes', async () => {
    installFakeWebSocket();
    const peer = createHostPeer();
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    const maps = privateMaps(peer);
    maps.pendingCandidates.set('guest-1', {
      candidates: [{ candidate: 'queued' }],
      bytes: 24,
    });
    maps.pendingCandidateBytes = 24;

    socket.close();

    expect(maps.pendingCandidates.size).toBe(0);
    expect(maps.pendingCandidateBytes).toBe(0);
  });
});

describe('Cloudflare guest signaling reconnect', () => {
  it('reopens the guest socket on reconnect() and re-auths without re-offering', async () => {
    const { peer, conn, socket } = await establishGuest('12345678');
    const onDisconnected = vi.fn();
    peer.on('disconnected', onDisconnected);
    const initialReconnectSecret = new URL(socket.url).searchParams.get('secret');

    expect(conn.open).toBe(true);
    expect(sentOfType(socket, 'signal-offer')).toHaveLength(1);
    expect(initialReconnectSecret).toMatch(/^[A-Za-z0-9_-]{32}$/);

    socket.close();

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(privateMaps(peer).roomSockets.has('123456')).toBe(false);
    // The durable registry must survive the blip — it is the reopen source.
    expect(privateMaps(peer).guestRooms.has('123456')).toBe(true);

    peer.reconnect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    const reopened = FakeWebSocket.instances[1];
    expect(reopened.url).toContain('role=guest');
    expect(new URL(reopened.url).searchParams.get('secret')).toBe(initialReconnectSecret);
    reopened.dispatch('open');
    expect(sentOfType(reopened, 'guest-auth')[0]?.password).toBe('12345678');
    expect(reopened.sent.join('\n')).not.toContain(initialReconnectSecret);

    reopened.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '123456' }),
    );
    await flushAsync();

    expect(peer.disconnected).toBe(false);
    expect(conn.open).toBe(true);
    // startGuestOffer's peerConnection early-return keeps the live data
    // channel untouched: exactly one offer total, none on the reopened socket.
    expect(sentOfType(reopened, 'signal-offer')).toHaveLength(0);
    expect(sentOfType(socket, 'signal-offer')).toHaveLength(1);
  });

  it('does not stack a second socket while a reconnect attempt is still connecting', async () => {
    const { peer, socket } = await establishGuest();

    socket.close();
    peer.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].readyState).toBe(FakeWebSocket.CONNECTING);

    peer.reconnect();

    // Stacking would make the DO close the older socket (GUEST_REPLACED),
    // re-emitting 'disconnected' -> peer.ts budget reset -> oscillation.
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('skips unestablished sessions on reconnect()', () => {
    installFakeWebSocket();
    const peer = createGuestPeer();
    peer.connect('123456');
    const socket = FakeWebSocket.instances[0];
    const onDisconnected = vi.fn();
    peer.on('disconnected', onDisconnected);

    socket.close();
    peer.reconnect();

    // Mid-handshake sessions belong to the join-timeout path, not reconnect.
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('drops a room from the reconnect registry when its data connection closes', async () => {
    const { peer, conn, socket } = await establishGuest();

    conn.close();

    expect(privateMaps(peer).guestRooms.has('123456')).toBe(false);
    expect(privateMaps(peer).connections.has('123456')).toBe(false);

    socket.close();
    peer.reconnect();

    // Dead sessions are owned by the explicit re-join path.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('treats DO rejection frames on an established session as signaling loss only', async () => {
    const { peer, conn, socket } = await establishGuest();
    const onError = vi.fn();
    const onDisconnected = vi.fn();
    conn.on('error', onError);
    peer.on('disconnected', onDisconnected);

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'error',
        errorType: 'peer-unavailable',
        message: 'HOST_NOT_AVAILABLE',
      }),
    );
    await flushAsync();

    // The rejection must not tear down the live data channel...
    expect(onError).not.toHaveBeenCalled();
    expect(conn.open).toBe(true);
    // ...but the socket close still surfaces as signaling loss so the
    // peer.ts backoff keeps driving retries (host-parity churn).
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(onDisconnected).toHaveBeenCalledTimes(1);

    peer.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('surfaces DO error frames before a data channel is established', async () => {
    installFakeWebSocket();
    const peer = createGuestPeer();
    const conn = peer.connect('123456');
    const socket = FakeWebSocket.instances[0];
    const onError = vi.fn();
    conn.on('error', onError);

    socket.dispatch('open');
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'error',
        errorType: 'room-password-required',
        message: 'ROOM_PASSWORD_REQUIRED',
      }),
    );
    await flushAsync();

    // Pinned UX: pre-establishment rejections drive the password dialog /
    // join failure and must keep reaching the connection error handler.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'room-password-required' }),
    );
  });

  it('stops reconnecting after a password rejection until an explicit re-join', async () => {
    const { peer, socket } = await establishGuest('12345678');

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'error',
        errorType: 'room-password-invalid',
        message: 'ROOM_PASSWORD_INVALID',
      }),
    );
    await flushAsync();

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    peer.reconnect();
    // Stored password is stale (rotation); retrying would hammer the DO
    // forever because peer.ts resets its budget on every 'disconnected'.
    expect(FakeWebSocket.instances).toHaveLength(1);

    // An explicit re-join with a fresh password re-arms the room.
    peer.connect('123456', { roomPassword: '87654321' });
    expect(FakeWebSocket.instances).toHaveLength(2);
    const rejoined = FakeWebSocket.instances[1];
    rejoined.dispatch('open');
    expect(sentOfType(rejoined, 'guest-auth')[0]?.password).toBe('87654321');
  });

  it('sends ICE candidates over the current socket after a reopen', async () => {
    const { peer, socket, pc } = await establishGuest();
    const onPeerError = vi.fn();
    peer.on('error', onPeerError);

    socket.close();

    // During the outage the send-time resolver finds no socket and throws
    // the same transport error type the captured-socket path produced.
    pc.dispatch('icecandidate', {
      candidate: { toJSON: () => ({ candidate: 'cand-during-outage' }) },
    });
    expect(onPeerError).toHaveBeenCalledTimes(1);
    expect(onPeerError).toHaveBeenCalledWith(expect.objectContaining({ type: 'socket-closed' }));

    peer.reconnect();
    const reopened = FakeWebSocket.instances[1];
    reopened.dispatch('open');

    pc.dispatch('icecandidate', {
      candidate: { toJSON: () => ({ candidate: 'cand-after-reopen' }) },
    });

    const candidates = sentOfType(reopened, 'signal-candidate');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.to).toBe('host');
    expect(candidates[0]?.candidate).toEqual({ candidate: 'cand-after-reopen' });
    expect(sentOfType(socket, 'signal-candidate')).toHaveLength(0);
  });

  it('answers a pre-blip media offer over the reopened socket', async () => {
    const { peer, socket } = await establishGuest();
    const onCall = vi.fn();
    peer.on('call', onCall);

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'media-offer',
        from: 'host',
        callId: 'call-1',
        sdp: { type: 'offer', sdp: 'host-media-offer' },
        audioTrackCount: 1,
      }),
    );
    await flushAsync();
    expect(onCall).toHaveBeenCalledTimes(1);
    const mediaConn = onCall.mock.calls[0]?.[0] as TransportMediaConnection;

    socket.close();
    peer.reconnect();
    const reopened = FakeWebSocket.instances[1];
    reopened.dispatch('open');

    mediaConn.answer();
    await flushAsync();

    const answers = sentOfType(reopened, 'media-answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]?.callId).toBe('call-1');
    expect(sentOfType(socket, 'media-answer')).toHaveLength(0);
  });

  it('sends host ICE candidates over the recreated host socket', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const peer = createHostPeer();
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-offer',
        from: 'guest-1',
        sdp: { type: 'offer', sdp: 'guest-offer' },
      }),
    );
    await flushAsync();
    expect(sentOfType(socket, 'signal-answer')).toHaveLength(1);
    const pc = FakeRTCPeerConnection.instances[0];

    socket.close();
    expect(peer.disconnected).toBe(true);
    peer.reconnect();
    const reopened = FakeWebSocket.instances[1];
    reopened.dispatch('open');

    pc.dispatch('icecandidate', {
      candidate: { toJSON: () => ({ candidate: 'host-cand' }) },
    });

    const candidates = sentOfType(reopened, 'signal-candidate');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.to).toBe('guest-1');
    expect(sentOfType(socket, 'signal-candidate')).toHaveLength(0);
  });

  it('destroy() clears the guest reconnect registry', () => {
    installFakeWebSocket();
    const peer = createGuestPeer();
    peer.connect('123456', { roomPassword: '12345678' });
    expect(privateMaps(peer).guestRooms.size).toBe(1);

    peer.destroy();

    expect(privateMaps(peer).guestRooms.size).toBe(0);
    expect(privateMaps(peer).roomSockets.size).toBe(0);
    expect(privateMaps(peer).connections.size).toBe(0);
  });
});
