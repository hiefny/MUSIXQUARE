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
    : setTimeout(fn, delayMs);
  _timers.set(name, id);
}

/**
 * Clear a specific managed timer.
 */
export function clearManagedTimer(name: string): void {
  const id = _timers.get(name);
  if (id != null) {
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
