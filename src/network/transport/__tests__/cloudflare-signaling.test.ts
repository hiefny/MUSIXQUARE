/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../../core/constants.ts';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import {
  FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES,
  FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
  FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES,
  FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_READY_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
  FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
} from '../../file-playback-transport-contract.ts';
import {
  createPeerRangeChunkFrames,
  createPeerRangeCloseHandleFrame,
  createPeerRangeErrorFrame,
  createPeerRangeReadFrame,
} from '../../../player/sources/peer-range-protocol.ts';
import { CloudflareDataConnection, CloudflareSignalingPeer } from '../cloudflare-signaling.ts';
import type { TransportDataConnection, TransportMediaConnection } from '../types.ts';
import {
  FILE_PLAYBACK_SESSION_HELLO_TYPE,
  FILE_PLAYBACK_SESSION_MAX_MESSAGE_BYTES,
} from '../../file-playback-session-handshake.ts';

const originalWebSocket = globalThis.WebSocket;
const originalRTCPeerConnection = globalThis.RTCPeerConnection;
const originalMediaStream = globalThis.MediaStream;
const frameTextEncoder = new TextEncoder();

function jsonFrameAtBytes(type: string, byteLength: number, escapedTypeKey = false): string {
  const typeKey = escapedTypeKey ? '\\u0074ype' : 'type';
  const prefix = `{"${typeKey}":"${type}","padding":"`;
  const suffix = '"}';
  const fixedBytes = frameTextEncoder.encode(prefix + suffix).byteLength;
  if (fixedBytes > byteLength) throw new RangeError('requested JSON frame is too small');
  const frame = `${prefix}${'x'.repeat(byteLength - fixedBytes)}${suffix}`;
  expect(frameTextEncoder.encode(frame).byteLength).toBe(byteLength);
  return frame;
}

function multibyteJsonFrameAtBytes(type: string, byteLength: number): string {
  const prefix = `{"type":"${type}","padding":"`;
  const suffix = '"}';
  const remaining = byteLength - frameTextEncoder.encode(prefix + suffix).byteLength;
  if (remaining < 0) throw new RangeError('requested JSON frame is too small');
  const frame = `${prefix}${'한'.repeat(Math.floor(remaining / 3))}${'x'.repeat(remaining % 3)}${suffix}`;
  expect(frameTextEncoder.encode(frame).byteLength).toBe(byteLength);
  return frame;
}

function encodeBinaryFrame(headerJson: string, totalFrameBytes: number): ArrayBuffer {
  const header = frameTextEncoder.encode(headerJson);
  const bodyLength = totalFrameBytes - 4 - header.byteLength;
  if (bodyLength < 0) throw new RangeError('requested binary frame is too small');
  const frame = new Uint8Array(totalFrameBytes);
  new DataView(frame.buffer).setUint32(0, header.byteLength, false);
  frame.set(header, 4);
  frame.fill(7, 4 + header.byteLength);
  return frame.buffer;
}

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
    setAlarm: async (): Promise<void> => {},
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

function privateMaps(peer: CloudflareSignalingPeer): {
  connections: Map<string, TransportDataConnection>;
  roomSockets: Map<string, FakeWebSocket>;
  guestRooms: Map<string, { conn: TransportDataConnection; authFailed: boolean }>;
} {
  return peer as unknown as {
    connections: Map<string, TransportDataConnection>;
    roomSockets: Map<string, FakeWebSocket>;
    guestRooms: Map<string, { conn: TransportDataConnection; authFailed: boolean }>;
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
      const hostUrl = new URL(hostClientSocket.url);
      const hostServerSocket = new ContractWorkerSocket();
      await room.acceptHost(
        hostServerSocket,
        '123456',
        hostUrl.searchParams.get('peerId') || '',
        hostUrl.searchParams.get('secret') || '',
      );

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
      const authFrame = sentOfType(guestClientSocket, 'guest-auth')[0];
      expect(authFrame).toEqual({ type: 'guest-auth', password: roomPassword });
      await room.webSocketMessage(guestServerSocket, JSON.stringify(authFrame));

      // In a passwordless room the Worker admitted the guest before the
      // client's no-op guest-auth; in a protected room it admits after auth.
      // Both paths must converge on the same peer-open/offer contract.
      expect(guestServerSocket.closed).toBe(false);
      const peerOpen = workerSentOfType(guestServerSocket, 'peer-open')[0];
      expect(peerOpen).toMatchObject({ type: 'peer-open', roomId: '123456' });
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
});

describe('Cloudflare signaling/data-channel boundary', () => {
  it('rejects oversized session JSON before materialization but preserves large playlist frames', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const received = vi.fn();
    const errors = vi.fn();
    conn.on('data', received);
    conn.on('error', errors);
    const oversized = `{"padding":"${'x'.repeat(FILE_PLAYBACK_SESSION_MAX_MESSAGE_BYTES)}","\\u0074ype":"${FILE_PLAYBACK_SESSION_HELLO_TYPE}"}`;
    control.dispatch('message', oversized);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    expect((errors.mock.calls[0]?.[0] as Error).message).toBe(
      'FILE_PLAYBACK_SESSION_FRAME_TOO_LARGE',
    );
    expect(received).not.toHaveBeenCalled();

    const playlist = JSON.stringify({
      type: MSG.PLAYLIST_UPDATE,
      list: [],
      currentQueueItemId: null,
      revision: 0,
      diagnosticPadding: 'p'.repeat(FILE_PLAYBACK_SESSION_MAX_MESSAGE_BYTES * 4),
    });
    control.dispatch('message', playlist);
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.PLAYLIST_UPDATE }));
  });

  it('enforces exact raw text budgets for bounded file-playback control frames', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const received = vi.fn();
    const errors = vi.fn();
    conn.on('data', received);
    conn.on('error', errors);

    expect(FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES).toBe(4 * 1024);
    const boundedTypes = [
      [FILE_MEDIA_SOURCE_OFFER_V2_TYPE, FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES],
      [
        FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
        FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES,
      ],
      [FILE_PLAYBACK_RUN_BINDING_V2_TYPE, FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES],
      [
        FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
        FILE_PLAYBACK_PRODUCT_BASELINE_V2_MAX_RAW_FRAME_BYTES,
      ],
      [FILE_PLAYBACK_PRODUCT_READY_V2_TYPE, FILE_PLAYBACK_PRODUCT_READY_V2_MAX_RAW_FRAME_BYTES],
    ] as const;
    for (const [type, budget] of boundedTypes) {
      const expectedReceived = received.mock.calls.length + 1;
      control.dispatch('message', jsonFrameAtBytes(type, budget));
      await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(expectedReceived));
      expect(received).toHaveBeenLastCalledWith(expect.objectContaining({ type }));

      const expectedErrors = errors.mock.calls.length + 1;
      control.dispatch('message', jsonFrameAtBytes(type, budget + 1, true));
      await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(expectedErrors));
      expect((errors.mock.calls.at(-1)?.[0] as Error).message).toBe(
        'FILE_PLAYBACK_CONTROL_FRAME_TOO_LARGE',
      );
    }
    expect(received).toHaveBeenCalledTimes(5);
    expect(errors).toHaveBeenCalledTimes(5);
  });

  it('measures multibyte text frames by UTF-8 bytes rather than UTF-16 length', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const received = vi.fn();
    const errors = vi.fn();
    conn.on('data', received);
    conn.on('error', errors);
    control.dispatch(
      'message',
      multibyteJsonFrameAtBytes(
        FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
        FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES,
      ),
    );
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));

    const oversized = `{"type":"${FILE_MEDIA_SOURCE_OFFER_V2_TYPE}","padding":"${'한'.repeat(
      Math.ceil(FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES / 3),
    )}"}`;
    expect(oversized.length).toBeLessThan(FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES);
    expect(frameTextEncoder.encode(oversized).byteLength).toBeGreaterThan(
      FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES,
    );
    control.dispatch('message', oversized);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    expect((errors.mock.calls[0]?.[0] as Error).message).toBe(
      'FILE_PLAYBACK_CONTROL_FRAME_TOO_LARGE',
    );
    expect(received).toHaveBeenCalledTimes(1);
  });

  it('keeps last-string duplicate semantics for protocol budgets, not a general frame cap', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const received = vi.fn();
    const errors = vi.fn();
    conn.on('data', received);
    conn.on('error', errors);
    const padding = 'x'.repeat(FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES);

    control.dispatch(
      'message',
      `{"type":"${FILE_MEDIA_SOURCE_OFFER_V2_TYPE}","padding":"${padding}","type":"${MSG.FILE_CHUNK}"}`,
    );
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    expect(received).toHaveBeenLastCalledWith(expect.objectContaining({ type: MSG.FILE_CHUNK }));

    control.dispatch(
      'message',
      `{"type":"${MSG.FILE_CHUNK}","padding":"${padding}","\\u0074ype":"${FILE_MEDIA_SOURCE_OFFER_V2_TYPE}"}`,
    );
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    expect((errors.mock.calls[0]?.[0] as Error).message).toBe(
      'FILE_PLAYBACK_CONTROL_FRAME_TOO_LARGE',
    );

    control.dispatch(
      'message',
      `{"type":"${FILE_PLAYBACK_RUN_BINDING_V2_TYPE}","padding":"${padding}","type":0}`,
    );
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
    expect(received).toHaveBeenCalledTimes(1);
  });

  it('uses the entire binary frame budget for bounded control headers', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const received = vi.fn();
    const errors = vi.fn();
    conn.on('data', received);
    conn.on('error', errors);
    const boundedTypes = [
      [FILE_MEDIA_SOURCE_OFFER_V2_TYPE, FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES],
      [
        FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
        FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES,
      ],
      [FILE_PLAYBACK_RUN_BINDING_V2_TYPE, FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES],
      [
        FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
        FILE_PLAYBACK_PRODUCT_BASELINE_V2_MAX_RAW_FRAME_BYTES,
      ],
      [FILE_PLAYBACK_PRODUCT_READY_V2_TYPE, FILE_PLAYBACK_PRODUCT_READY_V2_MAX_RAW_FRAME_BYTES],
    ] as const;

    for (const [type, budget] of boundedTypes) {
      const header = `{"chunk":{"__mxqrBinaryChunk":true},"type":"${type}"}`;
      const expectedReceived = received.mock.calls.length + 1;
      bulk.dispatch('message', encodeBinaryFrame(header, budget));
      await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(expectedReceived));
      expect(received).toHaveBeenLastCalledWith(
        expect.objectContaining({ type, chunk: expect.any(Uint8Array) }),
      );

      const escapedHeader = `{"chunk":{"__mxqrBinaryChunk":true},"\\u0074ype":"${type}"}`;
      const expectedErrors = errors.mock.calls.length + 1;
      bulk.dispatch('message', encodeBinaryFrame(escapedHeader, budget + 1));
      await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(expectedErrors));
      expect((errors.mock.calls.at(-1)?.[0] as Error).message).toBe(
        'FILE_PLAYBACK_CONTROL_FRAME_TOO_LARGE',
      );
    }
    expect(received).toHaveBeenCalledTimes(5);
    expect(errors).toHaveBeenCalledTimes(5);
  });

  it('snapshots native Blob ranges so subclass getters cannot bypass the raw budget', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const received = vi.fn();
    const errors = vi.fn();
    conn.on('data', received);
    conn.on('error', errors);
    const header = `{"chunk":{"__mxqrBinaryChunk":true},"type":"${FILE_MEDIA_SOURCE_OFFER_V2_TYPE}"}`;

    bulk.dispatch(
      'message',
      new Blob([encodeBinaryFrame(header, FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES)]),
    );
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));

    let sizeGetterCalls = 0;
    let sliceCalls = 0;
    let arrayBufferCalls = 0;
    class HostileBlob extends Blob {
      override get size(): number {
        sizeGetterCalls += 1;
        return FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES;
      }

      override slice(start?: number, end?: number, contentType?: string): Blob {
        sliceCalls += 1;
        return super.slice(start, end, contentType);
      }

      override arrayBuffer(): Promise<ArrayBuffer> {
        arrayBufferCalls += 1;
        return super.arrayBuffer();
      }
    }
    const hostile = new HostileBlob([
      encodeBinaryFrame(header, FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES + 1),
    ]);
    bulk.dispatch('message', hostile);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    expect((errors.mock.calls[0]?.[0] as Error).message).toBe(
      'FILE_PLAYBACK_CONTROL_FRAME_TOO_LARGE',
    );
    expect(received).toHaveBeenCalledTimes(1);
    expect(sizeGetterCalls).toBe(0);
    expect(sliceCalls).toBe(0);
    expect(arrayBufferCalls).toBe(0);
  });

  it('uses native ArrayBuffer length so subclasses cannot bypass full-frame budgets', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const received = vi.fn();
    const errors = vi.fn();
    conn.on('data', received);
    conn.on('error', errors);
    const header = `{"chunk":{"__mxqrBinaryChunk":true},"type":"${FILE_MEDIA_SOURCE_OFFER_V2_TYPE}"}`;
    const encoded = new Uint8Array(
      encodeBinaryFrame(header, FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES + 1),
    );
    let byteLengthGetterCalls = 0;
    class HostileArrayBuffer extends ArrayBuffer {
      override get byteLength(): number {
        byteLengthGetterCalls += 1;
        return FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES;
      }
    }
    const hostile = new HostileArrayBuffer(encoded.byteLength);
    new Uint8Array(hostile).set(encoded);

    bulk.dispatch('message', hostile);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    expect((errors.mock.calls[0]?.[0] as Error).message).toBe(
      'FILE_PLAYBACK_CONTROL_FRAME_TOO_LARGE',
    );
    expect(received).not.toHaveBeenCalled();
    expect(byteLengthGetterCalls).toBe(0);
  });

  it('applies the session preparse cap to binary headers without blocking bulk payload frames', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const received = vi.fn();
    const errors = vi.fn();
    conn.on('data', received);
    conn.on('error', errors);
    const encodeBinary = (headerJson: string, bodyLength = 1): ArrayBuffer => {
      const header = new TextEncoder().encode(headerJson);
      const frame = new Uint8Array(4 + header.byteLength + bodyLength);
      new DataView(frame.buffer).setUint32(0, header.byteLength, false);
      frame.set(header, 4);
      frame.fill(7, 4 + header.byteLength);
      return frame.buffer;
    };

    const oversizedSessionHeader = `{"padding":"${'x'.repeat(FILE_PLAYBACK_SESSION_MAX_MESSAGE_BYTES)}","chunk":{"__mxqrBinaryChunk":true},"\\u0074ype":"${FILE_PLAYBACK_SESSION_HELLO_TYPE}"}`;
    bulk.dispatch('message', encodeBinary(oversizedSessionHeader));
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    expect((errors.mock.calls[0]?.[0] as Error).message).toBe(
      'FILE_PLAYBACK_SESSION_FRAME_TOO_LARGE',
    );
    expect(received).not.toHaveBeenCalled();

    const smallSessionHeader = JSON.stringify({
      type: FILE_PLAYBACK_SESSION_HELLO_TYPE,
      chunk: { __mxqrBinaryChunk: true },
    });
    bulk.dispatch(
      'message',
      encodeBinary(smallSessionHeader, FILE_PLAYBACK_SESSION_MAX_MESSAGE_BYTES),
    );
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
    expect((errors.mock.calls[1]?.[0] as Error).message).toBe(
      'FILE_PLAYBACK_SESSION_FRAME_TOO_LARGE',
    );
    expect(received).not.toHaveBeenCalled();

    const largeFileChunkHeader = JSON.stringify({
      type: MSG.FILE_CHUNK,
      chunk: { __mxqrBinaryChunk: true },
      diagnosticPadding: 'f'.repeat(FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES * 2),
    });
    bulk.dispatch(
      'message',
      encodeBinary(largeFileChunkHeader, FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES * 2),
    );
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    expect(received).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: MSG.FILE_CHUNK, chunk: expect.any(Uint8Array) }),
    );
    expect((received.mock.calls[0]?.[0] as { chunk: Uint8Array }).chunk.byteLength).toBe(
      FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES * 2,
    );

    const largePeerRangeHeader = JSON.stringify({
      protocol: 'musixquare-peer-range',
      version: 1,
      lane: 'bulk',
      type: 'chunk',
      payload: { __mxqrBinaryPayload: true },
      diagnosticPadding: 'r'.repeat(FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES * 2),
    });
    bulk.dispatch(
      'message',
      encodeBinary(largePeerRangeHeader, FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES * 2),
    );
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(2));
    expect(received).toHaveBeenLastCalledWith(
      expect.objectContaining({
        protocol: 'musixquare-peer-range',
        payload: expect.any(ArrayBuffer),
      }),
    );
    expect((received.mock.calls[1]?.[0] as { payload: ArrayBuffer }).payload.byteLength).toBe(
      FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES * 2,
    );
  });

  it('opens only after both channels are ready and keeps ordered control frames off bulk', async () => {
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
      type: MSG.PLAY,
      time: 0,
      queueItemId: '00000000-0000-4000-8000-000000000001',
    });

    expect(control.sent).toHaveLength(2);
    expect(bulk.sent).toHaveLength(1);
    expect(
      control.sent
        .map((frame) => JSON.parse(frame as string) as { type: string })
        .map(({ type }) => type),
    ).toEqual([MSG.PLAYLIST_UPDATE, MSG.PLAY]);
    expect(bulk.sent[0]).toBeInstanceOf(ArrayBuffer);
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

  it('keeps peer range bytes and terminal errors on bulk with exact binary round trips', async () => {
    const conn = new CloudflareDataConnection('guest-1');
    const pc = new FakePeerConnection();
    const bulk = new FakeDataChannel('musixquare-data');
    const control = new FakeDataChannel('musixquare-control');
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const descriptor = createPeerRangeReadFrame({
      connectionId: 'connection-1',
      sourceIdentity: 'source-1',
      handleId: 'handle-1',
      requestId: 'request-1',
      offset: 64,
      totalLength: 4,
    });
    const chunk = createPeerRangeChunkFrames(descriptor, Uint8Array.of(7, 8, 9, 10))[0];
    const error = createPeerRangeErrorFrame(descriptor, 'unavailable', 'Source unavailable');
    const closeHandle = createPeerRangeCloseHandleFrame(descriptor);

    conn.send(descriptor);
    conn.send(closeHandle);
    conn.send(chunk);
    conn.send(error);

    expect(control.sent).toHaveLength(2);
    expect(JSON.parse(control.sent[1] as string)).toMatchObject({
      protocol: 'musixquare-peer-range',
      lane: 'control',
      type: 'close-handle',
    });
    expect(bulk.sent).toHaveLength(2);
    expect(bulk.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect(typeof bulk.sent[1]).toBe('string');

    const received: unknown[] = [];
    conn.on('data', (value) => received.push(value));
    bulk.dispatch('message', bulk.sent[0]);
    bulk.dispatch('message', bulk.sent[1]);
    control.dispatch('message', control.sent[1]);
    await vi.waitFor(() => expect(received).toHaveLength(3));

    expect(received[0]).toMatchObject({
      protocol: 'musixquare-peer-range',
      lane: 'bulk',
      type: 'chunk',
      payload: expect.any(ArrayBuffer),
    });
    expect(new Uint8Array((received[0] as { payload: ArrayBuffer }).payload)).toEqual(
      Uint8Array.of(7, 8, 9, 10),
    );
    expect(received[1]).toMatchObject({ type: 'error', code: 'unavailable' });
    expect(received[2]).toMatchObject({ lane: 'control', type: 'close-handle' });
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
    reopened.dispatch('open');
    expect(sentOfType(reopened, 'guest-auth')[0]?.password).toBe('12345678');

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
