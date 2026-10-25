import {
  HOST_TIMELINE_TRUST_WINDOW_MS,
  LOCAL_FILE_START_LEAD_MS,
} from '../player/file-play-timing.ts';

/**
 * A host sends DEMO_PLAY's hostPlayAt as its start plus this historical lead.
 * Demo guests before the old-version removal train (9.0.12 and older) require
 * the field and read it only to gate their host clock; this build ignores it.
 * Hosts may stop sending it only after a client floor at or above the release
 * that carries OV-B02 stage 1 (survey OV-F05). Never unify it with
 * DEMO_PLAY_START_LEAD_MS.
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
  /** Host-clock instant at which `time` becomes the shared demo position. */
  readonly hostStartAt: number;
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
  // A command remains projectable after a long download. Only an implausibly
  // future start falls back to the short local lead.
  const waitMs = hostNow !== null ? intent.hostStartAt - hostNow : null;
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
