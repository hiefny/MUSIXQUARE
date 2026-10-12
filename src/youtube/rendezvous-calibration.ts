import { getClockOffset, getHostNow, isClockCalibrated } from '../network/shared-clock.ts';
import { recordStandardStartObservation } from '../diagnostics/standard-start-observations.ts';
import {
  LATENCY_CLAMP_MAX_MS,
  LATENCY_EMA_RATE,
  LATENCY_OUTLIER_REJECT_MS,
  RENDEZVOUS_CALIBRATE_DELAY_MS,
} from './constants.ts';

// These are learning eligibility tolerances, not changes to SharedClock's policy.
const CLOCK_OFFSET_TOLERANCE_MS = 5;
const WALL_MONOTONIC_TOLERANCE_MS = 50;
let nextOperationId = 0;

interface RendezvousClockReading {
  hostMs: number;
  offsetMs: number;
  wallMs: number;
  monotonicMs: number;
  calibrated: boolean;
}

export function captureRendezvousClock(): RendezvousClockReading {
  return {
    monotonicMs: performance.now(),
    wallMs: Date.now(),
    hostMs: getHostNow(),
    offsetMs: getClockOffset(),
    calibrated: isClockCalibrated(),
  };
}

type SampleReason =
  | 'eligible'
  | 'clock-changed'
  | 'invalid-sample'
  | 'hidden'
  | 'stale-snapshot'
  | 'video-mismatch'
  | 'not-playing'
  | 'near-end'
  | 'outlier'
  | 'player-read-failed';

/** One precision rendezvous owns its plan, timer scheduling, release and sample. */
export function createRendezvousCalibration(
  planned: RendezvousClockReading,
  plannedHostPlayAtMs: number,
  effectiveLeadMs: number,
  manualOffsetSeconds: number,
) {
  const operationId = ++nextOperationId;
  // Preserve the original signed deadline, including time spent waiting for the
  // buffer. A zero-delay release timer may already be late when it is created.
  const plannedPlayAtMs = planned.monotonicMs + plannedHostPlayAtMs - planned.hostMs;
  let scheduled: RendezvousClockReading | null = null;
  let released: RendezvousClockReading | null = null;
  let releaseLatenessMs = 0;
  // This path seeks once during preparation and never seeks forward at release.
  // Do not import the PRO arm's release-time catch-up or count its correction here.
  const appliedCatchUpMs = 0;
  const base = {
    operationId,
    plannedPlayAtMs,
    plannedHostPlayAtMs,
    plannedClockOffsetMs: planned.offsetMs,
    plannedWallMs: planned.wallMs,
    plannedMonotonicMs: planned.monotonicMs,
    plannedClockCalibrated: planned.calibrated,
    manualOffsetSeconds,
    effectiveLeadMs,
  };
  recordStandardStartObservation('youtube-rendezvous-start', base);

  function sample(
    driftMs: number | null,
    current: number | null,
    reason: SampleReason,
  ): number | null {
    const sampled = captureRendezvousClock();
    const readings = [
      planned,
      ...(scheduled ? [scheduled] : []),
      ...(released ? [released] : []),
      sampled,
    ];
    const offsets = readings.map((clock) => clock.offsetMs);
    const mappings = readings.map((clock) => clock.wallMs - clock.monotonicMs);
    const clockOffsetSpanMs = Math.max(...offsets) - Math.min(...offsets);
    const clockMappingSpanMs = Math.max(...mappings) - Math.min(...mappings);
    const clockStable =
      scheduled !== null &&
      released !== null &&
      readings.every(
        (clock) =>
          clock.calibrated &&
          [clock.hostMs, clock.offsetMs, clock.wallMs, clock.monotonicMs].every(Number.isFinite),
      ) &&
      clockOffsetSpanMs <= CLOCK_OFFSET_TOLERANCE_MS &&
      clockMappingSpanMs <= WALL_MONOTONIC_TOLERANCE_MS &&
      sampled.monotonicMs >= released.monotonicMs &&
      released.monotonicMs >= scheduled.monotonicMs &&
      scheduled.monotonicMs >= planned.monotonicMs;
    const uncorrectedLatenessMs = Math.max(0, releaseLatenessMs - appliedCatchUpMs);
    const learningDriftMs = driftMs === null ? null : driftMs + uncorrectedLatenessMs;
    let verdict = reason;
    if (verdict === 'eligible' && !clockStable) verdict = 'clock-changed';
    if (
      verdict === 'eligible' &&
      (driftMs === null ||
        current === null ||
        ![driftMs, learningDriftMs, current, uncorrectedLatenessMs].every(Number.isFinite))
    ) {
      verdict = 'invalid-sample';
    }
    if (
      verdict === 'eligible' &&
      (Math.abs(driftMs!) > LATENCY_OUTLIER_REJECT_MS ||
        Math.abs(learningDriftMs!) > LATENCY_OUTLIER_REJECT_MS)
    ) {
      verdict = 'outlier';
    }
    const next =
      verdict === 'eligible'
        ? Math.round(
            Math.max(
              0,
              Math.min(LATENCY_CLAMP_MAX_MS, current! - learningDriftMs! * LATENCY_EMA_RATE),
            ),
          )
        : null;
    recordStandardStartObservation('youtube-rendezvous-sample', {
      ...base,
      scheduledAtMs: scheduled?.monotonicMs ?? null,
      scheduledClockOffsetMs: scheduled?.offsetMs ?? null,
      scheduledClockCalibrated: scheduled?.calibrated ?? false,
      releasedAtMs: released?.monotonicMs ?? null,
      sampledAtMs: sampled.monotonicMs,
      releaseClockOffsetMs: released?.offsetMs ?? null,
      sampleClockOffsetMs: sampled.offsetMs,
      releaseClockCalibrated: released?.calibrated ?? false,
      sampleClockCalibrated: sampled.calibrated,
      clockOffsetDeltaMs: released ? sampled.offsetMs - released.offsetMs : null,
      clockMappingDeltaMs: released
        ? sampled.wallMs - sampled.monotonicMs - (released.wallMs - released.monotonicMs)
        : null,
      clockOffsetSpanMs,
      clockMappingSpanMs,
      clockToleranceMs: CLOCK_OFFSET_TOLERANCE_MS,
      wallToleranceMs: WALL_MONOTONIC_TOLERANCE_MS,
      clockStable,
      releaseLatenessMs,
      appliedCatchUpMs,
      uncorrectedLatenessMs,
      sampleLatenessMs: released
        ? Math.max(0, sampled.monotonicMs - released.monotonicMs - RENDEZVOUS_CALIBRATE_DELAY_MS)
        : null,
      timelineDriftMs: driftMs,
      learningDriftMs,
      previousLatencyMs: current,
      nextLatencyMs: next,
      eligible: verdict === 'eligible',
      reason: verdict,
    });
    return next;
  }

  return {
    schedule(clock: RendezvousClockReading): void {
      // Use the exact reading used for waitMs. A transient change while the
      // buffer is preparing can move the timer even if it reverses by release.
      scheduled = clock;
    },
    release(): void {
      released = captureRendezvousClock();
      releaseLatenessMs = Math.max(0, released.monotonicMs - plannedPlayAtMs);
      recordStandardStartObservation('youtube-rendezvous-release', {
        ...base,
        scheduledAtMs: scheduled?.monotonicMs ?? null,
        scheduledClockOffsetMs: scheduled?.offsetMs ?? null,
        scheduledClockCalibrated: scheduled?.calibrated ?? false,
        releasedAtMs: released.monotonicMs,
        releaseClockOffsetMs: released.offsetMs,
        releaseClockCalibrated: released.calibrated,
        releaseLatenessMs,
        appliedCatchUpMs,
        uncorrectedLatenessMs: Math.max(0, releaseLatenessMs - appliedCatchUpMs),
      });
    },
    learn(driftMs: number, current: number): number | null {
      return sample(driftMs, current, 'eligible');
    },
    skip(reason: Exclude<SampleReason, 'eligible'>): void {
      sample(null, null, reason);
    },
  };
}
