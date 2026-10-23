/**
 * MUSIXQUARE — Page Lifecycle Claims & Handlers
 *
 * `beforeunload` fires before the user decides whether to leave, so it cannot
 * own peer/audio teardown. `pagehide` owns confirmed-unload cleanup.
 *
 * This module owns three responsibilities:
 *
 *   1. `claimUnloadExemption(reason)` — a writer that is about to navigate this
 *      document on purpose (the navigation owner's action, a same-tab Google
 *      login) holds its own claim, so the `beforeunload` guard does not ask to
 *      confirm while any claim is live. Each writer releases only its own
 *      claim (C6-7): a reset that recovers can no longer cancel a pending
 *      login's exemption.
 *
 *   2. `initPageLifecycleHandlers({ getRole, leaveSession })` — attaches the
 *      `beforeunload` and `pagehide` handlers with injected dependencies so the
 *      lifecycle contract remains testable.
 *
 *   3. `revealLiveShell()` — repairs the FOUC class when a pageshow proves this
 *      document is the live surface again.
 *
 * The pageshow that returns a document from the back-forward cache belongs to
 * the page navigation owner (`core/session-reset.ts`, `initPageNavigation`,
 * C6-6): it calls `revealLiveShell` first, settles a returned reset, and makes
 * the one bounded reload.
 *
 * App-owned hard navigations go through `core/session-reset.ts`, which blocks
 * interaction, lets the overlay paint, claims the exemption when its action
 * starts and releases it when the attempt settles in this document. Claiming
 * at that final boundary keeps an abandoned or queued navigation from
 * suppressing a later user-driven close confirmation.
 */

/** Who holds an unload exemption: the navigation owner or a same-tab login. */
type UnloadExemptionReason = 'navigation' | 'account-login';

const _unloadExemptions = new Set<{ readonly reason: UnloadExemptionReason }>();

/**
 * Exempt this document's unload from the leave confirmation until the
 * returned release runs. Claims are independent: releasing one never ends
 * another, and releasing twice is harmless.
 */
export function claimUnloadExemption(reason: UnloadExemptionReason): () => void {
  const claim = { reason };
  _unloadExemptions.add(claim);
  return () => {
    _unloadExemptions.delete(claim);
  };
}

/** @internal Test-only cleanup: drop every claim between test cases. */
export function __resetUnloadExemptionsForTests(): void {
  _unloadExemptions.clear();
}

/**
 * A pageshow proves this document is the live surface again: repair the FOUC
 * class so an abandoned navigation cannot leave only the themed body
 * background. The page navigation owner calls it on every pageshow, before
 * any reload decision.
 */
export function revealLiveShell(): void {
  try {
    document.body?.classList.add('fouc-loaded');
  } catch {
    /* a lifecycle recovery must never fail on a detached body */
  }
}

// ─── Handler Initialisation ─────────────────────────────────────────

interface PageLifecycleDeps {
  /** Read the current session role ('idle' / 'host' / 'guest' / …). */
  getRole: () => string;
  /** Tear down peer, player, timers, blobs, etc. (idempotent). */
  leaveSession: () => void;
}

export interface PageLifecycleHandle {
  /** Detach all listeners; mainly for tests. */
  dispose: () => void;
}

/**
 * Register the beforeunload / pagehide handlers.
 *
 * Returns a `dispose()` function that detaches both listeners at once via
 * AbortController, so tests can re-initialise between cases without stacking
 * duplicate handlers.
 */
export function initPageLifecycleHandlers(deps: PageLifecycleDeps): PageLifecycleHandle {
  const controller = new AbortController();
  const opts = { signal: controller.signal };

  // ── beforeunload ──
  // Show the native "Changes you made may not be saved" confirm when a
  // session is active AND no unload-exemption claim is live (our own
  // confirmed navigation or a same-tab login). Also forces bfcache off during active sessions so
  // a back-forward restore can't resurrect a stale UI (the navigation
  // owner's pageshow recovery covers the residual case where bfcache wins).
  window.addEventListener(
    'beforeunload',
    (e) => {
      if (_unloadExemptions.size > 0) return;
      if (deps.getRole() === 'idle') return;
      e.preventDefault();
      e.returnValue = '';
    },
    opts,
  );

  // ── pagehide ──
  // ONLY fires on actual unload ("Stay" does not trigger it). Runs the
  // real cleanup once, at the right time.
  //
  // `persisted === true` means the browser is stashing the page in
  // bfcache for possible later restore — we skip cleanup in that case
  // so the session can come back intact if a pageshow follows.
  //
  // If role is already 'idle' there's nothing left to tear down: the
  // popstate "Leave" flow calls leaveSession() synchronously, which
  // flips role→idle immediately; letting pagehide run a second
  // leaveSession would be harmless (idempotent) but wasteful.
  window.addEventListener(
    'pagehide',
    (e) => {
      if (e.persisted) return;
      if (deps.getRole() === 'idle') return;
      try {
        deps.leaveSession();
      } catch {
        /* noop */
      }
    },
    opts,
  );

  return { dispose: () => controller.abort() };
}
