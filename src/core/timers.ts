/**
 * MUSIXQUARE 2.0 — Managed Timers Registry
 * Extracted from original app.js lines 737-764
 *
 * Centralized timer management to prevent orphaned intervals/timeouts.
 */

type TimerName =
  | 'chunkWatchdog'
  | 'prepareWatchdog'
  | 'autoPlayTimer'
  | 'syncDebounce'
  | 'relayWaitTimeout'
  | 'preloadWatchdog'
  | 'heartbeatMonitor'
  | 'youtubeUILoop'
  | 'youtubeSyncLoop'
  | 'obAutoSlideTimer'
  | 'preloadScheduleTimer';

const _timers: Record<TimerName, ReturnType<typeof setTimeout> | null> = {
  chunkWatchdog: null,
  prepareWatchdog: null,
  autoPlayTimer: null,
  syncDebounce: null,
  relayWaitTimeout: null,
  preloadWatchdog: null,
  heartbeatMonitor: null,
  youtubeUILoop: null,
  youtubeSyncLoop: null,
  obAutoSlideTimer: null,
  preloadScheduleTimer: null,
};

/**
 * Set a managed timer. Automatically clears the previous timer for that name.
 */
export function setManagedTimer(
  name: TimerName,
  fn: () => void,
  delayMs: number,
  opts?: { interval?: boolean },
): void {
  clearManagedTimer(name);
  _timers[name] = opts?.interval
    ? setInterval(fn, delayMs)
    : setTimeout(fn, delayMs);
}

/**
 * Clear a specific managed timer.
 */
export function clearManagedTimer(name: TimerName): void {
  const id = _timers[name];
  if (id != null) {
    clearTimeout(id);
    clearInterval(id);
    _timers[name] = null;
  }
}

/**
 * Clear all managed timers.
 */
export function clearAllManagedTimers(): void {
  for (const name of Object.keys(_timers)) {
    clearManagedTimer(name as TimerName);
  }
}

/**
 * Get the raw timer ID (for external checks).
 */
export function getManagedTimer(name: TimerName): ReturnType<typeof setTimeout> | null {
  return _timers[name] ?? null;
}
