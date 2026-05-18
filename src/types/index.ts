/**
 * MUSIXQUARE — Shared Type Definitions
 */

// NOTE: TransferState and other shared value constants live in core/constants.ts.
//       Removed duplicate const enums that were never imported.

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

/** App media connection abstraction. PeerJS media calls are a fallback provider. */
export type MediaConnection = TransportMediaConnection;

/** Network peer/signaling provider instance. */
export type PeerInstance = TransportPeer;

// ─── File Transfer ─────────────────────────────────────────────────
export interface FileMeta {
  name: string;
  title?: string;
  type: string;
  index: number;
  size: number;
  mime: string;
  sessionId: number;
  total: number;
}

export interface PreloadSessionEntry {
  skipped: boolean;
  progress: number;
  total: number;
  name: string;
  index: number;
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
  index: number;
  sessionId: number;
  expiresAt: number;
  /**
   * Legacy compatibility flag. Remote speculative preload is disabled in
   * current clients; incoming descriptors with preload=true are ignored.
   */
  preload?: boolean;
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
    blobUrl: string | null;
    error: string | null;
  };
}

// ─── Playlist ──────────────────────────────────────────────────────
export interface PlaylistItem {
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

export interface TrackMeta extends Partial<PlaylistItem> {
  systemAudioPlaceholder?: boolean;
}

// ─── Storage Commands & Events ─────────────────────────────────────

/** Commands accepted by `storage.ts::postCommand`. All are STORAGE_*. */
export interface StorageCommand {
  command: string;
  filename?: string;
  sessionId?: number;
  index?: number;
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

/**
 * Events emitted by the storage layer. On the slot-pool branch these
 * came from `transfer.worker.ts` postMessage; on RAM-only the in-process
 * bridge synthesizes the same wire shape so consumers stay unchanged.
 */
export interface StorageEvent {
  type: StorageEventType;
  filename?: string;
  sessionId?: number;
  index?: number;
  // STORAGE_READ_COMPLETE delivers chunks as Uint8Array (with .buffer
  // transferred). Allow either shape so the in-process RAM bridge and a
  // worker-backed implementation both satisfy this contract.
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
}

export interface ConnectedPeer {
  id: string;
  slot: number;
  label: string;
  conn: DataConnection | null;
  isOp: boolean;
  preloadedIndexes: Set<number>;
  status: string;
  isDataTarget: boolean;
  joinOrder: number;
  connectionType: 'local' | 'remote' | 'unknown';
  lastHeartbeat: number;
}

// ─── P2P Protocol Messages ────────────────────────────────────────

/** Marker for protocol messages with no additional payload fields beyond `type`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type NoPayload = {};

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
  'guest-decode-failed': { index: number };
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

  // ── Playback ─────────────────────────────────────────────────────
  play: {
    time: number;
    index: number;
    name?: string | null;
    timestamp?: number;
    hostPlayAt?: number;
  };
  pause: {
    time: number;
    index?: number;
    timestamp?: number;
    endOfPlaylist?: boolean;
    reason?: 'pause' | 'stop' | 'seek' | 'transition' | 'end-of-playlist';
  };
  'play-preloaded': { index: number; name: string; mime?: string };
  'file-prepare': {
    name: string;
    index: number;
    sessionId: number;
    mime: string;
    size?: number;
    autoPlayDelayMs?: number;
  };
  'remote-file-unavailable': {
    name: string;
    index: number;
    sessionId: number;
    limited?: boolean;
  };
  'remote-file-share': RemoteFileSharePayload;
  // ── Playlist ─────────────────────────────────────────────────────
  'playlist-update': {
    list: Array<Record<string, unknown>>;
    currentTrackIndex?: number;
    index?: number;
  };
  'repeat-mode': { value: number };
  'shuffle-mode': { value: boolean };

  // ── File Transfer ────────────────────────────────────────────────
  'file-start': {
    name: string;
    mime?: string;
    total?: number;
    size?: number;
    index?: number;
    sessionId: number;
  };
  'file-chunk': {
    chunk: Uint8Array | ArrayBuffer;
    index: number;
    sessionId: number;
    total?: number;
    name?: string;
    size?: number;
    mime?: string;
  };
  'file-end': { name: string; mime: string; sessionId: number };
  'file-wait': { message: string };
  'file-resume': {
    name: string;
    mime?: string;
    total: number;
    size: number;
    startChunk: number;
    sessionId: number;
    index?: number;
  };

  // ── Preload ──────────────────────────────────────────────────────
  'preload-start': {
    name: string;
    mime?: string;
    total: number;
    size: number;
    index: number;
    sessionId: number;
    skipped?: boolean;
  };
  'preload-chunk': { chunk: Uint8Array; index: number; sessionId: number };
  'preload-end': { name: string; index: number; sessionId: number };
  'preload-ack': { index: number };
  'preload-abort': { sessionId: number };

  // 'sync-response', 'get-sync-time', 'global-resync-request' removed — dead code
  // 'heartbeat', 'heartbeat-ack', 'ping-latency', 'pong-latency' removed — replaced by sync-ping/pong

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
  'request-play': { time?: number };
  'request-pause': NoPayload;
  'request-seek': { time: number };
  'request-skip-time': { sec: number };
  'request-next-track': NoPayload;
  'request-prev-track': NoPayload;
  'request-track-change': { index: number };
  'request-setting': { settingType: string; value?: unknown; band?: number };
  'request-eq-reset': NoPayload;
  'request-current-file': { name?: string; index?: number; reason?: string };
  'request-data-recovery': {
    nextChunk: number;
    fileName: string;
    index: number;
    sessionId?: number;
  };
  'request-youtube-play': NoPayload;
  'request-youtube-pause': NoPayload;
  'request-youtube-toggle': NoPayload;
  'request-youtube-sub-seek': { subIdx: number; playlistIdx?: number };
  'request-youtube-playlist-info': { playlistId: string };

  // ── YouTube ──────────────────────────────────────────────────────
  'youtube-play': {
    videoId?: string | null;
    playlistId?: string | string[] | null;
    name?: string | null;
    index?: number;
    autoplay: boolean;
    subIndex?: number;
  };
  'youtube-stop': NoPayload;
  'youtube-zero-start-prepare': {
    token: string;
    videoId?: string;
    subIndex?: number;
    timeoutMs: number;
  };
  'youtube-zero-start-ready': {
    token: string;
    videoId?: string;
    subIndex?: number;
  };
  'youtube-state': {
    state: number;
    time: number;
    subIndex?: number;
    videoId?: string;
    hostPlayAt?: number;
    hostClock?: number;
    title?: string;
    zeroStart?: boolean;
  };
  'youtube-sync': {
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
    trackIndex: number;
  };
  'sync-request': NoPayload;

  // ── Chat ─────────────────────────────────────────────────────────
  chat: {
    senderId: string;
    sender: string;
    senderLabel: string;
    senderRole: string;
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
    text: string;
    ts: number;
    joinOrder: number;
  };
  'chat-notice': {
    senderLabel: string;
    text: string;
    ts: number;
    // Optional i18n key — when present, each receiver renders this key in
    // their own locale instead of using `text`. Lets system notices (e.g.
    // "skipped a track that one device couldn't decode") be localized
    // per-recipient even though the host doesn't know each guest's lang.
    // Sender still fills `text` as a fallback so older clients (or notices
    // without a known key) still display something readable.
    i18nKey?: string;
    i18nParams?: Record<string, string | number>;
  };
  'chat-slowmode': { seconds: number };
  'chat-filter': { on: boolean };
  'chat-system': {
    text: string;
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
     * `playback.lifecycle` now (see
     * `shouldSkipIncomingFile()` in transfer-receive.ts).
     */
    /** Timestamp (ms) when a burst of stale-session chunks started arriving. 0 = no burst. */
    staleChunkBurstStart: number;
    /** Count of consecutive stale-session chunks rejected in the current burst. */
    staleChunkBurstCount: number;
  };
  preload: {
    isPreloading: boolean;
    sessionId: number;
    meta: Partial<FileMeta> | null;
    nextTrackIndex: number;
    nextFileBlob: Blob | null;
    ackSent: Set<number>;
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
    subFreq: number;
    userPreampGain: number;
  };
  demo: {
    active: boolean;
    loading: boolean;
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
    currentTrackIndex: number;
    repeatMode: number;
    isShuffle: boolean;
  };
  files: { currentFileBlob: Blob | null; currentTrack: { name: string | null } };
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
     * { index, name } object instead of split pending file fields.
     */
  };
  systemAudio: { isReceiving: boolean };
  /**
   * Guest-side track playback lifecycle. Orthogonal to playback mode/activity.
   * Every transition MUST go through `src/player/lifecycle.ts::transition()`.
   * See `.workshop/design/playback-state-machine.md` for the full table.
   *
   * `transfer.waitingForPreload` and `transfer.skipIncomingFile` are derived
   * from this field now. New flags here would just resurrect the same divergence
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
    pendingPausedAt: number | undefined;
    /**
     * The track we're awaiting (recovery, preload-promoted blob, deferred
     * play). Replaces the legacy `recovery.pendingFileIndex` +
     * `recovery.pendingFileName` pair so consumers read one atomic
     * snapshot instead of two fields that could disagree mid-update.
     * `null` = no recovery target.
     */
    pendingRecoveryTarget: { index: number; name: string } | null;
    /**
     * Content-keyed identifiers of tracks whose decode failed (timeout,
     * corrupt, unsupported). Consulted on auto-advance to skip rather than
     * loop forever. Keys are content-based ("file:name:size:lastModified",
     * "yt:videoId", "name:fallback") so reorder/add doesn't invalidate
     * the memory. Cleared when count reaches playlist.length.
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
  'demo:enter': [];
  'demo:exit': [];
  'demo:request-exit': [];
  'demo:open-info': [];
  'demo:toggle-play': [];
  'demo:seek': [seconds: number];
  'demo:set-role': [mode: number];
  'demo:toggle-reverb': [];
  'demo:toggle-bass': [];
  'demo:toggle-treble': [];
  'demo:toggle-surround': [];

  // ── Beat Detection ──────────────────────────────────────────────
  'beat:pulse': [bpm: number, beatIndex: number];

  // ── Player ────────────────────────────────────────────────────────
  'player:ended': [];
  'player:toggle-play': [];
  'player:stop-all-media': [];
  'playback:replay-current': [delayMs?: number];
  'playback:refresh-current-position': [];
  'player:check-ended': [];
  'player:buffer-changed': [];

  // ── Playlist ──────────────────────────────────────────────────────
  'playlist:prev-track': [];
  'playlist:next-track': [];
  'playlist:toggle-repeat': [];
  'playlist:toggle-shuffle': [];
  'playlist:play-track': [index: number, subIndex?: number];

  // ── UI ────────────────────────────────────────────────────────────
  'ui:sync-reverb-preset': [type: string];
  'ui:sync-reverb-param': [param: string, value: number];
  'ui:sync-eq-preset': [type: string];
  'ui:sync-eq-band': [bandIdx: number, value: number];
  'ui:sync-surround': [on: boolean];
  'ui:sync-vbass': [on: boolean];
  'ui:show-toast': [message: string];
  // ui:show-loader / ui:update-loader removed — driven via direct function imports
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
  'ui:settings-tab-opened': [];
  'ui:playlist-tab-opened': [];
  'ui:visualizer-check': [];
  'ui:close-chat-drawer': [];
  'ui:toggle-chat-drawer': [];
  'i18n:changed': [lang: string];
  'chat:system-message': [text: string];
  'chat:notice-message': [sender: string, text: string];
  /**
   * Emitted by chat-render.ts when a chat/whisper/notice message is rendered
   * into the DOM. ui/chat.ts listens to update the preview text and unread
   * badge, keeping drawer state decoupled from render primitives. Unread
   * increments iff !isMine.
   */
  'chat:message-rendered': [sender: string, text: string, isMine: boolean];

  // ── YouTube ───────────────────────────────────────────────────────
  'youtube:sync-loading': [loading: boolean];
  'youtube:load': [
    videoId: string | null,
    playlistId: string | null,
    autoplay?: boolean,
    subIndex?: number,
  ];
  'youtube:restore-room-playback': [
    payload: {
      videoId: string | null;
      playlistId: string | null;
      name?: string | null;
      index?: number;
      autoplay?: boolean;
      subIndex?: number;
    },
  ];
  'youtube:toggle-play': [];
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
   * transitions). Listened by player.ts to re-apply the 1-second
   * rendezvous sync so guests stay aligned across the sub-video boundary.
   */
  'youtube:sub-video-advanced': [];
  /**
   * Emitted by iframe.ts from onYouTubePlayerReady. Used by the URL-input
   * path in player.ts to defer its 1-sec rendezvous sync trigger until
   * the freshly created player instance is actually usable.
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
  'youtube:sub-seek': [playlistIdx: number, subIdx: number, isCurrent: boolean];
  'youtube:populate-sub-items': [playlistId: string | null, playlistIdx: number];

  // ── Network ───────────────────────────────────────────────────────
  'network:peer-ready': [peerId: string];
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
  'playlist:remove-track': [index: number];

  // ── Storage ───────────────────────────────────────────────────────
  'storage:transfer-progress': [progress: number, total: number];
  'storage:preload-ready': [index: number];
  'storage:request-recovery': [];
  'storage:clear-previous-track': [context: string];
  'storage:use-preloaded': [index: number, name: string];
  'storage:preload-file-ready': [filename: string, sessionId: number];
  'storage:file-ready': [filename: string, sessionId: number, isPreload: boolean];
  'storage:read-complete': [data: unknown];
  'storage:read-error': [data: unknown];
  'storage:error': [error: string, filename: string];
  'storage:write-error': [data: unknown];
  'storage:session-mismatch': [data: unknown];
  'storage:cleanup-complete': [filename: string];

  // ── Remote Share ─────────────────────────────────────────────────
  'share:remote-file': [descriptor: RemoteFileSharePayload];
  'remote-file:ready': [index: number, name: string];
  'remote-file:progress': [phase: 'upload' | 'download' | 'decrypt', progress: number];

  // ── Blob ──────────────────────────────────────────────────────────
  'blob:revoke-all': [];

  // ── Sync ──────────────────────────────────────────────────────────
  'sync:display-update': [];
  'sync:nudge': [ms: number];
  'sync:auto-sync': [];
  'sync:arm-initial': [];
  'sync:close-manual': [];
  'sync:request-immediate-ping': [];
  'sync:force-resync': [];
  // 'sync:get-position', 'sync:response' removed — no emitter exists
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
  'setup:app-entrance': [];

  // ── App ───────────────────────────────────────────────────────────
  'app:load-demo': [];
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
