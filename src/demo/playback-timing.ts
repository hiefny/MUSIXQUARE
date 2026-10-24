import {
  HOST_TIMELINE_TRUST_WINDOW_MS,
  LOCAL_FILE_START_LEAD_MS,
} from '../player/file-play-timing.ts';

/**
 * Legacy guests join after the host's start by this historical lead. A wire
 * contract with already-shipped demo receivers: never unify it with the 200 ms
 * PLAY lead (LEGACY_FILE_SCHEDULE_AHEAD_MS) or with DEMO_PLAY_START_LEAD_MS.
 */
export const DEMO_PLAY_SCHEDULE_AHEAD_MS = 350;
/**
 * Prepared demo participants share a short start without waiting for downloads.
 * The same lead as a local-file shared start; aliased here so it loads only
 * with the lazy demo runtime.
 */
export const DEMO_PLAY_START_LEAD_MS = LOCAL_FILE_START_LEAD_MS;

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
    const useHostTimeline = waitMs !== null && waitMs < HOST_TIMELINE_TRUST_WINDOW_MS;
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
  const useHostTimeline = waitMs !== null && waitMs < HOST_TIMELINE_TRUST_WINDOW_MS;
  const delayMs = useHostTimeline ? Math.max(0, waitMs) : 0;
  const elapsedMs = useHostTimeline
    ? Math.max(0, hostNow! + delayMs - (intent.hostPlayAt - DEMO_PLAY_SCHEDULE_AHEAD_MS))
    : Math.max(0, now - intent.receivedAt);
  const position = intent.time + elapsedMs / 1_000;
  const ended = Number.isFinite(duration) && duration > 0 && position >= duration;
  return { position: ended ? duration : position, delay: delayMs / 1_000, ended };
}
