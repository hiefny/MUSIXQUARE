import { getHostNow, isClockCalibrated } from '../network/shared-clock.ts';

/**
 * Short shared start lead; guests never hold the host waiting for a decoder.
 * The guided demo uses the same lead (DEMO_PLAY_START_LEAD_MS aliases it).
 */
export const LOCAL_FILE_START_LEAD_MS = 200;
/**
 * Older PLAY receivers interpret hostPlayAt as command time plus this lead.
 * A wire contract with already-shipped receivers: never unify it with
 * LOCAL_FILE_START_LEAD_MS or with the demo's 350 ms DEMO_PLAY_SCHEDULE_AHEAD_MS,
 * even where the values match.
 */
export const LEGACY_FILE_SCHEDULE_AHEAD_MS = 200;
/**
 * A calibrated host deadline further than this from the host clock is not
 * trusted as the guest's timeline. Each guest projection keeps its own
 * predicate: the local-file check below is two-sided, the demo projection
 * (demo/playback-timing.ts) only bounds deadlines ahead.
 */
export const HOST_TIMELINE_TRUST_WINDOW_MS = 2_000;
/**
 * A guest that started a shared start (local file, preload, guided demo) asks
 * the host for an immediate clock ping this long afterwards.
 */
export const GUEST_START_SYNC_PING_DELAY_MS = 250;

interface FilePlayTimeline {
  readonly time: number;
  /** Participant-local wall time at which the timeline reaches `time`. */
  readonly setAt: number;
  /** Same anchor on the monotonic clock; OS wall-clock edits cannot move it. */
  readonly monotonicSetAt: number;
  readonly needsClockSync: boolean;
}

/** Capture once on receipt, before routing, fetching or decoding can await. */
export function captureGuestFilePlayTiming(
  data: Record<string, unknown>,
  time: number,
): FilePlayTimeline {
  const receivedAt = Date.now();
  const receivedMonotonicAt = performance.now();
  const hasSharedStart = typeof data.hostStartAt === 'number' && data.hostStartAt > 0;
  const hostAnchor = hasSharedStart ? data.hostStartAt : data.hostPlayAt;
  const hasAnchor = typeof hostAnchor === 'number' && Number.isFinite(hostAnchor) && hostAnchor > 0;
  const calibrated = isClockCalibrated();

  if (hasAnchor && calibrated) {
    const remainingMs = hostAnchor - getHostNow();
    if (Math.abs(remainingMs) < HOST_TIMELINE_TRUST_WINDOW_MS) {
      return {
        time: time + (hasSharedStart ? 0 : LEGACY_FILE_SCHEDULE_AHEAD_MS / 1_000),
        setAt: receivedAt + remainingMs,
        monotonicSetAt: receivedMonotonicAt + remainingMs,
        needsClockSync: false,
      };
    }
  }

  // A new guest's wall clock can differ arbitrarily from the host. Give a
  // shared-start frame only the short local lead, then let its first calibrated
  // PONG align playback; never derive a position from an uncalibrated clock.
  return {
    time,
    setAt: receivedAt + (hasSharedStart ? LOCAL_FILE_START_LEAD_MS : 0),
    monotonicSetAt: receivedMonotonicAt + (hasSharedStart ? LOCAL_FILE_START_LEAD_MS : 0),
    needsClockSync: hasAnchor && !calibrated,
  };
}

/** Resolve the same timeline after any preparation delay, including late decode. */
export function resolveFilePlayTiming(
  time: number,
  setAt: number,
  monotonicSetAt?: number | null,
): {
  offset: number;
  scheduleDelay: number;
  scheduleDeadlineMs: number;
} {
  const monotonicNow = performance.now();
  const remainingMs =
    monotonicSetAt != null ? monotonicSetAt - monotonicNow : setAt === 0 ? 0 : setAt - Date.now();
  const delayMs = Math.max(0, remainingMs);
  return {
    offset: time + Math.max(0, -remainingMs) / 1_000,
    scheduleDelay: delayMs / 1_000,
    // Transport consumes this absolute deadline after AudioContext setup and
    // any play-lock wait, so neither delay nor elapsed time is counted twice.
    scheduleDeadlineMs: monotonicNow + delayMs,
  };
}
