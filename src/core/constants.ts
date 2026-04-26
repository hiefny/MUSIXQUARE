/**
 * MUSIXQUARE — Constants
 */

// ─── App State ─────────────────────────────────────────────────────
export const APP_STATE = {
  IDLE: 'IDLE',
  PAUSED: 'PAUSED',
  PLAYING_AUDIO: 'PLAYING_AUDIO',
  PLAYING_YOUTUBE: 'PLAYING_YOUTUBE',
  PLAYING_SYSTEM_AUDIO: 'PLAYING_SYSTEM_AUDIO',
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

// ─── Playback Lifecycle State ──────────────────────────────────────
// Guest-side track lifecycle. Orthogonal to APP_STATE (mode); this describes
// WHAT PHASE within the local-file/video mode we're in. For YouTube and
// system-audio modes this stays at IDLE (they have their own lifecycle paths).
//
// See .workshop/design/playback-state-machine.md for the full transition
// table and migration plan. Every transition goes through
// src/player/lifecycle.ts::transition(); direct setState calls to
// playback.lifecycle outside that helper are forbidden.
export const PLAYBACK_STATE = {
  IDLE: 'IDLE', // nothing loaded, no operation pending
  DOWNLOADING: 'DOWNLOADING', // main transfer (FILE_PREPARE → FILE_START → chunks)
  AWAITING_PRELOAD: 'AWAITING_PRELOAD', // PLAY_PRELOADED received, preload blob not yet assembled
  DECODING: 'DECODING', // blob in hand, running decodeAudioData
  READY: 'READY', // decoded buffer loaded, waiting for PLAY
  PLAYING: 'PLAYING', // actively producing audio
  PAUSED: 'PAUSED', // decoded buffer present, not advancing
  FAILED: 'FAILED', // decode timeout / unsupported / corrupt — awaiting host advance
} as const;

export type PlaybackStateValue = (typeof PLAYBACK_STATE)[keyof typeof PLAYBACK_STATE];

/** How a track entered the pipeline. Attribute of the active load, not a state. */
export const LOAD_SOURCE = {
  FRESH: 'fresh', // full main-transfer download (FILE_PREPARE → FILE_END)
  PRELOAD_PROMOTED: 'preload-promoted', // started as preload, promoted to current
  RECOVERY_RESUME: 'recovery-resume', // partial prior download, resumed via FILE_RESUME
} as const;

export type LoadSourceValue = (typeof LOAD_SOURCE)[keyof typeof LOAD_SOURCE];

// ─── File Transfer ─────────────────────────────────────────────────
export const CHUNK_SIZE = 16384; // 16KB per chunk
export const WATCHDOG_TIMEOUT = 12000; // 12s chunk watchdog

export const MAX_RECOVERY_RETRIES = 3;
export const RECOVERY_BACKOFF = [2000, 5000, 10000] as const;

// ─── Timing Constants (ms) ─────────────────────────────────────────
export const DELAY = {
  TICK: 10, // Micro-yield for main thread breathing
  BACKPRESSURE: 50, // Backpressure polling interval
  RETRY: 200, // Retry / reconnection pause
  BLOB_REVOCATION: 10000, // BlobURL revocation safety delay
} as const;

// ─── Network ───────────────────────────────────────────────────────
export const DEFAULT_MAX_GUEST_SLOTS = 3;
export const MIN_GUEST_SLOTS = 1;
export const MAX_GUEST_SLOTS_LIMIT = 32;
/** Show "this mode is recommended for small rooms" dialog only when the host
 *  has opted into a larger room (slot cap ≥ this). Users sticking to the
 *  default 3 won't see the warning for file-share / system-audio entry. */
export const WARN_WHEN_MAX_SLOTS_AT_LEAST = 6;
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
  // GET_SYNC_TIME removed — dead code (no sender, no handler)
  // GLOBAL_RESYNC_REQUEST removed — dead code (no sender, no handler)
  PAUSE: 'pause',
  PLAY: 'play',
  PLAYLIST_UPDATE: 'playlist-update',
  PLAY_PRELOADED: 'play-preloaded',
  PREAMP: 'preamp',
  PRELOAD_ACK: 'preload-ack',
  PRELOAD_CHUNK: 'preload-chunk',
  PRELOAD_END: 'preload-end',
  PRELOAD_START: 'preload-start',
  REPEAT_MODE: 'repeat-mode',
  REQUEST_CURRENT_FILE: 'request-current-file',
  REQUEST_DATA_RECOVERY: 'request-data-recovery',
  REQUEST_EQ_RESET: 'request-eq-reset',
  // REQUEST_REVERB_RESET removed — dead code (no sender, no handler)
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
  REQUEST_YOUTUBE_TOGGLE: 'request-youtube-toggle',
  REQUEST_YOUTUBE_PLAYLIST_INFO: 'request-youtube-playlist-info',
  REQUEST_RENAME: 'request-rename',
  REQUEST_YOUTUBE_SUB_SEEK: 'request-youtube-sub-seek',
  REVERB: 'reverb',
  REVERB_DECAY: 'reverb-decay',
  REVERB_HIGHCUT: 'reverb-highcut',
  REVERB_LOWCUT: 'reverb-lowcut',
  REVERB_PREDELAY: 'reverb-predelay',
  REVERB_TYPE: 'reverb-type',
  SHUFFLE_MODE: 'shuffle-mode',
  // STATUS_SYNC removed — dead code (no sender, no handler)
  STEREO_WIDTH: 'stereo-width',
  // SYNC_RESPONSE removed — dead code (no sender, no handler)
  // FORCE_SYNC_PLAY removed — dead code (no sender, no handler)
  OPERATOR_GRANT: 'operator-grant',
  OPERATOR_REVOKE: 'operator-revoke',
  VBASS: 'vbass',
  VOLUME: 'volume',
  WELCOME: 'welcome',
  SESSION_FULL: 'session-full',
  YOUTUBE_PLAY: 'youtube-play',
  YOUTUBE_PLAYLIST_INFO: 'youtube-playlist-info',
  YOUTUBE_STATE: 'youtube-state',
  YOUTUBE_SUB_TITLE_UPDATE: 'youtube-sub-title-update',
  YOUTUBE_STOP: 'youtube-stop',
  YOUTUBE_SYNC: 'youtube-sync',
  // ── Shared Clock ───────────────────────────────────────────────
  SYNC_PING: 'sync-ping',
  SYNC_PONG: 'sync-pong',

  // SYS_TOAST removed — dead code (no sender, no handler)
  KICK_DEVICE: 'kick-device',
  RELAY_DOWNSTREAM_LOST: 'relay-downstream-lost',

  // ── System Audio Sharing ────────────────────────────────────────
  SYSTEM_AUDIO_START: 'system-audio-start',
  SYSTEM_AUDIO_STOP: 'system-audio-stop',

  // ── Chat Commands ──────────────────────────────────────────────
  CHAT_MUTE: 'chat-mute',
  CHAT_UNMUTE: 'chat-unmute',
  CHAT_FREEZE: 'chat-freeze',
  CHAT_UNFREEZE: 'chat-unfreeze',
  CHAT_CLEAR: 'chat-clear',
  CHAT_WHISPER: 'chat-whisper',
  CHAT_NOTICE: 'chat-notice',
  CHAT_SLOWMODE: 'chat-slowmode',
  CHAT_FILTER: 'chat-filter',
  CHAT_SYSTEM: 'chat-system',
  REQUEST_CHAT_COMMAND: 'request-chat-command',
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

// ─── Relayable Message Types ─────────────────────────────────────────
// 3.0: `satisfies` ensures every entry is a valid MsgType at compile time.
// Adding a typo or non-existent MSG key → TS error.
export const RELAYABLE_MSG_TYPES = [
  MSG.PLAY,
  MSG.PAUSE,
  MSG.VOLUME,
  MSG.EQ_UPDATE,
  MSG.PREAMP,
  MSG.EQ_RESET,
  MSG.REVERB,
  MSG.REVERB_TYPE,
  MSG.REVERB_DECAY,
  MSG.REVERB_PREDELAY,
  MSG.REVERB_LOWCUT,
  MSG.REVERB_HIGHCUT,
  MSG.STEREO_WIDTH,
  MSG.VBASS,
  MSG.REPEAT_MODE,
  MSG.SHUFFLE_MODE,
  MSG.YOUTUBE_PLAY,
  MSG.YOUTUBE_SYNC,
  MSG.YOUTUBE_STATE,
  MSG.YOUTUBE_STOP,
  MSG.YOUTUBE_SUB_TITLE_UPDATE,
  MSG.YOUTUBE_PLAYLIST_INFO,
  MSG.CHAT,
  MSG.CHAT_MUTE,
  MSG.CHAT_UNMUTE,
  MSG.CHAT_FREEZE,
  MSG.CHAT_UNFREEZE,
  MSG.CHAT_CLEAR,
  MSG.CHAT_NOTICE,
  MSG.CHAT_SLOWMODE,
  MSG.CHAT_FILTER,
  MSG.CHAT_SYSTEM,
  MSG.PLAYLIST_UPDATE,
  MSG.PLAY_PRELOADED,
  MSG.DEVICE_LIST_UPDATE,
  MSG.FILE_PREPARE,
  MSG.SYSTEM_AUDIO_START,
  MSG.SYSTEM_AUDIO_STOP,
] as const satisfies readonly MsgType[];

// ─── Audio ──────────────────────────────────────────────────────────
export const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000] as const;

// ─── Rename Validation ──────────────────────────────────────────────
// Names the host may reclaim (own identity across locales).
export const HOST_SELF_NAMES = ['host', '방장', '호스트'] as const;

export const RESERVED_NAMES = [
  ...HOST_SELF_NAMES,
  'guest',
  'admin',
  'operator',
  'op',
  'mod',
  'moderator',
  'system',
  'server',
  'bot',
  '관리자',
  '운영자',
] as const;

// ─── Misc ──────────────────────────────────────────────────────────
export const DEMO_FILE_NAME = 'demo_track.mp3';
