/**
 * MUSIXQUARE — Central State Store
 *
 * Single Source of Truth for app-wide reactive state.
 * Uses dot-separated paths and emits bus events on change.
 */

import { bus } from './events.ts';
import {
  APP_STATE,
  TRANSFER_STATE,
  PLAYBACK_STATE,
  EQ_FREQUENCIES,
  DEFAULT_MAX_GUEST_SLOTS,
} from './constants.ts';

// 3.0: StateTree, StatePath, StatePathValue, ShallowImmutable moved to types/index.ts
// to enable typed state:${StatePath} events without circular dependency.
// Re-export here for backward compatibility with existing importers.
export type { StateTree, StatePath, StatePathValue, ShallowImmutable } from '../types/index.ts';
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
    appState: APP_STATE.IDLE,

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
      // instead of looping recovery → re-decode → fail forever (iOS Safari can't
      // decode mp4-as-mp3, the original symptom that surfaced this gap).
      decodeFailureCount: 0,
    },

    transfer: {
      state: TRANSFER_STATE.IDLE,
      receivedCount: 0,
      meta: null,
      localSessionId: 0,
      currentSessionId: 0,
      activeBroadcastSession: null,
      lastReceivedCountSnapshot: 0,
      // Phase 4: waitingForPreload + skipIncomingFile removed; both derived
      // from playback.lifecycle now (see transfer-receive.ts shouldSkipIncomingFile).
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
      reverbDecay: 5.0,
      reverbPreDelay: 0.1,
      reverbLowCut: 0,
      reverbHighCut: 0,
      eqValues: Array(EQ_FREQUENCIES.length).fill(0) as number[],
      stereoWidth: 1.0,
      virtualBass: 0,
      subFreq: 120,
      userPreampGain: 1.0,
    },

    sync: {
      localOffset: 0,
      lastLatencyMs: 0,
      latencyHistory: [],
      // resyncTimer removed — managed timers registry handles this via 'global-resync' key
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

    relay: {
      upstreamDataConn: null,
      downstreamDataPeers: [],
    },

    playlist: {
      items: [],
      currentTrackIndex: -1,
      repeatMode: 0,
      isShuffle: false,
    },

    files: {
      currentFileBlob: null,
      currentFileOpfs: { name: null },
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
      pendingFileName: '',
      pendingFileIndex: undefined,
    },

    systemAudio: {
      isReceiving: false,
    },

    playback: {
      lifecycle: PLAYBACK_STATE.IDLE,
      loadSource: null,
      pendingPlayTime: undefined,
      pendingPausedAt: undefined,
    },
  };
}

// ─── State Instance ────────────────────────────────────────────────

let _state: StateTree = createInitialState();
let _isBatching = false;
let _batchedPaths: string[] = [];

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
        // eslint-disable-next-line no-console
        console.debug(`[State] path not found: "${path}" (failed at key "${key}")`);
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
  let current: Record<string, unknown> = _state as unknown as Record<string, unknown>;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== 'object') {
      if (import.meta.env?.DEV) {
        // eslint-disable-next-line no-console
        console.warn(
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
    (bus as any).emit(`state:${path}`, value, path);
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
      let current: Record<string, unknown> = _state as unknown as Record<string, unknown>;

      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (current[key] == null || typeof current[key] !== 'object') {
          if (import.meta.env?.DEV) {
            // eslint-disable-next-line no-console
            console.warn(
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
      (bus as any).emit(`state:${path}`, getState(path as StatePath), path);
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
// These are read-only (getState) or write-through (setState, which the app
// itself calls internally) handles — they don't grant the test any
// capability the app doesn't already have. The hooks are a few bytes each
// and enable deterministic Playwright assertions against state transitions
// without having to scrape the DOM. Previously gated by
// `import.meta.env.DEV`, but that stripped them from preview/production
// builds — which is exactly when the e2e suite runs — so the gate was
// silently defeating its own purpose.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ = getState;
  (window as unknown as Record<string, unknown>).__MUSIXQUARE_SET_STATE__ = setState;
  (window as unknown as Record<string, unknown>).__MUSIXQUARE_BUS__ = bus;
}
