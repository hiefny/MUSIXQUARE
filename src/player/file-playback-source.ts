import type { QueueItemId } from '../types/index.ts';
import {
  createPlaybackStateIdentity,
  isPlaybackRevisionWatermark,
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

export interface FilePlaybackPauseIntent extends RevisionedPlaybackRun {
  readonly kind: 'file-playback-pause';
  readonly atRoomTimeMs: number;
}

export interface FilePlaybackSeekIntent extends RevisionedPlaybackRun {
  readonly kind: 'file-playback-seek';
  readonly positionSeconds: number;
  readonly atRoomTimeMs: number;
}

export interface FilePlaybackCancelIntent extends RevisionedPlaybackRun {
  readonly kind: 'file-playback-cancel';
  readonly reasonCode: string;
}

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
  pause(intent: FilePlaybackPauseIntent): Promise<FilePlaybackSourceSnapshot>;
  seek(intent: FilePlaybackSeekIntent): Promise<FilePlaybackSourceSnapshot>;
  positionAt(localPerformanceTimeMs: number): FilePlaybackPosition;
  getSnapshot(): FilePlaybackSourceSnapshot;
  destroy(): Promise<void>;
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
const CANCEL_INTENT_KEYS = Object.freeze([
  'kind',
  'queueItemId',
  'runId',
  'revision',
  'reasonCode',
] as const);
const CANCEL_INTENT_KEY_SET: ReadonlySet<string> = new Set(CANCEL_INTENT_KEYS);
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

export function readFilePlaybackCancelIntent(
  value: unknown,
): Readonly<FilePlaybackCancelIntent> | null {
  const candidate = snapshotExactDataRecord(value, CANCEL_INTENT_KEYS, CANCEL_INTENT_KEY_SET);
  const identity = candidate ? readPlaybackStateIdentity(candidate) : null;
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

export function sourceOwnsRevisionedRun(
  source: Pick<FilePlaybackSource, 'queueItemId'>,
  run: RevisionedPlaybackRun,
): boolean {
  const canonical = readPlaybackStateIdentity(run);
  return canonical !== null && source.queueItemId === canonical.queueItemId;
}
