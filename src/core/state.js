// @ts-check
/**
 * MUSIXQUARE 2.0 - Central State Store
 *
 * 단일 진실의 원천(Single Source of Truth).
 * 모든 상태 변경은 setState()를 통해서만 이루어지며,
 * 변경 시 자동으로 이벤트가 발생한다.
 *
 * Usage:
 *   import { state, setState, getState } from '../core/state.js';
 *   setState('playback.status', 'playing');
 *   const status = getState('playback.status'); // 'playing'
 *
 * Events emitted:
 *   bus.emit('state:playback.status', 'playing', 'idle')  // (newVal, oldVal)
 *   bus.emit('state:playback', { ...playback })            // parent also notified
 */

import { bus } from './events.js';

/**
 * @typedef {'idle'|'connecting'|'playing_audio'|'playing_video'|'playing_youtube'|'paused'} PlaybackStatus
 * @typedef {'idle'|'receiving'|'processing'|'complete'} TransferStatus
 * @typedef {'host'|'guest'|null} AppRole
 */

/** @type {Object} The application state tree. */
const state = {
  /** @type {AppRole} */
  role: null,

  session: {
    /** @type {string|null} */
    peerId: null,
    /** @type {string|null} */
    inviteCode: null,
    /** @type {string|null} */
    hostId: null,
  },

  playback: {
    /** @type {PlaybackStatus} */
    status: 'idle',
    /** Current playback position in seconds */
    position: 0,
    /** Duration of current track */
    duration: 0,
    /** Current track index in playlist */
    trackIndex: 0,
    /** Track name */
    trackName: '',
    /** Whether currently seeking */
    isSeeking: false,
  },

  transfer: {
    /** @type {TransferStatus} */
    status: 'idle',
    /** Chunks received */
    received: 0,
    /** Total chunks expected */
    total: 0,
    /** File name being transferred */
    fileName: '',
    /** Session ID for transfer validation */
    sessionId: 0,
  },

  preload: {
    /** @type {TransferStatus} */
    status: 'idle',
    received: 0,
    total: 0,
    fileName: '',
    trackIndex: -1,
  },

  audio: {
    volume: 1,
    /** Channel mode: 0=Original, -1=Left, 1=Right, 2=Woofer */
    channelMode: 0,
    surroundIndex: 0,
    fx: {
      reverbMix: 0,
      reverbDecay: 5.0,
      reverbPreDelay: 0.1,
      reverbLowCut: 0,
      reverbHighCut: 0,
      stereoWidth: 1,
      virtualBass: 0,
      preamp: 0,
      /** @type {number[]} 10-band EQ gains */
      eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  },

  /** @type {Array<{id: string, label: string, channelMode: number, isReady: boolean}>} */
  peers: [],

  /** @type {Array<{name: string, duration?: number, source?: string}>} */
  playlist: [],

  ui: {
    /** @type {'play'|'playlist'|'settings'|'guide'} */
    activeTab: 'play',
    /** @type {'light'|'dark'} */
    theme: 'dark',
    isLoading: false,
    loadingText: '',
    /** @type {boolean} */
    setupComplete: false,
  },

  sync: {
    localOffset: 0,
    autoSyncOffset: 0,
    lastLatencyMs: 0,
  },
};

/**
 * Get a value from state by dot-separated path.
 * @param {string} path - e.g. 'playback.status'
 * @returns {any}
 */
export function getState(path) {
  const keys = path.split('.');
  let obj = state;
  for (const key of keys) {
    if (obj == null) return undefined;
    obj = obj[key];
  }
  return obj;
}

/**
 * Set a value in state by dot-separated path.
 * Emits 'state:<path>' events for the changed path and all parent paths.
 * @param {string} path - e.g. 'playback.status'
 * @param {any} value
 */
export function setState(path, value) {
  const keys = path.split('.');
  let obj = state;

  // Navigate to the parent
  for (let i = 0; i < keys.length - 1; i++) {
    if (obj[keys[i]] == null) obj[keys[i]] = {};
    obj = obj[keys[i]];
  }

  const lastKey = keys[keys.length - 1];
  const oldValue = obj[lastKey];

  // Skip if value hasn't changed (shallow comparison)
  if (oldValue === value) return;

  obj[lastKey] = value;

  // Emit specific path event
  bus.emit(`state:${path}`, value, oldValue);

  // Emit parent path events (e.g. 'state:playback' when 'playback.status' changes)
  if (keys.length > 1) {
    const parentPath = keys.slice(0, -1).join('.');
    bus.emit(`state:${parentPath}`, getState(parentPath));
  }
}

/**
 * Batch update multiple state paths at once.
 * Only emits events after all values are set.
 * @param {Record<string, any>} updates - e.g. { 'playback.status': 'playing', 'playback.position': 0 }
 */
export function batchSetState(updates) {
  const changes = [];

  for (const [path, value] of Object.entries(updates)) {
    const keys = path.split('.');
    let obj = state;
    for (let i = 0; i < keys.length - 1; i++) {
      if (obj[keys[i]] == null) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    const lastKey = keys[keys.length - 1];
    const oldValue = obj[lastKey];
    if (oldValue !== value) {
      obj[lastKey] = value;
      changes.push({ path, value, oldValue, keys });
    }
  }

  // Emit all events after all mutations
  const emittedParents = new Set();
  for (const { path, value, oldValue, keys } of changes) {
    bus.emit(`state:${path}`, value, oldValue);
    if (keys.length > 1) {
      const parentPath = keys.slice(0, -1).join('.');
      if (!emittedParents.has(parentPath)) {
        emittedParents.add(parentPath);
        bus.emit(`state:${parentPath}`, getState(parentPath));
      }
    }
  }
}

/**
 * Get a readonly snapshot of the entire state (for debugging).
 * @returns {Readonly<typeof state>}
 */
export function snapshot() {
  return JSON.parse(JSON.stringify(state));
}

// Expose for debugging in console
if (typeof window !== 'undefined') {
  /** @type {any} */ (window).__MXQR_STATE = { getState, setState, snapshot };
}
