import { log } from '../../core/log.ts';
import { clearManagedTimer, delay, setManagedTimer } from '../../core/timers.ts';
import { TinyEmitter } from './emitter.ts';
import type {
  TransportConnectOptions,
  TransportDataConnection,
  TransportMediaConnection,
  TransportPeer,
  TransportPeerOptions,
} from './types.ts';

type SignalingMessage =
  | { type: 'peer-open'; peerId: string; roomId: string }
  | { type: 'error'; errorType?: string; message?: string }
  | {
      type: 'signal-offer';
      from: string;
      sdp: RTCSessionDescriptionInit;
      metadata?: unknown;
    }
  | { type: 'signal-answer'; from: string; sdp: RTCSessionDescriptionInit }
  | { type: 'signal-candidate'; from: string; candidate: RTCIceCandidateInit }
  | {
      type: 'media-offer';
      from: string;
      callId: string;
      sdp: RTCSessionDescriptionInit;
      metadata?: Record<string, unknown>;
      audioTrackCount?: number;
    }
  | { type: 'media-answer'; from: string; callId: string; sdp: RTCSessionDescriptionInit }
  | { type: 'media-close'; from: string; callId: string }
  | { type: 'peer-left'; peerId: string };

type OutgoingSignal =
  | { type: 'room-password-set'; password: string }
  | { type: 'signal-offer'; to: 'host'; sdp: RTCSessionDescriptionInit; metadata?: unknown }
  | { type: 'signal-answer'; to: string; sdp: RTCSessionDescriptionInit }
  | { type: 'signal-candidate'; to: string; candidate: RTCIceCandidateInit }
  | {
      type: 'media-offer';
      to: string;
      callId: string;
      sdp: RTCSessionDescriptionInit;
      metadata?: Record<string, unknown>;
      audioTrackCount?: number;
    }
  | { type: 'media-answer'; to: 'host'; callId: string; sdp: RTCSessionDescriptionInit }
  | { type: 'media-close'; to: string | 'host'; callId: string }
  | { type: 'keepalive' };

const DATA_CHANNEL_LABEL = 'musixquare-data';
const BINARY_CHUNK_SENTINEL = '__mxqrBinaryChunk';
const DATA_CONNECTION_DISCONNECTED_GRACE_MS = 15_000;
const SIGNALING_KEEPALIVE_INTERVAL_MS = 25_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function randomBase64Url(bytes = 18): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let raw = '';
  for (const byte of data) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createTransportError(type: string, message: string): Error & { type: string } {
  const err = new Error(message) as Error & { type: string };
  err.type = type;
  return err;
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function encodePayload(data: unknown): string | ArrayBuffer {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const chunk = toUint8Array(record.chunk);
    if (chunk) {
      const header = { ...record, chunk: { [BINARY_CHUNK_SENTINEL]: true } };
      const headerBytes = textEncoder.encode(JSON.stringify(header));
      const frame = new Uint8Array(4 + headerBytes.byteLength + chunk.byteLength);
      new DataView(frame.buffer).setUint32(0, headerBytes.byteLength, false);
      frame.set(headerBytes, 4);
      frame.set(chunk, 4 + headerBytes.byteLength);
      return frame.buffer;
    }
  }
  return JSON.stringify(data);
}

function decodeBinaryPayload(frame: ArrayBuffer): unknown {
  if (frame.byteLength < 4) throw new Error('INVALID_BINARY_FRAME');
  const view = new DataView(frame);
  const headerLength = view.getUint32(0, false);
  if (headerLength <= 0 || headerLength > frame.byteLength - 4) {
    throw new Error('INVALID_BINARY_HEADER');
  }
  const bytes = new Uint8Array(frame);
  const headerJson = textDecoder.decode(bytes.slice(4, 4 + headerLength));
  const payload = JSON.parse(headerJson) as Record<string, unknown>;
  const marker = payload.chunk as Record<string, unknown> | undefined;
  if (!marker?.[BINARY_CHUNK_SENTINEL]) throw new Error('INVALID_BINARY_MARKER');
  payload.chunk = bytes.slice(4 + headerLength);
  return payload;
}

async function decodePayload(data: unknown): Promise<unknown> {
  if (typeof data === 'string') return JSON.parse(data);
  if (data instanceof ArrayBuffer) return decodeBinaryPayload(data);
  if (data instanceof Blob) return decodeBinaryPayload(await data.arrayBuffer());
  return data;
}

class CloudflareDataConnection extends TinyEmitter implements TransportDataConnection {
  open = false;
  peerConnection?: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  private closed = false;
  private readonly disconnectedTimerName: string;

  constructor(
    readonly peer: string,
    readonly metadata?: unknown,
  ) {
    super();
    this.disconnectedTimerName = `cloudflare-data-disconnected-${peer}-${randomBase64Url(8)}`;
  }

  attach(pc: RTCPeerConnection, channel: RTCDataChannel): void {
    this.peerConnection = pc;
    this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';

    channel.addEventListener('open', () => this.markOpen());
    channel.addEventListener('message', (event) => {
      decodePayload(event.data)
        .then((payload) => this.emit('data', payload))
        .catch((error) => this.emit('error', error));
    });
    channel.addEventListener('close', () => this.markClosed());
    channel.addEventListener('error', (event) => this.emit('error', event));

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        this.clearDisconnectedGrace();
        this.markClosed();
        return;
      }
      if (pc.connectionState === 'disconnected') {
        this.scheduleDisconnectedGrace();
        return;
      }
      this.clearDisconnectedGrace();
    });

    if (channel.readyState === 'open') queueMicrotask(() => this.markOpen());
  }

  send(data: unknown): void {
    const channel = this.dataChannel;
    if (!this.open || !channel || channel.readyState !== 'open') {
      throw createTransportError('webrtc', 'DATA_CHANNEL_NOT_OPEN');
    }
    const encoded = encodePayload(data);
    if (typeof encoded === 'string') channel.send(encoded);
    else channel.send(encoded);
  }

  close(): void {
    if (this.closed) return;
    try {
      this.dataChannel?.close();
    } catch {
      /* noop */
    }
    try {
      this.peerConnection?.close();
    } catch {
      /* noop */
    }
    this.markClosed();
  }

  private markOpen(): void {
    if (this.closed || this.open) return;
    this.open = true;
    this.emit('open');
  }

  private markClosed(): void {
    if (this.closed) return;
    this.clearDisconnectedGrace();
    this.closed = true;
    this.open = false;
    this.emit('close');
    this.clear();
  }

  private scheduleDisconnectedGrace(): void {
    if (this.closed) return;
    setManagedTimer(
      this.disconnectedTimerName,
      () => {
        const state = this.peerConnection?.connectionState;
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          this.markClosed();
        }
      },
      DATA_CONNECTION_DISCONNECTED_GRACE_MS,
    );
  }

  private clearDisconnectedGrace(): void {
    clearManagedTimer(this.disconnectedTimerName);
  }
}

class CloudflareMediaConnection extends TinyEmitter implements TransportMediaConnection {
  peerConnection?: RTCPeerConnection;
  private closed = false;
  private remoteOffer: RTCSessionDescriptionInit | null = null;
  private readonly remoteStream = new MediaStream();
  private remoteStreamEmitted = false;
  private remoteStreamTimerActive = false;
  private readonly localSenders: RTCRtpSender[] = [];
  private trackListener: ((event: RTCTrackEvent) => void) | null = null;
  private answerHandler: ((mediaConn: CloudflareMediaConnection, stream?: MediaStream) => Promise<void>) | null =
    null;
  private closeHandler: ((mediaConn: CloudflareMediaConnection, notifyRemote: boolean) => void) | null =
    null;

  constructor(
    readonly peer: string,
    readonly callId: string,
    readonly metadata: Record<string, unknown> | undefined,
    private readonly expectedAudioTrackCount: number,
  ) {
    super();
  }

  attachPeerConnection(pc: RTCPeerConnection): void {
    this.peerConnection = pc;
    this.trackListener = (event) => this.handleTrack(event);
    pc.addEventListener('track', this.trackListener);
  }

  setRemoteOffer(offer: RTCSessionDescriptionInit): void {
    this.remoteOffer = offer;
  }

  getRemoteOffer(): RTCSessionDescriptionInit | null {
    return this.remoteOffer;
  }

  setAnswerHandler(
    handler: (mediaConn: CloudflareMediaConnection, stream?: MediaStream) => Promise<void>,
  ): void {
    this.answerHandler = handler;
  }

  setCloseHandler(
    handler: (mediaConn: CloudflareMediaConnection, notifyRemote: boolean) => void,
  ): void {
    this.closeHandler = handler;
  }

  addLocalStream(stream: MediaStream): void {
    const pc = this.peerConnection;
    if (!pc) throw createTransportError('webrtc', 'MEDIA_PEER_CONNECTION_MISSING');
    for (const track of stream.getTracks()) {
      this.localSenders.push(pc.addTrack(track, stream));
    }
  }

  answer(stream?: MediaStream): void {
    if (!this.answerHandler) return;
    this.answerHandler(this, stream).catch((error) => this.emit('error', error));
  }

  close(): void {
    this.closeInternal(true);
  }

  closeFromRemote(): void {
    this.closeInternal(false);
  }

  private closeInternal(notifyRemote: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (this.remoteStreamTimerActive) {
      clearManagedTimer(this.remoteStreamTimerName());
      this.remoteStreamTimerActive = false;
    }
    const pc = this.peerConnection;
    if (pc) {
      for (const sender of this.localSenders) {
        try {
          pc.removeTrack(sender);
        } catch {
          /* noop */
        }
      }
      if (this.trackListener) {
        pc.removeEventListener('track', this.trackListener);
        this.trackListener = null;
      }
    }
    this.localSenders.length = 0;
    this.closeHandler?.(this, notifyRemote);
    this.emit('close');
    this.clear();
  }

  private handleTrack(event: RTCTrackEvent): void {
    if (this.closed || event.track.kind !== 'audio') return;

    const incomingStream = event.streams[0];
    const tracks = incomingStream?.getAudioTracks() ?? [event.track];
    for (const track of tracks) {
      if (!this.remoteStream.getTracks().some((existing) => existing.id === track.id)) {
        this.remoteStream.addTrack(track);
      }
    }

    event.track.addEventListener('ended', () => {
      if (this.remoteStream.getAudioTracks().every((track) => track.readyState === 'ended')) {
        this.closeFromRemote();
      }
    });

    this.scheduleRemoteStreamEmit();
  }

  private scheduleRemoteStreamEmit(): void {
    if (this.remoteStreamEmitted) return;
    const actual = this.remoteStream.getAudioTracks().length;
    const expected = Math.max(1, this.expectedAudioTrackCount || 1);
    if (actual >= expected) {
      this.emitRemoteStream();
      return;
    }

    if (this.remoteStreamTimerActive) return;
    this.remoteStreamTimerActive = true;
    setManagedTimer(this.remoteStreamTimerName(), () => {
      this.remoteStreamTimerActive = false;
      this.emitRemoteStream();
    }, 180);
  }

  private emitRemoteStream(): void {
    if (this.closed || this.remoteStreamEmitted) return;
    this.remoteStreamEmitted = true;
    this.emit('stream', this.remoteStream);
  }

  private remoteStreamTimerName(): string {
    return `cloudflare-media-stream-${this.callId}`;
  }
}

export class CloudflareSignalingPeer extends TinyEmitter implements TransportPeer {
  id?: string;
  open = false;
  destroyed = false;
  disconnected = false;

  private readonly connections = new Map<string, CloudflareDataConnection>();
  private readonly mediaCalls = new Map<string, CloudflareMediaConnection>();
  private readonly pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly roomSockets = new Map<string, WebSocket>();
  private readonly roomPasswords = new Map<string, string>();
  private hostSocket: WebSocket | null = null;
  private readonly hostRoomId: string | null;
  private readonly hostSecret = randomBase64Url(24);
  private roomPassword: string | null = null;

  constructor(
    requestedId: string | null,
    private readonly options: TransportPeerOptions,
  ) {
    super();
    this.hostRoomId = requestedId;
    this.id = requestedId ?? `mx-${randomBase64Url(12)}`;

    if (requestedId) {
      queueMicrotask(() => this.openHostSocket());
    } else {
      queueMicrotask(() => {
        if (this.destroyed || !this.id) return;
        this.open = true;
        this.disconnected = false;
        this.emit('open', this.id);
      });
    }
  }

  connect(roomId: string, options?: TransportConnectOptions): TransportDataConnection {
    if (this.destroyed) throw createTransportError('disconnected', 'PEER_DESTROYED');
    const conn = new CloudflareDataConnection(roomId, options?.metadata);
    const roomPassword =
      typeof options?.roomPassword === 'string' ? options.roomPassword.trim() : '';
    if (roomPassword) this.roomPasswords.set(roomId, roomPassword);
    else this.roomPasswords.delete(roomId);
    this.connections.set(roomId, conn);
    this.openGuestSocket(roomId, conn, options?.metadata, roomPassword);
    return conn;
  }

  call(
    peerId: string,
    stream: MediaStream,
    options?: { metadata?: Record<string, unknown> },
  ): TransportMediaConnection {
    if (this.destroyed) throw createTransportError('disconnected', 'PEER_DESTROYED');
    const conn = this.connections.get(peerId);
    const pc = conn?.peerConnection;
    if (!conn?.open || !pc) throw createTransportError('peer-unavailable', 'PEER_NOT_CONNECTED');

    const mediaConn = new CloudflareMediaConnection(
      peerId,
      randomBase64Url(12),
      options?.metadata,
      stream.getAudioTracks().length,
    );
    mediaConn.attachPeerConnection(pc);
    mediaConn.setCloseHandler((closedConn, notifyRemote) =>
      this.closeMediaCall(peerId, closedConn.callId, notifyRemote),
    );
    mediaConn.addLocalStream(stream);
    this.mediaCalls.set(mediaConn.callId, mediaConn);

    queueMicrotask(() => {
      this.startMediaOffer(peerId, mediaConn).catch((error) => mediaConn.emit('error', error));
    });

    return mediaConn;
  }

  reconnect(): void {
    if (this.destroyed) return;
    if (this.hostRoomId) {
      this.openHostSocket();
      return;
    }
    for (const [roomId, socket] of this.roomSockets) {
      if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        const conn = this.connections.get(roomId);
        if (conn) this.openGuestSocket(roomId, conn, conn.metadata, this.roomPasswords.get(roomId) || '');
      }
    }
  }

  setRoomPassword(password: string | null): void {
    if (!this.hostRoomId) return;
    const normalized = typeof password === 'string' && /^\d{8}$/.test(password) ? password : '';
    this.roomPassword = normalized || null;
    this.sendRoomPassword();
  }

  destroy(): void {
    this.destroyed = true;
    this.open = false;
    this.disconnected = false;
    for (const socket of this.roomSockets.values()) {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    }
    this.roomSockets.clear();
    try {
      this.hostSocket?.close();
    } catch {
      /* noop */
    }
    this.hostSocket = null;
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    for (const mediaConn of this.mediaCalls.values()) mediaConn.closeFromRemote();
    this.mediaCalls.clear();
    this.clear();
  }

  private requireSignalingUrl(): string {
    const url = this.options.signalingUrl;
    if (!url) throw createTransportError('server-error', 'CLOUDFLARE_SIGNALING_URL_MISSING');
    return url;
  }

  private buildSocketUrl(
    roomId: string,
    role: 'host' | 'guest',
    peerId: string,
    secret?: string,
  ): string {
    const base = new URL(this.requireSignalingUrl());
    if (base.protocol === 'http:') base.protocol = 'ws:';
    else if (base.protocol === 'https:') base.protocol = 'wss:';
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(roomId)}/ws`;
    base.searchParams.set('role', role);
    base.searchParams.set('peerId', peerId);
    if (secret) base.searchParams.set('secret', secret);
    return base.toString();
  }

  private send(socket: WebSocket | null | undefined, message: OutgoingSignal): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw createTransportError('socket-closed', 'SIGNALING_SOCKET_NOT_OPEN');
    }
    socket.send(JSON.stringify(message));
  }

  private startSocketKeepAlive(socket: WebSocket, timerName: string): void {
    setManagedTimer(
      timerName,
      () => {
        if (this.destroyed || socket.readyState !== WebSocket.OPEN) {
          clearManagedTimer(timerName);
          return;
        }
        try {
          socket.send(JSON.stringify({ type: 'keepalive' } satisfies OutgoingSignal));
        } catch {
          clearManagedTimer(timerName);
        }
      },
      SIGNALING_KEEPALIVE_INTERVAL_MS,
      { interval: true },
    );
  }

  private isDataConnectionAlive(conn: CloudflareDataConnection | undefined): boolean {
    if (!conn?.open) return false;
    const state = conn.peerConnection?.connectionState;
    return state !== 'closed' && state !== 'failed';
  }

  private sendRoomPassword(): void {
    if (!this.hostRoomId) return;
    const socket = this.hostSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      this.send(socket, { type: 'room-password-set', password: this.roomPassword || '' });
    } catch (error) {
      this.emit('error', error);
    }
  }

  private openHostSocket(): void {
    if (!this.hostRoomId || !this.id || this.destroyed) return;
    const existing = this.hostSocket;
    if (existing && existing.readyState !== WebSocket.CLOSED && existing.readyState !== WebSocket.CLOSING) {
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.buildSocketUrl(this.hostRoomId, 'host', this.id, this.hostSecret));
    } catch (error) {
      this.emit('error', error);
      return;
    }

    this.hostSocket = socket;
    const keepAliveTimerName = `cloudflare-signaling-keepalive-host-${this.id}`;
    socket.addEventListener('open', () => this.startSocketKeepAlive(socket, keepAliveTimerName));
    socket.addEventListener('message', (event) => {
      this.handleHostMessage(event.data).catch((error) => this.emit('error', error));
    });
    socket.addEventListener('close', () => {
      clearManagedTimer(keepAliveTimerName);
      if (this.destroyed) return;
      if (this.hostSocket === socket) {
        this.open = false;
        this.disconnected = true;
        this.emit('disconnected');
      }
    });
    socket.addEventListener('error', (event) => this.emit('error', event));
  }

  private openGuestSocket(
    roomId: string,
    conn: CloudflareDataConnection,
    metadata: unknown,
    roomPassword: string,
  ): void {
    if (!this.id) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.buildSocketUrl(roomId, 'guest', this.id));
    } catch (error) {
      queueMicrotask(() => conn.emit('error', error));
      return;
    }

    this.roomSockets.set(roomId, socket);
    const keepAliveTimerName = `cloudflare-signaling-keepalive-guest-${roomId}`;
    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ type: 'guest-auth', password: roomPassword || '' }));
        this.startSocketKeepAlive(socket, keepAliveTimerName);
      } catch (error) {
        conn.emit('error', error);
      }
    });
    socket.addEventListener('message', (event) => {
      this.handleGuestMessage(roomId, socket, conn, metadata, event.data).catch((error) =>
        conn.emit('error', error),
      );
    });
    socket.addEventListener('close', () => {
      clearManagedTimer(keepAliveTimerName);
      if (this.destroyed) return;
      if (this.roomSockets.get(roomId) === socket) {
        this.roomSockets.delete(roomId);
        if (conn.peerConnection) {
          this.disconnected = true;
          this.emit('disconnected');
        }
      }
    });
    socket.addEventListener('error', (event) => conn.emit('error', event));
  }

  private async parseSignal(raw: unknown): Promise<SignalingMessage> {
    if (typeof raw !== 'string') throw createTransportError('server-error', 'INVALID_SIGNAL');
    return JSON.parse(raw) as SignalingMessage;
  }

  private async handleHostMessage(raw: unknown): Promise<void> {
    const message = await this.parseSignal(raw);
    if (message.type === 'peer-open') {
      this.open = true;
      this.disconnected = false;
      this.emit('open', message.peerId);
      this.sendRoomPassword();
      return;
    }
    if (message.type === 'error') {
      this.emit('error', createTransportError(message.errorType ?? 'server-error', message.message ?? 'SIGNALING_ERROR'));
      return;
    }
    if (message.type === 'signal-offer') {
      await this.handleHostOffer(message.from, message.sdp, message.metadata);
      return;
    }
    if (message.type === 'signal-candidate') {
      await this.addRemoteCandidate(message.from, message.candidate);
      return;
    }
    if (message.type === 'media-answer') {
      await this.handleMediaAnswer(message.callId, message.sdp);
      return;
    }
    if (message.type === 'media-close') {
      this.mediaCalls.get(message.callId)?.closeFromRemote();
      this.mediaCalls.delete(message.callId);
      return;
    }
    if (message.type === 'peer-left') {
      const conn = this.connections.get(message.peerId);
      if (this.isDataConnectionAlive(conn)) {
        log.info(
          `[Transport] Ignoring signaling peer-left for ${message.peerId}; data channel is still alive`,
        );
        return;
      }
      conn?.close();
      for (const [callId, mediaConn] of this.mediaCalls) {
        if (mediaConn.peer === message.peerId) {
          mediaConn.closeFromRemote();
          this.mediaCalls.delete(callId);
        }
      }
    }
  }

  private async handleGuestMessage(
    roomId: string,
    socket: WebSocket,
    conn: CloudflareDataConnection,
    metadata: unknown,
    raw: unknown,
  ): Promise<void> {
    const message = await this.parseSignal(raw);
    if (message.type === 'peer-open') {
      this.disconnected = false;
      await this.startGuestOffer(roomId, socket, conn, metadata);
      return;
    }
    if (message.type === 'error') {
      conn.emit(
        'error',
        createTransportError(message.errorType ?? 'server-error', message.message ?? 'SIGNALING_ERROR'),
      );
      return;
    }
    if (message.type === 'signal-answer') {
      await this.handleGuestAnswer(roomId, message.sdp);
      return;
    }
    if (message.type === 'signal-candidate') {
      await this.addRemoteCandidate(roomId, message.candidate);
      return;
    }
    if (message.type === 'media-offer') {
      this.handleMediaOffer(roomId, socket, message).catch((error) => conn.emit('error', error));
      return;
    }
    if (message.type === 'media-close') {
      this.mediaCalls.get(message.callId)?.closeFromRemote();
      this.mediaCalls.delete(message.callId);
      return;
    }
    if (message.type === 'peer-left') {
      if (this.isDataConnectionAlive(conn)) {
        log.info('[Transport] Ignoring signaling peer-left for host; data channel is still alive');
        return;
      }
      conn.close();
    }
  }

  private createPeerConnection(peerId: string, socket: WebSocket): RTCPeerConnection {
    const pc = new RTCPeerConnection(this.options.config);
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return;
      try {
        this.send(socket, {
          type: 'signal-candidate',
          to: this.hostRoomId ? peerId : 'host',
          candidate: event.candidate.toJSON(),
        });
      } catch (error) {
        this.emit('error', error);
      }
    });
    return pc;
  }

  private async handleHostOffer(
    peerId: string,
    sdp: RTCSessionDescriptionInit,
    metadata: unknown,
  ): Promise<void> {
    const socket = this.hostSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    this.connections.get(peerId)?.close();
    const conn = new CloudflareDataConnection(peerId, metadata);
    const pc = this.createPeerConnection(peerId, socket);
    conn.peerConnection = pc;
    this.connections.set(peerId, conn);

    pc.addEventListener('datachannel', (event) => {
      conn.attach(pc, event.channel);
      this.emit('connection', conn);
    });

    await pc.setRemoteDescription(sdp);
    await this.flushRemoteCandidates(peerId);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (!pc.localDescription) throw createTransportError('webrtc', 'MISSING_LOCAL_DESCRIPTION');
    this.send(socket, { type: 'signal-answer', to: peerId, sdp: pc.localDescription.toJSON() });
  }

  private async startGuestOffer(
    roomId: string,
    socket: WebSocket,
    conn: CloudflareDataConnection,
    metadata: unknown,
  ): Promise<void> {
    if (conn.peerConnection) return;
    const pc = this.createPeerConnection(roomId, socket);
    const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, {
      ordered: true,
    });
    conn.attach(pc, channel);
    this.connections.set(roomId, conn);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (!pc.localDescription) throw createTransportError('webrtc', 'MISSING_LOCAL_DESCRIPTION');
    this.send(socket, {
      type: 'signal-offer',
      to: 'host',
      sdp: pc.localDescription.toJSON(),
      metadata,
    });
  }

  private async handleGuestAnswer(roomId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    const conn = this.connections.get(roomId);
    const pc = conn?.peerConnection;
    if (!pc) return;
    await pc.setRemoteDescription(sdp);
    await this.flushRemoteCandidates(roomId);
  }

  private async startMediaOffer(
    peerId: string,
    mediaConn: CloudflareMediaConnection,
  ): Promise<void> {
    const socket = this.hostSocket;
    const pc = mediaConn.peerConnection;
    if (!socket || socket.readyState !== WebSocket.OPEN || !pc) {
      throw createTransportError('socket-closed', 'SIGNALING_SOCKET_NOT_OPEN');
    }
    await this.waitForStableSignaling(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (!pc.localDescription) throw createTransportError('webrtc', 'MISSING_LOCAL_DESCRIPTION');
    this.send(socket, {
      type: 'media-offer',
      to: peerId,
      callId: mediaConn.callId,
      sdp: pc.localDescription.toJSON(),
      metadata: mediaConn.metadata,
      audioTrackCount: Math.max(1, pc.getSenders().filter((s) => s.track?.kind === 'audio').length),
    });
  }

  private async handleMediaOffer(
    roomId: string,
    socket: WebSocket,
    message: Extract<SignalingMessage, { type: 'media-offer' }>,
  ): Promise<void> {
    const conn = this.connections.get(roomId);
    const pc = conn?.peerConnection;
    if (!pc) throw createTransportError('webrtc', 'MEDIA_PEER_CONNECTION_MISSING');

    const existing = this.mediaCalls.get(message.callId);
    if (existing) existing.closeFromRemote();

    const mediaConn = new CloudflareMediaConnection(
      roomId,
      message.callId,
      message.metadata,
      message.audioTrackCount ?? 1,
    );
    mediaConn.attachPeerConnection(pc);
    mediaConn.setRemoteOffer(message.sdp);
    mediaConn.setAnswerHandler(async (incomingConn, stream) => {
      if (stream) incomingConn.addLocalStream(stream);
      const offer = incomingConn.getRemoteOffer();
      if (!offer) throw createTransportError('webrtc', 'MEDIA_OFFER_MISSING');
      await this.waitForStableSignaling(pc);
      await pc.setRemoteDescription(offer);
      await this.flushRemoteCandidates(roomId);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (!pc.localDescription) throw createTransportError('webrtc', 'MISSING_LOCAL_DESCRIPTION');
      this.send(socket, {
        type: 'media-answer',
        to: 'host',
        callId: incomingConn.callId,
        sdp: pc.localDescription.toJSON(),
      });
    });
    mediaConn.setCloseHandler((closedConn, notifyRemote) =>
      this.closeMediaCall(roomId, closedConn.callId, notifyRemote),
    );
    this.mediaCalls.set(message.callId, mediaConn);
    this.emit('call', mediaConn);
  }

  private async handleMediaAnswer(
    callId: string,
    sdp: RTCSessionDescriptionInit,
  ): Promise<void> {
    const mediaConn = this.mediaCalls.get(callId);
    const pc = mediaConn?.peerConnection;
    if (!mediaConn || !pc) return;
    await pc.setRemoteDescription(sdp);
    await this.flushRemoteCandidates(mediaConn.peer);
  }

  private closeMediaCall(peerId: string, callId: string, notifyRemote: boolean): void {
    this.mediaCalls.delete(callId);
    if (!notifyRemote) return;

    const socket = this.hostRoomId ? this.hostSocket : this.roomSockets.get(peerId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      this.send(socket, {
        type: 'media-close',
        to: this.hostRoomId ? peerId : 'host',
        callId,
      });
    } catch {
      /* noop */
    }
  }

  private async waitForStableSignaling(pc: RTCPeerConnection): Promise<void> {
    if (pc.signalingState === 'stable') return;
    await Promise.race([
      new Promise<void>((resolve) => {
        const onChange = (): void => {
          if (pc.signalingState !== 'stable') return;
          pc.removeEventListener('signalingstatechange', onChange);
          resolve();
        };
        pc.addEventListener('signalingstatechange', onChange);
      }),
      delay(3000),
    ]);
    const finalState = pc.signalingState as RTCSignalingState;
    if (finalState !== 'stable') {
      throw createTransportError('webrtc', `SIGNALING_NOT_STABLE:${finalState}`);
    }
  }

  private async addRemoteCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const conn = this.connections.get(peerId);
    const pc = conn?.peerConnection;
    if (!pc || !pc.remoteDescription) {
      const queued = this.pendingCandidates.get(peerId) ?? [];
      queued.push(candidate);
      this.pendingCandidates.set(peerId, queued);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      log.warn('[Transport] Failed to add ICE candidate:', error);
    }
  }

  private async flushRemoteCandidates(peerId: string): Promise<void> {
    const conn = this.connections.get(peerId);
    const pc = conn?.peerConnection;
    if (!pc) return;
    const queued = this.pendingCandidates.get(peerId) ?? [];
    this.pendingCandidates.delete(peerId);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        log.warn('[Transport] Failed to add queued ICE candidate:', error);
      }
    }
  }
}

export function createCloudflarePeer(
  requestedId: string | null,
  options: TransportPeerOptions,
): TransportPeer {
  log.info('[Transport] Using Cloudflare Durable Object signaling');
  return new CloudflareSignalingPeer(requestedId, options);
}
