/**
 * The page navigation contract: the timings the navigation owner
 * (core/session-reset.ts, RO-23) and the Back leave
 * (core/back-button-history.ts, RO-30) share, and the sessionStorage markers
 * one document leaves for the next.
 *
 * Dependency-free on purpose: core/navigation.ts imports the owner, so the
 * owner and its requesters import these from here without an import cycle.
 * The ordering the timings rely on is pinned in
 * src/core/__tests__/navigation-contract.test.ts.
 *
 * Only eager modules import this file. The lazy hard-reset chunk
 * (core/sw-hard-reset.ts with core/sw-update-completion.ts) keeps its own
 * activation wait and its copy of UPDATE_COMPLETION_KEY: one lazy importer
 * makes the bundler split this module into an eager chunk of its own, about
 * 200 B of gzip glue. sw-update-completion.test.ts pins that copy.
 */

/** The reset runs its action after two frames, or after this when frames are suspended. */
export const RESET_PAINT_FALLBACK_MS = 120;

/**
 * After the reset's action runs, the document must reach pagehide within this
 * window; otherwise the navigation did not commit (a rejected or no-op
 * navigation, such as history traversal at the edge of the stack) and the
 * owner makes the page interactive again.
 */
export const NAVIGATION_COMMIT_TIMEOUT_MS = 2_000;

/**
 * A navigation with a prepare step (the logo reset's service-worker promotion)
 * gets this long to prepare; then the owner navigates anyway, and only then
 * does NAVIGATION_COMMIT_TIMEOUT_MS start (owner decision 2, 2026-10-23). It
 * covers the hard reset's own activation wait (ACTIVATION_TIMEOUT_MS, 1.5 s, in
 * the lazy core/sw-hard-reset.ts) plus 1 s for loading that chunk and reading
 * the registration; navigation-contract.test.ts pins the ordering.
 */
export const NAVIGATION_PREPARE_TIMEOUT_MS = 2_500;

/**
 * A confirmed Back leave traverses history first and navigates home when no
 * traversal took this document away within this time. It runs inside the
 * leave's reset, so it must fire before NAVIGATION_COMMIT_TIMEOUT_MS.
 */
export const LEAVE_FALLBACK_MS = 1_000;

// ── Next-document sessionStorage markers ─────────────────────────────
// Written by one document and read by the next one in the same tab, so a
// version N page writes what version N+1 reads during the very update reload
// that installs it. The key strings never change.

/** The room code an update or reconnect returns to; setup reads it as a reconnect. */
export const RECONNECT_TARGET_KEY = 'mxqr_reconnect_target';

/** When this tab last asked a waiting worker to activate. */
export const SW_UPDATE_KEY = 'sw-updated-at';

/** When this tab saw the new controller before reloading for it. */
export const SW_CONTROLLER_CONFIRMED_KEY = 'sw-controller-confirmed-at';

/** The localized "Update applied" toast the next document shows once. */
export const UPDATE_COMPLETION_KEY = 'mxqr-swu';
