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

// ─── Peer / Network ────────────────────────────────────────────────

import type {
  TransportDataConnection,
  TransportMediaConnection,
  TransportPeer,
} from '../network/transport/types.ts';

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
  keyB64: string;
  ivB64: string;
  name: string;
  mime: string;
  size: number;
  encryptedSize: number;
  queueItemId: QueueItemId;
  sessionId: number;
  expiresAt: number;
}

export type RemoteShareUploadStatus = 'idle' | 'encrypting' | 'uploading' | 'done' | 'error';
export type RemoteShareDownloadStatus = 'idle' | 'fetching' | 'decrypting' | 'ready' | 'error';

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

// ─── Playlist ──────────────────────────────────────────────────────
export type QueueItemId = string;
/** Guest-local correlation token for one concrete file request. */
export type FileRequestId = number;
export type PlaylistRevision = number;

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
export interface DeviceInfo {
  id: string;
  label: string;
  isOp: boolean;
  isHost: boolean;
  status: string;
  joinOrder?: number;
  connectionType?: 'local' | 'remote' | 'unknown' | string;
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
  lastHeartbeat: number;
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
  };
  'remote-file-unavailable': {
    name: string;
    queueItemId: QueueItemId;
    sessionId: number;
    limited?: boolean;
  };
  'remote-file-share': RemoteFileSharePayload;
  // ── Playlist ─────────────────────────────────────────────────────
  'playlist-update': {
    list: PlaylistWireItem[];
    revision: PlaylistRevision;
    currentQueueItemId: QueueItemId | null;
    /** Only the first queue snapshot on a new host connection may rebaseline. */
    bootstrap?: true;
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
      joinOrder?: number;
    }>;
  };
  'kick-device': { reason?: string };
  'operator-toast': {
    text: string;
    i18nKey?: string;
    i18nParams?: Record<string, string | number>;
  };
  'operator-grant': NoPayload;
  'operator-revoke': NoPayload;

  // ── Guest Requests ───────────────────────────────────────────────
  'request-play': { time?: number; queueItemId: QueueItemId };
  'request-pause': { queueItemId: QueueItemId };
  'request-seek': { time: number; queueItemId: QueueItemId };
  'request-skip-time': { sec: number; queueItemId: QueueItemId };
  'request-next-track': { queueItemId: QueueItemId | null };
  'request-prev-track': { queueItemId: QueueItemId | null };
  'request-track-change': { queueItemId: QueueItemId };
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
    sender: string;
    senderLabel: string;
    text: string;
    ts: number;
    joinOrder?: number;
  };

  // ── Rename ──────────────────────────────────────────────────────
  'request-rename': { newLabel: string };

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
  'system-audio-sfu-ready': {
    version: 1;
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

export interface StateTree {
  setup: { sessionStarted: boolean };
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
    lastLatencyMs: number;
    latencyHistory: number[];
  };
  network: {
    myId: string | null;
    myDeviceLabel: string;
    myJoinOrder: number;
    appRole: 'host' | 'guest' | 'idle';
    sessionCode: string;
    lastJoinCode: string;
    hostConn: DataConnection | null;
    connectedPeers: ConnectedPeer[];
    isOperator: boolean;
    isConnecting: boolean;
    isIntentionalDisconnect: boolean;
    lastKnownDeviceList: DeviceInfo[] | null;
    peerLabels: Record<string, string>;
    maxGuestSlots: number;
    roomPasswordRequired: boolean;
    roomPassword: string;
    peerSlots: (string | null)[];
    peerSlotByPeerId: Map<string, number>;
    activeHostConnByPeerId: Map<string, DataConnection>;
    connectionType: 'local' | 'remote' | 'unknown';
    mutedPeers: Set<string>;
    chatFrozen: boolean;
    slowmodeSeconds: number;
    filterEnabled: boolean;
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
    subItemsMap: Record<string, { ids: string[]; titles: string[]; loadError?: boolean }>;
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

interface BaseEventMap {
  // ── Audio ─────────────────────────────────────────────────────────
  'audio:ready': [];
  'audio:activate': [];
  'audio:set-volume': [volume: number];
  'audio:volume-changed': [volume: number];
  'audio:apply-youtube-volume': [];
  'audio:connect-surround': [playerNode: unknown, channelIdx: number];
  'audio:disconnect-surround': [];
  'audio:set-channel-mode': [mode: number];
  'audio:update-effect': [type: string, param: string, value: number, isPreview?: boolean];
  'audio:set-eq': [band: number, value: number, isPreview?: boolean];
  'audio:reverb-type-change': [type: string];
  'audio:reset-eq': [];
  'audio:surround-toggled': [];
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
  'player:check-ended': [];
  'player:buffer-changed': [];

  // ── Playlist ──────────────────────────────────────────────────────
  'playlist:prev-track': [];
  'playlist:next-track': [];
  'playlist:toggle-repeat': [];
  'playlist:toggle-shuffle': [];
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
  'ui:update-play-state': [playing: boolean];
  'ui:duration-update': [duration: number];
  'ui:seek-reset': [];
  'ui:loop-start': [];
  'ui:scrollbar-relayout': [];
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
  'ui:toggle-chat-drawer': [];
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
  'youtube:sync-loading': [loading: boolean];
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
    },
  ];
  'youtube:toggle-play': [];
  'youtube:local-toggle-play': [];
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
          targetTime?: number;
          subIndex?: number;
          videoId?: string;
          skipSeek?: boolean;
          rendezvousDelayMs?: number;
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
  'youtube:broadcast-sync': [];
  'youtube:apply-manual-sync': [];
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
  /** Host-only ordered phase for authority snapshots before playback bootstrap. */
  'network:peer-bootstrap': [conn: DataConnection];
  'network:peer-connected': [conn: DataConnection];
  'network:peer-disconnected': [peerId: string];
  'network:data': [data: unknown, conn: DataConnection];
  'network:error': [error: unknown];
  'network:broadcast': [data: unknown];
  'network:broadcast-except': [peerId: string, data: unknown];
  'network:toggle-operator': [peerId: string];
  'network:device-list': [list: unknown[]];
  'network:device-list-update': [list: unknown[]];
  'network:role-badge-update': [];
  'network:session-full': [msg: unknown];
  'network:kicked-from-session': [];
  'network:kick-device': [peerId: string];
  'network:kicked-explicitly': [];
  'network:rename-device': [newName: string];
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

  // ── Orchestrator ────────────────────────────────────────────────
  'orchestrator:peer-type-detected': [peerId: string, isInitial?: boolean];
  'orchestrator:peer-evaluated': [peerId: string];
  'orchestrator:peer-joined': [peerId: string];
  'orchestrator:peer-data-target-ready': [peerId: string];

  // ── Connect ─────────────────────────────────────────────────────────
  'ui:connect-tab-opened': [];
  'network:max-guests-changed': [max: number];

  // ── Setup ─────────────────────────────────────────────────────────
  'setup:guest-join-success': [];
  'setup:guest-join-failure': [error: unknown];
  // User-cancelled the capability/Turnstile challenge mid-join — restore the
  // join UI silently (no red error toast). See guest.ts and setup.ts.
  'setup:guest-join-cancelled': [];
  'setup:app-entrance': [];

  // ── App ───────────────────────────────────────────────────────────
  'app:files-selected': [files: FileList | null];

  // ── System Audio Sharing ────────────────────────────────────────
  'system-audio:start': [];
  'system-audio:stop': [];
  'system-audio:force-stop': [];
  'system-audio:streams-ready': [];
  'system-audio:incoming-call': [mediaConn: unknown, channel: string];
  'system-audio:receive-timeout': [];
  'system-audio:sfu-fallback': [reason: string];
  'system-audio:host-stopped': [];

  // ── Visualizer ────────────────────────────────────────────────────
  'visualizer:start': [];
  'visualizer:hold-frame': [];
  'visualizer:fade-out': [];
  'visualizer:set-type': [mode: 'circular' | 'spectrum'];

  // ── Worker ──────────────────────────────────────────────────────────
  'worker:timer-tick': [id: string];
}
