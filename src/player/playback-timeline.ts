import {
  createPlaybackRunIdentity,
  isPlaybackRevision,
  isPlaybackRevisionWatermark,
  sameRun,
  type PlaybackRevision,
  type PlaybackRevisionWatermark,
  type PlaybackRunIdentity,
} from './playback-identity.ts';

export type PlaybackTimelinePhase = 'stopped' | 'playing' | 'paused';

/**
 * JSON-safe authoritative timeline state. `anchorMonotonicMs` belongs to the
 * clock domain of the owner of this snapshot; no AudioContext or AudioNode is
 * retained here.
 */
export interface PlaybackTimelineSnapshot {
  readonly schemaVersion: 1;
  readonly revision: PlaybackRevisionWatermark;
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

const SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion',
  'revision',
  'phase',
  'run',
  'positionSeconds',
  'anchorMonotonicMs',
  'rate',
] as const);
const INTENT_KEYS: Readonly<Record<PlaybackTimelineIntent['type'], readonly string[]>> =
  Object.freeze({
    play: Object.freeze(['type', 'revision', 'run', 'positionSeconds', 'rate']),
    pause: Object.freeze(['type', 'revision', 'run']),
    seek: Object.freeze(['type', 'revision', 'run', 'positionSeconds']),
    stop: Object.freeze(['type', 'revision', 'run']),
  });

interface DetachedDescriptors {
  readonly descriptors: PropertyDescriptorMap;
  readonly ownKeys: readonly PropertyKey[];
}

function freezeCanonical<T extends object>(value: T): T {
  return Object.freeze(Object.assign(Object.create(null), value)) as T;
}

function readOwnDataDescriptors(value: unknown): DetachedDescriptors | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.freeze({ descriptors, ownKeys: Object.freeze(Reflect.ownKeys(descriptors)) });
  } catch {
    return null;
  }
}

function snapshotExactDescriptors(
  detached: DetachedDescriptors,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  const expected = new Set(expectedKeys);
  if (
    detached.ownKeys.length !== expected.size ||
    detached.ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
  ) {
    return null;
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = detached.descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  const detached = readOwnDataDescriptors(value);
  return detached ? snapshotExactDescriptors(detached, expectedKeys) : null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPlaybackRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function readExactPlaybackRun(value: unknown): Readonly<PlaybackRunIdentity> | null {
  try {
    return createPlaybackRunIdentity(value as PlaybackRunIdentity);
  } catch {
    return null;
  }
}

function immutableSnapshot(
  snapshot: Omit<PlaybackTimelineSnapshot, 'schemaVersion'>,
): PlaybackTimelineSnapshot {
  return freezeCanonical({ schemaVersion: 1 as const, ...snapshot });
}

function readPlaybackTimelineSnapshot(value: unknown): PlaybackTimelineSnapshot | null {
  const candidate = snapshotExactDataRecord(value, SNAPSHOT_KEYS);
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    !isPlaybackRevisionWatermark(candidate.revision) ||
    (candidate.phase !== 'stopped' &&
      candidate.phase !== 'playing' &&
      candidate.phase !== 'paused') ||
    !isFiniteNonNegative(candidate.positionSeconds) ||
    !isFiniteNonNegative(candidate.anchorMonotonicMs) ||
    !isPlaybackRate(candidate.rate)
  ) {
    return null;
  }

  if (candidate.phase === 'stopped') {
    if (candidate.run !== null || candidate.positionSeconds !== 0 || candidate.rate !== 1) {
      return null;
    }
    return immutableSnapshot({
      revision: candidate.revision,
      phase: 'stopped',
      run: null,
      positionSeconds: 0,
      anchorMonotonicMs: candidate.anchorMonotonicMs,
      rate: 1,
    });
  }

  const run = readExactPlaybackRun(candidate.run);
  if (!isPlaybackRevision(candidate.revision) || !run) return null;
  return immutableSnapshot({
    revision: candidate.revision,
    phase: candidate.phase,
    run,
    positionSeconds: candidate.positionSeconds,
    anchorMonotonicMs: candidate.anchorMonotonicMs,
    rate: candidate.rate,
  });
}

function readPlaybackTimelineIntent(value: unknown): PlaybackTimelineIntent | null {
  const detached = readOwnDataDescriptors(value);
  if (!detached) return null;
  const typeDescriptor = detached.descriptors.type;
  if (!typeDescriptor || !typeDescriptor.enumerable || !Object.hasOwn(typeDescriptor, 'value')) {
    return null;
  }
  const type: unknown = typeDescriptor.value;
  if (type !== 'play' && type !== 'pause' && type !== 'seek' && type !== 'stop') return null;
  const candidate = snapshotExactDescriptors(detached, INTENT_KEYS[type]);
  if (!candidate || !isPlaybackRevision(candidate.revision)) return null;
  const run = readExactPlaybackRun(candidate.run);
  if (!run) return null;
  switch (type) {
    case 'play':
      if (!isFiniteNonNegative(candidate.positionSeconds) || !isPlaybackRate(candidate.rate)) {
        return null;
      }
      return freezeCanonical({
        type: 'play' as const,
        revision: candidate.revision,
        run,
        positionSeconds: candidate.positionSeconds,
        rate: candidate.rate,
      });
    case 'pause':
      return freezeCanonical({
        type: 'pause' as const,
        revision: candidate.revision,
        run,
      });
    case 'stop':
      return freezeCanonical({ type: 'stop' as const, revision: candidate.revision, run });
    case 'seek':
      if (!isFiniteNonNegative(candidate.positionSeconds)) return null;
      return freezeCanonical({
        type: 'seek' as const,
        revision: candidate.revision,
        run,
        positionSeconds: candidate.positionSeconds,
      });
  }
}

function requireTimeline(value: unknown): PlaybackTimelineSnapshot {
  const snapshot = readPlaybackTimelineSnapshot(value);
  if (!snapshot) throw new TypeError('Playback timeline snapshot is invalid');
  return snapshot;
}

function requireIntent(value: unknown): PlaybackTimelineIntent {
  const intent = readPlaybackTimelineIntent(value);
  if (!intent) throw new TypeError('Playback timeline intent is invalid');
  return intent;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function assertMonotonicTime(snapshot: PlaybackTimelineSnapshot, nowMonotonicMs: number): void {
  assertFiniteNonNegative(nowMonotonicMs, 'Monotonic time');
  if (nowMonotonicMs < snapshot.anchorMonotonicMs) {
    throw new RangeError('Monotonic time cannot move backwards');
  }
}

function deriveCanonicalPlaybackPosition(
  snapshot: PlaybackTimelineSnapshot,
  nowMonotonicMs: number,
): number {
  assertMonotonicTime(snapshot, nowMonotonicMs);
  if (snapshot.phase !== 'playing') return snapshot.positionSeconds;
  return (
    snapshot.positionSeconds +
    ((nowMonotonicMs - snapshot.anchorMonotonicMs) / 1000) * snapshot.rate
  );
}

export function createStoppedPlaybackTimeline(
  anchorMonotonicMs = 0,
  revision: PlaybackRevisionWatermark = 0,
): PlaybackTimelineSnapshot {
  assertFiniteNonNegative(anchorMonotonicMs, 'Timeline anchor');
  if (!isPlaybackRevisionWatermark(revision)) {
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
  return readPlaybackTimelineSnapshot(value) !== null;
}

export function derivePlaybackPosition(
  snapshot: PlaybackTimelineSnapshot,
  nowMonotonicMs: number,
): number {
  return deriveCanonicalPlaybackPosition(requireTimeline(snapshot), nowMonotonicMs);
}

function ignored(
  snapshot: PlaybackTimelineSnapshot,
  reason: 'stale-revision' | 'run-mismatch',
): PlaybackTimelineApplyResult {
  return freezeCanonical({ applied: false as const, reason, snapshot });
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
  const safeSnapshot = requireTimeline(snapshot);
  const safeIntent = requireIntent(intent);
  if (safeIntent.revision <= safeSnapshot.revision) {
    return ignored(safeSnapshot, 'stale-revision');
  }
  if (safeIntent.type !== 'play' && !sameRun(safeSnapshot.run, safeIntent.run)) {
    return ignored(safeSnapshot, 'run-mismatch');
  }
  assertMonotonicTime(safeSnapshot, nowMonotonicMs);

  let next: PlaybackTimelineSnapshot;
  switch (safeIntent.type) {
    case 'play':
      next = immutableSnapshot({
        revision: safeIntent.revision,
        phase: 'playing',
        run: safeIntent.run,
        positionSeconds: safeIntent.positionSeconds,
        anchorMonotonicMs: nowMonotonicMs,
        rate: safeIntent.rate,
      });
      break;
    case 'pause':
      next = immutableSnapshot({
        revision: safeIntent.revision,
        phase: 'paused',
        run: safeIntent.run,
        positionSeconds: deriveCanonicalPlaybackPosition(safeSnapshot, nowMonotonicMs),
        anchorMonotonicMs: nowMonotonicMs,
        rate: safeSnapshot.rate,
      });
      break;
    case 'seek':
      next = immutableSnapshot({
        revision: safeIntent.revision,
        phase: safeSnapshot.phase,
        run: safeIntent.run,
        positionSeconds: safeIntent.positionSeconds,
        anchorMonotonicMs: nowMonotonicMs,
        rate: safeSnapshot.rate,
      });
      break;
    case 'stop':
      next = immutableSnapshot({
        revision: safeIntent.revision,
        phase: 'stopped',
        run: null,
        positionSeconds: 0,
        anchorMonotonicMs: nowMonotonicMs,
        rate: 1,
      });
      break;
  }

  return freezeCanonical({ applied: true as const, snapshot: next });
}
