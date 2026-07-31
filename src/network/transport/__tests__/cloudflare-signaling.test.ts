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

type FakeSocketListener = (event: { data?: unknown; reason?: string }) => void;
type FakeChannelListener = (event: { data?: unknown; error?: unknown }) => void;

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

  dispatch(event: string, data?: unknown, reason?: string): void {
    if (event === 'open') this.readyState = FakeWebSocket.OPEN;
    if (event === 'close') this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ data, reason });
    }
  }
}

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  binaryType: BinaryType = 'blob';
  sent: unknown[] = [];
  emitErrorOnClose = false;
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
    if (this.emitErrorOnClose) {
      this.dispatch('error', new DOMException('User-Initiated Abort, reason=Close called'));
    }
    this.readyState = 'closed';
    this.dispatch('close');
  }

  dispatch(event: string, data?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(event === 'error' ? { error: data } : { data });
    }
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'connected';
  closeCount = 0;
  private listeners = new Map<string, Set<FakeChannelListener>>();

  addEventListener(event: string, listener: FakeChannelListener): void {
    const listeners = this.listeners.get(event) ?? new Set<FakeChannelListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  close(): void {
    if (this.connectionState === 'closed') return;
    this.closeCount++;
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
  readonly addedCandidates: RTCIceCandidateInit[] = [];
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

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
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

class ContractWorkerSocket {
  closed = false;
  sent: string[] = [];
  private attachment: unknown = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

class ContractWorkerState {
  readonly sockets: ContractWorkerSocket[] = [];
  readonly values = new Map<string, unknown>();
  readonly storage = {
    get: async (key: string): Promise<unknown> => structuredClone(this.values.get(key)),
    put: async (key: string, value: unknown): Promise<void> => {
      this.values.set(key, structuredClone(value));
    },
    getAlarm: async (): Promise<null> => null,
    setAlarm: async (): Promise<void> => {},
    deleteAlarm: async (): Promise<void> => {},
  };

  acceptWebSocket(socket: ContractWorkerSocket): void {
    this.sockets.push(socket);
  }

  getWebSockets(): ContractWorkerSocket[] {
    return this.sockets.filter((socket) => !socket.closed);
  }
}

type ContractWorkerRoom = {
  acceptHost(
    socket: ContractWorkerSocket,
    roomId: string,
    peerId: string,
    secret: string,
  ): Promise<void>;
  acceptPendingHost(socket: ContractWorkerSocket, roomId: string, peerId: string): void;
  acceptGuest(socket: ContractWorkerSocket, roomId: string, peerId: string): Promise<void>;
  webSocketMessage(socket: ContractWorkerSocket, raw: string): Promise<void>;
};

async function createContractWorkerRoom(): Promise<ContractWorkerRoom> {
  const workerModule = (await import('../../../../cloudflare/signaling-worker.js')) as unknown as {
    MusixquareRoom: new (state: ContractWorkerState) => ContractWorkerRoom;
  };
  return new workerModule.MusixquareRoom(new ContractWorkerState());
}

function workerSentOfType(
  socket: ContractWorkerSocket,
  type: string,
): Array<Record<string, unknown>> {
  return socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === type);
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

function clientProTicket(
  participantId: string,
  overrides: Partial<{
    roomCode: string;
    role: 'coordinator' | 'member';
    coordinatorEpoch: number;
    presenceIncarnationId: string;
    ticketSequence: number;
    jti: string;
  }> = {},
): string {
  const payload = btoa(
    JSON.stringify({
      v: 1,
      kind: 'pro-signaling',
      roomCode: overrides.roomCode ?? '000001',
      participantId,
      role: overrides.role ?? 'member',
      coordinatorEpoch: overrides.coordinatorEpoch ?? 7,
      presenceIncarnationId: overrides.presenceIncarnationId ?? 'presence-incarnation-0001',
      ticketSequence: overrides.ticketSequence ?? 1,
      jti: overrides.jti ?? 'client-ticket-identifier',
      iat: 1,
      exp: 2,
    }),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${payload}.test-signature`;
}

function privateMaps(peer: CloudflareSignalingPeer): {
  connections: Map<string, TransportDataConnection>;
  roomSockets: Map<string, FakeWebSocket>;
  guestRooms: Map<string, { conn: TransportDataConnection; authFailed: boolean }>;
  guestReconnectSecrets: Map<string, string>;
} {
  return peer as unknown as {
    connections: Map<string, TransportDataConnection>;
    roomSockets: Map<string, FakeWebSocket>;
    guestRooms: Map<string, { conn: TransportDataConnection; authFailed: boolean }>;
    guestReconnectSecrets: Map<string, string>;
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
  await flushAsync();
  socket.dispatch(
    'message',
    JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '123456' }),
  );
  await flushAsync();
  return { peer, conn, socket, pc: FakeRTCPeerConnection.instances[0] };
}

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
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

describe('standard-room account identity refresh', () => {
  it('authenticates a host immediately and attaches account identity after peer-open', async () => {
    installFakeWebSocket();
    let resolveAssertions:
      | ((value: { accountAssertion: string; deletionAssertion: null }) => void)
      | undefined;
    const assertionProvider = vi.fn(
      () =>
        new Promise<{ accountAssertion: string; deletionAssertion: null }>((resolve) => {
          resolveAssertions = resolve;
        }),
    );
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];

    socket.dispatch('open');

    expect(sentOfType(socket, 'host-auth')).toEqual([
      {
        type: 'host-auth',
        secret: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      },
    ]);
    expect(assertionProvider).not.toHaveBeenCalled();

    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(assertionProvider).toHaveBeenCalledWith({
      roomCode: '123456',
      peerId: '123456',
      role: 'host',
    });
    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([]);

    resolveAssertions?.({ accountAssertion: 'signed-assertion', deletionAssertion: null });
    await flushAsync();

    expect(sentOfType(socket, 'account-identity-refresh')).toContainEqual({
      type: 'account-identity-refresh',
      accountAssertion: 'signed-assertion',
    });
    peer.destroy();
  });

  it('drops a late host account assertion after the peer is destroyed', async () => {
    installFakeWebSocket();
    let resolveAssertions:
      | ((value: { accountAssertion: string; deletionAssertion: null }) => void)
      | undefined;
    const assertionProvider = vi.fn(
      () =>
        new Promise<{ accountAssertion: string; deletionAssertion: null }>((resolve) => {
          resolveAssertions = resolve;
        }),
    );
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(assertionProvider).toHaveBeenCalledOnce();

    peer.destroy();
    resolveAssertions?.({ accountAssertion: 'stale-signed-assertion', deletionAssertion: null });
    await flushAsync();

    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([]);
  });

  it('never sends account deletion without a deletion-audience proof', async () => {
    installFakeWebSocket();
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
    });
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    await flushAsync();
    socket.sent.length = 0;

    peer.deleteStandardRoomIdentity();
    await flushAsync();

    expect(sentOfType(socket, 'account-identity-delete')).toEqual([]);
    expect(sentOfType(socket, 'account-identity-clear')).toEqual([
      { type: 'account-identity-clear' },
    ]);
    peer.destroy();
  });

  it('fetches a deletion-only proof after account deletion commits and sends it afterwards', async () => {
    installFakeWebSocket();
    const assertionProvider = vi
      .fn()
      .mockResolvedValueOnce({
        accountAssertion: 'signed-attach-proof',
        deletionAssertion: null,
      })
      .mockResolvedValueOnce({
        accountAssertion: null,
        deletionAssertion: 'signed-deletion-proof',
      });
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    await flushAsync();
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    socket.sent.length = 0;

    peer.deleteStandardRoomIdentity();
    await flushAsync();

    expect(assertionProvider).toHaveBeenLastCalledWith({
      roomCode: '123456',
      peerId: '123456',
      role: 'host',
    });
    expect(sentOfType(socket, 'account-identity-delete')).toEqual([
      {
        type: 'account-identity-delete',
        deletionAssertion: 'signed-deletion-proof',
      },
    ]);
    peer.destroy();
  });

  it('sends a tombstoned browser deletion proof only after anonymous reconnect is admitted', async () => {
    installFakeWebSocket();
    const assertionProvider = vi.fn(async () => ({
      accountAssertion: null,
      deletionAssertion: 'cross-device-deletion-proof',
    }));
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    await flushAsync();

    expect(sentOfType(socket, 'host-auth')[0]).not.toHaveProperty('accountAssertion');
    expect(sentOfType(socket, 'account-identity-delete')).toEqual([]);

    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();

    expect(sentOfType(socket, 'account-identity-delete')).toEqual([
      {
        type: 'account-identity-delete',
        deletionAssertion: 'cross-device-deletion-proof',
      },
    ]);
    peer.destroy();
  });

  it('emits only a validated server-issued member deletion identity', async () => {
    installFakeWebSocket();
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
    });
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    await flushAsync();
    const deleted = vi.fn();
    peer.on('room-member-deleted', deleted);

    socket.dispatch(
      'message',
      JSON.stringify({ type: 'account-member-deleted', memberId: 'member_bad' }),
    );
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-member-deleted',
        memberId: 'member_abcdefghijklmnopqrstuv',
      }),
    );
    await flushAsync();

    expect(deleted).toHaveBeenCalledOnce();
    expect(deleted).toHaveBeenCalledWith('member_abcdefghijklmnopqrstuv');
    peer.destroy();
  });

  it('retries after a transient assertion failure following host admission', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const assertionProvider = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      accountAssertion: 'signed-assertion',
      deletionAssertion: null,
    });
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];

    socket.dispatch('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(sentOfType(socket, 'host-auth')[0]).not.toHaveProperty('accountAssertion');

    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sentOfType(socket, 'account-identity-refresh')).toContainEqual({
      type: 'account-identity-refresh',
      accountAssertion: 'signed-assertion',
    });
    peer.destroy();
  });

  it('keeps retrying after the Worker expires a transiently unrefreshed identity lease', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const assertionProvider = vi.fn(async () => ({
      accountAssertion: 'renewed-assertion',
      deletionAssertion: null,
    }));
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    await Promise.resolve();
    await Promise.resolve();
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'peer-open',
        peerId: '123456',
        roomId: '123456',
        memberIdentity: {
          memberId: 'member_abcdefghijklmnopqrstuv',
          memberDisplayNumber: 0,
          nickname: 'Minsu',
          isAuthenticated: true,
        },
      }),
    );
    socket.sent.length = 0;

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-identity',
        memberIdentity: null,
        clearReason: 'expired',
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sentOfType(socket, 'account-identity-refresh')).toContainEqual({
      type: 'account-identity-refresh',
      accountAssertion: 'renewed-assertion',
    });
    peer.destroy();
  });
});

describe('Cloudflare PRO signaling client contract', () => {
  it('uses the ticket-only PRO path for a coordinator and never sends the room password frame', async () => {
    installFakeWebSocket();
    const ticket = clientProTicket('coordinator-device', { role: 'coordinator' });
    const peer = new CloudflareSignalingPeer('000001', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      proSignaling: {
        roomCode: '000001',
        ticket,
        role: 'coordinator',
        coordinatorEpoch: 7,
        presenceIncarnationId: 'presence-incarnation-0001',
        ticketSequence: 1,
      },
    });
    await Promise.resolve();

    const socket = FakeWebSocket.instances[0];
    const url = new URL(socket.url);
    expect(url.pathname).toBe('/api/pro-rooms/000001/ws');
    expect([...url.searchParams.keys()]).toEqual(['ticket']);
    expect(url.searchParams.get('ticket')).toBe(ticket);

    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '000001', roomId: '000001' }),
    );
    await flushAsync();
    expect(sentOfType(socket, 'room-password-set')).toHaveLength(0);
    peer.destroy();
  });

  it('emits a strictly parsed developer command only on a PRO coordinator socket', async () => {
    installFakeWebSocket();
    const ticket = clientProTicket('coordinator-device', { role: 'coordinator' });
    const peer = new CloudflareSignalingPeer('000001', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      proSignaling: {
        roomCode: '000001',
        ticket,
        role: 'coordinator',
        coordinatorEpoch: 7,
        presenceIncarnationId: 'presence-incarnation-0001',
        ticketSequence: 1,
      },
    });
    await Promise.resolve();
    const received = vi.fn();
    peer.on('developer-command', received);
    const command = {
      type: 'developer-command',
      version: 1,
      roomCode: '000001',
      coordinatorEpoch: 7,
      commandId: 'cmd_1234567890123456789012',
      expiresAtMs: 1_900_000_000_000,
      expected: {
        queueItemId: '11111111-1111-4111-8111-111111111111',
        playlistRevision: 4,
        playbackRevision: 9,
      },
      command: { type: 'seek', positionSeconds: 12.5 },
    };

    FakeWebSocket.instances[0].dispatch('message', JSON.stringify(command));
    await flushAsync();

    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith(command);
    peer.destroy();
  });

  it('emits a strictly parsed developer invalidation only for its exact PRO coordinator epoch', async () => {
    installFakeWebSocket();
    const ticket = clientProTicket('coordinator-device', { role: 'coordinator' });
    const peer = new CloudflareSignalingPeer('000001', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      proSignaling: {
        roomCode: '000001',
        ticket,
        role: 'coordinator',
        coordinatorEpoch: 7,
        presenceIncarnationId: 'presence-incarnation-0001',
        ticketSequence: 1,
      },
    });
    await Promise.resolve();
    const received = vi.fn();
    const errors = vi.fn();
    peer.on('developer-invalidation', received);
    peer.on('error', errors);
    const invalidation = {
      type: 'developer-invalidation',
      version: 1,
      roomCode: '000001',
      coordinatorEpoch: 7,
      revision: 12,
      playlistRevision: 5,
    };

    FakeWebSocket.instances[0].dispatch('message', JSON.stringify(invalidation));
    await flushAsync();
    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith(invalidation);

    FakeWebSocket.instances[0].dispatch(
      'message',
      JSON.stringify({ ...invalidation, coordinatorEpoch: 8 }),
    );
    await flushAsync();
    expect(received).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]?.[0]).toMatchObject({
      type: 'server-error',
      message: 'UNEXPECTED_DEVELOPER_INVALIDATION',
    });
    peer.destroy();
  });

  it('emits a strictly parsed queue-addition event only for its exact PRO coordinator epoch', async () => {
    installFakeWebSocket();
    const ticket = clientProTicket('coordinator-device', { role: 'coordinator' });
    const peer = new CloudflareSignalingPeer('000001', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      proSignaling: {
        roomCode: '000001',
        ticket,
        role: 'coordinator',
        coordinatorEpoch: 7,
        presenceIncarnationId: 'presence-incarnation-0001',
        ticketSequence: 1,
      },
    });
    await Promise.resolve();
    const received = vi.fn();
    const errors = vi.fn();
    peer.on('pro-queue-addition', received);
    peer.on('error', errors);
    const addition = {
      type: 'pro-queue-addition',
      version: 1,
      roomCode: '000001',
      coordinatorEpoch: 7,
      playlistRevision: 5,
      eventId: 'qa_000001_5_12',
      actorName: 'Studio bot',
      count: 12,
    };

    FakeWebSocket.instances[0].dispatch('message', JSON.stringify(addition));
    await flushAsync();
    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith(addition);

    FakeWebSocket.instances[0].dispatch(
      'message',
      JSON.stringify({ ...addition, coordinatorEpoch: 8 }),
    );
    await flushAsync();
    expect(received).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]?.[0]).toMatchObject({
      type: 'server-error',
      message: 'UNEXPECTED_DEVELOPER_QUEUE_ADDITION',
    });
    peer.destroy();
  });

  it('rejects a malformed developer command without forwarding it', async () => {
    installFakeWebSocket();
    const ticket = clientProTicket('coordinator-device', { role: 'coordinator' });
    const peer = new CloudflareSignalingPeer('000001', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      proSignaling: {
        roomCode: '000001',
        ticket,
        role: 'coordinator',
        coordinatorEpoch: 7,
        presenceIncarnationId: 'presence-incarnation-0001',
        ticketSequence: 1,
      },
    });
    await Promise.resolve();
    const received = vi.fn();
    const errors = vi.fn();
    peer.on('developer-command', received);
    peer.on('error', errors);

    FakeWebSocket.instances[0].dispatch(
      'message',
      JSON.stringify({
        type: 'developer-command',
        version: 1,
        roomCode: '000001',
        coordinatorEpoch: 7,
        commandId: 'cmd_1234567890123456789012',
        expiresAtMs: 1_900_000_000_000,
        expected: {
          queueItemId: null,
          playlistRevision: 4,
          playbackRevision: 9,
        },
        command: { type: 'play', unexpected: true },
      }),
    );
    await flushAsync();

    expect(received).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]?.[0]).toMatchObject({
      type: 'server-error',
      message: 'INVALID_DEVELOPER_COMMAND',
    });
    peer.destroy();
  });

  it('rebuilds RTC only for an epoch-advanced close and preserves it for an ordinary signaling blip', async () => {
    installFakeWebSocket();
    const makePeer = (sequence: number) => {
      const ticket = clientProTicket('coordinator-device', {
        role: 'coordinator',
        ticketSequence: sequence,
        jti: `epoch-close-ticket-000${sequence}`,
      });
      return new CloudflareSignalingPeer('000001', {
        provider: 'cloudflare',
        signalingUrl: 'wss://signal.example.test/api/rooms',
        config: { iceServers: [] },
        proSignaling: {
          roomCode: '000001',
          ticket,
          role: 'coordinator',
          coordinatorEpoch: 7,
          presenceIncarnationId: 'presence-incarnation-0001',
          ticketSequence: sequence,
        },
      });
    };
    const attachLiveConnection = (peer: CloudflareSignalingPeer, id: string) => {
      const connection = new CloudflareDataConnection(id);
      connection.attach(
        new FakePeerConnection() as unknown as RTCPeerConnection,
        new FakeDataChannel('musixquare-data') as unknown as RTCDataChannel,
      );
      connection.attach(
        connection.peerConnection!,
        new FakeDataChannel('musixquare-control') as unknown as RTCDataChannel,
      );
      privateMaps(peer).connections.set(id, connection);
      return connection;
    };

    const ordinary = makePeer(1);
    await Promise.resolve();
    const ordinaryConnection = attachLiveConnection(ordinary, 'ordinary-member');
    await Promise.resolve();
    const ordinaryDisconnected = vi.fn();
    const ordinaryEpochAdvanced = vi.fn();
    ordinary.on('disconnected', ordinaryDisconnected);
    ordinary.on('pro-epoch-advanced', ordinaryEpochAdvanced);
    FakeWebSocket.instances[0].dispatch('close', undefined, 'network blip');
    expect(ordinaryConnection.open).toBe(true);
    expect(ordinaryDisconnected).toHaveBeenCalledOnce();
    expect(ordinaryEpochAdvanced).not.toHaveBeenCalled();
    ordinary.destroy();

    const advanced = makePeer(2);
    await Promise.resolve();
    const advancedConnection = attachLiveConnection(advanced, 'stale-member');
    await Promise.resolve();
    const advancedDisconnected = vi.fn();
    const epochAdvanced = vi.fn();
    advanced.on('disconnected', advancedDisconnected);
    advanced.on('pro-epoch-advanced', epochAdvanced);
    FakeWebSocket.instances[1].dispatch('close', undefined, 'PRO_COORDINATOR_EPOCH_ADVANCED');
    expect(advancedConnection.open).toBe(false);
    expect(privateMaps(advanced).connections.size).toBe(0);
    expect(epochAdvanced).toHaveBeenCalledOnce();
    expect(advancedDisconnected).not.toHaveBeenCalled();
    advanced.destroy();
  });

  it('atomically refreshes a same-room/role/epoch ticket for the next reconnect URL', async () => {
    installFakeWebSocket();
    const initialTicket = clientProTicket('coordinator-device', {
      role: 'coordinator',
      jti: 'initial-client-ticket',
    });
    const refreshedTicket = clientProTicket('coordinator-device', {
      role: 'coordinator',
      jti: 'refreshed-client-ticket',
      ticketSequence: 2,
    });
    const peer = new CloudflareSignalingPeer('000001', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      proSignaling: {
        roomCode: '000001',
        ticket: initialTicket,
        role: 'coordinator',
        coordinatorEpoch: 7,
        presenceIncarnationId: 'presence-incarnation-0001',
        ticketSequence: 1,
      },
    });
    await Promise.resolve();
    const initialSocket = FakeWebSocket.instances[0];

    const refreshedAccess = {
      roomCode: '000001',
      ticket: refreshedTicket,
      role: 'coordinator' as const,
      coordinatorEpoch: 7,
      presenceIncarnationId: 'presence-incarnation-0001',
      ticketSequence: 2,
    };
    expect(peer.setProSignalingAccess(refreshedAccess)).toBe(true);
    refreshedAccess.ticket = initialTicket;
    initialSocket.close();
    peer.reconnect();

    const reconnected = FakeWebSocket.instances[1];
    expect(new URL(reconnected.url).searchParams.get('ticket')).toBe(refreshedTicket);
    peer.destroy();
  });

  it.each([
    {
      label: 'room',
      access: {
        roomCode: '000000',
        role: 'coordinator' as const,
        coordinatorEpoch: 7,
        presenceIncarnationId: 'presence-incarnation-0001',
        ticketSequence: 2,
      },
    },
    {
      label: 'role',
      access: {
        roomCode: '000001',
        role: 'member' as const,
        coordinatorEpoch: 7,
        presenceIncarnationId: 'presence-incarnation-0001',
        ticketSequence: 2,
      },
    },
    {
      label: 'epoch',
      access: {
        roomCode: '000001',
        role: 'coordinator' as const,
        coordinatorEpoch: 8,
        presenceIncarnationId: 'presence-incarnation-0001',
        ticketSequence: 2,
      },
    },
  ])('rejects an in-place PRO $label change', async ({ access }) => {
    installFakeWebSocket();
    const initialTicket = clientProTicket('coordinator-device', { role: 'coordinator' });
    const peer = new CloudflareSignalingPeer('000001', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      proSignaling: {
        roomCode: '000001',
        ticket: initialTicket,
        role: 'coordinator',
        coordinatorEpoch: 7,
        presenceIncarnationId: 'presence-incarnation-0001',
        ticketSequence: 1,
      },
    });
    await Promise.resolve();
    const initialSocket = FakeWebSocket.instances[0];
    const mismatchedTicket = clientProTicket('coordinator-device', access);

    expect(peer.setProSignalingAccess({ ...access, ticket: mismatchedTicket })).toBe(false);
    initialSocket.close();
    peer.reconnect();
    expect(new URL(FakeWebSocket.instances[1].url).searchParams.get('ticket')).toBe(initialTicket);
    peer.destroy();
  });

  it('leaves a standard signaling peer unchanged when offered PRO access', async () => {
    installFakeWebSocket();
    const peer = createHostPeer();
    await Promise.resolve();
    expect(
      peer.setProSignalingAccess({
        roomCode: '000001',
        ticket: clientProTicket('coordinator-device', { role: 'coordinator' }),
        role: 'coordinator',
        coordinatorEpoch: 7,
        presenceIncarnationId: 'presence-incarnation-0001',
        ticketSequence: 2,
      }),
    ).toBe(false);
    expect(new URL(FakeWebSocket.instances[0].url).pathname).toBe('/api/rooms/123456/ws');
    peer.destroy();
  });

  it('derives a member identity from its signed payload and skips ordinary guest-auth', () => {
    installFakeWebSocket();
    const ticket = clientProTicket('stable-pro-member');
    const peer = new CloudflareSignalingPeer(null, {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      proSignaling: {
        roomCode: '000001',
        ticket,
        role: 'member',
        coordinatorEpoch: 7,
        presenceIncarnationId: 'presence-incarnation-0001',
        ticketSequence: 1,
      },
    });

    expect(peer.id).toBe('stable-pro-member');
    peer.connect('000001');
    const socket = FakeWebSocket.instances[0];
    const url = new URL(socket.url);
    expect(url.pathname).toBe('/api/pro-rooms/000001/ws');
    expect([...url.searchParams.keys()]).toEqual(['ticket']);
    socket.dispatch('open');
    expect(sentOfType(socket, 'guest-auth')).toHaveLength(0);
    expect(() => peer.connect('000000')).toThrowError('PRO_SIGNALING_ROOM_MISMATCH');
    peer.destroy();
  });
});

describe('Cloudflare client/Worker signaling contract', () => {
  it.each([
    { label: 'passwordless', roomPassword: '' },
    { label: 'password-protected', roomPassword: '12345678' },
  ])(
    'joins a $label room and relays the first client-generated offer and answer',
    async ({ roomPassword }) => {
      installFakeWebSocket();
      installFakeRTCPeerConnection();
      const room = await createContractWorkerRoom();

      const hostPeer = createHostPeer();
      hostPeer.setRoomPassword(roomPassword || null);
      await Promise.resolve();
      const hostClientSocket = FakeWebSocket.instances[0];
      hostClientSocket.dispatch('open');
      await flushAsync();
      const hostUrl = new URL(hostClientSocket.url);
      const hostServerSocket = new ContractWorkerSocket();
      expect([...hostUrl.searchParams.keys()]).toEqual(['role', 'peerId']);
      expect(hostUrl.searchParams.get('secret')).toBeNull();
      const hostAuthFrame = sentOfType(hostClientSocket, 'host-auth')[0];
      expect(hostAuthFrame).toEqual({
        type: 'host-auth',
        secret: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      });
      room.acceptPendingHost(hostServerSocket, '123456', hostUrl.searchParams.get('peerId') || '');
      expect(workerSentOfType(hostServerSocket, 'peer-open')).toHaveLength(0);
      await room.webSocketMessage(hostServerSocket, JSON.stringify(hostAuthFrame));

      hostClientSocket.dispatch('message', hostServerSocket.sent[0]);
      await flushAsync();
      const passwordFrame = sentOfType(hostClientSocket, 'room-password-set')[0];
      expect(passwordFrame).toEqual({ type: 'room-password-set', password: roomPassword });
      await room.webSocketMessage(hostServerSocket, JSON.stringify(passwordFrame));

      const guestPeer = createGuestPeer();
      guestPeer.connect(
        '123456',
        roomPassword
          ? { roomPassword, metadata: { contract: true } }
          : { metadata: { contract: true } },
      );
      const guestClientSocket = FakeWebSocket.instances[1];
      const guestUrl = new URL(guestClientSocket.url);
      const guestServerSocket = new ContractWorkerSocket();
      await room.acceptGuest(
        guestServerSocket,
        '123456',
        guestUrl.searchParams.get('peerId') || '',
      );

      guestClientSocket.dispatch('open');
      await flushAsync();
      const authFrame = sentOfType(guestClientSocket, 'guest-auth')[0];
      expect(authFrame).toMatchObject({
        type: 'guest-auth',
        password: roomPassword,
        reconnectSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });
      await room.webSocketMessage(guestServerSocket, JSON.stringify(authFrame));

      // Passwordless and protected rooms both authenticate the reconnect proof
      // before converging on the same peer-open/offer contract.
      expect(guestServerSocket.closed).toBe(false);
      const peerOpen = workerSentOfType(guestServerSocket, 'peer-open')[0];
      expect(peerOpen).toMatchObject({ type: 'peer-open', roomId: '123456' });
      expect(peerOpen).not.toHaveProperty('reconnectSecret');
      guestClientSocket.dispatch('message', JSON.stringify(peerOpen));
      await flushAsync();

      const offerFrame = sentOfType(guestClientSocket, 'signal-offer')[0];
      expect(offerFrame).toMatchObject({
        type: 'signal-offer',
        to: 'host',
        sdp: { type: 'offer', sdp: 'fake-offer' },
        metadata: { contract: true },
      });
      await room.webSocketMessage(guestServerSocket, JSON.stringify(offerFrame));

      const forwardedOffer = workerSentOfType(hostServerSocket, 'signal-offer')[0];
      expect(forwardedOffer).toMatchObject({
        type: 'signal-offer',
        from: guestUrl.searchParams.get('peerId'),
        sdp: { type: 'offer', sdp: 'fake-offer' },
      });
      hostClientSocket.dispatch('message', JSON.stringify(forwardedOffer));
      await flushAsync();

      const answerFrame = sentOfType(hostClientSocket, 'signal-answer')[0];
      expect(answerFrame).toMatchObject({
        type: 'signal-answer',
        to: guestUrl.searchParams.get('peerId'),
        sdp: { type: 'answer', sdp: 'fake-answer' },
      });
      await room.webSocketMessage(hostServerSocket, JSON.stringify(answerFrame));

      expect(workerSentOfType(guestServerSocket, 'signal-answer')[0]).toMatchObject({
        type: 'signal-answer',
        from: '123456',
        sdp: { type: 'answer', sdp: 'fake-answer' },
      });

      guestPeer.destroy();
      hostPeer.destroy();
    },
  );

  it('reuses the RAM-only host proof in frames without exposing it on reconnect URLs', async () => {
    installFakeWebSocket();
    const peer = createHostPeer();
    await Promise.resolve();
    const first = FakeWebSocket.instances[0];
    first.dispatch('open');
    await flushAsync();
    const firstAuth = sentOfType(first, 'host-auth')[0];

    expect(new URL(first.url).searchParams.get('secret')).toBeNull();
    expect(firstAuth?.secret).toMatch(/^[A-Za-z0-9_-]{32}$/);

    first.close();
    peer.reconnect();
    const reopened = FakeWebSocket.instances[1];
    reopened.dispatch('open');
    await flushAsync();

    expect(new URL(reopened.url).searchParams.get('secret')).toBeNull();
    expect(sentOfType(reopened, 'host-auth')[0]).toEqual(firstAuth);
    peer.destroy();
  });
});

describe('Cloudflare signaling/data-channel boundary', () => {
  it('suppresses synchronous channel errors caused by an intentional close', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    bulk.emitErrorOnClose = true;
    control.emitErrorOnClose = true;
    const onError = vi.fn();
    const onClose = vi.fn();
    conn.on('error', onError);
    conn.on('close', onClose);

    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    bulk.dispatch('error', new Error('live channel failure'));
    expect(onError).toHaveBeenCalledTimes(1);

    conn.close();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(conn.open).toBe(false);
  });

  it('suppresses sibling close errors while disposing after a remote channel closes', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    control.emitErrorOnClose = true;
    const onError = vi.fn();
    const onClose = vi.fn();
    conn.on('error', onError);
    conn.on('close', onClose);

    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    bulk.readyState = 'closed';
    bulk.dispatch('close');

    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(conn.open).toBe(false);
    expect(control.readyState).toBe('closed');
    expect(pc.connectionState).toBe('closed');
    expect(pc.closeCount).toBe(1);
  });

  it('suppresses a Chromium close-called error that races ahead of a remote close', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    const onError = vi.fn();
    const onClose = vi.fn();
    conn.on('error', onError);
    conn.on('close', onClose);

    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    bulk.dispatch(
      'error',
      new DOMException('User-Initiated Abort, reason=Close called', 'OperationError'),
    );
    bulk.readyState = 'closed';
    bulk.dispatch('close');

    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(conn.open).toBe(false);
  });

  it('keeps a transiently disconnected connection alive when RTC recovers within the grace', async () => {
    vi.useFakeTimers();
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    const onClose = vi.fn();
    conn.on('close', onClose);
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await vi.advanceTimersByTimeAsync(0);

    pc.connectionState = 'disconnected';
    pc.dispatch('connectionstatechange');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(conn.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    pc.connectionState = 'connected';
    pc.dispatch('connectionstatechange');
    await vi.advanceTimersByTimeAsync(15_000);

    expect(conn.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(bulk.readyState).toBe('open');
    expect(control.readyState).toBe('open');
    expect(pc.closeCount).toBe(0);
    conn.close();
  });

  it('closes and disposes every RTC resource exactly once after disconnected grace expires', async () => {
    vi.useFakeTimers();
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    const onClose = vi.fn();
    conn.on('close', onClose);
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await vi.advanceTimersByTimeAsync(0);

    pc.connectionState = 'disconnected';
    pc.dispatch('connectionstatechange');
    await vi.advanceTimersByTimeAsync(15_000);
    conn.close();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(conn.open).toBe(false);
    expect(bulk.readyState).toBe('closed');
    expect(control.readyState).toBe('closed');
    expect(pc.connectionState).toBe('closed');
    expect(pc.closeCount).toBe(1);
  });

  it('closes a failed RTC connection immediately and cancels its disconnected grace', async () => {
    vi.useFakeTimers();
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    const onClose = vi.fn();
    conn.on('close', onClose);
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await vi.advanceTimersByTimeAsync(0);

    pc.connectionState = 'disconnected';
    pc.dispatch('connectionstatechange');
    pc.connectionState = 'failed';
    pc.dispatch('connectionstatechange');
    await vi.advanceTimersByTimeAsync(15_000);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bulk.readyState).toBe('closed');
    expect(control.readyState).toBe('closed');
    expect(pc.connectionState).toBe('closed');
    expect(pc.closeCount).toBe(1);
  });

  it('opens only after both channels are ready and keeps file tails on their ordered bulk stream', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    bulk.readyState = 'connecting';
    control.readyState = 'connecting';
    const onOpen = vi.fn();
    conn.on('open', onOpen);

    expect(conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel)).toBe(
      true,
    );
    expect(
      conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel),
    ).toBe(false);

    bulk.readyState = 'open';
    bulk.dispatch('open');
    expect(conn.open).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    expect(() =>
      conn.send({
        type: MSG.PLAY,
        time: 0,
        queueItemId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toThrow('DATA_CHANNEL_NOT_OPEN');

    control.readyState = 'open';
    control.dispatch('open');
    expect(conn.open).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);

    conn.send({
      type: MSG.PLAYLIST_UPDATE,
      list: [],
      currentQueueItemId: null,
      revision: 0,
      bootstrap: true,
    });
    conn.send({
      type: MSG.FILE_CHUNK,
      chunk: new Uint8Array([1, 2, 3]),
      index: 0,
      sessionId: 1,
      total: 1,
      name: 'track.mp3',
    });
    conn.send({
      type: MSG.FILE_END,
      queueItemId: '00000000-0000-4000-8000-000000000001',
      sessionId: 1,
      name: 'track.mp3',
    });
    conn.send({
      type: MSG.OPERATOR_FILE_UPLOAD_FINISH,
      requestId: '10000000-0000-4000-8000-000000000001',
      sessionId: '20000000-0000-4000-8000-000000000001',
    });
    conn.send({
      type: MSG.PLAY,
      time: 0,
      queueItemId: '00000000-0000-4000-8000-000000000001',
    });

    expect(control.sent).toHaveLength(2);
    expect(bulk.sent).toHaveLength(3);
    expect(
      control.sent
        .map((frame) => JSON.parse(frame as string) as { type: string })
        .map(({ type }) => type),
    ).toEqual([MSG.PLAYLIST_UPDATE, MSG.PLAY]);
    expect(bulk.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect(JSON.parse(bulk.sent[1] as string)).toMatchObject({
      type: MSG.FILE_END,
      sessionId: 1,
    });
    expect(JSON.parse(bulk.sent[2] as string)).toMatchObject({
      type: MSG.OPERATOR_FILE_UPLOAD_FINISH,
    });
  });

  it('never falls back to the bulk channel for control frames', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');

    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(conn.open).toBe(false);
    expect(() =>
      conn.send({ type: MSG.PAUSE, time: 12, queueItemId: null, reason: 'pause' }),
    ).toThrow('DATA_CHANNEL_NOT_OPEN');

    expect(bulk.sent).toHaveLength(0);
  });

  it('keeps the previous host connection until its replacement reaches the lifecycle owner', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const peer = createHostPeer();
    const onConnection = vi.fn();
    peer.on('connection', onConnection);
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();

    const offer = {
      type: 'signal-offer',
      from: 'guest-reconnect',
      sdp: { type: 'offer', sdp: 'guest-offer' },
    };
    socket.dispatch('message', JSON.stringify(offer));
    await flushAsync();
    const firstPc = FakeRTCPeerConnection.instances[0];
    const firstBulk = new FakeDataChannel('musixquare-data');
    const firstControl = new FakeDataChannel('musixquare-control');
    firstPc.dispatch('datachannel', { channel: firstBulk });
    firstPc.dispatch('datachannel', { channel: firstControl });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const firstConnection = onConnection.mock.calls[0]?.[0] as CloudflareDataConnection;
    expect(firstConnection.open).toBe(true);

    socket.dispatch('message', JSON.stringify(offer));
    await flushAsync();
    const replacementPc = FakeRTCPeerConnection.instances[1];
    const replacementControl = new FakeDataChannel('musixquare-control');
    const replacementBulk = new FakeDataChannel('musixquare-data');

    expect(firstBulk.readyState).toBe('open');
    replacementPc.dispatch('datachannel', { channel: replacementControl });
    expect(firstBulk.readyState).toBe('open');

    replacementPc.dispatch('datachannel', { channel: replacementBulk });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const replacementConnection = onConnection.mock.calls[1]?.[0] as CloudflareDataConnection;
    expect(onConnection).toHaveBeenCalledTimes(2);
    expect(firstBulk.readyState).toBe('closed');
    expect(firstConnection.open).toBe(false);
    expect(replacementConnection.open).toBe(true);
    expect(privateMaps(peer).connections.get('guest-reconnect')).toBe(replacementConnection);

    peer.destroy();
  });

  it.each([
    {
      label: 'explicit identity clear',
      updates: [
        {
          type: 'account-member-updated',
          peerId: 'guest-identity-race',
          memberIdentity: null,
          clearReason: 'explicit',
        },
      ],
      expectedIdentity: null,
    },
    {
      label: 'newer authenticated identity',
      updates: [
        {
          type: 'account-member-updated',
          peerId: 'guest-identity-race',
          memberIdentity: null,
          clearReason: 'explicit',
        },
        {
          type: 'account-member-updated',
          peerId: 'guest-identity-race',
          memberIdentity: {
            memberId: 'member_bcdefghijklmnopqrstuvw',
            memberDisplayNumber: 2,
            nickname: 'Latest member',
            isAuthenticated: true,
          },
        },
      ],
      expectedIdentity: {
        memberId: 'member_bcdefghijklmnopqrstuvw',
        memberDisplayNumber: 2,
        nickname: 'Latest member',
        isAuthenticated: true,
      },
    },
  ])('publishes $label received while a host offer is still in flight', async (scenario) => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    let releaseRemoteDescription: (() => void) | undefined;
    vi.spyOn(FakeRTCPeerConnection.prototype, 'setRemoteDescription').mockImplementationOnce(
      (description) =>
        new Promise<void>((resolve) => {
          const pc = FakeRTCPeerConnection.instances.at(-1);
          if (pc) pc.remoteDescription = description;
          releaseRemoteDescription = resolve;
        }),
    );
    const peer = createHostPeer();
    const onConnection = vi.fn();
    peer.on('connection', onConnection);
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
        from: 'guest-identity-race',
        sdp: { type: 'offer', sdp: 'guest-offer' },
        memberIdentity: {
          memberId: 'member_abcdefghijklmnopqrstuv',
          memberDisplayNumber: 1,
          nickname: 'Stale member',
          isAuthenticated: true,
        },
      }),
    );
    await vi.waitFor(() => expect(releaseRemoteDescription).toBeTypeOf('function'));
    for (const update of scenario.updates) {
      socket.dispatch('message', JSON.stringify(update));
    }
    await flushAsync();

    releaseRemoteDescription?.();
    await vi.waitFor(() => expect(sentOfType(socket, 'signal-answer')).toHaveLength(1));
    const pc = FakeRTCPeerConnection.instances[0];
    pc.dispatch('datachannel', { channel: new FakeDataChannel('musixquare-data') });
    pc.dispatch('datachannel', { channel: new FakeDataChannel('musixquare-control') });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const conn = onConnection.mock.calls[0]?.[0] as CloudflareDataConnection;
    expect(onConnection).toHaveBeenCalledTimes(1);
    expect(conn.roomIdentity).toEqual(scenario.expectedIdentity);
    peer.destroy();
  });

  it('does not carry an authenticated identity into a newer anonymous offer for the same peer', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const peer = createHostPeer();
    const onConnection = vi.fn();
    peer.on('connection', onConnection);
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();

    const authenticatedOffer = {
      type: 'signal-offer',
      from: 'guest-identity-replacement',
      sdp: { type: 'offer', sdp: 'authenticated-offer' },
      memberIdentity: {
        memberId: 'member_abcdefghijklmnopqrstuv',
        memberDisplayNumber: 1,
        nickname: 'Authenticated member',
        isAuthenticated: true,
      },
    };
    socket.dispatch('message', JSON.stringify(authenticatedOffer));
    await flushAsync();
    const authenticatedPc = FakeRTCPeerConnection.instances[0];
    authenticatedPc.dispatch('datachannel', {
      channel: new FakeDataChannel('musixquare-data'),
    });
    authenticatedPc.dispatch('datachannel', {
      channel: new FakeDataChannel('musixquare-control'),
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const authenticatedConnection = onConnection.mock.calls[0]?.[0] as CloudflareDataConnection;
    expect(authenticatedConnection.roomIdentity).toEqual(authenticatedOffer.memberIdentity);

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-offer',
        from: 'guest-identity-replacement',
        sdp: { type: 'offer', sdp: 'anonymous-replacement-offer' },
      }),
    );
    await flushAsync();
    const anonymousPc = FakeRTCPeerConnection.instances[1];
    anonymousPc.dispatch('datachannel', {
      channel: new FakeDataChannel('musixquare-data'),
    });
    anonymousPc.dispatch('datachannel', {
      channel: new FakeDataChannel('musixquare-control'),
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const anonymousConnection = onConnection.mock.calls[1]?.[0] as CloudflareDataConnection;
    expect(onConnection).toHaveBeenCalledTimes(2);
    expect(anonymousConnection.roomIdentity).toBeNull();
    expect(authenticatedConnection.open).toBe(false);
    peer.destroy();
  });

  it('does not publish an in-flight host offer after a newer peer-left frame', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    let releaseRemoteDescription: (() => void) | undefined;
    vi.spyOn(FakeRTCPeerConnection.prototype, 'setRemoteDescription').mockImplementationOnce(
      (description) =>
        new Promise<void>((resolve) => {
          const pc = FakeRTCPeerConnection.instances.at(-1);
          if (pc) pc.remoteDescription = description;
          releaseRemoteDescription = resolve;
        }),
    );
    const peer = createHostPeer();
    const onConnection = vi.fn();
    peer.on('connection', onConnection);
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
        from: 'guest-departed-in-flight',
        sdp: { type: 'offer', sdp: 'guest-offer' },
      }),
    );
    await vi.waitFor(() => expect(releaseRemoteDescription).toBeTypeOf('function'));
    const pc = FakeRTCPeerConnection.instances[0];
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-left', peerId: 'guest-departed-in-flight' }),
    );
    await flushAsync();
    releaseRemoteDescription?.();
    await flushAsync();

    const bulk = new FakeDataChannel('musixquare-data');
    pc.dispatch('datachannel', { channel: bulk });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(pc.connectionState).toBe('closed');
    expect(bulk.readyState).toBe('closed');
    expect(onConnection).not.toHaveBeenCalled();
    expect(privateMaps(peer).connections.has('guest-departed-in-flight')).toBe(false);
    peer.destroy();
  });

  it('restores a live host connection when its replacement negotiation fails', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const peer = createHostPeer();
    const onConnection = vi.fn();
    const onError = vi.fn();
    peer.on('connection', onConnection);
    peer.on('error', onError);
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();

    const offer = {
      type: 'signal-offer',
      from: 'guest-reconnect',
      sdp: { type: 'offer', sdp: 'guest-offer' },
    };
    socket.dispatch('message', JSON.stringify(offer));
    await flushAsync();
    const firstPc = FakeRTCPeerConnection.instances[0];
    firstPc.dispatch('datachannel', { channel: new FakeDataChannel('musixquare-data') });
    firstPc.dispatch('datachannel', { channel: new FakeDataChannel('musixquare-control') });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const firstConnection = onConnection.mock.calls[0]?.[0] as CloudflareDataConnection;
    expect(firstConnection.open).toBe(true);

    vi.spyOn(FakeRTCPeerConnection.prototype, 'createAnswer').mockRejectedValueOnce(
      new Error('answer failed'),
    );
    socket.dispatch('message', JSON.stringify(offer));
    await flushAsync();

    const failedPc = FakeRTCPeerConnection.instances[1];
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onConnection).toHaveBeenCalledTimes(1);
    expect(firstConnection.open).toBe(true);
    expect(failedPc.connectionState).toBe('closed');
    expect(privateMaps(peer).connections.get('guest-reconnect')).toBe(firstConnection);

    peer.destroy();
  });

  it('keeps candidates and answers scoped to the newest overlapping offer generation', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const peer = createHostPeer();
    const onError = vi.fn();
    peer.on('error', onError);
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();

    let releaseFirst!: () => void;
    const firstRemoteDescription = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(FakeRTCPeerConnection.prototype, 'setRemoteDescription')
      .mockImplementationOnce(async function (
        this: FakeRTCPeerConnection,
        description: RTCSessionDescriptionInit,
      ) {
        this.remoteDescription = description;
        await firstRemoteDescription;
      })
      .mockImplementation(async function (
        this: FakeRTCPeerConnection,
        description: RTCSessionDescriptionInit,
      ) {
        this.remoteDescription = description;
      });

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-offer',
        from: 'guest-overlap',
        sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:first' },
      }),
    );
    await Promise.resolve();
    const firstPc = FakeRTCPeerConnection.instances[0]!;

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-offer',
        from: 'guest-overlap',
        sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:second' },
      }),
    );
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-candidate',
        from: 'guest-overlap',
        candidate: {
          candidate: 'candidate:2 1 udp 1 192.0.2.2 5000 typ host ufrag second',
          usernameFragment: 'second',
        },
      }),
    );

    await vi.waitFor(() => expect(sentOfType(socket, 'signal-answer')).toHaveLength(1));
    const secondPc = FakeRTCPeerConnection.instances[1]!;
    expect(secondPc.addedCandidates).toEqual([
      expect.objectContaining({ usernameFragment: 'second' }),
    ]);

    releaseFirst();
    await flushAsync();

    expect(sentOfType(socket, 'signal-answer')).toHaveLength(1);
    expect(firstPc.addedCandidates).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    peer.destroy();
  });

  it('echoes a negotiation token and admits only matching token-aware candidates', async () => {
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

    const negotiationId = 'negotiation_token_000001';
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-offer',
        from: 'guest-token',
        negotiationId,
        sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:token-aware' },
      }),
    );
    await vi.waitFor(() => expect(sentOfType(socket, 'signal-answer')).toHaveLength(1));
    expect(sentOfType(socket, 'signal-answer')[0]).toMatchObject({ negotiationId });

    const pc = FakeRTCPeerConnection.instances[0]!;
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-candidate',
        from: 'guest-token',
        candidate: { candidate: 'candidate:legacy-without-ufrag' },
      }),
    );
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-candidate',
        from: 'guest-token',
        negotiationId: 'negotiation_token_999999',
        candidate: { candidate: 'candidate:wrong-token' },
      }),
    );
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-candidate',
        from: 'guest-token',
        negotiationId,
        candidate: { candidate: 'candidate:matching-token' },
      }),
    );
    await flushAsync();

    expect(pc.addedCandidates).toEqual([{ candidate: 'candidate:matching-token' }]);
    peer.destroy();
  });

  it('keeps early candidates isolated by token and drops trickle from a superseded local pc', async () => {
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

    const firstToken = 'negotiation_token_000001';
    const secondToken = 'negotiation_token_000002';
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-offer',
        from: 'guest-token-overlap',
        negotiationId: firstToken,
        sdp: { type: 'offer', sdp: 'first-offer' },
      }),
    );
    await vi.waitFor(() => expect(sentOfType(socket, 'signal-answer')).toHaveLength(1));
    const firstPc = FakeRTCPeerConnection.instances[0]!;

    // WebSocket ordering usually puts the offer first, but the browser may
    // emit local trickle before the offer continuation sends its frame.
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-candidate',
        from: 'guest-token-overlap',
        negotiationId: secondToken,
        candidate: { candidate: 'candidate:early-second' },
      }),
    );
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-offer',
        from: 'guest-token-overlap',
        negotiationId: secondToken,
        sdp: { type: 'offer', sdp: 'second-offer' },
      }),
    );
    await vi.waitFor(() => expect(sentOfType(socket, 'signal-answer')).toHaveLength(2));
    const secondPc = FakeRTCPeerConnection.instances[1]!;
    expect(secondPc.addedCandidates).toEqual([{ candidate: 'candidate:early-second' }]);

    firstPc.dispatch('icecandidate', {
      candidate: { toJSON: () => ({ candidate: 'candidate:late-first' }) },
    });
    secondPc.dispatch('icecandidate', {
      candidate: { toJSON: () => ({ candidate: 'candidate:current-second' }) },
    });
    const sentCandidates = sentOfType(socket, 'signal-candidate');
    expect(sentCandidates).toHaveLength(1);
    expect(sentCandidates[0]).toMatchObject({
      negotiationId: secondToken,
      candidate: { candidate: 'candidate:current-second' },
    });
    peer.destroy();
  });

  it('falls back to ufrag-only ICE when an older answer omits the negotiation token', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const peer = createGuestPeer();
    peer.connect('123456');
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '123456' }),
    );
    await flushAsync();

    expect(sentOfType(socket, 'signal-offer')[0]?.negotiationId).toEqual(expect.any(String));
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-candidate',
        from: 'host',
        candidate: { candidate: 'candidate:legacy-host' },
      }),
    );
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-answer',
        from: 'host',
        sdp: { type: 'answer', sdp: 'legacy-answer' },
      }),
    );
    await flushAsync();

    expect(FakeRTCPeerConnection.instances[0]?.addedCandidates).toEqual([
      { candidate: 'candidate:legacy-host' },
    ]);
    peer.destroy();
  });

  it('does not let a late legacy data answer overwrite the active media negotiation', async () => {
    const { peer, socket, pc } = await establishGuest();
    const onCall = vi.fn();
    peer.on('call', onCall);
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'media-offer',
        from: 'host',
        callId: 'legacy-media-call',
        sdp: { type: 'offer', sdp: 'current-media-offer' },
        audioTrackCount: 1,
      }),
    );
    await flushAsync();
    const mediaConn = onCall.mock.calls[0]?.[0] as TransportMediaConnection;
    expect(mediaConn).toBeDefined();
    mediaConn.answer();
    await vi.waitFor(() => expect(sentOfType(socket, 'media-answer')).toHaveLength(1));
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'current-media-offer' });

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-answer',
        from: 'host',
        // A rolling-deploy legacy peer has no negotiationId.
        sdp: { type: 'answer', sdp: 'late-legacy-data-answer' },
      }),
    );
    await flushAsync();
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'current-media-offer' });

    peer.destroy();
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
    (peer as unknown as { connections: Map<string, unknown> }).connections.set('guest-1', conn);

    await (peer as unknown as { handleHostMessage(raw: string): Promise<void> }).handleHostMessage(
      JSON.stringify({ type: 'peer-left', peerId: 'guest-1' }),
    );

    expect(close).not.toHaveBeenCalled();
  });
});

describe('Cloudflare guest signaling reconnect', () => {
  it('reopens the guest socket on reconnect() and re-auths without re-offering', async () => {
    const { peer, conn, socket } = await establishGuest('12345678');
    const onDisconnected = vi.fn();
    peer.on('disconnected', onDisconnected);

    expect(conn.open).toBe(true);
    expect(sentOfType(socket, 'signal-offer')).toHaveLength(1);

    socket.close();

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(privateMaps(peer).roomSockets.has('123456')).toBe(false);
    // The durable registry must survive the blip — it is the reopen source.
    expect(privateMaps(peer).guestRooms.has('123456')).toBe(true);

    peer.reconnect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    const reopened = FakeWebSocket.instances[1];
    expect(reopened.url).toContain('role=guest');
    expect(new URL(reopened.url).searchParams.has('reconnectSecret')).toBe(false);
    reopened.dispatch('open');
    await flushAsync();
    expect(sentOfType(reopened, 'guest-auth')[0]?.password).toBe('12345678');
    expect(sentOfType(reopened, 'guest-auth')[0]?.reconnectSecret).toBe(
      sentOfType(socket, 'guest-auth')[0]?.reconnectSecret,
    );

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

  it('emits one disconnected transition across repeated failed reconnect sockets', async () => {
    const { peer, socket } = await establishGuest();
    const onDisconnected = vi.fn();
    peer.on('disconnected', onDisconnected);

    socket.close();
    peer.reconnect();
    const retry = FakeWebSocket.instances[1];
    retry.close();

    expect(peer.disconnected).toBe(true);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  it('retains the RAM-only reconnect secret after conn close without putting it in the URL', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const peer = createGuestPeer();
    const conn = peer.connect('123456');
    const socket = FakeWebSocket.instances[0];
    expect(new URL(socket.url).searchParams.has('reconnectSecret')).toBe(false);
    socket.dispatch('open');
    await flushAsync();
    const firstSecret = sentOfType(socket, 'guest-auth')[0]?.reconnectSecret;
    expect(firstSecret).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '123456' }),
    );
    await flushAsync();
    expect(conn.open).toBe(true);
    expect(privateMaps(peer).guestReconnectSecrets.get('123456')).toBe(firstSecret);

    conn.close();
    peer.connect('123456');
    const replacement = FakeWebSocket.instances[1];
    expect(new URL(replacement.url).searchParams.has('reconnectSecret')).toBe(false);
    replacement.dispatch('open');
    await flushAsync();

    expect(sentOfType(replacement, 'guest-auth')[0]?.reconnectSecret).toBe(firstSecret);
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

  it('retries a rolling-deploy guest identity conflict after the legacy socket closes', async () => {
    const { peer, conn, socket } = await establishGuest();
    const onError = vi.fn();
    conn.on('error', onError);

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'error',
        errorType: 'guest-reconnect-conflict',
        message: 'GUEST_RECONNECT_CONFLICT',
      }),
    );
    await flushAsync();

    expect(onError).not.toHaveBeenCalled();
    expect(conn.open).toBe(true);
    expect(privateMaps(peer).guestRooms.get('123456')?.authFailed).toBe(false);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

    peer.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('does not retry a true reconnect-secret mismatch until an explicit re-join', async () => {
    const { peer, socket } = await establishGuest();

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'error',
        errorType: 'guest-reconnect-denied',
        message: 'GUEST_RECONNECT_DENIED',
      }),
    );
    await flushAsync();

    expect(privateMaps(peer).guestRooms.get('123456')?.authFailed).toBe(true);
    peer.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    peer.connect('123456');
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

    // UX contract: pre-establishment rejections drive the password dialog /
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
    await flushAsync();
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

  it('destroy() clears the guest reconnect registry and RAM-only secrets', () => {
    installFakeWebSocket();
    const peer = createGuestPeer();
    peer.connect('123456', { roomPassword: '12345678' });
    expect(privateMaps(peer).guestRooms.size).toBe(1);
    expect(privateMaps(peer).guestReconnectSecrets.size).toBe(1);

    peer.destroy();

    expect(privateMaps(peer).guestRooms.size).toBe(0);
    expect(privateMaps(peer).guestReconnectSecrets.size).toBe(0);
    expect(privateMaps(peer).roomSockets.size).toBe(0);
    expect(privateMaps(peer).connections.size).toBe(0);
  });
});
