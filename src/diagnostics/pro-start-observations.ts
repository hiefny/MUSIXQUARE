/**
 * Participant-local PRO start observations. No storage, transport, or console
 * side effects. Only static event/field names and categorical strings enter
 * this ring; callers must use numeric local generations, never raw identities.
 */

type ObservationValue = string | number | boolean | null;

interface ProStartObservation {
  at: string;
  kind: string;
  detail: Record<string, ObservationValue>;
}

const MAX_OBSERVATIONS = 512;
const RETENTION_MS = 20 * 60 * 1_000;
const MAX_DETAIL_FIELDS = 64;
const MAX_STRING_LENGTH = 64;

const KINDS = new Set([
  'clock-request',
  'clock-sample',
  'clock-selection',
  'clock-round',
  'clock-wait',
  'playback-clock',
  'playback-clock-unavailable',
  'playback-clock-retry',
  'youtube-release',
  'youtube-sample',
  'youtube-learning',
  'youtube-observation-skipped',
]);

// Keep raw identifiers, arbitrary messages, URLs, and caller-chosen keys out
// even when a caller accidentally passes a larger object to the recorder.
const METRIC_FIELDS = new Set([
  'sampleId',
  'requestId',
  'roundId',
  'generation',
  'revision',
  'sentAtMs',
  'receivedAtMs',
  'serverTimeMs',
  'sentPerformanceMs',
  'receivedPerformanceMs',
  'rttMs',
  'offsetMs',
  'uncertaintyMs',
  'wallElapsedMs',
  'monotonicElapsedMs',
  'clockContinuitySuspect',
  'selectedSampleId',
  'selectedOffsetMs',
  'selectedRttMs',
  'comparisonToleranceMs',
  'disjointIntervals',
  'continuityToleranceMs',
  'bestCandidateSampleId',
  'bestCandidateRttMs',
  'bestCandidateOffsetMs',
  'excessDistanceMs',
  'confirmed',
  'readyCalibrationAgeMs',
  'candidateCount',
  'responseCount',
  'sampledAtMs',
  'signedDelayMs',
  'scheduleDelayMs',
  'elapsedMs',
  'commitGeneration',
  'checkpointMs',
  'plannedSampleAtMs',
  'elapsedSinceStartMs',
  'checkpointLatenessMs',
  'originalCanonicalExecuteAtMs',
  'canonicalExecuteAtMs',
  'canonicalStartSeconds',
  'predictedCanonicalSeconds',
  'rawPositionSeconds',
  'normalizedPositionSeconds',
  'timelineDriftMs',
  'learningDriftMs',
  'manualOffsetSeconds',
  'appliedOffsetSeconds',
  'automaticOffsetSeconds',
  'requestedTargetSeconds',
  'releasedTargetSeconds',
  'playCallAtMs',
  'playingAckAtMs',
  'callToPlayingAckMs',
  'acknowledgementOnly',
  'platformLeadMs',
  'timelineLeadMs',
  'releaseLeadMs',
  'scheduledLeadMs',
  'outputPositionAdvanceMs',
  'localStartDelayMs',
  'rawReleaseLatenessMs',
  'appliedReleaseLatenessMs',
  'uncorrectedCallbackLatenessMs',
  'catchUpSeconds',
  'positiveLeadWasFullyScheduled',
  'learningEnabled',
  'visible',
  'identityMatches',
  'revisionMatches',
  'offsetMatches',
  'playerState',
  'nearEnd',
  'playerReadFailed',
  'adStateKnown',
  'eligible',
  'sampleGapMs',
  'accepted',
  'updated',
  'nextTimelineLeadMs',
]);

const CATEGORIES: Readonly<Record<string, ReadonlySet<string>>> = {
  timingMode: new Set(['zero-start', 'scheduled-control']),
  platform: new Set(['ios', 'android', 'other']),
  path: new Set(['prepared', 'direct']),
  source: new Set(['connection', 'refresh', 'ready', 'ready-late']),
  purpose: new Set(['prepare', 'commit', 'restore', 'reconcile', 'catch-up']),
  state: new Set(['playing', 'paused', 'idle']),
  outcome: new Set(['selected', 'timeout', 'aborted', 'stale', 'retry']),
  reason: new Set([
    'eligible',
    'hidden',
    'identity-mismatch',
    'not-playing',
    'invalid-position',
    'near-end',
    'player-read-failed',
    'cancelled-pending',
    'scheduled-control-observation-only',
    'lead-clipped',
    'direct-no-ack',
    'missing-early-sample',
    'invalid-sample',
    'ineligible-sample',
    'unstable-samples',
    'deadband',
    'updated',
    'selected',
    'deadline',
    'timeout',
    'aborted',
    'disconnected',
    'expired',
    'unmatched',
    'generation',
    'confirmed',
    'candidate',
    'complete',
    'cancelled',
  ]),
};
const DETAIL_FIELDS = [...Object.keys(CATEGORIES), ...METRIC_FIELDS];

const observations: Array<{ recordedAtMs: number; observation: ProStartObservation }> = [];

function prune(nowMs: number): void {
  // Monotonic retention is unaffected by wall-clock corrections being audited.
  while (observations.length > 0 && nowMs - observations[0].recordedAtMs > RETENTION_MS) {
    observations.shift();
  }
}

export function recordProStartObservation(
  kind: string,
  detail: Record<string, ObservationValue>,
): void {
  if (!KINDS.has(kind) || !detail || typeof detail !== 'object') return;
  const sanitized: Record<string, ObservationValue> = {};
  let fields = 0;
  for (const key of DETAIL_FIELDS) {
    if (fields >= MAX_DETAIL_FIELDS) break;
    // Read only own data properties. Getters and inherited values are not
    // diagnostic samples, and must not execute while recording playback.
    const descriptor = Object.getOwnPropertyDescriptor(detail, key);
    if (!descriptor || !('value' in descriptor)) continue;
    const value: unknown = descriptor.value;
    const categories = CATEGORIES[key];
    if (value === null) {
      sanitized[key] = null;
    } else if (categories) {
      if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH || !categories.has(value)) {
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
  observations.push({
    recordedAtMs: nowMs,
    observation: { at: new Date().toISOString(), kind, detail: sanitized },
  });
  if (observations.length > MAX_OBSERVATIONS) {
    observations.splice(0, observations.length - MAX_OBSERVATIONS);
  }
}

/** Return detached primitive-only records; callers cannot mutate the ring. */
export function getProStartObservations(): ProStartObservation[] {
  prune(performance.now());
  return observations.map(({ observation }) => ({
    ...observation,
    detail: { ...observation.detail },
  }));
}

/** Clear at session boundaries or recorder disposal, never per sample. */
export function resetProStartObservations(): void {
  observations.length = 0;
}
