/** Page-wide named timer registry used for centralized cleanup. */

const _timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Set a managed timer. Automatically clears the previous timer for that name.
 * Names are page-global singleton keys. Concurrent owners must parameterize
 * them or a later registration silently replaces the earlier timer.
 */
export function setManagedTimer(
  name: string,
  fn: () => void,
  delayMs: number,
  opts?: { interval?: boolean },
): void {
  clearManagedTimer(name);
  const id = opts?.interval
    ? setInterval(() => {
        try {
          fn();
        } catch (e) {
          console.error(`[Timer] "${name}" threw:`, e);
        }
      }, delayMs)
    : setTimeout(() => {
        _timers.delete(name);
        try {
          fn();
        } catch (e) {
          console.error(`[Timer] "${name}" threw:`, e);
        }
      }, delayMs);
  _timers.set(name, id);
}

export function clearManagedTimer(name: string): void {
  const id = _timers.get(name);
  if (id != null) {
    // Browser timeout and interval IDs share a pool, so both clears accept the
    // stored ID regardless of which API created it.
    clearTimeout(id);
    clearInterval(id);
    _timers.delete(name);
  }
}

export function clearAllManagedTimers(): void {
  for (const name of Array.from(_timers.keys())) {
    clearManagedTimer(name);
  }
}

export function getManagedTimer(name: string): ReturnType<typeof setTimeout> | null {
  return _timers.get(name) ?? null;
}

/**
 * Promise-based delay. It is intentionally not registered or cancellable;
 * operation-scoped waits should use an AbortSignal-aware mechanism instead.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
