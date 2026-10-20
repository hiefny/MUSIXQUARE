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
 * Wake recovery invalidates clock continuation leases before recalibrating.
 * Running it for a zero-duration bounce can therefore disrupt a healthy
 * rendezvous even though no sleep/wake actually occurred.
 *
 * This is also the only threshold of the background-return Sync that ends
 * every recovery (player/background-return-sync.ts): each hidden period of at
 * least this long counts as a return from the background and is synced.
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
  /** Session/room ownership can disappear while recovery awaits browser APIs. */
  shouldHandle?: (event: BackgroundResumeEvent) => boolean;
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
  // The flight's warning has been asked for and is not answered yet.
  let warningOpen = false;
  // hiddenMs drives recovery; uncoveredHiddenMs is the longest absence that
  // ended before any warning of the current flight was shown.
  let pendingResume: { hiddenMs: number; uncoveredHiddenMs: number } | null = null;
  let disposed = false;

  const reportDetachedResumeFailure = (error: unknown): void => {
    deps.log?.warn?.('[BackgroundResume] Detached resume task failed', error);
  };

  const handleResume = async (
    event: BackgroundResumeEvent,
    warnHiddenMs = event.hiddenMs,
  ): Promise<void> => {
    if (disposed) return;
    if (deps.shouldHandle && !deps.shouldHandle(event)) return;
    if (inFlight) {
      // Do not drop a second real resume while a warning dialog owns the first
      // flight. One follow-up is sufficient; retain the longest absence so its
      // recovery cannot be weakened by later shorter tab flips. An absence
      // that ends while the warning is on screen is covered by that warning,
      // so its follow-up only recovers (owner decision 2026-10-17).
      pendingResume = {
        hiddenMs: Math.max(pendingResume?.hiddenMs ?? 0, event.hiddenMs),
        uncoveredHiddenMs: warningOpen
          ? (pendingResume?.uncoveredHiddenMs ?? 0)
          : Math.max(pendingResume?.uncoveredHiddenMs ?? 0, warnHiddenMs),
      };
      return;
    }

    const shouldRecover = event.hiddenMs >= recoverThresholdMs;
    const shouldWarn = warnHiddenMs >= warnThresholdMs;
    if (!shouldRecover && !shouldWarn) return;

    inFlight = true;
    deps.log?.warn?.('[BackgroundResume] Hidden resume detected', {
      hiddenMs: event.hiddenMs,
      willWarn: shouldWarn,
    });

    try {
      if (shouldRecover && (!deps.shouldHandle || deps.shouldHandle(event))) {
        try {
          await deps.recover(event);
        } catch (error) {
          deps.log?.warn?.('[BackgroundResume] Recovery attempt failed', error);
        }
      }
      // Recovery can await AudioContext/RTC work while the user leaves the
      // room. Re-check ownership so an obsolete resume never opens a dialog.
      if (shouldWarn && (!deps.shouldHandle || deps.shouldHandle(event))) {
        // This warning appears after every absence queued so far, so it
        // covers them as well as the ones that end while it is open.
        warningOpen = true;
        if (pendingResume) pendingResume.uncoveredHiddenMs = 0;
        try {
          await deps.warn(event);
        } catch (error) {
          deps.log?.warn?.('[BackgroundResume] Warning dialog failed', error);
        } finally {
          warningOpen = false;
        }
      }
    } finally {
      inFlight = false;
      const followUp = pendingResume;
      pendingResume = null;
      if (followUp && !disposed) {
        handleResume({ hiddenMs: followUp.hiddenMs }, followUp.uncoveredHiddenMs).catch(
          reportDetachedResumeFailure,
        );
      }
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

    handleResume({ hiddenMs }).catch(reportDetachedResumeFailure);
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
