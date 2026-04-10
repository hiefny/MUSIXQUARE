/**
 * MUSIXQUARE 3.0 — Shared Type Definitions
 */

// NOTE: AppState / TransferState live in core/constants.ts (APP_STATE, TRANSFER_STATE).
//       Removed duplicate const enums that were never imported.

import type { AppStateValue, TransferStateValue, MsgType } from '../core/constants.ts';

// ─── Peer / Network ────────────────────────────────────────────────

import type { Peer as PeerClass, DataConnection as PeerJSDataConnection } from 'peerjs';

/** PeerJS DataConnection extended with relay properties */
export type DataConnection = PeerJSDataConnection & {
  _relayQueue?: unknown[];
  _relayBusy?: boolean;
  _errorHandled?: boolean;
};

/** PeerJS Peer instance */
export type PeerInstance = PeerClass;



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

// ─── Worker Messages ───────────────────────────────────────────────
export interface WorkerCommand {
  command: string;
  id?: string;
  interval?: number;
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

export type WorkerResponseType =
  | 'OPFS_STARTED'
  | 'OPFS_FILE_READY'
  | 'OPFS_READ_COMPLETE'
  | 'OPFS_WRITE_ERROR'
  | 'OPFS_READ_ERROR'
  | 'OPFS_ERROR'
  | 'OPFS_RESET_COMPLETE'
  | 'OPFS_CLEANUP_COMPLETE'
  | 'SESSION_MISMATCH'
  | 'WORKER_ERROR'
  | 'TICK';

export interface WorkerResponse {
  type: WorkerResponseType;
  filename?: string;
  sessionId?: number;
  index?: number;
  chunk?: ArrayBuffer;
  isPreload?: boolean;
  requestId?: string;
  error?: string;
  command?: string;
  code?: string;
  skipped?: boolean;
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
  'welcome': { lockChannel: boolean; label: string; chatFrozen?: boolean; slowmodeSeconds?: number; filterEnabled?: boolean };
  'session-full': { message: string };
  'force-close-duplicate': NoPayload;

  // ── Audio Control ────────────────────────────────────────────────
  'volume': { value: number };
  'eq-update': { band: number; value: number };
  'eq-reset': NoPayload;
  'preamp': { value: number };
  'reverb': { value: number };
  'reverb-type': { value: string };
  'reverb-decay': { value: number };
  'reverb-predelay': { value: number };
  'reverb-lowcut': { value: number };
  'reverb-highcut': { value: number };
  'stereo-width': { value: number };
  'vbass': { value: number };

  // ── Playback ─────────────────────────────────────────────────────
  'play': { time: number; index: number; name?: string | null; state?: AppStateValue; timestamp?: number; hostPlayAt?: number };
  'pause': { time: number; index?: number; state?: AppStateValue; timestamp?: number; endOfPlaylist?: boolean };
  'play-preloaded': { index: number; name: string; mime?: string };
  'file-prepare': { name: string; index: number; sessionId: number; mime: string; size?: number; autoPlayDelayMs?: number };
  // ── Playlist ─────────────────────────────────────────────────────
  'playlist-update': { list: Array<Record<string, unknown>>; currentTrackIndex?: number; index?: number };
  'repeat-mode': { value: number };
  'shuffle-mode': { value: boolean };

  // ── File Transfer ────────────────────────────────────────────────
  'file-start': { name: string; mime?: string; total?: number; size?: number; index?: number; sessionId: number };
  'file-chunk': { chunk: Uint8Array | ArrayBuffer; index: number; sessionId: number; total?: number; name?: string; size?: number; mime?: string };
  'file-end': { name: string; mime: string; sessionId: number };
  'file-wait': { message: string };
  'file-resume': { name: string; mime?: string; total: number; size: number; startChunk: number; sessionId: number; index?: number };

  // ── Preload ──────────────────────────────────────────────────────
  'preload-start': { name: string; mime?: string; total: number; size: number; index: number; sessionId: number; skipped?: boolean };
  'preload-chunk': { chunk: Uint8Array; index: number; sessionId: number };
  'preload-end': { name: string; index: number; sessionId: number };
  'preload-ack': { index: number };

  // 'sync-response', 'get-sync-time', 'global-resync-request' removed — dead code
  // 'heartbeat', 'heartbeat-ack', 'ping-latency', 'pong-latency' removed — replaced by sync-ping/pong

  // ── Network / Relay ──────────────────────────────────────────────
  'device-list-update': { list: Array<{ id: string | null; label: string; status: string; isHost: boolean; isOp?: boolean; connectionType?: string; joinOrder?: number }> };
  'assign-data-source': { targetId?: string | null };
  'data-relay': NoPayload;
  'kick-device': { reason?: string };
  'relay-downstream-lost': { lostPeerId: string };
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
  'request-data-recovery': { nextChunk: number; fileName: string; index: number; sessionId?: number };
  'request-youtube-play': NoPayload;
  'request-youtube-pause': NoPayload;
  'request-youtube-toggle': NoPayload;
  'request-youtube-sub-seek': { subIdx: number; playlistIdx?: number };
  'request-youtube-playlist-info': { playlistId: string };

  // ── YouTube ──────────────────────────────────────────────────────
  'youtube-play': { videoId?: string | null; playlistId?: string | string[] | null; name?: string | null; index: number; autoplay: boolean; subIndex?: number };
  'youtube-stop': NoPayload;
  'youtube-state': { state: number; time: number; subIndex?: number; videoId?: string; hostPlayAt?: number };
  'youtube-sync': { time: number; state: number; subIndex?: number; videoId?: string };
  'youtube-sub-title-update': { playlistId: string; subIdx: number; title: string };
  'youtube-playlist-info': { playlistId: string; ids: string[]; titles: string[] };

  // ── Shared Clock ────────────────────────────────────────────────
  'sync-ping': { pingId: number; guestTime: number };
  'sync-pong': { pingId: number; hostTime: number; position: number; appState: string; trackIndex: number };

  // ── Chat ─────────────────────────────────────────────────────────
  'chat': { senderId: string; sender: string; senderLabel: string; senderRole: string; text: string; ts: number; joinOrder?: number };

  // ── Rename ──────────────────────────────────────────────────────
  'request-rename': { newLabel: string };

  // ── Chat Commands ─────────────────────────────────────────────
  'chat-mute': { targetId: string; targetLabel: string };
  'chat-unmute': { targetId: string; targetLabel: string };
  'chat-freeze': NoPayload;
  'chat-unfreeze': NoPayload;
  'chat-clear': NoPayload;
  'chat-whisper': { senderId: string; senderLabel: string; text: string; ts: number; joinOrder: number };
  'chat-notice': { senderLabel: string; text: string; ts: number };
  'chat-slowmode': { seconds: number };
  'chat-filter': { on: boolean };
  'chat-system': { text: string };
  'request-chat-command': { command: string; args: string[] };

  // ── System Audio Sharing ──────────────────────────────────────
  'system-audio-start': NoPayload;
  'system-audio-stop': NoPayload;
}

/** Full protocol message = { type: T } & payload */
export type ProtocolMsg<T extends MsgType> = { type: T } & ProtocolMap[T];

/** Union of all possible protocol messages */
export type AnyProtocolMsg = { [T in MsgType]: ProtocolMsg<T> }[MsgType];

// ─── State Tree ──────────────────────────────────────────────────────

export interface StateTree {
  appState: AppStateValue;
  setup: { sessionStarted: boolean };
  player: { startedAt: number; pausedAt: number; isSeeking: boolean; isFirstTrackLoad: boolean; currentTrackMeta: Partial<PlaylistItem> | null };
  transfer: {
    state: TransferStateValue;
    receivedCount: number;
    meta: Partial<FileMeta> | null;
    localSessionId: number;
    currentSessionId: number;
    activeBroadcastSession: number | null;
    lastReceivedCountSnapshot: number;
    skipIncomingFile: boolean;
    waitingForPreload: boolean;
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
    detectedBPM: number;
  };
  sync: { localOffset: number; lastLatencyMs: number; latencyHistory: number[] };
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
    peerSlots: (string | null)[];
    peerSlotByPeerId: Map<string, number>;
    activeHostConnByPeerId: Map<string, DataConnection>;
    connectionType: 'local' | 'remote' | 'unknown';
    mutedPeers: Set<string>;
    chatFrozen: boolean;
    slowmodeSeconds: number;
    filterEnabled: boolean;
  };
  relay: { upstreamDataConn: DataConnection | null; downstreamDataPeers: DataConnection[] };
  playlist: { items: PlaylistItem[]; currentTrackIndex: number; repeatMode: number; isShuffle: boolean };
  files: { currentFileBlob: Blob | null; currentFileOpfs: { name: string | null } };
  youtube: {
    currentSubIndex: number;
    subItemsMap: Record<string, { ids: string[]; titles: string[] }>;
    /**
     * Guest-only: estimated `playVideo()` call → audible output latency (ms).
     * Used by the rendezvous sync (guest-initiated, host-nondisruptive) to
     * fire playVideo() slightly ahead of the target rendezvous instant so
     * the audible start aligns with the host's playback position.
     *
     * Self-calibrating: after each rendezvous, drift is measured vs.
     * extrapolated host position and this value is nudged via EMA.
     * Clamped to [0, 600]ms. Default 0ms — first rendezvous fires AT the
     * target instant with no arbitrary pre-pull, and the calibrator learns
     * the true per-device latency from the observed drift.
     */
    guestPlayLatency: number;
  };
  recovery: { pending: boolean; retryCount: number; pendingFileName: string; pendingFileIndex: number | undefined };
  systemAudio: { isSharing: boolean; isReceiving: boolean; hostMuteLocal: boolean };
}

// ─── State Path Utilities ────────────────────────────────────────────

type IsLeaf<T> = T extends
  | string | number | boolean | null | undefined
  | Array<any> | Map<any, any> | Set<any>
  | Blob | DataConnection | ReturnType<typeof setTimeout>
  ? true : false;

/** Union of all valid dot-separated state paths. */
export type StatePath = {
  [K in keyof StateTree & string]: IsLeaf<StateTree[K]> extends true
    ? K
    : `${K}.${keyof StateTree[K] & string}`
}[keyof StateTree & string];

/** Maps a StatePath to its value type. */
export type StatePathValue<P extends string> =
  P extends keyof StateTree
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
export type ShallowImmutable<T> =
  T extends Blob | DataConnection ? T :            // Opaque externals pass through
  T extends Map<infer K, infer V> ? ReadonlyMap<K, V> :
  T extends Set<infer U> ? ReadonlySet<U> :
  T extends Array<infer U> ? ReadonlyArray<U> :
  T extends object ? Readonly<T> :
  T;

// ─── State Change Events (auto-derived from StatePath) ────────────
// Mapped type: generates 'state:appState', 'state:audio.masterVolume', etc.
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

  // ── Beat Detection ──────────────────────────────────────────────
  'beat:detected': [bpm: number, phase: number];
  'beat:pulse': [bpm: number, beatIndex: number];

  // ── Player ────────────────────────────────────────────────────────
  'player:ended': [];
  'player:toggle-play': [];
  'player:stop-all-media': [];
  'playback:replay-current': [delayMs?: number];
  'player:sync-video-volume': [volume: number];
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
  'ui:time-update': [currentFormatted: string, totalFormatted: string, currentTime: number, duration: number];
  'ui:switch-tab': [tabId: string];
  'ui:settings-tab-opened': [];
  'ui:visualizer-check': [];
  'ui:close-chat-drawer': [];
  'ui:toggle-chat-drawer': [];
  'chat:system-message': [text: string];
  'chat:notice-message': [sender: string, text: string];

  // ── YouTube ───────────────────────────────────────────────────────
  'youtube:sync-loading': [loading: boolean];
  'youtube:load': [videoId: string | null, playlistId: string | null, autoplay?: boolean, subIndex?: number];
  'youtube:toggle-play': [];
  'youtube:auto-play': [];
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
  'youtube:preview': [url: string];
  'youtube:load-from-input': [];
  'youtube:load-from-chat': [url: string];
  'youtube:stop-mode': [];
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
  'chat:muted-state-changed': [isMuted: boolean];
  'chat:clear-all': [];

  // ── Playlist ────────────────────────────────────────────────────
  'playlist:remove-track': [index: number];

  // ── Storage / OPFS ────────────────────────────────────────────────
  'storage:transfer-progress': [progress: number, total: number];
  'storage:preload-ready': [index: number];
  'storage:request-recovery': [];
  'storage:clear-previous-track': [context: string];
  'storage:use-preloaded': [index: number, name: string];
  'storage:preload-file-ready': [filename: string, sessionId: number];
  'opfs:file-ready': [filename: string, sessionId: number, isPreload: boolean];
  'opfs:read-complete': [data: unknown];
  'opfs:read-error': [data: unknown];
  'opfs:error': [error: string, filename: string];
  'opfs:write-error': [data: unknown];
  'opfs:session-mismatch': [data: unknown];
  'opfs:cleanup-complete': [filename: string];

  // ── Blob ──────────────────────────────────────────────────────────
  'blob:revoke-all': [];

  // ── Sync ──────────────────────────────────────────────────────────
  'sync:display-update': [];
  'sync:nudge': [ms: number];
  'sync:auto-sync': [];
  'sync:arm-initial': [];
  'sync:close-manual': [];
  // 'sync:get-position', 'sync:response' removed — no emitter exists
  'sync:latency-update': [ms: number];

  // ── Relay / Orchestrator ─────────────────────────────────────────
  'relay:incoming-connection': [conn: DataConnection];
  'relay:serve-current-file': [conn: DataConnection, msg: unknown];
  'relay:serve-recovery': [conn: DataConnection, msg: unknown];
  'orchestrator:peer-type-detected': [peerId: string];
  'orchestrator:peer-evaluated': [peerId: string];

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

  // ── Visualizer ────────────────────────────────────────────────────
  'visualizer:start': [];
  'visualizer:set-type': [mode: 'circular' | 'spectrum'];

  // ── Worker ──────────────────────────────────────────────────────────
  'worker:sync-command': [payload: { command: string; id: string; interval?: number }];
  'worker:timer-tick': [id: string];

}
