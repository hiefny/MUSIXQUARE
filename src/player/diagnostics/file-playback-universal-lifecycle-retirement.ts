import {
  acquireFilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleLease,
} from './file-playback-universal-lifecycle-diagnostics.ts';

const FILE_PLAYBACK_UNIVERSAL_RETIREMENT_TIMEOUT_MS = 5_000;

type FilePlaybackUniversalLifecycleRetirementOutcome = 'released' | 'unconfirmed';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

interface FilePlaybackUniversalLifecycleRetirementRuntime {
  readonly acquireTimerLease: () => FilePlaybackUniversalLifecycleLease;
  readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimeout: (timer: TimerHandle) => void;
}

const defaultRuntime: FilePlaybackUniversalLifecycleRetirementRuntime = Object.freeze({
  acquireTimerLease: () => acquireFilePlaybackUniversalLifecycleLease('timers'),
  setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer: TimerHandle) => globalThis.clearTimeout(timer),
});

function configuredTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw new RangeError('Lifecycle retirement timeout must be a positive integer up to 60000');
  }
  return value;
}

function unrefTimer(timer: TimerHandle): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Turns a logical close into a physically confirmed lifecycle retirement.
 *
 * The resource stays `retiring` until cleanup settles successfully. Rejection,
 * a synchronous cleanup failure, or a missing acknowledgement at the bounded
 * deadline is sticky `unconfirmed`; a late settlement can never turn it into a
 * false clean zero. The deadline handle is itself part of the timer ledger.
 */
export function confirmFilePlaybackUniversalLifecycleRetirement(
  lease: FilePlaybackUniversalLifecycleLease,
  cleanup: () => void | PromiseLike<void>,
  timeoutMs = FILE_PLAYBACK_UNIVERSAL_RETIREMENT_TIMEOUT_MS,
  runtime: FilePlaybackUniversalLifecycleRetirementRuntime = defaultRuntime,
): Promise<FilePlaybackUniversalLifecycleRetirementOutcome> {
  const durationMs = configuredTimeout(timeoutMs);
  const retirement = lease.beginRetire();
  let timerLease: FilePlaybackUniversalLifecycleLease;
  try {
    timerLease = runtime.acquireTimerLease();
  } catch {
    retirement.forceUnconfirmed();
    return Promise.resolve('unconfirmed');
  }
  let timer: TimerHandle | null = null;
  let timerFired = false;
  let settleTimeout!: () => void;
  const timeout = new Promise<void>((resolve) => {
    settleTimeout = resolve;
  });

  try {
    timer = runtime.setTimeout(() => {
      timerFired = true;
      settleTimeout();
    }, durationMs);
    unrefTimer(timer);
  } catch {
    let timerRetirementConfirmed = timerFired || timer === null;
    if (timer !== null && !timerFired) {
      try {
        runtime.clearTimeout(timer);
        timerRetirementConfirmed = true;
      } catch {
        timerRetirementConfirmed = false;
      }
    }
    if (timerRetirementConfirmed) timerLease.beginRetire().release();
    else timerLease.forceUnconfirmed();
    timer = null;
    retirement.forceUnconfirmed();
    return Promise.resolve('unconfirmed');
  }

  let cleanupResult: Promise<'released' | 'unconfirmed'>;
  try {
    cleanupResult = Promise.resolve(cleanup()).then(
      () => 'released' as const,
      () => 'unconfirmed' as const,
    );
  } catch {
    cleanupResult = Promise.resolve('unconfirmed');
  }

  const timeoutResult = timeout.then(() => 'unconfirmed' as const);
  return Promise.race([cleanupResult, timeoutResult]).then((outcome) => {
    let timerRetirementConfirmed = timerFired;
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
    if (outcome === 'released') retirement.release();
    else retirement.forceUnconfirmed();
    return outcome;
  });
}
