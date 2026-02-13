/**
 * ============================================================================
 * MUSIXQUARE - Multi-Device Synchronized Audio Player
 * ============================================================================
 * Multi-device P2P synchronized surround audio system web application.
 *
 * [DEPENDENCIES]
 * - Tone.js (Audio Engine)
 * - PeerJS (WebRTC P2P)
 * - QRCode.js (QR Generation)
 *
 * [SECTION INDEX]
 * - Global Constants & State Machine
 * - Resource Management (Blob URLs)
 * - Network & File Transfer (PeerJS / OPFS)
 * - Audio Engine (Tone.js) & Effects
 * - Playback Engine & Playlist
 * - YouTube Integration
 * - Chat & UI
 * - Window Exports (Public API)
 * ============================================================================
 */

// ============================================================================
// [SECTION] GLOBAL CONSTANTS & INSTANCE ID
// ============================================================================

// [Error Boundary] Catch uncaught exceptions and unhandled promise rejections
window.onerror = function (msg, src, line, col, err) {
    console.error(`[Global Error] ${msg} at ${src}:${line}:${col}`, err);
    return false; // Allow default browser handling
};
window.addEventListener('unhandledrejection', (event) => {
    console.error('[Unhandled Promise Rejection]', event.reason);
});

// Log Level System: set window.LOG_LEVEL = 0 for DEBUG output
const LOG_LEVEL = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, SILENT: 4 };
let _logLevel = LOG_LEVEL.INFO;
Object.defineProperty(window, 'LOG_LEVEL', {
    get: () => _logLevel,
    set: (v) => { _logLevel = v; console.info(`[Log] Level set to ${Object.keys(LOG_LEVEL).find(k => LOG_LEVEL[k] === v) || v}`); }
});
const log = {
    debug: (...args) => { if (_logLevel <= LOG_LEVEL.DEBUG) console.debug(...args); },
    info: (...args) => { if (_logLevel <= LOG_LEVEL.INFO) console.info(...args); },
    warn: (...args) => { if (_logLevel <= LOG_LEVEL.WARN) console.warn(...args); },
    error: (...args) => { if (_logLevel <= LOG_LEVEL.ERROR) console.error(...args); },
};

const OPFS_INSTANCE_ID = (typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : (Date.now().toString(36) + Math.random().toString(36).substr(2, 9));

// [iOS Latency Engineering]
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const IOS_STARTUP_BIAS = 0; // Reset to 0 as Tone.Player handles precision.

/**
 * [Robustness] Session ID Validation
 * Updated: Fallback to 0 with warning instead of crashing for non-critical ops
 */
function validateSessionId(id) {
    const sid = Number(id);
    if (!sid || sid === 0 || isNaN(sid)) {
        // [Relaxed] Log warning and return 0 instead of throwing to prevent flow interruption
        log.warn(`[Session] Warning: Invalid Session ID: ${id}. Fallback to 0.`);
        return 0;
    }
    return sid;
}

/**
 * [Worker] Centralized Protocol Wrapper
 * Routes commands to either SyncWorker (timers) or TransferWorker (OPFS)
 */
function postWorkerCommand(payload, transfers) {
    if (!payload.command) return;

    // OPFS commands require filename and sessionId
    // Exclude RESET and CLEANUP from strict ID enforcement
    if (payload.command.startsWith('OPFS_') &&
        payload.command !== 'OPFS_RESET' &&
        payload.command !== 'OPFS_CLEANUP') {

        if (!payload.filename) log.warn(`[Worker] Missing filename in ${payload.command}`);
        if (payload.sessionId === undefined) payload.sessionId = 0;
        validateSessionId(payload.sessionId);
    }

    // [ROUTING]
    if (payload.command.startsWith('OPFS_')) {
        if (typeof transferWorker !== 'undefined') {
            transferWorker.postMessage(payload, transfers);
        }
    } else {
        if (typeof syncWorker !== 'undefined') {
            syncWorker.postMessage(payload, transfers);
        }
    }
}

/**
 * [Diagnostics] Check if the browser environment supports required features.
 * Distinguishes between insecure context (HTTP) and outdated browsers (No OPFS).
 */
function checkSystemCompatibility() {
    const isSecure = window.isSecureContext;
    const hasOPFS = !!(navigator.storage && navigator.storage.getDirectory);

    // Give some time for UI/Toast engine to load
    setTimeout(() => {
        if (!isSecure) {
            log.error("[Compatibility] Insecure context detected.");
            showToast("HTTPS 필수: 보안 연결에서만 작동합니다.");
        } else if (!hasOPFS) {
            log.error("[Compatibility] OPFS not supported.");
            showToast("브라우저 업데이트 필요: 최신 iOS(15.2+)로 업데이트하세요.");
        } else if (IS_IOS) {
            showToast("IOS감지, 추가 보정 적용");
        }
    }, 1500);
}

// Run checks on startup
checkSystemCompatibility();

// ============================================================================
// [SECTION] AUDIO ENGINE - Tone.js Nodes
// Dependencies: Tone.js CDN
// ============================================================================
let toneSplit, toneMerge;
let gainL, gainR, masterGain;
let reverb, rvbLowCut, rvbHighCut, rvbCrossFade, eqNodes = [];
let playerNode = null;   // Transient BufferSource for precise start
let currentAudioBuffer = null; // Decoded PCM data in RAM
let vbFilter, vbCheby, vbGain;
let preamp, widener;
let globalLowPass = null;
let analyser;

// ============================================================================
// [SECTION] APP STATE MACHINE (State Pattern)
// ============================================================================
const APP_STATE = {
    IDLE: 'IDLE',
    PLAYING_AUDIO: 'PLAYING_AUDIO',     // Audio playback (Buffer Mode with Tone.js)
    PLAYING_VIDEO: 'PLAYING_VIDEO',     // Video playback (uses videoElement)
    PLAYING_YOUTUBE: 'PLAYING_YOUTUBE'  // YouTube embedded player
};

let currentState = APP_STATE.IDLE;
let _isStateTransitioning = false; // Guard against recursive state changes

/**
 * Centralized state transition function.
 * @param {string} newState - APP_STATE value
 * @param {object} options - { skipCleanup: boolean, onComplete: function }
 */
function setState(newState, options = {}) {
    const oldState = currentState;

    // Ignore same-state transitions
    if (oldState === newState) return;

    // Prevent recursive transitions
    if (_isStateTransitioning) {
        log.warn(`[State] Transition Blocked: Currently moving to another state. Rejecting ${newState}.`);
        return;
    }

    _isStateTransitioning = true;
    log.debug(`[State] Transition: ${oldState} -> ${newState}`, options);

    // Clean up previous state (optional)
    if (!options.skipCleanup) {
        cleanupState(oldState);
    }

    // Set new state
    currentState = newState;

    // Update UI for new state
    updateUIForState(newState);

    _isStateTransitioning = false;

    // Execute completion callback
    if (options.onComplete) {
        try { options.onComplete(); } catch (e) { log.error('[State] onComplete error:', e); }
    }
}

/**
 * Clean up resources based on previous state.
 */
function cleanupState(oldState) {
    // Capture current time before stopping the current engine to prevent drift
    if (oldState !== APP_STATE.IDLE) {
        pausedAt = getTrackPosition();
    }
    switch (oldState) {
        case APP_STATE.PLAYING_VIDEO:
        case APP_STATE.PLAYING_AUDIO:
            // Stop video element
            if (videoElement) {
                videoElement.pause();
            }
            // Don't revoke URL here! It kills the visible source during sync/pause.
            // Revocation is moved to clearPreviousTrackState.
            break;

        case APP_STATE.PLAYING_YOUTUBE:
            // Stop YouTube player
            if (typeof youtubePlayer !== 'undefined' && youtubePlayer && youtubePlayer.stopVideo) {
                try { youtubePlayer.stopVideo(); } catch (e) { /* best-effort cleanup */ }
            }
            // Ensure any active Blob URL is cleared when entering YouTube mode
            BlobURLManager.revoke();
            break;

        case APP_STATE.IDLE:
            BlobURLManager.revoke();
            break;
    }
}

function isMediaVideo(blob, metadata) {
    if (!blob) return false;

    // 1. Check MIME type (Real File on Host or Metadata from broadcast)
    if (blob.type && blob.type.startsWith('video/')) return true;
    if (metadata) {
        if (metadata.mime && metadata.mime.startsWith('video/')) return true;
        if (metadata.type && metadata.type.startsWith('video/')) return true;
    }

    // 2. Check Extension (Prioritize original metadata name from Host)
    const fileName = (metadata && metadata.name) || blob.name || "";
    const ext = fileName.split('.').pop().toLowerCase();
    return ['mp4', 'mkv', 'webm', 'mov'].includes(ext);
}

/**
 * 중앙화된 현재 트랙 재생 위치 계산 함수
 * startedAt, localOffset, autoSyncOffset을 모두 고려하여
 * 현재 트랙의 몇 초 지점인지를 반환합니다.
 */
function getTrackPosition() {
    if (currentState === APP_STATE.IDLE) return pausedAt || 0;

    const duration = (currentAudioBuffer && currentAudioBuffer.duration)
        ? currentAudioBuffer.duration
        : (videoElement && isFinite(videoElement.duration) ? videoElement.duration : 0);

    let pos = 0;

    // [Simplified] Calculate from Tone.now() and add offsets dynamically
    // startedAt !== 0 handles negative values for long tracks
    if (startedAt !== 0) {
        pos = (Tone.now() - startedAt) + localOffset + autoSyncOffset;
    }
    // Fallback to video element time only if startedAt is not set
    else if (videoElement && videoElement.src && videoElement.readyState >= 1) {
        pos = videoElement.currentTime;
    }

    // [Security/Harden] Sanitize output
    if (isNaN(pos)) pos = 0;
    if (pos < 0) pos = 0;
    if (duration > 0 && pos > duration) pos = duration;

    return pos;
}

/**
 * Update UI classes and elements based on state.
 */
function updateUIForState(newState) {
    // 1. Reset CSS classes (Centralized)
    document.body.classList.remove('mode-video', 'mode-youtube');

    // Toggle mode-video based on state
    const isVideoMode = (newState === APP_STATE.PLAYING_VIDEO || newState === APP_STATE.PLAYING_YOUTUBE);
    document.body.classList.toggle('mode-video', isVideoMode);

    // 2. Hide YouTube container (Global)
    const ytContainer = document.getElementById('youtube-player-container');
    if (ytContainer) {
        ytContainer.style.opacity = '0';
        ytContainer.style.pointerEvents = 'none';
        ytContainer.style.display = 'none';
    }

    // 3. Robust Video Wrapper Visibility
    const videoWrapper = document.querySelector('.video-wrapper');
    if (videoWrapper) {
        videoWrapper.style.display = isVideoMode ? 'flex' : 'none';
    }

    // 4. Hide main video element (Internal)
    if (videoElement) {
        videoElement.style.display = (newState === APP_STATE.PLAYING_VIDEO) ? 'block' : 'none';
    }

    switch (newState) {
        case APP_STATE.PLAYING_VIDEO:
            // Handled by isVideoMode logic above
            break;

        case APP_STATE.PLAYING_YOUTUBE:
            if (ytContainer) {
                ytContainer.style.display = 'block';
                ytContainer.style.opacity = '1';
                ytContainer.style.pointerEvents = 'auto';
            }
            break;

        case APP_STATE.PLAYING_AUDIO:
        case APP_STATE.IDLE:
        default:
            // Default: show visualizer
            break;
    }
}

let pausedAt = 0;
let startedAt = 0;
let activeLoadSessionId = 0; // Prevent Zombie Loads

let animationId = null;
let uiLoopId = null;
let isSeeking = false;
let _isPlayLocked = false; // Prevent concurrent play conflicts


// Centralized timer management object
const managedTimers = {
    chunkWatchdog: null,
    prepareWatchdog: null,
    autoPlayTimer: null,
    syncDebounce: null,
    relayWaitTimeout: null,
    preloadWatchdog: null,
    heartbeatMonitor: null,
    youtubeUILoop: null,
    youtubeSyncLoop: null
};

// Timer cleanup helper function
function clearManagedTimer(name) {
    if (managedTimers[name]) {
        clearTimeout(managedTimers[name]);
        clearInterval(managedTimers[name]);
        managedTimers[name] = null;
    }
}

function clearAllManagedTimers() {
    Object.keys(managedTimers).forEach(clearManagedTimer);
}

let channelMode = 0; // 0=Stereo, -1=Left, 1=Right, 2=Sub
let isSurroundMode = false; // 7.1 Mode
let surroundChannelIndex = -1; // 0..7
let surroundSplitter = null; // Split Source into 8 channels
let surroundGain = null; // Gain for selected surround channel
let mediaDownmixNode = null; // Stereo Downmixer for Standard Mode

let virtualBass = 0; // 0.0 ~ 1.0
let stereoWidth = 1.0;
let reverbMix = 0;
let reverbType = 'hall';
let subFreq = 120; // VB Crossover
let masterVolume = 1.0;
let preMuteVolume = 1.0; // Store volume before muting

// ============================================================================
// [SECTION] RESOURCE MANAGEMENT (Blob URLs)
// ============================================================================

const BlobURLManager = {
    _activeURL: null,
    _preparingURL: null,
    _pendingRevocations: new Map(),

    // BlobURL Queue: Avoid memory pressure during fast switching (Strict 5)
    MAX_PENDING: 5,

    /**
     * Create a new Blob URL in 'Preparing' state.
     * Use confirm() to move it to 'Active' state and schedule previous URL for revocation.
     */
    create: function (blob) {
        if (!blob) return null;

        // If we were preparing something else that never got confirmed, safeRevoke it
        if (this._preparingURL) {
            this.safeRevoke(this._preparingURL, null); // No blob to keep here maybe
        }

        this._preparingURL = URL.createObjectURL(blob);
        log.debug(`[BlobURL] Prepared: ${this._preparingURL}`);
        return this._preparingURL;
    },

    /**
     * Confirm the prepared URL as the active one.
     * This triggers the 10s delayed revocation for the OLD active URL.
     */
    confirm: function (blob) {
        if (!this._preparingURL) return;

        // Schedule previous ACTIVE URL for delayed revocation
        if (this._activeURL && this._activeURL !== this._preparingURL) {
            this.safeRevoke(this._activeURL); // No blob needed
        }

        this._activeURL = this._preparingURL;
        this._preparingURL = null;
        log.debug(`[BlobURL] Confirmed Active: ${this._activeURL}`);
    },

    /**
     * Schedule a specific URL for revocation after a safety delay.
     * Holds a reference to the blob to prevent GC during the delay.
     */
    safeRevoke: function (url) {
        if (!url || this._pendingRevocations.has(url)) return;

        // Never revoke the current active URL while playing
        if (url === this._activeURL && currentState !== APP_STATE.IDLE) {
            log.debug(`[BlobURL] Protected active URL during playback: ${url}`);
            return;
        }

        // Strict Queue management (Max 5)
        if (this._pendingRevocations.size >= this.MAX_PENDING) {
            const oldest = this._pendingRevocations.keys().next().value;
            log.debug(`[BlobURL] Queue Full. Explicitly revoking oldest: ${oldest}`);
            try {
                URL.revokeObjectURL(oldest);
            } catch (e) { log.debug('[BlobURL] Revoke failed (non-critical):', e.message); }
            this._pendingRevocations.delete(oldest);
        }

        // Store true instead of blob to allow GC to reclaim memory
        this._pendingRevocations.set(url, true);
        log.debug(`[BlobURL] Scheduled for revocation (10s): ${url}`);

        setTimeout(() => {
            try {
                URL.revokeObjectURL(url);
                this._pendingRevocations.delete(url);
                if (this._activeURL === url) this._activeURL = null;
                log.debug(`[BlobURL] Successfully revoked: ${url}`);
            } catch (e) {
                log.warn(`[BlobURL] Revocation failed:`, e);
            }
        }, DELAY.BLOB_REVOCATION);
    },

    /**
     * Revoke the current active URL.
     * Called by cleanupState() when stopping/resetting.
     */
    revoke: function () {
        if (this._activeURL) {
            this.safeRevoke(this._activeURL);
        }
    }
};

// ============================================================================
// [SECTION] NETWORK STATE - PeerJS
// Dependencies: PeerJS CDN
// ============================================================================
let myId = null, peer = null, hostConn = null;
window.hostConn = null; // Expose for inline onclick handlers (e.g. demo button in Help modal)
let localOffset = 0;
let autoSyncOffset = 0; // NEW: Store the Auto-Sync (Latency) Offset in Seconds
let usePingCompensation = true; // Default: apply RTT/2 compensation (set false for local network)
let myDeviceLabel = 'HOST'; // Store my label for UI updates
let lastLatencyMs = 0; // Store Median RTT (Robust)
let latencyHistory = []; // Buffer to filter noise
let syncRequestTime = 0; // Capture exact time of sync request

let connectedPeers = [];
let isOperator = false;
let deviceCounter = 0; // Host-side counter for unique device names
const peerLabels = {}; // Key: PeerID, Value: "DEVICE X"
let isIntentionalDisconnect = false;
let isConnecting = false;

// Beta Relay State
let upstreamDataConn = null; // Connection to receive file chunks from (Host or Relay info)
let downstreamDataPeers = []; // Peers I need to forward file chunks to
const MAX_DIRECT_DATA_PEERS = 2; // Host sends data to max 2 people directly

// [SECTION] RELAY MANAGEMENT - Queue & Back-pressure
let relayChunkQueue = [];
let isRelaying = false;
const MAX_BUFFER_THRESHOLD = 65536; // 64KB

// ============================================================================
// [SECTION] CONSTANTS
// ============================================================================
const CHUNK_SIZE = 16384; // 16KB per chunk
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100MB
const RELAY_MONITOR_INTERVAL = 10000; // 10 seconds
const ENDED_CHECK_THROTTLE = 500; // 500ms throttle for handleEnded
const WATCHDOG_TIMEOUT = 12000; // 12 seconds for chunk watchdog

// Delay constants (ms)
const DELAY = {
    TICK: 10,             // Micro-yield for main thread breathing
    BACKPRESSURE: 50,     // Backpressure polling interval
    UI_REFRESH: 100,      // UI state refresh / short debounce
    RETRY: 200,           // Retry / reconnection pause
    TRANSITION: 300,      // UI transition / animation settling
    DEBOUNCE: 500,        // Standard debounce / throttle
    CONNECTION_CHECK: 500, // Peer connection readiness check
    BLOB_REVOCATION: 10000, // BlobURL revocation safety delay
    JOIN_TIMEOUT: 10000,  // Max wait for peer.open
    RECOVERY_COOLDOWN: 5000, // Rate-limit recovery requests
};

const MSG = {
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
    VBASS: 'vbass',
    VOLUME: 'volume',
    WELCOME: 'welcome',
    YOUTUBE_PLAY: 'youtube-play',
    YOUTUBE_PLAYLIST_INFO: 'youtube-playlist-info',
    YOUTUBE_STATE: 'youtube-state',
    YOUTUBE_SUB_TITLE_UPDATE: 'youtube-sub-title-update',
    YOUTUBE_SYNC: 'youtube-sync',
};

// ============================================================================
// [SECTION] FILE TRANSFER STATE
// ============================================================================
const TRANSFER_STATE = {
    IDLE: 'IDLE',
    RECEIVING: 'RECEIVING',
    PROCESSING: 'PROCESSING',
    READY: 'READY'
};
let transferState = TRANSFER_STATE.IDLE;
let incomingChunks = [];
let receivedCount = 0;
let meta = {};
let _isProcessingBlob = false;

// ============================================================================
// [SECTION] OPFS STATE
// ============================================================================
let currentFileOpfs = { name: null };
let preloadFileOpfs = { name: null };

// ============================================================================
// [SECTION] INTERNAL FLAGS (previously attached to window._)
// ============================================================================
let _activeBroadcastSession = null;
let _currentYouTubeSessionId = null;
let _lastEndedCheck = 0;
let _pendingFileIndex = undefined;
let _pendingPlayTime = undefined;
let _preloadAckSent = false;
let _preloadUsedForIndex = null;
let _preloadWatchdog = null;
let _recoveryInProgress = {};
let _recoveryLastRequest = {};
let _skipIncomingFile = false;
let _skipIncomingPreload = false;
let _waitingForPreload = false;
let _waitingForRelayData = false;
let _ytIOSWatchdog = null;
let _ytLoadTimeout = null;
let _ytScriptLoading = false;

// ============================================================================
// [SECTION] YOUTUBE STATE
// ============================================================================
let currentYouTubeSubIndex = -1;
let youtubeSubItemsMap = {}; // playlistId -> { ids: [], titles: [] }
let currentFileBlob = null; // Cache for serving late joiners

// ============================================================================
// [SECTION] PLAYLIST STATE
// ============================================================================
let playlist = [];
let currentTrackIndex = -1;
let repeatMode = 0;
let isShuffle = false;
let isFirstTrackLoad = true;  // Track if this is the first file load

// ============================================================================
// [SECTION] VIDEO STATE
// ============================================================================

const videoElement = document.getElementById('main-video');

// ============================================================================
// [SECTION] PRELOAD STATE
// ============================================================================
// Host Side
let nextTrackIndex = -1;
let nextFileBlob = null;
let isPreloading = false;
let nextMeta = null; // Store metadata for preloaded file
let preloadSessionId = 0; // Session ID for cancellation support
let currentTransferSessionId = 0; // [NEW] Active transfer session ID to prevent competitive conditions
let _currentLoadToken = 0; // Token to invalidate async load operations when track changes

// Network initialization is deferred to DOMContentLoaded (see listener below)

// Guest Side
let preloadCount = 0;
let preloadMeta = null;
let localTransferSessionId = 0; // [NEW] Track active transfer session on Guest side
// Session-based state management
const preloadSessionState = new Map(); // sessionId -> { skipped, progress, total }

let globalSessionCounter = Math.floor(Date.now() / 1000); // Robust Session ID Start
function nextSessionId() {
    return ++globalSessionCounter;
}

// OPFS Helper coordination (now handled by worker)
// Async Cleanup with Worker Acknowledgment
async function cleanupOPFSInWorker(filename, isPreload) {
    if (!filename) return;

    return new Promise((resolve) => {
        const cleanupId = Date.now() + Math.random();
        const handler = (e) => {
            if (e.data.type === 'OPFS_CLEANUP_COMPLETE' && e.data.filename === filename) {
                transferWorker.removeEventListener('message', handler);
                resolve();
            }
        };
        transferWorker.addEventListener('message', handler);
        postWorkerCommand({ command: 'OPFS_CLEANUP', filename, isPreload });

        // Safety fallback: Continue if worker takes too long
        setTimeout(() => {
            transferWorker.removeEventListener('message', handler);
            resolve();
        }, 1500);
    });
}

// Helper: Clear metadata for upcoming preload (Host side) or current preload (Guest side)
function clearPreloadState() {
    // Protect the blob that is currently being transitioned to
    // If we clear this while a relay peer is requesting it, the relay fails.
    const isNextTrackActive = nextMeta && (nextMeta.index === currentTrackIndex);

    // Don't reset if preload is almost complete (90%+)
    if (preloadMeta && preloadMeta.total > 0) {
        const progress = preloadCount / preloadMeta.total;
        if (progress > 0.9 && progress < 1.0) {
            log.warn(`[Preload] Skipping reset - almost complete (${Math.round(progress * 100)}%)`);
            return;
        }
    }

    // Host side
    nextTrackIndex = -1;
    if (!isNextTrackActive) {
        nextFileBlob = null;
        nextMeta = null;
    }
    isPreloading = false;

    // Guest side
    preloadCount = 0;
    if (!isNextTrackActive) {
        preloadMeta = null;
    }
    _skipIncomingPreload = false;

    // Keep UI state in sync with Worker RESET
    preloadFileOpfs.name = null;

    // We do NOT call cleanupOPFSInWorker here anymore because it was deleting files
    // that were about to be played.

    // However, we SHOULD reset the worker lock so it can accept the NEXT preload
    postWorkerCommand({ command: 'OPFS_RESET', isPreload: true });
}

// Explicit OPFS physical file deletion (call only when really needed)
function forceCleanupOPFS(isPreload) {
    if (isPreload) {
        if (preloadFileOpfs.name) {
            cleanupOPFSInWorker(preloadFileOpfs.name, true);
            preloadFileOpfs.name = null;
        }
    } else {
        if (currentFileOpfs.name) {
            cleanupOPFSInWorker(currentFileOpfs.name, false);
            currentFileOpfs.name = null;
        }
    }
}

const syncWorker = new Worker('js/sync.worker.js');
const transferWorker = new Worker('js/transfer.worker.js');

// Initialize both workers directly (routing only sends to one)
syncWorker.postMessage({ command: 'INIT_INSTANCE', instanceId: OPFS_INSTANCE_ID });
transferWorker.postMessage({ command: 'INIT_INSTANCE', instanceId: OPFS_INSTANCE_ID });

const handleWorkerError = (e) => {
    log.error("[Worker Error]", e.message, e.filename, e.lineno);
    showToast("워커 작업 중 오류 발생!");
};

syncWorker.onerror = handleWorkerError;
transferWorker.onerror = handleWorkerError;

const handleWorkerMessage = async (e) => {
    try {
        const data = e.data;
        if (data.type === 'TICK') {
            const id = data.id;
            if (id === MSG.HEARTBEAT) {
                if (hostConn && typeof hostConn.send === 'function' && hostConn.open) {
                    hostConn.send({ type: MSG.HEARTBEAT });
                }
            } else if (id === 'ping') {
                if (hostConn && typeof hostConn.send === 'function' && hostConn.open) {
                    hostConn.send({ type: MSG.PING_LATENCY, timestamp: Date.now() });
                }
            } else if (id === 'video-sync') {
                checkVideoSync();
            }
        }
        else if (data.type === 'OPFS_FILE_READY') {
            log.debug(`[Main] File ready in OPFS: ${data.filename} (${data.isPreload ? 'preload' : 'current'})`);

            // Re-retrieve file handle in main thread to get the File object
            // (Handles are serialized shared state in some browsers,
            // but getting a fresh one from root is always safe)
            const root = await navigator.storage.getDirectory();
            // Use Instance ID for filename matching
            const safeName = (data.isPreload ? "preload_" : "current_") + data.filename.replace(/[^a-z0-9._-]/gi, '_') + "_" + OPFS_INSTANCE_ID;

            const fileHandle = await root.getFileHandle(safeName);
            const file = await fileHandle.getFile();

            if (data.isPreload) {
                nextFileBlob = file;
                const sessionState = preloadSessionState.get(data.sessionId);
                nextMeta = sessionState || preloadMeta; // session-scoped fallback
                nextTrackIndex = nextMeta?.index;

                // Dedup: Only send ack once per index
                if (hostConn && typeof hostConn.send === 'function' && hostConn.open && nextTrackIndex !== undefined) {
                    if (!_preloadAckSent) _preloadAckSent = new Set();
                    if (!_preloadAckSent.has(nextTrackIndex)) {
                        _preloadAckSent.add(nextTrackIndex);
                        hostConn.send({ type: MSG.PRELOAD_ACK, index: nextTrackIndex });
                        log.debug(`[Guest] Sent preload-ack for index ${nextTrackIndex}`);
                    }
                }

                if (_waitingForPreload && _pendingFileIndex === nextTrackIndex) {
                    log.debug("[Worker-OPFS] Guest was waiting for this track. Playing now.");
                    _waitingForPreload = false;
                    showLoader(false);
                    _currentLoadToken++;
                    loadPreloadedTrack(nextTrackIndex, _currentLoadToken);
                }
            } else {
                // Check session ID if available (data.sessionId)
                currentFileBlob = file;
                _waitingForRelayData = false;
                finalizeFileProcessing(file);
            }
        }
        else if (data.type === 'OPFS_READ_COMPLETE') {
            const { chunk, index, filename, requestId, sessionId } = data;
            const peerId = requestId; // We used peerId as requestId

            // Session guard: discard stale catch-up chunks from old track
            if (sessionId && sessionId < localTransferSessionId) {
                log.warn(`[OPFS_READ] Stale session chunk discarded (got ${sessionId}, current ${localTransferSessionId})`);
                return;
            }

            const dConn = downstreamDataPeers.find(p => p.peer === peerId);
            if (dConn && dConn.open) {
                // Use Relay Queue for recovered chunks to enforce back-pressure
                // Include metadata for downstream peers that missed file-start
                relayChunkQueue.push({
                    type: MSG.FILE_CHUNK,
                    chunk,
                    index,
                    sessionId,
                    total: meta?.total,
                    name: meta?.name || filename,
                    targetPeerId: peerId
                });
                processRelayQueue();
            }
        }
        else if (data.type === 'OPFS_ERROR' || data.type === 'OPFS_READ_ERROR') {
            log.error(`[Worker-OPFS] Error for ${data.filename}:`, data.error);
            if (data.type === 'OPFS_ERROR') showToast(`파일 저장 오류: ${data.filename}`);
        }
        // Handle Session ID mismatch notifications from Worker
        else if (data.type === 'SESSION_MISMATCH') {
            log.warn(`[Main] Session Mismatch in ${data.command}: expected=${data.expected}, got=${data.received}, file=${data.filename}`);

            // [Enhanced Fix] Dampen resync loops: 
            // If expected is null, it means the worker wasn't in an active session (e.g. churn).
            // Requesting a resync here often triggers an infinite loop if the Host is skipped again.
            if (data.expected === null) {
                log.debug(`[Main] Ignoring resync for null-session mismatch (Host churn)`);
                return;
            }

            // If mismatch detected for current file, try to resync with Host
            if (!data.filename?.includes('preload') && hostConn && typeof hostConn.send === 'function' && hostConn.open) {
                log.debug(`[Main] Requesting resync due to session mismatch`);
                hostConn.send({ type: MSG.GET_SYNC_TIME });
            }
        }
    } catch (err) {
        log.error('[Worker Message] Processing error:', err);
        showToast('워커 메시지 처리 중 오류');
    }
};

syncWorker.onmessage = handleWorkerMessage;
transferWorker.onmessage = handleWorkerMessage;

async function finalizeFileProcessing(file) {
    // Always use Buffer Mode for audio processing
    log.debug(`[Guest] Finalizing with Buffer Mode...`);
    showLoader(true, "오디오 메모리 로드 중...");

    try {
        await initAudio();
        if (Tone.context.state === 'suspended') await Tone.start();

        // 1. Convert to ArrayBuffer and decode (ensures high-precision sync)
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer);

        // 2. Store in global variable
        if (currentAudioBuffer) currentAudioBuffer = null; // Encourage GC
        currentAudioBuffer = audioBuffer;

        // 3. Set engine mode dynamically based on file type
        const isVideo = isMediaVideo(file, meta);

        log.debug(`[Guest] Auto-detecting mode: ${isVideo ? 'VIDEO' : 'AUDIO'} (Type: ${file.type || meta?.mime}, Name: ${meta?.name})`);
        setEngineMode(isVideo ? 'video' : 'audio');

        // 4. Video element used only for visual sync (muted)
        const url = BlobURLManager.create(file);
        videoElement.src = url;
        videoElement.muted = true; // Audio handled by Tone.js

        // Set currentFileBlob on Guest as well so hasBlob checks work in sync logic
        currentFileBlob = file;

        videoElement.addEventListener('loadedmetadata', function _onMetaLoaded() {
            videoElement.removeEventListener('loadedmetadata', _onMetaLoaded);
            // Duration based on accurate audio buffer
            document.getElementById('seek-slider').max = audioBuffer.duration;
            document.getElementById('seek-slider').value = 0;
            document.getElementById('time-dur').innerText = fmtTime(audioBuffer.duration);
            BlobURLManager.confirm(file);
        });
        videoElement.load();

        document.getElementById('play-btn').disabled = !isOperator;

        showLoader(false);
        clearManagedTimer('chunkWatchdog');
        pausedAt = 0;
        updatePlayState(false);
        showToast("재생 준비 완료");

        setTimeout(() => {
            if (hostConn && hostConn.open) {
                hostConn.send({ type: MSG.GET_SYNC_TIME });
            } else {
                syncReset();
            }
        }, 1000);

        if (_pendingPlayTime !== undefined) {
            const target = _pendingPlayTime + localOffset + autoSyncOffset;
            log.debug(`[Guest] Found pending play time after download, starting at ${target.toFixed(2)}s`);
            play(target);
            _pendingPlayTime = undefined;
        }

        // Reset state to READY so that subsequent preloads can show UI
        transferState = TRANSFER_STATE.READY;

    } catch (e) {
        log.error("[Guest] Decoding failed", e);
        showToast("오디오 디코딩 실패!");
        showLoader(false);

    }
}

// --- Theme Logic ---
function setTheme(mode) {
    let theme = mode;
    if (mode === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        theme = prefersDark ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-opt').forEach(el => el.classList.remove('active'));
    document.getElementById(`theme-${mode}`).classList.add('active');
    localStorage.setItem('musixquare-theme', mode);
}

(function initTheme() {
    const saved = localStorage.getItem('musixquare-theme') || 'system';
    setTheme(saved);
})();

// --- Tab Switching ---
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    const tabs = ['play', 'playlist', 'connect', 'settings'];
    const idx = tabs.indexOf(tabId);
    if (idx >= 0) document.querySelectorAll('.nav-item')[idx].classList.add('active');

    // YouTube mode toast when entering settings
    if (tabId === 'settings' && currentState === APP_STATE.PLAYING_YOUTUBE) {
        showToast("YouTube 같이 보기 - 고급 오디오 효과가 비활성화됩니다");
    }

    // FIX: YouTube Black Screen - Force refresh container when switching to 'play' tab
    if (tabId === MSG.PLAY && currentState === APP_STATE.PLAYING_YOUTUBE) {
        // Use timeout to ensure tab transition is complete
        setTimeout(() => refreshYouTubeDisplay(), 50);
    }

    // Chat drawer logic (previously in a separate wrapper)
    if (isChatDrawerOpen) {
        toggleChatDrawer();
    }
}

// --- Audio System (Tone.js) ---
async function initAudio() {
    if (Tone.context.state !== 'running') await Tone.start();
    if (masterGain) return; // Already Initialized

    // 2. Channel & Stereo Processing
    toneSplit = new Tone.Split();
    toneMerge = new Tone.Merge();
    gainL = new Tone.Gain(1);
    gainR = new Tone.Gain(1);

    toneSplit.connect(gainL, 0); // L -> gainL
    toneSplit.connect(gainR, 1); // R -> gainR

    // Default Routing: Stereo (L->0, R->1 of merge)
    gainL.connect(toneMerge, 0, 0);
    gainR.connect(toneMerge, 0, 1);

    // 3. Effects Chain
    masterGain = new Tone.Gain(1);

    // EQ (5-Band) - Using 5 Peaking Filters
    const freqs = [60, 230, 910, 3600, 14000];
    eqNodes = freqs.map(f => {
        const filt = new Tone.Filter({
            type: "peaking",
            frequency: f,
            Q: 1.0,
            gain: 0
        });
        return filt;
    });

    // Preamplifier
    preamp = new Tone.Gain(1);
    widener = new Tone.StereoWidener(1);

    // Reverb
    reverb = new Tone.Reverb({
        decay: 5.0,
        preDelay: 0.1
    });
    reverb.wet.value = 1; // 100% Wet for parallel routing
    await reverb.generate();

    // Damping & Mixing (New)
    // Smooth filters (-12dB/oct) for natural sound
    rvbLowCut = new Tone.Filter(20, "highpass", -12);
    rvbHighCut = new Tone.Filter(20000, "lowpass", -12);
    rvbCrossFade = new Tone.CrossFade(0); // Initially Dry

    // 4. Virtual Bass Chain (The "Secret Sauce")
    // Parallel Path: Source -> LPF -> Chebyshev -> Gain -> Master
    vbFilter = new Tone.Filter(subFreq, "lowpass"); // Dynamic Crossover
    vbCheby = new Tone.Chebyshev(50); // Harmonics Generator
    vbGain = new Tone.Gain(0); // Mix Level

    // Connections
    // New Order: Player -> Widener -> Preamp -> Split -> (Channel Logic) -> Merge -> EQ -> Reverb -> Master

    // 1. Pre-Processing (Stereo Width & Preamp)
    // Audio is handled via Tone.js (Buffer Mode)
    widener.connect(preamp);

    // 2. Channel Splitting
    preamp.connect(toneSplit);

    // toneSplit connects to gainL/gainR (already set above: toneSplit.connect(gainL, 0)...)
    // gainL/gainR connect to toneMerge (managed by setChannelMode)

    // 3. Post-Processing (EQ & Reverb after Merge)
    // Chain: Merge -> GlobalLowPass -> EQ -> Reverb -> Master
    globalLowPass = new Tone.Filter(20000, "lowpass"); // Default Open

    toneMerge.connect(globalLowPass);
    let eqIn = globalLowPass;
    eqNodes.forEach(fx => {
        eqIn.connect(fx);
        eqIn = fx;
    });

    // [Wet/Dry Routing with Damping]
    // 1. Dry Path
    eqIn.connect(rvbCrossFade.a);

    // 2. Wet Path (Reverb -> LowCut -> HighCut -> CrossFade)
    eqIn.connect(reverb);
    reverb.connect(rvbLowCut);
    rvbLowCut.connect(rvbHighCut);
    rvbHighCut.connect(rvbCrossFade.b);

    // 3. Output
    rvbCrossFade.connect(masterGain);

    // 4. Virtual Bass Chain (Parallel from Preamp)
    // Tapping after Preamp means it gets the Widened & Boosted signal
    preamp.connect(vbFilter);
    vbFilter.connect(vbCheby);
    vbCheby.connect(vbGain);
    vbGain.connect(masterGain);

    // Visualizer
    analyser = new Tone.Analyser("fft", 2048);
    analyser.smoothing = 0.3; // Lower = more immediate/punchy response
    masterGain.connect(analyser);
    masterGain.toDestination();

    // Initial Defaults
    applySettings();
}

// --- Onboarding Logic ---
let obCurrentSlide = 0;

function initOnboarding() {
    // 1. Determine Type
    const params = new URLSearchParams(window.location.search);
    const hostId = params.get('host');

    // [Critical Fix for LTE] Pre-fill ID immediately.
    // waiting for peer.on('open') is too slow on mobile networks.
    if (hostId) {
        document.getElementById('join-id-input').value = hostId;
    }

    const actionArea = document.getElementById('ob-actions');

    if (hostId) {
        // [Popup B] Guest Mode
        actionArea.innerHTML = `
            <button class="btn-ob-primary" onclick="actionEnterSession()">모임에 초대됐어요!</button>
        `;
    } else {
        // [Popup A] New User
        actionArea.innerHTML = `
            <button class="btn-ob-primary" onclick="actionCreateRoom()">방 만들기</button>
            <button class="btn-ob-secondary" onclick="actionJoinRoom()">참여하기</button>
        `;
    }
}

window.goToSlide = function (idx) {
    obCurrentSlide = idx;
    const track = document.getElementById('ob-track');
    const dots = document.querySelectorAll('.ob-dot');

    track.style.transform = `translateX(-${idx * 100}%)`;

    dots.forEach((d, i) => {
        d.classList.toggle('active', i === idx);
    });
};

window.nextSlide = function () {
    if (obCurrentSlide < 2) goToSlide(obCurrentSlide + 1);
    else goToSlide(0); // Optional loop
};

window.prevSlide = function () {
    if (obCurrentSlide > 0) goToSlide(obCurrentSlide - 1);
};

/* Actions */
let wakeLock = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            log.debug('Screen Wake Lock active');
            wakeLock.addEventListener('release', () => {
                log.debug('Screen Wake Lock released');
                wakeLock = null; // Explicitly null to allow recovery on visibilitychange
            });
        }
    } catch (err) {
        log.warn(`${err.name}, ${err.message}`);
    }
}

// Re-request wake lock when visibility changes
document.addEventListener('visibilitychange', async () => {
    if (wakeLock === null && document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});

async function activateAudio() {
    // 1. Start Tone.js Context (User Gesture)
    if (Tone.context.state !== 'running') {
        await Tone.start();
    }

    // 2. Initialize Graph
    // initAudio Checks if player exists, but calling it ensures setup
    await initAudio();
    initMediaSession();

    // 3. Silent Mode Bypass (iOS) - Play HTML5 Audio + Video Unlock
    const silentAudio = document.getElementById('silent-trigger');
    if (silentAudio) {
        silentAudio.play().catch(e => log.debug("Silent Audio play failed", e));
    }

    if (videoElement) {
        // [iOS Protection] Briefly play and pause video to unlock programmatic control later
        videoElement.play().then(() => {
            videoElement.pause();
        }).catch(e => log.debug("Video unlock failed", e));
    }

    // 4. Wake Lock
    requestWakeLock();
}

window.actionCreateRoom = async function () {
    await activateAudio();
    // Using setTimeout to allow UI update if needed, but alert blocks anyway.
    setTimeout(() => {
        alert("이제 당신이 호스트입니다.\n다른 사람을 초대하거나 다른 기기를 추가하려면\n'Connect' 탭의 QR코드 또는 링크를 공유하세요.");
        document.getElementById('onboarding-overlay').style.display = 'none';
        switchTab('connect');

        // [RESTORED] Visual Update
        myDeviceLabel = 'HOST';
        updateRoleBadge();
    }, 50);
};

window.actionJoinRoom = async function () {
    await activateAudio();
    setTimeout(() => {
        alert("호스트가 제공한 QR코드나 링크를 통해 접속하세요.\n'Connect' 탭에서 링크(ID)를 수동으로 입력하여 접속하실 수도 있습니다.");
        document.getElementById('onboarding-overlay').style.display = 'none';
        switchTab('connect');

        // [RESTORED] Visual Update
        myDeviceLabel = 'HOST';
        updateRoleBadge();
    }, 50);
};

window.actionEnterSession = async function () {
    await activateAudio();
    document.getElementById('onboarding-overlay').style.display = 'none';

    // [RESTORED] Visual Update
    myDeviceLabel = 'GUEST';
    updateRoleBadge();

    joinSession(); // This handles the connection and logic
    switchTab('play'); // Guest goes to visualizer
};

/**
 * [RESTORED] UI Update Logic for Status Pill
 */
function updateRoleBadge() {
    const badge = document.getElementById('role-badge');
    const text = document.getElementById('role-text');

    if (!badge || !text) return;

    // 1. Reset
    badge.classList.remove('connected');

    // 2. Update based on state
    if (isConnecting) {
        text.innerText = '연결 중...';
        // Keep the idle look or use a neutral color
    } else if (hostConn) {
        // Guest Mode
        text.innerText = 'GUEST';
        badge.classList.add('connected');
    } else if (connectedPeers.length > 0 || myDeviceLabel === 'HOST') {
        // Host Mode (connected or just started)
        text.innerText = 'HOST';
        badge.classList.add('connected');
    } else {
        // Offline / Setup
        text.innerText = 'OFFLINE';
    }
}

// Wrapper function to check guest before triggering file input
function openFileSelector() {
    if (hostConn) {
        showToast("Host만 실행할 수 있습니다.");
        return;
    }
    document.getElementById('file-input').click();
}

// Auto-run init
function initEventListeners() {
    // Helper: safely bind events by ID (null-safe)
    const $on = (id, evt, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); };

    // --- Header ---
    $on('btn-help', 'click', openHelpModal);
    $on('btn-fullscreen', 'click', toggleFullscreen);

    // --- Player Controls ---
    $on('btn-prev', 'click', playPrevTrack);
    $on('play-btn', 'click', togglePlay);
    $on('btn-next', 'click', playNextTrack);
    $on('vol-icon-btn', 'click', toggleMute);
    $on('volume-slider', 'input', function () { onVolInput(this.value); });
    $on('volume-slider', 'change', function () { onVolChange(this.value); });
    $on('chat-preview-btn', 'click', toggleChatDrawer);
    $on('btn-sync', 'click', handleManualSync);
    $on('btn-media-source', 'click', openMediaSourcePopup);

    // --- Playlist Tab ---
    $on('btn-repeat', 'click', toggleRepeat);
    $on('btn-shuffle', 'click', toggleShuffle);
    $on('btn-add-media', 'click', openMediaSourcePopup);

    // --- Connect Tab ---
    $on('btn-copy-link', 'click', copyLink);
    $on('btn-leave-session', 'click', leaveSession);
    $on('btn-join', 'click', joinSession);

    // --- Settings: Theme ---
    $on('theme-light', 'click', () => setTheme('light'));
    $on('theme-dark', 'click', () => setTheme('dark'));
    $on('theme-system', 'click', () => setTheme('system'));

    // --- Settings: Surround Mode ---
    $on('chk-surround', 'change', function () { toggleSurroundMode(this.checked); });

    // --- Settings: Channel Grid (Standard) ---
    document.querySelectorAll('#grid-standard .ch-opt[data-ch]').forEach(el => {
        el.addEventListener('click', () => setChannel(parseInt(el.dataset.ch), el));
    });

    // --- Settings: Surround Grid (7.1) ---
    document.querySelectorAll('#grid-surround .ch-opt[data-sch]').forEach(el => {
        el.addEventListener('click', () => setSurroundChannel(parseInt(el.dataset.sch), el));
    });

    // --- Settings: Subwoofer Cutoff ---
    $on('cutoff-slider', 'input', function () { updateSettings('cutoff', this.value); });
    $on('cutoff-slider', 'dblclick', function () { updateSettings('cutoff', 120); this.value = 120; });

    // --- Settings: Reverb ---
    $on('btn-reset-reverb', 'click', resetReverb);
    const reverbSliders = [
        { id: 'reverb-slider', param: 'mix', resetVal: 0 },
        { id: 'reverb-decay-slider', param: 'decay', resetVal: 5.0 },
        { id: 'reverb-predelay-slider', param: 'predelay', resetVal: 0.1 },
        { id: 'reverb-lowcut-slider', param: 'lowcut', resetVal: 0 },
        { id: 'reverb-highcut-slider', param: 'highcut', resetVal: 0 },
    ];
    reverbSliders.forEach(({ id, param, resetVal }) => {
        $on(id, 'input', function () { updateAudioEffect('reverb', param, this.value, true); });
        $on(id, 'change', function () { updateAudioEffect('reverb', param, this.value); });
        $on(id, 'dblclick', function () { updateAudioEffect('reverb', param, resetVal); });
    });

    // --- Settings: EQ ---
    $on('btn-reset-eq', 'click', resetEQ);
    $on('preamp-slider', 'input', function () { setPreamp(this.value, true); });
    $on('preamp-slider', 'change', function () { setPreamp(this.value); });
    $on('preamp-slider', 'dblclick', () => setPreamp(0));
    for (let i = 0; i < 5; i++) {
        $on(`eq-slider-${i}`, 'input', function () { setEQ(i, this.value, true); });
        $on(`eq-slider-${i}`, 'change', function () { setEQ(i, this.value); });
        $on(`eq-slider-${i}`, 'dblclick', () => setEQ(i, 0));
    }

    // --- Settings: Stereo Width ---
    $on('width-slider', 'input', function () { updateAudioEffect('stereo', 'mix', this.value, true); });
    $on('width-slider', 'change', function () { updateAudioEffect('stereo', 'mix', this.value); });
    $on('width-slider', 'dblclick', resetStereo);

    // --- Settings: Virtual Bass ---
    $on('vbass-slider', 'input', function () { updateAudioEffect('vbass', 'mix', this.value, true); });
    $on('vbass-slider', 'change', function () { updateAudioEffect('vbass', 'mix', this.value); });
    $on('vbass-slider', 'dblclick', () => updateAudioEffect('vbass', 'mix', 0));

    // --- Chat Drawer ---
    $on('btn-chat-close', 'click', toggleChatDrawer);
    $on('btn-chat-send', 'click', sendChatMessage);

    // --- Bottom Navigation ---
    document.querySelectorAll('.bottom-nav .nav-item[data-tab]').forEach(el => {
        el.addEventListener('click', () => switchTab(el.dataset.tab));
    });

    // --- Help Modal ---
    $on('help-modal', 'click', (e) => closeHelpModal(e));
    $on('btn-help-close', 'click', closeHelpModal);
    $on('btn-demo', 'click', () => { loadDemoMedia(); if (!window.hostConn) closeHelpModal(); });

    // --- Onboarding ---
    $on('ob-arrow-left', 'click', prevSlide);
    $on('ob-arrow-right', 'click', nextSlide);
    document.querySelectorAll('#ob-dots .ob-dot[data-slide]').forEach(el => {
        el.addEventListener('click', () => goToSlide(parseInt(el.dataset.slide)));
    });

    // --- Manual Sync Popup ---
    $on('btn-nudge-minus10', 'click', () => nudgeSync(-10));
    $on('btn-nudge-minus1', 'click', () => nudgeSync(-1));
    $on('btn-nudge-plus1', 'click', () => nudgeSync(1));
    $on('btn-nudge-plus10', 'click', () => nudgeSync(10));
    $on('btn-auto-sync', 'click', handleAutoSync);
    $on('btn-sync-done', 'click', closeManualSync);

    // --- Media Source Popup ---
    $on('btn-local-file', 'click', () => { closeMediaSourcePopup(); openFileSelector(); });
    $on('btn-youtube-source', 'click', () => { closeMediaSourcePopup(); openYouTubePopup(); });
    $on('btn-close-media-popup', 'click', closeMediaSourcePopup);

    // --- YouTube URL Popup ---
    $on('youtube-url-input', 'input', function () { fetchYouTubePreview(this.value); });
    $on('btn-yt-cancel', 'click', closeYouTubePopup);
    $on('youtube-play-btn', 'click', loadYouTubeFromInput);
}

document.addEventListener('DOMContentLoaded', () => {
    initOnboarding();
    initEventListeners();
    initNetwork(); // Deferred from top-level to ensure DOM and UI functions are ready
});

// --- Playlist & Player Logic ---
document.getElementById('file-input').addEventListener('change', async (e) => {
    // File upload is Host-only (OP cannot relay file data to other guests)
    if (hostConn) return showToast("Host만 파일을 추가할 수 있습니다.");

    // Initialize AudioContext immediately on user gesture
    try {
        if (Tone.context.state !== 'running') await Tone.start();
        await initAudio();
    } catch (err) { log.error(err); }

    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    files.forEach(f => playlist.push({ type: 'local', file: f, name: f.name }));
    updatePlaylistUI();

    const metaList = playlist.map(item => ({
        type: item.type,
        name: item.name || item.title,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null
    }));
    broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });

    // Clear all cache metadata on Host side when playlist structure changes
    connectedPeers.forEach(p => { if (p.preloadedIndexes) p.preloadedIndexes.clear(); });
    log.debug("[Host] Playlist changed, cleared all peer cache tracking");

    if (currentTrackIndex === -1) {
        playTrack(0);
    } else {
        showToast(`${files.length}곡 추가됨`);

        // Re-evaluate preload when new songs are added
        // Case 1: No preload queued yet -> trigger
        // Case 2: Current preload target is outdated (was looping to 0, but now there are new songs) -> re-trigger
        // Removed !isPreloading check to ensure we interrupt 'loop loop' to preload the NEW song immediately
        const wasLastTrack = (currentTrackIndex === playlist.length - files.length - 1);
        const shouldRePreload = (nextTrackIndex === -1 || wasLastTrack);

        if (shouldRePreload) {
            // Clear previous preload state if any
            if (nextTrackIndex !== -1) {
                log.debug("[Preload] New songs added, re-evaluating next track...");
                clearPreloadState();
            }
            preloadNextTrack();
        }
    }
    // Reset inputs
    e.target.value = '';
});

function toggleRepeat() {
    const nextMode = (repeatMode + 1) % 3;
    setRepeatMode(nextMode);

    // Broadcast if Host or requested by OP
    if (!hostConn) {
        broadcast({ type: MSG.REPEAT_MODE, value: nextMode });
    } else if (isOperator) {
        hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'repeat-mode', value: nextMode });
    }
}

function setRepeatMode(mode) {
    repeatMode = mode;
    const btn = document.getElementById('btn-repeat');
    if (!btn) return;

    btn.classList.remove('active', 'active-one');
    if (repeatMode === 1) {
        btn.classList.add('active');
        showToast("반복 재생: 전체");
    } else if (repeatMode === 2) {
        btn.classList.add('active-one');
        showToast("반복 재생: 한 곡");
    } else {
        showToast("반복 재생: 끔");
    }
}

function toggleShuffle() {
    const nextShuffle = !isShuffle;
    setShuffle(nextShuffle);

    // Broadcast if Host or requested by OP
    if (!hostConn) {
        broadcast({ type: MSG.SHUFFLE_MODE, value: nextShuffle });
    } else if (isOperator) {
        hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'shuffle-mode', value: nextShuffle });
    }
}

function setShuffle(enabled) {
    isShuffle = enabled;
    const btn = document.getElementById('btn-shuffle');
    if (btn) {
        btn.classList.toggle('active', isShuffle);
    }
    showToast(isShuffle ? "셔플: 켜짐" : "셔플: 꺼짐");
}

function updatePlaylistUI() {
    const ul = document.getElementById('playlist-ui');
    ul.innerHTML = '';
    if (playlist.length === 0) {
        ul.innerHTML = '<li style="color:var(--text-sub); font-size:13px; text-align:center; padding:20px;">파일이 없습니다.</li>';
        return;
    }

    playlist.forEach((item, idx) => {
        const isCurrent = (idx === currentTrackIndex);
        const li = document.createElement('li');
        li.className = `track-item ${isCurrent ? 'active' : ''} ${item.playlistId ? 'is-playlist' : ''}`;

        // Expansion Toggle for Playlists
        let expandBtn = '';
        if (item.playlistId) {
            expandBtn = `
                <div class="expand-toggle ${item.isExpanded ? 'active' : ''}" onclick="event.stopPropagation(); toggleExpansion(${idx});">
                    <svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>
                </div>
            `;
        }

        const icon = item.type === 'youtube'
            ? '<svg class="type-icon" viewBox="0 0 24 24" style="fill:#ff0000;"><path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47.13 1.33.22 2.65.28 1.3.07 2.49.1 3.59.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z"/></svg>'
            : '<svg class="type-icon" viewBox="0 0 24 24"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.16-1.75 4.45-4H15V6h4V3h-7z"/></svg>';

        const displayName = item.name || item.title || 'Unknown';
        li.onclick = () => {
            if (!hostConn) playTrack(idx);
            else if (isOperator) hostConn.send({ type: MSG.REQUEST_TRACK_CHANGE, index: idx });
        };

        li.innerHTML = `
            <div class="track-idx">${idx + 1}</div>
            <div class="track-name">${icon} ${escapeHtml(displayName)}</div>
            ${expandBtn}
            <div class="playing-indicator">
                <div class="bar"></div>
                <div class="bar"></div>
                <div class="bar"></div>
            </div>
        `;
        ul.appendChild(li);

        // Render Sub-items if expanded
        if (item.playlistId && item.isExpanded) {
            const subUl = document.createElement('ul');
            subUl.className = 'sub-playlist';

            // If we have data about this playlist items
            const subData = youtubeSubItemsMap[item.playlistId];
            if (subData && subData.ids) {
                subData.ids.forEach((sid, sIdx) => {
                    const sli = document.createElement('li');
                    const isActiveSub = (isCurrent && sIdx === currentYouTubeSubIndex);
                    sli.className = `sub-track-item ${isActiveSub ? 'active' : ''}`;

                    const sTitle = (subData.titles && subData.titles[sIdx]) ? subData.titles[sIdx] : `Video ${sIdx + 1}`;
                    sli.innerHTML = `
                        <span class="sub-idx">${sIdx + 1}</span>
                        <span class="sub-name">${escapeHtml(sTitle)}</span>
                        <div class="playing-indicator">
                            <div class="bar"></div>
                            <div class="bar"></div>
                            <div class="bar"></div>
                        </div>
                    `;

                    sli.onclick = (e) => {
                        e.stopPropagation();
                        if (hostConn && !isOperator) return;
                        if (!hostConn) {
                            if (isCurrent && youtubePlayer && youtubePlayer.playVideoAt) {
                                youtubePlayer.playVideoAt(sIdx);
                            } else {
                                // Not playing this playlist yet? Start it at this index.
                                // We'd need to modify loadYouTubeVideo to take a start index.
                                currentYouTubeSubIndex = sIdx;
                                playTrack(idx);
                            }
                        } else {
                            // OP request
                            hostConn.send({ type: MSG.REQUEST_YOUTUBE_SUB_SEEK, playlistIdx: idx, subIdx: sIdx });
                        }
                    };
                    subUl.appendChild(sli);
                });
            } else {
                subUl.innerHTML = '<li class="sub-track-item loading">재생 정보 대기 중...</li>';
            }
            ul.appendChild(subUl);
        }
    });

    // Sync Title/Artist UI Update:
    // Update the main header title and artist text immediately when the playlist UI is updated.
    // This ensures the title always matches the active item even during rapid clicks.
    const currentItem = playlist[currentTrackIndex];
    if (currentItem) {
        const title = currentItem.name || currentItem.title || 'Unknown';
        updateTitleWithMarquee(title);

        const artistEl = document.getElementById('track-artist');
        if (artistEl) {
            if (currentItem.artist) {
                artistEl.innerText = currentItem.artist;
            } else {
                artistEl.innerText = (currentItem.type === 'youtube' && !currentItem.artist) ? 'YouTube Video' : `Track ${currentTrackIndex + 1}`;
            }
        }
    }
}

// --- Media Session API (System Controls) ---
function initMediaSession() {
    if (!('mediaSession' in navigator)) return;

    log.debug("[MediaSession] Initializing action handlers...");

    navigator.mediaSession.setActionHandler('play', () => {
        if (currentState === APP_STATE.IDLE) togglePlay();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
        if (currentState !== APP_STATE.IDLE) togglePlay();
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
        playPrevTrack();
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
        playNextTrack();
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        skipTime(-(details.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
        skipTime(details.seekOffset || 10);
    });

    try {
        navigator.mediaSession.setActionHandler('stop', () => {
            stop();
        });
    } catch (e) { log.debug('[MediaSession] Handler setup skipped:', e.message); }
}

function updateMediaSessionMetadata(item) {
    if (!('mediaSession' in navigator) || !item) return;

    let title = item.name || item.title || 'Unknown Track';
    let artist = item.channel || (item.type === 'youtube' ? 'YouTube' : 'MUSIXQUARE');
    let artwork = [];

    if (item.type === 'youtube') {
        // If it's a playlist item and we have a sub-title, use it
        if (item.playlistId && currentYouTubeSubIndex !== -1) {
            const subData = youtubeSubItemsMap[item.playlistId];
            if (subData && subData.titles[currentYouTubeSubIndex]) {
                title = subData.titles[currentYouTubeSubIndex];
            } else {
                title = `${item.title || 'Playlist'} (${currentYouTubeSubIndex + 1})`;
            }
        }

        if (item.thumbnail) {
            artwork = [{ src: item.thumbnail, sizes: '480x360', type: 'image/jpeg' }];
        }
    } else {
        artwork = [{ src: 'favicon.svg', sizes: '512x512', type: 'image/svg+xml' }];
    }

    navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: artist,
        album: 'MUSIXQUARE',
        artwork: artwork
    });
}

function toggleExpansion(idx) {
    if (playlist[idx]) {
        playlist[idx].isExpanded = !playlist[idx].isExpanded;

        if (playlist[idx].isExpanded && playlist[idx].playlistId) {
            let ids = [];
            let pid = playlist[idx].playlistId;

            // 1. Try to get IDs from current player if it matches
            if (youtubePlayer && youtubePlayer.getPlaylist && playlist[currentTrackIndex] && playlist[currentTrackIndex].playlistId === pid) {
                try {
                    ids = youtubePlayer.getPlaylist() || [];
                } catch (e) { /* YouTube player may not be ready */ }
            }

            // 2. Initial map setup
            if (ids.length > 0) {
                if (!youtubeSubItemsMap[pid]) {
                    youtubeSubItemsMap[pid] = { ids: ids, titles: [] };
                } else if (!youtubeSubItemsMap[pid].ids || youtubeSubItemsMap[pid].ids.length === 0) {
                    youtubeSubItemsMap[pid].ids = ids;
                }
            }

            // 3. Trigger background title fetcher (All roles)
            if (youtubeSubItemsMap[pid] && youtubeSubItemsMap[pid].ids && youtubeSubItemsMap[pid].ids.length > 0) {
                fetchPlaylistSubTitles(pid, youtubeSubItemsMap[pid].ids);
            }

            if (hostConn) {
                // Guest: Request info from Host if map is missing or empty (double check)
                if (!youtubeSubItemsMap[pid] || !youtubeSubItemsMap[pid].ids || youtubeSubItemsMap[pid].ids.length === 0) {
                    hostConn.send({ type: MSG.REQUEST_YOUTUBE_PLAYLIST_INFO, playlistId: pid });
                }
            }
        }
        updatePlaylistUI();
    }
}

// Background fetcher for YouTube titles (No API Key needed)
async function fetchPlaylistSubTitles(playlistId, ids) {
    if (!ids || ids.length === 0) return;

    const data = youtubeSubItemsMap[playlistId];
    if (!data) return;

    if (data._isFetching) return; // Dedupe
    data._isFetching = true;

    log.debug(`[YouTube Feed] Starting title fetch for playlist: ${playlistId} (${ids.length} items)`);

    for (let i = 0; i < ids.length; i++) {
        // Skip if already has title
        if (data.titles[i]) continue;

        try {
            const videoId = ids[i];
            // Sequential fetching with a small delay to avoid rate limiting
            const response = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
            const json = await response.json();

            if (json && json.title) {
                data.titles[i] = json.title;
                log.debug(`[YouTube Feed] Fetched Title [${i}]: ${json.title}`);

                // Update UI
                updatePlaylistUI();

                // Only Host broadcasts to others to keep it centralized
                if (!hostConn) {
                    broadcast({
                        type: MSG.YOUTUBE_SUB_TITLE_UPDATE,
                        playlistId: playlistId,
                        subIdx: i,
                        title: json.title
                    });
                }
            }
        } catch (e) {
            log.warn(`[YouTube Feed] Failed to fetch title for ${ids[i]}:`, e);
        }

        // 200ms delay between requests
        await new Promise(r => setTimeout(r, DELAY.RETRY));
    }
    data._isFetching = false;
}

async function playTrack(index) {
    if (index < 0 || index >= playlist.length) return;

    // FIX: Clear existing autoplay timer to prevent audio overlap
    clearManagedTimer('autoPlayTimer');

    // Auto-switch to Play tab when starting a track (Host only)
    if (!hostConn) switchTab('play');

    _currentLoadToken++;
    const myLoadToken = _currentLoadToken;

    // Check if this track is already preloaded (Host Side Check)
    if (index === nextTrackIndex && nextFileBlob && !hostConn) {
        log.debug("[Host] Using Preloaded Track:", index);
        currentTrackIndex = index;
        updatePlaylistUI();

        // 1. Unified Stop for clean state
        stopAllMedia();

        // 2. Get track info for Guest fallback
        const item = playlist[index];
        const fileName = item?.file?.name || item?.name || `Track ${index}`;

        // 3. Broadcast ONLY play-preloaded command
        broadcast({ type: MSG.PLAY_PRELOADED, index: index, name: fileName, mime: item?.file?.type });

        // 4. Activate preloaded track and play
        await loadPreloadedTrack(index, myLoadToken);
        play(0);
        broadcast({ type: MSG.PLAY, time: 0 }); // Explicitly broadcast play for guests

        // Immediate Auto-Sync (User Request)
        handleMainSyncBtn();

        // Trigger Next Preload
        preloadNextTrack();
        return;
    }

    currentTrackIndex = index;
    updatePlaylistUI();

    const item = playlist[index];
    updateMediaSessionMetadata(item);

    // Route based on type
    if (item.type === 'youtube') {
        // YouTube playback (Host only)
        if (!hostConn) {
            // Stop local playback first (prevent overlap)
            stop();

            // Cancel any running preload immediately
            preloadSessionId++;
            isPreloading = false;

            // IMMEDIATELY broadcast to guests so they switch too
            broadcast({
                type: MSG.YOUTUBE_PLAY,
                videoId: item.videoId,
                playlistId: item.playlistId,
                index: index,
                autoplay: false  // Will send 'play' command separately
            });

            // Same logic as local: first track = wait for button, else = 3s countdown
            if (isFirstTrackLoad) {
                isFirstTrackLoad = false;
                // Load YouTube but DON'T auto-play (playerVars.autoplay will be 0)
                loadYouTubeVideo(item.videoId, item.playlistId, false);
                showToast("YouTube 준비 완료! 재생 버튼을 눌러주세요.");
            } else {
                // Load first (paused), then auto-play after 3s
                loadYouTubeVideo(item.videoId, item.playlistId, false);
                showToast("3초 후 YouTube 재생...");
                managedTimers.autoPlayTimer = setTimeout(() => {
                    managedTimers.autoPlayTimer = null;
                    if (youtubePlayer && youtubePlayer.playVideo) {
                        youtubePlayer.playVideo();
                        // Broadcast play state sync
                        broadcastYouTubeSync();
                    }
                }, 3000);
            }
        }
        return;
    }

    // Local file playback
    // 1. Unified Stop
    stopAllMedia();

    const file = item.file;
    if (!hostConn) {
        // Generate Global Unique Session ID
        const sessionId = nextSessionId();
        currentTransferSessionId = sessionId;

        // Standard Load with Session ID
        broadcast({ type: MSG.FILE_PREPARE, name: file.name, index: index, sessionId: sessionId, mime: file.type });
        await loadAndBroadcastFile(file, sessionId, false, myLoadToken);

        // After loading current, start preloading next
        // preloadNextTrack is already called inside loadAndBroadcastFile (line 773)
        // so we don't need to call it here.

        // AUTO PLAY with 3s Delay - Only on track advancement, not first load
        if (isFirstTrackLoad) {
            isFirstTrackLoad = false;  // Mark first load as done
            showToast("파일 준비 완료! 재생 버튼을 눌러주세요.");
        } else {
            showToast("3초 후 재생 시작...");
            managedTimers.autoPlayTimer = setTimeout(() => {
                managedTimers.autoPlayTimer = null;
                play(0);
                broadcast({ type: MSG.PLAY, time: 0 });
            }, 3000);
        }
    }
}

async function preloadNextTrack() {
    if (playlist.length <= 1) return;

    // Cancel previous preload if running
    if (isPreloading) {
        log.debug("[Preload] Cancelling previous preload session");
    }
    const currentSession = nextSessionId();
    preloadSessionId = currentSession;

    // Determine Next Index logic
    let nextIdx = -1;
    if (playlist.length === 0) {
        nextTrackIndex = -1;
        return;
    }

    if (repeatMode === 2) {
        nextIdx = currentTrackIndex; // Repeat One
    } else if (isShuffle && playlist.length > 1) {
        do {
            nextIdx = Math.floor(Math.random() * playlist.length);
        } while (nextIdx === currentTrackIndex);
    } else if (isShuffle && playlist.length === 1) {
        nextIdx = 0;
    } else {
        nextIdx = currentTrackIndex + 1;
        if (nextIdx >= playlist.length) {
            if (repeatMode === 1) nextIdx = 0; // Loop list
            else nextIdx = -1; // Stop at end (Repeat OFF)
        }
    }

    // Update State
    nextTrackIndex = nextIdx;

    // Guard against invalid index or missing item
    if (nextIdx < 0 || nextIdx >= playlist.length) {
        log.debug("[Preload] No valid next track (end of list or invalid index)");
        isPreloading = false;
        nextFileBlob = null;
        nextMeta = null;
        return;
    }

    const item = playlist[nextIdx];
    if (!item) {
        log.warn("[Preload] Next item is undefined, skipping");
        isPreloading = false;
        return;
    }

    // Skip preload for YouTube items
    if (item.type === 'youtube') {
        log.debug("[Preload] Next is YouTube, skipping preload");
        isPreloading = false;
        // Clear stale preload data so playTrack doesn't think we have a blob for this index
        nextFileBlob = null;
        nextMeta = null;
        return;
    }

    const file = item.file;
    log.debug("[Preload] Starting for:", file.name, "session:", currentSession);
    isPreloading = true;

    // 1. Host Loads Locally (Background)
    // Strategy: Decode small audio immediately, keep large files/video as Blob to save RAM.

    // Host side state tracking: Assign blob and meta locally too
    const total = Math.ceil(file.size / CHUNK_SIZE);
    nextFileBlob = file;
    nextMeta = { name: file.name, index: nextIdx, mime: file.type, total: total, size: file.size, sessionId: currentSession };

    // 2. Broadcast Preload
    // Special function to broadcast without stopping playback
    await broadcastPreloadFile(file, nextIdx, currentSession);

    // Only mark complete if this session wasn't cancelled
    if (preloadSessionId === currentSession) {
        isPreloading = false;
    }
}

// New: Broadcast for Background Preloading
async function broadcastPreloadFile(file, index, sessionId) {
    // Send original file as-is without extraction (memory safe)
    log.debug("[Preload] Broadcasting original file:", file.name);
    await backgroundTransfer(file, index, sessionId);
}

// Transfer without UI blocking
async function backgroundTransfer(file, index, sessionId) {
    const CHUNK = 16384;
    const total = Math.ceil(file.size / CHUNK);
    const header = {
        type: MSG.PRELOAD_START,
        name: file.name,
        mime: file.type,
        total: total,
        size: file.size,
        index: index,
        sessionId: sessionId // Included for tracking/cancellation
    };

    // Transfer to direct data targets (who will relay to others)
    const getTargets = () => {
        return connectedPeers.filter(p =>
            p.status === 'connected' &&
            p.conn.open &&
            p.isDataTarget !== false
        );
    };

    const targets = getTargets();

    if (targets.length === 0) {
        log.debug("[Preload] No active data targets, skipping transfer");
        return;
    }

    // Determine which targets actually need the data chunks
    const targetsWhoNeedChunks = targets.filter(p => !p.preloadedIndexes || !p.preloadedIndexes.has(index));

    // Send header UNICAST so we can tell each peer if we are skipping chunks
    targets.forEach(p => {
        const peerNeedsChunks = !p.preloadedIndexes || !p.preloadedIndexes.has(index);
        if (p.conn.open) {
            // Peer-specific header
            p.conn.send({ ...header, skipped: !peerNeedsChunks });
        }
    });

    const sendToTargets = (msg, chunksOnly = false) => {
        const list = chunksOnly ? targetsWhoNeedChunks : targets;
        list.forEach(p => {
            if (p.conn.open) p.conn.send(msg);
        });
    };

    for (let i = 0; i < total; i++) {
        // Check if this preload session was cancelled
        if (preloadSessionId !== sessionId) {
            log.debug("[Preload] Session cancelled, stopping transfer at chunk", i);
            return;
        }

        // Dynamic Congestion Control for Preload
        // Optimized to 256KB/30ms for maximum throughput with dual-worker architecture
        let congested = true;
        while (congested) {
            congested = false;
            for (const p of targets) {
                if (p.conn.open && p.conn.dataChannel && p.conn.dataChannel.bufferedAmount > 256 * 1024) {
                    congested = true;
                    break;
                }
            }
            if (congested) await new Promise(r => setTimeout(r, DELAY.BACKPRESSURE));
        }

        const start = i * CHUNK;
        const end = Math.min(start + CHUNK, file.size);
        const chunkBlob = file.slice(start, end);
        const chunkBuf = await chunkBlob.arrayBuffer();
        const chunk = new Uint8Array(chunkBuf);

        const chunkMsg = { type: MSG.PRELOAD_CHUNK, chunk: chunk, index: i };
        sendToTargets(chunkMsg, true); // true = send only to those who need chunks
    }

    // Final session check before completing
    if (preloadSessionId === sessionId) {
        sendToTargets({ type: MSG.PRELOAD_END, name: file.name, index: index, sessionId: sessionId });
        log.debug("[Preload] Complete for index:", index);
    }
}


function playNextTrack() {
    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return showToast("Host만 실행할 수 있습니다.");

    // OP: request Host to change track
    if (hostConn && isOperator) {
        hostConn.send({ type: MSG.REQUEST_NEXT_TRACK });
        return;
    }

    // Host: execute directly

    // YouTube Playlist Internal Navigation
    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer && youtubePlayer.getPlaylist) {
        try {
            const playlistIds = youtubePlayer.getPlaylist() || [];
            const currentIndex = youtubePlayer.getPlaylistIndex();

            if (playlistIds.length > 0 && currentIndex < playlistIds.length - 1) {
                log.debug("[YouTube] Next internal video:", currentIndex + 1);
                youtubePlayer.nextVideo();
                return; // Stay on the same MUSIXQUARE track
            }
        } catch (e) {
            log.warn("[YouTube] Internal next failed:", e);
        }
    }

    let nextIndex = -1;
    if (playlist.length === 0) return;

    if (repeatMode === 2) {
        nextIndex = currentTrackIndex;
    } else if (isShuffle && playlist.length > 1) {
        // Prevent infinite loop and immediate repeats in Shuffle
        do {
            nextIndex = Math.floor(Math.random() * playlist.length);
        } while (nextIndex === currentTrackIndex);
    } else if (isShuffle && playlist.length === 1) {
        nextIndex = 0;
    } else {
        nextIndex = currentTrackIndex + 1;
        if (nextIndex >= playlist.length) {
            if (repeatMode === 1) nextIndex = 0;
            else {
                log.debug("[Host] End of playlist reached (Repeat OFF). Stopping.");
                stopAllMedia();
                broadcast({ type: MSG.PAUSE, time: 0 }); // Explicit pause for guests if needed
                return;
            }
        }
    }

    // If we have a preloaded track ready for THIS SPECIFIC index, use it
    if (nextIndex !== -1 && nextTrackIndex === nextIndex && nextFileBlob) {
        log.debug(`[Host] Using preloaded track for index ${nextIndex}`);
        playTrack(nextIndex);
        return;
    }

    if (nextIndex !== -1) {
        playTrack(nextIndex);
    }
}

function playPrevTrack() {
    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return showToast("Host만 실행할 수 있습니다.");

    // OP: request Host to change track
    if (hostConn && isOperator) {
        hostConn.send({ type: MSG.REQUEST_PREV_TRACK });
        return;
    }

    // Host: execute directly

    // YouTube mode
    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
        try {
            const currentTime = youtubePlayer.getCurrentTime();
            const playlistIds = youtubePlayer.getPlaylist ? youtubePlayer.getPlaylist() : null;
            const subIndex = youtubePlayer.getPlaylistIndex ? youtubePlayer.getPlaylistIndex() : -1;

            if (currentTime > 3) {
                youtubePlayer.seekTo(0, true);
                broadcast({ type: MSG.YOUTUBE_STATE, state: youtubePlayer.getPlayerState ? youtubePlayer.getPlayerState() : 1, time: 0 });
                return;
            }

            // Internal YouTube Playlist Navigation
            if (playlistIds && playlistIds.length > 0 && subIndex > 0) {
                log.debug("[YouTube] Prev internal video:", subIndex - 1);
                youtubePlayer.previousVideo();
                return;
            }
        } catch (e) {
            log.error("[YouTube] Prev track error:", e);
        }
        // If < 3 seconds or at start of sub-playlist, go to previous track in MUSIXQUARE playlist
        if (currentTrackIndex > 0) playTrack(currentTrackIndex - 1);
        else playTrack(0);
        return;
    }

    // Local mode
    if (Tone.context && Tone.now() - startedAt > 3) {
        play(0); // Restart current
        broadcast({ type: MSG.PLAY, time: 0 });
        return;
    }
    if (currentTrackIndex > 0) playTrack(currentTrackIndex - 1);
    else playTrack(0);
}



async function loadAndBroadcastFile(file, sessionId = null, skipTabSync = false, loadToken = undefined) {
    // Prevent Zombie Loads: Increment session and capture ID
    activeLoadSessionId++;
    const myLoadId = activeLoadSessionId;
    const myToken = loadToken ?? _currentLoadToken;

    showLoader(true, `준비 중: ${file.name} `);
    stopAllMedia();

    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
        stopYouTubeMode();
    }

    try {
        await initAudio();
        if (Tone.context.state === 'suspended') await Tone.start();

        const url = BlobURLManager.create(file);
        currentFileBlob = file;

        let isVideo = false;
        if (file.type.startsWith('video/')) {
            isVideo = true;
        } else if (!file.type && file.name) {
            const ext = file.name.split('.').pop().toLowerCase();
            if (['mp4', 'mkv', 'webm', 'mov'].includes(ext)) isVideo = true;
        }

        // // Force Buffer Mode for ALL devices (Host & Guest) and ALL OSs.
        // This eliminates sync drift by serving audio from RAM via WebAudio Clock.
        log.debug("[BufferMode] Decoding audio for high-precision sync...");
        showToast("고정밀 동기화 모드: 오디오 디코딩 중...");

        // 1. Decode Audio
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer);

        // Re-verify after async decode
        if (loadToken !== undefined && _currentLoadToken !== myToken) {
            log.warn(`[Load] Token mismatch after decode (${myToken} vs ${_currentLoadToken}). Aborting.`);
            return;
        }

        // Stronger AudioBuffer Disposal: GC Hint + requestIdleCallback
        if (currentAudioBuffer) {
            const oldBuf = currentAudioBuffer;
            currentAudioBuffer = null;
            await new Promise(resolve => {
                if (window.requestIdleCallback) {
                    window.requestIdleCallback(() => {
                        if (oldBuf._buffer) oldBuf._buffer = null;
                        resolve();
                    }, { timeout: 100 });
                } else {
                    setTimeout(resolve, 100);
                }
            });
        }

        // Verify this is still the latest load session after work completes
        if (myLoadId !== activeLoadSessionId) {
            log.debug(`[Load] Stale loading session detected (${myLoadId} vs ${activeLoadSessionId}). Aborting.`);
            return;
        }

        // 2. Load into State
        currentAudioBuffer = audioBuffer;
        log.debug(`[BufferMode] Loaded ${audioBuffer.duration.toFixed(2)}s into RAM.`);

        // 3. Visual Sync (Background Video)
        videoElement.src = url;
        videoElement.muted = true;

        // meta is updated here for Host
        meta = { name: file.name, type: file.type };

        // redundant setEngineMode('buffer') removed.
        // _internalPlay will handle the state transition correctly soon.

        // Update Playlist UI (and title/artist)
        updatePlaylistUI();

        videoElement.addEventListener('loadedmetadata', function _onMetaLoaded() {
            videoElement.removeEventListener('loadedmetadata', _onMetaLoaded);
            if (myLoadId !== activeLoadSessionId) return;

            // Use Buffer Duration for accuracy
            const dur = currentAudioBuffer ? currentAudioBuffer.duration : videoElement.duration;

            if (dur && isFinite(dur)) {
                document.getElementById('time-dur').innerText = fmtTime(dur);
                const sSlider = document.getElementById('seek-slider');
                sSlider.max = dur;
                sSlider.value = 0;
            }
            BlobURLManager.confirm(file);
        });

        videoElement.load();

        const isGuest = !!hostConn;
        document.getElementById('play-btn').disabled = isGuest && !isOperator;

        if (connectedPeers.length > 0) {
            // Do NOT await broadcastFile.
            // This allows the Host to start playing and updates the UI immediately
            // while chunks are sent in the background.
            showToast("파일 전송 중...");
            broadcastFile(file, sessionId);
        }

        if (!hostConn) {
            preloadNextTrack();
        }

    } catch (err) {
        log.error(err);
        showToast(`Load Failed: ${err.message} `);
    } finally {
        showLoader(false);
        pausedAt = 0;
        updatePlayState(false);

        // Removed duplicate auto-play - playTrack() already handles this via autoPlayTimer

        // Ensure play button is enabled for Host even if load fails or halts
        if (!hostConn) {
            document.getElementById('play-btn').disabled = false;
        } else if (isOperator) {
            document.getElementById('play-btn').disabled = false;
        }
    }
}

// --- Playback Engine (Tone.js) ---

async function play(offset) {
    if (_isPlayLocked) {
        log.warn("[Play] Blocked: Already processing a play request");
        return;
    }
    _isPlayLocked = true;

    // Lock Watchdog: Ensure lock is released even if _internalPlay hangs
    const lockWatchdog = setTimeout(() => {
        if (_isPlayLocked) {
            log.warn("[Play] Lock Timeout: Forcing unlock after 5s");
            _isPlayLocked = false;
        }
    }, 5000);

    try {
        await _internalPlay(offset);
    } finally {
        clearTimeout(lockWatchdog);
        // Play Lock Safety: Add small timeout to prevent rapid-fire command overlaps
        setTimeout(() => {
            _isPlayLocked = false;
        }, 50);
    }
}

async function _internalPlay(offset) {
    _pendingPlayTime = undefined;

    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
        log.warn("[Audio] Blocked play() call while in YouTube mode");
        return;
    }

    if (Tone.context.state !== 'running') {
        try { await Tone.context.resume(); } catch (e) { log.warn("Resume failed:", e); }
    }

    const hasVideoSource = videoElement && videoElement.src && videoElement.src.startsWith('blob:');
    const hasBufferSource = !!currentAudioBuffer;

    if (!hasVideoSource && !hasBufferSource) {
        log.warn("[Play] No media source available");
        return;
    }

    initAudio();

    // --- BUFFER MODE (iOS / High Precision) ---
    if (currentAudioBuffer) {
        stopPlayerNode();

        // Create fresh transient source node
        playerNode = new Tone.BufferSource(currentAudioBuffer);

        // Branch connection path based on surround mode
        if (isSurroundMode) {
            // 1. Create surround nodes if missing (safety guard)
            if (!surroundSplitter) surroundSplitter = new Tone.Split(8);
            if (!surroundGain) surroundGain = new Tone.Gain(1);

            // 2. Connect player to 8-channel splitter (7.1 separation)
            playerNode.connect(surroundSplitter);

            // 3. Verify and restore splitter -> gain -> preamp chain
            if (surroundChannelIndex !== -1) {
                // Wire output to currently selected channel
                try {
                    surroundGain.disconnect();
                    surroundGain.connect(preamp);

                    // Disconnect existing and reconnect to target channel
                    surroundSplitter.disconnect();

                    // (Same wiring logic as setSurroundChannel)
                    const idx = surroundChannelIndex;
                    if (idx === 6) { // Rear Left + Side L Fallback
                        surroundSplitter.connect(surroundGain, 6, 0);
                        surroundSplitter.connect(surroundGain, 4, 0);
                    } else if (idx === 7) { // Rear Right + Side R Fallback
                        surroundSplitter.connect(surroundGain, 7, 0);
                        surroundSplitter.connect(surroundGain, 5, 0);
                    } else {
                        surroundSplitter.connect(surroundGain, idx, 0);
                    }
                } catch (e) { log.warn("Surround routing update failed", e); }
            }
            log.debug(`[BufferMode] Playing in 7.1 Surround (Ch: ${surroundChannelIndex})`);

        } else {
            // Standard stereo mode
            playerNode.connect(widener);
            log.debug(`[BufferMode] Playing in Stereo`);
        }

        playerNode.onended = () => {
            if (currentState === APP_STATE.PLAYING_AUDIO) {
                handleEnded();
            }
        };

        playerNode.start(Tone.now(), offset);
        // Unified Formula: startedAt represents the RAW start time point
        startedAt = Tone.now() - (offset - (localOffset + autoSyncOffset));
        log.debug(`[BufferMode] Started transient node at ${offset}s (startedAt: ${startedAt})`);

        // Sync Visuals (Muted Video)
        if (videoElement.src) {
            videoElement.currentTime = offset;
            videoElement.muted = true; // [Double Audio Fix] Ensure muted
            videoElement.volume = 0;   // [Double Audio Fix] Volume also 0
            videoElement.play().catch(() => { });
        }

    } else {
        // --- NO SOURCE (Safety) ---
        log.warn("[Play] Attempted to play without AudioBuffer.");
        return;
    }

    // Formula Refactor: startedAt represents the RAW start time point.
    // getTrackPosition will dynamically add (localOffset + autoSyncOffset).
    startedAt = Tone.now() - (offset - (localOffset + autoSyncOffset));
    pausedAt = offset;

    updatePlayState(true);

    // Use robust helper for video detection (prevents Host stale meta bug)
    const isVideo = isMediaVideo(currentFileBlob, meta);
    setState(isVideo ? APP_STATE.PLAYING_VIDEO : APP_STATE.PLAYING_AUDIO, { skipCleanup: true });

    startVisualizer();
    if (isVideo) {
        postWorkerCommand({ command: 'START_TIMER', id: 'video-sync', interval: 2000 });
    }
    if (!uiLoopId) loopUI();
}

function stopPlayerNode() {
    if (playerNode) {
        try {
            // [Key Fix] Must remove onended listener before stop()
            // Otherwise stop() triggers "track ended" causing infinite loop/overlap
            playerNode.onended = null;

            playerNode.stop();
            playerNode.disconnect();
            // dispose() for memory cleanup, may throw in some Tone.js versions
            playerNode.dispose();
        } catch (e) {
            log.warn("Error stopping/disposing playerNode:", e);
        } finally {
            playerNode = null;
        }
    }
}

function handleEnded() {
    // Video duration can be transiently small/wrong during load.
    // Guests should only trigger 'ended' if they are NOT loading and the Host isn't forcing playback.
    if (hostConn && currentState !== APP_STATE.IDLE) {
        // If Host says we are 3 mins in, but local says 0.39s, ignore local "end"
        return;
    }

    // Safety: Verify video readyState before trusting duration (VIDEO mode)
    const usesVideoElement = currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_AUDIO;
    if (usesVideoElement && videoElement && videoElement.readyState < 1) {
        return; // Metadata not yet reliable
    }

    const duration = videoElement ? videoElement.duration : 0;

    // Safety: Skip if duration is invalid or suspiciously short during load
    if (!duration || !isFinite(duration) || duration <= 0.5) {
        return;
    }

    // Proceed to check end conditions

    // Only require videoElement, not playerNode (playerNode is null in Streaming Mode)
    if (!videoElement) return;
    if (currentState === APP_STATE.IDLE) return;
    if (currentState === APP_STATE.PLAYING_YOUTUBE) return;

    // Use unified Track Position calculation
    const curr = getTrackPosition();

    // Seek Guard: If the user is currently scrubbing the timeline, ignore end signals.
    if (isSeeking) {
        log.debug("[handleEnded] Ignoring end signal while seeking");
        return;
    }

    const isPastEnd = (curr >= duration - 0.2);

    if (currentState !== APP_STATE.IDLE && isPastEnd) {
        log.debug(`Track ended at ${curr.toFixed(2)} s / ${duration.toFixed(2)} s`);

        // Use centralized stopAllMedia() which sets state to IDLE
        stopAllMedia();

        // Note: stopAllMedia() already calls setState(IDLE) and updatePlayState(false)
        pausedAt = 0;

        // Reset UI immediately
        const slider = document.getElementById('seek-slider');
        if (slider) slider.value = 0;
        const timeCurr = document.getElementById('time-curr');
        if (timeCurr) timeCurr.innerText = fmtTime(0);

        // Auto Advance (Host Only)
        if (!hostConn) {
            if (repeatMode === 2) {
                // Repeat One: Play same track again
                log.debug("Repeat One: Replaying current track...");
                // Reset sync state for clean restart
                setTimeout(() => playTrack(currentTrackIndex), 300);
            } else {
                log.debug("Auto-advancing to next track...");
                setTimeout(() => playNextTrack(), 500);
            }
        }
    }
}

/**
 * [iOS Latency Fix] Perform subtle drift correction.
 * Called every 2s to keep devices in sync without heavy UI lag.
 */
function checkVideoSync() {
    // Sync check is critical for both PLAYING_VIDEO and PLAYING_AUDIO (if video visual exists)
    if (currentState === APP_STATE.IDLE || currentState === APP_STATE.PLAYING_YOUTUBE) return;
    if (!videoElement || !videoElement.src) return;

    const targetTime = getTrackPosition();
    const actualTime = videoElement.currentTime;
    const drift = Math.abs(actualTime - targetTime);

    // Only correct if drift is significant (>300ms)
    if (drift > 0.3) {
        // Guard: Do not seek if already seeking (prevents infinite seek loops)
        if (videoElement.seeking) return;

        log.debug(`[SyncCheck] Correcting video drift: ${drift.toFixed(3)}s`);

        // [KICKSTART] If drift is exactly the check interval (2.0s), video is likely frozen.
        // Try to force play() to resume the video engine.
        if (drift >= 1.9 && videoElement.paused) {
            log.warn("[SyncCheck] Video appears frozen. Attempting kickstart...");
            videoElement.play().catch(() => { });
        }

        // In Buffer Mode, just sync video to Tone.js master clock
        if (currentAudioBuffer) {
            videoElement.currentTime = targetTime;
            return;
        }

        // --- NON-BUFFER MODE (Direct Streaming) ---
        // Safety: If no buffer and not paused, only seek video element.
        // (Removing the buggy BufferSource creation that used null currentAudioBuffer)
        videoElement.currentTime = targetTime;
    }
}

/**
 * Stop EVERYTHING. Tone.js, Video, and YouTube.
 * Ensures no audio overlap during transitions.
 */
function stopAllMedia() {
    // 1. Stop global video (full reset)
    if (videoElement) {
        videoElement.pause();
        videoElement.removeAttribute('src'); // Detach source link
        videoElement.load(); // Reset loading state
    }

    // 2. Stop YouTube (Full Teardown)
    // Use the comprehensive stopYouTubeMode if it exists, otherwise manual teardown
    if (typeof stopYouTubeMode === 'function') {
        // stopYouTubeMode internally calls setState(IDLE). 
        // We ensure it doesn't cause recursion by checking state or using flags if needed.
        // For now, stopYouTubeMode is safe as it checks currentState === PLAYING_YOUTUBE
        stopYouTubeMode();
    } else if (youtubePlayer && youtubePlayer.stopVideo) {
        try { youtubePlayer.stopVideo(); } catch (e) { /* best-effort cleanup */ }
    }

    // Clear any pending triggers
    // DO NOT clear _pendingPlayTime here. 
    // It should persist if we just finished loading and are waiting for Host to start (3s count).
    // It is safely cleared in clearPreviousTrackState when track actually changes.
    preloadSessionId++; // Invalidate any ongoing preloads
    if (managedTimers.autoPlayTimer) {
        clearManagedTimer('autoPlayTimer');
    }

    setState(APP_STATE.IDLE, { skipCleanup: true });
    updatePlayState(false);

    // Stop all background sync timers
    postWorkerCommand({ command: 'STOP_TIMER', id: 'video-sync' });
    postWorkerCommand({ command: 'STOP_TIMER', id: 'youtube-sync' });

    // Modified stopPlayerNode safely stops audio here
    stopPlayerNode();

    // Clear relay queues to prevent stale file chunks during mode transitions
    relayChunkQueue = [];
    downstreamDataPeers.forEach(p => {
        if (p._relayQueue) p._relayQueue = [];
    });

    // Reset master clock and offsets
    startedAt = 0;
    pausedAt = 0;
}
/**
 * Handle UI and state transitions between Audio, Video, and YouTube modes.
 * @param {string} mode - 'audio' | 'buffer' | 'video' | 'youtube'
 */
function setEngineMode(mode) {
    log.debug(`[Engine] Switching mode to: ${mode}`);

    // Map mode string to APP_STATE
    let newState;
    switch (mode) {
        case 'video':
            newState = APP_STATE.PLAYING_VIDEO;
            break;
        case 'youtube':
            newState = APP_STATE.PLAYING_YOUTUBE;
            break;
        case 'buffer':
        case 'audio':
            newState = APP_STATE.PLAYING_AUDIO;
            break;
        default:
            newState = APP_STATE.IDLE;
    }

    // Use centralized state transition (includes UI update)
    setState(newState);

    // Always sync UI after mode switch
    updatePlaylistUI();
}




function togglePlay() {
    if (hostConn && !isOperator) return showToast("Host만 실행할 수 있습니다.");

    // YouTube Mode: Control via YT API
    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
        // OP: request Host to control YouTube
        if (hostConn && isOperator) {
            try {
                const state = youtubePlayer.getPlayerState();
                if (state === YT.PlayerState.PLAYING) {
                    hostConn.send({ type: MSG.REQUEST_YOUTUBE_PAUSE });
                } else {
                    hostConn.send({ type: MSG.REQUEST_YOUTUBE_PLAY });
                }
            } catch (e) {
                log.error("[YouTube] OP toggle error:", e);
            }
            return;
        }

        // Host: execute directly
        try {
            const state = youtubePlayer.getPlayerState();
            if (state === YT.PlayerState.PLAYING) {
                youtubePlayer.pauseVideo();
                broadcast({ type: MSG.YOUTUBE_STATE, state: 2, time: youtubePlayer.getCurrentTime() });
            } else {
                youtubePlayer.playVideo();
                broadcast({ type: MSG.YOUTUBE_STATE, state: 1, time: youtubePlayer.getCurrentTime() });
            }
        } catch (e) {
            log.error("[YouTube] Toggle play error:", e);
        }
        return;
    }

    const isActuallyPlaying = (videoElement && !videoElement.paused);

    // Cancel pending auto-play timer if host manually controls playback
    if (!hostConn && managedTimers.autoPlayTimer) {
        clearManagedTimer('autoPlayTimer');
        showToast("자동 재생 취소됨");
    }

    if (isActuallyPlaying) {
        if (!hostConn) { pause(); broadcast({ type: MSG.PAUSE }); }
        else if (isOperator) hostConn.send({ type: MSG.REQUEST_PAUSE });
    } else {
        if (!hostConn) { play(pausedAt); broadcast({ type: MSG.PLAY, time: pausedAt }); }
        else if (isOperator) hostConn.send({ type: MSG.REQUEST_PLAY, time: pausedAt });
    }
}

function pause() {
    if (currentState !== APP_STATE.IDLE) {
        if (videoElement) videoElement.pause();

        // stopPlayerNode();

        pausedAt = getTrackPosition();
        if (videoElement) videoElement.currentTime = pausedAt;

        // Set state to IDLE so loopUI stops
        setState(APP_STATE.IDLE, { skipCleanup: true });
    }
    updatePlayState(false);
    showToast("일시정지");
    postWorkerCommand({ command: 'STOP_TIMER', id: 'video-sync' });
}

function skipTime(sec) {
    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return showToast("Host만 실행할 수 있습니다.");

    // OP: request Host to skip time
    if (hostConn && isOperator) {
        hostConn.send({ type: MSG.REQUEST_SKIP_TIME, sec: sec });
        return;
    }

    // Host: execute directly
    // YouTube mode: use YouTube API
    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
        try {
            const currentTime = youtubePlayer.getCurrentTime();
            const duration = youtubePlayer.getDuration();
            let target = currentTime + sec;

            if (target < 0) target = 0;
            if (target > duration) target = duration;

            youtubePlayer.seekTo(target, true);

            // Broadcast to guests
            broadcast({ type: MSG.YOUTUBE_STATE, state: youtubePlayer.getPlayerState(), time: target });
        } catch (e) {
            log.error("[YouTube] Skip time error:", e);
        }
        return;
    }

    // Local mode
    let current = getTrackPosition();

    let target = current + sec;
    const duration = videoElement ? videoElement.duration : 0;

    if (target < 0) target = 0;
    if (target > duration) target = duration;

    // Broadcast
    play(target);
    broadcast({ type: MSG.PLAY, time: target });
}

function updatePlayState(playing) {
    document.getElementById('icon-play').style.display = playing ? 'none' : 'block';
    document.getElementById('icon-pause').style.display = playing ? 'block' : 'none';
}

function adjustSync(val) {
    localOffset += val;
    updateSyncDisplay(); // Ensure UI updates immediately
    if (currentState !== APP_STATE.IDLE) play(getTrackPosition());
    else pausedAt += val;
}

// --- Audio Graph Settings (Tone.js) ---
function setChannelMode(mode) {
    channelMode = mode;

    // Remove Cutoff Visibility Toggle (Always Visible now)

    if (!masterGain) return; // Not init
    const ramp = 0.05;

    // Reset LowPass to Full Range by default (Safety)
    if (globalLowPass) globalLowPass.frequency.value = 20000;

    // Reset Routing first
    try {
        gainL.disconnect();
        gainR.disconnect();
    } catch (e) { /* expected during audio graph reconfiguration */ }

    if (mode === 0) { // Stereo
        // L -> Merge 0, R -> Merge 1
        gainL.connect(toneMerge, 0, 0);
        gainR.connect(toneMerge, 0, 1);

        gainL.gain.rampTo(1, ramp);
        gainR.gain.rampTo(1, ramp);
        showToast("Mode: Stereo");

    } else if (mode === -1) { // Left (Dual Mono)
        // L -> Merge 0 AND 1
        gainL.connect(toneMerge, 0, 0);
        gainL.connect(toneMerge, 0, 1);

        gainL.gain.rampTo(1, ramp);
        showToast("Mode: Left Channel");

    } else if (mode === 1) { // Right (Dual Mono)
        // R -> Merge 0 AND 1
        gainR.connect(toneMerge, 0, 0);
        gainR.connect(toneMerge, 0, 1);

        gainR.gain.rampTo(1, ramp);
        showToast("Mode: Right Channel");

    } else if (mode === 2) { // Sub
        // Apply Subwoofer Frequency Immediately
        if (globalLowPass) {
            globalLowPass.frequency.value = subFreq;
        }

        // Summing L+R to both speakers
        gainL.connect(toneMerge, 0, 0);
        gainL.connect(toneMerge, 0, 1);
        gainR.connect(toneMerge, 0, 0);
        gainR.connect(toneMerge, 0, 1);

        // Instant Gain Drop to prevent +6dB Spike during summing
        gainL.gain.value = 0.5;
        gainR.gain.value = 0.5;

        showToast(`Mode: Subwoofer(${subFreq}Hz)`);
    } else {
        // Fallback
        gainL.gain.rampTo(1, ramp);
        gainR.gain.rampTo(1, ramp);
    }
    applySettings();
}

// --- 7.1 Surround Logic ---
function toggleSurroundMode(enabled) {
    isSurroundMode = enabled;

    // UI Toggle
    document.getElementById('grid-standard').style.display = enabled ? 'none' : 'grid';
    document.getElementById('grid-surround').style.display = enabled ? 'grid' : 'none';

    // Logic Switch
    if (enabled) {
        // Ensure 7.1 Graph Nodes exist
        if (!surroundSplitter) {
            surroundSplitter = new Tone.Split(8);
            surroundGain = new Tone.Gain(1);
        }

        // Defaults to Center
        if (surroundChannelIndex === -1) setSurroundChannel(2, null);
        else setSurroundChannel(surroundChannelIndex, null);

        showToast("Surround Mode: Enabled");
    }

    setChannelMode(channelMode); // Restore standard channel

    // Instant Refresh: If playing in Buffer Mode, restart play() to reflect mode change immediately
    const isPlaybackState = currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_AUDIO;
    if (isPlaybackState && currentAudioBuffer && playerNode) {
        log.debug("[Surround] Instant mode refresh triggered");
        play(getTrackPosition());
    }
}

function setSurroundChannel(idx, el, skipSetup = false) {
    surroundChannelIndex = idx;

    // UI Highlight Logic
    const allOpts = document.querySelectorAll('.surround-grid .ch-opt');
    allOpts.forEach(e => e.classList.remove('active'));

    if (el) {
        el.classList.add('active');
    } else {
        // Programmatic Update: Find button by onclick content
        // This ensures the UI reflects default selection (e.g. FL)
        for (let btn of allOpts) {
            const onclickVal = btn.getAttribute('onclick');
            if (onclickVal && onclickVal.includes(`(${idx}, `)) {
                btn.classList.add('active');
                break;
            }
        }
    }

    if (!surroundSplitter) return; // Wait for media setup

    // Routing Logic:
    // 1. Ensure Graph is in Surround Mode
    if (!isSurroundMode) return;

    // 2. Connect selected Splitter Output to SurroundGain
    try {
        surroundGain.disconnect();
        surroundGain.connect(preamp); // Feed into main chain

        surroundSplitter.disconnect();

        // 5.1 / 7.1 Compatibility Routing
        // 5.1 Layout: L, R, C, LFE, SL, SR (No Rear L/R)
        // 7.1 Layout: L, R, C, LFE, SL, SR, BL, BR

        if (idx === 6) {
            // User selected "Rear Left"
            // If file is 5.1, Ch 6 is empty. capture Side Left (4) as fallback/fill.
            surroundSplitter.connect(surroundGain, 6, 0); // Real Rear L
            surroundSplitter.connect(surroundGain, 4, 0); // Side L (Fallback for 5.1)
        } else if (idx === 7) {
            // User selected "Rear Right"
            surroundSplitter.connect(surroundGain, 7, 0); // Real Rear R
            surroundSplitter.connect(surroundGain, 5, 0); // Side R (Fallback for 5.1)
        } else if (idx === 3) {
            // LFE (Sub) - Special Bass Management or Direct
            // Just connect LFE. If user wants Bass Management, we can mix L/R here too?
            // For now, Direct 1:1.
            surroundSplitter.connect(surroundGain, 3, 0);
        } else {
            // Standard 1:1 Mapping
            surroundSplitter.connect(surroundGain, idx, 0);
        }

        // Reset LowPass Filter (Safety for non-LFE channels)
        // IF LFE (3), set to subFreq. ELSE set to 20000.
        if (globalLowPass) {
            if (idx === 3) globalLowPass.frequency.value = subFreq;
            else globalLowPass.frequency.value = 20000;
        }

        // 3. Force Output to Dual Mono (L+R)
        gainL.disconnect();
        gainR.disconnect();

        // Direct Mapping: GainL -> Left Spk, GainR -> Right Spk
        // Since input is Mono (duplicated), this results in Dual Mono output.
        gainL.connect(toneMerge, 0, 0);
        gainR.connect(toneMerge, 0, 1);

        gainL.gain.rampTo(1, 0.1);
        gainR.gain.rampTo(1, 0.1);

        const names = ["Front Left (L)", "Front Right (R)", "Center (Dialog)", "LFE (Sub)", "Side Left", "Side Right", "Rear Left (Back)", "Rear Right (Back)"];
        showToast(`Ch: ${names[idx]}`);

    } catch (e) {
        log.warn(e);
    }
}

function setChannel(mode, el) {
    if (!masterGain) initAudio();
    document.querySelectorAll('.ch-opt').forEach(e => e.classList.remove('active'));
    el.classList.add('active');
    setChannelMode(mode);
}

function updateSettings(type, val) {
    if (type === 'cutoff') {
        subFreq = Number(val);
        document.getElementById('val-cutoff').innerText = subFreq + ' Hz';

        if (vbFilter) vbFilter.frequency.rampTo(subFreq, 0.1);

        // Update Main Filter ONLY if currently in Subwoofer/LFE mode
        const isSubMode = (channelMode === 2 && !isSurroundMode);
        const isLFE = (isSurroundMode && surroundChannelIndex === 3);

        if (globalLowPass && (isSubMode || isLFE)) {
            globalLowPass.frequency.rampTo(subFreq, 0.1);
        }
    }
}

function onReverbInput(val) { setReverbParam('mix', val); }
function onReverbChange(val) {
    if (!hostConn) broadcast({ type: MSG.REVERB, value: val });
    else if (isOperator) hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'reverb', value: val });
}

function onReverbDecayInput(val) {
    document.getElementById('val-rvb-decay').innerText = val + 's';
}
function onReverbDecayChange(val) {
    setReverbParam('decay', val);
    if (!hostConn) broadcast({ type: MSG.REVERB_DECAY, value: val });
    else if (isOperator) hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'reverb-decay', value: val });
}

function onReverbPreDelayInput(val) {
    document.getElementById('val-rvb-predelay').innerText = val + 's';
}
function onReverbPreDelayChange(val) {
    setReverbParam('predelay', val);
    if (!hostConn) broadcast({ type: MSG.REVERB_PREDELAY, value: val });
    else if (isOperator) hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'reverb-predelay', value: val });
}

function onReverbLowCutInput(val) {
    const v = Number(val);
    const freq = 20 * Math.pow(50, v / 100);
    const txt = freq >= 1000 ? (freq / 1000).toFixed(1) + 'k' : Math.round(freq) + 'Hz';
    document.getElementById('val-rvb-lowcut').innerText = txt;
}
function onReverbLowCutChange(val) {
    setReverbParam('lowcut', val);
    if (!hostConn) broadcast({ type: MSG.REVERB_LOWCUT, value: val });
    else if (isOperator) hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'reverb-lowcut', value: val });
}

function onReverbHighCutInput(val) {
    const v = Number(val);
    const freq = 20000 * Math.pow(0.025, v / 100);
    const txt = freq >= 1000 ? (freq / 1000).toFixed(1) + 'k' : Math.round(freq) + 'Hz';
    document.getElementById('val-rvb-highcut').innerText = txt;
}
function onReverbHighCutChange(val) {
    setReverbParam('highcut', val);
    if (!hostConn) broadcast({ type: MSG.REVERB_HIGHCUT, value: val });
    else if (isOperator) hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'reverb-highcut', value: val });
}

function setReverbParam(param, val) {
    const v = Number(val);
    if (!reverb) return;

    switch (param) {
        case 'mix':
            reverbMix = v / 100;
            document.getElementById('val-reverb').innerText = v + '%';
            document.getElementById('reverb-slider').value = v;
            applySettings();
            break;
        case 'decay':
            reverb.decay = v;
            reverb.generate();
            document.getElementById('val-rvb-decay').innerText = v + 's';
            document.getElementById('reverb-decay-slider').value = v;
            break;
        case 'predelay':
            reverb.preDelay = v;
            reverb.generate();
            document.getElementById('val-rvb-predelay').innerText = v + 's';
            document.getElementById('reverb-predelay-slider').value = v;
            break;
        case 'lowcut':
            const lFreq = 20 * Math.pow(50, v / 100);
            if (rvbLowCut) rvbLowCut.frequency.rampTo(lFreq, 0.1);
            document.getElementById('val-rvb-lowcut').innerText = (lFreq >= 1000 ? (lFreq / 1000).toFixed(1) + 'k' : Math.round(lFreq) + 'Hz');
            document.getElementById('reverb-lowcut-slider').value = v;
            break;
        case 'highcut':
            const hFreq = 20000 * Math.pow(0.025, v / 100);
            if (rvbHighCut) rvbHighCut.frequency.rampTo(hFreq, 0.1);
            document.getElementById('val-rvb-highcut').innerText = (hFreq >= 1000 ? (hFreq / 1000).toFixed(1) + 'k' : Math.round(hFreq) + 'Hz');
            document.getElementById('reverb-highcut-slider').value = v;
            break;
    }
}

// Restore missing setters for updateAudioEffect and legacy handlers
function setReverb(val, localOnly) { setReverbParam('mix', val); if (!localOnly) onReverbChange(val); }
function setReverbDecay(val, localOnly) { setReverbParam('decay', val); if (!localOnly) onReverbDecayChange(val); }
function setReverbPreDelay(val, localOnly) { setReverbParam('predelay', val); if (!localOnly) onReverbPreDelayChange(val); }
function setReverbLowCut(val, localOnly) { setReverbParam('lowcut', val); if (!localOnly) onReverbLowCutChange(val); }
function setReverbHighCut(val, localOnly) { setReverbParam('highcut', val); if (!localOnly) onReverbHighCutChange(val); }

function resetReverbMix() { setReverbParam('mix', 0); onReverbChange(0); }
function resetReverbDecay() { setReverbParam('decay', 5.0); onReverbDecayChange(5.0); }
function resetReverbPreDelay() { setReverbParam('predelay', 0.1); onReverbPreDelayChange(0.1); }
function resetReverbLowCut() { setReverbParam('lowcut', 0); onReverbLowCutChange(0); }
function resetReverbHighCut() { setReverbParam('highcut', 0); onReverbHighCutChange(0); }


function resetReverb() {
    resetReverbMix();
    resetReverbDecay();
    resetReverbPreDelay();
    resetReverbLowCut();
    resetReverbHighCut();
}

// Graphic EQ
function setEQ(idx, val, localOnly = false, fromSync = false) {
    const bandIdx = Number(idx);
    const bandVal = Number(val);

    // Tone.js Update
    if (eqNodes && eqNodes[bandIdx]) {
        // eqNodes are Tone.Filter(peaking)
        eqNodes[bandIdx].gain.value = bandVal;
    }

    // UI Update
    const bands = document.querySelectorAll('.eq-band');
    if (bands[bandIdx]) {
        const slider = bands[bandIdx].querySelector('.eq-slider');
        if (slider && parseFloat(slider.value) !== bandVal) slider.value = bandVal;
    }

    const label = document.getElementById(`eq-val-${bandIdx}`);
    if (label) label.innerText = bandVal > 0 ? `+${bandVal}` : bandVal;

    if (localOnly || fromSync) return;

    if (!hostConn) {
        broadcast({ type: MSG.EQ_UPDATE, band: bandIdx, value: bandVal });
    }
    else if (isOperator) {
        hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'eq', band: bandIdx, value: bandVal });
    }
}

// Global:
let userPreampGain = 1.0;

function setPreamp(val, localOnly = false, fromSync = false) {
    const db = Number(val);
    userPreampGain = Math.pow(10, db / 20); // Store user intent

    // UI Update
    const disp = document.getElementById('val-preamp');
    if (disp) disp.innerText = (db > 0 ? '+' : '') + db + 'dB';

    const slider = document.getElementById('preamp-slider');
    if (slider && slider.value != db) slider.value = db;

    // Apply immediately via common function
    applySettings();

    if (localOnly || fromSync) return;

    if (!hostConn) broadcast({ type: MSG.PREAMP, value: db });
    else if (isOperator) hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'preamp', value: db });
}

function resetEQ(fromSync = false) {
    if (isOperator && !fromSync) {
        hostConn.send({ type: MSG.REQUEST_EQ_RESET });
        return;
    }
    document.querySelectorAll('.eq-slider').forEach((el, idx) => {
        setEQ(idx, 0, false, true);
    });
    setPreamp(0, false, true);
    if (!hostConn && !fromSync) broadcast({ type: MSG.EQ_RESET });
}

// Virtual Stereo Width
function setStereoWidth(val) {
    stereoWidth = val / 100;
    document.getElementById('val-width').innerText = val + '%';
    document.getElementById('width-slider').value = val;
    applySettings();
}

function onStereoWidthChange(val) {
    if (!hostConn) broadcast({ type: MSG.STEREO_WIDTH, value: val });
    else if (isOperator) hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'stereo', value: val });
}

function resetStereo() { setStereoWidth(100); onStereoWidthChange(100); }

// Virtual Bass Control
function setVirtualBass(val) {
    virtualBass = val / 100;
    document.getElementById('val-vbass').innerText = val + '%';
    document.getElementById('vbass-slider').value = val;
    applySettings();
}

function onVirtualBassChange(val) {
    if (!hostConn) broadcast({ type: MSG.VBASS, value: val });
    else if (isOperator) hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'vbass', value: val });
}

function applySettings() {
    if (!masterGain) return;

    // Reverb Mix (CrossFade)
    if (rvbCrossFade) rvbCrossFade.fade.rampTo(reverbMix, 0.1);

    // Stereo Width & Gain Compensation
    if (widener) {
        // Active in ALL modes now (Pre-Split processing)
        widener.wet.rampTo(1, 0.1);
        // Fix Mapping: 100% UI = 0.5 Tone.Widener (Normal)
        // 200% UI = 1.0 Tone.Widener (Wide)
        widener.width.rampTo(stereoWidth * 0.5, 0.1);

        // Mono Compensation: When width -> 0, L+R sums energy (up to +6dB).
        // We reduce gain to approx 0.6x (-4.5dB) at Mono to keep level consistent.
        let compensation = 1.0;
        if (stereoWidth < 1.0) {
            compensation = 0.6 + (0.4 * stereoWidth);
        }

        if (preamp) preamp.gain.rampTo(userPreampGain * compensation, 0.1);
    }

    // Virtual Bass
    // Boost factor: 0 to 1
    if (vbGain) vbGain.gain.rampTo(virtualBass, 0.1);
}

function onVolInput(val) { setVolume(val / 100); }
function onVolChange(val) {
    if (!hostConn) {
        broadcast({ type: MSG.VOLUME, value: val / 100 });
        showToast(`Volume: ${Math.round(val)}%`);
    }
}

function toggleMute() {
    if (masterVolume > 0) {
        preMuteVolume = masterVolume;
        setVolume(0);
        showToast("Muted");
        if (!hostConn) broadcast({ type: MSG.VOLUME, value: 0 });
    } else {
        setVolume(preMuteVolume || 0.5); // Fallback to 50% if preMuteVolume was somehow 0
        showToast(`Volume: ${Math.round(masterVolume * 100)}%`);
        if (!hostConn) broadcast({ type: MSG.VOLUME, value: masterVolume });
    }
}

function updateVolumeIcon() {
    const icon = document.getElementById('vol-icon-btn');
    if (!icon) return;
    const path = icon.querySelector('path');
    if (!path) return;

    if (masterVolume === 0) {
        // Mute Icon
        path.setAttribute('d', 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z');
    } else {
        // Normal Icon
        path.setAttribute('d', 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z');
    }
}

function setVolume(val) {
    masterVolume = val;
    // Tone.Master.volume is dB. We want linear gain on masterGain node.
    if (masterGain) masterGain.gain.rampTo(masterVolume, 0.1);

    // Support YouTube Volume Integration
    if (youtubePlayer && typeof youtubePlayer.setVolume === 'function') {
        try {
            // YouTube API expects 0-100
            youtubePlayer.setVolume(val * 100);
        } catch (e) {
            log.warn("[YouTube] Failed to set volume:", e);
        }
    }

    const vSlider = document.getElementById('volume-slider');
    if (vSlider) vSlider.value = val * 100;

    // Support Video Element Volume sync (Especially for Host Native Playback)
    if (videoElement) {
        // [Double Audio Fix] Prevent unmuting video if playing via Buffer Mode
        if (currentAudioBuffer) {
            videoElement.volume = 0;
            videoElement.muted = true;
        } else {
            try {
                videoElement.volume = val;
            } catch (e) { log.debug('[Volume] Video element volume set failed:', e.message); }
        }
    }

    updateVolumeIcon();
}

// ==============================================================
// [Visualizer] Light/Dark Mode Supported
// ==============================================================
function startVisualizer() {
    // Prevent Loop Nesting: Clear previous loop if exists
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }

    const canvas = document.getElementById('visualizerCanvas');
    const ctx = canvas.getContext('2d');

    // Init Guard: If audio engine isn't ready (Race condition with play() -> initAudio()), retry next frame
    if (!analyser) {
        animationId = requestAnimationFrame(startVisualizer);
        return;
    }

    // Check type of global analyser (Tone or Native)
    const isToneAnalyser = (analyser && !analyser.getByteFrequencyData);

    // Determine buffer size
    const bufferLength = isToneAnalyser ? analyser.size : analyser.frequencyBinCount;
    // Tone analyzer size is usually 1024 or 2048.
    // If Tone, we map Float32 to Uint8 manually for compatibility with drawing logic
    const dataArray = isToneAnalyser ? new Float32Array(bufferLength) : new Uint8Array(bufferLength);

    // Scope Pollution: Keep bass state local to the loop
    let smoothedBass = 0;

    // Canvas Scale Logic (High DPI)
    const logicalSize = 240;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== logicalSize * dpr) {
        canvas.width = logicalSize * dpr;
        canvas.height = logicalSize * dpr;
        canvas.style.width = `${logicalSize}px`;
        canvas.style.height = `${logicalSize}px`;
        ctx.scale(dpr, dpr);
    }

    function draw() {
        if (currentState === APP_STATE.IDLE) return;
        animationId = requestAnimationFrame(draw);

        if (isToneAnalyser) {
            const dbData = analyser.getValue();
            for (let i = 0; i < bufferLength; i++) {
                // Map -100dB ~ -30dB to 0 ~ 255 (brightness coefficient: 2.5)
                let val = (dbData[i] + 100) * 2.5;
                if (val < 0) val = 0; if (val > 255) val = 255;
                dataArray[i] = val;
            }

            const theme = document.documentElement.getAttribute('data-theme');
            const isLight = (theme === 'light');

            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = isLight ? 'rgba(255, 255, 255, 0.9)' : 'rgba(18, 18, 18, 0.9)';
            ctx.fillRect(0, 0, logicalSize, logicalSize);

            // Bass: 0 ~ 260Hz (12 bins - sync.html style for better punch)
            let bassSum = 0;
            let bassCount = 12;
            // Safety check for array bounds
            if (bassCount > bufferLength) bassCount = bufferLength;
            for (let i = 0; i < bassCount; i++) { bassSum += dataArray[i]; }
            const bassAverage = bassSum / bassCount;

            // Per-band smoothing: Bass only (0.8 = smooth, High = immediate)
            smoothedBass = smoothedBass * 0.8 + bassAverage * 0.2;

            const bassPunch = Math.pow(smoothedBass / 255, 2.5);

            // High: 7.5kHz ~ 20kHz (0.7 ~ 1.0 of buffer)
            let highSum = 0;
            const highStart = Math.floor(bufferLength * 0.7);
            const highEnd = bufferLength;
            let highCountVal = highEnd - highStart;
            if (highCountVal < 1) highCountVal = 1;

            for (let i = highStart; i < highEnd; i++) { highSum += dataArray[i]; }
            const highAverage = highSum / highCountVal;
            const highPunch = Math.pow(highAverage / 255, 1.0);

            if (isLight) ctx.globalCompositeOperation = 'source-over';
            else ctx.globalCompositeOperation = 'lighter';

            ctx.shadowBlur = 0;
            ctx.lineWidth = 0;

            const centerX = logicalSize / 2;
            const centerY = logicalSize / 2;

            // Circle 1: Bass (increased amplification: 80 -> 150)
            const bassRadius = 40 + (bassPunch * 150);
            const bassLightness = 20 + (bassPunch * 60);

            if (isLight) ctx.fillStyle = `rgba(59, 130, 246, 0.6)`;
            else ctx.fillStyle = `hsla(217, 91 %, ${bassLightness + 40}%, 0.4)`;

            ctx.beginPath();
            ctx.arc(centerX, centerY, bassRadius, 0, 2 * Math.PI);
            ctx.fill();

            // Circle 2: High (30~130 range)
            const highRadius = 30 + (highPunch * 100);
            const highLightness = 40 + (highPunch * 60);

            if (isLight) {
                ctx.fillStyle = `rgba(96, 165, 250, 0.6)`;
            } else {
                ctx.fillStyle = `hsla(217, 100%, ${highLightness + 30}%, 0.4)`;
            }

            ctx.beginPath();
            ctx.arc(centerX, centerY, highRadius, 0, 2 * Math.PI);
            ctx.fill();
        }

    }
    // Correctly kickstart the loop once from outside
    draw();
}

function fmtTime(s) {
    if (isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

// --- Marquee Helper for Long Titles ---
function updateTitleWithMarquee(text) {
    const el = document.getElementById('track-title');
    if (!el) return;

    // Reset marquee state to measure accurately
    el.classList.remove('marquee');
    el.style.animation = 'none'; // Temporarily stop animation
    el.innerText = text;
    el.removeAttribute('data-text'); // No longer needed for CSS content

    // Clear inline styles from previous marquee
    el.style.removeProperty('--marquee-offset');
    el.style.removeProperty('--marquee-duration');

    // Use a small delay to allow DOM to calculate widths
    setTimeout(() => {
        const parent = el.parentElement;
        if (!parent) return;

        // Calculate Overflow
        // scrollWidth: actual text width, clientWidth: visible container width
        const overflowWidth = el.scrollWidth - parent.clientWidth;

        // Add a small buffer (e.g., 32px) to ensure it clears the edge fully
        const targetOffset = -(overflowWidth + 32); // +32 for padding/mask buffer

        if (overflowWidth > 0) {
            el.classList.add('marquee');

            // Set CSS Variable for the exact travel distance
            el.style.setProperty('--marquee-offset', `${targetOffset}px`);

            // Calculate Duration based on Speed (Constant Pixels Per Second)
            // e.g., 40px per second + 4s pause (2s start + 2s end)
            const speed = 40; // px per second
            const travelDuration = (Math.abs(targetOffset) / speed);
            const totalDuration = travelDuration * 2 + 4; // *2 for round trip, +4 for pauses

            el.style.setProperty('--marquee-duration', `${totalDuration}s`);

            // Re-apply animation
            el.style.animation = '';
        }
    }, 100);
}


// --- Seek & Interactions ---
const slider = document.getElementById('seek-slider');
slider.addEventListener('mousedown', () => isSeeking = true);
slider.addEventListener('touchstart', () => isSeeking = true);
slider.addEventListener('input', () => document.getElementById('time-curr').innerText = fmtTime(slider.value));
slider.addEventListener('change', () => {
    isSeeking = false;
    const t = parseFloat(slider.value);

    // Guest (non-OP): blocked
    if (hostConn && !isOperator) {
        return; // Guests can't seek
    }

    // OP: request Host to seek
    if (hostConn && isOperator) {
        hostConn.send({ type: MSG.REQUEST_SEEK, time: t });
        return;
    }

    // Host: execute directly
    // YouTube mode: use YouTube API
    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
        try {
            youtubePlayer.seekTo(t, true);  // t is already in seconds
            broadcast({ type: MSG.YOUTUBE_STATE, state: youtubePlayer.getPlayerState(), time: t });
        } catch (e) {
            log.error("[YouTube] Slider seek error:", e);
        }
        return;
    }

    const isActuallyPlaying = (videoElement && !videoElement.paused);

    if (isActuallyPlaying) {
        play(t);
        broadcast({ type: MSG.PLAY, time: t });
    } else {
        pausedAt = t;
        if (currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_AUDIO) videoElement.currentTime = t;
        // Broadcast pause with updated time to sync guests without starting playback
        broadcast({ type: MSG.PAUSE, time: t });
    }

    // Schedule global resync after seek (Host only)
    setTimeout(() => {
        broadcast({ type: MSG.GLOBAL_RESYNC_REQUEST });
        log.debug("[Host] Global resync requested after seek");
    }, 1000);
});

// Additional handlers to ensure isSeeking is reset on pointer release
slider.addEventListener('mouseup', () => isSeeking = false);
slider.addEventListener('touchend', () => isSeeking = false);

// --- Sync Button Logic ---
function handleMainSyncBtn() {
    const isActuallyPlaying = (videoElement && !videoElement.paused);

    log.debug("Sync Btn Clicked. HostConn:", !!hostConn, "Playing:", isActuallyPlaying);
    if (!hostConn) {
        // Host: Reset local offset and trigger Guest-side Sync
        localOffset = 0;
        updateSyncDisplay();
        showToast("모든 기기 재동기화 요청...");
        broadcast({ type: MSG.GLOBAL_RESYNC_REQUEST });
    } else {
        // Guest: Manual local sync
        syncReset();
    }
}

function syncReset() {
    if (!hostConn || !hostConn.open) return;
    // Do NOT clear localOffset here.
    // Users want to keep their manual hardware correction (e.g. BT delay)
    // even when network sync is recalibrated.
    updateSyncDisplay();

    showToast("최적 싱크 보정 적용 중...");
    syncRequestTime = Date.now();
    hostConn.send({ type: MSG.GET_SYNC_TIME });
}

function updateSyncBtnState(isGuest) {
    const btn = document.getElementById('btn-auto-sync');
    if (!btn) return; // Safety check

    // Unify Icon (Refresh) and Text (AUTO SYNC) for both roles
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg> AUTO SYNC`;
}

// --- Networking (Updated from network.html) ---

// Network initialization
async function initNetwork() {
    try {
        let turnConfig = { username: "", credential: "" };

        // 1. Detect local/private network
        const hostname = window.location.hostname;
        const isLocal = ['localhost', '127.0.0.1', '::1'].includes(hostname) ||
            hostname.startsWith('192.168.') ||
            hostname.startsWith('10.') ||
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname);

        if (!isLocal) {
            try {
                // Request config from relay (Netlify Function call)
                const response = await fetch('/.netlify/functions/get-turn-config');

                if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
                    turnConfig = await response.json();
                    log.debug("TURN 설정 로드 완료 (Netlify)");
                } else {
                    log.warn("Netlify Function 사용 불가 - STUN 전용으로 초기화합니다.");
                }
            } catch (fetchErr) {
                log.warn("네트워크 설정 요청 중 오류:", fetchErr.message);
            }
        } else {
            log.debug("[Network] Local/Private environment detected - skipping TURN configuration.");
        }

        // 2. Build options from fetched config
        const iceServers = [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun.relay.metered.ca:80" }
        ];

        // Add TURN server only when not local and TURN config exists
        if (!isLocal && turnConfig.username && turnConfig.credential) {
            iceServers.push(
                {
                    urls: "turn:standard.relay.metered.ca:443",
                    username: turnConfig.username,
                    credential: turnConfig.credential
                },
                {
                    urls: "turn:standard.relay.metered.ca:443?transport=tcp",
                    username: turnConfig.username,
                    credential: turnConfig.credential
                },
                {
                    urls: "turns:standard.relay.metered.ca:443?transport=tcp",
                    username: turnConfig.username,
                    credential: turnConfig.credential
                }
            );
        }

        const peerOpts = {
            debug: 2,
            config: {
                iceServers: iceServers,
                bundlePolicy: 'max-bundle',
                sdpSemantics: 'unified-plan',
                iceTransportPolicy: 'all',
                iceCandidatePoolSize: 0 // Reduced from 10 to 0 for better iOS compatibility
            }
        };

        // 3. Start PeerJS
        peer = new Peer(null, peerOpts);

        // --- Event listeners ---
        setupPeerEvents();

    } catch (e) {
        log.error("네트워크 초기화 중 치명적 오류:", e);
        showToast("네트워크 초기화 실패 (새로고침 하세요)");
    }
}

/**
 * QR 코드 업데이트 함수
 * @param {string} id - 세션 ID
 */
function updateQrCode(id) {
    const qrContainer = document.getElementById("qrcode");
    if (!qrContainer) {
        log.warn("[QR] qrcode 요소를 찾을 수 없습니다.");
        return;
    }

    qrContainer.innerHTML = "";

    // Verify QRCode.js library
    if (typeof QRCode === 'undefined') {
        log.warn("[QR] QRCode 라이브러리가 로드되지 않았습니다.");
        return;
    }

    try {
        new QRCode(qrContainer, {
            text: `${window.location.origin}${window.location.pathname}?host=${id}`,
            width: 160,
            height: 160,
            colorDark: "#000000",
            colorLight: "#ffffff"
        });
    } catch (e) {
        log.error("[QR] QR 코드 생성 실패:", e);
    }

    // Update ID display
    const myIdEl = document.getElementById('my-id');
    if (myIdEl) {
        myIdEl.innerText = hostConn ? "Host ID: " + id : id;
    }
}

function setupPeerEvents() {

    peer.on('error', (err) => {
        log.error("PeerJS Global Error:", err);
        log.error("Error Type:", err.type);

        let message = "네트워크 오류가 발생했습니다.";
        if (err.type === 'browser-incompatible') {
            message = "브라우저가 오디오 동기화(WebRTC)를 지원하지 않습니다.";
        } else if (err.type === 'server-error') {
            message = "PeerJS 서버와 연결할 수 없습니다. (현재 밴되었거나 서버 점검 중일 수 있습니다)";
        } else if (err.type === 'network') {
            message = "네트워크 환경이 불안정하거나 방화벽에서 차단되었습니다.";
        } else if (err.type === 'id-taken') {
            message = "이미 사용 중인 ID입니다. 다시 시도해주세요.";
        } else if (err.type === 'peer-unavailable') {
            // This is often handled in joinSession, but as a global error it's good to log
            message = "연결하려는 대상(Host)을 찾을 수 없습니다.";
        }

        showToast(message);

        // If it's a critical initialization/network error, show the overlay with tips
        // Don't show overlay if we already have an active P2P session (signalling loss is transient)
        const isSessionActive = (hostConn && hostConn.open) || (connectedPeers && connectedPeers.some(p => p.status === 'connected'));

        if (['server-error', 'network', 'browser-incompatible'].includes(err.type)) {
            if (isSessionActive && err.type !== 'browser-incompatible') {
                log.warn("[Network] Signalling server connection lost, but P2P session is active. Skipping overlay.");
                showToast("중계 서버와 연결이 끊겼습니다. (재연결 시도 중...)");
                return;
            }
            showConnectionFailedOverlay(
                message + "\n\n" +
                "1. VPN을 사용 중이라면 끄고 시도해보세요.\n" +
                "2. 브라우저 캐시를 지우거나 다른 브라우저(Chrome/Safari 권장)를 사용해보세요.\n" +
                "3. 공용 Wi-Fi나 회사/학교 망은 차단될 수 있습니다."
            );
        }
    });

    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });

    peer.on('open', id => {
        myId = id;
        const myIdEl = document.getElementById('my-id');
        if (myIdEl) myIdEl.innerText = id;

        updateQrCode(myId);

        const params = new URLSearchParams(window.location.search);
        if (params.get('host')) {
            const hostId = params.get('host');
            document.getElementById('join-id-input').value = hostId;
            log.debug("[QR] Auto-joining host:", hostId);

            // Auto-trigger join session for QR users
            // Removed auto-trigger. Users must click "I'm invited!" button
            // to ensure audio context is unlocked and prevent double-connection race.
            // setTimeout(() => joinSession(), 100);
        } else {
            const hostPanel = document.getElementById('host-panel');
            if (hostPanel) hostPanel.classList.add('visible');

            // Centralized Update
            myDeviceLabel = 'HOST';
            updateRoleBadge();

            updateSyncBtnState(false);

            renderDeviceList([
                { id: myId, label: 'HOST', status: 'connected', isHost: true }
            ]);

            // Heartbeat Monitor (Host checks for voluntary signals)
            clearManagedTimer('heartbeatMonitor');
            managedTimers.heartbeatMonitor = setInterval(() => {
                const now = Date.now();
                let changed = false;

                // 1. Check for Timeouts
                connectedPeers.forEach(p => {
                    if (p.status === 'connected') {
                        // Host does NOT ping. Waits for Guest.

                        // Timeout: 15 seconds (allows 2 lost signals from 5s interval)
                        if (now - p.lastHeartbeat > 15000) {
                            log.warn(`Peer ${p.label} timed out.`);
                            p.status = 'disconnected';
                            changed = true;
                            showToast(`${p.label} 제거됨(무응답)`);
                        }
                    }
                });

                // 2. Boldly Remove Disconnected Peers
                if (changed) {
                    // FORCE UPDATE: Reassign global array and CLEAN UP orphans
                    const toRemove = connectedPeers.filter(p => p.status === 'disconnected');
                    toRemove.forEach(p => {
                        if (p._relayMonitor) clearInterval(p._relayMonitor);
                        if (p._heartbeatTimer) clearInterval(p._heartbeatTimer);
                    });

                    connectedPeers = connectedPeers.filter(p => p.status !== 'disconnected');
                    broadcastDeviceList();
                }
            }, 1000);
        }
    });

    // Host Logic
    peer.on('connection', conn => {
        // Check for Data Relay Connection
        if (conn.metadata && conn.metadata.type === MSG.DATA_RELAY) {
            handleRelayConnection(conn);
            return;
        }

        // Duplicate check: If this peer ID is already connected, close the old one
        const existingIdx = connectedPeers.findIndex(p => p.id === conn.peer);
        if (existingIdx !== -1) {
            log.warn(`[Network] Duplicate connection from ${conn.peer}. Replacing old one.`);
            const oldPeer = connectedPeers[existingIdx];
            if (oldPeer.conn && oldPeer.conn.open) {
                try {
                    oldPeer.conn.send({ type: MSG.FORCE_CLOSE_DUPLICATE });
                    oldPeer.conn.close();
                } catch (e) { /* best-effort close on duplicate peer */ }
            }
            connectedPeers.splice(existingIdx, 1);
        }

        // [STABILIZATION] 1. Label/Counter memory check
        if (!peerLabels[conn.peer]) {
            deviceCounter++;
            peerLabels[conn.peer] = `DEVICE ${deviceCounter}`;
        }
        const deviceName = peerLabels[conn.peer];
        const numericOrder = parseInt((deviceName.match(/\d+/) || [0])[0]);

        // [STABILIZATION] 2. Immediate Peer Registration (Prevent duplicate race)
        const peerObj = {
            id: conn.peer,
            label: deviceName,
            joinOrder: numericOrder, // Stable monotonic ID for loop prevention
            status: 'connecting',
            conn: conn,
            isOp: false,
            isDataTarget: true,
            lastHeartbeat: Date.now()
        };
        connectedPeers.push(peerObj);

        conn.on('open', () => {
            peerObj.status = 'connected';
            peerObj.lastHeartbeat = Date.now();
            log.debug(`[Network] Connection opened for ${deviceName} (${conn.peer})`);

            const curItem = (currentTrackIndex >= 0) ? playlist[currentTrackIndex] : null;

            broadcastDeviceList();
            showToast(`${deviceName} 연결됨`);

            // --- Relay Assignment Logic (STABLE ACYCLIC STRATEGY) ---
            // Direct peers: 1, 2. Relays: 3, 4, 5...
            // Strategy: Peer N picks Peer (N-2) or (N-4) as parent.
            // Since (N-x) < N, a cycle is mathematically impossible.
            if (connectedPeers.length > MAX_DIRECT_DATA_PEERS) {
                let assigned = false;

                // Sort by joinOrder to be absolutely sure about seniority
                const seniors = connectedPeers
                    .filter(p => p.status === 'connected' && p.joinOrder < peerObj.joinOrder && p.id !== conn.peer)
                    .sort((a, b) => b.joinOrder - a.joinOrder); // Newest senior first

                log.debug(`[Relay] Evaluating ${deviceName} (joinOrder: ${peerObj.joinOrder}) for relay. Seniors found: ${seniors.length}`);

                for (const candidate of seniors) {
                    if (candidate.conn && candidate.conn.open) {
                        // Lane Logic: Prefer same parity (Odd/Even joinOrder)
                        const candidateParity = candidate.joinOrder % 2;
                        const myParity = peerObj.joinOrder % 2;
                        log.debug(`[Relay] Checking candidate ${candidate.label} (Parity: ${candidateParity}, MyParity: ${myParity})`);

                        if (candidateParity === myParity) {
                            log.debug(`[Relay] Assigned ${deviceName} -> ${candidate.label}`);
                            conn.send({ type: MSG.ASSIGN_DATA_SOURCE, targetId: candidate.id });
                            showToast(`Data Relay: ${deviceName} -> ${candidate.label}`);
                            peerObj.isDataTarget = false;
                            peerObj.assignedRelay = candidate.id;
                            assigned = true;
                            break;
                        }
                    }
                }

                // Fallback to any senior if lane match fails
                if (!assigned && seniors.length > 0) {
                    const candidate = seniors[0];
                    if (candidate.conn && candidate.conn.open) {
                        log.debug(`[Relay] Fallback Assignment: ${deviceName} -> ${candidate.label}`);
                        conn.send({ type: MSG.ASSIGN_DATA_SOURCE, targetId: candidate.id });
                        showToast(`Data Relay (Lane Fallback): ${deviceName} -> ${candidate.label}`);
                        peerObj.isDataTarget = false;
                        peerObj.assignedRelay = candidate.id;
                        assigned = true;
                    }
                }

                if (!assigned) {
                    log.warn(`[Relay] Could not assign relay for ${deviceName} even though seniors existed.`);
                }
            }
            // -----------------------------

            // Set up relay lane reassignment on parent disconnect
            if (!peerObj.isDataTarget && peerObj.assignedRelay) {
                // Monitor the assigned relay peer
                const monitorRelay = () => {
                    const relay = connectedPeers.find(p => p.id === peerObj.assignedRelay);
                    if (!relay || relay.status !== 'connected') {
                        log.debug(`[Relay] Parent ${peerObj.assignedRelay} lost, attempting recovery for ${deviceName}`);

                        // Find a new parent: nearest senior in the same lane
                        const juniors = connectedPeers
                            .filter(p => p.status === 'connected' && p.joinOrder < peerObj.joinOrder && p.id !== conn.peer)
                            .sort((a, b) => b.joinOrder - a.joinOrder);

                        let newParent = null;
                        for (const candidate of juniors) {
                            if (candidate.conn && candidate.conn.open && (candidate.joinOrder % 2) === (peerObj.joinOrder % 2)) {
                                newParent = candidate;
                                break;
                            }
                        }

                        if (newParent) {
                            log.debug(`[Relay] Reassigning ${deviceName} to senior ${newParent.label}`);
                            peerObj.assignedRelay = newParent.id;
                            peerObj.isDataTarget = false;
                            if (conn.open) {
                                conn.send({ type: MSG.ASSIGN_DATA_SOURCE, targetId: newParent.id, reason: 'parent-lost' });
                            }
                            showToast(`${deviceName} -> ${newParent.label} (릴레이 재배정)`);
                        } else {
                            log.debug(`[Relay] No seniors in lane, reassigning ${deviceName} to Host Direct`);
                            peerObj.isDataTarget = true;
                            peerObj.assignedRelay = null;

                            if (conn.open) {
                                conn.send({ type: MSG.ASSIGN_DATA_SOURCE, targetId: null, reason: 'parent-lost' });
                            }
                            showToast(`${deviceName} -> Host Direct (릴레이 끊김)`);

                            // Stop monitoring once reassigned to Host (no more seniors will ever exist for this joinOrder)
                            if (peerObj._relayMonitor) {
                                clearInterval(peerObj._relayMonitor);
                                peerObj._relayMonitor = null;
                            }
                        }
                    }
                };
                // Check every RELAY_MONITOR_INTERVAL ms
                peerObj._relayMonitor = setInterval(monitorRelay, RELAY_MONITOR_INTERVAL);
            }
            // -----------------------------

            conn.send({ type: MSG.WELCOME, label: deviceName });
            conn.send({ type: MSG.VOLUME, value: masterVolume });
            conn.send({ type: MSG.REVERB, value: reverbMix * 100 });
            conn.send({ type: MSG.REPEAT_MODE, value: repeatMode });
            conn.send({ type: MSG.SHUFFLE_MODE, value: isShuffle });
            conn.send({
                type: MSG.PLAYLIST_UPDATE,
                list: playlist.map(item => ({
                    type: item.type,
                    name: item.name || item.title,
                    videoId: item.videoId || null,
                    playlistId: item.playlistId || null
                }))
            });

            // Send current YouTube state if active
            if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
                try {
                    const videoData = youtubePlayer.getVideoData();
                    conn.send({
                        type: MSG.YOUTUBE_PLAY,
                        videoId: (videoData && videoData.video_id) ? videoData.video_id : (curItem ? curItem.videoId : null),
                        playlistId: curItem ? curItem.playlistId : null,
                        index: currentTrackIndex,
                        subIndex: currentYouTubeSubIndex
                    });
                    // Send current time sync after short delay (let guest load player first)
                    setTimeout(() => {
                        if (youtubePlayer && conn.open) {
                            conn.send({
                                type: MSG.YOUTUBE_SYNC,
                                time: youtubePlayer.getCurrentTime(),
                                state: youtubePlayer.getPlayerState(),
                                subIndex: currentYouTubeSubIndex
                            });
                        }
                    }, 3000);
                } catch (e) {
                    log.error("[YouTube] Failed to send state to new guest:", e);
                }
            }

            broadcastDeviceList();

            if (curItem && curItem.type !== 'youtube') {
                conn.send({
                    type: MSG.FILE_PREPARE,
                    name: curItem.name,
                    index: currentTrackIndex,
                    sessionId: currentTransferSessionId // Include session ID for late joiners
                });
            }

            // Late Joiner Media Guard:
            // If Host is still extracting audio from a video, do NOT send the MP4 file yet.
            // The guest will receive the WAV file automatically when broadcastFile(wavFile) is called later.
            if (peerObj.isDataTarget && playlist[currentTrackIndex]?.file && !playlist[currentTrackIndex]?._isExtracting) {
                unicastFile(conn, playlist[currentTrackIndex].file);
            } else if (playlist[currentTrackIndex]?._isExtracting) {
                log.debug(`[Host] Guest joined during extraction. Skipping unicast, waiting for broadcast.`);
                conn.send({ type: MSG.FILE_WAIT, message: '오디오 추출 중... 잠시만 기다려주세요.' });
            }

            // Move all conditional listeners INSIDE open callback so peerObj is in scope
            conn.on('data', data => {
                // Zombie Revival: If this peer was dropped (e.g. timeout) but is still talking, re-add it!
                if (conn.open && !connectedPeers.find(p => p.id === peerObj.id)) {
                    log.debug(`[Network] Reviving zombie connection: ${peerObj.label}`);
                    peerObj.status = 'connected';
                    peerObj.lastHeartbeat = Date.now();
                    connectedPeers.push(peerObj);
                    broadcastDeviceList();
                }

                if (data.type === MSG.HEARTBEAT || data.type === MSG.HEARTBEAT_ACK) {
                    peerObj.lastHeartbeat = Date.now();

                    if (!hostConn) { // Only genuine Host responds
                        const isActuallyPlaying = (videoElement && !videoElement.paused);

                        conn.send({
                            type: MSG.STATUS_SYNC,
                            currentTrackIndex: currentTrackIndex,
                            isPlaying: isActuallyPlaying,
                            repeatMode: repeatMode,
                            isShuffle: isShuffle,
                            playlistMeta: playlist.map(item => ({
                                type: item.type,
                                name: item.name || item.title,
                                videoId: item.videoId || null,
                                playlistId: item.playlistId || null
                            }))
                        });
                    }
                    return;
                }

                if (data.type === MSG.PING_LATENCY) {
                    conn.send({ type: MSG.PONG_LATENCY, timestamp: data.timestamp });
                    return;
                }

                if (data.type === MSG.GET_SYNC_TIME) {
                    const currentTime = getTrackPosition();
                    const isActuallyPlaying = (videoElement && !videoElement.paused);
                    conn.send({ type: MSG.SYNC_RESPONSE, time: currentTime, isPlaying: isActuallyPlaying });
                }
                else if (peerObj.isOp) {
                    handleOperatorRequest(data);
                }
                else if (data.type === MSG.PRELOAD_ACK) {
                    if (!peerObj.preloadedIndexes) peerObj.preloadedIndexes = new Set();
                    peerObj.preloadedIndexes.add(data.index);
                    log.debug(`[Host] Guest ${peerObj.id} confirmed preload for index ${data.index}`);
                }
                else if (data.type === MSG.REQUEST_YOUTUBE_PLAYLIST_INFO) {
                    const pid = data.playlistId;
                    if (youtubeSubItemsMap[pid]) {
                        conn.send({
                            type: MSG.YOUTUBE_PLAYLIST_INFO,
                            playlistId: pid,
                            ids: youtubeSubItemsMap[pid].ids,
                            titles: youtubeSubItemsMap[pid].titles
                        });
                    }
                }
                else if (data.type === MSG.REQUEST_DATA_RECOVERY) {
                    const fileName = data.fileName;
                    const recoveryIndex = data.index;
                    const nextChunk = data.nextChunk || 0;
                    const peerId = conn.peer;

                    // Rate-limit recovery requests per peer (min 5s between requests)
                    const RECOVERY_COOLDOWN_MS = 5000;
                    if (!_recoveryInProgress) _recoveryInProgress = {};
                    if (!_recoveryLastRequest) _recoveryLastRequest = {};
                    if (_recoveryInProgress[peerId]) return;
                    const lastReq = _recoveryLastRequest[peerId] || 0;
                    if (Date.now() - lastReq < RECOVERY_COOLDOWN_MS) {
                        log.warn(`[Recovery] Rate-limited request from ${peerId.substr(-4)}`);
                        return;
                    }
                    _recoveryLastRequest[peerId] = Date.now();

                    let item = playlist.find(f => f.name === fileName);
                    if (!item && recoveryIndex !== undefined && playlist[recoveryIndex]) {
                        item = playlist[recoveryIndex];
                    }

                    if (item && item.file) {
                        _recoveryInProgress[peerId] = true;
                        const queueDelay = Object.keys(_recoveryInProgress).length * 200;
                        setTimeout(async () => {
                            try {
                                if (conn.open) {
                                    showToast(`Recovering ${peerObj.label}: chunk ${nextChunk}`);
                                    await unicastFile(conn, item.file, nextChunk);
                                }
                            } finally {
                                delete _recoveryInProgress[peerId];
                            }
                        }, queueDelay);
                    }
                }
                else if (data.type === MSG.CHAT) {
                    addChatMessage(data.sender, data.text, false);
                    connectedPeers.forEach(p => {
                        if (p.status === 'connected' && p.conn.open && p.id !== conn.peer) {
                            p.conn.send({ type: MSG.CHAT, sender: data.sender, text: data.text });
                        }
                    });
                }
            });

            conn.on('close', () => {
                if (peerObj._relayMonitor) {
                    clearInterval(peerObj._relayMonitor);
                    peerObj._relayMonitor = null;
                }
                peerObj.status = 'disconnected';
                peerObj.lastSeen = Date.now();
                broadcastDeviceList();
                showToast(`${deviceName} 연결 끊김`);

                setTimeout(() => {
                    if (peerObj.status === 'disconnected') {
                        connectedPeers = connectedPeers.filter(p => p.id !== peerObj.id);
                        broadcastDeviceList();
                    }
                }, 30000);
            });

            conn.on('error', () => {
                peerObj.status = 'disconnected';
                broadcastDeviceList();
            });
        });
    });
}


// Guest Logic
let connectionRetryCount = 0;
const MAX_CONNECTION_RETRIES = 3;
const CONNECTION_TIMEOUT_MS = 7000; // Reduced from 10s to 7s for faster retry if it hangs
let connectionTimeoutId = null;

function joinSession(retryAttempt = 0) {
    // 1. When Peer object is not ready (initializing)
    if (!peer || !peer.open) {
        // Log retry count
        log.warn(`[Network] Peer not ready yet. Waiting... (${retryAttempt}/20)`);

        // Wait up to 20 retries (~10s), then give up
        if (retryAttempt > 20) {
            showConnectionFailedOverlay(
                "네트워크 초기화에 실패했습니다.\n\n" +
                "1. 잠시 후 '새로고침' 해보세요. (서버 부팅 중일 수 있음)\n" +
                "2. VPN이나 사내 보안망을 끄고 시도해보세요."
            );
            return;
        }

        // Retry after 0.5s with incremented count
        setTimeout(() => joinSession(retryAttempt + 1), 500);
        return;
    }

    if (isConnecting && retryAttempt === 0) {
        log.warn("[Network] joinSession already in progress. Ignoring duplicate call.");
        return;
    }
    isConnecting = true;

    const hostId = document.getElementById('join-id-input').value.trim();
    if (!hostId) return showToast("ID 입력 필요");

    // New attempt: Reset intentional flag
    isIntentionalDisconnect = false;

    // UI Reset: Rebranding to "Connecting" state (Gray)
    // Using updateRoleBadge will handle generic "OFFLINE" or "GUEST" but we want "Connecting..."
    // For connecting state, we might manually override text after calling update (or update function to support it)
    // For now, let's keep specific connection UI logic local but clean up the badge reset
    const roleBadge = document.getElementById('role-badge');
    if (roleBadge) {
        roleBadge.classList.remove('connected');
        roleBadge.style.background = '';
        roleBadge.style.boxShadow = '';
    }

    // Show connection status
    if (retryAttempt === 0) {
        showToast("Host에 연결 중...");
        updateRoleBadge();
    } else {
        // Connection timeout toast already shown, just update UI
        document.getElementById('role-text').innerText = `재연결 ${retryAttempt}/${MAX_CONNECTION_RETRIES}`;
    }

    initAudio();
    if (hostConn) hostConn.close();

    // Clear any existing timeout
    if (connectionTimeoutId) {
        clearTimeout(connectionTimeoutId);
        connectionTimeoutId = null;
    }

    hostConn = peer.connect(hostId, { reliable: true });
    window.hostConn = hostConn; // Sync for demo.js access

    // Connection Timeout Handler
    connectionTimeoutId = setTimeout(() => {
        if (hostConn && !hostConn.open) {
            log.warn(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`);
            hostConn.close();

            if (retryAttempt < MAX_CONNECTION_RETRIES) {
                isConnecting = false;
                showToast(`연결 시간 초과. 재시도 중... (${retryAttempt + 1}/${MAX_CONNECTION_RETRIES})`);
                // Exponential Backoff
                const backoffDelay = 1000 * Math.pow(1.5, retryAttempt);
                setTimeout(() => joinSession(retryAttempt + 1), backoffDelay);
            } else {
                isConnecting = false;
                showConnectionFailedOverlay("연결 시간이 초과되었습니다. Host가 온라인인지 확인하세요.");
            }
        }
    }, CONNECTION_TIMEOUT_MS);

    hostConn.on('open', () => {
        // Clear timeout on successful connection
        if (connectionTimeoutId) {
            clearTimeout(connectionTimeoutId);
            connectionTimeoutId = null;
        }
        isConnecting = false;
        connectionRetryCount = 0; // Reset retry counter

        // Remove connection failed overlay if present (from retry)
        const failedOverlay = document.getElementById('connection-failed-overlay');
        if (failedOverlay) failedOverlay.remove();

        showToast("Host 연결됨!");

        // Centralized Update
        myDeviceLabel = 'GUEST';
        updateRoleBadge();

        updateSyncBtnState(true);

        updateQrCode(hostId);
        const hostPanel = document.getElementById('host-panel');
        if (hostPanel) hostPanel.classList.add('visible');

        // Volunteer Heartbeat: Send to Host every 5s (Worker)
        postWorkerCommand({ command: 'START_TIMER', id: 'heartbeat', interval: 5000 });

        // Latency Ping (2s) (Worker)
        postWorkerCommand({ command: 'START_TIMER', id: 'ping', interval: 2000 });

        // Detect ICE connection type after connection stabilizes
        setTimeout(() => detectConnectionType(), 2000);

        const leaveBtn = document.getElementById('btn-leave-session');
        if (leaveBtn) leaveBtn.style.display = 'flex';
        switchTab('play');
    });

    hostConn.on('error', (err) => {
        log.error("PeerJS Connection Error:", err);

        // Clear timeout
        if (connectionTimeoutId) {
            clearTimeout(connectionTimeoutId);
            connectionTimeoutId = null;
        }

        // Retry logic with backoff
        if (retryAttempt < MAX_CONNECTION_RETRIES) {
            showToast(`연결 오류. 재시도 중... (${retryAttempt + 1}/${MAX_CONNECTION_RETRIES})`);
            const backoffDelay = 1500 * Math.pow(1.5, retryAttempt);
            setTimeout(() => joinSession(retryAttempt + 1), backoffDelay);
        } else {
            showConnectionFailedOverlay("연결 오류 발생: " + err.type);
        }
    });

    hostConn.on('data', handleData);
    hostConn.on('close', () => {
        // Clear timeout if still pending
        if (connectionTimeoutId) {
            clearTimeout(connectionTimeoutId);
            connectionTimeoutId = null;
        }

        // Stop Worker Timers
        postWorkerCommand({ command: 'STOP_TIMER', id: 'heartbeat' });
        postWorkerCommand({ command: 'STOP_TIMER', id: 'ping' });

        if (!isIntentionalDisconnect && retryAttempt < MAX_CONNECTION_RETRIES) {
            // If we are already in joinSession (isConnecting=true), don't trigger another one
            if (isConnecting) {
                log.debug("[Network] Connection closed but another attempt is already in progress. Skipping retry.");
                return;
            }

            isConnecting = false;
            log.warn(`Unexpected connection close. Retrying (${retryAttempt + 1}/${MAX_CONNECTION_RETRIES})`);
            showToast(`연결 끊김. 재시도 중... (${retryAttempt + 1}/${MAX_CONNECTION_RETRIES})`);

            const backoffDelay = 1500 * Math.pow(1.5, retryAttempt);
            setTimeout(() => joinSession(retryAttempt + 1), backoffDelay);
        } else {
            isConnecting = false;
            if (!isIntentionalDisconnect) {
                showConnectionFailedOverlay("Host와 연결이 끊어졌습니다");
            }
            showToast("Host 끊김");
            // Centralized Update
            updateRoleBadge();

            // Clear any inline styles left by detectConnectionType
            const roleBadge = document.getElementById('role-badge');
            if (roleBadge) {
                roleBadge.style.background = '';
                roleBadge.style.boxShadow = '';
            }
            updateSyncBtnState(false);
        }
    });
}

// Helper: Show connection failed overlay with retry option
function showConnectionFailedOverlay(message) {
    // Remove existing overlay if any
    const existing = document.getElementById('connection-failed-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'connection-failed-overlay';
    overlay.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.85);
        z-index: 9999; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 20px;
    `;
    overlay.innerHTML = `
        <h2 style="color:white; font-size: 24px; text-align: center; padding: 0 20px;">${message}</h2>
        <div style="display: flex; gap: 12px; flex-wrap: wrap; justify-content: center;">
            <button onclick="document.getElementById('connection-failed-overlay').remove(); joinSession(0);" style="
                padding: 12px 30px; background: var(--primary, #3b82f6); color: white;
                border: none; border-radius: 12px; font-weight: bold; font-size: 16px; cursor: pointer;
            ">다시 시도</button>
            <button onclick="window.location.href = window.location.pathname" style="
                padding: 12px 30px; background: #ef4444; color: white;
                border: none; border-radius: 12px; font-weight: bold; font-size: 16px; cursor: pointer;
            ">나가기</button>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('role-text').innerText = "연결 실패";
}

async function leaveSession() {
    log.debug("[Musixquare] Leaving session and resetting state...");

    // Set intentional disconnect flag first to prevent retry logic
    isIntentionalDisconnect = true;

    clearAllManagedTimers();

    // [Cleanup PeerJS]
    if (hostConn) {
        try {
            if (typeof hostConn.close === 'function') hostConn.close();
        } catch (e) { /* best-effort close on host connection */ }
        hostConn = null;
        window.hostConn = null;
    }

    if (peer) {
        try {
            if (typeof peer.destroy === 'function') peer.destroy();
        } catch (e) { /* best-effort destroy on peer instance */ }
        peer = null;
    }

    // [Cleanup Guests/Downstreams]
    connectedPeers.forEach(p => {
        try {
            if (p.conn && typeof p.conn.close === 'function') p.conn.close();
        } catch (e) { /* best-effort close on guest connection */ }
    });
    connectedPeers = [];
    downstreamDataPeers = [];

    // [Cleanup Media & State]
    stopAllMedia();

    // Clear Core State
    myDeviceLabel = 'HOST';
    isOperator = false;
    isConnecting = false;

    // Clear Playlist & Files
    currentTrackIndex = -1;
    playlist = [];
    meta = null;
    currentFileBlob = null;
    nextFileBlob = null;
    preloadMeta = null;
    receivedCount = 0;
    incomingChunks = [];
    localOffset = 0;
    autoSyncOffset = 0;
    currentYouTubeSubIndex = -1;
    youtubeSubItemsMap = {};
    currentTransferSessionId = 0;

    // Reset UI
    updatePlaylistUI();
    renderDeviceList([]);
    updateRoleBadge();
    updateTitleWithMarquee("MUSIXQUARE");

    const trackArtistEl = document.getElementById('track-artist');
    if (trackArtistEl) trackArtistEl.innerText = "Select a file or check Playlist";

    document.getElementById('play-btn').disabled = true;
    document.getElementById('seek-slider').disabled = true;
    document.getElementById('seek-slider').value = 0;
    document.getElementById('time-curr').innerText = "0:00";
    document.getElementById('time-dur').innerText = "0:00";

    const myIdEl = document.getElementById('my-id');
    if (myIdEl) myIdEl.innerText = 'ID 생성 중...';

    const joinIdInput = document.getElementById('join-id-input');
    if (joinIdInput) joinIdInput.value = '';

    // Cleanup Chat
    const chatDrawer = document.getElementById('chat-drawer');
    if (chatDrawer) chatDrawer.classList.remove('open');
    const chatBadge = document.getElementById('chat-preview-badge');
    if (chatBadge) chatBadge.classList.remove('show');
    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) chatMessages.innerHTML = '<div class="chat-empty">메시지가 없습니다.<br>첫 메시지를 보내보세요!</div>';

    unreadChatCount = 0;
    lastChatSender = '';
    lastChatText = '';
    isChatDrawerOpen = false;

    // Global Window State
    _activeBroadcastSession = null;
    _pendingFileName = null;
    _pendingFileIndex = null;
    _ytIOSWatchdog = null;
    _ytScriptLoading = false;
    window.isYouTubeAPIReady = false;

    if (window.BlobURLManager) BlobURLManager.revoke();

    setState(APP_STATE.IDLE);

    // Re-run network init to get a fresh ID for next time
    // We wait for previous destruction and clear state before starting new one
    await initNetwork();

    showToast("세션에서 나갔습니다.");

    // Update visibility of the leave button itself
    const leaveBtn = document.getElementById('btn-leave-session');
    if (leaveBtn) leaveBtn.style.display = 'none';

    log.debug("[Musixquare] Session left and state reset.");
}

// --- Data Handling ---
// Note: currentFileOpfs, preloadFileOpfs handles are used for storage

// Detect ICE connection type and set compensation mode
async function detectConnectionType() {
    if (!hostConn || !hostConn.peerConnection) {
        log.debug("[ICE] No peer connection available");
        return;
    }

    try {
        const stats = await hostConn.peerConnection.getStats();
        let connectionType = 'unknown';

        stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                // Check local and remote candidate types
                const localId = report.localCandidateId;
                const remoteId = report.remoteCandidateId;

                stats.forEach(candidate => {
                    if (candidate.id === localId || candidate.id === remoteId) {
                        if (candidate.candidateType === 'relay') {
                            connectionType = 'relay';
                        } else if (connectionType !== 'relay') {
                            connectionType = candidate.candidateType; // 'host' or 'srflx'
                        }
                    }
                });
            }
        });

        if (connectionType === 'relay') {
            usePingCompensation = true;
            log.debug("[ICE] TURN Relay detected - Using RTT/2 compensation");
            showToast("원격 네트워크 감지 - 자동 보정 활성화");

            // Change badge to orange (relay)
            const roleBadge = document.getElementById('role-badge');
            if (roleBadge) {
                roleBadge.style.background = '#fb923c';
                roleBadge.title = '원격 네트워크 (릴레이)';
            }
        } else if (connectionType === 'host' || connectionType === 'srflx') {
            usePingCompensation = false;
            log.debug(`[ICE] Direct connection (${connectionType}) - No ping compensation`);
            showToast("로컬 네트워크 감지 - 직접 동기화");
            // Keep default blue (set by CSS)
        } else {
            usePingCompensation = true; // Fallback: apply compensation
            log.debug("[ICE] Unknown connection type - Using RTT/2 compensation as fallback");
        }
    } catch (e) {
        log.error("[ICE] Detection failed:", e);
        usePingCompensation = true; // Fallback
    }
}

// Helper: Clear all previous track state to prevent data mixing
function clearPreviousTrackState(reason = '') {
    log.debug(`[State Clear] Clearing previous track state. Reason: ${reason}`);

    // Stop timers (using centralized timer system)
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('prepareWatchdog');

    // Clear relay queues to prevent stale chunks from being forwarded
    relayChunkQueue = [];
    downstreamDataPeers.forEach(p => {
        if (p._relayQueue) p._relayQueue = [];
    });

    // Release old chunk array for GC, then create new one
    if (incomingChunks && incomingChunks.length > 1000) {
        log.debug(`[GC] Releasing large chunk array (${incomingChunks.length} items)`);
    }
    incomingChunks = []; // Replaces old reference, old array becomes GC target

    // Reorder Buffer Cleanup: Prevent memory growth across tracks
    if (typeof fileReorderBuffer !== 'undefined') fileReorderBuffer.clear();
    if (typeof preloadReorderBuffer !== 'undefined') preloadReorderBuffer.clear();
    nextExpectedChunk = 0;
    nextExpectedPreloadChunk = 0;

    receivedCount = 0;

    meta = {}; // Old meta reference released for GC

    currentFileBlob = null;

    // CRITICAL: Clear audio buffer to prevent previous track from replaying
    if (currentAudioBuffer) {
        log.debug(`[State Clear] Clearing currentAudioBuffer`);
        currentAudioBuffer = null;
    }
    stopPlayerNode();  // Stop any playing audio
    _skipIncomingFile = false;
    _isProcessingBlob = false;
    window._pendingEarlyChunks = [];
    _pendingPlayTime = undefined; // Clear pending play intention on track change

    // Reset state to IDLE so that subsequent sync/play commands for the new track 
    // are not ignored as "already playing" stale state.
    if (currentState === APP_STATE.PLAYING_AUDIO) {
        setState(APP_STATE.IDLE);
    }

    // Clear preload-ack tracking for current track (allow new acks for next track)
    if (_preloadAckSent) _preloadAckSent.clear();

    BlobURLManager.revoke();

    if (videoElement) {
        videoElement.pause();
        videoElement.src = '';
        videoElement.load();
    }
    // Physically delete the OLD current file from OPFS when switching tracks
    if (currentFileOpfs.name) {
        // RESET worker slot first to clear lock
        postWorkerCommand({ command: 'OPFS_RESET', isPreload: false });
        cleanupOPFSInWorker(currentFileOpfs.name, false);
        currentFileOpfs.name = null;
    }

    // Note: We do NOT clear preload state here (nextFileBlob, preloadChunks, etc.)
    // Those are intentionally preserved for upcoming track switch
}

// --- Data Message Handlers ---
async function handleFilePrepare(data) {
    // Increment token to invalidate any previous async operations
    const myLoadToken = ++_currentLoadToken;

    // Immediate Session Check to invalidate old chunks
    const incomingSid = data.sessionId;
    if (incomingSid && incomingSid > localTransferSessionId) {
        log.debug(`[file-prepare] New session detected: ${incomingSid} (Previous: ${localTransferSessionId}). Invalidating old chunks.`);
        localTransferSessionId = incomingSid;

        // Force reset waiting flags on new session
        if (_waitingForPreload) {
            log.debug(`[file-prepare] Clearing stale _waitingForPreload flag`);
            _waitingForPreload = false;
            clearManagedTimer('preloadWatchdog');
        }
    }

    // Immediate stop for Guest during transition
    // Ensures old song stops even if we return early to wait for preload
    stopAllMedia();

    // Check if we already have this track preloaded!
    const hasPreloadedByIndex = nextMeta && data.index !== undefined && data.index === nextMeta.index;
    const hasPreloadedByName = nextMeta && data.name && data.name === nextMeta.name;

    // Also check if preload is IN PROGRESS for this track
    const preloadInProgressByIndex = preloadMeta && data.index !== undefined && data.index === preloadMeta.index;
    const preloadInProgressByName = preloadMeta && data.name && data.name === preloadMeta.name;

    // DEBUG: Log preload matching status
    log.debug("[file-prepare] Checking preload:", {
        dataIndex: data.index,
        dataName: data.name,
        nextMetaIndex: nextMeta?.index,
        nextMetaName: nextMeta?.name,
        hasNextFileBlob: !!nextFileBlob,
        matchByIndex: hasPreloadedByIndex,
        matchByName: hasPreloadedByName,
        preloadInProgress: preloadInProgressByIndex || preloadInProgressByName
    });

    // Verify Preload Index: Don't use stale preload metadata from a different track
    const isMismatch = nextMeta && data.index !== undefined && data.index !== nextMeta.index;
    if (isMismatch) {
        log.warn(`[file-prepare] Preload index mismatch! Request: ${data.index}, Preloaded: ${nextMeta.index}. Clearing stale preload.`);

        // Reset waiting flags to prevent getting stuck
        if (_waitingForPreload) {
            _waitingForPreload = false;
            log.debug("Cancelled stuck preload wait due to mismatch");
        }
        if (_preloadWatchdog) {
            clearTimeout(_preloadWatchdog);
            _preloadWatchdog = null;
        }

        clearPreloadState();
    }

    if (nextFileBlob && (hasPreloadedByIndex || hasPreloadedByName)) {

        log.debug("[Guest] ?? Using preloaded track instead of re-downloading:", data.name);
        showToast("프리로드된 파일 사용!");

        currentTrackIndex = data.index !== undefined ? data.index : currentTrackIndex;
        updatePlaylistUI();

        // Use preloaded file directly
        await loadPreloadedTrack(data.index, myLoadToken);

        // CRITICAL: Hide loader so play() doesn't think we're still downloading
        showLoader(false);

        // Mark that we already loaded this track (prevent duplicate load from play-preloaded)
        _preloadUsedForIndex = data.index;

        // Mark that we're skipping incoming file transfer
        _skipIncomingFile = true;
        return;
    }


    // CHECK: If preload is IN PROGRESS for this track, wait for it instead of starting new download
    if (preloadInProgressByIndex || preloadInProgressByName) {
        const incomingSid = data.sessionId;
        if (!incomingSid) return; // Strict validation

        // Resolve Deadlock: If Host has started Main Session (SID increased), prioritize it over preload
        if (incomingSid > localTransferSessionId) {
            log.debug("[file-prepare] Preload in progress but Host started Main Session. Prioritizing Main.");
            localTransferSessionId = incomingSid;
            clearPreloadState();
            // Continue to normal flow below (_skipIncomingFile = false)
        } else {
            log.debug("[file-prepare] Preload in progress for this track, waiting...");
            showLoader(true, `프리로드 완료 대기 중: ${data.name}`);

            // Set pending info
            window._pendingFileName = data.name;
            _pendingFileIndex = data.index;
            _waitingForPreload = true;
            _skipIncomingFile = true; // Skip any file-start that might come

            currentTrackIndex = data.index !== undefined ? data.index : currentTrackIndex;
            updatePlaylistUI();

            // Preload Watchdog: If preloading fails to complete, recover after 10s
            if (_preloadWatchdog) clearTimeout(_preloadWatchdog);
            _preloadWatchdog = setTimeout(() => {
                if (_waitingForPreload) {
                    log.warn("[Guest] Preload wait timed out. Force recovering...");
                    _waitingForPreload = false;
                    showLoader(false);
                    if (hostConn && hostConn.open) hostConn.send({ type: MSG.REQUEST_CURRENT_FILE });
                }
            }, 10000);

            return; // Don't start new download
        }
    }

    // Normal flow: No preload available, prepare for download
    _skipIncomingFile = false;
    _waitingForPreload = false;

    // Store pending file name for recovery requests
    window._pendingFileName = data.name;
    _pendingFileIndex = data.index;

    // CRITICAL: Don't clear state if we're resuming the SAME file!
    // This preserves already-received chunks during recovery
    const isSameFile = (meta && meta.name === data.name) ||
        (_pendingFileIndex !== undefined && _pendingFileIndex === data.index);
    const isResuming = isSameFile && receivedCount > 0;

    if (isResuming) {
        log.debug(`[file-prepare] Same file in progress (${receivedCount} chunks), skipping reset`);
        showLoader(true, `복구 대기 중: ${data.name}`);
    } else {
        // Clear previous track state before receiving new file
        clearPreviousTrackState('file-prepare (new download)');
        showLoader(true, `준비 중: ${data.name}`);
        // stopAllMedia(); // Removed - already called at the top of handler
        if (data.index !== undefined) {
            currentTrackIndex = data.index;
            updatePlaylistUI();
        }

        // Ensure meta is populated for fallback/recovery logic
        // Merge with existing meta to preserve 'total' and other fields
        meta = {
            ...meta,
            name: data.name || window._pendingFileName || (meta ? meta.name : ''),
            index: data.index !== undefined ? data.index : (_pendingFileIndex !== undefined ? _pendingFileIndex : currentTrackIndex),
            size: data.size || (meta ? meta.size : 0),
            mime: data.mime || (meta ? meta.mime : ''),
            sessionId: data.sessionId || localTransferSessionId // Store sessionId in meta
        };
        // Stop YouTube mode AFTER updatePlaylistUI to prevent title overwrite
        if (currentState === APP_STATE.PLAYING_YOUTUBE) {
            log.debug("[file-prepare] Stopping YouTube mode for incoming local file");
            stopYouTubeMode();
        }
        // Set title LAST to ensure it's not overwritten
        updateTitleWithMarquee(data.name);
        document.getElementById('track-artist').innerText = `Track ${data.index + 1}`;
    } // Close the else block from isResuming check

    // FIX 5: Prepare Watchdog (Prevent Infinite Preparing...)
    // Set fallback watchdog: If no chunks arrive within 12 seconds, something failed
    managedTimers.prepareWatchdog = setTimeout(() => {
        if (transferState === TRANSFER_STATE.IDLE || receivedCount === 0) {
            log.warn("[Prepare Watchdog] Timeout waiting for data start!");
            showToast("준비 지연 중... Host 복구 요청");

            // Fallback: Request recovery directly from Host
            if (hostConn && hostConn.open) {
                const recoveryFileName = window._pendingFileName || '';
                const recoveryIndex = _pendingFileIndex !== undefined ? _pendingFileIndex : currentTrackIndex;

                // Consistent Jitter
                const jitter = Math.random() * 1000 + 200;
                log.debug(`[Watchdog] Delaying recovery request by ${Math.round(jitter)}ms for DDoS mitigation`);
                setTimeout(() => {
                    if (hostConn && hostConn.open && !currentFileBlob) {
                        sendRecoveryRequest(0);

                    }
                }, jitter);
            }
        }
    }, 15000); // 15s safety timer
}

async function handleFileStart(data) {
    // RELAY LOGIC: Forward to downstream
    if (downstreamDataPeers.length > 0) {
        downstreamDataPeers.forEach(p => { if (p.open) p.send(data); });
    }

    // Session ID Validation - NO FALLBACK to 0
    const incomingSid = data.sessionId;
    if (!incomingSid || incomingSid < localTransferSessionId) {
        log.warn(`[file-start] Stale or invalid session ignored. Current: ${localTransferSessionId}, Received: ${incomingSid}`);
        return;
    }

    // If it's a newer session, reset state
    if (incomingSid > localTransferSessionId) {
        log.debug(`[file-start] New session detected: ${incomingSid}. Resetting state.`);
        localTransferSessionId = incomingSid;
        _currentLoadToken++; // Invalidate any stale decodes for the old session

        // Explicitly RESET worker slot for new session to prevent lock collision
        postWorkerCommand({ command: 'OPFS_RESET', isPreload: false });

        clearPreviousTrackState('new-session-start');
    }

    // Stop current playback immediately when new transfer starts
    stopAllMedia();

    // Skip if we're using preloaded file (already have the data)
    if (_skipIncomingFile) {
        log.debug("[file-start] Skipping - already using preloaded file");
        return;
    }

    // Clear Prepare Watchdog as we've started receiving
    clearManagedTimer('prepareWatchdog');

    // Always reset processing guard at file-start to prevent stuck loader
    // This is safe because file-start means we're (re)starting the transfer
    transferState = TRANSFER_STATE.IDLE;

    // [OPFS-Worker] Start new session
    // Consolidate OPFS_START logic
    // We will call OPFS_START once later in this function after determining if it's a recovery
    if (currentFileOpfs.name && currentFileOpfs.name !== data.name) {
        cleanupOPFSInWorker(currentFileOpfs.name, false);
    }
    currentFileOpfs.name = data.name;

    const sourceLabel = upstreamDataConn ? `Relay(${upstreamDataConn.peer.substr(-4)})` : "Host";

    let sizeText = "";
    if (data.size) {
        sizeText = ` (${(data.size / 1024 / 1024).toFixed(1)}MB)`;
    }

    // CRITICAL: Check if we're receiving the SAME file (recovery scenario)
    // If so, preserve existing chunks!
    const isSameFile = meta && meta.name === data.name && meta.total === data.total;

    if (isSameFile && receivedCount > 0) {
        // RECOVERY MODE: Keep existing chunks (OPFS will overwrite or we seek)
        log.debug(`[file-start] Same file detected! Keeping ${receivedCount}/${data.total} chunks (OPFS seek logic will follow)`);

        // If file is already 100% complete, reset guard and skip to end
        if (receivedCount >= data.total) {
            log.debug("[file-start] File already complete, triggering immediate processing");
            _isProcessingBlob = false; // Reset guard to allow reprocessing
            meta = data; // Update meta first

            // Trigger processing via worker notification
            postWorkerCommand({
                command: 'OPFS_END',
                filename: data.name,
                isPreload: false,
                sessionId: validateSessionId(incomingSid)
            });
            return; // Skip rest of file-start handler
        } else {
            showToast(`${sourceLabel}로부터 전송 이어받기`);
            const pct = Math.round((receivedCount / data.total) * 100);
            showLoader(true, `${sourceLabel} 수신 중... ${pct}%${sizeText}`);

            // Resume with Worker
            postWorkerCommand({
                command: 'OPFS_START',
                filename: data.name,
                isPreload: false,
                size: CHUNK_SIZE,
                sessionId: validateSessionId(incomingSid),
                keepExisting: true
            });
        }
        // Update meta but don't touch receivedCount
        meta = data;
    } else {
        // NEW FILE: Initialize fresh
        log.debug(`[file-start] New file, initializing Worker-OPFS for ${data.total} chunks`);
        showToast(`${sourceLabel}로부터 파일 수신 시작`);
        showLoader(true, `${sourceLabel} 수신 중... 0%${sizeText}`);

        // [OPFS-Worker] Start
        postWorkerCommand({
            command: 'OPFS_START',
            filename: data.name,
            isPreload: false,
            size: CHUNK_SIZE,
            sessionId: validateSessionId(incomingSid)
        });
        currentFileOpfs.name = data.name;

        incomingChunks = []; // Clear in-memory array
        receivedCount = 0;
        meta = data;
        transferState = TRANSFER_STATE.RECEIVING;

        // Apply any pending chunks that arrived before file-start
        if (window._pendingEarlyChunks && window._pendingEarlyChunks.length > 0) {
            log.debug(`[file-start] Applying ${window._pendingEarlyChunks.length} early chunks to Worker-OPFS`);
            for (const pending of window._pendingEarlyChunks) {
                if (pending.index >= 0 && pending.index < data.total) {
                    postWorkerCommand({
                        command: 'OPFS_WRITE',
                        chunk: pending.chunk,
                        index: pending.index,
                        isPreload: false,
                        filename: data.name,
                        sessionId: validateSessionId(incomingSid)
                    }, [pending.chunk.buffer]);
                    receivedCount++;
                }
            }
            window._pendingEarlyChunks = []; // Clear pending buffer
        }
    }

    // Playlist UI, Title, and Artist are updated via updatePlaylistUI() in the caller or earlier in handleFileStart logic
    // [Removed] updateTitleWithMarquee(data.name);

    // Watchdog Start
    clearManagedTimer('chunkWatchdog');
    lastChunkTime = Date.now();
    managedTimers.chunkWatchdog = setInterval(() => {
        const timeSinceLast = Date.now() - lastChunkTime;
        const isMetaInvalid = !meta || !meta.total;

        if (timeSinceLast > WATCHDOG_TIMEOUT || (incomingChunks.length > 0 && isMetaInvalid)) {
            // Timeout or Invalid State!
            clearManagedTimer('chunkWatchdog');
            showToast("데이터 수신 불안정. Host 복구 요청...");

            // Detach bad relay info if present (so we show 'Host' in UI next time)
            if (upstreamDataConn) upstreamDataConn = null;

            if (hostConn && hostConn.open) {
                // GAP-BASED RECOVERY: (Simplified usage of helper)
                sendRecoveryRequest(receivedCount || 0);
            }
        }
    }, 1000);

    // RELAY LOGIC: Forward 'file-start' header to downstream (simplified)
    // Removed _waitingForFileStart logic that caused duplicate transmissions
    if (downstreamDataPeers.length > 0) {
        downstreamDataPeers.forEach(p => {
            if (p.open) p.send(data);
        });
    }
}

async function handleFileResume(data) {
    // Session ID Validation - NO FALLBACK to 0
    const incomingSid = data.sessionId;
    if (!incomingSid || incomingSid < localTransferSessionId) {
        log.warn(`[file-resume] Stale or invalid session ignored. Current: ${localTransferSessionId}, Received: ${incomingSid}`);
        return;
    }

    if (incomingSid > localTransferSessionId) {
        log.debug(`[file-resume] New session detected during resume: ${incomingSid}`);
        localTransferSessionId = incomingSid;
    }

    // Clear Prepare Watchdog
    clearManagedTimer('prepareWatchdog');

    // RESUME TRANSFER
    _skipIncomingFile = false;

    // [OPFS-Worker] Resume
    postWorkerCommand({
        command: 'OPFS_START',
        filename: data.name,
        isPreload: false,
        size: CHUNK_SIZE,
        sessionId: validateSessionId(incomingSid),
        keepExisting: true
    });
    currentFileOpfs.name = data.name;

    const sourceLabel = upstreamDataConn ? `Relay(${upstreamDataConn.peer.substr(-4)})` : "Host";
    const startChunk = data.startChunk || 0;

    log.debug(`[Resume] Continuing from chunk ${startChunk}, already have ${receivedCount} chunks (OPFS handles resume via keepExistingData)`);
    showToast(`${sourceLabel}로부터 전송 재개 (${startChunk}부터)`);

    transferState = TRANSFER_STATE.RECEIVING;

    // Update meta
    meta = data;
    updatePlaylistUI();

    // RELAY LOGIC: Forward to downstream
    if (downstreamDataPeers.length > 0) {
        downstreamDataPeers.forEach(p => {
            if (p.open) p.send(data);
        });
    }

    let sizeText = data.size ? ` (${(data.size / 1024 / 1024).toFixed(1)}MB)` : "";
    const pct = meta.total > 0 ? Math.round((receivedCount / meta.total) * 100) : 0;
    showLoader(true, `${sourceLabel} 수신 중... ${pct}%${sizeText}`);

    // Restart watchdog
    clearManagedTimer('chunkWatchdog');
    lastChunkTime = Date.now();
    managedTimers.chunkWatchdog = setInterval(() => {
        const timeSinceLast = Date.now() - lastChunkTime;
        if (timeSinceLast > 12000) {
            clearManagedTimer('chunkWatchdog');
            showToast("데이터 수신 불안정. Host 복구 요청...");
            if (upstreamDataConn) upstreamDataConn = null;

            if (hostConn && hostConn.open) {
                // Find first missing chunk via helper
                sendRecoveryRequest(receivedCount || 0);

            }
        }
    }, 1000);
}

// Network Data Integrity: Chunk Reordering Buffer
const fileReorderBuffer = new Map(); // sessionId -> Map(index -> chunk)
let nextExpectedChunk = 0;

async function handleFileChunk(data) {
    const incomingSid = data.sessionId;
    if (!incomingSid) return; // Strict validation

    // Reset worker on new session detection
    if (incomingSid > localTransferSessionId) {
        log.debug(`[Chunk] New session detected: ${localTransferSessionId} → ${incomingSid}`);
        localTransferSessionId = incomingSid;

        // Explicitly clear worker buffers
        postWorkerCommand({
            command: 'OPFS_RESET',
            isPreload: false
        });

        // Reset existing state
        clearPreviousTrackState('session-change');

        // Reorder Buffer Reset
        fileReorderBuffer.set(incomingSid, new Map());
        nextExpectedChunk = 0;
        receivedCount = 0;
    }

    if (incomingSid < localTransferSessionId) {
        if (data.index === 0) log.warn(`[Chunk] Stale session ignored: ${incomingSid}`);
        return;
    }

    // Skip if we're using preloaded file
    if (_skipIncomingFile) {
        return;
    }

    if (!fileReorderBuffer.has(incomingSid)) {
        fileReorderBuffer.set(incomingSid, new Map());
        nextExpectedChunk = 0;
    }

    const sessionBuffer = fileReorderBuffer.get(incomingSid);

    // Clone data before storing/sending to avoid detachment issues
    const chunkData = new Uint8Array(data.chunk);
    sessionBuffer.set(data.index, chunkData);

    // Debug logging for first few chunks
    if (data.index < 5 || data.index % 100 === 0) {
        log.debug(`[Chunk] Received idx=${data.index}, total=${meta?.total}`);
    }

    // Skip orphan chunks when meta was cleared (session changed)
    if (!meta || meta.total === undefined) {
        if (data.total !== undefined) {
            log.debug(`[Chunk] Recovering meta from chunk idx=${data.index} (total=${data.total})`);
            meta = {
                ...meta,
                name: data.name || (meta ? meta.name : ''),
                total: data.total,
                sessionId: incomingSid,
                size: data.size || (meta ? meta.size : 0)
            };
            // Synchronize OPFS filename immediately and START worker session
            // This prevents "expected=null" mismatches if handleFileStart was missed due to rapid skip
            if (meta.name) {
                currentFileOpfs.name = meta.name;
                log.debug(`[Chunk] Auto-starting worker session for recovered meta: ${meta.name} (SID: ${incomingSid})`);
                postWorkerCommand({
                    command: 'OPFS_START',
                    filename: meta.name,
                    isPreload: false,
                    sessionId: incomingSid,
                    keepExisting: true // Don't wipe if some chunks already arrived
                });
            }
        } else {
            log.warn(`[Chunk] Orphan chunk ignored (idx=${data.index}): meta.total is undefined and no recovery data`);
            return;
        }
    }

    // Process all contiguous chunks in order
    while (sessionBuffer.has(nextExpectedChunk)) {
        const chunk = sessionBuffer.get(nextExpectedChunk);

        // Prepare Relay Copy (before transfer to worker)
        let relayCopy = null;
        if (downstreamDataPeers.length > 0) {
            relayCopy = new Uint8Array(chunk);
        }

        postWorkerCommand({
            command: 'OPFS_WRITE',
            chunk: chunk,
            index: nextExpectedChunk,
            isPreload: false,
            filename: currentFileOpfs.name,
            sessionId: validateSessionId(incomingSid)
        }, [chunk.buffer]);

        // RELAY LOGIC: Queue and Process
        if (relayCopy && downstreamDataPeers.length > 0) {
            relayChunkQueue.push({
                type: MSG.FILE_CHUNK,
                chunk: relayCopy,
                index: nextExpectedChunk,
                sessionId: incomingSid // Include session ID for relay sync
            });
            processRelayQueue();
        }

        sessionBuffer.delete(nextExpectedChunk);
        nextExpectedChunk++;
        receivedCount++;
    }

    lastChunkTime = Date.now();

    // Progress update...
    if (meta && meta.total > 0) {
        const percent = Math.min(100, Math.floor((receivedCount / meta.total) * 100));

        const sourceLabel = upstreamDataConn ? `Relay(${upstreamDataConn.peer.substr(-4)})` : "Host";
        let progressText = `${percent}%`;

        if (meta.size) {
            const totalMB = ((meta.size / 1024 / 1024)).toFixed(1);
            const currentBytes = receivedCount * 16384;
            const currentMB = ((currentBytes / 1024 / 1024)).toFixed(1);
            progressText = `${currentMB}MB / ${totalMB}MB (${percent}%)`;
        }

        const loaderText = document.getElementById('header-loading-text');
        if (loaderText) loaderText.innerText = `${sourceLabel} 수신 중... ${progressText}`;
        updateLoader(percent);
    }

    // Use >= instead of === to handle edge cases where receivedCount slightly exceeds total
    if (meta && receivedCount >= meta.total && transferState !== TRANSFER_STATE.PROCESSING) {
        // Set guard BEFORE any async operation to prevent race conditions
        transferState = TRANSFER_STATE.PROCESSING;
        const processingIndex = meta.index;   // Capture track index for ACK

        // Notify Host that we have this file now
        if (hostConn && hostConn.open && processingIndex !== undefined) {
            hostConn.send({ type: MSG.PRELOAD_ACK, index: processingIndex });
            log.debug(`[Guest] Confirmed cache for index ${processingIndex} to Host`);
        }

        // [Worker-OPFS] Finalize file with Size Verification
        postWorkerCommand({
            command: 'OPFS_END',
            filename: meta.name,
            isPreload: false,
            sessionId: validateSessionId(incomingSid),
            totalSize: meta.size // Send expected size for integrity check
        });

        // [Stability Fix] Explicitly clear watchdog once file is fully received
        clearManagedTimer('chunkWatchdog');

        // Finalize UI/playback state will happen in Worker message handler
        return;
    }
}

async function handleFileEnd(data) {
    if (_skipIncomingFile) return;

    // RELAY LOGIC: Forward to downstream
    if (downstreamDataPeers.length > 0) {
        downstreamDataPeers.forEach(p => { if (p.open) p.send(data); });
    }

    log.debug(`[file-end] Received end signal for: ${data.name}`);

    // Integrity check: if we haven't hit the total yet, something is wrong
    if (meta && receivedCount < meta.total) {
        log.warn(`[file-end] Received before all chunks! Got ${receivedCount}/${meta.total}`);
    }
}

async function handleFileWait(data) {
    log.debug("[Guest] Relay has no data yet, waiting for forwarded data...");
    showToast("릴레이 대기 중... 잠시만 기다려주세요");

    // Mark that we're waiting for relay data
    _waitingForRelayData = true;

    // Set timeout: If no data comes within 10 seconds, fall back to Host
    clearManagedTimer('relayWaitTimeout');
    managedTimers.relayWaitTimeout = setTimeout(() => {
        if (_waitingForRelayData && receivedCount === 0) {
            log.debug("[Guest] Relay wait timeout - falling back to Host");
            showToast("릴레이 응답 없음. Host에서 직접 수신...");
            _waitingForRelayData = false;

            // Disconnect from relay
            if (upstreamDataConn) {
                upstreamDataConn.close();
                upstreamDataConn = null;
            }

            // Request file from Host
            if (hostConn && hostConn.open) {
                const recoveryFileName = window._pendingFileName || '';
                const recoveryIndex = _pendingFileIndex !== undefined ? _pendingFileIndex : currentTrackIndex;

                // VALIDATION: Don't send recovery request with invalid index
                if (recoveryIndex < 0 || recoveryIndex >= playlist.length) {
                    log.warn("[file-wait timeout] Invalid index, skipping recovery:", recoveryIndex);
                    showLoader(false);
                    return;
                }

                // Check if preload is in progress for this track
                if (preloadMeta && preloadMeta.index === recoveryIndex) {
                    log.debug("[file-wait timeout] Preload in progress for this track, waiting...");
                    showToast("프리로드 완료 대기 중...");
                    return; // Let preload finish naturally
                }

                log.debug("[file-wait timeout] Requesting from Host:", recoveryFileName, "index:", recoveryIndex);
                hostConn.send({
                    type: MSG.REQUEST_DATA_RECOVERY,
                    nextChunk: 0,
                    fileName: recoveryFileName,
                    index: recoveryIndex
                });
            }
        }
    }, 10000); // 10 second timeout
}

async function handleSyncResponse(data) {
    // YouTube mode: Skip local audio sync (YouTube has its own sync)
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
        showToast("YouTube 모드에서는 Auto Sync가 작동하지 않습니다");
        return;
    }

    // [Latency Compensation - Conditional based on ICE type]
    // For relay (TURN): apply RTT/2 compensation
    // For direct (host/srflx): skip compensation (local network has minimal latency)
    let oneWayLatencySeconds = 0;

    if (usePingCompensation) {
        oneWayLatencySeconds = (lastLatencyMs / 2) / 1000;
    }

    autoSyncOffset = oneWayLatencySeconds; // Store for UI

    // compensatedTime = HostCurrentTime (approx)
    const compensatedTime = data.time + oneWayLatencySeconds;

    // [Simplified] Always perform a "Hard Sync" for maximum accuracy
    log.debug(`[AutoSync] Hard sync triggered (Compensated time: ${compensatedTime.toFixed(3)}s)`);

    if (data.isPlaying) {
        // Always restart the playback engine at the precise corrected time
        play(compensatedTime + localOffset);
    }
    else {
        // Don't stop if we are waiting for a scheduled play command (Host countdown)
        if (_pendingPlayTime) {
            log.debug("[AutoSync] Host is not playing yet, but we have a pending start. Keeping status quo.");
            pausedAt = compensatedTime; // Sync time for when we DO start
            return;
        }
        stopAllMedia();
        pausedAt = compensatedTime;
        if (!uiLoopId) loopUI();
    }

    if (usePingCompensation) {
        showToast(`자동 싱크 보정 완료, +${Math.round(lastLatencyMs / 2)}ms`);
    } else {
        showToast(`직접 동기화 완료 (로컬 네트워크)`);
    }
    updateSyncDisplay();
}

async function handleYouTubePlay(data) {
    // Guest receives YouTube play command from Host
    log.debug("[Guest] Received youtube-play:", data);

    // 1. Stop any local audio/video first
    stopAllMedia();

    // 2. [Reliability] Reset preload state when entering YouTube
    clearPreloadState();
    _skipIncomingPreload = false;
    clearManagedTimer('prepareWatchdog');

    // 3. Stop existing YouTube if playing
    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
        try { youtubePlayer.destroy(); } catch (e) { /* best-effort cleanup before re-init */ }
        youtubePlayer = null;
    }

    currentState = APP_STATE.PLAYING_YOUTUBE;

    // 4. Sync track index
    if (data.index !== undefined) {
        currentTrackIndex = data.index;
        updatePlaylistUI();
    }

    // 5. Load YouTube (autoplay based on Host's command)
    showToast("YouTube 같이 보기 - 고급 오디오 효과가 비활성화됩니다");
    loadYouTubeVideo(data.videoId, data.playlistId, data.autoplay !== false, data.subIndex || 0);

    // 6. Hide Loader (Prevent hang from accidental file-prepare)
    showLoader(false);
}

async function handlePreloadStart(data) {
    clearManagedTimer('prepareWatchdog');

    // Reliability: Match cache by Index OR Name (Fallback to currentTrackIndex)
    const matchIndex = (idx) => Number(idx) === Number(data.index);
    const matchName = (n) => n && data.name && n === data.name;

    const isCurrentlyPlaying = currentFileBlob && (matchIndex(currentTrackIndex) || matchName(meta?.name));
    const isNextPreloaded = nextFileBlob && (matchIndex(nextMeta?.index) || matchName(nextMeta?.name));
    const alreadyCachedLocally = isCurrentlyPlaying || isNextPreloaded;

    const sessionId = data.sessionId;
    if (!sessionId) {
        log.warn("[Preload] Start message missing sessionId. Ignoring.");
        return;
    }

    // Skip if Host explicitly said so, or if we detected cache ourselves
    if (data.skipped || alreadyCachedLocally) {
        log.debug(`[Preload] Skipping session ${sessionId}`);

        // Save per-session state
        preloadSessionState.set(sessionId, { skipped: true });
        latestPreloadSessionId = sessionId; // Track active session

        preloadChunks = [];
        preloadCount = 0;
        preloadMeta = { ...data, isSkipped: true };
        _skipIncomingPreload = true;

        // Relay from whatever cache we have to downstream
        const sourceBlob = isNextPreloaded ? nextFileBlob : (currentFileBlob || null);

        if (downstreamDataPeers.length > 0) {
            log.debug(`[Relay] Forwarding preload-start for cached track ${data.index} (relayed from this node)`);
            // [CRITICAL FIX] Always clear skipped=true for downstream peers because THIS node will send chunks!
            const forwardHeader = { ...data, skipped: false };
            downstreamDataPeers.forEach(p => { if (p.open) p.send(forwardHeader); });
        }

        if (sourceBlob) {
            relayPreloadFromCache(sourceBlob, data.index, data.sessionId);
        }
        return;
    }

    // Initialize session state
    preloadSessionState.set(sessionId, {
        skipped: false,
        progress: 0,
        total: data.total,
        name: data.name,    // Store name for chunk processing
        index: data.index,   // Store index for completeness check
        size: data.size,     // Store size for integrity check
        mime: data.mime,      // Store mime for video detection
        nextExpectedChunk: 0 // Session-scoped chunk pointer
    });
    latestPreloadSessionId = sessionId; // Track active session

    log.debug(`[Preload] Starting Worker-OPFS preload for: ${data.name}`);

    // Show Preload Status in Header
    // "Preparing next track..."
    // Only if main track transfer is NOT in progress to avoid UI flickering
    if (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.IDLE) {
        showLoader(true, `다음 곡 준비 중... (${data.name})`);
    } else {
        log.debug(`[Preload] Started behind main track: ${data.name}`);
    }

    // Explicitly RESET preload slot before starting new one to clear stale locks
    postWorkerCommand({ command: 'OPFS_RESET', isPreload: true });

    // [OPFS-Worker] Prepare preload file
    postWorkerCommand({
        command: 'OPFS_START',
        filename: data.name,
        isPreload: true,
        size: CHUNK_SIZE,
        sessionId: validateSessionId(sessionId)
    });
    preloadFileOpfs.name = data.name;

    preloadChunks = [];
    preloadCount = 0;
    preloadMeta = data;
    _skipIncomingPreload = false;

    if (downstreamDataPeers.length > 0) {
        downstreamDataPeers.forEach(p => { if (p.open) p.send(data); });
    }
}

// Network Data Integrity: Preload Reordering Buffer
const preloadReorderBuffer = new Map(); // sessionId -> Map(index -> chunk)
// [Refactor] Removed global nextExpectedPreloadChunk to prevent pollution
// let nextExpectedPreloadChunk = 0;
let latestPreloadSessionId = 0; // Fallback for chunks missing explicit SessionID

async function handlePreloadChunk(data) {
    // NO FALLBACK to 0. Must have valid SID.
    let sessionId = data.sessionId;
    if (!sessionId && latestPreloadSessionId !== 0) {
        sessionId = latestPreloadSessionId;
    }
    if (!sessionId) return;

    // Check session state
    const sessionState = preloadSessionState.get(sessionId);

    if (!sessionState) {
        // Session state missing - log warning but continue
        // Use preloadMeta as fallback for chunks that arrive before session state is set
        log.warn(`[Preload] Session State MISSING for SID: ${sessionId}, using preloadMeta fallback`);
    }

    if (sessionState?.skipped) {
        return; // Ignore chunks from skipped session
    }

    if (_skipIncomingPreload) return;

    if (!preloadReorderBuffer.has(sessionId)) {
        preloadReorderBuffer.set(sessionId, new Map());
        // nextExpectedPreloadChunk = 0; // Handled in sessionState
    }

    const sessionBuffer = preloadReorderBuffer.get(sessionId);
    sessionBuffer.set(data.index, data.chunk);

    // Use Session-Scoped Pointer
    let nextChunkPtr = sessionState ? sessionState.nextExpectedChunk : 0;

    while (sessionBuffer.has(nextChunkPtr)) {
        const chunk = sessionBuffer.get(nextChunkPtr);

        // Clone chunk to prevent detachment issues (one for relay, one for worker)
        const chunkClone = new Uint8Array(chunk);
        const fileName = sessionState.name || (preloadMeta ? preloadMeta.name : 'Unknown');

        // RELAY LOGIC: Forward to downstream
        if (downstreamDataPeers.length > 0) {
            const relayCopy = new Uint8Array(chunk);
            relayChunkQueue.push({
                type: MSG.PRELOAD_CHUNK,
                chunk: relayCopy,
                index: nextChunkPtr,
                sessionId: sessionId
            });
            processRelayQueue();
        }

        postWorkerCommand({
            command: 'OPFS_WRITE',
            chunk: chunkClone,
            index: nextChunkPtr,
            isPreload: true,
            filename: fileName,
            sessionId: validateSessionId(sessionId)
        }, [chunkClone.buffer]);

        sessionBuffer.delete(nextChunkPtr);
        nextChunkPtr++;
    }

    // Update session state pointer
    if (sessionState) {
        sessionState.nextExpectedChunk = nextChunkPtr;
    }

    // Update progress
    // Rely on Session State for progress tracking to avoid Global Variable pollution
    if (sessionState) {
        sessionState.progress = sessionState.nextExpectedChunk;
        preloadCount = sessionState.progress; // Sync global for legacy UI if needed
    } else {
        preloadCount = sessionState ? sessionState.nextExpectedChunk : 0; // Fallback
    }

    // Update UI for Preload
    if (preloadMeta && preloadMeta.total > 0) {
        // Only update progress bar for preload if main track is NOT using it
        if (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.IDLE) {
            const currentProgress = sessionState ? sessionState.progress : preloadCount;
            const pct = Math.min(100, Math.floor((currentProgress / preloadMeta.total) * 100));
            updateLoader(pct);
        }
    }

    // Use Session-Scoped Progress Check
    const currentProgress = sessionState ? sessionState.progress : preloadCount;
    const totalExpected = sessionState ? sessionState.total : (preloadMeta?.total || 0);
    const fileName = sessionState ? sessionState.name : (preloadMeta?.name || '');
    const fileSize = sessionState ? sessionState.size : (preloadMeta?.size || 0);

    if (totalExpected > 0 && currentProgress >= totalExpected) { // Finalize via worker
        const currentSessionState = preloadSessionState.get(sessionId);
        if (currentSessionState && !currentSessionState.finalized) {
            log.debug(`[Preload] All chunks received via Worker-OPFS (${currentProgress}/${totalExpected}). Finalizing...`);
            currentSessionState.finalized = true;
            postWorkerCommand({
                command: 'OPFS_END',
                filename: fileName,
                isPreload: true,
                sessionId: sessionId, // validateSessionId is too strict for worker commands
                totalSize: fileSize // Send expected size for integrity check
            });
            // NOTE: We do NOT reset preloadCount to 0 here because it's needed for handlePreloadEnd's check.
            // It will be reset in clearPreloadState().
        }
    }
}

async function handlePreloadEnd(data) {
    if (_skipIncomingPreload) return;

    /* Retrieve Session State to verify completeness */
    // NO FALLBACK to 0. Must have valid SID.
    let sessionId = data.sessionId;
    if (!sessionId && latestPreloadSessionId !== 0) {
        sessionId = latestPreloadSessionId;
    }

    const sessionState = preloadSessionState.get(sessionId);

    // Deduplicate OPFS_END if already called by handlePreloadChunk
    if (sessionState && !sessionState.finalized) {
        sessionState.finalized = true;
        const fileSize = sessionState.size || data.totalSize || preloadMeta?.size;
        const fileName = sessionState.name || data.filename || preloadMeta?.name;

        postWorkerCommand({
            command: 'OPFS_END',
            filename: fileName,
            isPreload: true,
            sessionId: sessionId, // validateSessionId is too strict for worker commands
            totalSize: fileSize
        });
    }

    const progress = sessionState ? sessionState.progress : preloadCount;
    const total = sessionState ? sessionState.total : (preloadMeta?.total || 0);
    const fileName = sessionState ? sessionState.name : (preloadMeta?.name || '');
    const fileSize = sessionState ? sessionState.size : (preloadMeta?.size || 0);

    log.debug(`[Preload] End signal received for index: ${data.index} (Progress: ${progress}/${total})`);

    // RELAY LOGIC: Forward to downstream
    if (downstreamDataPeers.length > 0) {
        downstreamDataPeers.forEach(p => { if (p.open) p.send(data); });
    }

    // Allow slight mismatch (e.g. -1) or exact match
    if (progress < total) {
        log.warn(`[Preload] Incomplete! Got ${progress}/${total} chunks.`);
        // Force try finalizing if we are very close (optional logic, but safe to just warn for now)
        return;
    }

    // OPFS_END is already sent by handlePreloadChunk or the block above (L5421-5433)
    // No additional finalization needed here

    // Removed duplicate preload-ack - already sent in OPFS_FILE_READY handler (line 576)
    // This prevents Host from receiving 2 acks per preload

    // Hide Loader when Preload Complete
    // Only if main track transfer is NOT in progress
    if (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.IDLE) {
        showLoader(false);
    } else {
        log.debug("[Preload] Complete, but keeping loader for main track transfer...");
    }
}

async function handlePlayPreloaded(data) {
    // Increment token to invalidate any previous async operations
    const myLoadToken = ++_currentLoadToken;

    // Host Command: "Switch to what you downloaded!"
    log.debug("Command: Play Preloaded Track, index:", data.index);

    // Deduplication: If already processing this exact track, ignore duplicate commands
    if (window._playPreloadedInProgress === data.index && !data.retryAttempt) {
        log.debug(`[PlayPreloaded] Already processing track ${data.index}, ignoring duplicate command`);
        return;
    }

    // Immediate stop for Guest during transition (only on first attempt)
    if (!data.retryAttempt) {
        window._playPreloadedInProgress = data.index;
        stopAllMedia();
    }

    // Skip if we already loaded this track via file-prepare
    if (_preloadUsedForIndex === data.index) {
        log.debug("[Guest] Already loaded track via file-prepare, skipping play-preloaded");
        _preloadUsedForIndex = undefined; // Reset flag
        window._playPreloadedInProgress = undefined;
        return;
    }

    currentTrackIndex = data.index;
    updatePlaylistUI(); // Update active highlight

    // If Guest was in YouTube mode, stop it before loading file
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
        log.debug("[Guest] Switching from YouTube to Preloaded Local Track");
        stopYouTubeMode();
    }

    // Strict Index Verification: Ensure preloaded data belongs to the requested track
    const isPreloadTargetMatch = nextMeta && (nextMeta.index === data.index || nextMeta.name === data.name);

    if (nextFileBlob && isPreloadTargetMatch) {
        // Use preloaded file if available
        log.debug("[Guest] Using preloaded file for track", data.index);
        await loadPreloadedTrack(data.index, myLoadToken);

        // CRITICAL: Hide loader (Playlist UI is already updated via handlePlayPreloaded's call to updatePlaylistUI)
        showLoader(false);

        // Mark that we already loaded this track (prevent duplicate load from following messages)
        _preloadUsedForIndex = data.index;
        _skipIncomingFile = true;
        window._playPreloadedInProgress = undefined; // Clear in-progress flag

        // RELAY LOGIC: Forward to downstream
        if (downstreamDataPeers.length > 0) {
            downstreamDataPeers.forEach(p => {
                if (p.open) p.send(data);
            });
        }
    } else {
        // [Race Condition Fix] If we are currently preloading this track, wait a moment!
        const isDownloadingSameTrack = preloadMeta && (preloadMeta.index === data.index || preloadMeta.name === data.name);
        const progress = preloadMeta && preloadMeta.total > 0 ? (preloadCount / preloadMeta.total) : 0;

        // If we are > 80% done or just processing, give it a chance
        if (isDownloadingSameTrack && !data.retryAttempt) {
            log.debug(`[PlayPreloaded] Preload is active (${(progress * 100).toFixed(1)}%). Waiting for completion...`);
            showToast("다운로드 마무리 중...");

            // Retry up to 4 times (2 seconds total)
            setTimeout(() => {
                const retryData = { ...data, retryAttempt: (data.retryAttempt || 0) + 1 };
                if (retryData.retryAttempt <= 4) {
                    handlePlayPreloaded(retryData);
                } else {
                    // Give up and request fallback
                    handlePlayPreloaded({ ...data, retryAttempt: 999 });
                }
            }, 500);
            return;
        }

        // No preload or index mismatch - request file from Host
        if (nextFileBlob && !isPreloadTargetMatch) {
            log.warn(`[Guest] Stale preload detected (ID mismatched). Found index: ${nextMeta ? nextMeta.index : 'N/A'}, Expected: ${data.index}`);
        }

        // Persistence: Capture metadata BEFORE clearing state
        const trackName = data.name || playlist[data.index]?.name || (nextMeta ? nextMeta.name : '');
        window._pendingFileName = trackName;
        _pendingFileIndex = data.index;

        log.warn("[Guest] No preloaded file found for track", data.index, "- requesting from Host");
        showLoader(true, "파일 요청 중...");

        // Clear any stale state
        clearPreviousTrackState('play-preloaded fallback');
        window._playPreloadedInProgress = undefined; // Clear in-progress flag

        if (upstreamDataConn && upstreamDataConn.open) {
            log.debug("[Guest] Requesting file from Relay:", trackName);
            upstreamDataConn.send({
                type: MSG.REQUEST_CURRENT_FILE,
                name: trackName,
                index: data.index
            });
            showToast("릴레이에 파일 요청 중...");
        } else if (hostConn && hostConn.open) {
            // Consistent Jitter for fallback request
            const jitter = Math.random() * 1000 + 200;
            log.debug(`[PlayPreloaded] Delaying fallback recovery by ${Math.round(jitter)}ms`);

            setTimeout(() => {
                // Double check before sending request
                if (hostConn && hostConn.open && !nextFileBlob) {
                    // Last check: did we get it during delay?
                    const hasItNow = (nextMeta && nextMeta.index === data.index && nextFileBlob);
                    if (hasItNow) {
                        log.debug("[Guest] Preload arrived during jitter wait! Playing...");
                        loadPreloadedTrack();
                        return;
                    }

                    log.debug("[Guest] Requesting file from Host:", trackName, "index:", data.index);
                    hostConn.send({
                        type: MSG.REQUEST_DATA_RECOVERY,
                        nextChunk: 0,
                        fileName: trackName,
                        index: data.index
                    });
                }
            }, jitter);
            showToast("Host에 파일 요청 중...");
        } else {
            showToast("Host 연결 끊김 - 파일을 받을 수 없습니다");
            showLoader(false);
        }

        if (!data.retryAttempt) showToast("프리로드 누락 - 파일 수신 중...");
    }
}

async function handleStatusSync(data) {
    // Required Field Validation
    if (!validateMessage(data, ['playlistMeta', 'currentTrackIndex'])) return;

    // [Synchronization Logic] Playlist-Centric Model
    const { playlistMeta, currentTrackIndex: hostTrackIndex, isPlaying: hostIsPlayingAny } = data;

    // Empty Playlist Defense - Skip if already in empty state
    if (!playlistMeta || playlistMeta.length === 0) {
        if (playlist.length === 0 && currentState === APP_STATE.IDLE) {
            return; // Already in empty state, skip redundant processing
        }
        log.debug("[StatusSync] Received empty playlist, clearing local state");
        playlist = [];
        currentTrackIndex = -1;
        updatePlaylistUI();
        stopAllMedia();
        return;
    }

    // 0. Sync Repeat/Shuffle State
    if (data.repeatMode !== undefined && data.repeatMode !== repeatMode) {
        setRepeatMode(data.repeatMode);
    }
    if (data.isShuffle !== undefined && data.isShuffle !== isShuffle) {
        setShuffle(data.isShuffle);
    }

    // 1. Sync Playlist Structure if different
    const isPlaylistDifferent = playlist.length !== playlistMeta.length || playlist.some((it, i) => it.name !== playlistMeta[i]?.name);
    if (isPlaylistDifferent) {
        log.debug("[Sync] Playlist out of sync, updating...");
        playlist = playlistMeta;
        updatePlaylistUI();
    }

    // 2. Sync Track Index and Trigger Auto-Recovery if needed
    if (hostTrackIndex !== -1 && hostTrackIndex !== currentTrackIndex) {
        log.debug(`Index mismatch: Host(${hostTrackIndex}) vs Me(${currentTrackIndex}). Correcting...`);

        // STOP EVERYTHING FIRST
        stopAllMedia();

        currentTrackIndex = hostTrackIndex;
        updatePlaylistUI();

        const item = playlist[currentTrackIndex];
        if (item && item.type !== 'youtube') {
            const hasBlob = (currentFileBlob && currentFileBlob.size > 0);
            const isPreloaded = nextFileBlob && (nextMeta && (nextMeta.index === hostTrackIndex || nextMeta.name === item.name));

            // If it's preloaded, use it immediately
            if (!hasBlob && isPreloaded) {
                log.debug("[Sync] Required track found in preload cache. Activating...");
                _currentLoadToken++;
                loadPreloadedTrack(hostTrackIndex, _currentLoadToken);
                return;
            }

            // Check if a preload is CURRENTLY in progress for this track
            const isOurPreload = preloadFileOpfs.name && (preloadMeta && (preloadMeta.index === hostTrackIndex || preloadMeta.name === item.name));

            // If it's a new track and we don't have it (or have the WRONG one), ask for it
            const isWrongBlob = hasBlob && meta && meta.name !== item.name;
            if (!hasBlob || isWrongBlob) {
                if (isOurPreload) {
                    log.debug("[Sync] Track is being preloaded. Waiting for completion...");
                    showLoader(true, `파일 동기화 중: ${item.name}`);
                    _waitingForPreload = true;
                    _pendingFileIndex = hostTrackIndex;
                    return;
                }

                log.debug("[Sync] Current track missing, requesting from host:", item.name);
                showLoader(true, `파일 동기화 중: ${item.name}`);
                clearPreviousTrackState('status-sync mismatch');

                // If in YouTube mode, stop it for the new local track
                if (currentState === APP_STATE.PLAYING_YOUTUBE) stopYouTubeMode();

                if (hostConn && hostConn.open) {
                    const jitter = Math.random() * 1000 + 200;
                    log.debug(`[Sync] Delaying recovery request by ${Math.round(jitter)}ms`);
                    setTimeout(() => {
                        // Final check before sending recovery: did it arrive via sync/preload while we waited?
                        const alreadyGotIt = currentFileBlob || nextFileBlob;
                        if (currentTrackIndex === hostTrackIndex && !alreadyGotIt) {
                            hostConn.send({
                                type: MSG.REQUEST_DATA_RECOVERY,
                                nextChunk: 0,
                                fileName: item.name,
                                index: hostTrackIndex
                            });
                        } else if (alreadyGotIt) {
                            log.debug("[Sync] Aborting recovery request: file arrived during jitter delay");
                            showLoader(false);
                        }
                    }, jitter);
                }
            }
        }
        else if (item && item.type === 'youtube') {
            if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
                log.debug("[Sync] Switching to YouTube mode for sync");
                // YouTube mode switch is usually handled by youtube-play message,
                // but this provides a fallback for late joiners.
            }
        }
    }
}

function handleHeartbeat(data) {
    if (hostConn && hostConn.open) hostConn.send({ type: MSG.HEARTBEAT_ACK });
}

function handlePongLatency(data) {
    const ms = Date.now() - data.timestamp;
    latencyHistory.push(ms);
    if (latencyHistory.length > 10) latencyHistory.shift();
    lastLatencyMs = Math.min(...latencyHistory);
    const roleText = document.getElementById('role-text');
    if (roleText && myDeviceLabel !== 'GUEST' && myDeviceLabel !== 'HOST') {
        roleText.innerText = `${myDeviceLabel} (${Math.round(lastLatencyMs)}ms)`;
    }
}

function handleWelcome(data) {
    document.getElementById('role-text').innerText = data.label;
}

async function handlePlay(data) {
    if (managedTimers.autoPlayTimer) {
        clearManagedTimer('autoPlayTimer');
    }

    // Index Check
    if (data.index !== undefined && data.index !== currentTrackIndex) {
        log.warn(`Play command for index ${data.index} received, but I'm on ${currentTrackIndex}. Switching...`);

        // 1. Stop whatever I'm doing
        stopAllMedia();

        // 2. Switch index and metadata
        currentTrackIndex = data.index;
        updatePlaylistUI();

        // 3. Initiate recovery/loading if needed
        const item = playlist[currentTrackIndex];
        if (item && item.type !== 'youtube') {
            const hasFile = (currentFileBlob && currentFileBlob.size > 0);
            const isPreloaded = nextFileBlob && (nextMeta && (nextMeta.index === currentTrackIndex || nextMeta.name === item.name));

            if (!hasFile && isPreloaded) {
                log.debug("Required track found in preload cache. Activating...");
                loadPreloadedTrack();
            } else if (!hasFile || (meta && meta.name !== item.name)) {
                // Check if currently preloading
                const isPreloadingThis = isPreloading && preloadMeta && (preloadMeta.index === currentTrackIndex || preloadMeta.name === item.name);
                if (isPreloadingThis) {
                    log.debug("Track is being preloaded. Waiting...");
                    showLoader(true, `파일 동기화 중: ${item.name}`);
                    _waitingForPreload = true;
                    _pendingFileIndex = currentTrackIndex;
                    _pendingPlayTime = data.time;
                    return;
                }

                log.debug("Need file for new index, requesting...");
                _pendingPlayTime = data.time; // Resume after download
                if (hostConn && hostConn.open) {
                    hostConn.send({
                        type: MSG.REQUEST_DATA_RECOVERY,
                        nextChunk: 0,
                        fileName: item.name,
                        index: currentTrackIndex
                    });
                }
                return; // Early exit, play will happen after load
            }
        }
    }

    const loaderEl = document.getElementById('loader');
    const loaderVisible = loaderEl && loaderEl.style.display !== 'none';
    const isDownloading = loaderVisible || _waitingForRelayData;
    if (isDownloading) {
        log.debug("[Guest] Play command received but still downloading, queuing...");
        showToast("다운로드 완료 후 재생됩니다");
        _pendingPlayTime = data.time;
        return;
    }

    // Prevent playing stale audio when no current file is loaded
    const hasValidAudio = currentAudioBuffer || (currentFileBlob && currentFileBlob.size > 0);
    if (!hasValidAudio && hostConn) {
        log.debug("[Guest] Play command received but no audio loaded, queuing...");
        _pendingPlayTime = data.time;
        return;
    }

    const target = data.time + localOffset + autoSyncOffset;
    if (currentState === APP_STATE.IDLE || Math.abs((Tone.now() - startedAt) - target) > 0.15) play(target);
}

async function handlePause(data) {
    if (data.time !== undefined) {
        pausedAt = data.time;
        const usesVideo = currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_AUDIO;
        if (usesVideo && videoElement) videoElement.currentTime = data.time;
        document.getElementById('seek-slider').value = data.time;
        document.getElementById('time-curr').innerText = fmtTime(data.time);
    }
    pause();
}
async function handleVolume(data) {
    setVolume(data.value);
    showToast(`Volume: ${Math.round(data.value * 100)}%`);
}

async function handleReverb(data) { setReverbParam('mix', data.value); }
async function handleReverbType(data) {
    if (reverb) {
        // Dynamic Reverb Type dispatcher
        // Currently Tone.Reverb doesn't have internal presets, but we can adjust parameters
        // to simulate different types (e.g. 'room', 'hall', 'space')
        if (data.value === 'room') {
            reverb.decay = 1.5;
            reverb.preDelay = 0.05;
        } else if (data.value === 'hall') {
            reverb.decay = 3.5;
            reverb.preDelay = 0.1;
        } else if (data.value === 'space') {
            reverb.decay = 7.0;
            reverb.preDelay = 0.2;
        }
        reverb.generate();
        showToast(`리버브 타입: ${data.value}`);
    }
}
async function handleReverbDecay(data) { setReverbParam('decay', data.value); }
async function handleReverbPreDelay(data) { setReverbParam('predelay', data.value); }
async function handleReverbLowCut(data) { setReverbParam('lowcut', data.value); }
async function handleReverbHighCut(data) { setReverbParam('highcut', data.value); }

async function handleEQUpdate(data) {
    setEQ(data.band, data.value, false, true);
}

async function handlePreamp(data) {
    setPreamp(data.value, false, true);
}

async function handleEQReset(data) {
    resetEQ(true);
}

async function handleStereoWidth(data) {
    setStereoWidth(data.value);
}

async function handleVBass(data) {
    setVirtualBass(data.value);
}

async function handleShuffle(data) {
    setShuffle(data.value);
}

async function handleRepeatMode(data) {
    setRepeatMode(data.value);
}

async function handlePlaylistUpdate(data) {
    playlist = data.list;
    updatePlaylistUI();
}

async function handleGlobalResyncRequest(data) {
    showToast("Host 요청: 싱크 초기화 및 재설정...");
    localOffset = 0; // [RE-ENGINEERING] Reset manual tweaks for auto-sync
    updateSyncDisplay();
    setTimeout(() => syncReset(), Math.random() * 500);
}

async function handleForceSyncPlay(data) {
    const t = data.time;
    showToast(`Host 강제 동기화: ${fmtTime(t)}`);
    play(t);
}

async function handleYouTubePlaylistInfo(data) {
    const { playlistId, ids, titles } = data;
    youtubeSubItemsMap[playlistId] = { ids: ids, titles: titles || [] };
    updatePlaylistUI();

    // Guest can also fetch titles if missing
    if (ids && ids.length > 0) {
        fetchPlaylistSubTitles(playlistId, ids);
    }
}

async function handleYouTubeStop(data) {
    log.debug("[Guest] Received youtube-stop, switching to local mode");
    if (currentState === APP_STATE.PLAYING_YOUTUBE) stopYouTubeMode();
    stopAllMedia();
}

async function handleOperatorGrant(data) {
    isOperator = true;
    showToast("Operator 권한이 부여되었습니다.");
    document.getElementById('play-btn').disabled = false;
    document.getElementById('role-badge').innerHTML = `<span class="role-dot"></span> HOST SYNC (OP)`;
}

async function handleOperatorRevoke(data) {
    isOperator = false;
    showToast("Operator 권한이 해제되었습니다.");
    // Play button disabled state handled by sync logic
    document.getElementById('role-badge').innerHTML = `<span class="role-dot"></span> HOST SYNC (Guest)`;
}

// ============================================================================
// [SECTION] UI HELPERS (Fixes for ReferenceError)
// ============================================================================

/**
 * Wrapper for Audio Effect UI controls to route to specific setter functions.
 * Handles the 'oninput' (local preview) vs 'onchange' (broadcast) logic.
 *
 * @param {string} type - Effect type ('reverb', 'stereo', 'vbass', 'cutoff')
 * @param {string} param - Parameter name ('mix', 'decay', 'predelay', 'lowcut', 'highcut', or null)
 * @param {number|string} value - The new value from range slider
 * @param {boolean} isInput - True if 'oninput' (dragging), False if 'onchange' (release)
 */
function updateAudioEffect(type, param, value, isInput = false) {
    const val = parseFloat(value);
    const isLocalOnly = isInput; // Don't broadcast while dragging

    // 1. Reverb
    if (type === MSG.REVERB) {
        switch (param) {
            case 'mix':
                if (typeof setReverb === 'function') setReverb(val, isLocalOnly);
                break;
            case 'decay':
                if (typeof setReverbDecay === 'function') setReverbDecay(val, isLocalOnly);
                break;
            case 'predelay':
                if (typeof setReverbPreDelay === 'function') setReverbPreDelay(val, isLocalOnly);
                break;
            case 'lowcut':
                if (typeof setReverbLowCut === 'function') setReverbLowCut(val, isLocalOnly);
                break;
            case 'highcut':
                if (typeof setReverbHighCut === 'function') setReverbHighCut(val, isLocalOnly);
                break;
        }
    }
    // 2. Stereo Width
    else if (type === 'stereo') {
        // setStereoWidth updates local. onStereoWidthChange broadcasts.
        if (typeof setStereoWidth === 'function') setStereoWidth(val);

        if (!isInput && typeof onStereoWidthChange === 'function') {
            onStereoWidthChange(val);
        }
    }
    // 3. Virtual Bass
    else if (type === MSG.VBASS) {
        if (typeof setVirtualBass === 'function') setVirtualBass(val);

        if (!isInput && typeof onVirtualBassChange === 'function') {
            onVirtualBassChange(val);
        }
    }
}

async function handleDeviceListUpdate(data) {
    const amIStillConnected = data.list.find(p => p.id === myId);
    if (hostConn && !amIStillConnected) {
        log.error("Removed from Host List. Reloading...");
        location.reload();
        return;
    }
    const me = data.list.find(p => p.id === myId);
    if (me) myDeviceLabel = me.label;
    renderDeviceList(data.list);
}

async function handleChat(data) {
    const isMine = (data.sender === myDeviceLabel);
    addChatMessage(data.sender, data.text, isMine);
}

async function handleAssignDataSource(data) {
    const targetId = data.targetId;
    if (targetId && targetId !== myId) {
        showToast(`Connecting to Relay: ...${targetId.substr(-4)}`);
        connectToRelay(targetId);
    } else if (targetId === myId) {
        log.warn("[Relay] Ignored self-assignment request from Host.");
    } else if (targetId === null) {
        // Fallback to Host Direct
        log.debug("[Relay] Fallback to Host requested by server.");
        if (upstreamDataConn) {
            upstreamDataConn.close();
            upstreamDataConn = null;
        }
        showToast("Host 직결로 전환되었습니다 (릴레이 끊김)");

        // Trigger recovery to get missing data from Host
        sendRecoveryRequest();
    }
}

/**
 * [Security] Helper to validate message structure
 */
function validateMessage(data, requiredFields) {
    if (!data || typeof data !== 'object') return false;
    if (!data.type) return false;
    for (const field of requiredFields) {
        if (data[field] === undefined || data[field] === null) {
            log.warn(`[Network] Missing required field '${field}' in message:`, data.type);
            return false;
        }
    }
    return true;
}

const handlers = {
    'heartbeat': handleHeartbeat,
    'pong-latency': handlePongLatency,
    'welcome': handleWelcome,
    'file-prepare': handleFilePrepare,
    'file-start': handleFileStart,
    'file-resume': handleFileResume,
    'file-chunk': handleFileChunk,
    'file-end': handleFileEnd,
    'file-wait': handleFileWait,
    'play': handlePlay,
    'pause': handlePause,
    'volume': handleVolume,
    'reverb': handleReverb,
    'reverb-type': handleReverbType,
    'reverb-decay': handleReverbDecay,
    'reverb-predelay': handleReverbPreDelay,
    'reverb-lowcut': handleReverbLowCut,
    'reverb-highcut': handleReverbHighCut,
    'eq-update': handleEQUpdate,
    'preamp': handlePreamp,
    'eq-reset': handleEQReset,
    'stereo-width': handleStereoWidth,
    'vbass': handleVBass,
    'playlist-update': handlePlaylistUpdate,
    'sync-response': handleSyncResponse,
    'shuffle-mode': handleShuffle,
    'repeat-mode': handleRepeatMode,
    'global-resync-request': handleGlobalResyncRequest,
    'force-sync-play': handleForceSyncPlay,
    'youtube-play': handleYouTubePlay,
    'youtube-sync': handleYouTubeSync,
    'youtube-state': handleYouTubeSync,
    'youtube-sub-title-update': handleYouTubeSubTitleUpdate,
    'youtube-playlist-info': handleYouTubePlaylistInfo,
    'youtube-stop': handleYouTubeStop,
    'operator-grant': handleOperatorGrant,
    'operator-revoke': handleOperatorRevoke,
    'device-list-update': handleDeviceListUpdate,
    'sys-toast': (data) => showToast(data.message),
    'chat': handleChat,
    'assign-data-source': handleAssignDataSource,
    'preload-start': handlePreloadStart,
    'preload-chunk': handlePreloadChunk,
    'preload-end': handlePreloadEnd,
    'play-preloaded': handlePlayPreloaded,
    'status-sync': handleStatusSync,
    'get-sync-time': handleGetSyncTime,
};

async function handleGetSyncTime(data, conn) {
    if (hostConn) return; // Guest ignores this
    if (conn && conn.open) {
        const t = getTrackPosition();
        const isPlaying = (currentState !== APP_STATE.IDLE && (videoElement && !videoElement.paused));

        conn.send({
            type: MSG.SYNC_RESPONSE,
            time: t,
            isPlaying: isPlaying
        });
        log.debug(`[Host] Sent fresh sync time (${t.toFixed(2)}s) to peer ${conn.peer.substr(-4)}`);
    }
}

async function handleData(data, conn) {
    // [Security] Generic validation for all messages
    if (!validateMessage(data, [])) return;

    const handler = handlers[data.type];
    if (handler) {
        try {
            await handler(data, conn);
        } catch (e) {
            log.error(`Error handling ${data.type}:`, e);
        }
    }
}

// --- Relay Functions ---

function connectToRelay(targetId) {
    // Close existing relay connection if we are reassigning
    if (upstreamDataConn) {
        log.debug(`[Relay] Closing existing relay connection (...${upstreamDataConn.peer.substr(-4)}) for new assignment`);
        upstreamDataConn.close();
        upstreamDataConn = null;
    }

    const conn = peer.connect(targetId, {
        metadata: { type: MSG.DATA_RELAY, label: myId }
    });

    const FAIL_TIMEOUT = 10000;
    const connTimer = setTimeout(() => {
        if (!conn.open) {
            log.warn("Relay Connect Timeout");
            conn.close();
            upstreamDataConn = null;

            showToast("Relay 응답 없음. Host 직결 전환...");

            if (hostConn && hostConn.open) {
                const recoveryFileName = window._pendingFileName || (meta ? meta.name : '');
                const recoveryIndex = _pendingFileIndex !== undefined ? _pendingFileIndex : currentTrackIndex;

                log.debug("[Recovery] Requesting from Host:", recoveryFileName, "index:", recoveryIndex, "received:", receivedCount);
                hostConn.send({
                    type: MSG.REQUEST_DATA_RECOVERY,
                    nextChunk: receivedCount || 0,
                    fileName: recoveryFileName,
                    index: recoveryIndex
                });
            }
        }
    }, FAIL_TIMEOUT);

    conn.on('open', () => {
        clearTimeout(connTimer);
        upstreamDataConn = conn;
        showToast("Connected to Relay Node");
        conn.on('data', handleData);

        log.debug("Requesting file from relay...");
        conn.send({ type: MSG.REQUEST_CURRENT_FILE });
    });

    conn.on('close', () => {
        showToast("Relay Disconnected. Recovering...");
        upstreamDataConn = null;

        if (receivedCount < (meta?.total || 0)) {
            if (hostConn && hostConn.open) {
                showToast(`Recovering...`);
                // If upstream relay is still connected, ask for recovery
                sendRecoveryRequest();
            }
        }
    });
}

// --- Manual Sync Logic (Tap Nudge) ---

function openManualSyncUI() {
    document.getElementById('manual-sync-overlay').classList.add('show');
    updateSyncDisplay();
}

window.closeManualSync = function () {
    document.getElementById('manual-sync-overlay').classList.remove('show');
};

function handleManualSync() {
    openManualSyncUI();
}

function handleAutoSync() {
    localOffset = 0; // [RE-ENGINEERING] Reset manual tweaks when clicking AUTO
    autoSyncOffset = 0;
    updateSyncDisplay();
    handleMainSyncBtn();
}

// Tap Sync Logic

function nudgeSync(ms) {
    localOffset += (ms / 1000);
    updateSyncDisplay();

    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
        try {
            const currentTime = youtubePlayer.getCurrentTime();
            youtubePlayer.seekTo(currentTime + (ms / 1000), true);
            showToast(`YouTube Sync: ${ms > 0 ? '+' : ''}${ms}ms`);
        } catch (e) {
            log.error("[YouTube] Nudge sync error:", e);
        }
        if (navigator.vibrate) navigator.vibrate(5);
        return;
    }

    // [Refactored] Formula is now handled dynamically by getTrackPosition()
    // startedAt remains a constant reference to the raw start time point.

    clearManagedTimer('syncDebounce');
    managedTimers.syncDebounce = setTimeout(() => {
        if (currentState !== APP_STATE.IDLE) {
            const target = getTrackPosition();
            const bias = IS_IOS ? IOS_STARTUP_BIAS : 0;

            // Force hard sync on nudge to immediately affect audio
            if (currentAudioBuffer) {
                log.debug(`[Nudge] Applying hard sync for audio: ${target.toFixed(3)}s`);
                play(target);
            }

            if (videoElement) videoElement.currentTime = target - bias;
            showToast(`Sync Adjusted: ${ms > 0 ? '+' : ''}${ms}ms`);
        }
    }, 450); // Balanced debounce
}

function resetTotalSync() {
    localOffset = 0;
    autoSyncOffset = 0;
    updateSyncDisplay();

    if (hostConn && hostConn.open) {
        showToast("초기화 및 재보정 시작...");
        syncReset();
    } else {
        showToast("호스트 연결 없음. 로컬 초기화 완료.");
        if (videoElement && !videoElement.paused) play(Tone.now() - startedAt);
    }
}

function updateSyncDisplay() {
    const totalMs = Math.round((localOffset + autoSyncOffset) * 1000);
    const autoMs = Math.round(autoSyncOffset * 1000);
    const manualMs = Math.round(localOffset * 1000);

    const el = document.getElementById('manual-sync-value');
    if (el) el.innerText = (totalMs > 0 ? '+' : '') + totalMs;

    const detailEl = document.getElementById('sync-details');
    if (detailEl) {
        detailEl.innerHTML = `<span style="opacity:0.7">Auto: ${autoMs}ms</span> <span style="opacity:0.4">|</span> <span style="opacity:0.7">Manual: ${manualMs}ms</span>`;
    }
}

function handleRelayConnection(conn) {
    conn.on('open', () => {
        log.debug("Accepted Relay Connection from", conn.peer);
        // Deduplicate downstream peers
        if (!downstreamDataPeers.find(p => p.peer === conn.peer)) {
            downstreamDataPeers.push(conn);
            showToast(`Relay: ${conn.peer.substr(-4)} 연결됨`);
        }
    });

    conn.on('data', async data => {
        if (data.type === MSG.REQUEST_CURRENT_FILE) {
            const reqName = data.name;
            const reqIndex = data.index;

            const currentTrackName = playlist[currentTrackIndex]?.name;

            // More intelligent source selection based on name/index
            const isMatchCurrent = currentFileBlob && (!reqName || meta.name === reqName);
            const isMatchPreload = nextFileBlob && (
                (reqIndex !== undefined && nextMeta?.index === reqIndex) ||
                (reqName && nextMeta?.name === reqName) ||
                (!reqName && nextMeta?.index === currentTrackIndex)
            );

            if (isMatchCurrent) {
                log.debug(`[Relay] Serving current file to ${conn.peer.substr(-4)}: ${meta.name}`);
                unicastFile(conn, currentFileBlob);
            }
            else if (isMatchPreload) {
                log.debug(`[Relay] Serving preloaded file to ${conn.peer.substr(-4)}: ${nextMeta.name}`);
                unicastFile(conn, nextFileBlob);
            }
            else if (meta?.name && (meta.name === (reqName || currentTrackName) || currentTrackName)) {
                // Mid-download relay bootstrapping
                // If relay peer is still receiving chunks, start downstream with available data
                const bootName = meta.name || reqName || currentTrackName;
                log.debug(`[Relay] Bootstrapping "동생" for ${bootName} (In-progress: ${receivedCount}/${meta.total || '?'})`);

                // 1. Send header first
                // Ensure type is file-start and sessionId is explicitly included
                conn.send({
                    ...meta,
                    type: MSG.FILE_START,
                    name: bootName,
                    sessionId: meta.sessionId || localTransferSessionId
                });

                // 2. Catch-up: Proactively trigger recovery for chunks the relay peer has stored
                // [Optimized] Removed artificial throttling at user request; processRelayQueue handles back-pressure.
                if (receivedCount > 0) {
                    for (let i = 0; i < receivedCount; i++) {
                        postWorkerCommand({
                            command: 'OPFS_READ',
                            filename: meta.name,
                            index: i,
                            isPreload: false,
                            sessionId: localTransferSessionId,
                            requestId: conn.peer
                        });
                    }
                }
            }
            else {
                log.debug("[Relay] No matching data yet for", reqName || 'current');
                conn.send({ type: MSG.FILE_WAIT, message: 'Relay source not ready yet' });
            }
        }
        else if (data.type === MSG.REQUEST_DATA_RECOVERY) {
            // [Relay Recovery] Handle missed chunk requests from downstream peers
            const { fileName, index: trackIdx, nextChunk, sessionId } = data;
            log.debug(`[Relay Recovery] PEER ${conn.peer.substr(-4)} requested chunk ${nextChunk} of ${fileName}`);

            // Request worker to read the chunk and send back to this peer
            postWorkerCommand({
                command: 'OPFS_READ',
                filename: fileName,
                index: nextChunk,
                isPreload: false, // Recovery is usually for current track
                sessionId: sessionId,
                requestId: conn.peer // Tag it so we know where to send the response
            });
        }
    });

    conn.on('close', () => {
        downstreamDataPeers = downstreamDataPeers.filter(p => p.peer !== conn.peer);
    });
}

/**
 * Relays a preloaded file from local cache to downstream peers.
 */
async function relayPreloadFromCache(blob, index, sessionId) {
    if (!blob) {
        log.warn("[Relay] Cannot relay null blob for index:", index);
        return;
    }
    const CHUNK = CHUNK_SIZE;
    const total = Math.ceil(blob.size / CHUNK);

    let fileName = "Preloaded Track";
    if (playlist[index]) fileName = playlist[index].name;
    else if (meta && meta.index === index) fileName = meta.name;
    else if (nextMeta && nextMeta.index === index) fileName = nextMeta.name;

    if (downstreamDataPeers.length === 0) return;

    log.debug(`[Preload Relay] Relaying ${fileName} (${total} chunks) to ${downstreamDataPeers.length} peers`);

    // Read entire blob once instead of per-chunk slice
    const fullBuffer = await blob.arrayBuffer();
    const fullView = new Uint8Array(fullBuffer);

    for (let i = 0; i < total; i++) {
        const activeDownstream = downstreamDataPeers.filter(p => p.open);
        if (activeDownstream.length === 0) break;

        const start = i * CHUNK;
        const end = Math.min(start + CHUNK, fullView.length);
        // Create a copy for safe transfer (subarray shares memory)
        const chunk = new Uint8Array(fullView.subarray(start, end));

        const chunkMsg = { type: MSG.PRELOAD_CHUNK, chunk: chunk, index: i, sessionId: sessionId };
        activeDownstream.forEach(p => p.send(chunkMsg));

        if (i % 10 === 0) await new Promise(r => setTimeout(r, 40));
    }

    const endMsg = { type: MSG.PRELOAD_END, name: fileName, index: index, sessionId: sessionId };
    downstreamDataPeers.forEach(p => {
        if (p.open) p.send(endMsg);
    });
    log.debug(`[Preload Relay] Finished relaying index ${index}`);
}

/**
 * Broadcasts a message to all connected peers.
 * @param {Object} msg - The message to broadcast.
 * @param {Boolean} isDataOnly - If true, only send to peers designated as data targets (relay nodes).
 */
function broadcast(msg, isDataOnly = false) {
    connectedPeers.forEach(p => {
        if (p.status === 'connected' && p.conn.open) {
            if (!isDataOnly || p.isDataTarget !== false) {
                p.conn.send(msg);
            }
        }
    });
}

// Generates and broadcasts the device list to all peers.
function broadcastDeviceList() {
    const list = [
        { id: myId, label: 'HOST', status: 'connected', isHost: true },
        ...connectedPeers
            .sort((a, b) => a.joinOrder - b.joinOrder) // Maintain stable visual order
            .map(p => ({
                id: p.id, label: p.label, status: p.status, isHost: false, isOp: p.isOp
            }))
    ];

    const msg = { type: MSG.DEVICE_LIST_UPDATE, list: list };
    broadcast(msg);
    renderDeviceList(list);
}

function renderDeviceList(list) {
    const container = document.getElementById('device-list');
    if (!container) return;

    let html = '';
    list.forEach((p) => {
        const safeLabel = escapeHtml(p.label);
        const shortId = escapeHtml(p.id.substr(-4));
        const statusClass = p.status === 'connected' ? 'active' : 'inactive';
        const statusText = p.status === 'connected' ? 'Connected' : 'Disconnected';
        const opBadge = p.isOp ? '<span style="color:var(--primary); font-size:10px; font-weight:bold; margin-left:4px;">OP</span>' : '';

        if (hostConn) {
            // Guest view: no operator toggle button
            html += `
                <div class="section-row">
                    <span class="d-name">
                        ${safeLabel} <span style="font-size:11px; opacity:0.5; margin-left:4px;">(${shortId})</span>
                        ${opBadge}
                    </span>
                    <span class="d-status ${statusClass}">${statusText}</span>
                </div>`;
        } else {
            // Host view: includes operator grant/revoke button
            let opBtn = '';
            if (!p.isHost && p.status === 'connected') {
                opBtn = `<button class="btn-action ${p.isOp ? 'active' : ''}"
                     style="font-size:10px; padding:4px 8px; margin-right:8px; ${p.isOp ? 'background:var(--primary); color:white; border:none;' : ''}"
                     onclick="toggleOperator('${escapeHtml(p.id)}')"
                     >${p.isOp ? 'REVOKE' : 'GRANT'}</button>`;
            }

            html += `
                <div class="section-row">
                    <span class="d-name">
                        ${safeLabel} <span style="font-size:11px; opacity:0.5; margin-left:4px;">(${shortId})</span>
                        ${opBadge}
                    </span>
                    <div style="display:flex; gap:4px; align-items:center;">
                        ${opBtn}
                        <span class="d-status ${statusClass}">${statusText}</span>
                    </div>
                </div>`;
        }
    });
    container.innerHTML = html;
}

window.toggleOperator = function (peerId) {
    const p = connectedPeers.find(x => x.id === peerId);
    if (p) {
        p.isOp = !p.isOp;
        p.conn.send({ type: p.isOp ? 'operator-grant' : 'operator-revoke' });
        broadcastDeviceList();
        renderDeviceList([
            { id: myId, label: 'HOST', status: 'connected', isHost: true },
            ...connectedPeers.map(p => ({
                id: p.id, label: p.label, status: p.status, isHost: false, isOp: p.isOp
            }))
        ]);
        showToast(`${p.label} 권한 ${p.isOp ? '부여됨' : '회수됨'}`);
    }
};

function handleOperatorRequest(data) {
    if (data.type === MSG.REQUEST_PLAY) {
        if (managedTimers.autoPlayTimer) {
            clearManagedTimer('autoPlayTimer');
            showToast("자동 재생 취소됨 (OP)");
        }
        play(data.time);
        broadcast({ type: MSG.PLAY, time: data.time });
    } else if (data.type === MSG.REQUEST_PAUSE) {
        if (managedTimers.autoPlayTimer) {
            clearManagedTimer('autoPlayTimer');
        }
        pause();
        broadcast({ type: MSG.PAUSE });
    } else if (data.type === MSG.REQUEST_YOUTUBE_PLAY) {
        log.debug("[Host] OP requested YouTube play");
        if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
            try {
                youtubePlayer.playVideo();
                broadcast({ type: MSG.YOUTUBE_STATE, state: 1, time: youtubePlayer.getCurrentTime() });
            } catch (e) {
                log.error("[YouTube] OP play error:", e);
            }
        }
    } else if (data.type === MSG.REQUEST_YOUTUBE_PAUSE) {
        log.debug("[Host] OP requested YouTube pause");
        if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
            try {
                youtubePlayer.pauseVideo();
                broadcast({ type: MSG.YOUTUBE_STATE, state: 2, time: youtubePlayer.getCurrentTime() });
            } catch (e) {
                log.error("[YouTube] OP pause error:", e);
            }
        }
    } else if (data.type === MSG.REQUEST_TRACK_CHANGE) {
        log.debug("[Host] OP requested track change to:", data.index);
        playTrack(data.index);
    } else if (data.type === MSG.REQUEST_NEXT_TRACK) {
        log.debug("[Host] OP requested next track");
        playNextTrack();
    } else if (data.type === MSG.REQUEST_PREV_TRACK) {
        log.debug("[Host] OP requested prev track");
        playPrevTrack();
    } else if (data.type === MSG.REQUEST_SKIP_TIME) {
        log.debug("[Host] OP requested skip time:", data.sec);
        skipTime(data.sec);
    } else if (data.type === MSG.REQUEST_SEEK) {
        log.debug("[Host] OP requested seek to:", data.time);

        if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
            try {
                youtubePlayer.seekTo(data.time, true);
                broadcast({ type: MSG.YOUTUBE_STATE, state: youtubePlayer.getPlayerState(), time: data.time });
            } catch (e) {
                log.error("[YouTube] request-seek error:", e);
            }
            return;
        }

        if (currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_AUDIO) play(data.time); else pausedAt = data.time;
        broadcast({ type: MSG.PLAY, time: data.time });
    } else if (data.type === MSG.REQUEST_EQ_RESET) {
        resetEQ();
    } else if (data.type === MSG.REQUEST_SETTING) {
        if (data.settingType === MSG.REVERB) { setReverb(data.value); broadcast({ type: MSG.REVERB, value: data.value }); }
        else if (data.settingType === MSG.REVERB_TYPE) { setReverbType(data.value); broadcast({ type: MSG.REVERB_TYPE, value: data.value }); }
        else if (data.settingType === MSG.REVERB_DECAY) { setReverbDecay(data.value); broadcast({ type: MSG.REVERB_DECAY, value: data.value }); }
        else if (data.settingType === MSG.REVERB_PREDELAY) { setReverbPreDelay(data.value); broadcast({ type: MSG.REVERB_PREDELAY, value: data.value }); }
        else if (data.settingType === MSG.REVERB_LOWCUT) { setReverbLowCut(data.value); broadcast({ type: MSG.REVERB_LOWCUT, value: data.value }); }
        else if (data.settingType === MSG.REVERB_HIGHCUT) { setReverbHighCut(data.value); broadcast({ type: MSG.REVERB_HIGHCUT, value: data.value }); }
        else if (data.settingType === 'eq') {
            const band = parseInt(data.band, 10);
            const val = parseFloat(data.value);
            setEQ(band, val, false, true);
            broadcast({ type: MSG.EQ_UPDATE, band: band, value: val });
        }
        else if (data.settingType === MSG.PREAMP) {
            const val = parseFloat(data.value);
            setPreamp(val, false, true);
            broadcast({ type: MSG.PREAMP, value: data.value });
        }
        else if (data.settingType === 'stereo') { setStereoWidth(data.value); broadcast({ type: MSG.STEREO_WIDTH, value: data.value }); }
        else if (data.settingType === MSG.VBASS) { setVirtualBass(data.value); broadcast({ type: MSG.VBASS, value: data.value }); }
    } else if (data.type === MSG.REQUEST_YOUTUBE_SUB_SEEK) {
        log.debug("[Host] OP requested YouTube sub-seek:", data.subIdx);
        if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer && youtubePlayer.playVideoAt) {
            try {
                youtubePlayer.playVideoAt(data.subIdx);
            } catch (e) {
                log.error("[YouTube] OP sub-seek error:", e);
            }
        }
    }
}

function sendRecoveryRequest(forceChunk = null) {
    // Prefer Relay Node for recovery if assigned
    const targetConn = (upstreamDataConn && upstreamDataConn.open) ? upstreamDataConn : hostConn;

    if (!targetConn || !targetConn.open) return;

    const fileName = (meta && meta.name) ? meta.name : (window._pendingFileName || '');
    const index = _pendingFileIndex !== undefined ? _pendingFileIndex : currentTrackIndex;
    const currentSid = localTransferSessionId || currentTransferSessionId;

    let chunkToAsk = forceChunk;
    if (chunkToAsk === null) {
        chunkToAsk = receivedCount || 0;
    }

    const sourceLabel = targetConn === upstreamDataConn ? "Relay" : "Host";
    log.debug(`[Recovery] Requesting from ${sourceLabel}: ${fileName} (Chunk: ${chunkToAsk})`);

    targetConn.send({
        type: MSG.REQUEST_DATA_RECOVERY,
        nextChunk: chunkToAsk,
        fileName: fileName,
        index: index,
        sessionId: currentSid
    });
}

async function broadcastFile(file, explicitSessionId = null) {
    let sessionId;
    if (explicitSessionId !== null) {
        sessionId = explicitSessionId;
        // Ensure global counter is at least equal to this (sync check)
        if (sessionId > currentTransferSessionId) currentTransferSessionId = sessionId;
    } else {
        currentTransferSessionId++;
        sessionId = currentTransferSessionId;
    }

    const CHUNK = CHUNK_SIZE;
    const total = Math.ceil(file.size / CHUNK);
    const header = { type: MSG.FILE_START, name: file.name, mime: file.type, total: total, size: file.size, index: currentTrackIndex, sessionId: sessionId };

    const getEligiblePeers = () => {
        return connectedPeers.filter(p => {
            const trackIdx = currentTrackIndex;
            const alreadyHasPreload = p.preloadedIndexes && p.preloadedIndexes.has(trackIdx);

            // For direct playback (broadcastFile), always send even if they had it preloaded.
            // Guests will ignore it via _skipIncomingFile if they still have the data.
            // This prevents "Previous Track" from failing if Guest deleted the file.
            return (p.status === 'connected' && p.conn.open && p.isDataTarget !== false);
        });
    };

    const eligiblePeers = getEligiblePeers();

    if (eligiblePeers.length === 0) {
        log.debug("[broadcastFile] All peers have preload or no peers, skipping file transfer");
        return;
    }

    // Session Guard: Prevent double-broadcast of the same file/session
    if (_activeBroadcastSession === sessionId) return;
    _activeBroadcastSession = sessionId;

    log.debug(`[broadcastFile] Sending to ${eligiblePeers.length} peers (${connectedPeers.filter(p => p.status === 'connected').length - eligiblePeers.length} skipped due to preload)`);

    eligiblePeers.forEach(p => p.conn.send(header));

    const chunkPromises = [];
    for (let i = 0; i < total; i++) {
        // Session Guard: abort if track changed
        if (_activeBroadcastSession !== sessionId) {
            log.debug(`[broadcastFile] Session cancelled (ID: ${sessionId}), stopping transfer at chunk ${i}`);
            eligiblePeers.forEach(p => { if (p.chunkQueue) p.chunkQueue = []; });
            return;
        }

        const start = i * CHUNK;
        const end = Math.min(start + CHUNK, file.size);
        const chunkBlob = file.slice(start, end);
        const chunkBuf = await chunkBlob.arrayBuffer();
        const chunk = new Uint8Array(chunkBuf);
        const chunkMsg = { type: MSG.FILE_CHUNK, chunk: chunk, index: i, sessionId: sessionId, total: total, name: file.name };

        // Send to each peer independently and wait for their own backpressure
        for (const p of eligiblePeers) {
            if (!p.openSender) {
                p.openSender = (async () => {
                    p.chunkQueue = [];
                    p.isSending = false;
                    p.processQueue = async () => {
                        if (p.isSending || p.chunkQueue.length === 0) return;
                        p.isSending = true;
                        while (p.chunkQueue.length > 0) {
                            const msg = p.chunkQueue.shift();
                            // Per-peer backpressure check
                            while (p.conn.dataChannel && p.conn.dataChannel.bufferedAmount > 512 * 1024) {
                                await new Promise(r => setTimeout(r, DELAY.BACKPRESSURE));
                                if (!p.conn.open) break;
                            }
                            if (p.conn.open) {
                                try { p.conn.send(msg); } catch (e) { log.warn(`[Send] Failed for ${p.label}:`, e); }
                            } else {
                                p.chunkQueue = [];
                                break;
                            }
                        }
                        p.isSending = false;
                    };
                })();
            }
            if (p.conn.open) {
                p.chunkQueue.push(chunkMsg);
                p.processQueue();
            }
        }

        // Slight throttle to prevent main thread starvation during large file slicing
        if (i % 50 === 0) await new Promise(r => setTimeout(r, DELAY.TICK));
    }

    // Prepare end message and send to all
    const endMsg = { type: MSG.FILE_END, name: file.name, mime: file.type, sessionId: sessionId };
    eligiblePeers.forEach(p => {
        if (p.conn.open) {
            p.chunkQueue.push(endMsg);
            p.processQueue();
        }
    });
}

async function unicastFile(conn, file, startChunkIndex = 0, sessionId = null) {
    if (!conn || !conn.open) {
        log.error("[Unicast] Connection is not open, cannot send file");
        showToast("연결 오류: 파일 전송 실패");
        return;
    }

    const effectiveSessionId = sessionId !== null ? sessionId : currentTransferSessionId;

    const CHUNK = CHUNK_SIZE;
    const total = Math.ceil(file.size / CHUNK);

    const isResume = startChunkIndex > 0;
    const msgType = isResume ? 'file-resume' : 'file-start';
    log.debug(`[Unicast] Sending ${msgType}: ${file.name}, chunk ${startChunkIndex}/${total} (SID: ${effectiveSessionId})`);

    try {
        conn.send({
            type: msgType,
            name: file.name,
            mime: file.type,
            total: total,
            size: file.size,
            startChunk: startChunkIndex,
            sessionId: effectiveSessionId
        });
    } catch (e) {
        log.error(`[Unicast] Failed to send ${msgType}:`, e);
        return;
    }

    await new Promise(r => setTimeout(r, 100));

    if (startChunkIndex > 0) {
        showToast(`Resuming transfer from ${startChunkIndex}...`);
    }

    try {
        for (let i = startChunkIndex; i < total; i++) {
            // Session Guard: abort if sequence changed
            if (currentTransferSessionId !== effectiveSessionId) {
                log.debug(`[Unicast] Session mismatch (Expected: ${effectiveSessionId}, Got: ${currentTransferSessionId}), aborting transfer at chunk ${i}`);
                return;
            }

            if (!conn.open) {
                log.warn(`[Unicast] Connection closed at chunk ${i}/${total}. Aborting.`);
                return;
            }

            try {
                // Robust Back-pressure for Unicast
                const startWait = Date.now();
                while (conn.dataChannel && conn.dataChannel.bufferedAmount > 64 * 1024) {
                    if (Date.now() - startWait > 30000) break;
                    await new Promise(r => setTimeout(r, DELAY.BACKPRESSURE));
                }
            } catch (bufferErr) {
                log.warn("[Unicast] Buffer check failed, continuing:", bufferErr);
            }

            const start = i * CHUNK;
            const end = Math.min(start + CHUNK, file.size);
            const chunkBlob = file.slice(start, end);
            const chunkBuf = await chunkBlob.arrayBuffer();
            const chunk = new Uint8Array(chunkBuf);

            try {
                conn.send({ type: MSG.FILE_CHUNK, chunk: chunk, index: i, sessionId: effectiveSessionId, total: total, name: file.name });
            } catch (sendErr) {
                log.warn(`[Unicast] Send failed at chunk ${i}:`, sendErr);
                return;
            }

            if (i % 50 === 0) {
                await new Promise(r => setTimeout(r, DELAY.TICK));
                if (i % 100 === 0) {
                    log.debug(`[Unicast] Progress: ${i}/${total} chunks`);
                }
            }
        }

        if (conn.open) {
            conn.send({ type: MSG.FILE_END, name: file.name, mime: file.type, sessionId: effectiveSessionId });
            log.debug("[Unicast] Transfer complete:", file.name);
        }

    } catch (e) {
        log.error("[Unicast] Transfer error:", e);
    }
}

// [Consolidated] Use broadcast(msg, isDataOnly) above

function updateLoader(percent) {
    const progressBg = document.getElementById('header-progress-bg');
    if (progressBg) {
        progressBg.style.width = `${percent}%`;
    }
}

function showLoader(show, txt) {
    const header = document.getElementById('main-header');
    const loadingText = document.getElementById('header-loading-text');
    const progressBg = document.getElementById('header-progress-bg');

    if (show) {
        header?.classList.add('loading');
        if (txt && loadingText) loadingText.innerText = txt;
        if (progressBg && (progressBg.style.width === '0px' || progressBg.style.width === '')) {
            progressBg.style.width = '0%';
        }
    } else {
        header?.classList.remove('loading');
        setTimeout(() => {
            if (progressBg) progressBg.style.width = '0%';
        }, 400);
    }
}

let toastTimer = null;
function showToast(msg) {
    const t = document.getElementById('toast');
    document.getElementById('toast-msg').innerText = msg;
    t.classList.add('show');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        t.classList.remove('show');
    }, 2000);
}
function copyLink() {
    const link = document.getElementById('my-id').innerText;
    if (link.includes('...')) return;
    let idToCopy = myId;
    if (hostConn) {
        const hostInput = document.getElementById('join-id-input').value;
        if (hostInput) idToCopy = hostInput;
    }
    navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?host=${idToCopy}`);
    showToast("링크 복사 완료");
}

function autoSync() {
    localOffset = 0;
    showToast("모든 기기 Auto Sync 요청...");
    broadcast({ type: MSG.GLOBAL_RESYNC_REQUEST });
}

function loopUI() {
    const isPlaybackState = currentState === APP_STATE.PLAYING_VIDEO ||
        currentState === APP_STATE.PLAYING_AUDIO;

    if (isPlaybackState) {
        // Always update slider while in playback state
        const duration = (currentAudioBuffer && currentAudioBuffer.duration)
            ? currentAudioBuffer.duration
            : (videoElement && isFinite(videoElement.duration) ? videoElement.duration : 0);

        let t = getTrackPosition();

        if (duration > 0 && t > duration) t = duration;

        if (!isSeeking) {
            const slider = document.getElementById('seek-slider');
            if (slider) {
                if (isFinite(duration) && duration > 0) slider.max = duration;
                slider.value = t;
            }
            const timeCurr = document.getElementById('time-curr');
            if (timeCurr) timeCurr.innerText = fmtTime(t);
            const timeDur = document.getElementById('time-dur');
            if (timeDur && isFinite(duration) && duration > 0) timeDur.innerText = fmtTime(duration);
        }

        const now = Date.now();
        if (!_lastEndedCheck || now - _lastEndedCheck > 500) {
            _lastEndedCheck = now;
            handleEnded();
        }

        uiLoopId = requestAnimationFrame(loopUI);
    } else {
        uiLoopId = null;
    }
}

function toggleFullscreen() {
    const wrapper = document.querySelector('.video-wrapper');
    const video = document.getElementById('main-video');

    if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
        return;
    }

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (wrapper.requestFullscreen) wrapper.requestFullscreen();
        else if (wrapper.webkitRequestFullscreen) wrapper.webkitRequestFullscreen();
        else if (wrapper.msRequestFullscreen) wrapper.msRequestFullscreen();
    } else {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
}

async function loadPreloadedTrack(expectedIndex = undefined, loadToken = undefined) {
    // Capture expected index and local copies of data at start
    const targetIndex = expectedIndex ?? nextMeta?.index ?? currentTrackIndex;
    const myToken = loadToken ?? _currentLoadToken;
    const localBlob = nextFileBlob;
    const localMeta = nextMeta ? { ...nextMeta } : null;

    if (!localBlob) {
        log.warn("[Preload] No preloaded blob found in cache!");
        return;
    }

    try {
        await initAudio();

        // Verify track index before proceeding
        if (expectedIndex !== undefined && currentTrackIndex !== targetIndex) {
            log.warn(`[Preload] Index mismatch at start! Expected ${targetIndex}, current is ${currentTrackIndex}. Aborting.`);
            return;
        }

        // Stronger AudioBuffer Disposal: GC Hint + requestIdleCallback
        if (currentAudioBuffer) {
            const oldBuf = currentAudioBuffer;
            currentAudioBuffer = null;
            await new Promise(resolve => {
                if (window.requestIdleCallback) {
                    window.requestIdleCallback(() => {
                        if (oldBuf._buffer) oldBuf._buffer = null;
                        resolve();
                    }, { timeout: 100 });
                } else {
                    setTimeout(resolve, 100);
                }
            });
        }

        // Force Buffer Mode for consistency
        // If decoding fails (e.g. EncodingError), fallback to Streaming Mode
        log.debug("[Preload] Decoding audio for Buffer Mode...");
        showToast("오디오 디코딩 중...");

        const arrayBuffer = await localBlob.arrayBuffer();
        const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer);

        // Re-verify after async decode: check both token and index
        if (loadToken !== undefined && _currentLoadToken !== myToken) {
            log.warn(`[Preload] Token mismatch after decode. Expected ${myToken}, current is ${_currentLoadToken}. Discarding.`);
            return;
        }
        if (expectedIndex !== undefined && currentTrackIndex !== targetIndex) {
            log.warn(`[Preload] Track changed during decode. Expected ${targetIndex}, now ${currentTrackIndex}. Discarding.`);
            return;
        }

        // Only now update global state
        currentFileBlob = localBlob;
        meta = localMeta;
        currentAudioBuffer = audioBuffer;
        log.debug(`[BufferMode] Preloaded ${audioBuffer.duration.toFixed(2)}s decoded.`);

        // Proper mode based on file type (video shows video UI, audio shows visualizer)
        const isVideo = isMediaVideo(localBlob, localMeta);
        setEngineMode(isVideo ? 'video' : 'buffer');

        // Visual Sync
        const url = BlobURLManager.create(localBlob);
        videoElement.src = url;
        videoElement.muted = true;

        // Set UI immediately based on buffer
        const dur = currentAudioBuffer.duration;
        if (isFinite(dur)) {
            document.getElementById('seek-slider').max = dur;
            document.getElementById('time-dur').innerText = fmtTime(dur);
        }
        BlobURLManager.confirm(localBlob);

        // Video load
        videoElement.load();

        // Safe Clearing: Avoid the global clearPreloadState() hammer.
        // Only clear the satisfy-cache variables that we just moved to "current".
        nextFileBlob = null;
        nextMeta = null;
        nextTrackIndex = -1;

        log.debug(`[Preload] Safe clear: nextFileBlob moved to current.`);

        // Consume pending play time if Host already sent it (Crucial for first track)
        if (hostConn && _pendingPlayTime !== undefined) {
            const target = _pendingPlayTime + localOffset + autoSyncOffset;
            log.debug(`[Preload] Found pending play time after activation, starting at ${target.toFixed(2)}s`);
            play(target);
            _pendingPlayTime = undefined;
        }

    } catch (e) {
        log.error("[Preload] Activation failed:", e);
        showToast("프리로드 재생 실패 - 다시 로드합니다");
        // Still clear cache so we can try recovery
        nextFileBlob = null;
        nextMeta = null;
        nextTrackIndex = -1;
        if (hostConn && hostConn.open) {
            hostConn.send({ type: MSG.REQUEST_CURRENT_FILE });
        }
        throw e; // Re-throw so callers can handle
    }
}

function updateUISlider(duration) {
    const slider = document.getElementById('seek-slider');
    const timeDur = document.getElementById('time-dur');

    if (slider && isFinite(duration)) {
        slider.max = duration;
        slider.value = 0;
        slider.disabled = false;
    }

    if (timeDur && isFinite(duration)) {
        timeDur.innerText = fmtTime(duration);
    }
}

function openHelpModal() {
    document.getElementById('help-modal').classList.add('show');
}

function closeHelpModal(event) {
    if (!event || event.target === event.currentTarget) {
        document.getElementById('help-modal').classList.remove('show');
    }
}

let myChatLabel = 'HOST';

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();

    if (!text) return;

    const sender = hostConn ? myDeviceLabel : 'HOST';
    myChatLabel = sender;

    addChatMessage(sender, text, true);

    const chatMsg = { type: MSG.CHAT, sender: sender, text: text };

    if (!hostConn) {
        broadcast(chatMsg);
    } else {
        hostConn.send(chatMsg);
    }

    input.value = '';
}

function addChatMessage(sender, text, isMine) {
    const container = document.getElementById('chat-messages');

    if (container) {
        const empty = container.querySelector('.chat-empty');
        if (empty) empty.remove();

        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

        const row = document.createElement('div');
        row.className = `chat-row ${isMine ? 'mine' : 'others'}`;

        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${isMine ? 'mine' : 'others'}`;

        let bubbleContent = '';
        if (!isMine) {
            bubbleContent += `<div class="chat-sender">${escapeHtml(sender)}</div>`;
        }
        bubbleContent += `<div class="chat-text">${parseMessageContent(text)}</div>`;
        bubble.innerHTML = bubbleContent;

        const timeNode = document.createElement('div');
        timeNode.className = 'chat-time';
        timeNode.innerText = timeStr;

        if (isMine) {
            row.appendChild(timeNode);
            row.appendChild(bubble);
        } else {
            row.appendChild(bubble);
            row.appendChild(timeNode);
        }

        container.appendChild(row);
        container.scrollTop = container.scrollHeight;
    }

    // Update preview state
    lastChatSender = sender;
    lastChatText = text;
    updateChatPreview(sender, text);

    if (!isMine) {
        incrementUnread();
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function parseMessageContent(text) {
    const ytRegex = /(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[a-zA-Z0-9_-]{11}[^\s]*/gi;
    const tsRegex = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;

    const combinedRegex = new RegExp(
        `(${ytRegex.source})|(${tsRegex.source})`,
        'gi'
    );

    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = combinedRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            result += escapeHtml(text.slice(lastIndex, match.index));
        }

        const matchedText = match[0];

        if (ytRegex.test(matchedText)) {
            ytRegex.lastIndex = 0;
            const cleanUrl = matchedText.startsWith('http') ? matchedText : 'https://' + matchedText;
            const safeUrl = cleanUrl.replace(/'/g, "\\'");
            const uniqueId = 'yt-' + Math.random().toString(36).substr(2, 9);

            result += `
                <button class="chat-youtube-btn" data-youtube-url="${escapeHtml(cleanUrl)}">
                    <span class="chat-yt-play-row">▶ YouTube 재생하기</span>
                    <span id="${uniqueId}" class="chat-yt-title">${escapeHtml(matchedText)}</span>
                </button>
            `;

            // Async title fetch
            setTimeout(() => updateYouTubeChatTitle(uniqueId, cleanUrl), 100);
        }
        else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(matchedText)) {
            const seconds = parseTimestamp(matchedText);
            result += `<span class="chat-timestamp" onclick="seekToTime(${seconds})">${matchedText}</span>`;
        }
        else {
            result += escapeHtml(matchedText);
        }

        lastIndex = combinedRegex.lastIndex;
    }

    if (lastIndex < text.length) {
        result += escapeHtml(text.slice(lastIndex));
    }

    return result;
}

/**
 * YouTube oEmbed API를 사용하여 영상 제목을 가져와 업데이트합니다.
 */
async function updateYouTubeChatTitle(elementId, url) {
    const el = document.getElementById(elementId);
    if (!el) return;

    try {
        const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        const response = await fetch(oEmbedUrl);
        if (response.ok) {
            const data = await response.json();
            if (data && data.title) {
                el.innerText = data.title;
            }
        }
    } catch (e) {
        log.warn("[YouTube] Failed to fetch oEmbed title:", e);
    }
}

function parseTimestamp(str) {
    const parts = str.split(':').map(Number);
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
}

function seekToTime(seconds) {
    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer && youtubePlayer.seekTo) {
        youtubePlayer.seekTo(seconds, true);
        showToast(`${fmtTime(seconds)}로 이동`);
    } else if (currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_AUDIO) {
        const video = document.getElementById('main-video');
        if (video) {
            video.currentTime = seconds;
            showToast(`${fmtTime(seconds)}로 이동`);
        }
    } else if (videoElement && videoElement.src) {
        stopAllMedia();
        play(seconds);
        showToast(`${fmtTime(seconds)}로 이동`);
    } else {
        showToast("재생 중인 미디어가 없습니다");
    }
}

function loadYouTubeFromChat(url) {
    const videoId = extractYouTubeVideoId(url);
    const playlistId = extractYouTubePlaylistId(url);

    if (!videoId && !playlistId) {
        showToast("유효하지 않은 YouTube 링크");
        return;
    }

    if (isChatDrawerOpen) {
        toggleChatDrawer();
    }

    const title = 'YouTube Video';
    const wasEmpty = (playlist.length === 0);

    playlist.push({
        type: 'youtube',
        videoId: videoId,
        playlistId: playlistId,
        title: title,
        name: title
    });

    updatePlaylistUI();

    const metaList = playlist.map(item => ({
        type: item.type,
        name: item.name || item.title,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null
    }));
    broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });

    playTrack(playlist.length - 1);
    showToast("YouTube 재생 시작");
}

function insertEmoji(emoji) {
    const input = document.getElementById('chat-input');
    if (input) {
        input.value += emoji;
        input.focus();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }

    // Event delegation for YouTube chat buttons (replaces inline onclick)
    document.addEventListener('click', (e) => {
        const ytBtn = e.target.closest('.chat-youtube-btn[data-youtube-url]');
        if (ytBtn) {
            const url = ytBtn.getAttribute('data-youtube-url');
            if (url) loadYouTubeFromChat(url);
        }
    });
});

window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    const isPlayingAny = (currentState !== APP_STATE.IDLE);
    if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePlay();
    } else if (e.key === 'p' || e.key === 'P') {
        if (!isPlayingAny) togglePlay();
    } else if (e.key === 's' || e.key === 'S') {
        if (isPlayingAny) togglePlay();
    }
});

let unreadChatCount = 0;
let lastChatSender = '';
let lastChatText = '';
let isChatDrawerOpen = false;

// [Consolidated] merged into updateChatBadge(count) and updateChatPreview(sender, text)

function incrementUnread() {
    if (!isChatDrawerOpen) {
        unreadChatCount++;
        updateChatBadge(unreadChatCount);
    }
}

function clearUnread() {
    unreadChatCount = 0;
    updateChatBadge(0);
}

function toggleChatDrawer() {
    const drawer = document.getElementById('chat-drawer');
    if (!drawer) return;

    isChatDrawerOpen = !isChatDrawerOpen;
    drawer.classList.toggle('open', isChatDrawerOpen);

    if (isChatDrawerOpen) {
        clearUnread();
        setTimeout(() => {
            const input = document.getElementById('chat-input');
            if (input) input.focus();
        }, 300);
        const messages = document.getElementById('chat-messages');
        if (messages) messages.scrollTop = messages.scrollHeight;
    }
}

function updateChatBadge(count) {
    const badge = document.getElementById('chat-preview-badge');
    if (!badge) return;

    if (count > 0) {
        badge.textContent = count > 9 ? '9+' : count;
        badge.classList.add('show');
    } else {
        badge.classList.remove('show');
    }
}

function updateChatPreview(sender, text) {
    const previewText = document.getElementById('chat-preview-text');
    if (previewText && sender && text) {
        previewText.textContent = `${sender}: ${text}`;
    }
}

function updateChatYouTube(active) {
    const drawer = document.getElementById('chat-drawer');
    if (!drawer) return;

    if (active) {
        drawer.classList.add('with-youtube');

        let container = document.getElementById('chat-youtube-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'chat-youtube-container';
            container.className = 'chat-youtube-container';
            container.innerHTML = '<div class="chat-youtube-player" id="chat-youtube-placeholder"></div>';

            const messages = document.getElementById('chat-messages');
            drawer.insertBefore(container, messages);
        }
    } else {
        drawer.classList.remove('with-youtube');
        const container = document.getElementById('chat-youtube-container');
        if (container) container.remove();
    }
}

let youtubePlayer = null;
let youtubeSessionId = 0;

function openMediaSourcePopup() {
    if (hostConn) {
        return showToast("Host만 실행할 수 있습니다.");
    }
    document.getElementById('media-source-overlay').classList.add('show');
}

function closeMediaSourcePopup() {
    document.getElementById('media-source-overlay').classList.remove('show');
}

function openYouTubePopup() {
    document.getElementById('youtube-url-overlay').classList.add('show');
    document.getElementById('youtube-url-input').value = '';
    document.getElementById('youtube-url-input').focus();
}

function closeYouTubePopup() {
    document.getElementById('youtube-url-overlay').classList.remove('show');
}

function extractYouTubeVideoId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

function extractYouTubePlaylistId(url) {
    const match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

function loadYouTubeFromInput() {
    const url = document.getElementById('youtube-url-input').value.trim();
    if (!url) {
        showToast("URL을 입력해 주세요");
        return;
    }

    const videoId = extractYouTubeVideoId(url);
    const playlistId = extractYouTubePlaylistId(url);

    if (!videoId && !playlistId) {
        showToast("유효한 YouTube 링크가 아닙니다");
        return;
    }

    const previewTitle = document.getElementById('youtube-preview-title').innerText || 'YouTube Video';
    const previewThumb = document.getElementById('youtube-preview-thumb').src || '';
    const previewChannel = document.getElementById('youtube-preview-channel').innerText || '';

    const wasEmpty = (playlist.length === 0);

    playlist.push({
        type: 'youtube',
        videoId: videoId,
        playlistId: playlistId,
        title: previewTitle,
        name: previewTitle,
        thumbnail: previewThumb,
        channel: previewChannel
    });

    updatePlaylistUI();

    const metaList = playlist.map(item => ({
        type: item.type,
        name: item.name || item.title,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null
    }));
    broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });

    closeYouTubePopup();

    document.getElementById('youtube-url-input').value = '';
    document.getElementById('youtube-preview').style.display = 'none';
    document.getElementById('youtube-preview-status').style.display = 'block';
    document.getElementById('youtube-preview-status').innerText = '동영상 또는 플레이리스트 링크를 입력하세요';
    document.getElementById('youtube-play-btn').disabled = true;
    document.getElementById('youtube-play-btn').style.opacity = '0.5';

    if (wasEmpty) {
        playTrack(0);
    } else {
        showToast(`"${previewTitle}" 플레이리스트에 추가됨`);
    }
}

function loadYouTubeVideo(videoId, playlistId = null, autoplay = true, subIndex = 0) {
    youtubeSessionId++;
    const currentSessionId = youtubeSessionId;
    _currentYouTubeSessionId = currentSessionId;

    stopAllMedia();
    setEngineMode('youtube');

    showToast("YouTube 같이 보기 - 고급 오디오 효과가 비활성화됩니다");

    const wrapper = document.querySelector('.video-wrapper');
    let container = document.getElementById('youtube-player-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'youtube-player-container';
        container.style.cssText = 'width:100%; height:100%; position:relative;';
        wrapper.appendChild(container);
    }

    if (!youtubePlayer) {
        container.innerHTML = '<div id="youtube-player"></div>';
    }

    if (!window.YT || !window.YT.Player) {
        if (!_ytScriptLoading) {
            _ytScriptLoading = true;
            const tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';

            // YouTube API loading error handling
            tag.onload = () => log.debug('[YouTube] API script loaded');
            tag.onerror = () => {
                log.error('[YouTube] Failed to load API script');
                _ytScriptLoading = false;
                showToast('YouTube API 로드 실패. 인터넷 연결 확인!');
            };

            document.head.appendChild(tag);
        }
        window.onYouTubeIframeAPIReady = () => {
            window.isYouTubeAPIReady = true;
            initYouTubePlayer(videoId, playlistId, autoplay, subIndex);
        };
    } else {
        initYouTubePlayer(videoId, playlistId, autoplay, subIndex);
    }


    // Safety Timeout: prevents infinite loader if YouTube API fails silently
    if (_ytLoadTimeout) clearTimeout(_ytLoadTimeout);
    _ytLoadTimeout = setTimeout(() => {
        if (_currentYouTubeSessionId === currentSessionId && (!youtubePlayer || !isYouTubeAPIReady)) {
            log.warn('[YouTube] Load timeout triggered.');
            showLoader(false);
            showToast('YouTube 로드 시간 초과. 다시 시도해주세요.');
        }
    }, 15000);

    document.getElementById('play-btn').disabled = false;

    const fsBtn = document.querySelector('.fullscreen-btn');
    if (fsBtn) fsBtn.style.setProperty('display', 'none', 'important');

    setTimeout(() => refreshYouTubeDisplay(), 500);

    log.debug("[YouTube] Loaded:", videoId || playlistId, "autoplay:", autoplay);
}

function initYouTubePlayer(videoId, playlistId = null, autoplay = true, subIndex = 0) {
    // Safety Guard: Ensure we are still in YouTube mode when player initializes
    if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
        log.warn("[YouTube] initYouTubePlayer aborted - not in PLAYING_YOUTUBE state");
        return;
    }
    if (youtubePlayer && youtubePlayer.loadVideoById) {
        log.debug("[YouTube] Re-using existing player instance");
        try {
            if (playlistId) {
                youtubePlayer.loadPlaylist({
                    list: playlistId,
                    listType: 'playlist',
                    index: subIndex,
                    startSeconds: 0
                });
            } else if (videoId) {
                youtubePlayer.loadVideoById(videoId);
            }
            if (!autoplay) youtubePlayer.pauseVideo();
            return;
        } catch (e) {
            log.warn("[YouTube] Failed to reuse player, recreating...", e);
            const container = document.getElementById('youtube-player-container');
            if (container) container.innerHTML = '<div id="youtube-player"></div>';
        }
    }

    const playerVars = {
        autoplay: autoplay ? 1 : 0,
        controls: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        origin: window.location.origin
    };

    if (playlistId) {
        playerVars.listType = 'playlist';
        playerVars.list = playlistId;
    }

    const playerOptions = {
        width: '100%',
        height: '100%',
        playerVars: playerVars,
        events: {
            'onReady': onYouTubePlayerReady,
            'onStateChange': onYouTubePlayerStateChange
        }
    };

    if (videoId) {
        playerOptions.videoId = videoId;
    }

    youtubePlayer = new YT.Player('youtube-player', playerOptions);
}

function onYouTubePlayerReady(event) {
    log.debug("[YouTube] Player ready");

    if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
        log.debug("[YouTube] onPlayerReady skipped - mode changed");
        return;
    }

    if (managedTimers.youtubeUILoop) clearInterval(managedTimers.youtubeUILoop);
    managedTimers.youtubeUILoop = setInterval(updateYouTubeUI, 500);

    // Ensure ONLY Host runs the sync loop
    if (managedTimers.youtubeSyncLoop) clearInterval(managedTimers.youtubeSyncLoop);
    if (!hostConn) {
        managedTimers.youtubeSyncLoop = setInterval(broadcastYouTubeSync, 3000);
    } else {
        log.debug("[YouTube] Guest mode: sync loop disabled");
    }

    // [Sync] Apply current master volume to YouTube player immediately
    setVolume(masterVolume);
}

function onYouTubePlayerStateChange(event) {
    if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
        log.debug("[YouTube] StateChange skipped - not in YouTube mode");
        return;
    }

    const state = event.data;

    if (state === YT.PlayerState.PLAYING) {
        showYouTubeSyncOverlay(false);
        document.getElementById('icon-play').style.display = 'none';
        document.getElementById('icon-pause').style.display = 'block';
    } else if (state === YT.PlayerState.PAUSED) {
        document.getElementById('icon-play').style.display = 'block';
        document.getElementById('icon-pause').style.display = 'none';
    } else if (state === YT.PlayerState.ENDED) {
        setState(APP_STATE.IDLE);

        if (!hostConn) {
            log.debug("[YouTube] Ended, playing next track...");
            playNextTrack();
        }
    }

    if (!hostConn && youtubePlayer && youtubePlayer.getCurrentTime) {
        broadcast({
            type: MSG.YOUTUBE_STATE,
            state: state,
            time: youtubePlayer.getCurrentTime(),
            subIndex: youtubePlayer.getPlaylistIndex ? youtubePlayer.getPlaylistIndex() : -1
        });
    }
}

function updateYouTubeUI() {
    if (!youtubePlayer || currentState !== APP_STATE.PLAYING_YOUTUBE || !youtubePlayer.getCurrentTime) return;

    try {
        const currentTime = youtubePlayer.getCurrentTime();
        const duration = youtubePlayer.getDuration ? youtubePlayer.getDuration() : 0;
        const state = youtubePlayer.getPlayerState ? youtubePlayer.getPlayerState() : -1;

        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        if (isIOS && (state === 5 || state === -1)) {
            if (!_ytIOSWatchdog) _ytIOSWatchdog = Date.now();
            if (Date.now() - _ytIOSWatchdog > 3000) {
                showYouTubeSyncOverlay(true);
            }
        } else {
            _ytIOSWatchdog = null;
        }

        if (duration > 0) {
            document.getElementById('time-curr').innerText = fmtTime(currentTime);
            document.getElementById('time-dur').innerText = fmtTime(duration);

            const slider = document.getElementById('seek-slider');
            slider.max = duration;
            slider.value = currentTime;
        }
    } catch (e) {
        // Player not ready yet
    }
}

function showYouTubeSyncOverlay(show) {
    const overlayId = 'youtube-ios-sync-overlay';
    let overlay = document.getElementById(overlayId);

    if (show) {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = overlayId;
            overlay.style.cssText = `
                position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.6); display: flex; align-items: center;
                justify-content: center; z-index: 100; cursor: pointer;
                backdrop-filter: blur(4px); animation: fadeIn 0.3s ease-out;
            `;
            overlay.onclick = () => {
                if (youtubePlayer && youtubePlayer.playVideo) {
                    youtubePlayer.playVideo();
                    showYouTubeSyncOverlay(false);
                }
            };
            overlay.innerHTML = `
                <div style="background:var(--primary); color:white; padding:12px 24px; border-radius:100px; font-weight:bold; font-size:14px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); display:flex; align-items:center; gap:8px;">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M8 5v14l11-7z"/></svg>
                    TAP TO SYNC VIDEO
                </div>
            `;
            const wrapper = document.querySelector('.video-wrapper');
            if (wrapper) wrapper.appendChild(overlay);
        }
        overlay.style.display = 'flex';
    } else if (overlay) {
        overlay.style.display = 'none';
        _ytIOSWatchdog = null;
    }
}

function broadcastYouTubeSync() {
    if (!youtubePlayer || hostConn || !youtubePlayer.getCurrentTime) return;

    try {
        const currentTime = youtubePlayer.getCurrentTime();
        const state = youtubePlayer.getPlayerState ? youtubePlayer.getPlayerState() : -1;

        if (youtubePlayer.getPlaylistIndex) {
            const sIdx = youtubePlayer.getPlaylistIndex();
            if (sIdx !== currentYouTubeSubIndex) {
                currentYouTubeSubIndex = sIdx;

                if (playlist[currentTrackIndex] && playlist[currentTrackIndex].playlistId) {
                    const pid = playlist[currentTrackIndex].playlistId;

                    if (youtubePlayer.getPlaylist) {
                        try {
                            const ids = youtubePlayer.getPlaylist();
                            if (ids && ids.length > 0) {
                                if (!youtubeSubItemsMap[pid]) {
                                    youtubeSubItemsMap[pid] = { ids: ids, titles: [] };
                                    if (playlist[currentTrackIndex].isExpanded) fetchPlaylistSubTitles(pid, ids);
                                } else if (!youtubeSubItemsMap[pid].ids || youtubeSubItemsMap[pid].ids.length === 0) {
                                    youtubeSubItemsMap[pid].ids = ids;
                                    if (playlist[currentTrackIndex].isExpanded) fetchPlaylistSubTitles(pid, ids);
                                }
                            }
                        } catch (idsErr) { }
                    }

                    if (youtubeSubItemsMap[pid]) {
                        if (youtubePlayer.getVideoData) {
                            const vData = youtubePlayer.getVideoData();
                            if (vData && vData.title) {
                                if (youtubeSubItemsMap[pid].titles[sIdx] !== vData.title) {
                                    youtubeSubItemsMap[pid].titles[sIdx] = vData.title;

                                    broadcast({
                                        type: MSG.YOUTUBE_SUB_TITLE_UPDATE,
                                        playlistId: pid,
                                        subIdx: sIdx,
                                        title: vData.title
                                    });
                                }
                            }
                        }
                    }
                }
                updatePlaylistUI();
                if (playlist[currentTrackIndex]) updateMediaSessionMetadata(playlist[currentTrackIndex]);
            }
        }

        broadcast({
            type: MSG.YOUTUBE_SYNC,
            time: currentTime,
            state: state,
            subIndex: currentYouTubeSubIndex
        });
    } catch (e) {
        // Player not ready
    }
}

function handleYouTubeSync(data) {
    if (!youtubePlayer || currentState !== APP_STATE.PLAYING_YOUTUBE || !youtubePlayer.getCurrentTime) return;

    try {
        const hostTime = data.time;
        const hostState = data.state;
        const hostSubIndex = data.subIndex;

        if (hostSubIndex !== undefined && hostSubIndex !== -1 && hostSubIndex !== currentYouTubeSubIndex) {
            log.debug(`[YouTube Sync] Sub-index change: ${currentYouTubeSubIndex} -> ${hostSubIndex}`);
            currentYouTubeSubIndex = hostSubIndex;

            if (youtubePlayer && youtubePlayer.playVideoAt && youtubePlayer.getPlaylistIndex) {
                if (youtubePlayer.getPlaylistIndex() !== hostSubIndex) {
                    youtubePlayer.playVideoAt(hostSubIndex);
                }
            }

            if (playlist[currentTrackIndex] && playlist[currentTrackIndex].playlistId) {
                const pid = playlist[currentTrackIndex].playlistId;
                if (!youtubeSubItemsMap[pid] && youtubePlayer && youtubePlayer.getPlaylist) {
                    youtubeSubItemsMap[pid] = { ids: youtubePlayer.getPlaylist(), titles: [] };
                }
                if (youtubePlayer && youtubePlayer.getVideoData) {
                    const vData = youtubePlayer.getVideoData();
                    if (vData && vData.title) {
                        if (!youtubeSubItemsMap[pid]) youtubeSubItemsMap[pid] = { ids: [], titles: [] };
                        youtubeSubItemsMap[pid].titles[hostSubIndex] = vData.title;
                    }
                }
            }
            updatePlaylistUI();
            if (playlist[currentTrackIndex]) updateMediaSessionMetadata(playlist[currentTrackIndex]);
        }

        const compensatedTime = hostTime + autoSyncOffset + localOffset;

        const currentTime = youtubePlayer.getCurrentTime();
        const drift = Math.abs(currentTime - compensatedTime);

        if (drift > 2 && youtubePlayer.seekTo) {
            log.debug(`[YouTube Sync] Drift ${drift.toFixed(1)}s, seeking to ${compensatedTime.toFixed(1)}s`);
            youtubePlayer.seekTo(compensatedTime, true);
        }

        if (youtubePlayer.getPlayerState && youtubePlayer.playVideo && youtubePlayer.pauseVideo) {
            const ytState = youtubePlayer.getPlayerState();
            if (hostState === 1 && ytState !== 1) {
                youtubePlayer.playVideo();
            } else if (hostState === 2 && ytState !== 2) {
                youtubePlayer.pauseVideo();
            }
        }
    } catch (e) {
        log.error("[YouTube Sync] Error:", e);
    }
}

/**
 * [HACK] Forces a layout recalculation for the YouTube iframe.
 * This resolves a race condition in mobile browsers where the player
 * appears as a black screen until the next layout pass (e.g. on scroll/resize).
 */
function refreshYouTubeDisplay() {
    const container = document.getElementById('youtube-player-container');
    if (!container || currentState !== APP_STATE.PLAYING_YOUTUBE) return;

    log.debug("[YouTube] Refreshing display to prevent black screen...");
    const iframe = container.querySelector('iframe');

    container.style.display = 'none';
    container.offsetHeight; // Force reflow
    container.style.display = 'block';

    if (iframe) {
        iframe.style.visibility = 'hidden';
        iframe.offsetHeight; // Force reflow
        iframe.style.visibility = 'visible';
    }

    window.dispatchEvent(new Event('resize'));
}

function handleYouTubeSubTitleUpdate(data) {
    const { playlistId, subIdx, title } = data;
    if (!youtubeSubItemsMap[playlistId]) {
        youtubeSubItemsMap[playlistId] = { ids: [], titles: [] };
    }
    youtubeSubItemsMap[playlistId].titles[subIdx] = title;
    updatePlaylistUI();

    if (playlist[currentTrackIndex] && playlist[currentTrackIndex].playlistId === playlistId && currentYouTubeSubIndex === subIdx) {
        updateMediaSessionMetadata(playlist[currentTrackIndex]);
    }
}

function stopYouTubeMode() {
    // Avoid IDLE state if we are transitioning TO another state
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
        setState(APP_STATE.IDLE, { skipCleanup: true });
    } else {
        // If already not in YouTube mode, skip redundant cleanup and logging
        return;
    }

    if (managedTimers.youtubeUILoop) clearInterval(managedTimers.youtubeUILoop);
    if (managedTimers.youtubeSyncLoop) clearInterval(managedTimers.youtubeSyncLoop);

    if (youtubePlayer) {
        try {
            log.debug("[YouTube] Destroying player instance...");
            youtubePlayer.stopVideo();
            if (typeof youtubePlayer.destroy === 'function') youtubePlayer.destroy();
        } catch (e) { log.debug('[YouTube] Cleanup error (non-critical):', e.message); }
        youtubePlayer = null;
    }

    const container = document.getElementById('youtube-player-container');
    if (container) {
        container.innerHTML = '';
    }

    const videoEl = document.getElementById('main-video');
    if (videoEl) {
        videoEl.pause();
        videoEl.src = '';
        videoEl.style.display = 'none';
        videoEl.load(); // Ensure cleanup
    }

    const fsBtn = document.querySelector('.fullscreen-btn');
    if (fsBtn) {
        fsBtn.style.removeProperty('display');
        fsBtn.style.display = '';
    }

    updateChatYouTube(false);

    log.debug("[YouTube] Mode stopped, visualizer restored");
    updatePlaylistUI();

    if (currentTrackIndex >= 0 && playlist[currentTrackIndex]) {
        const item = playlist[currentTrackIndex];
        if (item.type !== 'youtube') {
            const displayName = item.file?.name || item.name || 'Unknown';
            updateTitleWithMarquee(displayName);
            document.getElementById('track-artist').innerText = `Track ${currentTrackIndex + 1}`;
        }
    }
}

async function loadDemoMedia() {
    if (hostConn) return showToast("Host만 실행할 수 있습니다.");

    const DEMO_VIDEO_URL = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4";
    try {
        showLoader(true, "데모 영상 다운로드 중...");

        const response = await fetch(DEMO_VIDEO_URL);
        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;
        let loaded = 0;

        const reader = response.body.getReader();
        const chunks = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            chunks.push(value);
            loaded += value.length;

            if (total > 0) {
                const percent = Math.floor((loaded / total) * 100);
                const loadedMB = (loaded / 1024 / 1024).toFixed(1);
                const totalMB = (total / 1024 / 1024).toFixed(1);
                showLoader(true, `데모 다운로드... ${loadedMB} / ${totalMB} MB (${percent}%)`);
                updateLoader(percent);
            } else {
                const loadedMB = (loaded / 1024 / 1024).toFixed(1);
                showLoader(true, `데모 다운로드... ${loadedMB} MB`);
            }
        }

        const blob = new Blob(chunks, { type: 'video/mp4' });
        const file = new File([blob], 'TearsOfSteel.mp4', { type: 'video/mp4' });

        // [Refactor] Append to playlist instead of overwrite
        const newTrack = {
            type: 'video',
            file: file,
            name: file.name,
            title: 'Tears of Steel (Demo)'
        };
        playlist.push(newTrack);

        // Update UI
        updatePlaylistUI();

        // Broadcast playlist update
        const metaList = playlist.map(item => ({
            type: item.type,
            name: item.name || item.title,
            videoId: item.videoId || null,
            playlistId: item.playlistId || null
        }));
        broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });

        showToast("데모 영상 다운로드 완료. 재생을 시작합니다.");

        // [Refactor] Use standard playTrack flow
        // This handles broadcastFile, UI state, button enabling, etc.
        playTrack(playlist.length - 1);

    } catch (e) {
        log.error("Demo load failed:", e);
        showToast("데모 로드 실패: " + (e.name === 'AbortError' ? '시간 초과' : e.message));
        showLoader(false);
    }
}

let youtubePreviewDebounce = null;

function fetchYouTubePreview(url) {
    const previewContainer = document.getElementById('youtube-preview');
    const statusText = document.getElementById('youtube-preview-status');
    const playBtn = document.getElementById('youtube-play-btn');

    const setPlayBtnEnabled = (enabled) => {
        playBtn.disabled = !enabled;
        playBtn.style.opacity = enabled ? '1' : '0.5';
    };

    if (youtubePreviewDebounce) clearTimeout(youtubePreviewDebounce);

    if (!url || url.trim() === '') {
        previewContainer.style.display = 'none';
        statusText.style.display = 'block';
        statusText.innerText = '동영상 또는 플레이리스트 링크를 입력하세요';
        statusText.style.color = 'var(--text-sub)';
        setPlayBtnEnabled(false);
        return;
    }

    const videoId = extractYouTubeVideoId(url);
    const playlistId = extractYouTubePlaylistId(url);

    if (!videoId && !playlistId) {
        previewContainer.style.display = 'none';
        statusText.style.display = 'block';
        statusText.innerText = '유효한 YouTube 링크가 아닙니다';
        statusText.style.color = '#ef4444';
        setPlayBtnEnabled(false);
        return;
    }

    statusText.style.display = 'block';
    statusText.innerText = '영상 정보 불러오는 중...';
    statusText.style.color = 'var(--text-sub)';
    setPlayBtnEnabled(false);

    youtubePreviewDebounce = setTimeout(async () => {
        try {
            const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
            const response = await fetch(oembedUrl);

            if (!response.ok) {
                throw new Error('Video not found');
            }

            const data = await response.json();

            document.getElementById('youtube-preview-thumb').src = data.thumbnail_url;
            document.getElementById('youtube-preview-title').innerText = data.title;
            document.getElementById('youtube-preview-channel').innerText = data.author_name;

            previewContainer.style.display = 'block';
            statusText.style.display = 'none';

            setPlayBtnEnabled(true);

        } catch (e) {
            log.error('[YouTube Preview] Error:', e);
            previewContainer.style.display = 'none';
            statusText.style.display = 'block';
            statusText.innerText = '영상 정보를 불러올 수 없습니다';
            statusText.style.color = '#ef4444';
            setPlayBtnEnabled(false);
        }
    }, 500);
}

// NOTE: Seek slider event handlers are defined around line 2785
// Do not add duplicate handlers here

// --- Relay Queue Processor (Back-pressure Control) ---
async function processRelayQueue() {
    if (isRelaying) return;
    isRelaying = true;

    while (relayChunkQueue.length > 0) {
        const msg = relayChunkQueue.shift();
        const openPeers = downstreamDataPeers.filter(p => p.open);

        if (openPeers.length === 0) {
            relayChunkQueue = [];
            break;
        }

        // Dispatch to each peer's individual queue
        openPeers.forEach((p, pIdx) => {
            // Support targeting specific peers for catch-up data
            if (msg.targetPeerId && msg.targetPeerId !== p.peer) return;

            // Multi-peer Detachment Protection
            // Clone the message if there are multiple peers to ensure they each get a fresh buffer
            let peerMsg = msg;
            if (openPeers.length > 1 && msg.chunk instanceof Uint8Array) {
                // Clone for all but the last peer to save one allocation
                if (pIdx < openPeers.length - 1) {
                    peerMsg = { ...msg, chunk: new Uint8Array(msg.chunk) };
                }
            }

            if (!p._relayQueue) {
                p._relayQueue = [];
                p._relayBusy = false;
                p._processRelay = async () => {
                    if (p._relayBusy || p._relayQueue.length === 0) return;
                    p._relayBusy = true;
                    while (p._relayQueue.length > 0) {
                        const m = p._relayQueue.shift();
                        // Per-peer buffer check
                        // [Optimized] Lower threshold (128KB) for faster feedback
                        while (p.dataChannel && p.dataChannel.bufferedAmount > 128 * 1024) {
                            await new Promise(r => setTimeout(r, DELAY.BACKPRESSURE));
                            if (!p.open) break;
                        }
                        if (p.open) {
                            try { p.send(m); } catch (e) { log.warn(`[Relay] Send failed:`, e); }
                        } else {
                            p._relayQueue = [];
                            break;
                        }
                    }
                    p._relayBusy = false;
                };
            }
            // Memory safety: cap per-peer relay queue to prevent unbounded growth
            const MAX_PEER_RELAY_QUEUE = 500;
            if (p._relayQueue.length > MAX_PEER_RELAY_QUEUE) {
                // Drop oldest chunks instead of disconnecting - keeps peer alive on slow connections
                const dropped = p._relayQueue.length - Math.floor(MAX_PEER_RELAY_QUEUE * 0.8);
                log.warn(`[Relay] Peer ...${p.peer.substr(-4)} queue overflow (${p._relayQueue.length}). Dropping ${dropped} oldest chunks.`);
                p._relayQueue.splice(0, dropped);
            }

            p._relayQueue.push(peerMsg);
            p._processRelay();
        });

        // Yield to prevent blocking UI thread if queue is huge
        if (relayChunkQueue.length % 50 === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }

    isRelaying = false;
}

// ============================================================================
// [SECTION] RELAY DEBUG CONSOLE
// ============================================================================
window.relayDebug = function () {
    log.debug("=== RELAY DEBUG (엄마/형/동생) ===");
    log.debug("My Peer ID:", myId);
    log.debug("Is Host?", !hostConn);
    log.debug("Upstream (Received from):", upstreamDataConn ? upstreamDataConn.peer.substr(-4) : "HOST Direct");
    log.debug("Downstream (Relaying to):", downstreamDataPeers.length, "peers");

    downstreamDataPeers.forEach(p => {
        const buf = p.dataChannel ? p.dataChannel.bufferedAmount : 0;
        const qLen = p._relayQueue ? p._relayQueue.length : 0;
        log.debug(`- Peer ...${p.peer.substr(-4)}: [Queue: ${qLen}, Buffer: ${(buf / 1024).toFixed(1)}KB, Open: ${p.open}]`);
    });

    log.debug("Global Relay Queue:", relayChunkQueue.length);
    log.debug("Transfer State:", transferState);
    log.debug("Received Count:", receivedCount, "/", (meta?.total || 0));
};

window.toggleRelayOverlay = function () {
    let overlay = document.getElementById('relay-debug-overlay');
    if (overlay) {
        overlay.remove();
        return;
    }

    overlay = document.createElement('div');
    overlay.id = 'relay-debug-overlay';
    overlay.style = `
        position: fixed; top: 10px; left: 10px; z-index: 9999;
        background: rgba(0,0,0,0.8); color: lime; font-family: monospace;
        padding: 10px; border-radius: 8px; font-size: 11px; pointer-events: none;
        box-shadow: 0 0 10px rgba(0,255,0,0.3); border: 1px solid #333;
    `;
    document.body.appendChild(overlay);

    const update = () => {
        if (!document.getElementById('relay-debug-overlay')) return;
        let html = `<div><b>[RELAY DEBUG]</b></div>`;
        html += `<div>Source: ${upstreamDataConn ? 'Relay' : 'Direct'}</div>`;
        html += `<div>Progress: ${receivedCount} / ${meta?.total || 0}</div>`;
        html += `<div>Queued: ${relayChunkQueue.length}</div>`;
        html += `<hr style="border:0; border-top:1px solid #444; margin:5px 0">`;
        downstreamDataPeers.forEach(p => {
            const buf = p.dataChannel ? p.dataChannel.bufferedAmount : 0;
            const qLen = p._relayQueue ? p._relayQueue.length : 0;
            html += `<div>...${p.peer.substr(-4)}: Q:${qLen} B:${(buf / 1024).toFixed(0)}K</div>`;
        });
        overlay.innerHTML = html;
        requestAnimationFrame(update);
    };
    update();
};

// ============================================================================
// [SECTION] WINDOW EXPORTS (Public API for HTML/UI)
// ============================================================================
window.openHelpModal = openHelpModal;
window.closeHelpModal = closeHelpModal;
window.toggleFullscreen = toggleFullscreen;
window.playPrevTrack = playPrevTrack;
window.togglePlay = togglePlay;
window.playNextTrack = playNextTrack;
window.toggleMute = toggleMute;
window.onVolInput = onVolInput;
window.onVolChange = onVolChange;
window.toggleChatDrawer = toggleChatDrawer;
window.handleManualSync = handleManualSync;
window.openMediaSourcePopup = openMediaSourcePopup;
window.toggleRepeat = toggleRepeat;
window.toggleShuffle = toggleShuffle;
window.copyLink = copyLink;
window.leaveSession = leaveSession;
window.joinSession = joinSession;
window.setTheme = setTheme;
window.toggleSurroundMode = toggleSurroundMode;
window.setChannel = setChannel;
window.setSurroundChannel = setSurroundChannel;
window.updateSettings = updateSettings;
window.resetReverb = resetReverb;
window.resetEQ = resetEQ;
window.setPreamp = setPreamp;
window.setEQ = setEQ;
window.resetStereo = resetStereo;
window.sendChatMessage = sendChatMessage;
window.switchTab = switchTab;
window.loadDemoMedia = loadDemoMedia;
window.nudgeSync = nudgeSync;
window.handleAutoSync = handleAutoSync;
window.closeManualSync = closeManualSync;
window.openFileSelector = openFileSelector;
window.openYouTubePopup = openYouTubePopup;
window.closeMediaSourcePopup = closeMediaSourcePopup;
window.closeYouTubePopup = closeYouTubePopup;
window.fetchYouTubePreview = fetchYouTubePreview;
window.loadYouTubeFromInput = loadYouTubeFromInput;
window.updateAudioEffect = updateAudioEffect;
window.toggleRelayOverlay = toggleRelayOverlay;
window.relayDebug = relayDebug;
window.parseMessageContent = parseMessageContent;
window.seekToTime = seekToTime;
window.loadYouTubeFromChat = loadYouTubeFromChat;
window.insertEmoji = insertEmoji;

// End of Script
