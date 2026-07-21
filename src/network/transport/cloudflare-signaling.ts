import { log } from '../../core/log.ts';
import { MSG } from '../../core/constants.ts';
import { clearManagedTimer, delay, setManagedTimer } from '../../core/timers.ts';
import { TinyEmitter } from './emitter.ts';
import type {
  DeveloperCommandFrame,
  DeveloperInvalidationFrame,
  ProQueueAdditionFrame,
  ProSignalingOptions,
  TransportConnectOptions,
  TransportDataConnection,
  TransportMediaConnection,
  TransportPeer,
  TransportPeerOptions,
  StandardRoomIdentityAssertions,
  StandardRoomIdentityClearReason,
  StandardRoomMemberIdentity,
} from './types.ts';
import {
  parseDeveloperCommandFrame,
  parseDeveloperInvalidationFrame,
  parseProQueueAdditionFrame,
} from './types.ts';

type SignalingMessage =
  | {
      type: 'peer-open';
      peerId: string;
      roomId: string;
      workerVersionId?: string;
      memberIdentity?: StandardRoomMemberIdentity;
    }
  | { type: 'error'; errorType?: string; message?: string }
  | {
      type: 'signal-offer';
      from: string;
      sdp: RTCSessionDescriptionInit;
      metadata?: unknown;
      memberIdentity?: StandardRoomMemberIdentity;
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
  | { type: 'peer-left'; peerId: string }
  | {
      type: 'account-identity';
      memberIdentity: StandardRoomMemberIdentity | null;
      clearReason?: StandardRoomIdentityClearReason;
    }
  | {
      type: 'account-member-updated';
      peerId: string;
      memberIdentity: StandardRoomMemberIdentity | null;
      clearReason?: StandardRoomIdentityClearReason;
    }
  | { type: 'account-member-deleted'; memberId: string }
  | DeveloperCommandFrame
  | DeveloperInvalidationFrame
  | ProQueueAdditionFrame;

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

function normalizeStandardRoomMemberIdentity(value: unknown): StandardRoomMemberIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(',') !==
      'isAuthenticated,memberDisplayNumber,memberId,nickname' ||
    typeof candidate.memberId !== 'string' ||
    !/^member_[A-Za-z0-9_-]{22}$/.test(candidate.memberId) ||
    !Number.isSafeInteger(candidate.memberDisplayNumber) ||
    (candidate.memberDisplayNumber as number) < 0 ||
    (candidate.memberDisplayNumber as number) > 99 ||
    typeof candidate.nickname !== 'string' ||
    !candidate.nickname.trim() ||
    [...candidate.nickname].length > 20 ||
    candidate.isAuthenticated !== true
  ) {
    return null;
  }
  return {
    memberId: candidate.memberId,
    memberDisplayNumber: candidate.memberDisplayNumber as number,
    nickname: candidate.nickname.normalize('NFC').trim(),
    isAuthenticated: true,
  };
}

function normalizeStandardRoomIdentityAssertions(
  value: unknown,
): StandardRoomIdentityAssertions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const accountAssertion = candidate.accountAssertion;
  const deletionAssertion = candidate.deletionAssertion;
  if (
    (accountAssertion !== null &&
      (typeof accountAssertion !== 'string' ||
        accountAssertion.length < 3 ||
        accountAssertion.length > 2048)) ||
    (deletionAssertion !== null &&
      (typeof deletionAssertion !== 'string' ||
        deletionAssertion.length < 3 ||
        deletionAssertion.length > 2048)) ||
    (accountAssertion && deletionAssertion)
  ) {
    return null;
  }
  return {
    accountAssertion: accountAssertion as string | null,
    deletionAssertion: deletionAssertion as string | null,
  };
}

/**
 * Durable "this session wants a signaling socket" record for a guest room.
 * roomSockets is a transient handle map whose close handler deletes the
 * entry, so reopen decisions must derive from this registry,
 * never from the socket map itself.
 */
interface GuestRoomRecord {
  conn: CloudflareDataConnection;
  metadata: unknown;
  password: string;
  /**
   * Set when the DO rejects our stored password on an established session
   * (mid-session rotation). Excludes the room from automatic reconnect; the
   * outer retry loop resets its budget on every 'disconnected', so without
   * this flag a stale password becomes an indefinite failed-auth hammer
   * against the DO rate limit. An explicit connect() re-join writes a fresh
   * record and re-arms reconnect.
   */
  authFailed: boolean;
}

const DATA_CHANNEL_LABEL = 'musixquare-data';
const CONTROL_CHANNEL_LABEL = 'musixquare-control';
const BINARY_CHUNK_SENTINEL = '__mxqrBinaryChunk';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function randomBase64Url(bytes = 18): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let raw = '';
  for (const byte of data) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

interface ProTicketClaims {
  roomCode: string;
  participantId: string;
  role: 'coordinator' | 'member';
  coordinatorEpoch: number;
  presenceIncarnationId: string;
  ticketSequence: number;
}

function proTicketClaims(ticket: string): ProTicketClaims | null {
  const encoded = ticket.split('.')[0];
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const padding = '='.repeat((4 - (encoded.length % 4)) % 4);
    const raw = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + padding);
    const payload = JSON.parse(
      textDecoder.decode(Uint8Array.from(raw, (character) => character.charCodeAt(0))),
    ) as Partial<ProTicketClaims>;
    if (
      typeof payload.roomCode !== 'string' ||
      !/^\d{6}$/.test(payload.roomCode) ||
      typeof payload.participantId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,96}$/.test(payload.participantId) ||
      (payload.role !== 'coordinator' && payload.role !== 'member') ||
      !Number.isSafeInteger(payload.coordinatorEpoch) ||
      (payload.coordinatorEpoch ?? 0) < 1 ||
      typeof payload.presenceIncarnationId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(payload.presenceIncarnationId) ||
      !Number.isSafeInteger(payload.ticketSequence) ||
      (payload.ticketSequence ?? 0) < 1
    ) {
      return null;
    }
    return payload as ProTicketClaims;
  } catch {
    return null;
  }
}

function createTransportError(type: string, message: string): Error & { type: string } {
  const err = new Error(message) as Error & { type: string };
  err.type = type;
  return err;
}

function isPermanentGuestAuthError(errorType: string | undefined): boolean {
  return errorType?.startsWith('room-password-') === true || errorType === 'guest-reconnect-denied';
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
  const payload = data as Record<string, unknown>;
  if (toUint8Array(payload.chunk)) return true;

  // OPERATOR_FILE_UPLOAD_CHUNK is carried by the ordered bulk channel. Keep
  // its terminal fence on that same channel as well: ordering is guaranteed
  // within one RTCDataChannel, but not between the bulk and control channels.
  // Without this exception FINISH can overtake the final chunk on a slower
  // receiver and make an otherwise valid administrator upload look corrupt.
  return payload.type === MSG.OPERATOR_FILE_UPLOAD_FINISH;
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
    public roomIdentity: StandardRoomMemberIdentity | null = null,
  ) {
    super();
  }

  updateRoomIdentity(
    identity: StandardRoomMemberIdentity | null,
    clearReason?: StandardRoomIdentityClearReason,
  ): void {
    this.roomIdentity = identity;
    this.emit('identity', identity, clearReason);
  }

  attach(pc: RTCPeerConnection, channel: RTCDataChannel): boolean {
    this.peerConnection = pc;
    const isControl = channel.label === CONTROL_CHANNEL_LABEL;
    if (isControl) this.controlChannel = channel;
    else this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';

    channel.addEventListener('open', () => {
      this.markOpenIfReady();
    });
    channel.addEventListener('message', (event) => {
      decodePayload(event.data)
        .then((payload) => this.emit('data', payload))
        .catch((error) => this.emit('error', error));
    });
    channel.addEventListener('close', () => {
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

    if (channel.readyState === 'open') queueMicrotask(() => this.markOpenIfReady());
    return !isControl;
  }

  send(data: unknown): void {
    // Keep latency-sensitive control frames (PLAY/PAUSE/SYNC/etc.) off the
    // ordered bulk stream. iOS can throttle a backgrounded receiver while file
    // chunks keep queuing; sharing one stream lets playback commands sit behind
    // those chunks for seconds after the app returns.
    const bulk = isBulkPayload(data);
    const channel = bulk ? this.dataChannel : this.controlChannel;
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

  private markOpenIfReady(): void {
    if (this.closed || this.open) return;
    if (this.dataChannel?.readyState !== 'open' || this.controlChannel?.readyState !== 'open') {
      return;
    }
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
  private readonly pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly roomSockets = new Map<string, WebSocket>();
  private readonly guestRooms = new Map<string, GuestRoomRecord>();
  /** RAM-only per-room proof; survives conn replacement but never a page reload. */
  private readonly guestReconnectSecrets = new Map<string, string>();
  private hostSocket: WebSocket | null = null;
  private readonly hostRoomId: string | null;
  private readonly hostSecret = randomBase64Url(24);
  private readonly proParticipantId: string | null;
  private proSignalingAccess: ProSignalingOptions | null;
  private roomPassword: string | null = null;
  private readonly standardRoomIdentityRefreshTimerKey = 'standard-room-identity-refresh';
  private readonly standardRoomIdentityDeletionProofs = new Map<string, string>();

  private standardRoomIdentityProofKey(roomCode: string, role: 'host' | 'guest'): string {
    return `${role}:${roomCode}`;
  }

  private applyStandardRoomIdentity(
    value: unknown,
    clearReason?: StandardRoomIdentityClearReason,
  ): void {
    const identity = value === null ? null : normalizeStandardRoomMemberIdentity(value);
    if (value !== null && !identity) return;
    this.emit('room-identity', identity, clearReason);
    this.scheduleStandardRoomIdentityRefresh(
      identity ? 40_000 : clearReason === 'expired' ? 10_000 : null,
    );
  }

  private scheduleStandardRoomIdentityRefresh(delayMs: number | null): void {
    clearManagedTimer(this.standardRoomIdentityRefreshTimerKey);
    if (delayMs === null || this.destroyed || this.proSignalingAccess) return;
    setManagedTimer(
      this.standardRoomIdentityRefreshTimerKey,
      () => {
        void this.refreshStandardRoomIdentity();
      },
      delayMs,
    );
  }

  private async getStandardRoomAssertions(
    roomCode: string,
    peerId: string,
    role: 'host' | 'guest',
  ): Promise<StandardRoomIdentityAssertions | undefined> {
    const provider = this.options.standardRoomAssertionProvider;
    if (!provider || this.proSignalingAccess) {
      return { accountAssertion: null, deletionAssertion: null };
    }
    try {
      const value = await Promise.race([
        provider({ roomCode, peerId, role }),
        delay(2000).then(() => undefined),
      ]);
      if (value === undefined) return undefined;
      return normalizeStandardRoomIdentityAssertions(value) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private rememberStandardRoomDeletionProof(
    roomCode: string,
    role: 'host' | 'guest',
    deletionAssertion: string | null,
  ): void {
    const key = this.standardRoomIdentityProofKey(roomCode, role);
    if (deletionAssertion) this.standardRoomIdentityDeletionProofs.set(key, deletionAssertion);
    else this.standardRoomIdentityDeletionProofs.delete(key);
  }

  private sendPendingStandardRoomDeletion(
    roomCode: string,
    role: 'host' | 'guest',
    socket: WebSocket,
  ): boolean {
    const key = this.standardRoomIdentityProofKey(roomCode, role);
    const deletionAssertion = this.standardRoomIdentityDeletionProofs.get(key);
    if (!deletionAssertion || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'account-identity-delete', deletionAssertion }));
    this.standardRoomIdentityDeletionProofs.delete(key);
    return true;
  }

  private sendHostAuth(socket: WebSocket): void {
    if (
      !this.hostRoomId ||
      !this.id ||
      socket !== this.hostSocket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: 'host-auth',
        secret: this.hostSecret,
      }),
    );
  }

  private async sendGuestAuth(roomId: string, socket: WebSocket): Promise<void> {
    if (!this.id || socket.readyState !== WebSocket.OPEN) return;
    const assertions = await this.getStandardRoomAssertions(roomId, this.id, 'guest');
    if (socket !== this.roomSockets.get(roomId) || socket.readyState !== WebSocket.OPEN) return;
    if (assertions === undefined) this.scheduleStandardRoomIdentityRefresh(10_000);
    if (assertions) {
      this.rememberStandardRoomDeletionProof(roomId, 'guest', assertions.deletionAssertion);
    }
    const record = this.guestRooms.get(roomId);
    if (!record) return;
    socket.send(
      JSON.stringify({
        type: 'guest-auth',
        password: record.password || '',
        reconnectSecret: this.guestReconnectSecrets.get(roomId) || '',
        ...(assertions?.accountAssertion ? { accountAssertion: assertions.accountAssertion } : {}),
      }),
    );
  }

  private handleProEpochAdvanced(): void {
    if (!this.proSignalingAccess || this.destroyed) return;
    // The signaling close is an authority event, not a transient network
    // blip. Tear down every RTC facade immediately; the PRO runtime fetches
    // the new snapshot/epoch and constructs a fresh transport.
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.guestRooms.clear();
    for (const mediaConn of this.mediaCalls.values()) mediaConn.closeFromRemote();
    this.mediaCalls.clear();
    this.pendingCandidates.clear();
    this.open = false;
    this.disconnected = true;
    this.emit('pro-epoch-advanced');
  }

  constructor(
    requestedId: string | null,
    private readonly options: TransportPeerOptions,
  ) {
    super();
    const proSignaling = options.proSignaling;
    const claims = proSignaling ? proTicketClaims(proSignaling.ticket) : null;
    const proParticipantId = claims?.participantId ?? null;
    if (proSignaling) {
      const validShape =
        /^\d{6}$/.test(proSignaling.roomCode) &&
        !!proSignaling.ticket &&
        claims?.roomCode === proSignaling.roomCode &&
        claims.role === proSignaling.role &&
        claims.coordinatorEpoch === proSignaling.coordinatorEpoch &&
        claims.presenceIncarnationId === proSignaling.presenceIncarnationId &&
        claims.ticketSequence === proSignaling.ticketSequence &&
        Number.isSafeInteger(proSignaling.coordinatorEpoch) &&
        proSignaling.coordinatorEpoch >= 1;
      const validRoleShape =
        (proSignaling.role === 'coordinator' && requestedId === proSignaling.roomCode) ||
        (proSignaling.role === 'member' && requestedId === null);
      if (!validShape || !validRoleShape) {
        throw createTransportError('invalid-id', 'INVALID_PRO_SIGNALING_OPTIONS');
      }
    }
    this.hostRoomId = requestedId;
    this.proParticipantId = proParticipantId;
    this.proSignalingAccess = proSignaling ? { ...proSignaling } : null;
    this.id =
      requestedId ??
      (proSignaling?.role === 'member' ? proParticipantId : null) ??
      `mx-${randomBase64Url(12)}`;

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
    if (
      this.proSignalingAccess &&
      (this.proSignalingAccess.role !== 'member' || roomId !== this.proSignalingAccess.roomCode)
    ) {
      throw createTransportError('invalid-id', 'PRO_SIGNALING_ROOM_MISMATCH');
    }
    const conn = new CloudflareDataConnection(roomId, options?.metadata);
    const roomPassword =
      typeof options?.roomPassword === 'string' ? options.roomPassword.trim() : '';
    if (!this.proSignalingAccess && !this.guestReconnectSecrets.has(roomId)) {
      this.guestReconnectSecrets.set(roomId, randomBase64Url(32));
    }
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
        this.pendingCandidates.delete(roomId);
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

  setProSignalingAccess(access: ProSignalingOptions): boolean {
    const current = this.proSignalingAccess;
    const claims = proTicketClaims(access.ticket);
    if (
      !current ||
      !claims ||
      claims.participantId !== this.proParticipantId ||
      claims.roomCode !== access.roomCode ||
      claims.role !== access.role ||
      claims.coordinatorEpoch !== access.coordinatorEpoch ||
      claims.presenceIncarnationId !== access.presenceIncarnationId ||
      claims.ticketSequence !== access.ticketSequence ||
      access.roomCode !== current.roomCode ||
      access.role !== current.role ||
      access.coordinatorEpoch !== current.coordinatorEpoch ||
      access.presenceIncarnationId !== current.presenceIncarnationId ||
      access.ticketSequence <= current.ticketSequence
    ) {
      return false;
    }
    this.proSignalingAccess = { ...access };
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.open = false;
    this.disconnected = false;
    this.scheduleStandardRoomIdentityRefresh(null);
    this.standardRoomIdentityDeletionProofs.clear();
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
    this.guestReconnectSecrets.clear();
    for (const mediaConn of this.mediaCalls.values()) mediaConn.closeFromRemote();
    this.mediaCalls.clear();
    this.clear();
  }

  private requireSignalingUrl(): string {
    const url = this.options.signalingUrl;
    if (!url) throw createTransportError('server-error', 'CLOUDFLARE_SIGNALING_URL_MISSING');
    return url;
  }

  private buildSocketUrl(roomId: string, role: 'host' | 'guest', peerId: string): string {
    const base = new URL(this.requireSignalingUrl());
    if (base.protocol === 'http:') base.protocol = 'ws:';
    else if (base.protocol === 'https:') base.protocol = 'wss:';
    const proSignaling = this.proSignalingAccess;
    if (proSignaling) {
      const standardBase = base.pathname.replace(/\/+$/, '');
      const proBase = standardBase.endsWith('/api/rooms')
        ? `${standardBase.slice(0, -'/api/rooms'.length)}/api/pro-rooms`
        : standardBase.endsWith('/api/pro-rooms')
          ? standardBase
          : `${standardBase}/api/pro-rooms`;
      base.pathname = `${proBase}/${encodeURIComponent(roomId)}/ws`;
      base.search = '';
      base.searchParams.set('ticket', proSignaling.ticket);
      return base.toString();
    }
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(roomId)}/ws`;
    // A standard room's host secret is a bearer credential. Keep the URL
    // limited to routing identifiers so edge logs, traces, and diagnostics can
    // never capture it; the host proves ownership in the first WebSocket frame.
    base.search = '';
    base.searchParams.set('role', role);
    base.searchParams.set('peerId', peerId);
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
    if (this.proSignalingAccess) return;
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
      socket = new WebSocket(this.buildSocketUrl(this.hostRoomId, 'host', this.id));
    } catch (error) {
      this.emit('error', error);
      return;
    }

    this.hostSocket = socket;
    socket.addEventListener('open', () => {
      if (this.proSignalingAccess) return;
      try {
        this.sendHostAuth(socket);
      } catch (error) {
        this.emit('error', error);
      }
    });
    socket.addEventListener('message', (event) => {
      this.handleHostMessage(event.data).catch((error) => this.emit('error', error));
    });
    socket.addEventListener('close', (event) => {
      if (this.destroyed) return;
      if ((event as CloseEvent).reason === 'PRO_COORDINATOR_EPOCH_ADVANCED') {
        if (this.hostSocket === socket) this.hostSocket = null;
        this.handleProEpochAdvanced();
        return;
      }
      if (this.hostSocket === socket) {
        this.open = false;
        const wasDisconnected = this.disconnected;
        this.disconnected = true;
        if (!wasDisconnected) this.emit('disconnected');
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
   * 'disconnected', resets the outer retry budget, and causes a permanent
   * open/close oscillation.
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
    const { conn, metadata } = record;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.buildSocketUrl(roomId, 'guest', this.id));
    } catch (error) {
      queueMicrotask(() => conn.emit('error', error));
      return;
    }

    this.roomSockets.set(roomId, socket);
    socket.addEventListener('open', () => {
      if (this.proSignalingAccess) return;
      void this.sendGuestAuth(roomId, socket).catch((error) => conn.emit('error', error));
    });
    socket.addEventListener('message', (event) => {
      this.handleGuestMessage(roomId, socket, conn, metadata, event.data).catch((error) =>
        conn.emit('error', error),
      );
    });
    socket.addEventListener('close', (event) => {
      if (this.destroyed) return;
      if ((event as CloseEvent).reason === 'PRO_COORDINATOR_EPOCH_ADVANCED') {
        if (this.roomSockets.get(roomId) === socket) this.roomSockets.delete(roomId);
        this.handleProEpochAdvanced();
        return;
      }
      if (this.roomSockets.get(roomId) === socket) {
        this.roomSockets.delete(roomId);
        if (conn.peerConnection) {
          const wasDisconnected = this.disconnected;
          this.disconnected = true;
          if (!wasDisconnected) this.emit('disconnected');
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
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw createTransportError('server-error', 'INVALID_SIGNAL');
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'developer-command'
    ) {
      const command = parseDeveloperCommandFrame(value);
      if (!command) throw createTransportError('server-error', 'INVALID_DEVELOPER_COMMAND');
      return command;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'developer-invalidation'
    ) {
      const invalidation = parseDeveloperInvalidationFrame(value);
      if (!invalidation) {
        throw createTransportError('server-error', 'INVALID_DEVELOPER_INVALIDATION');
      }
      return invalidation;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'pro-queue-addition'
    ) {
      const addition = parseProQueueAdditionFrame(value);
      if (!addition) {
        throw createTransportError('server-error', 'INVALID_DEVELOPER_QUEUE_ADDITION');
      }
      return addition;
    }
    return value as SignalingMessage;
  }

  private async handleHostMessage(raw: unknown): Promise<void> {
    const message = await this.parseSignal(raw);
    if (message.type === 'developer-command') {
      if (this.proSignalingAccess?.role !== 'coordinator') {
        throw createTransportError('server-error', 'UNEXPECTED_DEVELOPER_COMMAND');
      }
      this.emit('developer-command', message);
      return;
    }
    if (message.type === 'developer-invalidation') {
      const access = this.proSignalingAccess;
      if (
        access?.role !== 'coordinator' ||
        message.roomCode !== access.roomCode ||
        message.coordinatorEpoch !== access.coordinatorEpoch
      ) {
        throw createTransportError('server-error', 'UNEXPECTED_DEVELOPER_INVALIDATION');
      }
      this.emit('developer-invalidation', message);
      return;
    }
    if (message.type === 'pro-queue-addition') {
      const access = this.proSignalingAccess;
      if (
        access?.role !== 'coordinator' ||
        message.roomCode !== access.roomCode ||
        message.coordinatorEpoch !== access.coordinatorEpoch
      ) {
        throw createTransportError('server-error', 'UNEXPECTED_DEVELOPER_QUEUE_ADDITION');
      }
      this.emit('pro-queue-addition', message);
      return;
    }
    if (message.type === 'peer-open') {
      if (message.memberIdentity) this.applyStandardRoomIdentity(message.memberIdentity);
      if (this.hostRoomId && this.hostSocket) {
        this.sendPendingStandardRoomDeletion(this.hostRoomId, 'host', this.hostSocket);
        // Room admission and code display must never wait on the account API.
        // Attach (or clear/delete) account identity only after the Worker has
        // authenticated the RAM-only host secret and admitted this socket.
        void this.refreshStandardRoomIdentity().catch((error) => this.emit('error', error));
      }
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
      await this.handleHostOffer(
        message.from,
        message.sdp,
        message.metadata,
        normalizeStandardRoomMemberIdentity(message.memberIdentity),
      );
      return;
    }
    if (message.type === 'account-identity') {
      this.applyStandardRoomIdentity(message.memberIdentity, message.clearReason);
      return;
    }
    if (message.type === 'account-member-updated') {
      const identity =
        message.memberIdentity === null
          ? null
          : normalizeStandardRoomMemberIdentity(message.memberIdentity);
      if (message.memberIdentity !== null && !identity) return;
      this.connections.get(message.peerId)?.updateRoomIdentity(identity, message.clearReason);
      return;
    }
    if (message.type === 'account-member-deleted') {
      if (/^member_[A-Za-z0-9_-]{22}$/.test(message.memberId)) {
        this.emit('room-member-deleted', message.memberId);
      }
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
    if (message.type === 'developer-command') {
      throw createTransportError('server-error', 'UNEXPECTED_DEVELOPER_COMMAND');
    }
    if (message.type === 'developer-invalidation') {
      throw createTransportError('server-error', 'UNEXPECTED_DEVELOPER_INVALIDATION');
    }
    if (message.type === 'pro-queue-addition') {
      throw createTransportError('server-error', 'UNEXPECTED_DEVELOPER_QUEUE_ADDITION');
    }
    if (message.type === 'peer-open') {
      if (message.memberIdentity) this.applyStandardRoomIdentity(message.memberIdentity);
      this.sendPendingStandardRoomDeletion(roomId, 'guest', socket);
      this.disconnected = false;
      await this.startGuestOffer(roomId, socket, conn, metadata);
      return;
    }
    if (message.type === 'account-identity') {
      this.applyStandardRoomIdentity(message.memberIdentity, message.clearReason);
      return;
    }
    if (message.type === 'account-member-updated') return;
    if (message.type === 'error') {
      const error = createTransportError(
        message.errorType ?? 'server-error',
        message.message ?? 'SIGNALING_ERROR',
      );
      if (this.isDataConnectionAlive(conn)) {
        // These rejection frames concern the signaling socket, not necessarily
        // the established data channel. Emitting a connection error would tear
        // down a channel that may still work, so log and close only the socket;
        // its close event emits 'disconnected' for the outer reconnect backoff.
        if (isPermanentGuestAuthError(message.errorType)) {
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
      // socket at send time instead of capturing one. On the guest side the
      // peer ID is the room ID and therefore the roomSockets key. A missing
      // current socket fails with SIGNALING_SOCKET_NOT_OPEN.
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
    roomIdentity: StandardRoomMemberIdentity | null,
  ): Promise<void> {
    const socket = this.hostSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    this.connections.get(peerId)?.close();
    const conn = new CloudflareDataConnection(peerId, metadata, roomIdentity);
    const pc = this.createPeerConnection(peerId);
    conn.peerConnection = pc;
    this.connections.set(peerId, conn);
    conn.on('close', () => {
      // Identity-guarded: a late close from a connection replaced by a newer
      // offer for the same peer must not evict the live record.
      if (this.connections.get(peerId) === conn) {
        this.connections.delete(peerId);
        this.pendingCandidates.delete(peerId);
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

  async refreshStandardRoomIdentity(): Promise<void> {
    if (this.destroyed || this.proSignalingAccess || !this.id) return;
    const targets: Array<{
      roomCode: string;
      role: 'host' | 'guest';
      socket: WebSocket;
    }> = [];
    if (this.hostRoomId && this.hostSocket && this.hostSocket.readyState === WebSocket.OPEN) {
      targets.push({ roomCode: this.hostRoomId, role: 'host', socket: this.hostSocket });
    }
    for (const [roomCode, socket] of this.roomSockets) {
      if (socket.readyState === WebSocket.OPEN) targets.push({ roomCode, role: 'guest', socket });
    }
    await Promise.all(
      targets.map(async ({ roomCode, role, socket }) => {
        const assertions = await this.getStandardRoomAssertions(roomCode, this.id!, role);
        const currentSocket = role === 'host' ? this.hostSocket : this.roomSockets.get(roomCode);
        if (socket !== currentSocket || socket.readyState !== WebSocket.OPEN) return;
        if (assertions === undefined) {
          this.scheduleStandardRoomIdentityRefresh(10_000);
          return;
        }
        if (assertions.deletionAssertion) {
          socket.send(
            JSON.stringify({
              type: 'account-identity-delete',
              deletionAssertion: assertions.deletionAssertion,
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify(
            assertions.accountAssertion
              ? {
                  type: 'account-identity-refresh',
                  accountAssertion: assertions.accountAssertion,
                }
              : { type: 'account-identity-clear' },
          ),
        );
      }),
    );
  }

  deleteStandardRoomIdentity(): void {
    // The App Worker mints a deletion-audience assertion only after the D1
    // account deletion transaction commits. A normal attach assertion is
    // intentionally never cached or repurposed as deletion authority.
    void this.refreshStandardRoomIdentity();
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
      // current room socket at send time. A missing current socket fails with
      // SIGNALING_SOCKET_NOT_OPEN.
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
