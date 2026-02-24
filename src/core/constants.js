// @ts-check
/**
 * MUSIXQUARE 2.0 - Shared Constants & Protocol
 *
 * 모든 매직넘버와 메시지 타입을 한 곳에서 관리.
 * 1.0에서 js/app.js 곳곳에 흩어져 있던 상수들을 통합.
 */

// ──────────────────────────────────────────
// Message Types (P2P Protocol)
// ──────────────────────────────────────────
export const MSG = Object.freeze({
  // Playback control
  PLAY:           'play',
  PAUSE:          'pause',
  STOP:           'stop',
  SEEK:           'seek',

  // File transfer
  FILE_PREPARE:   'file-prepare',
  FILE_START:     'file-start',
  FILE_CHUNK:     'file-chunk',
  FILE_END:       'file-end',
  FILE_WAIT:      'file-wait',

  // Preload
  PRELOAD_START:  'preload-start',
  PRELOAD_CHUNK:  'preload-chunk',
  PRELOAD_END:    'preload-end',
  PRELOAD_ACK:    'preload-ack',
  PLAY_PRELOADED: 'play-preloaded',

  // Sync
  GET_SYNC_TIME:  'get-sync-time',
  SYNC_RESPONSE:  'sync-response',
  STATUS_SYNC:    'status-sync',

  // Session
  WELCOME:        'welcome',
  HEARTBEAT:      'heartbeat',
  PONG:           'pong',
  DEVICE_LIST:    'device-list',

  // Audio FX
  VOLUME:         'volume',
  CHANNEL:        'channel',
  REVERB:         'reverb',
  REVERB_TYPE:    'reverb-type',
  REVERB_DECAY:   'reverb-decay',
  REVERB_PREDELAY:'reverb-predelay',
  REVERB_LOWCUT:  'reverb-lowcut',
  REVERB_HIGHCUT: 'reverb-highcut',
  EQ_UPDATE:      'eq-update',
  PREAMP:         'preamp',
  EQ_RESET:       'eq-reset',
  STEREO_WIDTH:   'stereo-width',
  VBASS:          'vbass',

  // Playlist
  PLAYLIST_UPDATE:'playlist-update',
  SHUFFLE:        'shuffle',
  REPEAT_MODE:    'repeat-mode',
  TRACK_ENDED:    'track-ended',

  // Recovery
  REQUEST_CURRENT_FILE: 'request-current-file',
  REQUEST_DATA_RECOVERY:'request-data-recovery',

  // YouTube
  YOUTUBE:        'youtube',
  YOUTUBE_SYNC:   'youtube-sync',

  // Chat
  CHAT:           'chat',
});

// ──────────────────────────────────────────
// Audio Constants
// ──────────────────────────────────────────
export const CHUNK_SIZE = 16384;        // 16KB per transfer chunk
export const MAX_PEERS = 3;             // Host + 3 guests max
export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// ──────────────────────────────────────────
// Channel Modes
// ──────────────────────────────────────────
export const CHANNEL = Object.freeze({
  LEFT:     -1,
  ORIGINAL:  0,
  RIGHT:     1,
  WOOFER:    2,
});

// ──────────────────────────────────────────
// Timing
// ──────────────────────────────────────────
export const HEARTBEAT_INTERVAL_MS = 1000;
export const PING_INTERVAL_MS = 2000;
export const RECOVERY_BACKOFF_MS = [2000, 5000, 10000];
export const MAX_RECOVERY_RETRIES = 3;
export const PRELOAD_WATCHDOG_MS = 10000;
export const LOCK_TIMEOUT_MS = 60000;
