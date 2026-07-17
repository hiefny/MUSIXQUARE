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
  | { readonly type: 'seek'; readonly positionSeconds: number }
  | { readonly type: 'play_item'; readonly queueItemId: string };

export interface DeveloperCommandFrame {
  readonly type: 'developer-command';
  readonly version: 1;
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
 * advanced. It carries no mutable state: the coordinator must refresh the
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
}

const DEVELOPER_COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{22}$/;
const DEVELOPER_COMMAND_QUEUE_ITEM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVELOPER_COMMAND_MAX_SEEK_SECONDS = 7 * 24 * 60 * 60;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDeveloperQueueItemId(value: unknown): value is string {
  return typeof value === 'string' && DEVELOPER_COMMAND_QUEUE_ITEM_ID_RE.test(value);
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
    value.version !== 1 ||
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
    (value.command.type === 'play' || value.command.type === 'pause') &&
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
  } else {
    return null;
  }

  return {
    type: 'developer-command',
    version: 1,
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
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'type',
      'version',
      'roomCode',
      'coordinatorEpoch',
      'playlistRevision',
      'eventId',
      'actorName',
      'count',
    ]) ||
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
    value.count > 1000
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
  };
}

export interface TransportConnectOptions {
  reliable?: boolean;
  metadata?: unknown;
  roomPassword?: string;
}

interface TransportCallOptions {
  metadata?: Record<string, unknown>;
}

export interface TransportDataConnection {
  peer: string;
  open: boolean;
  metadata?: unknown;
  peerConnection?: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  controlChannel?: RTCDataChannel;

  send(data: unknown): void;
  close(): void;
  on(event: 'open', callback: () => void): void;
  on(event: 'data', callback: (data: unknown) => void): void;
  on(event: 'close', callback: () => void): void;
  on(event: 'error', callback: (error: unknown) => void): void;
  off?(event: 'open', callback: () => void): void;
  off?(event: 'data', callback: (data: unknown) => void): void;
  off?(event: 'close', callback: () => void): void;
  off?(event: 'error', callback: (error: unknown) => void): void;
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
  setRoomPassword?(password: string | null): void;
  setProSignalingAccess?(access: ProSignalingOptions): boolean;
  destroy(): void;
  on(event: 'open', callback: (id: string) => void): void;
  on(event: 'error', callback: (error: unknown) => void): void;
  on(event: 'disconnected', callback: () => void): void;
  on(event: 'pro-epoch-advanced', callback: () => void): void;
  on(event: 'developer-command', callback: (frame: DeveloperCommandFrame) => void): void;
  on(event: 'developer-invalidation', callback: (frame: DeveloperInvalidationFrame) => void): void;
  on(event: 'pro-queue-addition', callback: (frame: ProQueueAdditionFrame) => void): void;
  on(event: 'connection', callback: (conn: TransportDataConnection) => void): void;
  on(event: 'call', callback: (mediaConn: TransportMediaConnection) => void): void;
  off(event: 'open', callback: (id: string) => void): void;
  off(event: 'error', callback: (error: unknown) => void): void;
  off(event: 'disconnected', callback: () => void): void;
  off(event: 'pro-epoch-advanced', callback: () => void): void;
  off(event: 'developer-command', callback: (frame: DeveloperCommandFrame) => void): void;
  off(event: 'developer-invalidation', callback: (frame: DeveloperInvalidationFrame) => void): void;
  off(event: 'pro-queue-addition', callback: (frame: ProQueueAdditionFrame) => void): void;
  off(event: 'connection', callback: (conn: TransportDataConnection) => void): void;
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
  provider: TransportProvider;
  signalingUrl?: string;
  peerJsServer?: PeerJsServerConfig;
  proSignaling?: ProSignalingOptions;
}
