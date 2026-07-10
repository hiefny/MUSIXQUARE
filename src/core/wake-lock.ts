/**
 * MUSIXQUARE — Screen Wake Lock (native API)
 *
 * Why this module exists
 * ======================
 * Keep this state machine outside `app.ts` so feature modules such as
 * ui/setup-shared.ts never back-import the composition root and create a
 * bootstrap dependency cycle. The invariant
 * "app.ts is import-terminal" is enforced by scripts/check-import-graph.mjs.
 *
 * Constraints:
 *   - DEPENDENCY-FREE leaf (core/log.ts only). No bus, no timers, no state —
 *     anything heavier re-creates the cycle affordance through core/.
 *   - Best-effort only. Session liveness still comes from heartbeat/sync
 *     recovery. Enabled once when a session starts, never disabled.
 *   - `activateNoSleep()` must stay safely callable from inside a
 *     user-gesture call stack (setup-guest join handlers fire it
 *     synchronously before the async join). Do not make it async or
 *     bus-driven; it must remain in the user-gesture call stack.
 *   - The visibilitychange re-acquire wiring stays in app.ts (bootstrap
 *     owns listener installation); it calls `reacquireWakeLockIfActive()`.
 */

import { log } from './log.ts';

let _wakeLockActive = false;

async function acquireWakeLock(): Promise<void> {
  if (!('wakeLock' in navigator)) return;
  try {
    await navigator.wakeLock.request('screen');
    log.debug('[WakeLock] Wake Lock acquired');
  } catch (err) {
    // Swallow rejections (low-battery policy, hidden document, …) WITHOUT
    // unsetting the active flag: the visibilitychange re-acquire path must
    // keep retrying on the next visibility bounce.
    log.warn('[WakeLock] Wake Lock request failed:', err);
  }
}

/**
 * Mark keep-awake as wanted for the rest of the page lifetime and fire a
 * best-effort wake-lock request. Idempotent — subsequent calls no-op.
 */
export function activateNoSleep(): void {
  if (_wakeLockActive) return;
  _wakeLockActive = true;
  void acquireWakeLock();
}

/**
 * Re-request the wake lock if a session ever activated it. Browsers silently
 * release wake locks when the tab is hidden; bootstrap calls this from its
 * visibilitychange handler and from long-background recovery. No-ops when
 * `activateNoSleep()` was never called.
 */
export function reacquireWakeLockIfActive(): void {
  if (_wakeLockActive) void acquireWakeLock();
}

/**
 * @internal Test-only helper to reset the module-scoped flag between test
 * cases (same precedent as core/page-lifecycle.ts's
 * `__resetIntentionalNavForTests`). Production code must NOT call this —
 * wake-lock activation is one-shot for the lifetime of the page.
 */
export function __resetWakeLockForTests(): void {
  _wakeLockActive = false;
}
