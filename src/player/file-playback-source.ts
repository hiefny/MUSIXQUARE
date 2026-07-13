import type { QueueItemId } from '../types/index.ts';
import {
  createPlaybackStateIdentity,
  isPlaybackRevisionWatermark,
  readPlaybackAttemptIdentity,
  readPlaybackStateIdentity,
  type PlaybackRevisionWatermark,
} from './playback-identity.ts';
import {
  type RendezvousArmIntent,
  type RendezvousArmReceipt,
  type RendezvousFinalizeIntent,
  type RendezvousFinalizeReceipt,
  type RevisionedPlaybackRun,
} from './rendezvous-contract.ts';

export type FilePlaybackBackend = 'audio-buffer' | 'streaming-flac';

export type FilePlaybackSourcePhase =
  | 'new'
  | 'preparing'
  | 'ready'
  | 'connected'
  | 'armed'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'cancelled'
  | 'failed'
  | 'destroyed';

/**
 * Durable, JSON-safe state for UI and orchestration stores. Runtime Web Audio
 * objects stay private to the FilePlaybackSource implementation.
 */
export interface FilePlaybackSourceSnapshot {
  readonly schemaVersion: 1;
  readonly queueItemId: QueueItemId;
  readonly backend: FilePlaybackBackend;
  readonly phase: FilePlaybackSourcePhase;
  readonly revision: PlaybackRevisionWatermark;
  readonly run: RevisionedPlaybackRun | null;
  readonly durationSeconds: number | null;
  readonly positionSeconds: number;
  readonly bufferedAheadSeconds: number;
  readonly outputSampleRateHz: number | null;
  readonly channelCount: number | null;
  readonly underrunCount: number;
  readonly errorCode: string | null;
}

export interface FilePlaybackPosition {
  readonly queueItemId: QueueItemId;
  readonly run: RevisionedPlaybackRun | null;
  readonly phase: FilePlaybackSourcePhase;
  readonly positionSeconds: number;
  readonly bufferedAheadSeconds: number;
  readonly underrunCount: number;
}

/** @deprecated Use FilePlaybackPauseTransitionIntent on the V2 current port. */
export interface FilePlaybackPauseIntent extends RevisionedPlaybackRun {
  readonly kind: 'file-playback-pause';
  readonly atRoomTimeMs: number;
}

/** @deprecated Use FilePlaybackSeekTransitionIntent on the V2 current port. */
export interface FilePlaybackSeekIntent extends RevisionedPlaybackRun {
  readonly kind: 'file-playback-seek';
  readonly positionSeconds: number;
  readonly atRoomTimeMs: number;
}

/**
 * Revision-bearing local control intents used by the V2 current-renderer
 * capability. `from` is the exact state that may be changed and `to` is the
 * only state that may become visible after native application evidence.
 *
 * The older flat pause/seek intents above remain only for the inactive legacy
 * control path. They cannot safely advance the authoritative revision.
 */
export interface FilePlaybackPauseTransitionIntent {
  readonly kind: 'file-playback-pause-transition';
  readonly from: RevisionedPlaybackRun;
  readonly to: RevisionedPlaybackRun;
  readonly atRoomTimeMs: number;
}

export interface FilePlaybackSeekTransitionIntent {
  readonly kind: 'file-playback-seek-transition';
  readonly from: RevisionedPlaybackRun;
  readonly to: RevisionedPlaybackRun;
  readonly positionSeconds: number;
  readonly atRoomTimeMs: number;
}

export type FilePlaybackTransitionIntent =
  | FilePlaybackPauseTransitionIntent
  | FilePlaybackSeekTransitionIntent;

export type FilePlaybackTransitionRejectReason =
  | 'invalid-contract'
  | 'operation-superseded'
  | 'identity-mismatch'
  | 'non-consecutive-revision'
  | 'wrong-phase'
  | 'playing-seek-requires-cutover'
  | 'transition-pending'
  | 'audio-context-not-running'
  | 'clock-unavailable'
  | 'target-not-in-future'
  | 'target-after-media-end'
  | 'position-out-of-range'
  | 'schedule-failed'
  | 'source-failed'
  | 'source-destroyed';

export type FilePlaybackTransitionObservation = 'webaudio-schedule-passed' | 'worklet-observed';

export interface FilePlaybackPauseTransitionEvidence {
  readonly kind: 'pause-applied';
  readonly observation: FilePlaybackTransitionObservation;
  readonly from: RevisionedPlaybackRun;
  readonly to: RevisionedPlaybackRun;
  readonly targetFrame: number;
  readonly appliedFrame: number;
}

export interface FilePlaybackSeekTransitionEvidence {
  readonly kind: 'seek-applied';
  readonly observation: FilePlaybackTransitionObservation;
  readonly from: RevisionedPlaybackRun;
  readonly to: RevisionedPlaybackRun;
  readonly targetFrame: number;
  readonly appliedFrame: number;
  readonly positionSeconds: number;
}

export type FilePlaybackTransitionEvidence =
  | FilePlaybackPauseTransitionEvidence
  | FilePlaybackSeekTransitionEvidence;

export type FilePlaybackTransitionResult =
  | Readonly<{
      readonly status: 'scheduled';
      readonly reason: null;
      readonly from: RevisionedPlaybackRun;
      readonly to: RevisionedPlaybackRun;
      readonly target: FilePlaybackCutoverTarget;
      /** Snapshot before the native boundary; it must still identify `from`. */
      readonly snapshot: FilePlaybackSourceSnapshot;
      readonly applied: Promise<FilePlaybackTransitionEvidence>;
    }>
  | Readonly<{
      readonly status: 'rejected';
      readonly reason: FilePlaybackTransitionRejectReason;
      readonly from: RevisionedPlaybackRun | null;
      readonly to: RevisionedPlaybackRun | null;
      readonly target: null;
      readonly snapshot: FilePlaybackSourceSnapshot;
      readonly applied: null;
    }>;

export interface FilePlaybackCancelIntent extends RevisionedPlaybackRun {
  readonly kind: 'file-playback-cancel';
  readonly rendezvousId: string;
  readonly reasonCode: string;
}

/**
 * Exact, process-local Web Audio target selected by a playback backend.
 *
 * This value is deliberately not JSON-safe and must never cross a wire or be
 * persisted. The AudioContext identity lets the active-source manager prove
 * that a silent candidate and its outer gate use the same native clock.
 */
export interface FilePlaybackCutoverTarget {
  readonly audioContext: AudioContext;
  readonly contextTimeSeconds: number;
  readonly targetFrame: number;
}

export interface AudioBufferPlaybackStartEvidence {
  readonly kind: 'webaudio-schedule-passed';
  readonly targetFrame: number;
}

/** Native start observation produced by any bounded PCM AudioWorklet backend. */
export interface StreamingPlaybackStartEvidence {
  readonly kind: 'worklet-observed';
  readonly targetFrame: number;
  readonly actualStartFrame: number;
}

/** @deprecated Use StreamingPlaybackStartEvidence. */
export type StreamingFlacPlaybackStartEvidence = StreamingPlaybackStartEvidence;

export type FilePlaybackStartEvidence =
  | AudioBufferPlaybackStartEvidence
  | StreamingPlaybackStartEvidence;

export type FilePlaybackCutoverArmResult =
  | Readonly<{
      readonly status: 'armed';
      readonly receipt: RendezvousArmReceipt;
      readonly target: FilePlaybackCutoverTarget;
      readonly started: Promise<FilePlaybackStartEvidence>;
    }>
  | Readonly<{
      readonly status: 'rejected';
      readonly receipt: RendezvousArmReceipt;
      readonly target: null;
      readonly started: null;
    }>;

/**
 * Common runtime contract for decoded AudioBuffer and bounded streaming-FLAC
 * backends. Implementations own their native objects and must never place them
 * in getSnapshot()/position() results or application global state.
 */
export interface FilePlaybackSource {
  /** Immutable queue occurrence identity assigned when the source is created. */
  readonly queueItemId: QueueItemId;
  readonly backend: FilePlaybackBackend;

  /** Prime/decode without connecting to the audible product graph. */
  prepare(): Promise<FilePlaybackSourceSnapshot>;
  /** Attach an already prepared source to the active product graph. */
  connect(destination: AudioNode): Promise<FilePlaybackSourceSnapshot>;
  arm(intent: RendezvousArmIntent): Promise<RendezvousArmReceipt>;
  finalize(intent: RendezvousFinalizeIntent): Promise<RendezvousFinalizeReceipt>;
  cancel(intent: FilePlaybackCancelIntent): Promise<FilePlaybackSourceSnapshot>;
  /** @deprecated Snapshot-only legacy control; it cannot advance a revision. */
  pause(intent: FilePlaybackPauseIntent): Promise<FilePlaybackSourceSnapshot>;
  /** @deprecated Snapshot-only legacy control; it cannot advance a revision. */
  seek(intent: FilePlaybackSeekIntent): Promise<FilePlaybackSourceSnapshot>;
  positionAt(localPerformanceTimeMs: number): FilePlaybackPosition;
  getSnapshot(): FilePlaybackSourceSnapshot;
  destroy(): Promise<void>;
}

/**
 * Local-only extension used by the atomic active-source cutover coordinator.
 * Keeping it as a subtype leaves existing FilePlaybackSource fakes and asset-
 * only preload implementations source-compatible.
 */
export interface FilePlaybackCutoverSource extends FilePlaybackSource {
  armForCutover(intent: RendezvousArmIntent): Promise<FilePlaybackCutoverArmResult>;
  pauseRevisioned(intent: FilePlaybackPauseTransitionIntent): Promise<FilePlaybackTransitionResult>;
  seekRevisioned(intent: FilePlaybackSeekTransitionIntent): Promise<FilePlaybackTransitionResult>;
}

const SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion',
  'queueItemId',
  'backend',
  'phase',
  'revision',
  'run',
  'durationSeconds',
  'positionSeconds',
  'bufferedAheadSeconds',
  'outputSampleRateHz',
  'channelCount',
  'underrunCount',
  'errorCode',
] as const);
const SNAPSHOT_KEY_SET: ReadonlySet<string> = new Set(SNAPSHOT_KEYS);
const PAUSE_INTENT_KEYS = Object.freeze([
  'kind',
  'queueItemId',
  'runId',
  'revision',
  'atRoomTimeMs',
] as const);
const PAUSE_INTENT_KEY_SET: ReadonlySet<string> = new Set(PAUSE_INTENT_KEYS);
const SEEK_INTENT_KEYS = Object.freeze([...PAUSE_INTENT_KEYS, 'positionSeconds'] as const);
const SEEK_INTENT_KEY_SET: ReadonlySet<string> = new Set(SEEK_INTENT_KEYS);
const PAUSE_TRANSITION_INTENT_KEYS = Object.freeze(['kind', 'from', 'to', 'atRoomTimeMs'] as const);
const PAUSE_TRANSITION_INTENT_KEY_SET: ReadonlySet<string> = new Set(PAUSE_TRANSITION_INTENT_KEYS);
const SEEK_TRANSITION_INTENT_KEYS = Object.freeze([
  ...PAUSE_TRANSITION_INTENT_KEYS,
  'positionSeconds',
] as const);
const SEEK_TRANSITION_INTENT_KEY_SET: ReadonlySet<string> = new Set(SEEK_TRANSITION_INTENT_KEYS);
const CANCEL_INTENT_KEYS = Object.freeze([
  'kind',
  'queueItemId',
  'runId',
  'revision',
  'rendezvousId',
  'reasonCode',
] as const);
const CANCEL_INTENT_KEY_SET: ReadonlySet<string> = new Set(CANCEL_INTENT_KEYS);
const CUTOVER_TARGET_KEYS = Object.freeze([
  'audioContext',
  'contextTimeSeconds',
  'targetFrame',
] as const);
const CUTOVER_TARGET_KEY_SET: ReadonlySet<string> = new Set(CUTOVER_TARGET_KEYS);
const AUDIO_BUFFER_START_EVIDENCE_KEYS = Object.freeze(['kind', 'targetFrame'] as const);
const AUDIO_BUFFER_START_EVIDENCE_KEY_SET: ReadonlySet<string> = new Set(
  AUDIO_BUFFER_START_EVIDENCE_KEYS,
);
const STREAMING_START_EVIDENCE_KEYS = Object.freeze([
  'kind',
  'targetFrame',
  'actualStartFrame',
] as const);
const STREAMING_START_EVIDENCE_KEY_SET: ReadonlySet<string> = new Set(
  STREAMING_START_EVIDENCE_KEYS,
);
const PAUSE_TRANSITION_EVIDENCE_KEYS = Object.freeze([
  'kind',
  'observation',
  'from',
  'to',
  'targetFrame',
  'appliedFrame',
] as const);
const PAUSE_TRANSITION_EVIDENCE_KEY_SET: ReadonlySet<string> = new Set(
  PAUSE_TRANSITION_EVIDENCE_KEYS,
);
const SEEK_TRANSITION_EVIDENCE_KEYS = Object.freeze([
  ...PAUSE_TRANSITION_EVIDENCE_KEYS,
  'positionSeconds',
] as const);
const SEEK_TRANSITION_EVIDENCE_KEY_SET: ReadonlySet<string> = new Set(
  SEEK_TRANSITION_EVIDENCE_KEYS,
);
const TRANSITION_RESULT_KEYS = Object.freeze([
  'status',
  'reason',
  'from',
  'to',
  'target',
  'snapshot',
  'applied',
] as const);
const TRANSITION_RESULT_KEY_SET: ReadonlySet<string> = new Set(TRANSITION_RESULT_KEYS);
const VALID_PHASES: ReadonlySet<FilePlaybackSourcePhase> = new Set([
  'new',
  'preparing',
  'ready',
  'connected',
  'armed',
  'playing',
  'paused',
  'ended',
  'cancelled',
  'failed',
  'destroyed',
]);
const TRANSITION_REJECT_REASONS: ReadonlySet<FilePlaybackTransitionRejectReason> = new Set([
  'invalid-contract',
  'operation-superseded',
  'identity-mismatch',
  'non-consecutive-revision',
  'wrong-phase',
  'playing-seek-requires-cutover',
  'transition-pending',
  'audio-context-not-running',
  'clock-unavailable',
  'target-not-in-future',
  'target-after-media-end',
  'position-out-of-range',
  'schedule-failed',
  'source-failed',
  'source-destroyed',
]);
const MAX_TEXT_LENGTH = 256;

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOptionalFinitePositive(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}

function isOptionalPositiveInteger(value: unknown, maximum: number): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum)
  );
}

function isOptionalErrorCode(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH)
  );
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

function freezeControlIntent<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readContextSampleRate(audioContext: AudioContext): number | null {
  try {
    const sampleRate = audioContext.sampleRate;
    return Number.isFinite(sampleRate) && sampleRate > 0 && sampleRate <= 1_000_000
      ? sampleRate
      : null;
  } catch {
    return null;
  }
}

/** Creates a canonical local target after proving its time/frame relationship. */
export function createFilePlaybackCutoverTarget(
  audioContext: AudioContext,
  contextTimeSeconds: number,
  targetFrame: number,
): FilePlaybackCutoverTarget {
  const sampleRate = readContextSampleRate(audioContext);
  if (
    sampleRate === null ||
    !isFiniteNonNegative(contextTimeSeconds) ||
    !isSafeNonNegativeInteger(targetFrame) ||
    Math.round(contextTimeSeconds * sampleRate) !== targetFrame
  ) {
    throw new TypeError('File playback cutover target is invalid');
  }
  return freezeControlIntent({ audioContext, contextTimeSeconds, targetFrame });
}

/**
 * Descriptor-safe target reader for the manager boundary. The expected native
 * context is mandatory so an arbitrary lookalike cannot introduce a clock.
 */
export function readFilePlaybackCutoverTarget(
  value: unknown,
  expectedAudioContext: AudioContext,
): FilePlaybackCutoverTarget | null {
  const candidate = snapshotExactDataRecord(value, CUTOVER_TARGET_KEYS, CUTOVER_TARGET_KEY_SET);
  if (!candidate || candidate.audioContext !== expectedAudioContext) return null;
  try {
    return createFilePlaybackCutoverTarget(
      expectedAudioContext,
      candidate.contextTimeSeconds as number,
      candidate.targetFrame as number,
    );
  } catch {
    return null;
  }
}

export function createAudioBufferPlaybackStartEvidence(
  targetFrame: number,
): AudioBufferPlaybackStartEvidence {
  if (!isSafeNonNegativeInteger(targetFrame)) {
    throw new TypeError('AudioBuffer playback start evidence is invalid');
  }
  return freezeControlIntent({ kind: 'webaudio-schedule-passed' as const, targetFrame });
}

export function createStreamingPlaybackStartEvidence(
  targetFrame: number,
  actualStartFrame: number,
): StreamingPlaybackStartEvidence {
  if (
    !isSafeNonNegativeInteger(targetFrame) ||
    !isSafeNonNegativeInteger(actualStartFrame) ||
    actualStartFrame !== targetFrame
  ) {
    throw new TypeError('Streaming playback start evidence is invalid');
  }
  return freezeControlIntent({ kind: 'worklet-observed' as const, targetFrame, actualStartFrame });
}

/** @deprecated Use createStreamingPlaybackStartEvidence. */
export const createStreamingFlacPlaybackStartEvidence = createStreamingPlaybackStartEvidence;

/** Canonicalizes exact backend evidence without invoking application accessors. */
export function readFilePlaybackStartEvidence(
  value: unknown,
  expectedTargetFrame: number,
): FilePlaybackStartEvidence | null {
  if (!isSafeNonNegativeInteger(expectedTargetFrame)) return null;
  const kindDescriptor = (() => {
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
      return Object.getOwnPropertyDescriptor(value, 'kind');
    } catch {
      return null;
    }
  })();
  if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value')) return null;
  if (kindDescriptor.value === 'webaudio-schedule-passed') {
    const candidate = snapshotExactDataRecord(
      value,
      AUDIO_BUFFER_START_EVIDENCE_KEYS,
      AUDIO_BUFFER_START_EVIDENCE_KEY_SET,
    );
    if (
      !candidate ||
      candidate.kind !== 'webaudio-schedule-passed' ||
      candidate.targetFrame !== expectedTargetFrame
    ) {
      return null;
    }
    try {
      return createAudioBufferPlaybackStartEvidence(candidate.targetFrame as number);
    } catch {
      return null;
    }
  }
  if (kindDescriptor.value === 'worklet-observed') {
    const candidate = snapshotExactDataRecord(
      value,
      STREAMING_START_EVIDENCE_KEYS,
      STREAMING_START_EVIDENCE_KEY_SET,
    );
    if (
      !candidate ||
      candidate.kind !== 'worklet-observed' ||
      candidate.targetFrame !== expectedTargetFrame
    ) {
      return null;
    }
    try {
      return createStreamingPlaybackStartEvidence(
        candidate.targetFrame as number,
        candidate.actualStartFrame as number,
      );
    } catch {
      return null;
    }
  }
  return null;
}

function sameCanonicalState(left: RevisionedPlaybackRun, right: RevisionedPlaybackRun): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision
  );
}

export function sameFilePlaybackTransitionIntent(
  left: FilePlaybackTransitionIntent,
  right: FilePlaybackTransitionIntent,
): boolean {
  const safeLeft = readFilePlaybackTransitionIntent(left);
  const safeRight = readFilePlaybackTransitionIntent(right);
  return (
    safeLeft !== null &&
    safeRight !== null &&
    safeLeft.kind === safeRight.kind &&
    sameCanonicalState(safeLeft.from, safeRight.from) &&
    sameCanonicalState(safeLeft.to, safeRight.to) &&
    safeLeft.atRoomTimeMs === safeRight.atRoomTimeMs &&
    (safeLeft.kind === 'file-playback-pause-transition' ||
      (safeRight.kind === 'file-playback-seek-transition' &&
        safeLeft.positionSeconds === safeRight.positionSeconds))
  );
}

export function createFilePlaybackTransitionEvidence(
  intent: FilePlaybackTransitionIntent,
  observation: FilePlaybackTransitionObservation,
  targetFrame: number,
  appliedFrame: number,
): FilePlaybackTransitionEvidence {
  const canonical = readFilePlaybackTransitionIntent(intent);
  if (
    !canonical ||
    !isConsecutiveFilePlaybackTransition(canonical.from, canonical.to) ||
    (observation !== 'webaudio-schedule-passed' && observation !== 'worklet-observed') ||
    !isSafeNonNegativeInteger(targetFrame) ||
    !isSafeNonNegativeInteger(appliedFrame) ||
    appliedFrame < targetFrame ||
    (canonical.kind === 'file-playback-pause-transition' &&
      observation === 'worklet-observed' &&
      appliedFrame !== targetFrame)
  ) {
    throw new TypeError('File playback transition evidence is invalid');
  }
  if (canonical.kind === 'file-playback-pause-transition') {
    return freezeControlIntent({
      kind: 'pause-applied',
      observation,
      from: canonical.from,
      to: canonical.to,
      targetFrame,
      appliedFrame,
    });
  }
  return freezeControlIntent({
    kind: 'seek-applied',
    observation,
    from: canonical.from,
    to: canonical.to,
    targetFrame,
    appliedFrame,
    positionSeconds: canonical.positionSeconds,
  });
}

export function readFilePlaybackTransitionEvidence(
  value: unknown,
  expectedIntent: FilePlaybackTransitionIntent,
  expectedObservation?: FilePlaybackTransitionObservation,
  expectedTargetFrame?: number,
): FilePlaybackTransitionEvidence | null {
  const intent = readFilePlaybackTransitionIntent(expectedIntent);
  if (!intent || !isConsecutiveFilePlaybackTransition(intent.from, intent.to)) return null;
  const expectedKind =
    intent.kind === 'file-playback-pause-transition' ? 'pause-applied' : 'seek-applied';
  const keys =
    expectedKind === 'pause-applied'
      ? PAUSE_TRANSITION_EVIDENCE_KEYS
      : SEEK_TRANSITION_EVIDENCE_KEYS;
  const keySet =
    expectedKind === 'pause-applied'
      ? PAUSE_TRANSITION_EVIDENCE_KEY_SET
      : SEEK_TRANSITION_EVIDENCE_KEY_SET;
  const candidate = snapshotExactDataRecord(value, keys, keySet);
  const identities = candidate ? readTransitionIdentities(candidate) : null;
  if (
    !candidate ||
    !identities ||
    candidate.kind !== expectedKind ||
    (candidate.observation !== 'webaudio-schedule-passed' &&
      candidate.observation !== 'worklet-observed') ||
    (expectedObservation !== undefined && candidate.observation !== expectedObservation) ||
    !sameCanonicalState(identities.from, intent.from) ||
    !sameCanonicalState(identities.to, intent.to) ||
    !isSafeNonNegativeInteger(candidate.targetFrame) ||
    !isSafeNonNegativeInteger(candidate.appliedFrame) ||
    candidate.appliedFrame < candidate.targetFrame ||
    (expectedTargetFrame !== undefined && candidate.targetFrame !== expectedTargetFrame) ||
    (intent.kind === 'file-playback-seek-transition' &&
      candidate.positionSeconds !== intent.positionSeconds)
  ) {
    return null;
  }
  try {
    return createFilePlaybackTransitionEvidence(
      intent,
      candidate.observation,
      candidate.targetFrame,
      candidate.appliedFrame,
    );
  } catch {
    return null;
  }
}

export function readFilePlaybackPauseIntent(
  value: unknown,
): Readonly<FilePlaybackPauseIntent> | null {
  const candidate = snapshotExactDataRecord(value, PAUSE_INTENT_KEYS, PAUSE_INTENT_KEY_SET);
  const identity = candidate ? readPlaybackStateIdentity(candidate) : null;
  if (
    !candidate ||
    !identity ||
    candidate.kind !== 'file-playback-pause' ||
    !isFiniteNonNegative(candidate.atRoomTimeMs)
  ) {
    return null;
  }
  return freezeControlIntent({
    kind: 'file-playback-pause',
    ...identity,
    atRoomTimeMs: candidate.atRoomTimeMs,
  });
}

export function readFilePlaybackSeekIntent(
  value: unknown,
): Readonly<FilePlaybackSeekIntent> | null {
  const candidate = snapshotExactDataRecord(value, SEEK_INTENT_KEYS, SEEK_INTENT_KEY_SET);
  const identity = candidate ? readPlaybackStateIdentity(candidate) : null;
  if (
    !candidate ||
    !identity ||
    candidate.kind !== 'file-playback-seek' ||
    !isFiniteNonNegative(candidate.atRoomTimeMs) ||
    !isFiniteNonNegative(candidate.positionSeconds)
  ) {
    return null;
  }
  return freezeControlIntent({
    kind: 'file-playback-seek',
    ...identity,
    positionSeconds: candidate.positionSeconds,
    atRoomTimeMs: candidate.atRoomTimeMs,
  });
}

function samePlaybackRunIdentity(
  left: RevisionedPlaybackRun,
  right: RevisionedPlaybackRun,
): boolean {
  return left.queueItemId === right.queueItemId && left.runId === right.runId;
}

export function isConsecutiveFilePlaybackTransition(
  from: RevisionedPlaybackRun,
  to: RevisionedPlaybackRun,
): boolean {
  const safeFrom = readPlaybackStateIdentity(from);
  const safeTo = readPlaybackStateIdentity(to);
  return (
    safeFrom !== null &&
    safeTo !== null &&
    samePlaybackRunIdentity(safeFrom, safeTo) &&
    safeFrom.revision < Number.MAX_SAFE_INTEGER &&
    safeTo.revision === safeFrom.revision + 1
  );
}

function readTransitionIdentities(
  candidate: Readonly<Record<string, unknown>>,
): Readonly<{ from: RevisionedPlaybackRun; to: RevisionedPlaybackRun }> | null {
  const from = readPlaybackStateIdentity(candidate.from);
  const to = readPlaybackStateIdentity(candidate.to);
  if (!from || !to) return null;
  return freezeControlIntent({ from, to });
}

export function readFilePlaybackPauseTransitionIntent(
  value: unknown,
): Readonly<FilePlaybackPauseTransitionIntent> | null {
  const candidate = snapshotExactDataRecord(
    value,
    PAUSE_TRANSITION_INTENT_KEYS,
    PAUSE_TRANSITION_INTENT_KEY_SET,
  );
  const identities = candidate ? readTransitionIdentities(candidate) : null;
  if (
    !candidate ||
    !identities ||
    candidate.kind !== 'file-playback-pause-transition' ||
    !isFiniteNonNegative(candidate.atRoomTimeMs)
  ) {
    return null;
  }
  return freezeControlIntent({
    kind: 'file-playback-pause-transition',
    from: identities.from,
    to: identities.to,
    atRoomTimeMs: candidate.atRoomTimeMs,
  });
}

export function readFilePlaybackSeekTransitionIntent(
  value: unknown,
): Readonly<FilePlaybackSeekTransitionIntent> | null {
  const candidate = snapshotExactDataRecord(
    value,
    SEEK_TRANSITION_INTENT_KEYS,
    SEEK_TRANSITION_INTENT_KEY_SET,
  );
  const identities = candidate ? readTransitionIdentities(candidate) : null;
  if (
    !candidate ||
    !identities ||
    candidate.kind !== 'file-playback-seek-transition' ||
    !isFiniteNonNegative(candidate.atRoomTimeMs) ||
    !isFiniteNonNegative(candidate.positionSeconds)
  ) {
    return null;
  }
  return freezeControlIntent({
    kind: 'file-playback-seek-transition',
    from: identities.from,
    to: identities.to,
    positionSeconds: candidate.positionSeconds,
    atRoomTimeMs: candidate.atRoomTimeMs,
  });
}

export function readFilePlaybackTransitionIntent(
  value: unknown,
): Readonly<FilePlaybackTransitionIntent> | null {
  const kindDescriptor = (() => {
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
      return Object.getOwnPropertyDescriptor(value, 'kind');
    } catch {
      return null;
    }
  })();
  if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value')) return null;
  if (kindDescriptor.value === 'file-playback-pause-transition') {
    return readFilePlaybackPauseTransitionIntent(value);
  }
  if (kindDescriptor.value === 'file-playback-seek-transition') {
    return readFilePlaybackSeekTransitionIntent(value);
  }
  return null;
}

export function readFilePlaybackCancelIntent(
  value: unknown,
): Readonly<FilePlaybackCancelIntent> | null {
  const candidate = snapshotExactDataRecord(value, CANCEL_INTENT_KEYS, CANCEL_INTENT_KEY_SET);
  const identity = candidate ? readPlaybackAttemptIdentity(candidate) : null;
  if (
    !candidate ||
    !identity ||
    candidate.kind !== 'file-playback-cancel' ||
    !isOptionalErrorCode(candidate.reasonCode) ||
    candidate.reasonCode === null
  ) {
    return null;
  }
  return freezeControlIntent({
    kind: 'file-playback-cancel',
    ...identity,
    reasonCode: candidate.reasonCode,
  });
}

function canonicalSourceSnapshot(value: unknown): FilePlaybackSourceSnapshot | null {
  const candidate = snapshotExactDataRecord(value, SNAPSHOT_KEYS, SNAPSHOT_KEY_SET);
  if (!candidate) return null;
  if (candidate.schemaVersion !== 1) return null;
  if (
    typeof candidate.queueItemId !== 'string' ||
    candidate.queueItemId.length === 0 ||
    candidate.queueItemId.length > MAX_TEXT_LENGTH
  ) {
    return null;
  }
  if (candidate.backend !== 'audio-buffer' && candidate.backend !== 'streaming-flac') {
    return null;
  }
  if (!VALID_PHASES.has(candidate.phase as FilePlaybackSourcePhase)) return null;
  if (!isPlaybackRevisionWatermark(candidate.revision)) return null;
  let run: RevisionedPlaybackRun | null = null;
  if (candidate.run !== null) {
    try {
      run = createPlaybackStateIdentity(candidate.run as RevisionedPlaybackRun);
    } catch {
      return null;
    }
    if (run.queueItemId !== candidate.queueItemId) return null;
    if (run.revision !== candidate.revision) return null;
  }
  if (
    (candidate.phase === 'armed' ||
      candidate.phase === 'playing' ||
      candidate.phase === 'paused') &&
    run === null
  ) {
    return null;
  }
  if (!isOptionalFinitePositive(candidate.durationSeconds)) return null;
  if (!isFiniteNonNegative(candidate.positionSeconds)) return null;
  if (!isFiniteNonNegative(candidate.bufferedAheadSeconds)) return null;
  if (!isOptionalPositiveInteger(candidate.outputSampleRateHz, 1_000_000)) return null;
  if (!isOptionalPositiveInteger(candidate.channelCount, 8)) return null;
  if (
    typeof candidate.underrunCount !== 'number' ||
    !Number.isSafeInteger(candidate.underrunCount) ||
    candidate.underrunCount < 0
  ) {
    return null;
  }
  if (!isOptionalErrorCode(candidate.errorCode)) return null;

  return Object.freeze({
    schemaVersion: 1,
    queueItemId: candidate.queueItemId as QueueItemId,
    backend: candidate.backend,
    phase: candidate.phase as FilePlaybackSourcePhase,
    revision: candidate.revision,
    run,
    durationSeconds: candidate.durationSeconds,
    positionSeconds: candidate.positionSeconds,
    bufferedAheadSeconds: candidate.bufferedAheadSeconds,
    outputSampleRateHz: candidate.outputSampleRateHz,
    channelCount: candidate.channelCount,
    underrunCount: candidate.underrunCount,
    errorCode: candidate.errorCode,
  });
}

export function isFilePlaybackSourceSnapshot(value: unknown): value is FilePlaybackSourceSnapshot {
  return canonicalSourceSnapshot(value) !== null;
}

/**
 * Validates, strips unexpected properties, and freezes a source snapshot. This
 * is the boundary used before state publication or wire serialization.
 */
export function createFilePlaybackSourceSnapshot(
  input: FilePlaybackSourceSnapshot,
): FilePlaybackSourceSnapshot {
  const snapshot = canonicalSourceSnapshot(input);
  if (snapshot) return snapshot;
  throw new TypeError('File playback source snapshot is invalid');
}

function snapshotIdentifiesState(
  snapshot: FilePlaybackSourceSnapshot,
  state: RevisionedPlaybackRun,
): boolean {
  return snapshot.run !== null && sameCanonicalState(snapshot.run, state);
}

export function createFilePlaybackScheduledTransitionResult(
  intent: FilePlaybackTransitionIntent,
  target: FilePlaybackCutoverTarget,
  snapshot: FilePlaybackSourceSnapshot,
  applied: Promise<FilePlaybackTransitionEvidence>,
): Extract<FilePlaybackTransitionResult, { readonly status: 'scheduled' }> {
  const canonicalIntent = readFilePlaybackTransitionIntent(intent);
  const canonicalSnapshot = createFilePlaybackSourceSnapshot(snapshot);
  if (
    !canonicalIntent ||
    !isConsecutiveFilePlaybackTransition(canonicalIntent.from, canonicalIntent.to) ||
    !snapshotIdentifiesState(canonicalSnapshot, canonicalIntent.from) ||
    !(applied instanceof Promise)
  ) {
    throw new TypeError('Scheduled file playback transition result is invalid');
  }
  const canonicalTarget = readFilePlaybackCutoverTarget(target, target.audioContext);
  if (!canonicalTarget) {
    throw new TypeError('Scheduled file playback transition target is invalid');
  }
  return freezeControlIntent({
    status: 'scheduled',
    reason: null,
    from: canonicalIntent.from,
    to: canonicalIntent.to,
    target: canonicalTarget,
    snapshot: canonicalSnapshot,
    applied,
  });
}

export function createFilePlaybackRejectedTransitionResult(
  intent: FilePlaybackTransitionIntent | null,
  reason: FilePlaybackTransitionRejectReason,
  snapshot: FilePlaybackSourceSnapshot,
): Extract<FilePlaybackTransitionResult, { readonly status: 'rejected' }> {
  const canonicalIntent = intent ? readFilePlaybackTransitionIntent(intent) : null;
  if (!TRANSITION_REJECT_REASONS.has(reason)) {
    throw new TypeError('File playback transition rejection reason is invalid');
  }
  return freezeControlIntent({
    status: 'rejected',
    reason,
    from: canonicalIntent?.from ?? null,
    to: canonicalIntent?.to ?? null,
    target: null,
    snapshot: createFilePlaybackSourceSnapshot(snapshot),
    applied: null,
  });
}

/**
 * Canonicalizes a backend transition result at the manager boundary. Native
 * promises are retained as opaque process-local evidence channels; no thenable
 * or accessor is invoked during this synchronous read.
 */
export function readFilePlaybackTransitionResult(
  value: unknown,
  expectedIntent: FilePlaybackTransitionIntent,
  expectedAudioContext: AudioContext,
): FilePlaybackTransitionResult | null {
  const intent = readFilePlaybackTransitionIntent(expectedIntent);
  const candidate = snapshotExactDataRecord(
    value,
    TRANSITION_RESULT_KEYS,
    TRANSITION_RESULT_KEY_SET,
  );
  if (!intent || !candidate) return null;
  const snapshot = canonicalSourceSnapshot(candidate.snapshot);
  if (!snapshot) return null;
  const status = candidate.status;
  const from = candidate.from === null ? null : readPlaybackStateIdentity(candidate.from);
  const to = candidate.to === null ? null : readPlaybackStateIdentity(candidate.to);
  if (status === 'rejected') {
    if (
      !TRANSITION_REJECT_REASONS.has(candidate.reason as FilePlaybackTransitionRejectReason) ||
      !from ||
      !to ||
      !sameCanonicalState(from, intent.from) ||
      !sameCanonicalState(to, intent.to) ||
      candidate.target !== null ||
      candidate.applied !== null
    ) {
      return null;
    }
    return createFilePlaybackRejectedTransitionResult(
      intent,
      candidate.reason as FilePlaybackTransitionRejectReason,
      snapshot,
    );
  }
  if (
    status !== 'scheduled' ||
    candidate.reason !== null ||
    !from ||
    !to ||
    !sameCanonicalState(from, intent.from) ||
    !sameCanonicalState(to, intent.to) ||
    !snapshotIdentifiesState(snapshot, intent.from) ||
    !(candidate.applied instanceof Promise)
  ) {
    return null;
  }
  const target = readFilePlaybackCutoverTarget(candidate.target, expectedAudioContext);
  if (!target) return null;
  try {
    return createFilePlaybackScheduledTransitionResult(
      intent,
      target,
      snapshot,
      candidate.applied as Promise<FilePlaybackTransitionEvidence>,
    );
  } catch {
    return null;
  }
}

export function sourceOwnsRevisionedRun(
  source: Pick<FilePlaybackSource, 'queueItemId'>,
  run: RevisionedPlaybackRun,
): boolean {
  const canonical = readPlaybackStateIdentity(run);
  return canonical !== null && source.queueItemId === canonical.queueItemId;
}
