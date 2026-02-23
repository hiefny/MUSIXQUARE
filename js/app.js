/**
 * ============================================================================
 * MUSIXQUARE - Multi-Device Synchronized Audio Player
 * ============================================================================
 * Multi-device P2P synchronized surround audio system web application.
 *
 * [DEPENDENCIES]
 * - Tone.js (Audio Engine)
 * - PeerJS (WebRTC P2P)
 * - (This build intentionally avoids QR/link onboarding)
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
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const IOS_STARTUP_BIAS = 0; // Reset to 0 as Tone.Player handles precision.

/**
 * [Viewport-fit Strategy]
 * viewport-fit=cover is set directly in the HTML <meta> tag to avoid
 * reflow-induced layout jitter on PWA cold starts.
 * Android removes it synchronously in a <head> inline script.
 */

/**
 * [UX] Disable iOS pinch-zoom gesture (app-like behavior)
 * NOTE: Disabling zoom can reduce accessibility. Remove if you want to allow zoom.
 */
function preventIOSPinchZoom() {
    if (!IS_IOS) return;
    ["gesturestart", "gesturechange", "gestureend"].forEach((evt) => {
        document.addEventListener(evt, (e) => e.preventDefault(), { passive: false });
    });
}
preventIOSPinchZoom();

// [iOS] Overscroll edge guard removed.
// CSS `overscroll-behavior-y: contain` on .tab-content handles this natively
// without the side-effect of blocking touch gestures at scroll edges.


/**
 * [Layout] Platform detection and CSS class hooks.
 *
 * Body height is governed entirely by CSS (100dvh with 100vh fallback).
 * Safe-area insets are handled via CSS env(safe-area-inset-*).
 * viewport-fit=cover is added only on iOS for notch handling.
 */

function isStandaloneDisplayMode() {
    try {
        if (window.navigator && window.navigator.standalone) return true;
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (_) { /* ignore */ }
    return false;
}

/**
 * [Layout] Viewport height CSS var (--app-height)
 *
 * Safe-area insets (notch/home-indicator) are handled purely in CSS via:
 *   env(safe-area-inset-top/right/bottom/left)
 *
 * We only manage --app-height in JS to avoid legacy 100vh quirks in some
 * installed PWA / WebView contexts.
 */
let _appHeightRaf = 0;

let _lastSoftKeyHeight = 0;

function updateAppHeightNow() {
    const root = document.documentElement;

    // Optional hooks (CSS targeting)
    try {
        if (IS_IOS) root.classList.add('ios');
        if (IS_ANDROID) root.classList.add('android');
        if (IS_IOS && isStandaloneDisplayMode()) root.classList.add('ios-standalone');
        if (isStandaloneDisplayMode()) root.classList.add('standalone');
    } catch (_) { /* ignore */ }

    const de = document.documentElement;
    const vv = window.visualViewport;
    const isStandalone = isStandaloneDisplayMode();

    let isLandscape = false;
    try {
        isLandscape = !!(window.matchMedia && window.matchMedia('(orientation: landscape)').matches);
    } catch (_) {
        isLandscape = (window.innerWidth > window.innerHeight);
    }

    // --- Collect all available height signals ---
    let validHeights = [];
    if (vv && Number.isFinite(vv.height) && vv.height > 0) validHeights.push(Math.round(vv.height));
    if (Number.isFinite(window.innerHeight) && window.innerHeight > 0) validHeights.push(Math.round(window.innerHeight));
    if (de && Number.isFinite(de.clientHeight) && de.clientHeight > 0) validHeights.push(Math.round(de.clientHeight));

    let h = validHeights.length > 0 ? Math.min(...validHeights) : 0;

    // --- Android: Detect if viewport STILL extends behind system bar ---
    // (Happens when native app forces fullscreen regardless of viewport-fit)
    let softKeyHeight = 0;
    const scr = window.screen || {};

    if (IS_ANDROID && isLandscape) {
        // Strategy 1: outerHeight vs innerHeight
        if (Number.isFinite(window.outerHeight) && window.outerHeight > 0 &&
            Number.isFinite(window.innerHeight) && window.innerHeight > 0) {
            const delta = Math.round(window.outerHeight - window.innerHeight);
            if (delta < 0) {
                softKeyHeight = Math.abs(delta);
            }
        }

        // Strategy 2: screen.availHeight/availWidth deltas
        if (softKeyHeight === 0 && scr.availHeight != null && scr.availWidth != null) {
            const dH = Math.round((scr.height || 0) - (scr.availHeight || 0));
            if (dH > 0 && dH < 150) {
                softKeyHeight = dH;
            }
            if (softKeyHeight === 0) {
                const dW = Math.round((scr.width || 0) - (scr.availWidth || 0));
                if (dW > 0 && dW < 150 && dH <= 0) {
                    softKeyHeight = 0;
                }
            }
        }

        // Strategy 3: Hardcoded 48dp fallback
        if (softKeyHeight === 0) {
            const scrDimH = Math.min(scr.height || Infinity, scr.width || Infinity);
            if (Number.isFinite(scrDimH) && scrDimH > 100) {
                if (Math.abs(h - scrDimH) < 4) {
                    softKeyHeight = 48; // 48dp standard nav bar
                }
            }
        }

        // Clamp to reasonable range
        if (softKeyHeight > 120) softKeyHeight = 48;
        if (softKeyHeight < 0) softKeyHeight = 0;

        // Stability: keep previous detection if in same orientation
        if (softKeyHeight > 0) {
            _lastSoftKeyHeight = softKeyHeight;
        } else if (_lastSoftKeyHeight > 0 && isLandscape) {
            softKeyHeight = _lastSoftKeyHeight;
        }

        // Apply compensation
        if (softKeyHeight > 0 && h > softKeyHeight) {
            h -= softKeyHeight;
            log.info(`[Viewport] Android landscape softkey compensation: ${softKeyHeight}px`);
        }
    } else if (!isLandscape) {
        // Reset cache when back to portrait
        _lastSoftKeyHeight = 0;
    }

    // --- iOS standalone fix ---
    if (IS_IOS && isStandalone && !isLandscape && window.screen &&
        Number.isFinite(window.screen.height) && window.screen.height > 0) {
        h = Math.max(h, Math.round(window.screen.height));
    }

    // --- Apply CSS variables ---
    if (h > 0) {
        try { root.style.setProperty('--app-height', `${h}px`); } catch (_) { /* ignore */ }
    }

    // --safe-nav-bottom: pushes fixed bottom elements above the system nav bar
    const navBottom = (IS_ANDROID && isLandscape && softKeyHeight > 0) ? softKeyHeight : 0;
    try { root.style.setProperty('--safe-nav-bottom', `${navBottom}px`); } catch (_) { /* ignore */ }
}

function scheduleAppHeightUpdate() {
    if (_appHeightRaf) return;
    try {
        _appHeightRaf = requestAnimationFrame(() => {
            _appHeightRaf = 0;
            try { updateAppHeightNow(); } catch (_) { /* ignore */ }
        });
    } catch (_) {
        _appHeightRaf = 0;
        try { updateAppHeightNow(); } catch (_) { /* ignore */ }
    }
}

// Stub for backward compatibility
function freezeLayoutMetricsOnce() { scheduleAppHeightUpdate(); }

(function initPlatformAndHeight() {
    const run = () => {
        scheduleAppHeightUpdate();
        if (IS_ANDROID) {
            setTimeout(scheduleAppHeightUpdate, 500);
            setTimeout(scheduleAppHeightUpdate, 1500);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
        run();
    }

    try {
        window.addEventListener('resize', () => {
            scheduleAppHeightUpdate();
        }, { passive: true });
        window.addEventListener('orientationchange', () => {
            scheduleAppHeightUpdate();
            if (IS_ANDROID) setTimeout(scheduleAppHeightUpdate, 500);
        }, { passive: true });
        window.addEventListener('pageshow', scheduleAppHeightUpdate, { passive: true });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') scheduleAppHeightUpdate();
        });
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', scheduleAppHeightUpdate, { passive: true });
            window.visualViewport.addEventListener('scroll', scheduleAppHeightUpdate, { passive: true });
        }
    } catch (_) { /* ignore */ }
})();

/**
 * [Robustness] Session ID Normalization
 * - transfer.worker.js의 OPFS lock은 sessionId가 'number & integer' 여야 합니다.
 * - PeerJS/DOM 등에서 string으로 들어오는 경우가 있어 항상 정수로 강제합니다.
 * - 유효하지 않으면 0을 반환합니다(0은 'no-session' sentinel).
 */
const _warnedBadSessionIds = new Set();
function validateSessionId(id, strict = false) {
    const n = Number(id);
    const sid = Number.isFinite(n) ? Math.trunc(n) : 0;

    const ok = Number.isSafeInteger(sid) && sid > 0;
    if (!ok) {
        // Avoid log spam (same bad value repeated)
        const key = String(id);
        // Prevent unbounded growth if an attacker/bug keeps sending random values
        // (edge-case: malformed peers / reconnect loops)
        if (_warnedBadSessionIds.size > 200) _warnedBadSessionIds.clear();
        if (!_warnedBadSessionIds.has(key)) {
            _warnedBadSessionIds.add(key);
            log.warn(`[Session] Invalid sessionId (${typeof id}):`, id);
        }
        if (strict) {
            throw new Error(`Invalid sessionId: ${id}`);
        }
        return 0;
    }
    return sid;
}

/**
 * [Worker] Centralized Protocol Wrapper
 * Routes commands to either SyncWorker (timers) or TransferWorker (OPFS)
 *
 * NOTE:
 * - OPFS_* 명령은 transfer.worker.js 내부에서 sessionId 타입(number/integer)을 강하게 요구합니다.
 * - 아직 Worker가 초기화되기 전에도 호출될 수 있으므로 window.syncWorker / window.transferWorker를 사용합니다.
 */
function postWorkerCommand(payload, transfers) {
    if (!payload || !payload.command) return;

    const cmd = payload.command;

    // OPFS commands require filename + valid numeric sessionId.
    // Exclude RESET/CLEANUP from strict session enforcement.
    if (cmd.startsWith('OPFS_') && cmd !== 'OPFS_RESET' && cmd !== 'OPFS_CLEANUP') {
        if (!payload.filename) log.warn(`[Worker] Missing filename in ${cmd}`);

        payload.sessionId = validateSessionId(payload.sessionId);

        // For critical write-path operations, never send with sid=0 (prevents cross-session corruption).
        const isCriticalOp = (cmd === 'OPFS_START' || cmd === 'OPFS_WRITE' || cmd === 'OPFS_END');
        if (isCriticalOp && !payload.sessionId) {
            log.error(`[Worker] Blocked ${cmd}: invalid sessionId`, payload);
            return;
        }
    }

    if (cmd.startsWith('OPFS_')) {
        const tw = window.transferWorker;
        if (tw && typeof tw.postMessage === 'function') {
            tw.postMessage(payload, transfers);
        } else {
            log.warn(`[Worker] TransferWorker not ready. Dropping command: ${cmd}`);
        }
    } else {
        const sw = window.syncWorker;
        if (sw && typeof sw.postMessage === 'function') {
            sw.postMessage(payload, transfers);
        } else {
            log.warn(`[Worker] SyncWorker not ready. Dropping command: ${cmd}`);
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
            // iOS 감지: 별도 토스트는 표시하지 않습니다.
            log.info(`[Compatibility] iOS detected. IOS_STARTUP_BIAS=${IOS_STARTUP_BIAS}`);
        }
    }, 1500);
}

// Run checks on startup
checkSystemCompatibility();

/**
 * [PWA] Service Worker Registration (App Shell Cache)
 * - HTTPS(또는 localhost)에서만 동작
 * - 업데이트 감지 시 사용자에게 "새로고침" 안내 후 적용
 */
let _swReloading = false;
let _swWantsReload = false;

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return;

    // Use an absolute URL derived from the current location to avoid path confusion
    const swUrl = new URL('service-worker.js', window.location.href);

    try {
        const reg = await navigator.serviceWorker.register(swUrl, { scope: './' });
        log.debug('[PWA] Service worker registered:', reg.scope);

        // Listen for controller changes only when we explicitly want to reload.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!_swWantsReload || _swReloading) return;
            _swReloading = true;
            window.location.reload();
        });

        // Update flow
        reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (!newWorker) return;

            newWorker.addEventListener('statechange', async () => {
                // "installed" with an existing controller means: update is ready
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    try {
                        const r = await showDialog({
                            title: '업데이트',
                            message: '새 버전이 준비되었습니다. 새로고침하면 업데이트가 적용됩니다.',
                            buttonText: '새로고침',
                            // 사용자가 실수로 배경 클릭/ESC로 닫으면 업데이트가 강제 적용되는 문제 방지
                            dismissible: true
                        });

                        // '확인/새로고침' 버튼을 눌렀을 때만 진행
                        if (r && r.action !== 'ok') return;

                        _swWantsReload = true;
                        // Ask the waiting SW to activate immediately
                        if (reg.waiting) {
                            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                        } else {
                            // Fallback: reload directly (some browsers may not expose waiting)
                            if (!_swReloading) {
                                _swReloading = true;
                                window.location.reload();
                            }
                        }
                    } catch (_) {
                        // If dialog fails, do nothing (best effort)
                    }
                }
            });
        });

        // Proactively check for updates (best effort)
        try { await reg.update(); } catch (_) { }

    } catch (err) {
        log.warn('[PWA] Service worker registration failed:', err?.message || err);
    }
}

window.addEventListener('load', () => {
    // Delay registration slightly so it doesn't compete with critical startup work
    setTimeout(() => { registerServiceWorker(); }, 500);

    // [Diagnostics] Detect CDN/script load failures (common in in-app webviews / captive portals)
    setTimeout(() => {
        try {
            const missing = [];
            if (!window.Tone) missing.push('Tone.js');
            if (!window.Peer) missing.push('PeerJS');

            if (missing.length) {
                showDialog({
                    title: '필수 라이브러리 로드 실패',
                    message: `${missing.join(', ')} 를(을) 불러오지 못했어요.

가능한 원인:
- 인터넷 연결 불안정 / 차단
- 인앱(WebView) 보안 정책(CSP)으로 외부 스크립트 차단

해결 방법:
- 네트워크를 확인한 뒤 새로고침
- 운영 환경에서는 Tone.js/PeerJS를 동일 도메인에 로컬로 포함(번들링)해 주세요.`,
                    buttonText: '확인',
                    dismissible: true
                });
            }
        } catch (_) {
            // best-effort only
        }
    }, 2500);
});


// ============================================================================
// [SECTION] AUDIO ENGINE - Tone.js Nodes
// Dependencies: Tone.js CDN
// ============================================================================
let toneSplit, toneMerge;
let gainL, gainR, masterGain;
let reverb, rvbLowCut, rvbHighCut, rvbCrossFade, eqNodes = [];
let playerNode = null;   // Transient BufferSource for precise start
let currentAudioBuffer = null; // Decoded PCM data in RAM
let vbFilter, vbCheby, vbPostFilter, vbGain;
let preamp, widener;
let globalLowPass = null;
let analyser;

// Audio init race guard (prevents double graph creation on rapid user actions)
let _initAudioPromise = null;

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

    try {
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
    } finally {
        _isStateTransitioning = false;
    }

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
        // YouTube uses a different clock; avoid accidentally capturing stale Tone.now()-based time.
        if (oldState === APP_STATE.PLAYING_YOUTUBE) {
            try {
                if (youtubePlayer && typeof youtubePlayer.getCurrentTime === 'function') {
                    const t = Number(youtubePlayer.getCurrentTime());
                    pausedAt = (Number.isFinite(t) && t >= 0) ? t : 0;
                } else {
                    pausedAt = 0;
                }
            } catch (_) {
                pausedAt = 0;
            }
        } else {
            pausedAt = getTrackPosition();
        }
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

    // [Simplified] Calculate from Tone.now() and add offsets dynamically.
    // IMPORTANT:
    // - startedAt can be 0 legitimately (e.g., right after AudioContext starts).
    // - Using (startedAt !== 0) incorrectly treats that valid state as "unset".
    // - We instead treat any finite number as valid.
    const startedAtValid = (typeof startedAt === 'number' && Number.isFinite(startedAt));
    if (startedAtValid && typeof Tone !== 'undefined' && Tone && typeof Tone.now === 'function') {
        pos = (Tone.now() - startedAt) + localOffset + autoSyncOffset;
    }
    // Fallback to video element time only if startedAt is not valid
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

    // Toggle mode-video based on state.
    // UX: When a local *video* is paused we still want to keep the paused frame visible
    // (instead of collapsing back to the visualizer). We treat "IDLE + loaded video" as
    // a video UI mode as well.
    const keepVideoVisibleOnIdle = (
        newState === APP_STATE.IDLE &&
        videoElement &&
        !!videoElement.src &&
        isMediaVideo(currentFileBlob, meta)
    );
    const isVideoMode = (
        newState === APP_STATE.PLAYING_VIDEO ||
        newState === APP_STATE.PLAYING_YOUTUBE ||
        keepVideoVisibleOnIdle
    );
    document.body.classList.toggle('mode-video', isVideoMode);

    // Toggle mode-youtube for state-specific UI (e.g., Settings lock)
    document.body.classList.toggle('mode-youtube', newState === APP_STATE.PLAYING_YOUTUBE);

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
        const showMainVideo = (newState === APP_STATE.PLAYING_VIDEO) || keepVideoVisibleOnIdle;
        videoElement.style.display = showMainVideo ? 'block' : 'none';
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
// Toss in-app: 역할(채널 모드)은 Settings에서 변경 가능해야 하므로 기본 잠금은 사용하지 않습니다.
let isChannelSelectionLocked = false;

let isSurroundMode = false; // 7.1 Mode
let surroundChannelIndex = -1; // 0..7
let surroundSplitter = null; // Split Source into 8 channels
let surroundGain = null; // Gain for selected surround channel
let mediaDownmixNode = null; // Stereo Downmixer for Standard Mode

let virtualBass = 0; // 0.0 ~ 1.0
let stereoWidth = 1.0;
let reverbMix = 0;
let reverbDecay = 5.0;
let reverbPreDelay = 0.1;
let reverbLowCut = 0; // 0-100
let reverbHighCut = 0; // 0-100
let eqValues = [0, 0, 0, 0, 0];
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

    // url -> timeoutId (scheduled revocation)
    _pendingRevocations: new Map(),

    // If we attempted to revoke while the URL was still attached to <video>,
    // we defer until the source is detached (e.g., stopAllMedia / clearPreviousTrackState).
    _deferredUntilDetached: new Set(),

    // BlobURL Queue: Avoid memory pressure during fast switching (Strict 5)
    MAX_PENDING: 5,

    _normalizeOptions(options) {
        if (!options || typeof options !== 'object') return {};
        return options;
    },

    _isUrlAttached(url) {
        try {
            return !!(url && typeof url === 'string' && typeof videoElement !== 'undefined' && videoElement && videoElement.src === url);
        } catch (_) {
            return false;
        }
    },

    _clearScheduled(url) {
        const t = this._pendingRevocations.get(url);
        if (t) {
            try { clearTimeout(t); } catch (_) { }
        }
        this._pendingRevocations.delete(url);
    },

    _revokeNow(url, reason = '') {
        if (!url) return;

        // Cancel any scheduled revocation first
        this._clearScheduled(url);
        this._deferredUntilDetached.delete(url);

        try {
            URL.revokeObjectURL(url);
            log.debug(`[BlobURL] Revoked: ${url}${reason ? ` (${reason})` : ''}`);
        } catch (e) {
            log.debug('[BlobURL] Revoke failed (non-critical):', e?.message || e);
        }

        if (this._activeURL === url) this._activeURL = null;
        if (this._preparingURL === url) this._preparingURL = null;
    },

    /**
     * Create a new Blob URL in 'Preparing' state.
     * Use confirm() to move it to 'Active' state and schedule previous URL for revocation.
     */
    create(blob) {
        if (!blob) return null;

        // If we were preparing something else that never got confirmed, revoke it immediately
        if (this._preparingURL) {
            this._revokeNow(this._preparingURL, 'abandoned-preparing');
        }

        this._preparingURL = URL.createObjectURL(blob);
        log.debug(`[BlobURL] Prepared: ${this._preparingURL}`);
        return this._preparingURL;
    },

    /**
     * Confirm the prepared URL as the active one.
     * This schedules the previous active URL for delayed revocation.
     */
    confirm(_blobUnused) {
        if (!this._preparingURL) return;

        const nextUrl = this._preparingURL;
        const prevUrl = this._activeURL;

        this._activeURL = nextUrl;
        this._preparingURL = null;

        // Schedule previous ACTIVE URL for delayed revocation
        if (prevUrl && prevUrl !== nextUrl) {
            this.safeRevoke(prevUrl);
        }

        log.debug(`[BlobURL] Confirmed Active: ${this._activeURL}`);
    },

    /**
     * Schedule a specific URL for revocation after a safety delay.
     * If the URL is still attached to <video>, we defer until detached.
     *
     * @param {string} url
     * @param {object} options  { delayMs?: number, force?: boolean }
     */
    safeRevoke(url, options) {
        if (!url) return;

        const opt = this._normalizeOptions(options);
        const force = opt.force === true;
        const delayMs = (typeof opt.delayMs === 'number' && opt.delayMs >= 0) ? opt.delayMs : DELAY.BLOB_REVOCATION;

        // Already scheduled
        if (this._pendingRevocations.has(url)) return;

        // If it's still attached, don't risk breaking playback/paused state. Defer until detached.
        if (!force && this._isUrlAttached(url)) {
            this._deferredUntilDetached.add(url);
            log.debug(`[BlobURL] Deferred revocation (still attached): ${url}`);
            return;
        }

        // Strict Queue management (Max 5 scheduled revocations)
        if (this._pendingRevocations.size >= this.MAX_PENDING) {
            const oldest = this._pendingRevocations.keys().next().value;
            log.debug(`[BlobURL] Queue full. Revoking oldest immediately: ${oldest}`);
            this._revokeNow(oldest, 'queue-overflow');
        }

        if (delayMs === 0) {
            this._revokeNow(url, 'delay=0');
            return;
        }

        const t = setTimeout(() => {
            this._revokeNow(url, 'scheduled');
        }, delayMs);

        this._pendingRevocations.set(url, t);
        log.debug(`[BlobURL] Scheduled for revocation (${delayMs}ms): ${url}`);
    },

    /**
     * Flush deferred URLs that were blocked because they were still attached to <video>.
     * Call this right after videoElement.src is detached/reset.
     */
    flushDeferred(reason = '') {
        if (!this._deferredUntilDetached.size) return;

        const urls = Array.from(this._deferredUntilDetached);
        let flushed = 0;

        for (const url of urls) {
            if (!this._isUrlAttached(url)) {
                // Force scheduling now that it is detached
                this._deferredUntilDetached.delete(url);
                this.safeRevoke(url, { force: true });
                flushed++;
            }
        }

        if (flushed) log.debug(`[BlobURL] Flushed deferred: ${flushed}${reason ? ` (${reason})` : ''}`);
    },

    /**
     * Attempt to revoke the currently active URL (and any preparing URL).
     * If still attached, it will be deferred until detached.
     */
    revoke(options) {
        // Preparing URL: safe to revoke quickly (it should not be attached yet)
        if (this._preparingURL) {
            this.safeRevoke(this._preparingURL, { force: true, delayMs: 0 });
        }
        if (this._activeURL) {
            this.safeRevoke(this._activeURL, options);
        }
    },

    /**
     * Force revoke everything (use ONLY after detaching media sources).
     */
    revokeAllNow(reason = 'force') {
        // Cancel scheduled revocations (and revoke)
        const scheduled = Array.from(this._pendingRevocations.keys());
        for (const url of scheduled) {
            this._revokeNow(url, reason);
        }

        // Deferred revocations
        const deferred = Array.from(this._deferredUntilDetached);
        for (const url of deferred) {
            this._revokeNow(url, reason);
        }

        // Active/preparing
        if (this._activeURL) this._revokeNow(this._activeURL, reason);
        if (this._preparingURL) this._revokeNow(this._preparingURL, reason);

        this._pendingRevocations.clear();
        this._deferredUntilDetached.clear();
        this._activeURL = null;
        this._preparingURL = null;
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
// Latest device roster snapshot (host broadcasts). Used for UI/toasts such as
// "연결된 기기 N대 | 초대 코드 000000".
let lastKnownDeviceList = null;
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
// [SECTION] OPFS CATCH-UP (Relay Bootstrap) - Controlled OPFS_READ Pump
// ============================================================================
// Downstream peer가 중간에 들어오면 OPFS에 이미 저장된 chunk를 읽어서 catch-up 해야 합니다.
// 기존처럼 for-loop로 OPFS_READ를 수천 번 한꺼번에 보내면 Worker queue가 폭발하여
// iOS/저사양 기기에서 프리징/메모리 급증/락 충돌이 발생할 수 있습니다.
// 아래 Pump는 "1개 요청 → 1개 응답" 방식으로 천천히 읽어오며, RTC back-pressure를 반영합니다.

const opfsCatchupPumps = new Map(); // peerId -> pump

function stopOpfsCatchupStream(peerId, reason = '') {
    const pump = opfsCatchupPumps.get(peerId);
    if (!pump) return;
    pump.active = false;
    if (pump._timer) {
        clearTimeout(pump._timer);
        pump._timer = null;
    }
    opfsCatchupPumps.delete(peerId);
    if (reason) log.debug(`[OPFS Catchup] Stop ...${String(peerId).slice(-4)}: ${reason}`);
}

function startOpfsCatchupStream(conn, { filename, sessionId, startIndex = 0, endIndexExclusive = 0, isPreload = false } = {}) {
    if (!conn || !conn.peer) return;
    const peerId = conn.peer;

    stopOpfsCatchupStream(peerId, 'restart');

    const sid = validateSessionId(sessionId);
    if (!sid) {
        log.warn(`[OPFS Catchup] Invalid sessionId, abort for peer ...${peerId.slice(-4)}`);
        return;
    }

    const pump = {
        peerId,
        conn,
        filename,
        sessionId: sid,
        isPreload: !!isPreload,
        nextIndex: Math.max(0, startIndex | 0),
        endIndex: Math.max(0, endIndexExclusive | 0),
        awaiting: false,
        awaitingIndex: null,
        lastActivity: Date.now(),
        active: true,
        _timer: null
    };

    opfsCatchupPumps.set(peerId, pump);
    scheduleOpfsCatchupPump(pump, 0);
}

function scheduleOpfsCatchupPump(pump, delayMs) {
    if (!pump || !pump.active) return;
    if (pump._timer) clearTimeout(pump._timer);
    pump._timer = setTimeout(() => runOpfsCatchupPump(pump), Math.max(0, delayMs | 0));
}

function runOpfsCatchupPump(pump) {
    if (!pump || !pump.active) return;

    const conn = pump.conn;
    if (!conn || !conn.open) {
        stopOpfsCatchupStream(pump.peerId, 'peer closed');
        return;
    }

    // Session guard: app이 더 새로운 session으로 넘어가면 중단
    if (pump.sessionId && pump.sessionId < localTransferSessionId) {
        stopOpfsCatchupStream(pump.peerId, 'session advanced');
        return;
    }

    if (!pump.filename || pump.nextIndex >= pump.endIndex) {
        stopOpfsCatchupStream(pump.peerId, 'complete');
        return;
    }

    // Wait for previous OPFS_READ response (sequential pump)
    if (pump.awaiting) {
        // If it's stuck for too long, retry the same chunk once.
        const stuckMs = Date.now() - pump.lastActivity;
        if (stuckMs > 6000 && pump.awaitingIndex !== null) {
            log.warn(`[OPFS Catchup] Stuck ${stuckMs}ms, retry idx=${pump.awaitingIndex} for ...${pump.peerId.slice(-4)}`);
            pump.awaiting = false;
            pump.nextIndex = pump.awaitingIndex; // rewind to retry
            pump.awaitingIndex = null;
        }
        scheduleOpfsCatchupPump(pump, DELAY.BACKPRESSURE);
        return;
    }

    // Back-pressure: don't read faster than RTC can send.
    const peerQueueLen = conn._relayQueue ? conn._relayQueue.length : 0;
    const bufAmt = conn.dataChannel ? conn.dataChannel.bufferedAmount : 0;

    // Conservative thresholds: keep catch-up smooth and prevent queue drops.
    if (peerQueueLen > 120 || bufAmt > 256 * 1024 || relayChunkQueue.length > 250) {
        scheduleOpfsCatchupPump(pump, DELAY.BACKPRESSURE);
        return;
    }

    const idx = pump.nextIndex;
    pump.nextIndex++;
    pump.awaiting = true;
    pump.awaitingIndex = idx;
    pump.lastActivity = Date.now();

    // requestId에 peerId + tag를 넣어, OPFS_READ_COMPLETE에서 peerId를 안정적으로 복원합니다.
    postWorkerCommand({
        command: 'OPFS_READ',
        filename: pump.filename,
        index: idx,
        isPreload: pump.isPreload,
        sessionId: pump.sessionId,
        requestId: `${pump.peerId}|catchup`
    });
}

function onOpfsCatchupReadComplete(peerId, sessionId, requestTag) {
    const pump = opfsCatchupPumps.get(peerId);
    if (!pump || !pump.active) return;

    // Only advance pump when this response is from catchup-tag.
    if (requestTag !== 'catchup') return;

    // Session guard
    if (sessionId && pump.sessionId && sessionId !== pump.sessionId) {
        stopOpfsCatchupStream(peerId, 'session mismatch');
        return;
    }

    pump.awaiting = false;
    pump.awaitingIndex = null;
    pump.lastActivity = Date.now();
    scheduleOpfsCatchupPump(pump, 0);
}


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
    REQUEST_REVERB_RESET: 'request-reverb-reset',
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
    SESSION_START: 'session-start',
    SESSION_FULL: 'session-full',
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
let _preloadAckSent = new Set();
let _preloadUsedForIndex = null;
let _preloadWatchdog = null;
let _recoveryInProgress = {};
let _recoveryLastRequest = {};
let _recoveryRetryCount = 0;
const MAX_RECOVERY_RETRIES = 3;
const RECOVERY_BACKOFF = [2000, 5000, 10000];
let _recoveryPending = false;
let _lastReceivedCountSnapshot = 0;
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

/**
 * Build a lightweight playlist payload safe to send over PeerJS.
 * IMPORTANT: Never send File objects (they are not reliably serializable).
 */
function buildPlaylistMetaList(srcList = playlist) {
    if (!Array.isArray(srcList)) return [];
    return srcList.map(item => ({
        type: item?.type,
        name: item?.name || item?.title || (item?.file ? item.file.name : 'Unknown'),
        videoId: item?.videoId || null,
        playlistId: item?.playlistId || null
    }));
}


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
let preloadChunks = [];
let preloadCount = 0;
let preloadMeta = null;
let lastChunkTime = 0;
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

    const tw = window.transferWorker;
    if (!tw) return;

    return new Promise((resolve) => {
        const timeoutMs = 2500; // Slightly higher to avoid false timeouts on slower devices
        const handler = (e) => {
            const d = e.data;
            if (d && d.type === 'OPFS_CLEANUP_COMPLETE' && d.filename === filename && !!d.isPreload === !!isPreload) {
                tw.removeEventListener('message', handler);
                resolve();
            }
        };

        tw.addEventListener('message', handler);
        postWorkerCommand({ command: 'OPFS_CLEANUP', filename, isPreload });

        // Safety fallback: Continue even if worker takes too long (best-effort cleanup)
        setTimeout(() => {
            try { tw.removeEventListener('message', handler); } catch (_) { }
            resolve();
        }, timeoutMs);
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

    // Memory safety: prune old preload session state/buffers (keep a small tail)
    try {
        let maxSid = 0;
        for (const sid of preloadSessionState.keys()) {
            const n = Number(sid);
            if (Number.isFinite(n) && n > maxSid) maxSid = n;
        }
        const keepFrom = Math.max(0, maxSid - 3);
        for (const sid of Array.from(preloadSessionState.keys())) {
            const n = Number(sid);
            if (Number.isFinite(n) && n < keepFrom) preloadSessionState.delete(sid);
        }
        for (const sid of Array.from(preloadReorderBuffer.keys())) {
            const n = Number(sid);
            if (Number.isFinite(n) && n < keepFrom) preloadReorderBuffer.delete(sid);
        }
    } catch (_) { /* ignore */ }

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

let syncWorker = null;
let transferWorker = null;

// [Robustness] Worker initialization can fail in some embedded/in-app webviews.
// - We degrade gracefully: UI still loads, but background timers/OPFS transfer features may be limited.
try {
    syncWorker = window.syncWorker = new Worker('js/sync.worker.js');
    // Initialize directly (routing only sends to one)
    syncWorker.postMessage({ command: 'INIT_INSTANCE', instanceId: OPFS_INSTANCE_ID });
} catch (e) {
    window.syncWorker = null;
    log.error('[Worker] Failed to start sync.worker.js:', e);
    showToast('환경 제한으로 백그라운드 타이머(Worker)를 사용할 수 없어요.');
}

try {
    transferWorker = window.transferWorker = new Worker('js/transfer.worker.js');
    transferWorker.postMessage({ command: 'INIT_INSTANCE', instanceId: OPFS_INSTANCE_ID });
} catch (e) {
    window.transferWorker = null;
    log.error('[Worker] Failed to start transfer.worker.js:', e);
    showToast('환경 제한으로 파일 저장/전송(Worker)을 사용할 수 없어요.');
}

const handleWorkerError = (e) => {
    log.error("[Worker Error]", e.message, e.filename, e.lineno);
    showToast("워커 작업 중 오류 발생!");
};

// Dedupe worker error toasts (avoid spam on repeated failures)
let _lastWorkerErrorToastAt = 0;
let _lastWorkerErrorKey = '';

if (syncWorker) syncWorker.onerror = handleWorkerError;
if (transferWorker) transferWorker.onerror = handleWorkerError;

const handleWorkerMessage = async (e) => {
    try {
        const data = e.data;
        if (data && data.type === 'WORKER_ERROR') {
            const scope = data.scope || 'worker';
            const cmd = data.command || '';
            const errMsg = data.error || 'Unknown error';
            log.error(`[${scope}] ${cmd}: ${errMsg}`, data);

            const key = `${scope}|${cmd}|${errMsg}`;
            const now = Date.now();
            if (key !== _lastWorkerErrorKey || (now - _lastWorkerErrorToastAt) > 2000) {
                _lastWorkerErrorKey = key;
                _lastWorkerErrorToastAt = now;
                showToast('백그라운드 작업 오류가 발생했어요');
            }
            return;
        }
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

            // requestId format: "<peerId>|<tag>"  (tag is optional)
            const reqStr = (requestId === undefined || requestId === null) ? '' : String(requestId);
            const [peerIdRaw, requestTagRaw] = reqStr.split('|');
            const peerId = peerIdRaw || reqStr;
            const requestTag = requestTagRaw || '';

            // Session guard: discard stale catch-up chunks from old track
            if (sessionId && sessionId < localTransferSessionId) {
                log.warn(`[OPFS_READ] Stale session chunk discarded (got ${sessionId}, current ${localTransferSessionId})`);
                onOpfsCatchupReadComplete(peerId, sessionId, requestTag);
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

            // Drive catch-up pump (if active)
            onOpfsCatchupReadComplete(peerId, sessionId, requestTag);
        }
        else if (data.type === 'OPFS_ERROR' || data.type === 'OPFS_READ_ERROR') {
            log.error(`[Worker-OPFS] Error for ${data.filename}:`, data.error);

            // If this was a catch-up pump request, stop the pump to avoid infinite retries.
            if (data.type === 'OPFS_READ_ERROR') {
                const reqStr = (data.requestId === undefined || data.requestId === null) ? '' : String(data.requestId);
                const [peerIdRaw, tagRaw] = reqStr.split('|');
                const peerId = peerIdRaw || reqStr;
                const tag = tagRaw || '';
                if (tag === 'catchup') {
                    stopOpfsCatchupStream(peerId, 'OPFS_READ_ERROR');
                }
            }

            if (data.type === 'OPFS_ERROR') showToast(`파일 저장 오류: ${data.filename}`);
        }
        else if (data.type === 'SESSION_MISMATCH') {
            const isPreload = !!data.isPreload;
            log.warn(`[Main] Session Mismatch in ${data.command}: expected=${data.expected}, got=${data.received}, file=${data.filename} (${isPreload ? 'preload' : 'current'})`);

            // [Enhanced Fix] Dampen resync loops:
            // If expected is null, it means the worker wasn't in an active session (e.g. churn).
            // Requesting a resync here often triggers an infinite loop if the Host is skipped again.
            if (data.expected === null) {
                log.debug(`[Main] Ignoring mismatch for null-session (Worker idle/churn)`);
                return;
            }

            // Preload mismatches are non-fatal; avoid forcing Host resync loops.
            if (isPreload) {
                log.debug('[Main] Preload session mismatch ignored (best-effort preload)');
                return;
            }

            // Only react when the mismatch is for the current file we care about.
            const fname = data.filename || '';
            const isCurrent = !!fname && (fname === currentFileOpfs.name || fname === meta?.name);
            if (!isCurrent) {
                log.debug('[Main] Ignoring session mismatch for non-current file:', fname);
                return;
            }

            if (hostConn && typeof hostConn.send === 'function' && hostConn.open) {
                log.debug(`[Main] Requesting resync due to session mismatch`);
                hostConn.send({ type: MSG.GET_SYNC_TIME });
            }
        }
    } catch (err) {
        log.error('[Worker Message] Processing error:', err);
        showToast('워커 메시지 처리 중 오류');
    }
};

if (syncWorker) syncWorker.onmessage = handleWorkerMessage;
if (transferWorker) transferWorker.onmessage = handleWorkerMessage;

// Worker Timer Helpers (sync.worker.js)
// - 세션 종료/재연결 시에도 worker timer가 남아있으면 불필요한 CPU 사용이 발생합니다.
const WORKER_TIMER_IDS = ['heartbeat', 'ping', 'video-sync'];
function stopBackgroundWorkerTimers() {
    WORKER_TIMER_IDS.forEach((id) => {
        try { postWorkerCommand({ command: 'STOP_TIMER', id }); } catch (_) { }
    });
}



/**
 * [OPFS] Best-effort helper to read an already-written file back from OPFS.
 * - Edge-case: we may have received all chunks but lost the in-memory File reference
 *   (relay churn / duplicate file-start / UI resets). This avoids forcing a full re-download.
 */
async function tryGetOpfsFile(filename, isPreload = false) {
    if (!(navigator.storage && navigator.storage.getDirectory)) return null;
    const name = filename ? String(filename) : '';
    if (!name) return null;

    try {
        const root = await navigator.storage.getDirectory();
        const safeName = (isPreload ? "preload_" : "current_") + name.replace(/[^a-z0-9._-]/gi, '_') + "_" + OPFS_INSTANCE_ID;
        const fileHandle = await root.getFileHandle(safeName);
        return await fileHandle.getFile();
    } catch (_) {
        return null;
    }
}


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

        // Reset state to READY and clear guards so that subsequent preloads/transfers work
        transferState = TRANSFER_STATE.READY;
        _skipIncomingFile = false;
        _waitingForPreload = false;
        clearManagedTimer('prepareWatchdog');
        clearManagedTimer('chunkWatchdog');

    } catch (e) {
        log.error("[Guest] Decoding failed", e);
        showToast("오디오 디코딩 실패! 다시 요청합니다.");
        showLoader(false);

        // Fallback: If decoding fails, request file again
        const _recoveryName = (playlist && playlist[currentTrackIndex] && playlist[currentTrackIndex].name) ? playlist[currentTrackIndex].name : (meta ? meta.name : '');
        if (hostConn && hostConn.open) {
            hostConn.send({ type: MSG.REQUEST_CURRENT_FILE, name: _recoveryName, index: currentTrackIndex, reason: 'decoding_failed' });
        }
    }
}

// --- Theme Logic ---
let _activeThemeMode = 'system';
let _systemDarkMQ = null;

function _resolveTheme(mode) {
    if (mode === 'dark') return 'dark';
    if (mode === 'light') return 'light';
    try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (_) { }
    return 'light';
}

function _applyResolvedTheme(resolved) {
    try {
        document.documentElement.setAttribute('data-theme', resolved);
        // Ensure UA-rendered widgets (overlay scrollbars on mobile/PWA, form controls)
        // follow the currently forced app theme even if the *system* theme differs.
        try { document.documentElement.style.colorScheme = resolved; } catch (_) { /* ignore */ }
        const metaColor = resolved === 'dark' ? '#000000' : '#f2f2f7';
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', metaColor);
        document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved === 'dark' ? 'dark light' : 'light dark');
    } catch (_) { /* ignore */ }
}

function _updateThemeSelector(mode) {
    try {
        document.querySelectorAll('.theme-opt').forEach(el => el.classList.remove('active'));
        const id = mode === 'dark' ? 'theme-dark' : mode === 'light' ? 'theme-light' : 'theme-system';
        document.getElementById(id)?.classList.add('active');

        // Sliding pill: set index (Light=0, Dark=1, System=2)
        const pillIndex = mode === 'light' ? 0 : mode === 'dark' ? 1 : 2;
        document.querySelectorAll('.theme-selector').forEach(sel => {
            sel.style.setProperty('--pill-index', pillIndex);
        });
    } catch (_) { /* ignore */ }
}

function setTheme(mode) {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') mode = 'system';
    _activeThemeMode = mode;

    try { localStorage.setItem('musixquare-theme', mode); } catch (_) { /* ignore */ }

    const resolved = _resolveTheme(mode);
    _applyResolvedTheme(resolved);
    _updateThemeSelector(mode);

    if (_systemDarkMQ) {
        try { _systemDarkMQ.removeEventListener('change', _onSystemThemeChange); } catch (_) { /* ignore */ }
    }
    if (mode === 'system') {
        try {
            _systemDarkMQ = window.matchMedia('(prefers-color-scheme: dark)');
            _systemDarkMQ.addEventListener('change', _onSystemThemeChange);
        } catch (_) { /* ignore */ }
    }
}

function _onSystemThemeChange() {
    if (_activeThemeMode !== 'system') return;
    _applyResolvedTheme(_resolveTheme('system'));
}

(function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('musixquare-theme'); } catch (_) { /* ignore */ }
    setTheme(saved || 'system');
})();


// --- Language / i18n ---
let _activeLanguageMode = 'system'; // 'ko' | 'en' | 'system'
// Resolved language is what the UI actually uses ('ko' or 'en').
let _resolvedLanguage = (function _resolveInitialSystemLanguage() {
    try {
        const langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || ''];
        const first = String(langs[0] || '').toLowerCase();
        return first.startsWith('ko') ? 'ko' : 'en';
    } catch (_) {
        return 'ko';
    }
})();

const I18N_EN = {
    ", 방장이 알려주는": ", provided by the host",
    "동기화 버튼을 눌러서 싱크를 맞춰보세요.": "Press the sync button to adjust the sync.",
    "1개 요청 → 1개 응답": "1 request → 1 response",
    "3초 후 YouTube 재생...": "Playing YouTube in 3 seconds...",
    "3초 후 재생 시작...": "Starting playback in 3 seconds...",
    "6자리 숫자 코드로 연결할 수 있어요.": "You can connect with a 6-digit code.",
    "6자리 코드": "6-digit code",
    "6자리 코드를 입력해 주세요": "Please enter the 6-digit code",
    "HTTPS 필수: 보안 연결에서만 작동합니다.": "HTTPS required: works only on a secure connection.",
    "Host 연결 끊김 - 파일을 받을 수 없습니다": "Host disconnected — can't receive the file",
    "Host 요청: 싱크 초기화 및 재설정...": "Host request: reset and recalibrate sync...",
    "Host 직결로 전환되었습니다 (릴레이 끊김)": "Switched to direct Host connection (relay disconnected)",
    "Host만 실행할 수 있습니다.": "Only Host can run this.",
    "Host에 파일 요청 중...": "Requesting file from Host...",
    "ID 생성 중...": "Generating ID...",
    "L 채널 출력": "L channel output",
    "MUSIXQUARE는 JavaScript가 필요해요. 브라우저 설정에서 JavaScript를 켠 뒤 다시 시도해 주세요.": "MUSIXQUARE requires JavaScript. Enable JavaScript in your browser settings and try again.",
    "OP 권한 부여": "Grant OP",
    "OP 권한 회수": "Revoke OP",
    "Operator 권한이 부여되었습니다.": "Operator permission granted.",
    "Operator 권한이 해제되었습니다.": "Operator permission revoked.",
    "R 채널 출력": "R channel output",
    "Relay 응답 없음. Host 직결 전환...": "No relay response. Switching to direct Host...",
    "URL을 입력해 주세요": "Please enter a URL",
    "VPN/사내 보안망이 켜져 있으면 연결이 실패할 수 있어요.": "If a VPN/corporate network is on, the connection may fail.",
    "Wi-Fi가 없다면 호스트의 핫스팟에 연결해주세요": "No Wi‑Fi? Connect to the host's hotspot.",
    "YouTube API 로드 실패. 인터넷 연결 확인!": "Failed to load the YouTube API. Check your connection!",
    "YouTube 같이 보기 - 고급 오디오 효과가 비활성화됩니다": "Watch YouTube together — advanced audio effects are disabled.",
    "YouTube 로드 시간 초과. 다시 시도해주세요.": "YouTube load timed out. Please try again.",
    "YouTube 링크 입력": "Enter YouTube link",
    "YouTube 모드에서는 역할 설정과 음향 효과를 쓸 수 없어요.": "In YouTube mode, role settings and audio effects are unavailable.",
    "YouTube 모드에서는 정밀 동기화를 지원하지 않아요": "High-precision sync isn't available in YouTube mode.",
    "YouTube 미리보기 썸네일": "YouTube preview thumbnail",
    "YouTube 비디오 또는 플레이리스트 링크를 입력하세요.": "Enter a YouTube video or playlist link.",
    "YouTube 이동 실패": "Failed to open YouTube",
    "YouTube 재생 시작": "YouTube playback started",
    "YouTube 함께보기": "Watch YouTube together",
    "YouTube가 준비됐어요! 재생 버튼을 눌러 보세요.": "YouTube is ready! Press Play.",
    "“모임에 참여할래요” → 코드 입력 → 역할 선택(원본/왼쪽/오른쪽/저음)": "“Join a session” → enter the code → choose a role (Original/Left/Right/Bass)",
    "“제가 방장할래요” → 코드 확인 → “시작할래요!”": "“I'll host” → check the code → “Start!”",
    "가상 베이스 강도": "Virtual bass intensity",
    "가상 베이스(방장 제어)": "Virtual bass (host-ctrl)",
    "가상 서라운드 너비 조절": "Adjust virtual surround width",
    "가상 서라운드(방장 제어)": "Virtual surround (host-ctrl)",
    "각 기기의 역할을 설정해 보세요.": "Set a role for each device.",
    "강도": "Intensity",
    "같은 Wi‑Fi인지 확인하고 다시 시도해주세요.": "Check that you're on the same Wi‑Fi and try again.",
    "거대한 오디오 시스템을 만들어 보세요.": "Create a giant audio system.",
    "고급 음향": "Advanced audio",
    "고급 효과를 시스템에 적용할 수 있어요.": "You can apply advanced effects system-wide.",
    "고정밀 동기화: 오디오를 준비하고 있어요…": "High-precision sync: preparing audio…",
    "공개된 링크만 함께 들을 수 있어요.": "Only public links can be played together.",
    "권한": "permission",
    "기기 파일에서 음악/영상을 선택": "Choose music/video from your device",
    "기기를 오른쪽에 놓아주세요": "Place the device on the right",
    "기기를 왼쪽에 놓아주세요": "Place the device on the left",
    "기기를 중앙에 놓아주세요": "Place the device in the center",
    "기본값 0%": "Default 0%",
    "기본값 0, 늘리면 가상 베이스(왜곡 증가)": "Default 0 — Higher = More Distortion",
    "기본값 0.1s": "Default 0.1s",
    "기본값 100, 줄이면 모노, 늘리면 서라운드": "Default 100 — lower = mono, higher = surround",
    "기본값 20.0kHz": "Default 20.0kHz",
    "기본값 20Hz": "Default 20Hz",
    "기본값 5.0s": "Default 5.0s",
    "기타 문의:": "Contact:",
    "나중에 설정에서 바꿀 수 있어요.": "You can change it later in Settings.",
    "남아있기": "Stay",
    "너비": "Width",
    "네트워크 상태를 확인한 후 다시 참가해 주세요.": "Check your network and try joining again.",
    "네트워크 연결 상태와 코드를 확인해주세요.": "Check your network connection and the code.",
    "네트워크 오류가 발생했어요. 같은 Wi‑Fi인지 확인해주세요.": "Network error occurred. Make sure you're on the same Wi‑Fi.",
    "네트워크 초기화 실패": "Network init failed",
    "네트워크 품질이 낮을 수 있어요. 공유기 가까이로 이동해 보세요.": "Network quality may be low. Try moving closer to the router.",
    "다운로드 마무리 중...": "Finishing download...",
    "다운로드 완료 후 재생됩니다": "Will play after download completes",
    "다음 설명": "Next",
    "다음 트랙": "Next track",
    "다음으로": "Next",
    "다크": "Dark",
    "닫기": "Close",
    "데모 로드 실패:": "Demo load failed:",
    "데모 미디어로 프로그램 테스트": "Test the app with demo media",
    "데모 음원 로드 완료. 재생을 시작합니다.": "Demo track loaded. Starting playback.",
    "데모 음원 로딩 중...": "Loading demo track...",
    "데이터 수신 불안정. Host 복구 요청...": "Data reception unstable. Requesting Host recovery...",
    "도움말": "Help",
    "도움이 필요할 때": "Need help?",
    "동기화": "Sync",
    "동시에 재생": "Play together",
    "동영상 또는 플레이리스트 링크를 입력하세요": "Enter a video or playlist link",
    "동일한 네트워크": "same network",
    "두 기기가 같은 네트워크인지 확인해 보세요.": "Make sure both devices are on the same network.",
    "라이트": "Light",
    "로우패스": "Low-pass",
    "로컬 네트워크 전용": "Local network only",
    "로컬 파일 선택": "Choose local file",
    "로컬(같은 Wi‑Fi/핫스팟)": "local (same Wi‑Fi/hotspot)",
    "로컬파일 불러오기": "Load local file",
    "로컬파일 불러오기:": "Load local file:",
    "를 입력해 연결해요.": " and enter it to connect.",
    "리버브 로우컷": "Reverb low-cut",
    "리버브 믹스": "Reverb mix",
    "리버브 반사 시간": "Reverb decay",
    "리버브 프리딜레이": "Reverb pre-delay",
    "리버브 하이컷": "Reverb high-cut",
    "리버브(방장 제어)": "Reverb (host-ctrl)",
    "리버브, 이퀄라이저, 가상 효과 등": "Reverb, EQ, virtual effects, and more",
    "릴레이 대기 중... 잠시만 기다려주세요": "Waiting for relay... please hold on",
    "릴레이 응답 없음. Host에서 직접 수신...": "No relay response. Receiving directly from Host...",
    "릴레이에 파일 요청 중...": "Requesting file via relay...",
    "링크를 붙여넣어 재생 목록에 추가": "Paste a link to add it to the playlist",
    "마지막이에요!": "Last step!",
    "메시지": "Message",
    "메시지 보내기": "Send message",
    "메시지 입력...": "Type a message...",
    "메인": "Home",
    "메인 화면으로 이동": "Go to Home",
    "모든 기기 Auto Sync 요청...": "Requesting Auto Sync on all devices...",
    "모든 기기 재동기화 요청...": "Requesting resync on all devices...",
    "모든 기기가": "All devices must be connected to the",
    "모든 기기를 동일한 Wi-Fi에 연결해주세요": "Connect all devices to the same Wi‑Fi",
    "모임에 참여할래요": "Join a session",
    "Sean Pitaro - Passport [NCS Release]": "Sean Pitaro - Passport [NCS Release]",
    "미디어 없음": "No media",
    "미디어 재생": "Play media",
    "미디어 재생하기": "Play media",
    "미디어 추가": "Add media",
    "미디어를 추가해주세요.": "Please add media.",
    "믹스": "Mix",
    "반복 모드 변경": "Change repeat mode",
    "반복 재생: 끔": "Repeat: Off",
    "반복 재생: 전체": "Repeat: All",
    "반복 재생: 한 곡": "Repeat: One",
    "반사 시간": "Decay time",
    "반사 지연": "Pre-delay",
    "방장 제외 최대 3대": "3 devices excluding the host",
    "방장:": "Host:",
    "방장만 미디어를 추가할 수 있어요.": "Only the host can add media.",
    "방장만 유튜브 링크를 추가할 수 있어요.": "Only the host can add YouTube links.",
    "방장에게는 3가지 선택지가 나와요.": "Hosts see three options.",
    "방장이 알려준 6자리 코드를 입력해주세요": "Enter the 6-digit code from the host",
    "배치": "Placement",
    "백그라운드 작업 오류가 발생했어요": "A background task error occurred",
    "복사하지 못했어요": "Couldn't copy",
    "볼륨 조절": "Adjust volume",
    "부여됨": "granted",
    "브라우저 업데이트 필요: 최신 iOS(15.2+)로 업데이트하세요.": "Browser update required: update to the latest iOS (15.2+).",
    "새 버전이 준비되었습니다. 새로고침하면 업데이트가 적용됩니다.": "A new version is ready. Refresh to update.",
    "새로고침": "Refresh",
    "서브우퍼": "Subwoofer",
    "서브우퍼 조절하기": "Adjust subwoofer",
    "서브우퍼 컷오프 주파수": "Subwoofer cutoff frequency",
    "서브우퍼:": "Subwoofer:",
    "설정": "Settings",
    "설정 · 도움말": "Settings · Help",
    "세션을 만들지 못했어요": "Couldn't create session",
    "세션이 가득 찼어요": "Session is full",
    "세션이 초기화되었습니다.": "Session has been reset.",
    "셔플 모드 변경": "Change shuffle mode",
    "셔플: 꺼짐": "Shuffle: Off",
    "셔플: 켜짐": "Shuffle: On",
    "데모 트랙 정보": "Demo Track",
    "스테레오(기본) 출력": "Stereo (default) output",
    "스피커로 재생하기": "Play through speakers",
    "시스템": "System",
    "시작하기": "Start",
    "아직 메시지가 없어요.": "No messages yet.",
    "안내": "Info",
    "안녕하세요! 본인의 역할을 선택해주세요.": "Hi! Please choose your role.",
    "앱 체험하기 (데모)": "Try it (Demo)",
    "앱 체험하기:": "Try the app:",
    "언어 · Language": "Language · 언어",
    "언제 어디서나 함께 듣는": "Listen together, anywhere",
    "업데이트": "Update",
    "에 연결되어야 해요.": ".",
    "에서 역할을 언제든 바꿀 수 있어요.": ".",
    "에서만 연결됩니다.": ".",
    "여러 기기를 무선으로 연결해": "Connect multiple devices wirelessly",
    "역할": "Role",
    "역할(출력 채널)": "Role (output channel)",
    "역할을 선택해 주세요": "Please select a role",
    "역할을 선택해 참가해 주세요.": "Select a role to join.",
    "역할을 선택해주세요": "Please select a role",
    "역할이 자동 설정되어 변경할 수 없어요.": "Role is auto-assigned and can't be changed.",
    "연결 실패": "Connection failed",
    "연결 오류: 파일 전송 실패": "Connection error: file transfer failed",
    "연결 준비 실패": "Failed to prepare connection",
    "연결 중...": "Connecting...",
    "연결 코드 6자리 입력": "Enter 6-digit code",
    "연결 코드를 입력해주세요.": "Please enter the connection code.",
    "연결된 기기 N대 | 초대 코드 000000": "Connected devices: N | Invite code 000000",
    "연결된 모든 기기에서 동시에 재생돼요.": "Playback is synchronized on all connected devices.",
    "연결된 모든 기기에서 선택한 미디어가 동시에 재생돼요.": "The selected media plays simultaneously on all connected devices.",
    "연결됨": "connected",
    "연결에 문제가 생겼어요": "Connection issue occurred",
    "연결이 끊어졌어요": "Disconnected",
    "연결이 불안정해요:": "Unstable connection:",
    "연결이 안 되면: Wi‑Fi 재연결 → 앱 새로고침 순서로 확인해 주세요.": "If it won't connect: reconnect Wi‑Fi → refresh the app.",
    "연결하지 못했어요": "Couldn't connect",
    "연결할 수 있는 기기는": "You can connect up to",
    "영상 정보 불러오는 중...": "Loading video info...",
    "영상 정보를 불러올 수 없습니다": "Couldn't load video info",
    "예요.": ".",
    "오디오 디코딩 실패!": "Audio decode failed!",
    "오디오 디코딩 중...": "Decoding audio...",
    "오디오 메모리 로드 중...": "Loading audio into memory...",
    "오디오 엔진을 불러오지 못했어요. 네트워크를 확인해 보세요.": "Couldn't load the audio engine. Check your network.",
    "오디오 엔진을 준비하지 못했어요": "Couldn't prepare the audio engine",
    "오디오 엔진이 아직 준비되지 않았어요. 네트워크를 확인해 보세요.": "The audio engine isn't ready yet. Check your network.",
    "오디오를 준비하지 못했어요. 화면을 한 번 터치한 뒤 다시 시도해 보세요.": "Couldn't prepare audio. Tap the screen once and try again.",
    "오른쪽 스피커": "Right speaker",
    "오른쪽 스피커:": "Right speaker:",
    "완벽한 사운드 경험": "A perfect sound experience",
    "왼쪽 스피커": "Left speaker",
    "왼쪽 스피커:": "Left speaker:",
    "왼쪽, 오른쪽 소리를 따로 재생하고": "Play left and right channels separately, and",
    "우퍼 모드로 웅장한 저음을 느껴보세요.": "Feel powerful bass with Woofer mode.",
    "워커 메시지 처리 중 오류": "Error handling worker message",
    "워커 작업 중 오류 발생!": "Worker error occurred!",
    "유튜브 (호환 모드)": "YouTube (compatibility mode)",
    "유튜브(채널분리 미지원):": "YouTube (no channel split):",
    "유효하지 않은 YouTube 링크": "Invalid YouTube link",
    "유효하지 않은 시간입니다": "Invalid time",
    "유효한 YouTube 링크가 아닙니다": "Not a valid YouTube link",
    "을 선택해요.": ".",
    "이 기기 역할 설정하기": "Set this device's role",
    "이 기기로 어떤 소리를 낼까요?": "What should this device play?",
    "이 버전은": "This version works only on",
    "이 코드를 다른 기기에 입력해주세요": "Enter this code on your other devices",
    "이렇게 연결해요": "How to connect",
    "이전 설명": "Previous",
    "이전 트랙": "Previous track",
    "이제 다른 기기들과 연결해주세요.": "Now connect your other devices.",
    "이퀄라이저 (방장 제어)": "Equalizer (host-ctrl)",
    "일시정지": "Pause",
    "입체 음향": "Spatial audio",
    "자동 재생 취소됨 (OP)": "Auto-play canceled (OP)",
    "자동 재생을 취소했어요": "Auto-play canceled",
    "잠시 후 다시 시도해주세요.": "Please try again in a moment.",
    "잠시만요...": "Just a moment...",
    "재생 시작": "Play",
    "재생 위치 조절": "Seek",
    "재생 준비 완료": "Ready to play",
    "재생/일시정지": "Play/Pause",
    "재생목록": "Playlist",
    "재생할 미디어를 선택해주세요": "Select media to play",
    "저역 믹스 출력": "Bass mix output",
    "전체화면 전환": "Toggle fullscreen",
    "정지": "Stop",
    "정지 요청을 보냈어요": "Stop request sent",
    "제가 방장할래요": "I'll host",
    "준비 지연 중... Host 복구 요청": "Preparation delayed... requesting Host recovery",
    "중앙 스피커": "Center speaker",
    "중앙 스피커:": "Center speaker:",
    "직접 동기화 완료 (로컬 네트워크)": "Direct sync complete (local network)",
    "참가자": "Guest",
    "참가자:": "Guest:",
    "참가자가": "Guests choose the",
    "참가하는 중...": "Joining...",
    "참가하는 중…": "Joining…",
    "참가하지 못했어요. 같은 Wi‑Fi에 연결되어 있는지 확인해 보세요.": "Couldn't join. Make sure you're connected to the same Wi‑Fi.",
    "참가할 수 없어요": "Can't join",
    "채팅": "Chat",
    "채팅 닫기": "Close chat",
    "채팅 메시지 입력": "Type a chat message",
    "채팅 열기": "Open chat",
    "채팅을 시작하세요": "Start chatting",
    "첫 메시지를 보내 보세요!": "Send your first message!",
    "초기 화면": "Home screen",
    "초기 화면으로 돌아갈까요?": "Return to the start screen?",
    "초기화 및 재보정 시작...": "Starting reset and recalibration...",
    "초대 코드": "Invite code",
    "초대 코드 표시 및 복사": "Show & copy invite code",
    "초대 코드가 아직 없어요": "No invite code yet",
    "초대 코드는 설정과 도움말에서 확인할 수 있어요": "You can find the invite code in Settings and Help.",
    "초대와 공유": "Invite & Share",
    "최적 싱크 보정 적용 중...": "Applying optimal sync calibration...",
    "취소": "Cancel",
    "코드를 입력했는데 연결이 안 돼요:": "I entered the code but can't connect:",
    "클릭하여 초대코드 복사": "Click to copy invite code",
    "테마": "Theme",
    "파일 요청 중...": "Requesting file...",
    "파일을 보내고 있어요…": "Sending file…",
    "파일을 선택하거나 플레이리스트를 확인하세요": "Select a file or check the playlist",
    "파일을 선택할 수 없어요": "Can't select a file",
    "파일이 준비됐어요! 재생 버튼을 눌러 보세요.": "Your file is ready! Press Play.",
    "프리로드 누락 - 파일 수신 중...": "Preload missing — receiving file...",
    "프리로드 완료 대기 중...": "Waiting for preload to complete...",
    "프리로드 재생 실패 - 다시 로드합니다": "Preload playback failed — reloading",
    "프리로드된 파일 사용!": "Using preloaded file!",
    "프리앰프": "Preamp",
    "프리앰프 게인": "Preamp gain",
    "플레이리스트 펼치기/접기": "Expand/collapse playlist",
    "플레이리스트에 추가됨": "added to playlist",
    "필수 라이브러리 로드 실패": "Failed to load required libraries",
    "필요하면": "If needed, you can change the role anytime in",
    "하이패스": "High-pass",
    "현재 세션과 연결이 끊어져요.": "You will be disconnected from the current session.",
    "현재 세션은 연결 가능한 기기 수(방장 제외 3대)에 도달했어요.": "This session has reached the device limit (3 excluding the host).",
    "호스트 연결 없음. 로컬 초기화 완료.": "No host connection. Local reset complete.",
    "호스트가 미디어를 재생하면": "When the host starts playback,",
    "호스트만 조작할 수 있어요": "Only the host can control this",
    "호스트만 파일을 추가할 수 있어요": "Only the host can add files",
    "호스트에 연결할 수 없어요": "Can't connect to the host",
    "호스트에서 연결이 종료되었습니다. 메인 화면으로 이동합니다.": "The host ended the connection. Returning to Home.",
    "호스트의 설정에 맞추어": "In sync with the host's settings",
    "호스트의 코드를 입력해주세요.": "Enter the host's code.",
    "홈 화면에 추가": "Add to Home Screen",
    "확인": "OK",
    "확인/새로고침": "OK / Refresh",
    "환경 제한으로 백그라운드 타이머(Worker)를 사용할 수 없어요.": "Due to environment limits, background timers (Worker) aren't available.",
    "환경 제한으로 파일 저장/전송(Worker)을 사용할 수 없어요.": "Due to environment limits, file save/transfer (Worker) isn't available.",
    "회수됨": "revoked"
};

const I18N_EN_REGEX = [
    // Invite code
    [/^초대 코드:\s*(\d{6})$/i, (_m, code) => `Invite code: ${code}`],
    // Connected devices | invite code
    [/^연결된 기기\s*(\d+)대\s*\|\s*초대 코드\s*(\d{6})$/i, (_m, cnt, code) => `Connected devices: ${cnt} | Invite code ${code}`],
    // Added tracks: "3곡을 추가했어요"
    [/^(\d+)곡을 추가했어요$/i, (_m, cnt) => {
        const n = Number(cnt);
        if (!Number.isFinite(n)) return `Added ${cnt} tracks`;
        return n === 1 ? 'Added 1 track' : `Added ${n} tracks`;
    }],
    // Added to playlist: ""Title" 플레이리스트에 추가됨"
    [/^"(.+)"\s*플레이리스트에 추가됨$/i, (_m, title) => `Added "${title}" to playlist`],
    // Preparing / waiting
    [/^준비 중:\s*(.+)$/i, (_m, name) => `Preparing: ${name}`],
    [/^복구 대기 중:\s*(.+)$/i, (_m, name) => `Recovery pending: ${name}`],
    [/^파일 동기화 중:\s*(.+)$/i, (_m, name) => `Syncing file: ${name}`],
    // File save error
    [/^파일 저장 오류:\s*(.+)$/i, (_m, name) => `File save error: ${name}`],
    // Device connection status
    [/^(.+)가\s*연결됐어요$/i, (_m, name) => `${name} connected`],
    [/^(.+)\s*연결이 끊겼어요$/i, (_m, name) => `${name} disconnected`],
    [/^(.+)\s*연결 오류$/i, (_m, name) => `${name} connection error`],
    // Transfer resume
    [/^(.+)로부터\s*전송 이어받기$/i, (_m, src) => `Resume transfer from ${src}`],
    [/^(.+)로부터\s*파일 수신 시작$/i, (_m, src) => `Started receiving file from ${src}`],
    [/^(.+)로부터\s*전송 재개\s*\((.+)부터\)$/i, (_m, src, start) => `Resuming transfer from ${src} (from ${start})`],
    // Receiving progress
    [/^(.+)\s*수신 중\.\.\.\s*(.*)$/i, (_m, src, rest) => `Receiving from ${src}... ${rest}`],
    // Auto sync calibration
    [/^자동 싱크 보정 완료,\s*\+?(\d+)ms$/i, (_m, ms) => `Auto sync calibration done, +${ms}ms`],
    // Reverb type
    [/^리버브 타입:\s*(.+)$/i, (_m, v) => `Reverb type: ${v}`],
    // Host forced sync
    [/^Host 강제 동기화:\s*(.+)$/i, (_m, t) => `Host force sync: ${t}`],
    // Relay connected
    [/^Relay:\s*(.+)\s*연결됨$/i, (_m, id) => `Relay: ${id} connected`],
    // Seek: "00:12로 이동"
    [/^(.+)로\s*이동$/i, (_m, t) => `Seek to ${t}`],
    // Next track preparing: "다음 곡 준비 중... (Track)"
    [/^다음 곡 준비 중\.\.\.\s*\((.+)\)$/i, (_m, name) => `Preparing next track... (${name})`],
];

let _i18nObserver = null;
let _i18nApplying = false;
const _i18nOriginalText = new Map(); // Text node -> { raw, translated }
const _i18nOriginalAttr = new Map(); // Element -> { attrName: { raw, translated } }
let _i18nKeyOrder = null;

function _i18nNorm(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function i18nTranslate(str) {
    // Public helper for UI strings.
    if (_resolvedLanguage !== 'en') return str;
    if (str === null || str === undefined) return str;

    const raw = String(str);
    const lead = raw.match(/^\s*/)?.[0] ?? '';
    const trail = raw.match(/\s*$/)?.[0] ?? '';
    const core = raw.trim();
    const key = _i18nNorm(core);
    if (!key) return raw;

    // 1) Exact match
    let translated = I18N_EN[key];

    // 2) Regex rules (dynamic strings)
    if (!translated) {
        for (const [re, fn] of I18N_EN_REGEX) {
            const m = key.match(re);
            if (!m) continue;
            try {
                translated = (typeof fn === 'function') ? fn(...m) : key.replace(re, fn);
            } catch (_) {
                translated = null;
            }
            break;
        }
    }

    // 3) Fragment replacement fallback (handles things like "OP 권한 부여됨")
    if (!translated) {
        if (!_i18nKeyOrder) {
            _i18nKeyOrder = Object.keys(I18N_EN).sort((a, b) => b.length - a.length);
        }
        let out = key;
        for (const k of _i18nKeyOrder) {
            if (!out.includes(k)) continue;
            out = out.split(k).join(I18N_EN[k]);
        }
        translated = out;
    }

    // Keep original outer whitespace without duplicating it
    let t = translated;
    if (lead) t = t.replace(/^\s+/, '');
    if (trail) t = t.replace(/\s+$/, '');
    return lead + t + trail;
}

function _i18nShouldSkipTextNode(node) {
    try {
        const p = node?.parentNode;
        if (!p || p.nodeType !== 1) return false;
        const tag = p.tagName;
        return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT';
    } catch (_) {
        return false;
    }
}

function _i18nTranslateTextNode(node) {
    if (!node || node.nodeType !== 3) return;
    if (_i18nShouldSkipTextNode(node)) return;

    const raw = node.data;
    if (!raw || !raw.trim()) return;

    const translated = i18nTranslate(raw);
    if (translated === raw) return;

    _i18nOriginalText.set(node, { raw, translated });
    node.data = translated;
}

function _i18nTranslateElementAttrs(el) {
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;

    const attrs = ['aria-label', 'title', 'placeholder', 'alt'];
    for (const a of attrs) {
        if (!el.hasAttribute(a)) continue;
        const raw = el.getAttribute(a);
        if (!raw) continue;

        const translated = i18nTranslate(raw);
        if (translated === raw) continue;

        let store = _i18nOriginalAttr.get(el);
        if (!store) {
            store = {};
            _i18nOriginalAttr.set(el, store);
        }
        store[a] = { raw, translated };
        el.setAttribute(a, translated);
    }
}

function _i18nTranslateSubtree(root) {
    if (_resolvedLanguage !== 'en') return;
    if (!root) return;

    _i18nApplying = true;
    try {
        // Attributes
        if (root.nodeType === 1) {
            _i18nTranslateElementAttrs(root);
            root.querySelectorAll?.('*')?.forEach(el => _i18nTranslateElementAttrs(el));
        }

        // Text nodes
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
            _i18nTranslateTextNode(n);
        }
    } finally {
        _i18nApplying = false;
    }
}

function _i18nRestoreAll() {
    _i18nApplying = true;
    try {
        for (const [node, st] of _i18nOriginalText.entries()) {
            try {
                if (!st) continue;
                const current = node.data;
                if (current === st.translated) node.data = st.raw;
            } catch (_) { /* ignore */ }
        }
        for (const [el, store] of _i18nOriginalAttr.entries()) {
            try {
                for (const [a, st] of Object.entries(store || {})) {
                    if (!st) continue;
                    const cur = el.getAttribute(a);
                    if (cur === st.translated) el.setAttribute(a, st.raw);
                }
            } catch (_) { /* ignore */ }
        }
    } finally {
        _i18nApplying = false;
    }
}

function _resolveSystemLanguage() {
    try {
        const langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || ''];
        const first = String(langs[0] || '').toLowerCase();
        return first.startsWith('ko') ? 'ko' : 'en';
    } catch (_) {
        return 'ko';
    }
}

function _applyResolvedLanguage(resolved) {
    _resolvedLanguage = resolved === 'en' ? 'en' : 'ko';
    try {
        document.documentElement.setAttribute('lang', _resolvedLanguage);
    } catch (_) { /* ignore */ }

    // Ensure observer exists once (best-effort)
    if (!_i18nObserver && typeof MutationObserver !== 'undefined') {
        _i18nObserver = new MutationObserver((mutations) => {
            if (_i18nApplying) return;
            if (_resolvedLanguage !== 'en') return;

            _i18nApplying = true;
            try {
                for (const m of mutations) {
                    if (m.type === 'characterData') {
                        _i18nTranslateTextNode(m.target);
                    } else if (m.type === 'attributes') {
                        _i18nTranslateElementAttrs(m.target);
                    } else if (m.type === 'childList') {
                        m.addedNodes?.forEach(n => {
                            if (n.nodeType === 3) _i18nTranslateTextNode(n);
                            else if (n.nodeType === 1) _i18nTranslateSubtree(n);
                        });
                    }
                }
            } finally {
                _i18nApplying = false;
            }
        });
        try {
            _i18nObserver.observe(document.body || document.documentElement, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true,
                attributeFilter: ['aria-label', 'title', 'placeholder', 'alt']
            });
        } catch (_) { /* ignore */ }
    }

    if (_resolvedLanguage === 'en') {
        _i18nTranslateSubtree(document.body || document.documentElement);
    } else {
        _i18nRestoreAll();
    }
}

function _updateLanguageSelector(mode) {
    try {
        document.querySelectorAll('.lang-opt').forEach(el => el.classList.remove('active'));
        const id = mode === 'ko' ? 'lang-ko' : mode === 'en' ? 'lang-en' : 'lang-system';
        document.getElementById(id)?.classList.add('active');

        // Sliding pill: set index (Korean=0, English=1, System=2)
        const pillIndex = mode === 'ko' ? 0 : mode === 'en' ? 1 : 2;
        document.querySelectorAll('.lang-selector').forEach(sel => {
            sel.style.setProperty('--pill-index', pillIndex);
        });
    } catch (_) { /* ignore */ }
}

function setLanguageMode(mode) {
    // Requirement: Always start internally as "system".
    if (mode !== 'ko' && mode !== 'en' && mode !== 'system') mode = 'system';
    _activeLanguageMode = mode;
    _updateLanguageSelector(mode);

    const resolved = (mode === 'system') ? _resolveSystemLanguage() : mode;
    _applyResolvedLanguage(resolved);
}

(function initLanguageMode() {
    // Start in "System" every time (no persistence).
    setLanguageMode('system');

    // Best-effort: re-apply if browser language changes while in System.
    try {
        window.addEventListener('languagechange', () => {
            if (_activeLanguageMode !== 'system') return;
            _applyResolvedLanguage(_resolveSystemLanguage());
        });
    } catch (_) { /* ignore */ }
})();


// --- Animation Utility ---
window._batchedTransitionCb = null;
window.animateTransition = function (callback) {
    if (!document.startViewTransition) {
        callback();
        return;
    }

    // Batch synchronous calls into a single transition
    if (window._batchedTransitionCb !== null) {
        const oldCb = window._batchedTransitionCb;
        window._batchedTransitionCb = () => { oldCb(); callback(); };
        return;
    }

    window._batchedTransitionCb = callback;
    Promise.resolve().then(() => {
        const cb = window._batchedTransitionCb;
        window._batchedTransitionCb = null;
        if (!cb) return;
        try {
            document.startViewTransition(() => {
                cb();
            });
        } catch (e) {
            cb();
        }
    });
};

// --- Tab Switching ---
function switchTab(tabId) {
    animateTransition(() => {
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        document.getElementById(`tab-${tabId}`).classList.add('active');
        const tabs = ['play', 'playlist', 'settings', 'guide'];
        const idx = tabs.indexOf(tabId);
        if (idx >= 0) document.querySelectorAll('.nav-item')[idx].classList.add('active');

        // Settings 상단 초대코드(Host/Guest 공통) 즉시 반영
        if (tabId === 'settings') {
            updateInviteCodeUI();
        }

        // FIX: YouTube Black Screen & Visualizer Disappearance
        if (tabId === 'play') {
            setTimeout(() => {
                if (currentState === APP_STATE.PLAYING_YOUTUBE) refreshYouTubeDisplay();

                // Ensure visualizer is resized and running
                if (currentState === APP_STATE.IDLE) drawIdleVisualizer();
                else startVisualizer();
            }, 50);
        }

        // Chat drawer logic (previously in a separate wrapper)
        if (isChatDrawerOpen) {
            toggleChatDrawer();
        }
    });
}

// --- Audio System (Tone.js) ---
async function initAudio() {
    // Fast-path: already initialized.
    if (masterGain) {
        if (typeof Tone !== 'undefined' && Tone?.context?.state !== 'running') {
            try { await Tone.start(); } catch (_) { /* best-effort */ }
        }
        return;
    }

    // Prevent concurrent initializations (e.g., play() + slider actions firing together)
    if (_initAudioPromise) return _initAudioPromise;

    _initAudioPromise = (async () => {
        if (typeof Tone === 'undefined' || !Tone?.context) {
            throw new Error('Tone.js not loaded');
        }

        if (Tone.context.state !== 'running') {
            await Tone.start();
        }
        if (masterGain) return; // Another call may have finished while awaiting

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
        // Parallel Path: Source -> LPF -> Chebyshev -> (optional LPF) -> Gain -> Master
        // - For L/R/Center: Chebyshev harmonics are kept (psychoacoustic bass on small speakers)
        // - For Sub/LFE: We keep only low frequencies (filter-based), instead of hard-muting.
        vbFilter = new Tone.Filter(subFreq, "lowpass", -12); // Dynamic crossover/extraction
        vbCheby = new Tone.Chebyshev(50); // Harmonics generator
        vbPostFilter = new Tone.Filter(20000, "lowpass", -12); // Sub/LFE harmonics suppression (configured in applySettings)
        vbGain = new Tone.Gain(0); // Mix level

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

        // 4. Virtual Bass Chain (Parallel)
        // Tap AFTER channel routing (+EQ) so it respects the selected role (L/R/Center/Sub)
        // and doesn't leak the opposite channel in L/R modes.
        eqIn.connect(vbFilter);
        vbFilter.connect(vbCheby);
        vbCheby.connect(vbPostFilter);
        vbPostFilter.connect(vbGain);
        vbGain.connect(masterGain);

        // Visualizer
        analyser = new Tone.Analyser("fft", 2048);
        analyser.smoothing = 0.3; // Lower = more immediate/punchy response
        masterGain.connect(analyser);
        masterGain.toDestination();

        // Initial Defaults
        // - Apply current channelMode routing (user may have selected a role before audio init)
        // - applySettings() is called inside setChannelMode()
        setChannelMode(channelMode);
    })();

    try {
        await _initAudioPromise;
    } finally {
        _initAudioPromise = null;
    }
}


// --- Setup Overlay (Toss In-App Release) ---
// Requirements:
// 1) No Netlify / No TURN / Local network only
// 2) Short code (6 digits) to connect
// 3) Host direct-connect up to 3 devices (host 제외 3대)
// 4) QR/외부링크 금지: 코드 입력으로만 연결
// 5) 역할은 강제하지 않으며, 게스트는 참가 시 4개 역할 중 선택 (추후 Settings에서 변경 가능)

const MAX_GUEST_SLOTS = 3;

// ============================================================================
// [SECTION] GUEST SLOT NAMING (Host-assigned)
// - Guests are always named "Peer 1..N" by the Host.
// - If a Peer leaves, its slot becomes available and the next joiner reuses it.
// ============================================================================

const PEER_NAME_PREFIX = 'Peer';

// Slot index: 1..MAX_GUEST_SLOTS (0 is unused)
const peerSlots = new Array(MAX_GUEST_SLOTS + 1).fill(null); // slot -> peerId
const peerSlotByPeerId = new Map(); // peerId -> slot

// Track currently-active Host-side PeerJS connections to avoid stale close events
// freeing the slot when a duplicate connection is replaced.
const activeHostConnByPeerId = new Map(); // peerId -> PeerJS DataConnection

function getPeerLabelBySlot(slot) {
    return `${PEER_NAME_PREFIX} ${slot}`;
}

function getAvailablePeerSlot(preferredSlot = null, peerId = null) {
    const pref = Number(preferredSlot);
    if (Number.isInteger(pref) && pref >= 1 && pref <= MAX_GUEST_SLOTS) {
        const occupant = peerSlots[pref];
        if (!occupant || occupant === peerId) return pref;
    }
    for (let i = 1; i <= MAX_GUEST_SLOTS; i++) {
        if (!peerSlots[i]) return i;
    }
    return null;
}

function assignPeerSlot(peerId, slot) {
    if (!peerId) return;
    const s = Number(slot);
    if (!Number.isInteger(s) || s < 1 || s > MAX_GUEST_SLOTS) return;
    peerSlots[s] = peerId;
    peerSlotByPeerId.set(peerId, s);
}

function releasePeerSlot(peerId) {
    if (!peerId) return;
    const slot = peerSlotByPeerId.get(peerId);
    if (slot) {
        if (peerSlots[slot] === peerId) peerSlots[slot] = null;
    }
    peerSlotByPeerId.delete(peerId);
}

let appRole = 'idle'; // 'host' | 'guest' | 'idle'
let sessionCode = '';
let lastJoinCode = '';

// Host가 "시작하기"를 눌러 메인 화면으로 진입했는지 (호스트 UI용)
let sessionStarted = false;

// Guest가 참가 시 선택한 역할(채널 모드)
let selectedJoinChannelMode = null;
let pendingPlacementToastMode = null;

// Settings UI: Invite code (Host/Guest 모두 동일하게 표시)
function getInviteCode() {
    // Prefer an active/known host code, then the last join code
    if (sessionCode && /^\d{6}$/.test(sessionCode)) return sessionCode;
    if (lastJoinCode && /^\d{6}$/.test(lastJoinCode)) return lastJoinCode;
    return '------';
}

function updateInviteCodeUI() {
    const code = getInviteCode();
    const elements = document.querySelectorAll('.invite-code-value');
    elements.forEach(el => {
        el.textContent = code;
        el.setAttribute('data-code', code);
    });
}

function getConnectedDeviceCount() {
    // Prefer host-provided roster (guests)
    if (Array.isArray(lastKnownDeviceList) && lastKnownDeviceList.length) {
        return lastKnownDeviceList.filter(d => d && d.status === 'connected').length;
    }

    // Host: self + connected peers
    const peerConnected = connectedPeers.filter(p => p && p.status === 'connected').length;
    if (!hostConn && (appRole === 'host' || sessionStarted || peerConnected > 0)) {
        return 1 + peerConnected;
    }

    // Guest (connected to host but roster not yet received)
    if (hostConn && hostConn.open) return 2;

    return 1;
}

async function copyInviteCode() {
    const code = getInviteCode();
    if (code === '------') return;

    const ok = await copyTextToClipboard(code);

    if (ok) {
        const cnt = getConnectedDeviceCount();
        showToast(`연결된 기기 ${cnt}대 | 초대 코드 ${code}`);

        // Visual feedback for all containers
        const values = document.querySelectorAll('.invite-code-value');
        values.forEach(el => {
            el.classList.add('copied');
            setTimeout(() => el.classList.remove('copied'), 1000);
        });
    } else {
        showToast("복사하지 못했어요");
    }
}

function setupEl(id) { return document.getElementById(id); }

// --- Overlay state helpers (CSS :has() fallback) ---
// Some browsers/WebViews don't support :has(), so we also toggle a body class.
const _OVERLAY_IDS = ['setup-overlay', 'media-source-overlay', 'youtube-url-overlay'];

function updateOverlayOpenClass() {
    try {
        const anyActive = _OVERLAY_IDS.some((id) => {
            const el = document.getElementById(id);
            return !!(el && el.classList && el.classList.contains('active'));
        });
        if (document.body) document.body.classList.toggle('overlay-open', anyActive);
    } catch (_) { /* ignore */ }
}

function initOverlayOpenObserver() {
    try {
        const obs = new MutationObserver(() => updateOverlayOpenClass());
        _OVERLAY_IDS.forEach((id) => {
            const el = document.getElementById(id);
            if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
        });
    } catch (_) { /* ignore */ }

    // Initial sync
    updateOverlayOpenClass();
}

function showSetupOverlay() {
    animateTransition(() => {
        const ov = setupEl('setup-overlay');
        if (ov) ov.classList.add('active');
        updateOverlayOpenClass();
        // Re-enable interactions once the overlay is mounted
        try { document.documentElement.classList.remove('setup-boot-block'); } catch (_) { /* ignore */ }
        _setupOverlayEverShown = true;
    });
}

function hideSetupOverlay() {
    animateTransition(() => {
        const overlay = setupEl('setup-overlay');
        if (overlay) overlay.classList.remove('active');
        updateOverlayOpenClass();
        stopObAutoSlide();
        try { document.documentElement.classList.remove('setup-boot-block'); } catch (_) { /* ignore */ }

        // iOS PWA: closing the setup overlay can leave the bottom bar in a "pre-layout" state
        // until a reflow happens (e.g., a tab switch). Nudge layout once here.
        try {
            requestAnimationFrame(() => {
                // Reflow nudge only (no resize dispatch; avoids triggering layout jitter on some iOS PWAs)
                try { void document.documentElement.offsetHeight; } catch (_) { /* ignore */ }
            });
        } catch (_) { /* ignore */ }
    });
}

function setupShowCodeArea(show) {
    animateTransition(() => {
        const box = setupEl('setup-code-area');
        if (box) box.style.display = show ? 'flex' : 'none';
        syncDesktopLeftPanel();
    });
}

function setupSetCode(code) {
    const el = setupEl('setup-code');
    if (el) {
        if (el.tagName === 'INPUT') el.value = code || '------';
        else el.textContent = code || '------';
    }
    setupShowCodeArea(!!code);
}

function setupShowInstruction(show, text = '') {
    const el = setupEl('setup-instruction');
    if (!el) return;
    el.style.display = show ? 'block' : 'none';
    el.textContent = text || '';
}

function setupShowJoinArea(show) {
    animateTransition(() => {
        const el = setupEl('setup-join-area');
        if (el) el.style.display = show ? 'flex' : 'none';
        syncDesktopLeftPanel();
    });
}

function setupShowRoleArea(show) {
    animateTransition(() => {
        const el = setupEl('setup-role-area');
        if (el) el.style.display = show ? 'flex' : 'none';
        syncDesktopLeftPanel();
    });
}

function setupShowWelcome(show) {
    animateTransition(() => {
        const el = setupEl('setup-welcome-area');
        if (el) el.style.display = show ? 'flex' : 'none';
        syncDesktopLeftPanel();
    });
}

/* ===== Desktop Left-Panel Sync (header + diagram mirroring) ===== */
let _desktopSyncedDiagram = null; // reference to the element currently moved into the left panel
let _desktopSyncedDiagramParent = null; // original parent to return it to
let _desktopSyncedDiagramNextSibling = null; // original next sibling for precise reinsertion

function isDesktopLayout() {
    return window.matchMedia('(min-width: 1280px)').matches;
}

/** Return the moved diagram element to its original parent at its original position */
function _restoreDesktopDiagram() {
    if (_desktopSyncedDiagram && _desktopSyncedDiagramParent) {
        try {
            // insertBefore(node, null) === appendChild, so this handles both cases
            _desktopSyncedDiagramParent.insertBefore(_desktopSyncedDiagram, _desktopSyncedDiagramNextSibling || null);
        } catch (_) { }
    }
    _desktopSyncedDiagram = null;
    _desktopSyncedDiagramParent = null;
    _desktopSyncedDiagramNextSibling = null;
    const hc = document.getElementById('desktop-step-header');
    const dc = document.getElementById('desktop-diagram-area');
    if (hc) hc.innerHTML = '';
    if (dc) dc.innerHTML = '';
}

function syncDesktopLeftPanel() {
    const headerContainer = document.getElementById('desktop-step-header');
    const diagramContainer = document.getElementById('desktop-diagram-area');
    if (!headerContainer || !diagramContainer) return;

    // If NOT desktop, restore everything and bail
    if (!isDesktopLayout()) {
        _restoreDesktopDiagram();
        return;
    }

    // Return any previously moved diagram element to its original parent
    if (_desktopSyncedDiagram && _desktopSyncedDiagramParent) {
        try {
            _desktopSyncedDiagramParent.insertBefore(_desktopSyncedDiagram, _desktopSyncedDiagramNextSibling || null);
        } catch (_) { }
        _desktopSyncedDiagram = null;
        _desktopSyncedDiagramParent = null;
        _desktopSyncedDiagramNextSibling = null;
    }
    diagramContainer.innerHTML = '';
    headerContainer.innerHTML = '';

    // Determine which area is currently visible
    const areas = [
        { id: 'setup-welcome-area', diagram: () => document.getElementById('ob-slider-area') },
        { id: 'setup-role-area', diagram: (el) => el.querySelector('.setup-graphic-container') },
        { id: 'setup-join-area', diagram: (el) => el.querySelector('.setup-guide-unified') },
        { id: 'setup-code-area', diagram: (el) => el.querySelector('.setup-guide-unified') },
    ];

    for (const area of areas) {
        const areaEl = document.getElementById(area.id);
        if (!areaEl || areaEl.style.display === 'none') continue;

        // Mirror header text to left panel
        const headerSrc = areaEl.querySelector('.setup-header-text');
        if (headerSrc) {
            headerContainer.innerHTML = headerSrc.innerHTML;
        }

        // Move diagram element to left panel
        const diagramEl = area.diagram(areaEl);
        if (diagramEl) {
            _desktopSyncedDiagramParent = diagramEl.parentElement;
            _desktopSyncedDiagramNextSibling = diagramEl.nextSibling; // remember position for reinsertion
            _desktopSyncedDiagram = diagramEl;
            diagramContainer.appendChild(diagramEl);
        }

        break; // only process the first visible area
    }
}

/* Listen for viewport changes to restore/move elements */
try {
    const _desktopMql = window.matchMedia('(min-width: 1280px)');
    _desktopMql.addEventListener('change', () => {
        syncDesktopLeftPanel();
    });
} catch (_) { }

function setupSetGuestJoinBusy(busy) {
    const input = setupEl('setup-join-code');
    if (input) input.disabled = !!busy;

    const grid = setupEl('setup-role-grid');
    if (grid) {
        grid.style.pointerEvents = busy ? 'none' : 'auto';
        grid.style.opacity = busy ? '0.6' : '1';
    }
}

function setupHighlightJoinRole(mode) {
    // Buttons
    const opts = document.querySelectorAll('#setup-role-grid .ch-opt[data-join-ch]');
    opts.forEach(o => o.classList.remove('selected')); // Use 'selected' as per CSS
    if (mode !== null && mode !== undefined) {
        const el = document.querySelector(`#setup-role-grid .ch-opt[data-join-ch="${mode}"]`);
        if (el) el.classList.add('selected');
    }

    // Speakers (SVG) - Also highlight here to ensure consistency if called from outside click handler
    const speakers = document.querySelectorAll('.setup-graphic-svg .graphic-speaker');
    speakers.forEach(el => el.classList.remove('active'));

    let targetId = null;
    if (mode === -1) targetId = 'svg-spk-l';
    else if (mode === 1) targetId = 'svg-spk-r';
    else if (mode === 0) targetId = 'svg-spk-center';
    else if (mode === 2) targetId = 'svg-spk-woofer';

    if (targetId) {
        const spk = document.getElementById(targetId);
        if (spk) spk.classList.add('active');
    }
}

function selectStandardChannelButton(mode) {
    const all = document.querySelectorAll('#grid-standard .ch-opt[data-ch]');
    all.forEach(e => e.classList.remove('active'));
    const el = document.querySelector(`#grid-standard .ch-opt[data-ch="${mode}"]`);
    if (el) el.classList.add('active');
}

// --------------------------------------------------------------------------
// Toss In-App Release: Role(채널) 단순화
// - 원본/왼쪽/오른쪽/저음 4개만 UI로 노출
// - Setup/Settings 모두 동일한 정의를 사용(중복 제거)
// --------------------------------------------------------------------------

const STANDARD_ROLE_MAP = {
    '0': { mode: 0, label: 'Original', placementToast: '기기를 중앙에 놓아주세요' },
    '-1': { mode: -1, label: 'Left', placementToast: '기기를 왼쪽에 놓아주세요' },
    '1': { mode: 1, label: 'Right', placementToast: '기기를 오른쪽에 놓아주세요' },
    '2': { mode: 2, label: 'Woofer', placementToast: '기기를 중앙에 놓아주세요' },
};

function getStandardRolePreset(mode) {
    const key = String(mode);
    return STANDARD_ROLE_MAP[key] || STANDARD_ROLE_MAP['0'];
}

function getRoleLabelByChannelMode(mode) {
    return getStandardRolePreset(mode).label;
}

function showPlacementToastForChannel(mode) {
    showToast(getStandardRolePreset(mode).placementToast);
}

function setupRenderActions(buttons, layout = 'row') {
    const area = setupEl('setup-actions');
    if (!area) return;
    area.innerHTML = '';

    area.classList.remove('vertical', 'horizontal-with-back');
    if (layout === 'vertical') {
        area.classList.add('vertical');
    } else if (layout === 'horizontal-with-back') {
        area.classList.add('horizontal-with-back');
    }

    buttons.forEach(btn => {
        const b = document.createElement('button');
        b.id = btn.id;
        b.type = 'button';

        if (btn.kind === 'secondary') {
            b.className = 'btn-ob-secondary';
        } else if (btn.kind === 'text-link') {
            b.className = 'btn-ob-text-link';
        } else if (btn.kind === 'icon-only') {
            b.className = 'btn-ob-icon';
        } else {
            b.className = 'btn-ob-primary';
        }

        if (btn.html) {
            b.innerHTML = btn.html;
        } else {
            b.textContent = btn.text;
        }

        if (btn.disabled) b.disabled = true;
        if (btn.onClick) b.addEventListener('click', btn.onClick);
        area.appendChild(b);
    });
}

// Onboarding Slider State
let currentObSlide = 0;
const totalObSlides = 4;
let obAutoSlideTimer = null;

/**
 * --- Onboarding Slider Helpers ---
 */
function startObAutoSlide() {
    stopObAutoSlide();
    obAutoSlideTimer = setInterval(() => {
        nextObSlide(true); // true means auto
    }, 5000);
}

function stopObAutoSlide() {
    if (obAutoSlideTimer) {
        clearInterval(obAutoSlideTimer);
        obAutoSlideTimer = null;
    }
}
function updateObSlider() {
    const track = setupEl('ob-slider-track');
    const dots = document.querySelectorAll('.ob-dot');
    if (!track) return;

    track.style.transform = `translateX(-${currentObSlide * 100}%)`;

    dots.forEach((dot, idx) => {
        dot.classList.toggle('active', idx === currentObSlide);
    });
}

function nextObSlide(isAuto = false) {
    if (currentObSlide < totalObSlides - 1) {
        currentObSlide++;
    } else {
        currentObSlide = 0;
    }
    updateObSlider();
    // CRITICAL: if intent is manual (!isAuto), we MUST reset the timer.
    // However, event objects are truthy, so we must be careful.
    if (isAuto === true) {
        // Just auto slide, do nothing
    } else {
        startObAutoSlide(); // Reset for manual
    }
}

function prevObSlide() {
    if (currentObSlide > 0) {
        currentObSlide--;
    } else {
        currentObSlide = totalObSlides - 1;
    }
    updateObSlider();
    startObAutoSlide(); // Reset timer for manual
}

function showRoleSelectionButtons() {
    setupRenderActions([
        { id: 'btn-setup-host', text: '제가 방장할래요', kind: 'primary', onClick: startHostFlow },
        { id: 'btn-setup-guest', text: '모임에 참여할래요', kind: 'secondary', onClick: startGuestFlow },
    ], 'vertical');
}

/**
 * --- Setup Overlay Initialization ---
 */

// Setup overlay mount timing
let _setupOverlayEverShown = false;
let _setupOverlayInitToken = 0;

// Boot Splash removed (no longer used)

/**
 * Wait before showing the Setup overlay so the underlying layout can settle first.
 * - We delay on ALL OS for consistency.
 * - On iOS "홈 화면에 추가"(standalone), also prefer the internal pwaStable signal.
 */


/**
 * --- Setup Overlay Initialization ---
 */
function initSetupOverlay() {
    const token = ++_setupOverlayInitToken;

    // Reset UI blocks
    const sliderArea = setupEl('ob-slider-area');
    if (sliderArea) sliderArea.style.display = 'block';

    // Graphic containers are now static in HTML


    setupShowCodeArea(false);
    setupShowJoinArea(false);
    setupShowRoleArea(false);
    setupShowWelcome(true);
    setupShowInstruction(false, '');
    setupSetGuestJoinBusy(false);

    // Reset state
    appRole = 'idle';
    sessionCode = '';
    currentObSlide = 0; // Start at first slide
    sessionStarted = false;
    selectedJoinChannelMode = null;
    pendingPlacementToastMode = null;

    // Header pill: 초기 상태 표시
    updateRoleBadge();

    updateObSlider();
    showRoleSelectionButtons();

    const showAndStart = () => {
        if (token !== _setupOverlayInitToken) {
            return;
        }
        // Update viewport height CSS var once (safe-area uses CSS env) before revealing UI.
        try { freezeLayoutMetricsOnce({ force: true }); } catch (_) { /* ignore */ }
        showSetupOverlay();
        startObAutoSlide();
    };

    // On the very first app launch, show Setup immediately.
    if (!_setupOverlayEverShown) {
        try { document.documentElement.classList.add('setup-boot-block'); } catch (_) { /* ignore */ }
        showAndStart();
    } else {
        showAndStart();
    }

    // Bind slider events
    const btnNext = setupEl('ob-next');
    if (btnNext) btnNext.onclick = () => nextObSlide(false);
    const btnPrev = setupEl('ob-prev');
    if (btnPrev) btnPrev.onclick = () => prevObSlide();

    document.querySelectorAll('.ob-dot').forEach(dot => {
        dot.onclick = (e) => {
            currentObSlide = parseInt(e.target.dataset.idx);
            updateObSlider();
            startObAutoSlide(); // Reset timer on manual click
        };
    });

    // Handle Swipe
    const viewport = setupEl('ob-slider-viewport');
    if (viewport) {
        let startX = 0;
        viewport.ontouchstart = (e) => { startX = e.touches[0].clientX; };
        viewport.ontouchend = (e) => {
            const endX = e.changedTouches[0].clientX;
            const diff = startX - endX;
            if (Math.abs(diff) > 50) {
                if (diff > 0) nextObSlide(false);
                else prevObSlide();
            }
        };
    }
}

/**
 * Mini Slider for Setup Connection Guides
 */
function initSetupInnerSlider(sliderId) {
    const slider = document.getElementById(sliderId);
    if (!slider) return;

    const track = slider.querySelector('.setup-inner-track');
    const dots = slider.querySelectorAll('.setup-inner-dot');
    let currentIdx = 0;
    const totalSlides = slider.querySelectorAll('.setup-inner-slide').length;

    const update = () => {
        if (track) track.style.transform = `translateX(-${(currentIdx * 100) / totalSlides}%)`;
        dots.forEach((dot, i) => dot.classList.toggle('active', i === currentIdx));
    };

    // Correct track width for multi-slide
    if (track) track.style.width = `${totalSlides * 100}%`;

    let timer = setInterval(() => {
        currentIdx = (currentIdx + 1) % totalSlides;
        update();
    }, 4500);

    const btnNext = slider.querySelector('.setup-inner-arrow.right');
    const btnPrev = slider.querySelector('.setup-inner-arrow.left');

    const stopAuto = () => { if (timer) { clearInterval(timer); timer = null; } };

    if (btnNext) btnNext.onclick = (e) => { e.stopPropagation(); stopAuto(); currentIdx = (currentIdx + 1) % totalSlides; update(); };
    if (btnPrev) btnPrev.onclick = (e) => { e.stopPropagation(); stopAuto(); currentIdx = (currentIdx + totalSlides - 1) % totalSlides; update(); };

    // Swipe support
    let startX = 0;
    slider.ontouchstart = (e) => { stopAuto(); startX = e.touches[0].clientX; };
    slider.ontouchend = (e) => {
        const diff = startX - e.changedTouches[0].clientX;
        if (Math.abs(diff) > 30) {
            if (diff > 0) currentIdx = (currentIdx + 1) % totalSlides;
            else currentIdx = (currentIdx + totalSlides - 1) % totalSlides;
            update();
        }
    };

    update(); // Initial call
}



function startSessionFromHost() {
    if (appRole !== 'host') return;

    sessionStarted = true;
    hideSetupOverlay();

    // Host UX
    showToast('초대 코드는 설정과 도움말에서 확인할 수 있어요');
    updateRoleBadge();



    // 깜빡임 효과 (미디어 재생 버튼 안내)
    setTimeout(() => {
        const btn = document.getElementById('btn-media-source');
        if (btn) {
            btn.classList.add('blink-hint');
            btn.addEventListener('animationend', () => {
                btn.classList.remove('blink-hint');
            }, { once: true });
        }
    }, 400);
}

// Setup State
let pendingSetupRole = null;

async function startHostFlow() {
    try {
        await activateAudio();
    } catch (e) {
        log.warn('[Audio] activateAudio failed (host flow):', e);
        showToast('오디오를 준비하지 못했어요. 화면을 한 번 터치한 뒤 다시 시도해 보세요.');
    }

    appRole = 'host';
    sessionStarted = false;
    selectedJoinChannelMode = null;
    pendingPlacementToastMode = null;
    pendingSetupRole = null; // Reset

    // Step 1: Role Selection
    setupShowJoinArea(false);
    setupShowCodeArea(false);
    setupShowWelcome(false);
    setupShowRoleArea(true);
    setupShowInstruction(false); // Use internal note in setup-role-area instead
    setupHighlightJoinRole(null); // Reset visual selection

    // Hide slider area but keep note
    // Graphic container is now embedded in setup-role-area
    // Unified guide layout used instead of slider


    const sliderArea = setupEl('ob-slider-area');
    if (sliderArea) {
        sliderArea.style.display = 'none';
        stopObAutoSlide();
    }

    // Back icon + '다음으로'
    setupRenderActions([
        { id: 'btn-setup-back', html: '<svg viewBox="0 0 24 24"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>', kind: 'icon-only', onClick: () => initSetupOverlay() },
        {
            id: 'btn-setup-next',
            text: '다음으로',
            kind: 'primary',
            disabled: false,
            onClick: () => {
                if (pendingSetupRole !== null) {
                    proceedToHostCode(pendingSetupRole);
                } else {
                    showToast('역할을 선택해주세요');
                }
            }
        }
    ], 'horizontal-with-back');
}

async function proceedToHostCode(mode) {
    if (appRole !== 'host') return;

    // Apply role immediately
    try {
        selectStandardChannelButton(mode);
        setChannelMode(mode);
    } catch (e) { log.warn(e); }

    // Step 2: Show Code
    setupShowRoleArea(false);
    setupShowCodeArea(true);

    const codeEl = setupEl('setup-code');
    if (codeEl) {
        if (codeEl.tagName === 'INPUT') codeEl.value = '------';
        else codeEl.textContent = '------';
    }

    // Temporary actions (loading state)
    setupRenderActions([
        { id: 'btn-setup-back', html: '<svg viewBox="0 0 24 24"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>', kind: 'icon-only', onClick: () => startHostFlow() },
        { id: 'btn-setup-confirm', text: '잠시만요...', kind: 'secondary', disabled: true }
    ], 'horizontal-with-back');

    try {
        const code = await createHostSessionWithShortCode();
        sessionCode = code;
        setupSetCode(code);

        updateInviteCodeUI();
        myDeviceLabel = 'HOST';
        updateRoleBadge();

        // Instruction is now embedded in HTML (label above input)
        setupShowInstruction(false);

        // Show "Start" + Back button 
        setupRenderActions([
            { id: 'btn-setup-back', html: '<svg viewBox="0 0 24 24"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>', kind: 'icon-only', onClick: () => startHostFlow() },
            { id: 'btn-setup-confirm', text: '시작하기', kind: 'primary', onClick: startSessionFromHost }
        ], 'horizontal-with-back');
    } catch (e) {
        log.error('[Setup] Host session init failed', e);
        showToast('세션을 만들지 못했어요');
        startHostFlow();
    }
}

async function startGuestFlow() {
    try {
        await activateAudio();
    } catch (e) {
        log.warn('[Audio] activateAudio failed (guest flow):', e);
        showToast('오디오를 준비하지 못했어요. 화면을 한 번 터치한 뒤 다시 시도해 보세요.');
    }

    appRole = 'guest';
    sessionStarted = false;
    selectedJoinChannelMode = null;
    pendingPlacementToastMode = null;
    pendingSetupRole = null; // Reset

    updateInviteCodeUI();

    // Step 1: Role Selection
    setupShowCodeArea(false);
    setupShowJoinArea(false);
    setupShowWelcome(false);
    setupShowRoleArea(true);
    setupShowInstruction(false); // Use internal note in setup-role-area
    setupHighlightJoinRole(null);
    setupSetGuestJoinBusy(false);

    // Hide slider area but keep note
    // Note: setup-note might be hidden/shown depending on logic.
    // In new design, setup-note is inside role area. We should hide the global one if exists.
    const globalNote = document.querySelector('.onboarding-card > .setup-note');
    if (globalNote) globalNote.style.display = 'none';

    const sliderArea = setupEl('ob-slider-area');
    if (sliderArea) {
        sliderArea.style.display = 'none';
        stopObAutoSlide();
    }

    setupRenderActions([
        { id: 'btn-setup-back', html: '<svg viewBox="0 0 24 24"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>', kind: 'icon-only', onClick: () => initSetupOverlay() },
        {
            id: 'btn-setup-next',
            text: '다음으로',
            kind: 'primary',
            disabled: false,
            onClick: () => {
                if (pendingSetupRole !== null) {
                    proceedToGuestCode(pendingSetupRole);
                } else {
                    showToast('역할을 선택해주세요');
                }
            }
        }
    ], 'horizontal-with-back');

    // Visual Update
    myDeviceLabel = '참가자';
    updateRoleBadge();
}

function proceedToGuestCode(mode) {
    pendingGuestRoleMode = mode;

    // Step 2: Show Input
    setupShowRoleArea(false);
    setupShowJoinArea(true);
    setupShowInstruction(false); // Use internal label in setup-join-area

    // Initialize the slider for Guest guide
    // Unified guide layout used instead of slider


    // Apply role locally for preview? (Optional, but user said "Guest sets role then inputs number")
    // We already stored it in pendingGuestRoleMode.

    // Show "Start" + Back button
    setupRenderActions([
        { id: 'btn-setup-back', html: '<svg viewBox="0 0 24 24"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>', kind: 'icon-only', onClick: () => startGuestFlow() },
        { id: 'btn-setup-confirm', text: '시작하기', kind: 'primary', onClick: () => handleSetupJoinWithRole(pendingGuestRoleMode) }
    ], 'horizontal-with-back');

    const input = setupEl('setup-join-code');
    if (input) {
        input.value = '';
        input.focus();
    }
}

// Guest: Selected role mode (pending confirm)
let pendingGuestRoleMode = null;

function showGuestConnecting() {
    // We no longer show standalone instruction text
    // setupShowInstruction(true, '참가하는 중…');
    setupSetGuestJoinBusy(true);
}

// --- Setup Role Grid Click Handler ---
// This handles the "manual selection" logic for both Host/Guest
const _setupRoleGrid = document.getElementById('setup-role-grid');
if (_setupRoleGrid) {
    _setupRoleGrid.addEventListener('click', (e) => {
        const item = e.target.closest('.ch-opt');
        if (!item) return;
        const mode = parseInt(item.dataset.joinCh);
        if (isNaN(mode)) return;

        handleSetupRolePreview(mode);
    });
}

// --- Setup SVG Speaker Click Handler ---
// Shared handler for speaker icon clicks (used in both mobile and desktop diagram areas)
function _handleSpeakerClick(e) {
    const item = e.target.closest('.graphic-speaker');
    if (!item) return;

    const SVG_ID_TO_MODE = { 'svg-spk-l': -1, 'svg-spk-r': 1, 'svg-spk-center': 0, 'svg-spk-woofer': 2 };
    const mode = SVG_ID_TO_MODE[item.id];
    if (mode !== undefined) handleSetupRolePreview(mode);
}

const _roleArea = document.getElementById('setup-role-area');
if (_roleArea) _roleArea.addEventListener('click', _handleSpeakerClick);

// Desktop: diagram is reparented to #desktop-diagram-area, so listen there too
const _desktopDiagramArea = document.getElementById('desktop-diagram-area');
if (_desktopDiagramArea) _desktopDiagramArea.addEventListener('click', _handleSpeakerClick);

// Back button handler for Role Area
const _btnRoleBack = document.getElementById('btn-role-back');
if (_btnRoleBack) {
    _btnRoleBack.onclick = (e) => {
        e.stopPropagation();
        initSetupOverlay(); // Go back to very start
    };
}

function handleSetupRolePreview(mode) {
    if (appRole !== 'guest' && appRole !== 'host') return;
    pendingSetupRole = mode;
    setupHighlightJoinRole(mode);

    // Show placement toast immediately on selection
    showPlacementToastForChannel(mode);

    // Visual feedback: Activate Next button
    const nextBtn = document.getElementById('btn-setup-next');
    if (nextBtn) {
        nextBtn.classList.remove('btn-ob-secondary');
        nextBtn.classList.add('btn-ob-primary');
    }
}



async function handleSetupJoinWithRole(mode) {
    if (mode === null || mode === undefined) {
        showToast('역할을 선택해 주세요');
        return;
    }
    if (appRole !== 'guest') {
        await startGuestFlow();
    }

    const input = setupEl('setup-join-code');
    const codeRaw = (input ? input.value : '').trim();
    const code = codeRaw.replace(/\s+/g, '');

    if (!/^\d{6}$/.test(code)) {
        showToast('6자리 코드를 입력해 주세요');
        if (input) input.focus();
        return;
    }

    lastJoinCode = code;
    updateInviteCodeUI();

    selectedJoinChannelMode = mode;
    pendingPlacementToastMode = mode;

    // Ensure we're in Standard mode
    try {
        const chk = document.getElementById('chk-surround');
        if (chk) chk.checked = false;
        if (typeof isSurroundMode !== 'undefined' && isSurroundMode) toggleSurroundMode(false);
    } catch (e) { /* noop */ }

    // Apply channel routing locally (no toast here)
    try {
        selectStandardChannelButton(mode);
        setChannelMode(mode);
    } catch (e) {
        log.warn('[Setup] setChannelMode failed', e);
    }

    // IMPORTANT: Device label is Host-assigned ("Peer N") after join.
    // Keep a neutral placeholder while connecting (do NOT overwrite with role label).
    myDeviceLabel = PEER_NAME_PREFIX;
    updateRoleBadge();

    // Start network + join
    showGuestConnecting();
    isConnecting = true;
    updateRoleBadge();

    // Update button to "참가하는 중..." and disable
    setupRenderActions([
        { id: 'btn-setup-back', html: '<svg viewBox="0 0 24 24"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>', kind: 'icon-only', onClick: () => startGuestFlow() },
        { id: 'btn-setup-confirm', text: '참가하는 중...', kind: 'primary', onClick: null, disabled: true }
    ], 'horizontal-with-back');

    initNetwork(null)
        .then(() => joinSession(0, code))
        .catch((e) => {
            log.error('[Setup] Guest init/join failed', e);
            isConnecting = false;
            updateRoleBadge();
            showToast('참가하지 못했어요. 같은 Wi‑Fi에 연결되어 있는지 확인해 보세요.');

            // Stay on Join screen, re-enable button
            setupRenderActions([
                { id: 'btn-setup-back', html: '<svg viewBox="0 0 24 24"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>', kind: 'icon-only', onClick: () => startGuestFlow() },
                { id: 'btn-setup-confirm', text: '시작하기', kind: 'primary', onClick: () => handleSetupJoinWithRole(pendingGuestRoleMode) }
            ], 'horizontal-with-back');

            const i = setupEl('setup-join-code');
            if (i) {
                i.value = code; // Keep the typed code
                i.disabled = false;
                i.focus();
            }
            setupSetGuestJoinBusy(false);
        });
}


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
    // Tone.js must be available (CDN failure / blocked network guard)
    if (typeof Tone === 'undefined' || !Tone || !Tone.context) {
        showToast('오디오 엔진을 불러오지 못했어요. 네트워크를 확인해 보세요.');
        return;
    }

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

// Legacy entry points (delegate to current flow functions)
window.actionCreateRoom = startHostFlow;
window.actionJoinRoom = startGuestFlow;
window.actionEnterSession = startGuestFlow;

/**
 * UI Update Logic for Status Pill
 */
function getAudioRoleLabelForBadge() {
    // Toss 인앱 출시용 UI에서는 4개 역할(원본/왼쪽/오른쪽/저음)만 표시합니다.
    // (Surround 기능은 내부 코드에 남아 있어도 UI에서는 숨김)
    return getRoleLabelByChannelMode(channelMode);
}

function updateRoleBadge() {
    const badge = document.getElementById('role-badge');
    const text = document.getElementById('role-text');

    if (!badge || !text) return;

    // Reset
    badge.classList.remove('connected');

    // Update based on state
    if (isConnecting) {
        text.innerText = '연결 중...';
        return;
    }

    // Guest: connected to host
    if (hostConn) {
        const latencyTxt = (lastLatencyMs && Number.isFinite(lastLatencyMs)) ? ` (${Math.round(lastLatencyMs)}ms)` : '';
        const label = (myDeviceLabel && String(myDeviceLabel).trim()) ? String(myDeviceLabel).trim() : 'Peer';
        // 표시 규칙: 역할(Original/Left/Right/Woofer 등)은 숨기고 이름만 노출
        text.innerText = `${label}${latencyTxt}`;
        badge.classList.add('connected');
        return;
    }

    // Host: show device label + role
    if (appRole === 'host' || connectedPeers.length > 0) {
        text.innerText = 'Host';
        badge.classList.add('connected');
        return;
    }

    // Guest flow but not connected yet
    if (appRole === 'guest') {
        text.innerText = 'Guest';
        return;
    }

    text.innerText = 'SETUP';
}

// Wrapper function to check guest before triggering file input
function openFileSelector() {
    // Host-only action. Guests are blocked.
    if (hostConn) {
        showToast("Host만 실행할 수 있습니다.");
        return;
    }

    const input = document.getElementById('file-input');
    if (!input) {
        log.warn('[UI] #file-input not found; cannot open file selector');
        showToast('파일을 선택할 수 없어요');
        return;
    }

    input.click();
}

/**
 * [Android UX] Prevent vertical scrolling while dragging sliders.
 *
 * On some Android Chrome/WebView builds, horizontal drags on <input type="range">
 * can also scroll the surrounding .tab-content container, which feels broken
 * (especially for seek/volume/EQ sliders).
 *
 * We keep the CSS fix (touch-action: pan-x) and add a small JS fallback that
 * temporarily locks the scroll container while the user is touching a slider.
 */
function installAndroidRangeScrollFix() {
    if (!IS_ANDROID) return;
    try {
        const ranges = Array.from(document.querySelectorAll('input[type="range"]'));
        ranges.forEach((range) => {
            const scrollParent = range.closest('.tab-content');
            if (!scrollParent) return;

            let prevOverflowY = null;
            const lock = () => {
                // Cache previous inline value only once per interaction
                if (prevOverflowY === null) prevOverflowY = scrollParent.style.overflowY;
                scrollParent.style.overflowY = 'hidden';
            };
            const unlock = () => {
                scrollParent.style.overflowY = (prevOverflowY !== null) ? prevOverflowY : '';
                prevOverflowY = null;
            };

            range.addEventListener('touchstart', lock, { passive: true });
            range.addEventListener('touchend', unlock, { passive: true });
            range.addEventListener('touchcancel', unlock, { passive: true });
        });
    } catch (e) {
        log.debug('[Android] Range scroll fix init failed:', e?.message || e);
    }
}

// Auto-run init
function initEventListeners() {
    // Helper: safely bind events by ID (null-safe)
    const $on = (id, evt, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); };

    // --- Header ---
    $on('btn-help', 'click', openHelpModal);
    $on('btn-fullscreen', 'click', toggleFullscreen);

    // Role badge (top-right): show/copy pairing code quickly
    const roleBadge = document.getElementById('role-badge');
    if (roleBadge) {
        try {
            roleBadge.setAttribute('role', 'button');
            roleBadge.setAttribute('tabindex', '0');
            roleBadge.setAttribute('aria-label', '초대 코드 표시 및 복사');
        } catch (_) { /* ignore */ }

        const onShowCode = async (e) => {
            try {
                e?.preventDefault?.();
                e?.stopPropagation?.();
            } catch (_) { /* ignore */ }

            const code = getInviteCode();
            if (!code || code === '------') {
                showToast('초대 코드가 아직 없어요');
                return;
            }

            const ok = await copyTextToClipboard(code);
            if (ok) {
                const cnt = getConnectedDeviceCount();
                showToast(`연결된 기기 ${cnt}대 | 초대 코드 ${code}`);
            } else {
                showToast(`초대 코드: ${code}`);
            }
        };

        roleBadge.addEventListener('click', onShowCode);
        roleBadge.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            onShowCode(e);
        });
    }

    // Logo: return to main screen (with confirmation if a session is active)
    const logo = document.getElementById('app-logo') || document.querySelector('.app-logo');
    if (logo) {
        logo.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleLogoReturnToMain();
        });
        logo.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            handleLogoReturnToMain();
        });
    }

    // --- Player Controls ---
    $on('btn-prev', 'click', playPrevTrack);
    $on('play-btn', 'click', togglePlay);
    $on('btn-next', 'click', playNextTrack);
    $on('vol-icon-btn', 'click', toggleMute);
    $on('volume-slider', 'input', function () { onVolInput(this.value); });
    $on('volume-slider', 'change', function () { onVolChange(this.value); });
    $on('chat-preview-btn', 'click', toggleChatDrawer);
    $on('btn-sync', 'click', handleMainSyncBtn);
    $on('btn-media-source', 'click', openMediaSourcePopup);

    // --- Playlist Tab ---
    $on('btn-repeat', 'click', toggleRepeat);
    $on('btn-shuffle', 'click', toggleShuffle);
    $on('btn-add-media', 'click', openMediaSourcePopup);

    // --- Settings: Theme ---
    $on('theme-light', 'click', () => setTheme('light'));
    $on('theme-dark', 'click', () => setTheme('dark'));
    $on('theme-system', 'click', () => setTheme('system'));

    // --- Settings: Language ---
    $on('lang-ko', 'click', () => setLanguageMode('ko'));
    $on('lang-en', 'click', () => setLanguageMode('en'));
    $on('lang-system', 'click', () => setLanguageMode('system'));

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
    $on('btn-reset-reverb', 'click', () => resetReverb());
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
    $on('btn-reset-eq', 'click', () => resetEQ());
    $on('preamp-slider', 'input', function () { setPreamp(this.value, true); });
    $on('preamp-slider', 'change', function () { setPreamp(this.value); });
    $on('preamp-slider', 'dblclick', () => setPreamp(0));
    for (let i = 0; i < 5; i++) {
        $on(`eq-slider-${i}`, 'input', function () { setEQ(i, this.value, true); });
        $on(`eq-slider-${i}`, 'change', function () { setEQ(i, this.value); });
        $on(`eq-slider-${i}`, 'dblclick', () => setEQ(i, 0));
    }

    // --- Settings: Stereo Width ---
    $on('btn-reset-stereo', 'click', resetStereo);
    $on('width-slider', 'input', function () { updateAudioEffect('stereo', 'mix', this.value, true); });
    $on('width-slider', 'change', function () { updateAudioEffect('stereo', 'mix', this.value); });
    $on('width-slider', 'dblclick', resetStereo);

    // --- Settings: Virtual Bass ---
    $on('btn-reset-vbass', 'click', resetVBass);
    $on('vbass-slider', 'input', function () { updateAudioEffect('vbass', 'mix', this.value, true); });
    $on('vbass-slider', 'change', function () { updateAudioEffect('vbass', 'mix', this.value); });
    $on('vbass-slider', 'dblclick', () => updateAudioEffect('vbass', 'mix', 0));

    // --- Chat Drawer ---
    $on('btn-chat-close', 'click', toggleChatDrawer);
    $on('btn-chat-send', 'click', sendChatMessage);

    // --- Bottom Navigation ---
    document.querySelectorAll('.bottom-nav .nav-item[data-tab]').forEach(el => {
        el.addEventListener('click', () => {
            // iOS PWA: avoid keeping focus on the bottom nav button (can cause subtle scroll/jank)
            try { el.blur(); } catch (_) { /* ignore */ }
            if (el.classList.contains('active')) {
                const tabBody = document.querySelector(`#tab-${el.dataset.tab} .tab-body`);
                if (tabBody) tabBody.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                switchTab(el.dataset.tab);
            }
        });
    });

    // --- Guide Tab ---
    $on('btn-demo-guide', 'click', () => { switchTab('play'); loadDemoMedia(); });

    // --- Setup Overlay (Short Code Join) ---
    $on('btn-setup-join', 'click', handleSetupJoin);
    const __setupJoinInput = document.getElementById('setup-join-code');
    if (__setupJoinInput) {
        // Keep the join code strictly numeric (paste/IME/whitespace safe)
        __setupJoinInput.addEventListener('input', () => {
            const raw = __setupJoinInput.value || '';
            const digits = raw.replace(/\D+/g, '').slice(0, 6);
            if (raw !== digits) __setupJoinInput.value = digits;
        });

        __setupJoinInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();

            // UX: Enter key should behave like the primary action of the current step.
            // - Step 1 (enter code): proceed to role selection
            // - Step 2 (role selection): join if a role is selected
            const joinArea = document.getElementById('setup-join-area');
            const roleArea = document.getElementById('setup-role-area');
            const joinVisible = !!(joinArea && joinArea.style.display !== 'none');
            const roleVisible = !!(roleArea && roleArea.style.display !== 'none');

            if (appRole === 'guest' && joinVisible) {
                handleSetupJoinWithRole(pendingGuestRoleMode);
                return;
            }
            if (appRole === 'guest' && roleVisible && pendingGuestRoleMode !== null && pendingGuestRoleMode !== undefined) {
                handleSetupJoinWithRole(pendingGuestRoleMode);
                return;
            }

            // Fallback (legacy behavior)
            handleSetupJoin();
        });
    }

    // (setup-role-grid click handler is registered via event delegation above, near line 3553)

    // --- Manual Sync Popup ---
    $on('btn-nudge-minus10', 'click', () => nudgeSync(-10));
    $on('btn-nudge-minus1', 'click', () => nudgeSync(-1));
    $on('btn-nudge-plus1', 'click', () => nudgeSync(1));
    $on('btn-nudge-plus10', 'click', () => nudgeSync(10));
    $on('btn-auto-sync', 'click', handleAutoSync);
    $on('btn-sync-done', 'click', closeManualSync);

    // --- Media Source Popup ---
    $on('btn-local-file', 'click', () => { openFileSelector(); });
    $on('btn-youtube-source', 'click', () => { closeMediaSourcePopup(); openYouTubePopup(); });
    $on('btn-demo-media', 'click', () => { closeMediaSourcePopup(); loadDemoMedia(); });
    $on('btn-close-media-popup', 'click', closeMediaSourcePopup);

    // --- YouTube URL Popup ---
    $on('youtube-url-input', 'input', function () { fetchYouTubePreview(this.value); });
    $on('btn-yt-cancel', 'click', closeYouTubePopup);
    $on('youtube-play-btn', 'click', loadYouTubeFromInput);
}

document.addEventListener('DOMContentLoaded', () => {
    // Keep body.overlay-open in sync (fallback for browsers without :has())
    try { initOverlayOpenObserver(); } catch (_) { /* ignore */ }

    initSetupOverlay();
    initEventListeners();
    installAndroidRangeScrollFix();
    // Network is initialized only after the user chooses Host/Guest.
});

// --- Playlist & Player Logic ---
const _fileInputEl = document.getElementById('file-input');
if (_fileInputEl) _fileInputEl.addEventListener('change', async (e) => {
    closeMediaSourcePopup();
    // File upload is Host-only (OP cannot relay file data to other guests)
    if (hostConn) return showToast("호스트만 파일을 추가할 수 있어요");

    // Initialize AudioContext immediately on user gesture
    try {
        if (typeof Tone === 'undefined' || !Tone || !Tone.context) {
            throw new Error('Tone.js not loaded');
        }
        if (Tone.context.state !== 'running') await Tone.start();
        await initAudio();
    } catch (err) {
        log.error(err);
        showToast('오디오 엔진을 준비하지 못했어요');
    }

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
        showToast(`${files.length}곡을 추가했어요`);

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
else log.warn("[UI] #file-input not found; 로컬 파일 추가 기능이 비활성화됩니다.");

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
    if (!ul) return;

    // Defensive: Playlist can temporarily be undefined during late-join resync or protocol mismatch.
    if (!Array.isArray(playlist)) {
        log.warn('[Playlist] playlist is not an array. Resetting.', playlist);
        playlist = [];
    }

    ul.innerHTML = '';
    if (playlist.length === 0) {
        ul.innerHTML = '<li class="list-empty-state">미디어를 추가해주세요.</li>';
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
                <button type="button" class="expand-toggle ${item.isExpanded ? 'active' : ''}" data-expand-idx="${idx}" aria-label="플레이리스트 펼치기/접기">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>
                </button>
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

        // Bind expand toggle without inline handlers
        const exp = li.querySelector('.expand-toggle[data-expand-idx]');
        if (exp) {
            exp.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleExpansion(idx);
            });
        }

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
    if (currentTrackIndex !== -1) {
        // [Metadata Sync Fix] Prefer 'meta.name' if it matches the current index, 
        // as the playlist itself might not have updated yet (ordered messaging race).
        let displayTitle = 'Unknown';
        if (meta && meta.index === currentTrackIndex && meta.name) {
            displayTitle = meta.name;
        } else if (currentItem) {
            displayTitle = currentItem.name || currentItem.title || 'Unknown';
        }

        updateTitleWithMarquee(displayTitle);

        const artistEl = document.getElementById('track-artist');
        if (artistEl) {
            if (currentItem && currentItem.artist) {
                artistEl.innerText = currentItem.artist;
            } else {
                artistEl.innerText = (currentItem && currentItem.type === 'youtube') ? 'YouTube Video' : `Track ${currentTrackIndex + 1}`;
            }
        }
    }
}

// --- Media Session API (System Controls) ---
function initMediaSession() {
    if (!('mediaSession' in navigator)) return;

    log.debug("[MediaSession] Initializing action handlers...");

    // NOTE: mediaSession actions should be idempotent.
    // - 'play' should not pause if we're already playing
    // - 'pause' should not resume if we're already paused
    navigator.mediaSession.setActionHandler('play', () => {
        // Guest (non-OP): blocked
        if (hostConn && !isOperator) return;

        try {
            // YouTube
            if (currentState === APP_STATE.PLAYING_YOUTUBE && typeof youtubePlayer !== 'undefined' && youtubePlayer) {
                const st = (typeof youtubePlayer.getPlayerState === 'function') ? youtubePlayer.getPlayerState() : null;
                if (typeof YT !== 'undefined' && st === YT.PlayerState.PLAYING) return;
                togglePlay();
                return;
            }

            // Audio/Video (media element)
            if (videoElement && videoElement.src) {
                if (!videoElement.paused) return; // already playing
                togglePlay();
                return;
            }

            // Fallback: if something is loaded, try to resume
            if (currentTrackIndex >= 0 && currentState !== APP_STATE.IDLE) {
                togglePlay();
            }
        } catch (_) {
            // Best effort
            try { togglePlay(); } catch (_) { }
        }
    });

    navigator.mediaSession.setActionHandler('pause', () => {
        // Guest (non-OP): blocked
        if (hostConn && !isOperator) return;

        try {
            // YouTube
            if (currentState === APP_STATE.PLAYING_YOUTUBE && typeof youtubePlayer !== 'undefined' && youtubePlayer) {
                const st = (typeof youtubePlayer.getPlayerState === 'function') ? youtubePlayer.getPlayerState() : null;
                if (typeof YT !== 'undefined' && st !== YT.PlayerState.PLAYING) return; // already paused
                togglePlay();
                return;
            }

            // Audio/Video (media element)
            if (videoElement && videoElement.src) {
                if (videoElement.paused) return; // already paused
                togglePlay();
                return;
            }

            // If no media element, nothing to pause
        } catch (_) {
            // Best effort
            try { if (currentState !== APP_STATE.IDLE) togglePlay(); } catch (_) { }
        }
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
            stopPlayback();
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
            const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`);
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

    // Cancel any in-flight preload immediately upon track change
    preloadSessionId++;
    isPreloading = false;

    // Auto-switch to Play tab when starting a track (Host only)
    if (!hostConn) switchTab('play');

    _currentLoadToken++;
    const myLoadToken = _currentLoadToken;

    // Check if this track is already preloaded (Host Side Check)
    if (index === nextTrackIndex && nextFileBlob && !hostConn) {
        log.debug("[Host] Using Preloaded Track:", index);
        currentTrackIndex = index;
        updatePlaylistUI();
        updateMediaSessionMetadata(playlist[index]);

        // CRITICAL:
        // When switching to a preloaded track, we MUST advance the Host-side transfer session id.
        // Otherwise, any Guest that missed the preload and requests recovery will trigger unicastFile,
        // but unicastFile will immediately abort due to its session-guard
        // (currentTransferSessionId !== effectiveSessionId).
        // Use the preload sessionId (if present) so Guests/Relays can correlate caches.
        if (nextMeta && nextMeta.sessionId && Number.isFinite(Number(nextMeta.sessionId))) {
            currentTransferSessionId = Number(nextMeta.sessionId);
        } else {
            currentTransferSessionId = nextSessionId();
        }

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
        broadcast({ type: MSG.PLAY, time: 0, index: currentTrackIndex, name: fileName }); // Explicitly broadcast play for guests

        // Immediate Auto-Sync (User Request)
        handleMainSyncBtn();

        // Trigger Next Preload (debounced to let track settle)
        schedulePreload();
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
            stopAllMedia();

            // Preload already cancelled at top of playTrack()
            // Clear preload blobs for YouTube (no file preload needed)

            // IMMEDIATELY broadcast to guests so they switch too
            broadcast({
                type: MSG.YOUTUBE_PLAY,
                videoId: item.videoId,
                playlistId: item.playlistId,
                name: item.name || item.title,
                index: index,
                autoplay: false  // Will send 'play' command separately
            });

            // Same logic as local: first track = wait for button, else = 3s countdown
            if (isFirstTrackLoad) {
                isFirstTrackLoad = false;
                // Load YouTube but DON'T auto-play (playerVars.autoplay will be 0)
                loadYouTubeVideo(item.videoId, item.playlistId, false);
                showToast("YouTube가 준비됐어요! 재생 버튼을 눌러 보세요.");
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
            showToast("파일이 준비됐어요! 재생 버튼을 눌러 보세요.");
        } else {
            showToast("3초 후 재생 시작...");
            managedTimers.autoPlayTimer = setTimeout(() => {
                managedTimers.autoPlayTimer = null;
                play(0);
                broadcast({ type: MSG.PLAY, time: 0, index: currentTrackIndex, name: file.name });
            }, 3000);
        }
    }
}

let _preloadScheduleTimer = null;
function schedulePreload(delayMs = 500) {
    if (_preloadScheduleTimer) clearTimeout(_preloadScheduleTimer);
    _preloadScheduleTimer = setTimeout(() => {
        _preloadScheduleTimer = null;
        preloadNextTrack();
    }, delayMs);
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

        const chunkMsg = { type: MSG.PRELOAD_CHUNK, chunk: chunk, index: i, sessionId: sessionId };
        sendToTargets(chunkMsg, true); // true = send only to those who need chunks
    }

    // Final session check before completing
    if (preloadSessionId === sessionId) {
        sendToTargets({ type: MSG.PRELOAD_END, name: file.name, index: index, sessionId: sessionId });
        log.debug("[Preload] Complete for index:", index);
    }
}


// Send preload data to a single peer (for late-joining guests)
async function unicastPreload(conn, file, index, sessionId) {
    if (!conn || !conn.open || !file) return;
    const CHUNK = 16384;
    const total = Math.ceil(file.size / CHUNK);
    conn.send({
        type: MSG.PRELOAD_START, name: file.name, mime: file.type,
        total: total, size: file.size, index: index, sessionId: sessionId, skipped: false
    });
    for (let i = 0; i < total; i++) {
        if (!conn.open) return;
        // Backpressure loop (match broadcastPreloadFile pattern)
        while (conn.open && conn.dataChannel && conn.dataChannel.bufferedAmount > 256 * 1024) {
            await new Promise(r => setTimeout(r, DELAY.BACKPRESSURE));
        }
        if (!conn.open) return;
        const start = i * CHUNK;
        const chunkBuf = await file.slice(start, Math.min(start + CHUNK, file.size)).arrayBuffer();
        conn.send({ type: MSG.PRELOAD_CHUNK, chunk: new Uint8Array(chunkBuf), index: i, sessionId: sessionId });
    }
    if (conn.open) {
        conn.send({ type: MSG.PRELOAD_END, name: file.name, index: index, sessionId: sessionId });
    }
}

function playNextTrack() {
    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return showToast("호스트만 조작할 수 있어요");

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
    } else if (isShuffle) {
        if (playlist.length === 1) {
            nextIndex = 0;
        } else if (
            nextTrackIndex !== -1 &&
            nextTrackIndex !== currentTrackIndex &&
            nextTrackIndex < playlist.length
        ) {
            // Use the already-decided next index (so preload is actually used)
            nextIndex = nextTrackIndex;
        } else {
            // Fallback: choose random (avoid immediate repeat)
            do {
                nextIndex = Math.floor(Math.random() * playlist.length);
            } while (nextIndex === currentTrackIndex);
        }
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
    if (hostConn && !isOperator) return showToast("호스트만 조작할 수 있어요");

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
    // Use centralized track position (works correctly even when paused/IDLE).
    // (Tone.now() - startedAt) keeps increasing while paused and can mis-detect the "3s rule".
    const pos = getTrackPosition();
    if (pos > 3) {
        play(0); // Restart current
        broadcast({ type: MSG.PLAY, time: 0, index: currentTrackIndex });
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
        showToast("고정밀 동기화: 오디오를 준비하고 있어요…");

        // 1. Decode Audio
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer);
        // Re-verify after async decode (protect against stale async loads)
        if (loadToken !== undefined && _currentLoadToken !== myToken) {
            const msg = `[Load] Token mismatch after decode (${myToken} vs ${_currentLoadToken}). Aborting stale load.`;

            // Only the latest load session may touch loader/UI.
            if (myLoadId === activeLoadSessionId) {
                log.warn(msg);
                showLoader(false);
            } else {
                log.debug(msg);
            }
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
            showToast("파일을 보내고 있어요…");
            broadcastFile(file, sessionId);
        }

        if (!hostConn) {
            schedulePreload();
        }

    } catch (err) {
        log.error(err);
        showToast(`Load Failed: ${err.message} `);
    } finally {
        // Only touch UI if this is still the active load session
        if (myLoadId === activeLoadSessionId) {
            showLoader(false);
            pausedAt = 0;
            updatePlayState(false);
        }

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

    // Defensive: Tone.js load failure guard (CDN blocked/offline)
    if (typeof Tone === 'undefined' || !Tone || !Tone.context) {
        log.error('[Audio] Tone.js not loaded');
        showToast('오디오 엔진이 아직 준비되지 않았어요. 네트워크를 확인해 보세요.');
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

    // Ensure the audio graph exists before wiring nodes.
    // (initAudio() is guarded against concurrent calls.)
    try {
        await initAudio();
    } catch (e) {
        log.error('[Audio] initAudio failed:', e);
        showToast('오디오 엔진을 준비하지 못했어요');
        return;
    }

    // Sanitize offset (guard against NaN/Infinity/negative/out-of-range)
    let safeOffset = Number(offset);
    if (!Number.isFinite(safeOffset) || safeOffset < 0) safeOffset = 0;
    const duration = (currentAudioBuffer && Number.isFinite(currentAudioBuffer.duration))
        ? currentAudioBuffer.duration
        : (videoElement && Number.isFinite(videoElement.duration) ? videoElement.duration : 0);
    if (duration > 0) {
        if (safeOffset > duration) safeOffset = duration;
        // Avoid starting exactly at EOF which can behave inconsistently across engines.
        if (safeOffset === duration) safeOffset = Math.max(0, duration - 0.001);
    }

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
            if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
                handleEnded();
            }
        };

        playerNode.start(Tone.now(), safeOffset);

        // Sync Visuals (Muted Video)
        if (videoElement.src) {
            videoElement.currentTime = safeOffset;
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
    startedAt = Tone.now() - (safeOffset - (localOffset + autoSyncOffset));
    pausedAt = safeOffset;
    log.debug(`[BufferMode] Started transient node at ${safeOffset}s (startedAt: ${startedAt})`);

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

    // Duration source priority:
    // - In MUSIXQUARE BufferMode we always decode into currentAudioBuffer.
    // - Some browsers (especially iOS/Safari) can report videoElement.duration as 0/NaN/Infinity
    //   even while the decoded buffer plays correctly.
    const hasBufferDuration = !!(currentAudioBuffer && Number.isFinite(currentAudioBuffer.duration) && currentAudioBuffer.duration > 0.5);

    // Safety: Verify video readyState only when we DON'T have a reliable AudioBuffer duration
    const usesVideoElement = currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_AUDIO;
    if (!hasBufferDuration && usesVideoElement && videoElement && videoElement.readyState < 1) {
        return; // Metadata not yet reliable
    }

    const duration = hasBufferDuration
        ? currentAudioBuffer.duration
        : (videoElement ? videoElement.duration : 0);

    // Safety: Skip if duration is invalid or suspiciously short during load
    if (!duration || !Number.isFinite(duration) || duration <= 0.5) {
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


    // Detaching the source is the safe point to flush deferred BlobURL revocations
    try { BlobURLManager.revoke(); } catch (_) { }
    try { BlobURLManager.flushDeferred('stopAllMedia'); } catch (_) { }

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
    if (_preloadScheduleTimer) { clearTimeout(_preloadScheduleTimer); _preloadScheduleTimer = null; }
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
    if (hostConn && !isOperator) return showToast("호스트만 조작할 수 있어요");

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
        showToast("자동 재생을 취소했어요");
    }

    if (isActuallyPlaying) {
        if (!hostConn) { pause(); broadcast({ type: MSG.PAUSE, time: pausedAt }); }
        else if (isOperator) hostConn.send({ type: MSG.REQUEST_PAUSE });
    } else {
        if (!hostConn) { play(pausedAt); broadcast({ type: MSG.PLAY, time: pausedAt, index: currentTrackIndex }); }
        else if (isOperator) hostConn.send({ type: MSG.REQUEST_PLAY, time: pausedAt });
    }
}

function stopPlayback() {
    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return showToast("호스트만 조작할 수 있어요");

    // OP: request Host to stop (seek to 0 then pause)
    if (hostConn && isOperator) {
        try { hostConn.send({ type: MSG.REQUEST_SEEK, time: 0 }); } catch (_) { }
        try { hostConn.send({ type: MSG.REQUEST_PAUSE }); } catch (_) { }
        showToast("정지 요청을 보냈어요");
        return;
    }

    // Host: YouTube mode uses YT API (keep the player loaded, just stop at 0)
    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer) {
        try {
            youtubePlayer.stopVideo();
            try { youtubePlayer.seekTo(0, true); } catch (_) { /* optional */ }
            broadcast({ type: MSG.YOUTUBE_STATE, state: 2, time: 0 });
        } catch (e) {
            log.error("[YouTube] Stop error:", e);
        }
        pausedAt = 0;
        updatePlayState(false);
        postWorkerCommand({ command: 'STOP_TIMER', id: 'youtube-sync' });
        return;
    }

    // Host: Local file mode
    stopAllMedia();
    pausedAt = 0;

    // Reset UI immediately
    const slider = document.getElementById('seek-slider');
    if (slider) slider.value = 0;
    const timeCurr = document.getElementById('time-curr');
    if (timeCurr) timeCurr.innerText = fmtTime(0);

    // Broadcast as "pause at 0" (backward-compatible stop)
    if (!hostConn) {
        broadcast({ type: MSG.PAUSE, time: 0 });
    }

    showToast("정지");
}
function pause(forcedTime) {
    if (currentState !== APP_STATE.IDLE) {
        // Capture current position BEFORE stopping the engine (prevents drift)
        if (typeof forcedTime === 'number' && isFinite(forcedTime) && forcedTime >= 0) {
            pausedAt = forcedTime;
        } else {
            pausedAt = getTrackPosition();
        }

        // True pause for Buffer Mode (prevents overlap when resuming)
        stopPlayerNode();

        if (videoElement) {
            try { videoElement.pause(); } catch (_) { }
            try { videoElement.currentTime = pausedAt; } catch (_) { }
        }

        // Set state to IDLE so loopUI stops
        setState(APP_STATE.IDLE, { skipCleanup: true });
    }
    updatePlayState(false);
    showToast("일시정지");
    postWorkerCommand({ command: 'STOP_TIMER', id: 'video-sync' });
}

function skipTime(sec) {
    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return showToast("호스트만 조작할 수 있어요");

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
    broadcast({ type: MSG.PLAY, time: target, index: currentTrackIndex });
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
    } else if (mode === -1) { // Left (Dual Mono)
        // L -> Merge 0 AND 1
        gainL.connect(toneMerge, 0, 0);
        gainL.connect(toneMerge, 0, 1);

        gainL.gain.rampTo(1, ramp);
    } else if (mode === 1) { // Right (Dual Mono)
        // R -> Merge 0 AND 1
        gainR.connect(toneMerge, 0, 0);
        gainR.connect(toneMerge, 0, 1);

        gainR.gain.rampTo(1, ramp);
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

    } else {
        // Fallback
        gainL.gain.rampTo(1, ramp);
        gainR.gain.rampTo(1, ramp);
    }
    applySettings();

    // Header pill: 역할(채널 모드) 실시간 반영
    try { updateRoleBadge(); } catch (e) { /* noop */ }
}

// --- 7.1 Surround Logic ---
function toggleSurroundMode(enabled) {
    isSurroundMode = enabled;

    // UI Toggle
    // (Toss In-App Release) UI에서 7.1 영역이 제거될 수 있으므로 null-safe 처리
    const stdGrid = document.getElementById('grid-standard');
    if (stdGrid) stdGrid.style.display = enabled ? 'none' : 'grid';
    const surGrid = document.getElementById('grid-surround');
    if (surGrid) surGrid.style.display = enabled ? 'grid' : 'none';

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
    if (hostConn && isChannelSelectionLocked) {
        showToast('역할이 자동 설정되어 변경할 수 없어요.');
        return;
    }

    surroundChannelIndex = idx;

    // UI Highlight Logic
    const allOpts = document.querySelectorAll('.surround-grid .ch-opt');
    allOpts.forEach(e => e.classList.remove('active'));

    if (el) {
        el.classList.add('active');
    } else {
        // Programmatic Update: Find button by data attribute.
        // (We no longer rely on inline onclick handlers.)
        for (let btn of allOpts) {
            const v = btn?.dataset?.sch;
            if (v !== undefined && v !== null && String(v) !== '' && parseInt(v, 10) === idx) {
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

    // Header pill: 역할(7.1 채널) 실시간 반영
    try { updateRoleBadge(); } catch (e) { /* noop */ }
}

async function setChannel(mode, el, force = false, notify = true) {
    if (hostConn && isChannelSelectionLocked && !force) {
        showToast('역할이 자동 설정되어 변경할 수 없어요.');
        return;
    }

    if (!masterGain) await initAudio();
    document.querySelectorAll('.ch-opt').forEach(e => e.classList.remove('active'));
    if (el) el.classList.add('active');
    setChannelMode(mode);

    // Toss 인앱 UX: 역할 변경 시 "배치" 안내 토스트
    if (notify) {
        try {
            // IMPORTANT: Device label is Host-assigned ("Peer N"). Do NOT overwrite it with role label.
            if (appRole === 'guest' || hostConn) {
                updateRoleBadge();
            }
        } catch (e) { /* noop */ }

        try { showPlacementToastForChannel(mode); } catch (e) { /* noop */ }
    }
}

function updateSettings(type, val) {
    if (type === 'cutoff') {
        subFreq = Number(val);
        document.getElementById('val-cutoff').innerText = subFreq + ' Hz';

        if (vbFilter) vbFilter.frequency.rampTo(subFreq, 0.1);

        // Update Main Filter ONLY if currently in Subwoofer/LFE mode
        const isSubMode = (channelMode === 2 && !isSurroundMode);
        const isLFE = (isSurroundMode && surroundChannelIndex === 3);

        // Subwoofer/LFE: keep Virtual Bass harmonics from leaking by filtering
        // the generated bass signal to the same cutoff.
        if (vbPostFilter) {
            const isWooferOutput = (isSubMode || isLFE);
            vbPostFilter.frequency.rampTo(isWooferOutput ? subFreq : 20000, 0.1);
        }

        if (globalLowPass && (isSubMode || isLFE)) {
            globalLowPass.frequency.rampTo(subFreq, 0.1);
        }
    }
}

// Legacy reverb input/change handlers removed (replaced by updateAudioEffect routing)

function setReverbParam(param, val) {
    const v = Number(val);
    if (!Number.isFinite(v)) return;

    switch (param) {
        case 'mix':
            reverbMix = v / 100;
            document.getElementById('val-reverb').innerText = v + '%';
            document.getElementById('reverb-slider').value = v;
            break;
        case 'decay':
            reverbDecay = v;
            document.getElementById('val-rvb-decay').innerText = v + 's';
            document.getElementById('reverb-decay-slider').value = v;
            break;
        case 'predelay':
            reverbPreDelay = v;
            document.getElementById('val-rvb-predelay').innerText = v + 's';
            document.getElementById('reverb-predelay-slider').value = v;
            break;
        case 'lowcut':
            reverbLowCut = v;
            const lFreq = 20 * Math.pow(50, v / 100);
            document.getElementById('val-rvb-lowcut').innerText = (lFreq >= 1000 ? (lFreq / 1000).toFixed(1) + 'kHz' : Math.round(lFreq) + 'Hz');
            document.getElementById('reverb-lowcut-slider').value = v;
            break;
        case 'highcut':
            reverbHighCut = v;
            const hFreq = 20000 * Math.pow(0.05, v / 100);
            document.getElementById('val-rvb-highcut').innerText = (hFreq >= 1000 ? (hFreq / 1000).toFixed(1) + 'kHz' : Math.round(hFreq) + 'Hz');
            document.getElementById('reverb-highcut-slider').value = v;
            break;
    }
    applySettings();
}

// Reverb setters: apply param locally; callers handle broadcasting
function setReverbType(type) {
    if (reverb) {
        if (type === 'room') { reverbDecay = 1.5; reverbPreDelay = 0.05; }
        else if (type === 'hall') { reverbDecay = 3.5; reverbPreDelay = 0.1; }
        else if (type === 'space') { reverbDecay = 7.0; reverbPreDelay = 0.2; }
        reverb.decay = reverbDecay;
        reverb.preDelay = reverbPreDelay;
        reverb.generate();
    }
}
function setReverb(val) { setReverbParam('mix', val); }
function setReverbDecay(val) { setReverbParam('decay', val); }
function setReverbPreDelay(val) { setReverbParam('predelay', val); }
function setReverbLowCut(val) { setReverbParam('lowcut', val); }
function setReverbHighCut(val) { setReverbParam('highcut', val); }

function resetReverbMix() { setReverbParam('mix', 0); }
function resetReverbDecay() { setReverbParam('decay', 5.0); }
function resetReverbPreDelay() { setReverbParam('predelay', 0.1); }
function resetReverbLowCut() { setReverbParam('lowcut', 0); }
function resetReverbHighCut() { setReverbParam('highcut', 0); }


function resetReverb(fromSync = false) {
    if (isOperator && !fromSync) {
        if (hostConn && hostConn.open) hostConn.send({ type: MSG.REQUEST_REVERB_RESET });
        return;
    }

    resetReverbMix();
    resetReverbDecay();
    resetReverbPreDelay();
    resetReverbLowCut();
    resetReverbHighCut();

    // Broadcast all reverb defaults to guests
    if (!hostConn && !fromSync) {
        broadcast({ type: MSG.REVERB, value: 0 });
        broadcast({ type: MSG.REVERB_DECAY, value: 5.0 });
        broadcast({ type: MSG.REVERB_PREDELAY, value: 0.1 });
        broadcast({ type: MSG.REVERB_LOWCUT, value: 0 });
        broadcast({ type: MSG.REVERB_HIGHCUT, value: 0 });
    }
}

// Graphic EQ
function setEQ(idx, val, localOnly = false, fromSync = false) {
    const bandIdx = Number(idx);
    const bandVal = Number(val);

    // Cached State Update
    eqValues[bandIdx] = bandVal;

    // Tone.js Update
    if (eqNodes && eqNodes[bandIdx]) {
        // eqNodes are Tone.Filter(peaking)
        eqNodes[bandIdx].gain.rampTo(bandVal, 0.1);
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
        if (hostConn && hostConn.open) hostConn.send({ type: MSG.REQUEST_EQ_RESET });
        return;
    }
    document.querySelectorAll('.eq-slider').forEach((el, idx) => {
        setEQ(idx, 0, false, true);
    });
    setPreamp(0, false, true);
    // Explicitly reset cached values for safety
    eqValues = [0, 0, 0, 0, 0];
    userPreampGain = 1.0;
    applySettings();
    if (!hostConn && !fromSync) broadcast({ type: MSG.EQ_RESET });
}

// Virtual Stereo Width
function setStereoWidth(val) {
    stereoWidth = val / 100;
    const label = document.getElementById('val-width');
    const slider = document.getElementById('width-slider');
    if (label) label.innerText = val + '%';
    if (slider) slider.value = val;
    applySettings();
}

function onStereoWidthChange(val) {
    if (!hostConn) broadcast({ type: MSG.STEREO_WIDTH, value: val });
    else if (isOperator) hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'stereo', value: val });
}

function resetStereo() { setStereoWidth(100); onStereoWidthChange(100); }

function resetVBass() {
    // Default: 0% (off)
    try { setVirtualBass(0); } catch (_) { /* ignore */ }
    try { onVirtualBassChange(0); } catch (_) { /* ignore */ }
}

// Virtual Bass Control
function setVirtualBass(val) {
    virtualBass = val / 100;
    const label = document.getElementById('val-vbass');
    const slider = document.getElementById('vbass-slider');
    if (label) label.innerText = val + '%';
    if (slider) slider.value = val;
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

    // Reverb Engine Sync (Decay/PreDelay/Filters) — batch changes, generate once
    if (reverb) {
        let needsGenerate = false;
        if (reverb.decay !== reverbDecay) {
            reverb.decay = reverbDecay;
            needsGenerate = true;
        }
        if (reverb.preDelay !== reverbPreDelay) {
            reverb.preDelay = reverbPreDelay;
            needsGenerate = true;
        }
        if (needsGenerate) reverb.generate();
    }
    if (rvbLowCut) {
        const lFreq = 20 * Math.pow(50, reverbLowCut / 100);
        rvbLowCut.frequency.rampTo(lFreq, 0.1);
    }
    if (rvbHighCut) {
        const hFreq = 20000 * Math.pow(0.05, reverbHighCut / 100);
        rvbHighCut.frequency.rampTo(hFreq, 0.1);
    }

    // EQ Sync
    if (eqNodes) {
        eqNodes.forEach((node, i) => {
            if (node.gain.value !== eqValues[i]) {
                node.gain.rampTo(eqValues[i], 0.1);
            }
        });
    }

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
    // NOTE:
    // - Virtual bass intentionally creates harmonics.
    // - On Subwoofer/LFE roles, we keep the virtual bass ON but
    //   filter it back down so only the low band remains (no UI change).
    const isWooferRole = (channelMode === 2) || (isSurroundMode && surroundChannelIndex === 3);
    if (vbPostFilter) {
        const cutoff = isWooferRole ? subFreq : 20000;
        vbPostFilter.frequency.rampTo(cutoff, 0.1);
    }
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

    // Canvas Scale Logic (High DPI) - Dynamic sizing from wrapper
    const wrapper = document.querySelector('.vinyl-wrapper');
    // Guard against 0 size (e.g. tab hidden) - use fallback but keep retry loop active
    const logicalSize = (wrapper && wrapper.clientWidth > 10) ? wrapper.clientWidth : 240;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== logicalSize * dpr || canvas.height !== logicalSize * dpr) {
        canvas.width = logicalSize * dpr;
        canvas.height = logicalSize * dpr;
        canvas.style.width = '';
        canvas.style.height = '';
        ctx.scale(dpr, dpr);
    }

    function draw() {
        if (currentState === APP_STATE.IDLE) return;
        animationId = requestAnimationFrame(draw);

        if (isToneAnalyser) {
            const dbData = analyser.getValue();

            const theme = document.documentElement.getAttribute('data-theme');
            const isLight = (theme === 'light');

            ctx.globalCompositeOperation = 'source-over';
            ctx.clearRect(0, 0, logicalSize, logicalSize);

            // Bass: 0 ~ 260Hz (12 bins - sync.html style for better punch)
            let bassSum = 0;
            let bassCount = 12;
            // Safety check for array bounds
            if (bassCount > bufferLength) bassCount = bufferLength;
            for (let i = 0; i < bassCount; i++) {
                let val = (dbData[i] + 100) * 2.5;
                if (val < 0) val = 0; if (val > 255) val = 255;
                bassSum += val;
            }
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

            for (let i = highStart; i < highEnd; i++) {
                let val = (dbData[i] + 100) * 2.5;
                if (val < 0) val = 0; if (val > 255) val = 255;
                highSum += val;
            }
            const highAverage = highSum / highCountVal;
            const highPunch = Math.pow(highAverage / 255, 1.0);

            if (isLight) ctx.globalCompositeOperation = 'source-over';
            else ctx.globalCompositeOperation = 'lighter';

            ctx.shadowBlur = 0;
            ctx.lineWidth = 0;

            const centerX = logicalSize / 2;
            const centerY = logicalSize / 2;
            const scale = logicalSize / 240;

            // Circle 1: Bass (increased amplification)
            const bassRadius = (55 + (bassPunch * 200)) * scale;
            const bassLightness = 20 + (bassPunch * 60);

            if (isLight) ctx.fillStyle = `rgba(59, 130, 246, 0.6)`;
            else ctx.fillStyle = `hsla(217, 91%, ${bassLightness + 40}%, 0.4)`;

            ctx.beginPath();
            ctx.arc(centerX, centerY, bassRadius, 0, 2 * Math.PI);
            ctx.fill();

            // Circle 2: High
            const highRadius = (40 + (highPunch * 130)) * scale;
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

function drawIdleVisualizer() {
    const canvas = document.getElementById('visualizerCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const wrapper = document.querySelector('.vinyl-wrapper');
    const logicalSize = wrapper ? wrapper.clientWidth : 240;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== logicalSize * dpr || canvas.height !== logicalSize * dpr) {
        canvas.width = logicalSize * dpr;
        canvas.height = logicalSize * dpr;
        canvas.style.width = '';
        canvas.style.height = '';
        ctx.scale(dpr, dpr);
    }

    // Theme
    const theme = document.documentElement.getAttribute('data-theme');
    const isLight = (theme === 'light');

    // Clear canvas
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, logicalSize, logicalSize);

    if (isLight) ctx.globalCompositeOperation = 'source-over';
    else ctx.globalCompositeOperation = 'lighter';

    ctx.shadowBlur = 0;
    ctx.lineWidth = 0;

    const centerX = logicalSize / 2;
    const centerY = logicalSize / 2;
    const scale = logicalSize / 240;

    // Base Bass Circle (0 punch)
    const bassRadius = 55 * scale;
    const bassLightness = 20;
    if (isLight) ctx.fillStyle = `rgba(59, 130, 246, 0.6)`;
    else ctx.fillStyle = `hsla(217, 91%, ${bassLightness + 40}%, 0.4)`;

    ctx.beginPath();
    ctx.arc(centerX, centerY, bassRadius, 0, 2 * Math.PI);
    ctx.fill();

    // Base High Circle (0 punch)
    const highRadius = 40 * scale;
    const highLightness = 40;
    if (isLight) ctx.fillStyle = `rgba(96, 165, 250, 0.6)`;
    else ctx.fillStyle = `hsla(217, 100%, ${highLightness + 30}%, 0.4)`;

    ctx.beginPath();
    ctx.arc(centerX, centerY, highRadius, 0, 2 * Math.PI);
    ctx.fill();
}
window.addEventListener('DOMContentLoaded', drawIdleVisualizer);
let _vizResizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(_vizResizeTimer);
    _vizResizeTimer = setTimeout(() => {
        const wrapper = document.querySelector('.vinyl-wrapper');
        if (!wrapper || wrapper.clientWidth < 10) return;
        if (currentState === APP_STATE.IDLE) {
            drawIdleVisualizer();
        } else {
            startVisualizer();
        }
    }, 250);
});

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
if (slider) {
    slider.addEventListener('mousedown', () => isSeeking = true);
    slider.addEventListener('touchstart', () => isSeeking = true);
    slider.addEventListener('input', () => {
        const tc = document.getElementById('time-curr');
        if (tc) tc.innerText = fmtTime(slider.value);
    });
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
            broadcast({ type: MSG.PLAY, time: t, index: currentTrackIndex });
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
} else {
    log.warn('[UI] #seek-slider not found; seeking controls disabled');
}

// --- Sync Button Logic ---
function handleMainSyncBtn() {
    // YouTube Together mode: timing is controlled by YouTube API sync.
    // Prevent confusing "resync" behaviors and show an explicit toast for BOTH roles.
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
        showToast("YouTube 모드에서는 정밀 동기화를 지원하지 않아요");
        return;
    }

    if (!hostConn) {
        // Host: Broadcast resync request to all guests
        showToast("모든 기기 재동기화 요청...");
        broadcast({ type: MSG.GLOBAL_RESYNC_REQUEST });
    } else {
        // Guest: Perform auto-sync (reset local offset and request sync time)
        localOffset = 0;
        autoSyncOffset = 0;
        updateSyncDisplay();
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
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg> 초기화`;
}

// --- Networking (Updated from network.html) ---

// Network initialization
async function initNetwork(requestedId = null) {
    // PeerJS must already be loaded (via CDN script)
    if (!window.Peer) {
        log.error('[Network] PeerJS not found on window.');
        showToast('네트워크 초기화 실패');
        throw new Error('PEERJS_NOT_LOADED');
    }

    // Clean up existing peer instance
    if (peer) {
        try { peer.destroy(); } catch (e) { /* noop */ }
        peer = null;
    }

    // Local-only ICE: no STUN/TURN (forces same LAN / same Wi‑Fi)
    const peerOpts = {
        debug: 2,
        config: {
            iceServers: [],
            sdpSemantics: 'unified-plan',
            bundlePolicy: 'max-bundle',
            iceCandidatePoolSize: 0,
        }
    };

    // Optional: allow Toss (or any) infrastructure to provide a custom PeerJS signaling server
    // Example injection (global):
    // window.__MUSIXQUARE_PEER_SERVER__ = { host: 'peer.yourdomain.com', port: 443, path: '/peerjs', secure: true };
    const customPeerServer = window.__MUSIXQUARE_PEER_SERVER__;
    if (customPeerServer && typeof customPeerServer === 'object') {
        if (customPeerServer.host) peerOpts.host = customPeerServer.host;
        if (customPeerServer.port) peerOpts.port = customPeerServer.port;
        if (customPeerServer.path) peerOpts.path = customPeerServer.path;
        if (typeof customPeerServer.secure === 'boolean') peerOpts.secure = customPeerServer.secure;
        if (customPeerServer.key) peerOpts.key = customPeerServer.key;
    }

    // If requestedId is provided, claim it as our PeerJS ID (used as 6-digit session code for Host)
    peer = new Peer(requestedId || undefined, peerOpts);

    setupPeerEvents();

    // Wait for open (or fail fast on error)
    const id = await new Promise((resolve, reject) => {
        peer.once('open', resolve);
        peer.once('error', reject);
    });

    myId = id;
    log.info('[Network] Peer opened:', myId);
    return myId;
}

function generateSessionCode() {
    // 6-digit numeric (no leading zeros)
    return String(Math.floor(100000 + Math.random() * 900000));
}

async function createHostSessionWithShortCode(maxAttempts = 12) {
    // Try to claim a short, human-enterable code as our PeerJS ID.
    for (let i = 0; i < maxAttempts; i++) {
        const code = generateSessionCode();
        try {
            await initNetwork(code);
            return code;
        } catch (err) {
            // PeerJS: { type: 'id-taken', ... }
            if (err && err.type === 'id-taken') {
                continue;
            }
            throw err;
        }
    }
    throw new Error('SESSION_CODE_UNAVAILABLE');
}

function handleSetupJoin() {
    // Toss 인앱 UX: 게스트는 "역할" 버튼을 눌러야 참가가 진행됩니다.
    showToast('역할을 선택해 참가해 주세요.');
}

function setupPeerEvents() {

    peer.on('error', (err) => {
        log.error('[PeerJS] Error:', err);

        // Host: most errors should be surfaced
        if (appRole === 'host' && !hostConn) {
            if (err && err.type === 'id-taken') {
                // handled by createHostSessionWithShortCode retry loop
                return;
            }
            showToast('네트워크 오류가 발생했어요. 같은 Wi‑Fi인지 확인해주세요.');
        }

        // Guest: joinSession handles common errors
    });

    peer.on('disconnected', () => {
        log.warn('[PeerJS] Disconnected from signaling server');
    });

    peer.on('connection', (conn) => {
        // Incoming connections are HOST-only.
        if (appRole !== 'host') {
            try { conn.close(); } catch (e) { /* noop */ }
            return;
        }
        handleHostIncomingConnection(conn);
    });
}

// (v3 이전) 슬롯 기반(L/R/Sub) 자동 세팅 로직은 Toss 인앱 요구사항에 맞춰 제거되었습니다.

function handleHostIncomingConnection(conn) {
    const peerId = conn.peer;

    // --------------------------------------------------------------------
    // Duplicate connection handling (must run BEFORE "session full" check)
    // --------------------------------------------------------------------
    // If the same peer reconnects, treat the newest connection as authoritative.
    // This prevents "session full" false negatives and avoids stale close events
    // freeing the new connection's slot.
    const existingActiveConn = activeHostConnByPeerId.get(peerId);
    if (existingActiveConn && existingActiveConn !== conn) {
        // Mark new connection as active first so the old close handler becomes a no-op.
        activeHostConnByPeerId.set(peerId, conn);
        try {
            if (existingActiveConn.open) {
                existingActiveConn.send({ type: MSG.FORCE_CLOSE_DUPLICATE });
            }
        } catch (e) { /* noop */ }
        try { existingActiveConn.close(); } catch (e) { /* noop */ }
    }

    // Remove any lingering peer object with the same id
    connectedPeers = connectedPeers.filter(p => p.id !== peerId);

    // --------------------------------------------------------------------
    // Enforce max guests (host 제외)
    // --------------------------------------------------------------------
    if (connectedPeers.length >= MAX_GUEST_SLOTS) {
        const sendFullAndClose = () => {
            try {
                conn.send({
                    type: MSG.SESSION_FULL,
                    message: '현재 세션은 연결 가능한 기기 수(방장 제외 3대)에 도달했어요.'
                });
            } catch (e) { /* noop */ }
            setTimeout(() => { try { conn.close(); } catch (e) { /* noop */ } }, 500);
        };
        if (conn.open) sendFullAndClose();
        else conn.once('open', sendFullAndClose);
        return;
    }

    // --------------------------------------------------------------------
    // Host-assigned slot naming: Peer 1..N (reuse freed slots)
    // --------------------------------------------------------------------
    const preferredSlot = peerSlotByPeerId.get(peerId) || null;
    const slot = getAvailablePeerSlot(preferredSlot, peerId);
    if (!slot) {
        // Defensive: should not happen if length check passed, but keep safe.
        try {
            conn.send({
                type: MSG.SESSION_FULL,
                message: '현재 세션은 연결 가능한 기기 수(방장 제외 3대)에 도달했어요.'
            });
        } catch (e) { /* noop */ }
        try { conn.close(); } catch (e) { /* noop */ }
        return;
    }
    assignPeerSlot(peerId, slot);
    const deviceName = getPeerLabelBySlot(slot);

    // Keep guest-provided metadata only as informational (do NOT use it as the device name)
    const metaLabel = (conn && conn.metadata && typeof conn.metadata.label === 'string') ? conn.metadata.label.trim() : '';

    // Track label for UI/debug
    peerLabels[peerId] = deviceName;

    // New connection becomes the active one
    activeHostConnByPeerId.set(peerId, conn);

    const peerObj = {
        id: peerId,
        slot: slot,
        label: deviceName,
        metaLabel: metaLabel,
        role: 'guest',
        status: 'connecting',
        conn,
        isOp: false,
        isDataTarget: true,
        joinOrder: slot, // Stable visual order: Peer 1, Peer 2, Peer 3
        lastHeartbeat: Date.now(),
        preloadedIndexes: new Set(),
        currentFileId: null,
    };

    connectedPeers.push(peerObj);

    updateRoleBadge();

    conn.on('open', () => {
        peerObj.status = 'connected';
        peerObj.lastHeartbeat = Date.now();

        showToast(`${deviceName}가 연결됐어요`);

        // Welcome
        // - Assign stable host-defined device label (Peer N)
        // - 역할은 게스트가 선택하므로 채널 강제/할당 없음
        try {
            conn.send({
                type: MSG.WELCOME,
                lockChannel: false,
                label: deviceName,
            });
        } catch (e) { /* noop */ }

        // Sync current settings/state (late-join bootstrap)
        try { conn.send({ type: MSG.VOLUME, value: masterVolume }); } catch (e) { /* noop */ }
        try { conn.send({ type: MSG.REVERB, value: reverbMix * 100 }); } catch (e) { /* noop */ }
        try { conn.send({ type: MSG.REVERB_DECAY, value: reverbDecay }); } catch (e) { /* noop */ }
        try { conn.send({ type: MSG.REVERB_PREDELAY, value: reverbPreDelay }); } catch (e) { /* noop */ }
        try { conn.send({ type: MSG.REVERB_LOWCUT, value: reverbLowCut }); } catch (e) { /* noop */ }
        try { conn.send({ type: MSG.REVERB_HIGHCUT, value: reverbHighCut }); } catch (e) { /* noop */ }
        try { conn.send({ type: MSG.REPEAT_MODE, value: repeatMode }); } catch (e) { /* noop */ }
        try { conn.send({ type: MSG.SHUFFLE_MODE, value: isShuffle }); } catch (e) { /* noop */ }
        try {
            eqValues.forEach((val, i) => {
                conn.send({ type: MSG.EQ_UPDATE, band: i, value: val });
            });
        } catch (e) { /* noop */ }
        try { conn.send({ type: MSG.PREAMP, value: Math.round(20 * Math.log10(userPreampGain)) }); } catch (e) { /* noop */ }
        try { conn.send({ type: MSG.STEREO_WIDTH, value: stereoWidth * 100 }); } catch (e) { /* noop */ }
        try { conn.send({ type: MSG.VBASS, value: virtualBass * 100 }); } catch (e) { /* noop */ }

        // Playlist Sync (Full state for joiners)
        try {
            conn.send({
                type: MSG.PLAYLIST,
                list: buildPlaylistMetaList()
            });
        } catch (e) { /* noop */ }

        // If a local file is already loaded, push it directly (for late-join / reconnect).
        // Note: Use currentTransferSessionId (Host) — localTransferSessionId is Guest-side.
        if (currentFileBlob && currentTrackIndex >= 0 && Array.isArray(playlist) && playlist[currentTrackIndex] && playlist[currentTrackIndex].type !== 'youtube') {
            try {
                unicastFile(conn, currentFileBlob, 0, currentTransferSessionId)
                    .catch((e) => log.error('[Host] unicastFile failed', e));
            } catch (e) { /* noop */ }
        }

        // Send preloaded next track to late-joining guest
        if (nextFileBlob && nextMeta && nextTrackIndex >= 0 &&
            Array.isArray(playlist) && playlist[nextTrackIndex] && playlist[nextTrackIndex].type !== 'youtube') {
            const preloadSid = nextMeta.sessionId || preloadSessionId;
            log.debug(`[Host] Sending preloaded track ${nextTrackIndex} to late joiner`);
            unicastPreload(conn, nextFileBlob, nextTrackIndex, preloadSid)
                .catch((e) => log.error('[Host] unicastPreload to late joiner failed', e));
        }

        // Playback state (time-sync for late joiners)
        const nowPos = getTrackPosition();

        if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
            const _itemName = (Array.isArray(playlist) && playlist[currentTrackIndex]) ? (playlist[currentTrackIndex].name || playlist[currentTrackIndex].file?.name) : null;
            try {
                conn.send({
                    type: MSG.PLAY,
                    time: nowPos,
                    index: currentTrackIndex,
                    name: _itemName,
                    state: currentState,
                    timestamp: Date.now()
                });
            } catch (e) { /* noop */ }
        } else if (currentState === APP_STATE.PLAYING_YOUTUBE) {
            // Send YouTube bootstrap so late joiners can enter YouTube mode
            const item = (Array.isArray(playlist) ? playlist[currentTrackIndex] : null);

            if (item && item.type === 'youtube') {
                let ytTime = 0;
                let ytState = 2;

                try {
                    if (youtubePlayer && youtubePlayer.getCurrentTime) ytTime = youtubePlayer.getCurrentTime();
                    if (youtubePlayer && youtubePlayer.getPlayerState) ytState = youtubePlayer.getPlayerState();
                } catch (_) { /* best-effort */ }

                const autoplay = (ytState === 1);
                const subIdx = (typeof currentYouTubeSubIndex === 'number' && currentYouTubeSubIndex >= 0) ? currentYouTubeSubIndex : 0;

                try {
                    conn.send({
                        type: MSG.YOUTUBE_PLAY,
                        videoId: item.videoId,
                        playlistId: item.playlistId,
                        name: item.name || item.title,
                        index: currentTrackIndex,
                        autoplay: autoplay,
                        subIndex: subIdx
                    });

                    // Also send an immediate sync frame
                    conn.send({
                        type: MSG.YOUTUBE_SYNC,
                        time: ytTime,
                        state: ytState,
                        subIndex: subIdx
                    });
                } catch (e) { /* noop */ }
            } else {
                // If YouTube state is inconsistent, send pause
                sendPauseState(conn, nowPos);
            }
        } else {
            // IDLE: Send pause to sync position
            sendPauseState(conn, nowPos);
        }

        updateRoleBadge();
    });

    conn.on('data', (data) => {
        try { handleData(data, conn); }
        catch (e) { log.error('[Host] Error in handleData', e); }
        try { handleOperatorRequest(data, conn); }
        catch (e) { log.error('[Host] Error in handleOperatorRequest', e); }
    });

    conn.on('close', () => {
        log.info(`[Host] Connection closed: ${peerId}`);

        // Ignore stale close events from replaced duplicate connections
        if (activeHostConnByPeerId.get(peerId) !== conn) {
            return;
        }

        activeHostConnByPeerId.delete(peerId);
        releasePeerSlot(peerId);

        connectedPeers = connectedPeers.filter(p => p.id !== peerId);

        updateRoleBadge();

        if (sessionStarted) {
            showToast(`${deviceName} 연결이 끊겼어요`);
        }
    });

    conn.on('error', (err) => {
        log.error('[Host] Connection error:', err);

        // Ignore stale errors from replaced duplicate connections
        if (activeHostConnByPeerId.get(peerId) !== conn) {
            try { conn.close(); } catch (e) { /* noop */ }
            return;
        }

        activeHostConnByPeerId.delete(peerId);
        releasePeerSlot(peerId);

        connectedPeers = connectedPeers.filter(p => p.id !== peerId);

        updateRoleBadge();

        if (sessionStarted) {
            showToast(`${deviceName} 연결 오류`);
        }

        try { conn.close(); } catch (e) { /* noop */ }
    });
}

function sendPauseState(conn, time) {
    try {
        if (!conn || !conn.open) return;
        conn.send({
            type: MSG.PAUSE,
            time: time,
            index: currentTrackIndex,
            state: currentState,
            timestamp: Date.now()
        });
    } catch (e) { /* noop */ }
}

// Guest Logic
let connectionTimeoutId = null;

function joinSession(retryAttempt = 0, hostIdOverride = null) {
    // Already connected?
    if (hostConn && hostConn.open) {
        log.warn('[Join] Already connected to host.');
        return;
    }

    const raw = (hostIdOverride || lastJoinCode || (setupEl('setup-join-code') ? setupEl('setup-join-code').value : '') || '').trim();
    const hostId = raw.replace(/\s+/g, '');

    if (!hostId) {
        showToast('연결 코드를 입력해주세요.');
        startGuestFlow();
        return;
    }

    lastJoinCode = hostId;

    // Settings tab header: keep showing the current invite code
    updateInviteCodeUI();

    // Ensure peer exists and is open
    if (!peer) {
        if (retryAttempt > 3) {
            showConnectionFailedOverlay('네트워크 초기화 실패', '같은 Wi‑Fi인지 확인하고 다시 시도해주세요.', hostId);
            return;
        }

        initNetwork(null)
            .then(() => joinSession(retryAttempt + 1, hostId))
            .catch((e) => {
                log.error('[Join] Failed to init peer', e);
                showConnectionFailedOverlay('네트워크 초기화 실패', '같은 Wi‑Fi인지 확인하고 다시 시도해주세요.', hostId);
            });
        return;
    }

    if (!peer.open) {
        if (retryAttempt < 10) {
            setTimeout(() => joinSession(retryAttempt + 1, hostId), 300);
        } else {
            showConnectionFailedOverlay('연결 준비 실패', '잠시 후 다시 시도해주세요.', hostId);
        }
        return;
    }

    isConnecting = true;
    updateRoleBadge();

    let conn;
    try {
        // IMPORTANT: myDeviceLabel is Host-assigned ("Peer N") after join.
        // For join metadata, send the current local role label instead (informational only).
        const joinRoleLabel = getRoleLabelByChannelMode(channelMode);
        conn = peer.connect(hostId, {
            reliable: true,
            metadata: {
                label: joinRoleLabel
            }
        });
    } catch (e) {
        log.error('[Join] peer.connect failed', e);
        isConnecting = false;
        updateRoleBadge();
        showConnectionFailedOverlay('연결 실패', '같은 Wi‑Fi인지 확인하고 다시 시도해주세요.', hostId);
        return;
    }

    // Timeout if host is unreachable
    const timeoutId = setTimeout(() => {
        if (!conn || conn.open || hostConn) return;

        try { conn.close(); } catch (e) { /* noop */ }
        isConnecting = false;
        updateRoleBadge();
        showConnectionFailedOverlay('호스트에 연결할 수 없어요', '네트워크 연결 상태와 코드를 확인해주세요.', hostId);
    }, 10000);

    conn.on('open', () => {
        clearTimeout(timeoutId);

        log.info('[Join] Connected to host:', hostId);

        hostConn = conn;
        isConnecting = false;
        updateRoleBadge();

        // Toss 인앱 UX: 역할 선택 후 바로 메인으로 진입
        hideSetupOverlay();
        try {
            const m = (pendingPlacementToastMode !== null && pendingPlacementToastMode !== undefined)
                ? pendingPlacementToastMode
                : channelMode;
            showPlacementToastForChannel(m);
        } catch (e) { /* noop */ }
        pendingPlacementToastMode = null;

        // Message handler
        conn.on('data', handleData);

        // Guard: PeerJS fires both 'error' and 'close' on failure → deduplicate popup
        conn._errorHandled = false;

        conn.on('close', () => {
            log.warn('[Join] Host connection closed');
            hostConn = null;
            isConnecting = false;
            updateRoleBadge();

            if (conn._errorHandled) { isIntentionalDisconnect = false; return; }
            conn._errorHandled = true;

            if (!isIntentionalDisconnect) {
                showConnectionFailedOverlay('연결이 끊어졌어요', '네트워크 상태를 확인한 후 다시 참가해 주세요.', hostId);
            }
            isIntentionalDisconnect = false;
        });

        conn.on('error', (err) => {
            log.error('[Join] Host connection error', err);
            hostConn = null;
            isConnecting = false;
            updateRoleBadge();

            if (conn._errorHandled) return;
            conn._errorHandled = true;

            showConnectionFailedOverlay('연결에 문제가 생겼어요', '네트워크 상태를 확인한 후 다시 참가해 주세요.', hostId);
        });

        // Start heartbeat/ping
        // NOTE: sync.worker.js understands START_TIMER/STOP_TIMER.
        // Previous builds used {type:'startHeartbeat'} which was silently ignored by postWorkerCommand.
        postWorkerCommand({ command: 'START_TIMER', id: MSG.HEARTBEAT, interval: 1000 });
        postWorkerCommand({ command: 'START_TIMER', id: 'ping', interval: 2000 });
        setTimeout(() => detectConnectionType(), 2000);

        switchTab('play');
    });
}

function showConnectionFailedOverlay(title, message, hostId = '') {
    // Simplified: Use the in-app dialog (no external links / no separate overlay)
    // Removed extra text as requested
    showDialog({
        title: String(title || '연결하지 못했어요'),
        message: String(message || '')
    });

    // Stay on guest join screen with the last code preserved
    // Re-enable button
    setupRenderActions([
        { id: 'btn-setup-confirm', text: '시작하기', kind: 'primary', onClick: () => handleSetupJoinWithRole(pendingGuestRoleMode) },
    ]);

    const input = setupEl('setup-join-code');
    if (input) {
        if (hostId) input.value = hostId;
        input.disabled = false;
        input.focus();
    }
    setupSetGuestJoinBusy(false);
}

async function leaveSession(opts = {}) {
    log.debug("[Musixquare] Leaving session and resetting state...");

    // Set intentional disconnect flag first to prevent retry logic
    isIntentionalDisconnect = true;

    // Stop background worker timers & any in-flight OPFS catch-up pumps
    stopBackgroundWorkerTimers();
    try {
        opfsCatchupPumps.forEach((_, pid) => stopOpfsCatchupStream(pid, 'leave-session'));
    } catch (_) { }

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

    // Reset host-assigned peer slots
    try {
        activeHostConnByPeerId.clear();
        peerSlotByPeerId.clear();
        for (let i = 1; i <= MAX_GUEST_SLOTS; i++) peerSlots[i] = null;
    } catch (_) { /* best-effort */ }

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
    updateTitleWithMarquee("미디어 없음");

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
    if (chatMessages) chatMessages.innerHTML = '<div class="chat-empty">아직 메시지가 없어요.<br>첫 메시지를 보내 보세요!</div>';

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
    window._lastClearedTrackName = null;

    if (window.BlobURLManager) BlobURLManager.revoke();

    setState(APP_STATE.IDLE);

    // Back to Setup overlay (network will be initialized on demand)
    const toastMsg = (opts && typeof opts.toastMessage === 'string') ? opts.toastMessage : "세션이 초기화되었습니다.";
    const showResetToast = (opts && opts.showToast !== undefined) ? !!opts.showToast : true;
    if (showResetToast) showToast(toastMsg);
    initSetupOverlay();

    log.debug("[Musixquare] Session left and state reset.");
}

// --- Data Handling ---
// Note: currentFileOpfs, preloadFileOpfs handles are used for storage

// Local-only build: no STUN/TURN, no relay mode
async function detectConnectionType() {
    // In this Toss in-app build we force local network connectivity (same Wi‑Fi).
    // Ping compensation / relay handling is intentionally disabled for simplicity.
    usePingCompensation = false;
}

// Helper: Clear all previous track state to prevent data mixing
function clearPreviousTrackState(reason = '') {
    log.debug(`[State Clear] Clearing previous track state. Reason: ${reason}`);

    // [Edge Case] If this function is called multiple times for the same track, skip
    const trackName = playlist[currentTrackIndex]?.name || meta?.name || '';
    if (reason === 'redundant-sync' && trackName && window._lastClearedTrackName === trackName) {
        log.debug(`[State Clear] Skipping redundant clear for: ${trackName}`);
        return;
    }
    window._lastClearedTrackName = trackName;

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

    // Redundant syncs should not stop audio if it's already the right track
    if (reason === 'redundant-sync') return;

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
    // Now that the source is detached, flush any deferred BlobURL revocations
    try { BlobURLManager.flushDeferred('clearPreviousTrackState'); } catch (_) { }

    // Physically delete the OLD current file from OPFS when switching tracks
    if (currentFileOpfs.name) {
        // Only cleanup if the filename is DIFFERENT from what we're about to load
        // (Prevents clearing OPFS right before playing a preloaded file with same name)
        const isActuallyChanging = (currentFileOpfs.name !== nextMeta?.name);
        if (isActuallyChanging) {
            postWorkerCommand({ command: 'OPFS_RESET', isPreload: false });
            cleanupOPFSInWorker(currentFileOpfs.name, false);
            currentFileOpfs.name = null;
        }
    }

    // Note: We do NOT clear preload state here (nextFileBlob, preloadChunks, etc.)
    // Those are intentionally preserved for upcoming track switch
}

// --- Data Message Handlers ---
async function handleFilePrepare(data) {
    // Increment token to invalidate any previous async operations
    const myLoadToken = ++_currentLoadToken;

    // Always clear stuck preload waiting state on new file-prepare
    if (_waitingForPreload) {
        log.debug(`[file-prepare] Clearing stale _waitingForPreload flag`);
        _waitingForPreload = false;
    }
    if (_preloadWatchdog) {
        clearTimeout(_preloadWatchdog);
        _preloadWatchdog = null;
    }
    clearManagedTimer('preloadWatchdog');
    _recoveryRetryCount = 0; // Reset recovery counter for new track

    // Immediate Session Check to invalidate old chunks
    const incomingSid = data.sessionId;
    if (incomingSid && incomingSid > localTransferSessionId) {
        log.debug(`[file-prepare] New session detected: ${incomingSid} (Previous: ${localTransferSessionId}). Invalidating old chunks.`);
        localTransferSessionId = incomingSid;
        window._lastClearedTrackName = null; // Forces next clear-state to run even if name matches (new session)
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

        // [Title Sync Fix] Update title when using preloaded track
        const preloadName = data.name || (nextMeta && nextMeta.name) || (playlist[data.index] && playlist[data.index].name) || `Track ${data.index + 1}`;
        updateTitleWithMarquee(preloadName);

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
            // [Title Sync Fix] Update title while waiting for preload
            if (data.name) updateTitleWithMarquee(data.name);

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
                    _skipIncomingFile = false; // Allow fallback download after preload timeout
                    if (hostConn && hostConn.open) hostConn.send({ type: MSG.REQUEST_CURRENT_FILE, name: data.name, index: data.index });
                }
            }, 10000);

            return; // Don't start new download
        }
    }

    // Normal flow: No preload available, prepare for download
    _skipIncomingFile = false;
    _waitingForPreload = false;

    // CRITICAL: Don't clear state if we're resuming the SAME file!
    // This preserves already-received chunks during recovery
    // Check BEFORE updating _pendingFileIndex (otherwise comparison is always true)
    const isSameFile = (meta && meta.name === data.name) ||
        (_pendingFileIndex !== undefined && _pendingFileIndex === data.index);

    // Store pending file name for recovery requests (AFTER isSameFile check)
    window._pendingFileName = data.name;
    _pendingFileIndex = data.index;
    const isResuming = isSameFile && receivedCount > 0;

    if (isResuming) {
        log.debug(`[file-prepare] Same file in progress (${receivedCount} chunks), skipping reset`);
        showLoader(true, `복구 대기 중: ${data.name}`);
        // [Title Sync Fix] Ensure title is set even during resume
        if (data.name) updateTitleWithMarquee(data.name);
    } else {
        // Clear previous track state before receiving new file
        clearPreviousTrackState('file-prepare (new download)');
        showLoader(true, `준비 중: ${data.name}`);
        // stopAllMedia(); // Removed - already called at the top of handler
        if (data.index !== undefined) {
            currentTrackIndex = data.index;
            // [Metadata Sync Fix] Cache name temporarily if not in playlist yet
            if (data.name && playlist[data.index]) {
                playlist[data.index].name = data.name;
            }
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
        updateTitleWithMarquee(data.name || meta?.name || 'Track');

        const _idx = (data.index !== undefined && data.index !== null)
            ? Number(data.index)
            : (meta && meta.index !== undefined ? Number(meta.index) : Number(currentTrackIndex));

        const _artistEl = document.getElementById('track-artist');
        if (_artistEl) {
            _artistEl.innerText = (Number.isFinite(_idx) && _idx >= 0) ? `Track ${_idx + 1}` : 'Track';
        }
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
    // Session ID Validation - NO FALLBACK to 0
    const incomingSid = data.sessionId;
    if (!incomingSid || incomingSid < localTransferSessionId) {
        log.warn(`[file-start] Stale or invalid session ignored. Current: ${localTransferSessionId}, Received: ${incomingSid}`);
        return;
    }

    const prevSid = localTransferSessionId;
    const isNewSession = incomingSid > prevSid;

    // If it's a newer session, reset state
    if (isNewSession) {
        log.debug(`[file-start] New session detected: ${incomingSid}. Resetting state.`);
        localTransferSessionId = incomingSid;
        _currentLoadToken++; // Invalidate any stale decodes for the old session

        // Explicitly RESET worker slot for new session to prevent lock collision
        postWorkerCommand({ command: 'OPFS_RESET', isPreload: false });

        clearPreviousTrackState('new-session-start');
    }

    // -------------------------------------------------------------
    // [Edge Case Fix]
    // When using a preloaded file, the Host may still send file-start.
    // stopAllMedia() would detach Blob URLs and clear the loaded media.
    // So, if we're intentionally skipping, do NOT stop playback/state here.
    // -------------------------------------------------------------
    if (_skipIncomingFile) {
        clearManagedTimer('prepareWatchdog');
        clearManagedTimer('chunkWatchdog');

        // Relay header downstream (if this node is acting as a relay)
        if (downstreamDataPeers.length > 0) {
            downstreamDataPeers.forEach(p => { if (p.open) p.send(data); });
        }

        log.debug("[file-start] Skipping - already using preloaded file");
        showLoader(false);
        return;
    }

    // -------------------------------------------------------------
    // [Edge Case Fix]
    // Duplicate file-start headers can occur (reconnect/relay churn).
    // If we already have a complete file for this same session, ignore
    // without stopping playback or re-finalizing OPFS.
    // -------------------------------------------------------------
    const isSameFile = meta && meta.name === data.name && meta.total === data.total;
    if (!isNewSession && isSameFile && receivedCount >= data.total) {
        log.debug("[file-start] Duplicate start for already-complete file. Ignoring.");
        clearManagedTimer('prepareWatchdog');
        clearManagedTimer('chunkWatchdog');

        // Keep meta aligned (helps late sync requests)
        meta = data;
        transferState = TRANSFER_STATE.READY;

        // Attempt OPFS recovery only if currentFileBlob is missing
        if (!currentFileBlob) {
            try {
                const recovered = await tryGetOpfsFile(data.name, false);
                if (recovered) {
                    currentFileBlob = recovered;
                    finalizeFileProcessing(recovered);
                }
            } catch (_) { /* best-effort */ }
        }

        // Ack Host (in case the previous ack was missed)
        if (hostConn && hostConn.open && data.index !== undefined) {
            try { hostConn.send({ type: MSG.PRELOAD_ACK, index: data.index }); } catch (_) { /* ignore */ }
        }

        // Relay header downstream if needed
        if (downstreamDataPeers.length > 0) {
            downstreamDataPeers.forEach(p => { if (p.open) p.send(data); });
        }

        showLoader(false);
        return;
    }

    // Stop current playback immediately when new transfer starts
    stopAllMedia();

    // Clear ANY pending watchdogs for file preparation/transfer
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');

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
    const isRecoverySameFile = meta && meta.name === data.name && meta.total === data.total;

    if (isRecoverySameFile && receivedCount > 0) {
        // RECOVERY MODE: Keep existing chunks (OPFS will overwrite or we seek)
        log.debug(`[file-start] Same file detected! Keeping ${receivedCount}/${data.total} chunks (OPFS seek logic will follow)`);
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

        incomingChunks = []; // Clear in-memory array (legacy; OPFS is primary)
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

    // Watchdog Start
    clearManagedTimer('chunkWatchdog');
    lastChunkTime = Date.now();
    _lastReceivedCountSnapshot = receivedCount;
    _recoveryRetryCount = 0; // Reset retry counter on new transfer
    managedTimers.chunkWatchdog = setInterval(() => {
        const timeSinceLast = Date.now() - lastChunkTime;
        const isMetaInvalid = !meta || !meta.total;
        const isStuck = (receivedCount === _lastReceivedCountSnapshot) && timeSinceLast > WATCHDOG_TIMEOUT;

        if (isStuck || timeSinceLast > WATCHDOG_TIMEOUT || (incomingChunks.length > 0 && isMetaInvalid)) {
            clearManagedTimer('chunkWatchdog');
            showToast("데이터 수신 불안정. Host 복구 요청...");

            if (upstreamDataConn) upstreamDataConn = null;

            if (hostConn && hostConn.open) {
                sendRecoveryRequest(receivedCount || 0);
            }
        }
        _lastReceivedCountSnapshot = receivedCount;
    }, 1000);

    // RELAY LOGIC: Forward 'file-start' header to downstream (validated, single-send)
    if (downstreamDataPeers.length > 0) {
        downstreamDataPeers.forEach(p => { if (p.open) p.send(data); });
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
    _lastReceivedCountSnapshot = receivedCount;
    _recoveryRetryCount = 0; // Reset retry counter on resume
    managedTimers.chunkWatchdog = setInterval(() => {
        const timeSinceLast = Date.now() - lastChunkTime;
        const isStuck = (receivedCount === _lastReceivedCountSnapshot) && timeSinceLast > 12000;

        if (isStuck || timeSinceLast > 12000) {
            clearManagedTimer('chunkWatchdog');
            showToast("데이터 수신 불안정. Host 복구 요청...");
            if (upstreamDataConn) upstreamDataConn = null;

            if (hostConn && hostConn.open) {
                sendRecoveryRequest(receivedCount || 0);
            }
        }
        _lastReceivedCountSnapshot = receivedCount;
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
            const currentBytes = receivedCount * CHUNK_SIZE;
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
        _recoveryRetryCount = 0; // Transfer complete, reset recovery counter
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
        showToast("YouTube 모드에서는 정밀 동기화를 지원하지 않아요");
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

    // Enter YouTube mode via centralized state transition so UI classes (e.g., Settings lock) stay consistent.
    setState(APP_STATE.PLAYING_YOUTUBE, { skipCleanup: true });

    // 4. Sync track index
    if (data.index !== undefined) {
        currentTrackIndex = data.index;
        // [Metadata Sync Fix] Cache name temporarily if not in playlist yet
        if (data.name && playlist[data.index]) {
            playlist[data.index].name = data.name;
        }
        updatePlaylistUI();

        // [Title Sync Fix] Update title so guest UI reflects the YouTube track
        const ytTrackName = data.name || (playlist[data.index] && playlist[data.index].name) || `Track ${data.index + 1}`;
        updateTitleWithMarquee(ytTrackName);
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
        try { preloadReorderBuffer.delete(sessionId); } catch (_) { /* ignore */ } // Memory safety
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

    // Clear any stuck waiting state from previous preload
    _waitingForPreload = false;

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

    // If any chunks arrived before PRELOAD_START was processed (unordered/unreliable channel),
    // drain them now that session state & OPFS_START are ready.
    try { drainPreloadReorderBuffer(sessionId); } catch (_) { /* best-effort */ }


    if (downstreamDataPeers.length > 0) {
        downstreamDataPeers.forEach(p => { if (p.open) p.send(data); });
    }

    // [Stability Fix] Watchdog: unconditionally clear preload loader after 30s
    clearManagedTimer('preloadWatchdog');
    managedTimers.preloadWatchdog = setTimeout(() => {
        log.warn("[Preload] Watchdog: forcing preload loader reset after 30s");
        showLoader(false);
        _waitingForPreload = false;
        // If main transfer is still in progress, restore its loader
        if (transferState === TRANSFER_STATE.RECEIVING && meta) {
            const pct = meta.total > 0 ? Math.round((receivedCount / meta.total) * 100) : 0;
            showLoader(true, `수신 중... ${pct}%`);
        }
    }, 30000);
}

// Network Data Integrity: Preload Reordering Buffer
const preloadReorderBuffer = new Map(); // sessionId -> Map(index -> chunk)
// [Legacy] Global preload pointer kept to avoid implicit globals; preload logic uses sessionState.nextExpectedChunk.
let nextExpectedPreloadChunk = 0; // Deprecated; used only for legacy resets/debug
let latestPreloadSessionId = 0; // Fallback for chunks missing explicit SessionID


function drainPreloadReorderBuffer(sessionId) {
    const sessionState = preloadSessionState.get(sessionId);
    if (!sessionState || sessionState.skipped) return;

    const sessionBuffer = preloadReorderBuffer.get(sessionId);
    if (!sessionBuffer) return;

    let nextChunkPtr = sessionState.nextExpectedChunk || 0;

    while (sessionBuffer.has(nextChunkPtr)) {
        const chunk = sessionBuffer.get(nextChunkPtr);

        // Clone chunk to prevent detachment issues (one for relay, one for worker)
        const chunkClone = new Uint8Array(chunk);
        const fileName = sessionState.name || (preloadMeta ? preloadMeta.name : '');

        // If we still don't know the filename, we can't safely write to OPFS.
        // Keep buffering until we have the header.
        if (!fileName) break;

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

    sessionState.nextExpectedChunk = nextChunkPtr;
    sessionState.progress = nextChunkPtr;
    preloadCount = sessionState.progress;

    // Update preload UI if main transfer is not using the loader
    if (preloadMeta && preloadMeta.total > 0) {
        // Tick watchdog
        clearManagedTimer('preloadWatchdog');
        managedTimers.preloadWatchdog = setTimeout(() => {
            if (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.IDLE) {
                showLoader(false);
            }
        }, 15000);

        if (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.IDLE) {
            const pct = Math.min(100, Math.floor((sessionState.progress / preloadMeta.total) * 100));
            updateLoader(pct);
        }
    }

    // Finalize if complete
    const totalExpected = sessionState.total || 0;
    const fileSize = sessionState.size || 0;
    if (totalExpected > 0 && sessionState.progress >= totalExpected) {
        if (!sessionState.finalized) {
            sessionState.finalized = true;
            postWorkerCommand({
                command: 'OPFS_END',
                filename: sessionState.name,
                isPreload: true,
                sessionId: sessionId,
                totalSize: fileSize
            });
        }
    }
}

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

    // If PRELOAD_START hasn't been processed yet (unordered delivery), don't consume/delete chunks.
    // Keep buffering until sessionState exists so we have a reliable filename/total.
    if (!sessionState) {
        // Safety cap: avoid unbounded memory growth if header is missing.
        const MAX_EARLY_PRELOAD_CHUNKS = 128;
        if (sessionBuffer.size > MAX_EARLY_PRELOAD_CHUNKS) {
            log.warn(`[Preload] Too many early chunks without session state (SID: ${sessionId}). Dropping buffered chunks.`);
            preloadReorderBuffer.delete(sessionId);
        }
        return;
    }



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
    clearManagedTimer('preloadWatchdog'); // Always clear on end
    if (_skipIncomingPreload) {
        // [Infinite Preparing Fix] Even if skipped, we MUST hide the loader if it was showing.
        if (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.IDLE) {
            showLoader(false);
        }
        return;
    }

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

    // Hide preload loader unconditionally
    showLoader(false);
    _waitingForPreload = false;
    // If main transfer is still in progress, restore its loader
    if (transferState === TRANSFER_STATE.RECEIVING && meta) {
        const pct = meta.total > 0 ? Math.round((receivedCount / meta.total) * 100) : 0;
        showLoader(true, `수신 중... ${pct}%`);
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

    // [Metadata Sync Fix] Cache name temporarily if not in playlist yet
    if (data.name && playlist[data.index]) {
        playlist[data.index].name = data.name;
    }

    updatePlaylistUI(); // Update active highlight

    // [Title Sync Fix] Update title immediately so guest UI reflects new track
    const preloadedTrackName = data.name || (playlist[data.index] && playlist[data.index].name) || `Track ${data.index + 1}`;
    updateTitleWithMarquee(preloadedTrackName);
    const _artistEl = document.getElementById('track-artist');
    if (_artistEl) _artistEl.innerText = `Track ${data.index + 1}`;

    // If Guest was in YouTube mode, stop it before loading file
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
        log.debug("[Guest] Switching from YouTube to Preloaded Local Track");
        stopYouTubeMode();
    }

    // Strict Index Verification: Ensure preloaded data belongs to the requested track
    // (Check both nextMeta and current meta if they refer to the same track)
    const activeMeta = (nextMeta && (nextMeta.index === data.index || nextMeta.name === data.name)) ? nextMeta : meta;
    const isPreloadTargetMatch = nextFileBlob && activeMeta && (activeMeta.index === data.index || activeMeta.name === data.name);

    if (isPreloadTargetMatch) {
        // Use preloaded file if available
        log.debug("[Guest] Using preloaded file for track", data.index);
        await loadPreloadedTrack(data.index, myLoadToken);

        // CRITICAL: Hide loader (Playlist UI is already updated via handlePlayPreloaded's call to updatePlaylistUI)
        showLoader(false);

        // Mark that we already loaded this track (prevent duplicate load from following messages)
        _preloadUsedForIndex = data.index;
        _skipIncomingFile = true;
        window._playPreloadedInProgress = undefined; // Clear in-progress flag

        // Final Cleanup for the new active track
        clearManagedTimer('prepareWatchdog');
        clearManagedTimer('chunkWatchdog');
        _waitingForPreload = false;

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
                        loadPreloadedTrack(data.index, myLoadToken);
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
                clearPreviousTrackState('redundant-sync');

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
    // Header pill: latency + 역할 표시를 실시간으로 업데이트
    updateRoleBadge();
}

function handleWelcome(data) {
    if (!data) return;

    if (data.label) {
        myDeviceLabel = data.label;
        updateRoleBadge();
    }

    // Role-based channel routing (legacy). Toss 인앱에서는 사용자가 직접 선택하므로,
    // 이미 역할을 선택했다면 host의 channelMode는 무시합니다.
    if (typeof data.channelMode === 'number' && selectedJoinChannelMode === null) {
        const ch = data.channelMode;
        const el = document.querySelector(`.ch-opt[data-ch="${ch}"]`);

        // Force apply even if channel is locked
        if (el) {
            setChannel(ch, el, true, false);
        } else {
            setChannelMode(ch);
        }
    }

    // Toss in-app build: 역할(채널 모드)은 사용자가 Settings에서 변경할 수 있어야 합니다.
    // 과거 빌드 호환을 위해 lockChannel 필드는 수신하더라도 강제로 잠그지 않습니다.
    if (data.lockChannel) {
        isChannelSelectionLocked = false;
    }
}

function handleSessionStart() {
    // (레거시 호환) 일부 빌드가 session-start를 보내더라도,
    // Toss 인앱 UX에서는 게스트가 즉시 진입하므로 조용히 처리합니다.
    sessionStarted = true;
    hideSetupOverlay();
    updateRoleBadge();
}

function handleSessionFull(data) {
    const msg = (data && data.message) ? data.message : '세션이 가득 찼어요';
    showDialog({ title: '참가할 수 없어요', message: String(msg || '') });

    // Avoid triggering extra "connection failed" UI
    isIntentionalDisconnect = true;

    try {
        if (hostConn && hostConn.open) hostConn.close();
    } catch (e) { /* noop */ }

    hostConn = null;
    isConnecting = false;
    updateRoleBadge();

    startGuestFlow();
}


async function handlePlay(data) {
    if (managedTimers.autoPlayTimer) {
        clearManagedTimer('autoPlayTimer');
    }

    // [Race Condition Fix] If a preloaded track is being activated asynchronously
    // (handlePlayPreloaded → loadPreloadedTrack in progress), queue this play command.
    // loadPreloadedTrack will pick up _pendingPlayTime when it completes.
    if (window._playPreloadedInProgress !== undefined) {
        log.debug(`[Guest] Play command during preloaded track activation (track ${window._playPreloadedInProgress}), queuing time=${data.time}`);
        _pendingPlayTime = data.time;
        return;
    }

    // Index Check
    if (data.index !== undefined && data.index !== currentTrackIndex) {
        log.warn(`Play command for index ${data.index} received, but I'm on ${currentTrackIndex}. Switching...`);

        // 1. Stop whatever I'm doing
        stopAllMedia();

        // 2. Switch index and metadata
        currentTrackIndex = data.index;
        updatePlaylistUI();

        // [Title Sync Fix] Use explicit name if provided, otherwise playlist lookup
        // (avoid overwriting title already set by FILE_PREPARE/PLAY_PRELOADED with generic fallback)
        const _playName = data.name || (playlist[data.index] && playlist[data.index].name);
        if (_playName) updateTitleWithMarquee(_playName);

        // 3. Initiate recovery/loading if needed
        const item = playlist[currentTrackIndex];
        if (item && item.type !== 'youtube') {
            const hasFile = (currentFileBlob && currentFileBlob.size > 0);
            const isPreloaded = nextFileBlob && (nextMeta && (nextMeta.index === currentTrackIndex || nextMeta.name === item.name));

            if (!hasFile && isPreloaded) {
                log.debug("Required track found in preload cache. Activating...");
                _pendingPlayTime = data.time;
                await loadPreloadedTrack(currentTrackIndex, _currentLoadToken);
                return; // loadPreloadedTrack will pick up _pendingPlayTime
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

    // [Stale Audio Guard] If index is provided and matches, verify the loaded file
    // actually belongs to this track (prevents playing old track's audio data)
    if (data.index !== undefined && hostConn) {
        const expectedName = data.name || (playlist[data.index] && playlist[data.index].name);
        if (expectedName && meta && meta.name && meta.name !== expectedName) {
            log.warn(`[Guest] Stale audio detected: loaded "${meta.name}" but play is for "${expectedName}" (index ${data.index}). Queuing...`);
            _pendingPlayTime = data.time;
            return;
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
    const t = (data && data.time !== undefined) ? Number(data.time) : undefined;

    if (t !== undefined && Number.isFinite(t)) {
        pausedAt = t;

        const usesVideo = currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_AUDIO;
        if (usesVideo && videoElement) {
            try { videoElement.currentTime = t; } catch (_) { }
        }

        const slider = document.getElementById('seek-slider');
        if (slider) slider.value = t;

        const timeCurr = document.getElementById('time-curr');
        if (timeCurr) timeCurr.innerText = fmtTime(t);

        pause(t);
        return;
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
    // Backward/forward compatible payload handling:
    // - Newer code sends { list: [...] }
    // - Some legacy paths used { playlist: [...] }
    const incoming = Array.isArray(data?.list) ? data.list : (Array.isArray(data?.playlist) ? data.playlist : null);

    if (!incoming) {
        log.warn('[PlaylistUpdate] Missing/invalid playlist payload. Resetting to empty.', data);
        playlist = [];
    } else {
        playlist = incoming;
    }

    // Late-join bootstrap may include currentTrackIndex
    if (typeof data?.currentTrackIndex === 'number') {
        currentTrackIndex = data.currentTrackIndex;
    } else if (typeof data?.index === 'number') {
        // Some payloads might use 'index' for current track
        currentTrackIndex = data.index;
    }

    // Clamp for safety
    if (!Array.isArray(playlist)) playlist = [];
    if (currentTrackIndex >= playlist.length) currentTrackIndex = playlist.length - 1;
    if (currentTrackIndex < -1) currentTrackIndex = -1;

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
    updateRoleBadge();
}

async function handleOperatorRevoke(data) {
    isOperator = false;
    showToast("Operator 권한이 해제되었습니다.");
    // Play button disabled state handled by sync logic
    updateRoleBadge();
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
        const REVERB_SETTERS = { mix: setReverb, decay: setReverbDecay, predelay: setReverbPreDelay, lowcut: setReverbLowCut, highcut: setReverbHighCut };
        const setter = REVERB_SETTERS[param];
        if (setter) setter(val);

        // Broadcast on release (not while dragging)
        if (!isInput) {
            const REVERB_MSG_MAP = { mix: MSG.REVERB, decay: MSG.REVERB_DECAY, predelay: MSG.REVERB_PREDELAY, lowcut: MSG.REVERB_LOWCUT, highcut: MSG.REVERB_HIGHCUT };
            const msgType = REVERB_MSG_MAP[param];
            if (msgType) {
                if (!hostConn) broadcast({ type: msgType, value: val });
                else if (isOperator) hostConn.send({ type: MSG.REQUEST_SETTING, settingType: msgType, value: val });
            }
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
    const list = (data && Array.isArray(data.list)) ? data.list : [];
    // Keep a local snapshot for UI/toasts (e.g., connected device count).
    lastKnownDeviceList = list;
    const amIStillConnected = list.find(p => p && p.id === myId);

    // If the host drops us from the roster, gracefully reset without a hard reload.
    if (hostConn && !amIStillConnected) {
        log.warn("[Guest] Removed from Host list. Leaving session...");
        // Prevent the close handler from showing an extra "connection failed" overlay.
        isIntentionalDisconnect = true;
        await leaveSession({ toastMessage: '호스트에서 연결이 종료되었습니다. 메인 화면으로 이동합니다.' });
        return;
    }

    const me = list.find(p => p && p.id === myId);
    if (me && me.label) myDeviceLabel = me.label;
    renderDeviceList(list);
}

async function handleChat(data, conn) {
    if (!data) return;

    const text = (data.text !== undefined && data.text !== null) ? String(data.text) : '';
    if (!text) return;

    // ------------------------------------------------------------------
    // Host behavior: a guest sends CHAT to Host; Host rebroadcasts to others
    // with the canonical Host-assigned label (Peer N) to keep names stable.
    // ------------------------------------------------------------------
    if (!hostConn && conn && conn.peer && conn.peer !== myId) {
        const pid = conn.peer;

        // Canonical Host-assigned label
        let senderLabel = '';
        try {
            const p = connectedPeers.find(x => x.id === pid);
            if (p && p.label) senderLabel = String(p.label);
        } catch (e) { /* noop */ }
        if (!senderLabel && peerLabels && peerLabels[pid]) senderLabel = String(peerLabels[pid]);
        if (!senderLabel) senderLabel = PEER_NAME_PREFIX;

        const senderRole = (data.senderRole || data.role || '').toString();
        const displayName = _formatChatDisplayName(senderLabel, senderRole);

        // Show on Host UI
        addChatMessage(displayName, text, false);

        // Broadcast to all OTHER guests (exclude original sender to avoid duplicate bubbles)
        try {
            broadcastExcept(pid, {
                type: MSG.CHAT,
                senderId: pid,
                sender: senderLabel,
                senderLabel: senderLabel,
                senderRole: senderRole,
                text: text,
                ts: data.ts || Date.now(),
            });
        } catch (e) { /* noop */ }

        return;
    }

    // ---------------------------------------------------------------
    // Guest/Receiver behavior: display message using label + role.
    // ---------------------------------------------------------------
    const senderId = data.senderId || null;
    let senderLabel = (data.senderLabel || data.sender || '').toString();
    if (senderLabel === 'HOST') senderLabel = 'Host';

    const senderRole = (data.senderRole || data.role || '').toString();
    const displayName = _formatChatDisplayName(senderLabel, senderRole);

    const isMine = senderId ? (String(senderId) === String(myId)) : (String(data.sender || '') === String(myDeviceLabel));
    addChatMessage(displayName, text, isMine);
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
    'session-start': handleSessionStart,
    'session-full': handleSessionFull,
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
    'playlist': handlePlaylistUpdate,
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
    'request-current-file': handleRequestCurrentFile,
    'request-data-recovery': handleRequestDataRecovery,
    'preload-ack': handlePreloadAck,
    'request-eq-reset': (data, conn) => handleOperatorRequest(data),
    'request-setting': (data, conn) => handleOperatorRequest(data),
    'request-play': (data, conn) => handleOperatorRequest(data),
    'request-pause': (data, conn) => handleOperatorRequest(data),
    'request-seek': (data, conn) => handleOperatorRequest(data),
    'request-track-change': (data, conn) => handleOperatorRequest(data),
    'request-next-track': (data, conn) => handleOperatorRequest(data),
    'request-prev-track': (data, conn) => handleOperatorRequest(data),
    'request-youtube-play': (data, conn) => handleOperatorRequest(data),
    'request-youtube-pause': (data, conn) => handleOperatorRequest(data),
    'request-reverb-reset': (data, conn) => handleOperatorRequest(data),
    'request-skip-time': (data, conn) => handleOperatorRequest(data),
    'request-youtube-sub-seek': (data, conn) => handleOperatorRequest(data),
    'request-youtube-playlist-info': (data, conn) => {
        // Host responds with cached playlist sub-item data
        if (hostConn) return; // Only host handles this
        const pid = data.playlistId;
        if (pid && youtubeSubItemsMap[pid]) {
            conn.send({ type: MSG.YOUTUBE_PLAYLIST_INFO, playlistId: pid, ids: youtubeSubItemsMap[pid].ids || [], titles: youtubeSubItemsMap[pid].titles || [] });
        }
    },
};

async function handlePreloadAck(data, conn) {
    if (hostConn) return; // Guest ignores
    const p = connectedPeers.find(p => p.id === conn.peer);
    if (p && data.index !== undefined) {
        if (!p.preloadedIndexes) p.preloadedIndexes = new Set();
        p.preloadedIndexes.add(Number(data.index));
        log.debug(`[Host] Marked index ${data.index} as CACHED for peer ${p.label}`);
    }
}

async function handleGetSyncTime(data, conn) {
    if (hostConn) return; // Guest ignores this
    if (conn && conn.open) {
        const t = getTrackPosition();
        const isPlaying = (currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_YOUTUBE);

        conn.send({
            type: MSG.SYNC_RESPONSE,
            time: t,
            isPlaying: isPlaying
        });
        log.debug(`[Host] Sent fresh sync time (${t.toFixed(2)}s) to peer ${conn.peer.substr(-4)}`);
    }
}


// ---------------------------------------------------------------------------
// [HOST] On-demand file serving (Recovery / Late-join support)
// - Guests may request the current file or a resume point when they miss chunks.
// - These handlers are intentionally NO-OP on Guests/Relays (hostConn exists).
// ---------------------------------------------------------------------------
function _ensureNamedFile(blob, fallbackName) {
    if (!blob) return null;
    try {
        if (blob && typeof blob.name === 'string' && blob.name) return blob;
        const name = (fallbackName && String(fallbackName).trim()) ? String(fallbackName).trim() : 'Track';
        return new File([blob], name, { type: blob.type || '' });
    } catch (e) {
        return blob;
    }
}

async function handleRequestCurrentFile(data, conn) {
    // Only Host serves files directly
    if (hostConn) return;
    if (!conn || !conn.open) return;

    // If Host is in YouTube mode there is no local file to serve
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
        try { conn.send({ type: MSG.FILE_WAIT, message: 'Host is playing YouTube (no local file to transfer)' }); } catch (_) { }
        return;
    }

    const reqName = data && data.name ? String(data.name) : '';
    const reqIndex = (data && data.index !== undefined) ? Number(data.index) : undefined;

    // Prefer current track if it matches request; otherwise fall back to whatever we have.
    let blob = null;
    if (currentFileBlob) {
        const matchByIndex = (reqIndex !== undefined && meta && Number(meta.index) === reqIndex);
        const matchByName = (reqName && meta && meta.name === reqName);
        const noHint = (!reqName && reqIndex === undefined);
        if (matchByIndex || matchByName || noHint) blob = currentFileBlob;
    }
    if (!blob && nextFileBlob && nextMeta) {
        const matchNextByIndex = (reqIndex !== undefined && Number(nextMeta.index) === reqIndex);
        const matchNextByName = (reqName && nextMeta.name === reqName);
        if (matchNextByIndex || matchNextByName) blob = nextFileBlob;
    }
    if (!blob) blob = currentFileBlob || nextFileBlob;

    if (!blob) {
        try { conn.send({ type: MSG.FILE_WAIT, message: 'Host file is not ready yet' }); } catch (_) { }
        return;
    }

    // Use current broadcast session id to keep Guest-side session guards happy.
    // IMPORTANT: Guest ignores SID=0, so ensure a valid (>=1) session id exists.
    let sid = (meta && meta.sessionId) ? meta.sessionId : currentTransferSessionId;
    if (!sid || sid < 1) {
        sid = nextSessionId();
        currentTransferSessionId = sid;
    }
    const _fallbackName = (blob === currentFileBlob && meta && meta.name) ? meta.name :
        (blob === nextFileBlob && nextMeta && nextMeta.name) ? nextMeta.name :
            (reqName || (meta && meta.name) || (nextMeta && nextMeta.name) || 'Track');
    const fileToSend = _ensureNamedFile(blob, _fallbackName);
    await unicastFile(conn, fileToSend, 0, sid);
}

async function handleRequestDataRecovery(data, conn) {
    // Only Host serves recovery directly
    if (hostConn) return;
    if (!conn || !conn.open) return;

    // Normalize requested start chunk
    let startChunk = 0;
    if (data && data.nextChunk !== undefined) {
        const n = Number(data.nextChunk);
        if (Number.isFinite(n) && n > 0) startChunk = Math.floor(n);
    }

    const reqName = data && (data.fileName || data.name) ? String(data.fileName || data.name) : '';
    const reqIndex = (data && data.index !== undefined) ? Number(data.index) : undefined;

    // Prefer current track for recovery
    let blob = null;
    if (currentFileBlob) {
        const matchByIndex = (reqIndex !== undefined && meta && Number(meta.index) === reqIndex);
        const matchByName = (reqName && meta && meta.name === reqName);
        if (matchByIndex || matchByName || (!reqName && reqIndex === undefined)) blob = currentFileBlob;
    }
    if (!blob && nextFileBlob && nextMeta) {
        const matchNextByIndex = (reqIndex !== undefined && Number(nextMeta.index) === reqIndex);
        const matchNextByName = (reqName && nextMeta.name === reqName);
        if (matchNextByIndex || matchNextByName) blob = nextFileBlob;
    }
    if (!blob) blob = currentFileBlob || nextFileBlob;

    if (!blob) {
        try { conn.send({ type: MSG.FILE_WAIT, message: 'Host has no cached file for recovery yet' }); } catch (_) { }
        return;
    }

    // Clamp chunk index to avoid weird requests (keeps unicast logic sane)
    const total = Math.ceil(blob.size / CHUNK_SIZE);
    if (!Number.isFinite(total) || total <= 0) {
        try { conn.send({ type: MSG.FILE_WAIT, message: 'Invalid file size' }); } catch (_) { }
        return;
    }
    if (startChunk >= total) startChunk = Math.max(0, total - 1);

    // Use current broadcast session id (and ensure it's valid).
    let sid = (meta && meta.sessionId) ? meta.sessionId : currentTransferSessionId;
    if (!sid || sid < 1) {
        sid = nextSessionId();
        currentTransferSessionId = sid;
    }
    const _fallbackName = (blob === currentFileBlob && meta && meta.name) ? meta.name :
        (blob === nextFileBlob && nextMeta && nextMeta.name) ? nextMeta.name :
            (reqName || (meta && meta.name) || (nextMeta && nextMeta.name) || 'Track');
    const fileToSend = _ensureNamedFile(blob, _fallbackName);
    await unicastFile(conn, fileToSend, startChunk, sid);
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

    // [Relay Architecture Fix] Automated Command Relay (Bi-directional)
    if (hostConn) {
        // 1. RELAY DOWNSTREAM (Control commands from Upstream -> Downstream)
        if (downstreamDataPeers.length > 0) {
            const RELAYABLE_COMMANDS = [
                MSG.PLAY, MSG.PAUSE, MSG.VOLUME, MSG.SEEK,
                MSG.EQ_UPDATE, MSG.PREAMP, MSG.EQ_RESET,
                MSG.REVERB, MSG.REVERB_TYPE, MSG.REVERB_DECAY,
                MSG.REVERB_PREDELAY, MSG.REVERB_LOWCUT, MSG.REVERB_HIGHCUT,
                MSG.STEREO_WIDTH, MSG.VBASS,
                MSG.REPEAT_MODE, MSG.SHUFFLE_MODE,
                MSG.YOUTUBE_PLAY, MSG.YOUTUBE_SYNC, MSG.YOUTUBE_STATE,
                MSG.YOUTUBE_STOP, MSG.YOUTUBE_SUB_TITLE_UPDATE,
                MSG.SYS_TOAST, MSG.STATUS_SYNC, MSG.CHAT,
                MSG.PLAYLIST_UPDATE, MSG.PLAYLIST
            ];

            if (RELAYABLE_COMMANDS.includes(data.type)) {
                downstreamDataPeers.forEach(p => {
                    if (p.open) {
                        try { p.send(data); } catch (_) { /* peer might have closed */ }
                    }
                });
            }
        }

        // 2. RELAY UPSTREAM (Operator requests from Downstream -> Upstream)
        if (conn !== hostConn && hostConn.open) {
            if (data.type && data.type.startsWith('request-')) {
                log.debug(`[Relay] Forwarding request downstream->upstream: ${data.type}`);
                hostConn.send(data);
            }
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
    const el = document.getElementById('manual-sync-value');
    if (el) el.innerText = (totalMs > 0 ? '+' : '') + totalMs;
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
            const isMatchCurrent = currentFileBlob && (!reqName || (meta && meta.name === reqName));
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
            else if (meta?.name && meta.name === (reqName || currentTrackName)) {
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
                    // [Stability] Worker queue 폭주 방지:
                    // 기존처럼 OPFS_READ를 receivedCount 만큼 한꺼번에 보내면 (특히 대용량 파일/저사양 iOS에서)
                    // 프리징/메모리 급증/락 충돌이 발생할 수 있습니다.
                    startOpfsCatchupStream(conn, {
                        filename: meta.name,
                        sessionId: meta.sessionId || localTransferSessionId,
                        startIndex: 0,
                        endIndexExclusive: receivedCount,
                        isPreload: false
                    });
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
                requestId: `${conn.peer}|recovery` // Tag it so we know where to send the response
            });
        }
    });

    conn.on('close', () => {
        downstreamDataPeers = downstreamDataPeers.filter(p => p.peer !== conn.peer);
        stopOpfsCatchupStream(conn.peer, 'peer close');
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

// Broadcast to all peers except one (useful for chat relays to avoid duplicates)
function broadcastExcept(excludePeerId, msg, isDataOnly = false) {
    connectedPeers.forEach(p => {
        if (p.status === 'connected' && p.conn.open) {
            if (excludePeerId && p.id === excludePeerId) return;
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

    // [Security] Avoid string-based innerHTML templating for remote/peer-provided fields.
    // Build DOM nodes with textContent to prevent XSS by construction.
    container.innerHTML = '';

    list.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'section-row';

        // Name area
        const name = document.createElement('span');
        name.className = 'd-name';
        name.textContent = (p.label || 'Device').toString();

        const shortId = document.createElement('span');
        shortId.style.cssText = 'font-size:11px; opacity:0.5; margin-left:4px;';
        shortId.textContent = `(${(p.id || '').toString().substr(-4)})`;
        name.appendChild(document.createTextNode(' '));
        name.appendChild(shortId);

        if (p.isOp) {
            const op = document.createElement('span');
            op.style.cssText = 'color:var(--primary); font-size:10px; font-weight:bold; margin-left:4px;';
            op.textContent = 'OP';
            name.appendChild(document.createTextNode(' '));
            name.appendChild(op);
        }

        const statusClass = p.status === 'connected' ? 'active' : 'inactive';
        const statusText = p.status === 'connected' ? 'Connected' : 'Disconnected';

        // Status element
        const status = document.createElement('span');
        status.className = `d-status ${statusClass}`;
        status.textContent = statusText;

        row.appendChild(name);

        if (hostConn) {
            // Guest view: status only
            row.appendChild(status);
        } else {
            // Host view: operator toggle + status
            const right = document.createElement('div');
            right.style.cssText = 'display:flex; gap:4px; align-items:center;';

            if (!p.isHost && p.status === 'connected') {
                const opBtn = document.createElement('button');
                opBtn.className = `btn-action ${p.isOp ? 'active' : ''}`;
                opBtn.dataset.opPeer = (p.id || '').toString();
                opBtn.style.cssText = `font-size:10px; padding:4px 8px; margin-right:8px; ${p.isOp ? 'background:var(--primary); color:white; border:none;' : ''}`;
                opBtn.textContent = p.isOp ? 'REVOKE' : 'GRANT';
                opBtn.setAttribute('aria-label', p.isOp ? 'OP 권한 회수' : 'OP 권한 부여');

                opBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const peerId = opBtn.dataset.opPeer;
                    if (peerId) window.toggleOperator(peerId);
                });

                right.appendChild(opBtn);
            }

            right.appendChild(status);
            row.appendChild(right);
        }

        container.appendChild(row);
    });
}

window.toggleOperator = function (peerId) {
    const p = connectedPeers.find(x => x.id === peerId);
    if (p) {
        p.isOp = !p.isOp;
        p.conn.send({ type: p.isOp ? 'operator-grant' : 'operator-revoke' });
        broadcastDeviceList(); // Already calls renderDeviceList internally
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
        broadcast({ type: MSG.PLAY, time: data.time, index: currentTrackIndex });
    } else if (data.type === MSG.REQUEST_PAUSE) {
        if (managedTimers.autoPlayTimer) {
            clearManagedTimer('autoPlayTimer');
        }
        pause();
        broadcast({ type: MSG.PAUSE, time: pausedAt });
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

        if (currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_AUDIO) {
            play(data.time);
            broadcast({ type: MSG.PLAY, time: data.time, index: currentTrackIndex });
        } else {
            pausedAt = data.time;
            if (videoElement) videoElement.currentTime = data.time;
            broadcast({ type: MSG.PAUSE, time: data.time });
        }
    } else if (data.type === MSG.REQUEST_EQ_RESET) {
        resetEQ();
    } else if (data.type === MSG.REQUEST_REVERB_RESET) {
        resetReverb();
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
        else if (data.settingType === MSG.REPEAT_MODE) { setRepeatMode(data.value); broadcast({ type: MSG.REPEAT_MODE, value: data.value }); }
        else if (data.settingType === MSG.SHUFFLE_MODE) { setShuffle(data.value); broadcast({ type: MSG.SHUFFLE_MODE, value: data.value }); }
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
    // Guard: Prevent overlapping recovery requests
    if (_recoveryPending) {
        log.debug('[Recovery] Request already pending, skipping');
        return;
    }

    // Check retry limit
    if (_recoveryRetryCount >= MAX_RECOVERY_RETRIES) {
        log.error(`[Recovery] Max retries (${MAX_RECOVERY_RETRIES}) exceeded. Giving up.`);
        showToast("파일 수신 실패. 다시 시도하려면 곡을 다시 선택해 주세요.");
        clearManagedTimer('chunkWatchdog');
        transferState = TRANSFER_STATE.IDLE;
        showLoader(false);
        _recoveryPending = false;
        _recoveryRetryCount = 0;
        return;
    }

    // Verify connection health
    const targetConn = (upstreamDataConn && upstreamDataConn.open) ? upstreamDataConn : hostConn;
    if (!targetConn || !targetConn.open) {
        log.warn('[Recovery] No healthy connection for recovery');
        return;
    }

    const fileName = (meta && meta.name) ? meta.name : (window._pendingFileName || '');
    const index = _pendingFileIndex !== undefined ? _pendingFileIndex : currentTrackIndex;
    const currentSid = localTransferSessionId || currentTransferSessionId;

    let chunkToAsk = forceChunk;
    if (chunkToAsk === null) {
        chunkToAsk = receivedCount || 0;
    }

    // Progressive backoff
    const backoffMs = RECOVERY_BACKOFF[Math.min(_recoveryRetryCount, RECOVERY_BACKOFF.length - 1)];
    _recoveryRetryCount++;
    _recoveryPending = true;

    const sourceLabel = targetConn === upstreamDataConn ? "Relay" : "Host";
    log.debug(`[Recovery] Attempt ${_recoveryRetryCount}/${MAX_RECOVERY_RETRIES} from ${sourceLabel}: ${fileName} (Chunk: ${chunkToAsk}, backoff: ${backoffMs}ms)`);

    setTimeout(() => {
        _recoveryPending = false;

        // Re-check connection after backoff
        if (!targetConn.open) {
            log.warn('[Recovery] Connection closed during backoff');
            return;
        }
        // Re-check meta freshness: abort if track changed during backoff
        const latestName = (meta && meta.name) ? meta.name : (window._pendingFileName || '');
        if (latestName && fileName && latestName !== fileName) {
            log.debug('[Recovery] Track changed during backoff, aborting stale recovery');
            _recoveryRetryCount = 0;
            return;
        }

        targetConn.send({
            type: MSG.REQUEST_DATA_RECOVERY,
            nextChunk: chunkToAsk,
            fileName: fileName,
            index: index,
            sessionId: currentSid
        });
    }, backoffMs);
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

    // Per-peer send queue init (edge-cases):
    // - Avoid Array.shift() O(n) behavior on large queues
    // - Ensure queue exists even if total===0 (empty file)
    const ensurePeerSendQueue = (p) => {
        if (!p || p.openSender) return;
        p.openSender = true;
        p.chunkQueue = [];
        p._chunkQueueHead = 0;
        p.isSending = false;

        p.processQueue = async () => {
            // Fast exit
            if (p.isSending) return;
            if (!p.chunkQueue || p._chunkQueueHead >= p.chunkQueue.length) return;
            p.isSending = true;
            try {
                while (p.chunkQueue && p._chunkQueueHead < p.chunkQueue.length) {
                    const msg = p.chunkQueue[p._chunkQueueHead++];

                    // Per-peer backpressure check
                    while (p.conn?.dataChannel && p.conn.dataChannel.bufferedAmount > 512 * 1024) {
                        await new Promise(r => setTimeout(r, DELAY.BACKPRESSURE));
                        if (!p.conn?.open) break;
                    }

                    if (p.conn?.open) {
                        try { p.conn.send(msg); } catch (e) { log.warn(`[Send] Failed for ${p.label}:`, e); }
                    } else {
                        // Connection closed: drop queue
                        p.chunkQueue = [];
                        p._chunkQueueHead = 0;
                        break;
                    }

                    // Periodic compaction to prevent unbounded memory growth
                    if (p._chunkQueueHead > 1024) {
                        p.chunkQueue = p.chunkQueue.slice(p._chunkQueueHead);
                        p._chunkQueueHead = 0;
                    }
                }
            } finally {
                p.isSending = false;
                // If new items arrived while sending, kick once more.
                if (p.chunkQueue && p._chunkQueueHead < p.chunkQueue.length) {
                    try { p.processQueue(); } catch (_) { /* noop */ }
                }
            }
        };
    };

    eligiblePeers.forEach(ensurePeerSendQueue);

    // Send header (best-effort)
    eligiblePeers.forEach(p => {
        try { if (p?.conn?.open) p.conn.send(header); } catch (e) { log.warn('[broadcastFile] header send failed:', e); }
    });

    for (let i = 0; i < total; i++) {
        // Session Guard: abort if track changed
        if (_activeBroadcastSession !== sessionId) {
            log.debug(`[broadcastFile] Session cancelled (ID: ${sessionId}), stopping transfer at chunk ${i}`);
            eligiblePeers.forEach(p => {
                if (p.chunkQueue) p.chunkQueue = [];
                p._chunkQueueHead = 0;
                p.isSending = false;
            });
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
            ensurePeerSendQueue(p);
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
        ensurePeerSendQueue(p);
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
        if (txt && loadingText) loadingText.innerText = i18nTranslate(txt);
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
    // Harden: toast can be called very early (or in embedded contexts where the DOM differs).
    // Never throw from UI notifications.
    try {
        const t = document.getElementById('toast');
        const msgEl = document.getElementById('toast-msg');
        const text = (msg === undefined || msg === null) ? '' : String(msg);

        if (!t || !msgEl) {
            console.info('[Toast]', text);
            return;
        }

        msgEl.innerText = i18nTranslate(text);
        t.classList.add('show');

        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            try { t.classList.remove('show'); } catch (_) { /* noop */ }
        }, 2000);
    } catch (e) {
        // Last resort fallback
        console.info('[Toast fallback]', msg);
    }
}

// Non-blocking dialog (replaces alert())
// - Promise-based
// - Queued (prevents lost resolves when called multiple times)
// - Cleans up listeners on close (iOS Safari 호환: AbortSignal 옵션 미사용)
// - Restores focus for accessibility
let _dialogActive = null;
const _dialogQueue = [];

function drainDialogQueue() {
    if (_dialogActive) return;
    const next = _dialogQueue.shift();
    if (!next) return;
    _openDialog(next.opts, next.resolve);
}

function closeDialog(action = 'close') {
    const overlay = document.getElementById('dialog-overlay');
    if (overlay) {
        overlay.classList.remove('show');
        overlay.setAttribute('aria-hidden', 'true');
    }

    const active = _dialogActive;
    _dialogActive = null;

    // Cleanup listeners (best-effort)
    try {
        if (active && Array.isArray(active.cleanup)) {
            active.cleanup.forEach(fn => {
                try { fn(); } catch (_) { /* ignore */ }
            });
        }
    } catch (_) { /* ignore */ }

    // Restore focus
    if (active?.prevFocus && typeof active.prevFocus.focus === 'function') {
        try { active.prevFocus.focus(); } catch (_) { /* ignore */ }
    }

    // Resolve
    if (typeof active?.resolve === 'function') {
        try { active.resolve({ action }); } catch (_) { /* ignore */ }
    }

    // Drain queue (defer so the DOM has time to reflect the close state)
    setTimeout(drainDialogQueue, 0);
}

function _openDialog(opts, resolve) {
    const overlay = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const msgEl = document.getElementById('dialog-message');
    const okBtn = document.getElementById('btn-dialog-ok');
    const secondaryBtn = document.getElementById('btn-dialog-secondary');
    const closeBtn = document.getElementById('btn-dialog-close');

    if (!overlay || !titleEl || !msgEl || !okBtn || !closeBtn) {
        // Fallback: toast (never block)
        showToast(typeof opts === 'string' ? opts : (opts?.message || '안내'));
        resolve({ action: 'fallback' });
        // Continue queue immediately
        setTimeout(drainDialogQueue, 0);
        return;
    }

    const o = (typeof opts === 'object' && opts) ? opts : { message: String(opts ?? '') };
    const title = (typeof opts === 'string') ? '안내' : (o.title || '안내');
    const message = (typeof opts === 'string') ? String(opts ?? '') : String(o.message || '');
    const buttonText = o.buttonText ? String(o.buttonText) : '확인';
    // Optional secondary action ("Cancel" / "Stay")
    const secondaryTextRaw = (o.secondaryText !== undefined && o.secondaryText !== null)
        ? o.secondaryText
        : ((o.cancelText !== undefined && o.cancelText !== null) ? o.cancelText : '');
    const secondaryText = (secondaryTextRaw !== undefined && secondaryTextRaw !== null)
        ? String(secondaryTextRaw).trim()
        : '';
    const hasSecondary = !!secondaryText;
    const dismissible = (o.dismissible !== undefined) ? !!o.dismissible : true;
    const defaultFocus = (o.defaultFocus !== undefined && o.defaultFocus !== null)
        ? String(o.defaultFocus)
        : (hasSecondary ? 'secondary' : 'primary');

    // Set content safely (no HTML injection)
    titleEl.textContent = i18nTranslate(title);
    msgEl.textContent = i18nTranslate(message);
    okBtn.textContent = i18nTranslate(buttonText);

    // Secondary button (optional)
    if (secondaryBtn) {
        if (hasSecondary) {
            secondaryBtn.textContent = i18nTranslate(secondaryText);
            secondaryBtn.style.display = '';
        } else {
            secondaryBtn.style.display = 'none';
        }
    }

    // Track previous focus (a11y)
    const prevFocus = document.activeElement;

    // Show
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');

    const cleanup = [];
    const on = (target, type, handler, options) => {
        if (!target) return;
        target.addEventListener(type, handler, options);
        cleanup.push(() => {
            try { target.removeEventListener(type, handler, options); } catch (_) { /* ignore */ }
        });
    };

    _dialogActive = { resolve, prevFocus, cleanup };

    const done = (action) => closeDialog(action);

    // Click outside
    on(overlay, 'click', (e) => {
        if (!dismissible) return;
        if (e.target === overlay) done('overlay');
    });

    // Buttons
    on(okBtn, 'click', () => done('ok'));
    if (hasSecondary && secondaryBtn) {
        on(secondaryBtn, 'click', () => done('secondary'));
    }
    on(closeBtn, 'click', () => {
        if (!dismissible) return done('ok');
        done('close');
    });

    // Keyboard
    on(window, 'keydown', (e) => {
        if (e.key === 'Escape') {
            if (!dismissible) return;
            e.preventDefault();
            done('escape');
            return;
        }

        // Focus trap: loop between close / secondary / ok
        if (e.key === 'Tab') {
            const focusables = [
                closeBtn,
                (hasSecondary ? secondaryBtn : null),
                okBtn
            ].filter((x) => x && x.offsetParent !== null);
            if (focusables.length === 0) return;

            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const activeEl = document.activeElement;

            if (e.shiftKey) {
                if (activeEl === first || !overlay.contains(activeEl)) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (activeEl === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        }
    });

    // Focus default action
    setTimeout(() => {
        try {
            const pick = (defaultFocus === 'secondary' && hasSecondary && secondaryBtn)
                ? secondaryBtn
                : (defaultFocus === 'close' ? closeBtn : okBtn);
            (pick || okBtn).focus();
        } catch (_) { /* ignore */ }
    }, 0);
}

function showDialog(opts = {}) {
    return new Promise((resolve) => {
        // Queue calls so we never lose a resolver
        _dialogQueue.push({ opts, resolve });
        drainDialogQueue();
    });
}

// Header logo: confirm before leaving an active session
let _logoNavBusy = false;
async function handleLogoReturnToMain() {
    if (_logoNavBusy) return;
    _logoNavBusy = true;

    try {
        const setupOverlay = document.getElementById('setup-overlay');
        const isOnMain = !!(setupOverlay && setupOverlay.classList.contains('active'));

        // If the setup overlay is already visible, just make sure we're on the Play tab.
        if (isOnMain) {
            try { switchTab('play'); } catch (_) { /* noop */ }
            return;
        }

        const isInSession = !!hostConn || !!peer || appRole === 'host' || appRole === 'guest' || !!sessionCode || !!lastJoinCode || !!sessionStarted;
        if (!isInSession) {
            // Defensive: if UI is somehow on main app without a session, reset to setup.
            initSetupOverlay();
            return;
        }

        const r = await showDialog({
            title: '초기 화면으로 돌아갈까요?',
            message: '현재 세션과 연결이 끊어져요.',
            buttonText: '초기 화면',
            secondaryText: '남아있기',
            defaultFocus: 'secondary',
            dismissible: true,
        });

        if (r && r.action === 'ok') {
            await leaveSession();
        }
    } catch (e) {
        log.warn('[UI] Logo navigation failed:', e?.message || e);
    } finally {
        _logoNavBusy = false;
    }
}

async function copyTextToClipboard(text) {
    // Modern async clipboard API (HTTPS required)
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) {
        // fall through to legacy fallback
        log.debug('[Clipboard] navigator.clipboard failed, trying fallback:', e?.message || e);
    }

    // Legacy fallback (some iOS/Safari contexts)
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return !!ok;
    } catch (e) {
        log.warn('[Clipboard] Fallback copy failed:', e?.message || e);
        return false;
    }
}

// copyLink removed (Toss in-app: external links are not allowed)

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
    if (!video || !wrapper) return;

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
        // (If currentTrackIndex is -1, it means we are just starting, so we allow it)
        if (expectedIndex !== undefined && currentTrackIndex !== -1 && currentTrackIndex !== targetIndex) {
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
        if (expectedIndex !== undefined && currentTrackIndex !== -1 && currentTrackIndex !== targetIndex) {
            log.warn(`[Preload] Track changed during decode. Expected ${targetIndex}, now ${currentTrackIndex}. Discarding.`);
            return;
        }

        // Capture expected meta for cleanup/verification (favor localMeta but fallback)
        const activeMeta = localMeta || meta;

        // Only now update global state
        currentFileBlob = localBlob;
        meta = activeMeta;
        currentAudioBuffer = audioBuffer;
        log.debug(`[BufferMode] Preloaded ${audioBuffer.duration.toFixed(2)}s decoded.`);

        // Proper mode based on file type (video shows video UI, audio shows visualizer)
        const isVideo = isMediaVideo(localBlob, activeMeta);
        setEngineMode(isVideo ? 'video' : 'buffer');

        // Visual Sync
        const url = BlobURLManager.create(localBlob);
        videoElement.src = url;
        videoElement.muted = true;

        // Set UI immediately based on buffer
        const dur = currentAudioBuffer.duration;
        if (isFinite(dur)) {
            const seekSlider = document.getElementById('seek-slider');
            if (seekSlider) seekSlider.max = dur;

            const slideSlider = document.getElementById('slide-slider');
            if (slideSlider) slideSlider.max = dur;

            const timeDur = document.getElementById('time-dur');
            if (timeDur) timeDur.innerText = fmtTime(dur);
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

        // Ensure transfer guards are reset
        _skipIncomingFile = true;
        _waitingForPreload = false;
        clearManagedTimer('prepareWatchdog');
        clearManagedTimer('chunkWatchdog');
        clearManagedTimer('preloadWatchdog');

        // [Enhanced Sync] Request fresh sync time from host to ensure playback matches precisely
        setTimeout(() => {
            if (hostConn && hostConn.open) {
                hostConn.send({ type: MSG.GET_SYNC_TIME });
            }
        }, 500);

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
        // Allow fallback download if preload activation failed (avoid getting stuck skipping incoming transfer)
        _skipIncomingFile = false;
        _waitingForPreload = false;
        clearManagedTimer('preloadWatchdog');
        const _recoveryName = (playlist && playlist[currentTrackIndex] && playlist[currentTrackIndex].name) ? playlist[currentTrackIndex].name : (meta ? meta.name : '');
        if (hostConn && hostConn.open) {
            hostConn.send({ type: MSG.REQUEST_CURRENT_FILE, name: _recoveryName, index: currentTrackIndex, reason: 'preload_activation_failed' });
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
    // Help modal has been replaced by the bottom "? guide" tab.
    switchTab('guide');
}


let myChatLabel = 'Host';

// Chat sender label rules:
// - Host shows as "Host"
// - Guests show as Host-assigned "Peer N" (myDeviceLabel)
// - Never use role labels (Original/Left/Right/Woofer) as the device name.
function _getChatLabelBase() {
    if (!hostConn) return 'Host';

    const label = (myDeviceLabel && String(myDeviceLabel).trim()) ? String(myDeviceLabel).trim() : '';

    // Guard against placeholders / legacy values
    if (!label || label === 'HOST' || label === 'Guest' || label === '참가자') return PEER_NAME_PREFIX;

    // Guard against accidentally using role labels as the device name
    const role0 = getRoleLabelByChannelMode(0);
    const roleL = getRoleLabelByChannelMode(-1);
    const roleR = getRoleLabelByChannelMode(1);
    const roleS = getRoleLabelByChannelMode(2);
    if (label === role0 || label === roleL || label === roleR || label === roleS) return PEER_NAME_PREFIX;

    return label;
}

function _formatChatDisplayName(label, roleLabel) {
    // Chat sender 표시: 역할(Original/Left/Right/Surround 등)은 숨기고 이름(Host/Peer N)만 보여줍니다.
    const l = (label && String(label).trim()) ? String(label).trim() : PEER_NAME_PREFIX;
    return l;
}


function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();

    if (!text) return;

    const senderLabel = _getChatLabelBase();
    const senderRole = getRoleLabelByChannelMode(channelMode);
    const displayName = _formatChatDisplayName(senderLabel, senderRole);

    myChatLabel = senderLabel;

    addChatMessage(displayName, text, true);

    // sender: backward-compatible field (older clients only understand sender+text)
    const chatMsg = {
        type: MSG.CHAT,
        senderId: myId,
        sender: senderLabel,
        senderLabel: senderLabel,
        senderRole: senderRole,
        text: text,
        ts: Date.now(),
    };

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

        const group = document.createElement('div');
        group.className = `chat-group ${isMine ? 'mine' : 'others'}`;

        if (!isMine) {
            const senderNode = document.createElement('div');
            senderNode.className = 'chat-sender';
            senderNode.innerText = sender;
            group.appendChild(senderNode);
        }

        const row = document.createElement('div');
        row.className = 'chat-row';

        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${isMine ? 'mine' : 'others'}`;
        bubble.innerHTML = `<div class="chat-text">${parseMessageContent(text)}</div>`;

        // Fallback for browsers without :has(): mark bubbles that contain a YouTube button
        try {
            if (bubble.querySelector('.chat-youtube-btn')) bubble.classList.add('has-youtube');
        } catch (_) { /* ignore */ }

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

        group.appendChild(row);
        container.appendChild(group);
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

// HTML 특수문자 이스케이핑 (innerHTML 사용 시 XSS/마크업 깨짐 방지)
// - & < > " ' 를 이스케이프
// - null/undefined는 빈 문자열 처리
const _ESCAPE_HTML_RE = /[&<>"']/;
const _ESCAPE_HTML_RE_G = /[&<>"']/g;
const _ESCAPE_HTML_MAP = Object.freeze({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
});

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (!_ESCAPE_HTML_RE.test(str)) return str;
    return str.replace(_ESCAPE_HTML_RE_G, (ch) => _ESCAPE_HTML_MAP[ch] || ch);
}

// escapeAttr delegates to escapeHtml (same character set: & < > " ')
const escapeAttr = escapeHtml;

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

        // NOTE: ytRegex has the global flag; always reset lastIndex before test()
        ytRegex.lastIndex = 0;
        if (ytRegex.test(matchedText)) {
            const cleanUrl = matchedText.startsWith('http') ? matchedText : 'https://' + matchedText;
            const uniqueId = 'yt-' + Math.random().toString(36).substr(2, 9);

            result += `
                <button type="button" class="chat-youtube-btn" data-youtube-url="${escapeAttr(cleanUrl)}" aria-label="YouTube 링크 열기" aria-describedby="${uniqueId}">
                    <div class="chat-yt-play-row">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/></svg>
                        YouTube
                    </div>
                    <div id="${uniqueId}" class="chat-yt-title">${escapeHtml(matchedText)}</div>
                </button>
            `;

            // Async title fetch
            setTimeout(() => updateYouTubeChatTitle(uniqueId, cleanUrl), 100);
        }
        else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(matchedText)) {
            const seconds = parseTimestamp(matchedText);
            result += `<span class="chat-timestamp" role="button" tabindex="0" data-seek="${seconds}">${escapeHtml(matchedText)}</span>`;
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

// Event delegation for timestamp seeking (replaces inline onclick)
document.addEventListener('click', (e) => {
    const target = (e.target && e.target.closest) ? e.target : (e.target && e.target.parentElement);
    const ts = target ? target.closest('.chat-timestamp[data-seek]') : null;
    if (!ts) return;
    const sec = Number(ts.getAttribute('data-seek'));
    if (Number.isFinite(sec)) seekToTime(sec);
});

document.addEventListener('keydown', (e) => {
    // Allow keyboard activation (Enter/Space) for timestamp spans
    const ts = e.target && e.target.closest ? e.target.closest('.chat-timestamp[data-seek]') : null;
    if (!ts) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    const sec = Number(ts.getAttribute('data-seek'));
    if (Number.isFinite(sec)) seekToTime(sec);
});

// YouTube oEmbed title cache to avoid repeated network calls (chat can contain duplicate URLs)
const _ytOEmbedTitleCache = new Map(); // url -> title
const _ytOEmbedInFlight = new Map();  // url -> Promise<title|null>
const _YT_OEMBED_CACHE_MAX = 200;

async function _fetchYouTubeOEmbedTitle(url) {
    const key = String(url || '');
    if (!key) return null;

    if (_ytOEmbedTitleCache.has(key)) return _ytOEmbedTitleCache.get(key);
    if (_ytOEmbedInFlight.has(key)) return await _ytOEmbedInFlight.get(key);

    const p = (async () => {
        try {
            const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(key)}&format=json`;
            const response = await fetch(oEmbedUrl);
            if (!response.ok) return null;
            const data = await response.json();
            const title = (data && typeof data.title === 'string') ? data.title.trim() : '';
            return title || null;
        } catch (e) {
            return null;
        }
    })();

    _ytOEmbedInFlight.set(key, p);

    try {
        const title = await p;
        if (title) {
            _ytOEmbedTitleCache.set(key, title);
            // LRU-ish cap (Map preserves insertion order)
            while (_ytOEmbedTitleCache.size > _YT_OEMBED_CACHE_MAX) {
                const firstKey = _ytOEmbedTitleCache.keys().next().value;
                _ytOEmbedTitleCache.delete(firstKey);
            }
        }
        return title;
    } finally {
        _ytOEmbedInFlight.delete(key);
    }
}

/**
 * YouTube oEmbed API를 사용하여 영상 제목을 가져와 업데이트합니다.
 */
async function updateYouTubeChatTitle(elementId, url) {
    const el = document.getElementById(elementId);
    if (!el) return;

    try {
        const title = await _fetchYouTubeOEmbedTitle(url);
        if (title) el.innerText = title;
    } catch (e) {
        // Should be rare: helper already swallows most errors
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
    const t = Number(seconds);
    if (!Number.isFinite(t) || t < 0) {
        showToast("유효하지 않은 시간입니다");
        return;
    }

    // Guest (non-OP): blocked
    if (hostConn && !isOperator) {
        showToast("Host만 실행할 수 있습니다.");
        return;
    }

    // OP: request Host to seek
    if (hostConn && isOperator) {
        try {
            hostConn.send({ type: MSG.REQUEST_SEEK, time: t });
        } catch (e) {
            log.warn('[Chat Seek] OP seek request failed:', e);
        }
        return;
    }

    // Host: execute directly
    // YouTube mode: use YouTube API (and broadcast to guests)
    if (currentState === APP_STATE.PLAYING_YOUTUBE && youtubePlayer && youtubePlayer.seekTo) {
        try {
            youtubePlayer.seekTo(t, true);
            broadcast({
                type: MSG.YOUTUBE_STATE,
                state: youtubePlayer.getPlayerState ? youtubePlayer.getPlayerState() : 1,
                time: t,
                subIndex: youtubePlayer.getPlaylistIndex ? youtubePlayer.getPlaylistIndex() : -1
            });
            showToast(`${fmtTime(t)}로 이동`);
        } catch (e) {
            log.error("[YouTube] Chat timestamp seek error:", e);
            showToast("YouTube 이동 실패");
        }
        return;
    }

    const isActuallyPlaying = (videoElement && !videoElement.paused);

    if (isActuallyPlaying) {
        play(t);
        broadcast({ type: MSG.PLAY, time: t, index: currentTrackIndex });
    } else {
        pausedAt = t;
        if (currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_AUDIO) {
            if (videoElement) videoElement.currentTime = t;
        }
        // Broadcast pause with updated time to sync guests without starting playback
        broadcast({ type: MSG.PAUSE, time: t });
    }

    // Schedule global resync after seek (Host only)
    setTimeout(() => {
        broadcast({ type: MSG.GLOBAL_RESYNC_REQUEST });
        log.debug("[Host] Global resync requested after seek (chat timestamp)");
    }, 1000);

    showToast(`${fmtTime(t)}로 이동`);
}


function loadYouTubeFromChat(url) {
    if (hostConn) {
        showToast('방장만 유튜브 링크를 추가할 수 있어요.');
        return;
    }

    const videoId = extractYouTubeVideoId(url);
    const playlistId = extractYouTubePlaylistId(url);

    if (!videoId && !playlistId) {
        showToast("유효하지 않은 YouTube 링크");
        return;
    }

    if (isChatDrawerOpen) {
        toggleChatDrawer();
    }

    const newItem = {
        type: 'youtube',
        videoId: videoId,
        playlistId: playlistId,
        title: 'YouTube Video',
        name: 'YouTube Video'
    };
    playlist.push(newItem);

    updatePlaylistUI();

    broadcast({ type: MSG.PLAYLIST_UPDATE, list: buildPlaylistMetaList() });

    playTrack(playlist.length - 1);
    showToast("YouTube 재생 시작");

    // Fetch real title in background and update immediately upon arrive
    _fetchYouTubeOEmbedTitle(url).then(fetchedTitle => {
        if (fetchedTitle) {
            newItem.title = fetchedTitle;
            newItem.name = fetchedTitle;
            updatePlaylistUI();

            // If it's currently playing this track, update the UI header
            if (currentTrackIndex === playlist.indexOf(newItem)) {
                updateTrackInfoDisplay();
            }
            // Broadcast the updated title to guests
            broadcast({ type: MSG.PLAYLIST_UPDATE, list: buildPlaylistMetaList() });
        }
    }).catch(e => log.warn('Chat YT title fetch err:', e));
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

    // Invite code copy (multiple containers)
    document.addEventListener('click', (e) => {
        const container = e.target.closest('.invite-code-container');
        if (container) {
            copyInviteCode();
        }
    });

    // Event delegation for YouTube chat buttons (replaces inline onclick)
    document.addEventListener('click', (e) => {
        const target = (e.target && e.target.closest) ? e.target : (e.target && e.target.parentElement);
        const ytBtn = target ? target.closest('.chat-youtube-btn[data-youtube-url]') : null;
        if (ytBtn) {
            const url = ytBtn.getAttribute('data-youtube-url');
            if (url) loadYouTubeFromChat(url);
        }
    });
});

window.addEventListener('keydown', (e) => {
    // If another handler already claimed this key, don't also treat it as a global shortcut.
    if (e.defaultPrevented) return;

    const activeTag = document.activeElement && document.activeElement.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) return;

    // Don't hijack Space when the user is focused on an interactive control (buttons/links/etc).
    // (Important for accessibility: Space should activate focused buttons.)
    const interactive = (e.target && e.target.closest)
        ? e.target.closest('button, a, [role="button"], input, textarea, select, [contenteditable="true"]')
        : null;
    if ((e.key === ' ' || e.code === 'Space') && interactive) return;

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
    // Host-only (guests are not allowed to add media)
    if (hostConn) {
        showToast('방장만 미디어를 추가할 수 있어요.');
        return;
    }

    animateTransition(() => {
        const ov = document.getElementById('media-source-overlay');
        if (ov) ov.classList.add('active');
        updateOverlayOpenClass();
    });
}

function closeMediaSourcePopup() {
    animateTransition(() => {
        const ov = document.getElementById('media-source-overlay');
        if (ov) ov.classList.remove('active');
        updateOverlayOpenClass();
    });
}

function openYouTubePopup() {
    // Host-only
    if (hostConn) {
        showToast('방장만 유튜브 링크를 추가할 수 있어요.');
        return;
    }

    animateTransition(() => {
        const ov = document.getElementById('youtube-url-overlay');
        if (ov) ov.classList.add('active');
        updateOverlayOpenClass();

        // auto-focus
        const urlInput = document.getElementById('youtube-url-input');
        if (urlInput) urlInput.focus();
    });
}


function closeYouTubePopup() {
    animateTransition(() => {
        const ov = document.getElementById('youtube-url-overlay');
        if (ov) ov.classList.remove('active');
        updateOverlayOpenClass();
    });
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
    // Host-only
    if (hostConn) {
        showToast('방장만 유튜브 링크를 추가할 수 있어요.');
        return;
    }

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

    broadcast({ type: MSG.PLAYLIST_UPDATE, list: buildPlaylistMetaList() });

    closeYouTubePopup();

    document.getElementById('youtube-url-input').value = '';
    document.getElementById('youtube-preview').style.display = 'none';
    document.getElementById('youtube-preview-status').style.display = 'block';
    document.getElementById('youtube-preview-status').innerText = '동영상 또는 플레이리스트 링크를 입력하세요';
    document.getElementById('youtube-play-btn').disabled = true;
    document.getElementById('youtube-play-btn').style.opacity = '0.5';

    if (wasEmpty) {
        clearPreviousTrackState('youtube-load');
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

        if (IS_IOS && (state === 5 || state === -1)) {
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

    if (managedTimers.youtubeUILoop) { clearInterval(managedTimers.youtubeUILoop); managedTimers.youtubeUILoop = null; }
    if (managedTimers.youtubeSyncLoop) { clearInterval(managedTimers.youtubeSyncLoop); managedTimers.youtubeSyncLoop = null; }

    if (_ytLoadTimeout) {
        clearTimeout(_ytLoadTimeout);
        _ytLoadTimeout = null;
    }

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

    const DEMO_FILE_NAME = "demo_track.mp3";
    const DEMO_TITLE = "Sean Pitaro - Passport (NCS Release)";

    try {
        showLoader(true, "데모 음원 로딩 중...");
        updateLoader(0);

        const blob = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', DEMO_FILE_NAME, true);
            xhr.responseType = 'blob';

            xhr.onprogress = (event) => {
                if (event.lengthComputable) {
                    const percent = Math.round((event.loaded / event.total) * 100);
                    updateLoader(percent);
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.response);
                } else {
                    reject(new Error(`HTTP Error ${xhr.status}`));
                }
            };

            xhr.onerror = () => reject(new Error("Network Error"));
            xhr.send();
        });
        const file = new File([blob], DEMO_FILE_NAME, { type: 'audio/mpeg' });

        // Append to playlist
        const newTrack = {
            type: 'audio',
            file: file,
            name: file.name,
            title: DEMO_TITLE
        };
        playlist.push(newTrack);

        // Update UI
        updatePlaylistUI();

        // Broadcast playlist update to guests
        broadcast({ type: MSG.PLAYLIST_UPDATE, list: buildPlaylistMetaList() });

        showToast("데모 음원 로드 완료. 재생을 시작합니다.");

        // Use standard playTrack flow (handles broadcastFile, UI, guest sync)
        playTrack(playlist.length - 1);

    } catch (e) {
        log.error("Demo load failed:", e);
        showToast("데모 로드 실패: " + e.message);
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
// [SECTION] WINDOW EXPORTS (Public API for HTML/UI)
// ============================================================================
window.openHelpModal = openHelpModal;
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
window.parseMessageContent = parseMessageContent;
window.seekToTime = seekToTime;
window.loadYouTubeFromChat = loadYouTubeFromChat;
window.copyInviteCode = copyInviteCode;
window.insertEmoji = insertEmoji;

// Utilities
window.showDialog = showDialog;

// End of Script