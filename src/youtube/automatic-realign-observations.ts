import { recordStandardStartObservation } from '../diagnostics/standard-start-observations.ts';

const BLOCKED_REPEAT_MS = 20_000;
const BLOCKED_REASONS = new Set([
  'uncalibrated',
  'discontinuity',
  'selected-expired',
  'replies-stale',
  'uncertainty',
  'clock-changed',
]);
const RECOVERY_REASONS = new Set(['recovery', 'clock-changed', 'late-release']);

interface AutomaticRealignObservation {
  /** Internal dedupe only; never passed to the recorder. */
  occurrenceKey: string;
  stage: 'blocked' | 'admitted' | 'recovery';
  reason: string;
  driftMs: number | null;
  triggerMs: number;
  clock: {
    epoch: number;
    offsetMs: number;
    rttMs: number | null;
    selectedAgeMs: number | null;
    newestSampleAgeMs: number | null;
    uncertaintyMs: number | null;
  };
}

// One player owns one current occurrence. Retain only its key and at most the
// fixed blocked-reason count, never a growing history of raw identities.
let currentOccurrence: string | null = null;
const blockedAt = new Map<string, number>();

/** Call only for meaningful drift/admission/recovery, not every healthy heartbeat. */
export function recordAutomaticRealignObservation(observation: AutomaticRealignObservation): void {
  const { occurrenceKey, stage, reason, clock } = observation;
  if (
    !(stage === 'blocked' && BLOCKED_REASONS.has(reason)) &&
    !(stage === 'admitted' && reason === 'admitted') &&
    !(stage === 'recovery' && RECOVERY_REASONS.has(reason))
  ) {
    return;
  }

  if (currentOccurrence !== occurrenceKey) {
    currentOccurrence = occurrenceKey;
    blockedAt.clear();
  }
  if (stage === 'blocked') {
    const now = performance.now();
    if (!Number.isFinite(now)) return;
    const previous = blockedAt.get(reason);
    if (previous !== undefined && now >= previous && now - previous < BLOCKED_REPEAT_MS) return;
    blockedAt.set(reason, now);
  }

  recordStandardStartObservation(`youtube-automatic-realign-${stage}`, {
    reason,
    epoch: clock.epoch,
    selectedOffsetMs: clock.offsetMs,
    selectedRttMs: clock.rttMs,
    selectedAgeMs: clock.selectedAgeMs,
    newestSampleAgeMs: clock.newestSampleAgeMs,
    uncertaintyMs: clock.uncertaintyMs,
    timelineDriftMs: observation.driftMs,
    triggerMs: observation.triggerMs,
  });
}

/** Reset dedupe at sync/session teardown without erasing existing flight evidence. */
export function resetAutomaticRealignObservations(): void {
  currentOccurrence = null;
  blockedAt.clear();
}
