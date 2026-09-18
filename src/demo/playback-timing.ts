/** The host starts locally when it publishes a future guest rendezvous. */
export const DEMO_PLAY_SCHEDULE_AHEAD_MS = 350;

interface DemoPlayTiming {
  readonly time: number;
  readonly hostPlayAt: number;
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
