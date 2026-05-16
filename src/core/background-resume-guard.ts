/**
 * MUSIXQUARE — Background Resume Guard
 *
 * Browsers can return from a hidden tab with media timing that looks fine
 * to JS but is no longer trustworthy at the output pipeline. Mobile is
 * the worst offender: even a brief switch to a chat app can leave the
 * audio context interrupted or the wake lock released.
 *
 * The signal fans into two tiers so we can be aggressive about silent
 * recovery without nagging the user every time they peek at a notification.
 *
 *   recover()  Silent housekeeping (resume audio context, reacquire wake
 *              lock, nudge sync). Cheap and idempotent, so we run it on
 *              every return from hidden, even after a five-second swap.
 *
 *   warn()     User-facing modal. Interrupts flow and offers "leave
 *              session", so it only fires after a meaningful absence
 *              where a restart hint actually helps.
 */

/** recover() runs on any return from hidden, however brief. */
export const DEFAULT_RECOVER_THRESHOLD_MS = 0;

/**
 * warn() only fires after a one-minute absence. Short tab swaps for chat
 * replies and notification checks recover silently underneath.
 */
export const DEFAULT_WARN_THRESHOLD_MS = 60 * 1000;

export interface BackgroundResumeEvent {
  hiddenMs: number;
}

export interface BackgroundResumeGuardDeps {
  recover: (event: BackgroundResumeEvent) => void | Promise<void>;
  warn: (event: BackgroundResumeEvent) => void | Promise<void>;
  getNow?: () => number;
  getVisibilityState?: () => DocumentVisibilityState;
  /** Hidden duration at or above which recover() runs. Default 0. */
  recoverThresholdMs?: number;
  /** Hidden duration at or above which warn() runs. Should be >= recoverThresholdMs. Default 60s. */
  warnThresholdMs?: number;
  log?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
  };
}

export interface BackgroundResumeGuardHandle {
  dispose: () => void;
}

export function initBackgroundResumeGuard(
  deps: BackgroundResumeGuardDeps,
): BackgroundResumeGuardHandle {
  const controller = new AbortController();
  const opts = { signal: controller.signal };
  const getNow = deps.getNow ?? (() => Date.now());
  const getVisibilityState = deps.getVisibilityState ?? (() => document.visibilityState);
  const recoverThresholdMs = deps.recoverThresholdMs ?? DEFAULT_RECOVER_THRESHOLD_MS;
  const warnThresholdMs = deps.warnThresholdMs ?? DEFAULT_WARN_THRESHOLD_MS;

  let hiddenAt: number | null = getVisibilityState() === 'hidden' ? getNow() : null;

  // Single-flight gate. `await deps.warn()` can stall on user interaction
  // (the dialog blocks until tap), so guard against stacking another
  // recover/warn pair on top from a second visibility flip mid-dialog.
  let inFlight = false;

  const handleResume = async (event: BackgroundResumeEvent): Promise<void> => {
    if (inFlight) return;

    const shouldRecover = event.hiddenMs >= recoverThresholdMs;
    const shouldWarn = event.hiddenMs >= warnThresholdMs;
    if (!shouldRecover && !shouldWarn) return;

    inFlight = true;
    deps.log?.warn?.('[BackgroundResume] Hidden resume detected', {
      hiddenMs: event.hiddenMs,
      willWarn: shouldWarn,
    });

    try {
      if (shouldRecover) {
        try {
          await deps.recover(event);
        } catch (error) {
          deps.log?.warn?.('[BackgroundResume] Recovery attempt failed', error);
        }
      }
      if (shouldWarn) {
        try {
          await deps.warn(event);
        } catch (error) {
          deps.log?.warn?.('[BackgroundResume] Warning dialog failed', error);
        }
      }
    } finally {
      inFlight = false;
    }
  };

  const onVisibilityChange = (): void => {
    const visibility = getVisibilityState();
    const now = getNow();

    if (visibility === 'hidden') {
      hiddenAt = now;
      return;
    }

    if (visibility !== 'visible' || hiddenAt === null) return;

    const hiddenMs = now - hiddenAt;
    hiddenAt = null;

    // Skip the closure entirely when neither tier could fire.
    if (hiddenMs < Math.min(recoverThresholdMs, warnThresholdMs)) return;

    void handleResume({ hiddenMs });
  };

  document.addEventListener('visibilitychange', onVisibilityChange, opts);
  deps.log?.info?.('[BackgroundResume] Guard initialized');

  return { dispose: () => controller.abort() };
}
