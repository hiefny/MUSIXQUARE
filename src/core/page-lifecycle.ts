/**
 * MUSIXQUARE — Page Lifecycle Flags & Handlers
 *
 * `beforeunload` fires before the user decides whether to leave, so it cannot
 * own peer/audio teardown. `pagehide` owns confirmed-unload cleanup.
 *
 * This module owns three responsibilities:
 *
 *   1. `markIntentionalNav()` — a one-shot flag any code path can flip
 *      right before triggering `window.location.reload()` /
 *      `window.location.href = …` to tell the `beforeunload` guard
 *      that the app already obtained confirmation.
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
 * App-owned hard navigations should go through `core/session-reset.ts`, which
 * blocks interaction, allows the overlay to paint, and calls
 * `markIntentionalNav()` immediately before navigation. Keeping the flag at
 * that final boundary prevents an abandoned reset from suppressing a later
 * user-driven close confirmation.
 */

let _intentionalNav = false;

/**
 * Flip the intentional-nav flag. The `beforeunload` handler will then
 * early-return for subsequent events, suppressing the native confirm.
 * Idempotent — safe to call repeatedly.
 */
export function markIntentionalNav(): void {
  _intentionalNav = true;
}

/**
 * Clear an intentional navigation that never committed. Reset coordinators
 * call this when their navigation action throws or produces no unload, so a
 * later user-driven close still receives the normal confirmation.
 */
export function clearIntentionalNav(): void {
  _intentionalNav = false;
}

/** @internal Read by the `beforeunload` handler. */
export function isIntentionalNav(): boolean {
  return _intentionalNav;
}

/**
 * @internal Test-only helper to reset the module-scoped flag between
 * test cases. Production code should NOT call this — the flag is meant
 * to be one-shot for the lifetime of the page.
 */
export function __resetIntentionalNavForTests(): void {
  clearIntentionalNav();
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
  // session is active AND the navigation wasn't triggered by our own
  // confirmed flow. Also forces bfcache off during active sessions so
  // a back-forward restore can't resurrect a stale UI (the navigation
  // owner's pageshow recovery covers the residual case where bfcache wins).
  window.addEventListener(
    'beforeunload',
    (e) => {
      if (_intentionalNav) return;
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
