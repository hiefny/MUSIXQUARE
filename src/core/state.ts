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
  isStateTransitioning: boolean;

  // Session
  session: {
    peerId: string | null;
    inviteCode: string | null;
    hostId: string | null;
    started: boolean;
  };

  // Setup
  setup: {
    sessionStarted: boolean;
  };

  // Player (playback state — code uses `player.*` paths throughout)
  player: {
    startedAt: number;
    pausedAt: number;
    isSeeking: boolean;
    isPlayLocked: boolean;
    activeLoadSessionId: number;
    currentLoadToken: number;
    isFirstTrackLoad: boolean;
  };

  // Transfer
  transfer: {
    state: TransferStateValue;
    receivedCount: number;
    meta: Partial<FileMeta>;
    localSessionId: number;
    currentSessionId: number;
    activeBroadcastSession: number | null;
    lastReceivedCountSnapshot: number;
    skipIncomingFile: boolean;
  };

  // Preload
  preload: {
    isPreloading: boolean;
    sessionId: number;
    count: number;
    meta: Partial<FileMeta> | null;
    nextTrackIndex: number;
    nextFileBlob: Blob | null;
    skipIncoming: boolean;
    waitingFor: boolean;
    usedForIndex: number | null;
    ackSent: Set<number>;
    sessionState: Map<number, PreloadSessionEntry>;
    watchdog: ReturnType<typeof setTimeout> | null;
  };

  // Audio
  audio: {
    masterVolume: number;
    preMuteVolume: number;
    channelMode: number;
    isSurroundMode: boolean;
    surroundChannelIndex: number;
    reverbMix: number;
    reverbDecay: number;
    reverbPreDelay: number;
    reverbLowCut: number;
    reverbHighCut: number;
    reverbType: string;
    eqValues: number[];
    stereoWidth: number;
    virtualBass: number;
    subFreq: number;
    userPreampGain: number;
  };

  // Sync
  sync: {
    localOffset: number;
    autoSyncOffset: number;
    usePingCompensation: boolean;
    lastLatencyMs: number;
    latencyHistory: number[];
    lastHeartbeatAckAt: number;
    syncRequestTime: number;
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
    }>;
    isOperator: boolean;
    isConnecting: boolean;
    isIntentionalDisconnect: boolean;
    lastKnownDeviceList: DeviceInfo[] | null;
    deviceCounter: number;
    peerLabels: Record<string, string>;
    peerSlots: (string | null)[];
    peerSlotByPeerId: Map<string, number>;
    activeHostConnByPeerId: Map<string, DataConnection>;
  };

  // Relay
  relay: {
    upstreamDataConn: DataConnection | null;
    downstreamDataPeers: string[];
    chunkQueue: unknown[];
    isRelaying: boolean;
  };

  // Playlist
  playlist: {
    items: PlaylistItem[];
    currentTrackIndex: number;
    repeatMode: number;
    isShuffle: boolean;
    isFirstTrackLoad: boolean;
  };

  // Files
  files: {
    currentFileBlob: Blob | null;
    currentAudioBuffer: AudioBuffer | null;
    currentFileOpfs: { name: string | null };
    preloadFileOpfs: { name: string | null };
  };

  // YouTube
  youtube: {
    currentSessionId: number;
    currentSubIndex: number;
    subItemsMap: Record<string, { ids: string[]; titles: string[] }>;
    scriptLoading: boolean;
    loadTimeout: ReturnType<typeof setTimeout> | null;
    iosWatchdog: number | null;
  };

  // Recovery
  recovery: {
    pending: boolean;
    inProgress: Record<string, boolean>;
    lastRequest: Record<string, number>;
    retryCount: number;
    pendingFileName: string;
    pendingFileIndex: number | undefined;
    pendingPlayTime: number | undefined;
  };

  // UI
  ui: {
    animationId: number | null;
    uiLoopId: number | null;
    isChatDrawerOpen: boolean;
    unreadChatCount: number;
  };
}

// ─── Initial State ─────────────────────────────────────────────────

function createInitialState(): StateTree {
  return {
    appState: APP_STATE.IDLE,
    isStateTransitioning: false,

    session: {
      peerId: null,
      inviteCode: null,
      hostId: null,
      started: false,
    },

    setup: {
      sessionStarted: false,
    },

    player: {
      startedAt: 0,
      pausedAt: 0,
      isSeeking: false,
      isPlayLocked: false,
      activeLoadSessionId: 0,
      currentLoadToken: 0,
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
    },

    preload: {
      isPreloading: false,
      sessionId: 0,
      count: 0,
      meta: null,
      nextTrackIndex: -1,
      nextFileBlob: null,
      skipIncoming: false,
      waitingFor: false,
      usedForIndex: null,
      ackSent: new Set(),
      sessionState: new Map(),
      watchdog: null,
    },

    audio: {
      masterVolume: 1.0,
      preMuteVolume: 1.0,
      channelMode: 0,
      isSurroundMode: false,
      surroundChannelIndex: -1,
      reverbMix: 0,
      reverbDecay: 5.0,
      reverbPreDelay: 0.1,
      reverbLowCut: 0,
      reverbHighCut: 0,
      reverbType: 'hall',
      eqValues: [0, 0, 0, 0, 0],
      stereoWidth: 1.0,
      virtualBass: 0,
      subFreq: 120,
      userPreampGain: 1.0,
    },

    sync: {
      localOffset: 0,
      autoSyncOffset: 0,
      usePingCompensation: false,
      lastLatencyMs: 0,
      latencyHistory: [],
      lastHeartbeatAckAt: 0,
      syncRequestTime: 0,
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
      deviceCounter: 0,
      peerLabels: {},
      peerSlots: [null, null, null, null], // index 0 unused, 1-3 for guests
      peerSlotByPeerId: new Map(),
      activeHostConnByPeerId: new Map(),
    },

    relay: {
      upstreamDataConn: null,
      downstreamDataPeers: [],
      chunkQueue: [],
      isRelaying: false,
    },

    playlist: {
      items: [],
      currentTrackIndex: -1,
      repeatMode: 0,
      isShuffle: false,
      isFirstTrackLoad: true,
    },

    files: {
      currentFileBlob: null,
      currentAudioBuffer: null,
      currentFileOpfs: { name: null },
      preloadFileOpfs: { name: null },
    },

    youtube: {
      currentSessionId: 0,
      currentSubIndex: -1,
      subItemsMap: {},
      scriptLoading: false,
      loadTimeout: null,
      iosWatchdog: null,
    },

    recovery: {
      pending: false,
      inProgress: {},
      lastRequest: {},
      retryCount: 0,
      pendingFileName: '',
      pendingFileIndex: undefined,
      pendingPlayTime: undefined,
    },

    ui: {
      animationId: null,
      uiLoopId: null,
      isChatDrawerOpen: false,
      unreadChatCount: 0,
    },
  };
}

// ─── State Instance ────────────────────────────────────────────────

let _state: StateTree = createInitialState();

// ─── Accessors ─────────────────────────────────────────────────────

/**
 * Get a state value by dot-separated path.
 * @example getState('audio.masterVolume') // 1.0
 * @example getState('playlist.items')     // PlaylistItem[]
 */
export function getState<T = unknown>(path: string): T {
  const keys = path.split('.');
  let current: unknown = _state;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined as T;
    current = (current as Record<string, unknown>)[key];
  }
  return current as T;
}

/**
 * Set a state value by dot-separated path.
 * Emits `state:<path>` events for each parent path.
 */
export function setState(path: string, value: unknown): void {
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

  // Emit events for the changed path and all parent paths
  let eventPath = '';
  for (const key of keys) {
    eventPath = eventPath ? `${eventPath}.${key}` : key;
    bus.emit(`state:${eventPath}`, value, path);
  }
}

/**
 * Batch multiple state updates, emitting events only once per path.
 */
export function batchSetState(updates: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(updates)) {
    setState(path, value);
  }
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

/**
 * Direct access to the state tree (use sparingly — prefer getState/setState).
 */
export function getRawState(): StateTree {
  return _state;
}
