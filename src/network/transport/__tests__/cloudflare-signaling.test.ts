/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../../core/constants.ts';
import { log } from '../../../core/log.ts';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import {
  __cloudflareSignalingForTests,
  CloudflareDataConnection,
  CloudflareSignalingPeer,
} from '../cloudflare-signaling.ts';
import type { TransportDataConnection, TransportMediaConnection } from '../types.ts';

const originalWebSocket = globalThis.WebSocket;
const DATA_CONNECTION_DISCONNECTED_GRACE_MS = 15_000;
const BACKGROUND_RESUME_DISCONNECTED_PROBE_MS = 1_000;
const BACKGROUND_RESUME_LIVENESS_TIMEOUT_MS = 3_000;
const originalRTCPeerConnection = globalThis.RTCPeerConnection;
const originalMediaStream = globalThis.MediaStream;
const NEGOTIATION_ID = 'negotiation_test_000001';
const NEXT_NEGOTIATION_ID = 'negotiation_test_000002';
const PRO_SIGNALING_WEBSOCKET_PROTOCOL = 'mxqr.pro-signaling.v1';
const PRO_SIGNALING_TICKET_PROTOCOL_PREFIX = 'mxqr.ticket.';
const PRIMARY_SIGNALING_URL = 'wss://signal.example.test/api/rooms';
const FALLBACK_SIGNALING_URL = 'wss://signal-alt.example.test/api/rooms';

type FakeSocketListener = (event: {
  data?: unknown;
  reason?: string;
  code?: number;
  wasClean?: boolean;
}) => void;
type FakeChannelListener = (event: { data?: unknown; error?: unknown }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static stallCloseWhileConnecting = false;

  readyState = FakeWebSocket.CONNECTING;
  closeCount = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<FakeSocketListener>>();

  readonly protocols: string[];

  constructor(
    readonly url: string,
    protocols: string | string[] = [],
  ) {
    this.protocols = typeof protocols === 'string' ? [protocols] : [...protocols];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: FakeSocketListener): void {
    const listeners = this.listeners.get(event) ?? new Set<FakeSocketListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, listener: FakeSocketListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closeCount++;
    if (FakeWebSocket.stallCloseWhileConnecting && this.readyState === FakeWebSocket.CONNECTING) {
      // iOS/CFNetwork regression model: close(CONNECTING) never reaches a
      // terminal event and poisons subsequent WebSocket work in the app.
      this.readyState = FakeWebSocket.CLOSING;
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
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
  static modelSignalingState = false;

  connectionState: RTCPeerConnectionState = 'connected';
  signalingState: RTCSignalingState = 'stable';
  localDescription: FakeLocalDescription | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly channels: FakeDataChannel[] = [];
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  readonly localDescriptionHistory: RTCSessionDescriptionInit[] = [];
  readonly remoteDescriptionHistory: RTCSessionDescriptionInit[] = [];
  readonly removedSenders: RTCRtpSender[] = [];
  rollbackCount = 0;
  private readonly senders: RTCRtpSender[] = [];
  private listeners = new Map<string, Set<FakeRTCListener>>();

  constructor(readonly configuration?: RTCConfiguration) {
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

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
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
    this.localDescriptionHistory.push({ ...description });
    if (description.type === 'rollback') {
      this.rollbackCount++;
      this.localDescription = null;
      this.remoteDescription = null;
      this.setSignalingState('stable');
      return;
    }
    const type = description.type ?? 'offer';
    const sdp = description.sdp ?? '';
    this.localDescription = { type, sdp, toJSON: () => ({ type, sdp }) };
    if (FakeRTCPeerConnection.modelSignalingState) {
      if (type === 'offer') this.setSignalingState('have-local-offer');
      else if (type === 'answer') this.setSignalingState('stable');
    }
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescriptionHistory.push({ ...description });
    if (description.type === 'rollback') {
      this.rollbackCount++;
      this.localDescription = null;
      this.remoteDescription = null;
      this.setSignalingState('stable');
      return;
    }
    this.remoteDescription = description;
    if (FakeRTCPeerConnection.modelSignalingState) {
      if (description.type === 'offer') this.setSignalingState('have-remote-offer');
      else if (description.type === 'answer') this.setSignalingState('stable');
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  addTrack(track: MediaStreamTrack): RTCRtpSender {
    const sender = { track } as RTCRtpSender;
    this.senders.push(sender);
    return sender;
  }

  removeTrack(sender: RTCRtpSender): void {
    const index = this.senders.indexOf(sender);
    if (index >= 0) this.senders.splice(index, 1);
    this.removedSenders.push(sender);
  }

  getSenders(): RTCRtpSender[] {
    return [...this.senders];
  }

  forceSignalingState(state: RTCSignalingState): void {
    this.setSignalingState(state);
  }

  close(): void {
    this.connectionState = 'closed';
    this.setSignalingState('closed');
    this.dispatch('connectionstatechange', {});
  }

  private setSignalingState(state: RTCSignalingState): void {
    if (this.signalingState === state) return;
    this.signalingState = state;
    this.dispatch('signalingstatechange', {});
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
  const signalingWorkerModulePath = '../../../../cloudflare/signaling-worker.ts';
  const workerModule = (await import(signalingWorkerModulePath)) as unknown as {
    MusixquareRoom: new (
      state: ContractWorkerState,
      env?: { MXQR_STANDARD_ROOM_PIN_PEPPER?: string },
    ) => ContractWorkerRoom;
  };
  return new workerModule.MusixquareRoom(new ContractWorkerState(), {
    MXQR_STANDARD_ROOM_PIN_PEPPER: 'contract-test-standard-room-pin-pepper-32-bytes-minimum',
  });
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
  FakeWebSocket.stallCloseWhileConnecting = false;
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
    return this.tracks.filter((track) => track.kind === 'audio');
  }

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
  }
}

function installFakeRTCPeerConnection(options: { modelSignalingState?: boolean } = {}): void {
  FakeRTCPeerConnection.instances = [];
  FakeRTCPeerConnection.modelSignalingState = options.modelSignalingState === true;
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
    signalingUrl: PRIMARY_SIGNALING_URL,
    config: { iceServers: [] },
  });
}

function createHostPeer(): CloudflareSignalingPeer {
  return new CloudflareSignalingPeer('123456', {
    provider: 'cloudflare',
    signalingUrl: PRIMARY_SIGNALING_URL,
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
  return `${payload}.${'s'.repeat(43)}`;
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

interface HttpBridgeHarness {
  readonly requests: Array<{ url: string; body: Record<string, unknown> | null }>;
  failNextOpen: boolean;
  readonly sendStatuses: number[];
  nextAuthorityFrame: Record<string, unknown> | null;
  nextTerminal: { code: number; reason: string } | null;
  requestCount(suffix: string): number;
}

function installHttpBridgeHarness(options: { admit?: boolean } = {}): HttpBridgeHarness {
  interface Session {
    readonly roomId: string;
    readonly peerId: string;
    authSent: boolean;
    authorityDelivered: boolean;
    pendingPoll: ((response: Response) => void) | null;
  }

  const admit = options.admit !== false;
  const sessions = new Map<string, Session>();
  const requests: HttpBridgeHarness['requests'] = [];
  let sessionSequence = 0;
  const harness: HttpBridgeHarness = {
    requests,
    failNextOpen: false,
    sendStatuses: [],
    nextAuthorityFrame: null,
    nextTerminal: null,
    requestCount(suffix: string): number {
      return requests.filter(({ url }) => url.endsWith(suffix)).length;
    },
  };

  const authorityResponse = (session: Session): Response => {
    session.authorityDelivered = true;
    const frame = harness.nextAuthorityFrame ?? {
      type: 'peer-open',
      peerId: session.peerId,
      roomId: session.roomId,
    };
    const terminal = harness.nextTerminal;
    harness.nextAuthorityFrame = null;
    harness.nextTerminal = null;
    return Response.json({
      v: 1,
      events: [{ sseq: 1, data: JSON.stringify(frame) }],
      ...(terminal ? { terminal } : {}),
    });
  };

  const pendingPoll = (session: Session, signal?: AbortSignal | null): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      session.pendingPoll = resolve;
      const abort = () => {
        if (session.pendingPoll === resolve) session.pendingPoll = null;
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });

  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ url, body });
    if (url.endsWith('/api/security-config')) {
      return Promise.resolve(Response.json({ capabilityRequired: false }));
    }
    if (url.endsWith('/bridge/open')) {
      if (harness.failNextOpen) {
        harness.failNextOpen = false;
        return Promise.reject(new TypeError('HTTP bridge route unavailable'));
      }
      const token = `session.${String(++sessionSequence).padStart(48, 'a')}`;
      sessions.set(token, {
        roomId: String(body?.roomId),
        peerId: String(body?.peerId),
        authSent: false,
        authorityDelivered: false,
        pendingPoll: null,
      });
      return Promise.resolve(Response.json({ sessionToken: token }));
    }

    const authorization = new Headers(init?.headers).get('Authorization') ?? '';
    const token = authorization.replace(/^Bearer\s+/u, '');
    const session = sessions.get(token);
    if (!session) return Promise.resolve(Response.json({}, { status: 401 }));
    if (url.endsWith('/bridge/send')) {
      const status = harness.sendStatuses.shift();
      if (status !== undefined) return Promise.resolve(Response.json({}, { status }));
      const frame = typeof body?.frame === 'string' ? JSON.parse(body.frame) : null;
      if (frame?.type === 'host-auth' || frame?.type === 'guest-auth') {
        session.authSent = true;
        if (admit && session.pendingPoll && !session.authorityDelivered) {
          const resolve = session.pendingPoll;
          session.pendingPoll = null;
          resolve(authorityResponse(session));
        }
      }
      return Promise.resolve(Response.json({ v: 1, ack: body?.cseq }));
    }
    if (url.endsWith('/bridge/poll')) {
      if (admit && session.authSent && !session.authorityDelivered) {
        return Promise.resolve(authorityResponse(session));
      }
      return pendingPoll(session, init?.signal);
    }
    if (url.endsWith('/bridge/close')) {
      return Promise.resolve(Response.json({ ok: true }));
    }
    throw new Error(`Unexpected HTTP bridge URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return harness;
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

async function establishGuestWithSignalingState(): Promise<{
  peer: CloudflareSignalingPeer;
  conn: TransportDataConnection;
  socket: FakeWebSocket;
  pc: FakeRTCPeerConnection;
}> {
  installFakeWebSocket();
  installFakeRTCPeerConnection({ modelSignalingState: true });
  const peer = createGuestPeer();
  const conn = peer.connect('123456');
  const socket = FakeWebSocket.instances[0];
  socket.dispatch('open');
  await flushAsync();
  socket.dispatch(
    'message',
    JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '123456' }),
  );
  await flushAsync();
  const pc = FakeRTCPeerConnection.instances[0];
  const dataOffer = sentOfType(socket, 'signal-offer')[0];
  socket.dispatch(
    'message',
    JSON.stringify({
      type: 'signal-answer',
      from: 'host',
      negotiationId: dataOffer?.negotiationId,
      sdp: { type: 'answer', sdp: 'data-answer' },
    }),
  );
  await vi.waitFor(() => expect(pc.signalingState).toBe('stable'));
  return { peer, conn, socket, pc };
}

async function establishHostWithSignalingState(peerId = 'guest-media'): Promise<{
  peer: CloudflareSignalingPeer;
  conn: TransportDataConnection;
  socket: FakeWebSocket;
  pc: FakeRTCPeerConnection;
}> {
  installFakeWebSocket();
  installFakeRTCPeerConnection({ modelSignalingState: true });
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
      from: peerId,
      negotiationId: NEGOTIATION_ID,
      sdp: { type: 'offer', sdp: 'guest-data-offer' },
    }),
  );
  await vi.waitFor(() => expect(sentOfType(socket, 'signal-answer')).toHaveLength(1));
  const pc = FakeRTCPeerConnection.instances[0];
  pc.dispatch('datachannel', { channel: new FakeDataChannel('musixquare-data') });
  pc.dispatch('datachannel', { channel: new FakeDataChannel('musixquare-control') });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const conn = privateMaps(peer).connections.get(peerId);
  if (!conn) throw new Error('HOST_DATA_CONNECTION_NOT_ESTABLISHED');
  return { peer, conn, socket, pc };
}

function fakeAudioStream(id: string): MediaStream {
  const stream = new FakeMediaStream();
  stream.addTrack({ id, kind: 'audio' } as MediaStreamTrack);
  return stream as unknown as MediaStream;
}

afterEach(() => {
  clearAllManagedTimers();
  __cloudflareSignalingForTests.resetPageSignalingSocketHandles();
  __cloudflareSignalingForTests.resetStandardHttpPreference();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

describe('Remote Share upload assertions', () => {
  const assertionRequest = {
    actorId: `rsa_${'a'.repeat(43)}`,
    requestId: `rs3_${'r'.repeat(43)}`,
    sessionId: 7,
    queueItemId: '10000000-0000-4000-8000-000000000001',
    size: 4,
    bodySha256: 'h'.repeat(43),
  };
  const assertionToken = `${'p'.repeat(80)}.${'s'.repeat(43)}`;

  async function admittedHost(advertise = true): Promise<{
    peer: CloudflareSignalingPeer;
    socket: FakeWebSocket;
  }> {
    installFakeWebSocket();
    const peer = createHostPeer();
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatch('open');
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'peer-open',
        peerId: '123456',
        roomId: '123456',
        ...(advertise ? { remoteShareUploadAssertionVersion: 1 } : {}),
      }),
    );
    await flushAsync();
    return { peer, socket };
  }

  it('sends requests only after the admitted Worker advertises support', async () => {
    const legacy = await admittedHost(false);
    await expect(
      legacy.peer.requestRemoteShareUploadAssertion(assertionRequest),
    ).resolves.toBeNull();
    expect(sentOfType(legacy.socket, 'remote-share-upload-assertion-request')).toHaveLength(0);
    legacy.peer.destroy();

    const current = await admittedHost();
    const pending = current.peer.requestRemoteShareUploadAssertion(assertionRequest);
    const request = sentOfType(current.socket, 'remote-share-upload-assertion-request')[0]!;
    expect(request).toMatchObject({
      type: 'remote-share-upload-assertion-request',
      ...assertionRequest,
    });
    expect(request.correlationId).toMatch(/^rsaq_[A-Za-z0-9_-]{32}$/);

    current.socket.dispatch(
      'message',
      JSON.stringify({
        type: 'remote-share-upload-assertion',
        correlationId: request.correlationId,
        assertion: assertionToken,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
    );
    await expect(pending).resolves.toBe(assertionToken);
    current.peer.destroy();
  });

  it('defers assertion expiry authority to the Worker when the browser clock is ahead', async () => {
    const { peer, socket } = await admittedHost();
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    const pending = peer.requestRemoteShareUploadAssertion(assertionRequest);
    const request = sentOfType(socket, 'remote-share-upload-assertion-request')[0]!;

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'remote-share-upload-assertion',
        correlationId: request.correlationId,
        assertion: assertionToken,
        // This is intentionally in the browser's apparent past. Only the
        // issuing/verifying Workers share the authoritative expiry clock.
        expiresAt: 1_800_000_060,
      }),
    );
    const flushed = flushAsync();
    await vi.advanceTimersByTimeAsync(0);
    await flushed;
    await vi.advanceTimersByTimeAsync(5_001);

    await expect(pending).resolves.toBe(assertionToken);
    peer.destroy();
  });

  it('correlates concurrent responses independently when they arrive out of order', async () => {
    const { peer, socket } = await admittedHost();
    const first = peer.requestRemoteShareUploadAssertion(assertionRequest);
    const second = peer.requestRemoteShareUploadAssertion({ ...assertionRequest, sessionId: 8 });
    const requests = sentOfType(socket, 'remote-share-upload-assertion-request');
    expect(requests).toHaveLength(2);

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'remote-share-upload-assertion',
        correlationId: requests[1]!.correlationId,
        assertion: `${'q'.repeat(80)}.${'t'.repeat(43)}`,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
    );
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'remote-share-upload-assertion',
        correlationId: requests[0]!.correlationId,
        assertion: assertionToken,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
    );

    await expect(first).resolves.toBe(assertionToken);
    await expect(second).resolves.toBe(`${'q'.repeat(80)}.${'t'.repeat(43)}`);
    peer.destroy();
  });

  it('rejects pending issuance on abort and socket close without legacy downgrade', async () => {
    const { peer, socket } = await admittedHost();
    const controller = new AbortController();
    const aborted = peer.requestRemoteShareUploadAssertion(assertionRequest, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toThrow('REMOTE_SHARE_UPLOAD_ASSERTION_ABORTED');

    const closed = peer.requestRemoteShareUploadAssertion({ ...assertionRequest, sessionId: 9 });
    socket.close();
    await expect(closed).rejects.toThrow('REMOTE_SHARE_UPLOAD_ASSERTION_SOCKET_CLOSED');
    await expect(
      peer.requestRemoteShareUploadAssertion({ ...assertionRequest, sessionId: 10 }),
    ).rejects.toThrow('REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE');

    peer.reconnect();
    const replacement = FakeWebSocket.instances.at(-1)!;
    expect(replacement).not.toBe(socket);
    replacement.dispatch('open');
    replacement.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();
    await expect(
      peer.requestRemoteShareUploadAssertion({ ...assertionRequest, sessionId: 11 }),
    ).rejects.toThrow('REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE');
    peer.destroy();
  });
});

describe('deferred RTC configuration', () => {
  async function createDeferredHost(): Promise<{
    peer: CloudflareSignalingPeer;
    socket: FakeWebSocket;
  }> {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [{ urls: 'stun:stun.example.test:3478' }] },
      deferRtcUntilConfigured: true,
    });
    await Promise.resolve();
    return { peer, socket: FakeWebSocket.instances[0] };
  }

  function dispatchOffer(
    socket: FakeWebSocket,
    negotiationId = NEGOTIATION_ID,
    from = 'guest-before-code-display',
  ): void {
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-offer',
        from,
        negotiationId,
        sdp: { type: 'offer', sdp: 'guest-offer' },
      }),
    );
  }

  async function admitDeferredHost(socket: FakeWebSocket): Promise<void> {
    socket.dispatch('open');
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();
  }

  function releaseWithTurn(peer: CloudflareSignalingPeer): RTCConfiguration {
    const configuration: RTCConfiguration = {
      iceServers: [
        { urls: 'stun:stun.example.test:3478' },
        {
          urls: 'turn:turn.example.test:3478',
          username: 'turn-user',
          credential: 'turn-secret',
        },
      ],
      bundlePolicy: 'max-bundle',
    };
    peer.setRtcConfiguration(configuration);
    return configuration;
  }

  it('blocks a guessed-code offer until the final TURN configuration is installed', async () => {
    const { peer, socket } = await createDeferredHost();
    await admitDeferredHost(socket);
    dispatchOffer(socket);
    await flushAsync();

    expect(FakeRTCPeerConnection.instances).toHaveLength(0);
    expect(sentOfType(socket, 'signal-answer')).toHaveLength(0);

    const configuration = releaseWithTurn(peer);
    await flushAsync();

    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    expect(FakeRTCPeerConnection.instances[0]?.configuration).toEqual(configuration);
    expect(sentOfType(socket, 'signal-answer')).toHaveLength(1);
    peer.destroy();
  });

  it('drops a gated offer when a newer peer-left arrives before TURN is ready', async () => {
    const { peer, socket } = await createDeferredHost();
    await admitDeferredHost(socket);
    dispatchOffer(socket);
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-left', peerId: 'guest-before-code-display' }),
    );
    await flushAsync();

    releaseWithTurn(peer);
    await flushAsync();

    expect(FakeRTCPeerConnection.instances).toHaveLength(0);
    expect(sentOfType(socket, 'signal-answer')).toHaveLength(0);
    peer.destroy();
  });

  it('negotiates only the newest replacement offer queued behind the TURN gate', async () => {
    const { peer, socket } = await createDeferredHost();
    await admitDeferredHost(socket);
    dispatchOffer(socket, NEGOTIATION_ID, 'guest-replacement');
    dispatchOffer(socket, NEXT_NEGOTIATION_ID, 'guest-replacement');
    await flushAsync();

    releaseWithTurn(peer);
    await flushAsync();

    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    expect(sentOfType(socket, 'signal-answer')).toEqual([
      expect.objectContaining({ negotiationId: NEXT_NEGOTIATION_ID }),
    ]);
    peer.destroy();
  });

  it('does not forward an old socket offer through its replacement after TURN becomes ready', async () => {
    const { peer, socket: oldSocket } = await createDeferredHost();
    await admitDeferredHost(oldSocket);
    dispatchOffer(oldSocket);
    await flushAsync();

    oldSocket.dispatch('close');
    peer.reconnect();
    const replacementSocket = FakeWebSocket.instances[1];
    replacementSocket.dispatch('open');
    releaseWithTurn(peer);
    await flushAsync();

    expect(FakeRTCPeerConnection.instances).toHaveLength(0);
    expect(sentOfType(oldSocket, 'signal-answer')).toHaveLength(0);
    expect(sentOfType(replacementSocket, 'signal-answer')).toHaveLength(0);
    peer.destroy();
  });
});

describe('standard-room account identity refresh', () => {
  it('keeps guest admission bounded at two seconds when an account assertion is slow', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const assertionProvider = vi.fn(
      () =>
        new Promise<{ accountAssertion: string; deletionAssertion: null }>((resolve) => {
          setTimeout(
            () =>
              resolve({ accountAssertion: 'late-admission-assertion', deletionAssertion: null }),
            2_500,
          );
        }),
    );
    const peer = new CloudflareSignalingPeer(null, {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    await Promise.resolve();
    peer.connect('123456');
    const socket = FakeWebSocket.instances[0];

    socket.dispatch('open');
    await vi.advanceTimersByTimeAsync(1_999);

    expect(assertionProvider).toHaveBeenCalledOnce();
    expect(sentOfType(socket, 'guest-auth')).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(sentOfType(socket, 'guest-auth')).toEqual([
      {
        type: 'guest-auth',
        password: '',
        reconnectSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
    ]);
    peer.destroy();
  });

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
        desiredRoomPassword: '',
        pinMutationId: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      },
    ]);
    expect(assertionProvider).not.toHaveBeenCalled();

    // A timer or account event may fire while a reconnecting host is still in
    // the Worker's asynchronous admission path. host-auth must remain the only
    // frame until peer-open proves admission for this exact socket.
    await peer.refreshStandardRoomIdentity();
    expect(assertionProvider).not.toHaveBeenCalled();
    expect(socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type)).toEqual([
      'host-auth',
    ]);

    const pinMutationId = sentOfType(socket, 'host-auth')[0]?.pinMutationId;
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'peer-open',
        peerId: '123456',
        roomId: '123456',
        roomPasswordMutationId: pinMutationId,
        roomPasswordApplied: true,
      }),
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

  it('waits for peer-open on the exact replacement host socket before refreshing identity', async () => {
    installFakeWebSocket();
    const assertionProvider = vi.fn(async () => ({
      accountAssertion: 'current-host-assertion',
      deletionAssertion: null,
    }));
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    await Promise.resolve();
    const originalSocket = FakeWebSocket.instances[0];
    originalSocket.dispatch('open');
    originalSocket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();
    assertionProvider.mockClear();

    originalSocket.close();
    peer.reconnect();
    const replacementSocket = FakeWebSocket.instances[1];
    replacementSocket.dispatch('open');

    await peer.refreshStandardRoomIdentity();
    expect(assertionProvider).not.toHaveBeenCalled();
    expect(replacementSocket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type)).toEqual(
      ['host-auth'],
    );

    originalSocket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();
    expect(assertionProvider).not.toHaveBeenCalled();
    expect(sentOfType(replacementSocket, 'account-identity-refresh')).toEqual([]);

    replacementSocket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();

    expect(assertionProvider).toHaveBeenCalledOnce();
    expect(sentOfType(replacementSocket, 'account-identity-refresh')).toEqual([
      {
        type: 'account-identity-refresh',
        accountAssertion: 'current-host-assertion',
      },
    ]);
    peer.destroy();
  });

  it('accepts a slow background renewal that exceeds the admission cutoff', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const assertionProvider = vi.fn(async () => ({
      accountAssertion: 'initial-assertion',
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
    await vi.advanceTimersByTimeAsync(0);
    assertionProvider.mockClear();
    socket.sent.length = 0;
    assertionProvider.mockImplementation(
      () =>
        new Promise<{ accountAssertion: string; deletionAssertion: null }>((resolve) => {
          setTimeout(
            () => resolve({ accountAssertion: 'slow-renewed-assertion', deletionAssertion: null }),
            2_500,
          );
        }),
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(assertionProvider).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(assertionProvider).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_499);
    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([
      {
        type: 'account-identity-refresh',
        accountAssertion: 'slow-renewed-assertion',
      },
    ]);
    peer.destroy();
  });

  it('keeps a background identity send failure non-fatal to the active room transport', async () => {
    installFakeWebSocket();
    const assertionProvider = vi.fn(async () => ({
      accountAssertion: 'background-identity-assertion',
      deletionAssertion: null,
    }));
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    const fatalErrors = vi.fn();
    peer.on('error', fatalErrors);
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();

    const sendFailure = vi.spyOn(socket, 'send').mockImplementation(() => {
      throw new Error('socket send failed during background identity refresh');
    });
    peer.deleteStandardRoomIdentity();
    await flushAsync();

    expect(sendFailure).toHaveBeenCalled();
    expect(fatalErrors).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    peer.destroy();
  });

  it('drops an older authenticated renewal after a newer explicit clear', async () => {
    installFakeWebSocket();
    const oldRenewal = deferred<{ accountAssertion: string; deletionAssertion: null }>();
    const assertionProvider = vi
      .fn()
      .mockImplementationOnce(() => oldRenewal.promise)
      .mockResolvedValueOnce({ accountAssertion: null, deletionAssertion: null });
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

    await peer.refreshStandardRoomIdentity();
    expect(sentOfType(socket, 'account-identity-clear')).toEqual([
      { type: 'account-identity-clear' },
    ]);

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-identity',
        memberIdentity: null,
        clearReason: 'explicit',
      }),
    );
    await flushAsync();
    oldRenewal.resolve({
      accountAssertion: 'stale-authenticated-assertion',
      deletionAssertion: null,
    });
    await flushAsync();

    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([]);
    expect(sentOfType(socket, 'account-identity-clear')).toHaveLength(1);
    peer.destroy();
  });

  it('drops an older authenticated renewal after a newer deletion proof', async () => {
    installFakeWebSocket();
    const oldRenewal = deferred<{ accountAssertion: string; deletionAssertion: null }>();
    const assertionProvider = vi
      .fn()
      .mockImplementationOnce(() => oldRenewal.promise)
      .mockResolvedValueOnce({
        accountAssertion: null,
        deletionAssertion: 'newer-deletion-proof',
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
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(assertionProvider).toHaveBeenCalledOnce();

    peer.deleteStandardRoomIdentity();
    await flushAsync();
    expect(sentOfType(socket, 'account-identity-delete')).toEqual([
      {
        type: 'account-identity-delete',
        deletionAssertion: 'newer-deletion-proof',
      },
    ]);

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-identity',
        memberIdentity: null,
        clearReason: 'deleted',
      }),
    );
    await flushAsync();
    oldRenewal.resolve({
      accountAssertion: 'stale-authenticated-assertion',
      deletionAssertion: null,
    });
    await flushAsync();

    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([]);
    expect(sentOfType(socket, 'account-identity-delete')).toHaveLength(1);
    peer.destroy();
  });

  it('keeps the expiry retry armed while allowing an in-flight renewal to finish', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const oldRenewal = deferred<{ accountAssertion: string; deletionAssertion: null }>();
    const assertionProvider = vi
      .fn()
      .mockImplementationOnce(() => oldRenewal.promise)
      .mockResolvedValueOnce({
        accountAssertion: 'post-expiry-renewal',
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
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(assertionProvider).toHaveBeenCalledOnce();

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-identity',
        memberIdentity: null,
        clearReason: 'expired',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    oldRenewal.resolve({
      accountAssertion: 'stale-authenticated-assertion',
      deletionAssertion: null,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([
      {
        type: 'account-identity-refresh',
        accountAssertion: 'stale-authenticated-assertion',
      },
    ]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(assertionProvider).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(assertionProvider).toHaveBeenCalledTimes(2);
    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([
      {
        type: 'account-identity-refresh',
        accountAssertion: 'stale-authenticated-assertion',
      },
      {
        type: 'account-identity-refresh',
        accountAssertion: 'post-expiry-renewal',
      },
    ]);
    peer.destroy();
  });

  it('keeps a newer authenticated refresh alive after an older explicit-clear ack', async () => {
    installFakeWebSocket();
    const newerRefresh = deferred<{ accountAssertion: string; deletionAssertion: null }>();
    const assertionProvider = vi
      .fn()
      .mockResolvedValueOnce({ accountAssertion: null, deletionAssertion: null })
      .mockImplementationOnce(() => newerRefresh.promise);
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
    await flushAsync();

    expect(assertionProvider).toHaveBeenCalledOnce();
    expect(sentOfType(socket, 'account-identity-clear')).toHaveLength(1);

    const latestOperation = peer.refreshStandardRoomIdentity();
    await Promise.resolve();
    expect(assertionProvider).toHaveBeenCalledTimes(2);

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-identity',
        memberIdentity: null,
        clearReason: 'explicit',
      }),
    );
    await flushAsync();

    newerRefresh.resolve({
      accountAssertion: 'newer-authenticated-assertion',
      deletionAssertion: null,
    });
    await latestOperation;

    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([
      {
        type: 'account-identity-refresh',
        accountAssertion: 'newer-authenticated-assertion',
      },
    ]);
    peer.destroy();
  });

  it('preserves a newer retry timer when an older explicit-clear ack arrives late', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const assertionProvider = vi
      .fn()
      .mockResolvedValueOnce({ accountAssertion: null, deletionAssertion: null })
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({
        accountAssertion: 'retried-after-delayed-clear-ack',
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
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sentOfType(socket, 'account-identity-clear')).toHaveLength(1);

    const timedOutRefresh = peer.refreshStandardRoomIdentity();
    await vi.advanceTimersByTimeAsync(15_000);
    await timedOutRefresh;
    expect(assertionProvider).toHaveBeenCalledTimes(2);

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-identity',
        memberIdentity: null,
        clearReason: 'explicit',
      }),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(assertionProvider).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(assertionProvider).toHaveBeenCalledTimes(3);
    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([
      {
        type: 'account-identity-refresh',
        accountAssertion: 'retried-after-delayed-clear-ack',
      },
    ]);
    peer.destroy();
  });

  it('drops a rapid re-login result after any deleted projection and replays only latest state', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const newerRefresh = deferred<{ accountAssertion: string; deletionAssertion: null }>();
    const assertionProvider = vi
      .fn()
      .mockResolvedValueOnce({
        accountAssertion: null,
        deletionAssertion: 'unacknowledged-deletion-proof',
      })
      .mockImplementationOnce(() => newerRefresh.promise)
      .mockResolvedValueOnce({
        accountAssertion: 'latest-relogin-assertion',
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
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(sentOfType(socket, 'account-identity-delete')).toHaveLength(1);

    const rapidRelogin = peer.refreshStandardRoomIdentity();
    await vi.advanceTimersByTimeAsync(0);
    expect(assertionProvider).toHaveBeenCalledTimes(2);

    // This may be the local proof's delayed ack or a sibling device's external
    // deletion. Deleted projections are deliberately not correlated to a
    // client-side request because an invalid proof receives no ack.
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-identity',
        memberIdentity: null,
        clearReason: 'deleted',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    newerRefresh.resolve({
      accountAssertion: 'superseded-relogin-assertion',
      deletionAssertion: null,
    });
    await rapidRelogin;
    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(assertionProvider).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(assertionProvider).toHaveBeenCalledTimes(3);
    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([
      {
        type: 'account-identity-refresh',
        accountAssertion: 'latest-relogin-assertion',
      },
    ]);
    peer.destroy();
  });

  it('does not loop deletion refreshes when no newer assertion request was cancelled', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const assertionProvider = vi.fn(async () => ({
      accountAssertion: null,
      deletionAssertion: 'ordinary-deletion-proof',
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
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(assertionProvider).toHaveBeenCalledOnce();

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-identity',
        memberIdentity: null,
        clearReason: 'deleted',
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(assertionProvider).toHaveBeenCalledOnce();
    expect(sentOfType(socket, 'account-identity-delete')).toHaveLength(1);
    peer.destroy();
  });

  it.each([
    {
      label: 'clear',
      currentAssertions: { accountAssertion: null, deletionAssertion: null },
      outgoingType: 'account-identity-clear',
      expectedOutgoing: { type: 'account-identity-clear' },
    },
    {
      label: 'deletion',
      currentAssertions: {
        accountAssertion: null,
        deletionAssertion: 'current-admission-deletion-proof',
      },
      outgoingType: 'account-identity-delete',
      expectedOutgoing: {
        type: 'account-identity-delete',
        deletionAssertion: 'current-admission-deletion-proof',
      },
    },
  ] as const)(
    'keeps guest-auth first after a newer identity $label supersedes its assertion',
    async ({ currentAssertions, outgoingType, expectedOutgoing }) => {
      installFakeWebSocket();
      installFakeRTCPeerConnection();
      const oldAdmission = deferred<{ accountAssertion: string; deletionAssertion: null }>();
      const assertionProvider = vi
        .fn()
        .mockImplementationOnce(() => oldAdmission.promise)
        .mockResolvedValueOnce(currentAssertions);
      const peer = new CloudflareSignalingPeer(null, {
        provider: 'cloudflare',
        signalingUrl: 'wss://signal.example.test/api/rooms',
        config: { iceServers: [] },
        standardRoomAssertionProvider: assertionProvider,
      });
      await Promise.resolve();
      peer.connect('123456');
      const socket = FakeWebSocket.instances[0];
      socket.dispatch('open');
      await Promise.resolve();
      expect(assertionProvider).toHaveBeenCalledOnce();

      await peer.refreshStandardRoomIdentity();
      expect(assertionProvider).toHaveBeenCalledOnce();
      expect(socket.sent).toEqual([]);

      oldAdmission.resolve({
        accountAssertion: 'stale-admission-assertion',
        deletionAssertion: null,
      });
      await flushAsync();

      expect(sentOfType(socket, 'guest-auth')).toEqual([
        {
          type: 'guest-auth',
          password: '',
          reconnectSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        },
      ]);
      expect((JSON.parse(socket.sent[0]) as { type: string }).type).toBe('guest-auth');
      expect(sentOfType(socket, outgoingType)).toEqual([]);

      socket.dispatch(
        'message',
        JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '123456' }),
      );
      await flushAsync();

      expect(assertionProvider).toHaveBeenCalledTimes(2);
      expect(sentOfType(socket, outgoingType)).toEqual([expectedOutgoing]);
      peer.destroy();
    },
  );

  it('replays the latest projection after deletion supersedes pending guest admission', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const pendingGuestAdmission = deferred<{
      accountAssertion: string;
      deletionAssertion: null;
    }>();
    const assertionProvider = vi
      .fn()
      .mockResolvedValueOnce({
        accountAssertion: 'initial-host-assertion',
        deletionAssertion: null,
      })
      .mockImplementationOnce(() => pendingGuestAdmission.promise)
      .mockResolvedValue({ accountAssertion: null, deletionAssertion: null });
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    await Promise.resolve();
    const hostSocket = FakeWebSocket.instances[0];
    hostSocket.dispatch('open');
    hostSocket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();

    peer.connect('654321');
    const guestSocket = FakeWebSocket.instances[1];
    guestSocket.dispatch('open');
    await Promise.resolve();
    expect(assertionProvider).toHaveBeenCalledTimes(2);

    hostSocket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-identity',
        memberIdentity: null,
        clearReason: 'deleted',
      }),
    );
    await flushAsync();

    pendingGuestAdmission.resolve({
      accountAssertion: 'stale-guest-admission-assertion',
      deletionAssertion: null,
    });
    await flushAsync();
    expect(sentOfType(guestSocket, 'guest-auth')[0]).not.toHaveProperty('accountAssertion');
    expect(sentOfType(guestSocket, 'account-identity-clear')).toEqual([]);

    guestSocket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '654321' }),
    );
    await flushAsync();

    // The logical refresh projects the same newest account snapshot onto both
    // admitted sockets independently.
    expect(assertionProvider).toHaveBeenCalledTimes(4);
    expect(sentOfType(guestSocket, 'account-identity-clear')).toEqual([
      { type: 'account-identity-clear' },
    ]);
    peer.destroy();
  });

  it('replays a queued identity refresh only after the exact reconnect socket is admitted', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const assertionProvider = vi.fn(async () => ({
      accountAssertion: 'initial-guest-assertion',
      deletionAssertion: null,
    }));
    const peer = new CloudflareSignalingPeer(null, {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    await Promise.resolve();
    const conn = peer.connect('123456');
    const originalSocket = FakeWebSocket.instances[0];
    originalSocket.dispatch('open');
    await flushAsync();
    originalSocket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '123456' }),
    );
    await flushAsync();
    expect(conn.open).toBe(true);

    const replacementAdmission = deferred<{
      accountAssertion: string;
      deletionAssertion: null;
    }>();
    assertionProvider
      .mockImplementationOnce(() => replacementAdmission.promise)
      .mockResolvedValueOnce({
        accountAssertion: 'current-reconnect-assertion',
        deletionAssertion: null,
      });
    assertionProvider.mockClear();

    originalSocket.close();
    peer.reconnect();
    const replacementSocket = FakeWebSocket.instances[1];
    replacementSocket.dispatch('open');
    await Promise.resolve();
    expect(assertionProvider).toHaveBeenCalledOnce();

    await peer.refreshStandardRoomIdentity();
    expect(assertionProvider).toHaveBeenCalledOnce();
    expect(replacementSocket.sent).toEqual([]);

    // A delayed peer-open from the replaced socket cannot admit or replay the
    // identity refresh for the current socket.
    originalSocket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '123456' }),
    );
    await flushAsync();
    expect(assertionProvider).toHaveBeenCalledOnce();
    expect(replacementSocket.sent).toEqual([]);

    replacementAdmission.resolve({
      accountAssertion: 'stale-reconnect-assertion',
      deletionAssertion: null,
    });
    await flushAsync();
    expect((JSON.parse(replacementSocket.sent[0]) as { type: string }).type).toBe('guest-auth');
    expect(sentOfType(replacementSocket, 'guest-auth')[0]).not.toHaveProperty('accountAssertion');
    expect(sentOfType(replacementSocket, 'account-identity-refresh')).toEqual([]);

    replacementSocket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '123456' }),
    );
    await flushAsync();

    expect(assertionProvider).toHaveBeenCalledTimes(2);
    expect(sentOfType(replacementSocket, 'account-identity-refresh')).toEqual([
      {
        type: 'account-identity-refresh',
        accountAssertion: 'current-reconnect-assertion',
      },
    ]);
    peer.destroy();
  });

  it('gathers every target in a multi-room refresh before projecting any result', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const assertionProvider = vi.fn(async () => ({
      accountAssertion: 'bootstrap-assertion',
      deletionAssertion: null,
    }));
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    await Promise.resolve();
    const hostSocket = FakeWebSocket.instances[0];
    hostSocket.dispatch('open');
    hostSocket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();

    peer.connect('654321');
    const guestSocket = FakeWebSocket.instances[1];
    guestSocket.dispatch('open');
    await flushAsync();
    guestSocket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '654321' }),
    );
    await flushAsync();
    assertionProvider.mockClear();
    hostSocket.sent.length = 0;
    guestSocket.sent.length = 0;

    const hostRenewal = deferred<{ accountAssertion: string; deletionAssertion: null }>();
    const guestRenewal = deferred<{ accountAssertion: string; deletionAssertion: null }>();
    assertionProvider
      .mockImplementationOnce(() => hostRenewal.promise)
      .mockImplementationOnce(() => guestRenewal.promise);

    const refresh = peer.refreshStandardRoomIdentity();
    await Promise.resolve();
    expect(assertionProvider).toHaveBeenCalledTimes(2);

    guestRenewal.resolve({ accountAssertion: 'guest-renewal', deletionAssertion: null });
    await flushAsync();
    expect(sentOfType(guestSocket, 'account-identity-refresh')).toEqual([]);
    expect(sentOfType(hostSocket, 'account-identity-refresh')).toEqual([]);

    hostRenewal.resolve({ accountAssertion: 'host-renewal', deletionAssertion: null });
    await refresh;
    expect(sentOfType(hostSocket, 'account-identity-refresh')).toEqual([
      { type: 'account-identity-refresh', accountAssertion: 'host-renewal' },
    ]);
    expect(sentOfType(guestSocket, 'account-identity-refresh')).toEqual([
      { type: 'account-identity-refresh', accountAssertion: 'guest-renewal' },
    ]);
    peer.destroy();
  });

  it.each(['host-first', 'deletion-first'] as const)(
    'makes deletion generation-wide when mixed target results resolve %s',
    async (resolutionOrder) => {
      vi.useFakeTimers();
      installFakeWebSocket();
      installFakeRTCPeerConnection();
      const assertionProvider = vi.fn(async () => ({
        accountAssertion: 'bootstrap-assertion' as string | null,
        deletionAssertion: null as string | null,
      }));
      const peer = new CloudflareSignalingPeer('123456', {
        provider: 'cloudflare',
        signalingUrl: 'wss://signal.example.test/api/rooms',
        config: { iceServers: [] },
        standardRoomAssertionProvider: assertionProvider,
      });
      await Promise.resolve();
      const hostSocket = FakeWebSocket.instances[0];
      hostSocket.dispatch('open');
      hostSocket.dispatch(
        'message',
        JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
      );
      await vi.advanceTimersByTimeAsync(0);

      peer.connect('654321');
      const guestSocket = FakeWebSocket.instances[1];
      guestSocket.dispatch('open');
      await vi.advanceTimersByTimeAsync(0);
      guestSocket.dispatch(
        'message',
        JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '654321' }),
      );
      await vi.advanceTimersByTimeAsync(0);

      assertionProvider.mockClear();
      hostSocket.sent.length = 0;
      guestSocket.sent.length = 0;
      const staleHost = deferred<{ accountAssertion: string; deletionAssertion: null }>();
      const deletedGuest = deferred<{ accountAssertion: null; deletionAssertion: string }>();
      assertionProvider
        .mockImplementationOnce(() => staleHost.promise)
        .mockImplementationOnce(() => deletedGuest.promise)
        .mockResolvedValue({
          accountAssertion: null,
          deletionAssertion: 'latest-deletion-proof',
        });

      const refresh = peer.refreshStandardRoomIdentity();
      await vi.advanceTimersByTimeAsync(0);
      expect(assertionProvider).toHaveBeenCalledTimes(2);

      if (resolutionOrder === 'host-first') {
        staleHost.resolve({
          accountAssertion: 'pre-delete-host-assertion',
          deletionAssertion: null,
        });
      } else {
        deletedGuest.resolve({
          accountAssertion: null,
          deletionAssertion: 'guest-deletion-proof',
        });
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(sentOfType(hostSocket, 'account-identity-refresh')).toEqual([]);
      expect(sentOfType(hostSocket, 'account-identity-clear')).toEqual([]);
      expect(sentOfType(hostSocket, 'account-identity-delete')).toEqual([]);
      expect(sentOfType(guestSocket, 'account-identity-delete')).toEqual([]);

      if (resolutionOrder === 'host-first') {
        deletedGuest.resolve({
          accountAssertion: null,
          deletionAssertion: 'guest-deletion-proof',
        });
      } else {
        staleHost.resolve({
          accountAssertion: 'pre-delete-host-assertion',
          deletionAssertion: null,
        });
      }
      await vi.advanceTimersByTimeAsync(0);
      await refresh;

      // The stale host assertion is suppressed even when it completed before
      // the deletion proof. Only the target-bound proof is sent now.
      expect(sentOfType(hostSocket, 'account-identity-refresh')).toEqual([]);
      expect(sentOfType(hostSocket, 'account-identity-clear')).toEqual([]);
      expect(sentOfType(hostSocket, 'account-identity-delete')).toEqual([]);
      expect(sentOfType(guestSocket, 'account-identity-delete')).toEqual([
        { type: 'account-identity-delete', deletionAssertion: 'guest-deletion-proof' },
      ]);

      // A delayed deleted projection must not erase the dedicated one-shot
      // reconciliation for the host that lacked a deletion proof.
      await vi.advanceTimersByTimeAsync(4_000);
      guestSocket.dispatch(
        'message',
        JSON.stringify({
          type: 'account-identity',
          memberIdentity: null,
          clearReason: 'deleted',
        }),
      );
      await vi.advanceTimersByTimeAsync(999);
      expect(assertionProvider).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(assertionProvider).toHaveBeenCalledTimes(4);
      expect(sentOfType(hostSocket, 'account-identity-delete')).toEqual([
        { type: 'account-identity-delete', deletionAssertion: 'latest-deletion-proof' },
      ]);
      expect(sentOfType(guestSocket, 'account-identity-delete')).toEqual([
        { type: 'account-identity-delete', deletionAssertion: 'guest-deletion-proof' },
        { type: 'account-identity-delete', deletionAssertion: 'latest-deletion-proof' },
      ]);

      hostSocket.dispatch(
        'message',
        JSON.stringify({
          type: 'account-identity',
          memberIdentity: null,
          clearReason: 'deleted',
        }),
      );
      guestSocket.dispatch(
        'message',
        JSON.stringify({
          type: 'account-identity',
          memberIdentity: null,
          clearReason: 'deleted',
        }),
      );
      await vi.advanceTimersByTimeAsync(10_000);

      expect(assertionProvider).toHaveBeenCalledTimes(4);
      peer.destroy();
    },
  );

  it.each(['host-first', 'clear-first'] as const)(
    'makes authoritative clear generation-wide when mixed target results resolve %s',
    async (resolutionOrder) => {
      vi.useFakeTimers();
      installFakeWebSocket();
      installFakeRTCPeerConnection();
      const assertionProvider = vi.fn(async () => ({
        accountAssertion: 'bootstrap-assertion' as string | null,
        deletionAssertion: null as string | null,
      }));
      const peer = new CloudflareSignalingPeer('123456', {
        provider: 'cloudflare',
        signalingUrl: 'wss://signal.example.test/api/rooms',
        config: { iceServers: [] },
        standardRoomAssertionProvider: assertionProvider,
      });
      await Promise.resolve();
      const hostSocket = FakeWebSocket.instances[0];
      hostSocket.dispatch('open');
      hostSocket.dispatch(
        'message',
        JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
      );
      await vi.advanceTimersByTimeAsync(0);

      peer.connect('654321');
      const guestSocket = FakeWebSocket.instances[1];
      guestSocket.dispatch('open');
      await vi.advanceTimersByTimeAsync(0);
      guestSocket.dispatch(
        'message',
        JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '654321' }),
      );
      await vi.advanceTimersByTimeAsync(0);

      const memberIdentity = {
        memberId: 'member_abcdefghijklmnopqrstuv',
        memberDisplayNumber: 0,
        nickname: 'Minsu',
        isAuthenticated: true,
      };
      for (const socket of [hostSocket, guestSocket]) {
        socket.dispatch('message', JSON.stringify({ type: 'account-identity', memberIdentity }));
      }
      await vi.advanceTimersByTimeAsync(0);

      assertionProvider.mockClear();
      hostSocket.sent.length = 0;
      guestSocket.sent.length = 0;
      const staleHost = deferred<{ accountAssertion: string; deletionAssertion: null }>();
      const clearedGuest = deferred<{ accountAssertion: null; deletionAssertion: null }>();
      assertionProvider
        .mockImplementationOnce(() => staleHost.promise)
        .mockImplementationOnce(() => clearedGuest.promise);

      const refresh = peer.refreshStandardRoomIdentity();
      await vi.advanceTimersByTimeAsync(0);
      expect(assertionProvider).toHaveBeenCalledTimes(2);

      if (resolutionOrder === 'host-first') {
        staleHost.resolve({
          accountAssertion: 'pre-logout-host-assertion',
          deletionAssertion: null,
        });
      } else {
        clearedGuest.resolve({ accountAssertion: null, deletionAssertion: null });
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(sentOfType(hostSocket, 'account-identity-refresh')).toEqual([]);
      expect(sentOfType(hostSocket, 'account-identity-clear')).toEqual([]);
      expect(sentOfType(guestSocket, 'account-identity-clear')).toEqual([]);

      if (resolutionOrder === 'host-first') {
        clearedGuest.resolve({ accountAssertion: null, deletionAssertion: null });
      } else {
        staleHost.resolve({
          accountAssertion: 'pre-logout-host-assertion',
          deletionAssertion: null,
        });
      }
      await vi.advanceTimersByTimeAsync(0);
      await refresh;

      expect(sentOfType(hostSocket, 'account-identity-refresh')).toEqual([]);
      expect(sentOfType(guestSocket, 'account-identity-refresh')).toEqual([]);
      expect(sentOfType(hostSocket, 'account-identity-clear')).toEqual([
        { type: 'account-identity-clear' },
      ]);
      expect(sentOfType(guestSocket, 'account-identity-clear')).toEqual([
        { type: 'account-identity-clear' },
      ]);

      for (const socket of [hostSocket, guestSocket]) {
        socket.dispatch(
          'message',
          JSON.stringify({
            type: 'account-identity',
            memberIdentity: null,
            clearReason: 'explicit',
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(60_000);

      // The pre-existing renewal and every transient/deletion retry are gone;
      // delayed ordered clear acks are timer no-ops.
      expect(assertionProvider).toHaveBeenCalledTimes(2);
      peer.destroy();
    },
  );

  it('retries a timed-out background renewal five seconds later', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const assertionProvider = vi.fn(async () => ({
      accountAssertion: 'initial-assertion',
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
    await vi.advanceTimersByTimeAsync(0);
    assertionProvider.mockClear();
    socket.sent.length = 0;
    assertionProvider.mockImplementation(() => new Promise(() => {}));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(assertionProvider).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(assertionProvider).toHaveBeenCalledOnce();
    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(assertionProvider).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(assertionProvider).toHaveBeenCalledTimes(2);
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
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
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
    await flushAsync();
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

  it('keeps a pending retry when a sibling identity projection arrives', async () => {
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

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-identity',
        memberIdentity: {
          memberId: 'member_abcdefghijklmnopqrstuv',
          memberDisplayNumber: 0,
          nickname: 'Minsu',
          isAuthenticated: true,
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
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
    await vi.advanceTimersByTimeAsync(0);
    assertionProvider.mockClear();
    socket.sent.length = 0;

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-identity',
        memberIdentity: null,
        clearReason: 'expired',
      }),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(assertionProvider).not.toHaveBeenCalled();
    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(assertionProvider).toHaveBeenCalledOnce();
    expect(sentOfType(socket, 'account-identity-refresh')).toContainEqual({
      type: 'account-identity-refresh',
      accountAssertion: 'renewed-assertion',
    });
    peer.destroy();
  });

  it('cancels a pending identity refresh when the identity is explicitly cleared', async () => {
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
    await vi.advanceTimersByTimeAsync(0);
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    assertionProvider.mockClear();
    socket.sent.length = 0;

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'account-identity',
        memberIdentity: {
          memberId: 'member_abcdefghijklmnopqrstuv',
          memberDisplayNumber: 0,
          nickname: 'Minsu',
          isAuthenticated: true,
        },
      }),
    );
    socket.dispatch('message', JSON.stringify({ type: 'account-identity', memberIdentity: null }));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(assertionProvider).not.toHaveBeenCalled();
    expect(sentOfType(socket, 'account-identity-refresh')).toEqual([]);
    peer.destroy();
  });

  it('does not postpone its own identity refresh when a sibling device updates the account identity', async () => {
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
    await vi.advanceTimersByTimeAsync(0);
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    assertionProvider.mockClear();
    socket.sent.length = 0;

    const memberIdentity = {
      memberId: 'member_abcdefghijklmnopqrstuv',
      memberDisplayNumber: 0,
      nickname: 'Minsu',
      isAuthenticated: true,
    };
    socket.dispatch('message', JSON.stringify({ type: 'account-identity', memberIdentity }));
    await vi.advanceTimersByTimeAsync(20_000);

    // The Worker sends this projection when another same-account device renews,
    // but it deliberately does not extend this socket's independent lease.
    socket.dispatch('message', JSON.stringify({ type: 'account-identity', memberIdentity }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(assertionProvider).toHaveBeenCalledOnce();
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
      signalingFallbackUrl: FALLBACK_SIGNALING_URL,
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
    expect(peer.recommendedPeerOpenTimeoutMs).toBeUndefined();
    await Promise.resolve();

    const socket = FakeWebSocket.instances[0];
    const url = new URL(socket.url);
    expect(url.origin).toBe('wss://signal.example.test');
    expect(url.pathname).toBe('/api/pro-rooms/000001/ws');
    expect(url.search).toBe('');
    expect(socket.protocols).toEqual([
      PRO_SIGNALING_WEBSOCKET_PROTOCOL,
      `${PRO_SIGNALING_TICKET_PROTOCOL_PREFIX}${ticket}`,
    ]);

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
    expect(new URL(reconnected.url).search).toBe('');
    expect(reconnected.protocols).toEqual([
      PRO_SIGNALING_WEBSOCKET_PROTOCOL,
      `${PRO_SIGNALING_TICKET_PROTOCOL_PREFIX}${refreshedTicket}`,
    ]);
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
    expect(new URL(FakeWebSocket.instances[1].url).search).toBe('');
    expect(FakeWebSocket.instances[1].protocols).toEqual([
      PRO_SIGNALING_WEBSOCKET_PROTOCOL,
      `${PRO_SIGNALING_TICKET_PROTOCOL_PREFIX}${initialTicket}`,
    ]);
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
    expect(FakeWebSocket.instances[0].protocols).toEqual([]);
    peer.destroy();
  });

  it('derives a member identity from its signed payload and skips ordinary guest-auth', () => {
    installFakeWebSocket();
    const ticket = clientProTicket('stable-pro-member');
    const peer = new CloudflareSignalingPeer(null, {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      signalingFallbackUrl: FALLBACK_SIGNALING_URL,
      config: { iceServers: [] },
      prepareNetworkRouteRetry: async () => null,
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
    const conn = peer.connect('000001');
    expect(conn.recommendedPreOpenTimeoutMs).toBeUndefined();
    const socket = FakeWebSocket.instances[0];
    const url = new URL(socket.url);
    expect(url.pathname).toBe('/api/pro-rooms/000001/ws');
    expect(url.search).toBe('');
    expect(socket.protocols).toEqual([
      PRO_SIGNALING_WEBSOCKET_PROTOCOL,
      `${PRO_SIGNALING_TICKET_PROTOCOL_PREFIX}${ticket}`,
    ]);
    socket.dispatch('open');
    expect(sentOfType(socket, 'guest-auth')).toHaveLength(0);
    expect(() => peer.connect('000000')).toThrowError('PRO_SIGNALING_ROOM_MISMATCH');
    peer.destroy();
  });
});

describe('Cloudflare client/Worker signaling contract', () => {
  it('keeps guest-auth first and replays a superseding identity clear only after admission', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const room = await createContractWorkerRoom();

    const hostPeer = createHostPeer();
    await Promise.resolve();
    const hostClientSocket = FakeWebSocket.instances[0];
    hostClientSocket.dispatch('open');
    await flushAsync();
    const hostUrl = new URL(hostClientSocket.url);
    const hostServerSocket = new ContractWorkerSocket();
    room.acceptPendingHost(hostServerSocket, '123456', hostUrl.searchParams.get('peerId') || '');
    await room.webSocketMessage(
      hostServerSocket,
      JSON.stringify(sentOfType(hostClientSocket, 'host-auth')[0]),
    );
    hostClientSocket.dispatch(
      'message',
      JSON.stringify(workerSentOfType(hostServerSocket, 'peer-open')[0]),
    );
    await flushAsync();
    await room.webSocketMessage(
      hostServerSocket,
      JSON.stringify(sentOfType(hostClientSocket, 'room-password-set')[0]),
    );

    const oldAdmission = deferred<{ accountAssertion: string; deletionAssertion: null }>();
    const assertionProvider = vi
      .fn()
      .mockImplementationOnce(() => oldAdmission.promise)
      .mockResolvedValueOnce({ accountAssertion: null, deletionAssertion: null });
    const guestPeer = new CloudflareSignalingPeer(null, {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      standardRoomAssertionProvider: assertionProvider,
    });
    await Promise.resolve();
    guestPeer.connect('123456');
    const guestClientSocket = FakeWebSocket.instances[1];
    const guestUrl = new URL(guestClientSocket.url);
    const guestServerSocket = new ContractWorkerSocket();
    await room.acceptGuest(guestServerSocket, '123456', guestUrl.searchParams.get('peerId') || '');

    guestClientSocket.dispatch('open');
    await Promise.resolve();
    expect(assertionProvider).toHaveBeenCalledOnce();

    await guestPeer.refreshStandardRoomIdentity();
    expect(assertionProvider).toHaveBeenCalledOnce();
    expect(guestClientSocket.sent).toEqual([]);

    oldAdmission.resolve({
      accountAssertion: 'superseded-admission-assertion',
      deletionAssertion: null,
    });
    await flushAsync();

    const firstFrame = JSON.parse(guestClientSocket.sent[0]) as Record<string, unknown>;
    expect(firstFrame).toMatchObject({ type: 'guest-auth' });
    expect(firstFrame).not.toHaveProperty('accountAssertion');
    await room.webSocketMessage(guestServerSocket, JSON.stringify(firstFrame));

    expect(guestServerSocket.closed).toBe(false);
    const peerOpen = workerSentOfType(guestServerSocket, 'peer-open')[0];
    guestClientSocket.dispatch('message', JSON.stringify(peerOpen));
    await flushAsync();

    expect(assertionProvider).toHaveBeenCalledTimes(2);
    const identityClear = sentOfType(guestClientSocket, 'account-identity-clear')[0];
    expect(identityClear).toEqual({ type: 'account-identity-clear' });
    expect(
      guestClientSocket.sent
        .map((raw) => (JSON.parse(raw) as { type: string }).type)
        .indexOf('account-identity-clear'),
    ).toBeGreaterThan(0);

    await room.webSocketMessage(guestServerSocket, JSON.stringify(identityClear));
    expect(guestServerSocket.closed).toBe(false);
    expect(workerSentOfType(guestServerSocket, 'account-identity')).toContainEqual({
      type: 'account-identity',
      memberIdentity: null,
      clearReason: 'explicit',
    });

    guestPeer.destroy();
    hostPeer.destroy();
  });

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
        desiredRoomPassword: roomPassword,
        pinMutationId: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      });
      room.acceptPendingHost(hostServerSocket, '123456', hostUrl.searchParams.get('peerId') || '');
      expect(workerSentOfType(hostServerSocket, 'peer-open')).toHaveLength(0);
      await room.webSocketMessage(hostServerSocket, JSON.stringify(hostAuthFrame));

      const peerOpenFrame = workerSentOfType(hostServerSocket, 'peer-open')[0];
      expect(peerOpenFrame).toMatchObject({
        roomPasswordMutationId: hostAuthFrame?.pinMutationId,
        roomPasswordApplied: true,
      });
      hostClientSocket.dispatch('message', JSON.stringify(peerOpenFrame));
      await flushAsync();
      const finalPasswordFrame = sentOfType(hostClientSocket, 'room-password-set')[0];
      expect(finalPasswordFrame).toEqual({
        type: 'room-password-set',
        password: roomPassword,
        pinMutationId: hostAuthFrame?.pinMutationId,
      });
      const preConfirmationGuest = new ContractWorkerSocket();
      await room.acceptGuest(preConfirmationGuest, '123456', 'guest-before-pin-confirmation');
      expect(preConfirmationGuest.closed).toBe(true);
      expect(workerSentOfType(preConfirmationGuest, 'error')[0]).toMatchObject({
        type: 'error',
        errorType: 'service-unavailable',
        message: 'ROOM_PASSWORD_MUTATION_PENDING',
      });
      await room.webSocketMessage(hostServerSocket, JSON.stringify(finalPasswordFrame));
      const finalPasswordResult = workerSentOfType(hostServerSocket, 'room-password-result')[0];
      expect(finalPasswordResult).toEqual({
        type: 'room-password-result',
        mutationId: hostAuthFrame?.pinMutationId,
        applied: true,
      });
      hostClientSocket.dispatch('message', JSON.stringify(finalPasswordResult));
      await flushAsync();

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

  it('reconnects and reasserts the exact desired PIN mutation after a negative acknowledgement', async () => {
    installFakeWebSocket();
    const peer = createHostPeer();
    peer.setRoomPassword('12345678');
    await Promise.resolve();
    const first = FakeWebSocket.instances[0];
    first.dispatch('open');
    await flushAsync();
    const firstAuth = sentOfType(first, 'host-auth')[0];
    expect(firstAuth).toMatchObject({
      desiredRoomPassword: '12345678',
      pinMutationId: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
    });

    first.dispatch(
      'message',
      JSON.stringify({
        type: 'room-password-result',
        mutationId: firstAuth?.pinMutationId,
        applied: false,
        errorType: 'ROOM_PASSWORD_STORAGE_UNAVAILABLE',
      }),
    );
    await flushAsync();
    expect(first.closeCount).toBe(1);

    peer.reconnect();
    const reopened = FakeWebSocket.instances[1];
    reopened.dispatch('open');
    await flushAsync();
    expect(sentOfType(reopened, 'host-auth')[0]).toEqual(firstAuth);
    peer.destroy();
  });

  it('requires a fresh final PIN confirmation on every admitted host socket', async () => {
    installFakeWebSocket();
    const peer = createHostPeer();
    peer.setRoomPassword('12345678');
    await Promise.resolve();
    const first = FakeWebSocket.instances[0];
    first.dispatch('open');
    await flushAsync();
    const firstAuth = sentOfType(first, 'host-auth')[0];
    const peerOpen = {
      type: 'peer-open',
      peerId: '123456',
      roomId: '123456',
      roomPasswordApplied: true,
      roomPasswordMutationId: firstAuth?.pinMutationId,
    };
    first.dispatch('message', JSON.stringify(peerOpen));
    await flushAsync();
    const firstConfirmation = sentOfType(first, 'room-password-set')[0];
    expect(firstConfirmation).toMatchObject({
      password: '12345678',
      pinMutationId: firstAuth?.pinMutationId,
    });
    first.dispatch(
      'message',
      JSON.stringify({
        type: 'room-password-result',
        mutationId: firstAuth?.pinMutationId,
        applied: true,
      }),
    );
    await flushAsync();

    first.close();
    peer.reconnect();
    const reopened = FakeWebSocket.instances[1];
    reopened.dispatch('open');
    await flushAsync();
    expect(sentOfType(reopened, 'host-auth')[0]).toEqual(firstAuth);

    reopened.dispatch('message', JSON.stringify(peerOpen));
    await flushAsync();
    expect(sentOfType(reopened, 'room-password-set')[0]).toEqual(firstConfirmation);
    peer.destroy();
  });

  it('keeps Worker guest admission fenced until a reconnected client confirms on its new socket', async () => {
    installFakeWebSocket();
    const room = await createContractWorkerRoom();
    const peer = createHostPeer();
    peer.setRoomPassword('12345678');
    await Promise.resolve();

    const admitClientSocket = async (
      clientSocket: FakeWebSocket,
      serverSocket: ContractWorkerSocket,
    ): Promise<Record<string, unknown>> => {
      clientSocket.dispatch('open');
      await flushAsync();
      const url = new URL(clientSocket.url);
      room.acceptPendingHost(serverSocket, '123456', url.searchParams.get('peerId') || '');
      const auth = sentOfType(clientSocket, 'host-auth')[0];
      await room.webSocketMessage(serverSocket, JSON.stringify(auth));
      const opened = workerSentOfType(serverSocket, 'peer-open')[0];
      clientSocket.dispatch('message', JSON.stringify(opened));
      await flushAsync();
      return sentOfType(clientSocket, 'room-password-set')[0];
    };

    const firstClient = FakeWebSocket.instances[0];
    const firstServer = new ContractWorkerSocket();
    const firstConfirmation = await admitClientSocket(firstClient, firstServer);
    await room.webSocketMessage(firstServer, JSON.stringify(firstConfirmation));
    firstClient.dispatch(
      'message',
      JSON.stringify(workerSentOfType(firstServer, 'room-password-result')[0]),
    );
    await flushAsync();

    firstClient.close();
    peer.reconnect();
    const reconnectedClient = FakeWebSocket.instances[1];
    const reconnectedServer = new ContractWorkerSocket();
    const reconnectedConfirmation = await admitClientSocket(reconnectedClient, reconnectedServer);
    expect(reconnectedConfirmation).toEqual(firstConfirmation);

    const fencedGuest = new ContractWorkerSocket();
    await room.acceptGuest(fencedGuest, '123456', 'guest-before-reconnect-confirmation');
    expect(workerSentOfType(fencedGuest, 'error')[0]).toMatchObject({
      errorType: 'service-unavailable',
      message: 'ROOM_PASSWORD_MUTATION_PENDING',
    });

    await room.webSocketMessage(reconnectedServer, JSON.stringify(reconnectedConfirmation));
    const admittedGuest = new ContractWorkerSocket();
    await room.acceptGuest(admittedGuest, '123456', 'guest-after-reconnect-confirmation');
    expect(admittedGuest.closed).toBe(false);
    peer.destroy();
  });

  it('restarts pre-admission host auth when the desired PIN changes in flight', async () => {
    installFakeWebSocket();
    const peer = createHostPeer();
    await Promise.resolve();
    const staleSocket = FakeWebSocket.instances[0];
    staleSocket.dispatch('open');
    await flushAsync();
    const staleAuth = sentOfType(staleSocket, 'host-auth')[0];
    expect(staleAuth).toMatchObject({ desiredRoomPassword: '' });

    peer.setRoomPassword('12345678');

    expect(staleSocket.closeCount).toBe(1);
    const currentSocket = FakeWebSocket.instances[1];
    currentSocket.dispatch('open');
    await flushAsync();
    const currentAuth = sentOfType(currentSocket, 'host-auth')[0];
    expect(currentAuth).toMatchObject({ desiredRoomPassword: '12345678' });
    expect(currentAuth?.pinMutationId).not.toBe(staleAuth?.pinMutationId);
    expect(sentOfType(staleSocket, 'room-password-set')).toEqual([]);
    peer.destroy();
  });
});

describe('Standard HTTPS route preference circuit breaker', () => {
  function fallbackOptions(prepareNetworkRouteRetry = vi.fn(async () => null)) {
    return {
      provider: 'cloudflare' as const,
      signalingUrl: PRIMARY_SIGNALING_URL,
      signalingFallbackUrl: FALLBACK_SIGNALING_URL,
      config: { iceServers: [] },
      prepareNetworkRouteRetry,
    };
  }

  async function moveHostToHttp(peer: CloudflareSignalingPeer): Promise<void> {
    await Promise.resolve();
    const primary = FakeWebSocket.instances.at(-1)!;
    primary.dispatch('open');
    primary.dispatch('error');
    await flushAsync();
    const alternate = FakeWebSocket.instances.at(-1)!;
    expect(alternate).not.toBe(primary);
    alternate.dispatch('open');
    alternate.dispatch('error');
    await flushAsync();
    await vi.waitFor(() => expect(peer.open).toBe(true));
  }

  it('reuses an admitted HTTP route across destroyed peers for both host and guest setup', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const bridge = installHttpBridgeHarness();
    let now = 100;
    __cloudflareSignalingForTests.setStandardHttpPreferenceNow(() => now);

    const seedPrepare = vi.fn(async () => null);
    const seed = new CloudflareSignalingPeer('123456', fallbackOptions(seedPrepare));
    seed.setRoomPassword('12345678');
    await moveHostToHttp(seed);
    expect(seedPrepare).toHaveBeenCalledOnce();
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(true);
    seed.destroy();
    await flushAsync();
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(true);
    expect(__cloudflareSignalingForTests.pageSignalingSocketHandleCount()).toBe(0);

    FakeWebSocket.instances = [];
    const hostOpenCount = bridge.requestCount('/bridge/open');
    const nextHostPrepare = vi.fn(async () => null);
    const nextHost = new CloudflareSignalingPeer('234567', fallbackOptions(nextHostPrepare));
    nextHost.setRoomPassword('87654321');
    await vi.waitFor(() => expect(bridge.requestCount('/bridge/open')).toBe(hostOpenCount + 1));
    await vi.waitFor(() => expect(nextHost.open).toBe(true));
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(nextHostPrepare).not.toHaveBeenCalled();
    nextHost.destroy();
    await flushAsync();

    const guestOpenCount = bridge.requestCount('/bridge/open');
    const guestPrepare = vi.fn(async () => null);
    const guest = new CloudflareSignalingPeer(null, fallbackOptions(guestPrepare));
    const conn = guest.connect('345678');
    await vi.waitFor(() => expect(bridge.requestCount('/bridge/open')).toBe(guestOpenCount + 1));
    await vi.waitFor(() => expect(conn.peerConnection).not.toBeNull());
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(guestPrepare).not.toHaveBeenCalled();
    now += 1;
    guest.destroy();
    expect(__cloudflareSignalingForTests.pageSignalingSocketHandleCount()).toBe(0);
  });

  it('expires lazily at five minutes and does not slide on repeated promotion', async () => {
    installFakeWebSocket();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>());
    let now = 50;
    const ttl = __cloudflareSignalingForTests.standardHttpPreferenceTtlMs;
    __cloudflareSignalingForTests.setStandardHttpPreferenceNow(() => now);
    __cloudflareSignalingForTests.promoteStandardHttpPreference();
    now += ttl - 1;
    __cloudflareSignalingForTests.promoteStandardHttpPreference();
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(true);
    now += 1;
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(false);

    const peer = new CloudflareSignalingPeer('123456', fallbackOptions());
    peer.setRoomPassword('12345678');
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(new URL(FakeWebSocket.instances[0].url).origin).toBe('wss://signal.example.test');
    expect(fetch).not.toHaveBeenCalled();
    peer.destroy();
  });

  it('does not promote an HTTP socket that only opens or later reports stale authority', async () => {
    installFakeWebSocket();
    const bridge = installHttpBridgeHarness({ admit: false });
    const peer = new CloudflareSignalingPeer('123456', fallbackOptions());
    peer.setRoomPassword('12345678');
    await Promise.resolve();
    FakeWebSocket.instances[0].dispatch('open');
    FakeWebSocket.instances[0].dispatch('error');
    await flushAsync();
    FakeWebSocket.instances[1].dispatch('open');
    FakeWebSocket.instances[1].dispatch('error');
    await vi.waitFor(() => expect(bridge.requestCount('/bridge/open')).toBe(1));
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(false);

    const staleSocket = (peer as unknown as { hostSocket: EventTarget }).hostSocket;
    peer.destroy();
    staleSocket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
      }),
    );
    await flushAsync();
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(false);
  });

  it('ignores a superseded HTTP guest socket when its peer-open arrives late', async () => {
    installFakeWebSocket();
    const bridge = installHttpBridgeHarness({ admit: false });
    __cloudflareSignalingForTests.promoteStandardHttpPreference();
    const peer = new CloudflareSignalingPeer(null, fallbackOptions());
    peer.connect('123456');
    await vi.waitFor(() => expect(bridge.requestCount('/bridge/open')).toBe(1));
    const staleSocket = (
      peer as unknown as { roomSockets: Map<string, EventTarget> }
    ).roomSockets.get('123456')!;
    __cloudflareSignalingForTests.clearStandardHttpPreference();

    peer.connect('123456');
    expect(FakeWebSocket.instances).toHaveLength(1);
    staleSocket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'peer-open', peerId: peer.id, roomId: '123456' }),
      }),
    );
    await flushAsync();
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(false);
    peer.destroy();
  });

  it('clears a failed preferred HTTP route and tries primary then alternate without HTTP re-entry', async () => {
    installFakeWebSocket();
    const bridge = installHttpBridgeHarness();
    bridge.failNextOpen = true;
    __cloudflareSignalingForTests.promoteStandardHttpPreference();
    const prepare = vi.fn(async () => null);
    const peer = new CloudflareSignalingPeer(null, fallbackOptions(prepare));
    const conn = peer.connect('123456');
    const onError = vi.fn();
    conn.on('error', onError);

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    expect(new URL(FakeWebSocket.instances[0].url).origin).toBe('wss://signal.example.test');
    FakeWebSocket.instances[0].dispatch('error');
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(new URL(FakeWebSocket.instances[1].url).origin).toBe('wss://signal-alt.example.test');
    expect(prepare).toHaveBeenCalledOnce();
    FakeWebSocket.instances[1].dispatch('error');
    await flushAsync();
    expect(onError).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(bridge.requestCount('/bridge/open')).toBe(1);
    peer.destroy();
  });

  it.each([
    { label: '200 protocol response', statuses: [200], recoversWithWss: true },
    { label: '404 rollout miss', statuses: [404], recoversWithWss: true },
    { label: '409 stale bridge state', statuses: [409], recoversWithWss: true },
    { label: '410 expired bridge state', statuses: [410], recoversWithWss: true },
    {
      label: 'consecutive 503 responses',
      statuses: [503, 503],
      recoversWithWss: true,
    },
    { label: '400 invalid request', statuses: [400], recoversWithWss: false },
    { label: '401 invalid bearer', statuses: [401], recoversWithWss: false },
    { label: '403 denied bearer', statuses: [403], recoversWithWss: false },
    { label: '429 rate limit', statuses: [429], recoversWithWss: false },
  ] as const)('classifies preferred HTTP $label', async ({ statuses, recoversWithWss }) => {
    installFakeWebSocket();
    const bridge = installHttpBridgeHarness();
    bridge.sendStatuses.push(...statuses);
    __cloudflareSignalingForTests.promoteStandardHttpPreference();
    const prepare = vi.fn(async () => null);
    const peer = new CloudflareSignalingPeer(null, fallbackOptions(prepare));
    const conn = peer.connect('123456');
    const onError = vi.fn();
    conn.on('error', onError);

    if (recoversWithWss) {
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      expect(prepare).toHaveBeenCalledOnce();
    } else {
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(prepare).not.toHaveBeenCalled();
    }
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(false);
    expect(bridge.requestCount('/bridge/open')).toBe(1);
    peer.destroy();
  });

  it('keeps the preference on an authoritative room error and never downgrades it to WSS', async () => {
    installFakeWebSocket();
    const bridge = installHttpBridgeHarness();
    bridge.nextAuthorityFrame = {
      type: 'error',
      errorType: 'room-password-invalid',
      message: 'ROOM_PASSWORD_INVALID',
    };
    bridge.nextTerminal = { code: 1008, reason: 'semantic rejection' };
    __cloudflareSignalingForTests.promoteStandardHttpPreference();
    const peer = new CloudflareSignalingPeer(null, fallbackOptions());
    const conn = peer.connect('123456', { roomPassword: 'wrong-pin' });
    const onError = vi.fn();
    conn.on('error', onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      type: 'room-password-invalid',
      message: 'ROOM_PASSWORD_INVALID',
    });
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(bridge.requestCount('/bridge/open')).toBe(1);
    expect(__cloudflareSignalingForTests.pageSignalingSocketHandleCount()).toBe(0);
    await flushAsync();
    expect(onError).toHaveBeenCalledOnce();
    peer.destroy();
  });

  it('clears the preference on current WSS admission and admitted HTTP transport failure', async () => {
    installFakeWebSocket();
    const bridge = installHttpBridgeHarness();
    const wssPeer = new CloudflareSignalingPeer('123456', fallbackOptions());
    wssPeer.setRoomPassword('12345678');
    await Promise.resolve();
    __cloudflareSignalingForTests.promoteStandardHttpPreference();
    const wss = FakeWebSocket.instances[0];
    wss.dispatch('open');
    wss.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(false);
    wssPeer.destroy();

    __cloudflareSignalingForTests.promoteStandardHttpPreference();
    FakeWebSocket.instances = [];
    const httpPeer = new CloudflareSignalingPeer('234567', fallbackOptions());
    httpPeer.setRoomPassword('12345678');
    await vi.waitFor(() => expect(httpPeer.open).toBe(true));
    const currentHttp = (httpPeer as unknown as { hostSocket: EventTarget }).hostSocket;
    currentHttp.dispatchEvent(new Event('error'));
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(0);
    httpPeer.destroy();

    __cloudflareSignalingForTests.promoteStandardHttpPreference();
    bridge.nextTerminal = { code: 1012, reason: 'service restart' };
    const closingPeer = new CloudflareSignalingPeer('345678', fallbackOptions());
    const onClosingPeerOpen = vi.fn();
    closingPeer.on('open', onClosingPeerOpen);
    closingPeer.setRoomPassword('12345678');
    await vi.waitFor(() => expect(onClosingPeerOpen).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(false),
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(__cloudflareSignalingForTests.pageSignalingSocketHandleCount()).toBe(0);
    closingPeer.destroy();
    expect(bridge.requestCount('/bridge/open')).toBe(2);
  });

  it('leaves PRO signaling and ambient browser state untouched', async () => {
    installFakeWebSocket();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    let now = 10;
    __cloudflareSignalingForTests.setStandardHttpPreferenceNow(() => now);
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const addWindowListener = vi.spyOn(globalThis, 'addEventListener');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const cookieBefore = document.cookie;
    __cloudflareSignalingForTests.promoteStandardHttpPreference();
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(true);
    now += __cloudflareSignalingForTests.standardHttpPreferenceTtlMs;
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(false);
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(addWindowListener).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.cookie).toBe(cookieBefore);

    __cloudflareSignalingForTests.promoteStandardHttpPreference();
    const ticket = clientProTicket('coordinator-device', { role: 'coordinator' });
    const peer = new CloudflareSignalingPeer('000001', {
      ...fallbackOptions(),
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
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(new URL(FakeWebSocket.instances[0].url).pathname).toBe('/api/pro-rooms/000001/ws');
    expect(fetchMock).not.toHaveBeenCalled();
    FakeWebSocket.instances[0].dispatch('open');
    FakeWebSocket.instances[0].dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '000001', roomId: '000001' }),
    );
    await flushAsync();
    expect(__cloudflareSignalingForTests.hasStandardHttpPreference()).toBe(true);
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

  it('does not grant a fresh full grace when a long-hidden disconnected RTC resumes', async () => {
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

    // WebKit delivered disconnected before visibility recovery. The ordinary
    // 15s timer is already armed, but the hidden interval consumed that grace.
    pc.connectionState = 'disconnected';
    pc.dispatch('connectionstatechange');
    expect(conn.recoverAfterBackground(60_000, false)).toBe('monitoring');

    await vi.advanceTimersByTimeAsync(BACKGROUND_RESUME_DISCONNECTED_PROBE_MS - 1);
    expect(conn.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(conn.open).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('catches a queued disconnected event delivered after the foreground hook', async () => {
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

    // visibilitychange can run while connectionState still reads connected.
    expect(conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    pc.connectionState = 'disconnected';
    pc.dispatch('connectionstatechange');

    await vi.advanceTimersByTimeAsync(BACKGROUND_RESUME_DISCONNECTED_PROBE_MS);
    expect(conn.open).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps a long-resume RTC alive when the short foreground probe reconnects', async () => {
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
    expect(conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    await vi.advanceTimersByTimeAsync(BACKGROUND_RESUME_DISCONNECTED_PROBE_MS / 2);
    pc.connectionState = 'connected';
    pc.dispatch('connectionstatechange');
    await vi.advanceTimersByTimeAsync(DATA_CONNECTION_DISCONNECTED_GRACE_MS);

    expect(conn.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    conn.close();
  });

  it('closes a stale connected/open WebKit connection when its liveness challenge is unanswered', async () => {
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

    expect(conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    const probe = JSON.parse(control.sent.at(-1) as string) as Record<string, unknown>;
    expect(probe).toMatchObject({ type: MSG.SYNC_PING });
    expect(probe.pingId).toEqual(expect.any(Number));

    // A redundant connected event is not proof: this is one of WebKit's stale
    // object failure modes after a long suspension.
    pc.dispatch('connectionstatechange');
    await vi.advanceTimersByTimeAsync(BACKGROUND_RESUME_LIVENESS_TIMEOUT_MS - 1);
    expect(conn.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onClose).toHaveBeenCalledOnce();
    expect(conn.open).toBe(false);
  });

  it('keeps a stale-looking connected RTC only after the exact liveness pong arrives', async () => {
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

    expect(conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    const probe = JSON.parse(control.sent.at(-1) as string) as { pingId: number };

    // An unrelated queued frame and a different pong must not certify the
    // pre-suspend association.
    control.dispatch('message', JSON.stringify({ type: MSG.SYNC_PONG, pingId: probe.pingId - 1 }));
    control.dispatch('message', JSON.stringify({ type: MSG.CHAT, text: 'queued' }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(BACKGROUND_RESUME_LIVENESS_TIMEOUT_MS - 1);
    expect(conn.open).toBe(true);

    control.dispatch(
      'message',
      JSON.stringify({
        type: MSG.SYNC_PONG,
        pingId: probe.pingId,
        hostTime: Date.now(),
        position: 0,
        mode: null,
        activity: 'idle',
        queueItemId: null,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(BACKGROUND_RESUME_LIVENESS_TIMEOUT_MS);

    expect(conn.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    conn.close();
  });

  it('keeps the ordinary grace when the hidden interval was shorter than it', async () => {
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
    expect(conn.recoverAfterBackground(DATA_CONNECTION_DISCONNECTED_GRACE_MS - 1, false)).toBe(
      'not-applicable',
    );

    await vi.advanceTimersByTimeAsync(DATA_CONNECTION_DISCONNECTED_GRACE_MS - 1);
    expect(conn.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes a long-hidden connection immediately when a data channel is no longer open', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    const onClose = vi.fn();
    conn.on('close', onClose);
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    control.readyState = 'closed';
    expect(conn.recoverAfterBackground(60_000, false)).toBe('stale-connection-closed');
    expect(conn.open).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
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

  it('rejects malformed UTF-8 in peer-controlled binary headers', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const onData = vi.fn();
    const onError = vi.fn();
    conn.on('data', onData);
    conn.on('error', onError);
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);

    const prefix = new TextEncoder().encode(
      '{"type":"file-chunk","chunk":{"__mxqrBinaryChunk":true},"name":"',
    );
    const suffix = new TextEncoder().encode('"}');
    const header = new Uint8Array(prefix.byteLength + 2 + suffix.byteLength);
    header.set(prefix, 0);
    header.set([0xc3, 0x28], prefix.byteLength);
    header.set(suffix, prefix.byteLength + 2);
    const frame = new Uint8Array(4 + header.byteLength + 1);
    new DataView(frame.buffer).setUint32(0, header.byteLength, false);
    frame.set(header, 4);
    frame[frame.byteLength - 1] = 1;

    bulk.dispatch('message', frame.buffer);
    await flushAsync();

    expect(onData).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
  });

  it('rejects oversized peer binary frames before they reach protocol handlers', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const onData = vi.fn();
    const onError = vi.fn();
    conn.on('data', onData);
    conn.on('error', onError);
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);

    const header = new TextEncoder().encode(
      '{"type":"file-chunk","chunk":{"__mxqrBinaryChunk":true}}',
    );
    const frame = new Uint8Array(4 + header.byteLength + CHUNK_SIZE + 1);
    new DataView(frame.buffer).setUint32(0, header.byteLength, false);
    frame.set(header, 4);

    bulk.dispatch('message', frame.buffer);
    await flushAsync();

    expect(onData).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: 'INVALID_BINARY_BODY' });
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
      negotiationId: NEGOTIATION_ID,
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
        negotiationId: NEGOTIATION_ID,
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
      negotiationId: NEGOTIATION_ID,
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
        negotiationId: NEXT_NEGOTIATION_ID,
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
        negotiationId: NEGOTIATION_ID,
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
      negotiationId: NEGOTIATION_ID,
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
        negotiationId: NEGOTIATION_ID,
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
        negotiationId: NEXT_NEGOTIATION_ID,
        sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:second' },
      }),
    );
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-candidate',
        from: 'guest-overlap',
        negotiationId: NEXT_NEGOTIATION_ID,
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
    await vi.waitFor(() => expect(sentOfType(socket, 'signal-candidate')).toHaveLength(1));
    const sentCandidates = sentOfType(socket, 'signal-candidate');
    expect(sentCandidates).toHaveLength(1);
    expect(sentCandidates[0]).toMatchObject({
      negotiationId: secondToken,
      candidate: { candidate: 'candidate:current-second' },
    });
    peer.destroy();
  });

  it('ignores tokenless ICE and answers after emitting a token-aware offer', async () => {
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

    const negotiationId = sentOfType(socket, 'signal-offer')[0]?.negotiationId;
    expect(negotiationId).toEqual(expect.any(String));
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

    expect(FakeRTCPeerConnection.instances[0]?.addedCandidates).toEqual([]);
    expect(FakeRTCPeerConnection.instances[0]?.remoteDescription).toBeNull();
    peer.destroy();
  });

  it('does not let a late tokenless data answer overwrite the active media negotiation', async () => {
    const { peer, socket, pc } = await establishGuest();
    const onCall = vi.fn();
    peer.on('call', onCall);
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'media-offer',
        from: 'host',
        negotiationId: NEGOTIATION_ID,
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
        sdp: { type: 'answer', sdp: 'late-legacy-data-answer' },
      }),
    );
    await flushAsync();
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'current-media-offer' });

    peer.destroy();
  });

  describe('shared media negotiation lifecycle', () => {
    it('waits for reopened host admission before sending an in-flight media offer', async () => {
      const { peer, socket, pc } = await establishHostWithSignalingState();
      const pendingOffer = deferred<RTCSessionDescriptionInit>();
      const createOffer = vi.spyOn(pc, 'createOffer').mockReturnValueOnce(pendingOffer.promise);

      const mediaConn = peer.call('guest-media', fakeAudioStream('reconnected-media-offer'));
      const onError = vi.fn();
      mediaConn.on('error', onError);
      await vi.waitFor(() => expect(createOffer).toHaveBeenCalledTimes(1));

      socket.close();
      expect(peer.disconnected).toBe(true);
      peer.reconnect();
      const reopened = FakeWebSocket.instances.at(-1)!;
      expect(reopened).not.toBe(socket);
      reopened.dispatch('open');

      pendingOffer.resolve({ type: 'offer', sdp: 'reconnected-media-offer' });
      await vi.waitFor(() => expect(pc.localDescription?.sdp).toBe('reconnected-media-offer'));
      expect(sentOfType(reopened, 'media-offer')).toHaveLength(0);
      expect(sentOfType(socket, 'media-offer')).toHaveLength(0);
      expect(onError).not.toHaveBeenCalled();

      reopened.dispatch(
        'message',
        JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
      );
      await vi.waitFor(() => expect(sentOfType(reopened, 'media-offer')).toHaveLength(1));

      expect(sentOfType(reopened, 'media-offer')[0]).toMatchObject({
        to: 'guest-media',
        sdp: { type: 'offer', sdp: 'reconnected-media-offer' },
      });
      expect(sentOfType(socket, 'media-offer')).toHaveLength(0);
      expect(onError).not.toHaveBeenCalled();
      expect(pc.connectionState).toBe('connected');
      expect(FakeRTCPeerConnection.instances).toHaveLength(1);
      peer.destroy();
    });

    it('applies outgoing transform and sender tuning once per call without patching the shared pc', async () => {
      const { peer, socket, pc } = await establishHostWithSignalingState();
      const originalSetLocalDescription = pc.setLocalDescription;
      const transform = vi.fn((sdp: string) => `${sdp}|stereo`);
      const tuneSender = vi.fn();

      const first = peer.call('guest-media', fakeAudioStream('audio-1'), {
        sdpTransform: transform,
        senderTuning: tuneSender,
      });
      const firstOpen = vi.fn();
      first.on('open', firstOpen);
      await vi.waitFor(() => expect(sentOfType(socket, 'media-offer')).toHaveLength(1));
      const firstOffer = sentOfType(socket, 'media-offer')[0]!;
      socket.dispatch(
        'message',
        JSON.stringify({
          type: 'media-answer',
          from: 'guest-media',
          callId: firstOffer.callId,
          negotiationId: firstOffer.negotiationId,
          sdp: { type: 'answer', sdp: 'first-media-answer' },
        }),
      );
      await vi.waitFor(() => expect(firstOpen).toHaveBeenCalledTimes(1));
      first.close();
      await flushAsync();

      const second = peer.call('guest-media', fakeAudioStream('audio-2'), {
        sdpTransform: transform,
        senderTuning: tuneSender,
      });
      const secondOpen = vi.fn();
      second.on('open', secondOpen);
      await vi.waitFor(() => expect(sentOfType(socket, 'media-offer')).toHaveLength(2));
      const secondOffer = sentOfType(socket, 'media-offer')[1]!;
      socket.dispatch(
        'message',
        JSON.stringify({
          type: 'media-answer',
          from: 'guest-media',
          callId: secondOffer.callId,
          negotiationId: secondOffer.negotiationId,
          sdp: { type: 'answer', sdp: 'second-media-answer' },
        }),
      );
      await vi.waitFor(() => expect(secondOpen).toHaveBeenCalledTimes(1));

      expect(firstOffer.sdp).toEqual({ type: 'offer', sdp: 'fake-offer|stereo' });
      expect(secondOffer.sdp).toEqual({ type: 'offer', sdp: 'fake-offer|stereo' });
      expect(transform).toHaveBeenCalledTimes(2);
      expect(tuneSender).toHaveBeenCalledTimes(2);
      expect(pc.setLocalDescription).toBe(originalSetLocalDescription);
      expect(pc.rollbackCount).toBe(0);
      expect(FakeRTCPeerConnection.instances).toHaveLength(1);
      peer.destroy();
    });

    it('releases partially-added senders when outgoing call setup fails', async () => {
      const { peer, socket, pc } = await establishHostWithSignalingState();
      const stream = new FakeMediaStream();
      stream.addTrack({ id: 'partial-audio-1', kind: 'audio' } as MediaStreamTrack);
      stream.addTrack({ id: 'partial-audio-2', kind: 'audio' } as MediaStreamTrack);
      const nativeAddTrack = pc.addTrack.bind(pc);
      vi.spyOn(pc, 'addTrack')
        .mockImplementationOnce((track) => nativeAddTrack(track))
        .mockImplementationOnce(() => {
          throw new Error('second addTrack failed');
        });

      const mediaConn = peer.call('guest-media', stream as unknown as MediaStream);
      const onError = vi.fn();
      mediaConn.on('error', onError);
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledWith(new Error('second addTrack failed')),
      );

      expect(pc.getSenders()).toEqual([]);
      expect(pc.removedSenders).toHaveLength(1);
      expect(pc.listenerCount('track')).toBe(0);
      expect(sentOfType(socket, 'media-offer')).toHaveLength(0);
      peer.destroy();
    });

    it('does not run a queued media offer after the exact call closes synchronously', async () => {
      const { peer, socket, pc } = await establishHostWithSignalingState();
      const mediaConn = peer.call('guest-media', fakeAudioStream('cancelled-before-offer'));

      mediaConn.close();
      await flushAsync();

      expect(sentOfType(socket, 'media-offer')).toHaveLength(0);
      expect(pc.getSenders()).toEqual([]);
      expect(pc.listenerCount('track')).toBe(0);
      expect(pc.signalingState).toBe('stable');
      peer.destroy();
    });

    it('applies incoming answer transform once per call without patching the shared pc', async () => {
      const { peer, socket, pc } = await establishGuestWithSignalingState();
      const originalSetLocalDescription = pc.setLocalDescription;
      const originalSetRemoteDescription = pc.setRemoteDescription;
      const transform = vi.fn((sdp: string) => `${sdp}|stereo`);
      const onCall = vi.fn();
      peer.on('call', onCall);

      socket.dispatch(
        'message',
        JSON.stringify({
          type: 'media-offer',
          from: 'host',
          negotiationId: NEGOTIATION_ID,
          callId: 'incoming-transform-1',
          sdp: { type: 'offer', sdp: 'first-host-media-offer' },
          audioTrackCount: 1,
        }),
      );
      await vi.waitFor(() => expect(onCall).toHaveBeenCalledTimes(1));
      const first = onCall.mock.calls[0]?.[0] as TransportMediaConnection;
      first.answer(undefined, { sdpTransform: transform });
      await vi.waitFor(() => expect(sentOfType(socket, 'media-answer')).toHaveLength(1));
      first.close();
      await flushAsync();

      socket.dispatch(
        'message',
        JSON.stringify({
          type: 'media-offer',
          from: 'host',
          negotiationId: NEXT_NEGOTIATION_ID,
          callId: 'incoming-transform-2',
          sdp: { type: 'offer', sdp: 'second-host-media-offer' },
          audioTrackCount: 1,
        }),
      );
      await vi.waitFor(() => expect(onCall).toHaveBeenCalledTimes(2));
      const second = onCall.mock.calls[1]?.[0] as TransportMediaConnection;
      second.answer(undefined, { sdpTransform: transform });
      await vi.waitFor(() => expect(sentOfType(socket, 'media-answer')).toHaveLength(2));

      const answers = sentOfType(socket, 'media-answer');
      expect(answers[0]?.sdp).toEqual({ type: 'answer', sdp: 'fake-answer|stereo' });
      expect(answers[1]?.sdp).toEqual({ type: 'answer', sdp: 'fake-answer|stereo' });
      expect(transform).toHaveBeenCalledTimes(2);
      expect(pc.setLocalDescription).toBe(originalSetLocalDescription);
      expect(pc.setRemoteDescription).toBe(originalSetRemoteDescription);
      expect(pc.rollbackCount).toBe(0);
      expect(FakeRTCPeerConnection.instances).toHaveLength(1);
      peer.destroy();
    });

    it('rolls back a failed host media answer before retrying on the same data pc', async () => {
      const { peer, socket, pc } = await establishHostWithSignalingState();
      const nativeSetRemoteDescription = pc.setRemoteDescription.bind(pc);
      vi.spyOn(pc, 'setRemoteDescription').mockImplementation(async (description) => {
        if (description.sdp === 'failed-media-answer') throw new Error('set remote failed');
        await nativeSetRemoteDescription(description);
      });

      const first = peer.call('guest-media', fakeAudioStream('failed-audio'));
      const firstError = vi.fn();
      first.on('error', firstError);
      await vi.waitFor(() => expect(sentOfType(socket, 'media-offer')).toHaveLength(1));
      const firstOffer = sentOfType(socket, 'media-offer')[0]!;
      socket.dispatch(
        'message',
        JSON.stringify({
          type: 'media-answer',
          from: 'guest-media',
          callId: firstOffer.callId,
          negotiationId: firstOffer.negotiationId,
          sdp: { type: 'answer', sdp: 'failed-media-answer' },
        }),
      );
      await vi.waitFor(() => {
        expect(firstError).toHaveBeenCalledTimes(1);
        expect(pc.rollbackCount).toBe(1);
        expect(pc.signalingState).toBe('stable');
      });

      const second = peer.call('guest-media', fakeAudioStream('retry-audio'));
      const secondOpen = vi.fn();
      second.on('open', secondOpen);
      await vi.waitFor(() => expect(sentOfType(socket, 'media-offer')).toHaveLength(2));
      const secondOffer = sentOfType(socket, 'media-offer')[1]!;
      socket.dispatch(
        'message',
        JSON.stringify({
          type: 'media-answer',
          from: 'guest-media',
          callId: secondOffer.callId,
          negotiationId: secondOffer.negotiationId,
          sdp: { type: 'answer', sdp: 'retry-media-answer' },
        }),
      );
      await vi.waitFor(() => expect(secondOpen).toHaveBeenCalledTimes(1));
      expect(pc.signalingState).toBe('stable');
      expect(FakeRTCPeerConnection.instances).toHaveLength(1);
      peer.destroy();
    });

    it('rolls back a failed guest answer before answering the next offer', async () => {
      const { peer, socket, pc } = await establishGuestWithSignalingState();
      vi.spyOn(pc, 'createAnswer').mockRejectedValueOnce(new Error('create answer failed'));
      const onCall = vi.fn();
      peer.on('call', onCall);

      socket.dispatch(
        'message',
        JSON.stringify({
          type: 'media-offer',
          from: 'host',
          negotiationId: NEGOTIATION_ID,
          callId: 'failed-incoming-answer',
          sdp: { type: 'offer', sdp: 'failed-host-offer' },
          audioTrackCount: 1,
        }),
      );
      await vi.waitFor(() => expect(onCall).toHaveBeenCalledTimes(1));
      const failed = onCall.mock.calls[0]?.[0] as TransportMediaConnection;
      const failedError = vi.fn();
      failed.on('error', failedError);
      failed.answer();
      await vi.waitFor(() => {
        expect(failedError).toHaveBeenCalledTimes(1);
        expect(pc.rollbackCount).toBe(1);
        expect(pc.signalingState).toBe('stable');
        expect(pc.listenerCount('signalingstatechange')).toBe(0);
      });

      socket.dispatch(
        'message',
        JSON.stringify({
          type: 'media-offer',
          from: 'host',
          negotiationId: NEXT_NEGOTIATION_ID,
          callId: 'retry-incoming-answer',
          sdp: { type: 'offer', sdp: 'retry-host-offer' },
          audioTrackCount: 1,
        }),
      );
      await vi.waitFor(() => expect(onCall).toHaveBeenCalledTimes(2));
      const retry = onCall.mock.calls[1]?.[0] as TransportMediaConnection;
      retry.answer();
      await vi.waitFor(() => expect(sentOfType(socket, 'media-answer')).toHaveLength(1));
      expect(sentOfType(socket, 'media-answer')[0]?.callId).toBe('retry-incoming-answer');
      expect(pc.signalingState).toBe('stable');
      expect(pc.listenerCount('track')).toBe(1);
      peer.destroy();
    });

    it("does not let a settled call's stale close roll back its successor offer", async () => {
      const { peer, socket, pc } = await establishHostWithSignalingState();
      const first = peer.call('guest-media', fakeAudioStream('first-audio'));
      await vi.waitFor(() => expect(sentOfType(socket, 'media-offer')).toHaveLength(1));
      const firstOffer = sentOfType(socket, 'media-offer')[0]!;
      socket.dispatch(
        'message',
        JSON.stringify({
          type: 'media-answer',
          from: 'guest-media',
          callId: firstOffer.callId,
          negotiationId: firstOffer.negotiationId,
          sdp: { type: 'answer', sdp: 'first-answer' },
        }),
      );
      await vi.waitFor(() => expect(pc.signalingState).toBe('stable'));

      const second = peer.call('guest-media', fakeAudioStream('second-audio'));
      const secondOpen = vi.fn();
      second.on('open', secondOpen);
      await vi.waitFor(() => expect(sentOfType(socket, 'media-offer')).toHaveLength(2));
      const secondOffer = sentOfType(socket, 'media-offer')[1]!;
      expect(pc.signalingState).toBe('have-local-offer');

      first.close();
      await flushAsync();
      expect(pc.signalingState).toBe('have-local-offer');
      expect(pc.rollbackCount).toBe(0);

      socket.dispatch(
        'message',
        JSON.stringify({
          type: 'media-answer',
          from: 'guest-media',
          callId: secondOffer.callId,
          negotiationId: secondOffer.negotiationId,
          sdp: { type: 'answer', sdp: 'second-answer' },
        }),
      );
      await vi.waitFor(() => expect(secondOpen).toHaveBeenCalledTimes(1));
      expect(pc.signalingState).toBe('stable');
      peer.destroy();
    });

    it('retires the exact shared data connection when owned rollback fails', async () => {
      const { peer, conn, socket, pc } = await establishHostWithSignalingState();
      const mediaConn = peer.call('guest-media', fakeAudioStream('rollback-failure-audio'));
      await vi.waitFor(() => expect(sentOfType(socket, 'media-offer')).toHaveLength(1));
      vi.spyOn(pc, 'setLocalDescription').mockRejectedValueOnce(new Error('rollback failed'));

      mediaConn.close();

      await vi.waitFor(() => expect(pc.connectionState).toBe('closed'));
      expect(conn.open).toBe(false);
      expect(privateMaps(peer).connections.has('guest-media')).toBe(false);
      peer.destroy();
    });

    it('removes stable-wait listeners after both settlement and timeout', async () => {
      vi.useFakeTimers();
      installFakeRTCPeerConnection({ modelSignalingState: true });
      const peer = createGuestPeer();
      const pc = new FakeRTCPeerConnection();
      const internalPeer = peer as unknown as {
        waitForStableSignaling(target: RTCPeerConnection, signal?: AbortSignal): Promise<void>;
      };

      pc.forceSignalingState('have-local-offer');
      const settledWait = internalPeer.waitForStableSignaling(pc as unknown as RTCPeerConnection);
      expect(pc.listenerCount('signalingstatechange')).toBe(1);
      pc.forceSignalingState('stable');
      await settledWait;
      expect(pc.listenerCount('signalingstatechange')).toBe(0);

      pc.forceSignalingState('have-local-offer');
      const controller = new AbortController();
      const abortedWait = internalPeer.waitForStableSignaling(
        pc as unknown as RTCPeerConnection,
        controller.signal,
      );
      const abortedRejection = expect(abortedWait).rejects.toThrow('MEDIA_NEGOTIATION_CANCELLED');
      expect(pc.listenerCount('signalingstatechange')).toBe(1);
      controller.abort();
      await abortedRejection;
      expect(pc.listenerCount('signalingstatechange')).toBe(0);

      pc.forceSignalingState('have-local-offer');
      const timedWait = internalPeer.waitForStableSignaling(pc as unknown as RTCPeerConnection);
      const rejection = expect(timedWait).rejects.toThrow('SIGNALING_NOT_STABLE:have-local-offer');
      expect(pc.listenerCount('signalingstatechange')).toBe(1);
      await vi.advanceTimersByTimeAsync(3000);
      await rejection;
      expect(pc.listenerCount('signalingstatechange')).toBe(0);
      peer.destroy();
    });
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
    expect(peer.recommendedPeerOpenTimeoutMs).toBeUndefined();
    expect(conn.recommendedPreOpenTimeoutMs).toBeUndefined();
    const socket = FakeWebSocket.instances[0];
    const onError = vi.fn();
    conn.on('error', onError);

    socket.dispatch('error');

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('falls back from primary and alternate WSS to the HTTPS bridge with the same join proof', async () => {
    installFakeWebSocket();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const bridgeRequests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      bridgeRequests.push({ url, body });
      if (url.endsWith('/api/security-config')) {
        return Promise.resolve(
          new Response(JSON.stringify({ capabilityRequired: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.endsWith('/bridge/open')) {
        return Promise.resolve(
          new Response(JSON.stringify({ sessionToken: `session.${'a'.repeat(48)}` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.endsWith('/bridge/send')) {
        return Promise.resolve(
          new Response(JSON.stringify({ v: 1, ack: body?.cseq }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.endsWith('/bridge/poll')) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      if (url.endsWith('/bridge/close')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      throw new Error(`Unexpected HTTP bridge URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const routeReady = deferred<RTCConfiguration | null>();
    const prepareNetworkRouteRetry = vi.fn(
      (_signal: AbortSignal, _retrySignalingUrl: string) => routeReady.promise,
    );
    const peer = new CloudflareSignalingPeer(null, {
      provider: 'cloudflare',
      signalingUrl: PRIMARY_SIGNALING_URL,
      signalingFallbackUrl: FALLBACK_SIGNALING_URL,
      config: { iceServers: [] },
      prepareNetworkRouteRetry,
    });
    const conn = peer.connect('123456', { roomPassword: '12345678' });
    expect(peer.recommendedPeerOpenTimeoutMs).toBe(25_000);
    expect(conn.recommendedPreOpenTimeoutMs).toBe(20_000);
    const onError = vi.fn(() => conn.close());
    conn.on('error', onError);
    const first = FakeWebSocket.instances[0];
    expect(new URL(first.url).origin).toBe('wss://signal.example.test');
    first.dispatch('open');
    await flushAsync();
    const firstAuth = sentOfType(first, 'guest-auth')[0]!;

    first.dispatch('error');
    first.dispatch('error');
    expect(prepareNetworkRouteRetry).toHaveBeenCalledOnce();
    expect(prepareNetworkRouteRetry).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      FALLBACK_SIGNALING_URL,
    );
    expect(onError).not.toHaveBeenCalled();
    expect(first.closeCount).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    routeReady.resolve({
      iceServers: [{ urls: 'turn:route-fresh.example.test:3478' }],
      bundlePolicy: 'max-bundle',
    });
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const replacement = FakeWebSocket.instances[1];
    expect(new URL(replacement.url).origin).toBe('wss://signal-alt.example.test');
    expect(new URL(replacement.url).pathname).toBe(new URL(first.url).pathname);
    replacement.dispatch('open');
    await flushAsync();
    expect(sentOfType(replacement, 'guest-auth')[0]).toMatchObject({
      password: firstAuth.password,
      reconnectSecret: firstAuth.reconnectSecret,
    });

    // A second generic pre-admission WSS failure moves to the same-origin HTTP
    // bridge. It reuses the exact guest proof rather than starting a new join.
    replacement.dispatch('error');
    replacement.dispatch('error');
    await vi.waitFor(() =>
      expect(
        bridgeRequests.some(
          (request) =>
            request.url.endsWith('/bridge/send') &&
            typeof request.body?.frame === 'string' &&
            (JSON.parse(request.body.frame) as Record<string, unknown>).type === 'guest-auth',
        ),
      ).toBe(true),
    );
    const bridgeAuthRequest = bridgeRequests.find(
      (request) =>
        request.url.endsWith('/bridge/send') &&
        typeof request.body?.frame === 'string' &&
        (JSON.parse(request.body.frame) as Record<string, unknown>).type === 'guest-auth',
    );
    expect(JSON.parse(String(bridgeAuthRequest?.body?.frame))).toMatchObject({
      password: firstAuth.password,
      reconnectSecret: firstAuth.reconnectSecret,
    });
    expect(onError).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(__cloudflareSignalingForTests.pageSignalingSocketHandleCount()).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '[Transport] Guest alternate signaling failed before admission; activating HTTPS bridge fallback',
      expect.objectContaining({
        route: 'fallback',
        everOpened: true,
        authSent: true,
        admitted: false,
      }),
    );
    peer.destroy();
    expect(__cloudflareSignalingForTests.pageSignalingSocketHandleCount()).toBe(0);
  });

  it('retries one setup host socket with the same room claim and ignores the retired generation', async () => {
    installFakeWebSocket();
    const routeReady = deferred<RTCConfiguration | null>();
    const prepareNetworkRouteRetry = vi.fn(
      (_signal: AbortSignal, _retrySignalingUrl: string) => routeReady.promise,
    );
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: PRIMARY_SIGNALING_URL,
      signalingFallbackUrl: FALLBACK_SIGNALING_URL,
      config: { iceServers: [] },
      prepareNetworkRouteRetry,
    });
    const onError = vi.fn();
    const onOpen = vi.fn();
    peer.on('error', onError);
    peer.on('open', onOpen);
    peer.setRoomPassword('12345678');
    await Promise.resolve();
    const first = FakeWebSocket.instances[0];
    expect(new URL(first.url).origin).toBe('wss://signal.example.test');
    first.dispatch('open');
    const firstAuth = sentOfType(first, 'host-auth')[0]!;

    first.dispatch('error');
    first.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();
    expect(prepareNetworkRouteRetry).toHaveBeenCalledOnce();
    expect(prepareNetworkRouteRetry).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      FALLBACK_SIGNALING_URL,
    );
    expect(onError).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(first.closeCount).toBe(1);

    routeReady.resolve(null);
    await flushAsync();
    const replacement = FakeWebSocket.instances[1];
    expect(new URL(replacement.url).origin).toBe('wss://signal-alt.example.test');
    expect(new URL(replacement.url).pathname).toBe(new URL(first.url).pathname);
    replacement.dispatch('open');
    expect(sentOfType(replacement, 'host-auth')[0]).toMatchObject({
      secret: firstAuth.secret,
      desiredRoomPassword: firstAuth.desiredRoomPassword,
      pinMutationId: firstAuth.pinMutationId,
    });
    replacement.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await flushAsync();

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    peer.destroy();
  });

  it('carries the host claim from alternate WSS into the HTTPS bridge', async () => {
    installFakeWebSocket();
    const bridgeRequests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      bridgeRequests.push({ url, body });
      if (url.endsWith('/api/security-config')) {
        return Promise.resolve(Response.json({ capabilityRequired: false }));
      }
      if (url.endsWith('/bridge/open')) {
        return Promise.resolve(Response.json({ sessionToken: `session.${'b'.repeat(48)}` }));
      }
      if (url.endsWith('/bridge/send')) {
        return Promise.resolve(Response.json({ v: 1, ack: body?.cseq }));
      }
      if (url.endsWith('/bridge/poll')) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      if (url.endsWith('/bridge/close')) return Promise.resolve(Response.json({ ok: true }));
      throw new Error(`Unexpected HTTP bridge URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: PRIMARY_SIGNALING_URL,
      signalingFallbackUrl: FALLBACK_SIGNALING_URL,
      config: { iceServers: [] },
      prepareNetworkRouteRetry: async () => null,
    });
    peer.setRoomPassword('12345678');
    await Promise.resolve();
    const primary = FakeWebSocket.instances[0];
    primary.dispatch('open');
    const primaryAuth = sentOfType(primary, 'host-auth')[0]!;

    primary.dispatch('error');
    await flushAsync();
    const alternate = FakeWebSocket.instances[1];
    alternate.dispatch('open');
    expect(sentOfType(alternate, 'host-auth')[0]).toMatchObject({
      secret: primaryAuth.secret,
      desiredRoomPassword: primaryAuth.desiredRoomPassword,
      pinMutationId: primaryAuth.pinMutationId,
    });

    alternate.dispatch('error');
    await vi.waitFor(() =>
      expect(
        bridgeRequests.some(
          (request) =>
            request.url.endsWith('/bridge/send') &&
            typeof request.body?.frame === 'string' &&
            (JSON.parse(request.body.frame) as Record<string, unknown>).type === 'host-auth',
        ),
      ).toBe(true),
    );
    const bridgeAuth = bridgeRequests.find(
      (request) =>
        request.url.endsWith('/bridge/send') &&
        typeof request.body?.frame === 'string' &&
        (JSON.parse(request.body.frame) as Record<string, unknown>).type === 'host-auth',
    );
    expect(JSON.parse(String(bridgeAuth?.body?.frame))).toMatchObject({
      secret: primaryAuth.secret,
      desiredRoomPassword: primaryAuth.desiredRoomPassword,
      pinMutationId: primaryAuth.pinMutationId,
    });
    peer.destroy();
  });

  it('does not open a route-retry successor after provisional setup is destroyed', async () => {
    installFakeWebSocket();
    const routeReady = deferred<RTCConfiguration | null>();
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      prepareNetworkRouteRetry: () => routeReady.promise,
    });
    await Promise.resolve();
    const retired = FakeWebSocket.instances[0];
    retired.dispatch('error');
    peer.destroy();
    expect(retired.closeCount).toBe(0);
    retired.dispatch('open');
    expect(retired.closeCount).toBe(1);
    expect(sentOfType(retired, 'host-auth')).toHaveLength(0);

    routeReady.resolve(null);
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('records final close metadata when an error reports CLOSED before its close event', async () => {
    installFakeWebSocket();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const routeReady = deferred<RTCConfiguration | null>();
    const peer = new CloudflareSignalingPeer(null, {
      provider: 'cloudflare',
      signalingUrl: PRIMARY_SIGNALING_URL,
      signalingFallbackUrl: FALLBACK_SIGNALING_URL,
      config: { iceServers: [] },
      prepareNetworkRouteRetry: () => routeReady.promise,
    });
    const conn = peer.connect('123456');
    const onError = vi.fn();
    conn.on('error', onError);
    const retired = FakeWebSocket.instances[0];

    retired.readyState = FakeWebSocket.CLOSED;
    retired.dispatch('error');
    expect(warn).toHaveBeenCalledWith(
      '[Transport] Guest signaling failed before admission; awaiting fresh route once',
      expect.objectContaining({ readyStateName: 'CLOSED', closeSuppressed: false }),
    );
    retired.dispatch('close', undefined, '', 1006, false);

    expect(onError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[Transport] Signaling socket reached terminal close after pre-admission retirement',
      expect.objectContaining({
        route: 'primary',
        everOpened: false,
        authSent: false,
        closeCode: 1006,
        closeClean: false,
        readyStateName: 'CLOSED',
      }),
    );

    peer.destroy();
    routeReady.resolve(null);
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('converges a silent CONNECTING guest socket through one bounded route retry', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const prepareNetworkRouteRetry = vi.fn(
      async (_signal: AbortSignal, _retrySignalingUrl: string) => null,
    );
    const peer = new CloudflareSignalingPeer(null, {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      prepareNetworkRouteRetry,
    });
    const conn = peer.connect('123456');
    expect(conn.recommendedPreOpenTimeoutMs).toBeUndefined();
    const onError = vi.fn(() => conn.close());
    conn.on('error', onError);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(prepareNetworkRouteRetry).toHaveBeenCalledOnce();
    expect(prepareNetworkRouteRetry).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      PRIMARY_SIGNALING_URL,
    );
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(new URL(FakeWebSocket.instances[1].url).origin).toBe('wss://signal.example.test');
    expect(FakeWebSocket.instances[0].closeCount).toBe(0);
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CONNECTING);
    expect(onError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[Transport] Guest signaling failed before admission; awaiting fresh route once',
      expect.objectContaining({
        route: 'primary',
        everOpened: false,
        authSent: false,
        admitted: false,
        elapsedMs: 3_000,
        closeCode: null,
        closeClean: null,
        readyState: FakeWebSocket.CONNECTING,
        readyStateName: 'CONNECTING',
        closeSuppressed: true,
      }),
    );

    await vi.advanceTimersByTimeAsync(3_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(2);
    peer.destroy();
  });

  it('bounds page-wide stuck setup handles and fails before creating another socket', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const handleLimit = __cloudflareSignalingForTests.maxPageSignalingSocketHandles;
    expect(handleLimit).toBeGreaterThanOrEqual(2);
    expect(handleLimit % 2).toBe(0);

    const exhaustedPeers: CloudflareSignalingPeer[] = [];
    for (let attempt = 0; attempt < handleLimit / 2; attempt++) {
      const peer = new CloudflareSignalingPeer(null, {
        provider: 'cloudflare',
        signalingUrl: 'wss://signal.example.test/api/rooms',
        config: { iceServers: [] },
        prepareNetworkRouteRetry: async () => null,
      });
      exhaustedPeers.push(peer);
      const conn = peer.connect('123456');
      conn.on('error', () => conn.close());

      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(FakeWebSocket.instances).toHaveLength(handleLimit);

    const blockedGuest = createGuestPeer();
    const blockedConn = blockedGuest.connect('654321');
    const guestError = vi.fn();
    blockedConn.on('error', guestError);
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(handleLimit);
    expect(guestError).toHaveBeenCalledOnce();
    expect(guestError.mock.calls[0]?.[0]).toMatchObject({
      type: 'network',
      message: 'SIGNALING_SOCKET_HANDLE_LIMIT_REACHED',
    });

    const blockedHost = createHostPeer();
    const hostError = vi.fn();
    blockedHost.on('error', hostError);
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(handleLimit);
    expect(hostError).toHaveBeenCalledOnce();
    expect(hostError.mock.calls[0]?.[0]).toMatchObject({
      type: 'network',
      message: 'SIGNALING_SOCKET_HANDLE_LIMIT_REACHED',
    });

    // A truly terminal socket returns one page-wide slot; the next explicit
    // attempt may create a physical socket immediately.
    FakeWebSocket.instances[0].dispatch('close');
    const recoveredPeer = createGuestPeer();
    recoveredPeer.connect('999999');
    expect(FakeWebSocket.instances).toHaveLength(handleLimit + 1);

    recoveredPeer.destroy();
    blockedGuest.destroy();
    blockedHost.destroy();
    for (const peer of exhaustedPeers) peer.destroy();
  });

  it('never closes CONNECTING setup sockets and retains them through a non-terminal error', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    FakeWebSocket.stallCloseWhileConnecting = true;
    const prepareNetworkRouteRetry = vi.fn(async () => null);
    const peer = new CloudflareSignalingPeer(null, {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      prepareNetworkRouteRetry,
    });
    const conn = peer.connect('123456');
    const onError = vi.fn(() => conn.close());
    conn.on('error', onError);

    await vi.advanceTimersByTimeAsync(3_000);
    const retired = FakeWebSocket.instances[0];
    const successor = FakeWebSocket.instances[1];
    expect(retired.closeCount).toBe(0);
    expect(retired.readyState).toBe(FakeWebSocket.CONNECTING);

    // Some CFNetwork failures emit error without moving readyState to CLOSED.
    // The retired handle must survive that notification so a late open can be
    // authority-fenced and closed safely from OPEN.
    retired.dispatch('error');
    expect(retired.closeCount).toBe(0);
    expect(retired.readyState).toBe(FakeWebSocket.CONNECTING);
    retired.dispatch('open');
    expect(retired.closeCount).toBe(1);
    expect(retired.readyState).toBe(FakeWebSocket.CLOSED);
    expect(sentOfType(retired, 'guest-auth')).toHaveLength(0);

    // The stale open must not clear the successor's admission watchdog.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(successor.closeCount).toBe(0);
    expect(successor.readyState).toBe(FakeWebSocket.CONNECTING);

    // Even after conn cleanup and peer destruction, the terminal successor is
    // retained until its own late open, then closed without CONNECTING poison.
    successor.dispatch('error');
    peer.destroy();
    successor.dispatch('open');
    expect(successor.closeCount).toBe(1);
    expect(successor.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('keeps superseded and destroyed CONNECTING guest handles until a safe late open', () => {
    installFakeWebSocket();
    FakeWebSocket.stallCloseWhileConnecting = true;
    const peer = new CloudflareSignalingPeer(null, {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
    });

    const firstConn = peer.connect('123456');
    const first = FakeWebSocket.instances[0];
    firstConn.close();
    expect(first.closeCount).toBe(0);
    expect(first.readyState).toBe(FakeWebSocket.CONNECTING);

    peer.connect('123456');
    const replacement = FakeWebSocket.instances[1];
    first.dispatch('error');
    first.dispatch('open');
    expect(first.closeCount).toBe(1);
    expect(sentOfType(first, 'guest-auth')).toHaveLength(0);

    peer.destroy();
    expect(replacement.closeCount).toBe(0);
    expect(replacement.readyState).toBe(FakeWebSocket.CONNECTING);
    replacement.dispatch('open');
    expect(replacement.closeCount).toBe(1);
    expect(sentOfType(replacement, 'guest-auth')).toHaveLength(0);
  });

  it('does not charge the guest identity-assertion wait to the CONNECTING watchdog', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const prepareNetworkRouteRetry = vi.fn(async () => null);
    const identity = deferred<{ accountAssertion: null; deletionAssertion: null } | undefined>();
    const peer = new CloudflareSignalingPeer(null, {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      prepareNetworkRouteRetry,
      standardRoomAssertionProvider: () => identity.promise,
    });
    peer.connect('123456');
    const socket = FakeWebSocket.instances[0];
    socket.dispatch('open');

    // The optional assertion wait expires at 2s. The admission watchdog starts
    // only after guest-auth is sent, so t=3.5s is still a healthy first socket.
    await vi.advanceTimersByTimeAsync(3_500);
    expect(sentOfType(socket, 'guest-auth')).toHaveLength(1);
    expect(prepareNetworkRouteRetry).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    peer.destroy();
  });

  it('converges a silent CONNECTING host claim without creating a third socket', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const prepareNetworkRouteRetry = vi.fn(async () => null);
    const peer = new CloudflareSignalingPeer('123456', {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
      config: { iceServers: [] },
      prepareNetworkRouteRetry,
    });
    const onError = vi.fn(() => peer.destroy());
    peer.on('error', onError);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(prepareNetworkRouteRetry).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(2);
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

  it('holds guest ICE candidates for the exact admitted socket after a reopen', async () => {
    const { peer, socket, pc } = await establishGuest();
    const onPeerError = vi.fn();
    peer.on('error', onPeerError);

    socket.close();

    pc.dispatch('icecandidate', {
      candidate: { toJSON: () => ({ candidate: 'cand-during-outage' }) },
    });
    expect(onPeerError).not.toHaveBeenCalled();

    peer.reconnect();
    const reopened = FakeWebSocket.instances[1];
    reopened.dispatch('open');

    pc.dispatch('icecandidate', {
      candidate: { toJSON: () => ({ candidate: 'cand-after-reopen' }) },
    });

    expect(sentOfType(reopened, 'signal-candidate')).toHaveLength(0);
    reopened.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '123456' }),
    );
    await vi.waitFor(() => expect(sentOfType(reopened, 'signal-candidate')).toHaveLength(2));

    const candidates = sentOfType(reopened, 'signal-candidate');
    expect(candidates.map((candidate) => candidate.candidate)).toEqual([
      { candidate: 'cand-during-outage' },
      { candidate: 'cand-after-reopen' },
    ]);
    expect(candidates.every((candidate) => candidate.to === 'host')).toBe(true);
    expect(sentOfType(socket, 'signal-candidate')).toHaveLength(0);
    expect(onPeerError).not.toHaveBeenCalled();
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
        negotiationId: NEGOTIATION_ID,
        callId: 'call-1',
        sdp: { type: 'offer', sdp: 'host-media-offer' },
        audioTrackCount: 1,
      }),
    );
    await flushAsync();
    expect(onCall).toHaveBeenCalledTimes(1);
    const mediaConn = onCall.mock.calls[0]?.[0] as TransportMediaConnection;
    const onError = vi.fn();
    mediaConn.on('error', onError);

    socket.close();
    peer.reconnect();
    const reopened = FakeWebSocket.instances[1];
    reopened.dispatch('open');

    mediaConn.answer();
    await flushAsync();

    expect(sentOfType(reopened, 'media-answer')).toHaveLength(0);
    expect(sentOfType(socket, 'media-answer')).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();

    reopened.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: 'mx-guest', roomId: '123456' }),
    );
    await vi.waitFor(() => expect(sentOfType(reopened, 'media-answer')).toHaveLength(1));

    const answers = sentOfType(reopened, 'media-answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]?.callId).toBe('call-1');
    expect(sentOfType(socket, 'media-answer')).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not send media-close before a reopened guest socket is admitted', async () => {
    const { peer, socket } = await establishGuest();
    const onCall = vi.fn();
    peer.on('call', onCall);
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'media-offer',
        from: 'host',
        negotiationId: NEGOTIATION_ID,
        callId: 'call-close-before-admission',
        sdp: { type: 'offer', sdp: 'host-media-offer' },
        audioTrackCount: 1,
      }),
    );
    await vi.waitFor(() => expect(onCall).toHaveBeenCalledTimes(1));
    const mediaConn = onCall.mock.calls[0]?.[0] as TransportMediaConnection;

    socket.close();
    peer.reconnect();
    const reopened = FakeWebSocket.instances[1];
    reopened.dispatch('open');
    await vi.waitFor(() => expect(sentOfType(reopened, 'guest-auth')).toHaveLength(1));

    mediaConn.close();
    await flushAsync();

    expect(sentOfType(reopened, 'media-close')).toHaveLength(0);
    expect(sentOfType(socket, 'media-close')).toHaveLength(0);
    expect(reopened.sent.map((raw) => JSON.parse(raw).type)).toEqual(['guest-auth']);
    peer.destroy();
  });

  it('sends an in-flight host data answer only after the recreated socket is admitted', async () => {
    installFakeWebSocket();
    installFakeRTCPeerConnection();
    const pendingAnswer = deferred<RTCSessionDescriptionInit>();
    const createAnswer = vi
      .spyOn(FakeRTCPeerConnection.prototype, 'createAnswer')
      .mockReturnValueOnce(pendingAnswer.promise);
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

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'signal-offer',
        from: 'guest-answer-reconnect',
        negotiationId: NEGOTIATION_ID,
        sdp: { type: 'offer', sdp: 'guest-data-offer' },
      }),
    );
    await vi.waitFor(() => expect(createAnswer).toHaveBeenCalledTimes(1));

    socket.close();
    peer.reconnect();
    const reopened = FakeWebSocket.instances[1];
    reopened.dispatch('open');
    pendingAnswer.resolve({ type: 'answer', sdp: 'host-data-answer-after-reconnect' });
    await vi.waitFor(() =>
      expect(FakeRTCPeerConnection.instances[0]?.localDescription?.sdp).toBe(
        'host-data-answer-after-reconnect',
      ),
    );

    expect(sentOfType(socket, 'signal-answer')).toHaveLength(0);
    expect(sentOfType(reopened, 'signal-answer')).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();

    reopened.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await vi.waitFor(() => expect(sentOfType(reopened, 'signal-answer')).toHaveLength(1));

    expect(sentOfType(reopened, 'signal-answer')[0]).toMatchObject({
      to: 'guest-answer-reconnect',
      negotiationId: NEGOTIATION_ID,
      sdp: { type: 'answer', sdp: 'host-data-answer-after-reconnect' },
    });
    expect(sentOfType(socket, 'signal-answer')).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
    peer.destroy();
  });

  it('holds host ICE candidates for the exact admitted recreated socket', async () => {
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
        negotiationId: NEGOTIATION_ID,
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

    expect(sentOfType(reopened, 'signal-candidate')).toHaveLength(0);
    reopened.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await vi.waitFor(() => expect(sentOfType(reopened, 'signal-candidate')).toHaveLength(1));

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
