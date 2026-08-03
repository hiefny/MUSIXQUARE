/**
 * Coordinates every app-owned hard reset/navigation.
 *
 * The reset overlay is shown synchronously so the page cannot accept another
 * interaction while teardown or navigation is pending. The actual action is
 * deferred until the browser has had a chance to paint the overlay. A native
 * timeout backs up requestAnimationFrame because background tabs may suspend
 * animation frames, and managed timers can be cleared by leaveSession().
 */

import { clearIntentionalNav, markIntentionalNav } from './page-lifecycle.ts';
import { log } from './log.ts';

const OVERLAY_ID = 'session-reset-overlay';
const MESSAGE_ID = 'session-reset-message';
const FALLBACK_DELAY_MS = 120;
const NAVIGATION_COMMIT_TIMEOUT_MS = 2_000;
const INTERACTION_EVENTS = [
  'keydown',
  'keyup',
  'pointerdown',
  'pointerup',
  'click',
  'touchstart',
  'touchend',
  'wheel',
] as const;

interface ResetAttempt {
  actionStarted: boolean;
  navigationCommitted: boolean;
  fallbackTimer: number;
  recoveryTimer: number;
  animationFrames: number[];
  inertStates: Map<HTMLElement, boolean>;
  previousFocus: HTMLElement | null;
}

let _resetPending = false;
let _activeAttempt: ResetAttempt | null = null;

function blockInteraction(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function installInteractionBlockers(): void {
  for (const eventName of INTERACTION_EVENTS) {
    window.addEventListener(eventName, blockInteraction, {
      capture: true,
      passive: false,
    });
  }
}

function removeInteractionBlockers(): void {
  for (const eventName of INTERACTION_EVENTS) {
    window.removeEventListener(eventName, blockInteraction, true);
  }
}

function markNavigationCommitted(): void {
  const attempt = _activeAttempt;
  if (!attempt) return;
  attempt.navigationCommitted = true;
  window.clearTimeout(attempt.recoveryTimer);
}

function restoreReturnedNavigation(): void {
  const attempt = _activeAttempt;
  if (!attempt?.actionStarted || !attempt.navigationCommitted) return;
  // Safari may restore the old document after a navigation reached pagehide
  // but the replacement shell failed to commit. Do not leave that returned
  // document inert behind the full-viewport reset surface.
  restoreSessionReset();
}

function restoreReturnedVisibleNavigation(): void {
  if (document.visibilityState === 'visible') restoreReturnedNavigation();
}

function ensureOverlay(): HTMLElement {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing instanceof HTMLElement) return existing;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'session-reset-overlay';
  overlay.hidden = true;
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'assertive');
  overlay.setAttribute('aria-atomic', 'true');
  overlay.setAttribute('aria-hidden', 'true');

  const message = document.createElement('p');
  message.id = MESSAGE_ID;
  message.className = 'session-reset-message';

  overlay.append(message);
  document.body.append(overlay);
  return overlay;
}

function showResetOverlay(message: string, attempt: ResetAttempt): void {
  const overlay = ensureOverlay();
  const messageEl = overlay.querySelector<HTMLElement>(`#${MESSAGE_ID}`);
  if (messageEl) messageEl.textContent = message;
  installInteractionBlockers();

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && activeElement !== overlay) {
    attempt.previousFocus = activeElement;
    activeElement.blur();
  }

  for (const child of document.body.children) {
    if (child === overlay || !(child instanceof HTMLElement)) continue;
    attempt.inertStates.set(child, child.inert);
    child.inert = true;
  }

  document.documentElement.classList.add('session-reset-pending');
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  overlay.setAttribute('aria-busy', 'true');
  overlay.classList.add('show');

  try {
    overlay.focus({ preventScroll: true });
  } catch {
    overlay.focus();
  }
}

/** Whether this document currently owns a blocking hard-reset attempt. */
export function isSessionResetPending(): boolean {
  return _resetPending;
}

/**
 * Restore an interactive document after an abandoned reset or bfcache return.
 * Safe to call repeatedly.
 */
export function restoreSessionReset(): void {
  const attempt = _activeAttempt;
  if (attempt) {
    window.clearTimeout(attempt.fallbackTimer);
    window.clearTimeout(attempt.recoveryTimer);
    if (typeof window.cancelAnimationFrame === 'function') {
      for (const frame of attempt.animationFrames) window.cancelAnimationFrame(frame);
    }
    for (const [element, wasInert] of attempt.inertStates) {
      element.inert = wasInert;
    }
  }

  removeInteractionBlockers();
  window.removeEventListener('pagehide', markNavigationCommitted, true);
  window.removeEventListener('pageshow', restoreReturnedNavigation, false);
  document.removeEventListener('visibilitychange', restoreReturnedVisibleNavigation, true);

  const overlay = document.getElementById(OVERLAY_ID);
  const previousFocus = attempt?.previousFocus;
  // Restore focus while the status overlay is still exposed. Safari/VoiceOver
  // can discard focus when the currently focused overlay is hidden first,
  // even if the destination has already had its inert state restored.
  if (previousFocus?.isConnected) {
    try {
      previousFocus.focus({ preventScroll: true });
    } catch {
      previousFocus.focus();
    }
  }

  if (overlay instanceof HTMLElement) {
    overlay.hidden = true;
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.removeAttribute('aria-busy');
  }
  document.documentElement.classList.remove('session-reset-pending');

  _activeAttempt = null;
  _resetPending = false;
  clearIntentionalNav();
}

/**
 * Show the blocking reset UI now, then run the supplied hard-navigation action
 * after the overlay has painted. Only the first request in a document wins.
 */
export function scheduleSessionReset(message: string, action: () => void): void {
  if (_resetPending) return;
  _resetPending = true;
  const attempt: ResetAttempt = {
    actionStarted: false,
    navigationCommitted: false,
    fallbackTimer: 0,
    recoveryTimer: 0,
    animationFrames: [],
    inertStates: new Map(),
    previousFocus: null,
  };
  _activeAttempt = attempt;
  showResetOverlay(message, attempt);
  // beforeunload can still be cancelled by another listener or the browser.
  // pagehide is the reliable boundary that this document actually left.
  window.addEventListener('pagehide', markNavigationCommitted, true);
  // A stalled iOS navigation can subsequently return the same document via
  // pageshow, or only foreground it again. Either signal must make the old
  // shell interactive instead of preserving a permanent reset screen.
  // Keep this in the ordinary listener phase. page-lifecycle's earlier
  // pageshow handler must get the first chance to replace a returned reset
  // with its single bounded reload attempt.
  window.addEventListener('pageshow', restoreReturnedNavigation, false);
  document.addEventListener('visibilitychange', restoreReturnedVisibleNavigation, true);

  const runOnce = () => {
    if (_activeAttempt !== attempt || attempt.actionStarted) return;
    attempt.actionStarted = true;
    window.clearTimeout(attempt.fallbackTimer);
    markIntentionalNav();
    try {
      action();
    } catch (error) {
      restoreSessionReset();
      log.error('[SessionReset] Hard-navigation action failed:', error);
      return;
    }

    // Navigation APIs return before unload begins and can be rejected/no-op
    // (notably history traversal at the edge of a stack). Do not leave the
    // current document permanently inert when no navigation signal follows.
    attempt.recoveryTimer = window.setTimeout(() => {
      if (_activeAttempt === attempt && !attempt.navigationCommitted) {
        restoreSessionReset();
      }
    }, NAVIGATION_COMMIT_TIMEOUT_MS);
  };

  attempt.fallbackTimer = window.setTimeout(runOnce, FALLBACK_DELAY_MS);
  if (typeof window.requestAnimationFrame === 'function') {
    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(runOnce);
      attempt.animationFrames.push(secondFrame);
    });
    attempt.animationFrames.push(firstFrame);
  }
}

/** @internal Test-only cleanup for module-scoped listeners and timers. */
export function __resetSessionResetForTests(): void {
  restoreSessionReset();
}
