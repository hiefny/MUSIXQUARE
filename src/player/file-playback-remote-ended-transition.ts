import { isConsecutiveFilePlaybackTransition } from './file-playback-source.ts';
import { readPlaybackStateIdentity, type PlaybackStateIdentity } from './playback-identity.ts';

type FilePlaybackRemoteEndedObservedPhase = 'playing' | 'paused' | 'ended';

/**
 * A host-observed natural end applied to one exact remote renderer revision.
 *
 * This is intentionally distinct from a scheduled STOP. The host observation
 * carries no process-local AudioContext target and cannot manufacture native
 * stop evidence on a guest.
 */
export interface FilePlaybackRemoteEndedTransitionIntent {
  readonly kind: 'file-playback-remote-ended-transition';
  readonly from: PlaybackStateIdentity;
  readonly to: PlaybackStateIdentity;
  readonly hostObservedAtRoomTimeMs: number;
}

/** Manager-owned proof that the exact remote renderer was physically retired. */
export interface FilePlaybackRemoteEndedTransitionEvidence {
  readonly kind: 'remote-ended-renderer-retired';
  readonly from: PlaybackStateIdentity;
  readonly to: PlaybackStateIdentity;
  readonly hostObservedAtRoomTimeMs: number;
  readonly observedPhase: FilePlaybackRemoteEndedObservedPhase;
}

const INTENT_KEYS = Object.freeze(['kind', 'from', 'to', 'hostObservedAtRoomTimeMs'] as const);
const EVIDENCE_KEYS = Object.freeze([
  'kind',
  'from',
  'to',
  'hostObservedAtRoomTimeMs',
  'observedPhase',
] as const);
const OBSERVED_PHASES: ReadonlySet<string> = new Set(['playing', 'paused', 'ended']);

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = new Set(expectedKeys);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function readStates(value: Readonly<Record<string, unknown>>): Readonly<{
  from: PlaybackStateIdentity;
  to: PlaybackStateIdentity;
}> | null {
  const from = readPlaybackStateIdentity(value.from);
  const to = readPlaybackStateIdentity(value.to);
  if (!from || !to || !isConsecutiveFilePlaybackTransition(from, to)) return null;
  return freezeCanonical({ from, to });
}

function sameState(left: PlaybackStateIdentity, right: PlaybackStateIdentity): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision
  );
}

function readObservedPhase(value: unknown): FilePlaybackRemoteEndedObservedPhase | null {
  return typeof value === 'string' && OBSERVED_PHASES.has(value)
    ? (value as FilePlaybackRemoteEndedObservedPhase)
    : null;
}

export function readFilePlaybackRemoteEndedTransitionIntent(
  value: unknown,
): Readonly<FilePlaybackRemoteEndedTransitionIntent> | null {
  const snapshot = snapshotExactRecord(value, INTENT_KEYS);
  const states = snapshot ? readStates(snapshot) : null;
  if (
    !snapshot ||
    !states ||
    snapshot.kind !== 'file-playback-remote-ended-transition' ||
    typeof snapshot.hostObservedAtRoomTimeMs !== 'number' ||
    !Number.isFinite(snapshot.hostObservedAtRoomTimeMs) ||
    snapshot.hostObservedAtRoomTimeMs < 0
  ) {
    return null;
  }
  return freezeCanonical({
    kind: 'file-playback-remote-ended-transition' as const,
    from: states.from,
    to: states.to,
    hostObservedAtRoomTimeMs: snapshot.hostObservedAtRoomTimeMs,
  });
}

export function sameFilePlaybackRemoteEndedTransitionIntent(
  left: FilePlaybackRemoteEndedTransitionIntent,
  right: FilePlaybackRemoteEndedTransitionIntent,
): boolean {
  const safeLeft = readFilePlaybackRemoteEndedTransitionIntent(left);
  const safeRight = readFilePlaybackRemoteEndedTransitionIntent(right);
  return (
    safeLeft !== null &&
    safeRight !== null &&
    sameState(safeLeft.from, safeRight.from) &&
    sameState(safeLeft.to, safeRight.to) &&
    safeLeft.hostObservedAtRoomTimeMs === safeRight.hostObservedAtRoomTimeMs
  );
}

export function createFilePlaybackRemoteEndedTransitionEvidence(
  intent: FilePlaybackRemoteEndedTransitionIntent,
  observedPhase: FilePlaybackRemoteEndedObservedPhase,
): Readonly<FilePlaybackRemoteEndedTransitionEvidence> {
  const canonical = readFilePlaybackRemoteEndedTransitionIntent(intent);
  const canonicalPhase = readObservedPhase(observedPhase);
  if (!canonical || !canonicalPhase) {
    throw new TypeError('File playback remote-ended transition evidence is invalid');
  }
  return freezeCanonical({
    kind: 'remote-ended-renderer-retired' as const,
    from: canonical.from,
    to: canonical.to,
    hostObservedAtRoomTimeMs: canonical.hostObservedAtRoomTimeMs,
    observedPhase: canonicalPhase,
  });
}

export function readFilePlaybackRemoteEndedTransitionEvidence(
  value: unknown,
  expectedIntent: FilePlaybackRemoteEndedTransitionIntent,
): Readonly<FilePlaybackRemoteEndedTransitionEvidence> | null {
  const intent = readFilePlaybackRemoteEndedTransitionIntent(expectedIntent);
  const snapshot = snapshotExactRecord(value, EVIDENCE_KEYS);
  const states = snapshot ? readStates(snapshot) : null;
  const observedPhase = snapshot ? readObservedPhase(snapshot.observedPhase) : null;
  if (
    !intent ||
    !snapshot ||
    !states ||
    !observedPhase ||
    snapshot.kind !== 'remote-ended-renderer-retired' ||
    !sameState(states.from, intent.from) ||
    !sameState(states.to, intent.to) ||
    snapshot.hostObservedAtRoomTimeMs !== intent.hostObservedAtRoomTimeMs
  ) {
    return null;
  }
  return createFilePlaybackRemoteEndedTransitionEvidence(intent, observedPhase);
}
