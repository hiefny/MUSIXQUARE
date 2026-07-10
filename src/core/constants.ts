/**
 * MUSIXQUARE — Constants
 */

export type PlaybackModeValue = 'file' | 'youtube' | 'system-audio' | null;
export type PlaybackActivityValue = 'idle' | 'paused' | 'playing' | 'pending';

// ─── Transfer State ────────────────────────────────────────────────
export const TRANSFER_STATE = {
  IDLE: 'IDLE',
  RECEIVING: 'RECEIVING',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
} as const;

export type TransferStateValue = (typeof TRANSFER_STATE)[keyof typeof TRANSFER_STATE];

// ─── Playback Lifecycle State ──────────────────────────────────────
// Guest-side track lifecycle. Orthogonal to playback mode/activity; this describes
// WHAT PHASE within the local-file/video mode we're in. For YouTube and
// system-audio modes this stays at IDLE (they have their own lifecycle paths).
//
// See docs/design/playback-state-machine.md for the full transition
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
export const CHUNK_SIZE = 64 * 1024; // 64KB per chunk

// Remote R2 payload limits. Protocol v4 uploads one independently authenticated
// 8 MiB record per R2 multipart part, so the browser never creates a second
// whole-file copy. Five GiB is a product guardrail rather than a Worker body or
// R2 single-PUT limit.
const REMOTE_SHARE_MIB = 1024 * 1024;
const REMOTE_SHARE_GIB = 1024 * REMOTE_SHARE_MIB;
export const REMOTE_SHARE_CRYPTO_CHUNK_BYTES = 8 * REMOTE_SHARE_MIB;
export const REMOTE_SHARE_GCM_TAG_BYTES = 16;
export const REMOTE_SHARE_MAX_PLAINTEXT_BYTES = 5 * REMOTE_SHARE_GIB;
const REMOTE_SHARE_MAX_CHUNK_COUNT = Math.ceil(
  REMOTE_SHARE_MAX_PLAINTEXT_BYTES / REMOTE_SHARE_CRYPTO_CHUNK_BYTES,
);
export const REMOTE_SHARE_MAX_ENCRYPTED_BYTES =
  REMOTE_SHARE_MAX_PLAINTEXT_BYTES + REMOTE_SHARE_MAX_CHUNK_COUNT * REMOTE_SHARE_GCM_TAG_BYTES;
/** Above this size every guest, including LAN guests, uses R2 range streaming. */
export const REMOTE_SHARE_STREAM_THRESHOLD_BYTES = 32 * REMOTE_SHARE_MIB;
/** Rolling whole-file AES-GCM compatibility is intentionally memory bounded. */
export const REMOTE_SHARE_LEGACY_MAX_PLAINTEXT_BYTES = 64 * REMOTE_SHARE_MIB;
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

/** Manual per-device sync nudge clamp. Large offsets usually mean the
 *  panel is being used in the wrong state, and can fight drift correction. */
export const MANUAL_SYNC_OFFSET_LIMIT_SEC = 3;

// ─── Network ───────────────────────────────────────────────────────
export const DEFAULT_MAX_GUEST_SLOTS = 4;
export const MIN_GUEST_SLOTS = 1;
export const MAX_GUEST_SLOTS_LIMIT = 32;
/** Show "this mode is recommended for small rooms" dialog only when the host
 *  has opted into a larger room (slot cap ≥ this). Users sticking to the
 *  default 3 won't see the warning for file-share / system-audio entry. */
export const WARN_WHEN_MAX_SLOTS_AT_LEAST = 6;
export const PEER_NAME_PREFIX = 'Peer';

// ─── Chat Wire Caps ────────────────────────────────────────────────
// Cross-client WIRE CONTRACT — keep bit-identical across releases (deployed
// clients truncate with these exact values; drift desyncs sender-side vs
// receiver-side truncation). Used by:
//   - chat/protocol.ts   inbound truncation + host fan-out write-back (CHAT-1)
//   - network/sync.ts    OP /notice cap before broadcast, so an OP can't
//                        amplify a 10MB arg to N peers
//   - ui/chat.ts         input clamp / paste-merge clamp
// NOT to be unified with the 4000-char validator caps in network/protocol.ts:
// that gap is intentional defense-in-depth headroom (validator drops garbage
// frames; these cap rendered/relayed payloads).
export const MAX_MSG_LENGTH = 500;
export const MAX_SENDER_LABEL_LENGTH = 30;

// ─── Message Types (P2P Protocol) ──────────────────────────────────
export const MSG = {
  CHAT: 'chat',
  DEVICE_LIST_UPDATE: 'device-list-update',
  EQ_RESET: 'eq-reset',
  EQ_UPDATE: 'eq-update',
  FILE_CHUNK: 'file-chunk',
  FILE_END: 'file-end',
  FILE_PREPARE: 'file-prepare',
  REMOTE_FILE_UNAVAILABLE: 'remote-file-unavailable',
  REMOTE_FILE_SHARE: 'remote-file-share',
  FILE_RESUME: 'file-resume',
  FILE_START: 'file-start',
  FILE_WAIT: 'file-wait',
  FORCE_CLOSE_DUPLICATE: 'force-close-duplicate',
  GUEST_DECODE_FAILED: 'guest-decode-failed',
  DEMO_ENTER: 'demo-enter',
  DEMO_EXIT: 'demo-exit',
  DEMO_PAUSE: 'demo-pause',
  DEMO_PLAY: 'demo-play',
  // GET_SYNC_TIME removed — dead code (no sender, no handler)
  // GLOBAL_RESYNC_REQUEST removed — dead code (no sender, no handler)
  PAUSE: 'pause',
  PLAY: 'play',
  PLAYLIST_UPDATE: 'playlist-update',
  PLAY_PRELOADED: 'play-preloaded',
  PREAMP: 'preamp',
  PRELOAD_ABORT: 'preload-abort',
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
  EXCITER: 'exciter',
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
  // SYNC_REQUEST removed — dead code (host sync button now broadcasts PLAY/PAUSE directly)

  // SYS_TOAST removed — dead code (no sender, no handler)
  KICK_DEVICE: 'kick-device',
  OPERATOR_TOAST: 'operator-toast',

  // ── System Audio Sharing ────────────────────────────────────────
  SYSTEM_AUDIO_START: 'system-audio-start',
  SYSTEM_AUDIO_SFU_READY: 'system-audio-sfu-ready',
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

// ─── Audio ──────────────────────────────────────────────────────────
export const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000] as const;
export const REVERB_DEFAULT_DECAY = 5.0;
export const REVERB_DEFAULT_PREDELAY = 0.1;

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

// Control / zero-width / bidi-override characters stripped from device labels
// BEFORE the reserved/duplicate checks ("HOST"+zero-width-space must not slip
// past as a visually identical impersonation; U+202E must not reorder the
// rendered name). Single source of truth: the host's handleRequestRename
// (network/sync.ts) strips with this exact pattern, and the client-side
// validators (ui/connect.ts, chat/commands.ts) must apply the SAME strip so a
// name that sanitizes into a reserved/duplicate/empty string fails locally
// with feedback instead of being silently rejected by the host (F-2404).
export const DEVICE_LABEL_SANITIZE_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

// ─── Misc ──────────────────────────────────────────────────────────
