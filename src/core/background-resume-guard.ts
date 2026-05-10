/**
 * MUSIXQUARE — Long Background Resume Guard
 *
 * Browsers can return from a long hidden/frozen state with media timing that
 * looks normal to JS but is no longer trustworthy at the output pipeline.
 * This module detects that risky condition; callers decide how to recover and
 * how strongly to warn the local user.
 */

export const DEFAULT_LONG_BACKGROUND_RESUME_MS = 5 * 60 * 1000;

export interface BackgroundResumeEvent {
  hiddenMs: number;
}

export interface BackgroundResumeGuardDeps {
  isAtRisk: () => boolean;
  recover: (event: BackgroundResumeEvent) => void | Promise<void>;
  warn: (event: BackgroundResumeEvent) => void | Promise<void>;
  getNow?: () => number;
  getVisibilityState?: () => DocumentVisibilityState;
  longHiddenMs?: number;
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
  const getVisibilityState =
    deps.getVisibilityState ?? (() => document.visibilityState);
  const thresholdMs = deps.longHiddenMs ?? DEFAULT_LONG_BACKGROUND_RESUME_MS;

  let hiddenAt: number | null = getVisibilityState() === 'hidden' ? getNow() : null;
  let warningInFlight = false;

  const handleRiskyResume = async (event: BackgroundResumeEvent): Promise<void> => {
    if (warningInFlight) return;
    warningInFlight = true;
    deps.log?.warn?.('[BackgroundResume] Long hidden resume detected', event);

    try {
      await deps.recover(event);
    } catch (error) {
      deps.log?.warn?.('[BackgroundResume] Recovery attempt failed', error);
    }

    try {
      await deps.warn(event);
    } catch (error) {
      deps.log?.warn?.('[BackgroundResume] Warning dialog failed', error);
    } finally {
      warningInFlight = false;
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
    if (hiddenMs < thresholdMs) return;
    if (!deps.isAtRisk()) return;

    void handleRiskyResume({ hiddenMs });
  };

  document.addEventListener('visibilitychange', onVisibilityChange, opts);
  deps.log?.info?.('[BackgroundResume] Guard initialized');

  return { dispose: () => controller.abort() };
}
