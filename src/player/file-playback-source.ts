import type { QueueItemId } from '../types/index.ts';
import { isPlaybackRevision, type PlaybackRevision } from './playback-timeline.ts';
import {
  isRevisionedPlaybackRun,
  type RendezvousArmIntent,
  type RendezvousArmReceipt,
  type RendezvousFinalizeIntent,
  type RendezvousFinalizeReceipt,
  type RevisionedPlaybackRun,
} from './rendezvous-contract.ts';

export type FilePlaybackBackend = 'audio-buffer' | 'streaming-flac';

export type FilePlaybackSourcePhase =
  | 'new'
  | 'connecting'
  | 'ready'
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
  readonly revision: PlaybackRevision;
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

const SNAPSHOT_KEYS = new Set([
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
]);
const RUN_KEYS = new Set(['queueItemId', 'runId', 'revision']);
const VALID_PHASES: ReadonlySet<FilePlaybackSourcePhase> = new Set([
  'new',
  'connecting',
  'ready',
  'armed',
  'playing',
  'paused',
  'ended',
  'cancelled',
  'failed',
  'destroyed',
]);
const MAX_TEXT_LENGTH = 256;

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.size && ownKeys.every((key) => keys.has(key));
}

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

function isExactRevisionedRun(value: unknown): value is RevisionedPlaybackRun {
  return (
    !!value &&
    typeof value === 'object' &&
    hasOnlyKeys(value as Record<string, unknown>, RUN_KEYS) &&
    isRevisionedPlaybackRun(value)
  );
}

export function isFilePlaybackSourceSnapshot(value: unknown): value is FilePlaybackSourceSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!hasOnlyKeys(candidate, SNAPSHOT_KEYS)) return false;
  if (candidate.schemaVersion !== 1) return false;
  if (
    typeof candidate.queueItemId !== 'string' ||
    candidate.queueItemId.length === 0 ||
    candidate.queueItemId.length > MAX_TEXT_LENGTH
  ) {
    return false;
  }
  if (candidate.backend !== 'audio-buffer' && candidate.backend !== 'streaming-flac') {
    return false;
  }
  if (!VALID_PHASES.has(candidate.phase as FilePlaybackSourcePhase)) return false;
  if (!isPlaybackRevision(candidate.revision)) return false;
  if (candidate.run !== null) {
    if (!isExactRevisionedRun(candidate.run)) return false;
    if (candidate.run.queueItemId !== candidate.queueItemId) return false;
    if (candidate.run.revision !== candidate.revision) return false;
  }
  if (
    (candidate.phase === 'armed' ||
      candidate.phase === 'playing' ||
      candidate.phase === 'paused') &&
    candidate.run === null
  ) {
    return false;
  }
  if (!isOptionalFinitePositive(candidate.durationSeconds)) return false;
  if (!isFiniteNonNegative(candidate.positionSeconds)) return false;
  if (!isFiniteNonNegative(candidate.bufferedAheadSeconds)) return false;
  if (!isOptionalPositiveInteger(candidate.outputSampleRateHz, 1_000_000)) return false;
  if (!isOptionalPositiveInteger(candidate.channelCount, 8)) return false;
  if (
    typeof candidate.underrunCount !== 'number' ||
    !Number.isSafeInteger(candidate.underrunCount) ||
    candidate.underrunCount < 0
  ) {
    return false;
  }
  return isOptionalErrorCode(candidate.errorCode);
}

function immutableRun(run: RevisionedPlaybackRun): RevisionedPlaybackRun {
  return Object.freeze({
    queueItemId: run.queueItemId,
    runId: run.runId,
    revision: run.revision,
  });
}

/**
 * Validates, strips unexpected properties, and freezes a source snapshot. This
 * is the boundary used before state publication or wire serialization.
 */
export function createFilePlaybackSourceSnapshot(
  input: FilePlaybackSourceSnapshot,
): FilePlaybackSourceSnapshot {
  if (!isFilePlaybackSourceSnapshot(input)) {
    throw new TypeError('File playback source snapshot is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    queueItemId: input.queueItemId,
    backend: input.backend,
    phase: input.phase,
    revision: input.revision,
    run: input.run ? immutableRun(input.run) : null,
    durationSeconds: input.durationSeconds,
    positionSeconds: input.positionSeconds,
    bufferedAheadSeconds: input.bufferedAheadSeconds,
    outputSampleRateHz: input.outputSampleRateHz,
    channelCount: input.channelCount,
    underrunCount: input.underrunCount,
    errorCode: input.errorCode,
  });
}

export function sourceOwnsRevisionedRun(
  source: Pick<FilePlaybackSource, 'queueItemId'>,
  run: RevisionedPlaybackRun,
): boolean {
  return source.queueItemId === run.queueItemId && isRevisionedPlaybackRun(run);
}
