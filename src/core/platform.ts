/**
 * MUSIXQUARE — Platform Detection & Viewport Management
 */

import { log } from './log.ts';
import { setManagedTimer } from './timers.ts';
import type { DevicePlatform } from '../types/index.ts';

type NavigatorWithInstallHints = Navigator & {
  standalone?: boolean;
  userAgentData?: { platform?: string };
};

type WindowWithLegacyMsStream = Window & { MSStream?: unknown };

const installNavigator = navigator as NavigatorWithInstallHints;

// ─── Platform Detection ────────────────────────────────────────────

export const IS_IOS: boolean =
  (/iPad|iPhone|iPod/.test(navigator.userAgent) &&
    !(typeof window !== 'undefined' ? (window as WindowWithLegacyMsStream).MSStream : undefined)) ||
  ((installNavigator.userAgentData?.platform ?? navigator.platform ?? '') === 'MacIntel' &&
    navigator.maxTouchPoints > 1);

export const IS_ANDROID: boolean = /Android/i.test(navigator.userAgent);

export const IS_WINDOWS: boolean =
  /Windows/i.test(navigator.userAgent) ||
  /^Win/i.test(installNavigator.userAgentData?.platform ?? navigator.platform ?? '');

const DEVICE_PLATFORMS = new Set<DevicePlatform>([
  'ios',
  'android',
  'windows',
  'macos',
  'linux',
  'other',
]);

/** Accept only the coarse platform categories allowed in room presence data. */
export function normalizeDevicePlatform(value: unknown): DevicePlatform {
  return typeof value === 'string' && DEVICE_PLATFORMS.has(value as DevicePlatform)
    ? (value as DevicePlatform)
    : 'other';
}

/**
 * Return a coarse OS category without exposing a raw user agent, device model,
 * serial number, or persistent fingerprint to the room.
 */
export function getDevicePlatform(): DevicePlatform {
  if (IS_IOS) return 'ios';
  if (IS_ANDROID) return 'android';
  if (IS_WINDOWS) return 'windows';
  const platform = installNavigator.userAgentData?.platform ?? navigator.platform ?? '';
  const userAgent = navigator.userAgent ?? '';
  if (/Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  if (/Linux|X11/i.test(platform) || /Linux|X11/i.test(userAgent)) return 'linux';
  return 'other';
}

/** Desktop Chromium browser (Chrome, Edge, Opera, etc.) — supports getDisplayMedia with audio */
const IS_DESKTOP_CHROMIUM: boolean = !IS_IOS && !IS_ANDROID && /Chrome\//.test(navigator.userAgent);

/** Runtime check for system audio capture support */
export function canCaptureSystemAudio(): boolean {
  return IS_DESKTOP_CHROMIUM && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

// ─── Layout Breakpoint Helpers ─────────────────────────────────────

const MQL_COMPACT = '(min-width: 720px) and (max-width: 1279px)';

/**
 * Uniform scale applied to the desktop dashboard's body render tree.
 *
 * DOMRects and pointer coordinates are reported after this transform, while
 * layout metrics (`offsetTop`, `clientHeight`, `scrollTop`) and inline CSS
 * lengths remain in the body's pre-transform coordinate space. Keep the
 * conversion at the few boundaries that mix those two spaces instead of
 * making every UI caller aware of the desktop density implementation.
 */
export function getBodyRenderedScale(): number {
  const body = document.body;
  if (!body) return 1;
  const value = Number.parseFloat(
    window.getComputedStyle(body).getPropertyValue('--desktop-ui-scale'),
  );
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Convert a post-transform viewport distance into a body-local CSS length. */
export function viewportLengthToBodyCssPixels(viewportPixels: number): number {
  return viewportPixels / getBodyRenderedScale();
}

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
    if (installNavigator.standalone) return true;
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch (e) {
    log.debug('[Platform] standalone detection failed:', e);
  }
  return false;
}

// ─── iOS Pinch-Zoom Prevention ─────────────────────────────────────

// ─── Viewport Height Management ────────────────────────────────────

/**
 * Preserve the fixed-scale mobile application surface on iOS.
 *
 * Safari may allow native gesture zoom even when the viewport declares
 * `user-scalable=no`, so the product contract needs both layers. This is an
 * intentional app-shell interaction policy documented in
 * docs/mobile-app-zoom-policy.md, not a generic recommendation for websites.
 */
function preventIOSPinchZoom(): void {
  if (!IS_IOS) return;
  for (const eventName of ['gesturestart', 'gesturechange', 'gestureend'] as const) {
    document.addEventListener(eventName, (event) => event.preventDefault(), { passive: false });
  }
}

/**
 * Window during which keyboard detection is suppressed after orientationchange.
 * The OS animates rotation over a few hundred ms and visualViewport.resize
 * fires repeatedly through that window with intermediate (shrunken) heights
 * that look identical to a soft keyboard opening. 1s is comfortably longer
 * than any rotation animation observed across iOS/Android while still feeling
 * instant if the user types right after rotating.
 */
const KB_DETECTION_LOCK_MS = 1200;
const IOS_STANDALONE_BOOT_SETTLE_MS = [300, 1300] as const;
const IOS_STANDALONE_SAFE_AREA_DELTA_MAX = 64;

let _appHeightRaf = 0;
let _lastSoftKeyHeight = 0;
let _platformClassesApplied = false;
let _iosViewportProbe: HTMLDivElement | null = null;
let _iosStandaloneViewportProbe: HTMLDivElement | null = null;
let _stableViewportHeight = 0;
let _keyboardFreezeUntil = 0;
let _kbDetectionLockedUntil = 0;
let _stableViewportLandscape: boolean | null = null;
let _stableLayoutViewportWidth = 0;
let _stableLayoutViewportHeight = 0;
let _allowFocusedOrientationReconcile = false;
const _platformViewportListenerCleanups: Array<() => void> = [];

function clearPlatformViewportListeners(): void {
  for (
    let cleanup = _platformViewportListenerCleanups.pop();
    cleanup;
    cleanup = _platformViewportListenerCleanups.pop()
  ) {
    try {
      cleanup();
    } catch {
      /* noop */
    }
  }
}

function addPlatformViewportListener(
  target: EventTarget,
  type: string,
  listener: EventListener,
  options: AddEventListenerOptions,
): void {
  target.addEventListener(type, listener, options);
  _platformViewportListenerCleanups.push(() => {
    target.removeEventListener(type, listener, options.capture ?? false);
  });
}

function roundedPositive(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.round(value ?? 0) : 0;
}

function hasEditableFocus(): boolean {
  return document.activeElement?.matches('input, textarea, [contenteditable="true"]') === true;
}

function mediaViewportLandscape(): boolean | null {
  try {
    const orientation = window.matchMedia?.('(orientation: landscape)');
    return orientation ? orientation.matches : null;
  } catch {
    return null;
  }
}

/**
 * Prefer live layout geometry over orientation media state. WebKit can expose
 * the previous media-query orientation briefly while launching an installed
 * PWA, whereas innerWidth/innerHeight already drive its compact layout.
 */
function isViewportLandscape(vv: VisualViewport | null, root: HTMLElement): boolean {
  const allowFocusedOrientationReconcile = _allowFocusedOrientationReconcile;
  _allowFocusedOrientationReconcile = false;
  const innerWidth = roundedPositive(window.innerWidth);
  const innerHeight = roundedPositive(window.innerHeight);
  const innerLandscape =
    innerWidth > 0 && innerHeight > 0 && innerWidth !== innerHeight
      ? innerWidth > innerHeight
      : null;

  if (
    _stableViewportLandscape !== null &&
    (root.classList.contains('keyboard-open') || hasEditableFocus())
  ) {
    // Keep the committed orientation while keyboard geometry is transient.
    // A background rotation can preserve input focus and omit
    // orientationchange, though. A pageshow/foreground pass may replace it
    // only when the layout axes have actually swapped. This rejects a portrait
    // keyboard that merely makes height shorter than width.
    const mediaLandscape = mediaViewportLandscape();
    const axesSwapped =
      _stableLayoutViewportWidth > 0 &&
      _stableLayoutViewportHeight > 0 &&
      Math.abs(innerWidth - _stableLayoutViewportHeight) <= IOS_STANDALONE_SAFE_AREA_DELTA_MAX &&
      Math.abs(innerHeight - _stableLayoutViewportWidth) <= IOS_STANDALONE_SAFE_AREA_DELTA_MAX;
    if (
      allowFocusedOrientationReconcile &&
      innerLandscape !== null &&
      innerLandscape !== _stableViewportLandscape &&
      mediaLandscape === innerLandscape &&
      axesSwapped
    ) {
      _stableViewportLandscape = innerLandscape;
      _stableLayoutViewportWidth = innerWidth;
      _stableLayoutViewportHeight = innerHeight;
      resetKeyboardViewportTransitionState();
    }
    return _stableViewportLandscape;
  }

  if (innerLandscape !== null) {
    _stableViewportLandscape = innerLandscape;
    _stableLayoutViewportWidth = innerWidth;
    _stableLayoutViewportHeight = innerHeight;
    return _stableViewportLandscape;
  }

  const visualWidth = roundedPositive(vv?.width);
  const visualHeight = roundedPositive(vv?.height);
  if (visualWidth > 0 && visualHeight > 0 && visualWidth !== visualHeight) {
    _stableViewportLandscape = visualWidth > visualHeight;
    return _stableViewportLandscape;
  }

  _stableViewportLandscape = mediaViewportLandscape() ?? false;
  return _stableViewportLandscape;
}

/**
 * Installed iOS WebKit can report visualViewport/100dvh without the home
 * indicator area on a cold landscape launch. A 100vh probe represents the
 * full standalone layout surface and is intentionally used only for that
 * mode; safe-area env() values remain inner padding, not extra height.
 */
function measureIOSStandaloneLayoutViewport(): { width: number; height: number } {
  try {
    if (!_iosStandaloneViewportProbe && document.body) {
      _iosStandaloneViewportProbe = document.createElement('div');
      _iosStandaloneViewportProbe.setAttribute('aria-hidden', 'true');
      _iosStandaloneViewportProbe.style.cssText =
        'position:fixed;top:0;left:0;width:100vw;height:100vh;visibility:hidden;pointer-events:none';
      document.body.appendChild(_iosStandaloneViewportProbe);
    }
    return {
      width: roundedPositive(_iosStandaloneViewportProbe?.offsetWidth),
      height: roundedPositive(_iosStandaloneViewportProbe?.offsetHeight),
    };
  } catch (e) {
    log.debug('[Platform] iOS standalone viewport probe failed:', e);
    return { width: 0, height: 0 };
  }
}

function resolveIOSStandaloneLandscapeHeight(options: {
  layoutWidth: number;
  innerHeight: number;
  visualWidth: number;
  visualHeight: number;
  cssLayoutWidth: number;
  cssLayoutHeight: number;
}): number {
  const { layoutWidth, innerHeight, visualWidth, visualHeight, cssLayoutWidth, cssLayoutHeight } =
    options;
  const innerCandidate = layoutWidth > innerHeight ? innerHeight : 0;
  const visualCandidate = visualWidth > visualHeight ? visualHeight : 0;
  const cssCandidate = cssLayoutWidth > cssLayoutHeight ? cssLayoutHeight : 0;

  if (innerCandidate > 0) {
    if (
      cssCandidate > 0 &&
      Math.abs(cssCandidate - innerCandidate) <= IOS_STANDALONE_SAFE_AREA_DELTA_MAX
    ) {
      return Math.max(innerCandidate, cssCandidate);
    }
    return innerCandidate;
  }

  if (visualCandidate > 0 && cssCandidate > 0) {
    return Math.abs(cssCandidate - visualCandidate) <= IOS_STANDALONE_SAFE_AREA_DELTA_MAX
      ? Math.max(visualCandidate, cssCandidate)
      : 0;
  }

  return 0;
}

function resetKeyboardViewportTransitionState(): void {
  if (!IS_IOS && !IS_ANDROID) return;
  _kbDetectionLockedUntil = Date.now() + KB_DETECTION_LOCK_MS;
  _keyboardFreezeUntil = 0;
  _stableViewportHeight = 0;
  const root = document.documentElement;
  root.classList.remove('keyboard-open');
  root.style.setProperty('--keyboard-overlap', '0px');
}

function resetMobileViewportTransitionState(): void {
  if (!IS_IOS && !IS_ANDROID) return;
  resetKeyboardViewportTransitionState();
  _stableViewportLandscape = null;
  _stableLayoutViewportWidth = 0;
  _stableLayoutViewportHeight = 0;
  _allowFocusedOrientationReconcile = false;
}

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

  const isLandscape = isViewportLandscape(vv, root);

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
  // Detect soft keyboard from an editable focus plus visualViewport shrink.
  // Sets keyboard-open class and --keyboard-overlap CSS variable proactively.
  //
  // Detection is locked for ~1s right after orientationchange. Without the
  // lock, visualViewport.resize fires repeatedly during the rotation
  // animation with intermediate heights that look like a soft keyboard
  // opening (height shrinks below the previous orientation's stable
  // baseline). Those false positives re-add the keyboard-open class
  // immediately after the orientationchange handler clears it, the
  // shouldFreezeAppHeight gate re-engages, and --app-height gets stuck at
  // the previous orientation's value on iOS.
  if ((IS_IOS || IS_ANDROID) && vv && Date.now() >= _kbDetectionLockedUntil) {
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
    const isKbOpen =
      hasEditableFocus() && _stableViewportHeight > 100 && kbShrink > _stableViewportHeight * 0.15;

    if (isKbOpen && !wasKbOpen) {
      root.classList.add('keyboard-open');
      // No need for a settle timer — --app-height stays frozen while keyboard-open is present
      log.debug(
        `[Platform] Keyboard opened: stable=${_stableViewportHeight} current=${kbVvH} shrink=${kbShrink}`,
      );
    } else if (!isKbOpen && wasKbOpen) {
      // iOS can leave the input focused after the keyboard is dismissed. The
      // recovered viewport, not blur delivery, is authoritative; otherwise
      // keyboard-open keeps the compact side navigation hidden indefinitely.
      root.classList.remove('keyboard-open');
      // Brief freeze during close animation to prevent jitter
      _keyboardFreezeUntil = Date.now() + 350;
      setManagedTimer('kb-height-settle-close', scheduleAppHeightUpdate, 400);
      _stableViewportHeight = Math.max(kbVvH, Math.round(window.innerHeight));
      log.debug('[Platform] Keyboard closed');
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

  // iOS PWA signals have different safe-area behaviour by orientation.
  // Portrait retains the historical screen-height fallback for the top inset.
  // Landscape excludes visualViewport/root.clientHeight from authority because
  // WebKit may shorten both by the home-indicator area on a cold launch.
  if (IS_IOS && isStandalone) {
    const ih = roundedPositive(window.innerHeight);
    const vvH = roundedPositive(vv?.height);
    const scrH = roundedPositive(window.screen?.height);
    const layoutWidth = roundedPositive(window.innerWidth);
    const cssLayout = isLandscape ? measureIOSStandaloneLayoutViewport() : { width: 0, height: 0 };
    const fullH = isLandscape
      ? resolveIOSStandaloneLandscapeHeight({
          layoutWidth,
          innerHeight: ih,
          visualWidth: roundedPositive(vv?.width),
          visualHeight: vvH,
          cssLayoutWidth: cssLayout.width,
          cssLayoutHeight: cssLayout.height,
        })
      : Math.max(ih, vvH, scrH);
    if (isLandscape) root.style.removeProperty('height');
    if (fullH > 0 && !shouldFreezeAppHeight) {
      try {
        if (!isLandscape) root.style.height = `${fullH}px`;
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

function scheduleIOSStandaloneHeightSettles(allowFocusedOrientationReconcile = false): void {
  if (!IS_IOS || !isStandaloneDisplayMode()) return;
  for (const delayMs of IOS_STANDALONE_BOOT_SETTLE_MS) {
    setManagedTimer(
      `boot-height-ios-${delayMs}`,
      () => {
        if (allowFocusedOrientationReconcile) _allowFocusedOrientationReconcile = true;
        scheduleAppHeightUpdate();
      },
      delayMs,
    );
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
    const root = document.documentElement;
    root.classList.add('is-booting');
    // A cold standalone landscape launch does not emit orientationchange.
    // Apply the same bounded keyboard-inference lock up front so transient
    // visualViewport values cannot hide the side navigation on first paint.
    if (IS_IOS && isStandaloneDisplayMode()) resetMobileViewportTransitionState();
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
    } else if (IS_IOS && isStandaloneDisplayMode()) {
      // Installed WebKit can publish its final layout/safe-area geometry after
      // the initial frame. Reconcile twice, then stop; there is no interval or
      // background viewport probe after this bounded boot window.
      scheduleIOSStandaloneHeightSettles();
      setManagedTimer(
        'boot-end',
        endBootingPhase,
        IOS_STANDALONE_BOOT_SETTLE_MS[IOS_STANDALONE_BOOT_SETTLE_MS.length - 1] + 100,
      );
    } else {
      // Non-Android: remove boot guard after a short stabilization window
      setManagedTimer('boot-end', endBootingPhase, 300);
    }
  };

  // bootstrap() guarantees DOMContentLoaded before initPlatform() is called
  run();

  try {
    clearPlatformViewportListeners();
    addPlatformViewportListener(window, 'resize', scheduleAppHeightUpdate, { passive: true });
    addPlatformViewportListener(
      window,
      'orientationchange',
      () => {
        // iOS can keep activeElement focused after rotation even though the
        // keyboard is gone. Blur before accepting geometry for the new
        // orientation so a later resize cannot reuse that stale authority.
        const ae = document.activeElement as HTMLElement | null;
        if (ae && ae !== document.body && typeof ae.blur === 'function') {
          try {
            ae.blur();
          } catch {
            /* noop */
          }
        }

        // Reset keyboard freeze and the stable viewport. A rotation within the
        // keyboard-close freeze window (350ms) would otherwise lock
        // --app-height at the previous orientation's value: the next
        // updateAppHeight call sees shouldFreezeAppHeight=true and skips
        // the assignment, leaving the new orientation with a stale viewport
        // height. CSS that anchors on var(--app-height) (scrollbar centering,
        // sidebar height, modal positioning) then renders relative to the
        // wrong dimension. Suppress keyboard detection for
        // KB_DETECTION_LOCK_MS as visualViewport
        // .resize fires repeatedly during the rotation animation with shrunken
        // heights that get mis-detected as a keyboard opening — those false
        // positives re-add the keyboard-open class right after we clear it
        // below, defeating every other reset in this handler.
        resetMobileViewportTransitionState();
        scheduleAppHeightUpdate();
        // Settle timer for both platforms — visualViewport can lag behind
        // orientationchange while the OS animates the rotation, so a single
        // synchronous update isn't enough. iOS in particular had no follow-up
        // trigger after the freeze cleared, leaving --app-height stale until
        // the user touched the screen and incidentally re-fired the update.
        setManagedTimer('orientation-height', scheduleAppHeightUpdate, 500);
      },
      { passive: true },
    );
    addPlatformViewportListener(
      window,
      'pageshow',
      () => {
        _allowFocusedOrientationReconcile = true;
        scheduleAppHeightUpdate();
        scheduleIOSStandaloneHeightSettles(true);
      },
      { passive: true },
    );
    addPlatformViewportListener(
      document,
      'visibilitychange',
      () => {
        if (document.visibilityState === 'visible') {
          _allowFocusedOrientationReconcile = true;
          scheduleAppHeightUpdate();
          scheduleIOSStandaloneHeightSettles(true);
        }
      },
      { passive: true },
    );
    addPlatformViewportListener(document, 'focusin', scheduleAppHeightUpdate, { passive: true });
    addPlatformViewportListener(document, 'focusout', scheduleAppHeightUpdate, { passive: true });
    if (window.visualViewport) {
      addPlatformViewportListener(window.visualViewport, 'resize', scheduleAppHeightUpdate, {
        passive: true,
      });
      addPlatformViewportListener(window.visualViewport, 'scroll', scheduleAppHeightUpdate, {
        passive: true,
      });
    }
  } catch (e) {
    log.debug('[Platform] Event listener registration failed:', e);
  }
}

export const platformViewportForTests = {
  updateNow: updateAppHeightNow,
  reset(): void {
    clearPlatformViewportListeners();
    if (_appHeightRaf) cancelAnimationFrame(_appHeightRaf);
    _appHeightRaf = 0;
    _lastSoftKeyHeight = 0;
    _platformClassesApplied = false;
    _stableViewportHeight = 0;
    _keyboardFreezeUntil = 0;
    _kbDetectionLockedUntil = 0;
    _stableViewportLandscape = null;
    _stableLayoutViewportWidth = 0;
    _stableLayoutViewportHeight = 0;
    _allowFocusedOrientationReconcile = false;
    _iosViewportProbe?.remove();
    _iosViewportProbe = null;
    _iosStandaloneViewportProbe?.remove();
    _iosStandaloneViewportProbe = null;
  },
};
