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
 * navigation call throwing ('failed'), the commit deadline, a return after
 * pagehide and a request no longer current at navigate ('recovered'). A
 * committed navigation never settles: the document is gone, or it comes back
 * and the return settles it.
 *
 * Reloads wait in one queue here (C6-5). The busy rule (owner decision 1,
 * 2026-10-23): a reload asked for while another navigation holds the page, or
 * while the PRO claim fence (core/document-reload.ts) defers reloads, waits
 * and runs if that navigation settles in this document; a waiting request
 * with the same message joins the one already waiting. A direct reset asked
 * for while any navigation holds the page is still refused (first wins).
 *
 * A request is a plain action or { prepare?, navigate, isCurrent? } (C6-8). An
 * optional prepare step (the logo reset's service-worker promotion) runs
 * first, bounded by NAVIGATION_PREPARE_TIMEOUT_MS; then the owner calls
 * navigate, the final navigation call, and only then starts the 2 s commit
 * deadline (owner decision 2, 2026-10-23). The prepare signal aborts when its
 * window closes (the deadline or a settle), so a late step never runs and a
 * settled attempt never navigates. isCurrent() false at navigate time settles
 * the attempt as recovered without navigating.
 *
 * The reset surface stays on top of every window (C6-11, owner decision 4,
 * 2026-10-23): the modal stack never locks it, a dialog that opens while a
 * navigation is pending sits underneath, inert, and focus stays on the
 * surface. While an element fills the screen in the browser's fullscreen top
 * layer, the surface moves inside it, or the top layer would cover it
 * whatever its z-index; the page is locked around it there, and it moves
 * back when fullscreen ends or the attempt settles.
 *
 * The page transitions that end an attempt (pagehide, pageshow, a visible
 * return) reach this owner through one dispatch (C6-6), installed once by
 * initPageNavigation, or by the first attempt when nothing installed it yet.
 * Its three listeners use the capture phase, so they run before the Back
 * guard's bubble-phase resume whatever the init order. The dispatch also owns
 * the single bounded reload of a document the back-forward cache returns.
 */

import { claimUnloadExemption, revealLiveShell } from './page-lifecycle.ts';
import { log } from './log.ts';
import {
  __resetReloadFenceForTests,
  beginFencedReload,
  isReloadFenced,
  setReloadFenceOpenHandler,
  type ReloadFenceTicket,
} from './document-reload.ts';
import { setElementInertForOwner } from './inert-ownership.ts';
import {
  NAVIGATION_COMMIT_TIMEOUT_MS,
  NAVIGATION_PREPARE_TIMEOUT_MS,
  RESET_PAINT_FALLBACK_MS,
} from './navigation-contract.ts';

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
  /** Set for a reload: the attempt's hold on the PRO claim fence. */
  readonly reloadFence: ReloadFenceTicket | null;
  readonly settledListeners: Set<(outcome: NavigationOutcome) => void>;
  /** Set when settle() starts, so a re-entrant settle cannot run it twice. */
  settling: boolean;
  /** Set just before the listeners run; a later subscriber hears it at once. */
  outcome: NavigationOutcome | null;
  readonly timers: { paint: number; prepare: number; commit: number; frames: number[] };
  /** Aborted when the prepare window closes: its deadline passed or the attempt settled. */
  readonly prepareAbort: AbortController;
  readonly inertElements: HTMLElement[];
  previousFocus: HTMLElement | null;
  /** The unload-exemption claim, held from the action's start until settle. */
  releaseUnloadExemption: (() => void) | null;
}

/**
 * - painting: the overlay is up; the action waits for two frames or the
 *   RESET_PAINT_FALLBACK_MS timeout.
 * - preparing: the request's prepare step runs, bounded by
 *   NAVIGATION_PREPARE_TIMEOUT_MS.
 * - navigating: the final navigation call ran; NAVIGATION_COMMIT_TIMEOUT_MS is
 *   running.
 * - left: pagehide was seen. Only pageshow or a visible return settles it.
 */
type PageNavigationState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'painting' | 'preparing' | 'navigating' | 'left';
      readonly attempt: NavigationAttempt;
    };

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

/** A navigation for the owner to run once the reset screen has painted. */
interface NavigationRequest {
  /**
   * An optional bounded step before the navigation. The owner navigates when it
   * settles, rejects, or passes NAVIGATION_PREPARE_TIMEOUT_MS; `signal` aborts
   * then or when the attempt settles, and a late step must stop on it.
   */
  prepare?(signal: AbortSignal): Promise<void>;
  /** The final navigation call: a location sink. */
  navigate(): void;
  /** Whether the requester still wants this navigation when the owner is about to navigate. */
  isCurrent?(): boolean;
}

/** Reload requests waiting for the page; one entry per message. */
interface ReloadRequest {
  readonly message: string;
  readonly callbacks: Array<() => void>;
}

/** What the back-forward cache recovery needs from the app shell. */
interface PageNavigationDeps {
  /** The session role ('idle' outside a session). */
  getRole: () => string;
  /** The reset message of the bounded reload after a back-forward cache return. */
  bfcacheReloadMessage: () => string;
  log?: { info: (message: string, ...args: unknown[]) => void };
}

/**
 * What the window layer (ui/dom.ts) gives the reset surface. The app shell
 * injects it so this core module stays below the UI.
 */
interface ResetWindowLayer {
  /** Re-derive the window stack after an abandoned reset releases its locks. */
  release(): void;
  /** The element the browser paints in its fullscreen top layer, or null. */
  surfaceHost(): HTMLElement | null;
  /** Run `listener` when that element may have changed; returns an unsubscribe. */
  onSurfaceHostChange(listener: () => void): () => void;
}

let _state: PageNavigationState = IDLE;
let _windowLayer: ResetWindowLayer | null = null;
let _stopSurfaceHostWatch: (() => void) | null = null;
const _reloadQueue: ReloadRequest[] = [];
let _transitionDeps: PageNavigationDeps | null = null;
let _transitionDispatchInstalled = false;
/**
 * A failed reload can return the same document from the back-forward cache.
 * Retrying on every return loops the reset screen, so one document gets one
 * automatic recovery reload.
 */
let _bfcacheRetryUsed = false;
const _pendingChangeListeners = new Set<() => void>();
/** The pending state subscribers last heard of. */
let _reportedPending = false;

/**
 * Let the window layer re-derive its state after an abandoned reset releases
 * its locks, and tell the reset surface where the fullscreen top layer is.
 */
export function setSessionResetWindowLayer(layer: ResetWindowLayer): void {
  _windowLayer = layer;
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
  window.clearTimeout(attempt.timers.prepare);
  window.clearTimeout(attempt.timers.commit);
}

function markNavigationCommitted(): void {
  if (_state.phase === 'idle' || _state.phase === 'left') return;
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

/**
 * The document came back from the back-forward cache. An active session's
 * runtime resources went stale there, and a confirmed Back leave returns idle
 * but still behind its reset screen, so either gets one fresh reload; a
 * returned reset is settled first, so a rejected reload cannot strand the page.
 */
function recoverFromBackForwardCache(deps: PageNavigationDeps): void {
  const role = deps.getRole();
  const resetPending = _state.phase !== 'idle';
  if (role === 'idle' && !resetPending) return;

  if (_state.phase !== 'idle') {
    try {
      settle(_state.attempt, 'recovered');
    } catch {
      // Keep the live document visible even if reset cleanup is partial.
    }
  }

  if (_bfcacheRetryUsed) {
    // The prior reload left and returned to this exact document. Stop
    // retrying automatically; the service worker's bounded navigation
    // fallback or a later user action can recover without a reload loop.
    deps.log?.info('[PageLifecycle] bfcache reload returned; keeping recovered shell visible');
    return;
  }
  _bfcacheRetryUsed = true;
  deps.log?.info(
    resetPending
      ? '[PageLifecycle] Restored a pending session reset from bfcache. Reloading'
      : '[PageLifecycle] Restored from bfcache with active session. Reloading',
  );
  // The reload claims its own unload exemption when its action starts. While
  // it waits (behind the PRO claim fence), closing the tab still asks (C6-7).
  scheduleDocumentReload(deps.bfcacheReloadMessage());
}

// beforeunload can still be cancelled by another listener or the browser.
// pagehide is the reliable boundary that this document actually left.
function onPageHide(): void {
  markNavigationCommitted();
}

// Fresh and back-forward cache pageshows both prove that this document is the
// live surface again. A stalled iOS navigation can also return the same
// document through pageshow, or only foreground it (onVisibilityChange);
// either must make the old shell interactive instead of keeping a permanent
// reset screen.
function onPageShow(event: Event): void {
  revealLiveShell();
  const persisted = (event as PageTransitionEvent).persisted === true;
  if (persisted && _transitionDeps) recoverFromBackForwardCache(_transitionDeps);
  else restoreReturnedNavigation();
}

function onVisibilityChange(): void {
  restoreReturnedVisibleNavigation();
}

/** Install the one page-transition dispatch, once per document. */
function ensurePageTransitionDispatch(): void {
  if (_transitionDispatchInstalled) return;
  _transitionDispatchInstalled = true;
  window.addEventListener('pagehide', onPageHide, true);
  window.addEventListener('pageshow', onPageShow, true);
  document.addEventListener('visibilitychange', onVisibilityChange, true);
}

function removePageTransitionDispatch(): void {
  _transitionDispatchInstalled = false;
  window.removeEventListener('pagehide', onPageHide, true);
  window.removeEventListener('pageshow', onPageShow, true);
  document.removeEventListener('visibilitychange', onVisibilityChange, true);
}

/**
 * Install the page-transition dispatch with what its back-forward cache
 * recovery needs. The app shell calls it once at bootstrap; dispose is for
 * tests that boot the shell again.
 */
export function initPageNavigation(deps: PageNavigationDeps): { dispose(): void } {
  _transitionDeps = deps;
  ensurePageTransitionDispatch();
  return {
    dispose() {
      if (_transitionDeps === deps) _transitionDeps = null;
    },
  };
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

/**
 * Put the overlay inside the fullscreen host while one exists (the browser
 * paints that element's subtree above every z-index outside it), else in the
 * body. A body child stays where it is.
 */
function placeOverlay(overlay: HTMLElement, host = _windowLayer?.surfaceHost()): void {
  const parent = host?.isConnected && !overlay.contains(host) ? host : document.body;
  if (overlay.parentNode !== parent) parent.append(overlay);
}

function focusOverlay(overlay: HTMLElement): void {
  try {
    overlay.focus({ preventScroll: true });
  } catch {
    overlay.focus();
  }
}

/**
 * Claim inert on every element beside the overlay's path from the body. A
 * body-child overlay leaves every other body child claimed, as before C6-11;
 * inside a fullscreen host, the host's ancestors stay unclaimed (the overlay
 * would inherit their inert) and their other children are claimed instead.
 *
 * Claims go through the shared ledger: a dialog that opens or closes while
 * the reset is pending owns its own lock, so neither release can strand the
 * shell inert or re-enable it behind the other. Claim inert only: windows
 * write their own aria-hidden while the reset holds them, and the release
 * must not put back a value saved before they opened or closed.
 */
function claimPageAround(overlay: HTMLElement, attempt: NavigationAttempt): void {
  let children: HTMLCollection | null = document.body.children;
  while (children) {
    let next: HTMLCollection | null = null;
    for (const child of Array.from(children)) {
      if (child === overlay) continue;
      if (child.contains(overlay)) {
        next = child.children;
        continue;
      }
      if (!(child instanceof HTMLElement)) continue;
      setElementInertForOwner(child, INERT_OWNER, true, { ariaHidden: false });
      attempt.inertElements.push(child);
    }
    children = next;
  }
}

function releasePageClaims(attempt: NavigationAttempt): void {
  for (const element of attempt.inertElements) {
    setElementInertForOwner(element, INERT_OWNER, false);
  }
  attempt.inertElements.length = 0;
}

/** Fullscreen began or ended under a pending reset: move the surface and its lock. */
function followSurfaceHost(): void {
  if (_state.phase === 'idle') return;
  const { attempt } = _state;
  const overlay = document.getElementById(OVERLAY_ID);
  if (!(overlay instanceof HTMLElement)) return;
  releasePageClaims(attempt);
  placeOverlay(overlay);
  claimPageAround(overlay, attempt);
  // Moving the focused overlay drops its focus; the page holds no other.
  focusOverlay(overlay);
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

  placeOverlay(overlay);
  claimPageAround(overlay, attempt);
  _stopSurfaceHostWatch?.();
  _stopSurfaceHostWatch = _windowLayer?.onSurfaceHostChange(followSurfaceHost) ?? null;

  document.documentElement.classList.add('session-reset-pending');
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  overlay.setAttribute('aria-busy', 'true');
  overlay.classList.add('show');
  focusOverlay(overlay);
}

/**
 * Take the reset surface down: timers, inert claims and interaction blockers,
 * then focus, the window layer and the overlay. Runs while
 * the attempt still reports pending; with no attempt it only clears leftovers.
 */
function releaseResetSurface(attempt: NavigationAttempt | null): void {
  _stopSurfaceHostWatch?.();
  _stopSurfaceHostWatch = null;
  if (attempt) {
    cancelTimers(attempt);
    releasePageClaims(attempt);
  }

  removeInteractionBlockers();

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
  if (attempt && _windowLayer) {
    // A window that opened or closed while the reset held it wrote state the
    // modal stack could not apply yet, and could not take focus.
    try {
      _windowLayer.release();
    } catch (error) {
      log.error('[SessionReset] Release handler failed:', error);
    }
  }

  if (overlay instanceof HTMLElement) {
    overlay.hidden = true;
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.removeAttribute('aria-busy');
    // Hidden first, so the move out of a fullscreen host shows nothing.
    placeOverlay(overlay, null);
  }
  document.documentElement.classList.remove('session-reset-pending');
}

/**
 * End `attempt` in this document, at most once: release the surface (still
 * pending), report idle with the unload exemption cleared, give a reload's
 * claim fragment back to the fence, start the next queued reload, tell the
 * attempt's listeners how it ended, then send the pending change.
 */
function settle(attempt: NavigationAttempt, outcome: NavigationOutcome): void {
  if (_state.phase === 'idle' || _state.attempt !== attempt || attempt.settling) return;
  attempt.settling = true;
  // A prepare step still running must not navigate or promote anything now.
  attempt.prepareAbort.abort();
  releaseResetSurface(attempt);
  _state = IDLE;
  attempt.releaseUnloadExemption?.();
  attempt.releaseUnloadExemption = null;
  attempt.outcome = outcome;
  try {
    attempt.reloadFence?.end();
  } catch (error) {
    // Logged as before C6-5, when the rollback ran inside a recovery listener.
    log.error('[SessionReset] Recovery listener failed:', error);
  }
  startQueuedReload();
  const listeners = [...attempt.settledListeners];
  attempt.settledListeners.clear();
  for (const listener of listeners) {
    try {
      listener(outcome);
    } catch (error) {
      log.error('[SessionReset] Recovery listener failed:', error);
    }
  }
  reportPendingChange();
}

/** Whether this document currently owns a blocking hard-reset attempt. */
export function isSessionResetPending(): boolean {
  return _state.phase !== 'idle';
}

/**
 * Tell subscribers when the page's pending state changed. It runs when an
 * attempt starts and at the very end of settle, after the queue and the
 * attempt's own callbacks: a reload the queue started there, or a reset a
 * callback asked for, keeps the page pending, so no subscriber hears of an
 * idle page that never was. Subscribers read the live state.
 */
function reportPendingChange(): void {
  const pending = _state.phase !== 'idle';
  if (pending === _reportedPending) return;
  _reportedPending = pending;
  for (const listener of [..._pendingChangeListeners]) {
    try {
      listener();
    } catch (error) {
      log.error('[SessionReset] Pending-change listener failed:', error);
    }
  }
}

/**
 * Run `listener` whenever a navigation starts holding the page or the page is
 * released again (read isSessionResetPending()). The Back guard re-arms from
 * it once a navigation settles in this document (C6-12, owner decision 5).
 * Returns an unsubscribe.
 */
export function onNavigationPendingChange(listener: () => void): () => void {
  _pendingChangeListeners.add(listener);
  return () => {
    _pendingChangeListeners.delete(listener);
  };
}

/** Make the page interactive again and drop leftovers; settles a pending attempt. */
function restorePage(): void {
  if (_state.phase !== 'idle') {
    settle(_state.attempt, 'recovered');
    return;
  }
  releaseResetSurface(null);
}

/**
 * Show the blocking reset UI now, then run the request after the overlay has
 * painted: its prepare step, if any, then its final navigation call. Only the
 * first request in a document wins.
 */
export function scheduleSessionReset(
  message: string,
  action: () => void,
): SessionResetHandle | null;
export function scheduleSessionReset(
  message: string,
  request: NavigationRequest,
): SessionResetHandle | null;
export function scheduleSessionReset(
  message: string,
  request: (() => void) | NavigationRequest,
): SessionResetHandle | null {
  if (_state.phase !== 'idle') return null;
  return beginAttempt(
    message,
    typeof request === 'function' ? { navigate: request } : request,
    null,
  );
}

/** Run the final navigation call and start the commit deadline. */
function navigateAttempt(attempt: NavigationAttempt, request: NavigationRequest): void {
  if (request.isCurrent && !request.isCurrent()) {
    // The requester moved on (another session opened meanwhile): restore the
    // page instead of navigating.
    settle(attempt, 'recovered');
    return;
  }
  _state = { phase: 'navigating', attempt };
  try {
    request.navigate();
  } catch (error) {
    settle(attempt, 'failed');
    log.error('[SessionReset] Hard-navigation action failed:', error);
    return;
  }
  // The navigation may have seen pagehide already.
  if (_state.phase !== 'navigating' || _state.attempt !== attempt) return;

  // Navigation APIs return before unload begins and can be rejected/no-op
  // (notably history traversal at the edge of a stack). Do not leave the
  // current document permanently inert when no navigation signal follows.
  attempt.timers.commit = window.setTimeout(() => {
    if (_state.phase === 'navigating' && _state.attempt === attempt) {
      settle(attempt, 'recovered');
    }
  }, NAVIGATION_COMMIT_TIMEOUT_MS);
}

/**
 * Run the request's prepare step. It ends when the step settles, rejects
 * (logged; the navigation fails open) or passes NAVIGATION_PREPARE_TIMEOUT_MS;
 * the first of these closes the window (aborting the signal) and navigates,
 * unless the attempt has left or settled meanwhile.
 */
function prepareAttempt(attempt: NavigationAttempt, request: NavigationRequest): void {
  _state = { phase: 'preparing', attempt };
  const finish = (): void => {
    if (_state.phase !== 'preparing' || _state.attempt !== attempt) return;
    window.clearTimeout(attempt.timers.prepare);
    attempt.prepareAbort.abort();
    navigateAttempt(attempt, request);
  };
  attempt.timers.prepare = window.setTimeout(finish, NAVIGATION_PREPARE_TIMEOUT_MS);
  let prepared: Promise<void>;
  try {
    prepared = request.prepare?.(attempt.prepareAbort.signal) ?? Promise.resolve();
  } catch (error) {
    prepared = Promise.reject(error);
  }
  void Promise.resolve(prepared).then(finish, (error: unknown) => {
    if (_state.phase === 'preparing' && _state.attempt === attempt) {
      log.warn('[SessionReset] Navigation preparation failed; navigating anyway:', error);
    }
    finish();
  });
}

function beginAttempt(
  message: string,
  request: NavigationRequest,
  reloadFence: ReloadFenceTicket | null,
): SessionResetHandle {
  const attempt: NavigationAttempt = {
    reloadFence,
    settledListeners: new Set(),
    settling: false,
    outcome: null,
    timers: { paint: 0, prepare: 0, commit: 0, frames: [] },
    prepareAbort: new AbortController(),
    inertElements: [],
    previousFocus: null,
    releaseUnloadExemption: null,
  };
  _state = { phase: 'painting', attempt };
  ensurePageTransitionDispatch();
  showResetOverlay(message, attempt);

  const runAction = () => {
    if (_state.phase !== 'painting' || _state.attempt !== attempt) return;
    cancelPaint(attempt);
    // The exemption covers the whole action, prepare step included.
    attempt.releaseUnloadExemption = claimUnloadExemption('navigation');
    if (request.prepare) prepareAttempt(attempt, request);
    else navigateAttempt(attempt, request);
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
  reportPendingChange();
  return handle;
}

/** Start the oldest waiting reload when nothing holds the page and the fence is open. */
function startQueuedReload(): void {
  if (_state.phase !== 'idle' || isReloadFenced()) return;
  const request = _reloadQueue.shift();
  if (!request) return;
  const reloadFence = beginFencedReload();
  const handle = beginAttempt(
    request.message,
    {
      navigate() {
        // A safe pending claim is restored only for the sink call; settle()
        // scrubs it again if this document stays.
        reloadFence.restoreClaim();
        window.location.reload();
      },
    },
    reloadFence,
  );
  for (const callback of request.callbacks) handle.onSettled(() => callback());
}

setReloadFenceOpenHandler(startQueuedReload);

/**
 * Reload this document behind the reset screen. The request waits while
 * another navigation holds the page or the PRO claim fence defers reloads, and
 * runs once that navigation settles in this document; it never runs if that
 * navigation commits. A waiting request with the same message (the reason the
 * user is shown) joins it and is answered by the same reload; a reload already
 * running is the winning navigation, so a request during it waits behind it.
 * `onRecovered` runs once if the reload carrying the request settles in this
 * document (owner decision 1, 2026-10-23).
 */
export function scheduleDocumentReload(message: string, onRecovered?: () => void): void {
  const callbacks = onRecovered ? [onRecovered] : [];
  const waiting = _reloadQueue.find((request) => request.message === message);
  if (waiting) waiting.callbacks.push(...callbacks);
  else _reloadQueue.push({ message, callbacks });
  startQueuedReload();
}

/**
 * @internal Test-only cleanup of the whole page navigation owner: its queue,
 * attempt, listeners and timers, and the PRO claim fence it reloads through.
 */
export function __resetPageNavigationForTests(): void {
  _reloadQueue.length = 0;
  restorePage();
  _reportedPending = false;
  removePageTransitionDispatch();
  _transitionDeps = null;
  _bfcacheRetryUsed = false;
  __resetReloadFenceForTests();
}
