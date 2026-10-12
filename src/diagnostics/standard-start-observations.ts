/**
 * Local Standard clock and playback observations. Independent bounded rings
 * keep clock traffic from evicting playback evidence. No storage, transport,
 * or console side effects; raw room, peer, queue, and video identities are
 * never accepted. Correlation uses caller-supplied numeric local identifiers.
 */

type ObservationValue = string | number | boolean | null;

interface StandardStartObservation {
  at: string;
  kind: string;
  detail: Record<string, ObservationValue>;
}

interface ObservationRing {
  limit: number;
  records: Array<{ recordedAtMs: number; observation: StandardStartObservation }>;
}

const RETENTION_MS = 20 * 60 * 1_000;
const MAX_DETAIL_FIELDS = 64;
const MAX_STRING_LENGTH = 64;
const CLOCK_KINDS = new Set(['clock-selection', 'clock-continuity']);
const PLAYBACK_KINDS = new Set([
  'youtube-rendezvous-start',
  'youtube-rendezvous-release',
  'youtube-rendezvous-sample',
]);

const METRIC_FIELDS = [
  'previousSampleId',
  'selectedSampleId',
  'previousEpoch',
  'epoch',
  'previousIsHostClock',
  'isHostClock',
  'previousOffsetMs',
  'selectedOffsetMs',
  'previousRttMs',
  'selectedRttMs',
  'previousAgeMs',
  'selectedAgeMs',
  'sampleCount',
  'comparisonToleranceMs',
  'offsetDifferenceMs',
  'intervalGapMs',
  'sameEpoch',
  'disjointIntervals',
  'sentAtMs',
  'rawSentAtMs',
  'rawWallElapsedMs',
  'receivedAtMs',
  'hostTimeMs',
  'sentPerformanceMs',
  'receivedPerformanceMs',
  'wallElapsedMs',
  'monotonicElapsedMs',
  'continuityToleranceMs',
  'localClockStepMs',
  'clockContinuitySuspect',
  'operationId',
  'plannedPlayAtMs',
  'plannedHostPlayAtMs',
  'plannedClockOffsetMs',
  'scheduledClockOffsetMs',
  'releaseClockOffsetMs',
  'sampleClockOffsetMs',
  'releaseLatenessMs',
  'appliedCatchUpMs',
  'uncorrectedLatenessMs',
  'timelineDriftMs',
  'learningDriftMs',
  'clockOffsetDeltaMs',
  'clockMappingDeltaMs',
  'clockOffsetSpanMs',
  'clockMappingSpanMs',
  'plannedClockCalibrated',
  'scheduledClockCalibrated',
  'releaseClockCalibrated',
  'sampleClockCalibrated',
  'clockToleranceMs',
  'wallToleranceMs',
  'clockStable',
  'sampleLatenessMs',
  'manualOffsetSeconds',
  'effectiveLeadMs',
  'previousLatencyMs',
  'nextLatencyMs',
  'eligible',
  'plannedWallMs',
  'plannedMonotonicMs',
  'scheduledAtMs',
  'releasedAtMs',
  'sampledAtMs',
];
const REASONS = new Set([
  'new-sample',
  'equal-rtt',
  'expired',
  'capacity',
  'reset',
  'rebase',
  'clock-step',
  'host-role',
  'wall-monotonic',
  'eligible',
  'clock-changed',
  'invalid-sample',
  'hidden',
  'stale-snapshot',
  'video-mismatch',
  'not-playing',
  'near-end',
  'outlier',
  'player-read-failed',
]);
const DETAIL_FIELDS = ['reason', ...METRIC_FIELDS];
const clockRing: ObservationRing = { limit: 1_200, records: [] };
const playbackRing: ObservationRing = { limit: 512, records: [] };

function prune(nowMs: number): void {
  // Wall-clock corrections under observation must not extend retention.
  for (const ring of [clockRing, playbackRing]) {
    while (ring.records.length > 0 && nowMs - ring.records[0].recordedAtMs > RETENTION_MS) {
      ring.records.shift();
    }
  }
}

export function recordStandardStartObservation(
  kind: string,
  detail: Record<string, ObservationValue>,
): void {
  const ring = CLOCK_KINDS.has(kind) ? clockRing : PLAYBACK_KINDS.has(kind) ? playbackRing : null;
  if (!ring || !detail || typeof detail !== 'object') return;
  const sanitized: Record<string, ObservationValue> = {};
  let fields = 0;
  for (const key of DETAIL_FIELDS) {
    if (fields >= MAX_DETAIL_FIELDS) break;
    // Never execute getters or retain inherited properties/object payloads.
    const descriptor = Object.getOwnPropertyDescriptor(detail, key);
    if (!descriptor || !('value' in descriptor)) continue;
    const value: unknown = descriptor.value;
    if (value === null) {
      sanitized[key] = null;
    } else if (key === 'reason') {
      if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH || !REASONS.has(value)) {
        continue;
      }
      sanitized[key] = value;
    } else if (typeof value === 'number') {
      sanitized[key] = Number.isFinite(value) ? value : null;
    } else if (typeof value === 'boolean') {
      sanitized[key] = value;
    } else {
      continue;
    }
    fields += 1;
  }
  const nowMs = performance.now();
  prune(nowMs);
  ring.records.push({
    recordedAtMs: nowMs,
    observation: { at: new Date().toISOString(), kind, detail: sanitized },
  });
  if (ring.records.length > ring.limit) {
    ring.records.splice(0, ring.records.length - ring.limit);
  }
}

function copyRing(ring: ObservationRing): StandardStartObservation[] {
  return ring.records.map(({ observation }) => ({
    ...observation,
    detail: { ...observation.detail },
  }));
}

/** Detached oldest-to-newest snapshots, separately bounded by event family. */
export function getStandardStartObservations(): {
  clock: StandardStartObservation[];
  playback: StandardStartObservation[];
} {
  prune(performance.now());
  return { clock: copyRing(clockRing), playback: copyRing(playbackRing) };
}

/** Clear at recorder/session boundaries, never after individual samples. */
export function resetStandardStartObservations(): void {
  clockRing.records.length = 0;
  playbackRing.records.length = 0;
}
