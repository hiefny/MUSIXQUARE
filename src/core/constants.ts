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
// WHAT PHASE within local-file mode we're in. For YouTube and
// system-audio modes this stays at IDLE (they have their own lifecycle paths).
//
// Current invariants are documented in
// docs/design/playback-concurrency-invariants.md. Every transition goes through
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
  FAILED: 'FAILED', // native allocation/decode failure — awaiting host advance
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
export const CHUNK_SIZE = 64 * 1024; // 64 KiB per chunk
export const WATCHDOG_TIMEOUT = 12000; // 12s chunk watchdog

/** Remote-share wire/storage contract. AES-GCM appends one 128-bit tag to the
 * whole-file plaintext; the Worker and descriptor validator enforce the same
 * exact relationship. */
export const REMOTE_SHARE_MAX_BYTES = 200 * 1024 * 1024;
export const REMOTE_SHARE_AES_GCM_TAG_BYTES = 16;
export const REMOTE_SHARE_MAX_ENCRYPTED_BYTES =
  REMOTE_SHARE_MAX_BYTES + REMOTE_SHARE_AES_GCM_TAG_BYTES;

export const MAX_RECOVERY_RETRIES = 3;
export const RECOVERY_BACKOFF = [2000, 5000, 10000] as const;

// ─── Timing Constants (ms) ─────────────────────────────────────────
export const DELAY = {
  TICK: 10, // Micro-yield for main thread breathing
  BACKPRESSURE: 50, // Backpressure polling interval
  RETRY: 200, // Retry / reconnection pause
} as const;

/** Manual per-device sync nudge clamp. Large offsets usually mean the
 *  panel is being used in the wrong state, and can fight drift correction. */
export const MANUAL_SYNC_OFFSET_LIMIT_SEC = 3;

// ─── Network ───────────────────────────────────────────────────────
/** Absolute room capacity. The host occupies device 0; guests use slots 1–99. */
const MAX_CONNECTED_DEVICES = 100;
export const MAX_GUEST_SLOTS = MAX_CONNECTED_DEVICES - 1;
/** System-audio sharing is intentionally limited to a small room because
 * every listener adds a live audio-delivery cost. The host counts as one. */
export const MAX_SYSTEM_AUDIO_DEVICES = 4;
/** Hard ceiling for one host-side system-audio sharing session. */
export const SYSTEM_AUDIO_SHARE_LIMIT_MS = 2 * 60 * 60 * 1000;
/** Show the local-file warning only once the ninth connected guest requires
 *  the bounded R2 fanout path. The fixed room ceiling must never make the
 *  dialog appear in an otherwise direct-transfer room. */
export const WARN_WHEN_CONNECTED_LOCAL_GUESTS_AT_LEAST = 9;
export const PEER_NAME_PREFIX = 'Peer';

// ─── Chat Wire Caps ────────────────────────────────────────────────
// Cross-client WIRE CONTRACT — keep bit-identical across releases (deployed
// clients truncate with these exact values; drift desyncs sender-side vs
// receiver-side truncation). Used by:
//   - chat/protocol.ts   inbound truncation + host fan-out write-back
//   - network/sync.ts    OP /notice cap before broadcast, so an OP can't
//                        amplify a 10MB arg to N peers
//   - ui/chat.ts         input clamp / paste-merge clamp
// NOT to be unified with the 4000-char validator caps in network/protocol.ts:
// that gap is intentional defense-in-depth headroom (validator drops garbage
// frames; these cap rendered/relayed payloads).
export const MAX_MSG_LENGTH = 500;
export const MAX_SENDER_LABEL_LENGTH = 30;
/** Keep one-version rolling-deploy compatibility with the former 24-hour BOT
 * window. The live room now returns at most one hour, while cached clients and
 * a briefly older Worker can still exchange the previous bounded response. */
export const BOT_RATE_LIMIT_MAX_RETRY_SECONDS = 24 * 60 * 60;

// ─── Message Types (P2P Protocol) ──────────────────────────────────
export const MSG = {
  CHAT: 'chat',
  DEVICE_LIST_UPDATE: 'device-list-update',
  EQ_RESET: 'eq-reset',
  EQ_UPDATE: 'eq-update',
  FILE_CHUNK: 'file-chunk',
  FILE_END: 'file-end',
  FILE_PREPARE: 'file-prepare',
  FILE_R2_CAPABILITY: 'file-r2-capability',
  REMOTE_FILE_UNAVAILABLE: 'remote-file-unavailable',
  REMOTE_FILE_SHARE: 'remote-file-share',
  FILE_RESUME: 'file-resume',
  FILE_START: 'file-start',
  FILE_WAIT: 'file-wait',
  OPERATOR_FILE_UPLOAD_ABORT: 'operator-file-upload-abort',
  OPERATOR_FILE_UPLOAD_BATCH_START: 'operator-file-upload-batch-start',
  OPERATOR_FILE_UPLOAD_BATCH_COMPLETE: 'operator-file-upload-batch-complete',
  OPERATOR_FILE_UPLOAD_CHUNK: 'operator-file-upload-chunk',
  OPERATOR_FILE_UPLOAD_FINISH: 'operator-file-upload-finish',
  OPERATOR_FILE_UPLOAD_START: 'operator-file-upload-start',
  OPERATOR_FILE_UPLOAD_STATUS: 'operator-file-upload-status',
  FORCE_CLOSE_DUPLICATE: 'force-close-duplicate',
  GUEST_DECODE_FAILED: 'guest-decode-failed',
  DEMO_ENTER: 'demo-enter',
  DEMO_EXIT: 'demo-exit',
  DEMO_PAUSE: 'demo-pause',
  DEMO_PLAY: 'demo-play',
  PAUSE: 'pause',
  PLAY: 'play',
  PLAYLIST_UPDATE: 'playlist-update',
  PRO_FILE_PRELOAD: 'pro-file-preload',
  PRO_ROOM_INVALIDATED: 'pro-room-invalidated',
  PRO_SYSTEM_AUDIO_HINT: 'pro-system-audio-hint',
  PRO_SYSTEM_AUDIO_STATE: 'pro-system-audio-state',
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
  REQUEST_KICK_DEVICE: 'request-kick-device',
  REQUEST_NEXT_TRACK: 'request-next-track',
  REQUEST_PAUSE: 'request-pause',
  REQUEST_PLAYLIST_ADD_YOUTUBE: 'request-playlist-add-youtube',
  REQUEST_PLAYLIST_REMOVE: 'request-playlist-remove',
  REQUEST_PLAYLIST_REORDER: 'request-playlist-reorder',
  OPERATOR_QUEUE_MUTATION_RESULT: 'operator-queue-mutation-result',
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
  REQUEST_YOUTUBE_SUB_SEEK: 'request-youtube-sub-seek',
  REVERB: 'reverb',
  REVERB_DECAY: 'reverb-decay',
  REVERB_HIGHCUT: 'reverb-highcut',
  REVERB_LOWCUT: 'reverb-lowcut',
  REVERB_PREDELAY: 'reverb-predelay',
  REVERB_TYPE: 'reverb-type',
  SHUFFLE_MODE: 'shuffle-mode',
  STEREO_WIDTH: 'stereo-width',
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
  YOUTUBE_ZERO_START_ABORT: 'youtube-zero-start-abort',
  YOUTUBE_ZERO_START_ARMED: 'youtube-zero-start-armed',
  YOUTUBE_ZERO_START_CAPABILITY: 'youtube-zero-start-capability',
  YOUTUBE_ZERO_START_COMMIT: 'youtube-zero-start-commit',
  YOUTUBE_ZERO_START_PREPARE: 'youtube-zero-start-prepare',
  YOUTUBE_ZERO_START_TIMELINE: 'youtube-zero-start-timeline',
  // ── Shared Clock ───────────────────────────────────────────────
  SYNC_PING: 'sync-ping',
  SYNC_PONG: 'sync-pong',
  KICK_DEVICE: 'kick-device',
  OPERATOR_TOAST: 'operator-toast',

  // ── System Audio Sharing ────────────────────────────────────────
  SYSTEM_AUDIO_START: 'system-audio-start',
  SYSTEM_AUDIO_SFU_CAPABILITY: 'system-audio-sfu-capability',
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
  CHAT_BOT_RESULT: 'chat-bot-result',
  REQUEST_CHAT_COMMAND: 'request-chat-command',
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

// ─── Audio ──────────────────────────────────────────────────────────
export const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000] as const;
export const REVERB_DEFAULT_DECAY = 5.0;
export const REVERB_DEFAULT_PREDELAY = 0.1;

// ─── Account Nickname Validation ───────────────────────────────────────
// Names the host may reclaim (own identity across locales).
const HOST_SELF_NAMES = ['host', '방장', '호스트'] as const;

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

// PRO room default identities are allocated by the server. Reserve the whole
// visible namespace so account nicknames cannot impersonate a Peer N label.
export const PRO_GENERATED_PEER_NAME_RE = /^peer(?: \d+)?$/i;

// Control / zero-width / bidi-override characters stripped from account
// nicknames before reserved-name checks ("HOST"+zero-width-space must not slip
// past as a visually identical impersonation; U+202E must not reorder the
// rendered name). Account nickname validation owns this normalization so
// visually identical reserved names are rejected consistently.
export const ACCOUNT_NICKNAME_SANITIZE_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

// ─── Misc ──────────────────────────────────────────────────────────
