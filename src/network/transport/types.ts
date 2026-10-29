export type TransportProvider = 'peerjs' | 'cloudflare';

/**
 * Authenticated, server-originated description of one accepted PRO queue add.
 * It reaches the App only as the `addition` of a `pro-room-invalidated` PRO
 * server event.
 */
export interface ProQueueAdditionFrame {
  readonly type: 'pro-queue-addition';
  readonly version: 1;
  readonly roomCode: string;
  readonly coordinatorEpoch: number;
  readonly playlistRevision: number;
  readonly eventId: string;
  readonly actorName: string;
  readonly count: number;
  /** Optional during rollout; current servers include it when the first added row has a title. */
  readonly firstTitle?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const actual = Object.keys(value);
  const allowed = [...keys, ...optional];
  return keys.every((key) => actual.includes(key)) && actual.every((key) => allowed.includes(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasUnsafeQueueMetadataCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

export function parseProQueueAdditionFrame(value: unknown): ProQueueAdditionFrame | null {
  const firstTitle = isPlainRecord(value) ? value.firstTitle : undefined;
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(
      value,
      [
        'type',
        'version',
        'roomCode',
        'coordinatorEpoch',
        'playlistRevision',
        'eventId',
        'actorName',
        'count',
      ],
      ['firstTitle'],
    ) ||
    value.type !== 'pro-queue-addition' ||
    value.version !== 1 ||
    typeof value.roomCode !== 'string' ||
    !/^0\d{5}$/.test(value.roomCode) ||
    !isNonNegativeSafeInteger(value.coordinatorEpoch) ||
    value.coordinatorEpoch < 1 ||
    !isNonNegativeSafeInteger(value.playlistRevision) ||
    value.playlistRevision < 1 ||
    typeof value.eventId !== 'string' ||
    !/^qa_0\d{5}_\d+_\d+$/.test(value.eventId) ||
    typeof value.actorName !== 'string' ||
    value.actorName.length < 1 ||
    value.actorName.length > 30 ||
    !isNonNegativeSafeInteger(value.count) ||
    value.count < 1 ||
    value.count > 1000 ||
    (firstTitle !== undefined &&
      (typeof firstTitle !== 'string' ||
        firstTitle.length < 1 ||
        firstTitle.length > 120 ||
        firstTitle.trim() !== firstTitle ||
        hasUnsafeQueueMetadataCharacter(firstTitle)))
  ) {
    return null;
  }
  return {
    type: 'pro-queue-addition',
    version: 1,
    roomCode: value.roomCode,
    coordinatorEpoch: value.coordinatorEpoch,
    playlistRevision: value.playlistRevision,
    eventId: value.eventId,
    actorName: value.actorName,
    count: value.count,
    ...(typeof firstTitle === 'string' ? { firstTitle } : {}),
  };
}

export interface TransportConnectOptions {
  reliable?: boolean;
  metadata?: unknown;
  roomPassword?: string;
}

/** Server-owned identity projected by the standard-room signaling Worker. */
export interface StandardRoomMemberIdentity {
  readonly memberId: string;
  readonly memberDisplayNumber: number;
  readonly nickname: string;
  readonly isAuthenticated: true;
}

export type StandardRoomIdentityClearReason = 'explicit' | 'expired' | 'deleted';

export interface StandardRoomAssertionRequest {
  readonly roomCode: string;
  readonly peerId: string;
  readonly role: 'host' | 'guest';
}

export interface StandardRoomIdentityAssertions {
  readonly accountAssertion: string | null;
  readonly deletionAssertion: string | null;
}

export type TransportSdpTransform = (sdp: string) => string;
export type TransportSenderTuning = (sender: RTCRtpSender) => void;

export interface TransportCallOptions {
  metadata?: Record<string, unknown>;
  /** Applied exactly once by the transport to the locally-created offer. */
  sdpTransform?: TransportSdpTransform;
  /** Applied exactly once to each sender created for this outgoing call. */
  senderTuning?: TransportSenderTuning;
}

export interface TransportAnswerOptions {
  /** Applied exactly once by the transport to the locally-created answer. */
  sdpTransform?: TransportSdpTransform;
}

/** Optional receiver-confirmed capacity for this exact transport connection. */
export interface TransportBulkFlowControl {
  hasCapacity(nextPayloadBytes: number): boolean;
  subscribe(listener: () => void): () => void;
}

/**
 * Why a caller closes a data connection, named at the decision for the
 * provider's close-cause line. It never changes how the connection closes.
 */
export type TransportCloseReason =
  | 'heartbeat-stale'
  | 'open-timeout'
  | 'rollback-unproven'
  | 'admission-expired'
  | 'peer-left'
  | 'leave'
  | 'transport-error'
  | 'join-bootstrap-failed'
  | 'pro-epoch-advanced';

/**
 * The original route of a Cloudflare logical data connection (Standard or
 * PRO room) as its link-liveness owner reads it (registry RO-15, Phase 4 C5-8).
 */
export interface TransportLinkLivenessView {
  /**
   * `recovering` while the owner holds an interruption of the original route
   * (disconnected, or failed with a restart binding, until it reads connected
   * again), `opening` until the connection opens, `closed` once it closes.
   * The side route's outages, which the owner keeps apart since C5-9, never
   * make it `recovering`.
   */
  readonly phase: 'opening' | 'live' | 'recovering' | 'closed';
  /** The owner's published, non-renewing recovery deadline (wall clock), or 0. */
  readonly recoveryDeadline: number;
}

export interface TransportDataConnection {
  peer: string;
  open: boolean;
  metadata?: unknown;
  /**
   * Provider recommendation for the application-owned data-channel-open
   * deadline. Consumers must clamp this value; providers cannot disable or
   * shorten the ordinary timeout through this additive hint.
   */
  readonly recommendedPreOpenTimeoutMs?: number;
  roomIdentity?: StandardRoomMemberIdentity | null;
  peerConnection?: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  controlChannel?: RTCDataChannel;
  readonly bulkFlowControl?: TransportBulkFlowControl;
  /** Activate private flow frames only after the application join handshake settles. */
  startBulkFlowControl?(): void;
  /**
   * Provider-owned, non-renewing deadline for this exact ICE interruption.
   * Transport health reads it only on a connection without `linkLiveness`.
   */
  readonly iceRecoveryDeadline?: number;
  /**
   * The link-liveness owner's view of the original route, on a provider that
   * has one (every Cloudflare connection, Standard and PRO rooms alike; a
   * PeerJS connection has none). Transport health reads its phase instead of
   * the peer connection's connectionState, and its deadline as the recovery
   * lease (Phase 4 C5-8).
   */
  readonly linkLiveness?: TransportLinkLivenessView;
  /**
   * The provider emits `ice-recovered` when this connection survives an ICE
   * interruption. Work paused until that event requires it.
   */
  readonly reportsIceRecovery?: boolean;

  send(data: unknown): void;
  /** PeerJS ignores the reason: its close option bag reads only `flush`. */
  close(reason?: TransportCloseReason): void;
  on(event: 'open', callback: () => void): void;
  on(event: 'data', callback: (data: unknown) => void): void;
  on(event: 'close', callback: () => void): void;
  on(event: 'error', callback: (error: unknown) => void): void;
  /** Established RTC path recovered after a disconnected/failed transition. */
  on(event: 'ice-recovered', callback: () => void): void;
  on(
    event: 'identity',
    callback: (
      identity: StandardRoomMemberIdentity | null,
      clearReason?: StandardRoomIdentityClearReason,
    ) => void,
  ): void;
  off?(event: 'open', callback: () => void): void;
  off?(event: 'data', callback: (data: unknown) => void): void;
  off?(event: 'close', callback: () => void): void;
  off?(event: 'error', callback: (error: unknown) => void): void;
  off?(event: 'ice-recovered', callback: () => void): void;
  off?(
    event: 'identity',
    callback: (
      identity: StandardRoomMemberIdentity | null,
      clearReason?: StandardRoomIdentityClearReason,
    ) => void,
  ): void;
}

export interface TransportMediaConnection {
  peer?: string;
  metadata?: Record<string, unknown>;
  peerConnection?: RTCPeerConnection;

  answer(stream?: MediaStream, options?: TransportAnswerOptions): void;
  close(): void;
  /** Emitted by transports when the outgoing media offer is acknowledged. */
  on(event: 'open', callback: () => void): void;
  on(event: 'stream', callback: (stream: MediaStream) => void): void;
  on(event: 'close', callback: () => void): void;
  on(event: 'error', callback: (error: unknown) => void): void;
  off?(event: 'stream', callback: (stream: MediaStream) => void): void;
  off?(event: 'open', callback: () => void): void;
  off?(event: 'close', callback: () => void): void;
  off?(event: 'error', callback: (error: unknown) => void): void;
}

export type TransportBackgroundRecoveryStatus =
  'not-applicable' | 'monitoring' | 'stale-connection-closed';

/**
 * Exact Remote Share /session authority requested from an authenticated
 * standard-room host signaling socket. The body digest binds even JSON key
 * order and whitespace so the resulting bearer cannot authorize a rewritten
 * upload reservation.
 */
export interface RemoteShareUploadAssertionRequest {
  readonly actorId: string;
  readonly requestId: string;
  readonly sessionId: number;
  readonly queueItemId: string;
  readonly size: number;
  readonly bodySha256: string;
}

/**
 * How a Standard-room PIN change treats the devices already in the room.
 * keep_present lets the listed peers reconnect without the new PIN (bound to
 * their reconnect secret); revoke_all closes every guest signaling socket.
 */
export interface StandardRoomPinMembershipRequest {
  readonly mode: 'keep_present' | 'revoke_all';
  readonly keptPeerIds: readonly string[];
}

/**
 * Outcome of one Standard-room PIN mutation. `applied` arrives only with the
 * Worker acknowledgement of that exact mutation; `membership` names what the
 * Worker committed ('legacy' = the PIN alone: turning the PIN off, which
 * carries no choice, or an acknowledgement that does not echo the choice sent
 * on its socket; a PeerJS host resolves it the same way). A newer
 * call, or destroying the transport, settles an older one as `superseded`.
 */
export type StandardRoomPinCommit =
  | { readonly status: 'applied'; readonly membership: 'keep_present' | 'revoke_all' | 'legacy' }
  | { readonly status: 'superseded' };

/**
 * Result of a provider-specific foreground reconciliation after the document
 * spent time hidden. Providers that do not retain suspendable transports can
 * omit the hook entirely.
 */
export interface TransportBackgroundRecoveryResult {
  status: TransportBackgroundRecoveryStatus;
}

export interface TransportPeer {
  id?: string;
  open: boolean;
  destroyed: boolean;
  disconnected: boolean;
  /**
   * Provider recommendation for the application-owned signaling admission
   * deadline. Consumers must clamp this additive hint; providers cannot
   * shorten the ordinary peer-open timeout or make it unbounded.
   */
  readonly recommendedPeerOpenTimeoutMs?: number;

  connect(peerId: string, options?: TransportConnectOptions): TransportDataConnection;
  call?(
    peerId: string,
    stream: MediaStream,
    options?: TransportCallOptions,
  ): TransportMediaConnection;
  reconnect?(): void;
  /** A terminal admission cannot use signaling recovery; a new join is required. */
  getSignalingRecoveryBlockReason?(): 'room-expired' | null;
  /** Retire a signaling path that the browser/OS has proven unavailable. */
  markSignalingUnavailable?(): boolean;
  /**
   * Reconcile transport state after a hidden-to-visible transition. This is an
   * explicit lifecycle hook so providers never need to observe document
   * visibility themselves. Implementations must preserve ordinary transient
   * disconnect grace unless the elapsed hidden time and transport state prove
   * that an already-expired outage was resumed.
   */
  recoverAfterBackground?(hiddenMs: number): TransportBackgroundRecoveryResult;
  /** Release a deliberately deferred RTC negotiation with its final ICE config. */
  setRtcConfiguration?(configuration: RTCConfiguration, expiresAt?: number): void;
  /**
   * Replace the Standard-room PIN. The promise has no internal timeout: the
   * desired PIN persists and replays across signaling reconnects, so callers
   * race it against their own UI deadline.
   */
  setRoomPassword?(
    password: string | null,
    membership?: StandardRoomPinMembershipRequest,
  ): Promise<StandardRoomPinCommit>;
  setProSignalingAccess?(access: ProSignalingOptions): boolean;
  refreshStandardRoomIdentity?(): Promise<void>;
  deleteStandardRoomIdentity?(): void;
  /**
   * Issue a Remote Share room upload assertion through the admitted Standard
   * host signaling socket. Every failure rejects, including a Worker without
   * the assertion secret: there is no assertion-free upload path.
   */
  requestRemoteShareUploadAssertion?(
    request: RemoteShareUploadAssertionRequest,
    signal?: AbortSignal,
  ): Promise<string>;
  destroy(): void;
  on(event: 'open', callback: (id: string) => void): void;
  on(event: 'error', callback: (error: unknown) => void): void;
  on(event: 'disconnected', callback: () => void): void;
  on(event: 'signaling-recovery-blocked', callback: () => void): void;
  on(event: 'pro-epoch-advanced', callback: () => void): void;
  on(event: 'connection', callback: (conn: TransportDataConnection) => void): void;
  on(
    event: 'room-identity',
    callback: (
      identity: StandardRoomMemberIdentity | null,
      clearReason?: StandardRoomIdentityClearReason,
    ) => void,
  ): void;
  on(event: 'room-member-deleted', callback: (memberId: string) => void): void;
  on(event: 'call', callback: (mediaConn: TransportMediaConnection) => void): void;
  off(event: 'open', callback: (id: string) => void): void;
  off(event: 'error', callback: (error: unknown) => void): void;
  off(event: 'disconnected', callback: () => void): void;
  off(event: 'signaling-recovery-blocked', callback: () => void): void;
  off(event: 'pro-epoch-advanced', callback: () => void): void;
  off(event: 'connection', callback: (conn: TransportDataConnection) => void): void;
  off(
    event: 'room-identity',
    callback: (
      identity: StandardRoomMemberIdentity | null,
      clearReason?: StandardRoomIdentityClearReason,
    ) => void,
  ): void;
  off(event: 'call', callback: (mediaConn: TransportMediaConnection) => void): void;
}

export interface PeerJsServerConfig {
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
  key?: string;
}

export interface ProSignalingOptions {
  readonly roomCode: string;
  readonly ticket: string;
  readonly role: 'coordinator' | 'member';
  readonly coordinatorEpoch: number;
  readonly presenceIncarnationId: string;
  readonly ticketSequence: number;
}

export interface TransportPeerOptions {
  debug?: number;
  config: RTCConfiguration;
  /** Absolute credential expiry, retained across page-scoped cache hits. */
  rtcConfigurationExpiresAt?: number;
  /** Bounded credential renewal for both existing and subsequently created PCs. */
  rtcConfigurationProvider?: (
    signal: AbortSignal,
  ) => Promise<{ configuration: RTCConfiguration; expiresAt: number } | null>;
  /** Open signaling immediately, but do not construct RTCPeerConnection until configured. */
  deferRtcUntilConfigured?: boolean;
  provider: TransportProvider;
  signalingUrl?: string;
  /** Separate Standard-room origin used only by the one pre-admission retry. */
  signalingFallbackUrl?: string;
  peerJsServer?: PeerJsServerConfig;
  proSignaling?: ProSignalingOptions;
  /**
   * Setup-only barrier used after one generic pre-open signaling failure.
   * The provider owns the retry generation and aborts this work when that
   * provisional peer/connection loses authority.
   */
  prepareNetworkRouteRetry?: (
    signal: AbortSignal,
    retrySignalingUrl: string,
  ) => Promise<RTCConfiguration | null>;
  standardRoomAssertionProvider?: (
    request: StandardRoomAssertionRequest,
  ) => Promise<StandardRoomIdentityAssertions | undefined>;
}
