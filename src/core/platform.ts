/**
 * MUSIXQUARE — Platform Detection & Viewport Management
 */

import { log } from './log.ts';
import { setManagedTimer } from './timers.ts';

// ─── Platform Detection ────────────────────────────────────────────

export const IS_IOS: boolean =
  (/iPad|iPhone|iPod/.test(navigator.userAgent) &&
    !(window as unknown as Record<string, unknown>).MSStream) ||
  (((navigator as unknown as Record<string, { platform?: string }>).userAgentData?.platform ??
    navigator.platform ??
    '') === 'MacIntel' &&
    navigator.maxTouchPoints > 1);

export const IS_ANDROID: boolean = /Android/i.test(navigator.userAgent);

/** Desktop Chromium browser (Chrome, Edge, Opera, etc.) — supports getDisplayMedia with audio */
export const IS_DESKTOP_CHROMIUM: boolean =
  !IS_IOS && !IS_ANDROID && /Chrome\//.test(navigator.userAgent);

/** Runtime check for system audio capture support */
export function canCaptureSystemAudio(): boolean {
  return IS_DESKTOP_CHROMIUM && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

// ─── Layout Breakpoint Helpers ─────────────────────────────────────

const MQL_COMPACT = '(min-width: 720px) and (max-width: 1279px)';

/** Compact landscape: width 720px–1279px */
export function isCompactLandscape(): boolean {
  return window.matchMedia(MQL_COMPACT).matches;
}

/** Listen for compact landscape changes. Returns cleanup function. */
export function onCompactLandscapeChange(cb: () => void): () => void {
  const mql = window.matchMedia(MQL_COMPACT);
  mql.addEventListener('change', cb);
  return () => {
    mql.removeEventListener('change', cb);
  };
}

export function isStandaloneDisplayMode(): boolean {
  try {
    if ((navigator as unknown as Record<string, unknown>).standalone) return true;
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch (e) {
    log.debug('[Platform] standalone detection failed:', e);
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
let _iosViewportProbe: HTMLDivElement | null = null;
let _stableViewportHeight = 0;
let _keyboardFreezeUntil = 0;

function updateAppHeightNow(): void {
  const root = document.documentElement;

  // Platform CSS hooks (one-time)
  if (!_platformClassesApplied) {
    try {
      if (IS_IOS) root.classList.add('ios');
      if (IS_ANDROID) root.classList.add('android');
      if (IS_IOS && isStandaloneDisplayMode()) root.classList.add('ios-standalone');
      if (isStandaloneDisplayMode()) root.classList.add('standalone');
    } catch (e) {
      log.debug('[Platform] CSS class application failed:', e);
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
  if (Number.isFinite(window.innerHeight) && window.innerHeight > 0)
    validHeights.push(Math.round(window.innerHeight));
  if (root && Number.isFinite(root.clientHeight) && root.clientHeight > 0)
    validHeights.push(Math.round(root.clientHeight));

  let h = validHeights.length > 0 ? Math.min(...validHeights) : 0;

  // Android: Detect if viewport extends behind system bar
  let softKeyHeight = 0;
  const scr = window.screen || ({} as Screen);

  if (IS_ANDROID && isLandscape) {
    // Strategy 1: outerHeight vs innerHeight
    if (
      Number.isFinite(window.outerHeight) &&
      window.outerHeight > 0 &&
      Number.isFinite(window.innerHeight) &&
      window.innerHeight > 0
    ) {
      const delta = Math.round(window.outerHeight - window.innerHeight);
      if (delta < 0) softKeyHeight = Math.abs(delta);
    }

    // Strategy 2: screen.availHeight
    if (softKeyHeight === 0 && scr.availHeight != null && scr.availWidth != null) {
      const dH = Math.round((scr.height || 0) - (scr.availHeight || 0));
      if (dH > 0 && dH < 150) softKeyHeight = dH;
    }

    // Strategy 3: Hardcoded 48dp fallback
    // LIMITATION: Gesture-navigation devices (Android 10+) have 0dp navbar but
    // this heuristic cannot reliably detect gesture vs 3-button navigation.
    // CSS env(safe-area-inset-bottom) is preferred when available (handled in CSS).
    // This fallback only applies when the viewport height closely matches the
    // screen's shorter dimension, suggesting the viewport extends behind the navbar.
    if (softKeyHeight === 0) {
      // Skip heuristic when CSS safe-area-inset is supported — the browser
      // already provides accurate inset values for gesture navigation devices.
      const hasSafeArea = CSS.supports?.('padding-bottom: env(safe-area-inset-bottom)');
      if (!hasSafeArea) {
        const scrDimH = Math.min(scr.height || Infinity, scr.width || Infinity);
        if (Number.isFinite(scrDimH) && scrDimH > 100) {
          if (Math.abs(h - scrDimH) < 4) softKeyHeight = 48;
        }
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

  // iOS Safari (non-PWA): JS height signals can exclude safe-area-inset
  // under viewport-fit=cover. Measure actual CSS viewport via a fixed-position probe.
  // Probe element is cached to avoid createElement/appendChild/removeChild on every resize.
  if (IS_IOS && !isLandscape && !isStandalone) {
    try {
      if (!_iosViewportProbe && document.body) {
        _iosViewportProbe = document.createElement('div');
        _iosViewportProbe.style.cssText =
          'position:fixed;top:0;bottom:0;left:0;width:0;visibility:hidden;pointer-events:none';
        document.body.appendChild(_iosViewportProbe);
      }
      if (_iosViewportProbe) {
        const cssVh = _iosViewportProbe.offsetHeight;
        if (cssVh > 0) h = Math.max(h, cssVh);
      }
    } catch (e) {
      log.debug('[Platform] iOS viewport probe failed:', e);
    }
  }

  // ── Keyboard Detection (mobile only) ───────────────────────────
  // Detect soft keyboard via visualViewport shrink, BEFORE focus event fires.
  // Sets keyboard-open class and --keyboard-overlap CSS variable proactively.
  if ((IS_IOS || IS_ANDROID) && vv) {
    const kbVvH = Math.round(vv.height);
    const wasKbOpen = root.classList.contains('keyboard-open');

    // Track the stable (no-keyboard) viewport height
    if (!wasKbOpen) {
      _stableViewportHeight = Math.max(
        _stableViewportHeight,
        kbVvH,
        Math.round(window.innerHeight),
      );
    }

    // Keyboard detected when viewport shrinks >15% from stable height
    const kbShrink = _stableViewportHeight > 0 ? _stableViewportHeight - kbVvH : 0;
    const isKbOpen = _stableViewportHeight > 100 && kbShrink > _stableViewportHeight * 0.15;

    if (isKbOpen && !wasKbOpen) {
      root.classList.add('keyboard-open');
      // No need for a settle timer — --app-height stays frozen while keyboard-open is present
      log.debug(
        `[Platform] Keyboard opened — stable=${_stableViewportHeight} current=${kbVvH} shrink=${kbShrink}`,
      );
    } else if (!isKbOpen && wasKbOpen) {
      const active = document.activeElement;
      const stillFocused = active?.matches('input, textarea, [contenteditable="true"]');
      if (!stillFocused) {
        root.classList.remove('keyboard-open');
        // Brief freeze during close animation to prevent jitter
        _keyboardFreezeUntil = Date.now() + 350;
        setManagedTimer('kb-height-settle-close', scheduleAppHeightUpdate, 400);
        _stableViewportHeight = Math.max(kbVvH, Math.round(window.innerHeight));
        log.debug('[Platform] Keyboard closed');
      }
    }

    // Set keyboard overlap CSS variable
    const overlap = root.classList.contains('keyboard-open') ? Math.max(0, kbShrink) : 0;
    try {
      root.style.setProperty('--keyboard-overlap', `${overlap}px`);
    } catch (e) {
      log.debug('[Platform] --keyboard-overlap set failed:', e);
    }
  }

  // Freeze --app-height while keyboard is open (prevents the "pop" after animation)
  // AND briefly during close animation (prevents jitter as viewport expands back)
  const shouldFreezeAppHeight =
    (IS_IOS || IS_ANDROID) &&
    (root.classList.contains('keyboard-open') ||
      (_keyboardFreezeUntil > 0 && Date.now() < _keyboardFreezeUntil));

  // iOS PWA portrait: CSS units (100%, 100dvh) both exclude safe-area-inset-top
  // on iOS standalone. Use the largest available height signal and set html
  // element height directly. screen.height (hardware constant) is included as
  // a stable fallback — innerHeight / visualViewport.height can report shorter
  // values during cold-start before the viewport fully stabilises.
  if (IS_IOS && isStandalone && !isLandscape) {
    const ih = Number.isFinite(window.innerHeight) ? Math.round(window.innerHeight) : 0;
    const vvH = vv && Number.isFinite(vv.height) ? Math.round(vv.height) : 0;
    const scrH =
      window.screen && Number.isFinite(window.screen.height) && window.screen.height > 0
        ? Math.round(window.screen.height)
        : 0;
    const fullH = Math.max(ih, vvH, scrH);
    if (fullH > 0 && !shouldFreezeAppHeight) {
      try {
        root.style.height = `${fullH}px`;
        root.style.setProperty('--app-height', `${fullH}px`);
      } catch (e) {
        log.debug('[Platform] iOS standalone height set failed:', e);
      }
    }
  } else {
    // Clear any iOS standalone inline height override (e.g. after rotation)
    try {
      root.style.removeProperty('height');
    } catch (e) {
      log.debug('[Platform] removeProperty failed:', e);
    }
    if (h > 0 && !shouldFreezeAppHeight) {
      try {
        root.style.setProperty('--app-height', `${h}px`);
      } catch (e) {
        log.debug('[Platform] --app-height set failed:', e);
      }
    }
  }

  const navBottom = IS_ANDROID && isLandscape && softKeyHeight > 0 ? softKeyHeight : 0;
  try {
    root.style.setProperty('--safe-nav-bottom', `${navBottom}px`);
  } catch (e) {
    log.debug('[Platform] --safe-nav-bottom set failed:', e);
  }
}

function scheduleAppHeightUpdate(): void {
  if (_appHeightRaf) return;
  try {
    _appHeightRaf = requestAnimationFrame(() => {
      _appHeightRaf = 0;
      try {
        updateAppHeightNow();
      } catch (e) {
        log.debug('[Platform] updateAppHeightNow failed:', e);
      }
    });
  } catch (e) {
    _appHeightRaf = 0;
    log.debug('[Platform] rAF scheduling failed:', e);
    try {
      updateAppHeightNow();
    } catch (e2) {
      log.debug('[Platform] updateAppHeightNow fallback failed:', e2);
    }
  }
}

/**
 * Remove the is-booting guard class after viewport calculations stabilize.
 * This re-enables CSS transitions and backdrop-filter.
 */
function endBootingPhase(): void {
  try {
    const root = document.documentElement;
    if (!root.classList.contains('is-booting')) return;
    // Use rAF to ensure the final layout has been painted before enabling transitions
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        root.classList.remove('is-booting');
      });
    });
  } catch (e) {
    log.debug('[Platform] endBootingPhase failed:', e);
  }
}

/**
 * Initialize platform detection and viewport height tracking.
 * Call once at app bootstrap.
 */
export function initPlatform(): void {
  // Suppress all transitions/animations during boot to prevent layout shaking.
  // CSS html.is-booting * { transition: none !important } handles the rest.
  try {
    document.documentElement.classList.add('is-booting');
  } catch (e) {
    log.debug('[Platform] is-booting class failed:', e);
  }

  preventIOSPinchZoom();

  const run = () => {
    scheduleAppHeightUpdate();
    if (IS_ANDROID) {
      setManagedTimer('boot-height-500', scheduleAppHeightUpdate, 500);
      setManagedTimer('boot-height-1500', scheduleAppHeightUpdate, 1500);
      // Remove boot guard after last Android height update settles
      setManagedTimer('boot-end', endBootingPhase, 1800);
    } else {
      // Non-Android: remove boot guard after a short stabilization window
      setManagedTimer('boot-end', endBootingPhase, 300);
    }
  };

  // bootstrap() guarantees DOMContentLoaded before initPlatform() is called
  run();

  try {
    window.addEventListener('resize', scheduleAppHeightUpdate, { passive: true });
    window.addEventListener(
      'orientationchange',
      () => {
        // Reset stable viewport height — orientation changes the full viewport dimensions
        _stableViewportHeight = 0;
        scheduleAppHeightUpdate();
        if (IS_ANDROID) setManagedTimer('orientation-height', scheduleAppHeightUpdate, 500);
      },
      { passive: true },
    );
    window.addEventListener('pageshow', scheduleAppHeightUpdate, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleAppHeightUpdate();
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleAppHeightUpdate, { passive: true });
      window.visualViewport.addEventListener('scroll', scheduleAppHeightUpdate, { passive: true });
    }
  } catch (e) {
    log.debug('[Platform] Event listener registration failed:', e);
  }
}
