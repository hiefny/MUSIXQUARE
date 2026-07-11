/**
 * MUSIXQUARE — Central State Store
 *
 * Single Source of Truth for app-wide reactive state.
 * Uses dot-separated paths and emits bus events on change.
 */

import { bus } from './events.ts';
import {
  TRANSFER_STATE,
  PLAYBACK_STATE,
  EQ_FREQUENCIES,
  REVERB_DEFAULT_DECAY,
  REVERB_DEFAULT_PREDELAY,
  DEFAULT_MAX_GUEST_SLOTS,
} from './constants.ts';
import { log } from './log.ts';

// Keep shared state types in types/index.ts to avoid a circular dependency.
// StateTree remains re-exported for compatibility; the other types are local
// signature imports only.
export type { StateTree } from '../types/index.ts';
import type { StateTree, StatePath, StatePathValue, ShallowImmutable } from '../types/index.ts';

/**
 * Restore persisted YouTube rendezvous play-latency from localStorage.
 *
 * The playVideo() → audible-output latency is a stable per-device property
 * (browser + OS + audio stack), so once the rendezvous calibration has
 * learned it, we persist the value and reuse it next session — otherwise
 * every fresh page load would have an inaccurate first rendezvous until
 * the EMA caught up.
 *
 * Clamped to the same [0, 600] range as the calibration floor/ceiling, and
 * falls back to 0 on any read error (no localStorage, corrupt value, etc.).
 */
const YT_PLAY_LATENCY_STORAGE_KEY = 'musixquare-yt-play-latency';
function readStoredGuestPlayLatency(): number {
  try {
    if (typeof localStorage === 'undefined') return 0;
    const raw = localStorage.getItem(YT_PLAY_LATENCY_STORAGE_KEY);
    if (raw === null) return 0;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 600) return 0;
    return parsed;
  } catch {
    return 0;
  }
}

// ─── Initial State ─────────────────────────────────────────────────

function createInitialState(): StateTree {
  return {
    setup: {
      sessionStarted: false,
    },

    player: {
      startedAt: 0,
      pausedAt: 0,
      isSeeking: false,
      isFirstTrackLoad: true,
      currentTrackMeta: null,
      // Consecutive decode failures for the current track (reset on FILE_PREPARE).
      // After 2 failures the guest gives up and signals host via GUEST_DECODE_FAILED
      // instead of looping recovery → re-decode → fail forever. For example,
      // iOS Safari cannot decode content mislabeled as mp4-as-mp3.
      decodeFailureCount: 0,
    },

    share: {
      remote: {
        upload: {
          status: 'idle',
          progress: 0,
          objectId: null,
          expiresAt: null,
          error: null,
        },
        download: {
          status: 'idle',
          progress: 0,
          error: null,
        },
      },
    },

    transfer: {
      state: TRANSFER_STATE.IDLE,
      receivedCount: 0,
      meta: null,
      localSessionId: 0,
      currentSessionId: 0,
      activeBroadcastSession: null,
      lastReceivedCountSnapshot: 0,
      // waitingForPreload + skipIncomingFile are derived from playback.lifecycle
      // (see transfer-receive.ts shouldSkipIncomingFile).
      staleChunkBurstStart: 0,
      staleChunkBurstCount: 0,
    },

    preload: {
      isPreloading: false,
      sessionId: 0,
      meta: null,
      nextTrackIndex: -1,
      nextFileBlob: null,
      ackSent: new Set(),
      sessionState: new Map(),
    },

    audio: {
      masterVolume: 1.0,
      channelMode: 0,
      isSurroundMode: false,
      surroundChannelIndex: -1,
      reverbMix: 0,
      reverbDecay: REVERB_DEFAULT_DECAY,
      reverbPreDelay: REVERB_DEFAULT_PREDELAY,
      reverbLowCut: 0,
      reverbHighCut: 0,
      eqValues: Array(EQ_FREQUENCIES.length).fill(0) as number[],
      stereoWidth: 1.0,
      virtualBass: 0,
      exciter: false,
      subFreq: 120,
      userPreampGain: 1.0,
    },

    demo: {
      active: false,
      loading: false,
      reverbOn: false,
      bassBoostOn: false,
      trebleBoostOn: false,
      surroundOn: false,
    },

    sync: {
      localOffset: 0,
      youtubeLocalOffset: 0,
      lastLatencyMs: 0,
      latencyHistory: [],
    },

    network: {
      myId: null,
      myDeviceLabel: 'HOST',
      myJoinOrder: 0,
      appRole: 'idle',
      sessionCode: '',
      lastJoinCode: '',
      hostConn: null,
      connectedPeers: [],
      isOperator: false,
      maxGuestSlots: DEFAULT_MAX_GUEST_SLOTS,
      roomPasswordRequired: false,
      roomPassword: '',
      isConnecting: false,
      isIntentionalDisconnect: false,
      lastKnownDeviceList: null,
      peerLabels: {},
      peerSlots: Array(DEFAULT_MAX_GUEST_SLOTS + 1).fill(null) as (string | null)[], // index 0 unused, 1-N for guests
      peerSlotByPeerId: new Map(),
      activeHostConnByPeerId: new Map(),
      connectionType: 'unknown' as const,
      mutedPeers: new Set<string>(),
      chatFrozen: false,
      slowmodeSeconds: 0,
      filterEnabled: false,
    },

    playlist: {
      items: [],
      currentTrackIndex: -1,
      repeatMode: 0,
      isShuffle: false,
    },

    files: {
      currentFileBlob: null,
      currentTrack: { name: null },
    },

    youtube: {
      currentSubIndex: -1,
      subItemsMap: {},
      // ms — restored from localStorage if a previous session has calibrated
      // it, else 0 (no arbitrary pre-pull). Self-calibrated by rendezvous sync.
      // See StateTree.youtube.guestPlayLatency
      guestPlayLatency: readStoredGuestPlayLatency(),
    },

    recovery: {
      pending: false,
      retryCount: 0,
      // pendingFileName + pendingFileIndex live as playback.pendingRecoveryTarget
      // (atomic { index, name }).
    },

    systemAudio: {
      isReceiving: false,
    },

    playback: {
      mode: null,
      activity: 'idle',
      lifecycle: PLAYBACK_STATE.IDLE,
      loadSource: null,
      pendingPlayTime: undefined,
      pendingPlayTimeSetAt: 0,
      pendingRecoveryTarget: null,
      failedTrackKeys: new Set<string>(),
    },
  };
}

// ─── State Instance ────────────────────────────────────────────────

let _state: StateTree = createInitialState();
let _isBatching = false;
let _batchedPaths: string[] = [];

type StateEventName = `state:${StatePath}`;

declare global {
  interface Window {
    __MUSIXQUARE_GET_STATE__?: typeof getState;
    __MUSIXQUARE_SET_STATE__?: typeof setState;
    __MUSIXQUARE_BUS__?: typeof bus;
  }
}

function emitStateChange(path: StatePath, value: unknown): void {
  bus.emit(`state:${path}` as StateEventName, value, path);
}

function asMutableStateRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// ─── Accessors ─────────────────────────────────────────────────────

/**
 * Get a state value by dot-separated path.
 * @example getState('audio.masterVolume') // 1.0
 * @example getState('playlist.items')     // PlaylistItem[]
 */
export function getState<P extends StatePath>(path: P): ShallowImmutable<StatePathValue<P>> {
  const keys = path.split('.');
  let current: unknown = _state;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') {
      if (import.meta.env?.DEV) {
        log.debug(`[State] path not found: "${path}" (failed at key "${key}")`);
      }
      return undefined as ShallowImmutable<StatePathValue<P>>;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current as ShallowImmutable<StatePathValue<P>>;
}

/**
 * Set a state value by dot-separated path.
 * Emits a `state:<path>` event on change (skipped during batching).
 */
export function setState<P extends StatePath>(path: P, value: StatePathValue<P>): void {
  const keys = path.split('.');
  let current = asMutableStateRecord(_state);

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== 'object') {
      if (import.meta.env?.DEV) {
        log.warn(
          `[State] setState auto-creating intermediate key "${keys.slice(0, i + 1).join('.')}" for path "${path}"`,
        );
      }
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1];
  const oldValue = current[lastKey];
  // Intentional: skip if same reference (===). For objects/arrays, callers MUST
  // provide a new reference (spread/map) to trigger subscribers. This is by design
  // for performance — avoids deep equality checks on hot paths.
  if (oldValue === value) return;

  current[lastKey] = value;

  if (!_isBatching) {
    // Safe: P extends StatePath ⊂ keyof StateEvents ⊂ keyof EventMap
    emitStateChange(path, value);
  }
}

/**
 * Batch multiple state updates, emitting events only once per unique path.
 * During the batch, setState applies values but skips event emission.
 * After all mutations, deduplicated events are emitted.
 */
export function batchSetState(updates: Partial<{ [P in StatePath]: StatePathValue<P> }>): void {
  _isBatching = true;
  _batchedPaths = [];

  try {
    for (const [path, value] of Object.entries(updates)) {
      const keys = path.split('.');
      let current = asMutableStateRecord(_state);

      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (current[key] == null || typeof current[key] !== 'object') {
          if (import.meta.env?.DEV) {
            log.warn(
              `[State] batchSetState auto-creating intermediate key "${keys.slice(0, i + 1).join('.')}" for path "${path}"`,
            );
          }
          current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
      }

      const lastKey = keys[keys.length - 1];
      const oldValue = current[lastKey];
      if (oldValue !== value) {
        current[lastKey] = value;
        _batchedPaths.push(path);
      }
    }
  } finally {
    _isBatching = false;
  }

  // Snapshot paths before emitting — re-entrant setState/batchSetState during
  // emit would overwrite _batchedPaths, losing remaining paths.
  const pathsToEmit = _batchedPaths;
  _batchedPaths = [];

  const seen = new Set<string>();
  for (const path of pathsToEmit) {
    if (!seen.has(path)) {
      seen.add(path);
      // Safe: path is a StatePath string from setState calls
      emitStateChange(path as StatePath, getState(path as StatePath));
    }
  }
}

/**
 * Get a readonly deep-cloned snapshot of the entire state tree (for debugging).
 * Returns a JSON-serialized deep copy to prevent external mutation of internal state.
 * (structuredClone is not used because StateTree contains non-cloneable DataConnection objects.)
 */
export function snapshot(): Readonly<StateTree> {
  // JSON serialization — structuredClone always throws because
  // StateTree contains non-cloneable DataConnection objects.
  try {
    const seen = new WeakSet();
    return JSON.parse(
      JSON.stringify(_state, (_key, value) => {
        if (value instanceof Set) return [...value];
        if (value instanceof Map) return Object.fromEntries(value);
        if (value instanceof Blob) return '[Blob]';
        if (typeof MediaStream !== 'undefined' && value instanceof MediaStream)
          return '[MediaStream]';
        if (typeof value === 'object' && value !== null) {
          if (typeof value.close === 'function') return '[Connection]';
          // Guard against arbitrary circular references
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      }),
    );
  } catch {
    return {} as Readonly<StateTree>;
  }
}

/**
 * Reset state to initial values.
 */
export function resetState(): void {
  _state = createInitialState();
}

// ─── E2E Test Hook ─────────────────────────────────────────────────
// Expose getState/setState/bus as a test observation + drive-through hook.
// Keep these out of the normal production bundle: if an XSS ever lands, these
// globals would amplify it into easy app-state/event manipulation. E2E builds
// opt in via `vite build --mode e2e`; local dev keeps the convenience hooks.
const SHOULD_EXPOSE_TEST_HOOKS =
  import.meta.env.DEV ||
  import.meta.env.MODE === 'e2e' ||
  import.meta.env.VITE_MUSIXQUARE_TEST_HOOKS === '1';

if (typeof window !== 'undefined' && SHOULD_EXPOSE_TEST_HOOKS) {
  window.__MUSIXQUARE_GET_STATE__ = getState;
  window.__MUSIXQUARE_SET_STATE__ = setState;
  window.__MUSIXQUARE_BUS__ = bus;
}
