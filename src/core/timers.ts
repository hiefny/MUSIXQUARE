/**
 * MUSIXQUARE 2.0 — Managed Timers Registry
 * Extracted from original app.js lines 737-764
 *
 * Centralized timer management to prevent orphaned intervals/timeouts.
 * Timer names are plain strings — any module can register its own.
 */

const _timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Set a managed timer. Automatically clears the previous timer for that name.
 */
export function setManagedTimer(
  name: string,
  fn: () => void,
  delayMs: number,
  opts?: { interval?: boolean },
): void {
  clearManagedTimer(name);
  const id = opts?.interval
    ? setInterval(fn, delayMs)
    : setTimeout(() => {
        _timers.delete(name);
        fn();
      }, delayMs);
  _timers.set(name, id);
}

/**
 * Clear a specific managed timer.
 */
export function clearManagedTimer(name: string): void {
  const id = _timers.get(name);
  if (id != null) {
    // Both clearTimeout and clearInterval are called because the managed timer
    // system stores a single ID regardless of whether it was created with
    // setTimeout or setInterval. Per the HTML spec, timer IDs share a single
    // numbering pool and both clear functions accept either type, so calling
    // both is safe and ensures the timer is cleared regardless of its origin.
    clearTimeout(id);
    clearInterval(id);
    _timers.delete(name);
  }
}

/**
 * Clear all managed timers.
 */
export function clearAllManagedTimers(): void {
  for (const name of _timers.keys()) {
    clearManagedTimer(name);
  }
}

/**
 * Get the raw timer ID (for external checks).
 */
export function getManagedTimer(name: string): ReturnType<typeof setTimeout> | null {
  return _timers.get(name) ?? null;
}
