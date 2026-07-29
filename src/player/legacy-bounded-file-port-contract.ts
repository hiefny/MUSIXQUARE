import type {
  FilePlaybackCutoverSource,
  FilePlaybackPosition,
  FilePlaybackSourceSnapshot,
  FilePlaybackTransitionRejectReason,
} from './file-playback-source.ts';
import type { QueueItemId } from '../types/index.ts';

declare const legacyBoundedFileLeaseBrand: unique symbol;

/**
 * Process-local authority for one exact bounded renderer incarnation.
 *
 * The runtime implementation issues a frozen object with no readable fields.
 * Structural lookalikes are inert because authority lives in a WeakMap.
 */
export type LegacyBoundedFileLease = object & {
  readonly [legacyBoundedFileLeaseBrand]: never;
};

/**
 * Immutable identity copied at the V1-to-bounded boundary.
 *
 * `roomEpoch` and `bridgeGeneration` fence room/bridge reuse. The remaining
 * fields fence queue-occurrence, source, and secret descriptor replacement.
 */
export interface LegacyBoundedFileScope {
  readonly roomEpoch: string;
  readonly bridgeGeneration: string;
  readonly bindingId: string;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly descriptorId: string;
  readonly descriptorVersion: number;
}

/**
 * The opener owns its source until it fulfills. On fulfillment, ownership is
 * transferred to LegacyBoundedFilePort. It must observe the supplied signal;
 * the port still destroys a source that arrives after revocation.
 */
export interface LegacyBoundedFileOpenedSource {
  readonly source: FilePlaybackCutoverSource;
  readonly destination: AudioNode;
}

export type LegacyBoundedFileOpener = (
  signal: AbortSignal,
) => Promise<LegacyBoundedFileOpenedSource | null>;

export interface LegacyBoundedFilePrepareInput {
  readonly scope: LegacyBoundedFileScope;
  readonly open: LegacyBoundedFileOpener;
}

export type LegacyBoundedFilePrepareOutcome =
  | Readonly<{
      readonly status: 'ready';
      readonly snapshot: FilePlaybackSourceSnapshot;
    }>
  | Readonly<{
      readonly status: 'fallback';
      readonly reason: 'unsupported-source';
    }>
  | Readonly<{
      readonly status: 'superseded';
    }>
  | Readonly<{
      readonly status: 'failed';
      readonly error: unknown;
    }>;

export interface LegacyBoundedFilePreparation {
  readonly lease: LegacyBoundedFileLease;
  readonly ready: Promise<LegacyBoundedFilePrepareOutcome>;
}

export interface LegacyBoundedFilePlayInput {
  readonly startAtRoomTimeMs: number;
  /**
   * Fresh V1 canonical position sampled for this exact start attempt.
   * A candidate whose one-shot prime outlives its start is retired; callers
   * prepare a fresh candidate instead of retrying with a different position.
   */
  readonly positionSeconds: number;
}

export interface LegacyBoundedFileTimedControlInput {
  readonly atRoomTimeMs: number;
}

export interface LegacyBoundedFileSeekInput extends LegacyBoundedFileTimedControlInput {
  readonly positionSeconds: number;
}

export type LegacyBoundedFileControlOutcome =
  | Readonly<{
      readonly status: 'applied';
      readonly snapshot: FilePlaybackSourceSnapshot | null;
    }>
  | Readonly<{
      readonly status: 'rejected';
      readonly reason: FilePlaybackTransitionRejectReason | 'busy' | 'not-current';
    }>
  | Readonly<{
      readonly status: 'superseded';
    }>
  | Readonly<{
      readonly status: 'failed';
      readonly error: unknown;
    }>;

/**
 * Two-phase PLAY admission. `scheduled` proves that native finalization and
 * gate scheduling succeeded while the shared start is still in the future.
 * `settled` remains the authoritative started-evidence outcome.
 */
export type LegacyBoundedFileScheduleOutcome =
  | Readonly<{
      readonly status: 'scheduled';
      readonly startAtRoomTimeMs: number;
      readonly snapshot: FilePlaybackSourceSnapshot;
      readonly settled: Promise<LegacyBoundedFileControlOutcome>;
    }>
  | Readonly<{
      readonly status: 'rejected';
      readonly reason: FilePlaybackTransitionRejectReason | 'busy' | 'not-current';
    }>
  | Readonly<{
      readonly status: 'superseded';
    }>
  | Readonly<{
      readonly status: 'failed';
      readonly error: unknown;
    }>;

export interface LegacyBoundedFilePortOptions {
  /** Monotonic room clock already maintained by the stable V1 controller. */
  readonly nowRoomTimeMs: () => number;
}

export interface LegacyBoundedFilePortContract {
  prepare(input: LegacyBoundedFilePrepareInput): LegacyBoundedFilePreparation;
  schedulePlay(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    input: LegacyBoundedFilePlayInput,
  ): Promise<LegacyBoundedFileScheduleOutcome>;
  commitPlay(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    input: LegacyBoundedFilePlayInput,
  ): Promise<LegacyBoundedFileControlOutcome>;
  pause(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    input: LegacyBoundedFileTimedControlInput,
  ): Promise<LegacyBoundedFileControlOutcome>;
  seek(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    input: LegacyBoundedFileSeekInput,
  ): Promise<LegacyBoundedFileControlOutcome>;
  stop(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    input: LegacyBoundedFileTimedControlInput,
  ): Promise<LegacyBoundedFileControlOutcome>;
  snapshot(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
  ): FilePlaybackSourceSnapshot | null;
  position(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    localPerformanceTimeMs: number,
  ): FilePlaybackPosition | null;
  retire(lease: LegacyBoundedFileLease, scope: LegacyBoundedFileScope): Promise<void>;
  clearRoom(scope: LegacyBoundedFileScope): Promise<void>;
  clear(): Promise<void>;
}
