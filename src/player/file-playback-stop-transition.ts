import {
  isConsecutiveFilePlaybackTransition,
  readFilePlaybackCutoverTarget,
  type FilePlaybackCutoverTarget,
} from './file-playback-source.ts';
import { readPlaybackStateIdentity } from './playback-identity.ts';
import type { RevisionedPlaybackRun } from './rendezvous-contract.ts';

/**
 * A manager-owned logical stop. Unlike pause/seek, STOP never asks the source
 * backend to manufacture a stopped snapshot. The controller supplies the room
 * boundary and its already-mapped process-local Web Audio target; the manager
 * applies that boundary solely with its outer gate.
 */
export interface FilePlaybackStopTransitionIntent {
  readonly kind: 'file-playback-stop-transition';
  readonly from: RevisionedPlaybackRun;
  readonly to: RevisionedPlaybackRun;
  readonly atRoomTimeMs: number;
  readonly target: FilePlaybackCutoverTarget;
}

export interface FilePlaybackScheduledStopTransitionEvidence {
  readonly kind: 'stop-applied';
  readonly observation: 'webaudio-schedule-passed';
  readonly from: RevisionedPlaybackRun;
  readonly to: RevisionedPlaybackRun;
  readonly targetFrame: number;
  readonly appliedFrame: number;
}

/**
 * Exact source-native failure followed by manager-owned current-port
 * retirement. This evidence never claims that a future Web Audio frame was
 * scheduled or observed.
 */
export interface FilePlaybackFailedStopTransitionEvidence {
  readonly kind: 'failed-stop-applied';
  readonly observation: 'source-failed-retired';
  readonly from: RevisionedPlaybackRun;
  readonly to: RevisionedPlaybackRun;
}

export type FilePlaybackStopTransitionEvidence =
  | FilePlaybackScheduledStopTransitionEvidence
  | FilePlaybackFailedStopTransitionEvidence;

interface FilePlaybackScheduledStopTransitionResult {
  readonly status: 'scheduled';
  readonly from: RevisionedPlaybackRun;
  readonly to: RevisionedPlaybackRun;
  readonly target: FilePlaybackCutoverTarget;
  readonly applied: Promise<FilePlaybackScheduledStopTransitionEvidence>;
}

interface FilePlaybackFailedStopTransitionResult {
  readonly status: 'failed-retired';
  readonly from: RevisionedPlaybackRun;
  readonly to: RevisionedPlaybackRun;
  readonly target: FilePlaybackCutoverTarget;
  readonly applied: Promise<FilePlaybackFailedStopTransitionEvidence>;
}

export type FilePlaybackStopTransitionResult =
  | FilePlaybackScheduledStopTransitionResult
  | FilePlaybackFailedStopTransitionResult;

const INTENT_KEYS = Object.freeze(['kind', 'from', 'to', 'atRoomTimeMs', 'target'] as const);
const INTENT_KEY_SET: ReadonlySet<string> = new Set(INTENT_KEYS);
const TARGET_KEYS = Object.freeze(['audioContext', 'contextTimeSeconds', 'targetFrame'] as const);
const TARGET_KEY_SET: ReadonlySet<string> = new Set(TARGET_KEYS);
const SCHEDULED_EVIDENCE_KEYS = Object.freeze([
  'kind',
  'observation',
  'from',
  'to',
  'targetFrame',
  'appliedFrame',
] as const);
const SCHEDULED_EVIDENCE_KEY_SET: ReadonlySet<string> = new Set(SCHEDULED_EVIDENCE_KEYS);
const FAILED_EVIDENCE_KEYS = Object.freeze(['kind', 'observation', 'from', 'to'] as const);
const FAILED_EVIDENCE_KEY_SET: ReadonlySet<string> = new Set(FAILED_EVIDENCE_KEYS);
const RESULT_KEYS = Object.freeze(['status', 'from', 'to', 'target', 'applied'] as const);
const RESULT_KEY_SET: ReadonlySet<string> = new Set(RESULT_KEYS);
const NATIVE_PROMISE_PROTOTYPE = Promise.prototype;
const NATIVE_PROMISE_THEN = Promise.prototype.then;
const TRUSTED_REFLECT_APPLY = Reflect.apply;

function freezeRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  expectedKeySet: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !expectedKeySet.has(key))
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

function sameState(left: RevisionedPlaybackRun, right: RevisionedPlaybackRun): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision
  );
}

/**
 * Accepts only a same-realm native Promise and attaches safe handlers without
 * propagating its fulfillment value into an unobserved derived Promise. This
 * keeps hostile proxies, Promise subclasses/species, and late-added thenables
 * out of the manager-owned evidence contract.
 */
function readExactNativePromise<T>(value: unknown): Promise<T> | null {
  try {
    if (value === null || typeof value !== 'object') return null;
    if (Reflect.getPrototypeOf(value) !== NATIVE_PROMISE_PROTOTYPE) return null;
    if (Object.hasOwn(value, 'constructor')) return null;
    const observed = TRUSTED_REFLECT_APPLY(NATIVE_PROMISE_THEN, value, [
      () => undefined,
      () => undefined,
    ]) as unknown;
    if (
      observed === null ||
      typeof observed !== 'object' ||
      Reflect.getPrototypeOf(observed) !== NATIVE_PROMISE_PROTOTYPE
    ) {
      return null;
    }
    return value as Promise<T>;
  } catch {
    return null;
  }
}

function readStates(
  value: Readonly<Record<string, unknown>>,
): Readonly<{ from: RevisionedPlaybackRun; to: RevisionedPlaybackRun }> | null {
  const from = readPlaybackStateIdentity(value.from);
  const to = readPlaybackStateIdentity(value.to);
  if (!from || !to || !isConsecutiveFilePlaybackTransition(from, to)) return null;
  return freezeRecord({ from, to });
}

function readSelfDescribingIntent(
  value: unknown,
): Readonly<FilePlaybackStopTransitionIntent> | null {
  const candidate = snapshotExactDataRecord(value, INTENT_KEYS, INTENT_KEY_SET);
  const target = candidate
    ? snapshotExactDataRecord(candidate.target, TARGET_KEYS, TARGET_KEY_SET)
    : null;
  if (!target || target.audioContext === null || typeof target.audioContext !== 'object') {
    return null;
  }
  return readFilePlaybackStopTransitionIntent(value, target.audioContext as AudioContext);
}

export function readFilePlaybackStopTransitionIntent(
  value: unknown,
  expectedAudioContext: AudioContext,
): Readonly<FilePlaybackStopTransitionIntent> | null {
  const candidate = snapshotExactDataRecord(value, INTENT_KEYS, INTENT_KEY_SET);
  const states = candidate ? readStates(candidate) : null;
  const target = candidate
    ? readFilePlaybackCutoverTarget(candidate.target, expectedAudioContext)
    : null;
  if (
    !candidate ||
    !states ||
    !target ||
    candidate.kind !== 'file-playback-stop-transition' ||
    typeof candidate.atRoomTimeMs !== 'number' ||
    !Number.isFinite(candidate.atRoomTimeMs) ||
    candidate.atRoomTimeMs < 0
  ) {
    return null;
  }
  return freezeRecord({
    kind: 'file-playback-stop-transition',
    from: states.from,
    to: states.to,
    atRoomTimeMs: candidate.atRoomTimeMs,
    target,
  });
}

export function sameFilePlaybackStopTransitionIntent(
  left: FilePlaybackStopTransitionIntent,
  right: FilePlaybackStopTransitionIntent,
  expectedAudioContext: AudioContext,
): boolean {
  const safeLeft = readFilePlaybackStopTransitionIntent(left, expectedAudioContext);
  const safeRight = readFilePlaybackStopTransitionIntent(right, expectedAudioContext);
  return (
    safeLeft !== null &&
    safeRight !== null &&
    sameState(safeLeft.from, safeRight.from) &&
    sameState(safeLeft.to, safeRight.to) &&
    safeLeft.atRoomTimeMs === safeRight.atRoomTimeMs &&
    safeLeft.target.audioContext === safeRight.target.audioContext &&
    safeLeft.target.contextTimeSeconds === safeRight.target.contextTimeSeconds &&
    safeLeft.target.targetFrame === safeRight.target.targetFrame
  );
}

export function createFilePlaybackStopTransitionEvidence(
  intent: FilePlaybackStopTransitionIntent,
  appliedFrame: number,
): FilePlaybackScheduledStopTransitionEvidence {
  const canonical = readSelfDescribingIntent(intent);
  if (
    !canonical ||
    !Number.isSafeInteger(appliedFrame) ||
    appliedFrame < canonical.target.targetFrame
  ) {
    throw new TypeError('File playback stop evidence is invalid');
  }
  return freezeRecord({
    kind: 'stop-applied',
    observation: 'webaudio-schedule-passed',
    from: canonical.from,
    to: canonical.to,
    targetFrame: canonical.target.targetFrame,
    appliedFrame,
  });
}

export function createFilePlaybackFailedStopTransitionEvidence(
  intent: FilePlaybackStopTransitionIntent,
): FilePlaybackFailedStopTransitionEvidence {
  const canonical = readSelfDescribingIntent(intent);
  if (!canonical) {
    throw new TypeError('Failed file playback stop evidence is invalid');
  }
  return freezeRecord({
    kind: 'failed-stop-applied',
    observation: 'source-failed-retired',
    from: canonical.from,
    to: canonical.to,
  });
}

export function readFilePlaybackStopTransitionEvidence(
  value: unknown,
  expectedIntent: FilePlaybackStopTransitionIntent,
): FilePlaybackStopTransitionEvidence | null {
  const intent = readSelfDescribingIntent(expectedIntent);
  const scheduled = snapshotExactDataRecord(
    value,
    SCHEDULED_EVIDENCE_KEYS,
    SCHEDULED_EVIDENCE_KEY_SET,
  );
  const failed = scheduled
    ? null
    : snapshotExactDataRecord(value, FAILED_EVIDENCE_KEYS, FAILED_EVIDENCE_KEY_SET);
  const candidate = scheduled ?? failed;
  const states = candidate ? readStates(candidate) : null;
  if (
    !intent ||
    !candidate ||
    !states ||
    !sameState(states.from, intent.from) ||
    !sameState(states.to, intent.to)
  ) {
    return null;
  }
  if (
    failed &&
    candidate.kind === 'failed-stop-applied' &&
    candidate.observation === 'source-failed-retired'
  ) {
    try {
      return createFilePlaybackFailedStopTransitionEvidence(intent);
    } catch {
      return null;
    }
  }
  if (
    !scheduled ||
    candidate.kind !== 'stop-applied' ||
    candidate.observation !== 'webaudio-schedule-passed' ||
    candidate.targetFrame !== intent.target.targetFrame ||
    typeof candidate.appliedFrame !== 'number'
  ) {
    return null;
  }
  try {
    return createFilePlaybackStopTransitionEvidence(intent, candidate.appliedFrame);
  } catch {
    return null;
  }
}

export function createFilePlaybackStopTransitionResult(
  intent: FilePlaybackStopTransitionIntent,
  applied: Promise<FilePlaybackScheduledStopTransitionEvidence>,
): FilePlaybackScheduledStopTransitionResult {
  const canonical = readSelfDescribingIntent(intent);
  const canonicalApplied =
    readExactNativePromise<FilePlaybackScheduledStopTransitionEvidence>(applied);
  if (!canonical || !canonicalApplied) {
    throw new TypeError('Scheduled file playback stop result is invalid');
  }
  return freezeRecord({
    status: 'scheduled',
    from: canonical.from,
    to: canonical.to,
    target: canonical.target,
    applied: canonicalApplied,
  });
}

export function createFilePlaybackFailedStopTransitionResult(
  intent: FilePlaybackStopTransitionIntent,
  applied: Promise<FilePlaybackFailedStopTransitionEvidence>,
): FilePlaybackFailedStopTransitionResult {
  const canonical = readSelfDescribingIntent(intent);
  const canonicalApplied =
    readExactNativePromise<FilePlaybackFailedStopTransitionEvidence>(applied);
  if (!canonical || !canonicalApplied) {
    throw new TypeError('Failed file playback stop result is invalid');
  }
  return freezeRecord({
    status: 'failed-retired',
    from: canonical.from,
    to: canonical.to,
    target: canonical.target,
    applied: canonicalApplied,
  });
}

export function readFilePlaybackStopTransitionResult(
  value: unknown,
  expectedIntent: FilePlaybackStopTransitionIntent,
): FilePlaybackStopTransitionResult | null {
  const intent = readSelfDescribingIntent(expectedIntent);
  const candidate = snapshotExactDataRecord(value, RESULT_KEYS, RESULT_KEY_SET);
  const from = candidate ? readPlaybackStateIdentity(candidate.from) : null;
  const to = candidate ? readPlaybackStateIdentity(candidate.to) : null;
  const applied = candidate
    ? readExactNativePromise<FilePlaybackStopTransitionEvidence>(candidate.applied)
    : null;
  if (
    !intent ||
    !candidate ||
    (candidate.status !== 'scheduled' && candidate.status !== 'failed-retired') ||
    !from ||
    !to ||
    !sameState(from, intent.from) ||
    !sameState(to, intent.to) ||
    !readFilePlaybackCutoverTarget(candidate.target, intent.target.audioContext) ||
    !applied
  ) {
    return null;
  }
  const target = readFilePlaybackCutoverTarget(candidate.target, intent.target.audioContext);
  if (
    !target ||
    target.contextTimeSeconds !== intent.target.contextTimeSeconds ||
    target.targetFrame !== intent.target.targetFrame
  ) {
    return null;
  }
  try {
    return candidate.status === 'scheduled'
      ? createFilePlaybackStopTransitionResult(
          intent,
          applied as Promise<FilePlaybackScheduledStopTransitionEvidence>,
        )
      : createFilePlaybackFailedStopTransitionResult(
          intent,
          applied as Promise<FilePlaybackFailedStopTransitionEvidence>,
        );
  } catch {
    return null;
  }
}
