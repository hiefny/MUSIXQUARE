/** Page-wide named timer registry used for centralized cleanup. */

interface ManagedTimer {
  handle: ReturnType<typeof setTimeout>;
  interval: boolean;
}

const _timers = new Map<string, ManagedTimer>();

type ManagedTimerCallback = () => unknown;

function runManagedTimerCallback(name: string, fn: ManagedTimerCallback): void {
  try {
    const result = fn();
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      typeof (result as PromiseLike<unknown>).then === 'function'
    ) {
      void Promise.resolve(result).catch((error) => {
        console.error(`[Timer] "${name}" rejected:`, error);
      });
    }
  } catch (error) {
    console.error(`[Timer] "${name}" threw:`, error);
  }
}

/**
 * Set a managed timer. Automatically clears the previous timer for that name.
 * Names are page-global singleton keys. Concurrent owners must parameterize
 * them or a later registration silently replaces the earlier timer.
 */
export function setManagedTimer(
  name: string,
  fn: ManagedTimerCallback,
  delayMs: number,
  opts?: { interval?: boolean },
): void {
  clearManagedTimer(name);
  const interval = opts?.interval === true;
  const handle = interval
    ? setInterval(() => {
        runManagedTimerCallback(name, fn);
      }, delayMs)
    : setTimeout(() => {
        _timers.delete(name);
        runManagedTimerCallback(name, fn);
      }, delayMs);
  _timers.set(name, { handle, interval });
}

export function clearManagedTimer(name: string): void {
  const timer = _timers.get(name);
  if (timer) {
    if (timer.interval) clearInterval(timer.handle);
    else clearTimeout(timer.handle);
    _timers.delete(name);
  }
}

/**
 * Clear every managed timer except explicitly page-lifetime owners.
 *
 * The registry is page-global, so session teardown must name any timers that
 * intentionally outlive a room instead of silently cancelling them.
 */
export function clearAllManagedTimers(options: { except?: readonly string[] } = {}): void {
  const exceptions = new Set(options.except ?? []);
  for (const name of Array.from(_timers.keys())) {
    if (exceptions.has(name)) continue;
    clearManagedTimer(name);
  }
}

export function getManagedTimer(name: string): ReturnType<typeof setTimeout> | null {
  return _timers.get(name)?.handle ?? null;
}

/**
 * Promise-based delay. It is intentionally not registered or cancellable;
 * operation-scoped waits should use an AbortSignal-aware mechanism instead.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
