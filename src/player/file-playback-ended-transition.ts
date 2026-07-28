import { readPlaybackStateIdentity, type PlaybackStateIdentity } from './playback-identity.ts';
import { isConsecutiveFilePlaybackTransition } from './file-playback-source.ts';

export interface FilePlaybackEndedTransitionIntent {
  readonly kind: 'file-playback-ended-transition';
  readonly from: PlaybackStateIdentity;
  readonly to: PlaybackStateIdentity;
  readonly observedAtRoomTimeMs: number;
}

export interface FilePlaybackEndedTransitionEvidence {
  readonly kind: 'ended-renderer-retired';
  readonly from: PlaybackStateIdentity;
  readonly to: PlaybackStateIdentity;
  readonly observedAtRoomTimeMs: number;
}

const INTENT_KEYS = Object.freeze(['kind', 'from', 'to', 'observedAtRoomTimeMs'] as const);
const EVIDENCE_KEYS = INTENT_KEYS;

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

export function readFilePlaybackEndedTransitionIntent(
  value: unknown,
): Readonly<FilePlaybackEndedTransitionIntent> | null {
  const snapshot = snapshotExactRecord(value, INTENT_KEYS);
  const states = snapshot ? readStates(snapshot) : null;
  if (
    !snapshot ||
    !states ||
    snapshot.kind !== 'file-playback-ended-transition' ||
    typeof snapshot.observedAtRoomTimeMs !== 'number' ||
    !Number.isFinite(snapshot.observedAtRoomTimeMs) ||
    snapshot.observedAtRoomTimeMs < 0
  ) {
    return null;
  }
  return freezeCanonical({
    kind: 'file-playback-ended-transition' as const,
    from: states.from,
    to: states.to,
    observedAtRoomTimeMs: snapshot.observedAtRoomTimeMs,
  });
}

export function sameFilePlaybackEndedTransitionIntent(
  left: FilePlaybackEndedTransitionIntent,
  right: FilePlaybackEndedTransitionIntent,
): boolean {
  const safeLeft = readFilePlaybackEndedTransitionIntent(left);
  const safeRight = readFilePlaybackEndedTransitionIntent(right);
  return (
    safeLeft !== null &&
    safeRight !== null &&
    sameState(safeLeft.from, safeRight.from) &&
    sameState(safeLeft.to, safeRight.to) &&
    safeLeft.observedAtRoomTimeMs === safeRight.observedAtRoomTimeMs
  );
}

export function createFilePlaybackEndedTransitionEvidence(
  intent: FilePlaybackEndedTransitionIntent,
): Readonly<FilePlaybackEndedTransitionEvidence> {
  const canonical = readFilePlaybackEndedTransitionIntent(intent);
  if (!canonical) throw new TypeError('File playback ended transition intent is invalid');
  return freezeCanonical({
    kind: 'ended-renderer-retired' as const,
    from: canonical.from,
    to: canonical.to,
    observedAtRoomTimeMs: canonical.observedAtRoomTimeMs,
  });
}

export function readFilePlaybackEndedTransitionEvidence(
  value: unknown,
  expectedIntent: FilePlaybackEndedTransitionIntent,
): Readonly<FilePlaybackEndedTransitionEvidence> | null {
  const intent = readFilePlaybackEndedTransitionIntent(expectedIntent);
  const snapshot = snapshotExactRecord(value, EVIDENCE_KEYS);
  const states = snapshot ? readStates(snapshot) : null;
  if (
    !intent ||
    !snapshot ||
    !states ||
    snapshot.kind !== 'ended-renderer-retired' ||
    !sameState(states.from, intent.from) ||
    !sameState(states.to, intent.to) ||
    snapshot.observedAtRoomTimeMs !== intent.observedAtRoomTimeMs
  ) {
    return null;
  }
  return createFilePlaybackEndedTransitionEvidence(intent);
}
