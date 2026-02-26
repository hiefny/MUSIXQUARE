/**
 * MUSIXQUARE 2.0 — Platform Detection & Viewport Management
 * Extracted from original app.js lines 54-264
 */

import { log } from './log.ts';

// ─── Platform Detection ────────────────────────────────────────────

export const IS_IOS: boolean =
  (/iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as unknown as Record<string, unknown>).MSStream) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const IS_ANDROID: boolean = /Android/i.test(navigator.userAgent);

export function isStandaloneDisplayMode(): boolean {
  try {
    if ((navigator as unknown as Record<string, unknown>).standalone) return true;
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch {
    /* ignore */
  }
  return false;
}

// ─── iOS Pinch-Zoom Prevention ─────────────────────────────────────

export function preventIOSPinchZoom(): void {
  if (!IS_IOS) return;
  for (const evt of ['gesturestart', 'gesturechange', 'gestureend'] as const) {
    document.addEventListener(evt, (e) => e.preventDefault(), { passive: false });
  }
}

// ─── Viewport Height Management ────────────────────────────────────

let _appHeightRaf = 0;
let _lastSoftKeyHeight = 0;
let _platformClassesApplied = false;

function updateAppHeightNow(): void {
  const root = document.documentElement;

  // Platform CSS hooks (one-time)
  if (!_platformClassesApplied) {
    try {
      if (IS_IOS) root.classList.add('ios');
      if (IS_ANDROID) root.classList.add('android');
      if (IS_IOS && isStandaloneDisplayMode()) root.classList.add('ios-standalone');
      if (isStandaloneDisplayMode()) root.classList.add('standalone');
    } catch {
      /* ignore */
    }
    _platformClassesApplied = true;
  }

  const vv = window.visualViewport;
  const isStandalone = isStandaloneDisplayMode();

  let isLandscape: boolean;
  try {
    isLandscape = !!window.matchMedia?.('(orientation: landscape)').matches;
  } catch {
    isLandscape = window.innerWidth > window.innerHeight;
  }

  // Collect all available height signals
  const validHeights: number[] = [];
  if (vv && Number.isFinite(vv.height) && vv.height > 0) validHeights.push(Math.round(vv.height));
  if (Number.isFinite(window.innerHeight) && window.innerHeight > 0) validHeights.push(Math.round(window.innerHeight));
  if (root && Number.isFinite(root.clientHeight) && root.clientHeight > 0) validHeights.push(Math.round(root.clientHeight));

  let h = validHeights.length > 0 ? Math.min(...validHeights) : 0;

  // Android: Detect if viewport extends behind system bar
  let softKeyHeight = 0;
  const scr = window.screen || ({} as Screen);

  if (IS_ANDROID && isLandscape) {
    // Strategy 1: outerHeight vs innerHeight
    if (Number.isFinite(window.outerHeight) && window.outerHeight > 0 &&
        Number.isFinite(window.innerHeight) && window.innerHeight > 0) {
      const delta = Math.round(window.outerHeight - window.innerHeight);
      if (delta < 0) softKeyHeight = Math.abs(delta);
    }

    // Strategy 2: screen.availHeight
    if (softKeyHeight === 0 && scr.availHeight != null && scr.availWidth != null) {
      const dH = Math.round((scr.height || 0) - (scr.availHeight || 0));
      if (dH > 0 && dH < 150) softKeyHeight = dH;
    }

    // Strategy 3: Hardcoded 48dp fallback
    if (softKeyHeight === 0) {
      const scrDimH = Math.min(scr.height || Infinity, scr.width || Infinity);
      if (Number.isFinite(scrDimH) && scrDimH > 100) {
        if (Math.abs(h - scrDimH) < 4) softKeyHeight = 48;
      }
    }

    // Clamp
    if (softKeyHeight > 120) softKeyHeight = 48;
    if (softKeyHeight < 0) softKeyHeight = 0;

    // Stability
    if (softKeyHeight > 0) {
      _lastSoftKeyHeight = softKeyHeight;
    } else if (_lastSoftKeyHeight > 0 && isLandscape) {
      softKeyHeight = _lastSoftKeyHeight;
    }

    if (softKeyHeight > 0 && h > softKeyHeight) {
      h -= softKeyHeight;
      log.info(`[Viewport] Android landscape softkey compensation: ${softKeyHeight}px`);
    }
  } else if (!isLandscape) {
    _lastSoftKeyHeight = 0;
  }

  // iOS: JS height signals (innerHeight, visualViewport) can exclude safe-area-inset
  // under viewport-fit=cover. Measure actual CSS viewport via a fixed-position probe.
  if (IS_IOS && !isLandscape) {
    try {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;top:0;bottom:0;left:0;width:0;visibility:hidden;pointer-events:none';
      document.body.appendChild(probe);
      const cssVh = probe.offsetHeight;
      document.body.removeChild(probe);
      if (cssVh > 0) h = Math.max(h, cssVh);
    } catch { /* ignore */ }
  }

  // Apply CSS variables
  if (h > 0) {
    try { root.style.setProperty('--app-height', `${h}px`); } catch { /* ignore */ }
  }

  // DEBUG: show viewport diagnostics on iOS standalone (remove after fixing)
  if (IS_IOS && isStandalone) {
    try {
      let dbg = document.getElementById('__dbg');
      if (!dbg) {
        dbg = document.createElement('div');
        dbg.id = '__dbg';
        dbg.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:red;color:white;font:11px/1.4 monospace;padding:4px 8px;pointer-events:none;white-space:pre';
        document.body.appendChild(dbg);
      }
      const safeB = getComputedStyle(root).getPropertyValue('--safe-bottom');
      const safeT = getComputedStyle(root).getPropertyValue('--safe-top');
      const bodyH = getComputedStyle(document.body).height;
      dbg.textContent = `ih:${window.innerHeight} vv:${Math.round(vv?.height||0)} root:${root.clientHeight} scr:${window.screen.height}\n--app-h:${h} body:${bodyH} safeT:${safeT} safeB:${safeB}\ncls: ${root.className}`;
    } catch { /* ignore */ }
  }

  const navBottom = (IS_ANDROID && isLandscape && softKeyHeight > 0) ? softKeyHeight : 0;
  try { root.style.setProperty('--safe-nav-bottom', `${navBottom}px`); } catch { /* ignore */ }
}

function scheduleAppHeightUpdate(): void {
  if (_appHeightRaf) return;
  try {
    _appHeightRaf = requestAnimationFrame(() => {
      _appHeightRaf = 0;
      try { updateAppHeightNow(); } catch { /* ignore */ }
    });
  } catch {
    _appHeightRaf = 0;
    try { updateAppHeightNow(); } catch { /* ignore */ }
  }
}

/**
 * Initialize platform detection and viewport height tracking.
 * Call once at app bootstrap.
 */
export function initPlatform(): void {
  preventIOSPinchZoom();

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
  } catch {
    /* ignore */
  }
}
