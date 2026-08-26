import { parseRoomEffectsPatch, type RoomEffectsPatch } from '../../core/room-effects.ts';

export type TransportProvider = 'peerjs' | 'cloudflare';

export type DeveloperCommandResultCode =
  | 'applied'
  | 'already_applied'
  | 'busy'
  | 'no_media'
  | 'stale_queue'
  | 'unsupported_mode'
  | 'expired'
  | 'execution_failed';

type DeveloperCommand =
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  | { readonly type: 'next' }
  | { readonly type: 'seek'; readonly positionSeconds: number }
  | { readonly type: 'play_item'; readonly queueItemId: string }
  | { readonly type: 'set_effects'; readonly effects: RoomEffectsPatch };

export interface DeveloperCommandFrame {
  readonly type: 'developer-command';
  readonly version: 1 | 2 | 3;
  readonly roomCode: string;
  readonly coordinatorEpoch: number;
  readonly commandId: string;
  readonly expiresAtMs: number;
  readonly expected: {
    readonly queueItemId: string | null;
    readonly playlistRevision: number;
    readonly playbackRevision: number;
  };
  readonly command: DeveloperCommand;
}

/**
 * Authenticated signaling-service hint that the persistent PRO snapshot has
 * advanced. It carries no mutable state: each recipient must refresh the
 * authoritative snapshot before applying anything locally.
 */
export interface DeveloperInvalidationFrame {
  readonly type: 'developer-invalidation';
  readonly version: 1;
  readonly roomCode: string;
  readonly coordinatorEpoch: number;
  readonly revision: number;
  readonly playlistRevision: number;
}

/** Authenticated, server-originated description of one accepted PRO queue add. */
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

const DEVELOPER_COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{22}$/;
const DEVELOPER_COMMAND_QUEUE_ITEM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVELOPER_COMMAND_MAX_SEEK_SECONDS = 7 * 24 * 60 * 60;

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

function isDeveloperQueueItemId(value: unknown): value is string {
  return typeof value === 'string' && DEVELOPER_COMMAND_QUEUE_ITEM_ID_RE.test(value);
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

/**
 * Strictly validates the only signaling frame that may cross into the
 * developer-control executor. Ordinary WebRTC signaling remains private to
 * the transport implementation.
 */
export function parseDeveloperCommandFrame(value: unknown): DeveloperCommandFrame | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'type',
      'version',
      'roomCode',
      'coordinatorEpoch',
      'commandId',
      'expiresAtMs',
      'expected',
      'command',
    ]) ||
    value.type !== 'developer-command' ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    typeof value.roomCode !== 'string' ||
    !/^0\d{5}$/.test(value.roomCode) ||
    !isNonNegativeSafeInteger(value.coordinatorEpoch) ||
    value.coordinatorEpoch < 1 ||
    typeof value.commandId !== 'string' ||
    !DEVELOPER_COMMAND_ID_RE.test(value.commandId) ||
    !isNonNegativeSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs < 1 ||
    !isPlainRecord(value.expected) ||
    !hasExactKeys(value.expected, ['queueItemId', 'playlistRevision', 'playbackRevision']) ||
    (value.expected.queueItemId !== null && !isDeveloperQueueItemId(value.expected.queueItemId)) ||
    !isNonNegativeSafeInteger(value.expected.playlistRevision) ||
    !isNonNegativeSafeInteger(value.expected.playbackRevision) ||
    !isPlainRecord(value.command)
  ) {
    return null;
  }

  let command: DeveloperCommand;
  if (
    (value.command.type === 'play' ||
      value.command.type === 'pause' ||
      value.command.type === 'next') &&
    hasExactKeys(value.command, ['type'])
  ) {
    command = { type: value.command.type };
  } else if (
    value.command.type === 'seek' &&
    hasExactKeys(value.command, ['type', 'positionSeconds']) &&
    typeof value.command.positionSeconds === 'number' &&
    Number.isFinite(value.command.positionSeconds) &&
    value.command.positionSeconds >= 0 &&
    value.command.positionSeconds <= DEVELOPER_COMMAND_MAX_SEEK_SECONDS
  ) {
    command = { type: 'seek', positionSeconds: value.command.positionSeconds };
  } else if (
    value.command.type === 'play_item' &&
    hasExactKeys(value.command, ['type', 'queueItemId']) &&
    isDeveloperQueueItemId(value.command.queueItemId)
  ) {
    command = { type: 'play_item', queueItemId: value.command.queueItemId };
  } else if (
    value.command.type === 'set_effects' &&
    hasExactKeys(value.command, ['type', 'effects'])
  ) {
    const effects = parseRoomEffectsPatch(value.command.effects);
    if (!effects) return null;
    command = { type: 'set_effects', effects };
  } else {
    return null;
  }

  const requiredVersion = command.type === 'next' ? 3 : command.type === 'set_effects' ? 2 : 1;
  if (value.version !== requiredVersion) return null;

  return {
    type: 'developer-command',
    version: value.version,
    roomCode: value.roomCode,
    coordinatorEpoch: value.coordinatorEpoch,
    commandId: value.commandId,
    expiresAtMs: value.expiresAtMs,
    expected: {
      queueItemId: value.expected.queueItemId as string | null,
      playlistRevision: value.expected.playlistRevision,
      playbackRevision: value.expected.playbackRevision,
    },
    command,
  };
}

export function parseDeveloperInvalidationFrame(value: unknown): DeveloperInvalidationFrame | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'type',
      'version',
      'roomCode',
      'coordinatorEpoch',
      'revision',
      'playlistRevision',
    ]) ||
    value.type !== 'developer-invalidation' ||
    value.version !== 1 ||
    typeof value.roomCode !== 'string' ||
    !/^0\d{5}$/.test(value.roomCode) ||
    !isNonNegativeSafeInteger(value.coordinatorEpoch) ||
    value.coordinatorEpoch < 1 ||
    !isNonNegativeSafeInteger(value.revision) ||
    !isNonNegativeSafeInteger(value.playlistRevision)
  ) {
    return null;
  }

  return {
    type: 'developer-invalidation',
    version: 1,
    roomCode: value.roomCode,
    coordinatorEpoch: value.coordinatorEpoch,
    revision: value.revision,
    playlistRevision: value.playlistRevision,
  };
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

interface TransportCallOptions {
  metadata?: Record<string, unknown>;
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

  send(data: unknown): void;
  close(): void;
  on(event: 'open', callback: () => void): void;
  on(event: 'data', callback: (data: unknown) => void): void;
  on(event: 'close', callback: () => void): void;
  on(event: 'error', callback: (error: unknown) => void): void;
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

  answer(stream?: MediaStream): void;
  close(): void;
  on(event: 'stream', callback: (stream: MediaStream) => void): void;
  on(event: 'close', callback: () => void): void;
  on(event: 'error', callback: (error: unknown) => void): void;
  off?(event: 'stream', callback: (stream: MediaStream) => void): void;
  off?(event: 'close', callback: () => void): void;
  off?(event: 'error', callback: (error: unknown) => void): void;
}

export type TransportBackgroundRecoveryStatus =
  | 'not-applicable'
  | 'monitoring'
  | 'stale-connection-closed';

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

  connect(peerId: string, options?: TransportConnectOptions): TransportDataConnection;
  call?(
    peerId: string,
    stream: MediaStream,
    options?: TransportCallOptions,
  ): TransportMediaConnection;
  reconnect?(): void;
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
  setRtcConfiguration?(configuration: RTCConfiguration): void;
  setRoomPassword?(password: string | null): void;
  setProSignalingAccess?(access: ProSignalingOptions): boolean;
  refreshStandardRoomIdentity?(): Promise<void>;
  deleteStandardRoomIdentity?(): void;
  /**
   * Return null only when the admitted signaling deployment does not advertise
   * this additive protocol. Once advertised, issuance failures reject rather
   * than silently downgrading to the legacy upload path.
   */
  requestRemoteShareUploadAssertion?(
    request: RemoteShareUploadAssertionRequest,
    signal?: AbortSignal,
  ): Promise<string | null>;
  destroy(): void;
  on(event: 'open', callback: (id: string) => void): void;
  on(event: 'error', callback: (error: unknown) => void): void;
  on(event: 'disconnected', callback: () => void): void;
  on(event: 'pro-epoch-advanced', callback: () => void): void;
  on(event: 'developer-command', callback: (frame: DeveloperCommandFrame) => void): void;
  on(event: 'developer-invalidation', callback: (frame: DeveloperInvalidationFrame) => void): void;
  on(event: 'pro-queue-addition', callback: (frame: ProQueueAdditionFrame) => void): void;
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
  off(event: 'pro-epoch-advanced', callback: () => void): void;
  off(event: 'developer-command', callback: (frame: DeveloperCommandFrame) => void): void;
  off(event: 'developer-invalidation', callback: (frame: DeveloperInvalidationFrame) => void): void;
  off(event: 'pro-queue-addition', callback: (frame: ProQueueAdditionFrame) => void): void;
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
