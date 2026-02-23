import { log } from './log.js';
import { IS_IOS, IS_ANDROID, isStandaloneDisplayMode } from './platform.js';

let _appHeightRaf = 0;
let _lastSoftKeyHeight = 0;

export function updateAppHeightNow() {
    const root = document.documentElement;

    // CSS targeting hooks
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

    // Collect all available height signals
    let validHeights = [];
    if (vv && Number.isFinite(vv.height) && vv.height > 0) validHeights.push(Math.round(vv.height));
    if (Number.isFinite(window.innerHeight) && window.innerHeight > 0) validHeights.push(Math.round(window.innerHeight));
    if (de && Number.isFinite(de.clientHeight) && de.clientHeight > 0) validHeights.push(Math.round(de.clientHeight));

    let h = validHeights.length > 0 ? Math.min(...validHeights) : 0;

    // Android: Detect if viewport extends behind system bar
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

        // Strategy 2: screen.availHeight deltas
        if (softKeyHeight === 0 && scr.availHeight != null && scr.availWidth != null) {
            const dH = Math.round((scr.height || 0) - (scr.availHeight || 0));
            if (dH > 0 && dH < 150) {
                softKeyHeight = dH;
            }
        }

        // Strategy 3: Hardcoded 48dp fallback
        if (softKeyHeight === 0) {
            const scrDimH = Math.min(scr.height || Infinity, scr.width || Infinity);
            if (Number.isFinite(scrDimH) && scrDimH > 100) {
                if (Math.abs(h - scrDimH) < 4) {
                    softKeyHeight = 48;
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
        _lastSoftKeyHeight = 0;
    }

    // iOS standalone fix
    if (IS_IOS && isStandalone && !isLandscape && window.screen &&
        Number.isFinite(window.screen.height) && window.screen.height > 0) {
        h = Math.max(h, Math.round(window.screen.height));
    }

    // Apply CSS variables
    if (h > 0) {
        try { root.style.setProperty('--app-height', `${h}px`); } catch (_) { /* ignore */ }
    }

    // --safe-nav-bottom: pushes fixed bottom elements above the system nav bar
    const navBottom = (IS_ANDROID && isLandscape && softKeyHeight > 0) ? softKeyHeight : 0;
    try { root.style.setProperty('--safe-nav-bottom', `${navBottom}px`); } catch (_) { /* ignore */ }
}

export function scheduleAppHeightUpdate() {
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
export function freezeLayoutMetricsOnce() { scheduleAppHeightUpdate(); }

// Auto-initialize
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
        window.addEventListener('resize', scheduleAppHeightUpdate, { passive: true });
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
