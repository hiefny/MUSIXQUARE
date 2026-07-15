import {
  acquireFilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleLease,
} from './file-playback-universal-lifecycle-diagnostics.ts';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

interface FilePlaybackUniversalLifecycleDelayRuntime {
  readonly acquireTimerLease: () => FilePlaybackUniversalLifecycleLease;
  readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimeout: (timer: TimerHandle) => void;
}

interface FilePlaybackUniversalLifecycleDelay {
  readonly promise: Promise<void>;
  readonly cancel: () => void;
}

const defaultRuntime: FilePlaybackUniversalLifecycleDelayRuntime = Object.freeze({
  acquireTimerLease: () => acquireFilePlaybackUniversalLifecycleLease('timers'),
  setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer: TimerHandle) => globalThis.clearTimeout(timer),
});

function unrefTimer(timer: TimerHandle): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Cancellable deadline whose native handle is represented in the universal
 * lifecycle ledger. A failed cancellation is sticky-unconfirmed: resolving
 * the logical delay must never manufacture a false physical zero.
 */
export function createFilePlaybackUniversalLifecycleDelay(
  delayMs: number,
  runtime: FilePlaybackUniversalLifecycleDelayRuntime = defaultRuntime,
): FilePlaybackUniversalLifecycleDelay {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new RangeError('Lifecycle delay must be an integer from 0 to 60000 milliseconds');
  }
  const timerLease = runtime.acquireTimerLease();
  let timer: TimerHandle | null = null;
  let arming = true;
  let firedWhileArming = false;
  let settled = false;
  let resolveDelay!: () => void;
  let rejectDelay!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveDelay = resolve;
    rejectDelay = reject;
  });
  const settle = (failed: boolean, error?: unknown, timerFired = false) => {
    if (settled) return;
    settled = true;
    let timerRetirementConfirmed = timerFired || timer === null;
    if (timer !== null && !timerFired) {
      try {
        runtime.clearTimeout(timer);
        timerRetirementConfirmed = true;
      } catch {
        timerRetirementConfirmed = false;
      }
    }
    timer = null;
    if (timerRetirementConfirmed) timerLease.beginRetire().release();
    else timerLease.forceUnconfirmed();
    if (failed) rejectDelay(error);
    else resolveDelay();
  };
  try {
    timer = runtime.setTimeout(() => {
      if (arming) {
        firedWhileArming = true;
        return;
      }
      settle(false, undefined, true);
    }, delayMs);
    arming = false;
    if (firedWhileArming) settle(false, undefined, true);
    else unrefTimer(timer);
  } catch (error) {
    arming = false;
    settle(true, error);
  }
  return Object.freeze({
    promise,
    cancel: () => settle(false),
  });
}
