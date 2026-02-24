/**
 * MUSIXQUARE 2.0 — Constants
 * Extracted from original app.js lines 1172-1299
 */

// ─── App State ─────────────────────────────────────────────────────
export const APP_STATE = {
  IDLE: 'IDLE',
  PAUSED: 'PAUSED',
  PLAYING_AUDIO: 'PLAYING_AUDIO',
  PLAYING_VIDEO: 'PLAYING_VIDEO',
  PLAYING_YOUTUBE: 'PLAYING_YOUTUBE',
} as const;

export type AppStateValue = (typeof APP_STATE)[keyof typeof APP_STATE];

// ─── Transfer State ────────────────────────────────────────────────
export const TRANSFER_STATE = {
  IDLE: 'IDLE',
  RECEIVING: 'RECEIVING',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
} as const;

export type TransferStateValue = (typeof TRANSFER_STATE)[keyof typeof TRANSFER_STATE];

// ─── File Transfer ─────────────────────────────────────────────────
export const CHUNK_SIZE = 16384; // 16KB per chunk
export const ENDED_CHECK_THROTTLE = 500; // ms
export const WATCHDOG_TIMEOUT = 12000; // 12s chunk watchdog

export const MAX_RECOVERY_RETRIES = 3;
export const RECOVERY_BACKOFF = [2000, 5000, 10000] as const;

// ─── Timing Constants (ms) ─────────────────────────────────────────
export const DELAY = {
  TICK: 10,               // Micro-yield for main thread breathing
  BACKPRESSURE: 50,       // Backpressure polling interval
  UI_REFRESH: 100,        // UI state refresh / short debounce
  RETRY: 200,             // Retry / reconnection pause
  TRANSITION: 300,        // UI transition / animation settling
  DEBOUNCE: 500,          // Standard debounce / throttle
  CONNECTION_CHECK: 500,  // Peer connection readiness check
  BLOB_REVOCATION: 10000, // BlobURL revocation safety delay
  JOIN_TIMEOUT: 10000,    // Max wait for peer.open
  RECOVERY_COOLDOWN: 5000,// Rate-limit recovery requests
} as const;

// ─── Network ───────────────────────────────────────────────────────
export const MAX_GUEST_SLOTS = 3;
export const MAX_DIRECT_DATA_PEERS = 2;
export const PEER_NAME_PREFIX = 'Peer';

// ─── Message Types (P2P Protocol) ──────────────────────────────────
export const MSG = {
  ASSIGN_DATA_SOURCE: 'assign-data-source',
  CHAT: 'chat',
  DATA_RELAY: 'data-relay',
  DEVICE_LIST_UPDATE: 'device-list-update',
  EQ_RESET: 'eq-reset',
  EQ_UPDATE: 'eq-update',
  FILE_CHUNK: 'file-chunk',
  FILE_END: 'file-end',
  FILE_PREPARE: 'file-prepare',
  FILE_RESUME: 'file-resume',
  FILE_START: 'file-start',
  FILE_WAIT: 'file-wait',
  FORCE_CLOSE_DUPLICATE: 'force-close-duplicate',
  GET_SYNC_TIME: 'get-sync-time',
  GLOBAL_RESYNC_REQUEST: 'global-resync-request',
  HEARTBEAT: 'heartbeat',
  HEARTBEAT_ACK: 'heartbeat-ack',
  PAUSE: 'pause',
  PING_LATENCY: 'ping-latency',
  PLAY: 'play',
  PLAYLIST: 'playlist',
  PLAYLIST_UPDATE: 'playlist-update',
  PLAY_PRELOADED: 'play-preloaded',
  PONG_LATENCY: 'pong-latency',
  PREAMP: 'preamp',
  PRELOAD_ACK: 'preload-ack',
  PRELOAD_CHUNK: 'preload-chunk',
  PRELOAD_END: 'preload-end',
  PRELOAD_START: 'preload-start',
  REPEAT_MODE: 'repeat-mode',
  REQUEST_CURRENT_FILE: 'request-current-file',
  REQUEST_DATA_RECOVERY: 'request-data-recovery',
  REQUEST_EQ_RESET: 'request-eq-reset',
  REQUEST_REVERB_RESET: 'request-reverb-reset',
  REQUEST_NEXT_TRACK: 'request-next-track',
  REQUEST_PAUSE: 'request-pause',
  REQUEST_PLAY: 'request-play',
  REQUEST_PREV_TRACK: 'request-prev-track',
  REQUEST_SEEK: 'request-seek',
  REQUEST_SETTING: 'request-setting',
  REQUEST_SKIP_TIME: 'request-skip-time',
  REQUEST_TRACK_CHANGE: 'request-track-change',
  REQUEST_YOUTUBE_PAUSE: 'request-youtube-pause',
  REQUEST_YOUTUBE_PLAY: 'request-youtube-play',
  REQUEST_YOUTUBE_PLAYLIST_INFO: 'request-youtube-playlist-info',
  REQUEST_YOUTUBE_SUB_SEEK: 'request-youtube-sub-seek',
  REVERB: 'reverb',
  REVERB_DECAY: 'reverb-decay',
  REVERB_HIGHCUT: 'reverb-highcut',
  REVERB_LOWCUT: 'reverb-lowcut',
  REVERB_PREDELAY: 'reverb-predelay',
  REVERB_TYPE: 'reverb-type',
  SHUFFLE_MODE: 'shuffle-mode',
  STATUS_SYNC: 'status-sync',
  STEREO_WIDTH: 'stereo-width',
  SYNC_RESPONSE: 'sync-response',
  FORCE_SYNC_PLAY: 'force-sync-play',
  OPERATOR_GRANT: 'operator-grant',
  OPERATOR_REVOKE: 'operator-revoke',
  VBASS: 'vbass',
  VOLUME: 'volume',
  WELCOME: 'welcome',
  SESSION_START: 'session-start',
  SESSION_FULL: 'session-full',
  YOUTUBE_PLAY: 'youtube-play',
  YOUTUBE_PLAYLIST_INFO: 'youtube-playlist-info',
  YOUTUBE_STATE: 'youtube-state',
  YOUTUBE_SUB_TITLE_UPDATE: 'youtube-sub-title-update',
  YOUTUBE_STOP: 'youtube-stop',
  YOUTUBE_SYNC: 'youtube-sync',
  SYS_TOAST: 'sys-toast',
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

// ─── Audio ──────────────────────────────────────────────────────────
export const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000] as const;
export const DEFAULT_SUB_FREQ = 120;
export const DEFAULT_REVERB_DECAY = 5.0;
export const DEFAULT_REVERB_PREDELAY = 0.1;

// ─── Relay ──────────────────────────────────────────────────────────
export const MAX_PEER_RELAY_QUEUE = 500;
export const MAX_EARLY_PRELOAD_CHUNKS = 128;

// ─── Misc ──────────────────────────────────────────────────────────
export const DEMO_FILE_NAME = 'demo_track.mp3';
export const DEMO_TITLE = 'Sean Pitaro - Passport (NCS Release)';

/** Video file extensions */
export const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov'] as const;
