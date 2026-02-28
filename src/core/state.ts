/**
 * MUSIXQUARE 2.0 — Central State Store
 * Extracted from original app.js global variables.
 *
 * Single Source of Truth for app-wide reactive state.
 * Uses dot-separated paths and emits bus events on change.
 */

import { bus } from './events.ts';
import { APP_STATE, TRANSFER_STATE } from './constants.ts';
import type { AppStateValue, TransferStateValue } from './constants.ts';
import type { FileMeta, PlaylistItem, PreloadSessionEntry, DeviceInfo, DataConnection } from '../types/index.ts';

// ─── State Tree ────────────────────────────────────────────────────

export interface StateTree {
  // App
  appState: AppStateValue;

  // Setup
  setup: {
    sessionStarted: boolean;
  };

  // Player (playback state — code uses `player.*` paths throughout)
  player: {
    startedAt: number;
    pausedAt: number;
    isSeeking: boolean;
    isFirstTrackLoad: boolean;
  };

  // Transfer
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
  };

  // Preload
  preload: {
    isPreloading: boolean;
    sessionId: number;
    meta: Partial<FileMeta> | null;
    nextTrackIndex: number;
    nextFileBlob: Blob | null;
    ackSent: Set<number>;
    sessionState: Map<number, PreloadSessionEntry>;
  };

  // Audio
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
    analyser: unknown | null;
  };

  // Sync
  sync: {
    localOffset: number;
    autoSyncOffset: number;
    usePingCompensation: boolean;
    lastLatencyMs: number;
    latencyHistory: number[];
    resyncTimer: ReturnType<typeof setTimeout> | null;
  };

  // Network
  network: {
    myId: string | null;
    myDeviceLabel: string;
    appRole: 'host' | 'guest' | 'idle';
    sessionCode: string;
    lastJoinCode: string;
    hostConn: DataConnection | null;
    connectedPeers: Array<{
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
    }>;
    isOperator: boolean;
    isConnecting: boolean;
    isIntentionalDisconnect: boolean;
    lastKnownDeviceList: DeviceInfo[] | null;
    peerLabels: Record<string, string>;
    peerSlots: (string | null)[];
    peerSlotByPeerId: Map<string, number>;
    activeHostConnByPeerId: Map<string, DataConnection>;
    connectionType: 'local' | 'remote' | 'unknown';
  };

  // Relay
  relay: {
    upstreamDataConn: DataConnection | null;
    downstreamDataPeers: DataConnection[];
  };

  // Playlist
  playlist: {
    items: PlaylistItem[];
    currentTrackIndex: number;
    repeatMode: number;
    isShuffle: boolean;
  };

  // Files
  files: {
    currentFileBlob: Blob | null;
    currentFileOpfs: { name: string | null };
  };

  // YouTube
  youtube: {
    currentSubIndex: number;
    subItemsMap: Record<string, { ids: string[]; titles: string[] }>;
  };

  // Recovery
  recovery: {
    pending: boolean;
    retryCount: number;
    pendingFileName: string;
    pendingFileIndex: number | undefined;
  };

}

// ─── Type-safe Path Utilities ─────────────────────────────────────

/**
 * Leaf type check — stops path recursion at primitive/collection types.
 * Without this, `Array`, `Map`, `Set`, `Blob`, etc. would be recursed into.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IsLeaf<T> = T extends
  | string | number | boolean | null | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | Array<any> | Map<any, any> | Set<any>
  | Blob | DataConnection | ReturnType<typeof setTimeout>
  ? true : false;

/**
 * Union of all valid dot-separated state paths, auto-derived from StateTree.
 * Top-level leaf keys (e.g. 'appState') and nested keys (e.g. 'audio.masterVolume').
 */
export type StatePath = {
  [K in keyof StateTree & string]: IsLeaf<StateTree[K]> extends true
    ? K
    : `${K}.${keyof StateTree[K] & string}`
}[keyof StateTree & string];

/**
 * Maps a StatePath to its value type.
 * e.g. StatePathValue<'audio.masterVolume'> = number
 */
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
    },

    transfer: {
      state: TRANSFER_STATE.IDLE,
      receivedCount: 0,
      meta: {},
      localSessionId: 0,
      currentSessionId: 0,
      activeBroadcastSession: null,
      lastReceivedCountSnapshot: 0,
      skipIncomingFile: false,
      waitingForPreload: false,
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
      eqValues: [0, 0, 0, 0, 0],
      stereoWidth: 1.0,
      virtualBass: 0,
      subFreq: 120,
      userPreampGain: 1.0,
      analyser: null,
    },

    sync: {
      localOffset: 0,
      autoSyncOffset: 0,
      usePingCompensation: false, // 로컬 네트워크 전용 — RTT 보정 비활성화
      lastLatencyMs: 0,
      latencyHistory: [],
      resyncTimer: null,
    },

    network: {
      myId: null,
      myDeviceLabel: 'HOST',
      appRole: 'idle',
      sessionCode: '',
      lastJoinCode: '',
      hostConn: null,
      connectedPeers: [],
      isOperator: false,
      isConnecting: false,
      isIntentionalDisconnect: false,
      lastKnownDeviceList: null,
      peerLabels: {},
      peerSlots: [null, null, null, null], // index 0 unused, 1-3 for guests
      peerSlotByPeerId: new Map(),
      activeHostConnByPeerId: new Map(),
      connectionType: 'unknown' as const,
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
    },

    recovery: {
      pending: false,
      retryCount: 0,
      pendingFileName: '',
      pendingFileIndex: undefined,
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
export function getState<P extends StatePath>(path: P): StatePathValue<P> {
  const keys = path.split('.');
  let current: unknown = _state;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined as StatePathValue<P>;
    current = (current as Record<string, unknown>)[key];
  }
  return current as StatePathValue<P>;
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
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1];
  const oldValue = current[lastKey];
  if (oldValue === value) return;

  current[lastKey] = value;

  if (!_isBatching) {
    bus.emit(`state:${path}` as `state:${string}`, value as unknown, path as string);
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

  // Emit deduplicated events
  const seen = new Set<string>();
  for (const path of _batchedPaths) {
    if (!seen.has(path)) {
      seen.add(path);
      bus.emit(`state:${path}` as `state:${string}`, getState(path as StatePath) as unknown, path as string);
    }
  }
  _batchedPaths = [];
}

/**
 * Get a readonly snapshot of the entire state tree (for debugging).
 */
export function snapshot(): Readonly<StateTree> {
  return _state;
}

/**
 * Reset state to initial values.
 */
export function resetState(): void {
  _state = createInitialState();
}

