import type { QueueItemId } from '../types/index.ts';
import { calculateRendezvousLeadMs } from '../network/clock-estimator.ts';
import {
  FilePlaybackApplicationController,
  type FilePlaybackHostAcceptedRendezvousCommit,
  type FilePlaybackHostEndedCommit,
  type FilePlaybackHostTransitionCommit,
} from './file-playback-application-controller.ts';
import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetBinding,
  type FilePlaybackAssetLease,
  type FilePlaybackAssetMetadata,
  type FilePlaybackAssetSnapshot,
  type FilePlaybackProvisionalAssetLease,
} from './file-playback-asset-registry.ts';
import type { FilePlaybackClockBindings } from './file-playback-clock.ts';
import type {
  FilePlaybackEndedTransitionEvidence,
  FilePlaybackEndedTransitionIntent,
} from './file-playback-ended-transition.ts';
import {
  completeLocalFilePlaybackParticipant,
  retireLocalFilePlaybackParticipant,
  stageLocalFilePlaybackParticipant,
  stageWarmLocalFilePlaybackParticipant,
  type FilePlaybackLocalStartCoordinatorRuntimeForTests,
  type LocalFilePlaybackSchedule,
  type StagedLocalFilePlaybackParticipant,
} from './file-playback-local-start-coordinator.ts';
import {
  prepareFilePlaybackAssetSourceWarm,
  retireFilePlaybackAssetSourceWarm,
  type FilePlaybackAssetSourceStagerRuntimeForTests,
  type FilePlaybackPreparedSourceReadiness,
  type FilePlaybackWarmSourceAuthority,
} from './file-playback-asset-source-stager.ts';
import {
  FilePlaybackManager,
  isExactFilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from './file-playback-manager.ts';
import { createFilePlaybackMediaScope } from './file-playback-media-scope.ts';
import { createFilePlaybackRunId } from './file-playback-run-binding.ts';
import { FilePlaybackRoomClock } from './file-playback-room-clock.ts';
import {
  createFilePlaybackCutoverTarget,
  type FilePlaybackBackend,
  type FilePlaybackPauseTransitionEvidence,
  type FilePlaybackPauseTransitionIntent,
  type FilePlaybackPosition,
  type FilePlaybackSeekTransitionEvidence,
  type FilePlaybackSeekTransitionIntent,
  type FilePlaybackSourceSnapshot,
  type FilePlaybackStartEvidence,
  type FilePlaybackTransitionResult,
} from './file-playback-source.ts';
import type { OrdinaryAudioDecoder } from './file-playback-source-factory.ts';
import { derivePeerRangeManifestBundleSize } from './file-media-source-offer.ts';
import type {
  FilePlaybackStopTransitionEvidence,
  FilePlaybackStopTransitionIntent,
  FilePlaybackStopTransitionResult,
} from './file-playback-stop-transition.ts';
import {
  createPlaybackStateIdentity,
  sameAttempt,
  type PlaybackAttemptIdentity,
  type PlaybackStateIdentity,
} from './playback-identity.ts';
import { derivePlaybackPosition, type PlaybackTimelineSnapshot } from './playback-timeline.ts';
import { isQueueItemId } from './queue-model.ts';
import { RemoteRendezvousParticipant } from './remote-rendezvous-participant.ts';
import {
  HostRendezvousCoordinator,
  type HostRendezvousAttempt,
  type HostRendezvousParticipant,
} from './rendezvous-coordinator.ts';
import type { EncodedAudioSource } from './sources/encoded-audio-source.ts';
import { ManifestPrefixedEncodedAudioSource } from './sources/manifest-prefixed-encoded-audio-source.ts';
import {
  isFilePlaybackPeerRangeManifestCodecEnabled,
  snapshotFilePlaybackBoundedRoutePolicy,
  type FilePlaybackBoundedRoutePolicy,
} from './file-playback-bounded-route-policy.ts';
import {
  copyCodecTimelineHostArtifactManifestForLease,
  describeCodecTimelineHostArtifactForLease,
  revokeCodecTimelineHostArtifactForLease,
} from './manifests/codec-timeline-host-artifact-lease-store.ts';

const DEFAULT_MIME = 'application/octet-stream';
const MAX_APPLICATION_SCOPE_ID_LENGTH = 128;
const MAX_PARTICIPANT_ID_LENGTH = 256;
const uint8ArrayFill = Uint8Array.prototype.fill;
const OPTION_KEYS = Object.freeze([
  'controller',
  'roomGeneration',
  'applicationScopeId',
  'roomToken',
  'roomClock',
  'hostParticipantId',
  'boundedRoutePolicy',
  'onFatalRoom',
  'onTransitionScheduled',
  'onTimelineCommitted',
  'runtimeForTests',
] as const);
const REQUIRED_OPTION_KEYS = OPTION_KEYS.filter(
  (key) =>
    key !== 'boundedRoutePolicy' &&
    key !== 'onTransitionScheduled' &&
    key !== 'onTimelineCommitted' &&
    key !== 'runtimeForTests',
);
const START_KEYS = Object.freeze([
  'queueItemId',
  'blob',
  'name',
  'mime',
  'audioContext',
  'destination',
  'decodeOrdinaryAudio',
  'signal',
] as const);
const START_LOCAL_TRACK_KEYS = Object.freeze([...START_KEYS, 'positionSeconds'] as const);
const WARM_LOCAL_TRACK_KEYS = Object.freeze([
  'queueItemId',
  'blob',
  'name',
  'mime',
  'audioContext',
  'decodeOrdinaryAudio',
  'signal',
] as const);
const CLEAR_WARM_LOCAL_TRACK_BY_QUEUE_KEYS = Object.freeze(['queueItemId'] as const);
const CLEAR_WARM_LOCAL_TRACK_BY_LEASE_KEYS = Object.freeze(['sourceLease'] as const);
const START_PREPARED_TRACK_KEYS = Object.freeze(['prepared', 'remoteParticipants'] as const);
const PREPARED_REMOTE_PARTICIPANT_KEYS = Object.freeze(['bindAttempt', 'participant'] as const);
const CURRENT_OPERATION_KEYS = Object.freeze(['signal'] as const);
const SEEK_PLAYING_KEYS = Object.freeze(['positionSeconds', 'signal'] as const);
const SEEK_PAUSED_KEYS = SEEK_PLAYING_KEYS;
const RESOLVE_PEER_SOURCE_KEYS = Object.freeze([
  'peerRangeManifest',
  'publication',
  'signal',
  'sourceIdentity',
] as const);
const RESOLVE_PREPARED_PEER_SOURCE_KEYS = Object.freeze([
  'peerRangeManifest',
  'prepared',
  'signal',
  'sourceIdentity',
] as const);
const RESOLVE_WARM_PEER_SOURCE_KEYS = Object.freeze([
  'peerRangeManifest',
  'signal',
  'sourceIdentity',
  'sourceLease',
] as const);
const RECOVER_REMOTE_KEYS = Object.freeze([
  'bindAttempt',
  'participant',
  'publication',
  'signal',
] as const);
const RUNTIME_KEYS = Object.freeze([
  'createRunIdForTests',
  'localStartRuntimeForTests',
  'warmSourceRuntimeForTests',
  'beforeControllerCommitForTests',
  'onTerminalReferencesReleasedForTests',
  'createManagerForTests',
  'createRendezvousIdForTests',
  'fatalAfterAdmissionForTests',
  'onCoordinatorClosedForTests',
  'beforeManagerTransitionForTests',
  'beforeTransitionControllerCommitForTests',
  'admitAssetForTests',
] as const);

type ExactRecord = Readonly<Record<string, unknown>>;

export interface FilePlaybackHostFirstFileEngineRuntimeForTests {
  /** Deterministic boundary seam. Product code always uses createFilePlaybackRunId(). */
  readonly createRunIdForTests?: () => string;
  readonly localStartRuntimeForTests?: FilePlaybackLocalStartCoordinatorRuntimeForTests;
  readonly warmSourceRuntimeForTests?: FilePlaybackAssetSourceStagerRuntimeForTests;
  readonly beforeControllerCommitForTests?: () => void;
  readonly beforeManagerTransitionForTests?: () => void;
  readonly beforeTransitionControllerCommitForTests?: () => void;
  /** Transfers a non-Blob asset into the exact production registry in source-resolution tests. */
  readonly admitAssetForTests?: (
    registry: FilePlaybackAssetRegistry,
    roomToken: object,
    binding: Readonly<FilePlaybackAssetBinding>,
    blob: Blob,
    metadata: Readonly<FilePlaybackAssetMetadata>,
  ) => FilePlaybackAssetLease;
  /** Exact empty manager factory; production always creates a private manager. */
  readonly createManagerForTests?: () => FilePlaybackManager;
  readonly createRendezvousIdForTests?: () => string;
  readonly fatalAfterAdmissionForTests?: boolean;
  readonly onCoordinatorClosedForTests?: () => void;
  readonly onTerminalReferencesReleasedForTests?: (
    snapshot: Readonly<{
      readonly assetReferenceCount: 0;
      readonly audioContextRetained: false;
      readonly destinationRetained: false;
      readonly clockBindingsRetained: false;
    }>,
  ) => void;
}

export interface FilePlaybackHostFirstFileEngineOptions {
  readonly controller: FilePlaybackApplicationController;
  readonly roomGeneration: number;
  /** Stable CSPRNG-issued application/session scope for this exact room. */
  readonly applicationScopeId: string;
  readonly roomToken: object;
  /** Exact active host clock authority for this room. */
  readonly roomClock: FilePlaybackRoomClock;
  readonly hostParticipantId: string;
  /** Fixed for this engine lifetime; omission preserves the current bounded route. */
  readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
  readonly onFatalRoom: (error: Error) => void;
  readonly onTransitionScheduled?: (
    event: Readonly<HostCurrentPlaybackTransitionScheduledEvent>,
  ) => void;
  readonly onTimelineCommitted?: (
    event: Readonly<HostCurrentPlaybackTimelineCommittedEvent>,
  ) => void;
  readonly runtimeForTests?: FilePlaybackHostFirstFileEngineRuntimeForTests;
}

export interface StartHostFirstLocalFileOptions {
  readonly queueItemId: QueueItemId;
  readonly blob: Blob;
  readonly name: string;
  /** Empty/whitespace-only browser file types are normalized to application/octet-stream. */
  readonly mime: string;
  readonly audioContext: AudioContext;
  readonly destination: AudioNode;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly signal: AbortSignal;
}

/** Starts a new logical run, replacing the current renderer at rendezvous. */
export interface StartHostLocalTrackOptions extends StartHostFirstLocalFileOptions {
  readonly positionSeconds: number;
}

/** Revision-free bounded source construction; destination and timeline are intentionally absent. */
export interface WarmHostLocalTrackOptions {
  readonly queueItemId: QueueItemId;
  readonly blob: Blob;
  readonly name: string;
  readonly mime: string;
  readonly audioContext: AudioContext;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly signal: AbortSignal;
}

declare const hostLocalTrackSourceLeaseBrand: unique symbol;

/**
 * Opaque authority for one exact engine-owned bounded warm source. Runtime
 * authenticity is retained only by the issuing engine and cannot be copied.
 */
export interface HostLocalTrackSourceLease {
  readonly [hostLocalTrackSourceLeaseBrand]: never;
}

export interface ClearHostLocalTrackWarmByLeaseOptions {
  readonly sourceLease: HostLocalTrackSourceLease;
}

/** Compatibility surface for the product facade's serialized, ABA-safe lane. */
export interface ClearHostLocalTrackWarmByQueueOptions {
  readonly queueItemId: QueueItemId;
}

export type ClearHostLocalTrackWarmOptions =
  | ClearHostLocalTrackWarmByLeaseOptions
  | ClearHostLocalTrackWarmByQueueOptions;

export interface HostCurrentPlaybackOperationOptions {
  readonly signal: AbortSignal;
}

export interface SeekHostPlayingOptions extends HostCurrentPlaybackOperationOptions {
  readonly positionSeconds: number;
}

export interface SeekHostPausedOptions extends HostCurrentPlaybackOperationOptions {
  readonly positionSeconds: number;
}

/** Serializable, body-free result published only after physical and timeline commit. */
export interface HostFirstLocalFilePlaybackCommit {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly backend: FilePlaybackBackend;
  readonly asset: Readonly<FilePlaybackAssetSnapshot>;
  readonly attempt: Readonly<PlaybackAttemptIdentity>;
  readonly schedule: Readonly<LocalFilePlaybackSchedule>;
  readonly startEvidence: Readonly<FilePlaybackStartEvidence>;
  readonly timeline: PlaybackTimelineSnapshot;
}

export type HostCurrentPlaybackTransitionEvidence =
  | FilePlaybackPauseTransitionEvidence
  | FilePlaybackSeekTransitionEvidence
  | FilePlaybackStopTransitionEvidence
  | FilePlaybackEndedTransitionEvidence;

/** Body-free result published only after manager evidence and timeline commit. */
export interface HostCurrentPlaybackTransitionCommit {
  readonly schemaVersion: 1;
  readonly kind: 'pause' | 'seek' | 'stop' | 'ended';
  readonly roomGeneration: number;
  readonly evidence: Readonly<HostCurrentPlaybackTransitionEvidence>;
  readonly timeline: PlaybackTimelineSnapshot;
}

/** Body-free exact-next transition after the native renderer accepted scheduling. */
export interface HostCurrentPlaybackTransitionScheduledEvent {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly kind: 'pause' | 'seek' | 'stop';
  readonly from: Readonly<PlaybackStateIdentity>;
  readonly to: Readonly<PlaybackStateIdentity>;
  readonly atRoomTimeMs: number;
  readonly positionSeconds: number | null;
}

/** Canonical room truth published only after physical transition evidence. */
export interface HostCurrentPlaybackTimelineCommittedEvent {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly kind: HostCurrentPlaybackTransitionCommit['kind'];
  readonly previous: PlaybackTimelineSnapshot;
  readonly timeline: PlaybackTimelineSnapshot;
}

export interface HostPeerRangeManifestPublication {
  readonly codec: 'adts-aac-lc' | 'mp3-no-frame-count';
  readonly manifestByteLength: number;
  readonly manifestSha256B64: string;
}

export interface HostPeerPlaybackAssetPublication {
  readonly kind: FilePlaybackAssetSnapshot['kind'];
  readonly binding: Readonly<FilePlaybackAssetBinding>;
  readonly metadata: Readonly<FilePlaybackAssetMetadata>;
  readonly encodedSize: number;
  readonly peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null;
}

/**
 * Exact body-free capability for one silent local candidate. The engine accepts
 * only the object identity it issued; copying these fields never grants source
 * or start authority.
 */
export interface HostPreparedLocalTrack {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly backend: FilePlaybackBackend;
  readonly state: Readonly<PlaybackStateIdentity>;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly asset: Readonly<HostPeerPlaybackAssetPublication>;
  /** Preserved only when this candidate consumed the exact bounded warm source. */
  readonly sourceLease: HostLocalTrackSourceLease | null;
}

/** Body-free observation only; the engine retains all authority over the warm source. */
export interface HostLocalTrackWarmResult {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly status: 'warmed' | 'skipped-non-bounded';
  readonly backend: FilePlaybackBackend;
  readonly asset: Readonly<HostPeerPlaybackAssetPublication>;
  readonly readiness: Readonly<FilePlaybackPreparedSourceReadiness>;
  /**
   * Exact source authority for engine-issued `warmed` results; engine-issued
   * `skipped-non-bounded` results set null. Optional only for compatibility
   * with the still-unmigrated product projection.
   */
  readonly sourceLease?: HostLocalTrackSourceLease | null;
}

/** One already-source-ready remote participant admitted to the initial cohort. */
export interface HostPreparedRemoteParticipant {
  readonly participant: RemoteRendezvousParticipant;
  /** Resolves only after exact renderer start evidence has been admitted. */
  readonly bindAttempt: (attempt: HostRendezvousAttempt) => Promise<void>;
}

export interface StartPreparedHostLocalTrackOptions {
  readonly prepared: Readonly<HostPreparedLocalTrack>;
  readonly remoteParticipants: readonly Readonly<HostPreparedRemoteParticipant>[];
}

/** Exact, immutable, body-free description of the host's current peer-readable run. */
export interface HostPeerPlaybackPublication {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly backend: FilePlaybackBackend;
  readonly state: Readonly<PlaybackStateIdentity>;
  readonly timeline: PlaybackTimelineSnapshot;
  readonly asset: Readonly<HostPeerPlaybackAssetPublication>;
}

export type HostPeerRangeSource = Blob | EncodedAudioSource;

export interface ResolveHostPeerRangeSourceOptions {
  readonly publication: Readonly<HostPeerPlaybackPublication>;
  readonly sourceIdentity: string;
  readonly peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null;
  readonly signal: AbortSignal;
}

export interface ResolvePreparedHostPeerRangeSourceOptions {
  readonly prepared: Readonly<HostPreparedLocalTrack>;
  readonly sourceIdentity: string;
  readonly peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null;
  readonly signal: AbortSignal;
}

export interface ResolveWarmHostPeerRangeSourceOptions {
  readonly sourceLease: HostLocalTrackSourceLease;
  readonly sourceIdentity: string;
  readonly peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null;
  readonly signal: AbortSignal;
}

/**
 * `bindAttempt` synchronously publishes the exact attempt to the connection
 * owner and returns a native Promise which resolves only after exact renderer
 * start evidence has been admitted. The engine performs participant commit.
 */
export interface RecoverHostRemoteParticipantOptions {
  readonly publication: Readonly<HostPeerPlaybackPublication>;
  readonly participant: RemoteRendezvousParticipant;
  readonly signal: AbortSignal;
  readonly bindAttempt: (attempt: HostRendezvousAttempt) => Promise<void>;
}

export interface HostRemoteRecoveryCommit {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly participantId: string;
  readonly publication: Readonly<HostPeerPlaybackPublication>;
  readonly attempt: Readonly<PlaybackAttemptIdentity>;
  readonly schedule: Readonly<LocalFilePlaybackSchedule>;
  readonly timeline: PlaybackTimelineSnapshot;
}

interface RuntimeSnapshot {
  readonly createRunId: () => string;
  readonly localStartRuntime: FilePlaybackLocalStartCoordinatorRuntimeForTests | undefined;
  readonly warmSourceRuntime: FilePlaybackAssetSourceStagerRuntimeForTests | undefined;
  readonly beforeControllerCommit: (() => void) | null;
  readonly beforeManagerTransition: (() => void) | null;
  readonly beforeTransitionControllerCommit: (() => void) | null;
  readonly onTerminalReferencesReleased:
    | ((
        snapshot: Readonly<{
          readonly assetReferenceCount: 0;
          readonly audioContextRetained: false;
          readonly destinationRetained: false;
          readonly clockBindingsRetained: false;
        }>,
      ) => void)
    | null;
  readonly createManager: () => FilePlaybackManager;
  readonly createRendezvousId: () => string;
  readonly fatalAfterAdmission: boolean;
  readonly onCoordinatorClosed: (() => void) | null;
  readonly admitAsset: (
    registry: FilePlaybackAssetRegistry,
    roomToken: object,
    binding: Readonly<FilePlaybackAssetBinding>,
    blob: Blob,
    metadata: Readonly<FilePlaybackAssetMetadata>,
  ) => FilePlaybackAssetLease;
}

interface AdmittedLocalFile {
  readonly queueItemId: QueueItemId;
  readonly blob: Blob;
  readonly name: string;
  readonly mime: string;
  readonly binding: Readonly<FilePlaybackAssetBinding>;
  readonly lease: FilePlaybackAssetLease;
  ownership: 'provisional' | 'live' | 'discarding' | 'discarded';
  discardPromise: Promise<void> | null;
}

type CandidateAction = 'first' | 'track' | 'resume' | 'playing-seek' | 'replay';

interface PendingNewRun {
  readonly action: 'first' | 'track' | 'replay';
  readonly expectedPrevious: PlaybackTimelineSnapshot;
  readonly expectedRevision: number;
  readonly queueItemId: QueueItemId;
  readonly positionSeconds: number;
  readonly runId: string;
}

interface CanonicalFileCandidateInput {
  readonly queueItemId: QueueItemId;
  readonly blob: Blob;
  readonly name: string;
  readonly mime: string;
  readonly audioContext: AudioContext;
  readonly destination: AudioNode;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly signal: AbortSignal;
  readonly positionSeconds: number;
}

interface CanonicalFileWarmInput {
  readonly queueItemId: QueueItemId;
  readonly blob: Blob;
  readonly name: string;
  readonly mime: string;
  readonly audioContext: AudioContext;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly signal: AbortSignal;
}

interface CandidateAudioRuntime {
  readonly audioContext: AudioContext;
  readonly destination: AudioNode;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly clockBindings: FilePlaybackClockBindings;
}

interface WarmAudioRuntime {
  readonly audioContext: AudioContext;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly clockBindings: FilePlaybackClockBindings;
}

interface BeginCandidateOperationInput extends CandidateAudioRuntime {
  readonly action: CandidateAction;
  readonly previousTimeline: PlaybackTimelineSnapshot;
  readonly expectedCurrentPort: FilePlaybackCutoverCandidatePort | null;
  asset: AdmittedLocalFile;
  readonly runId: string;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly signal: AbortSignal;
}

interface ActiveStartOperation {
  readonly kind: 'candidate';
  readonly epoch: number;
  readonly action: CandidateAction;
  readonly previousTimeline: PlaybackTimelineSnapshot;
  readonly expectedCurrentPort: FilePlaybackCutoverCandidatePort | null;
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal;
  readonly removeExternalAbort: () => void;
  commitDominant: boolean;
  published: boolean;
  task: Promise<unknown> | null;
}

type TransitionAction = 'pause' | 'seek' | 'stop' | 'ended';
type HostCurrentTransitionIntent =
  | FilePlaybackPauseTransitionIntent
  | FilePlaybackSeekTransitionIntent
  | FilePlaybackStopTransitionIntent
  | FilePlaybackEndedTransitionIntent;

interface ActiveTransitionOperation {
  readonly kind: 'transition';
  readonly epoch: number;
  readonly action: TransitionAction;
  readonly positionSeconds: number | null;
  readonly previousTimeline: PlaybackTimelineSnapshot;
  readonly expectedCurrentPort: FilePlaybackCutoverCandidatePort;
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal;
  readonly removeExternalAbort: () => void;
  commitDominant: boolean;
  physicalBoundaryClaimed: boolean;
  task: Promise<Readonly<HostCurrentPlaybackTransitionCommit>> | null;
}

type ActiveRoomOperation = ActiveStartOperation | ActiveTransitionOperation;

interface PeerPublicationAuthority {
  readonly publication: Readonly<HostPeerPlaybackPublication>;
  readonly timeline: PlaybackTimelineSnapshot;
  readonly state: Readonly<PlaybackStateIdentity>;
  readonly asset: Readonly<FilePlaybackAssetSnapshot>;
  readonly lease: FilePlaybackAssetLease;
}

interface PreparedTrackAuthority {
  readonly prepared: Readonly<HostPreparedLocalTrack>;
  readonly operation: ActiveStartOperation;
  readonly input: Readonly<BeginCandidateOperationInput>;
  readonly playbackState: Readonly<PlaybackStateIdentity>;
  readonly staged: Readonly<StagedLocalFilePlaybackParticipant>;
  readonly sourceLease: HostLocalTrackSourceLease | null;
  sourcePhase: 'prepared' | 'starting' | 'current' | 'retired';
  started: boolean;
}

interface WarmTrackOperation {
  readonly epoch: number;
  readonly queueItemId: QueueItemId;
  input: Readonly<CanonicalFileWarmInput> | null;
  asset: AdmittedLocalFile | null;
  readonly controller: AbortController;
  readonly removeExternalAbort: () => void;
  task: Promise<Readonly<HostLocalTrackWarmResult>> | null;
  authority: Readonly<FilePlaybackWarmSourceAuthority> | null;
  sourceLease: HostLocalTrackSourceLease | null;
  claimed: boolean;
  claimedBy: ActiveStartOperation | null;
  handoffBarrier: WarmTrackHandoffBarrier | null;
  assetRetirementPromise: Promise<void> | null;
  retirementPromise: Promise<void> | null;
}

interface WarmSourceLeaseAuthority {
  readonly lease: HostLocalTrackSourceLease;
  readonly operation: WarmTrackOperation;
  readonly asset: Readonly<FilePlaybackAssetSnapshot>;
  readonly backend: FilePlaybackBackend;
  readonly peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null;
  preparedAuthority: PreparedTrackAuthority | null;
  retired: boolean;
}

interface WarmTrackHandoffBarrier {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  settled: boolean;
}

interface ClaimedWarmTrackSource {
  readonly authority: Readonly<FilePlaybackWarmSourceAuthority>;
  readonly operation: WarmTrackOperation;
}

interface ActiveRemoteRecovery {
  readonly participantId: string;
  readonly participant: RemoteRendezvousParticipant;
  readonly publication: Readonly<HostPeerPlaybackPublication>;
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal;
  readonly removeExternalAbort: () => void;
  attempt: HostRendezvousAttempt | null;
}

interface DeferredRemoteParticipant {
  readonly participant: HostRendezvousParticipant;
  release(): void;
  reject(error: Error): void;
}

class HostFirstFileCleanupError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'HostFirstFileCleanupError';
  }
}

const trustedControllerSnapshot = FilePlaybackApplicationController.prototype.snapshot;
const trustedControllerTimeline = FilePlaybackApplicationController.prototype.timelineSnapshot;
const trustedControllerCommit =
  FilePlaybackApplicationController.prototype.commitHostAcceptedRendezvous;
const trustedControllerTransitionCommit =
  FilePlaybackApplicationController.prototype.commitHostPlaybackTransition;
const trustedControllerEndedCommit =
  FilePlaybackApplicationController.prototype.commitHostEndedPlayback;
const trustedManagerCurrentPort = FilePlaybackManager.prototype.currentCutoverPort;
const trustedManagerSnapshot = FilePlaybackManager.prototype.snapshot;
const trustedManagerClear = FilePlaybackManager.prototype.clear;
const trustedManagerRetireCandidate = FilePlaybackManager.prototype.retireCutoverCandidate;
const trustedManagerRetireCurrent = FilePlaybackManager.prototype.retireCurrentCutover;
const trustedManagerCurrentSnapshot = FilePlaybackManager.prototype.currentCutoverSnapshot;
const trustedManagerCurrentPosition = FilePlaybackManager.prototype.currentCutoverPosition;
const trustedManagerPauseCurrent = FilePlaybackManager.prototype.pauseCurrentCutover;
const trustedManagerSeekCurrent = FilePlaybackManager.prototype.seekCurrentCutover;
const trustedManagerStopCurrent = FilePlaybackManager.prototype.stopCurrentCutover;
const trustedManagerRetireEnded = FilePlaybackManager.prototype.retireEndedCurrent;
const trustedManagerRecoveryRequired = FilePlaybackManager.prototype.cutoverRecoveryRequired;
const trustedRoomClockRole = FilePlaybackRoomClock.prototype.role;
const trustedRoomClockNow = FilePlaybackRoomClock.prototype.nowRoomTimeMs;
const trustedRoomClockBind = FilePlaybackRoomClock.prototype.bindAudioContext;
const trustedAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const trustedRendezvousCoordinatorStart = HostRendezvousCoordinator.prototype.start;
const trustedRendezvousCoordinatorStartRecovery = HostRendezvousCoordinator.prototype.startRecovery;
const trustedRendezvousCoordinatorClose = HostRendezvousCoordinator.prototype.close;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function samePeerRangeManifestPublication(
  left: Readonly<HostPeerRangeManifestPublication> | null,
  right: Readonly<HostPeerRangeManifestPublication> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.codec === right.codec &&
    left.manifestByteLength === right.manifestByteLength &&
    left.manifestSha256B64 === right.manifestSha256B64
  );
}

function scrubManifestBytes(bytes: Uint8Array): void {
  Reflect.apply(uint8ArrayFill, bytes, [0]);
}

function snapshotExactRecord(value: unknown, expectedKeys: readonly string[]): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = new Set<string>(expectedKeys);
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

function snapshotOptions(value: unknown): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set<string>(OPTION_KEYS);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      REQUIRED_OPTION_KEYS.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of OPTION_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor) {
        snapshot[key] = undefined;
        continue;
      }
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function runtimeSnapshot(value: unknown): RuntimeSnapshot | null {
  if (value === undefined) {
    return freezeCanonical({
      createRunId: () => createFilePlaybackRunId(),
      localStartRuntime: undefined,
      warmSourceRuntime: undefined,
      beforeControllerCommit: null,
      beforeManagerTransition: null,
      beforeTransitionControllerCommit: null,
      onTerminalReferencesReleased: null,
      createManager: () => new FilePlaybackManager(),
      createRendezvousId: () => createFilePlaybackRunId(),
      fatalAfterAdmission: false,
      onCoordinatorClosed: null,
      admitAsset: (registry, roomToken, binding, blob, metadata) =>
        registry.admitBlob(roomToken, binding, blob, metadata),
    });
  }
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set<string>(RUNTIME_KEYS);
    if (Reflect.ownKeys(descriptors).some((key) => !allowed.has(key as string))) return null;
    for (const key of RUNTIME_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    }
    const createRunId = descriptors.createRunIdForTests?.value;
    const beforeControllerCommit = descriptors.beforeControllerCommitForTests?.value;
    const beforeManagerTransition = descriptors.beforeManagerTransitionForTests?.value;
    const beforeTransitionControllerCommit =
      descriptors.beforeTransitionControllerCommitForTests?.value;
    const localStartRuntime = descriptors.localStartRuntimeForTests?.value;
    const warmSourceRuntime = descriptors.warmSourceRuntimeForTests?.value;
    const onTerminalReferencesReleased = descriptors.onTerminalReferencesReleasedForTests?.value;
    const createManager = descriptors.createManagerForTests?.value;
    const createRendezvousId = descriptors.createRendezvousIdForTests?.value;
    const fatalAfterAdmission = descriptors.fatalAfterAdmissionForTests?.value;
    const onCoordinatorClosed = descriptors.onCoordinatorClosedForTests?.value;
    const admitAsset = descriptors.admitAssetForTests?.value;
    if (
      (createRunId !== undefined && typeof createRunId !== 'function') ||
      (beforeControllerCommit !== undefined && typeof beforeControllerCommit !== 'function') ||
      (beforeManagerTransition !== undefined && typeof beforeManagerTransition !== 'function') ||
      (beforeTransitionControllerCommit !== undefined &&
        typeof beforeTransitionControllerCommit !== 'function') ||
      (onTerminalReferencesReleased !== undefined &&
        typeof onTerminalReferencesReleased !== 'function') ||
      (createManager !== undefined && typeof createManager !== 'function') ||
      (createRendezvousId !== undefined && typeof createRendezvousId !== 'function') ||
      (fatalAfterAdmission !== undefined && typeof fatalAfterAdmission !== 'boolean') ||
      (onCoordinatorClosed !== undefined && typeof onCoordinatorClosed !== 'function') ||
      (admitAsset !== undefined && typeof admitAsset !== 'function') ||
      (localStartRuntime !== undefined &&
        (localStartRuntime === null || typeof localStartRuntime !== 'object')) ||
      (warmSourceRuntime !== undefined &&
        (warmSourceRuntime === null || typeof warmSourceRuntime !== 'object'))
    ) {
      return null;
    }
    return freezeCanonical({
      createRunId: (createRunId as (() => string) | undefined) ?? (() => createFilePlaybackRunId()),
      localStartRuntime: localStartRuntime as
        | FilePlaybackLocalStartCoordinatorRuntimeForTests
        | undefined,
      warmSourceRuntime: warmSourceRuntime as
        | FilePlaybackAssetSourceStagerRuntimeForTests
        | undefined,
      beforeControllerCommit: (beforeControllerCommit as (() => void) | undefined) ?? null,
      beforeManagerTransition: (beforeManagerTransition as (() => void) | undefined) ?? null,
      beforeTransitionControllerCommit:
        (beforeTransitionControllerCommit as (() => void) | undefined) ?? null,
      onTerminalReferencesReleased:
        (onTerminalReferencesReleased as
          | ((
              snapshot: Readonly<{
                readonly assetReferenceCount: 0;
                readonly audioContextRetained: false;
                readonly destinationRetained: false;
                readonly clockBindingsRetained: false;
              }>,
            ) => void)
          | undefined) ?? null,
      createManager:
        (createManager as (() => FilePlaybackManager) | undefined) ??
        (() => new FilePlaybackManager()),
      createRendezvousId:
        (createRendezvousId as (() => string) | undefined) ?? (() => createFilePlaybackRunId()),
      fatalAfterAdmission: (fatalAfterAdmission as boolean | undefined) ?? false,
      onCoordinatorClosed: (onCoordinatorClosed as (() => void) | undefined) ?? null,
      admitAsset:
        (admitAsset as RuntimeSnapshot['admitAsset'] | undefined) ??
        ((registry, roomToken, binding, blob, metadata) =>
          registry.admitBlob(roomToken, binding, blob, metadata)),
    });
  } catch {
    return null;
  }
}

function isExactController(value: unknown): value is FilePlaybackApplicationController {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      Reflect.getPrototypeOf(value) === FilePlaybackApplicationController.prototype
    );
  } catch {
    return false;
  }
}

function isExactRoomClock(value: unknown): value is FilePlaybackRoomClock {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      Reflect.getPrototypeOf(value) === FilePlaybackRoomClock.prototype
    );
  } catch {
    return false;
  }
}

function isExactRemoteParticipant(value: unknown): value is RemoteRendezvousParticipant {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      Reflect.getPrototypeOf(value) === RemoteRendezvousParticipant.prototype
    );
  } catch {
    return false;
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function normalizeMime(value: string): string {
  return value.trim().length === 0 ? DEFAULT_MIME : value;
}

function throwIfAborted(signal: AbortSignal): void {
  Reflect.apply(trustedAbortThrowIfAborted, signal, []);
}

function currentPort(manager: FilePlaybackManager): FilePlaybackCutoverCandidatePort | null {
  return Reflect.apply(trustedManagerCurrentPort, manager, []);
}

function observe(value: Promise<unknown>): void {
  void value.then(
    () => undefined,
    () => undefined,
  );
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  const reason = signal.reason as unknown;
  return reason instanceof Error ? reason : new Error(fallback, { cause: reason });
}

function waitWithSignal<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal, 'Remote recovery was aborted'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(signal, 'Remote recovery was aborted')));
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function deferredRemoteParticipant(remote: RemoteRendezvousParticipant): DeferredRemoteParticipant {
  let target: RemoteRendezvousParticipant | null = remote;
  let resolveGate!: () => void;
  let rejectGate!: (error: Error) => void;
  let settled = false;
  const gate = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  void gate.catch(() => undefined);
  const rttP95Ms = remote.rttP95Ms;
  const armP95Ms = remote.armP95Ms;
  // calculateRendezvousLeadMs validates both detached metrics before the
  // coordinator can retain this wrapper.
  calculateRendezvousLeadMs(rttP95Ms, armP95Ms);
  const participant = Object.freeze({
    participantId: remote.participantId,
    rttP95Ms,
    armP95Ms,
    arm: (intent: Parameters<RemoteRendezvousParticipant['arm']>[0]) =>
      gate.then(() => {
        if (!target) throw new Error('Remote recovery participant is released');
        return target.arm(intent);
      }),
    finalize: (intent: Parameters<RemoteRendezvousParticipant['finalize']>[0]) =>
      gate.then(() => {
        if (!target) throw new Error('Remote recovery participant is released');
        return target.finalize(intent);
      }),
    commitAttempt: (identity: PlaybackAttemptIdentity) => {
      if (!settled || !target) return false;
      const accepted = target.commitAttempt(identity);
      if (accepted) target = null;
      return accepted;
    },
    cancel: (intent: Parameters<RemoteRendezvousParticipant['cancel']>[0]) =>
      gate.then(
        async () => {
          const current = target;
          target = null;
          await current?.cancel(intent);
        },
        () => {
          target = null;
        },
      ),
  }) satisfies HostRendezvousParticipant;
  return {
    participant,
    release() {
      if (settled) return;
      settled = true;
      resolveGate();
    },
    reject(error: Error) {
      if (settled) return;
      settled = true;
      target = null;
      rejectGate(error);
    },
  };
}

async function closeEncodedSourceWithoutMasking(source: EncodedAudioSource): Promise<void> {
  try {
    await source.close();
  } catch {
    // The stale/aborted authority error remains primary.
  }
}

function sameLocalPlaybackSchedule(
  left: Readonly<LocalFilePlaybackSchedule>,
  right: Readonly<LocalFilePlaybackSchedule>,
): boolean {
  return (
    left.positionSeconds === right.positionSeconds &&
    left.playbackRate === right.playbackRate &&
    left.createdAtRoomTimeMs === right.createdAtRoomTimeMs &&
    left.leadTimeMs === right.leadTimeMs &&
    left.finalizeByRoomTimeMs === right.finalizeByRoomTimeMs &&
    left.startAtRoomTimeMs === right.startAtRoomTimeMs
  );
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

function mergeCleanupFailure(current: unknown, next: unknown): unknown {
  if (current === null) return next;
  return new AggregateError([current, next], 'Multiple host first-file cleanup operations failed');
}

function containsCleanupFailure(value: unknown): boolean {
  if (value instanceof HostFirstFileCleanupError) return true;
  return value instanceof AggregateError && value.errors.some(containsCleanupFailure);
}

/**
 * One-room, host-only candidate engine for V2 file playback.
 *
 * Peer publication is body-free. Exact source leases and same-state remote
 * recovery remain private capabilities of this room-generation engine.
 * The historical class name and startFirstLocalFile method remain as
 * compatibility surfaces while one instance owns the local renderer lifetime.
 */
export class FilePlaybackHostFirstFileEngine {
  readonly #controller: FilePlaybackApplicationController;
  readonly #roomGeneration: number;
  readonly #applicationScopeId: string;
  readonly #roomToken: object;
  readonly #roomClock: FilePlaybackRoomClock;
  readonly #manager: FilePlaybackManager;
  /** Kept explicit for the forthcoming coordinator close/revocation integration. */
  readonly #rendezvousCoordinator: HostRendezvousCoordinator;
  readonly #hostParticipantId: string;
  readonly #boundedRoutePolicy: Readonly<FilePlaybackBoundedRoutePolicy> | null;
  readonly #installCodecTimelineHostArtifact: boolean;
  readonly #onFatalRoom: (error: Error) => void;
  readonly #onTransitionScheduled:
    | ((event: Readonly<HostCurrentPlaybackTransitionScheduledEvent>) => void)
    | null;
  readonly #onTimelineCommitted:
    | ((event: Readonly<HostCurrentPlaybackTimelineCommittedEvent>) => void)
    | null;
  readonly #runtime: RuntimeSnapshot;
  readonly #registry: FilePlaybackAssetRegistry;
  readonly #initialTimeline: PlaybackTimelineSnapshot;
  readonly #assets = new Map<QueueItemId, AdmittedLocalFile>();
  readonly #ownedPorts = new Set<FilePlaybackCutoverCandidatePort>();
  readonly #portRetirements = new Map<FilePlaybackCutoverCandidatePort, Promise<void>>();
  readonly #remoteRecoveries = new Map<string, ActiveRemoteRecovery>();
  readonly #detachedWarmRetirements = new Set<Promise<void>>();
  readonly #warmSourceLeaseAuthorities = new WeakMap<
    HostLocalTrackSourceLease,
    WarmSourceLeaseAuthority
  >();
  #peerPublicationAuthority: PeerPublicationAuthority | null = null;
  #preparedTrackAuthority: PreparedTrackAuthority | null = null;
  #preparedSourceAuthority: PreparedTrackAuthority | null = null;
  #currentSourceAuthority: PreparedTrackAuthority | null = null;
  #warmTrackOperation: WarmTrackOperation | null = null;
  #warmEpoch = 0;
  #audioContext: AudioContext | null = null;
  #destination: AudioNode | null = null;
  #clockBindings: FilePlaybackClockBindings | null = null;
  #decodeOrdinaryAudio: OrdinaryAudioDecoder | null = null;
  #legacyFirstQueueItemId: QueueItemId | null = null;
  #pendingNewRun: PendingNewRun | null = null;
  #committedPort: FilePlaybackCutoverCandidatePort | null = null;
  #operationEpoch = 0;
  #activeOperation: ActiveRoomOperation | null = null;
  #startingSynchronously = false;
  #closed = false;
  #fatalError: Error | null = null;
  #warmCleanupFailure: unknown = null;
  #fatalNotified = false;
  #terminalReferencesReleased = false;
  #coordinatorClosed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: FilePlaybackHostFirstFileEngineOptions) {
    const input = snapshotOptions(options);
    const runtime = runtimeSnapshot(input?.runtimeForTests);
    if (!input || !runtime) {
      throw new TypeError('Host first-file engine options are invalid');
    }
    const canonicalBoundedRoutePolicy = snapshotFilePlaybackBoundedRoutePolicy(
      input.boundedRoutePolicy,
    );
    const boundedRoutePolicy =
      input.boundedRoutePolicy === undefined ? null : canonicalBoundedRoutePolicy;
    const installCodecTimelineHostArtifact =
      isFilePlaybackPeerRangeManifestCodecEnabled(canonicalBoundedRoutePolicy, 'adts-aac-lc') ||
      isFilePlaybackPeerRangeManifestCodecEnabled(
        canonicalBoundedRoutePolicy,
        'mp3-no-frame-count',
      );
    if (!isExactController(input.controller)) {
      throw new TypeError('Host first-file engine requires an exact application controller');
    }
    if (!Number.isSafeInteger(input.roomGeneration) || (input.roomGeneration as number) <= 0) {
      throw new TypeError('Host first-file engine room generation is invalid');
    }
    if (!isBoundedIdentifier(input.applicationScopeId, MAX_APPLICATION_SCOPE_ID_LENGTH)) {
      throw new TypeError('Host first-file engine application scope ID is invalid');
    }
    if (input.roomToken === null || typeof input.roomToken !== 'object') {
      throw new TypeError('Host first-file engine requires an opaque room token');
    }
    if (!isExactRoomClock(input.roomClock)) {
      throw new TypeError('Host first-file engine requires an exact room clock');
    }
    if (!isBoundedIdentifier(input.hostParticipantId, MAX_PARTICIPANT_ID_LENGTH)) {
      throw new TypeError('Host first-file engine participant ID is invalid');
    }
    if (
      typeof input.onFatalRoom !== 'function' ||
      (input.onTransitionScheduled !== undefined &&
        typeof input.onTransitionScheduled !== 'function') ||
      (input.onTimelineCommitted !== undefined && typeof input.onTimelineCommitted !== 'function')
    ) {
      throw new TypeError('Host first-file engine callbacks are invalid');
    }

    const roomClock = input.roomClock;
    const roomClockRole = Reflect.apply(trustedRoomClockRole, roomClock, []);
    const currentRoomTimeMs = Reflect.apply(trustedRoomClockNow, roomClock, []);
    if (
      roomClockRole !== 'host' ||
      typeof currentRoomTimeMs !== 'number' ||
      !Number.isFinite(currentRoomTimeMs) ||
      currentRoomTimeMs < 0
    ) {
      throw new Error('Host first-file engine requires the current host room clock authority');
    }

    const manager = Reflect.apply(runtime.createManager, undefined, []);
    if (!isExactFilePlaybackManager(manager)) {
      throw new TypeError('Host first-file engine manager factory returned an inexact manager');
    }
    const controller = input.controller;
    const controllerSnapshot = Reflect.apply(trustedControllerSnapshot, controller, []);
    const baselineTimeline = Reflect.apply(trustedControllerTimeline, controller, []);
    if (
      controllerSnapshot.roomGeneration !== input.roomGeneration ||
      controllerSnapshot.roomRole !== 'host' ||
      controllerSnapshot.timeline !== baselineTimeline ||
      baselineTimeline.phase !== 'stopped' ||
      baselineTimeline.run !== null ||
      baselineTimeline.revision === Number.MAX_SAFE_INTEGER
    ) {
      throw new Error('Host first-file engine requires the exact stopped host room generation');
    }
    const managerSnapshot = Reflect.apply(trustedManagerSnapshot, manager, []);
    if (
      currentPort(manager) !== null ||
      managerSnapshot.active !== null ||
      managerSnapshot.standby !== null
    ) {
      throw new Error('Host first-file engine requires an empty playback manager');
    }

    this.#controller = controller;
    this.#roomGeneration = input.roomGeneration as number;
    this.#applicationScopeId = input.applicationScopeId as string;
    this.#roomToken = input.roomToken;
    this.#roomClock = roomClock;
    this.#manager = manager;
    this.#rendezvousCoordinator = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => Reflect.apply(trustedRoomClockNow, this.#roomClock, []),
      createRendezvousId: runtime.createRendezvousId,
    });
    this.#hostParticipantId = input.hostParticipantId as string;
    this.#boundedRoutePolicy = boundedRoutePolicy;
    this.#installCodecTimelineHostArtifact = installCodecTimelineHostArtifact;
    this.#onFatalRoom = input.onFatalRoom as (error: Error) => void;
    this.#onTransitionScheduled =
      (input.onTransitionScheduled as
        | ((event: Readonly<HostCurrentPlaybackTransitionScheduledEvent>) => void)
        | undefined) ?? null;
    this.#onTimelineCommitted =
      (input.onTimelineCommitted as
        | ((event: Readonly<HostCurrentPlaybackTimelineCommittedEvent>) => void)
        | undefined) ?? null;
    this.#runtime = runtime;
    this.#initialTimeline = baselineTimeline;
    this.#registry = new FilePlaybackAssetRegistry({
      liveRoomToken: this.#roomToken,
      onFatalRoom: (token, error) => {
        if (token === this.#roomToken) this.#handleRegistryFatal(error);
      },
    });
  }

  startFirstLocalFile(
    options: StartHostFirstLocalFileOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    return this.#runSynchronousCandidateStart(() => {
      const input = this.#readFileCandidateInput(options, START_KEYS, 0);
      const previousTimeline = this.#captureTimeline('first');
      if (
        previousTimeline !== this.#initialTimeline ||
        previousTimeline.phase !== 'stopped' ||
        previousTimeline.run !== null
      ) {
        throw new Error('Host first local file requires its exact initial stopped timeline');
      }
      if (
        this.#legacyFirstQueueItemId !== null &&
        this.#legacyFirstQueueItemId !== input.queueItemId
      ) {
        throw new Error('Host first-file compatibility API owns one logical queue asset');
      }
      const task = this.#startFileCandidate('first', input, previousTimeline);
      this.#legacyFirstQueueItemId ??= input.queueItemId;
      return task;
    });
  }

  startLocalTrack(
    options: StartHostLocalTrackOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    return this.#runSynchronousCandidateStart(() => {
      const input = this.#readFileCandidateInput(options, START_LOCAL_TRACK_KEYS, undefined);
      const previousTimeline = this.#captureTimeline('track');
      return this.#startFileCandidate('track', input, previousTimeline);
    });
  }

  /**
   * Warms exactly one bounded local source without claiming a manager slot or
   * binding it to a run/revision. A later matching track preparation consumes
   * the source once; a non-bounded result is destroyed immediately.
   */
  warmLocalTrack(options: WarmHostLocalTrackOptions): Promise<Readonly<HostLocalTrackWarmResult>> {
    return this.#runSynchronousWarm(() => {
      const input = this.#readWarmFileInput(options);
      const timeline = this.#captureWarmRoomTimeline();
      const runtime = this.#bindWarmAudioRuntime(input, timeline);
      this.#assertTimelineAuthority(timeline, false);
      return this.#beginWarmTrack(input, runtime);
    });
  }

  /**
   * Retires the exact queued warm source. A provisional-only asset is discarded;
   * an exact live room asset remains admitted for repeat or shuffle playback.
   */
  clearWarmLocalTrack(options: ClearHostLocalTrackWarmOptions): Promise<boolean> {
    try {
      const byLease = snapshotExactRecord(options, CLEAR_WARM_LOCAL_TRACK_BY_LEASE_KEYS);
      const byQueue = byLease
        ? null
        : snapshotExactRecord(options, CLEAR_WARM_LOCAL_TRACK_BY_QUEUE_KEYS);
      if (!byLease && (!byQueue || !isQueueItemId(byQueue.queueItemId))) {
        throw new TypeError('Host local file warm clear options are invalid');
      }
      const operation = this.#warmTrackOperation;
      const leaseAuthority = byLease
        ? this.#warmSourceLeaseAuthorities.get(byLease.sourceLease as HostLocalTrackSourceLease)
        : null;
      const matches = byLease
        ? leaseAuthority?.operation === operation &&
          leaseAuthority.lease === byLease.sourceLease &&
          operation?.sourceLease === byLease.sourceLease
        : operation?.queueItemId === byQueue?.queueItemId;
      if (!operation || operation.claimed || !matches) {
        return Promise.resolve(false);
      }
      this.#warmEpoch += 1;
      return this.#retireWarmTrackOperation(
        operation,
        new Error('Host local file warm source was explicitly cleared'),
      ).then(() => true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Decodes/opens and primes one silent local candidate without creating a
   * rendezvous or changing canonical timeline truth.
   */
  prepareLocalTrack(
    options: StartHostLocalTrackOptions,
  ): Promise<Readonly<HostPreparedLocalTrack>> {
    return this.#runSynchronousCandidatePreparation(() => {
      const input = this.#readFileCandidateInput(options, START_LOCAL_TRACK_KEYS, undefined);
      const previousTimeline = this.#captureTimeline('track');
      return this.#prepareFileCandidate('track', input, previousTimeline);
    });
  }

  /** Prepares an exact-next same-run playing seek without starting its rendezvous. */
  preparePlayingSeek(options: SeekHostPlayingOptions): Promise<Readonly<HostPreparedLocalTrack>> {
    return this.#runSynchronousCandidatePreparation(() =>
      this.#preparePlayingSeekCandidate(options),
    );
  }

  /** Prepares a fresh zero-position run for the current asset without starting its rendezvous. */
  prepareReplayCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostPreparedLocalTrack>> {
    return this.#runSynchronousCandidatePreparation(() =>
      this.#prepareReplayCurrentCandidate(options),
    );
  }

  /** Starts one shared rendezvous for the exact prepared local host and remotes. */
  startPreparedLocalTrack(
    options: StartPreparedHostLocalTrackOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    try {
      const input = snapshotExactRecord(options, START_PREPARED_TRACK_KEYS);
      if (!input) throw new TypeError('Host prepared local track start options are invalid');
      const authority = this.#requirePreparedTrackAuthority(input.prepared);
      const remoteParticipants = this.#readPreparedRemoteParticipants(input.remoteParticipants);
      if (authority.started) {
        throw new Error('Host prepared local track has already started');
      }
      authority.started = true;
      if (this.#preparedSourceAuthority === authority) authority.sourcePhase = 'starting';
      const task = this.#executePreparedCandidateStart(authority, remoteParticipants);
      authority.operation.task = task;
      return task;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  resumeCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    return this.#runSynchronousCandidateStart(() => {
      const input = this.#readCurrentOperationInput(options, CURRENT_OPERATION_KEYS);
      const previousTimeline = this.#captureTimeline('resume');
      if (previousTimeline.phase !== 'paused' || previousTimeline.run === null) {
        throw new Error('Host resume requires exact paused timeline truth');
      }
      const asset = this.#requireCurrentAsset(previousTimeline);
      const runtime = this.#requireAudioRuntime();
      const expectedCurrentPort = this.#assertExpectedRenderer(previousTimeline, 'resume');
      return this.#beginCandidateOperation({
        action: 'resume',
        previousTimeline,
        expectedCurrentPort,
        asset,
        runId: previousTimeline.run.runId,
        positionSeconds: previousTimeline.positionSeconds,
        playbackRate: previousTimeline.rate,
        signal: input.signal,
        ...runtime,
      });
    });
  }

  seekPlaying(
    options: SeekHostPlayingOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    return this.#runSynchronousCandidateStart(() => {
      return this.#preparePlayingSeekCandidate(options).then((prepared) =>
        this.startPreparedLocalTrack({ prepared, remoteParticipants: [] }),
      );
    });
  }

  replayCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    return this.#runSynchronousCandidateStart(() => {
      return this.#prepareReplayCurrentCandidate(options).then((prepared) =>
        this.startPreparedLocalTrack({ prepared, remoteParticipants: [] }),
      );
    });
  }

  pauseCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>> {
    return this.#runSynchronousTransition(() => {
      const input = this.#readCurrentOperationInput(options, CURRENT_OPERATION_KEYS);
      return this.#beginCurrentTransition('pause', input.signal, null);
    });
  }

  seekPaused(
    options: SeekHostPausedOptions,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>> {
    return this.#runSynchronousTransition(() => {
      const input = this.#readCurrentOperationInput(options, SEEK_PAUSED_KEYS);
      if (
        typeof input.positionSeconds !== 'number' ||
        !Number.isFinite(input.positionSeconds) ||
        input.positionSeconds < 0
      ) {
        throw new TypeError('Host paused seek position is invalid');
      }
      return this.#beginCurrentTransition('seek', input.signal, input.positionSeconds);
    });
  }

  stopCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>> {
    return this.#runSynchronousTransition(() => {
      const input = this.#readCurrentOperationInput(options, CURRENT_OPERATION_KEYS);
      return this.#beginCurrentTransition('stop', input.signal, null);
    });
  }

  settleEndedCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>> {
    return this.#runSynchronousTransition(() => {
      const input = this.#readCurrentOperationInput(options, CURRENT_OPERATION_KEYS);
      return this.#beginCurrentTransition('ended', input.signal, null);
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const active = this.#activeOperation;
    const warm = this.#warmTrackOperation;
    this.#closed = true;
    this.#peerPublicationAuthority = null;
    this.#retireAllSourceAuthorities();
    this.#preparedTrackAuthority = null;
    this.#cancelAllRemoteRecoveries('remote-recovery-room-closed');
    if (!active?.commitDominant) this.#operationEpoch += 1;
    this.#warmEpoch += 1;
    const coordinatorFailure = this.#closeCoordinatorOnce();
    if (this.#closePromise) return this.#closePromise;
    if (active && !active.commitDominant) {
      active.controller.abort(new Error('Host first-file room closed'));
    }
    const warmCleanup = this.#collectWarmCleanup(warm, new Error('Host first-file room closed'));
    this.#closePromise = this.#closeOwnedRoom(
      active?.task ?? null,
      coordinatorFailure,
      warmCleanup,
    );
    return this.#closePromise;
  }

  currentRendererSnapshot(): FilePlaybackSourceSnapshot | null {
    if (!this.#hasLiveProjectionAuthority()) return null;
    const port = this.#committedPort;
    if (!port || currentPort(this.#manager) !== port) return null;
    const snapshot = Reflect.apply(trustedManagerCurrentSnapshot, this.#manager, [port]);
    if (
      !snapshot ||
      !this.#hasLiveProjectionAuthority() ||
      this.#committedPort !== port ||
      currentPort(this.#manager) !== port
    ) {
      return null;
    }
    return snapshot;
  }

  currentPeerPublication(): Readonly<HostPeerPlaybackPublication> | null {
    try {
      if (!this.#hasLiveProjectionAuthority()) return null;
      const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
      if (!this.#allowsCurrentPeerPublicationForTimeline(timeline)) return null;
      const run = timeline.run;
      if (!run || timeline.phase === 'stopped') return null;
      const port = this.#committedPort;
      const renderer = port
        ? Reflect.apply(trustedManagerCurrentSnapshot, this.#manager, [port])
        : null;
      if (!renderer || renderer.phase !== timeline.phase) return null;
      const admitted = this.#assets.get(run.queueItemId);
      if (!admitted) return null;
      const asset = this.#registry.snapshotForLease(this.#roomToken, admitted.lease);
      if (
        !asset ||
        asset.queueItemId !== run.queueItemId ||
        asset.sourceIdentity !== admitted.binding.sourceIdentity ||
        asset.transferSessionId !== admitted.binding.transferSessionId
      ) {
        return null;
      }
      const cached = this.#peerPublicationAuthority;
      if (
        cached &&
        cached.timeline === timeline &&
        cached.lease === admitted.lease &&
        this.#samePeerAsset(cached.asset, asset)
      ) {
        this.#assertCurrentPeerPublicationAuthority(cached);
        return cached.publication;
      }
      const state = freezeCanonical({
        queueItemId: run.queueItemId,
        runId: run.runId,
        revision: timeline.revision,
      });
      const publication = freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: this.#roomGeneration,
        backend: renderer.backend,
        state,
        timeline,
        asset: this.#peerAssetPublication(asset, admitted.lease, renderer.backend),
      });
      const authority: PeerPublicationAuthority = {
        publication,
        timeline,
        state,
        asset,
        lease: admitted.lease,
      };
      this.#peerPublicationAuthority = authority;
      this.#assertCurrentPeerPublicationAuthority(authority);
      return publication;
    } catch {
      this.#peerPublicationAuthority = null;
      return null;
    }
  }

  async resolveCurrentPeerRangeSource(
    options: ResolveHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource> {
    const input = snapshotExactRecord(options, RESOLVE_PEER_SOURCE_KEYS);
    if (
      !input ||
      !(input.signal instanceof AbortSignal) ||
      !isBoundedIdentifier(input.sourceIdentity, MAX_APPLICATION_SCOPE_ID_LENGTH * 2)
    ) {
      throw new TypeError('Host peer-range source resolution options are invalid');
    }
    const signal = input.signal;
    const authority = this.#requireCurrentPeerPublication(input.publication);
    if (input.sourceIdentity !== authority.asset.sourceIdentity) {
      throw new Error('Host peer-range source identity is not the current publication');
    }
    const peerRangeManifest = this.#requirePeerRangeManifestSelector(
      input.peerRangeManifest,
      authority.publication.asset.peerRangeManifest,
      'Host peer-range source',
    );
    throwIfAborted(signal);
    this.#assertCurrentPeerPublicationAuthority(authority);
    return this.#resolvePeerRangeLeaseSource(
      authority.lease,
      authority.asset,
      authority.publication.backend,
      peerRangeManifest,
      signal,
      () => this.#assertCurrentPeerPublicationAuthority(authority),
      'Host peer-range',
    );
  }

  async resolvePreparedPeerRangeSource(
    options: ResolvePreparedHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource> {
    const input = snapshotExactRecord(options, RESOLVE_PREPARED_PEER_SOURCE_KEYS);
    if (
      !input ||
      !(input.signal instanceof AbortSignal) ||
      !isBoundedIdentifier(input.sourceIdentity, MAX_APPLICATION_SCOPE_ID_LENGTH * 2)
    ) {
      throw new TypeError('Host prepared peer-range source resolution options are invalid');
    }
    const signal = input.signal;
    const authority = this.#requirePreparedSourceAuthority(input.prepared);
    const asset = authority.staged.asset;
    if (input.sourceIdentity !== asset.sourceIdentity) {
      throw new Error('Host prepared peer-range source identity is not the exact candidate');
    }
    const peerRangeManifest = this.#requirePeerRangeManifestSelector(
      input.peerRangeManifest,
      authority.prepared.asset.peerRangeManifest,
      'Host prepared peer-range source',
    );
    throwIfAborted(signal);
    this.#assertPreparedSourceAuthority(authority);
    return this.#resolvePeerRangeLeaseSource(
      authority.input.asset.lease,
      asset,
      authority.prepared.backend,
      peerRangeManifest,
      signal,
      () => this.#assertPreparedSourceAuthority(authority),
      'Host prepared peer-range',
    );
  }

  async resolveWarmPeerRangeSource(
    options: ResolveWarmHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource> {
    const input = snapshotExactRecord(options, RESOLVE_WARM_PEER_SOURCE_KEYS);
    if (
      !input ||
      !(input.signal instanceof AbortSignal) ||
      !isBoundedIdentifier(input.sourceIdentity, MAX_APPLICATION_SCOPE_ID_LENGTH * 2)
    ) {
      throw new TypeError('Host warm peer-range source resolution options are invalid');
    }
    const signal = input.signal;
    const authority = this.#requireWarmSourceLeaseAuthority(input.sourceLease);
    this.#assertWarmSourceLeaseAuthority(authority);
    const admitted = authority.operation.asset;
    if (!admitted) {
      throw new Error('Host warm peer-range source lost its admitted asset');
    }
    const asset = authority.asset;
    if (input.sourceIdentity !== asset.sourceIdentity) {
      throw new Error('Host warm peer-range source identity is not the exact lease');
    }
    const peerRangeManifest = this.#requirePeerRangeManifestSelector(
      input.peerRangeManifest,
      authority.peerRangeManifest,
      'Host warm peer-range source',
    );
    throwIfAborted(signal);
    return this.#resolvePeerRangeLeaseSource(
      admitted.lease,
      asset,
      authority.backend,
      peerRangeManifest,
      signal,
      () => this.#assertWarmSourceLeaseAuthority(authority),
      'Host warm peer-range',
    );
  }

  recoverRemoteParticipant(
    options: RecoverHostRemoteParticipantOptions,
  ): Promise<Readonly<HostRemoteRecoveryCommit>> {
    const input = snapshotExactRecord(options, RECOVER_REMOTE_KEYS);
    if (
      !input ||
      !(input.signal instanceof AbortSignal) ||
      !isExactRemoteParticipant(input.participant) ||
      typeof input.bindAttempt !== 'function'
    ) {
      return Promise.reject(new TypeError('Host remote recovery options are invalid'));
    }
    try {
      throwIfAborted(input.signal);
      const authority = this.#requirePeerPublication(input.publication);
      this.#assertPeerPublicationAuthority(authority);
      if (authority.timeline.phase !== 'playing' || this.#activeOperation !== null) {
        throw new Error('Host remote recovery requires an exact idle playing publication');
      }
      const participant = input.participant;
      const previous = this.#remoteRecoveries.get(participant.participantId);
      if (previous) this.#abortRemoteRecovery(previous, 'remote-recovery-replaced');

      const controller = new AbortController();
      const externalSignal = input.signal;
      const forwardExternalAbort = () =>
        controller.abort(abortReason(externalSignal, 'Remote recovery was aborted'));
      externalSignal.addEventListener('abort', forwardExternalAbort, { once: true });
      const operation: ActiveRemoteRecovery = {
        participantId: participant.participantId,
        participant,
        publication: authority.publication,
        controller,
        externalSignal,
        removeExternalAbort: () =>
          externalSignal.removeEventListener('abort', forwardExternalAbort),
        attempt: null,
      };
      this.#remoteRecoveries.set(operation.participantId, operation);
      if (externalSignal.aborted) forwardExternalAbort();
      const task = this.#executeRemoteRecovery(
        operation,
        authority,
        input.bindAttempt as RecoverHostRemoteParticipantOptions['bindAttempt'],
      );
      return task;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  positionAt(localPerformanceTimeMs: number): FilePlaybackPosition | null {
    if (
      typeof localPerformanceTimeMs !== 'number' ||
      !Number.isFinite(localPerformanceTimeMs) ||
      localPerformanceTimeMs < 0 ||
      !this.#hasLiveProjectionAuthority()
    ) {
      return null;
    }
    const port = this.#committedPort;
    if (!port || currentPort(this.#manager) !== port) return null;
    const position = Reflect.apply(trustedManagerCurrentPosition, this.#manager, [
      port,
      localPerformanceTimeMs,
    ]);
    if (
      !position ||
      !this.#hasLiveProjectionAuthority() ||
      this.#committedPort !== port ||
      currentPort(this.#manager) !== port
    ) {
      return null;
    }
    return position;
  }

  #runSynchronousCandidateStart(
    start: () => Promise<Readonly<HostFirstLocalFilePlaybackCommit>>,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    if (this.#startingSynchronously) {
      return Promise.reject(new Error('Host file candidate re-entered synchronous admission'));
    }
    this.#startingSynchronously = true;
    try {
      return start();
    } catch (error) {
      return Promise.reject(error);
    } finally {
      this.#startingSynchronously = false;
    }
  }

  #runSynchronousCandidatePreparation(
    start: () => Promise<Readonly<HostPreparedLocalTrack>>,
  ): Promise<Readonly<HostPreparedLocalTrack>> {
    if (this.#startingSynchronously) {
      return Promise.reject(new Error('Host file candidate re-entered synchronous admission'));
    }
    this.#startingSynchronously = true;
    try {
      return start();
    } catch (error) {
      return Promise.reject(error);
    } finally {
      this.#startingSynchronously = false;
    }
  }

  #runSynchronousWarm(
    start: () => Promise<Readonly<HostLocalTrackWarmResult>>,
  ): Promise<Readonly<HostLocalTrackWarmResult>> {
    if (this.#startingSynchronously) {
      return Promise.reject(new Error('Host file warm admission re-entered synchronously'));
    }
    this.#startingSynchronously = true;
    try {
      return start();
    } catch (error) {
      return Promise.reject(error);
    } finally {
      this.#startingSynchronously = false;
    }
  }

  #readWarmFileInput(options: unknown): Readonly<CanonicalFileWarmInput> {
    const input = snapshotExactRecord(options, WARM_LOCAL_TRACK_KEYS);
    if (!input) throw new TypeError('Host local file warm options are invalid');
    if (!isQueueItemId(input.queueItemId)) {
      throw new TypeError('Host local file warm queue item ID is invalid');
    }
    if (!(input.blob instanceof Blob)) {
      throw new TypeError('Host local file warm body must be a Blob or File');
    }
    if (typeof input.name !== 'string' || typeof input.mime !== 'string') {
      throw new TypeError('Host local file warm metadata is invalid');
    }
    if (
      input.audioContext === null ||
      typeof input.audioContext !== 'object' ||
      typeof input.decodeOrdinaryAudio !== 'function'
    ) {
      throw new TypeError('Host local file warm audio runtime is invalid');
    }
    if (!(input.signal instanceof AbortSignal)) {
      throw new TypeError('Host local file warm requires an exact AbortSignal');
    }
    throwIfAborted(input.signal);
    return freezeCanonical({
      queueItemId: input.queueItemId,
      blob: input.blob,
      name: input.name,
      mime: normalizeMime(input.mime),
      audioContext: input.audioContext as AudioContext,
      decodeOrdinaryAudio: input.decodeOrdinaryAudio as OrdinaryAudioDecoder,
      signal: input.signal,
    });
  }

  #readFileCandidateInput(
    options: unknown,
    keys: readonly string[],
    requestedPosition: unknown,
  ): Readonly<CanonicalFileCandidateInput> {
    const input = snapshotExactRecord(options, keys);
    if (!input) throw new TypeError('Host local file candidate options are invalid');
    if (!isQueueItemId(input.queueItemId)) {
      throw new TypeError('Host local file candidate queue item ID is invalid');
    }
    if (!(input.blob instanceof Blob)) {
      throw new TypeError('Host local file candidate body must be a Blob or File');
    }
    if (typeof input.name !== 'string' || typeof input.mime !== 'string') {
      throw new TypeError('Host local file candidate metadata is invalid');
    }
    if (
      input.audioContext === null ||
      typeof input.audioContext !== 'object' ||
      input.destination === null ||
      typeof input.destination !== 'object' ||
      typeof input.decodeOrdinaryAudio !== 'function'
    ) {
      throw new TypeError('Host local file candidate audio graph is invalid');
    }
    if (!(input.signal instanceof AbortSignal)) {
      throw new TypeError('Host local file candidate requires an exact AbortSignal');
    }
    const positionSeconds = requestedPosition ?? input.positionSeconds;
    if (
      typeof positionSeconds !== 'number' ||
      !Number.isFinite(positionSeconds) ||
      positionSeconds < 0
    ) {
      throw new TypeError('Host local file candidate position is invalid');
    }
    throwIfAborted(input.signal);
    return freezeCanonical({
      queueItemId: input.queueItemId,
      blob: input.blob,
      name: input.name,
      mime: normalizeMime(input.mime),
      audioContext: input.audioContext as AudioContext,
      destination: input.destination as AudioNode,
      decodeOrdinaryAudio: input.decodeOrdinaryAudio as OrdinaryAudioDecoder,
      signal: input.signal,
      positionSeconds,
    });
  }

  #readPreparedRemoteParticipants(
    value: unknown,
  ): readonly Readonly<HostPreparedRemoteParticipant>[] {
    if (!Array.isArray(value)) {
      throw new TypeError('Host prepared remote participants must be an array');
    }
    const participantIds = new Set<string>([this.#hostParticipantId]);
    const participants: Readonly<HostPreparedRemoteParticipant>[] = [];
    for (const candidate of value) {
      const input = snapshotExactRecord(candidate, PREPARED_REMOTE_PARTICIPANT_KEYS);
      if (
        !input ||
        !isExactRemoteParticipant(input.participant) ||
        typeof input.bindAttempt !== 'function'
      ) {
        throw new TypeError('Host prepared remote participant is invalid');
      }
      const participant = input.participant;
      if (participantIds.has(participant.participantId)) {
        throw new Error('Host prepared cohort participant IDs must be unique');
      }
      participantIds.add(participant.participantId);
      participants.push(
        freezeCanonical({
          participant,
          bindAttempt: input.bindAttempt as HostPreparedRemoteParticipant['bindAttempt'],
        }),
      );
    }
    return Object.freeze(participants.slice());
  }

  #readCurrentOperationInput(
    options: unknown,
    keys: readonly string[],
  ): Readonly<{ readonly signal: AbortSignal; readonly positionSeconds: unknown }> {
    const input = snapshotExactRecord(options, keys);
    if (!input) throw new TypeError('Host current renderer operation options are invalid');
    if (!(input.signal instanceof AbortSignal)) {
      throw new TypeError('Host current renderer operation requires an exact AbortSignal');
    }
    throwIfAborted(input.signal);
    return freezeCanonical({ signal: input.signal, positionSeconds: input.positionSeconds });
  }

  #preparePlayingSeekCandidate(
    options: SeekHostPlayingOptions,
  ): Promise<Readonly<HostPreparedLocalTrack>> {
    const input = this.#readCurrentOperationInput(options, SEEK_PLAYING_KEYS);
    const positionSeconds = input.positionSeconds;
    if (
      typeof positionSeconds !== 'number' ||
      !Number.isFinite(positionSeconds) ||
      positionSeconds < 0
    ) {
      throw new TypeError('Host playing seek position is invalid');
    }
    const previousTimeline = this.#captureTimeline('playing-seek');
    if (previousTimeline.phase !== 'playing' || previousTimeline.run === null) {
      throw new Error('Host playing seek requires exact playing timeline truth');
    }
    const asset = this.#requireCurrentAsset(previousTimeline);
    const runtime = this.#requireAudioRuntime();
    const expectedCurrentPort = this.#assertExpectedRenderer(previousTimeline, 'playing-seek');
    return this.#beginCandidatePreparation({
      action: 'playing-seek',
      previousTimeline,
      expectedCurrentPort,
      asset,
      runId: previousTimeline.run.runId,
      positionSeconds,
      playbackRate: previousTimeline.rate,
      signal: input.signal,
      ...runtime,
    });
  }

  #prepareReplayCurrentCandidate(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostPreparedLocalTrack>> {
    const input = this.#readCurrentOperationInput(options, CURRENT_OPERATION_KEYS);
    const previousTimeline = this.#captureTimeline('replay');
    if (
      (previousTimeline.phase !== 'playing' && previousTimeline.phase !== 'paused') ||
      previousTimeline.run === null
    ) {
      throw new Error('Host replay requires exact active timeline truth');
    }
    const asset = this.#requireCurrentAsset(previousTimeline);
    const runtime = this.#requireAudioRuntime();
    const expectedCurrentPort = this.#assertExpectedRenderer(previousTimeline, 'replay');
    const runId = this.#newRunId('replay', asset.queueItemId, 0, previousTimeline);
    return this.#beginCandidatePreparation({
      action: 'replay',
      previousTimeline,
      expectedCurrentPort,
      asset,
      runId,
      positionSeconds: 0,
      playbackRate: 1,
      signal: input.signal,
      ...runtime,
    });
  }

  #runSynchronousTransition(
    start: () => Promise<Readonly<HostCurrentPlaybackTransitionCommit>>,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>> {
    if (this.#startingSynchronously) {
      return Promise.reject(new Error('Host renderer transition re-entered synchronously'));
    }
    this.#startingSynchronously = true;
    try {
      return start();
    } catch (error) {
      return Promise.reject(error);
    } finally {
      this.#startingSynchronously = false;
    }
  }

  #beginCurrentTransition(
    action: TransitionAction,
    signal: AbortSignal,
    positionSeconds: number | null,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>> {
    const active = this.#activeOperation;
    if (active?.kind === 'candidate') {
      throw new Error(`Host ${action} conflicts with an active renderer candidate`);
    }
    if (active) {
      if (
        active.action === action &&
        active.positionSeconds === positionSeconds &&
        active.externalSignal === signal &&
        active.task
      ) {
        return active.task;
      }
      throw new Error(`Host ${action} conflicts with an active renderer transition`);
    }
    throwIfAborted(signal);
    const previousTimeline = this.#captureTransitionTimeline(action);
    const expectedCurrentPort = this.#assertTransitionRenderer(previousTimeline, action);
    this.#operationEpoch += 1;
    const operationController = new AbortController();
    const forwardExternalAbort = () => operationController.abort(signal.reason);
    signal.addEventListener('abort', forwardExternalAbort, { once: true });
    const operation: ActiveTransitionOperation = {
      kind: 'transition',
      epoch: this.#operationEpoch,
      action,
      positionSeconds,
      previousTimeline,
      expectedCurrentPort,
      controller: operationController,
      externalSignal: signal,
      removeExternalAbort: () => signal.removeEventListener('abort', forwardExternalAbort),
      commitDominant: false,
      physicalBoundaryClaimed: false,
      task: null,
    };
    this.#activeOperation = operation;
    this.#peerPublicationAuthority = null;
    this.#cancelAllRemoteRecoveries(`remote-recovery-${action}-transition`);
    if (signal.aborted) forwardExternalAbort();
    const task = this.#executeCurrentTransition(operation);
    operation.task = task;
    return task;
  }

  #captureTransitionTimeline(action: TransitionAction): PlaybackTimelineSnapshot {
    this.#assertRoomClockAuthority();
    const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    const phaseAccepted =
      action === 'pause'
        ? timeline.phase === 'playing'
        : action === 'seek'
          ? timeline.phase === 'paused'
          : action === 'stop'
            ? timeline.phase === 'playing' || timeline.phase === 'paused'
            : timeline.phase === 'playing';
    if (
      this.#closed ||
      this.#fatalError ||
      snapshot.roomGeneration !== this.#roomGeneration ||
      snapshot.roomRole !== 'host' ||
      snapshot.timeline !== timeline ||
      !phaseAccepted ||
      timeline.run === null ||
      timeline.revision === Number.MAX_SAFE_INTEGER
    ) {
      throw this.#fatalError ?? new Error(`Host ${action} timeline authority is stale`);
    }
    this.#assertRoomClockAuthority();
    return timeline;
  }

  #assertTransitionRenderer(
    timeline: PlaybackTimelineSnapshot,
    action: TransitionAction,
  ): FilePlaybackCutoverCandidatePort {
    const port = this.#committedPort;
    const run = timeline.run;
    if (!port || !run || currentPort(this.#manager) !== port) {
      throw new Error(`Host ${action} current renderer authority is stale`);
    }
    const snapshot = Reflect.apply(trustedManagerCurrentSnapshot, this.#manager, [port]);
    if (
      !snapshot ||
      snapshot.queueItemId !== run.queueItemId ||
      snapshot.revision !== timeline.revision ||
      snapshot.run?.queueItemId !== run.queueItemId ||
      snapshot.run.runId !== run.runId ||
      snapshot.run.revision !== timeline.revision
    ) {
      throw new Error(`Host ${action} renderer identity does not match timeline truth`);
    }
    const phaseAccepted =
      action === 'pause'
        ? timeline.phase === 'playing' && snapshot.phase === 'playing'
        : action === 'seek'
          ? timeline.phase === 'paused' && snapshot.phase === 'paused'
          : action === 'stop'
            ? snapshot.phase === timeline.phase
            : timeline.phase === 'playing' && snapshot.phase === 'ended';
    if (!phaseAccepted) throw new Error(`Host ${action} renderer phase is stale`);
    return port;
  }

  #transitionStates(timeline: PlaybackTimelineSnapshot): Readonly<{
    readonly from: PlaybackStateIdentity;
    readonly to: PlaybackStateIdentity;
  }> {
    const run = timeline.run;
    if (!run) throw new Error('Host renderer transition has no active run');
    return freezeCanonical({
      from: createPlaybackStateIdentity({
        queueItemId: run.queueItemId,
        runId: run.runId,
        revision: timeline.revision,
      }),
      to: createPlaybackStateIdentity({
        queueItemId: run.queueItemId,
        runId: run.runId,
        revision: timeline.revision + 1,
      }),
    });
  }

  #futureTransitionRoomTime(timeline: PlaybackTimelineSnapshot): number {
    const clockBindings = this.#clockBindings;
    if (!clockBindings) throw new Error('Host renderer transition has no room clock binding');
    const nowRoomTimeMs = clockBindings.nowRoomTimeMs();
    if (!Number.isFinite(nowRoomTimeMs) || nowRoomTimeMs < 0) {
      throw new Error('Host renderer transition room clock is unavailable');
    }
    const atRoomTimeMs =
      Math.max(nowRoomTimeMs, timeline.anchorMonotonicMs) + calculateRendezvousLeadMs(0, 0);
    if (!Number.isFinite(atRoomTimeMs) || atRoomTimeMs < 0) {
      throw new RangeError('Host renderer transition room target is invalid');
    }
    return atRoomTimeMs;
  }

  #endedObservationRoomTime(timeline: PlaybackTimelineSnapshot): number {
    const clockBindings = this.#clockBindings;
    if (!clockBindings) throw new Error('Host ended renderer has no room clock binding');
    const observedAtRoomTimeMs = clockBindings.nowRoomTimeMs();
    if (
      !Number.isFinite(observedAtRoomTimeMs) ||
      observedAtRoomTimeMs < timeline.anchorMonotonicMs
    ) {
      throw new Error('Host ended renderer observation clock is stale');
    }
    return observedAtRoomTimeMs;
  }

  async #executeCurrentTransition(
    operation: ActiveTransitionOperation,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>> {
    try {
      this.#assertTransitionOperationFence(operation);
      this.#runtime.beforeManagerTransition?.();
      this.#assertTransitionOperationFence(operation);
      const states = this.#transitionStates(operation.previousTimeline);
      if (operation.action === 'ended') {
        return await this.#executeEndedTransition(operation, states.from, states.to);
      }
      const atRoomTimeMs = this.#futureTransitionRoomTime(operation.previousTimeline);
      if (operation.action === 'pause') {
        return await this.#executePauseTransition(operation, states.from, states.to, atRoomTimeMs);
      }
      if (operation.action === 'seek') {
        return await this.#executePausedSeekTransition(
          operation,
          states.from,
          states.to,
          atRoomTimeMs,
        );
      }
      return await this.#executeStopTransition(operation, states.from, states.to, atRoomTimeMs);
    } catch (error) {
      const recoveryRequired = Reflect.apply(trustedManagerRecoveryRequired, this.#manager, []);
      const currentChanged =
        currentPort(this.#manager) !== operation.expectedCurrentPort &&
        currentPort(this.#manager) !== null;
      if (operation.physicalBoundaryClaimed || recoveryRequired || currentChanged) {
        this.#quarantineAfterPhysicalFailure(error);
      }
      throw error;
    } finally {
      operation.removeExternalAbort();
      if (this.#activeOperation === operation) this.#activeOperation = null;
    }
  }

  async #executePauseTransition(
    operation: ActiveTransitionOperation,
    from: PlaybackStateIdentity,
    to: PlaybackStateIdentity,
    atRoomTimeMs: number,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>> {
    const intent: Readonly<FilePlaybackPauseTransitionIntent> = freezeCanonical({
      kind: 'file-playback-pause-transition' as const,
      from,
      to,
      atRoomTimeMs,
    });
    const pending = Reflect.apply(trustedManagerPauseCurrent, this.#manager, [
      operation.expectedCurrentPort,
      intent,
    ]) as Promise<FilePlaybackTransitionResult>;
    operation.commitDominant = true;
    const result = await pending;
    if (result.status === 'rejected') {
      operation.commitDominant = false;
      throw new Error(`Host pause was rejected before scheduling: ${result.reason}`);
    }
    operation.physicalBoundaryClaimed = true;
    this.#notifyTransitionScheduled('pause', intent, null);
    const evidence = (await result.applied) as Readonly<FilePlaybackPauseTransitionEvidence>;
    this.#assertTransitionCommitFence(operation, intent, true);
    this.#runtime.beforeTransitionControllerCommit?.();
    this.#assertTransitionCommitFence(operation, intent, true);
    const committed = Reflect.apply(trustedControllerTransitionCommit, this.#controller, [
      {
        kind: 'pause',
        roomGeneration: this.#roomGeneration,
        expectedPrevious: operation.previousTimeline,
        intent,
        evidence,
      },
    ]) as Readonly<FilePlaybackHostTransitionCommit>;
    this.#assertTransitionControllerCommit(operation, intent, committed, 'paused', null);
    this.#notifyTimelineCommitted('pause', operation.previousTimeline, committed.timeline);
    return this.#transitionResult('pause', evidence, committed.timeline);
  }

  async #executePausedSeekTransition(
    operation: ActiveTransitionOperation,
    from: PlaybackStateIdentity,
    to: PlaybackStateIdentity,
    atRoomTimeMs: number,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>> {
    const positionSeconds = operation.positionSeconds;
    if (positionSeconds === null) throw new Error('Host paused seek lost its exact position');
    const intent: Readonly<FilePlaybackSeekTransitionIntent> = freezeCanonical({
      kind: 'file-playback-seek-transition' as const,
      from,
      to,
      positionSeconds,
      atRoomTimeMs,
    });
    const pending = Reflect.apply(trustedManagerSeekCurrent, this.#manager, [
      operation.expectedCurrentPort,
      intent,
    ]) as Promise<FilePlaybackTransitionResult>;
    operation.commitDominant = true;
    const result = await pending;
    if (result.status === 'rejected') {
      operation.commitDominant = false;
      throw new Error(`Host paused seek was rejected before scheduling: ${result.reason}`);
    }
    operation.physicalBoundaryClaimed = true;
    this.#notifyTransitionScheduled('seek', intent, positionSeconds);
    const evidence = (await result.applied) as Readonly<FilePlaybackSeekTransitionEvidence>;
    this.#assertTransitionCommitFence(operation, intent, true);
    this.#runtime.beforeTransitionControllerCommit?.();
    this.#assertTransitionCommitFence(operation, intent, true);
    const committed = Reflect.apply(trustedControllerTransitionCommit, this.#controller, [
      {
        kind: 'seek',
        roomGeneration: this.#roomGeneration,
        expectedPrevious: operation.previousTimeline,
        intent,
        evidence,
      },
    ]) as Readonly<FilePlaybackHostTransitionCommit>;
    this.#assertTransitionControllerCommit(operation, intent, committed, 'paused', positionSeconds);
    this.#notifyTimelineCommitted('seek', operation.previousTimeline, committed.timeline);
    return this.#transitionResult('seek', evidence, committed.timeline);
  }

  async #executeStopTransition(
    operation: ActiveTransitionOperation,
    from: PlaybackStateIdentity,
    to: PlaybackStateIdentity,
    atRoomTimeMs: number,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>> {
    const audioContext = this.#audioContext;
    const clockBindings = this.#clockBindings;
    if (!audioContext || !clockBindings) {
      throw new Error('Host stop has no exact audio clock authority');
    }
    const contextTimeSeconds = clockBindings.roomTimeMsToContextTime(atRoomTimeMs);
    const sampleRate = audioContext.sampleRate;
    if (
      !Number.isFinite(contextTimeSeconds) ||
      contextTimeSeconds < 0 ||
      !Number.isFinite(sampleRate) ||
      sampleRate <= 0
    ) {
      throw new Error('Host stop audio target is invalid');
    }
    const targetFrame = Math.round(contextTimeSeconds * sampleRate);
    const intent: Readonly<FilePlaybackStopTransitionIntent> = freezeCanonical({
      kind: 'file-playback-stop-transition' as const,
      from,
      to,
      atRoomTimeMs,
      target: createFilePlaybackCutoverTarget(audioContext, contextTimeSeconds, targetFrame),
    });
    const pending = Reflect.apply(trustedManagerStopCurrent, this.#manager, [
      operation.expectedCurrentPort,
      intent,
    ]) as Promise<FilePlaybackStopTransitionResult>;
    operation.commitDominant = true;
    const result = await pending;
    operation.physicalBoundaryClaimed = true;
    this.#notifyTransitionScheduled('stop', intent, null);
    const evidence = await result.applied;
    this.#assertTransitionCommitFence(operation, intent, false);
    this.#runtime.beforeTransitionControllerCommit?.();
    this.#assertTransitionCommitFence(operation, intent, false);
    const committed = Reflect.apply(trustedControllerTransitionCommit, this.#controller, [
      {
        kind: 'stop',
        roomGeneration: this.#roomGeneration,
        expectedPrevious: operation.previousTimeline,
        intent,
        evidence,
      },
    ]) as Readonly<FilePlaybackHostTransitionCommit>;
    this.#assertTransitionControllerCommit(operation, intent, committed, 'stopped', null);
    this.#committedPort = null;
    this.#retireCurrentSourceAuthority();
    this.#notifyTimelineCommitted('stop', operation.previousTimeline, committed.timeline);
    return this.#transitionResult('stop', evidence, committed.timeline);
  }

  async #executeEndedTransition(
    operation: ActiveTransitionOperation,
    from: PlaybackStateIdentity,
    to: PlaybackStateIdentity,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>> {
    const intent: Readonly<FilePlaybackEndedTransitionIntent> = freezeCanonical({
      kind: 'file-playback-ended-transition' as const,
      from,
      to,
      observedAtRoomTimeMs: this.#endedObservationRoomTime(operation.previousTimeline),
    });
    const pending = Reflect.apply(trustedManagerRetireEnded, this.#manager, [
      operation.expectedCurrentPort,
      intent,
    ]) as Promise<Readonly<FilePlaybackEndedTransitionEvidence>>;
    operation.commitDominant = true;
    operation.physicalBoundaryClaimed = true;
    const evidence = await pending;
    this.#assertTransitionCommitFence(operation, intent, false);
    this.#runtime.beforeTransitionControllerCommit?.();
    this.#assertTransitionCommitFence(operation, intent, false);
    const committed = Reflect.apply(trustedControllerEndedCommit, this.#controller, [
      {
        roomGeneration: this.#roomGeneration,
        expectedPrevious: operation.previousTimeline,
        intent,
        evidence,
      },
    ]) as Readonly<FilePlaybackHostEndedCommit>;
    if (
      committed.previous !== operation.previousTimeline ||
      committed.timeline.revision !== intent.to.revision ||
      committed.timeline.phase !== 'stopped' ||
      committed.timeline.run !== null
    ) {
      throw new Error('Host ended timeline commit did not match manager evidence');
    }
    this.#committedPort = null;
    this.#retireCurrentSourceAuthority();
    this.#notifyTimelineCommitted('ended', operation.previousTimeline, committed.timeline);
    return this.#transitionResult('ended', evidence, committed.timeline);
  }

  #notifyTransitionScheduled(
    kind: HostCurrentPlaybackTransitionScheduledEvent['kind'],
    intent:
      | Readonly<FilePlaybackPauseTransitionIntent>
      | Readonly<FilePlaybackSeekTransitionIntent>
      | Readonly<FilePlaybackStopTransitionIntent>,
    positionSeconds: number | null,
  ): void {
    const notify = this.#onTransitionScheduled;
    if (!notify) return;
    const event = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: this.#roomGeneration,
      kind,
      from: intent.from,
      to: intent.to,
      atRoomTimeMs: intent.atRoomTimeMs,
      positionSeconds,
    });
    try {
      notify(event);
    } catch {
      // A failed per-connection observer must never roll back a native frame
      // schedule which the local renderer has already accepted.
    }
  }

  #notifyTimelineCommitted(
    kind: HostCurrentPlaybackTimelineCommittedEvent['kind'],
    previous: PlaybackTimelineSnapshot,
    timeline: PlaybackTimelineSnapshot,
  ): void {
    const notify = this.#onTimelineCommitted;
    if (!notify) return;
    const event = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: this.#roomGeneration,
      kind,
      previous,
      timeline,
    });
    try {
      notify(event);
    } catch {
      // Canonical truth and physical evidence are already committed. Product
      // fanout isolates a broken connection instead of destabilizing the room.
    }
  }

  #captureWarmRoomTimeline(): PlaybackTimelineSnapshot {
    this.#assertRoomClockAuthority();
    const warmCleanupError = this.#warmCleanupAuthorityError();
    const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (
      this.#closed ||
      this.#coordinatorClosed ||
      this.#fatalError ||
      warmCleanupError ||
      snapshot.roomGeneration !== this.#roomGeneration ||
      snapshot.roomRole !== 'host' ||
      snapshot.timeline !== timeline
    ) {
      throw (
        this.#fatalError ??
        warmCleanupError ??
        new Error('Host local file warm room authority is stale')
      );
    }
    this.#assertRoomClockAuthority();
    return timeline;
  }

  #bindWarmAudioRuntime(
    input: Readonly<CanonicalFileWarmInput>,
    timeline: PlaybackTimelineSnapshot,
  ): Readonly<WarmAudioRuntime> {
    if (this.#audioContext && this.#audioContext !== input.audioContext) {
      throw new Error('Host file playback room AudioContext cannot change');
    }
    const clockBindings =
      this.#clockBindings ??
      Reflect.apply(trustedRoomClockBind, this.#roomClock, [input.audioContext]);
    if (clockBindings === null || typeof clockBindings !== 'object') {
      throw new TypeError('Host file playback room clock returned invalid bindings');
    }
    this.#assertTimelineAuthority(timeline, false);
    this.#audioContext ??= input.audioContext;
    this.#clockBindings ??= clockBindings;
    this.#decodeOrdinaryAudio = input.decodeOrdinaryAudio;
    return freezeCanonical({
      audioContext: input.audioContext,
      decodeOrdinaryAudio: input.decodeOrdinaryAudio,
      clockBindings,
    });
  }

  #beginWarmTrack(
    input: Readonly<CanonicalFileWarmInput>,
    runtime: Readonly<WarmAudioRuntime>,
  ): Promise<Readonly<HostLocalTrackWarmResult>> {
    throwIfAborted(input.signal);
    const previous = this.#warmTrackOperation;
    this.#warmEpoch += 1;
    const epoch = this.#warmEpoch;
    const controller = new AbortController();
    const externalSignal = input.signal;
    let operation: WarmTrackOperation | null = null;
    const forwardExternalAbort = () => {
      controller.abort(externalSignal.reason);
      const current = operation;
      if (current && !current.claimed) {
        this.#observeDetachedWarmRetirement(
          this.#retireWarmTrackOperation(
            current,
            asError(externalSignal.reason, 'Host local file warm source was aborted'),
          ),
        );
      }
    };
    let listening = true;
    externalSignal.addEventListener('abort', forwardExternalAbort, { once: true });
    const removeExternalAbort = () => {
      if (!listening) return;
      listening = false;
      externalSignal.removeEventListener('abort', forwardExternalAbort);
    };
    operation = {
      epoch,
      queueItemId: input.queueItemId,
      input,
      asset: null,
      controller,
      removeExternalAbort,
      task: null,
      authority: null,
      sourceLease: null,
      claimed: false,
      claimedBy: null,
      handoffBarrier: null,
      assetRetirementPromise: null,
      retirementPromise: null,
    };
    this.#warmTrackOperation = operation;
    if (previous && !previous.claimed) {
      previous.controller.abort(new Error('Host local file warm source was superseded'));
    }
    if (externalSignal.aborted) forwardExternalAbort();
    const task = this.#executeWarmTrack(operation, previous, runtime);
    operation.task = task;
    return task;
  }

  async #executeWarmTrack(
    operation: WarmTrackOperation,
    previous: WarmTrackOperation | null,
    runtime: Readonly<WarmAudioRuntime>,
  ): Promise<Readonly<HostLocalTrackWarmResult>> {
    try {
      if (previous) {
        await this.#retireWarmTrackOperation(
          previous,
          new Error('Host local file warm source was replaced'),
        );
      }
      this.#assertWarmOperationFence(operation);
      operation.asset = this.#admitWarmOperationAsset(operation);
      this.#assertWarmTrackAuthority(operation);
      const asset = operation.asset;
      const authority = await prepareFilePlaybackAssetSourceWarm({
        registry: this.#registry,
        roomToken: this.#roomToken,
        assetLease: asset.lease,
        expectedBinding: asset.binding,
        audioContext: runtime.audioContext,
        clockBindings: runtime.clockBindings,
        signal: operation.controller.signal,
        isCurrent: () => this.#warmTrackAuthorityAllows(operation),
        decodeOrdinaryAudio: runtime.decodeOrdinaryAudio,
        ...(this.#boundedRoutePolicy ? { boundedRoutePolicy: this.#boundedRoutePolicy } : {}),
        ...(this.#installCodecTimelineHostArtifact
          ? { installCodecTimelineHostArtifact: true as const }
          : {}),
        ...(this.#runtime.warmSourceRuntime ? { runtime: this.#runtime.warmSourceRuntime } : {}),
      });
      operation.authority = authority;
      this.#assertWarmTrackAuthority(operation);
      const result = this.#warmTrackResult(
        operation,
        authority,
        authority.backend === 'bounded-stream' ? 'warmed' : 'skipped-non-bounded',
      );
      if (authority.backend !== 'bounded-stream') {
        try {
          await retireFilePlaybackAssetSourceWarm(authority);
        } catch (cleanupError) {
          operation.authority = null;
          const failure = new HostFirstFileCleanupError(
            'Host non-bounded warm source cleanup failed',
            cleanupError,
          );
          this.#recordWarmCleanupFailure(failure);
          throw failure;
        }
        operation.authority = null;
        const discard = this.#discardProvisionalAsset(asset);
        this.#releaseRetiredWarmOperationReferences(operation);
        if (discard) {
          try {
            await discard;
          } catch (cleanupError) {
            const failure = new HostFirstFileCleanupError(
              'Host non-bounded warm asset discard failed',
              cleanupError,
            );
            this.#recordWarmCleanupFailure(failure);
            throw failure;
          }
        }
        if (this.#warmTrackOperation === operation) this.#warmTrackOperation = null;
        operation.removeExternalAbort();
      }
      return result;
    } catch (error) {
      const authority = operation.authority;
      const asset = operation.asset;
      operation.authority = null;
      let cleanupFailure: unknown = null;
      if (authority) {
        try {
          await retireFilePlaybackAssetSourceWarm(authority);
        } catch (cleanupError) {
          cleanupFailure = mergeCleanupFailure(cleanupFailure, cleanupError);
        }
      }
      const discard = asset ? this.#discardProvisionalAsset(asset) : null;
      this.#releaseRetiredWarmOperationReferences(operation);
      if (discard) {
        try {
          await discard;
        } catch (cleanupError) {
          cleanupFailure = mergeCleanupFailure(cleanupFailure, cleanupError);
        }
      }
      operation.removeExternalAbort();
      if (this.#warmTrackOperation === operation) this.#warmTrackOperation = null;
      if (cleanupFailure !== null) {
        const failure = new HostFirstFileCleanupError(
          'Host local file warm source cleanup failed',
          new AggregateError([error, cleanupFailure]),
        );
        this.#recordWarmCleanupFailure(failure);
        throw failure;
      }
      throw error;
    }
  }

  #warmTrackResult(
    operation: WarmTrackOperation,
    authority: Readonly<FilePlaybackWarmSourceAuthority>,
    status: HostLocalTrackWarmResult['status'],
  ): Readonly<HostLocalTrackWarmResult> {
    const asset = authority.asset;
    const admitted = operation.asset;
    if (!admitted) {
      throw new Error('Host warm result lost its admitted asset');
    }
    const publicationAsset = this.#peerAssetPublication(asset, admitted.lease, authority.backend);
    let sourceLease: HostLocalTrackSourceLease | null = null;
    if (status === 'warmed') {
      sourceLease = freezeCanonical({}) as HostLocalTrackSourceLease;
      operation.sourceLease = sourceLease;
      this.#warmSourceLeaseAuthorities.set(sourceLease, {
        lease: sourceLease,
        operation,
        asset,
        backend: authority.backend,
        peerRangeManifest: publicationAsset.peerRangeManifest,
        preparedAuthority: null,
        retired: false,
      });
    }
    return freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: this.#roomGeneration,
      status,
      backend: authority.backend,
      asset: publicationAsset,
      readiness: authority.readiness,
      sourceLease,
    });
  }

  #assertWarmOperationFence(operation: WarmTrackOperation): void {
    throwIfAborted(operation.controller.signal);
    const warmCleanupError = this.#warmCleanupAuthorityError();
    if (
      this.#warmTrackOperation !== operation ||
      this.#warmEpoch !== operation.epoch ||
      operation.claimed ||
      this.#closed ||
      this.#coordinatorClosed ||
      this.#fatalError ||
      warmCleanupError
    ) {
      throw (
        this.#fatalError ??
        warmCleanupError ??
        new Error('Host local file warm source was superseded')
      );
    }
    this.#assertRoomClockAuthority();
    const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (
      snapshot.roomGeneration !== this.#roomGeneration ||
      snapshot.roomRole !== 'host' ||
      snapshot.timeline !== timeline
    ) {
      throw new Error('Host local file warm room authority changed');
    }
    throwIfAborted(operation.controller.signal);
  }

  #assertWarmTrackAuthority(operation: WarmTrackOperation): void {
    this.#assertWarmOperationFence(operation);
    const admitted = operation.asset;
    const asset = admitted
      ? this.#registry.snapshotForLease(this.#roomToken, admitted.lease)
      : null;
    if (
      !admitted ||
      !asset ||
      (admitted.ownership !== 'provisional' && admitted.ownership !== 'live') ||
      this.#assets.get(admitted.queueItemId) !== admitted ||
      asset.queueItemId !== admitted.binding.queueItemId ||
      asset.sourceIdentity !== admitted.binding.sourceIdentity ||
      asset.transferSessionId !== admitted.binding.transferSessionId ||
      asset.kind !== 'blob' ||
      asset.size !== admitted.blob.size ||
      asset.name !== admitted.name ||
      asset.mime !== admitted.mime
    ) {
      throw new Error('Host local file warm source authority changed');
    }
    throwIfAborted(operation.controller.signal);
  }

  #warmTrackAuthorityAllows(operation: WarmTrackOperation): boolean {
    try {
      if (operation.claimed) {
        const candidate = operation.claimedBy;
        if (!candidate) return false;
        this.#assertOperationFence(candidate);
        return true;
      }
      this.#assertWarmTrackAuthority(operation);
      return true;
    } catch {
      return false;
    }
  }

  #retireWarmTrackOperation(operation: WarmTrackOperation, reason: Error): Promise<void> {
    if (!operation.claimed) {
      const asset = operation.asset;
      this.#retireWarmSourceLeaseAuthority(operation);
      if (asset && !operation.assetRetirementPromise) {
        operation.assetRetirementPromise = this.#discardProvisionalAsset(asset);
      }
    }
    if (operation.retirementPromise) return operation.retirementPromise;
    const retirement = this.#executeWarmTrackRetirement(operation, reason);
    operation.retirementPromise = retirement;
    return retirement;
  }

  async #executeWarmTrackRetirement(operation: WarmTrackOperation, reason: Error): Promise<void> {
    const authorityAtStart = !operation.claimed ? operation.authority : null;
    const earlyAuthorityRetirement = authorityAtStart
      ? retireFilePlaybackAssetSourceWarm(authorityAtStart)
      : null;
    if (!operation.claimed) operation.controller.abort(reason);
    let failure: unknown = null;
    const task = operation.task;
    if (task) {
      try {
        await task;
      } catch (error) {
        if (containsCleanupFailure(error)) failure = error;
      }
    }
    if (operation.claimed && operation.handoffBarrier) {
      await operation.handoffBarrier.promise;
    }
    const authority = operation.authority;
    operation.authority = null;
    if (earlyAuthorityRetirement) {
      try {
        await earlyAuthorityRetirement;
      } catch (error) {
        failure = mergeCleanupFailure(failure, error);
      }
    }
    if (authority && authority !== authorityAtStart && !operation.claimed) {
      try {
        await retireFilePlaybackAssetSourceWarm(authority);
      } catch (error) {
        failure = mergeCleanupFailure(failure, error);
      }
    }
    const assetRetirement = operation.assetRetirementPromise;
    if (assetRetirement) {
      try {
        await assetRetirement;
      } catch (error) {
        failure = mergeCleanupFailure(failure, error);
      }
    }
    operation.removeExternalAbort();
    if (this.#warmTrackOperation === operation) this.#warmTrackOperation = null;
    if (failure) {
      const cleanupError = new HostFirstFileCleanupError(
        'Host local file warm retirement failed',
        failure,
      );
      this.#recordWarmCleanupFailure(cleanupError);
      throw cleanupError;
    }
  }

  #observeDetachedWarmRetirement(retirement: Promise<void>): void {
    this.#detachedWarmRetirements.add(retirement);
    void retirement.then(
      () => {
        this.#detachedWarmRetirements.delete(retirement);
      },
      (error: unknown) => {
        this.#detachedWarmRetirements.delete(retirement);
        const cleanupError = asError(error, 'Host detached warm source cleanup failed');
        this.#recordWarmCleanupFailure(cleanupError);
        this.#handleDetachedWarmCleanupFailure(cleanupError);
      },
    );
  }

  #recordWarmCleanupFailure(error: unknown): void {
    if (this.#warmCleanupFailure === error) return;
    this.#warmCleanupFailure = mergeCleanupFailure(this.#warmCleanupFailure, error);
  }

  #warmCleanupAuthorityError(): Error | null {
    return this.#warmCleanupFailure === null
      ? null
      : asError(this.#warmCleanupFailure, 'Host warm cleanup authority is unsafe');
  }

  async #collectWarmCleanup(operation: WarmTrackOperation | null, reason: Error): Promise<void> {
    const tasks = new Set<Promise<void>>(this.#detachedWarmRetirements);
    if (operation) tasks.add(this.#retireWarmTrackOperation(operation, reason));
    let failure = this.#warmCleanupFailure;
    for (const task of tasks) {
      try {
        await task;
      } catch (error) {
        if (failure !== error) failure = mergeCleanupFailure(failure, error);
      }
    }
    if (this.#warmCleanupFailure !== null && failure !== this.#warmCleanupFailure) {
      failure = mergeCleanupFailure(failure, this.#warmCleanupFailure);
    }
    if (failure !== null) {
      throw new HostFirstFileCleanupError('Host warm cleanup did not complete safely', failure);
    }
  }

  #handleDetachedWarmCleanupFailure(error: Error): void {
    if (!this.#fatalError) this.#fatalError = error;
    this.#closed = true;
    this.#peerPublicationAuthority = null;
    this.#retireAllSourceAuthorities();
    this.#preparedTrackAuthority = null;
    const active = this.#activeOperation;
    const warm = this.#warmTrackOperation;
    this.#cancelAllRemoteRecoveries('remote-recovery-warm-cleanup-fatal');
    this.#operationEpoch += 1;
    this.#warmEpoch += 1;
    const coordinatorFailure = mergeCleanupFailure(this.#closeCoordinatorOnce(), error);
    active?.controller.abort(error);
    const warmCleanup = this.#collectWarmCleanup(warm, error);
    if (!this.#closePromise) {
      this.#closePromise = this.#closeOwnedRoom(
        active?.task ?? null,
        coordinatorFailure,
        warmCleanup,
      );
      observe(this.#closePromise);
    }
    this.#notifyFatalAfterTerminalCleanup(this.#fatalError);
  }

  #claimMatchingWarmSource(
    asset: AdmittedLocalFile,
    operation: ActiveStartOperation,
  ): Readonly<ClaimedWarmTrackSource> | null | Promise<Readonly<ClaimedWarmTrackSource> | null> {
    this.#assertOperationFence(operation);
    if (!this.#warmTrackOperation) return null;
    return this.#claimMatchingWarmSourceAsync(asset, operation);
  }

  async #claimMatchingWarmSourceAsync(
    asset: AdmittedLocalFile,
    operation: ActiveStartOperation,
  ): Promise<Readonly<ClaimedWarmTrackSource> | null> {
    for (;;) {
      this.#assertOperationFence(operation);
      const warm = this.#warmTrackOperation;
      if (!warm) return null;
      try {
        if (warm.task) await warm.task;
      } catch (error) {
        if (containsCleanupFailure(error)) throw error;
      }
      this.#assertOperationFence(operation);
      if (this.#warmTrackOperation !== warm) continue;
      if (warm.asset !== asset) {
        await this.#retireWarmTrackOperation(
          warm,
          new Error('Host local file candidate replaced a different warm source'),
        );
        continue;
      }
      const authority = warm.authority;
      if (!authority || authority.backend !== 'bounded-stream' || warm.claimed) {
        await this.#retireWarmTrackOperation(
          warm,
          new Error('Host local file warm source was unavailable for handoff'),
        );
        continue;
      }
      try {
        this.#assertWarmTrackAuthority(warm);
      } catch {
        await this.#retireWarmTrackOperation(
          warm,
          new Error('Host local file warm source became stale before handoff'),
        );
        continue;
      }
      let resolveHandoff!: () => void;
      const handoffPromise = new Promise<void>((resolve) => {
        resolveHandoff = resolve;
      });
      warm.claimed = true;
      warm.claimedBy = operation;
      warm.handoffBarrier = {
        promise: handoffPromise,
        resolve: resolveHandoff,
        settled: false,
      };
      warm.removeExternalAbort();
      return freezeCanonical({ authority, operation: warm });
    }
  }

  #settleClaimedWarmTrack(claimed: Readonly<ClaimedWarmTrackSource>): void {
    const operation = claimed.operation;
    const barrier = operation.handoffBarrier;
    if (!operation.claimed || !barrier || barrier.settled) return;
    barrier.settled = true;
    operation.authority = null;
    if (this.#warmTrackOperation === operation) this.#warmTrackOperation = null;
    barrier.resolve();
  }

  #assertTransitionControllerCommit(
    operation: ActiveTransitionOperation,
    intent:
      | Readonly<FilePlaybackPauseTransitionIntent>
      | Readonly<FilePlaybackSeekTransitionIntent>
      | Readonly<FilePlaybackStopTransitionIntent>,
    committed: Readonly<FilePlaybackHostTransitionCommit>,
    expectedPhase: 'paused' | 'stopped',
    expectedPositionSeconds: number | null,
  ): void {
    const timeline = committed.timeline;
    const run = timeline.run;
    if (
      committed.kind !== operation.action ||
      committed.previous !== operation.previousTimeline ||
      timeline.revision !== intent.to.revision ||
      timeline.phase !== expectedPhase ||
      (expectedPositionSeconds !== null && timeline.positionSeconds !== expectedPositionSeconds) ||
      (expectedPhase === 'stopped'
        ? run !== null
        : !run || run.queueItemId !== intent.to.queueItemId || run.runId !== intent.to.runId)
    ) {
      throw new Error(`Host ${operation.action} timeline commit did not match manager evidence`);
    }
  }

  #transitionResult(
    kind: HostCurrentPlaybackTransitionCommit['kind'],
    evidence: Readonly<HostCurrentPlaybackTransitionEvidence>,
    timeline: PlaybackTimelineSnapshot,
  ): Readonly<HostCurrentPlaybackTransitionCommit> {
    return freezeCanonical({
      schemaVersion: 1 as const,
      kind,
      roomGeneration: this.#roomGeneration,
      evidence,
      timeline,
    });
  }

  #captureTimeline(action: CandidateAction): PlaybackTimelineSnapshot {
    if (this.#activeOperation?.kind === 'transition') {
      throw new Error(`Host ${action} conflicts with an active renderer transition`);
    }
    if (this.#activeOperation?.commitDominant) {
      throw new Error(`Host ${action} cannot supersede a physical renderer commit`);
    }
    this.#assertRoomClockAuthority();
    const warmCleanupError = this.#warmCleanupAuthorityError();
    const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (
      this.#closed ||
      this.#fatalError ||
      warmCleanupError ||
      snapshot.roomGeneration !== this.#roomGeneration ||
      snapshot.roomRole !== 'host' ||
      snapshot.timeline !== timeline ||
      timeline.revision === Number.MAX_SAFE_INTEGER
    ) {
      throw (
        this.#fatalError ?? warmCleanupError ?? new Error(`Host ${action} room authority is stale`)
      );
    }
    this.#assertRoomClockAuthority();
    return timeline;
  }

  #startFileCandidate(
    action: 'first' | 'track',
    input: Readonly<CanonicalFileCandidateInput>,
    previousTimeline: PlaybackTimelineSnapshot,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    return this.#prepareFileCandidate(action, input, previousTimeline).then((prepared) =>
      this.startPreparedLocalTrack({ prepared, remoteParticipants: [] }),
    );
  }

  #prepareFileCandidate(
    action: 'first' | 'track',
    input: Readonly<CanonicalFileCandidateInput>,
    previousTimeline: PlaybackTimelineSnapshot,
  ): Promise<Readonly<HostPreparedLocalTrack>> {
    const expectedCurrentPort = this.#assertExpectedRenderer(previousTimeline, action);
    const runtime = this.#bindAudioRuntime(input, previousTimeline);
    const asset = this.#admitAsset(input, previousTimeline);
    this.#assertTimelineAuthority(previousTimeline, false);
    if (this.#assertExpectedRenderer(previousTimeline, action) !== expectedCurrentPort) {
      throw new Error('Host local file renderer authority changed during admission');
    }
    const runId = this.#newRunId(
      action,
      asset.queueItemId,
      input.positionSeconds,
      previousTimeline,
    );
    return this.#beginCandidatePreparation({
      action,
      previousTimeline,
      expectedCurrentPort,
      asset,
      runId,
      positionSeconds: input.positionSeconds,
      playbackRate: 1,
      signal: input.signal,
      ...runtime,
    });
  }

  #bindAudioRuntime(
    input: Readonly<CanonicalFileCandidateInput>,
    previousTimeline: PlaybackTimelineSnapshot,
  ): Readonly<CandidateAudioRuntime> {
    if (this.#audioContext && this.#audioContext !== input.audioContext) {
      throw new Error('Host file playback room AudioContext cannot change');
    }
    if (this.#destination && this.#destination !== input.destination) {
      throw new Error('Host file playback room destination cannot change');
    }
    const clockBindings =
      this.#clockBindings ??
      Reflect.apply(trustedRoomClockBind, this.#roomClock, [input.audioContext]);
    if (clockBindings === null || typeof clockBindings !== 'object') {
      throw new TypeError('Host file playback room clock returned invalid bindings');
    }
    this.#assertTimelineAuthority(previousTimeline, false);
    this.#audioContext ??= input.audioContext;
    this.#destination ??= input.destination;
    this.#clockBindings ??= clockBindings;
    this.#decodeOrdinaryAudio = input.decodeOrdinaryAudio;
    return freezeCanonical({
      audioContext: input.audioContext,
      destination: input.destination,
      decodeOrdinaryAudio: input.decodeOrdinaryAudio,
      clockBindings,
    });
  }

  #requireAudioRuntime(): Readonly<CandidateAudioRuntime> {
    if (
      !this.#audioContext ||
      !this.#destination ||
      !this.#clockBindings ||
      !this.#decodeOrdinaryAudio
    ) {
      throw new Error('Host current renderer has no retained audio runtime');
    }
    return freezeCanonical({
      audioContext: this.#audioContext,
      destination: this.#destination,
      decodeOrdinaryAudio: this.#decodeOrdinaryAudio,
      clockBindings: this.#clockBindings,
    });
  }

  #admitAsset(
    input: Readonly<CanonicalFileWarmInput>,
    previousTimeline: PlaybackTimelineSnapshot,
  ): AdmittedLocalFile {
    const existing = this.#assets.get(input.queueItemId);
    if (existing) {
      if (
        existing.blob !== input.blob ||
        existing.name !== input.name ||
        existing.mime !== input.mime
      ) {
        throw new Error('Host queue item asset binding cannot change during a room');
      }
      if (existing.ownership === 'provisional' && this.#warmTrackOperation?.asset !== existing) {
        throw new Error('Host queue item provisional asset already belongs to a candidate');
      }
      if (existing.ownership === 'discarding' || existing.ownership === 'discarded') {
        throw new Error('Host queue item provisional asset cleanup is pending');
      }
      return existing;
    }
    this.#assertTimelineAuthority(previousTimeline, false);
    const scope = createFilePlaybackMediaScope(this.#applicationScopeId, input.queueItemId);
    const binding = freezeCanonical({ queueItemId: input.queueItemId, ...scope });
    const lease = Reflect.apply(this.#runtime.admitAsset, undefined, [
      this.#registry,
      this.#roomToken,
      binding,
      input.blob,
      freezeCanonical({ name: input.name, mime: input.mime }),
    ]);
    const admitted: AdmittedLocalFile = {
      queueItemId: input.queueItemId,
      blob: input.blob,
      name: input.name,
      mime: input.mime,
      binding,
      lease,
      ownership: 'live',
      discardPromise: null,
    };
    this.#assets.set(input.queueItemId, admitted);
    if (this.#runtime.fatalAfterAdmission) {
      this.#handleRegistryFatal(new Error('Fixture registry fatal after admission'));
    }
    return admitted;
  }

  #admitWarmOperationAsset(operation: WarmTrackOperation): AdmittedLocalFile {
    const input = operation.input;
    operation.input = null;
    if (!input || input.queueItemId !== operation.queueItemId) {
      throw new Error('Host local file warm admission input is stale');
    }
    return this.#admitWarmAsset(input);
  }

  #admitWarmAsset(input: Readonly<CanonicalFileWarmInput>): AdmittedLocalFile {
    const existing = this.#assets.get(input.queueItemId);
    if (existing) {
      if (
        existing.blob !== input.blob ||
        existing.name !== input.name ||
        existing.mime !== input.mime
      ) {
        throw new Error('Host queue item asset binding cannot change during warm admission');
      }
      if (existing.ownership !== 'live') {
        throw new Error('Host queue item already has provisional warm asset authority');
      }
      return existing;
    }
    this.#assertRoomClockAuthority();
    const scope = createFilePlaybackMediaScope(this.#applicationScopeId, input.queueItemId);
    const binding = freezeCanonical({ queueItemId: input.queueItemId, ...scope });
    const lease = this.#registry.admitProvisionalBlobAsset(
      this.#roomToken,
      binding,
      input.blob,
      freezeCanonical({ name: input.name, mime: input.mime }),
    );
    const admitted: AdmittedLocalFile = {
      queueItemId: input.queueItemId,
      blob: input.blob,
      name: input.name,
      mime: input.mime,
      binding,
      lease,
      ownership: 'provisional',
      discardPromise: null,
    };
    this.#assets.set(input.queueItemId, admitted);
    if (this.#runtime.fatalAfterAdmission) {
      this.#handleRegistryFatal(new Error('Fixture registry fatal after admission'));
    }
    return admitted;
  }

  #ensureColdCandidateAsset(
    operation: ActiveStartOperation,
    input: BeginCandidateOperationInput,
  ): Promise<void> | null {
    const previous = input.asset;
    if (previous.ownership === 'live') return null;
    return this.#replaceDiscardedCandidateAsset(operation, input, previous);
  }

  async #replaceDiscardedCandidateAsset(
    operation: ActiveStartOperation,
    input: BeginCandidateOperationInput,
    previous: AdmittedLocalFile,
  ): Promise<void> {
    const discard = this.#discardProvisionalAsset(previous) ?? previous.discardPromise;
    if (discard) await discard;
    this.#assertOperationFence(operation);

    const current = this.#assets.get(previous.queueItemId);
    if (current?.ownership === 'provisional') {
      throw new Error('Host candidate cold fallback conflicts with a newer warm source');
    }
    const admitted = this.#admitAsset(
      {
        queueItemId: previous.queueItemId,
        blob: previous.blob,
        name: previous.name,
        mime: previous.mime,
        audioContext: input.audioContext,
        decodeOrdinaryAudio: input.decodeOrdinaryAudio,
        signal: operation.controller.signal,
      },
      operation.previousTimeline,
    );
    if (admitted.ownership !== 'live') {
      throw new Error('Host candidate cold fallback did not acquire live asset authority');
    }
    input.asset = admitted;
  }

  async #joinCandidateProvisionalCleanup(
    cause: unknown,
    tasks: readonly (Promise<void> | null)[],
    message: string,
  ): Promise<void> {
    let cleanupFailure: unknown = null;
    for (const task of new Set(tasks.filter((task): task is Promise<void> => task !== null))) {
      try {
        await task;
      } catch (error) {
        cleanupFailure = mergeCleanupFailure(cleanupFailure, error);
      }
    }
    if (cleanupFailure === null) return;
    const failure = new HostFirstFileCleanupError(
      message,
      new AggregateError([cause, cleanupFailure]),
    );
    this.#recordWarmCleanupFailure(failure);
    throw failure;
  }

  #discardProvisionalAsset(asset: AdmittedLocalFile): Promise<void> | null {
    if (asset.ownership === 'live' || asset.ownership === 'discarded') return null;
    if (asset.discardPromise) return asset.discardPromise;
    asset.ownership = 'discarding';
    if (this.#assets.get(asset.queueItemId) === asset) this.#assets.delete(asset.queueItemId);

    let resolveDiscard!: () => void;
    let rejectDiscard!: (reason: unknown) => void;
    const task = new Promise<void>((resolve, reject) => {
      resolveDiscard = resolve;
      rejectDiscard = reject;
    });
    asset.discardPromise = task;
    let cleanupFailure: unknown = null;
    try {
      revokeCodecTimelineHostArtifactForLease({
        registry: this.#registry,
        roomToken: this.#roomToken,
        lease: asset.lease,
      });
    } catch (error) {
      cleanupFailure = mergeCleanupFailure(cleanupFailure, error);
    }

    try {
      const discard = this.#registry.discardProvisionalAsset(
        this.#roomToken,
        asset.lease as FilePlaybackProvisionalAssetLease,
      );
      void discard.then(
        (discarded) => {
          if (!discarded) {
            cleanupFailure = mergeCleanupFailure(
              cleanupFailure,
              new Error('Host provisional asset lost exact discard authority'),
            );
          } else {
            asset.ownership = 'discarded';
          }
          if (cleanupFailure !== null) {
            rejectDiscard(cleanupFailure);
          } else {
            resolveDiscard();
          }
        },
        (error: unknown) => {
          rejectDiscard(mergeCleanupFailure(cleanupFailure, error));
        },
      );
    } catch (error) {
      rejectDiscard(mergeCleanupFailure(cleanupFailure, error));
      return task;
    }
    return task;
  }

  #promoteProvisionalAsset(asset: AdmittedLocalFile): void {
    if (asset.ownership === 'live') return;
    if (
      asset.ownership !== 'provisional' ||
      asset.discardPromise !== null ||
      this.#assets.get(asset.queueItemId) !== asset
    ) {
      throw new Error('Host provisional asset promotion authority is stale');
    }
    const promoted = this.#registry.promoteProvisionalAsset(
      this.#roomToken,
      asset.lease as FilePlaybackProvisionalAssetLease,
    );
    if (promoted !== asset.lease) {
      throw new Error('Host provisional asset promotion changed exact lease identity');
    }
    asset.ownership = 'live';
  }

  #newRunId(
    action: 'first' | 'track' | 'replay',
    queueItemId: QueueItemId,
    positionSeconds: number,
    expectedPrevious: PlaybackTimelineSnapshot,
  ): string {
    const pending = this.#pendingNewRun;
    if (
      pending &&
      pending.action === action &&
      pending.expectedPrevious === expectedPrevious &&
      pending.expectedRevision === expectedPrevious.revision &&
      pending.queueItemId === queueItemId &&
      pending.positionSeconds === positionSeconds
    ) {
      return pending.runId;
    }
    const runId = Reflect.apply(this.#runtime.createRunId, undefined, []);
    const state = createPlaybackStateIdentity({
      queueItemId,
      runId,
      revision: expectedPrevious.revision + 1,
    });
    this.#pendingNewRun = freezeCanonical({
      action,
      expectedPrevious,
      expectedRevision: expectedPrevious.revision,
      queueItemId,
      positionSeconds,
      runId: state.runId,
    });
    return state.runId;
  }

  #requireCurrentAsset(timeline: PlaybackTimelineSnapshot): AdmittedLocalFile {
    const queueItemId = timeline.run?.queueItemId;
    const asset = queueItemId ? this.#assets.get(queueItemId) : null;
    if (!asset) throw new Error('Host current renderer asset is unavailable');
    return asset;
  }

  #assertExpectedRenderer(
    timeline: PlaybackTimelineSnapshot,
    action: CandidateAction,
  ): FilePlaybackCutoverCandidatePort | null {
    const managerPort = currentPort(this.#manager);
    if (timeline.phase === 'stopped') {
      if (timeline.run !== null || managerPort !== null) {
        throw new Error(`Host ${action} stopped renderer authority is stale`);
      }
      return null;
    }
    const expectedPort = this.#committedPort;
    const run = timeline.run;
    if (!expectedPort || !run || managerPort !== expectedPort) {
      throw new Error(`Host ${action} current renderer authority is stale`);
    }
    const snapshot = Reflect.apply(trustedManagerCurrentSnapshot, this.#manager, [expectedPort]);
    if (
      !snapshot ||
      snapshot.queueItemId !== run.queueItemId ||
      snapshot.revision !== timeline.revision ||
      snapshot.run?.queueItemId !== run.queueItemId ||
      snapshot.run.runId !== run.runId ||
      snapshot.run.revision !== timeline.revision
    ) {
      throw new Error(`Host ${action} renderer identity does not match timeline truth`);
    }
    const phaseMatches =
      action === 'resume'
        ? timeline.phase === 'paused' && snapshot.phase === 'paused'
        : action === 'playing-seek'
          ? timeline.phase === 'playing' && snapshot.phase === 'playing'
          : timeline.phase === 'paused'
            ? snapshot.phase === 'paused'
            : timeline.phase === 'playing' &&
              (snapshot.phase === 'playing' || snapshot.phase === 'ended');
    if (!phaseMatches) throw new Error(`Host ${action} renderer phase is stale`);
    return expectedPort;
  }

  #beginCandidateOperation(
    input: BeginCandidateOperationInput,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    return this.#beginCandidatePreparation(input).then((prepared) =>
      this.startPreparedLocalTrack({ prepared, remoteParticipants: [] }),
    );
  }

  #beginCandidatePreparation(
    input: BeginCandidateOperationInput,
  ): Promise<Readonly<HostPreparedLocalTrack>> {
    const previousOperation = this.#activeOperation;
    if (previousOperation?.kind === 'transition') {
      throw new Error('Host local file candidate conflicts with a renderer transition');
    }
    if (previousOperation?.commitDominant) {
      throw new Error('Host renderer physical commit cannot be superseded');
    }
    throwIfAborted(input.signal);
    this.#retireCandidateSourceAuthority();
    this.#operationEpoch += 1;
    const operationController = new AbortController();
    const externalSignal = input.signal;
    const forwardExternalAbort = () => {
      operationController.abort(externalSignal.reason);
      const sourceAuthority = this.#preparedSourceAuthority;
      if (sourceAuthority?.operation === operation) {
        this.#retirePreparedSourceAuthority(sourceAuthority);
      }
    };
    externalSignal.addEventListener('abort', forwardExternalAbort, { once: true });
    const operation: ActiveStartOperation = {
      kind: 'candidate',
      epoch: this.#operationEpoch,
      action: input.action,
      previousTimeline: input.previousTimeline,
      expectedCurrentPort: input.expectedCurrentPort,
      controller: operationController,
      externalSignal,
      removeExternalAbort: () => externalSignal.removeEventListener('abort', forwardExternalAbort),
      commitDominant: false,
      published: false,
      task: null,
    };
    this.#activeOperation = operation;
    if (operation.action !== 'playing-seek') this.#peerPublicationAuthority = null;
    this.#preparedTrackAuthority = null;
    this.#cancelAllRemoteRecoveries('remote-recovery-renderer-candidate');
    previousOperation?.controller.abort(new Error('Host local file candidate was superseded'));
    const warm = this.#warmTrackOperation;
    if (
      (operation.action === 'first' || operation.action === 'track') &&
      warm &&
      !warm.claimed &&
      warm.queueItemId !== input.asset.queueItemId
    ) {
      warm.controller.abort(new Error('Host local file warm source was replaced by a candidate'));
    }
    if (externalSignal.aborted) forwardExternalAbort();
    const task = this.#executeCandidatePreparation(operation, input);
    operation.task = task;
    return task;
  }

  async #executeCandidatePreparation(
    operation: ActiveStartOperation,
    input: BeginCandidateOperationInput,
  ): Promise<Readonly<HostPreparedLocalTrack>> {
    let staged: Readonly<StagedLocalFilePlaybackParticipant> | null = null;
    let claimedWarm: Readonly<ClaimedWarmTrackSource> | null = null;
    let claimedSourceLease: HostLocalTrackSourceLease | null = null;
    try {
      this.#assertOperationFence(operation);
      if (currentPort(this.#manager) !== operation.expectedCurrentPort) {
        throw new Error('Host local file current renderer changed before candidate staging');
      }
      const playbackState = createPlaybackStateIdentity({
        queueItemId: input.asset.queueItemId,
        runId: input.runId,
        revision: operation.previousTimeline.revision + 1,
      });
      const warmClaim =
        operation.action === 'first' || operation.action === 'track'
          ? this.#claimMatchingWarmSource(input.asset, operation)
          : null;
      claimedWarm = warmClaim instanceof Promise ? await warmClaim : warmClaim;
      if (!claimedWarm) {
        const refresh = this.#ensureColdCandidateAsset(operation, input);
        if (refresh) await refresh;
      }
      const participantOptions = {
        manager: this.#manager,
        destination: input.destination,
        signal: operation.controller.signal,
        isCurrent: () => this.#candidateAuthorityAllows(operation, playbackState),
        playbackState,
        participantId: this.#hostParticipantId,
        rttP95Ms: 0,
        armP95Ms: 0,
        ...(this.#runtime.localStartRuntime
          ? { runtimeForTests: this.#runtime.localStartRuntime }
          : {}),
      };
      staged = claimedWarm
        ? await stageWarmLocalFilePlaybackParticipant({
            warmSource: claimedWarm.authority,
            ...participantOptions,
          })
        : await stageLocalFilePlaybackParticipant({
            registry: this.#registry,
            roomToken: this.#roomToken,
            assetLease: input.asset.lease,
            expectedBinding: input.asset.binding,
            audioContext: input.audioContext,
            clockBindings: input.clockBindings,
            decodeOrdinaryAudio: input.decodeOrdinaryAudio,
            ...(this.#boundedRoutePolicy ? { boundedRoutePolicy: this.#boundedRoutePolicy } : {}),
            ...(this.#installCodecTimelineHostArtifact
              ? { installCodecTimelineHostArtifact: true as const }
              : {}),
            ...participantOptions,
          });
      if (claimedWarm) {
        claimedSourceLease = claimedWarm.operation.sourceLease;
        const leaseAuthority = claimedSourceLease
          ? this.#warmSourceLeaseAuthorities.get(claimedSourceLease)
          : null;
        if (
          !claimedSourceLease ||
          !leaseAuthority ||
          leaseAuthority.operation !== claimedWarm.operation ||
          leaseAuthority.lease !== claimedSourceLease ||
          leaseAuthority.preparedAuthority !== null
        ) {
          throw new Error('Host claimed warm source lease authority changed during handoff');
        }
        this.#settleClaimedWarmTrack(claimedWarm);
        claimedWarm = null;
      }
      this.#ownedPorts.add(staged.port);
      this.#assertOperationFence(operation);
      if (currentPort(this.#manager) !== operation.expectedCurrentPort) {
        throw new Error('Host local file current renderer changed during candidate staging');
      }
      this.#assertOperationFence(operation);
      const asset = staged.asset;
      const prepared = freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: this.#roomGeneration,
        backend: staged.backend,
        state: staged.playbackState,
        positionSeconds: input.positionSeconds,
        playbackRate: input.playbackRate,
        asset: this.#peerAssetPublication(asset, input.asset.lease, staged.backend),
        sourceLease: claimedSourceLease,
      });
      const authority: PreparedTrackAuthority = {
        prepared,
        operation,
        input,
        playbackState: staged.playbackState,
        staged,
        sourceLease: claimedSourceLease,
        sourcePhase:
          operation.action === 'first' ||
          operation.action === 'track' ||
          operation.action === 'replay'
            ? 'prepared'
            : 'retired',
        started: false,
      };
      if (claimedSourceLease) {
        const leaseAuthority = this.#warmSourceLeaseAuthorities.get(claimedSourceLease);
        if (
          !leaseAuthority ||
          leaseAuthority.operation.claimedBy !== operation ||
          leaseAuthority.preparedAuthority !== null
        ) {
          throw new Error('Host claimed warm source lease was stale before candidate publication');
        }
        leaseAuthority.preparedAuthority = authority;
      }
      this.#preparedTrackAuthority = authority;
      if (authority.sourcePhase === 'prepared') this.#preparedSourceAuthority = authority;
      this.#assertPreparedTrackAuthority(authority);
      return prepared;
    } catch (error) {
      const joinsProvisionalCleanup = input.asset.ownership !== 'live';
      let participantRetirement: Promise<void> | null = null;
      if (staged) {
        participantRetirement = retireLocalFilePlaybackParticipant(
          staged,
          operation.controller.signal.aborted ? 'host-candidate-aborted' : 'host-candidate-failed',
        );
      } else if (claimedWarm) {
        this.#retireWarmSourceLeaseAuthority(claimedWarm.operation);
        participantRetirement = retireFilePlaybackAssetSourceWarm(claimedWarm.authority).then(
          () => undefined,
        );
      }
      const sourceAuthority = this.#preparedSourceAuthority;
      if (sourceAuthority?.operation === operation) {
        this.#retirePreparedSourceAuthority(sourceAuthority);
      } else if (claimedSourceLease) {
        const leaseAuthority = this.#warmSourceLeaseAuthorities.get(claimedSourceLease);
        if (leaseAuthority?.preparedAuthority === null) {
          leaseAuthority.retired = true;
          leaseAuthority.preparedAuthority = null;
          this.#releaseRetiredWarmOperationReferences(leaseAuthority.operation);
        }
      }
      const discard = this.#discardProvisionalAsset(input.asset);
      let cleanupFailure: unknown = null;
      try {
        if (joinsProvisionalCleanup) {
          await this.#joinCandidateProvisionalCleanup(
            error,
            [participantRetirement, discard],
            'Host failed candidate cleanup did not complete safely',
          );
        } else if (participantRetirement) {
          observe(participantRetirement);
        }
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
      operation.removeExternalAbort();
      if (this.#activeOperation === operation) this.#activeOperation = null;
      if (cleanupFailure) throw cleanupFailure;
      throw error;
    } finally {
      if (claimedWarm) this.#settleClaimedWarmTrack(claimedWarm);
    }
  }

  async #executePreparedCandidateStart(
    authority: PreparedTrackAuthority,
    remoteParticipants: readonly Readonly<HostPreparedRemoteParticipant>[],
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    const { operation, input, playbackState, staged } = authority;
    const deferredRemotes = remoteParticipants.map((remote) => ({
      remote,
      deferred: deferredRemoteParticipant(remote.participant),
    }));
    let attempt: HostRendezvousAttempt | null = null;
    try {
      this.#assertPreparedTrackStartAuthority(authority);
      attempt = Reflect.apply(trustedRendezvousCoordinatorStart, this.#rendezvousCoordinator, [
        {
          run: playbackState,
          positionSeconds: input.positionSeconds,
          playbackRate: input.playbackRate,
          participants: [
            staged.participant,
            ...deferredRemotes.map(({ deferred }) => deferred.participant),
          ],
        },
      ]);
      this.#assertPreparedTrackStartAuthority(authority);
      const localCompletion = completeLocalFilePlaybackParticipant({ staged, attempt });
      observe(localCompletion);
      const localAcceptedTask = attempt.whenParticipantAccepted(this.#hostParticipantId);
      observe(localAcceptedTask);

      for (const { remote, deferred } of deferredRemotes) {
        try {
          this.#assertPreparedTrackStartAuthority(authority);
          const evidence = Reflect.apply(remote.bindAttempt, undefined, [attempt]) as unknown;
          if (!(evidence instanceof Promise)) {
            throw new TypeError(
              'Host prepared remote attempt binding must return a native Promise',
            );
          }
          observe(evidence);
          this.#assertPreparedTrackStartAuthority(authority);
          const committed = Promise.all([
            attempt.whenParticipantAccepted(remote.participant.participantId),
            evidence,
          ]).then(() => {
            if (!attempt?.commitParticipant(remote.participant.participantId)) {
              throw new Error('Host prepared remote renderer evidence was not committed');
            }
          });
          observe(committed);
          deferred.release();
        } catch (error) {
          deferred.reject(asError(error, 'Host prepared remote participant binding failed'));
        }
      }

      const accepted = await localAcceptedTask;
      this.#assertPreparedTrackStartAuthority(authority);
      const acceptedSnapshot = attempt.getSnapshot();
      if (
        accepted.acceptedParticipantId !== this.#hostParticipantId ||
        (acceptedSnapshot.status !== 'open' && acceptedSnapshot.status !== 'complete') ||
        acceptedSnapshot.reasonCode !== null ||
        acceptedSnapshot.rendezvousId !== accepted.attempt.rendezvousId ||
        acceptedSnapshot.run.queueItemId !== playbackState.queueItemId ||
        acceptedSnapshot.run.runId !== playbackState.runId ||
        acceptedSnapshot.run.revision !== playbackState.revision ||
        !acceptedSnapshot.participants.some(
          (participant) =>
            participant.participantId === this.#hostParticipantId &&
            participant.finalizeStatus === 'accepted',
        ) ||
        accepted.attempt.queueItemId !== playbackState.queueItemId ||
        accepted.attempt.runId !== playbackState.runId ||
        accepted.attempt.revision !== playbackState.revision ||
        accepted.attempt.rendezvousId !== attempt.rendezvousId ||
        accepted.schedule.positionSeconds !== input.positionSeconds ||
        accepted.schedule.playbackRate !== input.playbackRate ||
        accepted.schedule.createdAtRoomTimeMs !== acceptedSnapshot.createdAtRoomTimeMs ||
        accepted.schedule.leadTimeMs !== acceptedSnapshot.leadTimeMs ||
        accepted.schedule.finalizeByRoomTimeMs !== acceptedSnapshot.finalizeByRoomTimeMs ||
        accepted.schedule.startAtRoomTimeMs !== acceptedSnapshot.startAtRoomTimeMs ||
        accepted.schedule.startAtRoomTimeMs !== attempt.startAtRoomTimeMs ||
        accepted.schedule.finalizeByRoomTimeMs !== attempt.finalizeByRoomTimeMs
      ) {
        throw new Error('Host rendezvous local acceptance changed the requested schedule');
      }
      this.#assertPreparedTrackStartAuthority(authority);
      operation.commitDominant = true;
      this.#assertTimelineCommitFence(operation);

      this.#runtime.beforeControllerCommit?.();
      this.#assertTimelineCommitFence(operation);
      const committed = Reflect.apply(trustedControllerCommit, this.#controller, [
        {
          roomGeneration: this.#roomGeneration,
          expectedPreviousRevision: operation.previousTimeline.revision,
          attempt: accepted.attempt,
          schedule: accepted.schedule,
        },
      ]) as Readonly<FilePlaybackHostAcceptedRendezvousCommit>;
      if (
        committed.previous !== operation.previousTimeline ||
        committed.timeline.revision !== accepted.attempt.revision ||
        committed.timeline.anchorMonotonicMs !== accepted.schedule.startAtRoomTimeMs ||
        committed.timeline.positionSeconds !== accepted.schedule.positionSeconds ||
        committed.timeline.rate !== accepted.schedule.playbackRate ||
        committed.timeline.run?.queueItemId !== input.asset.queueItemId ||
        committed.timeline.run.runId !== input.runId
      ) {
        throw new Error('Host local file timeline commit did not match rendezvous acceptance');
      }
      this.#promoteProvisionalAsset(input.asset);
      operation.published = true;
      if (this.#preparedSourceAuthority === authority) this.#retireCurrentSourceAuthority();
      if (
        this.#pendingNewRun?.queueItemId === input.asset.queueItemId &&
        this.#pendingNewRun.runId === input.runId &&
        this.#pendingNewRun.positionSeconds === input.positionSeconds
      ) {
        this.#pendingNewRun = null;
      }

      const started = await localCompletion;
      if (
        started.port !== staged.port ||
        !sameAttempt(started.attempt, accepted.attempt) ||
        !sameLocalPlaybackSchedule(started.schedule, accepted.schedule)
      ) {
        throw new Error('Host local renderer result did not match the accepted rendezvous');
      }
      this.#committedPort = started.port;
      if (this.#preparedSourceAuthority === authority) {
        authority.sourcePhase = 'current';
        this.#preparedSourceAuthority = null;
        this.#currentSourceAuthority = authority;
        this.#assertPreparedSourceAuthority(authority);
      }

      return freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: this.#roomGeneration,
        backend: started.backend,
        asset: started.asset,
        attempt: started.attempt,
        schedule: started.schedule,
        startEvidence: started.startEvidence,
        timeline: committed.timeline,
      });
    } catch (error) {
      for (const { deferred } of deferredRemotes) {
        deferred.reject(asError(error, 'Host prepared cohort failed'));
      }
      const joinsProvisionalCleanup = !operation.published && input.asset.ownership !== 'live';
      let participantRetirement: Promise<void> | null = null;
      if (!operation.published) {
        try {
          attempt?.cancel(
            operation.controller.signal.aborted
              ? 'host-candidate-aborted'
              : 'host-candidate-failed',
          );
        } catch {
          // Exact local-port retirement remains the cleanup fence.
        }
        participantRetirement = retireLocalFilePlaybackParticipant(
          staged,
          operation.controller.signal.aborted ? 'host-candidate-aborted' : 'host-candidate-failed',
        );
      }
      if (operation.commitDominant && !operation.published) {
        this.#quarantineAfterPhysicalFailure(error);
      }
      if (
        this.#preparedSourceAuthority === authority ||
        this.#currentSourceAuthority === authority
      ) {
        this.#retirePreparedSourceAuthority(authority);
      }
      if (joinsProvisionalCleanup && !operation.commitDominant) {
        await this.#joinCandidateProvisionalCleanup(
          error,
          [participantRetirement, this.#discardProvisionalAsset(input.asset)],
          'Host failed prepared candidate cleanup did not complete safely',
        );
      } else if (participantRetirement) {
        observe(participantRetirement);
      }
      throw error;
    } finally {
      operation.removeExternalAbort();
      if (this.#preparedTrackAuthority === authority) this.#preparedTrackAuthority = null;
      if (this.#activeOperation === operation) this.#activeOperation = null;
    }
  }

  #assertTimelineAuthority(
    expectedTimeline: PlaybackTimelineSnapshot,
    allowClosingCommit: boolean,
  ): void {
    this.#assertRoomClockAuthority();
    const warmCleanupError = this.#warmCleanupAuthorityError();
    const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (
      (!allowClosingCommit && (this.#closed || this.#coordinatorClosed)) ||
      this.#fatalError ||
      warmCleanupError ||
      snapshot.roomGeneration !== this.#roomGeneration ||
      snapshot.roomRole !== 'host' ||
      snapshot.timeline !== timeline ||
      timeline !== expectedTimeline
    ) {
      throw (
        this.#fatalError ?? warmCleanupError ?? new Error('Host local-file room authority is stale')
      );
    }
    this.#assertRoomClockAuthority();
  }

  #peerAssetPublication(
    asset: Readonly<FilePlaybackAssetSnapshot>,
    lease: FilePlaybackAssetLease,
    backend: FilePlaybackBackend,
  ): Readonly<HostPeerPlaybackAssetPublication> {
    const diagnostics = this.#eligiblePeerRangeManifestForLease(asset, lease, backend);
    const peerRangeManifest = diagnostics
      ? freezeCanonical({
          codec: diagnostics.codec,
          manifestByteLength: diagnostics.manifestByteLength,
          manifestSha256B64: diagnostics.manifestSha256B64,
        })
      : null;
    return freezeCanonical({
      kind: asset.kind,
      binding: freezeCanonical({
        queueItemId: asset.queueItemId,
        sourceIdentity: asset.sourceIdentity,
        transferSessionId: asset.transferSessionId,
      }),
      metadata: freezeCanonical({ name: asset.name, mime: asset.mime }),
      encodedSize: asset.size,
      peerRangeManifest,
    });
  }

  #eligiblePeerRangeManifestForLease(
    asset: Readonly<FilePlaybackAssetSnapshot>,
    lease: FilePlaybackAssetLease,
    backend: FilePlaybackBackend,
  ): Readonly<HostPeerRangeManifestPublication> | null {
    const policy = this.#boundedRoutePolicy;
    if (backend !== 'bounded-stream' || !policy) return null;
    const diagnostics = describeCodecTimelineHostArtifactForLease({
      registry: this.#registry,
      roomToken: this.#roomToken,
      lease,
    });
    if (!diagnostics) return null;
    if (!isFilePlaybackPeerRangeManifestCodecEnabled(policy, diagnostics.codec)) return null;
    if (derivePeerRangeManifestBundleSize(asset.size, diagnostics.manifestByteLength) === null) {
      throw new Error('Host peer-range manifest bundle geometry is invalid');
    }
    return diagnostics;
  }

  #requirePeerRangeManifestSelector(
    value: unknown,
    issued: Readonly<HostPeerRangeManifestPublication> | null,
    label: string,
  ): Readonly<HostPeerRangeManifestPublication> | null {
    if (value === null) return null;
    if (issued === null || value !== issued) {
      throw new Error(`${label} manifest selector is not the exact issued authority`);
    }
    return issued;
  }

  #copyPeerRangeManifestForLease(
    asset: Readonly<FilePlaybackAssetSnapshot>,
    lease: FilePlaybackAssetLease,
    backend: FilePlaybackBackend,
    expected: Readonly<HostPeerRangeManifestPublication>,
  ): Readonly<{ bytes: Uint8Array; bundleSize: number }> {
    const diagnostics = this.#eligiblePeerRangeManifestForLease(asset, lease, backend);
    if (!diagnostics || !samePeerRangeManifestPublication(expected, diagnostics)) {
      throw new Error('Host peer-range manifest lease diagnostics changed');
    }
    const bundleSize = derivePeerRangeManifestBundleSize(asset.size, expected.manifestByteLength);
    if (bundleSize === null) {
      throw new Error('Host peer-range manifest bundle geometry changed');
    }
    const bytes = copyCodecTimelineHostArtifactManifestForLease({
      registry: this.#registry,
      roomToken: this.#roomToken,
      lease,
    });
    if (!bytes || bytes.byteLength !== expected.manifestByteLength) {
      if (bytes) scrubManifestBytes(bytes);
      throw new Error('Host peer-range manifest body changed during resolution');
    }
    return { bytes, bundleSize };
  }

  #assertManifestPrefixedSource(
    source: ManifestPrefixedEncodedAudioSource,
    asset: Readonly<FilePlaybackAssetSnapshot>,
    manifest: Readonly<HostPeerRangeManifestPublication>,
    bundleSize: number,
  ): void {
    if (
      source.kind !== asset.kind ||
      source.identity !== asset.sourceIdentity ||
      source.metadata.name !== asset.name ||
      source.metadata.mime !== asset.mime ||
      source.mediaSize !== asset.size ||
      source.manifestSize !== manifest.manifestByteLength ||
      source.size !== bundleSize
    ) {
      throw new Error('Host manifest-prefixed source changed its exact binding');
    }
  }

  async #resolvePeerRangeLeaseSource(
    lease: FilePlaybackAssetLease,
    asset: Readonly<FilePlaybackAssetSnapshot>,
    backend: FilePlaybackBackend,
    peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null,
    signal: AbortSignal,
    assertAuthority: () => void,
    label: string,
  ): Promise<HostPeerRangeSource> {
    let manifestBytes: Uint8Array | null = null;
    let bundleSize: number | null = null;
    const scrubManifestCopy = () => {
      const bytes = manifestBytes;
      if (!bytes) return;
      manifestBytes = null;
      scrubManifestBytes(bytes);
    };

    try {
      if (peerRangeManifest) {
        const copied = this.#copyPeerRangeManifestForLease(
          asset,
          lease,
          backend,
          peerRangeManifest,
        );
        manifestBytes = copied.bytes;
        bundleSize = copied.bundleSize;
      }
      throwIfAborted(signal);
      assertAuthority();

      const blobResolution = this.#registry.resolveBlobAsset(this.#roomToken, lease);
      if (blobResolution) {
        if (
          blobResolution.binding.queueItemId !== asset.queueItemId ||
          blobResolution.binding.sourceIdentity !== asset.sourceIdentity ||
          blobResolution.binding.transferSessionId !== asset.transferSessionId ||
          blobResolution.metadata.name !== asset.name ||
          blobResolution.metadata.mime !== asset.mime ||
          blobResolution.blob.size !== asset.size
        ) {
          throw new Error(`${label} Blob resolution changed its exact binding`);
        }
        if (!peerRangeManifest) {
          await Promise.resolve();
          throwIfAborted(signal);
          assertAuthority();
          return blobResolution.blob;
        }

        let prefixed: ManifestPrefixedEncodedAudioSource | null = null;
        try {
          if (!manifestBytes || bundleSize === null) {
            throw new Error(`${label} manifest body is unavailable`);
          }
          prefixed = new ManifestPrefixedEncodedAudioSource({
            manifestBytes,
            media: blobResolution.blob,
            identity: asset.sourceIdentity,
            metadata: { name: asset.name, mime: asset.mime },
          });
          scrubManifestCopy();
          this.#assertManifestPrefixedSource(prefixed, asset, peerRangeManifest, bundleSize);
          await Promise.resolve();
          throwIfAborted(signal);
          assertAuthority();
          const resolved = prefixed;
          prefixed = null;
          return resolved;
        } catch (error) {
          if (prefixed) await closeEncodedSourceWithoutMasking(prefixed);
          throw error;
        }
      }

      let source: EncodedAudioSource | null = null;
      let prefixed: ManifestPrefixedEncodedAudioSource | null = null;
      try {
        source = this.#registry.acquireSource(this.#roomToken, lease);
        if (
          source.kind !== asset.kind ||
          source.identity !== asset.sourceIdentity ||
          source.size !== asset.size ||
          source.metadata.name !== asset.name ||
          source.metadata.mime !== asset.mime
        ) {
          throw new Error(`${label} encoded source changed its exact binding`);
        }
        if (!peerRangeManifest) {
          await Promise.resolve();
          throwIfAborted(signal);
          assertAuthority();
          const resolved = source;
          source = null;
          return resolved;
        }
        if (!manifestBytes || bundleSize === null) {
          throw new Error(`${label} manifest body is unavailable`);
        }
        prefixed = new ManifestPrefixedEncodedAudioSource({
          manifestBytes,
          media: source,
        });
        source = null;
        scrubManifestCopy();
        this.#assertManifestPrefixedSource(prefixed, asset, peerRangeManifest, bundleSize);
        await Promise.resolve();
        throwIfAborted(signal);
        assertAuthority();
        const resolved = prefixed;
        prefixed = null;
        return resolved;
      } catch (error) {
        if (prefixed) await closeEncodedSourceWithoutMasking(prefixed);
        if (source) await closeEncodedSourceWithoutMasking(source);
        throw error;
      }
    } finally {
      scrubManifestCopy();
    }
  }

  #samePeerAsset(
    left: Readonly<FilePlaybackAssetSnapshot>,
    right: Readonly<FilePlaybackAssetSnapshot>,
  ): boolean {
    return (
      left.queueItemId === right.queueItemId &&
      left.sourceIdentity === right.sourceIdentity &&
      left.transferSessionId === right.transferSessionId &&
      left.kind === right.kind &&
      left.size === right.size &&
      left.name === right.name &&
      left.mime === right.mime
    );
  }

  #retireWarmSourceLeaseAuthority(operation: WarmTrackOperation): void {
    const sourceLease = operation.sourceLease;
    if (sourceLease) {
      const authority = this.#warmSourceLeaseAuthorities.get(sourceLease);
      if (authority?.operation === operation && authority.lease === sourceLease) {
        authority.retired = true;
        authority.preparedAuthority = null;
      }
    }
    this.#releaseRetiredWarmOperationReferences(operation);
  }

  #releaseRetiredWarmOperationReferences(operation: WarmTrackOperation): void {
    operation.input = null;
    operation.asset = null;
    operation.claimedBy = null;
  }

  #retirePreparedSourceAuthority(authority: PreparedTrackAuthority): void {
    authority.sourcePhase = 'retired';
    if (this.#preparedSourceAuthority === authority) this.#preparedSourceAuthority = null;
    if (this.#currentSourceAuthority === authority) this.#currentSourceAuthority = null;
    if (!authority.operation.commitDominant) {
      const discard = this.#discardProvisionalAsset(authority.input.asset);
      if (discard) this.#observeDetachedWarmRetirement(discard);
    }
    const sourceLease = authority.sourceLease;
    if (!sourceLease) return;
    const leaseAuthority = this.#warmSourceLeaseAuthorities.get(sourceLease);
    if (leaseAuthority?.lease === sourceLease && leaseAuthority.preparedAuthority === authority) {
      leaseAuthority.retired = true;
      leaseAuthority.preparedAuthority = null;
      this.#releaseRetiredWarmOperationReferences(leaseAuthority.operation);
    }
  }

  #retireCandidateSourceAuthority(): void {
    const authority = this.#preparedSourceAuthority;
    if (authority) this.#retirePreparedSourceAuthority(authority);
  }

  #retireCurrentSourceAuthority(): void {
    const authority = this.#currentSourceAuthority;
    if (authority) this.#retirePreparedSourceAuthority(authority);
  }

  #retireAllSourceAuthorities(): void {
    this.#retireCandidateSourceAuthority();
    this.#retireCurrentSourceAuthority();
  }

  #requireWarmSourceLeaseAuthority(value: unknown): WarmSourceLeaseAuthority {
    const authority =
      value !== null && typeof value === 'object'
        ? this.#warmSourceLeaseAuthorities.get(value as HostLocalTrackSourceLease)
        : undefined;
    if (!authority || authority.lease !== value) {
      throw new Error('Host warm source lease is not the exact issued authority');
    }
    return authority;
  }

  #assertWarmSourceLeaseAuthority(authority: WarmSourceLeaseAuthority): void {
    const { lease, operation, asset } = authority;
    const admitted = operation.asset;
    if (authority.retired) {
      throw new Error('Host warm source lease authority was retired');
    }
    if (
      !admitted ||
      operation.sourceLease !== lease ||
      (admitted.ownership !== 'provisional' && admitted.ownership !== 'live') ||
      this.#assets.get(admitted.queueItemId) !== admitted ||
      admitted.binding.queueItemId !== asset.queueItemId ||
      admitted.binding.sourceIdentity !== asset.sourceIdentity ||
      admitted.binding.transferSessionId !== asset.transferSessionId ||
      admitted.blob.size !== asset.size ||
      admitted.name !== asset.name ||
      admitted.mime !== asset.mime
    ) {
      throw new Error('Host warm source lease binding changed');
    }
    if (authority.preparedAuthority) {
      if (
        authority.preparedAuthority.sourceLease !== lease ||
        authority.preparedAuthority.prepared.sourceLease !== lease ||
        authority.preparedAuthority.prepared.backend !== authority.backend ||
        !samePeerRangeManifestPublication(
          authority.preparedAuthority.prepared.asset.peerRangeManifest,
          authority.peerRangeManifest,
        )
      ) {
        throw new Error('Host warm source lease handoff changed');
      }
      this.#assertPreparedSourceAuthority(authority.preparedAuthority);
    } else if (operation.claimed) {
      if (!operation.claimedBy) {
        throw new Error('Host warm source lease lost its handoff authority');
      }
      this.#assertOperationFence(operation.claimedBy);
    } else {
      this.#assertWarmTrackAuthority(operation);
      if (
        operation.authority?.backend !== 'bounded-stream' ||
        operation.authority.asset !== asset
      ) {
        throw new Error('Host warm source lease is not backed by the exact bounded source');
      }
    }
    const currentAsset = this.#registry.snapshotForLease(this.#roomToken, admitted.lease);
    if (!currentAsset || !this.#samePeerAsset(currentAsset, asset)) {
      throw new Error('Host warm source lease asset authority changed');
    }
  }

  #requirePreparedSourceAuthority(value: unknown): PreparedTrackAuthority {
    const candidate = this.#preparedSourceAuthority;
    const current = this.#currentSourceAuthority;
    const authority =
      value === candidate?.prepared ? candidate : value === current?.prepared ? current : null;
    if (!authority) {
      throw new Error('Host prepared peer source is not the exact current authority');
    }
    this.#assertPreparedSourceAuthority(authority);
    return authority;
  }

  #assertPreparedSourceAuthority(authority: PreparedTrackAuthority): void {
    const { prepared, operation, input, playbackState, staged, sourceLease, sourcePhase } =
      authority;
    const sourceLeaseAuthority = sourceLease
      ? this.#warmSourceLeaseAuthorities.get(sourceLease)
      : null;
    const ownsExactPhase =
      sourcePhase === 'current'
        ? this.#currentSourceAuthority === authority
        : (sourcePhase === 'prepared' || sourcePhase === 'starting') &&
          this.#preparedSourceAuthority === authority;
    if (
      !ownsExactPhase ||
      sourcePhase === 'retired' ||
      this.#closed ||
      this.#coordinatorClosed ||
      this.#fatalError ||
      (operation.action !== 'first' &&
        operation.action !== 'track' &&
        operation.action !== 'replay') ||
      prepared.roomGeneration !== this.#roomGeneration ||
      prepared.backend !== staged.backend ||
      prepared.state !== playbackState ||
      prepared.positionSeconds !== input.positionSeconds ||
      prepared.playbackRate !== input.playbackRate ||
      prepared.sourceLease !== sourceLease ||
      (sourceLease !== null &&
        (sourceLeaseAuthority?.preparedAuthority !== authority ||
          sourceLeaseAuthority.retired ||
          sourceLeaseAuthority.backend !== prepared.backend ||
          !samePeerRangeManifestPublication(
            sourceLeaseAuthority.peerRangeManifest,
            prepared.asset.peerRangeManifest,
          ))) ||
      staged.playbackState !== playbackState ||
      staged.asset.queueItemId !== playbackState.queueItemId ||
      prepared.asset.binding.queueItemId !== staged.asset.queueItemId ||
      prepared.asset.binding.sourceIdentity !== staged.asset.sourceIdentity ||
      prepared.asset.binding.transferSessionId !== staged.asset.transferSessionId ||
      prepared.asset.kind !== staged.asset.kind ||
      prepared.asset.encodedSize !== staged.asset.size ||
      prepared.asset.metadata.name !== staged.asset.name ||
      prepared.asset.metadata.mime !== staged.asset.mime ||
      (input.asset.ownership !== 'provisional' && input.asset.ownership !== 'live') ||
      this.#assets.get(staged.asset.queueItemId) !== input.asset
    ) {
      throw this.#fatalError ?? new Error('Host prepared peer source authority is stale');
    }
    const currentAsset = this.#registry.snapshotForLease(this.#roomToken, input.asset.lease);
    if (!currentAsset || !this.#samePeerAsset(currentAsset, staged.asset)) {
      throw new Error('Host prepared peer source asset authority changed');
    }
    if (sourcePhase === 'prepared') {
      this.#assertPreparedTrackAuthority(authority);
      return;
    }
    this.#assertRoomClockAuthority();
    const controller = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (
      controller.roomGeneration !== this.#roomGeneration ||
      controller.roomRole !== 'host' ||
      controller.timeline !== timeline
    ) {
      throw new Error('Host prepared peer source room authority changed');
    }
    if (sourcePhase === 'starting') {
      if (
        !authority.started ||
        this.#preparedTrackAuthority !== authority ||
        this.#activeOperation !== operation ||
        this.#operationEpoch !== operation.epoch ||
        (!operation.published && timeline !== operation.previousTimeline)
      ) {
        throw new Error('Host prepared peer source start authority is stale');
      }
      if (!operation.commitDominant) throwIfAborted(operation.controller.signal);
      if (
        operation.published &&
        (timeline.phase === 'stopped' ||
          timeline.revision !== playbackState.revision ||
          timeline.run?.queueItemId !== playbackState.queueItemId ||
          timeline.run.runId !== playbackState.runId)
      ) {
        throw new Error('Host prepared peer source published timeline changed');
      }
      return;
    }
    if (timeline.phase === 'stopped' || timeline.run?.queueItemId !== staged.asset.queueItemId) {
      throw new Error('Host prepared peer source is no longer the current track');
    }
  }

  #requirePreparedTrackAuthority(value: unknown): PreparedTrackAuthority {
    const authority = this.#preparedTrackAuthority;
    if (!authority || value !== authority.prepared) {
      throw new Error('Host prepared local track is not the exact current candidate');
    }
    this.#assertPreparedTrackAuthority(authority);
    return authority;
  }

  #assertPreparedTrackAuthority(authority: PreparedTrackAuthority): void {
    if (authority.started) {
      throw new Error('Host prepared local track has already started');
    }
    this.#assertPreparedTrackCommonAuthority(authority);
  }

  #assertPreparedTrackStartAuthority(authority: PreparedTrackAuthority): void {
    if (!authority.started) {
      throw new Error('Host prepared local track has not claimed start authority');
    }
    this.#assertPreparedTrackCommonAuthority(authority);
  }

  #assertPreparedTrackCommonAuthority(authority: PreparedTrackAuthority): void {
    const { prepared, operation, input, playbackState, staged, sourceLease } = authority;
    const sourceLeaseAuthority = sourceLease
      ? this.#warmSourceLeaseAuthorities.get(sourceLease)
      : null;
    if (
      this.#preparedTrackAuthority !== authority ||
      this.#activeOperation !== operation ||
      this.#operationEpoch !== operation.epoch ||
      operation.commitDominant ||
      operation.published ||
      prepared.roomGeneration !== this.#roomGeneration ||
      prepared.backend !== staged.backend ||
      prepared.state !== playbackState ||
      prepared.positionSeconds !== input.positionSeconds ||
      prepared.playbackRate !== input.playbackRate ||
      prepared.sourceLease !== sourceLease ||
      (sourceLease !== null &&
        (sourceLeaseAuthority?.preparedAuthority !== authority ||
          sourceLeaseAuthority.retired ||
          sourceLeaseAuthority.backend !== prepared.backend ||
          !samePeerRangeManifestPublication(
            sourceLeaseAuthority.peerRangeManifest,
            prepared.asset.peerRangeManifest,
          ))) ||
      staged.playbackState !== playbackState ||
      staged.asset.queueItemId !== playbackState.queueItemId ||
      prepared.asset.binding.queueItemId !== staged.asset.queueItemId ||
      prepared.asset.binding.sourceIdentity !== staged.asset.sourceIdentity ||
      prepared.asset.binding.transferSessionId !== staged.asset.transferSessionId ||
      prepared.asset.kind !== staged.asset.kind ||
      prepared.asset.encodedSize !== staged.asset.size ||
      prepared.asset.metadata.name !== staged.asset.name ||
      prepared.asset.metadata.mime !== staged.asset.mime ||
      currentPort(this.#manager) !== operation.expectedCurrentPort
    ) {
      throw new Error('Host prepared local track authority changed');
    }
    this.#assertOperationFence(operation);
    const currentAsset = this.#registry.snapshotForLease(this.#roomToken, input.asset.lease);
    if (!currentAsset || !this.#samePeerAsset(currentAsset, staged.asset)) {
      throw new Error('Host prepared local track asset authority changed');
    }
  }

  #requirePeerPublication(value: unknown): PeerPublicationAuthority {
    const authority = this.#peerPublicationAuthority;
    if (!authority || value !== authority.publication) {
      throw new Error('Host peer publication is not the exact current publication');
    }
    this.#assertPeerPublicationAuthority(authority);
    return authority;
  }

  #requireCurrentPeerPublication(value: unknown): PeerPublicationAuthority {
    const authority = this.#peerPublicationAuthority;
    if (!authority || value !== authority.publication) {
      throw new Error('Host peer publication is not the exact current publication');
    }
    this.#assertCurrentPeerPublicationAuthority(authority);
    return authority;
  }

  #assertPeerPublicationAuthority(authority: PeerPublicationAuthority): void {
    if (this.#activeOperation !== null) {
      throw new Error('Host peer publication authority is stale');
    }
    this.#assertPeerPublicationStateAuthority(authority);
  }

  #assertCurrentPeerPublicationAuthority(authority: PeerPublicationAuthority): void {
    if (!this.#allowsCurrentPeerPublicationForTimeline(authority.timeline)) {
      throw new Error('Host peer publication authority is stale');
    }
    this.#assertPeerPublicationStateAuthority(authority);
  }

  #assertPeerPublicationStateAuthority(authority: PeerPublicationAuthority): void {
    if (this.#peerPublicationAuthority !== authority || !this.#hasLiveProjectionAuthority()) {
      throw new Error('Host peer publication authority is stale');
    }
    const controller = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    const run = timeline.run;
    const currentAsset = this.#registry.snapshotForLease(this.#roomToken, authority.lease);
    const admitted = run ? this.#assets.get(run.queueItemId) : null;
    const port = this.#committedPort;
    const renderer = port
      ? Reflect.apply(trustedManagerCurrentSnapshot, this.#manager, [port])
      : null;
    if (
      controller.roomGeneration !== this.#roomGeneration ||
      controller.roomRole !== 'host' ||
      controller.timeline !== timeline ||
      timeline !== authority.timeline ||
      authority.publication.roomGeneration !== this.#roomGeneration ||
      authority.publication.backend !== renderer?.backend ||
      authority.publication.timeline !== timeline ||
      authority.publication.state !== authority.state ||
      timeline.phase === 'stopped' ||
      renderer?.phase !== timeline.phase ||
      !run ||
      run.queueItemId !== authority.state.queueItemId ||
      run.runId !== authority.state.runId ||
      timeline.revision !== authority.state.revision ||
      admitted?.lease !== authority.lease ||
      !currentAsset ||
      !this.#samePeerAsset(currentAsset, authority.asset)
    ) {
      throw new Error('Host peer publication authority changed');
    }
  }

  #allowsCurrentPeerPublicationForTimeline(timeline: PlaybackTimelineSnapshot): boolean {
    const operation = this.#activeOperation;
    if (operation === null) return true;
    return (
      operation.kind === 'candidate' &&
      operation.action === 'playing-seek' &&
      !operation.published &&
      this.#operationEpoch === operation.epoch &&
      operation.previousTimeline === timeline &&
      operation.expectedCurrentPort !== null &&
      operation.expectedCurrentPort === this.#committedPort
    );
  }

  async #executeRemoteRecovery(
    operation: ActiveRemoteRecovery,
    authority: PeerPublicationAuthority,
    bindAttempt: RecoverHostRemoteParticipantOptions['bindAttempt'],
  ): Promise<Readonly<HostRemoteRecoveryCommit>> {
    const deferred = deferredRemoteParticipant(operation.participant);
    let attempt: HostRendezvousAttempt | null = null;
    try {
      this.#assertRemoteRecoveryAuthority(operation, authority, null);
      const leadTimeMs = Math.max(
        calculateRendezvousLeadMs(0, 0),
        calculateRendezvousLeadMs(deferred.participant.rttP95Ms, deferred.participant.armP95Ms),
      );
      const nowRoomTimeMs = this.#clockBindings
        ? this.#clockBindings.nowRoomTimeMs()
        : Reflect.apply(trustedRoomClockNow, this.#roomClock, []);
      const projectedStartAtRoomTimeMs = nowRoomTimeMs + leadTimeMs;
      if (!Number.isFinite(projectedStartAtRoomTimeMs)) {
        throw new RangeError('Host remote recovery schedule overflowed');
      }
      const positionSeconds = derivePlaybackPosition(
        authority.timeline,
        projectedStartAtRoomTimeMs,
      );
      attempt = Reflect.apply(
        trustedRendezvousCoordinatorStartRecovery,
        this.#rendezvousCoordinator,
        [
          freezeCanonical({
            run: authority.state,
            positionSeconds,
            playbackRate: authority.timeline.rate,
            participants: Object.freeze([deferred.participant]) as readonly [
              HostRendezvousParticipant,
            ],
          }),
        ],
      );
      const firstAcceptedTask = attempt.whenFirstParticipantAccepted();
      observe(firstAcceptedTask);
      operation.attempt = attempt;
      this.#assertRemoteRecoveryAuthority(operation, authority, attempt);

      const evidenceTask = Reflect.apply(bindAttempt, undefined, [attempt]) as unknown;
      if (!(evidenceTask instanceof Promise)) {
        throw new TypeError('Host remote recovery attempt binding must return a native Promise');
      }
      observe(evidenceTask);
      this.#assertRemoteRecoveryAuthority(operation, authority, attempt);

      // The exact attempt is now connection-owned. Only now may ARM reach the
      // transport and race renderer evidence/receipts.
      deferred.release();
      const evidenceFailure = new Promise<never>((_resolve, reject) => {
        void evidenceTask.catch(reject);
      });
      const accepted = await waitWithSignal(
        Promise.race([firstAcceptedTask, evidenceFailure]),
        operation.controller.signal,
      );
      this.#assertRemoteRecoveryAuthority(operation, authority, attempt);
      const expectedAttempt = freezeCanonical({
        queueItemId: authority.state.queueItemId,
        runId: authority.state.runId,
        revision: authority.state.revision,
        rendezvousId: attempt.rendezvousId,
      });
      const attemptSnapshot = attempt.getSnapshot();
      if (
        accepted.acceptedParticipantId !== operation.participantId ||
        !sameAttempt(accepted.attempt, expectedAttempt) ||
        attemptSnapshot.rendezvousId !== attempt.rendezvousId ||
        attemptSnapshot.run.queueItemId !== authority.state.queueItemId ||
        attemptSnapshot.run.runId !== authority.state.runId ||
        attemptSnapshot.run.revision !== authority.state.revision ||
        !sameLocalPlaybackSchedule(accepted.schedule, attemptSnapshot)
      ) {
        throw new Error('Host remote recovery accepted a mismatched participant or schedule');
      }

      await waitWithSignal(evidenceTask, operation.controller.signal);
      this.#assertRemoteRecoveryAuthority(operation, authority, attempt);
      if (!attempt.commitParticipant(operation.participantId)) {
        throw new Error('Host remote recovery renderer evidence was not committed');
      }
      this.#assertRemoteRecoveryAuthority(operation, authority, attempt);
      return freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: this.#roomGeneration,
        participantId: operation.participantId,
        publication: authority.publication,
        attempt: accepted.attempt,
        schedule: accepted.schedule,
        timeline: authority.timeline,
      });
    } catch (error) {
      const failure = asError(error, 'Host remote recovery failed');
      deferred.reject(failure);
      try {
        attempt?.cancel('remote-recovery-failed');
      } catch {
        // The recovery rejection remains primary and never quarantines the room.
      }
      throw failure;
    } finally {
      operation.removeExternalAbort();
      if (this.#remoteRecoveries.get(operation.participantId) === operation) {
        this.#remoteRecoveries.delete(operation.participantId);
      }
      operation.attempt = null;
    }
  }

  #assertRemoteRecoveryAuthority(
    operation: ActiveRemoteRecovery,
    authority: PeerPublicationAuthority,
    attempt: HostRendezvousAttempt | null,
  ): void {
    throwIfAborted(operation.externalSignal);
    throwIfAborted(operation.controller.signal);
    if (
      this.#remoteRecoveries.get(operation.participantId) !== operation ||
      operation.publication !== authority.publication ||
      operation.participant.participantId !== operation.participantId ||
      operation.attempt !== attempt
    ) {
      throw new Error('Host remote recovery was superseded');
    }
    if (attempt) {
      const status = attempt.getSnapshot().status;
      if (status === 'cancelled' || status === 'superseded') {
        throw new Error('Host remote recovery attempt is stale');
      }
    }
    this.#assertPeerPublicationAuthority(authority);
  }

  #abortRemoteRecovery(operation: ActiveRemoteRecovery, reason: string): void {
    operation.controller.abort(new Error(reason));
    try {
      operation.attempt?.cancel(reason);
    } catch {
      // Abort is authoritative; best-effort transport cancellation cannot mask it.
    }
  }

  #cancelAllRemoteRecoveries(reason: string): void {
    if (this.#remoteRecoveries.size === 0) return;
    const operations = [...this.#remoteRecoveries.values()];
    this.#remoteRecoveries.clear();
    for (const operation of operations) this.#abortRemoteRecovery(operation, reason);
  }

  #hasLiveProjectionAuthority(): boolean {
    try {
      if (this.#closed || this.#coordinatorClosed || this.#committedPort === null) {
        return false;
      }
      this.#assertRoomClockAuthority();
      const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
      const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
      const port = this.#committedPort;
      const renderer = Reflect.apply(trustedManagerCurrentSnapshot, this.#manager, [port]);
      const run = timeline.run;
      return (
        !this.#closed &&
        !this.#coordinatorClosed &&
        snapshot.roomGeneration === this.#roomGeneration &&
        snapshot.roomRole === 'host' &&
        snapshot.timeline === timeline &&
        timeline.phase !== 'stopped' &&
        run !== null &&
        this.#assets.has(run.queueItemId) &&
        currentPort(this.#manager) === port &&
        renderer?.queueItemId === run.queueItemId &&
        renderer.revision === timeline.revision &&
        renderer.run?.queueItemId === run.queueItemId &&
        renderer.run.runId === run.runId &&
        renderer.run.revision === timeline.revision
      );
    } catch {
      return false;
    }
  }

  #assertRoomClockAuthority(): void {
    const role = Reflect.apply(trustedRoomClockRole, this.#roomClock, []);
    const nowRoomTimeMs = this.#clockBindings
      ? this.#clockBindings.nowRoomTimeMs()
      : Reflect.apply(trustedRoomClockNow, this.#roomClock, []);
    if (
      role !== 'host' ||
      typeof nowRoomTimeMs !== 'number' ||
      !Number.isFinite(nowRoomTimeMs) ||
      nowRoomTimeMs < 0
    ) {
      throw new Error('Host first-file room clock authority is stale');
    }
  }

  #assertOperationFence(operation: ActiveStartOperation): void {
    throwIfAborted(operation.externalSignal);
    throwIfAborted(operation.controller.signal);
    if (
      operation.commitDominant ||
      this.#activeOperation !== operation ||
      this.#operationEpoch !== operation.epoch
    ) {
      throw new Error('Host local file candidate operation was superseded');
    }
    this.#assertTimelineAuthority(operation.previousTimeline, false);
    throwIfAborted(operation.externalSignal);
    throwIfAborted(operation.controller.signal);
  }

  #assertTransitionOperationFence(operation: ActiveTransitionOperation): void {
    throwIfAborted(operation.externalSignal);
    throwIfAborted(operation.controller.signal);
    if (
      operation.commitDominant ||
      this.#activeOperation !== operation ||
      this.#operationEpoch !== operation.epoch
    ) {
      throw new Error(`Host ${operation.action} operation was superseded`);
    }
    this.#assertTimelineAuthority(operation.previousTimeline, false);
    if (currentPort(this.#manager) !== operation.expectedCurrentPort) {
      throw new Error(`Host ${operation.action} current renderer changed before scheduling`);
    }
    throwIfAborted(operation.externalSignal);
    throwIfAborted(operation.controller.signal);
  }

  #assertTransitionCommitFence(
    operation: ActiveTransitionOperation,
    intent: Readonly<HostCurrentTransitionIntent>,
    keepsCurrentPort: boolean,
  ): void {
    if (
      !operation.commitDominant ||
      !operation.physicalBoundaryClaimed ||
      this.#activeOperation !== operation ||
      this.#operationEpoch !== operation.epoch
    ) {
      throw new Error(`Host ${operation.action} physical commit authority was superseded`);
    }
    this.#assertTimelineAuthority(operation.previousTimeline, true);
    const managerPort = currentPort(this.#manager);
    if (!keepsCurrentPort) {
      if (managerPort !== null) {
        throw new Error(`Host ${operation.action} evidence did not retire the exact current port`);
      }
      return;
    }
    if (managerPort !== operation.expectedCurrentPort) {
      throw new Error(`Host ${operation.action} evidence lost the exact current port`);
    }
    const snapshot = Reflect.apply(trustedManagerCurrentSnapshot, this.#manager, [managerPort]);
    if (
      !snapshot ||
      snapshot.phase !== 'paused' ||
      snapshot.queueItemId !== intent.to.queueItemId ||
      snapshot.revision !== intent.to.revision ||
      snapshot.run?.queueItemId !== intent.to.queueItemId ||
      snapshot.run.runId !== intent.to.runId ||
      snapshot.run.revision !== intent.to.revision
    ) {
      throw new Error(`Host ${operation.action} renderer state did not match physical evidence`);
    }
  }

  #candidateAuthorityAllows(
    operation: ActiveStartOperation,
    playbackState: PlaybackStateIdentity,
  ): boolean {
    try {
      if (operation.published) {
        const closingDominantTransition =
          this.#activeOperation?.kind === 'transition' &&
          this.#activeOperation.commitDominant &&
          (this.#closed || this.#coordinatorClosed);
        if (
          this.#fatalError ||
          ((this.#closed || this.#coordinatorClosed) && !closingDominantTransition)
        ) {
          return false;
        }
        this.#assertRoomClockAuthority();
        const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
        const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
        return (
          snapshot.roomGeneration === this.#roomGeneration &&
          snapshot.roomRole === 'host' &&
          snapshot.timeline === timeline &&
          timeline.phase !== 'stopped' &&
          timeline.run?.queueItemId === playbackState.queueItemId &&
          timeline.run.runId === playbackState.runId
        );
      }
      if (this.#activeOperation === operation && this.#operationEpoch === operation.epoch) {
        if (operation.commitDominant) {
          this.#assertTimelineAuthority(operation.previousTimeline, true);
        } else {
          this.#assertOperationFence(operation);
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  #assertTimelineCommitFence(operation: ActiveStartOperation): void {
    if (
      !operation.commitDominant ||
      this.#activeOperation !== operation ||
      this.#operationEpoch !== operation.epoch
    ) {
      throw new Error('Host local file rendezvous commit authority was superseded');
    }
    this.#assertTimelineAuthority(operation.previousTimeline, true);
  }

  async #retireOwnedPort(port: FilePlaybackCutoverCandidatePort): Promise<void> {
    const inFlight = this.#portRetirements.get(port);
    if (inFlight) return inFlight;
    if (!this.#ownedPorts.has(port)) return;
    // Publish the in-flight authority before invoking any native/source-owned
    // cleanup callback, so a synchronous close re-entry cannot retire twice.
    const retirement = Promise.resolve().then(() => this.#retireOwnedPortOnce(port));
    this.#portRetirements.set(port, retirement);
    try {
      await retirement;
    } finally {
      if (this.#portRetirements.get(port) === retirement) {
        this.#portRetirements.delete(port);
      }
    }
  }

  async #retireOwnedPortOnce(port: FilePlaybackCutoverCandidatePort): Promise<void> {
    let failure: unknown = null;
    try {
      if (currentPort(this.#manager) === port) {
        await Reflect.apply(trustedManagerRetireCurrent, this.#manager, [port]);
      } else {
        const candidateRetired = await Reflect.apply(trustedManagerRetireCandidate, this.#manager, [
          port,
        ]);
        if (!candidateRetired) {
          await Reflect.apply(trustedManagerRetireCurrent, this.#manager, [port]);
        }
      }
    } catch (error) {
      failure = error;
    }
    if (currentPort(this.#manager) === port) {
      throw new HostFirstFileCleanupError(
        'Host first-file renderer cleanup left the exact current port attached',
        failure,
      );
    }
    if (this.#committedPort === port) this.#committedPort = null;
    this.#ownedPorts.delete(port);
  }

  async #closeOwnedRoom(
    activeTask: Promise<unknown> | null,
    coordinatorFailure: unknown,
    warmCleanup: Promise<void>,
  ): Promise<void> {
    // Always leave the registry mutation that may have reported a fatal error
    // before asking that registry for its idempotent terminal promise.
    await Promise.resolve();
    let cleanupFailure: unknown = coordinatorFailure;
    if (activeTask) {
      try {
        await activeTask;
      } catch (error) {
        // Abort/fence rejection is expected. A failed exact-port retirement
        // must remain visible to the room owner even when close raced it.
        if (containsCleanupFailure(error)) {
          cleanupFailure = mergeCleanupFailure(cleanupFailure, error);
        }
      }
    }
    try {
      await warmCleanup;
    } catch (error) {
      cleanupFailure = mergeCleanupFailure(cleanupFailure, error);
    }
    try {
      const ports = [...this.#ownedPorts];
      for (const port of ports) {
        try {
          await this.#retireOwnedPort(port);
        } catch (error) {
          cleanupFailure = mergeCleanupFailure(cleanupFailure, error);
        }
      }
      // The constructor claims an empty, exact manager for this one-room
      // engine. Clearing it also cancels a stager whose opaque port has not
      // yet crossed the await boundary and cannot be tracked by this layer.
      try {
        await Reflect.apply(trustedManagerClear, this.#manager, []);
        this.#ownedPorts.clear();
      } catch (error) {
        cleanupFailure = mergeCleanupFailure(cleanupFailure, error);
      }
      for (const asset of this.#assets.values()) {
        try {
          revokeCodecTimelineHostArtifactForLease({
            registry: this.#registry,
            roomToken: this.#roomToken,
            lease: asset.lease,
          });
        } catch (error) {
          cleanupFailure = mergeCleanupFailure(cleanupFailure, error);
        }
      }
    } finally {
      try {
        await this.#registry.close(this.#roomToken);
      } catch (error) {
        cleanupFailure = mergeCleanupFailure(cleanupFailure, error);
      } finally {
        try {
          this.#releaseTerminalReferences();
        } catch (error) {
          cleanupFailure = mergeCleanupFailure(cleanupFailure, error);
        }
      }
    }
    if (cleanupFailure) throw cleanupFailure;
  }

  #quarantineAfterPhysicalFailure(cause: unknown): void {
    const error = asError(cause, 'Host local-file physical commit failed');
    if (!this.#fatalError) this.#fatalError = error;
    this.#closed = true;
    this.#peerPublicationAuthority = null;
    this.#retireAllSourceAuthorities();
    this.#preparedTrackAuthority = null;
    const warm = this.#warmTrackOperation;
    this.#cancelAllRemoteRecoveries('remote-recovery-room-quarantined');
    this.#operationEpoch += 1;
    this.#warmEpoch += 1;
    const coordinatorFailure = this.#closeCoordinatorOnce();
    this.#activeOperation?.controller.abort(error);
    const warmCleanup = this.#collectWarmCleanup(warm, error);
    if (!this.#closePromise) {
      // Never make terminal cleanup await the task that is currently invoking
      // this quarantine path. The promoted renderer is already manager truth;
      // closeOwnedRoom owns its exact retirement through #ownedPorts.
      this.#closePromise = this.#closeOwnedRoom(null, coordinatorFailure, warmCleanup);
      observe(this.#closePromise);
    }
    this.#notifyFatalAfterTerminalCleanup(this.#fatalError);
  }

  #handleRegistryFatal(error: Error): void {
    if (!this.#fatalError) this.#fatalError = error;
    this.#closed = true;
    this.#peerPublicationAuthority = null;
    this.#retireAllSourceAuthorities();
    this.#preparedTrackAuthority = null;
    const warm = this.#warmTrackOperation;
    this.#cancelAllRemoteRecoveries('remote-recovery-registry-fatal');
    this.#operationEpoch += 1;
    this.#warmEpoch += 1;
    const coordinatorFailure = this.#closeCoordinatorOnce();
    this.#activeOperation?.controller.abort(error);
    const warmCleanup = this.#collectWarmCleanup(warm, error);
    if (!this.#closePromise) {
      this.#closePromise = this.#closeOwnedRoom(
        this.#activeOperation?.task ?? null,
        coordinatorFailure,
        warmCleanup,
      );
      observe(this.#closePromise);
    }
    this.#notifyFatalAfterTerminalCleanup(error);
  }

  #notifyFatalAfterTerminalCleanup(error: Error): void {
    if (this.#fatalNotified) return;
    this.#fatalNotified = true;
    const close = this.#closePromise;
    if (!close) {
      this.#notifyFatalAfterClose(error);
      return;
    }
    void close.then(
      () => this.#notifyFatalAfterClose(error),
      () => this.#notifyFatalAfterClose(error),
    );
  }

  #notifyFatalAfterClose(error: Error): void {
    try {
      this.#onFatalRoom(error);
    } catch {
      // The room has already been quarantined and is closed.
    }
  }

  #closeCoordinatorOnce(): unknown {
    if (this.#coordinatorClosed) return null;
    this.#coordinatorClosed = true;
    let failure: unknown = null;
    try {
      Reflect.apply(trustedRendezvousCoordinatorClose, this.#rendezvousCoordinator, []);
    } catch (error) {
      failure = error;
    }
    try {
      this.#runtime.onCoordinatorClosed?.();
    } catch (error) {
      failure = mergeCleanupFailure(failure, error);
    }
    return failure;
  }

  #releaseTerminalReferences(): void {
    if (this.#terminalReferencesReleased) return;
    if (!this.#coordinatorClosed) {
      throw new HostFirstFileCleanupError(
        'Host first-file terminal cleanup preceded coordinator close',
        null,
      );
    }
    this.#peerPublicationAuthority = null;
    this.#retireAllSourceAuthorities();
    this.#preparedTrackAuthority = null;
    if (this.#warmTrackOperation !== null) {
      throw new HostFirstFileCleanupError(
        'Host first-file terminal cleanup retained a warm source operation',
        null,
      );
    }
    this.#cancelAllRemoteRecoveries('remote-recovery-terminal-cleanup');
    this.#assets.clear();
    this.#legacyFirstQueueItemId = null;
    this.#pendingNewRun = null;
    this.#committedPort = null;
    this.#decodeOrdinaryAudio = null;
    this.#audioContext = null;
    this.#destination = null;
    this.#clockBindings = null;
    const assetReferenceCount = this.#assets.size;
    const audioContextRetained = this.#audioContext !== null;
    const destinationRetained = this.#destination !== null;
    const clockBindingsRetained = this.#clockBindings !== null;
    if (
      assetReferenceCount !== 0 ||
      audioContextRetained ||
      destinationRetained ||
      clockBindingsRetained
    ) {
      throw new HostFirstFileCleanupError(
        'Host first-file terminal references were not released',
        null,
      );
    }
    this.#terminalReferencesReleased = true;
    const snapshot = freezeCanonical({
      assetReferenceCount: assetReferenceCount as 0,
      audioContextRetained,
      destinationRetained,
      clockBindingsRetained,
    });
    try {
      this.#runtime.onTerminalReferencesReleased?.(snapshot);
    } catch {
      // Test-only observation cannot weaken terminal cleanup.
    }
  }
}
