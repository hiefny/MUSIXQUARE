/**
 * MUSIXQUARE — Page Lifecycle Flags & Handlers
 *
 * `beforeunload` fires before the user decides whether to leave, so it cannot
 * own peer/audio teardown. `pagehide` owns confirmed-unload cleanup, while
 * `pageshow` rejects an active-session UI restored from bfcache after its
 * runtime resources have gone stale.
 *
 * This module owns three responsibilities:
 *
 *   1. `markIntentionalNav()` — a one-shot flag any code path can flip
 *      right before triggering `window.location.reload()` /
 *      `window.location.href = …` to tell the `beforeunload` guard
 *      that the app already obtained confirmation.
 *
 *   2. `initPageLifecycleHandlers({ getRole, leaveSession, reload })` —
 *      attaches the `beforeunload`, `pagehide`, and `pageshow` handlers with
 *      injected dependencies so the lifecycle contract remains testable.
 *
 *   3. Bfcache restore fallback (pageshow, persisted=true) — if the page
 *      returns with an active session or a pending hard reset, force a reload
 *      so cached UI cannot claim dead resources are connected or stay inert.
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

// ─── Handler Initialisation ─────────────────────────────────────────

interface PageLifecycleDeps {
  /** Read the current session role ('idle' / 'host' / 'guest' / …). */
  getRole: () => string;
  /** Tear down peer, player, timers, blobs, etc. (idempotent). */
  leaveSession: () => void;
  /** Force a fresh page load — used by the bfcache-restore fallback. */
  reload: () => void;
  /** Whether a hard reset was in flight when this document entered bfcache. */
  hasPendingReset?: () => boolean;
  /** Remove reset UI/interaction locks before retrying a bfcache reload. */
  restorePendingReset?: () => void;
  /** Optional logger for bfcache-restore telemetry. */
  log?: { info: (msg: string, ...args: unknown[]) => void };
}

export interface PageLifecycleHandle {
  /** Detach all listeners; mainly for tests. */
  dispose: () => void;
}

/**
 * Register the beforeunload / pagehide / pageshow handlers.
 *
 * Returns a `dispose()` function that detaches all three listeners at
 * once via AbortController, so tests can re-initialise between cases
 * without stacking duplicate handlers.
 */
export function initPageLifecycleHandlers(deps: PageLifecycleDeps): PageLifecycleHandle {
  const controller = new AbortController();
  const opts = { signal: controller.signal };
  // A failed reload can return the same document from bfcache. Retrying on
  // every pageshow creates an endless reset-overlay/navigation loop, so one
  // document gets one automatic bfcache recovery navigation.
  let bfcacheReloadAttempted = false;

  const revealLiveShell = (): void => {
    try {
      document.body?.classList.add('fouc-loaded');
    } catch {
      /* a lifecycle recovery must never fail on a detached body */
    }
  };

  // ── beforeunload ──
  // Show the native "Changes you made may not be saved" confirm when a
  // session is active AND the navigation wasn't triggered by our own
  // confirmed flow. Also forces bfcache off during active sessions so
  // a back-forward restore can't resurrect a stale UI (the companion
  // pageshow handler covers the residual case where bfcache wins anyway).
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

  // ── pageshow ──
  // Fires on both fresh loads (persisted=false) and bfcache restores
  // (persisted=true). Only the restore case needs handling: an active-session
  // page may have stale runtime resources, while a confirmed Back flow may
  // return with role=idle but its cached reset overlay and inert DOM intact.
  // Both cases force a fresh load; the pending-reset case first restores
  // interaction so a rejected reload cannot strand the document.
  window.addEventListener(
    'pageshow',
    (e) => {
      // Fresh and bfcache pageshows both prove that this document is the live
      // surface again. Repair the FOUC class before any reload decision so an
      // abandoned navigation cannot leave only the themed body background.
      revealLiveShell();
      if (!e.persisted) return;
      const role = deps.getRole();
      const resetPending = deps.hasPendingReset?.() === true;
      if (role === 'idle' && !resetPending) return;

      if (resetPending) {
        // A confirmed Back flow calls leaveSession() before navigating, so its
        // cached document legitimately has role=idle. Remove the cached inert
        // UI first: even if reload is rejected, the restored page remains
        // interactive instead of being trapped behind the reset overlay.
        try {
          deps.restorePendingReset?.();
        } catch {
          /* keep the live document visible even if reset cleanup is partial */
        }
      }

      if (bfcacheReloadAttempted) {
        // The prior reload left and returned to this exact document. Restore
        // interaction above, then stop retrying automatically; the service
        // worker's bounded navigation fallback or a later user action can
        // recover without trapping the PWA in a reload loop.
        clearIntentionalNav();
        deps.log?.info('[PageLifecycle] bfcache reload returned; keeping recovered shell visible');
        return;
      }

      bfcacheReloadAttempted = true;

      deps.log?.info(
        resetPending
          ? '[PageLifecycle] Restored a pending session reset from bfcache — reloading'
          : '[PageLifecycle] Restored from bfcache with active session — reloading',
      );
      if (role !== 'idle') markIntentionalNav(); // avoid prompting on the reload itself
      try {
        deps.reload();
      } catch {
        // A failed reload must not suppress a later user-driven unload.
        clearIntentionalNav();
      }
    },
    opts,
  );

  return { dispose: () => controller.abort() };
}
