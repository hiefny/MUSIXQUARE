import type { QueueItemId } from '../types/index.ts';

const PLAYBACK_IDENTITY_MAX_IDENTIFIER_LENGTH = 256;

/** Positive revision owned by one active playback state. */
export type PlaybackRevision = number;
/** Timeline watermark; zero is reserved for the initial stopped timeline. */
export type PlaybackRevisionWatermark = number;
export type PlaybackRunId = string;

export interface PlaybackRunIdentity {
  readonly queueItemId: QueueItemId;
  readonly runId: PlaybackRunId;
}

/** Flat identity for one revision of an active playback run. */
export interface PlaybackStateIdentity extends PlaybackRunIdentity {
  readonly revision: PlaybackRevision;
}

/** Flat identity for one rendezvous attempt within a playback state. */
export interface PlaybackAttemptIdentity extends PlaybackStateIdentity {
  readonly rendezvousId: string;
}

const RUN_KEYS = Object.freeze(['queueItemId', 'runId'] as const);
const STATE_KEYS = Object.freeze(['queueItemId', 'revision', 'runId'] as const);
const ATTEMPT_KEYS = Object.freeze(['queueItemId', 'rendezvousId', 'revision', 'runId'] as const);

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Shared opaque identifier contract used by the current wire/rendezvous protocols. */
function isPlaybackIdentityIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PLAYBACK_IDENTITY_MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

export function isPlaybackRevision(value: unknown): value is PlaybackRevision {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isPlaybackRevisionWatermark(value: unknown): value is PlaybackRevisionWatermark {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  return snapshotOwnDataRecord(value, expectedKeys, false);
}

function snapshotRequiredDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  return snapshotOwnDataRecord(value, requiredKeys, true);
}

function snapshotOwnDataRecord(
  value: unknown,
  projectedKeys: readonly string[],
  allowExtraKeys: boolean,
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const projected = new Set(projectedKeys);
    if (!allowExtraKeys && ownKeys.length !== projected.size) return null;
    if (!allowExtraKeys && ownKeys.some((key) => typeof key !== 'string' || !projected.has(key))) {
      return null;
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of projectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function canonicalRun(value: unknown): Readonly<PlaybackRunIdentity> | null {
  const snapshot = snapshotExactDataRecord(value, RUN_KEYS);
  if (
    !snapshot ||
    !isPlaybackIdentityIdentifier(snapshot.queueItemId) ||
    !isPlaybackIdentityIdentifier(snapshot.runId)
  ) {
    return null;
  }
  return freezeCanonical({
    queueItemId: snapshot.queueItemId as QueueItemId,
    runId: snapshot.runId,
  });
}

function readPlaybackRunIdentity(value: unknown): Readonly<PlaybackRunIdentity> | null {
  const snapshot = snapshotRequiredDataRecord(value, RUN_KEYS);
  return snapshot
    ? canonicalRun({ queueItemId: snapshot.queueItemId, runId: snapshot.runId })
    : null;
}

function canonicalState(value: unknown): Readonly<PlaybackStateIdentity> | null {
  const snapshot = snapshotExactDataRecord(value, STATE_KEYS);
  if (
    !snapshot ||
    !isPlaybackIdentityIdentifier(snapshot.queueItemId) ||
    !isPlaybackIdentityIdentifier(snapshot.runId) ||
    !isPlaybackRevision(snapshot.revision)
  ) {
    return null;
  }
  return freezeCanonical({
    queueItemId: snapshot.queueItemId as QueueItemId,
    runId: snapshot.runId,
    revision: snapshot.revision,
  });
}

/**
 * Projects an identity out of a larger data envelope without performing
 * dynamic property reads. Extra schema fields are intentionally ignored.
 */
export function readPlaybackStateIdentity(value: unknown): Readonly<PlaybackStateIdentity> | null {
  const snapshot = snapshotRequiredDataRecord(value, STATE_KEYS);
  return snapshot
    ? canonicalState({
        queueItemId: snapshot.queueItemId,
        runId: snapshot.runId,
        revision: snapshot.revision,
      })
    : null;
}

function canonicalAttempt(value: unknown): Readonly<PlaybackAttemptIdentity> | null {
  const snapshot = snapshotExactDataRecord(value, ATTEMPT_KEYS);
  if (
    !snapshot ||
    !isPlaybackIdentityIdentifier(snapshot.queueItemId) ||
    !isPlaybackIdentityIdentifier(snapshot.runId) ||
    !isPlaybackRevision(snapshot.revision) ||
    !isPlaybackIdentityIdentifier(snapshot.rendezvousId)
  ) {
    return null;
  }
  return freezeCanonical({
    queueItemId: snapshot.queueItemId as QueueItemId,
    runId: snapshot.runId,
    revision: snapshot.revision,
    rendezvousId: snapshot.rendezvousId,
  });
}

/** Descriptor-safe projection for rendezvous envelopes with additional fields. */
export function readPlaybackAttemptIdentity(
  value: unknown,
): Readonly<PlaybackAttemptIdentity> | null {
  const snapshot = snapshotRequiredDataRecord(value, ATTEMPT_KEYS);
  return snapshot
    ? canonicalAttempt({
        queueItemId: snapshot.queueItemId,
        runId: snapshot.runId,
        revision: snapshot.revision,
        rendezvousId: snapshot.rendezvousId,
      })
    : null;
}

export function isPlaybackRunIdentity(value: unknown): value is PlaybackRunIdentity {
  return canonicalRun(value) !== null;
}

export function isPlaybackStateIdentity(value: unknown): value is PlaybackStateIdentity {
  return canonicalState(value) !== null;
}

export function createPlaybackRunIdentity(
  value: PlaybackRunIdentity,
): Readonly<PlaybackRunIdentity> {
  const identity = canonicalRun(value);
  if (!identity) throw new TypeError('Playback run identity is invalid');
  return identity;
}

export function createPlaybackStateIdentity(
  value: PlaybackStateIdentity,
): Readonly<PlaybackStateIdentity> {
  const identity = canonicalState(value);
  if (!identity) throw new TypeError('Playback state identity is invalid');
  return identity;
}

export function sameRun(
  left: PlaybackRunIdentity | null | undefined,
  right: PlaybackRunIdentity | null | undefined,
): boolean {
  const safeLeft = readPlaybackRunIdentity(left);
  const safeRight = readPlaybackRunIdentity(right);
  return (
    safeLeft !== null &&
    safeRight !== null &&
    safeLeft.queueItemId === safeRight.queueItemId &&
    safeLeft.runId === safeRight.runId
  );
}

export function sameState(
  left: PlaybackStateIdentity | null | undefined,
  right: PlaybackStateIdentity | null | undefined,
): boolean {
  const safeLeft = readPlaybackStateIdentity(left);
  const safeRight = readPlaybackStateIdentity(right);
  return (
    safeLeft !== null &&
    safeRight !== null &&
    safeLeft.queueItemId === safeRight.queueItemId &&
    safeLeft.runId === safeRight.runId &&
    safeLeft.revision === safeRight.revision
  );
}

export function sameAttempt(
  left: PlaybackAttemptIdentity | null | undefined,
  right: PlaybackAttemptIdentity | null | undefined,
): boolean {
  const safeLeft = readPlaybackAttemptIdentity(left);
  const safeRight = readPlaybackAttemptIdentity(right);
  return (
    safeLeft !== null &&
    safeRight !== null &&
    safeLeft.queueItemId === safeRight.queueItemId &&
    safeLeft.runId === safeRight.runId &&
    safeLeft.revision === safeRight.revision &&
    safeLeft.rendezvousId === safeRight.rendezvousId
  );
}
