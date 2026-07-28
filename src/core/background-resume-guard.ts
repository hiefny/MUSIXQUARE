/**
 * Converts a hidden-to-visible transition into two policy callbacks: quiet
 * recovery after short absences and a user-facing warning after longer ones.
 * Media state, AudioContext state, and wake locks can all change while a page
 * is hidden, so elapsed visibility time is only the trigger, not proof of drift.
 */

/**
 * Ignore transient visibility bounces (tab previews, DevTools focus changes,
 * mobile browser chrome) that are too short to suspend timers or audio.
 *
 * V2 wake recovery invalidates clock continuation leases before recalibrating.
 * Running it for a zero-duration bounce can therefore disrupt a healthy
 * rendezvous even though no sleep/wake actually occurred.
 */
export const DEFAULT_RECOVER_THRESHOLD_MS = 1000;

/** Reserve the disruptive warning for absences of at least one minute. */
export const DEFAULT_WARN_THRESHOLD_MS = 60 * 1000;

interface BackgroundResumeEvent {
  hiddenMs: number;
}

interface BackgroundResumeGuardDeps {
  recover: (event: BackgroundResumeEvent) => void | Promise<void>;
  warn: (event: BackgroundResumeEvent) => void | Promise<void>;
  getNow?: () => number;
  getVisibilityState?: () => DocumentVisibilityState;
  /** Hidden duration at or above which recover() runs. Default 1s. */
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

  // A page can bootstrap while hidden (opening a background tab, restored PWA
  // process, file picker hand-off). That first visible event is not a resume
  // from an established foreground session. Arm only after this guard has
  // observed an actual hidden transition.
  let hiddenAt: number | null = null;

  // Single-flight gate. `await deps.warn()` can stall on user interaction
  // (the dialog blocks until tap), so guard against stacking another
  // recover/warn pair on top from a second visibility flip mid-dialog.
  let inFlight = false;
  let pendingResume: BackgroundResumeEvent | null = null;
  let disposed = false;

  const handleResume = async (event: BackgroundResumeEvent): Promise<void> => {
    if (disposed) return;
    if (inFlight) {
      // Do not drop a second real resume while a warning dialog owns the first
      // flight. One follow-up is sufficient; retain the longest absence so its
      // warning policy cannot be weakened by later shorter tab flips.
      pendingResume = {
        hiddenMs: Math.max(pendingResume?.hiddenMs ?? 0, event.hiddenMs),
      };
      return;
    }

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
      const followUp = pendingResume;
      pendingResume = null;
      if (followUp && !disposed) void handleResume(followUp);
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

    if (hiddenMs < Math.min(recoverThresholdMs, warnThresholdMs)) return;

    void handleResume({ hiddenMs });
  };

  document.addEventListener('visibilitychange', onVisibilityChange, opts);
  deps.log?.info?.('[BackgroundResume] Guard initialized');

  return {
    dispose: () => {
      disposed = true;
      pendingResume = null;
      controller.abort();
    },
  };
}
