/**
 * ============================================================================
 * MUSIXQUARE - Multi-Device Synchronized Audio Player
 * ============================================================================
 * * 여러 스마트폰을 P2P로 연결하여 동기화된 서라운드 오디오 시스템을 구축하는 웹 앱
 * * [DEPENDENCIES]
 * - Tone.js (Audio Engine)
 * - PeerJS (WebRTC P2P)
 * - QRCode.js (QR Generation)
 * * [SECTION INDEX]
 * - 전역 변수 선언
 * - Worker & Timer
 * - Audio Engine (Tone.js)
 * - Onboarding & Session Actions
 * - Playlist & Track Management
 * - Playback Engine
 * - Audio Settings (EQ, Reverb, VB, Surround)
 * - Visualizer & UI Helpers
 * - Networking (PeerJS)
 * - Data Handlers (File Transfer, Sync)
 * - Relay & Broadcast
 * - UI Functions (Toast, Loader, Help)
 * - Chat System
 * - YouTube Integration
 * * ============================================================================
 * GLOBAL VARIABLES REFERENCE
 * ============================================================================
 * * [AUDIO ENGINE - Tone.js Nodes]
 * toneSplit       : Tone.Split - 스테레오 채널 분리
 * toneMerge       : Tone.Merge - 채널 병합
 * gainL, gainR    : Tone.Gain - L/R 채널 게인
 * masterGain      : Tone.Gain - 마스터 볼륨
 * reverb          : Tone.Reverb - 리버브 이펙트
 * eqNodes[]       : Tone.Filter[] - 5밴드 EQ
 * vbFilter/Cheby/Gain : Virtual Bass 체인
 * analyser        : Tone.Analyser - 비주얼라이저용
 * * [PLAYBACK STATE]
 * currentState    : string - APP_STATE 머신 상태
 * startedAt       : number - Tone.now() 기준 재생 시작 시간
 * pausedAt        : number - 일시정지 위치 (초)
 * * [PLAYLIST]
 * playlist[]      : Array - { type, file, name, videoId, playlistId, ... }
 * currentTrackIndex : number - 현재 재생 중인 트랙 인덱스
 * repeatMode      : 0=끔, 1=전체반복, 2=한곡반복
 * isShuffle       : boolean - 셔플 모드
 * * [NETWORK - PeerJS]
 * peer            : Peer - PeerJS 인스턴스
 * myId            : string - 내 Peer ID
 * hostConn        : DataConnection - Guest→Host 연결 (Guest만 사용)
 * connectedPeers[] : DataConnection[] - Host가 관리하는 Guest 연결 목록
 * isOperator      : boolean - Guest가 OP 권한 보유 여부
 * * [SYNC]
 * localOffset     : number - 수동 싱크 오프셋 (초)
 * autoSyncOffset  : number - 자동 레이턴시 보정 (초)
 * * [PRELOAD]
 * nextTrackIndex  : number - 프리로드된 다음 트랙 인덱스
 * nextFileBlob    : Blob - 프리로드된 파일 (Guest 전송용)
 * * [YOUTUBE]
 * youtubePlayer   : YT.Player - YouTube IFrame Player
 * youtubeSubItemsMap : object - 플레이리스트별 비디오 ID/제목 캐시
 * * ============================================================================
 */

// ============================================================================
// [SECTION] AUDIO ENGINE - Tone.js Nodes
// Dependencies: Tone.js CDN
// ============================================================================
let toneSplit, toneMerge;
let gainL, gainR, masterGain;
let reverb, rvbLowCut, rvbHighCut, rvbCrossFade, eqNodes = [];
let vbFilter, vbCheby, vbGain;
let preamp, widener;
let globalLowPass = null;
let analyser;

// ============================================================================
// [SECTION] APP STATE MACHINE (State Pattern)
// ============================================================================
const APP_STATE = {
    IDLE: 'IDLE',
    PLAYING_VIDEO: 'PLAYING_VIDEO',     // 비디오 및 스트리밍 모드 통합
    PLAYING_STREAMING: 'PLAYING_STREAMING', // 오디오 전용 스트리밍 (videoElement 사용하지만 화면 숨김)
    PLAYING_YOUTUBE: 'PLAYING_YOUTUBE'
};

let currentState = APP_STATE.IDLE;
let _isStateTransitioning = false; // Guard against recursive state changes

/**
 * 중앙화된 상태 전환 함수
 * @param {string} newState - APP_STATE 값
 * @param {object} options - { skipCleanup: boolean, onComplete: function }
 */
function setState(newState, options = {}) {
    const oldState = currentState;

    // 동일 상태 전환 무시
    if (oldState === newState) return;

    // 재귀 방지
    if (_isStateTransitioning) {
        console.warn(`[State] Recursive transition blocked: ${oldState} → ${newState}`);
        return;
    }

    _isStateTransitioning = true;
    console.log(`[State] ${oldState} → ${newState}`);

    // 이전 상태 정리 (선택적)
    if (!options.skipCleanup) {
        cleanupState(oldState);
    }

    // 새 상태 설정
    currentState = newState;

    // UI 모드 전환
    updateUIForState(newState);

    _isStateTransitioning = false;

    // 콜백 실행
    if (options.onComplete) {
        try { options.onComplete(); } catch (e) { console.error('[State] onComplete error:', e); }
    }
}

/**
 * 이전 상태에 따른 리소스 정리
 */
function cleanupState(oldState) {
    // [Fix] Capture current time before stopping the current engine to prevent drift
    if (oldState !== APP_STATE.IDLE) {
        pausedAt = getTrackPosition();
    }
    switch (oldState) {
        case APP_STATE.PLAYING_VIDEO:
        case APP_STATE.PLAYING_STREAMING:
            // Video Element 정지
            if (videoElement) {
                videoElement.pause();
            }
            // [Fix] Don't revoke URL here! It kills the visible source during sync/pause.
            // Revocation is moved to clearPreviousTrackState.
            break;

        case APP_STATE.PLAYING_YOUTUBE:
            // YouTube 정지
            if (typeof youtubePlayer !== 'undefined' && youtubePlayer && youtubePlayer.stopVideo) {
                try { youtubePlayer.stopVideo(); } catch (e) { }
            }
            // Ensure any active Blob URL is cleared when entering YouTube mode
            BlobURLManager.revoke();
            break;

        case APP_STATE.IDLE:
            BlobURLManager.revoke();
            break;
    }
}

/**
 * [NEW] 중앙화된 현재 트랙 재생 위치 계산 함수
 * startedAt, localOffset, autoSyncOffset을 모두 고려하여
 * 현재 트랙의 몇 초 지점인지를 반환합니다.
 * @param {boolean} useAudioClock - true면 비디오 요소 대신 Tone.js 클락(네트워크 기준)을 사용합니다.
 */
function getTrackPosition() {
    if (currentState === APP_STATE.IDLE) return pausedAt;

    // 스트리밍 모드: videoElement.currentTime 사용
    if (videoElement && videoElement.src && videoElement.readyState >= 1) {
        return videoElement.currentTime;
    }

    return (Tone.now() - startedAt) + localOffset + autoSyncOffset;
}

/**
 * 상태에 따른 UI 클래스 및 요소 업데이트
 */
function updateUIForState(newState) {
    // CSS 클래스 초기화
    document.body.classList.remove('mode-video', 'mode-youtube');

    // YouTube 컨테이너 숨김
    const ytContainer = document.getElementById('youtube-player-container');
    if (ytContainer) {
        ytContainer.style.opacity = '0';
        ytContainer.style.pointerEvents = 'none';
    }

    // Video Element 숨김 (기본)
    if (videoElement) videoElement.style.display = 'none';

    switch (newState) {
        case APP_STATE.PLAYING_VIDEO:
            document.body.classList.add('mode-video');
            if (videoElement) videoElement.style.display = 'block';
            break;

        case APP_STATE.PLAYING_STREAMING:
            // 스트리밍 오디오: videoElement 사용하지만 숨김 유지
            // (Visualizer가 보이도록)
            break;

        case APP_STATE.PLAYING_YOUTUBE:
            document.body.classList.add('mode-youtube');
            if (ytContainer) {
                ytContainer.style.opacity = '1';
                ytContainer.style.pointerEvents = 'auto';
            }
            break;

        case APP_STATE.PLAYING_AUDIO:
        case APP_STATE.IDLE:
        default:
            // 기본 상태: Visualizer 표시
            break;
    }
}

let startTime = 0;
let pausedAt = 0;
let startedAt = 0;

let animationId;
let isSeeking = false;

// ✅ 새로 추가: 타이머 중앙 관리 객체
const managedTimers = {
    chunkWatchdog: null,
    prepareWatchdog: null,
    autoPlayTimer: null,
    syncDebounce: null,
    relayWaitTimeout: null,
    preloadWatchdog: null
};

// ✅ 새로 추가: 타이머 정리 헬퍼 함수
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
let isSurroundMode = false; // New 7.1 Mode
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
let currentMediaObjectURL = null;

const BlobURLManager = {
    _activeURL: null,
    _preparingURL: null,
    _pendingRevocations: new Map(), // URL -> Blob reference for GC protection

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
        console.log(`[BlobURL] Prepared: ${this._preparingURL}`);
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
            this.safeRevoke(this._activeURL, currentFileBlob);
        }

        this._activeURL = this._preparingURL;
        this._preparingURL = null;
        console.log(`[BlobURL] Confirmed Active: ${this._activeURL}`);
    },

    /**
     * Schedule a specific URL for revocation after a safety delay.
     * Holds a reference to the blob to prevent GC during the delay.
     */
    safeRevoke: function (url, blob) {
        if (!url || this._pendingRevocations.has(url)) return;

        this._pendingRevocations.set(url, blob);
        console.log(`[BlobURL] Scheduled for revocation (10s): ${url}`);

        setTimeout(() => {
            try {
                URL.revokeObjectURL(url);
                this._pendingRevocations.delete(url);
                if (this._activeURL === url) this._activeURL = null;
                console.log(`[BlobURL] Successfully revoked: ${url}`);
            } catch (e) {
                console.warn(`[BlobURL] Revocation failed:`, e);
            }
        }, 10000);
    },

    /**
     * Revoke the current active URL.
     * Called by cleanupState() when stopping/resetting.
     */
    revoke: function () {
        if (this._activeURL) {
            this.safeRevoke(this._activeURL, currentFileBlob);
        }
    }
};

// ============================================================================
// [SECTION] NETWORK STATE - PeerJS
// Dependencies: PeerJS CDN
// ============================================================================
let myId = null, peer = null, hostConn = null;
window.hostConn = null; // Expose to other scripts (demo.js)
let localOffset = 0;
let autoSyncOffset = 0; // NEW: Store the Auto-Sync (Latency) Offset in Seconds
let usePingCompensation = true; // Default: apply RTT/2 compensation (set false for local network)
let myDeviceLabel = 'GUEST'; // Store my label for UI updates
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

// ============================================================================
// [SECTION] FILE TRANSFER STATE
// ============================================================================
let lastChunkTime = 0;
const TRANSFER_STATE = {
    IDLE: 'IDLE',
    RECEIVING: 'RECEIVING',
    PROCESSING: 'PROCESSING', // Blob 생성 중
    READY: 'READY'
};
let transferState = TRANSFER_STATE.IDLE;
let incomingChunks = [];
let receivedCount = 0;
let meta = {};
let lastProgressAck = 0;
let _isProcessingBlob = false;

// OPFS State
let currentFileOpfs = { handle: null, writable: null, name: null };
let preloadFileOpfs = { handle: null, writable: null, name: null };

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

// Start network initialization early to fetch TURN config in parallel with script parsing
initNetwork();

// Guest Side
let preloadCount = 0;
let preloadMeta = null;
let localTransferSessionId = 0; // [NEW] Track active transfer session on Guest side
// ✅ 추가: 세션 기반 상태 관리
const preloadSessionState = new Map(); // sessionId -> { skipped, progress, total }

// OPFS Helper coordination (now handled by worker)
function cleanupOPFSInWorker(filename, isPreload) {
    if (!filename) return;
    timerWorker.postMessage({ command: 'OPFS_CLEANUP', filename, isPreload });
}

// Helper: Clear metadata for upcoming preload (Host side) or current preload (Guest side)
function clearPreloadState() {
    // Host side
    nextTrackIndex = -1;
    nextFileBlob = null;
    nextMeta = null;
    isPreloading = false;

    // Guest side
    preloadCount = 0;
    preloadMeta = null;
    window._skipIncomingPreload = false;

    // We do NOT call cleanupOPFSInWorker here anymore because it was deleting files
    // that were about to be played.
}

// 명시적인 OPFS 물리 파일 삭제 (정말 필요할 때만 호출)
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


// --- Worker for Background Timers (Blob URL for file:// support) ---
// --- Worker for Background Timers and High-Performance OPFS Writes ---
const timerWorker = new Worker('js/worker.js');

timerWorker.onerror = (e) => {
    console.error("Worker Error: ", e.message);
    showToast("워커 로드 실패! HTTPS 환경인지 확인하세요.");
};

timerWorker.onmessage = async (e) => {
    try {
        const data = e.data;
        if (data.type === 'TICK') {
            const id = data.id;
            if (id === 'heartbeat') {
                if (hostConn && hostConn.open) hostConn.send({ type: 'heartbeat' });
            } else if (id === 'ping') {
                if (hostConn && hostConn.open) hostConn.send({ type: 'ping-latency', timestamp: Date.now() });
            } else if (id === 'video-sync') {
                checkVideoSync();
            }
        }
        else if (data.type === 'OPFS_FILE_READY') {
            console.log(`[Main] File ready in OPFS: ${data.filename} (${data.isPreload ? 'preload' : 'current'})`);

            // Re-retrieve file handle in main thread to get the File object
            // (Handles are serialized shared state in some browsers, 
            // but getting a fresh one from root is always safe)
            const root = await navigator.storage.getDirectory();
            const safeName = (data.isPreload ? "preload_" : "current_") + data.filename.replace(/[^a-z0-9._-]/gi, '_');
            const fileHandle = await root.getFileHandle(safeName);
            const file = await fileHandle.getFile();

            if (data.isPreload) {
                nextFileBlob = file;
                nextMeta = preloadMeta;
                nextTrackIndex = preloadMeta.index;

                if (hostConn && hostConn.open) {
                    hostConn.send({ type: 'preload-ack', index: nextTrackIndex });
                }

                if (window._waitingForPreload && window._pendingFileIndex === nextTrackIndex) {
                    console.log("[Worker-OPFS] Guest was waiting for this track. Playing now.");
                    window._waitingForPreload = false;
                    showLoader(false);
                    loadPreloadedTrack();
                }
            } else {
                // Check session ID if available (data.sessionId)
                currentFileBlob = file;
                window._waitingForRelayData = false;
                finalizeFileProcessing(file);
            }
        }
        else if (data.type === 'OPFS_ERROR') {
            console.error(`[Worker-OPFS] Error for ${data.filename}:`, data.error);
            showToast(`파일 저장 오류: ${data.filename}`);
        }
    } catch (err) {
        console.error('[Worker Message] Processing error:', err);
        showToast('워커 메시지 처리 중 오류');
    }
};

// ✅ 추가: 에러 핸들러
timerWorker.onerror = (err) => {
    console.error('[Worker Error]', err.message, err.filename, err.lineno);
    showToast('백그라운드 작업 오류 발생');
};

function finalizeFileProcessing(file) {
    // This is called when OPFS_FILE_READY comes back from worker.
    // transferState was set to PROCESSING by handleFileChunk to prevent concurrent finishers.

    const isVideoBlob = file.type.startsWith('video/') || (meta && meta.name && /\.(mp4|mkv|webm|mov)$/i.test(meta.name));
    const shouldBeVideoMode = isVideoBlob;

    console.log(`[Main] Finalizing processing from Worker-OPFS. VideoMode: ${shouldBeVideoMode}`);

    setEngineMode(shouldBeVideoMode ? 'video' : 'streaming');

    const url = BlobURLManager.create(file);
    videoElement.src = url;

    // [New] Set currentFileBlob on Guest as well so hasBlob checks work in sync logic
    currentFileBlob = file;

    videoElement.onloadedmetadata = () => {
        document.getElementById('seek-slider').max = videoElement.duration;
        document.getElementById('seek-slider').value = 0;
        document.getElementById('time-dur').innerText = fmtTime(videoElement.duration);
        BlobURLManager.confirm(file);
    };
    videoElement.load();
    setupMediaSource();

    document.getElementById('play-btn').disabled = !isOperator;
    if (Tone.context.state === 'suspended') Tone.context.resume();

    showLoader(false);
    clearManagedTimer('chunkWatchdog');
    pausedAt = 0;
    updatePlayState(false);
    showToast("재생 준비 완료");

    setTimeout(() => {
        if (hostConn && hostConn.open) {
            hostConn.send({ type: 'get-sync-time' });
        } else {
            syncReset();
        }
    }, 1000);

    if (window._pendingPlayTime !== undefined) {
        const target = window._pendingPlayTime + localOffset;
        play(target);
        window._pendingPlayTime = undefined;
    }

    receivedCount = 0;
    transferState = TRANSFER_STATE.READY;
}

// function checkVideoSync() { ... } [REMOVED POLLING]


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
    if (tabId === 'play' && currentState === APP_STATE.PLAYING_YOUTUBE) {
        // Use timeout to ensure tab transition is complete
        setTimeout(() => refreshYouTubeDisplay(), 50);
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
    // Audio is piped via setupMediaSource() using videoElement
    widener = new Tone.StereoWidener(1);
    preamp = new Tone.Gain(1);

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

// --- Gesture Unlock ---
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
            console.log('Screen Wake Lock active');
            wakeLock.addEventListener('release', () => {
                console.log('Screen Wake Lock released');
            });
        }
    } catch (err) {
        console.warn(`${err.name}, ${err.message}`);
    }
}

// Re-request wake lock when visibility changes
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
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
        silentAudio.play().catch(e => console.log("Silent Audio play failed", e));
    }

    if (videoElement) {
        // [iOS Protection] Briefly play and pause video to unlock programmatic control later
        videoElement.play().then(() => {
            videoElement.pause();
        }).catch(e => console.log("Video unlock failed", e));
    }



    // 5. Wake Lock
    requestWakeLock();
}

window.actionCreateRoom = async function () {
    await activateAudio();
    // Using setTimeout to allow UI update if needed, but alert blocks anyway.
    setTimeout(() => {
        alert("이제 당신이 호스트입니다.\n다른 사람을 초대하거나 다른 기기를 추가하려면\n'Connect' 탭의 QR코드 또는 링크를 공유하세요.");
        document.getElementById('onboarding-overlay').style.display = 'none';
        switchTab('connect');
    }, 50);
};

window.actionJoinRoom = async function () {
    await activateAudio();
    setTimeout(() => {
        alert("호스트가 제공한 QR코드나 링크를 통해 접속하세요.\n'Connect' 탭에서 링크(ID)를 수동으로 입력하여 접속하실 수도 있습니다.");
        document.getElementById('onboarding-overlay').style.display = 'none';
        switchTab('connect');
    }, 50);
};

window.actionEnterSession = async function () {
    await activateAudio();
    document.getElementById('onboarding-overlay').style.display = 'none';
    joinSession(); // This handles the connection and logic
    switchTab('play'); // Guest goes to visualizer
};

// Wrapper function to check guest before triggering file input
function openFileSelector() {
    if (hostConn) {
        showToast("Host만 실행할 수 있습니다.");
        return;
    }
    document.getElementById('file-input').click();
}

// Auto-run init
document.addEventListener('DOMContentLoaded', initOnboarding);

// --- Playlist & Player Logic ---
document.getElementById('file-input').addEventListener('change', async (e) => {
    // File upload is Host-only (OP cannot relay file data to other guests)
    if (hostConn) return showToast("Host만 파일을 추가할 수 있습니다.");

    // Initialize AudioContext immediately on user gesture
    try {
        if (Tone.context.state !== 'running') await Tone.start();
        await initAudio();
    } catch (err) { console.error(err); }

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
    broadcast({ type: 'playlist-update', list: metaList });

    // [Optimization] Clear all cache metadata on Host side when playlist structure changes
    connectedPeers.forEach(p => { if (p.preloadedIndexes) p.preloadedIndexes.clear(); });
    console.log("[Host] Playlist changed, cleared all peer cache tracking");

    if (currentTrackIndex === -1) {
        playTrack(0);
    } else {
        showToast(`${files.length}곡 추가됨`);

        // Re-evaluate preload when new songs are added
        // Case 1: No preload queued yet -> trigger
        // Case 2: Current preload target is outdated (was looping to 0, but now there are new songs) -> re-trigger
        const wasLastTrack = (currentTrackIndex === playlist.length - files.length - 1);
        const shouldRePreload = !isPreloading && (nextTrackIndex === -1 || wasLastTrack);

        if (shouldRePreload) {
            // Clear previous preload state if any
            if (nextTrackIndex !== -1) {
                console.log("[Preload] New songs added, re-evaluating next track...");
                clearPreloadState();
            }
            preloadNextTrack();
        }
    }
    // Reset inputs
    e.target.value = '';
});

function toggleRepeat() {
    repeatMode = (repeatMode + 1) % 3;
    const btn = document.getElementById('btn-repeat');
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
    isShuffle = !isShuffle;
    document.getElementById('btn-shuffle').classList.toggle('active', isShuffle);
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
            else if (isOperator) hostConn.send({ type: 'request-track-change', index: idx });
        };

        li.innerHTML = `
            <div class="track-idx">${idx + 1}</div>
            <div class="track-name">${icon} ${displayName}</div>
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
                        <span class="sub-name">${sTitle}</span>
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
                            hostConn.send({ type: 'request-youtube-sub-seek', playlistIdx: idx, subIdx: sIdx });
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
}

// --- Media Session API (System Controls) ---
function initMediaSession() {
    if (!('mediaSession' in navigator)) return;

    console.log("[MediaSession] Initializing action handlers...");

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
    } catch (e) { }
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
        artwork = [{ src: 'HFNY4ren.svg', sizes: '512x512', type: 'image/svg+xml' }];
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
                } catch (e) { }
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
                    hostConn.send({ type: 'request-youtube-playlist-info', playlistId: pid });
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

    console.log(`[YouTube Feed] Starting title fetch for playlist: ${playlistId} (${ids.length} items)`);

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
                console.log(`[YouTube Feed] Fetched Title [${i}]: ${json.title}`);

                // Update UI
                updatePlaylistUI();

                // Only Host broadcasts to others to keep it centralized
                if (!hostConn) {
                    broadcast({
                        type: 'youtube-sub-title-update',
                        playlistId: playlistId,
                        subIdx: i,
                        title: json.title
                    });
                }
            }
        } catch (e) {
            console.warn(`[YouTube Feed] Failed to fetch title for ${ids[i]}:`, e);
        }

        // 200ms delay between requests
        await new Promise(r => setTimeout(r, 200));
    }
    data._isFetching = false;
}



async function playTrack(index) {
    if (index < 0 || index >= playlist.length) return;

    // FIX: Clear existing autoplay timer to prevent audio overlap
    clearManagedTimer('autoPlayTimer');

    // Auto-switch to Play tab when starting a track (Host only)
    if (!hostConn) switchTab('play');

    // Check if this track is already preloaded (Host Side Check)
    if (index === nextTrackIndex && nextFileBlob && !hostConn) {
        console.log("[Host] Using Preloaded Track:", index);
        currentTrackIndex = index;
        updatePlaylistUI();

        // 1. Host Switches Locally Fast
        await loadPreloadedTrack();

        // 2. Get track info for Guest fallback
        const item = playlist[index];
        const fileName = item?.file?.name || item?.name || `Track ${index}`;

        // 3. Broadcast ONLY play-preloaded command
        broadcast({ type: 'play-preloaded', index: index, name: fileName });

        // 4. Start Playback immediately after loading
        await loadPreloadedTrack();
        play(0);

        // Schedule Auto-Sync (5s later)
        setTimeout(() => {
            handleMainSyncBtn();
        }, 5000);

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
                type: 'youtube-play',
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
        // Standard Load
        broadcast({ type: 'file-prepare', name: file.name, index: index });
        await loadAndBroadcastFile(file);

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
                broadcast({ type: 'play', time: 0 });
            }, 3000);
        }
    }
}

async function preloadNextTrack() {
    if (playlist.length <= 1) return;

    // Cancel previous preload if running
    if (isPreloading) {
        console.log("[Preload] Cancelling previous preload session");
    }
    preloadSessionId++;  // Invalidate previous session
    const currentSession = preloadSessionId;

    // Determine Next Index logic (copy of playNextTrack logic)
    let nextIdx;
    if (repeatMode === 2) nextIdx = currentTrackIndex; // Repeat One
    else if (isShuffle) {
        // Simple shuffle: valid random
        do {
            nextIdx = Math.floor(Math.random() * playlist.length);
        } while (nextIdx === currentTrackIndex && playlist.length > 1);
    } else {
        nextIdx = currentTrackIndex + 1;
        if (nextIdx >= playlist.length) nextIdx = 0; // Loop list
    }

    // Update State
    nextTrackIndex = nextIdx;
    const item = playlist[nextIdx];

    // Skip preload for YouTube items
    if (item.type === 'youtube') {
        console.log("[Preload] Next is YouTube, skipping preload");
        isPreloading = false;
        return;
    }

    const file = item.file;
    console.log("[Preload] Starting for:", file.name, "session:", currentSession);
    isPreloading = true;

    // 1. Host Loads Locally (Background)
    // Strategy: Decode small audio immediately, keep large files/video as Blob to save RAM.

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
    // 비디오든 오디오든 추출 과정 없이 원본 파일 그대로 전송 (메모리 안전)
    console.log("[Preload] Broadcasting original file:", file.name);
    await backgroundTransfer(file, index, sessionId);
}

// Transfer without UI blocking
async function backgroundTransfer(file, index, sessionId) {
    const CHUNK = 16384;
    const total = Math.ceil(file.size / CHUNK);
    const header = {
        type: 'preload-start',
        name: file.name,
        mime: file.type,
        total: total,
        size: file.size,
        index: index,
        sessionId: sessionId // [Optimization] Included for tracking/cancellation
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
        console.log("[Preload] No active data targets, skipping transfer");
        return;
    }

    // Determine which targets actually need the data chunks
    const targetsWhoNeedChunks = targets.filter(p => !p.preloadedIndexes || !p.preloadedIndexes.has(index));

    // [Optimization] Send header UNICAST so we can tell each peer if we are skipping chunks
    targets.forEach(p => {
        const peerNeedsChunks = !p.preloadedIndexes || !p.preloadedIndexes.has(index);
        if (p.conn.open) {
            // [Fix] Peer-specific header
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
            console.log("[Preload] Session cancelled, stopping transfer at chunk", i);
            return;
        }

        // Flow Control: check primary targets only (they handle downstream)
        let congested = true;
        while (congested) {
            congested = false;
            for (const p of targets) {
                if (p.conn.open && p.conn.dataChannel && p.conn.dataChannel.bufferedAmount > 1 * 1024 * 1024) {
                    congested = true;
                    break;
                }
            }
            if (congested) await new Promise(r => setTimeout(r, 100));
        }

        const start = i * CHUNK;
        const end = Math.min(start + CHUNK, file.size);
        const chunkBlob = file.slice(start, end);
        const chunkBuf = await chunkBlob.arrayBuffer();
        const chunk = new Uint8Array(chunkBuf);

        const chunkMsg = { type: 'preload-chunk', chunk: chunk, index: i };
        sendToTargets(chunkMsg, true); // true = send only to those who need chunks

        // Slow down sending to save CPU/Network for playback
        if (i % 10 === 0) await new Promise(r => setTimeout(r, 20));
    }

    // Final session check before completing
    if (preloadSessionId === sessionId) {
        sendToTargets({ type: 'preload-end', name: file.name, index: index, sessionId: sessionId });
        console.log("[Preload] Complete for index:", index);
    }
}


function playNextTrack() {
    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return showToast("Host만 실행할 수 있습니다.");

    // OP: request Host to change track
    if (hostConn && isOperator) {
        hostConn.send({ type: 'request-next-track' });
        return;
    }

    // Host: execute directly

    // YouTube Playlist Internal Navigation
    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer && youtubePlayer.getPlaylist) {
        try {
            const playlistIds = youtubePlayer.getPlaylist() || [];
            const currentIndex = youtubePlayer.getPlaylistIndex();

            if (playlistIds.length > 0 && currentIndex < playlistIds.length - 1) {
                console.log("[YouTube] Next internal video:", currentIndex + 1);
                youtubePlayer.nextVideo();
                return; // Stay on the same MUSIXQUARE track
            }
        } catch (e) {
            console.warn("[YouTube] Internal next failed:", e);
        }
    }

    // If we have a preloaded track ready with actual data, use it
    if (nextTrackIndex !== -1 && nextFileBlob) {
        playTrack(nextTrackIndex);
        return;
    }

    let nextIndex;
    if (playlist.length === 0) return;

    if (repeatMode === 2) {
        nextIndex = currentTrackIndex;
    } else if (isShuffle && playlist.length > 1) {
        // [FIX] Prevent infinite loop and immediate repeats in Shuffle
        do {
            nextIndex = Math.floor(Math.random() * playlist.length);
        } while (nextIndex === currentTrackIndex);
    } else if (isShuffle && playlist.length === 1) {
        nextIndex = 0;
    } else {
        nextIndex = currentTrackIndex + 1;
        if (nextIndex >= playlist.length) {
            if (repeatMode === 1) nextIndex = 0;
            else return; // Stop at end
        }
    }
    playTrack(nextIndex);
}

function playPrevTrack() {
    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return showToast("Host만 실행할 수 있습니다.");

    // OP: request Host to change track
    if (hostConn && isOperator) {
        hostConn.send({ type: 'request-prev-track' });
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
                broadcast({ type: 'youtube-state', state: youtubePlayer.getPlayerState ? youtubePlayer.getPlayerState() : 1, time: 0 });
                return;
            }

            // Internal YouTube Playlist Navigation
            if (playlistIds && playlistIds.length > 0 && subIndex > 0) {
                console.log("[YouTube] Prev internal video:", subIndex - 1);
                youtubePlayer.previousVideo();
                return;
            }
        } catch (e) {
            console.error("[YouTube] Prev track error:", e);
        }
        // If < 3 seconds or at start of sub-playlist, go to previous track in MUSIXQUARE playlist
        if (currentTrackIndex > 0) playTrack(currentTrackIndex - 1);
        else playTrack(0);
        return;
    }

    // Local mode
    if (Tone.context && Tone.now() - startedAt > 3) {
        play(0); // Restart current
        broadcast({ type: 'play', time: 0 });
        return;
    }
    if (currentTrackIndex > 0) playTrack(currentTrackIndex - 1);
    else playTrack(0);
}



async function loadAndBroadcastFile(file) {
    showLoader(true, `준비 중: ${file.name} `);
    stop();

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

        // Always Streaming Mode
        console.log("Streaming Mode (MediaElementSource) enabled.");

        setEngineMode(isVideo ? 'video' : 'streaming');
        updateTitleWithMarquee(file.name);
        document.getElementById('track-artist').innerText = `Track ${currentTrackIndex + 1}`;
        videoElement.src = url;

        videoElement.onloadedmetadata = () => {
            const dur = videoElement.duration;
            if (dur && isFinite(dur)) {
                document.getElementById('time-dur').innerText = fmtTime(dur);
                const sSlider = document.getElementById('seek-slider');
                sSlider.max = dur;
                sSlider.value = 0;
            }
            BlobURLManager.confirm(file);
        };

        videoElement.load();
        setupMediaSource();

        const isGuest = !!hostConn;
        document.getElementById('play-btn').disabled = isGuest && !isOperator;

        if (connectedPeers.length > 0) {
            // Always send original file directly to skip memory-heavy extraction
            showToast("파일 전송 중...");
            await broadcastFile(file);
        }

        if (!hostConn) {
            preloadNextTrack();
        }

    } catch (err) {
        console.error(err);
        showToast(`Load Failed: ${err.message} `);
    } finally {
        showLoader(false);
        pausedAt = 0;
        updatePlayState(false);
    }
}

// --- Playback Engine (Tone.js) ---
let mediaSourceNode = null;

function setupMediaSource() {
    if (!videoElement) return;

    // 1. DISCONNECT PREVIOUS (Avoid overlap and effects leak)
    if (mediaSourceNode) {
        try { mediaSourceNode.disconnect(); } catch (e) { }
    }

    // Ensure Context
    if (Tone.context.state !== 'running') Tone.context.resume();

    // Create Source ONLY ONCE per element to avoid errors
    if (!mediaSourceNode) {
        // Use rawContext for native MediaElementSource
        mediaSourceNode = Tone.context.rawContext.createMediaElementSource(videoElement);
    } else {
        // [FIX] If mediaSourceNode exists but with a different element (unlikely but safe)
        // or just ensure we don't recreate it on the same element which triggers browser errors.
        console.log("[Audio] Reusing existing MediaElementSourceNode");
    }

    if (!mediaDownmixNode) {
        mediaDownmixNode = new Tone.Gain(1);
        // FORCE DOWNMIX (Standard Mode): 5.1/7.1 -> Stereo
        mediaDownmixNode.channelCount = 2;
        mediaDownmixNode.channelInterpretation = 'speakers';
    }

    if (!surroundSplitter) {
        // 8 Channel Splitter for 7.1
        surroundSplitter = new Tone.Split(8);
    }

    if (!surroundGain) {
        surroundGain = new Tone.Gain(1); // Mono feeder
    }

    // Connect logic
    try {
        // Disconnect branches from their internal targets before re-routing
        try { mediaDownmixNode.disconnect(); } catch (e) { }
        try { surroundSplitter.disconnect(); } catch (e) { }
        try { surroundGain.disconnect(); } catch (e) { }

        // Branch 1: Standard Stereo Path (Downmix -> Widener)
        // If Surround Mode is OFF, we use this.
        // If Surround Mode is ON, we use Branch 2.

        // Connect MediaSource to both Downmixer (Stereo) and Splitter (Surround) paths.

        if (isSurroundMode) {
            // Surround Path: Source -> Splitter -> (Select 1) -> SurroundGain -> Preamp
            Tone.connect(mediaSourceNode, surroundSplitter);

            // Connector from Splitter to SurroundGain is managed by setSurroundChannel()
            // But we need to ensure SurroundGain connects to graph
            surroundGain.connect(preamp);

            // Restore Channel Selection (Routing: Splitter -> Gain)
            // We pass true to skip calling setupMediaSource again (recursion)
            if (surroundChannelIndex !== -1) {
                setSurroundChannel(surroundChannelIndex, null, true);
            }
        } else {
            // Standard Path: Source -> Downmix -> Widener -> Preamp
            Tone.connect(mediaSourceNode, mediaDownmixNode);
            mediaDownmixNode.connect(widener);

            // Safety Re-connect Chain
            try {
                widener.disconnect();
                widener.connect(preamp);

                preamp.disconnect();
                preamp.connect(toneSplit);
                // Preamp also feeds vbFilter (Virtual Bass)
                preamp.connect(vbFilter);
            } catch (e) { console.warn("Chain reconnect warn", e); }
        }

        videoElement.muted = false;

    } catch (e) {
        console.warn("MediaSource Setup Error:", e);
    }
}

async function play(offset) {
    window._pendingPlayTime = undefined;

    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
        console.warn("[Audio] Blocked play() call while in YouTube mode");
        return;
    }

    if (Tone.context.state !== 'running') {
        try { await Tone.context.resume(); } catch (e) { console.warn("Resume failed:", e); }
    }

    const hasVideoSource = videoElement && videoElement.src && videoElement.src.startsWith('blob:');

    if (!hasVideoSource) {
        console.warn("[Play] No media source available");
        return;
    }

    initAudio();

    // --- STREAMING MODE (Video or Large WAV) ---
    setupMediaSource();

    videoElement.currentTime = offset;

    const onSeeked = () => {
        videoElement.removeEventListener('seeked', onSeeked);
        videoElement.play().catch(e => console.log('[Video] play failed', e));
        updatePlayState(true);
    };

    if (videoElement.seeking) {
        videoElement.addEventListener('seeked', onSeeked);
    } else {
        videoElement.play().catch(e => console.log('[Video] play failed', e));
        updatePlayState(true);
    }

    if (currentState !== APP_STATE.PLAYING_VIDEO) {
        // [New] If current source is video, try to stay in PLAYING_VIDEO mode
        const isVideo = currentFileBlob && (currentFileBlob.type.startsWith('video/') || (meta && meta.name && /\.(mp4|mkv|webm|mov)$/i.test(meta.name)));
        setState(isVideo ? APP_STATE.PLAYING_VIDEO : APP_STATE.PLAYING_STREAMING, { skipCleanup: true });
    }

    startedAt = Tone.now() - offset + (localOffset + autoSyncOffset);
    pausedAt = offset;

    startVisualizer();
    // timerWorker.postMessage({ command: 'START_TIMER', id: 'video-sync', interval: 50 }); [REMOVED POLLING]
    loopUI();
}

function handleEnded() {
    // [SAFARI FIX] Video duration can be transiently small/wrong during load.
    // Guests should only trigger 'ended' if they are NOT loading and the Host isn't forcing playback.
    if (hostConn && currentState !== APP_STATE.IDLE) {
        // If Host says we are 3 mins in, but local says 0.39s, ignore local "end"
        return;
    }

    // Safety: Verify video readyState before trusting duration (VIDEO and STREAMING modes)
    const usesVideoElement = currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_STREAMING;
    if (usesVideoElement && videoElement && videoElement.readyState < 1) {
        return; // Metadata not yet reliable
    }

    const duration = videoElement ? videoElement.duration : 0;

    // Safety: Skip if duration is invalid or suspiciously short during load
    if (!duration || !isFinite(duration) || duration <= 0.5) {
        return;
    }

    // [FIX] Use unified Track Position calculation
    const curr = getTrackPosition();

    const isPastEnd = (curr >= duration - 0.2);

    if (currentState !== APP_STATE.IDLE && isPastEnd) {
        console.log(`Track ended at ${curr.toFixed(2)} s / ${duration.toFixed(2)} s`);

        // [FIX] Use centralized stopAllMedia() which sets state to IDLE
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
                console.log("Repeat One: Replaying current track...");
                // Reset sync state for clean restart
                setTimeout(() => playTrack(currentTrackIndex), 300);
            } else {
                console.log("Auto-advancing to next track...");
                setTimeout(() => playNextTrack(), 500);
            }
        }
    }
}

/**
 * Stop EVERYTHING. Tone.js, Video, and YouTube.
 * Ensures no audio overlap during transitions.
 */
function stopAllMedia() {
    // 1. Stop Global Video
    if (videoElement) {
        videoElement.pause();
        videoElement.currentTime = 0;
    }

    // 2. Stop YouTube
    if (youtubePlayer && youtubePlayer.stopVideo) {
        try { youtubePlayer.stopVideo(); } catch (e) { }
    }

    // Clear any pending triggers
    window._pendingPlayTime = undefined;
    if (managedTimers.autoPlayTimer) {
        clearManagedTimer('autoPlayTimer');
    }

    setState(APP_STATE.IDLE, { skipCleanup: true });
    updatePlayState(false);

    // Stop all background sync timers
    timerWorker.postMessage({ command: 'STOP_TIMER', id: 'video-sync' });
    timerWorker.postMessage({ command: 'STOP_TIMER', id: 'youtube-sync' });
}

/**
 * Handle UI and state transitions between Audio, Video, Streaming, and YouTube modes.
 * @param {string} mode - 'audio' | 'video' | 'streaming' | 'youtube'
 */
function setEngineMode(mode) {
    console.log(`[Engine] Switching mode to: ${mode}`);

    // Map mode string to APP_STATE
    let newState;
    switch (mode) {
        case 'video':
            newState = APP_STATE.PLAYING_VIDEO;
            break;
        case 'streaming':
            newState = APP_STATE.PLAYING_STREAMING;
            break;
        case 'youtube':
            newState = APP_STATE.PLAYING_YOUTUBE;
            break;
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

function stop() {
    stopAllMedia();
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
                    hostConn.send({ type: 'request-youtube-pause' });
                } else {
                    hostConn.send({ type: 'request-youtube-play' });
                }
            } catch (e) {
                console.error("[YouTube] OP toggle error:", e);
            }
            return;
        }

        // Host: execute directly
        try {
            const state = youtubePlayer.getPlayerState();
            if (state === YT.PlayerState.PLAYING) {
                youtubePlayer.pauseVideo();
                broadcast({ type: 'youtube-state', state: 2, time: youtubePlayer.getCurrentTime() });
            } else {
                youtubePlayer.playVideo();
                broadcast({ type: 'youtube-state', state: 1, time: youtubePlayer.getCurrentTime() });
            }
        } catch (e) {
            console.error("[YouTube] Toggle play error:", e);
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
        if (!hostConn) { pause(); broadcast({ type: 'pause' }); }
        else if (isOperator) hostConn.send({ type: 'request-pause' });
    } else {
        if (!hostConn) { play(pausedAt); broadcast({ type: 'play', time: pausedAt }); }
        else if (isOperator) hostConn.send({ type: 'request-play', time: pausedAt });
    }
}

function pause() {
    if (currentState !== APP_STATE.IDLE) {
        if (videoElement) videoElement.pause();
        pausedAt = getTrackPosition();
        if (videoElement) videoElement.currentTime = pausedAt;
    }
    updatePlayState(false);
    showToast("일시정지");
    timerWorker.postMessage({ command: 'STOP_TIMER', id: 'video-sync' });
}

function skipTime(sec) {
    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return showToast("Host만 실행할 수 있습니다.");

    // OP: request Host to skip time
    if (hostConn && isOperator) {
        hostConn.send({ type: 'request-skip-time', sec: sec });
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
            broadcast({ type: 'youtube-state', state: youtubePlayer.getPlayerState(), time: target });
        } catch (e) {
            console.error("[YouTube] Skip time error:", e);
        }
        return;
    }

    // Local mode
    let current = (currentState !== APP_STATE.IDLE) ? (Tone.now() - startedAt) : pausedAt;
    if ((currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_STREAMING)) current = videoElement.currentTime;

    let target = current + sec;
    const duration = videoElement ? videoElement.duration : 0;

    if (target < 0) target = 0;
    if (target > duration) target = duration;

    // Broadcast
    play(target);
    broadcast({ type: 'play', time: target });
}

function updatePlayState(playing) {
    document.getElementById('icon-play').style.display = playing ? 'none' : 'block';
    document.getElementById('icon-pause').style.display = playing ? 'block' : 'none';
}

function adjustSync(val) {
    localOffset += val;
    showToast(`Sync: ${val > 0 ? '+' : ''}${val.toFixed(2)} s`);
    // Use Tone.now()
    if (currentState !== APP_STATE.IDLE) play((Tone.now() - startedAt) + val);
    else pausedAt += val;
}

// --- Audio Graph Settings ---
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
    } catch (e) { }

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
        if (!surroundSplitter) setupMediaSource();

        // Streaming/No Buffer defaults to Center
        if (surroundChannelIndex === -1) setSurroundChannel(2, null);
        else setSurroundChannel(surroundChannelIndex, null);

        showToast("Surround Mode: Enabled");
    }

    // Streaming Mode: Restore MediaSource
    setupMediaSource();
    setChannelMode(channelMode); // Restore standard channel
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

    // 2. Re-connect MediaSource if needed (to Splitter)
    if (!skipSetup) setupMediaSource();

    // 3. Connect selected Splitter Output to SurroundGain
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

        // 4. Force Output to Dual Mono (L+R)
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
        console.warn(e);
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

function onReverbInput(val) { setReverb(val); }
function onReverbChange(val) {
    if (!hostConn) broadcast({ type: 'reverb', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'reverb', value: val });
}

function setReverb(val) {
    reverbMix = val / 100;
    document.getElementById('val-reverb').innerText = val + '%';
    document.getElementById('reverb-slider').value = val;
    applySettings();
}

function resetReverbMix() {
    setReverb(0);
    onReverbChange(0);
}

function setReverbType(type) {
    if (!reverb) return;
    reverbType = type;
    document.querySelectorAll('.rvb-chip').forEach(el => el.classList.remove('active'));
    document.getElementById(`rvb - ${type}`).classList.add('active');

    // Preset Decay Times
    let decay = 1.5;
    if (type === 'room') decay = 1.5;
    else if (type === 'hall') decay = 3.0; // Standard Hall
    else if (type === 'church') decay = 6.0; // Long
    else if (type === 'plate') decay = 2.5; // Bright/Medium

    // Update Audio & Slider UI
    setReverbDecay(decay);

    if (!hostConn) broadcast({ type: 'reverb-type', value: type });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'reverb-type', value: type });
}

function onReverbDecayInput(val) {
    document.getElementById('val-rvb-decay').innerText = val + 's';
}
function onReverbDecayChange(val) {
    setReverbDecay(val);
    if (!hostConn) broadcast({ type: 'reverb-decay', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'reverb-decay', value: val });
}
function setReverbDecay(val) {
    const v = Number(val);
    if (reverb) {
        reverb.decay = v;
        reverb.generate();
    }
    const label = document.getElementById('val-rvb-decay');
    if (label) label.innerText = v + 's';
    const slider = document.getElementById('reverb-decay-slider');
    if (slider) slider.value = v;
}
function resetReverbDecay() {
    setReverbDecay(5.0);
    onReverbDecayChange(5.0);
}

function onReverbPreDelayInput(val) {
    document.getElementById('val-rvb-predelay').innerText = val + 's';
}
function onReverbPreDelayChange(val) {
    setReverbPreDelay(val);
    if (!hostConn) broadcast({ type: 'reverb-predelay', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'reverb-predelay', value: val });
}
function setReverbPreDelay(val) {
    const v = Number(val);
    if (reverb) {
        reverb.preDelay = v;
        reverb.generate();
    }
    const label = document.getElementById('val-rvb-predelay');
    if (label) label.innerText = v + 's';
    const slider = document.getElementById('reverb-predelay-slider');
    if (slider) slider.value = v;
}
function resetReverbPreDelay() {
    setReverbPreDelay(0.1);
    onReverbPreDelayChange(0.1);
}

// Reverb Low Cut (HPF)
function onReverbLowCutInput(val) {
    const v = Number(val);
    const freq = 20 * Math.pow(50, v / 100);
    const txt = freq >= 1000 ? (freq / 1000).toFixed(1) + 'k' : Math.round(freq) + 'Hz';
    document.getElementById('val-rvb-lowcut').innerText = txt;
}
function onReverbLowCutChange(val) {
    setReverbLowCut(val);
    if (!hostConn) broadcast({ type: 'reverb-lowcut', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'reverb-lowcut', value: val });
}
function setReverbLowCut(val) {
    const v = Number(val);
    // 0% -> 20Hz (Off), 100% -> 1000Hz
    const freq = 20 * Math.pow(50, v / 100);
    if (rvbLowCut) rvbLowCut.frequency.rampTo(freq, 0.1);

    const txt = freq >= 1000 ? (freq / 1000).toFixed(1) + 'k' : Math.round(freq) + 'Hz';
    const label = document.getElementById('val-rvb-lowcut');
    if (label) label.innerText = txt;
    const slider = document.getElementById('reverb-lowcut-slider');
    if (slider) slider.value = v;
}
function resetReverbLowCut() {
    setReverbLowCut(0);
    onReverbLowCutChange(0);
}

// Reverb High Cut (LPF)
function onReverbHighCutInput(val) {
    const v = Number(val);
    const freq = 20000 * Math.pow(0.025, v / 100);
    const txt = freq >= 1000 ? (freq / 1000).toFixed(1) + 'k' : Math.round(freq) + 'Hz';
    document.getElementById('val-rvb-highcut').innerText = txt;
}
function onReverbHighCutChange(val) {
    setReverbHighCut(val);
    if (!hostConn) broadcast({ type: 'reverb-highcut', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'reverb-highcut', value: val });
}
function setReverbHighCut(val) {
    const v = Number(val);
    // 0% -> 20k (Off), 100% -> 500Hz
    const freq = 20000 * Math.pow(0.025, v / 100);
    if (rvbHighCut) rvbHighCut.frequency.rampTo(freq, 0.1);

    const txt = freq >= 1000 ? (freq / 1000).toFixed(1) + 'k' : Math.round(freq) + 'Hz';
    const label = document.getElementById('val-rvb-highcut');
    if (label) label.innerText = txt;
    const slider = document.getElementById('reverb-highcut-slider');
    if (slider) slider.value = v;
}
function resetReverbHighCut() {
    setReverbHighCut(0);
    onReverbHighCutChange(0);
}

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

    const label = document.getElementById(`eq - val - ${bandIdx}`);
    if (label) label.innerText = bandVal > 0 ? `+ ${bandVal}` : bandVal;

    if (localOnly || fromSync) return;

    if (!hostConn) {
        broadcast({ type: 'eq-update', band: bandIdx, value: bandVal });
    }
    else if (isOperator) {
        hostConn.send({ type: 'request-setting', settingType: 'eq', band: bandIdx, value: bandVal });
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

    if (!hostConn) broadcast({ type: 'preamp', value: db });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'preamp', value: db });
}

function resetEQ(fromSync = false) {
    if (isOperator && !fromSync) {
        hostConn.send({ type: 'request-eq-reset' });
        return;
    }
    document.querySelectorAll('.eq-slider').forEach((el, idx) => {
        setEQ(idx, 0, false, true);
    });
    setPreamp(0, false, true);
    if (!hostConn && !fromSync) broadcast({ type: 'eq-reset' });
}

// Virtual Stereo Width
function setStereoWidth(val) {
    stereoWidth = val / 100;
    document.getElementById('val-width').innerText = val + '%';
    document.getElementById('width-slider').value = val;
    applySettings();
}

function onStereoWidthChange(val) {
    if (!hostConn) broadcast({ type: 'stereo-width', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'stereo', value: val });
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
    if (!hostConn) broadcast({ type: 'vbass', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'vbass', value: val });
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
        broadcast({ type: 'volume', value: val / 100 });
        showToast(`Volume: ${Math.round(val)}%`);
    }
}

function toggleMute() {
    if (masterVolume > 0) {
        preMuteVolume = masterVolume;
        setVolume(0);
        showToast("Muted");
        if (!hostConn) broadcast({ type: 'volume', value: 0 });
    } else {
        setVolume(preMuteVolume || 0.5); // Fallback to 50% if preMuteVolume was somehow 0
        showToast(`Volume: ${Math.round(masterVolume * 100)}%`);
        if (!hostConn) broadcast({ type: 'volume', value: masterVolume });
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

    // [FIX] Support YouTube Volume Integration
    if (youtubePlayer && typeof youtubePlayer.setVolume === 'function') {
        try {
            // YouTube API expects 0-100
            youtubePlayer.setVolume(val * 100);
        } catch (e) {
            console.warn("[YouTube] Failed to set volume:", e);
        }
    }

    const vSlider = document.getElementById('volume-slider');
    if (vSlider) vSlider.value = val * 100;

    // [New] Support Video Element Volume sync (Especially for Host Native Playback)
    if (videoElement) {
        try {
            videoElement.volume = val;
        } catch (e) { }
    }

    updateVolumeIcon();
}

// ==============================================================
// [Visualizer] Light/Dark Mode Supported
// ==============================================================
function startVisualizer() {
    const canvas = document.getElementById('visualizerCanvas');
    const ctx = canvas.getContext('2d');

    // Check type of global analyser (Tone or Native)
    const isToneAnalyser = (analyser && !analyser.getByteFrequencyData);

    // Determine buffer size
    const bufferLength = isToneAnalyser ? analyser.size : analyser.frequencyBinCount;
    // Tone analyzer size is usually 1024 or 2048.
    // If Tone, we map Float32 to Uint8 manually for compatibility with drawing logic
    const dataArray = isToneAnalyser ? new Float32Array(bufferLength) : new Uint8Array(bufferLength);

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
            if (typeof smoothedBass === 'undefined') smoothedBass = bassAverage;
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
                ctx.fillStyle = `hsla(217, 100 %, ${highLightness + 30}%, 0.4)`;
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
    return `${m}:${sec < 10 ? '0' : ''}${sec} `;
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
        hostConn.send({ type: 'request-seek', time: t });
        return;
    }

    // Host: execute directly
    // YouTube mode: use YouTube API
    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
        try {
            youtubePlayer.seekTo(t, true);  // t is already in seconds
            broadcast({ type: 'youtube-state', state: youtubePlayer.getPlayerState(), time: t });
        } catch (e) {
            console.error("[YouTube] Slider seek error:", e);
        }
        return;
    }

    const isActuallyPlaying = (videoElement && !videoElement.paused);

    if (isActuallyPlaying) {
        play(t);
        broadcast({ type: 'play', time: t });
    } else {
        pausedAt = t;
        if (currentState === APP_STATE.PLAYING_VIDEO) videoElement.currentTime = t;
        // Broadcast pause with updated time to sync guests without starting playback
        broadcast({ type: 'pause', time: t });
    }

    // Schedule global resync after seek (Host only)
    setTimeout(() => {
        broadcast({ type: 'global-resync-request' });
        console.log("[Host] Global resync requested after seek");
    }, 1000);
});

// --- Sync Button Logic ---
function handleMainSyncBtn() {
    const isActuallyPlaying = (videoElement && !videoElement.paused);

    console.log("Sync Btn Clicked. HostConn:", !!hostConn, "Playing:", isActuallyPlaying);
    if (!hostConn) {
        // Host: Reset local offset and trigger Guest-side Sync
        localOffset = 0;
        updateSyncDisplay();
        showToast("모든 기기 재동기화 요청...");
        broadcast({ type: 'global-resync-request' });
    } else {
        // Guest: Manual local sync
        syncReset();
    }
}

function syncReset() {
    if (!hostConn || !hostConn.open) return;
    // [FIX] Do NOT clear localOffset here. 
    // Users want to keep their manual hardware correction (e.g. BT delay) 
    // even when network sync is recalibrated.
    updateSyncDisplay();

    showToast("동기화(Median Pattern) 적용 중...");
    syncRequestTime = Date.now();
    hostConn.send({ type: 'get-sync-time' });
}

function updateSyncBtnState(isGuest) {
    const btn = document.getElementById('btn-auto-sync');
    if (!btn) return; // Safety check

    // Unify Icon (Refresh) and Text (AUTO SYNC) for both roles
    btn.innerHTML = `< svg width = "14" height = "14" viewBox = "0 0 24 24" fill = "currentColor" > <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" /></svg > AUTO SYNC`;
}

// --- Networking (Updated from network.html) ---

// [수정된 네트워크 초기화 코드]
async function initNetwork() {
    try {
        let turnConfig = { username: "", credential: "" };

        // 1. 로컬/프라이빗 네트워크 감지
        const hostname = window.location.hostname;
        const isLocal = ['localhost', '127.0.0.1', '::1'].includes(hostname) ||
            hostname.startsWith('192.168.') ||
            hostname.startsWith('10.') ||
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname);

        if (!isLocal) {
            try {
                // 배달원에게 설정값 요청 (Netlify Function 호출)
                const response = await fetch('/.netlify/functions/get-turn-config');

                if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
                    turnConfig = await response.json();
                    console.log("TURN 설정 로드 완료 (Netlify)");
                } else {
                    console.warn("Netlify Function 사용 불가 - STUN 전용으로 초기화합니다.");
                }
            } catch (fetchErr) {
                console.warn("네트워크 설정 요청 중 오류:", fetchErr.message);
            }
        } else {
            console.log("[Network] Local/Private environment detected - skipping TURN configuration.");
        }

        // 2. 받아온 설정으로 옵션 만들기
        const iceServers = [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun.relay.metered.ca:80" }
        ];

        // 로컬이 아니고 TURN 설정이 있는 경우에만 TURN 서버 추가
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
                iceCandidatePoolSize: 0 // [SAFARI FIX] Reduced from 10 to 0 for better iOS compatibility
            }
        };

        // 3. PeerJS 시작
        peer = new Peer(null, peerOpts);

        // --- 기존 이벤트 리스너들 ---
        setupPeerEvents();

    } catch (e) {
        console.error("네트워크 초기화 중 치명적 오류:", e);
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
        console.warn("[QR] qrcode 요소를 찾을 수 없습니다.");
        return;
    }

    qrContainer.innerHTML = "";

    // QRCode.js 라이브러리 확인
    if (typeof QRCode === 'undefined') {
        console.warn("[QR] QRCode 라이브러리가 로드되지 않았습니다.");
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
        console.error("[QR] QR 코드 생성 실패:", e);
    }

    // ID 표시 업데이트
    const myIdEl = document.getElementById('my-id');
    if (myIdEl) {
        myIdEl.innerText = hostConn ? "Host ID: " + id : id;
    }
}

function setupPeerEvents() {

    peer.on('error', (err) => {
        console.error("PeerJS Global Error:", err);
        console.error("Error Type:", err.type);

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
        // [FIX] Don't show overlay if we already have an active P2P session (signalling loss is transient)
        const isSessionActive = (hostConn && hostConn.open) || (connectedPeers && connectedPeers.some(p => p.status === 'connected'));

        if (['server-error', 'network', 'browser-incompatible'].includes(err.type)) {
            if (isSessionActive && err.type !== 'browser-incompatible') {
                console.warn("[Network] Signalling server connection lost, but P2P session is active. Skipping overlay.");
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
            console.log("[QR] Auto-joining host:", hostId);

            // Auto-trigger join session for QR users
            // This is safe because we are already inside peer.on('open')
            setTimeout(() => joinSession(), 100);
        } else {
            const hostPanel = document.getElementById('host-panel');
            if (hostPanel) hostPanel.classList.add('visible');
            const roleText = document.getElementById('role-text');
            if (roleText) roleText.innerText = "HOST (ME)";
            document.getElementById('role-badge').classList.add('connected');
            updateSyncBtnState(false);

            renderDeviceList([
                { id: myId, label: 'HOST', status: 'connected', isHost: true }
            ]);

            // Heartbeat Monitor (Host checks for voluntary signals)
            setInterval(() => {
                const now = Date.now();
                let changed = false;

                // 1. Check for Timeouts
                connectedPeers.forEach(p => {
                    if (p.status === 'connected') {
                        // Host does NOT ping. Waits for Guest.

                        // Timeout: 15 seconds (allows 2 lost signals from 5s interval)
                        if (now - p.lastHeartbeat > 15000) {
                            console.warn(`Peer ${p.label} timed out.`);
                            p.status = 'disconnected';
                            changed = true;
                            showToast(`${p.label} 제거됨(무응답)`);
                        }
                    }
                });

                // 2. Boldly Remove Disconnected Peers
                if (changed) {
                    // FORCE UPDATE: Reassign global array and CLEAN UP orphans
                    const disconnected = connectedPeers.filter(p => p.status !== 'connected');
                    disconnected.forEach(p => {
                        if (p._relayMonitor) clearInterval(p._relayMonitor);
                        if (p._heartbeatTimer) clearInterval(p._heartbeatTimer);
                    });
                    connectedPeers = connectedPeers.filter(p => p.status === 'connected');
                    broadcastDeviceList();
                }
            }, 1000);
        }
    });

    function broadcastDeviceList() {
        const list = [
            { id: myId, label: 'HOST', status: 'connected', isHost: true },
            ...connectedPeers.map(p => ({
                id: p.id, label: p.label, status: p.status, isHost: false, isOp: p.isOp
            }))
        ];

        const msg = { type: 'device-list-update', list: list };
        broadcast(msg);
        renderDeviceList(list);
    }

    // Host Logic
    peer.on('connection', conn => {
        // Check for Data Relay Connection
        if (conn.metadata && conn.metadata.type === 'data-relay') {
            handleRelayConnection(conn);
            return;
        }

        // [GHOSTING FIX] Duplicate check: If this peer ID is already connected, close the old one
        const existingIdx = connectedPeers.findIndex(p => p.id === conn.peer);
        if (existingIdx !== -1) {
            console.warn(`[Network] Duplicate connection from ${conn.peer}. Replacing old one.`);
            const oldPeer = connectedPeers[existingIdx];
            if (oldPeer.conn && oldPeer.conn.open) {
                try {
                    // [FIX] Tag this closure so Guest doesn't auto-retry redundant connection
                    oldPeer.conn.send({ type: 'force-close-duplicate' });
                    oldPeer.conn.close();
                } catch (e) { }
            }
            connectedPeers.splice(existingIdx, 1);
        }

        conn.on('open', () => {
            let deviceName;

            // 1. Label Memory 확인: 이전에 접속했던 기기인가?
            if (peerLabels[conn.peer]) {
                deviceName = peerLabels[conn.peer];
                console.log(`[Network] Re-connection detected: ${deviceName} (${conn.peer})`);
            } else {
                // 2. 신규 기기라면 카운터 증가 및 저장
                deviceCounter++;
                deviceName = `DEVICE ${deviceCounter} `; // 뒤에 공백 유지
                peerLabels[conn.peer] = deviceName;
            }

            const curItem = (currentTrackIndex >= 0) ? playlist[currentTrackIndex] : null;

            const peerObj = {
                id: conn.peer,
                label: deviceName,
                status: 'connected',
                conn: conn,
                isOp: false,
                isDataTarget: true, // Default: Receive data from Host
                lastHeartbeat: Date.now() // Heartbeat Init
            };
            connectedPeers.push(peerObj);
            broadcastDeviceList();

            showToast(`${deviceName} 연결됨`);

            // --- Relay Assignment Logic ---
            // --- Relay Assignment Logic (2-Lane Stabilized) ---
            if (connectedPeers.length > MAX_DIRECT_DATA_PEERS) {
                // 2-Lane System: Try to find a parent in the same lane (Odd/Even)
                // 2-Lane Relay Strategy: Find nearest same-lane ancestor (Odd/Even indices)

                let assigned = false;
                for (let i = connectedPeers.length - 3; i >= 0; i -= 2) {
                    const candidate = connectedPeers[i];
                    // Must be connected AND have open channel to serve as relay
                    if (candidate && candidate.status === 'connected' && candidate.conn.open) {
                        conn.send({ type: 'assign-data-source', targetId: candidate.id });
                        showToast(`Data Relay: ${deviceName} -> ${candidate.label} `);

                        // Do NOT send data directly from Host to this new peer
                        peerObj.isDataTarget = false;
                        peerObj.assignedRelay = candidate.id; // [FIX #8] Track for monitoring
                        assigned = true;
                        break;
                    }
                }
                if (!assigned) {
                    // If no active parent found in lane, fall back to Host (keep isDataTarget = true)
                    showToast(`Relay Lane Unavailable: ${deviceName} joined Host Direct`);
                }
            }
            // -----------------------------

            // [FIX #8] Set up relay lane reassignment on parent disconnect
            if (!peerObj.isDataTarget && peerObj.assignedRelay) {
                // Monitor the assigned relay peer
                const monitorRelay = () => {
                    const relay = connectedPeers.find(p => p.id === peerObj.assignedRelay);
                    if (!relay || relay.status !== 'connected') {
                        console.log(`[Relay] Parent ${peerObj.assignedRelay} disconnected, reassigning ${deviceName}`);
                        peerObj.isDataTarget = true; // Fall back to Host direct
                        showToast(`${deviceName} -> Host Direct (릴레이 끊김)`);

                        // [Fix] Stop monitoring once reassigned to prevent interval spam
                        if (peerObj._relayMonitor) {
                            clearInterval(peerObj._relayMonitor);
                            peerObj._relayMonitor = null;
                        }
                    }
                };
                // Check every RELAY_MONITOR_INTERVAL ms
                peerObj._relayMonitor = setInterval(monitorRelay, RELAY_MONITOR_INTERVAL);
            }
            // -----------------------------

            conn.send({ type: 'welcome', label: deviceName });
            conn.send({ type: 'volume', value: masterVolume });
            conn.send({ type: 'reverb', value: reverbMix * 100 });
            conn.send({
                type: 'playlist-update',
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
                        type: 'youtube-play',
                        videoId: (videoData && videoData.video_id) ? videoData.video_id : (curItem ? curItem.videoId : null),
                        playlistId: curItem ? curItem.playlistId : null,
                        index: currentTrackIndex,
                        subIndex: currentYouTubeSubIndex
                    });
                    // Send current time sync after short delay (let guest load player first)
                    setTimeout(() => {
                        if (youtubePlayer && conn.open) {
                            conn.send({
                                type: 'youtube-sync',
                                time: youtubePlayer.getCurrentTime(),
                                state: youtubePlayer.getPlayerState(),
                                subIndex: currentYouTubeSubIndex
                            });
                        }
                    }, 3000);
                } catch (e) {
                    console.error("[YouTube] Failed to send state to new guest:", e);
                }
            }

            broadcastDeviceList();

            if (curItem && curItem.type !== 'youtube') {
                conn.send({ type: 'file-prepare', name: curItem.name, index: currentTrackIndex });
            }

            // [FIX] Late Joiner Media Guard:
            // If Host is still extracting audio from a video, do NOT send the MP4 file yet.
            // The guest will receive the WAV file automatically when broadcastFile(wavFile) is called later.
            if (peerObj.isDataTarget && playlist[currentTrackIndex]?.file && !playlist[currentTrackIndex]?._isExtracting) {
                unicastFile(conn, playlist[currentTrackIndex].file);
            } else if (playlist[currentTrackIndex]?._isExtracting) {
                console.log(`[Host] Guest joined during extraction. Skipping unicast, waiting for broadcast.`);
                conn.send({ type: 'file-wait', message: '오디오 추출 중... 잠시만 기다려주세요.' });
            }

            // [FIX] Move all conditional listeners INSIDE open callback so peerObj is in scope
            conn.on('data', data => {
                if (data.type === 'heartbeat' || data.type === 'heartbeat-ack') {
                    peerObj.lastHeartbeat = Date.now();

                    if (!hostConn) { // Only genuine Host responds
                        const isActuallyPlaying = (videoElement && !videoElement.paused);

                        conn.send({
                            type: 'status-sync',
                            currentTrackIndex: currentTrackIndex,
                            isPlaying: isActuallyPlaying,
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

                if (data.type === 'ping-latency') {
                    conn.send({ type: 'pong-latency', timestamp: data.timestamp });
                    return;
                }

                if (data.type === 'get-sync-time') {
                    const currentTime = getTrackPosition();
                    const isActuallyPlaying = (videoElement && !videoElement.paused);
                    conn.send({ type: 'sync-response', time: currentTime, isPlaying: isActuallyPlaying });
                }
                else if (peerObj.isOp) {
                    handleOperatorRequest(data);
                }
                else if (data.type === 'preload-ack') {
                    if (!peerObj.preloadedIndexes) peerObj.preloadedIndexes = new Set();
                    peerObj.preloadedIndexes.add(data.index);
                    console.log(`[Host] Guest ${peerObj.id} confirmed preload for index ${data.index}`);
                }
                else if (data.type === 'request-youtube-playlist-info') {
                    const pid = data.playlistId;
                    if (youtubeSubItemsMap[pid]) {
                        conn.send({
                            type: 'youtube-playlist-info',
                            playlistId: pid,
                            ids: youtubeSubItemsMap[pid].ids,
                            titles: youtubeSubItemsMap[pid].titles
                        });
                    }
                }
                else if (data.type === 'request-data-recovery') {
                    const fileName = data.fileName;
                    const recoveryIndex = data.index;
                    const nextChunk = data.nextChunk || 0;
                    const peerId = conn.peer;

                    if (!window._recoveryInProgress) window._recoveryInProgress = {};
                    if (window._recoveryInProgress[peerId]) return;

                    let item = playlist.find(f => f.name === fileName);
                    if (!item && recoveryIndex !== undefined && playlist[recoveryIndex]) {
                        item = playlist[recoveryIndex];
                    }

                    if (item && item.file) {
                        window._recoveryInProgress[peerId] = true;
                        const queueDelay = Object.keys(window._recoveryInProgress).length * 200;
                        setTimeout(async () => {
                            try {
                                if (conn.open) {
                                    showToast(`Recovering ${peerObj.label}: chunk ${nextChunk}`);
                                    await unicastFile(conn, item.file, nextChunk);
                                }
                            } finally {
                                delete window._recoveryInProgress[peerId];
                            }
                        }, queueDelay);
                    }
                }
                else if (data.type === 'chat') {
                    addChatMessage(data.sender, data.text, false);
                    connectedPeers.forEach(p => {
                        if (p.status === 'connected' && p.conn.open && p.id !== conn.peer) {
                            p.conn.send({ type: 'chat', sender: data.sender, text: data.text });
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
const CONNECTION_TIMEOUT_MS = 7000; // [SAFARI FIX] Reduced from 10s to 7s for faster retry if it hangs
let connectionTimeoutId = null;

function joinSession(retryAttempt = 0) {
    // 1. Peer 객체가 준비되지 않았을 때 (초기화 중)
    if (!peer || !peer.open) {
        // [FIX] 로그에 시도 횟수 표시
        console.warn(`[Network] Peer not ready yet. Waiting... (${retryAttempt}/20)`);

        // [FIX] 20번(약 10초)까지만 기다려보고, 안 되면 포기 선언
        if (retryAttempt > 20) {
            showConnectionFailedOverlay(
                "네트워크 초기화에 실패했습니다.\n\n" +
                "1. 잠시 후 '새로고침' 해보세요. (서버 부팅 중일 수 있음)\n" +
                "2. VPN이나 사내 보안망을 끄고 시도해보세요."
            );
            return;
        }

        // [FIX] 0.5초 뒤에 다시 확인하되, 카운트를 1 증가시킴
        setTimeout(() => joinSession(retryAttempt + 1), 500);
        return;
    }

    if (isConnecting && retryAttempt === 0) {
        console.warn("[Network] joinSession already in progress. Ignoring duplicate call.");
        return;
    }
    isConnecting = true;

    const hostId = document.getElementById('join-id-input').value.trim();
    if (!hostId) return showToast("ID 입력 필요");

    // New attempt: Reset intentional flag
    isIntentionalDisconnect = false;

    // UI Reset: Rebranding to "Connecting" state (Gray)
    const roleBadge = document.getElementById('role-badge');
    if (roleBadge) {
        roleBadge.classList.remove('connected');
        roleBadge.style.background = ''; // Clear inline colors (orange/blue)
        roleBadge.style.boxShadow = '';
    }

    // Show connection status
    if (retryAttempt === 0) {
        showToast("Host에 연결 중...");
        document.getElementById('role-text').innerText = "연결 중...";
    } else {
        // 연결 시간 초과 토스트가 이미 표시되므로 여기서는 UI만 업데이트
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
            console.warn(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`);
            hostConn.close();

            if (retryAttempt < MAX_CONNECTION_RETRIES) {
                isConnecting = false;
                showToast(`연결 시간 초과. 재시도 중... (${retryAttempt + 1}/${MAX_CONNECTION_RETRIES})`);
                // [GHOSTING FIX] Exponential Backoff
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
        const roleBadge = document.getElementById('role-badge');
        if (roleBadge) roleBadge.classList.add('connected');
        updateSyncBtnState(true);

        updateQrCode(hostId);
        const hostPanel = document.getElementById('host-panel');
        if (hostPanel) hostPanel.classList.add('visible');

        // Volunteer Heartbeat: Send to Host every 5s (Worker)
        timerWorker.postMessage({ command: 'START_TIMER', id: 'heartbeat', interval: 5000 });

        // Latency Ping (2s) (Worker)
        timerWorker.postMessage({ command: 'START_TIMER', id: 'ping', interval: 2000 });

        // Detect ICE connection type after connection stabilizes
        setTimeout(() => detectConnectionType(), 2000);

        const leaveBtn = document.getElementById('btn-leave-session');
        if (leaveBtn) leaveBtn.style.display = 'flex';
        switchTab('play');
    });

    hostConn.on('error', (err) => {
        console.error("PeerJS Connection Error:", err);

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
        timerWorker.postMessage({ command: 'STOP_TIMER', id: 'heartbeat' });
        timerWorker.postMessage({ command: 'STOP_TIMER', id: 'ping' });

        if (!isIntentionalDisconnect && retryAttempt < MAX_CONNECTION_RETRIES) {
            // [FIX] If we are already in joinSession (isConnecting=true), don't trigger another one
            if (isConnecting) {
                console.log("[Network] Connection closed but another attempt is already in progress. Skipping retry.");
                return;
            }

            isConnecting = false;
            console.warn(`Unexpected connection close. Retrying (${retryAttempt + 1}/${MAX_CONNECTION_RETRIES})`);
            showToast(`연결 끊김. 재시도 중... (${retryAttempt + 1}/${MAX_CONNECTION_RETRIES})`);

            const backoffDelay = 1500 * Math.pow(1.5, retryAttempt);
            setTimeout(() => joinSession(retryAttempt + 1), backoffDelay);
        } else {
            isConnecting = false;
            if (!isIntentionalDisconnect) {
                showConnectionFailedOverlay("Host와 연결이 끊어졌습니다");
            }
            showToast("Host 끊김");
            document.getElementById('role-text').innerText = "OFFLINE";
            const roleBadge = document.getElementById('role-badge');
            if (roleBadge) {
                roleBadge.classList.remove('connected');
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
    clearAllManagedTimers();
    if (hostConn) {
        showToast("Host만 실행할 수 있습니다.");
        return;
    }

    if (peer) {
        peer.destroy();
        peer = null;
    }

    if (hostConn) {
        hostConn.close();
        hostConn = null;
    }

    connectedPeers.forEach(p => p.conn.close());
    connectedPeers = [];
    downstreamDataPeers = [];

    stopAllMedia();
    resetUI();
    showToast("세션 종료됨");
    updateDeviceList();
    updatePlaylistUI();
    updateTitleWithMarquee("Welcome");
    document.getElementById('track-artist').innerText = "No Track Loaded";
    document.getElementById('play-btn').disabled = true;
    document.getElementById('seek-slider').disabled = true;
    document.getElementById('seek-slider').value = 0;
    document.getElementById('time-curr').innerText = "00:00";
    document.getElementById('time-dur').innerText = "00:00";
    document.getElementById('my-id').innerText = '...';
    document.getElementById('join-id-input').value = '';
    document.getElementById('join-btn').disabled = false;
    document.getElementById('create-btn').disabled = false;
    document.getElementById('host-controls').style.display = 'none';
    document.getElementById('guest-controls').style.display = 'none';
    document.getElementById('player-controls').style.display = 'none';
    document.getElementById('player-info').style.display = 'none';
    document.getElementById('main-video').style.display = 'none';
    document.getElementById('visualizer').style.display = 'block';
    document.getElementById('chat-drawer').classList.remove('open');
    document.getElementById('chat-preview-badge').classList.remove('show');
    document.getElementById('chat-messages').innerHTML = '<div class="chat-empty">채팅이 없습니다.</div>';
    unreadChatCount = 0;
    lastChatSender = '';
    lastChatText = '';
    isChatDrawerOpen = false;
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
    window._activeBroadcastSession = null;
    window._pendingFileName = null;
    window._pendingFileIndex = null;
    window._ytIOSWatchdog = null;
    window._ytScriptLoading = false;
    window.isYouTubeAPIReady = false;
    if (window.BlobURLManager) BlobURLManager.clear();
    setState(APP_STATE.IDLE);
    console.log("Session left.");
}

// --- Data Handling ---
// Note: currentFileOpfs, preloadFileOpfs handles are used for storage

// Detect ICE connection type and set compensation mode
async function detectConnectionType() {
    if (!hostConn || !hostConn.peerConnection) {
        console.log("[ICE] No peer connection available");
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
            console.log("[ICE] TURN Relay detected - Using RTT/2 compensation");
            showToast("원격 네트워크 감지 - 자동 보정 활성화");

            // 배지 주황색으로 변경 (릴레이)
            const roleBadge = document.getElementById('role-badge');
            if (roleBadge) {
                roleBadge.style.background = '#fb923c';
                roleBadge.title = '원격 네트워크 (릴레이)';
            }
        } else if (connectionType === 'host' || connectionType === 'srflx') {
            usePingCompensation = false;
            console.log(`[ICE] Direct connection (${connectionType}) - No ping compensation`);
            showToast("로컬 네트워크 감지 - 직접 동기화");
            // 기본 파란색 유지 (CSS에서 설정됨)
        } else {
            usePingCompensation = true; // Fallback: apply compensation
            console.log("[ICE] Unknown connection type - Using RTT/2 compensation as fallback");
        }
    } catch (e) {
        console.error("[ICE] Detection failed:", e);
        usePingCompensation = true; // Fallback
    }
}

// Helper: Clear all previous track state to prevent data mixing
function clearPreviousTrackState(reason = '') {
    console.log(`[State Clear] Clearing previous track state. Reason: ${reason}`);

    // Stop timers (중앙화된 타이머 사용)
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('prepareWatchdog');

    // ✅ 강화: 명시적 null 할당으로 GC 유도
    if (incomingChunks && incomingChunks.length > 1000) {
        console.log(`[GC] Releasing large chunk array (${incomingChunks.length} items)`);
    }
    incomingChunks = null; // GC 대상으로 만들기
    incomingChunks = []; // 새 빈 배열

    receivedCount = 0;

    // ✅ 개선: meta도 명시적 해제
    if (meta) {
        meta = null;
    }
    meta = {};

    currentFileBlob = null;

    window._skipIncomingFile = false;
    _isProcessingBlob = false;
    window._pendingEarlyChunks = [];

    BlobURLManager.revoke();

    if (videoElement) {
        videoElement.pause();
        videoElement.src = '';
        videoElement.load();
    }
    // [New] Explicitly revoke Blob URL when clearing track state
    BlobURLManager.revoke();

    // [New] Physically delete the OLD current file from OPFS when switching tracks
    if (currentFileOpfs.name) {
        cleanupOPFSInWorker(currentFileOpfs.name, false);
        currentFileOpfs.name = null;
    }

    // Note: We do NOT clear preload state here (nextFileBlob, preloadChunks, etc.)
    // Those are intentionally preserved for upcoming track switch
}

// --- Data Message Handlers ---
async function handleFilePrepare(data) {
    // Check if we already have this track preloaded!
    const hasPreloadedByIndex = nextMeta && data.index !== undefined && data.index === nextMeta.index;
    const hasPreloadedByName = nextMeta && data.name && data.name === nextMeta.name;

    // Also check if preload is IN PROGRESS for this track
    const preloadInProgressByIndex = preloadMeta && data.index !== undefined && data.index === preloadMeta.index;
    const preloadInProgressByName = preloadMeta && data.name && data.name === preloadMeta.name;

    // DEBUG: Log preload matching status
    console.log("[file-prepare] Checking preload:", {
        dataIndex: data.index,
        dataName: data.name,
        nextMetaIndex: nextMeta?.index,
        nextMetaName: nextMeta?.name,
        hasNextFileBlob: !!nextFileBlob,
        matchByIndex: hasPreloadedByIndex,
        matchByName: hasPreloadedByName,
        preloadInProgress: preloadInProgressByIndex || preloadInProgressByName
    });

    // [FIX] Verify Preload Index: Don't use stale preload metadata from a different track
    const isMismatch = nextMeta && data.index !== undefined && data.index !== nextMeta.index;
    if (isMismatch) {
        console.warn(`[file-prepare] Preload index mismatch! Request: ${data.index}, Preloaded: ${nextMeta.index}. Clearing stale preload.`);
        clearPreloadState();
    }

    if (nextFileBlob && (hasPreloadedByIndex || hasPreloadedByName)) {

        console.log("[Guest] ?? Using preloaded track instead of re-downloading:", data.name);
        showToast("프리로드된 파일 사용!");

        stop();
        currentTrackIndex = data.index !== undefined ? data.index : currentTrackIndex;
        updatePlaylistUI();

        // Use preloaded file directly
        await loadPreloadedTrack();

        // CRITICAL: Hide loader so play() doesn't think we're still downloading
        showLoader(false);

        // Mark that we already loaded this track (prevent duplicate load from play-preloaded)
        window._preloadUsedForIndex = data.index;

        // Mark that we're skipping incoming file transfer
        window._skipIncomingFile = true;
        return;
    }


    // CHECK: If preload is IN PROGRESS for this track, wait for it instead of starting new download
    if (preloadInProgressByIndex || preloadInProgressByName) {
        console.log("[file-prepare] Preload in progress for this track, waiting...");
        showLoader(true, `프리로드 완료 대기 중: ${data.name}`);

        // Set pending info
        window._pendingFileName = data.name;
        window._pendingFileIndex = data.index;
        window._waitingForPreload = true;
        window._skipIncomingFile = true; // Skip any file-start that might come

        currentTrackIndex = data.index !== undefined ? data.index : currentTrackIndex;
        updatePlaylistUI();

        // [FIX] Preload Watchdog: If preloading fails to complete, recover after 10s
        if (window._preloadWatchdog) clearTimeout(window._preloadWatchdog);
        window._preloadWatchdog = setTimeout(() => {
            if (window._waitingForPreload) {
                console.warn("[Guest] Preload wait timed out. Force recovering...");
                window._waitingForPreload = false;
                showLoader(false);
                if (hostConn && hostConn.open) hostConn.send({ type: 'request-current-file' });
            }
        }, 10000);

        return; // Don't start new download
    }

    // Normal flow: No preload available, prepare for download
    window._skipIncomingFile = false;
    window._waitingForPreload = false;

    // Store pending file name for recovery requests
    window._pendingFileName = data.name;
    window._pendingFileIndex = data.index;

    // CRITICAL: Don't clear state if we're resuming the SAME file!
    // This preserves already-received chunks during recovery
    const isSameFile = (meta && meta.name === data.name) ||
        (window._pendingFileIndex !== undefined && window._pendingFileIndex === data.index);
    const isResuming = isSameFile && receivedCount > 0;

    if (isResuming) {
        console.log(`[file-prepare] Same file in progress (${receivedCount} chunks), skipping reset`);
        showLoader(true, `복구 대기 중: ${data.name}`);
    } else {
        // Clear previous track state before receiving new file
        clearPreviousTrackState('file-prepare (new download)');
        showLoader(true, `준비 중: ${data.name}`);
        stop();
        if (data.index !== undefined) {
            currentTrackIndex = data.index;
            updatePlaylistUI();
        }
        // [FIX] Stop YouTube mode AFTER updatePlaylistUI to prevent title overwrite
        if (currentState === APP_STATE.PLAYING_YOUTUBE) {
            console.log("[file-prepare] Stopping YouTube mode for incoming local file");
            stopYouTubeMode();
        }
        // [FIX] Set title LAST to ensure it's not overwritten
        updateTitleWithMarquee(data.name);
        document.getElementById('track-artist').innerText = `Track ${data.index + 1}`;
    } // Close the else block from isResuming check

    // FIX 5: Prepare Watchdog (Prevent Infinite Preparing...)
    // Set fallback watchdog: If no chunks arrive within 12 seconds, something failed
    managedTimers.prepareWatchdog = setTimeout(() => {
        if (transferState === TRANSFER_STATE.IDLE || receivedCount === 0) {
            console.warn("[Prepare Watchdog] Timeout waiting for data start!");
            showToast("준비 지연 중... Host 복구 요청");

            // Fallback: Request recovery directly from Host
            if (hostConn && hostConn.open) {
                const recoveryFileName = window._pendingFileName || '';
                const recoveryIndex = window._pendingFileIndex !== undefined ? window._pendingFileIndex : currentTrackIndex;

                // [FIX] Consistent Jitter
                const jitter = Math.random() * 1000 + 200;
                console.log(`[Watchdog] Delaying recovery request by ${Math.round(jitter)}ms for DDoS mitigation`);
                setTimeout(() => {
                    if (hostConn && hostConn.open && !currentFileBlob) {
                        console.log("[Prepare Watchdog Recovery] Requesting from Host:", recoveryFileName);
                        hostConn.send({
                            type: 'request-data-recovery',
                            nextChunk: 0,
                            fileName: recoveryFileName,
                            index: recoveryIndex
                        });
                    }
                }, jitter);
            }
        }
    }, 15000); // 15s safety timer
}

async function handleFileStart(data) {
    // [FIX] Session ID Validation
    const incomingSid = data.sessionId || 0;
    if (incomingSid < localTransferSessionId) {
        console.warn(`[file-start] Stale session ignored. Current: ${localTransferSessionId}, Received: ${incomingSid}`);
        return;
    }

    // If it's a newer session, reset state
    if (incomingSid > localTransferSessionId) {
        console.log(`[file-start] New session detected: ${incomingSid}. Resetting state.`);
        localTransferSessionId = incomingSid;
        clearPreviousTrackState('new-session-start');
    }

    // Skip if we're using preloaded file (already have the data)
    if (window._skipIncomingFile) {
        console.log("[file-start] Skipping - already using preloaded file");
        return;
    }

    // Clear Prepare Watchdog as we've started receiving
    clearManagedTimer('prepareWatchdog');

    // [FIX] Always reset processing guard at file-start to prevent stuck loader
    // This is safe because file-start means we're (re)starting the transfer
    transferState = TRANSFER_STATE.IDLE;

    // [OPFS-Worker] Start new session
    if (currentFileOpfs.name && currentFileOpfs.name !== data.name) {
        cleanupOPFSInWorker(currentFileOpfs.name, false);
    }
    timerWorker.postMessage({ command: 'OPFS_START', filename: data.name, isPreload: false, size: CHUNK_SIZE });
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
        console.log(`[file-start] Same file detected! Keeping ${receivedCount}/${data.total} chunks (OPFS seek logic will follow)`);

        // [FIX] If file is already 100% complete, reset guard and skip to end
        if (receivedCount >= data.total) {
            console.log("[file-start] File already complete, triggering immediate processing");
            _isProcessingBlob = false; // Reset guard to allow reprocessing
            meta = data; // Update meta first

            // Trigger processing via worker notification
            timerWorker.postMessage({ command: 'OPFS_END', filename: data.name, isPreload: false, sessionId: incomingSid });
            return; // Skip rest of file-start handler
        } else {
            showToast(`${sourceLabel}로부터 전송 이어받기`);
            const pct = Math.round((receivedCount / data.total) * 100);
            showLoader(true, `${sourceLabel} 수신 중... ${pct}%${sizeText}`);

            // Resume with Worker (keepExistingData is default for OPFS_START if we handle logic there, 
            // but Worker implementation above creates fresh. Let's send START to ensure handles are open)
            timerWorker.postMessage({ command: 'OPFS_START', filename: data.name, isPreload: false, size: CHUNK_SIZE });
        }
        // Update meta but don't touch receivedCount
        meta = data;
    } else {
        // NEW FILE: Initialize fresh
        console.log(`[file-start] New file, initializing Worker-OPFS for ${data.total} chunks`);
        showToast(`${sourceLabel}로부터 파일 수신 시작`);
        showLoader(true, `${sourceLabel} 수신 중... 0%${sizeText}`);

        // [OPFS-Worker] Start
        timerWorker.postMessage({ command: 'OPFS_START', filename: data.name, isPreload: false, size: CHUNK_SIZE });
        currentFileOpfs.name = data.name;

        incomingChunks = []; // Clear in-memory array
        receivedCount = 0;
        meta = data;
        transferState = TRANSFER_STATE.RECEIVING;

        // [FIX] Apply any pending chunks that arrived before file-start
        if (window._pendingEarlyChunks && window._pendingEarlyChunks.length > 0) {
            console.log(`[file-start] Applying ${window._pendingEarlyChunks.length} early chunks to Worker-OPFS`);
            for (const pending of window._pendingEarlyChunks) {
                if (pending.index >= 0 && pending.index < data.total) {
                    timerWorker.postMessage({
                        command: 'OPFS_WRITE',
                        chunk: pending.chunk,
                        index: pending.index,
                        isPreload: false
                    }, [pending.chunk.buffer]);
                    receivedCount++;
                }
            }
            window._pendingEarlyChunks = []; // Clear pending buffer
        }
    }

    updateTitleWithMarquee(data.name);

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
                const recoveryFileName = (meta && meta.name) ? meta.name : (window._pendingFileName || '');
                const recoveryIndex = window._pendingFileIndex !== undefined ? window._pendingFileIndex : currentTrackIndex;

                // GAP-BASED RECOVERY: (Simplified: using receivedCount as fallback since we don't have bitset here)
                let firstMissing = receivedCount || 0;

                console.log("[Watchdog Recovery] Requesting from index:", firstMissing, "FileName:", recoveryFileName);
                hostConn.send({
                    type: 'request-data-recovery',
                    nextChunk: firstMissing,
                    fileName: recoveryFileName,
                    index: recoveryIndex
                });
            }
        }
    }, 1000);

    // RELAY LOGIC: Forward 'file-start' header to downstream (simplified)
    // [FIX] Removed _waitingForFileStart logic that caused duplicate transmissions
    if (downstreamDataPeers.length > 0) {
        downstreamDataPeers.forEach(p => {
            if (p.open) p.send(data);
        });
    }
}

async function handleFileResume(data) {
    // [FIX] Session ID Validation
    const incomingSid = data.sessionId || 0;
    if (incomingSid < localTransferSessionId) {
        console.warn(`[file-resume] Stale session ignored. Current: ${localTransferSessionId}, Received: ${incomingSid}`);
        return;
    }

    if (incomingSid > localTransferSessionId) {
        console.log(`[file-resume] New session detected during resume: ${incomingSid}`);
        localTransferSessionId = incomingSid;
    }

    // Clear Prepare Watchdog
    clearManagedTimer('prepareWatchdog');

    // RESUME TRANSFER
    window._skipIncomingFile = false;

    // [OPFS-Worker] Resume
    timerWorker.postMessage({ command: 'OPFS_START', filename: data.name, isPreload: false, size: CHUNK_SIZE, keepExisting: true });
    currentFileOpfs.name = data.name;

    const sourceLabel = upstreamDataConn ? `Relay(${upstreamDataConn.peer.substr(-4)})` : "Host";
    const startChunk = data.startChunk || 0;

    console.log(`[Resume] Continuing from chunk ${startChunk}, already have ${receivedCount} chunks (OPFS handles resume via keepExistingData)`);
    showToast(`${sourceLabel}로부터 전송 재개 (${startChunk}부터)`);

    transferState = TRANSFER_STATE.RECEIVING;

    // Update meta
    meta = data;
    updateTitleWithMarquee(data.name);

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
                const recoveryFileName = meta?.name || window._pendingFileName || '';
                const recoveryIndex = window._pendingFileIndex !== undefined ? window._pendingFileIndex : currentTrackIndex;

                // Find first missing chunk (Simplified: in OPFS we'd need a tracking bitset for perfect gaps, using receivedCount as fallback)
                let firstMissing = receivedCount || 0;

                console.log("[Resume Watchdog] Requesting from index:", firstMissing);
                hostConn.send({
                    type: 'request-data-recovery',
                    nextChunk: firstMissing,
                    fileName: recoveryFileName,
                    index: recoveryIndex
                });
            }
        }
    }, 1000);
}

async function handleFileChunk(data) {
    const incomingSid = data.sessionId || 0;

    // ✅ 새 세션 감지 시 워커 리셋
    if (incomingSid > localTransferSessionId) {
        console.log(`[Chunk] New session detected: ${localTransferSessionId} → ${incomingSid}`);
        localTransferSessionId = incomingSid;

        // Worker 버퍼 명시적 클리어
        timerWorker.postMessage({
            command: 'OPFS_RESET',
            isPreload: false
        });

        // 기존 상태 초기화
        clearPreviousTrackState('session-change');
    }

    if (incomingSid < localTransferSessionId) {
        if (data.index === 0) console.warn(`[Chunk] Stale session ignored: ${incomingSid}`);
        return;
    }

    // Skip if we're using preloaded file
    if (window._skipIncomingFile) {
        console.log("[Chunk] Skipped - _skipIncomingFile is true");
        return; // Silently ignore chunks when using preload
    }

    // CRITICAL: Clone the chunk! The underlying buffer might be reused or detached by PeerJS.
    const chunkCopy = new Uint8Array(data.chunk);

    // INDEX-BASED REASSEMBLY (Fixes Data Corruption)
    const idx = data.index;

    // Debug logging for first few chunks
    if (idx < 5 || idx % 100 === 0) {
        console.log(`[Chunk] Received idx=${idx}, total=${meta?.total}`);
    }

    // [FIX #12] Enhanced bounds check with meta.total validation
    const isValidIndex = idx >= 0 &&
        (!meta || !meta.total || idx < meta.total);

    // [FIX] Prepare relay copy BEFORE sending chunkCopy to worker (to avoid detachment)
    let relayCopy = null;
    if (downstreamDataPeers.length > 0) {
        relayCopy = new Uint8Array(chunkCopy);
    }

    if (isValidIndex) {
        // [Worker-OPFS] Offload write
        timerWorker.postMessage({
            command: 'OPFS_WRITE',
            chunk: chunkCopy,
            index: idx,
            isPreload: false
        }, [chunkCopy.buffer]);
        receivedCount++;
    } else {
        // [FIX] Buffer early chunks that arrive before file-start
        console.log(`[Chunk] Buffering early chunk idx=${idx} (waiting for OPFS start)`);
        if (!window._pendingEarlyChunks) window._pendingEarlyChunks = [];
        window._pendingEarlyChunks.push({ index: idx, chunk: chunkCopy });
    }

    lastChunkTime = Date.now();


    // RELAY LOGIC: Queue and Process (with Back-pressure)
    if (relayCopy && downstreamDataPeers.length > 0) {
        relayChunkQueue.push({ type: 'file-chunk', chunk: relayCopy, index: idx });
        processRelayQueue();
    }

    // Calculate percent with safety check
    let percent = 0;
    if (meta && meta.total > 0) {
        percent = Math.min(100, Math.floor((receivedCount / meta.total) * 100));
    }

    const sourceLabel = upstreamDataConn ? `Relay(${upstreamDataConn.peer.substr(-4)})` : "Host";

    let progressText = `${percent}%`;

    if (meta && meta.size) {
        const totalMB = (meta.size / 1024 / 1024).toFixed(1);
        // Estimate current based on chunks
        const currentBytes = receivedCount * 16384;
        const currentMB = (currentBytes / 1024 / 1024).toFixed(1);
        progressText = `${currentMB}MB / ${totalMB}MB (${percent}%)`;
    }

    document.getElementById('loader-text').innerText = `${sourceLabel} 수신 중... ${progressText}`;
    updateLoader(percent);

    // [FIX] Use >= instead of === to handle edge cases where receivedCount slightly exceeds total
    if (receivedCount >= meta.total && transferState !== TRANSFER_STATE.PROCESSING) {
        // [FIX #4] Set guard BEFORE any async operation to prevent race conditions
        transferState = TRANSFER_STATE.PROCESSING;
        const processingFileName = meta.name; // Capture filename for validation
        const processingIndex = meta.index;   // [Fix] Capture track index for ACK

        // [New] Notify Host that we have this file now
        if (hostConn && hostConn.open && processingIndex !== undefined) {
            hostConn.send({ type: 'preload-ack', index: processingIndex });
            console.log(`[Guest] Confirmed cache for index ${processingIndex} to Host`);
        }

        // [Worker-OPFS] Finalize file
        timerWorker.postMessage({ command: 'OPFS_END', filename: meta.name, isPreload: false, sessionId: incomingSid });

        // Finalize UI/playback state will happen in Worker message handler
        return;
    }
}

async function handleFileWait(data) {
    console.log("[Guest] Relay has no data yet, waiting for forwarded data...");
    showToast("릴레이 대기 중... 잠시만 기다려주세요");

    // Mark that we're waiting for relay data
    window._waitingForRelayData = true;

    // Set timeout: If no data comes within 10 seconds, fall back to Host
    clearManagedTimer('relayWaitTimeout');
    managedTimers.relayWaitTimeout = setTimeout(() => {
        if (window._waitingForRelayData && receivedCount === 0) {
            console.log("[Guest] Relay wait timeout - falling back to Host");
            showToast("릴레이 응답 없음. Host에서 직접 수신...");
            window._waitingForRelayData = false;

            // Disconnect from relay
            if (upstreamDataConn) {
                upstreamDataConn.close();
                upstreamDataConn = null;
            }

            // Request file from Host
            if (hostConn && hostConn.open) {
                const recoveryFileName = window._pendingFileName || '';
                const recoveryIndex = window._pendingFileIndex !== undefined ? window._pendingFileIndex : currentTrackIndex;

                // VALIDATION: Don't send recovery request with invalid index
                if (recoveryIndex < 0 || recoveryIndex >= playlist.length) {
                    console.warn("[file-wait timeout] Invalid index, skipping recovery:", recoveryIndex);
                    showLoader(false);
                    return;
                }

                // Check if preload is in progress for this track
                if (preloadMeta && preloadMeta.index === recoveryIndex) {
                    console.log("[file-wait timeout] Preload in progress for this track, waiting...");
                    showToast("프리로드 완료 대기 중...");
                    return; // Let preload finish naturally
                }

                console.log("[file-wait timeout] Requesting from Host:", recoveryFileName, "index:", recoveryIndex);
                hostConn.send({
                    type: 'request-data-recovery',
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
        showToast("YouTube 모드에서는 수동 싱크가 작동하지 않습니다");
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

    if (data.isPlaying) play(compensatedTime + localOffset);
    else {
        stop();
        pausedAt = compensatedTime;
        loopUI();
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
    console.log("[Guest] Received youtube-play:", data);

    // 1. Stop any local audio/video first
    stop();

    // 2. [Reliability] Reset preload state when entering YouTube
    clearPreloadState();
    window._skipIncomingPreload = false;
    clearManagedTimer('prepareWatchdog');

    currentState = APP_STATE.PLAYING_YOUTUBE;
    // 3. Stop existing YouTube if playing
    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
        try { youtubePlayer.destroy(); } catch (e) { }
        youtubePlayer = null;
    }

    // 4. Sync track index
    if (data.index !== undefined) {
        currentTrackIndex = data.index;
        updatePlaylistUI();
    }

    // 4. Load YouTube (autoplay based on Host's command)
    showToast("YouTube 같이 보기 - 고급 오디오 효과가 비활성화됩니다");
    loadYouTubeVideo(data.videoId, data.playlistId, data.autoplay !== false, data.subIndex || 0);

    // 5. Hide Loader (Prevent hang from accidental file-prepare)
    showLoader(false);
}

async function handlePreloadStart(data) {
    clearManagedTimer('prepareWatchdog');

    // [Fix] Reliability: Match cache by Index OR Name (Fallback to currentTrackIndex)
    const matchIndex = (idx) => Number(idx) === Number(data.index);
    const matchName = (n) => n && data.name && n === data.name;

    const isCurrentlyPlaying = currentFileBlob && (matchIndex(currentTrackIndex) || matchName(meta?.name));
    const isNextPreloaded = nextFileBlob && (matchIndex(nextMeta?.index) || matchName(nextMeta?.name));
    const alreadyCachedLocally = isCurrentlyPlaying || isNextPreloaded;

    const sessionId = data.sessionId || 0;

    // Skip if Host explicitly said so, or if we detected cache ourselves
    if (data.skipped || alreadyCachedLocally) {
        console.log(`[Preload] Skipping session ${sessionId}`);

        // ✅ 세션별 상태 저장
        preloadSessionState.set(sessionId, { skipped: true });

        preloadChunks = [];
        preloadCount = 0;
        preloadMeta = { ...data, isSkipped: true };
        window._skipIncomingPreload = true;

        // Relay from whatever cache we have to downstream
        const sourceBlob = isNextPreloaded ? nextFileBlob : (currentFileBlob || null);

        if (downstreamDataPeers.length > 0) {
            console.log(`[Relay] Forwarding preload-start for cached track ${data.index} (relayed from this node)`);
            // [CRITICAL FIX] Always clear skipped=true for downstream peers because THIS node will send chunks!
            const forwardHeader = { ...data, skipped: false };
            downstreamDataPeers.forEach(p => { if (p.open) p.send(forwardHeader); });
        }

        if (sourceBlob) {
            relayPreloadFromCache(sourceBlob, data.index, data.sessionId);
        }
        return;
    }

    // ✅ 세션 상태 초기화
    preloadSessionState.set(sessionId, {
        skipped: false,
        progress: 0,
        total: data.total
    });

    console.log(`[Preload] Starting Worker-OPFS preload for: ${data.name}`);

    // [OPFS-Worker] Prepare preload file
    timerWorker.postMessage({ command: 'OPFS_START', filename: data.name, isPreload: true, size: CHUNK_SIZE });
    preloadFileOpfs.name = data.name;

    preloadChunks = [];
    preloadCount = 0;
    preloadMeta = data;
    window._skipIncomingPreload = false;

    if (downstreamDataPeers.length > 0) {
        downstreamDataPeers.forEach(p => { if (p.open) p.send(data); });
    }
}

async function handlePreloadChunk(data) {
    const sessionId = data.sessionId || 0;

    // ✅ 세션 상태 확인
    const sessionState = preloadSessionState.get(sessionId);
    if (sessionState?.skipped) {
        return; // 스킵된 세션의 청크 무시
    }

    if (window._skipIncomingPreload) return;

    const idx = data.index;
    const chunkCopy = new Uint8Array(data.chunk);

    // [FIX] Clone chunk for downstream BEFORE sending to worker (to avoid detachment)
    let fwdMsg = null;
    if (downstreamDataPeers.length > 0) {
        fwdMsg = { type: 'preload-chunk', chunk: new Uint8Array(chunkCopy), index: idx };
    }

    // [Worker-OPFS] Offload write
    timerWorker.postMessage({
        command: 'OPFS_WRITE',
        chunk: chunkCopy,
        index: idx,
        isPreload: true
    }, [chunkCopy.buffer]);
    preloadCount++;

    // ✅ 진행률 업데이트
    if (sessionState) {
        sessionState.progress = preloadCount;
    }

    if (fwdMsg && downstreamDataPeers.length > 0) {
        downstreamDataPeers.forEach(p => { if (p.open) p.send(fwdMsg); });
    }

    if (preloadMeta && preloadCount >= preloadMeta.total) {
        console.log("[Preload] All chunks received via Worker-OPFS. Finalizing...");
        timerWorker.postMessage({ command: 'OPFS_END', filename: preloadMeta.name, isPreload: true });
        // NOTE: We do NOT reset preloadCount to 0 here because it's needed for handlePreloadEnd's check.
        // It will be reset in clearPreloadState().
    }
}

async function handlePreloadEnd(data) {
    if (window._skipIncomingPreload) return;

    console.log("[Preload] End signal received for index:", data.index);

    if (preloadCount < (preloadMeta?.total || 0)) {
        console.warn(`[Preload] Incomplete! Got ${preloadCount}/${preloadMeta.total} chunks.`);
        return;
    }

    if (!nextFileBlob) {
        timerWorker.postMessage({ command: 'OPFS_END', filename: preloadMeta.name, isPreload: true, sessionId: data.sessionId });
    }

    // NOTIFY HOST
    if (hostConn && hostConn.open) {
        hostConn.send({ type: 'preload-ack', index: data.index });
    }
}

async function handlePlayPreloaded(data) {
    // Host Command: "Switch to what you downloaded!"
    console.log("Command: Play Preloaded Track, index:", data.index);

    // Skip if we already loaded this track via file-prepare
    if (window._preloadUsedForIndex === data.index) {
        console.log("[Guest] Already loaded track via file-prepare, skipping play-preloaded");
        window._preloadUsedForIndex = undefined; // Reset flag
        return;
    }

    currentTrackIndex = data.index;
    updatePlaylistUI(); // Update active highlight

    // [Fix] If Guest was in YouTube mode, stop it before loading file
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
        console.log("[Guest] Switching from YouTube to Preloaded Local Track");
        stopYouTubeMode();
    }

    // [FIX] Strict Index Verification: Ensure preloaded data belongs to the requested track
    const isPreloadTargetMatch = nextMeta && (nextMeta.index === data.index || nextMeta.name === data.name);

    if (nextFileBlob && isPreloadTargetMatch) {
        // 프리로드된 파일이 있으면 사용
        console.log("[Guest] Using preloaded file for track", data.index);
        await loadPreloadedTrack();

        // CRITICAL: Hide loader
        showLoader(false);

        // Mark that we already loaded this track (prevent duplicate load from following messages)
        window._preloadUsedForIndex = data.index;
        window._skipIncomingFile = true;

    } else {
        // 프리로드 없음 혹은 인덱스 불일치 - Host에게 파일 요청
        if (nextFileBlob && !isPreloadTargetMatch) {
            console.warn(`[Guest] Stale preload detected (ID mismatched). Found index: ${nextMeta ? nextMeta.index : 'N/A'}, Expected: ${data.index}`);
        }
        console.warn("[Guest] No preloaded file found for track", data.index, "- requesting from Host");
        showLoader(true, "파일 요청 중...");

        // Clear any stale state
        clearPreviousTrackState('play-preloaded fallback');

        // Request file from Relay (if available) or Host
        const trackName = data.name || playlist[data.index]?.name || '';
        window._pendingFileName = trackName;
        window._pendingFileIndex = data.index;

        if (upstreamDataConn && upstreamDataConn.open) {
            console.log("[Guest] Requesting file from Relay:", trackName);
            upstreamDataConn.send({ type: 'request-current-file' });
            showToast("릴레이에 파일 요청 중...");
        } else if (hostConn && hostConn.open) {
            // [FIX] Consistent Jitter for fallback request
            const jitter = Math.random() * 1000 + 200;
            console.log(`[PlayPreloaded] Delaying fallback recovery by ${Math.round(jitter)}ms`);
            setTimeout(() => {
                if (hostConn && hostConn.open && !nextFileBlob) {
                    console.log("[Guest] Requesting file from Host:", trackName, "index:", data.index);
                    hostConn.send({
                        type: 'request-data-recovery',
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

        showToast("프리로드 누락 - 파일 수신 중...");
    }
}

async function handleStatusSync(data) {
    // [FIX] Required Field Validation
    if (!validateMessage(data, ['playlistMeta', 'currentTrackIndex'])) return;

    // [Synchronization Logic] Playlist-Centric Model
    const { playlistMeta, currentTrackIndex: hostTrackIndex, isPlaying: hostIsPlayingAny } = data;

    // [FIX] Empty Playlist Defense
    if (!playlistMeta || playlistMeta.length === 0) {
        console.log("[StatusSync] Received empty playlist, clearing local state");
        playlist = [];
        currentTrackIndex = -1;
        updatePlaylistUI();
        stop();
        return;
    }

    // 1. Sync Playlist Structure if different
    const isPlaylistDifferent = JSON.stringify(playlist.map(it => it.name)) !== JSON.stringify(playlistMeta.map(it => it.name));
    if (isPlaylistDifferent) {
        console.log("[Sync] Playlist out of sync, updating...");
        playlist = playlistMeta;
        updatePlaylistUI();
    }

    // 2. Sync Track Index and Trigger Auto-Recovery if needed
    if (hostTrackIndex !== -1 && hostTrackIndex !== currentTrackIndex) {
        console.log(`[StrongSync] Index mismatch: Host(${hostTrackIndex}) vs Me(${currentTrackIndex}). Correcting...`);

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
                console.log("[Sync] Required track found in preload cache. Activating...");
                loadPreloadedTrack();
                return;
            }

            // Check if a preload is CURRENTLY in progress for this track
            const isOurPreload = preloadFileOpfs.name && (preloadMeta && (preloadMeta.index === hostTrackIndex || preloadMeta.name === item.name));

            // If it's a new track and we don't have it, ask for it
            if (!hasBlob && ((!meta || meta.name !== item.name))) {
                if (isOurPreload) {
                    console.log("[Sync] Track is being preloaded. Waiting for completion...");
                    showLoader(true, `파일 동기화 중: ${item.name}`);
                    window._waitingForPreload = true;
                    window._pendingFileIndex = hostTrackIndex;
                    return;
                }

                console.log("[Sync] Current track missing, requesting from host:", item.name);
                showLoader(true, `파일 동기화 중: ${item.name}`);
                clearPreviousTrackState('status-sync mismatch');

                // [Fix] If in YouTube mode, stop it for the new local track
                if (currentState === APP_STATE.PLAYING_YOUTUBE) stopYouTubeMode();

                if (hostConn && hostConn.open) {
                    const jitter = Math.random() * 1000 + 200;
                    console.log(`[Sync] Delaying recovery request by ${Math.round(jitter)}ms`);
                    setTimeout(() => {
                        // Final check before sending recovery: did it arrive via sync/preload while we waited?
                        const alreadyGotIt = currentFileBlob || nextFileBlob;
                        if (currentTrackIndex === hostTrackIndex && !alreadyGotIt) {
                            hostConn.send({
                                type: 'request-data-recovery',
                                nextChunk: 0,
                                fileName: item.name,
                                index: hostTrackIndex
                            });
                        } else if (alreadyGotIt) {
                            console.log("[Sync] Aborting recovery request: file arrived during jitter delay");
                            showLoader(false);
                        }
                    }, jitter);
                }
            }
        }
        else if (item && item.type === 'youtube') {
            if (currentState !== APP_STATE.PLAYING_YOUTUBE || currentTrackIndex !== prevIndex) {
                console.log("[Sync] Switching to YouTube mode for sync");
                // YouTube mode switch is usually handled by youtube-play message,
                // but this provides a fallback for late joiners.
            }
        }
    }
}



// --- Data Message Handlers ---

async function handleHeartbeat(data) {
    if (hostConn && hostConn.open) hostConn.send({ type: 'heartbeat-ack' });
}

async function handlePongLatency(data) {
    const ms = Date.now() - data.timestamp;
    latencyHistory.push(ms);
    if (latencyHistory.length > 10) latencyHistory.shift();
    lastLatencyMs = Math.min(...latencyHistory);
    const roleText = document.getElementById('role-text');
    if (roleText && myDeviceLabel !== 'GUEST' && myDeviceLabel !== 'HOST') {
        roleText.innerText = `${myDeviceLabel} (${Math.round(lastLatencyMs)}ms)`;
    }
}

async function handleWelcome(data) {
    document.getElementById('role-text').innerText = data.label;
}

async function handlePlay(data) {
    if (managedTimers.autoPlayTimer) {
        clearManagedTimer('autoPlayTimer');
    }

    // [StrongSync] Index Check
    if (data.index !== undefined && data.index !== currentTrackIndex) {
        console.warn(`[StrongSync] Play command for index ${data.index} received, but I'm on ${currentTrackIndex}. Switching...`);

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
                console.log("[StrongSync] Required track found in preload cache. Activating...");
                loadPreloadedTrack();
            } else if (!hasFile || (meta && meta.name !== item.name)) {
                // Check if currently preloading
                const isPreloadingThis = isPreloading && preloadMeta && (preloadMeta.index === currentTrackIndex || preloadMeta.name === item.name);
                if (isPreloadingThis) {
                    console.log("[StrongSync] Track is being preloaded. Waiting...");
                    showLoader(true, `파일 동기화 중: ${item.name}`);
                    window._waitingForPreload = true;
                    window._pendingFileIndex = currentTrackIndex;
                    window._pendingPlayTime = data.time;
                    return;
                }

                console.log("[StrongSync] Need file for new index, requesting...");
                window._pendingPlayTime = data.time; // Resume after download
                if (hostConn && hostConn.open) {
                    hostConn.send({
                        type: 'request-data-recovery',
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
    const isDownloading = loaderVisible || window._waitingForRelayData;
    if (isDownloading) {
        console.log("[Guest] Play command received but still downloading, queuing...");
        showToast("다운로드 완료 후 재생됩니다");
        window._pendingPlayTime = data.time;
        return;
    }
    const target = data.time + localOffset;
    if (currentState === APP_STATE.IDLE || Math.abs((Tone.now() - startedAt) - target) > 0.15) play(target);
}

async function handlePause(data) {
    if (data.time !== undefined) {
        pausedAt = data.time;
        const usesVideo = currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_STREAMING;
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

async function handleReverb(data) { setReverb(data.value); }
async function handleReverbType(data) { setReverbType(data.value); }
async function handleReverbDecay(data) { setReverbDecay(data.value); }
async function handleReverbPreDelay(data) { setReverbPreDelay(data.value); }
async function handleReverbLowCut(data) { setReverbLowCut(data.value); }
async function handleReverbHighCut(data) { setReverbHighCut(data.value); }

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

async function handlePlaylistUpdate(data) {
    playlist = data.list;
    updatePlaylistUI();
}

async function handleGlobalResyncRequest(data) {
    showToast("Host 요청: 동기화 재설정 중...");
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

    // [New] Guest can also fetch titles if missing
    if (ids && ids.length > 0) {
        fetchPlaylistSubTitles(playlistId, ids);
    }
}

async function handleYouTubeStop(data) {
    console.log("[Guest] Received youtube-stop, switching to local mode");
    if (currentState === APP_STATE.PLAYING_YOUTUBE) stopYouTubeMode();
    stop();
}

async function handleOperatorGrant(data) {
    isOperator = true;
    showToast("Operator 권한이 부여되었습니다.");
    document.getElementById('play-btn').disabled = false;
    document.getElementById('role-badge').innerHTML = `<span class="role-dot"></span> HOST SYNC (OP)`;
}

async function handleOperatorRevoke(data) {
    isOperator = false;
    showToast("Operator 권한이 회수되었습니다.");
    document.getElementById('play-btn').disabled = true;
    document.getElementById('role-badge').innerHTML = `<span class="role-dot"></span> HOST SYNC`;
}

async function handleDeviceListUpdate(data) {
    const amIStillConnected = data.list.find(p => p.id === myId);
    if (hostConn && !amIStillConnected) {
        console.error("Removed from Host List. Reloading...");
        location.reload();
        return;
    }
    const me = data.list.find(p => p.id === myId);
    if (me) myDeviceLabel = me.label;
    renderDeviceList(data.list);
}

async function handleSysToast(data) {
    showToast(data.message);
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
            console.warn(`[Network] Missing required field '${field}' in message:`, data.type);
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
    'sys-toast': handleSysToast,
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
            type: 'sync-response',
            time: t,
            isPlaying: isPlaying
        });
        console.log(`[Host] Sent fresh sync time (${t.toFixed(2)}s) to peer ${conn.peer.substr(-4)}`);
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
            console.error(`Error handling ${data.type}:`, e);
        }
    }
}


// --- Relay Functions ---

function connectToRelay(targetId) {
    const conn = peer.connect(targetId, {
        metadata: { type: 'data-relay', label: myId }
    });

    const FAIL_TIMEOUT = 10000;
    const connTimer = setTimeout(() => {
        if (!conn.open) {
            console.warn("Relay Connect Timeout");
            conn.close();
            upstreamDataConn = null;

            showToast("Relay 응답 없음. Host 직결 전환...");

            if (hostConn && hostConn.open) {
                const recoveryFileName = window._pendingFileName || (meta ? meta.name : '');
                const recoveryIndex = window._pendingFileIndex !== undefined ? window._pendingFileIndex : currentTrackIndex;

                console.log("[Recovery] Requesting from Host:", recoveryFileName, "index:", recoveryIndex, "received:", receivedCount);
                hostConn.send({
                    type: 'request-data-recovery',
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

        console.log("Requesting file from relay...");
        conn.send({ type: 'request-current-file' });
    });

    conn.on('close', () => {
        showToast("Relay Disconnected. Recovering...");
        upstreamDataConn = null;

        const totalExpected = meta?.total || 0;
        if (receivedCount < totalExpected) {
            if (hostConn && hostConn.open) {
                const recoveryFileName = meta?.name || window._pendingFileName || '';
                const recoveryIndex = window._pendingFileIndex !== undefined ? window._pendingFileIndex : currentTrackIndex;

                let firstMissing = 0;
                if (incomingChunks && incomingChunks.length > 0) {
                    for (let j = 0; j < incomingChunks.length; j++) {
                        if (!incomingChunks[j]) {
                            firstMissing = j;
                            break;
                        }
                    }
                } else {
                    firstMissing = receivedCount || 0;
                }

                showToast(`Recovering from chunk ${firstMissing}...`);
                hostConn.send({
                    type: 'request-data-recovery',
                    nextChunk: firstMissing,
                    fileName: recoveryFileName,
                    index: recoveryIndex
                });
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
            console.error("[YouTube] Nudge sync error:", e);
        }
        if (navigator.vibrate) navigator.vibrate(5);
        return;
    }

    // Debounce: Only broadcast after user stops nudging
    clearManagedTimer('syncDebounce');
    managedTimers.syncDebounce = setTimeout(() => {
        if (currentState !== APP_STATE.IDLE) {
            const target = (Tone.now() - startedAt);
            play(target);
            showToast("Sync Applied");
        }
    }, 300);
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
        console.log("Accepted Relay Connection from", conn.peer);
        showToast(`Relay: ${conn.peer.substr(-4)} 연결됨`);
        downstreamDataPeers.push(conn);
    });

    conn.on('data', async data => {
        if (data.type === 'request-current-file') {
            const currentTrackName = playlist[currentTrackIndex]?.name;
            const hasValidMeta = meta && meta.name && meta.name === currentTrackName;

            if (currentFileBlob && hasValidMeta) {
                showToast(`Relay Request: Serving blob to ${conn.peer.substr(-4)}`);
                unicastFile(conn, currentFileBlob);
            }
            else if (nextFileBlob && preloadMeta && preloadMeta.index === currentTrackIndex) {
                showToast(`Relay Request: Serving preloaded blob to ${conn.peer.substr(-4)}`);
                unicastFile(conn, nextFileBlob);
            }
            else if (preloadMeta && nextFileBlob) {
                showToast(`Relay Request: Serving preload to ${conn.peer.substr(-4)}`);
                unicastFile(conn, nextFileBlob);
            }
            else {
                console.log("[Relay] No data yet, telling downstream to wait...");
                conn.send({ type: 'file-wait', message: 'Relay waiting for data from upstream' });
                conn._waitingForDataRelay = true;
                showToast(`${conn.peer.substr(-4)}에게 대기 요청`);
            }
        }
    });

    conn._waitingForFileStart = false;

    conn.on('close', () => {
        downstreamDataPeers = downstreamDataPeers.filter(p => p !== conn);
    });
}

/**
 * [Optimization] Relays a preloaded file from local cache to downstream peers.
 */
async function relayPreloadFromCache(blob, index, sessionId) {
    if (!blob) {
        console.warn("[Relay] Cannot relay null blob for index:", index);
        return;
    }
    const CHUNK = 16384;
    const total = Math.ceil(blob.size / CHUNK);

    let fileName = "Preloaded Track";
    if (playlist[index]) fileName = playlist[index].name;
    else if (meta && meta.index === index) fileName = meta.name;
    else if (nextMeta && nextMeta.index === index) fileName = nextMeta.name;

    if (downstreamDataPeers.length === 0) return;

    console.log(`[Preload Relay] Relaying ${fileName} (${total} chunks) to ${downstreamDataPeers.length} peers`);

    for (let i = 0; i < total; i++) {
        const activeDownstream = downstreamDataPeers.filter(p => p.open);
        if (activeDownstream.length === 0) break;

        const start = i * CHUNK;
        const end = Math.min(start + CHUNK, blob.size);
        const chunkBlob = blob.slice(start, end);
        const chunkBuf = await chunkBlob.arrayBuffer();
        const chunk = new Uint8Array(chunkBuf);

        const chunkMsg = { type: 'preload-chunk', chunk: chunk, index: i };
        activeDownstream.forEach(p => p.send(chunkMsg));

        if (i % 10 === 0) await new Promise(r => setTimeout(r, 40));
    }

    const endMsg = { type: 'preload-end', name: fileName, index: index, sessionId: sessionId };
    downstreamDataPeers.forEach(p => {
        if (p.open) p.send(endMsg);
    });
    console.log(`[Preload Relay] Finished relaying index ${index}`);
}

function broadcastData(msg) {
    connectedPeers.forEach(p => {
        if (p.status === 'connected' && p.conn.open && p.isDataTarget !== false) {
            p.conn.send(msg);
        }
    });
}

function renderDeviceList(list) {
    const container = document.getElementById('device-list');
    container.innerHTML = '';

    list.forEach((p, idx) => {
        if (hostConn) {
            const statusClass = p.status === 'connected' ? 'active' : 'inactive';
            const statusText = p.status === 'connected' ? 'Connected' : 'Disconnected';
            container.innerHTML += `
                <div class="section-row">
                    <span class="d-name">
                        ${p.label} <span style="font-size:11px; opacity:0.5; margin-left:4px;">(${p.id.substr(-4)})</span>
                        ${p.isOp ? '<span style="color:var(--primary); font-size:10px; font-weight:bold; margin-left:4px;">OP</span>' : ''}
                    </span>
                    <span class="d-status ${statusClass}">${statusText}</span>
                </div>`;
        } else {
            const statusClass = p.status === 'connected' ? 'active' : 'inactive';
            const statusText = p.status === 'connected' ? 'Connected' : 'Disconnected';
            let opBtn = '';

            if (!p.isHost && p.status === 'connected') {
                opBtn = `<button class="btn-action ${p.isOp ? 'active' : ''}"
                     style="font-size:10px; padding:4px 8px; margin-right:8px; ${p.isOp ? 'background:var(--primary); color:white; border:none;' : ''}"
                     onclick="toggleOperator('${p.id}')">
                     ${p.isOp ? 'REVOKE' : 'GRANT'}
                 </button>`;
            }

            container.innerHTML += `
                <div class="section-row">
                    <span class="d-name">
                        ${p.label} <span style="font-size:11px; opacity:0.5; margin-left:4px;">(${p.id.substr(-4)})</span>
                        ${p.isOp ? '<span style="color:var(--primary); font-size:10px; font-weight:bold; margin-left:4px;">OP</span>' : ''}
                    </span>
                    <div style="display:flex; gap:4px; align-items:center;">
                        ${opBtn}
                        <span class="d-status ${statusClass}">${statusText}</span>
                    </div>
                </div>`;
        }
    });
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
    if (data.type === 'request-play') {
        if (managedTimers.autoPlayTimer) {
            clearManagedTimer('autoPlayTimer');
            showToast("자동 재생 취소됨 (OP)");
        }
        play(data.time);
        broadcast({ type: 'play', time: data.time });
    } else if (data.type === 'request-pause') {
        if (managedTimers.autoPlayTimer) {
            clearManagedTimer('autoPlayTimer');
        }
        pause();
        broadcast({ type: 'pause' });
    } else if (data.type === 'request-youtube-play') {
        console.log("[Host] OP requested YouTube play");
        if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
            try {
                youtubePlayer.playVideo();
                broadcast({ type: 'youtube-state', state: 1, time: youtubePlayer.getCurrentTime() });
            } catch (e) {
                console.error("[YouTube] OP play error:", e);
            }
        }
    } else if (data.type === 'request-youtube-pause') {
        console.log("[Host] OP requested YouTube pause");
        if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
            try {
                youtubePlayer.pauseVideo();
                broadcast({ type: 'youtube-state', state: 2, time: youtubePlayer.getCurrentTime() });
            } catch (e) {
                console.error("[YouTube] OP pause error:", e);
            }
        }
    } else if (data.type === 'request-track-change') {
        console.log("[Host] OP requested track change to:", data.index);
        playTrack(data.index);
    } else if (data.type === 'request-next-track') {
        console.log("[Host] OP requested next track");
        playNextTrack();
    } else if (data.type === 'request-prev-track') {
        console.log("[Host] OP requested prev track");
        playPrevTrack();
    } else if (data.type === 'request-skip-time') {
        console.log("[Host] OP requested skip time:", data.sec);
        skipTime(data.sec);
    } else if (data.type === 'request-seek') {
        console.log("[Host] OP requested seek to:", data.time);

        if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
            try {
                youtubePlayer.seekTo(data.time, true);
                broadcast({ type: 'youtube-state', state: youtubePlayer.getPlayerState(), time: data.time });
            } catch (e) {
                console.error("[YouTube] request-seek error:", e);
            }
            return;
        }

        if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) play(data.time); else pausedAt = data.time;
        broadcast({ type: 'play', time: data.time });
    } else if (data.type === 'request-eq-reset') {
        resetEQ();
    } else if (data.type === 'request-setting') {
        if (data.settingType === 'reverb') { setReverb(data.value); broadcast({ type: 'reverb', value: data.value }); }
        else if (data.settingType === 'reverb-type') { setReverbType(data.value); broadcast({ type: 'reverb-type', value: data.value }); }
        else if (data.settingType === 'reverb-decay') { setReverbDecay(data.value); broadcast({ type: 'reverb-decay', value: data.value }); }
        else if (data.settingType === 'reverb-predelay') { setReverbPreDelay(data.value); broadcast({ type: 'reverb-predelay', value: data.value }); }
        else if (data.settingType === 'reverb-lowcut') { setReverbLowCut(data.value); broadcast({ type: 'reverb-lowcut', value: data.value }); }
        else if (data.settingType === 'reverb-highcut') { setReverbHighCut(data.value); broadcast({ type: 'reverb-highcut', value: data.value }); }
        else if (data.settingType === 'eq') {
            const band = parseInt(data.band, 10);
            const val = parseFloat(data.value);
            setEQ(band, val, false, true);
            broadcast({ type: 'eq-update', band: band, value: val });
        }
        else if (data.settingType === 'preamp') {
            const val = parseFloat(data.value);
            setPreamp(val, false, true);
            broadcast({ type: 'preamp', value: data.value });
        }
        else if (data.settingType === 'stereo') { setStereoWidth(data.value); broadcast({ type: 'stereo-width', value: data.value }); }
        else if (data.settingType === 'vbass') { setVirtualBass(data.value); broadcast({ type: 'vbass', value: data.value }); }
    } else if (data.type === 'request-youtube-sub-seek') {
        console.log("[Host] OP requested YouTube sub-seek:", data.subIdx);
        if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer && youtubePlayer.playVideoAt) {
            try {
                youtubePlayer.playVideoAt(data.subIdx);
            } catch (e) {
                console.error("[YouTube] OP sub-seek error:", e);
            }
        }
    }
}

async function broadcastFile(file) {
    currentTransferSessionId++;
    const sessionId = currentTransferSessionId;

    const CHUNK = 16384;
    const total = Math.ceil(file.size / CHUNK);
    const header = { type: 'file-start', name: file.name, mime: file.type, total: total, size: file.size, index: currentTrackIndex, sessionId: sessionId };

    const getEligiblePeers = () => {
        return connectedPeers.filter(p => {
            const trackIdx = currentTrackIndex;
            const alreadyHasPreload = p.preloadedIndexes && p.preloadedIndexes.has(trackIdx);
            return (p.status === 'connected' && p.conn.open && p.isDataTarget !== false && !alreadyHasPreload);
        });
    };

    const eligiblePeers = getEligiblePeers();

    if (eligiblePeers.length === 0) {
        console.log("[broadcastFile] All peers have preload or no peers, skipping file transfer");
        return;
    }

    // [FIX] Session Guard: Prevent double-broadcast of the same file/session
    if (window._activeBroadcastSession === sessionId) return;
    window._activeBroadcastSession = sessionId;

    console.log(`[broadcastFile] Sending to ${eligiblePeers.length} peers (${connectedPeers.filter(p => p.status === 'connected').length - eligiblePeers.length} skipped due to preload)`);

    eligiblePeers.forEach(p => p.conn.send(header));

    for (let i = 0; i < total; i++) {
        // Robust Back-pressure: Wait for buffers to clear below 64KB across ALL peers
        // Max wait 30 seconds for safety
        const startWait = Date.now();
        while (true) {
            let congested = false;
            for (const p of eligiblePeers) {
                if (p.conn.dataChannel && p.conn.dataChannel.bufferedAmount > 64 * 1024) {
                    congested = true;
                    break;
                }
            }
            if (!congested || Date.now() - startWait > 30000) break;
            await new Promise(r => setTimeout(r, 50));
        }

        const start = i * CHUNK;
        const end = Math.min(start + CHUNK, file.size);
        const chunkBlob = file.slice(start, end);
        const chunkBuf = await chunkBlob.arrayBuffer();
        const chunk = new Uint8Array(chunkBuf);

        const chunkMsg = { type: 'file-chunk', chunk: chunk, index: i, sessionId: sessionId };

        for (const p of eligiblePeers) {
            try {
                if (p.conn.open) p.conn.send(chunkMsg);
            } catch (e) {
                console.warn(`[broadcastFile] Send failed for peer ${p.id.substr(-4)}:`, e);
            }
        }

        if (i % 50 === 0) await new Promise(r => setTimeout(r, 10));
    }

    const endMsg = { type: 'file-end', name: file.name, mime: file.type, sessionId: sessionId };
    eligiblePeers.forEach(p => {
        try {
            if (p.conn.open) p.conn.send(endMsg);
        } catch (e) { }
    });
}


async function unicastFile(conn, file, startChunkIndex = 0, sessionId = null) {
    if (!conn || !conn.open) {
        console.error("[Unicast] Connection is not open, cannot send file");
        showToast("연결 오류: 파일 전송 실패");
        return;
    }

    const effectiveSessionId = sessionId !== null ? sessionId : currentTransferSessionId;

    const CHUNK = 16384;
    const total = Math.ceil(file.size / CHUNK);

    const isResume = startChunkIndex > 0;
    const msgType = isResume ? 'file-resume' : 'file-start';
    console.log(`[Unicast] Sending ${msgType}: ${file.name}, chunk ${startChunkIndex}/${total} (SID: ${effectiveSessionId})`);

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
        console.error(`[Unicast] Failed to send ${msgType}:`, e);
        return;
    }

    await new Promise(r => setTimeout(r, 100));

    if (startChunkIndex > 0) {
        showToast(`Resuming transfer from ${startChunkIndex}...`);
    }

    try {
        for (let i = startChunkIndex; i < total; i++) {
            if (!conn.open) {
                console.warn(`[Unicast] Connection closed at chunk ${i}/${total}. Aborting.`);
                return;
            }

            try {
                // Robust Back-pressure for Unicast
                const startWait = Date.now();
                while (conn.dataChannel && conn.dataChannel.bufferedAmount > 64 * 1024) {
                    if (Date.now() - startWait > 30000) break;
                    await new Promise(r => setTimeout(r, 50));
                }
            } catch (bufferErr) {
                console.warn("[Unicast] Buffer check failed, continuing:", bufferErr);
            }

            const start = i * CHUNK;
            const end = Math.min(start + CHUNK, file.size);
            const chunkBlob = file.slice(start, end);
            const chunkBuf = await chunkBlob.arrayBuffer();
            const chunk = new Uint8Array(chunkBuf);

            try {
                conn.send({ type: 'file-chunk', chunk: chunk, index: i, sessionId: effectiveSessionId });
            } catch (sendErr) {
                console.warn(`[Unicast] Send failed at chunk ${i}:`, sendErr);
                return;
            }

            if (i % 50 === 0) {
                await new Promise(r => setTimeout(r, 10));
                if (i % 100 === 0) {
                    console.log(`[Unicast] Progress: ${i}/${total} chunks`);
                }
            }
        }

        if (conn.open) {
            conn.send({ type: 'file-end', name: file.name, mime: file.type, sessionId: effectiveSessionId });
            console.log("[Unicast] Transfer complete:", file.name);
        }

    } catch (e) {
        console.error("[Unicast] Transfer error:", e);
    }
}

function broadcast(msg) {
    connectedPeers.forEach(p => { if (p.status === 'connected' && p.conn.open) p.conn.send(msg); });
}

function updateLoader(percent) {
    const circle = document.getElementById('loader-ring');
    document.querySelector('.progress-ring').classList.remove('indeterminate');
    const radius = circle.r.baseVal.value;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - (percent / 100) * circumference;
    circle.style.strokeDashoffset = offset;
}

function showLoader(show, txt) {
    document.getElementById('loader').style.display = show ? 'flex' : 'none';
    if (txt) document.getElementById('loader-text').innerText = txt;
    if (show) {
        document.querySelector('.progress-ring').classList.add('indeterminate');
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
    broadcast({ type: 'global-resync-request' });
}

function loopUI() {
    const isPlaybackState = currentState === APP_STATE.PLAYING_VIDEO ||
        currentState === APP_STATE.PLAYING_STREAMING;

    if (isPlaybackState) {
        let isActuallyPlaying = (videoElement && !videoElement.paused);

        if (isActuallyPlaying) {
            const hasVideoSrc = videoElement && videoElement.src && videoElement.src.startsWith('blob:');
            const duration = hasVideoSrc ? videoElement.duration : 0;

            let t = getTrackPosition();

            if (duration > 0 && t > duration) t = duration;

            if (!isSeeking) {
                const slider = document.getElementById('seek-slider');
                if (slider) slider.value = t;
                const timeCurr = document.getElementById('time-curr');
                if (timeCurr) timeCurr.innerText = fmtTime(t);
            }
        }

        const now = Date.now();
        if (!window._lastEndedCheck || now - window._lastEndedCheck > 500) {
            window._lastEndedCheck = now;
            handleEnded();
        }

        requestAnimationFrame(loopUI);
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


window.playlist = playlist;
window.playTrack = playTrack;
window.updatePlaylistUI = updatePlaylistUI;
window.broadcast = broadcast;
window.broadcastFile = broadcastFile;
window.initAudio = initAudio;

window.toggleSurroundMode = toggleSurroundMode;
window.setSurroundChannel = setSurroundChannel;

async function loadPreloadedTrack() {
    if (!nextFileBlob) return;

    return new Promise(async (resolve, reject) => {
        try {
            await initAudio();
            currentFileBlob = nextFileBlob;

            const isVideo = nextMeta && (nextMeta.mime?.startsWith('video/') || (nextMeta.name && /\.(mp4|mkv|webm|mov)$/i.test(nextMeta.name)));

            // ALWAYS STREAMING
            setEngineMode(isVideo ? 'video' : 'streaming');

            const url = BlobURLManager.create(nextFileBlob);

            // Set up one-time listener for readiness
            const onReady = () => {
                videoElement.removeEventListener('canplaythrough', onReady);
                console.log("[Guest] Preloaded track ready via Streaming");
                resolve();
            };
            videoElement.addEventListener('canplaythrough', onReady);

            videoElement.src = url;

            videoElement.onloadedmetadata = () => {
                const dur = videoElement.duration;
                if (isFinite(dur)) {
                    document.getElementById('seek-slider').max = dur;
                    document.getElementById('time-dur').innerText = fmtTime(dur);
                }
                BlobURLManager.confirm(nextFileBlob);
            };
            videoElement.load();
            setupMediaSource();

            if (nextMeta && nextMeta.name) {
                updateTitleWithMarquee(nextMeta.name);
                document.getElementById('track-artist').innerText = `Track ${nextTrackIndex + 1}`;
            }

            document.getElementById('play-btn').disabled = !isOperator;

            clearPreloadState();

        } catch (e) {
            console.error("[Preload] Play failed:", e);
            showToast("프리로드 재생 실패 - 다시 로드합니다");
            clearPreloadState();
            if (hostConn && hostConn.open) {
                hostConn.send({ type: 'request-current-file' });
            }
            reject(e);
        }
    });
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

window.openHelpModal = openHelpModal;
window.closeHelpModal = closeHelpModal;

let myChatLabel = 'HOST';

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();

    if (!text) return;

    const sender = hostConn ? myDeviceLabel : 'HOST';
    myChatLabel = sender;

    addChatMessage(sender, text, true);

    const chatMsg = { type: 'chat', sender: sender, text: text };

    if (!hostConn) {
        broadcast(chatMsg);
    } else {
        hostConn.send(chatMsg);
    }

    input.value = '';
}

function addChatMessage(sender, text, isMine) {
    const container = document.getElementById('chat-messages');

    const empty = container.querySelector('.chat-empty');
    if (empty) empty.remove();

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${isMine ? 'mine' : 'others'}`;
    bubble.innerHTML = `
        <div class="chat-sender">${escapeHtml(sender)}</div>
        <div class="chat-text">${parseMessageContent(text)}</div>
    `;

    container.appendChild(bubble);

    container.scrollTop = container.scrollHeight;
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
            result += `<button class="chat-youtube-btn" onclick="loadYouTubeFromChat('${safeUrl}')">▶ 재생</button>`;
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
    } else if (currentState === APP_STATE.PLAYING_VIDEO) {
        const video = document.getElementById('main-video');
        if (video) {
            video.currentTime = seconds;
            showToast(`${fmtTime(seconds)}로 이동`);
        }
    } else if (videoElement && videoElement.src) {
        stop();
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
    broadcast({ type: 'playlist-update', list: metaList });

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

window.parseMessageContent = parseMessageContent;
window.seekToTime = seekToTime;
window.loadYouTubeFromChat = loadYouTubeFromChat;
window.insertEmoji = insertEmoji;

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

function updateChatBadgeDisplay() {
    const badge = document.getElementById('chat-preview-badge');
    if (!badge) return;

    if (unreadChatCount > 0) {
        badge.textContent = unreadChatCount > 9 ? '9+' : unreadChatCount;
        badge.classList.add('show');
    } else {
        badge.classList.remove('show');
    }
}

function updateChatPreviewText() {
    const previewText = document.getElementById('chat-preview-text');
    if (previewText && lastChatSender && lastChatText) {
        previewText.textContent = `${lastChatSender}: ${lastChatText}`;
    }
}

function incrementUnread() {
    if (!isChatDrawerOpen) {
        unreadChatCount++;
        updateChatBadgeDisplay();
    }
}

function clearUnread() {
    unreadChatCount = 0;
    updateChatBadgeDisplay();
}

const originalAddChatMessage = addChatMessage;
addChatMessage = function (sender, text, isMine) {
    originalAddChatMessage(sender, text, isMine);
    lastChatSender = sender;
    lastChatText = text;
    updateChatPreviewText();

    if (!isMine) {
        incrementUnread();
    }
};

const originalSwitchTab = switchTab;
switchTab = function (tabId) {
    originalSwitchTab(tabId);
    if (isChatDrawerOpen) {
        toggleChatDrawer();
    }

    const miniPlayer = document.getElementById('yt-mini-player');
    if (miniPlayer) {
        if (tabId === 'settings' && currentState === APP_STATE.PLAYING_YOUTUBE) {
            miniPlayer.style.display = 'none';
        } else {
            miniPlayer.style.display = 'none';
        }

        if (tabId === 'play' && currentState === APP_STATE.PLAYING_YOUTUBE) {
            miniPlayer.style.display = 'none';
        }
    }
};

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

function updateChatPreview(sender, text) {
    const previewText = document.getElementById('chat-preview-text');
    if (previewText && sender && text) {
        previewText.textContent = `${sender}: ${text}`;
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

window.sendChatMessage = sendChatMessage;
window.addChatMessage = addChatMessage;
window.toggleChatDrawer = toggleChatDrawer;
window.updateChatYouTube = updateChatYouTube;

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
    broadcast({ type: 'playlist-update', list: metaList });

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
    window._currentYouTubeSessionId = currentSessionId;

    stopAllMedia();
    setEngineMode('youtube');

    showToast("YouTube 같이 보기 - 고급 오디오 효과가 비활성화됩니다");

    document.body.classList.add('mode-video');

    const videoElement = document.getElementById('main-video');
    videoElement.style.display = 'none';

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
        if (!window._ytScriptLoading) {
            window._ytScriptLoading = true;
            const tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';

            // ✅ 추가: YouTube API 로딩 에러 핸들링
            tag.onload = () => console.log('[YouTube] API script loaded');
            tag.onerror = () => {
                console.error('[YouTube] Failed to load API script');
                window._ytScriptLoading = false;
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

    updateTitleWithMarquee('YouTube Video');
    document.getElementById('track-artist').innerText = playlistId ? '플레이리스트 재생 중' : '재생 중';

    document.getElementById('play-btn').disabled = false;

    const fsBtn = document.querySelector('.fullscreen-btn');
    if (fsBtn) fsBtn.style.setProperty('display', 'none', 'important');

    setTimeout(() => refreshYouTubeDisplay(), 500);

    console.log("[YouTube] Loaded:", videoId || playlistId, "autoplay:", autoplay);
}

function initYouTubePlayer(videoId, playlistId = null, autoplay = true, subIndex = 0) {
    // [FIX] Safety Guard: Ensure we are still in YouTube mode when player initializes
    if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
        console.warn("[YouTube] initYouTubePlayer aborted - not in PLAYING_YOUTUBE state");
        return;
    }
    if (youtubePlayer && youtubePlayer.loadVideoById) {
        console.log("[YouTube] Re-using existing player instance");
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
            console.warn("[YouTube] Failed to reuse player, recreating...", e);
            const container = document.getElementById('youtube-player-container');
            if (container) container.innerHTML = '<div id="youtube-player"></div>';
        }
    }

    const playerVars = {
        autoplay: autoplay ? 1 : 0,
        controls: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1
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
    console.log("[YouTube] Player ready");

    if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
        console.log("[YouTube] onPlayerReady skipped - mode changed");
        return;
    }

    if (managedTimers.youtubeUILoop) clearInterval(managedTimers.youtubeUILoop);
    managedTimers.youtubeUILoop = setInterval(updateYouTubeUI, 500);

    // [FIX] Ensure ONLY Host runs the sync loop
    if (managedTimers.youtubeSyncLoop) clearInterval(managedTimers.youtubeSyncLoop);
    if (!hostConn) {
        managedTimers.youtubeSyncLoop = setInterval(broadcastYouTubeSync, 3000);
    } else {
        console.log("[YouTube] Guest mode: sync loop disabled");
    }

    // [Sync] Apply current master volume to YouTube player immediately
    setVolume(masterVolume);
}

function onYouTubePlayerStateChange(event) {
    if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
        console.log("[YouTube] StateChange skipped - not in YouTube mode");
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
        currentState = APP_STATE.IDLE;

        if (!hostConn) {
            console.log("[YouTube] Ended, playing next track...");
            playNextTrack();
        }
    }

    if (!hostConn && youtubePlayer && youtubePlayer.getCurrentTime) {
        broadcast({
            type: 'youtube-state',
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
            if (!window._ytIOSWatchdog) window._ytIOSWatchdog = Date.now();
            if (Date.now() - window._ytIOSWatchdog > 3000) {
                showYouTubeSyncOverlay(true);
            }
        } else {
            window._ytIOSWatchdog = null;
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
        window._ytIOSWatchdog = null;
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
                                        type: 'youtube-sub-title-update',
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
            type: 'youtube-sync',
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
            console.log(`[YouTube Sync] Sub-index change: ${currentYouTubeSubIndex} -> ${hostSubIndex}`);
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
            console.log(`[YouTube Sync] Drift ${drift.toFixed(1)}s, seeking to ${compensatedTime.toFixed(1)}s`);
            youtubePlayer.seekTo(compensatedTime, true);
        }

        if (youtubePlayer.getPlayerState && youtubePlayer.playVideo && youtubePlayer.pauseVideo) {
            const currentState = youtubePlayer.getPlayerState();
            if (hostState === 1 && currentState !== 1) {
                youtubePlayer.playVideo();
            } else if (hostState === 2 && currentState !== 2) {
                youtubePlayer.pauseVideo();
            }
        }
    } catch (e) {
        console.error("[YouTube Sync] Error:", e);
    }
}

function refreshYouTubeDisplay() {
    const container = document.getElementById('youtube-player-container');
    if (!container || currentState !== APP_STATE.PLAYING_YOUTUBE) return;

    console.log("[YouTube] Refreshing display to prevent black screen...");
    const iframe = container.querySelector('iframe');

    container.style.display = 'none';
    container.offsetHeight;
    container.style.display = 'block';

    if (iframe) {
        iframe.style.visibility = 'hidden';
        iframe.offsetHeight;
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
    // [FIX] Avoid IDLE state if we are transitioning TO another state
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
        setState(APP_STATE.IDLE);
    }

    if (managedTimers.youtubeUILoop) clearInterval(managedTimers.youtubeUILoop);
    if (managedTimers.youtubeSyncLoop) clearInterval(managedTimers.youtubeSyncLoop);

    if (youtubePlayer) {
        try {
            console.log("[YouTube] Destroying player instance...");
            youtubePlayer.stopVideo();
            youtubePlayer.destroy();
        } catch (e) { }
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
    }

    const fsBtn = document.querySelector('.fullscreen-btn');
    if (fsBtn) {
        fsBtn.style.removeProperty('display');
        fsBtn.style.display = '';
    }

    updateChatYouTube(false);

    console.log("[YouTube] Mode stopped, visualizer restored");
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

window.openMediaSourcePopup = openMediaSourcePopup;
window.closeMediaSourcePopup = closeMediaSourcePopup;
window.openYouTubePopup = openYouTubePopup;
window.closeYouTubePopup = closeYouTubePopup;
window.loadYouTubeFromInput = loadYouTubeFromInput;

async function loadDemoMedia() {
    try {
        const response = await fetch('dummy_audio.mp3');
        const blob = await response.blob();
        const file = new File([blob], 'Loyal_ODESZA_Loyal.mp3', { type: 'audio/mpeg' });

        meta = { name: file.name, size: file.size, type: file.type, index: 0, total: 1 };
        playlist = [{
            type: 'audio',
            file: file,
            name: file.name,
            title: file.name
        }];
        updatePlaylistUI();

        // Host locally processes it
        currentFileBlob = file;
        finalizeFileProcessing(file);

        showToast("데모 미디어가 로드되었습니다.");
    } catch (e) {
        console.error("Demo load failed:", e);
        showToast("데모 로드 실패");
    }
}
window.loadDemoMedia = loadDemoMedia;

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
            console.error('[YouTube Preview] Error:', e);
            previewContainer.style.display = 'none';
            statusText.style.display = 'block';
            statusText.innerText = '영상 정보를 불러올 수 없습니다';
            statusText.style.color = '#ef4444';
            setPlayBtnEnabled(false);
        }
    }, 500);
}

window.fetchYouTubePreview = fetchYouTubePreview;

document.getElementById('seek-slider').addEventListener('mousedown', function () {
    isSeeking = true;
});

document.getElementById('seek-slider').addEventListener('touchstart', function () {
    isSeeking = true;
}, { passive: true });

document.getElementById('seek-slider').addEventListener('input', function () {
    isSeeking = true;
    const seekTime = parseFloat(this.value);
    document.getElementById('time-curr').innerText = fmtTime(seekTime);

    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
        try {
            youtubePlayer.seekTo(seekTime, true);
        } catch (e) {
            console.error("[YouTube] Seek error:", e);
        }
    }
});

document.getElementById('seek-slider').addEventListener('change', function () {
    isSeeking = false;
    const seekTime = parseFloat(this.value);

    console.log("[Seek] Final position:", seekTime);

    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
        if (!hostConn) {
            broadcast({ type: 'youtube-sync', time: seekTime, state: youtubePlayer.getPlayerState() });
        }
    } else {
        // Local mode
        if (!hostConn) {
            play(seekTime);
            broadcast({ type: 'play', time: seekTime });
        } else if (isOperator) {
            hostConn.send({ type: 'request-play', time: seekTime });
        }
    }
});

document.getElementById('seek-slider').addEventListener('mouseup', function () {
    isSeeking = false;
});

document.getElementById('seek-slider').addEventListener('touchend', function () {
    isSeeking = false;
});

// --- Relay Queue Processor (Back-pressure Control) ---
async function processRelayQueue() {
    if (isRelaying) return;
    isRelaying = true;

    while (relayChunkQueue.length > 0) {
        const openPeers = downstreamDataPeers.filter(p => p.open);
        if (openPeers.length === 0) {
            relayChunkQueue = []; // No downstream peers, clear queue
            break;
        }

        // Check back-pressure: find slowest peer's bufferedAmount
        let maxBuffered = 0;
        openPeers.forEach(p => {
            // PeerJS DataConnection holds the underlying RTCDataChannel in 'dataChannel'
            const dc = p.dataChannel;
            if (dc && dc.bufferedAmount > maxBuffered) {
                maxBuffered = dc.bufferedAmount;
            }
        });

        if (maxBuffered > MAX_BUFFER_THRESHOLD) {
            // Buffer too high, wait 50ms and check again
            await new Promise(resolve => setTimeout(resolve, 50));
            continue;
        }

        // Buffer safe, send one chunk from queue
        const fwdMsg = relayChunkQueue.shift();
        if (fwdMsg) {
            openPeers.forEach(p => {
                try {
                    p.send(fwdMsg);
                } catch (e) {
                    console.error("[Relay] Send failed:", e);
                }
            });
        }
    }

    isRelaying = false;
}

// End of Script

