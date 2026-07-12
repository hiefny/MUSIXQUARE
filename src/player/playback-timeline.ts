import type { QueueItemId } from '../types/index.ts';

/**
 * Monotonically increasing version of the authoritative playback timeline.
 *
 * The value deliberately remains a plain number so snapshots can cross the
 * PeerJS wire boundary without a codec or class revival step.
 */
export type PlaybackRevision = number;

/** A fresh ID is allocated for every logical attempt to play a queue item. */
export type PlaybackRunId = string;

export interface PlaybackRunIdentity {
  readonly queueItemId: QueueItemId;
  readonly runId: PlaybackRunId;
}

export type PlaybackTimelinePhase = 'stopped' | 'playing' | 'paused';

/**
 * JSON-safe authoritative timeline state. `anchorMonotonicMs` belongs to the
 * clock domain of the owner of this snapshot; no AudioContext or AudioNode is
 * retained here.
 */
export interface PlaybackTimelineSnapshot {
  readonly schemaVersion: 1;
  readonly revision: PlaybackRevision;
  readonly phase: PlaybackTimelinePhase;
  readonly run: PlaybackRunIdentity | null;
  readonly positionSeconds: number;
  readonly anchorMonotonicMs: number;
  readonly rate: number;
}

export type PlaybackTimelineIntent =
  | {
      readonly type: 'play';
      readonly revision: PlaybackRevision;
      readonly run: PlaybackRunIdentity;
      readonly positionSeconds: number;
      readonly rate: number;
    }
  | {
      readonly type: 'pause';
      readonly revision: PlaybackRevision;
      readonly run: PlaybackRunIdentity;
    }
  | {
      readonly type: 'seek';
      readonly revision: PlaybackRevision;
      readonly run: PlaybackRunIdentity;
      readonly positionSeconds: number;
    }
  | {
      readonly type: 'stop';
      readonly revision: PlaybackRevision;
      readonly run: PlaybackRunIdentity;
    };

export type PlaybackTimelineApplyResult =
  | {
      readonly applied: true;
      readonly snapshot: PlaybackTimelineSnapshot;
    }
  | {
      readonly applied: false;
      readonly reason: 'stale-revision' | 'run-mismatch';
      readonly snapshot: PlaybackTimelineSnapshot;
    };

const MAX_ID_LENGTH = 256;
const SNAPSHOT_KEYS = new Set([
  'schemaVersion',
  'revision',
  'phase',
  'run',
  'positionSeconds',
  'anchorMonotonicMs',
  'rate',
]);
const RUN_KEYS = new Set(['queueItemId', 'runId']);

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.size && ownKeys.every((key) => keys.has(key));
}

function isNonEmptyBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

export function isPlaybackRevision(value: unknown): value is PlaybackRevision {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function allocatePlaybackRevision(current: PlaybackRevision): PlaybackRevision {
  if (!isPlaybackRevision(current)) {
    throw new RangeError('Playback revision must be a non-negative safe integer');
  }
  if (current === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Playback revision space is exhausted');
  }
  return current + 1;
}

export function isPlaybackRunIdentity(value: unknown): value is PlaybackRunIdentity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return isNonEmptyBoundedString(candidate.queueItemId) && isNonEmptyBoundedString(candidate.runId);
}

function isExactPlaybackRunIdentity(value: unknown): value is PlaybackRunIdentity {
  return (
    !!value &&
    typeof value === 'object' &&
    hasOnlyKeys(value as Record<string, unknown>, RUN_KEYS) &&
    isPlaybackRunIdentity(value)
  );
}

export function samePlaybackRun(
  left: PlaybackRunIdentity | null | undefined,
  right: PlaybackRunIdentity | null | undefined,
): boolean {
  return !!left && !!right && left.queueItemId === right.queueItemId && left.runId === right.runId;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function assertPlaybackRate(rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError('Playback rate must be a finite positive number');
  }
}

function assertRun(run: PlaybackRunIdentity): void {
  if (!isPlaybackRunIdentity(run)) {
    throw new TypeError('Playback run identity is invalid');
  }
}

function immutableRun(run: PlaybackRunIdentity): PlaybackRunIdentity {
  return Object.freeze({ queueItemId: run.queueItemId, runId: run.runId });
}

function immutableSnapshot(
  snapshot: Omit<PlaybackTimelineSnapshot, 'schemaVersion'>,
): PlaybackTimelineSnapshot {
  return Object.freeze({ schemaVersion: 1, ...snapshot });
}

export function createStoppedPlaybackTimeline(
  anchorMonotonicMs = 0,
  revision: PlaybackRevision = 0,
): PlaybackTimelineSnapshot {
  assertFiniteNonNegative(anchorMonotonicMs, 'Timeline anchor');
  if (!isPlaybackRevision(revision)) {
    throw new RangeError('Playback revision must be a non-negative safe integer');
  }
  return immutableSnapshot({
    revision,
    phase: 'stopped',
    run: null,
    positionSeconds: 0,
    anchorMonotonicMs,
    rate: 1,
  });
}

export function isPlaybackTimelineSnapshot(value: unknown): value is PlaybackTimelineSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!hasOnlyKeys(candidate, SNAPSHOT_KEYS)) return false;
  if (candidate.schemaVersion !== 1) return false;
  if (!isPlaybackRevision(candidate.revision)) return false;
  if (
    candidate.phase !== 'stopped' &&
    candidate.phase !== 'playing' &&
    candidate.phase !== 'paused'
  ) {
    return false;
  }
  if (candidate.run !== null && !isExactPlaybackRunIdentity(candidate.run)) return false;
  if (candidate.phase === 'stopped' && candidate.run !== null) return false;
  if (candidate.phase !== 'stopped' && candidate.run === null) return false;
  if (
    typeof candidate.positionSeconds !== 'number' ||
    !Number.isFinite(candidate.positionSeconds) ||
    candidate.positionSeconds < 0
  ) {
    return false;
  }
  if (
    typeof candidate.anchorMonotonicMs !== 'number' ||
    !Number.isFinite(candidate.anchorMonotonicMs) ||
    candidate.anchorMonotonicMs < 0
  ) {
    return false;
  }
  return (
    typeof candidate.rate === 'number' && Number.isFinite(candidate.rate) && candidate.rate > 0
  );
}

function assertTimeline(snapshot: PlaybackTimelineSnapshot): void {
  if (!isPlaybackTimelineSnapshot(snapshot)) {
    throw new TypeError('Playback timeline snapshot is invalid');
  }
}

function assertMonotonicTime(snapshot: PlaybackTimelineSnapshot, nowMonotonicMs: number): void {
  assertFiniteNonNegative(nowMonotonicMs, 'Monotonic time');
  if (nowMonotonicMs < snapshot.anchorMonotonicMs) {
    throw new RangeError('Monotonic time cannot move backwards');
  }
}

export function derivePlaybackPosition(
  snapshot: PlaybackTimelineSnapshot,
  nowMonotonicMs: number,
): number {
  assertTimeline(snapshot);
  assertMonotonicTime(snapshot, nowMonotonicMs);
  if (snapshot.phase !== 'playing') return snapshot.positionSeconds;
  return (
    snapshot.positionSeconds +
    ((nowMonotonicMs - snapshot.anchorMonotonicMs) / 1000) * snapshot.rate
  );
}

function ignored(
  snapshot: PlaybackTimelineSnapshot,
  reason: 'stale-revision' | 'run-mismatch',
): PlaybackTimelineApplyResult {
  return { applied: false, reason, snapshot };
}

/**
 * Applies one authoritative transition without consulting wall clock or global
 * state. Stale revisions and commands for a superseded run are no-ops.
 */
export function applyPlaybackTimelineIntent(
  snapshot: PlaybackTimelineSnapshot,
  intent: PlaybackTimelineIntent,
  nowMonotonicMs: number,
): PlaybackTimelineApplyResult {
  assertTimeline(snapshot);
  if (!isPlaybackRevision(intent.revision)) {
    throw new RangeError('Playback revision must be a non-negative safe integer');
  }
  if (intent.revision <= snapshot.revision) return ignored(snapshot, 'stale-revision');

  assertRun(intent.run);
  if (intent.type !== 'play' && !samePlaybackRun(snapshot.run, intent.run)) {
    return ignored(snapshot, 'run-mismatch');
  }
  assertMonotonicTime(snapshot, nowMonotonicMs);

  let next: PlaybackTimelineSnapshot;
  switch (intent.type) {
    case 'play':
      assertFiniteNonNegative(intent.positionSeconds, 'Playback position');
      assertPlaybackRate(intent.rate);
      next = immutableSnapshot({
        revision: intent.revision,
        phase: 'playing',
        run: immutableRun(intent.run),
        positionSeconds: intent.positionSeconds,
        anchorMonotonicMs: nowMonotonicMs,
        rate: intent.rate,
      });
      break;
    case 'pause':
      next = immutableSnapshot({
        revision: intent.revision,
        phase: 'paused',
        run: immutableRun(intent.run),
        positionSeconds: derivePlaybackPosition(snapshot, nowMonotonicMs),
        anchorMonotonicMs: nowMonotonicMs,
        rate: snapshot.rate,
      });
      break;
    case 'seek':
      assertFiniteNonNegative(intent.positionSeconds, 'Playback position');
      next = immutableSnapshot({
        revision: intent.revision,
        phase: snapshot.phase,
        run: immutableRun(intent.run),
        positionSeconds: intent.positionSeconds,
        anchorMonotonicMs: nowMonotonicMs,
        rate: snapshot.rate,
      });
      break;
    case 'stop':
      next = immutableSnapshot({
        revision: intent.revision,
        phase: 'stopped',
        run: null,
        positionSeconds: 0,
        anchorMonotonicMs: nowMonotonicMs,
        rate: 1,
      });
      break;
  }

  return { applied: true, snapshot: next };
}
