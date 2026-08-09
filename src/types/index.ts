/**
 * MUSIXQUARE — Shared Type Definitions
 */

// TransferState and other shared value constants live in core/constants.ts.

import type {
  TransferStateValue,
  MsgType,
  PlaybackStateValue,
  LoadSourceValue,
  PlaybackModeValue,
  PlaybackActivityValue,
} from '../core/constants.ts';
import type { RoomEffectsState } from '../core/room-effects.ts';

// ─── Peer / Network ────────────────────────────────────────────────

import type {
  ProQueueAdditionFrame,
  StandardRoomMemberIdentity,
  TransportDataConnection,
  TransportMediaConnection,
  TransportPeer,
} from '../network/transport/types.ts';
import type { ProRoomAdministrator } from '../pro-room/contracts.ts';

export type { DeveloperCommandResultCode } from '../network/transport/types.ts';

/** App data channel connection. PeerJS is only one possible provider. */
export type DataConnection = TransportDataConnection;

/** App media connection abstraction, implemented by the configured call adapter. */
export type MediaConnection = TransportMediaConnection;

/** Network peer/signaling provider instance. */
export type PeerInstance = TransportPeer;

// ─── File Transfer ─────────────────────────────────────────────────
export interface FileMeta {
  name: string;
  title?: string;
  type: string;
  queueItemId: QueueItemId;
  indexHint: number;
  size: number;
  mime: string;
  sessionId: number;
  total: number;
  /** R2 object identity for remote-share bytes. Local transfers omit it. */
  objectId?: string;
}

export interface PreloadSessionEntry {
  skipped: boolean;
  progress: number;
  total: number;
  name: string;
  queueItemId: QueueItemId;
  indexHint: number;
  size: number;
  mime: string;
  nextExpectedChunk: number;
  finalized: boolean;
}

export interface RemoteFileSharePayload {
  roomId: string;
  objectId: string;
  downloadUrl?: string;
  /**
   * Peer descriptor format. `whole-v1` names the WebRTC handoff contract;
   * Worker tokens/R2 metadata use the storage-layer name `whole-object-v1`.
   */
  storageFormat: 'whole-v1';
  storedSize: number;
  downloadToken: string;
  name: string;
  mime: string;
  size: number;
  queueItemId: QueueItemId;
  sessionId: number;
  expiresAt: number;
  /** Explicit host-authorized object-storage delivery for a local guest. */
  delivery?: 'r2';
  /** Background next-track delivery. Absence means the active playback file. */
  preload?: true;
}

export type RemoteShareUploadStatus = 'idle' | 'uploading' | 'done' | 'error';
export type RemoteShareDownloadStatus = 'idle' | 'fetching' | 'ready' | 'error';

export interface RemoteShareState {
  upload: {
    status: RemoteShareUploadStatus;
    progress: number;
    objectId: string | null;
    expiresAt: number | null;
    error: string | null;
  };
  download: {
    status: RemoteShareDownloadStatus;
    progress: number;
    error: string | null;
  };
}

/** UI projection for the bounded standard-room administrator file uplink. */
export interface StandardOperatorFileUplinkProgress {
  direction: 'send' | 'receive';
  phase: 'waiting' | 'uploading' | 'assembling' | 'complete' | 'aborted' | 'error';
  requestId: string;
  sessionId: string;
  fileName: string;
  loaded: number;
  total: number;
  /** Zero-based position within the sender's sequential selection batch. */
  fileIndex?: number;
  fileCount?: number;
  code?: string;
}

// ─── Playlist ──────────────────────────────────────────────────────
export type QueueItemId = string;

/** Atomic volume + room-wide DSP payload for opt-in device synchronization. */
export interface RoomSettingsSyncState {
  masterVolume: number;
  effects: RoomEffectsState;
}

/** Independent producers that can keep YouTube synchronization UI busy. */
export type YouTubeSyncLoadingOwner = 'rendezvous' | 'clock-action' | 'zero-start';
/** Guest-local correlation token for one concrete file request. */
export type FileRequestId = number;
export type PlaylistRevision = number;

export type ProPlaybackUiControlKind = 'play' | 'pause' | 'seek';

/**
 * Participant-local projection for one PRO playback command.
 *
 * This token never crosses the network. It lets the initiating browser show
 * immediate, reversible feedback while the server remains the sole playback
 * authority.
 */
export interface ProPlaybackUiControlPendingEvent {
  readonly token: number;
  readonly kind: ProPlaybackUiControlKind;
  readonly queueItemId: QueueItemId | null;
  readonly targetSeconds: number;
  readonly wasPlaying: boolean;
}

export type ProPlaybackUiControlSettlementStatus = 'applied' | 'failed' | 'superseded';

export interface ProPlaybackUiControlSettledEvent {
  readonly token: number;
  readonly kind: ProPlaybackUiControlKind;
  readonly queueItemId: QueueItemId | null;
  readonly status: ProPlaybackUiControlSettlementStatus;
  /** Canonical position when known; consumers may otherwise sample their live engine. */
  readonly positionSeconds?: number;
}

export type YouTubeZeroStartPlatform = 'ios' | 'android' | 'other';
export type YouTubeZeroStartCommitReason = 'all-ready' | 'guest-timeout' | 'host-delayed';
export type YouTubeZeroStartAbortReason =
  | 'superseded'
  | 'cancelled'
  | 'authority-changed'
  | 'player-unavailable'
  | 'prepare-failed';

export interface PlaylistWireItem {
  queueItemId: QueueItemId;
  type: 'file' | 'youtube';
  name: string;
  title?: string;
  artist?: string;
  thumbnail?: string;
  videoId: string | null;
  playlistId: string | null;
}

export interface PlaylistItem {
  queueItemId: QueueItemId;
  type: 'file' | 'youtube';
  file?: File;
  name: string;
  title?: string;
  artist?: string;
  thumbnail?: string;
  videoId: string | null;
  playlistId: string | null;
  isExpanded?: boolean;
}

/** A queue occurrence plus its current, non-authoritative positional hint. */
export interface QueueTarget {
  queueItemId: QueueItemId;
  indexHint: number;
  name: string;
}

/** One concrete transfer attempt for a queue occurrence. */
interface TransferIdentity extends QueueTarget {
  sessionId: number;
}

/** Atomically published bytes and the identity that owns them. */
export interface ResidentFile extends TransferIdentity {
  blob: Blob;
  mime: string;
  size: number;
  objectId?: string;
}

export interface TrackMeta extends Partial<PlaylistItem> {
  systemAudioPlaceholder?: boolean;
}

// ─── Storage Commands & Events ─────────────────────────────────────

/** Commands accepted by `storage.ts::postCommand`. All are STORAGE_*. */
export interface StorageCommand {
  command: string;
  filename?: string;
  sessionId?: number;
  queueItemId?: QueueItemId;
  chunkIndex?: number;
  chunk?: ArrayBuffer;
  isPreload?: boolean;
  requestId?: string;
  total?: number;
  totalSize?: number;
  size?: number;
  mime?: string;
  keepExisting?: boolean;
  instanceId?: string;
}

export type StorageEventType =
  | 'STORAGE_STARTED'
  | 'STORAGE_FILE_READY'
  | 'STORAGE_READ_COMPLETE'
  | 'STORAGE_WRITE_ERROR'
  | 'STORAGE_READ_ERROR'
  | 'STORAGE_ERROR'
  | 'STORAGE_RESET_COMPLETE'
  | 'STORAGE_CLEANUP_COMPLETE'
  | 'SESSION_MISMATCH'
  | 'WORKER_ERROR';

/** Events emitted by the in-process RAM storage bridge. */
export interface StorageEvent {
  type: StorageEventType;
  filename?: string;
  sessionId?: number;
  queueItemId?: QueueItemId;
  chunkIndex?: number;
  // Binary consumers normalize either ArrayBuffer or Uint8Array at this
  // boundary; the current RAM bridge emits Uint8Array.
  chunk?: ArrayBuffer | Uint8Array;
  isPreload?: boolean;
  requestId?: string;
  error?: string;
  command?: string;
  code?: string;
  skipped?: boolean;
  // SESSION_MISMATCH reporting fields.
  expected?: number | null;
  received?: number;
}

// ─── Device List ───────────────────────────────────────────────────
export type DevicePlatform = 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'other';

export interface DeviceInfo {
  id: string;
  label: string;
  isOp: boolean;
  isHost: boolean;
  status: string;
  joinOrder?: number;
  connectionType?: 'local' | 'remote' | 'unknown' | string;
  /** Coarse, self-reported OS category. Never contains a raw user agent or model name. */
  devicePlatform?: DevicePlatform;
  memberId?: string;
  memberDisplayNumber?: number;
  isAuthenticated?: boolean;
  /** Server-authoritative PRO membership role for this physical connection. */
  role?: 'owner' | 'controller' | 'member';
  /** Effective PRO authority for this physical connection. */
  capabilities?: RoomCapability[];
}

type StandardRoomPermission = 'media.add' | 'playback.control' | 'members.kick' | 'chat.notice';

export type StandardRoomPermissionSet = Record<StandardRoomPermission, boolean>;

export interface StandardRoomAdministrator {
  memberId: string;
  memberDisplayNumber: number;
  isAuthenticated: boolean;
  displayName: string;
  permissions: StandardRoomPermissionSet;
}

export interface ConnectedPeer {
  id: string;
  slot: number;
  label: string;
  conn: DataConnection | null;
  isOp: boolean;
  preloadedQueueItemIds: Set<QueueItemId>;
  status: string;
  isDataTarget: boolean;
  joinOrder: number;
  connectionType: 'local' | 'remote' | 'unknown';
  /** Cosmetic coarse OS category supplied by the connected browser. */
  devicePlatform?: DevicePlatform;
  lastHeartbeat: number;
  /** Server-verified standard-room person identity, independent of peerId. */
  memberId?: StandardRoomMemberIdentity['memberId'];
  memberDisplayNumber?: number;
  isAuthenticated?: boolean;
  standardRoomPermissions?: StandardRoomPermissionSet;
  /** Effective server/host-issued capabilities for this physical connection. */
  roomCapabilities?: RoomCapability[];
}

// ─── P2P Protocol Messages ────────────────────────────────────────

/** Marker for protocol messages with no additional payload fields beyond `type`. */
type NoPayload = Record<never, never>;

/**
 * Maps each MsgType string literal to its payload shape (excluding the `type` field).
 * Used by ProtocolMsg<T> to build the full message type.
 */
export interface ProtocolMap {
  // ── Handshake / Session ──────────────────────────────────────────
  welcome: {
    lockChannel: boolean;
    label: string;
    chatFrozen?: boolean;
    slowmodeSeconds?: number;
    filterEnabled?: boolean;
  };
  'session-full': { message: string };
  'force-close-duplicate': NoPayload;
  'join-bootstrap-hello': { version: 1; bootstrapId: string };
  'join-bootstrap-applied': { version: 1; bootstrapId: string };
  'guest-decode-failed': { queueItemId: QueueItemId };
  'demo-enter': {
    index: number;
    reverbOn: boolean;
    bassBoostOn: boolean;
    trebleBoostOn: boolean;
    surroundOn: boolean;
  };
  'demo-exit': NoPayload;
  'demo-pause': { time: number };
  'demo-play': {
    index: number;
    time: number;
    hostPlayAt: number;
  };

  // ── Audio Control ────────────────────────────────────────────────
  volume: { value: number };
  /** Atomic coordinator-sequenced volume + DSP authority snapshot. */
  'settings-sync-snapshot': {
    version: 1;
    epoch: number;
    sequence: number;
    settings: RoomSettingsSyncState;
    _bootstrap?: true;
  };
  /** Any follower may ask the coordinator to replay the canonical snapshot. */
  'request-settings-sync-snapshot': { version: 1 };
  /** Only an effects controller may replace the canonical snapshot. */
  'publish-settings-sync-snapshot': { version: 1; settings: RoomSettingsSyncState };
  'eq-update': { band: number; value: number };
  'eq-reset': NoPayload;
  preamp: { value: number };
  reverb: { value: number };
  'reverb-type': { value: string };
  'reverb-decay': { value: number };
  'reverb-predelay': { value: number };
  'reverb-lowcut': { value: number };
  'reverb-highcut': { value: number };
  'stereo-width': { value: number };
  vbass: { value: number };
  exciter: { value: number };

  // ── Playback ─────────────────────────────────────────────────────
  play: {
    time: number;
    queueItemId: QueueItemId;
    name?: string | null;
    hostPlayAt?: number;
  };
  pause: {
    time: number;
    queueItemId: QueueItemId | null;
    endOfPlaylist?: boolean;
    reason?: 'pause' | 'stop' | 'seek' | 'transition' | 'end-of-playlist';
  };
  'play-preloaded': { queueItemId: QueueItemId; name: string; mime?: string };
  'file-prepare': {
    name: string;
    queueItemId: QueueItemId;
    sessionId: number;
    mime: string;
    size?: number;
    autoPlayDelayMs?: number;
    delivery?: 'r2';
  };
  'file-r2-capability': {
    version: 1;
    localAudience: true;
  };
  'remote-file-unavailable': {
    name: string;
    queueItemId: QueueItemId;
    sessionId: number;
    limited?: boolean;
    delivery?: 'r2';
  };
  'remote-file-share': RemoteFileSharePayload;
  // ── Playlist ─────────────────────────────────────────────────────
  'playlist-update': {
    list: PlaylistWireItem[];
    revision: PlaylistRevision;
    currentQueueItemId: QueueItemId | null;
    /** Only the first queue snapshot on a new host connection may rebaseline. */
    bootstrap?: true;
    /** Repaint an equal-revision operator view after a rejected/no-op mutation. */
    refresh?: true;
  };
  /** Legacy host hint for the next persistent file; the recipient self-preloads from R2. */
  'pro-file-preload': { queueItemId: QueueItemId; sessionId: number };
  /** Member hint that the authenticated PRO service has a newer snapshot. */
  'pro-room-invalidated': { revision: number; playlistRevision: number };
  /** Legacy member-to-host hint requesting a server-owned live-share refresh. */
  'pro-system-audio-hint': { generation: number };
  /** Legacy host fanout of an already server-validated PRO live-share state. */
  'pro-system-audio-state': {
    version: 1;
    generation: number;
    status: 'idle' | 'preparing' | 'live';
    ownerParticipantId: string | null;
    ownerDisplayName: string | null;
    claimExpiresAt: number | null;
    liveExpiresAt: number | null;
    publication: null | {
      publicationId: string;
      sessionId: string;
      tracks: Array<{
        trackName: string;
        channel: 'L' | 'R';
        mid?: string;
      }>;
    };
  };
  // _bootstrap marks a re-baseline frame (join bootstrap / OPERATOR_REVOKE
  // resync) — the receiving handler applies the value but skips the toast.
  'repeat-mode': { value: number; _bootstrap?: boolean };
  'shuffle-mode': { value: boolean; _bootstrap?: boolean };

  // ── File Transfer ────────────────────────────────────────────────
  'file-start': {
    name: string;
    mime?: string;
    total: number;
    size: number;
    queueItemId: QueueItemId;
    sessionId: number;
  };
  'file-chunk': {
    chunk: Uint8Array | ArrayBuffer;
    chunkIndex: number;
    queueItemId: QueueItemId;
    sessionId: number;
    total: number;
    name: string;
    size: number;
    mime?: string;
  };
  'file-end': { name: string; mime: string; queueItemId: QueueItemId; sessionId: number };
  'file-wait': {
    message: string;
    requestId: FileRequestId;
    queueItemId: QueueItemId;
    sessionId?: number;
    reason?: string;
  };
  'file-resume': {
    name: string;
    mime?: string;
    total: number;
    size: number;
    startChunk: number;
    sessionId: number;
    queueItemId: QueueItemId;
  };
  /** Separate upstream namespace: standard-room administrator -> host. */
  'operator-file-upload-start': {
    requestId: string;
    sessionId: string;
    name: string;
    mime: string;
    size: number;
    total: number;
  };
  'operator-file-upload-batch-start': { requestId: string; fileCount: number };
  'operator-file-upload-batch-complete': { requestId: string; committedCount: number };
  'operator-file-upload-chunk': {
    requestId: string;
    sessionId: string;
    chunkIndex: number;
    chunk: Uint8Array | ArrayBuffer;
  };
  'operator-file-upload-finish': { requestId: string; sessionId: string };
  'operator-file-upload-abort': {
    requestId: string;
    sessionId: string;
    reason: string;
  };
  'operator-file-upload-status': {
    requestId: string;
    sessionId: string;
    status: 'ready' | 'progress' | 'complete' | 'rejected' | 'aborted';
    loaded: number;
    total: number;
    code: string | null;
  };

  // ── Preload ──────────────────────────────────────────────────────
  'preload-start': {
    name: string;
    mime?: string;
    total: number;
    size: number;
    queueItemId: QueueItemId;
    sessionId: number;
    skipped?: boolean;
  };
  'preload-chunk': {
    chunk: Uint8Array;
    chunkIndex: number;
    queueItemId: QueueItemId;
    sessionId: number;
  };
  'preload-end': { name: string; queueItemId: QueueItemId; sessionId: number };
  'preload-ack': { queueItemId: QueueItemId; sessionId: number };
  'preload-abort': { queueItemId: QueueItemId; sessionId: number };

  // ── Network ─────────────────────────────────────────────────────
  'device-list-update': {
    list: Array<{
      id: string | null;
      label: string;
      status: string;
      isHost: boolean;
      isOp?: boolean;
      connectionType?: string;
      devicePlatform?: DevicePlatform;
      joinOrder?: number;
      memberId?: string;
      memberDisplayNumber?: number;
      isAuthenticated?: boolean;
      capabilities?: RoomCapability[];
    }>;
  };
  'kick-device': { reason?: string };
  'operator-toast': {
    text: string;
    i18nKey?: string;
    i18nParams?: Record<string, string | number>;
  };
  'operator-grant': { capabilities?: RoomCapability[]; silent?: boolean };
  'operator-revoke': { silent?: boolean };

  // ── Guest Requests ───────────────────────────────────────────────
  'request-play': { time?: number; queueItemId: QueueItemId };
  'request-pause': { queueItemId: QueueItemId };
  'request-seek': { time: number; queueItemId: QueueItemId };
  'request-skip-time': { sec: number; queueItemId: QueueItemId };
  'request-next-track': { queueItemId: QueueItemId | null };
  'request-prev-track': { queueItemId: QueueItemId | null };
  'request-track-change': { queueItemId: QueueItemId };
  /** Standard-room operator request; the host remains the sole queue writer. */
  'request-playlist-add-youtube': {
    requestId: string;
    baseRevision: PlaylistRevision;
    sourceUrl: string;
    title: string;
  };
  /** Standard-room operator request; the host resolves IDs against its live queue. */
  'request-playlist-remove': {
    requestId: string;
    baseRevision: PlaylistRevision;
    queueItemIds: QueueItemId[];
  };
  /** Standard-room operator request; insertion is expressed by stable queue IDs. */
  'request-playlist-reorder': {
    requestId: string;
    baseRevision: PlaylistRevision;
    queueItemId: QueueItemId;
    beforeQueueItemId: QueueItemId | null;
  };
  /**
   * Two-phase acknowledgement for standard-room operator queue requests.
   * The authoritative playlist snapshot remains the only queue state writer;
   * this message only reports compatibility and terminal request outcome.
   */
  'operator-queue-mutation-result': {
    requestId: string;
    phase: 'accepted' | 'settled';
    outcome: null | 'applied' | 'rejected';
    revision: PlaylistRevision;
    code:
      | null
      | 'conflict'
      | 'unauthorized'
      | 'invalid-target'
      | 'invalid-source'
      | 'queue-full'
      | 'resolution-failed'
      | 'internal-error';
  };
  'request-setting': { settingType: string; value?: unknown; band?: number };
  'request-eq-reset': NoPayload;
  'request-current-file': {
    requestId: FileRequestId;
    queueItemId: QueueItemId;
    sessionId?: number;
    name?: string;
    reason?: string;
  };
  'request-data-recovery': {
    requestId: FileRequestId;
    nextChunk: number;
    fileName: string;
    queueItemId: QueueItemId;
    sessionId?: number;
  };
  /** Authenticated PRO controller request; the server re-authorizes the target. */
  'request-kick-device': { targetPeerId: string };
  'request-kick-physical-device': { targetPeerId: string };
  'request-youtube-play': { queueItemId: QueueItemId };
  'request-youtube-pause': { queueItemId: QueueItemId };
  'request-youtube-toggle': { queueItemId: QueueItemId };
  'request-youtube-sub-seek': { subIdx: number; queueItemId: QueueItemId };
  'request-youtube-playlist-info': { playlistId: string };

  // ── YouTube ──────────────────────────────────────────────────────
  'youtube-play': {
    videoId?: string | null;
    playlistId?: string | string[] | null;
    name?: string | null;
    queueItemId: QueueItemId;
    autoplay: boolean;
    subIndex?: number;
  };
  'youtube-stop': { queueItemId: QueueItemId };
  'youtube-state': {
    queueItemId: QueueItemId;
    state: number;
    time: number;
    subIndex?: number;
    videoId?: string;
    hostPlayAt?: number;
    hostClock?: number;
    title?: string;
  };
  'youtube-sync': {
    queueItemId: QueueItemId;
    time: number;
    state: number;
    subIndex?: number;
    videoId?: string;
    hostClock?: number;
    isManual?: boolean;
    title?: string;
  };
  'youtube-zero-start-capability':
    | {
        /** Legacy support-only advertisement. Never implies runtime readiness. */
        version: 1;
        platform: YouTubeZeroStartPlatform;
      }
    | {
        /** Runtime-aware advertisement used by the bounded zero-start barrier. */
        version: 2;
        platform: YouTubeZeroStartPlatform;
        ready: boolean;
      };
  'youtube-zero-start-prepare': {
    version: 1;
    runId: string;
    sequence: number;
    queueItemId: QueueItemId;
    videoId: string;
    subIndex: number | null;
    prepareAtHost: number;
    decisionAtHost: number;
    startDeadlineAtHost: number;
    hostPlatform: YouTubeZeroStartPlatform;
  };
  'youtube-zero-start-armed': {
    version: 1;
    runId: string;
    sequence: number;
    queueItemId: QueueItemId;
    videoId: string;
    preparedMs: number;
    warmLatencyMs: number;
    positionSec: number;
    playerState: number;
    audioUnlocked: boolean;
    muted: boolean;
    volume: number;
    loadedFraction: number;
    startLeadMs: number;
    audibleBaseLeadMs: number;
    timelineLeadMs: number;
    platform: YouTubeZeroStartPlatform;
  };
  /** One authoritative release packet; no separate START frame is used. */
  'youtube-zero-start-commit': {
    version: 1;
    runId: string;
    sequence: number;
    queueItemId: QueueItemId;
    videoId: string;
    startAtHost: number;
    reason: YouTubeZeroStartCommitReason;
    cohort: string[];
  };
  'youtube-zero-start-abort': {
    version: 1;
    runId: string;
    sequence: number;
    queueItemId: QueueItemId;
    reason: YouTubeZeroStartAbortReason;
  };
  'youtube-zero-start-timeline': {
    version: 1;
    runId: string;
    sequence: number;
    queueItemId: QueueItemId;
    videoId: string;
    hostTime: number;
    positionSec: number;
    playerState: number;
  };
  'youtube-sub-title-update': { playlistId: string; subIdx: number; title: string };
  'youtube-playlist-info': { playlistId: string; ids: string[]; titles: string[] };

  // ── Shared Clock ────────────────────────────────────────────────
  'sync-ping': { pingId: number; guestTime: number };
  'sync-pong': {
    pingId: number;
    hostTime: number;
    position: number;
    mode: PlaybackModeValue;
    activity: PlaybackActivityValue;
    queueItemId: QueueItemId | null;
    demoTrackIndex?: number;
  };

  // ── Chat ─────────────────────────────────────────────────────────
  chat: {
    senderId: string;
    /** Host-attested room member identity used only for person-level presentation. */
    senderMemberId?: string;
    sender: string;
    senderLabel: string;
    text: string;
    ts: number;
    joinOrder?: number;
    /** Correlates a visible `/bot` request with its single terminal BOT reply. */
    botRequestId?: string;
  };
  'chat-bot-result': {
    requestId: string;
    senderId: string;
    result:
      | { kind: 'answer'; text: string }
      | { kind: 'added'; count: number; playbackChanged: boolean }
      | { kind: 'failed' }
      | { kind: 'rate_limited'; retryAfterSeconds: number };
  };

  // ── Chat Commands ─────────────────────────────────────────────
  'chat-mute': { targetId: string; targetLabel: string };
  'chat-unmute': { targetId: string; targetLabel: string };
  'chat-freeze': NoPayload;
  'chat-unfreeze': NoPayload;
  'chat-clear': NoPayload;
  'chat-whisper': {
    senderId: string;
    senderLabel: string;
    targetId: string;
    text: string;
    ts: number;
    joinOrder: number;
  };
  'chat-notice': {
    senderLabel: string;
    text: string;
    ts: number;
    // Optional i18n key retained for protocol compatibility. New pinned
    // notices are human-authored or operations-authored and normally use text.
    i18nKey?: string;
    i18nParams?: Record<string, string | number>;
    /** True only for a live publish; false when hydrating a late joiner. */
    attention?: boolean;
  };
  'chat-slowmode': { seconds: number };
  'chat-filter': { on: boolean };
  'chat-system': {
    text: string;
    // Automatic application events use this channel. Receivers localize the
    // key independently while `text` remains a readable fallback.
    i18nKey?: string;
    i18nParams?: Record<string, string | number>;
  };
  'request-chat-command': { command: string; args: string[] };

  // ── System Audio Sharing ──────────────────────────────────────
  'system-audio-start': NoPayload;
  'system-audio-sfu-capability': {
    version: 1;
    localAudience: true;
  };
  'system-audio-sfu-ready': {
    version: 1;
    /** `all` lets a LAN guest consume the publication instead of P2P. */
    audience?: 'remote' | 'all';
    sessionId: string;
    tracks: Array<{
      trackName: string;
      channel: 'L' | 'R';
      mid?: string;
    }>;
  };
  'system-audio-stop': NoPayload;
}

/** Full protocol message = { type: T } & payload */
export type ProtocolMsg<T extends MsgType> = { type: T } & ProtocolMap[T];

/** Union of all possible protocol messages */
export type AnyProtocolMsg = { [T in MsgType]: ProtocolMsg<T> }[MsgType];

// ─── State Tree ──────────────────────────────────────────────────────

type RoomKind = 'standard' | 'pro';
type RoomParticipantRole = 'coordinator' | 'member' | 'idle';
export type RoomCapability =
  | 'media.add'
  | 'queue.mutate'
  | 'playback.control'
  | 'effects.control'
  | 'asset.upload'
  /** Local-only authority: publish live system audio; never serialized in PRO snapshots. */
  | 'system-audio.publish'
  | 'members.manage'
  | 'chat.notice'
  | 'room.configure'
  | 'coordinator.eligible';

/**
 * Provider-neutral room authority projected into the legacy application.
 * `network.appRole`, `hostConn`, and `isOperator` remain transport-compatibility
 * fields; new PRO code must authorize against this context instead.
 */
export interface RoomContext {
  kind: RoomKind;
  roomId: string | null;
  role: RoomParticipantRole;
  coordinatorId: string | null;
  epoch: number;
  snapshotRevision: number;
  capabilities: RoomCapability[];
}

type SignalingHealthStatus = 'healthy' | 'reconnecting' | 'recovered' | 'exhausted';

/**
 * Durable UI-facing health of the room's signaling/control channel.
 *
 * This is deliberately separate from peer/data-channel health: an ordinary
 * room can keep its existing WebRTC channels alive while signaling is down,
 * and a PRO room can keep local media running while its server control
 * channel is being rebuilt.
 */
export interface SignalingHealthState {
  status: SignalingHealthStatus;
  /** One-based reconnect attempt while reconnecting; 0 in every other state. */
  attempt: number;
  maxAttempts: number;
}

export interface StateTree {
  setup: { sessionStarted: boolean };
  room: { context: RoomContext };
  player: {
    startedAt: number;
    pausedAt: number;
    isSeeking: boolean;
    isFirstTrackLoad: boolean;
    currentTrackMeta: TrackMeta | null;
    decodeFailureCount: number;
  };
  share: {
    remote: RemoteShareState;
  };
  transfer: {
    state: TransferStateValue;
    receivedCount: number;
    meta: Partial<FileMeta> | null;
    localSessionId: number;
    currentSessionId: number;
    activeBroadcastSession: number | null;
    lastReceivedCountSnapshot: number;
    /**
     * `waitingForPreload` and `skipIncomingFile` are derived from
     * `playback.lifecycle` (see `shouldSkipIncomingFile()` in
     * transfer-receive.ts).
     */
    /** Timestamp (ms) when a burst of stale-session chunks started arriving. 0 = no burst. */
    staleChunkBurstStart: number;
    /** Count of consecutive stale-session chunks rejected in the current burst. */
    staleChunkBurstCount: number;
  };
  preload: {
    isPreloading: boolean;
    sessionId: number;
    activeTarget: Partial<FileMeta> | null;
    ready: ResidentFile | null;
    nextQueueItemId: QueueItemId | null;
    ackSent: Map<QueueItemId, number>;
    sessionState: Map<number, PreloadSessionEntry>;
  };
  audio: {
    masterVolume: number;
    settingsSyncEnabled: boolean;
    channelMode: number;
    isSurroundMode: boolean;
    surroundChannelIndex: number;
    reverbMix: number;
    reverbDecay: number;
    reverbPreDelay: number;
    reverbLowCut: number;
    reverbHighCut: number;
    eqValues: number[];
    stereoWidth: number;
    virtualBass: number;
    exciter: boolean;
    subFreq: number;
    userPreampGain: number;
  };
  demo: {
    active: boolean;
    loading: boolean;
    currentTrackIndex: number;
    reverbOn: boolean;
    bassBoostOn: boolean;
    trebleBoostOn: boolean;
    surroundOn: boolean;
  };
  sync: {
    localOffset: number;
    youtubeLocalOffset: number;
    /** Actual offset currently realized by the authoritative PRO YouTube iframe. */
    youtubeCoordinatorAppliedOffset: number;
    lastLatencyMs: number;
    latencyHistory: number[];
  };
  network: {
    myId: string | null;
    myDeviceLabel: string;
    myJoinOrder: number;
    myMemberId: string | null;
    myMemberDisplayNumber: number | null;
    myMemberAuthenticated: boolean;
    appRole: 'host' | 'guest' | 'idle';
    sessionCode: string;
    lastJoinCode: string;
    hostConn: DataConnection | null;
    connectedPeers: ConnectedPeer[];
    isOperator: boolean;
    /** Explicit current standard-room grant. `null` means a legacy boolean-only host. */
    standardRoomCapabilities: RoomCapability[] | null;
    /**
     * A PRO member's outbound row-selection request while this endpoint is
     * still fetching/preparing that occurrence. This is local UI intent only;
     * authoritative queue selection still comes from the room service.
     */
    pendingTrackChangeQueueItemId: QueueItemId | null;
    isConnecting: boolean;
    isIntentionalDisconnect: boolean;
    lastKnownDeviceList: DeviceInfo[] | null;
    peerLabels: Record<string, string>;
    roomPasswordRequired: boolean;
    roomPassword: string;
    peerSlots: (string | null)[];
    peerSlotByPeerId: Map<string, number>;
    activeHostConnByPeerId: Map<string, DataConnection>;
    /** Canonical standard-room grants; `isOp` is only its legacy projection. */
    standardRoomAdministrators: Map<string, StandardRoomAdministrator>;
    connectionType: 'local' | 'remote' | 'unknown';
    mutedPeers: Set<string>;
    chatFrozen: boolean;
    slowmodeSeconds: number;
    filterEnabled: boolean;
    signalingHealth: SignalingHealthState;
  };
  playlist: {
    items: PlaylistItem[];
    currentQueueItemId: QueueItemId | null;
    revision: PlaylistRevision;
    repeatMode: number;
    isShuffle: boolean;
  };
  files: { current: ResidentFile | null };
  youtube: {
    currentSubIndex: number;
    subItemsMap: Record<
      string,
      {
        ids: string[];
        titles: string[];
        loadError?: boolean;
        /** True when ids came from a complete server manifest, including a real one-item list. */
        manifestComplete?: boolean;
      }
    >;
    /**
     * Guest-only: estimated `playVideo()` call → audible output latency (ms).
     * Used by the rendezvous sync (guest-initiated, host-nondisruptive) to
     * fire playVideo() slightly ahead of the target rendezvous instant so
     * the audible start aligns with the host's playback position.
     *
     * Self-calibrating: after each rendezvous, drift is measured vs.
     * extrapolated host position and this value is nudged via EMA.
     * Clamped to [0, 600]ms.
     *
     * Persisted to localStorage under `musixquare-yt-play-latency` so the
     * learned value survives page reloads — the underlying latency is a
     * stable device property (browser + OS + audio stack), so each device
     * only has to calibrate once and subsequent sessions start accurate.
     * Default 0ms when no prior calibration exists (pristine install).
     */
    guestPlayLatency: number;
  };
  recovery: {
    pending: boolean;
    retryCount: number;
    /**
     * Consumers read `playback.pendingRecoveryTarget` as a single atomic
     * { queueItemId, indexHint, name } object instead of split pending fields.
     */
  };
  systemAudio: { isReceiving: boolean };
  /**
   * Guest-side track playback lifecycle. Orthogonal to playback mode/activity.
   * Every transition MUST go through `src/player/lifecycle.ts::transition()`;
   * its lifecycle tests are the executable transition table.
   *
   * `transfer.waitingForPreload` and `transfer.skipIncomingFile` are derived
   * from this field. New flags here would resurrect the same divergence
   * problem; if you're tempted to add one, ask whether it can instead
   * be a derived helper that reads lifecycle + loadSource.
   */
  playback: {
    mode: PlaybackModeValue;
    activity: PlaybackActivityValue;
    lifecycle: PlaybackStateValue;
    loadSource: LoadSourceValue | null;
    pendingPlayTime: number | undefined;
    /**
     * Wall-clock time (Date.now ms) when pendingPlayTime was set. Consumers
     * add the elapsed delta to estimate the host's current position — important
     * when decode/HTTP-fetch takes seconds and the host keeps playing forward.
     * 0 = no pending time.
     */
    pendingPlayTimeSetAt: number;
    /**
     * The track we're awaiting (recovery, preload-promoted blob, deferred
     * play). Consumers read one atomic snapshot whose stable owner is
     * queueItemId; indexHint is diagnostic and may be reconciled after reorder.
     * `null` = no recovery target.
     */
    pendingRecoveryTarget: QueueTarget | null;
    /**
     * Content-keyed identifiers of tracks whose decode failed (timeout,
     * corrupt, unsupported). Consulted on auto-advance to skip rather than
     * loop forever. Local media keys come from Blob/File object identity (or
     * the playlist-entry object when no Blob is attached); YouTube uses its
     * stable video id. Metadata such as name and size is never content
     * identity. Cleared when count reaches playlist.length.
     *
     * Mutations follow the immutable-update rule: setState('playback.failedTrackKeys', new Set([...prev, key])).
     */
    failedTrackKeys: Set<string>;
  };
}

// ─── State Path Utilities ────────────────────────────────────────────

type IsLeaf<T> = T extends
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<unknown>
  | Map<unknown, unknown>
  | Set<unknown>
  | Blob
  | DataConnection
  | ReturnType<typeof setTimeout>
  ? true
  : false;

/** Union of all valid dot-separated state paths. */
export type StatePath = {
  [K in keyof StateTree & string]: IsLeaf<StateTree[K]> extends true
    ? K
    : `${K}.${keyof StateTree[K] & string}`;
}[keyof StateTree & string];

/** Maps a StatePath to its value type. */
export type StatePathValue<P extends string> = P extends keyof StateTree
  ? StateTree[P]
  : P extends `${infer D}.${infer K}`
    ? D extends keyof StateTree
      ? K extends keyof StateTree[D]
        ? StateTree[D][K]
        : never
      : never
    : never;

// ─── Immutability Utility ────────────────────────────────────────────

/**
 * Shallow immutability guard for getState() return values.
 * Prevents .push(), .set(), .delete() on state-derived collections
 * while keeping inner elements spreadable for immutable updates.
 */
export type ShallowImmutable<T> = T extends Blob | DataConnection
  ? T // Opaque externals pass through
  : T extends Map<infer K, infer V>
    ? ReadonlyMap<K, V>
    : T extends Set<infer U>
      ? ReadonlySet<U>
      : T extends Array<infer U>
        ? ReadonlyArray<U>
        : T extends object
          ? Readonly<T>
          : T;

// ─── State Change Events (auto-derived from StatePath) ────────────
// Mapped type: generates 'state:audio.masterVolume', 'state:playback.mode', etc.
// Typos like bus.emit('state:audio.volumee') → compile error.
type StateEvents = {
  [P in StatePath as `state:${P}`]: [value: unknown, path: string];
};

// ─── EventBus typed events ─────────────────────────────────────────
// 3.0: EventMap = BaseEventMap & StateEvents (no escape hatch)
export type EventMap = BaseEventMap & StateEvents;

export type SystemAudioStopReason = 'device-limit' | 'duration-limit';

/**
 * Stable, UI-facing projection of the authenticated PRO system-audio lease.
 * The private lease credential and the public SFU descriptor deliberately do
 * not cross the application event bus.
 */
interface ProSystemAudioUiState {
  roomCode: string | null;
  initialized: boolean;
  phase: 'idle' | 'preparing' | 'live';
  generation: number | null;
  ownerParticipantId: string | null;
  isLocalOwner: boolean;
  localRequestPending: boolean;
  canStart: boolean;
  canStop: boolean;
  claimExpiresAt: number | null;
  liveExpiresAt: number | null;
}

interface SetupGuestJoinFailure {
  error: unknown;
  userMessage: string;
}

interface BaseEventMap {
  'account:open': [];
  'account:deleted': [];
  'account:deletion-pending': [];
  // ── Audio ─────────────────────────────────────────────────────────
  'audio:ready': [];
  'audio:activate': [];
  'audio:set-volume': [volume: number];
  'audio:volume-changed': [volume: number];
  'audio:apply-youtube-volume': [];
  'audio:connect-surround': [channelIdx: number];
  'audio:disconnect-surround': [];
  'audio:set-channel-mode': [mode: number];
  'audio:update-effect': [type: string, param: string, value: number, isPreview?: boolean];
  'audio:set-virtual-effects': [state: { bass: boolean; treble: boolean; surround: boolean }];
  'audio:set-eq': [band: number, value: number, isPreview?: boolean];
  'audio:reverb-type-change': [type: string];
  'audio:reset-eq': [];
  'audio:surround-toggled': [];
  'settings-sync:publish-local': [];
  'settings-sync:changed': [enabled: boolean];
  'settings-sync:authority-revoked': [];
  // Host → effects.ts: resend the effect-settings snapshot to one peer
  // (fired on OPERATOR_REVOKE to re-baseline a demoted OP's optimistic applies)
  'effects:resync-peer': [conn: DataConnection];
  'demo:enter': [];
  /** Tear down old-room demo runtime without restoring its captured snapshot. */
  'demo:authority-reset': [];
  'demo:request-exit': [];
  'demo:open-info': [];
  'demo:toggle-play': [];
  'demo:seek': [seconds: number];
  'demo:set-role': [mode: number];
  'demo:toggle-reverb': [];
  'demo:toggle-bass': [];
  'demo:toggle-treble': [];
  'demo:toggle-surround': [];

  // ── Player ────────────────────────────────────────────────────────
  'player:ended': [];
  'player:toggle-play': [];
  'player:stop-all-media': [
    options?: { silent?: boolean; cancelInFlight?: boolean; clearBuffer?: boolean },
  ];
  'playback:replay-current': [delayMs?: number];
  'playback:refresh-current-position': [];
  /**
   * Rejoin only this browser's output to the authoritative room timeline.
   * This must never manufacture a room-wide play/seek command.
   */
  'playback:local-output-rejoin': [
    request: Readonly<{
      reason: 'media-session-play' | 'audio-context-recovered';
      mode: 'file' | 'youtube';
    }>,
  ];
  'player:check-ended': [];
  'player:buffer-changed': [];
  /** Local-only feedback while a PRO playback command awaits canonical media application. */
  'pro-playback:ui-control-pending': [event: Readonly<ProPlaybackUiControlPendingEvent>];
  /** Exact terminal result for the matching local PRO UI control token. */
  'pro-playback:ui-control-settled': [event: Readonly<ProPlaybackUiControlSettledEvent>];
  /** All-participant feedback while the PRO server rendezvous is preparing media. */
  'pro-playback:transition-loading': [loading: boolean];

  // ── Playlist ──────────────────────────────────────────────────────
  'playlist:prev-track': [];
  'playlist:next-track': [];
  'playlist:toggle-repeat': [];
  'playlist:toggle-shuffle': [];
  'playlist:shuffle-order-changed': [];
  'playlist:play-track': [queueItemId: QueueItemId, subIndex?: number];

  // ── UI ────────────────────────────────────────────────────────────
  'ui:sync-reverb-preset': [type: string];
  'ui:sync-reverb-param': [param: string, value: number];
  'ui:sync-eq-preset': [type: string];
  'ui:sync-eq-band': [bandIdx: number, value: number];
  'ui:sync-surround': [on: boolean];
  'ui:sync-vbass': [on: boolean];
  'ui:sync-exciter': [on: boolean];
  'ui:show-toast': [message: string];
  'ui:play-btn-state': [enabled: boolean];
  'ui:play-loading-state': [loading: boolean];
  'ui:update-play-state': [playing: boolean];
  'ui:duration-update': [duration: number];
  'ui:seek-reset': [];
  'ui:loop-start': [];
  'ui:scrollbar-relayout': [];
  /**
   * Re-measure and briefly reveal custom scrollbars inside a newly visible
   * surface. The optional scope keeps parked tabs/dialogs from flashing.
   */
  'ui:scrollbar-reveal': [scope?: HTMLElement];
  'ui:time-update': [
    currentFormatted: string,
    totalFormatted: string,
    currentTime: number,
    duration: number,
  ];
  'ui:switch-tab': [tabId: string];
  'ui:tab-changed': [tabId: string];
  'ui:settings-tab-opened': [];
  'ui:playlist-tab-opened': [];
  'ui:player-panel-visible': [];
  'ui:visualizer-check': [];
  'ui:close-chat-drawer': [];
  'ui:ui-sounds-changed': [enabled: boolean];
  'i18n:changed': [lang: string];
  'chat:system-message': [text: string];
  'chat:notice-message': [sender: string, text: string, timestamp?: number];
  /**
   * Emitted by chat-render.ts when a chat/whisper message is rendered into
   * the DOM, or when a notice reaches its pinned banner. ui/chat.ts listens to
   * update the preview text and unread badge, keeping drawer state decoupled
   * from render primitives. Unread increments iff !isMine.
   */
  'chat:message-rendered': [sender: string, text: string, isMine: boolean];

  // ── YouTube ───────────────────────────────────────────────────────
  /**
   * Projects independently owned YouTube synchronization work into the UI.
   * An owner-scoped `false` only releases that owner; an unscoped `false`
   * remains the hard-reset signal used when YouTube mode/session teardown
   * invalidates every pending operation.
   */
  'youtube:sync-loading': [loading: boolean, owner?: YouTubeSyncLoadingOwner];
  'youtube:load': [
    videoId: string | null,
    playlistId: string | null,
    queueItemId: QueueItemId,
    autoplay?: boolean,
    subIndex?: number,
  ];
  'youtube:restore-room-playback': [
    payload: {
      videoId: string | null;
      playlistId: string | null;
      name?: string | null;
      queueItemId: QueueItemId;
      autoplay?: boolean;
      subIndex?: number;
      positionSeconds?: number;
    },
  ];
  'youtube:toggle-play': [];
  /** Desired participant-local state from OS/headphone media controls. */
  'youtube:set-local-paused': [paused: boolean, reason?: 'media-session-play'];
  // isTrackTransition=true: caller is a block-to-block YT-to-YT track switch
  // (existing player ran loadVideoById on a different video). Handler pauses
  // the host and uses TRACK_TRANSITION_RENDEZVOUS_MS so guests get a 4s
  // window to loadVideoById the new entry before the synchronized resume —
  // mirrors the youtube:sub-video-advanced flow used inside a single
  // playlist's sub-items. Default (omitted/false) is the URL-input
  // first-load path where STAGE2_RENDEZVOUS_BROADCAST_MS is enough.
  'youtube:auto-play': [
    intent?:
      | boolean
      | {
          isTrackTransition?: boolean;
          /** Fresh shared 0-second start; eligible for the zero-start barrier. */
          zeroStart?: boolean;
          targetTime?: number;
          subIndex?: number;
          videoId?: string;
          skipSeek?: boolean;
          rendezvousDelayMs?: number;
          state?: 1 | 2;
        },
  ];
  'youtube:get-position': [callback: (pos: number) => void];
  'youtube:stop-playback': [];
  'youtube:skip-time': [seconds: number];
  'youtube:seek-to': [seconds: number];
  'youtube:try-next-internal': [callback: (success: boolean) => void];
  'youtube:try-prev-internal': [callback: (success: boolean) => void];
  /**
   * Emitted by iframe.ts when the YouTube IFrame auto-advances between
   * sub-videos in a playlist (ENDED does not fire for intra-playlist
   * transitions). player.ts listens and starts the transition rendezvous so
   * guests stay aligned across the sub-video boundary.
   */
  'youtube:sub-video-advanced': [];
  /**
   * Emitted by iframe.ts from onYouTubePlayerReady. The URL-input path waits
   * for this event before starting rendezvous sync on a fresh player.
   */
  'youtube:player-ready': [];
  'youtube:zero-start-readiness-changed': [];
  'youtube:broadcast-sync': [];
  'youtube:apply-manual-sync': [];
  'youtube:set-coordinator-manual-offset': [requestedOffsetSeconds: number];
  'youtube:preview': [url: string];
  'youtube:load-from-input': [];
  'youtube:load-from-chat': [url: string];
  // opts.silent: caller is mid-transition to another mode and will claim
  // playback shortly, so skip the IDLE bounce and avoid a body-class flash.
  'youtube:stop-mode': [opts?: { silent?: boolean }];
  'youtube:refresh-display': [];
  'youtube:set-volume': [volumePercent: number];
  'youtube:sub-seek': [queueItemId: QueueItemId, subIdx: number, isCurrent: boolean];
  'youtube:populate-sub-items': [playlistId: string | null, queueItemId: QueueItemId];

  // ── Network ───────────────────────────────────────────────────────
  'network:peer-ready': [peerId: string];
  /** Host-only ordered phase with synchronous send acknowledgement. */
  'network:peer-bootstrap': [
    conn: DataConnection,
    send: (frame: unknown) => boolean,
    acknowledge: (success: boolean) => void,
  ];
  /** Guest-only synchronous application of one ordered bootstrap frame. */
  'network:peer-bootstrap-apply': [
    frame: unknown,
    conn: DataConnection,
    acknowledge: (success: boolean) => void,
  ];
  'network:peer-connected': [conn: DataConnection];
  'network:peer-disconnected': [peerId: string];
  /** Same logical peerId, but a new exact authenticated DataConnection. */
  'network:peer-connection-replaced': [peerId: string];
  'network:data': [data: unknown, conn: DataConnection];
  'network:error': [error: unknown];
  'network:pro-queue-addition': [frame: ProQueueAdditionFrame];
  'network:broadcast': [data: unknown];
  'network:broadcast-except': [peerId: string, data: unknown];
  'network:toggle-operator': [peerId: string];
  'network:device-list': [list: unknown[]];
  'network:device-list-update': [list: unknown[]];
  'network:grant-standard-room-administrator': [
    detail: { memberId: string; permissions?: StandardRoomPermissionSet },
  ];
  'network:revoke-standard-room-administrator': [detail: { memberId: string }];
  'network:update-standard-room-administrator': [
    detail: { memberId: string; permissions: StandardRoomPermissionSet },
  ];
  /**
   * UI-facing standard-room kick request. The host enforces it directly;
   * delegated administrators relay one physical target to the host, which
   * expands a verified memberId to every live device.
   */
  'network:request-kick-standard-room-member': [detail: { memberId: string }];
  /** UI-facing request to disconnect exactly one physical standard-room connection. */
  'network:request-kick-standard-room-device': [detail: { peerId: string }];
  /** Verified signaling proof that an account was deleted from this room generation. */
  'network:standard-room-account-deleted': [detail: { memberId: string }];
  'network:role-badge-update': [];
  'network:session-full': [msg: unknown];
  'network:kicked-from-session': [];
  'network:kick-device': [peerId: string];
  /** Host-only exact physical disconnect; unlike kick-device, it preserves member authority. */
  'network:kick-physical-device': [peerId: string];
  /** PRO-room member removal is enforced by the room server across every account device. */
  'pro-room:kick-member': [memberIdOrLegacyParticipantId: string];
  'pro-room:administrators-updated': [administrators: ProRoomAdministrator[]];
  'network:kicked-explicitly': [];
  'network:room-password-changed': [password: string | null];
  'chat:muted-state-changed': [isMuted: boolean];
  'chat:clear-all': [];

  // ── Playlist ────────────────────────────────────────────────────
  'playlist:remove-tracks': [queueItemIds: QueueItemId[]];
  'playlist:reorder-track': [
    queueItemId: QueueItemId,
    beforeQueueItemId: QueueItemId | null,
    baseRevision: PlaylistRevision,
  ];
  'playlist:items-added': [queueItemIds: QueueItemId[]];
  /** Re-render the current authoritative queue after a local request send fails. */
  'playlist:refresh-requested': [];
  /** Fully verified upstream File; the host remains the sole queue writer. */
  'standard-room:operator-file-received': [
    file: File,
    acknowledge: (outcome: true | false | 'queue-full') => void,
    sourceConnection?: DataConnection,
  ];
  'standard-room:operator-file-uplink-progress': [progress: StandardOperatorFileUplinkProgress];
  'standard-room:operator-files-added': [
    sourceConnection: DataConnection,
    count: number,
    firstTitle?: string,
  ];
  'standard-room:queue-mutation-failed': [
    reason: 'send-failed' | 'accept-timeout' | 'settle-timeout' | 'rejected',
    code:
      | null
      | 'conflict'
      | 'unauthorized'
      | 'invalid-target'
      | 'invalid-source'
      | 'queue-full'
      | 'resolution-failed'
      | 'internal-error',
  ];

  // ── Storage ───────────────────────────────────────────────────────
  'storage:transfer-progress': [progress: number, total: number];
  'storage:preload-ready': [queueItemId: QueueItemId];
  // forceChunk is the store-derived resume base from handleFileResume.
  // Plain emits (no arg) mean "ask from the counter"; the recovery listener
  // normalizes undefined → null before forwarding to sendRecoveryRequest.
  'storage:request-recovery': [forceChunk?: number];
  'storage:clear-previous-track': [context: string];
  'storage:use-preloaded': [queueItemId: QueueItemId, name: string, sessionId?: number];
  'storage:preload-file-ready': [filename: string, sessionId: number, queueItemId: QueueItemId];
  'storage:file-ready': [
    filename: string,
    sessionId: number,
    isPreload: boolean,
    queueItemId: QueueItemId,
  ];
  'storage:read-error': [data: unknown];
  'storage:error': [error: string, filename: string];
  'storage:write-error': [data: StorageEvent];
  'storage:session-mismatch': [data: unknown];
  'storage:cleanup-complete': [queueItemId: QueueItemId, sessionId?: number, filename?: string];

  // ── Blob ──────────────────────────────────────────────────────────

  // ── Sync ──────────────────────────────────────────────────────────
  'sync:display-update': [];
  'sync:nudge': [ms: number];
  'sync:auto-sync': [];
  'sync:arm-initial': [];
  'sync:close-manual': [];
  'sync:request-immediate-ping': [];
  'sync:force-resync': [];
  'sync:latency-update': [ms: number];
  /** Local-only inputs for the bounded, RAM-only sync flight recorder. */
  'sync:diagnostic-worker-tick': [id: string];
  'sync:diagnostic-standard-pong': [
    observation: {
      trackKey: string | null;
      trackMatches: boolean;
      playing: boolean;
      hostTimeMs: number;
      positionSeconds: number;
      rttMs: number;
      offsetMs: number;
    },
  ];
  'sync:diagnostic-standard-decision': [
    observation: {
      decision: 'observe' | 'bootstrap' | 'initial' | 'hard' | 'soft' | 'skipped';
      expectedPositionSeconds?: number;
      localPositionSeconds?: number;
      reason?: string;
    },
  ];
  'sync:diagnostic-pro-checkpoint': [
    observation: {
      trackKey: string | null;
      state: 'idle' | 'playing' | 'paused';
      positionSeconds: number;
      updatedAtMs: number;
      revision: number;
    },
  ];

  // ── Orchestrator ────────────────────────────────────────────────
  'orchestrator:peer-type-detected': [peerId: string, isInitial?: boolean];
  'orchestrator:peer-evaluated': [peerId: string];
  'orchestrator:peer-joined': [peerId: string];
  'orchestrator:peer-data-target-ready': [peerId: string];

  // ── Connect ─────────────────────────────────────────────────────────
  'ui:connect-tab-opened': [];

  // ── Setup ─────────────────────────────────────────────────────────
  'setup:guest-join-success': [];
  'setup:guest-join-failure': [failure: SetupGuestJoinFailure];
  // User-cancelled the capability/Turnstile challenge mid-join — restore the
  // join UI silently (no red error toast). See guest.ts and setup.ts.
  'setup:guest-join-cancelled': [];
  'setup:app-entrance': [];

  // ── App ───────────────────────────────────────────────────────────
  'app:files-selected': [files: FileList | readonly File[] | null];

  // ── System Audio Sharing ────────────────────────────────────────
  'system-audio:start': [];
  'system-audio:stop': [options?: { reason?: SystemAudioStopReason }];
  'system-audio:force-stop': [];
  'system-audio:streams-ready': [];
  'system-audio:incoming-call': [mediaConn: unknown, channel: string];
  'system-audio:receive-timeout': [];
  'system-audio:sfu-fallback': [reason: string];
  'system-audio:delivery-handoff': [];
  'system-audio:host-started': [];
  'system-audio:host-stopped': [];
  'pro-system-audio:state-changed': [state: ProSystemAudioUiState, ownerDisplayName: string | null];
  'pro-system-audio:lease-lost': [
    reason: 'authoritative-revocation' | 'session-changed' | 'reset' | 'publisher-failed',
  ];

  // ── Visualizer ────────────────────────────────────────────────────
  'visualizer:start': [];
  'visualizer:hold-frame': [];
  'visualizer:fade-out': [];
  'visualizer:set-type': [mode: 'circular' | 'spectrum'];

  // ── Worker ──────────────────────────────────────────────────────────
  'worker:timer-tick': [id: string];
}
