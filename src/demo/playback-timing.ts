/** Legacy guests join after the host's start by this historical lead. */
export const DEMO_PLAY_SCHEDULE_AHEAD_MS = 350;
/** Prepared demo participants share a short start without waiting for downloads. */
export const DEMO_PLAY_START_LEAD_MS = 200;

let demoHostStartAt: number | null = null;

export function setDemoHostStartAt(timestamp: number | null): void {
  demoHostStartAt = timestamp !== null && Number.isFinite(timestamp) ? timestamp : null;
}

/** Published by the exact host output owner; load, pause and exit revoke it. */
export function getPendingDemoHostStartAt(): number | undefined {
  return demoHostStartAt !== null && demoHostStartAt > Date.now() ? demoHostStartAt : undefined;
}

interface DemoPlayTiming {
  readonly time: number;
  readonly hostPlayAt: number;
  readonly hostStartAt?: number;
  readonly receivedAt: number;
}

export function projectDemoPlay(
  intent: DemoPlayTiming,
  now: number,
  calibratedHostNow: number | null,
  duration: number,
): { position: number; delay: number; ended: boolean } {
  const hostNow =
    calibratedHostNow !== null && Number.isFinite(calibratedHostNow) ? calibratedHostNow : null;
  if (Number.isFinite(intent.hostStartAt) && Number(intent.hostStartAt) > 0) {
    const hostStartAt = Number(intent.hostStartAt);
    const waitMs = hostNow !== null ? hostStartAt - hostNow : null;
    const useHostTimeline = waitMs !== null && waitMs < 2_000;
    const localStartAt = intent.receivedAt + DEMO_PLAY_START_LEAD_MS;
    const remainingMs = useHostTimeline ? waitMs : localStartAt - now;
    const position = intent.time + Math.max(0, -remainingMs) / 1_000;
    const ended = Number.isFinite(duration) && duration > 0 && position >= duration;
    return {
      position: ended ? duration : position,
      delay: Math.max(0, remainingMs) / 1_000,
      ended,
    };
  }
  const waitMs = hostNow !== null && intent.hostPlayAt > 0 ? intent.hostPlayAt - hostNow : null;
  // Old commands remain projectable after a long download. Only implausibly
  // future deadlines fall back to the time spent waiting on this device.
  const useHostTimeline = waitMs !== null && waitMs < 2_000;
  const delayMs = useHostTimeline ? Math.max(0, waitMs) : 0;
  const elapsedMs = useHostTimeline
    ? Math.max(0, hostNow! + delayMs - (intent.hostPlayAt - DEMO_PLAY_SCHEDULE_AHEAD_MS))
    : Math.max(0, now - intent.receivedAt);
  const position = intent.time + elapsedMs / 1_000;
  const ended = Number.isFinite(duration) && duration > 0 && position >= duration;
  return { position: ended ? duration : position, delay: delayMs / 1_000, ended };
}
