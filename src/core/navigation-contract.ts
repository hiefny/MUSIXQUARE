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

/**
 * The reset runs its action once its screen's fade-in has run (two frames, then
 * what is left of that transition), or, when frames are suspended, this long
 * after the fade-in's length.
 */
export const RESET_PAINT_FALLBACK_MS = 120;

/**
 * A visible page can render the reset screen's first frame late (a busy WebKit
 * page past the fallback above), so until a first frame comes it waits this
 * long after the show instead (owner decision 2026-11-20). A page that cannot
 * render frames (hidden, or no requestAnimationFrame) keeps the fallback above.
 */
export const RESET_FIRST_FRAME_LIMIT_MS = 800;

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
 * covers the hard reset's activation wait (ACTIVATION_TIMEOUT_MS, 1.5 s, in
 * the lazy core/sw-hard-reset.ts) plus 1 s for loading that chunk and asking
 * the update machine; navigation-contract.test.ts pins the ordering. An Apply
 * already in flight is waited for until this window closes (Phase 3 C6-10).
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

/**
 * The forced update's loop guard (RO-22, train 9.0.14): "<build>:<floor>",
 * written by a forced Apply before it activates or reloads. A next document
 * of the same build, refused at a floor not above the stored one, does not
 * force the update again (a misconfigured floor, a cache-fallback load).
 */
export const FORCED_UPDATE_APPLY_KEY = 'mxqr-forced-apply';

/**
 * A Standard-room guest's last logical-connection close, "<cause> <epoch ms>",
 * kept across its disconnect reload; the next document in the tab that logs
 * info lines logs it once for `/debug console` (network/last-link-close.ts,
 * Phase 4 4B, P4-D5 B).
 */
export const PREVIOUS_LINK_CLOSE_KEY = 'mxqr-prev-close';

/**
 * When this tab's reset screen took the page down to navigate (epoch ms): the
 * next document's boot splash shows the same wordmark and loader in their
 * final place instead of drawing the wordmark again, while the stamp is under
 * 15 s old (core/session-reset.ts writes it and removes it when its document
 * stays; the next document's browser/classic-runtime/bootstrap.ts reads and
 * removes it before the app runs, and cannot import this, so
 * boot-splash.test.ts pins its copy; RO-55).
 */
export const BOOT_SPLASH_CONTINUITY_KEY = 'mxqr-boot-continuity';

/**
 * The box the reset screen centred the wordmark and loader in, as
 * "<window width>x<screen height>" (CSS px; the height is the screen's laid-out
 * height in the page's body), written beside BOOT_SPLASH_CONTINUITY_KEY when
 * the screen shows and again just before the page leaves, never while anything
 * is fullscreen. The next document's head preflight (index.html) gives its
 * continued splash that height while its own first screen is as wide and
 * within the installed iOS app's largest safe-area difference of it (the sheet
 * keeps the splash within that window of its screen), so a first screen iOS
 * gives short by the home indicator strip no longer moves them up and back
 * (inferred from the owner's report, 2026-11-16). core/session-reset.ts writes
 * it and removes it with the stamp; browser/classic-runtime/bootstrap.ts
 * removes it with the stamp; neither copy can import this (boot-splash.test.ts
 * pins them; RO-55).
 */
export const BOOT_SPLASH_CONTINUITY_BOX_KEY = 'mxqr-boot-continuity-box';

/**
 * This page's audio output recovery counts with its build and label set,
 * "<label set> <build> <every slot>", kept at each pagehide; the next
 * document in the tab reads and removes it once and shows it in
 * `/debug sync` after a reload (audio/output-recovery-counters.ts, Phase 7
 * 7A-1, owner decision Q4).
 */
export const PREVIOUS_AUDIO_RECOVERY_KEY = 'mxqr-prev-audio-recovery';
