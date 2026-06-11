/**
 * MUSIXQUARE — Page Lifecycle Flags & Handlers
 *
 * Why this module exists
 * ======================
 * Browser page lifecycle around a live P2P session is nuanced — the naïve
 * "cleanup in `beforeunload`" approach leaves the session in an undefined
 * state when the user picks "Stay" in the confirm dialog (listeners fire
 * for every unload attempt, not just confirmed ones). And app-driven
 * navigations (leave-session, kick, reconnect redirect, SW update, …)
 * that have already got explicit user confirmation through our own
 * dialog shouldn't also surface the browser's native
 * "Changes you made may not be saved" prompt.
 *
 * This module owns three slim responsibilities:
 *
 *   1. `markIntentionalNav()` — a one-shot flag any code path can flip
 *      right before triggering `window.location.reload()` /
 *      `window.location.href = …` to tell the `beforeunload` guard
 *      "don't show the native confirm; the user already confirmed."
 *
 *   2. `initPageLifecycleHandlers({ getRole, leaveSession, reload })` —
 *      attaches the `beforeunload` + `pagehide` + `pageshow` trio with
 *      the correct branching. Accepts dependencies as parameters so it
 *      can be unit-tested in isolation without dragging in the full
 *      bootstrap graph.
 *
 *   3. Bfcache restore fallback (pageshow, persisted=true) — if the page
 *      ever returns from the back-forward cache with a session role
 *      still marked active, the peer/audio/timer graph is gone; force
 *      a reload so the cached UI can't lie about the session state.
 *
 * Developer rule
 * ==============
 * ANY code path that programmatically navigates away from the app during
 * a session — reload, href change, back-forward, whatever — MUST call
 * `markIntentionalNav()` immediately before the navigation. Put the call
 * INSIDE any setTimeout/setManagedTimer callback wrapping the navigate,
 * never before it: a cancelled timer shouldn't leave the flag asserted
 * because that would suppress the native confirm on a later user-driven
 * close attempt.
 *
 * Current call sites (keep in sync):
 *   - src/ui/connect.ts            (Leave Session button)
 *   - src/ui/player-controls.ts    (Logo → home)
 *   - src/ui/setup-guest.ts        (Invite-link back)
 *   - src/ui/setup.ts              (4×: reconnect, kicked, explicit-kick)
 *   - src/sw-register.ts           (2×: SW update + controllerchange)
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
  _intentionalNav = false;
}

// ─── Handler Initialisation ─────────────────────────────────────────

interface PageLifecycleDeps {
  /** Read the current session role ('idle' / 'host' / 'guest' / …). */
  getRole: () => string;
  /** Tear down peer, player, timers, blobs, etc. (idempotent). */
  leaveSession: () => void;
  /** Force a fresh page load — used by the bfcache-restore fallback. */
  reload: () => void;
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
  // (persisted=true). Only the restore case needs handling: if an
  // active-session page is restored from bfcache, every runtime
  // resource is dead (PeerJS DataConnections, RTCPeerConnection, the
  // AudioContext, managed timers) but the cached DOM would still show
  // "connected". Force a reload for fresh state.
  window.addEventListener(
    'pageshow',
    (e) => {
      if (!e.persisted) return;
      if (deps.getRole() === 'idle') return;
      deps.log?.info('[PageLifecycle] Restored from bfcache with active session — reloading');
      _intentionalNav = true; // avoid double-prompting on the reload itself
      deps.reload();
    },
    opts,
  );

  return { dispose: () => controller.abort() };
}
