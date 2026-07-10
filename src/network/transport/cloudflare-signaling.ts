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
  | { type: 'media-close'; to: string | 'host'; callId: string };

/**
 * Durable "this session wants a signaling socket" record for a guest room.
 * roomSockets is a transient handle map whose close handler deletes the
 * entry, so reopen decisions (reconnect) must derive from this registry,
 * never from the socket map itself.
 */
interface GuestRoomRecord {
  conn: CloudflareDataConnection;
  metadata: unknown;
  password: string;
  /**
   * Set when the DO rejects our stored password on an established session
   * (mid-session rotation). Excludes the room from reconnect(): peer.ts
   * resets its retry budget on every 'disconnected', so without this flag a
   * stale password becomes an indefinite failed-auth hammer against the DO
   * rate limit. An explicit connect() re-join writes a fresh record and
   * re-arms reconnect.
   */
  authFailed: boolean;
}

const DATA_CHANNEL_LABEL = 'musixquare-data';
const CONTROL_CHANNEL_LABEL = 'musixquare-control';
const BINARY_CHUNK_SENTINEL = '__mxqrBinaryChunk';
const MAX_PENDING_ICE_CANDIDATES_PER_PEER = 64;
const MAX_PENDING_ICE_BYTES_PER_PEER = 64 * 1024;
const MAX_PENDING_ICE_PEERS = 32;
const MAX_PENDING_ICE_TOTAL_BYTES = MAX_PENDING_ICE_PEERS * MAX_PENDING_ICE_BYTES_PER_PEER;
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

function isBulkPayload(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return !!toUint8Array((data as Record<string, unknown>).chunk);
}

export class CloudflareDataConnection extends TinyEmitter implements TransportDataConnection {
  open = false;
  peerConnection?: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  controlChannel?: RTCDataChannel;
  private closed = false;
  private pcListenersAttached = false;

  constructor(
    readonly peer: string,
    readonly metadata?: unknown,
  ) {
    super();
  }

  attach(pc: RTCPeerConnection, channel: RTCDataChannel): boolean {
    this.peerConnection = pc;
    const isControl = channel.label === CONTROL_CHANNEL_LABEL;
    if (isControl) this.controlChannel = channel;
    else this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';

    channel.addEventListener('open', () => {
      if (!isControl) this.markOpen();
    });
    channel.addEventListener('message', (event) => {
      decodePayload(event.data)
        .then((payload) => this.emit('data', payload))
        .catch((error) => this.emit('error', error));
    });
    channel.addEventListener('close', () => {
      if (isControl) {
        if (this.controlChannel === channel) this.controlChannel = undefined;
        return;
      }
      this.markClosed();
    });
    channel.addEventListener('error', (event) => this.emit('error', event));

    if (!this.pcListenersAttached) {
      this.pcListenersAttached = true;
      pc.addEventListener('connectionstatechange', () => {
        if (
          pc.connectionState === 'closed' ||
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected'
        ) {
          this.markClosed();
        }
      });
    }

    if (!isControl && channel.readyState === 'open') queueMicrotask(() => this.markOpen());
    return !isControl;
  }

  send(data: unknown): void {
    // Keep latency-sensitive control frames (PLAY/PAUSE/SYNC/etc.) off the
    // ordered bulk stream. iOS can throttle a backgrounded receiver while file
    // chunks keep queuing; sharing one stream lets playback commands sit behind
    // those chunks for seconds after the app returns.
    const bulk = isBulkPayload(data);
    const preferredChannel = bulk ? this.dataChannel : this.controlChannel;
    const fallbackChannel = bulk ? undefined : this.dataChannel;
    const channel =
      preferredChannel?.readyState === 'open'
        ? preferredChannel
        : fallbackChannel?.readyState === 'open'
          ? fallbackChannel
          : null;
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
      this.controlChannel?.close();
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
    this.closed = true;
    this.open = false;
    this.emit('close');
    this.clear();
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
  private answerHandler:
    | ((mediaConn: CloudflareMediaConnection, stream?: MediaStream) => Promise<void>)
    | null = null;
  private closeHandler:
    | ((mediaConn: CloudflareMediaConnection, notifyRemote: boolean) => void)
    | null = null;

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
    setManagedTimer(
      this.remoteStreamTimerName(),
      () => {
        this.remoteStreamTimerActive = false;
        this.emitRemoteStream();
      },
      180,
    );
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
  private readonly pendingCandidates = new Map<
    string,
    { candidates: RTCIceCandidateInit[]; bytes: number }
  >();
  private pendingCandidateBytes = 0;
  private readonly roomSockets = new Map<string, WebSocket>();
  private readonly guestRooms = new Map<string, GuestRoomRecord>();
  private hostSocket: WebSocket | null = null;
  private readonly hostRoomId: string | null;
  private readonly hostSecret = randomBase64Url(24);
  private readonly guestReconnectSecret = randomBase64Url(24);
  private roomPassword: string | null = null;

  private deletePendingCandidates(peerId: string): void {
    const queued = this.pendingCandidates.get(peerId);
    if (queued) this.pendingCandidateBytes = Math.max(0, this.pendingCandidateBytes - queued.bytes);
    this.pendingCandidates.delete(peerId);
  }

  private clearPendingCandidates(): void {
    this.pendingCandidates.clear();
    this.pendingCandidateBytes = 0;
  }

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
    this.guestRooms.set(roomId, {
      conn,
      metadata: options?.metadata,
      password: roomPassword,
      authFailed: false,
    });
    this.connections.set(roomId, conn);
    conn.on('close', () => {
      // Identity-guarded cleanup: a late 'close' from a conn replaced by a
      // newer connect() for the same room must not evict the live records.
      // Also drops queued candidates so a dead peer cannot grow
      // pendingCandidates unbounded.
      if (this.guestRooms.get(roomId)?.conn === conn) this.guestRooms.delete(roomId);
      if (this.connections.get(roomId) === conn) {
        this.connections.delete(roomId);
        this.deletePendingCandidates(roomId);
      }
    });
    // Deliberately NOT ensureGuestSocket: a re-join over a still-open socket
    // must REPLACE it, because the old socket's message listeners are
    // closure-bound to the previous (dead) conn. The DO closes the replaced
    // socket (GUEST_REPLACED) and the identity-guarded socket close handler
    // ignores that late close.
    this.openGuestSocket(roomId);
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
    for (const [roomId, record] of this.guestRooms) {
      // Dead sessions belong to the join/HOST_DISCONNECTED re-join path, and
      // mid-handshake conns (peerConnection set, open=false) stay with the
      // join timeout — reconnect only serves established sessions whose
      // signaling socket blipped.
      if (!this.isDataConnectionAlive(record.conn)) continue;
      this.ensureGuestSocket(roomId);
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
    this.guestRooms.clear();
    this.clearPendingCandidates();
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

  private isDataConnectionAlive(conn: CloudflareDataConnection | undefined): boolean {
    if (!conn?.open) return false;
    const state = conn.peerConnection?.connectionState;
    return state !== 'closed' && state !== 'failed';
  }

  private handleSignalingSocketError(
    socket: WebSocket,
    options: {
      label: string;
      isEstablished: () => boolean;
      emitPreOpenError: (event: Event) => void;
    },
    event: Event,
  ): void {
    if (!options.isEstablished()) {
      options.emitPreOpenError(event);
      return;
    }

    log.warn(`[Transport] ${options.label} signaling socket error; preserving data channel`, event);
    try {
      socket.close();
    } catch {
      /* noop */
    }
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
    if (
      existing &&
      existing.readyState !== WebSocket.CLOSED &&
      existing.readyState !== WebSocket.CLOSING
    ) {
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(
        this.buildSocketUrl(this.hostRoomId, 'host', this.id, this.hostSecret),
      );
    } catch (error) {
      this.emit('error', error);
      return;
    }

    this.hostSocket = socket;
    socket.addEventListener('message', (event) => {
      this.handleHostMessage(event.data).catch((error) => this.emit('error', error));
    });
    socket.addEventListener('close', () => {
      if (this.destroyed) return;
      if (this.hostSocket === socket) {
        this.clearPendingCandidates();
        this.open = false;
        this.disconnected = true;
        this.emit('disconnected');
      }
    });
    socket.addEventListener('error', (event) =>
      this.handleSignalingSocketError(
        socket,
        {
          label: 'Host',
          isEstablished: () => this.open,
          emitPreOpenError: (error) => this.emit('error', error),
        },
        event,
      ),
    );
  }

  /**
   * Idempotent reopen used by reconnect(): mirrors openHostSocket's
   * readyState guard. Never stacks a second socket on a CONNECTING/OPEN one
   * — the DO would close the older with GUEST_REPLACED, whose close re-emits
   * 'disconnected' -> peer.ts budget reset -> permanent open/close
   * oscillation.
   */
  private ensureGuestSocket(roomId: string): void {
    const record = this.guestRooms.get(roomId);
    if (!record || record.authFailed) return;
    const existing = this.roomSockets.get(roomId);
    if (
      existing &&
      existing.readyState !== WebSocket.CLOSED &&
      existing.readyState !== WebSocket.CLOSING
    ) {
      return;
    }
    this.openGuestSocket(roomId);
  }

  private openGuestSocket(roomId: string): void {
    const record = this.guestRooms.get(roomId);
    if (!record || !this.id) return;
    const { conn, metadata, password } = record;
    let socket: WebSocket;
    try {
      socket = new WebSocket(
        this.buildSocketUrl(roomId, 'guest', this.id, this.guestReconnectSecret),
      );
    } catch (error) {
      queueMicrotask(() => conn.emit('error', error));
      return;
    }

    this.roomSockets.set(roomId, socket);
    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ type: 'guest-auth', password: password || '' }));
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
      if (this.destroyed) return;
      if (this.roomSockets.get(roomId) === socket) {
        this.roomSockets.delete(roomId);
        this.deletePendingCandidates(roomId);
        if (conn.peerConnection) {
          this.disconnected = true;
          this.emit('disconnected');
        }
      }
    });
    socket.addEventListener('error', (event) =>
      this.handleSignalingSocketError(
        socket,
        {
          label: 'Guest',
          isEstablished: () => this.isDataConnectionAlive(conn),
          emitPreOpenError: (error) => conn.emit('error', error),
        },
        event,
      ),
    );
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
      this.emit(
        'error',
        createTransportError(
          message.errorType ?? 'server-error',
          message.message ?? 'SIGNALING_ERROR',
        ),
      );
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
      // Signaling departure always ends ICE trickle for this socket identity,
      // even when the already-established data channel is intentionally kept.
      this.deletePendingCandidates(message.peerId);
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
      const error = createTransportError(
        message.errorType ?? 'server-error',
        message.message ?? 'SIGNALING_ERROR',
      );
      if (this.isDataConnectionAlive(conn)) {
        // DO rejection frames become reachable on established sessions once
        // reconnect() actually reopens guest sockets: HOST_NOT_AVAILABLE
        // (guest reconnects while the host's signaling is also down) and
        // room-password-* (mid-session rotation). These are signaling-plane
        // failures; funneling them to conn 'error' would let guest.ts tear
        // down a working data channel. Mirror the established-socket-error
        // policy instead: log, close the socket, keep the channel. The
        // worker closes the socket after sending the frame anyway, and the
        // socket close handler still emits 'disconnected' so peer.ts backoff
        // keeps running.
        if (message.errorType?.startsWith('room-password-')) {
          const record = this.guestRooms.get(roomId);
          if (record?.conn === conn) record.authFailed = true;
        }
        log.warn(
          '[Transport] Guest signaling rejected after establishment; preserving data channel',
          error,
        );
        try {
          socket.close();
        } catch {
          /* noop */
        }
        return;
      }
      conn.emit('error', error);
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
      this.handleMediaOffer(roomId, message).catch((error) => conn.emit('error', error));
      return;
    }
    if (message.type === 'media-close') {
      this.mediaCalls.get(message.callId)?.closeFromRemote();
      this.mediaCalls.delete(message.callId);
      return;
    }
    if (message.type === 'peer-left') {
      this.deletePendingCandidates(roomId);
      if (this.isDataConnectionAlive(conn)) {
        log.info('[Transport] Ignoring signaling peer-left for host; data channel is still alive');
        return;
      }
      conn.close();
    }
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection(this.options.config);
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return;
      // This listener outlives any individual signaling socket (candidates
      // can trickle after a socket blip + reopen), so resolve the CURRENT
      // socket at send time instead of capturing one. On the guest side
      // peerId IS the roomId (startGuestOffer passes it), which is exactly
      // the roomSockets key. send(undefined, ...) throws the same
      // 'socket-closed' SIGNALING_SOCKET_NOT_OPEN as the captured path did.
      const socket = this.hostRoomId ? this.hostSocket : this.roomSockets.get(peerId);
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
    const pc = this.createPeerConnection(peerId);
    conn.peerConnection = pc;
    this.connections.set(peerId, conn);
    conn.on('close', () => {
      // Identity-guarded: a late close from a conn replaced by a newer offer
      // for the same peer must not evict the live record (handleHostOffer
      // closes the old conn before installing the new one).
      if (this.connections.get(peerId) === conn) {
        this.connections.delete(peerId);
        this.deletePendingCandidates(peerId);
      }
    });

    pc.addEventListener('datachannel', (event) => {
      const shouldEmitConnection = conn.attach(pc, event.channel);
      if (shouldEmitConnection) this.emit('connection', conn);
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
    const pc = this.createPeerConnection(roomId);
    const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, {
      ordered: true,
    });
    const controlChannel = pc.createDataChannel(CONTROL_CHANNEL_LABEL, {
      ordered: true,
    });
    conn.attach(pc, channel);
    conn.attach(pc, controlChannel);
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
      // answer() may run long after the socket that delivered the offer died
      // (signaling blip + reopen mid system-audio handshake), so resolve the
      // current room socket at send time. send(undefined, ...) throws the
      // same 'socket-closed' SIGNALING_SOCKET_NOT_OPEN as the captured path.
      this.send(this.roomSockets.get(roomId), {
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

  private async handleMediaAnswer(callId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
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
      let candidateBytes: number;
      try {
        candidateBytes = textEncoder.encode(JSON.stringify(candidate)).byteLength;
      } catch {
        log.warn('[Transport] Dropping non-serializable ICE candidate');
        return;
      }
      const existing = this.pendingCandidates.get(peerId);
      if (!existing && this.pendingCandidates.size >= MAX_PENDING_ICE_PEERS) {
        log.warn('[Transport] Pending ICE peer limit reached; dropping candidate');
        return;
      }
      const queued = existing ?? { candidates: [], bytes: 0 };
      if (
        queued.candidates.length >= MAX_PENDING_ICE_CANDIDATES_PER_PEER ||
        candidateBytes > MAX_PENDING_ICE_BYTES_PER_PEER ||
        queued.bytes + candidateBytes > MAX_PENDING_ICE_BYTES_PER_PEER ||
        this.pendingCandidateBytes + candidateBytes > MAX_PENDING_ICE_TOTAL_BYTES
      ) {
        log.warn(`[Transport] Pending ICE limit reached for ${peerId}; dropping candidate`);
        return;
      }
      queued.candidates.push(candidate);
      queued.bytes += candidateBytes;
      this.pendingCandidateBytes += candidateBytes;
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
    const queued = this.pendingCandidates.get(peerId)?.candidates ?? [];
    this.deletePendingCandidates(peerId);
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
