// Resource owner: RO-23 (app-owned page navigation).
/**
 * Coordinates every app-owned hard reset/navigation.
 *
 * The reset overlay is shown synchronously so the page cannot accept another
 * interaction while teardown or navigation is pending. The actual action is
 * deferred until the browser has had a chance to paint the overlay. A native
 * timeout backs up requestAnimationFrame because background tabs may suspend
 * animation frames, and managed timers can be cleared by leaveSession().
 *
 * One state holds the page's navigation (PageNavigationState). Every way an
 * attempt can end in this document goes through settle() exactly once: the
 * action throwing ('failed'), the commit deadline, a return after pagehide and
 * an explicit restore ('recovered'). A committed navigation never settles: the
 * document is gone, or it comes back and the return settles it.
 */

import { clearIntentionalNav, markIntentionalNav } from './page-lifecycle.ts';
import { log } from './log.ts';
import { requestDocumentReload } from './document-reload.ts';
import { setElementInertForOwner } from './inert-ownership.ts';
import { NAVIGATION_COMMIT_TIMEOUT_MS, RESET_PAINT_FALLBACK_MS } from './navigation-contract.ts';

const OVERLAY_ID = 'session-reset-overlay';
const MESSAGE_ID = 'session-reset-message';
const INERT_OWNER = 'session-reset';
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

/** How an attempt ended while this document stayed alive. */
type NavigationOutcome = 'recovered' | 'failed';

interface NavigationAttempt {
  readonly settledListeners: Set<(outcome: NavigationOutcome) => void>;
  /** Set when settle() starts, so a re-entrant settle cannot run it twice. */
  settling: boolean;
  /** Set just before the listeners run; a later subscriber hears it at once. */
  outcome: NavigationOutcome | null;
  readonly timers: { paint: number; commit: number; frames: number[] };
  readonly inertElements: HTMLElement[];
  previousFocus: HTMLElement | null;
}

/**
 * - painting: the overlay is up; the action waits for two frames or the
 *   RESET_PAINT_FALLBACK_MS timeout.
 * - navigating: the action ran; NAVIGATION_COMMIT_TIMEOUT_MS is running.
 * - left: pagehide was seen. Only pageshow or a visible return settles it.
 */
type PageNavigationState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'painting' | 'navigating' | 'left'; readonly attempt: NavigationAttempt };

const IDLE: PageNavigationState = { phase: 'idle' };

/**
 * Exact ownership handle for one accepted reset request. Settled listeners
 * run only when this document restores that same attempt instead of leaving.
 * They intentionally stay silent once pagehide commits the navigation.
 */
interface SessionResetHandle {
  onSettled(listener: (outcome: NavigationOutcome) => void): () => void;
  /** onSettled for listeners that do not need the outcome. */
  onRecovered(listener: () => void): () => void;
}

let _state: PageNavigationState = IDLE;
let _releaseHandler: (() => void) | null = null;

/**
 * Let the window layer re-derive its state after an abandoned reset releases
 * its locks. The app shell injects it so this core module stays below the UI.
 */
export function setSessionResetReleaseHandler(handler: () => void): void {
  _releaseHandler = handler;
}

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

function cancelPaint(attempt: NavigationAttempt): void {
  window.clearTimeout(attempt.timers.paint);
  if (typeof window.cancelAnimationFrame === 'function') {
    for (const frame of attempt.timers.frames) window.cancelAnimationFrame(frame);
  }
}

function cancelTimers(attempt: NavigationAttempt): void {
  cancelPaint(attempt);
  window.clearTimeout(attempt.timers.commit);
}

function markNavigationCommitted(): void {
  if (_state.phase !== 'painting' && _state.phase !== 'navigating') return;
  const { attempt } = _state;
  _state = { phase: 'left', attempt };
  // pagehide can precede the deferred action when another navigation wins
  // during the overlay paint. Cancel every pending trigger so a returned old
  // document cannot issue the superseded hard navigation later.
  cancelTimers(attempt);
}

function restoreReturnedNavigation(): void {
  if (_state.phase !== 'left') return;
  // Safari may restore the old document after a navigation reached pagehide
  // but the replacement shell failed to commit. Do not leave that returned
  // document inert behind the full-viewport reset surface.
  settle(_state.attempt, 'recovered');
}

function restoreReturnedVisibleNavigation(): void {
  if (document.visibilityState === 'visible') restoreReturnedNavigation();
}

function addReturnListeners(): void {
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
}

function removeReturnListeners(): void {
  window.removeEventListener('pagehide', markNavigationCommitted, true);
  window.removeEventListener('pageshow', restoreReturnedNavigation, false);
  document.removeEventListener('visibilitychange', restoreReturnedVisibleNavigation, true);
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

function showResetOverlay(message: string, attempt: NavigationAttempt): void {
  const overlay = ensureOverlay();
  const messageEl = overlay.querySelector<HTMLElement>(`#${MESSAGE_ID}`);
  if (messageEl) messageEl.textContent = message;
  installInteractionBlockers();

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && activeElement !== overlay) {
    attempt.previousFocus = activeElement;
    activeElement.blur();
  }

  // Claim through the shared ledger: a dialog that opens or closes while the
  // reset is pending owns its own lock, so neither release can strand the
  // shell inert or re-enable it behind the other. Claim inert only: windows
  // write their own aria-hidden while the reset holds them, and the release
  // must not put back a value saved before they opened or closed.
  for (const child of document.body.children) {
    if (child === overlay || !(child instanceof HTMLElement)) continue;
    setElementInertForOwner(child, INERT_OWNER, true, { ariaHidden: false });
    attempt.inertElements.push(child);
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

/**
 * Take the reset surface down: timers, inert claims, interaction blockers and
 * return listeners, then focus, the window layer and the overlay. Runs while
 * the attempt still reports pending; with no attempt it only clears leftovers.
 */
function releaseResetSurface(attempt: NavigationAttempt | null): void {
  if (attempt) {
    cancelTimers(attempt);
    for (const element of attempt.inertElements) {
      setElementInertForOwner(element, INERT_OWNER, false);
    }
  }

  removeInteractionBlockers();
  removeReturnListeners();

  const overlay = document.getElementById(OVERLAY_ID);
  const previousFocus = attempt?.previousFocus;
  // Restore focus while the status overlay is still exposed. Safari/VoiceOver
  // can discard focus when the currently focused overlay is hidden first,
  // even if the destination has already had its inert state restored. Skip
  // a target that a window opened during the reset still covers.
  if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) {
    try {
      previousFocus.focus({ preventScroll: true });
    } catch {
      previousFocus.focus();
    }
  }
  if (attempt && _releaseHandler) {
    // A window that opened or closed while the reset held it wrote state the
    // modal stack could not apply yet, and could not take focus.
    try {
      _releaseHandler();
    } catch (error) {
      log.error('[SessionReset] Release handler failed:', error);
    }
  }

  if (overlay instanceof HTMLElement) {
    overlay.hidden = true;
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.removeAttribute('aria-busy');
  }
  document.documentElement.classList.remove('session-reset-pending');
}

/**
 * End `attempt` in this document, at most once: release the surface (still
 * pending), report idle with the unload exemption cleared, then tell the
 * attempt's listeners how it ended.
 */
function settle(attempt: NavigationAttempt, outcome: NavigationOutcome): void {
  if (_state.phase === 'idle' || _state.attempt !== attempt || attempt.settling) return;
  attempt.settling = true;
  releaseResetSurface(attempt);
  _state = IDLE;
  clearIntentionalNav();
  attempt.outcome = outcome;
  const listeners = [...attempt.settledListeners];
  attempt.settledListeners.clear();
  for (const listener of listeners) {
    try {
      listener(outcome);
    } catch (error) {
      log.error('[SessionReset] Recovery listener failed:', error);
    }
  }
}

/** Whether this document currently owns a blocking hard-reset attempt. */
export function isSessionResetPending(): boolean {
  return _state.phase !== 'idle';
}

/**
 * Restore an interactive document after an abandoned reset or bfcache return.
 * Safe to call repeatedly.
 */
export function restoreSessionReset(): void {
  if (_state.phase !== 'idle') {
    settle(_state.attempt, 'recovered');
    return;
  }
  releaseResetSurface(null);
  clearIntentionalNav();
}

/**
 * Show the blocking reset UI now, then run the supplied hard-navigation action
 * after the overlay has painted. Only the first request in a document wins.
 */
export function scheduleSessionReset(
  message: string,
  action: () => void,
): SessionResetHandle | null {
  if (_state.phase !== 'idle') return null;
  const attempt: NavigationAttempt = {
    settledListeners: new Set(),
    settling: false,
    outcome: null,
    timers: { paint: 0, commit: 0, frames: [] },
    inertElements: [],
    previousFocus: null,
  };
  _state = { phase: 'painting', attempt };
  showResetOverlay(message, attempt);
  addReturnListeners();

  const runAction = () => {
    if (_state.phase !== 'painting' || _state.attempt !== attempt) return;
    _state = { phase: 'navigating', attempt };
    cancelPaint(attempt);
    markIntentionalNav();
    try {
      action();
    } catch (error) {
      settle(attempt, 'failed');
      log.error('[SessionReset] Hard-navigation action failed:', error);
      return;
    }
    // The action may have settled the attempt itself or seen pagehide.
    if (_state.phase !== 'navigating' || _state.attempt !== attempt) return;

    // Navigation APIs return before unload begins and can be rejected/no-op
    // (notably history traversal at the edge of a stack). Do not leave the
    // current document permanently inert when no navigation signal follows.
    attempt.timers.commit = window.setTimeout(() => {
      if (_state.phase === 'navigating' && _state.attempt === attempt) {
        settle(attempt, 'recovered');
      }
    }, NAVIGATION_COMMIT_TIMEOUT_MS);
  };

  attempt.timers.paint = window.setTimeout(runAction, RESET_PAINT_FALLBACK_MS);
  if (typeof window.requestAnimationFrame === 'function') {
    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(runAction);
      attempt.timers.frames.push(secondFrame);
    });
    attempt.timers.frames.push(firstFrame);
  }

  const handle: SessionResetHandle = {
    onSettled(listener) {
      if (attempt.outcome) {
        listener(attempt.outcome);
        return () => undefined;
      }
      attempt.settledListeners.add(listener);
      return () => attempt.settledListeners.delete(listener);
    },
    onRecovered: (listener) => handle.onSettled(listener),
  };
  return handle;
}

/**
 * Route every app-owned hard reload through the pending-claim coordinator.
 * The fragment is restored only inside the deferred navigation action and is
 * scrubbed again before the same document becomes interactive after recovery.
 */
export function scheduleDocumentReload(message: string, onRecovered?: () => void): void {
  requestDocumentReload((attempt) => {
    const resetHandle = scheduleSessionReset(message, () =>
      attempt.navigate(() => window.location.reload()),
    );
    const recover = () => {
      try {
        attempt.recover();
      } finally {
        onRecovered?.();
      }
    };
    if (!resetHandle) {
      recover();
      return;
    }
    resetHandle.onRecovered(recover);
  });
}

/** @internal Test-only cleanup for module-scoped listeners and timers. */
export function __resetSessionResetForTests(): void {
  restoreSessionReset();
}
