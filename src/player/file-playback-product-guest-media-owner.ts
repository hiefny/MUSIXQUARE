import type {
  FilePlaybackAuxiliaryAdoptionEvent,
  FilePlaybackPeerRangeAdoptionEvent,
  FilePlaybackWireAdoptionEvent,
} from '../network/file-playback-application-session.ts';
import { FilePlaybackConnectionChannel } from '../network/file-playback-connection-channel.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import {
  FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
  FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
  FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
} from '../network/file-playback-transport-contract.ts';
import type { QueueItemId } from '../types/index.ts';
import type {
  FilePlaybackApplicationTimelineAdoptedEvent,
  FilePlaybackApplicationTimelineUpdatedEvent,
} from './file-playback-application-controller.ts';
import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetBinding,
  type FilePlaybackAssetLease,
  type FilePlaybackAssetSnapshot,
  type FilePlaybackProvisionalAssetLease,
} from './file-playback-asset-registry.ts';
import {
  isFilePlaybackPeerRangeManifestCodecEnabled,
  snapshotFilePlaybackBoundedRoutePolicy,
  type FilePlaybackBoundedRoutePolicy,
} from './file-playback-bounded-route-policy.ts';
import {
  handoffFilePlaybackAssetSourceWarm,
  prepareFilePlaybackAssetSourceWarm,
  retireFilePlaybackAssetSourceWarm,
  stageFilePlaybackAssetSource,
  stageFilePlaybackPeerRangeManifestAssetSource,
  type FilePlaybackWarmSourceAuthority,
  type StageFilePlaybackAssetSourceOptions,
  type StageFilePlaybackPeerRangeManifestAssetSourceOptions,
  type StagedFilePlaybackAssetSource,
} from './file-playback-asset-source-stager.ts';
import type { FilePlaybackClockBindings } from './file-playback-clock.ts';
import {
  FilePlaybackConnectionMediaSession,
  type FilePlaybackConnectionMediaOfferPreparation,
  type FilePlaybackConnectionMediaOperation,
  type FilePlaybackConnectionMediaPreparedRunAttempt,
  type FilePlaybackConnectionMediaStatePreparation,
  type FilePlaybackConnectionMediaStateOperation,
} from './file-playback-connection-media-session.ts';
import {
  FilePlaybackManager,
  isExactFilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from './file-playback-manager.ts';
import {
  acquireFilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleLease,
} from './diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import { confirmFilePlaybackUniversalLifecycleRetirement } from './diagnostics/file-playback-universal-lifecycle-retirement.ts';
import type {
  FilePlaybackProductSessionRouterConnectionContext,
  FilePlaybackProductSessionRouterGuestMediaOwnerPort,
} from './file-playback-product-session-router.ts';
import {
  acquireFilePlaybackPeerRangeManifestAsset,
  type FilePlaybackPeerRangeManifestAdmission,
  type FilePlaybackPeerRangeManifestAcquisition,
} from './file-playback-peer-range-manifest-acquisition.ts';
import {
  prepareFilePlaybackPeerRangeManifestDecoderConstruction,
  retireFilePlaybackPeerRangeManifestDecoderConstruction,
} from './file-playback-peer-range-manifest-decoder-bridge.ts';
import {
  FilePlaybackR2WholeBlobAcquirer,
  type FilePlaybackR2WholeBlobAcquirerOptions,
  type FilePlaybackR2WholeBlobAcquisition,
} from './file-playback-r2-whole-blob-acquirer.ts';
import {
  readFilePlaybackStartEvidence,
  type FilePlaybackCancelIntent,
  type FilePlaybackSourceSnapshot,
  type FilePlaybackStartEvidence,
  type FilePlaybackPauseTransitionIntent,
  type FilePlaybackSeekTransitionIntent,
} from './file-playback-source.ts';
import type { FilePlaybackStopTransitionIntent } from './file-playback-stop-transition.ts';
import {
  readFilePlaybackRemoteEndedTransitionEvidence,
  type FilePlaybackRemoteEndedTransitionIntent,
} from './file-playback-remote-ended-transition.ts';
import type { OrdinaryAudioDecoder } from './file-playback-source-factory.ts';
import { parseFilePlaybackRunBindingV2 } from './file-playback-run-binding.ts';
import type {
  FilePlaybackWireAttemptLease,
  FilePlaybackWireLease,
  FilePlaybackWireStateLease,
} from './file-playback-wire-binding.ts';
import type { FilePlaybackWireMessage } from './file-playback-wire.ts';
import { ManagerCutoverRendezvousParticipant } from './manager-cutover-rendezvous-participant.ts';
import {
  readPlaybackStateIdentity,
  type PlaybackAttemptIdentity,
  type PlaybackStateIdentity,
} from './playback-identity.ts';
import {
  readRendezvousArmReceipt,
  readRendezvousFinalizeReceipt,
  type RendezvousArmIntent,
  type RendezvousArmReceipt,
  type RendezvousFinalizeIntent,
  type RendezvousFinalizeReceipt,
} from './rendezvous-contract.ts';
import { isPlaybackTimelineSnapshot, type PlaybackTimelineSnapshot } from './playback-timeline.ts';
import { PeerRangeEncodedAudioAsset } from './sources/peer-range-encoded-audio-asset.ts';
import type { PeerRangeControlFrame } from './sources/peer-range-protocol.ts';
import {
  FramedPeerRangeClientTransport,
  bindPeerRangeTrustedConnection,
  type FramedPeerRangeClientTransportOptions,
  type PeerRangeTrustedConnectionContext,
} from './sources/peer-range-transport.ts';

const CONTEXT_KEYS = Object.freeze([
  'schemaVersion',
  'role',
  'connection',
  'channel',
  'connectionToken',
  'routerToken',
  'sessionId',
  'connectionId',
  'hostParticipantId',
  'guestParticipantId',
] as const);
const OPTION_KEYS = Object.freeze([
  'context',
  'roomToken',
  'registry',
  'manager',
  'getAudioGraph',
  'maxEncodedSize',
  'decodeOrdinaryAudio',
  'boundedRoutePolicy',
  'sendRequired',
  'canSendPeerControl',
  'onTimelineRendered',
  'onFatalConnection',
  'armP95Ms',
  'readyLeaseMs',
  'rendererHealthLeaseMs',
  'runtimeForTests',
] as const);
const REQUIRED_OPTION_KEYS = OPTION_KEYS.filter(
  (key) =>
    key !== 'armP95Ms' &&
    key !== 'readyLeaseMs' &&
    key !== 'rendererHealthLeaseMs' &&
    key !== 'boundedRoutePolicy' &&
    key !== 'runtimeForTests',
);
const RUNTIME_KEYS = Object.freeze([
  'stageAssetSource',
  'stageManifestAssetSource',
  'prepareWarmSource',
  'handoffWarmSource',
  'retireWarmSource',
  'acquireManifestAsset',
  'prepareManifestDecoderConstruction',
  'retireManifestDecoderConstruction',
  'createR2Acquirer',
  'createPeerTransport',
  'createParticipant',
  'currentPort',
  'currentSnapshot',
  'recoveryRequired',
  'primeCandidate',
  'retireCandidate',
  'retireCurrent',
  'pauseCurrent',
  'seekCurrent',
  'stopCurrent',
  'remoteEndCurrent',
  'waitForClockPoll',
  'scheduleTimeoutForTests',
  'cancelTimeoutForTests',
] as const);
const AUXILIARY_EVENT_KEYS = Object.freeze([
  'channel',
  'connection',
  'connectionToken',
  'frame',
] as const);

async function settlePhysicalCleanupStrictly(
  tasks: readonly Promise<unknown>[],
  message: string,
): Promise<void> {
  const settlements = await Promise.allSettled(tasks);
  const failures = settlements
    .filter((settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected')
    .map((settlement) => settlement.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

function invokePhysicalCleanup(cleanup: () => void | PromiseLike<void>): Promise<void> {
  try {
    return Promise.resolve(cleanup());
  } catch (cause) {
    return Promise.reject(cause);
  }
}
const PEER_EVENT_KEYS = Object.freeze([
  'channel',
  'connection',
  'connectionToken',
  'frame',
  'lane',
  'role',
] as const);
const WIRE_EVENT_KEYS = Object.freeze([
  'attemptLease',
  'channel',
  'connection',
  'message',
  'stateLease',
] as const);
const TIMELINE_EVENT_KEYS = Object.freeze([
  'schemaVersion',
  'roomGeneration',
  'sessionId',
  'connectionId',
  'status',
  'timeline',
] as const);
const TIMELINE_UPDATED_EVENT_KEYS = Object.freeze([
  'schemaVersion',
  'roomGeneration',
  'sessionId',
  'connectionId',
  'timeline',
] as const);
const TIMELINE_KEYS = Object.freeze([
  'schemaVersion',
  'revision',
  'phase',
  'run',
  'positionSeconds',
  'anchorMonotonicMs',
  'rate',
] as const);
const RUN_KEYS = Object.freeze(['queueItemId', 'runId'] as const);
const AUDIO_GRAPH_KEYS = Object.freeze(['audioContext', 'destination'] as const);
const MANIFEST_CONSTRUCTION_KEYS = Object.freeze([
  'codec',
  'queueItemId',
  'sourceIdentity',
  'sourceSize',
] as const);
const DEFAULT_ARM_P95_MS = 75;
const DEFAULT_READY_LEASE_MS = 30_000;
const DEFAULT_RENDERER_HEALTH_LEASE_MS = 10_000;
const RENDERER_HEALTH_HEARTBEAT_DIVISOR = 3;
const CLOCK_POLL_MS = 20;
const WARM_CLOSE_GRACE_MS = 2_000;
const TERMINAL_REMOTE_RECOVERY_CANCEL_REASONS = new Set([
  'remote-recovery-pause-transition',
  'remote-recovery-seek-transition',
  'remote-recovery-stop-transition',
  'remote-recovery-ended-transition',
]);

function isTerminalRemoteRecoveryCancelReason(reasonCode: string): boolean {
  return TERMINAL_REMOTE_RECOVERY_CANCEL_REASONS.has(reasonCode);
}

type ExactRecord = Readonly<Record<string, unknown>>;
type MaybePromiseBoolean = boolean | PromiseLike<boolean>;
type StageAssetSource = (
  options: StageFilePlaybackAssetSourceOptions,
) => Promise<Readonly<StagedFilePlaybackAssetSource>>;
type PrepareWarmSource = typeof prepareFilePlaybackAssetSourceWarm;
type HandoffWarmSource = typeof handoffFilePlaybackAssetSourceWarm;
type RetireWarmSource = typeof retireFilePlaybackAssetSourceWarm;
type AcquireManifestAsset = typeof acquireFilePlaybackPeerRangeManifestAsset;
type PrepareManifestDecoderConstruction =
  typeof prepareFilePlaybackPeerRangeManifestDecoderConstruction;
type RetireManifestDecoderConstruction =
  typeof retireFilePlaybackPeerRangeManifestDecoderConstruction;
type StageManifestAssetSource = (
  options: StageFilePlaybackPeerRangeManifestAssetSourceOptions,
) => Promise<Readonly<StagedFilePlaybackAssetSource>>;
type TimerHandle = string;
let rendererHealthTimerSequence = 0;

interface GuestR2AcquirerPort {
  acquire(
    operation: Readonly<FilePlaybackConnectionMediaOperation>,
  ): Promise<Readonly<FilePlaybackR2WholeBlobAcquisition>>;
  removeQueueItem(queueItemId: QueueItemId): Promise<boolean>;
  close(): Promise<void>;
}

interface GuestPeerTransportPort {
  read: FramedPeerRangeClientTransport['read'];
  acceptBulk: FramedPeerRangeClientTransport['acceptBulk'];
  close: FramedPeerRangeClientTransport['close'];
  closeHandle: FramedPeerRangeClientTransport['closeHandle'];
}

interface GuestRendezvousParticipantPort {
  readonly participantId: string;
  arm(intent: RendezvousArmIntent): Promise<RendezvousArmReceipt>;
  finalize(intent: RendezvousFinalizeIntent): Promise<RendezvousFinalizeReceipt>;
  started(identity: PlaybackAttemptIdentity): Promise<FilePlaybackStartEvidence>;
  commitAttempt(identity: PlaybackAttemptIdentity): boolean;
  cancel(intent: FilePlaybackCancelIntent): Promise<void>;
}

interface RuntimeSnapshot {
  readonly stageAssetSource: StageAssetSource;
  readonly stageManifestAssetSource: StageManifestAssetSource;
  readonly prepareWarmSource: PrepareWarmSource;
  readonly handoffWarmSource: HandoffWarmSource;
  readonly retireWarmSource: RetireWarmSource;
  readonly acquireManifestAsset: AcquireManifestAsset;
  readonly prepareManifestDecoderConstruction: PrepareManifestDecoderConstruction;
  readonly retireManifestDecoderConstruction: RetireManifestDecoderConstruction;
  readonly createR2Acquirer: (
    options: FilePlaybackR2WholeBlobAcquirerOptions,
  ) => GuestR2AcquirerPort;
  readonly createPeerTransport: (
    options: FramedPeerRangeClientTransportOptions,
  ) => GuestPeerTransportPort;
  readonly createParticipant: (options: {
    readonly participantId: string;
    readonly rttP95Ms: number;
    readonly armP95Ms: number;
    readonly manager: FilePlaybackManager;
    readonly candidatePort: FilePlaybackCutoverCandidatePort;
  }) => GuestRendezvousParticipantPort;
  readonly currentPort: (manager: FilePlaybackManager) => FilePlaybackCutoverCandidatePort | null;
  readonly currentSnapshot: (
    manager: FilePlaybackManager,
    port: FilePlaybackCutoverCandidatePort,
  ) => FilePlaybackSourceSnapshot | null;
  readonly recoveryRequired: (manager: FilePlaybackManager) => boolean;
  readonly primeCandidate: (
    manager: FilePlaybackManager,
    ...args: Parameters<FilePlaybackManager['primeCutoverCandidate']>
  ) => ReturnType<FilePlaybackManager['primeCutoverCandidate']>;
  readonly retireCandidate: (
    manager: FilePlaybackManager,
    port: FilePlaybackCutoverCandidatePort,
  ) => Promise<boolean>;
  readonly retireCurrent: (
    manager: FilePlaybackManager,
    port: FilePlaybackCutoverCandidatePort,
  ) => Promise<boolean>;
  readonly pauseCurrent: (
    manager: FilePlaybackManager,
    ...args: Parameters<FilePlaybackManager['pauseCurrentCutover']>
  ) => ReturnType<FilePlaybackManager['pauseCurrentCutover']>;
  readonly seekCurrent: (
    manager: FilePlaybackManager,
    ...args: Parameters<FilePlaybackManager['seekCurrentCutover']>
  ) => ReturnType<FilePlaybackManager['seekCurrentCutover']>;
  readonly stopCurrent: (
    manager: FilePlaybackManager,
    ...args: Parameters<FilePlaybackManager['stopCurrentCutover']>
  ) => ReturnType<FilePlaybackManager['stopCurrentCutover']>;
  readonly remoteEndCurrent: (
    manager: FilePlaybackManager,
    ...args: Parameters<FilePlaybackManager['retireRemoteEndedCurrent']>
  ) => ReturnType<FilePlaybackManager['retireRemoteEndedCurrent']>;
  readonly waitForClockPoll: (signal: AbortSignal) => Promise<void>;
  readonly scheduleTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancelTimeout: (handle: TimerHandle) => void;
}

export interface FilePlaybackProductGuestMediaOwnerRuntimeForTests {
  readonly stageAssetSource?: RuntimeSnapshot['stageAssetSource'];
  readonly stageManifestAssetSource?: RuntimeSnapshot['stageManifestAssetSource'];
  readonly prepareWarmSource?: RuntimeSnapshot['prepareWarmSource'];
  readonly handoffWarmSource?: RuntimeSnapshot['handoffWarmSource'];
  readonly retireWarmSource?: RuntimeSnapshot['retireWarmSource'];
  readonly acquireManifestAsset?: RuntimeSnapshot['acquireManifestAsset'];
  readonly prepareManifestDecoderConstruction?: RuntimeSnapshot['prepareManifestDecoderConstruction'];
  readonly retireManifestDecoderConstruction?: RuntimeSnapshot['retireManifestDecoderConstruction'];
  readonly createR2Acquirer?: RuntimeSnapshot['createR2Acquirer'];
  readonly createPeerTransport?: RuntimeSnapshot['createPeerTransport'];
  readonly createParticipant?: RuntimeSnapshot['createParticipant'];
  readonly currentPort?: RuntimeSnapshot['currentPort'];
  readonly currentSnapshot?: RuntimeSnapshot['currentSnapshot'];
  readonly recoveryRequired?: RuntimeSnapshot['recoveryRequired'];
  readonly primeCandidate?: RuntimeSnapshot['primeCandidate'];
  readonly retireCandidate?: RuntimeSnapshot['retireCandidate'];
  readonly retireCurrent?: RuntimeSnapshot['retireCurrent'];
  readonly remoteEndCurrent?: RuntimeSnapshot['remoteEndCurrent'];
  readonly waitForClockPoll?: RuntimeSnapshot['waitForClockPoll'];
  readonly scheduleTimeoutForTests?: RuntimeSnapshot['scheduleTimeout'];
  readonly cancelTimeoutForTests?: RuntimeSnapshot['cancelTimeout'];
}

export interface FilePlaybackProductGuestMediaOwnerOptions {
  readonly context: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  readonly roomToken: object;
  readonly registry: FilePlaybackAssetRegistry;
  readonly manager: FilePlaybackManager;
  readonly getAudioGraph: () => Promise<Readonly<FilePlaybackProductGuestAudioGraph>>;
  readonly maxEncodedSize: number;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
  readonly sendRequired: (
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
    frame: unknown,
  ) => MaybePromiseBoolean;
  readonly canSendPeerControl: (
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
    frame: PeerRangeControlFrame,
  ) => boolean;
  readonly onFatalConnection: (
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
    error: FilePlaybackProductGuestMediaOwnerFatalError,
  ) => void;
  /** Called only after exact playing evidence or a prepared paused baseline commits. */
  readonly onTimelineRendered: (timeline: Readonly<PlaybackTimelineSnapshot>) => void;
  readonly armP95Ms?: number;
  readonly readyLeaseMs?: number;
  readonly rendererHealthLeaseMs?: number;
  readonly runtimeForTests?: FilePlaybackProductGuestMediaOwnerRuntimeForTests;
}

export interface FilePlaybackProductGuestAudioGraph {
  readonly audioContext: AudioContext;
  readonly destination: AudioNode;
}

export interface FilePlaybackProductGuestMediaOwnerPort extends FilePlaybackProductSessionRouterGuestMediaOwnerPort {
  readonly onTimelineAdopted: (event: FilePlaybackApplicationTimelineAdoptedEvent) => void;
  readonly onTimelineUpdated: (event: FilePlaybackApplicationTimelineUpdatedEvent) => void;
}

interface GuestPreparedRun {
  readonly kind: 'baseline' | 'recovery' | 'state-successor' | 'successor';
  state: Readonly<PlaybackStateIdentity>;
  readonly operation: Readonly<FilePlaybackConnectionMediaOperation>;
  statePreparation: Readonly<FilePlaybackConnectionMediaStatePreparation> | null;
  stateOperation: Readonly<FilePlaybackConnectionMediaStateOperation> | null;
  rendezvousTarget: Readonly<GuestRendezvousTarget> | null;
  primedPositionSeconds: number | null;
  recoveryTargetAllowed: boolean;
  assetLease: FilePlaybackAssetLease | null;
  manifestAdmission: FilePlaybackPeerRangeManifestAdmission | null;
  audioGraph: Readonly<FilePlaybackProductGuestAudioGraph> | null;
  staged: Readonly<StagedFilePlaybackAssetSource> | null;
  participant: GuestRendezvousParticipantPort | null;
  readyPublished: boolean;
  attempt: GuestAttempt | null;
  status: 'preparing' | 'ready' | 'current' | 'retired';
}

interface GuestRendezvousTarget {
  readonly positionSeconds: number;
  readonly playbackRate: number;
}

type GuestOfferWarmOutcome = 'warmed' | 'cold-retained';

interface GuestOfferWarmOperation {
  readonly preparation: Readonly<FilePlaybackConnectionMediaOfferPreparation>;
  readonly binding: Readonly<FilePlaybackAssetBinding>;
  readonly controller: AbortController;
  removePreparationAbort: () => void;
  task: Promise<GuestOfferWarmOutcome> | null;
  provisionalLease: FilePlaybackProvisionalAssetLease | null;
  authority: Readonly<FilePlaybackWarmSourceAuthority> | null;
  claimedBy: GuestPreparedRun | null;
  promoted: boolean;
  retiring: boolean;
  retirementPromise: Promise<void> | null;
}

interface GuestOfferWarmClaim {
  readonly assetLease: FilePlaybackAssetLease;
  readonly staged: Readonly<StagedFilePlaybackAssetSource> | null;
}

interface GuestRoomState {
  readonly roomGeneration: number;
  timeline: Readonly<PlaybackTimelineSnapshot>;
  current: GuestPreparedRun | null;
  candidate: GuestPreparedRun | null;
  physical: GuestPhysicalCommit | null;
  activeBaselineProjected: boolean;
}

interface GuestPhysicalCommit {
  readonly state: Readonly<PlaybackStateIdentity>;
  readonly phase: PlaybackTimelineSnapshot['phase'];
  readonly positionSeconds: number | null;
}

interface GuestAttempt {
  readonly rendezvousId: string;
  readonly attemptLease: FilePlaybackWireAttemptLease;
  readonly admittedAttempt: Readonly<FilePlaybackConnectionMediaPreparedRunAttempt> | null;
  readonly stateOperation: Readonly<FilePlaybackConnectionMediaStateOperation> | null;
  readonly participant: GuestRendezvousParticipantPort;
  readonly identity: Readonly<PlaybackAttemptIdentity>;
  readonly armIntent: Readonly<RendezvousArmIntent>;
  armReceipt: Readonly<RendezvousArmReceipt> | null;
  armTask: Promise<void>;
  finalizeTask: Promise<void> | null;
  committed: boolean;
  cancelled: boolean;
}

interface GuestRendererHealthHeartbeat {
  readonly generation: number;
  readonly room: GuestRoomState;
  readonly prepared: GuestPreparedRun;
  readonly attempt: GuestAttempt;
  readonly renderedFrame: number;
  timerHandle: TimerHandle | null;
  timerLifecycleLease: FilePlaybackUniversalLifecycleLease | null;
}

const channelRole = FilePlaybackConnectionChannel.prototype.role;
const channelBinding = FilePlaybackConnectionChannel.prototype.establishedBinding;
const channelToken = FilePlaybackConnectionChannel.prototype.liveConnectionToken;
const channelClosed = FilePlaybackConnectionChannel.prototype.isClosed;
const channelClockReady = FilePlaybackConnectionChannel.prototype.clockReady;
const channelClockBindings = FilePlaybackConnectionChannel.prototype.bindAudioContext;
const channelNowRoomTime = FilePlaybackConnectionChannel.prototype.nowRoomTimeMs;
const channelQuality = FilePlaybackConnectionChannel.prototype.quality;
const channelCreateWire = FilePlaybackConnectionChannel.prototype.createWire;
const channelCommitAttempt = FilePlaybackConnectionChannel.prototype.commitAttempt;
const channelRetireAttempt = FilePlaybackConnectionChannel.prototype.retireAttempt;
const registryAdmitEncoded = FilePlaybackAssetRegistry.prototype.admitEncodedAsset;
const registryAdmitProvisionalEncoded =
  FilePlaybackAssetRegistry.prototype.admitProvisionalEncodedAsset;
const registryPromoteProvisional = FilePlaybackAssetRegistry.prototype.promoteProvisionalAsset;
const registryDiscardProvisional = FilePlaybackAssetRegistry.prototype.discardProvisionalAsset;
const registrySnapshot = FilePlaybackAssetRegistry.prototype.snapshotForLease;
const managerCurrentPort = FilePlaybackManager.prototype.currentCutoverPort;
const managerCurrentSnapshot = FilePlaybackManager.prototype.currentCutoverSnapshot;
const managerRecoveryRequired = FilePlaybackManager.prototype.cutoverRecoveryRequired;
const managerPrimeCandidate = FilePlaybackManager.prototype.primeCutoverCandidate;
const managerRetireCandidate = FilePlaybackManager.prototype.retireCutoverCandidate;
const managerRetireCurrent = FilePlaybackManager.prototype.retireCurrentCutover;
const managerPauseCurrent = FilePlaybackManager.prototype.pauseCurrentCutover;
const managerSeekCurrent = FilePlaybackManager.prototype.seekCurrentCutover;
const managerStopCurrent = FilePlaybackManager.prototype.stopCurrentCutover;
const managerRemoteEndCurrent = FilePlaybackManager.prototype.retireRemoteEndedCurrent;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotExactRecord(value: unknown, keys: readonly string[]): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set(keys);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotAllowedOptions(value: unknown): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(OPTION_KEYS);
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

function snapshotOptionalRuntime(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === undefined) return Object.freeze(Object.create(null));
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set<string>(RUNTIME_KEYS);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of RUNTIME_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if (
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function'
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function lifecycleDelay(delayMs: number): Promise<void> {
  const timerLease = acquireFilePlaybackUniversalLifecycleLease('timers');
  return new Promise<void>((resolve, reject) => {
    try {
      globalThis.setTimeout(() => {
        timerLease.beginRetire().release();
        resolve();
      }, delayMs);
    } catch (error) {
      timerLease.beginRetire().release();
      reject(error);
    }
  });
}

function waitForClockPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('Guest media owner was revoked', 'AbortError'),
    );
  }
  return lifecycleDelay(CLOCK_POLL_MS);
}

function runtimeSnapshot(value: unknown): RuntimeSnapshot | null {
  const runtime = snapshotOptionalRuntime(value);
  if (!runtime) return null;
  return Object.freeze({
    stageAssetSource:
      (runtime.stageAssetSource as RuntimeSnapshot['stageAssetSource'] | undefined) ??
      stageFilePlaybackAssetSource,
    stageManifestAssetSource:
      (runtime.stageManifestAssetSource as
        | RuntimeSnapshot['stageManifestAssetSource']
        | undefined) ?? stageFilePlaybackPeerRangeManifestAssetSource,
    prepareWarmSource:
      (runtime.prepareWarmSource as RuntimeSnapshot['prepareWarmSource'] | undefined) ??
      prepareFilePlaybackAssetSourceWarm,
    handoffWarmSource:
      (runtime.handoffWarmSource as RuntimeSnapshot['handoffWarmSource'] | undefined) ??
      handoffFilePlaybackAssetSourceWarm,
    retireWarmSource:
      (runtime.retireWarmSource as RuntimeSnapshot['retireWarmSource'] | undefined) ??
      retireFilePlaybackAssetSourceWarm,
    acquireManifestAsset:
      (runtime.acquireManifestAsset as RuntimeSnapshot['acquireManifestAsset'] | undefined) ??
      acquireFilePlaybackPeerRangeManifestAsset,
    prepareManifestDecoderConstruction:
      (runtime.prepareManifestDecoderConstruction as
        | RuntimeSnapshot['prepareManifestDecoderConstruction']
        | undefined) ?? prepareFilePlaybackPeerRangeManifestDecoderConstruction,
    retireManifestDecoderConstruction:
      (runtime.retireManifestDecoderConstruction as
        | RuntimeSnapshot['retireManifestDecoderConstruction']
        | undefined) ?? retireFilePlaybackPeerRangeManifestDecoderConstruction,
    createR2Acquirer:
      (runtime.createR2Acquirer as RuntimeSnapshot['createR2Acquirer'] | undefined) ??
      ((options: FilePlaybackR2WholeBlobAcquirerOptions) =>
        new FilePlaybackR2WholeBlobAcquirer(options)),
    createPeerTransport:
      (runtime.createPeerTransport as RuntimeSnapshot['createPeerTransport'] | undefined) ??
      ((options: FramedPeerRangeClientTransportOptions) =>
        new FramedPeerRangeClientTransport(options)),
    createParticipant:
      (runtime.createParticipant as RuntimeSnapshot['createParticipant'] | undefined) ??
      ((options: Parameters<RuntimeSnapshot['createParticipant']>[0]) =>
        new ManagerCutoverRendezvousParticipant(options)),
    currentPort:
      (runtime.currentPort as RuntimeSnapshot['currentPort'] | undefined) ??
      ((manager: FilePlaybackManager) => Reflect.apply(managerCurrentPort, manager, [])),
    currentSnapshot:
      (runtime.currentSnapshot as RuntimeSnapshot['currentSnapshot'] | undefined) ??
      ((manager: FilePlaybackManager, port: FilePlaybackCutoverCandidatePort) =>
        Reflect.apply(managerCurrentSnapshot, manager, [port])),
    recoveryRequired:
      (runtime.recoveryRequired as RuntimeSnapshot['recoveryRequired'] | undefined) ??
      ((manager: FilePlaybackManager) => Reflect.apply(managerRecoveryRequired, manager, [])),
    primeCandidate:
      (runtime.primeCandidate as RuntimeSnapshot['primeCandidate'] | undefined) ??
      ((
        manager: FilePlaybackManager,
        port: FilePlaybackCutoverCandidatePort,
        positionSeconds: number,
        signal: AbortSignal,
      ) => Reflect.apply(managerPrimeCandidate, manager, [port, positionSeconds, signal])),
    retireCandidate:
      (runtime.retireCandidate as RuntimeSnapshot['retireCandidate'] | undefined) ??
      ((manager: FilePlaybackManager, port: FilePlaybackCutoverCandidatePort) =>
        Reflect.apply(managerRetireCandidate, manager, [port])),
    retireCurrent:
      (runtime.retireCurrent as RuntimeSnapshot['retireCurrent'] | undefined) ??
      ((manager: FilePlaybackManager, port: FilePlaybackCutoverCandidatePort) =>
        Reflect.apply(managerRetireCurrent, manager, [port])),
    pauseCurrent:
      (runtime.pauseCurrent as RuntimeSnapshot['pauseCurrent'] | undefined) ??
      ((
        manager: FilePlaybackManager,
        port: FilePlaybackCutoverCandidatePort,
        intent: FilePlaybackPauseTransitionIntent,
      ) => Reflect.apply(managerPauseCurrent, manager, [port, intent])),
    seekCurrent:
      (runtime.seekCurrent as RuntimeSnapshot['seekCurrent'] | undefined) ??
      ((
        manager: FilePlaybackManager,
        port: FilePlaybackCutoverCandidatePort,
        intent: FilePlaybackSeekTransitionIntent,
      ) => Reflect.apply(managerSeekCurrent, manager, [port, intent])),
    stopCurrent:
      (runtime.stopCurrent as RuntimeSnapshot['stopCurrent'] | undefined) ??
      ((
        manager: FilePlaybackManager,
        port: FilePlaybackCutoverCandidatePort,
        intent: FilePlaybackStopTransitionIntent,
      ) => Reflect.apply(managerStopCurrent, manager, [port, intent])),
    remoteEndCurrent:
      (runtime.remoteEndCurrent as RuntimeSnapshot['remoteEndCurrent'] | undefined) ??
      ((
        manager: FilePlaybackManager,
        port: FilePlaybackCutoverCandidatePort,
        intent: FilePlaybackRemoteEndedTransitionIntent,
      ) => Reflect.apply(managerRemoteEndCurrent, manager, [port, intent])),
    waitForClockPoll:
      (runtime.waitForClockPoll as RuntimeSnapshot['waitForClockPoll'] | undefined) ??
      waitForClockPoll,
    scheduleTimeout:
      (runtime.scheduleTimeoutForTests as RuntimeSnapshot['scheduleTimeout'] | undefined) ??
      ((callback: () => void, delayMs: number) => {
        const name = `file-playback-guest-renderer-health-${++rendererHealthTimerSequence}`;
        setManagedTimer(name, callback, delayMs);
        return name;
      }),
    cancelTimeout:
      (runtime.cancelTimeoutForTests as RuntimeSnapshot['cancelTimeout'] | undefined) ??
      ((handle: TimerHandle) => clearManagedTimer(handle)),
  });
}

function exactContext(
  value: unknown,
): Readonly<FilePlaybackProductSessionRouterConnectionContext> | null {
  const context = snapshotExactRecord(value, CONTEXT_KEYS);
  if (
    !context ||
    context.schemaVersion !== 1 ||
    context.role !== 'guest' ||
    !(context.channel instanceof FilePlaybackConnectionChannel) ||
    context.connection === null ||
    (typeof context.connection !== 'object' && typeof context.connection !== 'function') ||
    context.connectionToken !== context.connection ||
    context.routerToken === null ||
    typeof context.routerToken !== 'object' ||
    typeof context.sessionId !== 'string' ||
    typeof context.connectionId !== 'string' ||
    typeof context.hostParticipantId !== 'string' ||
    typeof context.guestParticipantId !== 'string'
  ) {
    return null;
  }
  const channel = context.channel;
  try {
    const binding = Reflect.apply(channelBinding, channel, []);
    if (
      Reflect.getPrototypeOf(channel) !== FilePlaybackConnectionChannel.prototype ||
      Reflect.apply(channelRole, channel, []) !== 'guest' ||
      Reflect.apply(channelClosed, channel, []) ||
      Reflect.apply(channelToken, channel, []) !== context.connectionToken ||
      !binding ||
      binding.sessionId !== context.sessionId ||
      binding.connectionId !== context.connectionId ||
      binding.hostParticipantId !== context.hostParticipantId ||
      binding.guestParticipantId !== context.guestParticipantId
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return value as Readonly<FilePlaybackProductSessionRouterConnectionContext>;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function configuredDuration(
  value: unknown,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!positiveSafeInteger(selected) || selected > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
  return selected;
}

function canonicalTimeline(value: unknown): Readonly<PlaybackTimelineSnapshot> | null {
  const timeline = snapshotExactRecord(value, TIMELINE_KEYS);
  const run = timeline?.run === null ? null : snapshotExactRecord(timeline?.run, RUN_KEYS);
  if (!timeline || !isPlaybackTimelineSnapshot(value)) return null;
  if (timeline.run !== null && !run) return null;
  return freezeCanonical({
    schemaVersion: 1 as const,
    revision: timeline.revision as number,
    phase: timeline.phase as PlaybackTimelineSnapshot['phase'],
    run:
      run === null
        ? null
        : freezeCanonical({
            queueItemId: run.queueItemId as QueueItemId,
            runId: run.runId as string,
          }),
    positionSeconds: timeline.positionSeconds as number,
    anchorMonotonicMs: timeline.anchorMonotonicMs as number,
    rate: timeline.rate as number,
  });
}

function sameTimeline(
  left: Readonly<PlaybackTimelineSnapshot>,
  right: Readonly<PlaybackTimelineSnapshot>,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.revision === right.revision &&
    left.phase === right.phase &&
    left.run?.queueItemId === right.run?.queueItemId &&
    left.run?.runId === right.run?.runId &&
    left.positionSeconds === right.positionSeconds &&
    left.anchorMonotonicMs === right.anchorMonotonicMs &&
    left.rate === right.rate
  );
}

function assetBinding(
  operation: Readonly<FilePlaybackConnectionMediaOperation>,
): Readonly<FilePlaybackAssetBinding> {
  return freezeCanonical({
    queueItemId: operation.binding.queueItemId,
    sourceIdentity: operation.binding.sourceIdentity,
    transferSessionId: operation.binding.transferSessionId,
  });
}

function preparationAssetBinding(
  preparation: Readonly<FilePlaybackConnectionMediaOfferPreparation>,
): Readonly<FilePlaybackAssetBinding> {
  return freezeCanonical({
    queueItemId: preparation.offer.queueItemId,
    sourceIdentity: preparation.offer.sourceIdentity,
    transferSessionId: preparation.offer.transferSessionId,
  });
}

function sameOfferedAsset(
  snapshot: Readonly<FilePlaybackAssetSnapshot> | null,
  binding: Readonly<FilePlaybackAssetBinding>,
  preparation: Readonly<FilePlaybackConnectionMediaOfferPreparation>,
): snapshot is Readonly<FilePlaybackAssetSnapshot> {
  return (
    snapshot !== null &&
    snapshot.queueItemId === binding.queueItemId &&
    snapshot.sourceIdentity === binding.sourceIdentity &&
    snapshot.transferSessionId === binding.transferSessionId &&
    snapshot.size === preparation.offer.encodedSize &&
    snapshot.name === preparation.offer.name &&
    snapshot.mime === preparation.offer.mime
  );
}

function sameAsset(
  snapshot: Readonly<FilePlaybackAssetSnapshot> | null,
  binding: Readonly<FilePlaybackAssetBinding>,
  operation: Readonly<FilePlaybackConnectionMediaOperation>,
): snapshot is Readonly<FilePlaybackAssetSnapshot> {
  return (
    snapshot !== null &&
    snapshot.queueItemId === binding.queueItemId &&
    snapshot.sourceIdentity === binding.sourceIdentity &&
    snapshot.transferSessionId === binding.transferSessionId &&
    snapshot.size === operation.offer.encodedSize &&
    snapshot.name === operation.offer.name &&
    snapshot.mime === operation.offer.mime
  );
}

function manifestOfferEnabled(policy: Readonly<FilePlaybackBoundedRoutePolicy>): boolean {
  return (
    isFilePlaybackPeerRangeManifestCodecEnabled(policy, 'adts-aac-lc') ||
    isFilePlaybackPeerRangeManifestCodecEnabled(policy, 'mp3-no-frame-count')
  );
}

function messageMatchesPrepared(
  message: Readonly<FilePlaybackWireMessage>,
  context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  prepared: GuestPreparedRun,
): boolean {
  return (
    message.sessionId === context.sessionId &&
    message.connectionId === context.connectionId &&
    message.senderParticipantId === context.hostParticipantId &&
    message.recipientParticipantId === context.guestParticipantId &&
    message.queueItemId === prepared.state.queueItemId &&
    message.runId === prepared.state.runId &&
    message.revision === prepared.state.revision &&
    message.sourceIdentity === prepared.operation.binding.sourceIdentity &&
    message.transferSessionId === prepared.operation.binding.transferSessionId
  );
}

function messageMatchesCurrentSuccessor(
  message: Readonly<FilePlaybackWireMessage>,
  context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  prepared: GuestPreparedRun,
): boolean {
  return (
    message.sessionId === context.sessionId &&
    message.connectionId === context.connectionId &&
    message.senderParticipantId === context.hostParticipantId &&
    message.recipientParticipantId === context.guestParticipantId &&
    message.queueItemId === prepared.state.queueItemId &&
    message.runId === prepared.state.runId &&
    message.sourceIdentity === prepared.operation.binding.sourceIdentity &&
    message.transferSessionId === prepared.operation.binding.transferSessionId
  );
}

function stateFromTimeline(
  timeline: Readonly<PlaybackTimelineSnapshot>,
): Readonly<PlaybackStateIdentity> | null {
  if (!timeline.run || timeline.phase === 'stopped') return null;
  return readPlaybackStateIdentity({
    queueItemId: timeline.run.queueItemId,
    runId: timeline.run.runId,
    revision: timeline.revision,
  });
}

function sameState(
  left: Readonly<PlaybackStateIdentity>,
  right: Readonly<PlaybackStateIdentity>,
): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision
  );
}

function isExactNextState(
  previous: Readonly<PlaybackTimelineSnapshot>,
  next: Readonly<PlaybackStateIdentity>,
): boolean {
  return next.revision === previous.revision + 1;
}

function attemptIdentity(
  state: Readonly<PlaybackStateIdentity>,
  rendezvousId: string,
): Readonly<PlaybackAttemptIdentity> {
  return freezeCanonical({ ...state, rendezvousId });
}

function canonicalStartEvidence(value: unknown): Readonly<FilePlaybackStartEvidence> | null {
  let targetFrame: unknown;
  try {
    targetFrame =
      value && typeof value === 'object'
        ? Object.getOwnPropertyDescriptor(value, 'targetFrame')?.value
        : null;
  } catch {
    return null;
  }
  return typeof targetFrame === 'number' ? readFilePlaybackStartEvidence(value, targetFrame) : null;
}

function canonicalAudioGraph(value: unknown): Readonly<FilePlaybackProductGuestAudioGraph> | null {
  const graph = snapshotExactRecord(value, AUDIO_GRAPH_KEYS);
  if (
    !graph ||
    !Object.isFrozen(value) ||
    graph.audioContext === null ||
    typeof graph.audioContext !== 'object' ||
    graph.destination === null ||
    typeof graph.destination !== 'object'
  ) {
    return null;
  }
  let destinationContext: unknown;
  try {
    destinationContext = (graph.destination as AudioNode).context;
  } catch {
    return null;
  }
  if (destinationContext !== graph.audioContext) return null;
  return freezeCanonical({
    audioContext: graph.audioContext as AudioContext,
    destination: graph.destination as AudioNode,
  });
}

function isParticipant(
  value: unknown,
  participantId: string,
): value is GuestRendezvousParticipantPort {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as GuestRendezvousParticipantPort).participantId === participantId &&
    typeof (value as GuestRendezvousParticipantPort).arm === 'function' &&
    typeof (value as GuestRendezvousParticipantPort).finalize === 'function' &&
    typeof (value as GuestRendezvousParticipantPort).started === 'function' &&
    typeof (value as GuestRendezvousParticipantPort).commitAttempt === 'function' &&
    typeof (value as GuestRendezvousParticipantPort).cancel === 'function'
  );
}

export class FilePlaybackProductGuestMediaOwnerFatalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FilePlaybackProductGuestMediaOwnerFatalError';
  }
}

class GuestOfferWarmCleanupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GuestOfferWarmCleanupError';
  }
}

class GuestRendezvousAttemptCancelledError extends Error {
  constructor() {
    super('Guest rendezvous attempt was cancelled');
    this.name = 'GuestRendezvousAttemptCancelledError';
  }
}

class GuestMediaOwner {
  readonly #lifecycleLease: FilePlaybackUniversalLifecycleLease;
  readonly #context: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  readonly #roomToken: object;
  readonly #registry: FilePlaybackAssetRegistry;
  readonly #manager: FilePlaybackManager;
  readonly #getAudioGraph: FilePlaybackProductGuestMediaOwnerOptions['getAudioGraph'];
  readonly #decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly #boundedRoutePolicy: Readonly<FilePlaybackBoundedRoutePolicy> | undefined;
  readonly #manifestBoundedRoutePolicy: Readonly<FilePlaybackBoundedRoutePolicy>;
  readonly #sendRequiredCallback: FilePlaybackProductGuestMediaOwnerOptions['sendRequired'];
  readonly #canSendPeerControl: FilePlaybackProductGuestMediaOwnerOptions['canSendPeerControl'];
  readonly #onFatalConnection: FilePlaybackProductGuestMediaOwnerOptions['onFatalConnection'];
  readonly #onTimelineRendered: FilePlaybackProductGuestMediaOwnerOptions['onTimelineRendered'];
  readonly #runtime: RuntimeSnapshot;
  readonly #armP95Ms: number;
  readonly #readyLeaseMs: number;
  readonly #rendererHealthLeaseMs: number;
  readonly #abort = new AbortController();
  readonly #mediaSession: FilePlaybackConnectionMediaSession;
  readonly #peerContext: PeerRangeTrustedConnectionContext;
  readonly #peerTransport: GuestPeerTransportPort;
  readonly #r2Acquirer: GuestR2AcquirerPort;
  readonly #tasks = new Set<Promise<void>>();
  readonly #warmTasks = new Set<Promise<void>>();
  #room: GuestRoomState | null = null;
  #offerWarm: GuestOfferWarmOperation | null = null;
  #pendingOfferWarm: Readonly<FilePlaybackConnectionMediaOfferPreparation> | null = null;
  #lane: Promise<void> = Promise.resolve();
  #closed = false;
  #fatalError: FilePlaybackProductGuestMediaOwnerFatalError | null = null;
  #closePromise: Promise<void> | null = null;
  #fatalPublished = false;
  #timelineCallbackActive = false;
  #audioGraphPromise: Promise<Readonly<FilePlaybackProductGuestAudioGraph>> | null = null;
  #rendererHealthHeartbeatGeneration = 0;
  #rendererHealthHeartbeat: GuestRendererHealthHeartbeat | null = null;

  constructor(options: FilePlaybackProductGuestMediaOwnerOptions) {
    const input = snapshotAllowedOptions(options);
    const manifestBoundedRoutePolicy = snapshotFilePlaybackBoundedRoutePolicy(
      input?.boundedRoutePolicy,
    );
    const boundedRoutePolicy =
      input?.boundedRoutePolicy === undefined ? undefined : manifestBoundedRoutePolicy;
    const context = exactContext(input?.context);
    const runtime = runtimeSnapshot(input?.runtimeForTests);
    if (!input || !context || !runtime) {
      throw new TypeError('File playback product guest media owner options are invalid');
    }
    if (!input.roomToken || typeof input.roomToken !== 'object') {
      throw new TypeError('Guest media owner requires an opaque room token');
    }
    if (
      input.registry === null ||
      typeof input.registry !== 'object' ||
      Reflect.getPrototypeOf(input.registry) !== FilePlaybackAssetRegistry.prototype ||
      !isExactFilePlaybackManager(input.manager)
    ) {
      throw new TypeError('Guest media owner registry or manager is invalid');
    }
    if (!positiveSafeInteger(input.maxEncodedSize)) {
      throw new TypeError('Guest media owner size policy is invalid');
    }
    if (
      typeof input.getAudioGraph !== 'function' ||
      typeof input.decodeOrdinaryAudio !== 'function' ||
      typeof input.sendRequired !== 'function' ||
      typeof input.canSendPeerControl !== 'function' ||
      typeof input.onTimelineRendered !== 'function' ||
      typeof input.onFatalConnection !== 'function'
    ) {
      throw new TypeError('Guest media owner callbacks are invalid');
    }
    this.#context = context;
    this.#roomToken = input.roomToken;
    this.#registry = input.registry as FilePlaybackAssetRegistry;
    this.#manager = input.manager as FilePlaybackManager;
    this.#getAudioGraph =
      input.getAudioGraph as FilePlaybackProductGuestMediaOwnerOptions['getAudioGraph'];
    this.#decodeOrdinaryAudio = input.decodeOrdinaryAudio as OrdinaryAudioDecoder;
    this.#boundedRoutePolicy = boundedRoutePolicy;
    this.#manifestBoundedRoutePolicy = manifestBoundedRoutePolicy;
    this.#sendRequiredCallback =
      input.sendRequired as FilePlaybackProductGuestMediaOwnerOptions['sendRequired'];
    this.#canSendPeerControl =
      input.canSendPeerControl as FilePlaybackProductGuestMediaOwnerOptions['canSendPeerControl'];
    this.#onFatalConnection =
      input.onFatalConnection as FilePlaybackProductGuestMediaOwnerOptions['onFatalConnection'];
    this.#onTimelineRendered =
      input.onTimelineRendered as FilePlaybackProductGuestMediaOwnerOptions['onTimelineRendered'];
    this.#runtime = runtime;
    this.#armP95Ms = configuredDuration(input.armP95Ms, DEFAULT_ARM_P95_MS, 60_000, 'armP95Ms');
    this.#readyLeaseMs = configuredDuration(
      input.readyLeaseMs,
      DEFAULT_READY_LEASE_MS,
      120_000,
      'readyLeaseMs',
    );
    this.#rendererHealthLeaseMs = configuredDuration(
      input.rendererHealthLeaseMs,
      DEFAULT_RENDERER_HEALTH_LEASE_MS,
      30_000,
      'rendererHealthLeaseMs',
    );

    this.#mediaSession = new FilePlaybackConnectionMediaSession({
      channel: context.channel,
      connectionToken: context.connectionToken,
      maxEncodedSize: input.maxEncodedSize,
      nowRoomTimeMs: () => this.#nowRoomTimeMs(),
      onFatalConnection: (token, error) => {
        if (token === context.connectionToken) {
          this.#fatal('Guest connection media authority failed', error);
        }
      },
    });
    this.#peerContext = bindPeerRangeTrustedConnection(
      context.connectionToken,
      context.connectionId,
    );
    this.#peerTransport = runtime.createPeerTransport({
      connection: this.#peerContext,
      canSend: (connection, frame) => {
        if (connection !== this.#peerContext || this.#closed) return false;
        return this.#canSendPeerControl(this.#context, frame) === true;
      },
      sendControl: (frame) => this.#sendPeerControl(frame),
      onFatalConnection: (connection, error) => {
        if (connection === this.#peerContext)
          this.#fatal('Guest peer-range transport failed', error);
      },
    });
    this.#r2Acquirer = runtime.createR2Acquirer({
      roomToken: this.#roomToken,
      registry: this.#registry,
      onFatalRoom: (token, error) => {
        if (token === this.#roomToken) this.#fatal('Guest R2 whole-Blob acquisition failed', error);
      },
    });
    try {
      this.#lifecycleLease = acquireFilePlaybackUniversalLifecycleLease('connectionOwners');
    } catch (error) {
      void invokePhysicalCleanup(() => this.#peerTransport.close(error)).catch(() => undefined);
      void invokePhysicalCleanup(() => this.#r2Acquirer.close()).catch(() => undefined);
      throw error;
    }
  }

  onTimelineAdopted(value: FilePlaybackApplicationTimelineAdoptedEvent): void {
    const event = snapshotExactRecord(value, TIMELINE_EVENT_KEYS);
    const timeline = canonicalTimeline(event?.timeline);
    try {
      this.#assertLive();
      if (
        !event ||
        !timeline ||
        event.schemaVersion !== 1 ||
        !positiveSafeInteger(event.roomGeneration) ||
        event.sessionId !== this.#context.sessionId ||
        event.connectionId !== this.#context.connectionId ||
        (event.status !== 'adopted' && event.status !== 'replayed')
      ) {
        throw new TypeError('Guest timeline adoption event is invalid');
      }
      const existing = this.#room;
      if (existing) {
        if (
          existing.roomGeneration === event.roomGeneration &&
          sameTimeline(existing.timeline, timeline)
        ) {
          return;
        }
        throw new Error('Guest timeline baseline is one-shot');
      }
      if (timeline.phase === 'stopped') {
        if (timeline.run !== null) throw new Error('Stopped guest baseline retained a run');
        this.#mediaSession.bootstrapStopped(timeline.revision);
        this.#room = {
          roomGeneration: event.roomGeneration,
          timeline,
          current: null,
          candidate: null,
          physical: null,
          activeBaselineProjected: false,
        };
        return;
      }
      const state = readPlaybackStateIdentity({
        queueItemId: timeline.run?.queueItemId,
        runId: timeline.run?.runId,
        revision: timeline.revision,
      });
      if (!state || (timeline.phase !== 'playing' && timeline.phase !== 'paused')) {
        throw new Error('Guest active baseline has no exact playback state');
      }
      if (!this.#mediaSession.admitQueueItem(state.queueItemId)) {
        throw new Error('Guest active baseline queue item was not admitted');
      }
      this.#room = {
        roomGeneration: event.roomGeneration,
        timeline,
        current: null,
        candidate: null,
        physical: null,
        activeBaselineProjected: false,
      };
      this.#assertLive();
    } catch (error) {
      throw this.#fatal('Guest timeline adoption failed', error);
    }
  }

  onTimelineUpdated(value: FilePlaybackApplicationTimelineUpdatedEvent): void {
    try {
      const event = snapshotExactRecord(value, TIMELINE_UPDATED_EVENT_KEYS);
      const timeline = canonicalTimeline(event?.timeline);
      this.#assertLive();
      if (
        !event ||
        !timeline ||
        event.schemaVersion !== 1 ||
        !positiveSafeInteger(event.roomGeneration) ||
        event.sessionId !== this.#context.sessionId ||
        event.connectionId !== this.#context.connectionId
      ) {
        throw new TypeError('Guest timeline update event is invalid');
      }
      const room = this.#requireRoom();
      if (room.roomGeneration !== event.roomGeneration) {
        throw new Error('Guest timeline update changed its pinned room generation');
      }
      this.#enqueue('timeline update', async () => this.#commitTimelineUpdate(room, timeline));
    } catch (error) {
      throw this.#fatal('Guest timeline update failed', error);
    }
  }

  adoptAuxiliaryMessage(
    value: Readonly<FilePlaybackAuxiliaryAdoptionEvent>,
    acknowledge: () => void,
  ): void {
    try {
      const event = snapshotExactRecord(value, AUXILIARY_EVENT_KEYS);
      this.#assertAuxiliaryEvent(event);
      if (typeof acknowledge !== 'function') {
        throw new TypeError('Guest auxiliary acknowledgement is invalid');
      }
      const type = this.#frameType(event!.frame);
      const room = this.#requireRoom();
      if (type === FILE_MEDIA_SOURCE_OFFER_V2_TYPE) {
        const frame = event!.frame as Readonly<Record<string, unknown>>;
        const queueItemId = frame.queueItemId;
        if (
          typeof queueItemId !== 'string' ||
          !this.#mediaSession.admitQueueItem(queueItemId as QueueItemId)
        ) {
          throw new Error('Guest source offer queue item was not admitted');
        }
        const result = this.#mediaSession.adoptSourceOffer(event!.frame);
        if (!result.accepted) {
          throw new Error(`Guest source offer was rejected: ${result.reason}`);
        }
        if (
          result.offer.transport === 'peer-range-manifest' &&
          !manifestOfferEnabled(this.#manifestBoundedRoutePolicy)
        ) {
          throw new Error('FILE_PLAYBACK_PEER_RANGE_MANIFEST_GATED_OFF');
        }
        acknowledge();
        if (result.offer.transport === 'peer-range') {
          this.#scheduleOfferWarm(result.preparation);
        }
        return;
      }
      if (type === FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE) {
        const result = this.#mediaSession.revokeSourceOffer(event!.frame);
        if (!result.accepted) {
          throw new Error(`Guest source offer revoke was rejected: ${result.reason}`);
        }
        if (result.preparation && this.#pendingOfferWarm === result.preparation) {
          this.#pendingOfferWarm = null;
        }
        acknowledge();
        return;
      }
      if (type !== FILE_PLAYBACK_RUN_BINDING_V2_TYPE) {
        throw new Error('Guest auxiliary frame is not media-owner traffic');
      }
      const binding = parseFilePlaybackRunBindingV2(event!.frame);
      if (!binding) throw new Error('Guest run binding is malformed');
      const state = readPlaybackStateIdentity({
        queueItemId: binding.queueItemId,
        runId: binding.runId,
        revision: binding.playbackRevision,
      });
      if (!state) throw new Error('Guest run binding has no exact playback state');
      const baselineState = stateFromTimeline(room.timeline);
      const kind =
        room.current === null && baselineState && sameState(baselineState, state)
          ? ('baseline' as const)
          : ('successor' as const);
      if (kind === 'successor') {
        if (!isExactNextState(room.timeline, state)) {
          throw new Error('Guest run binding is not the exact next timeline state');
        }
        if (baselineState && baselineState.runId === state.runId) {
          throw new Error('Same-run successor must not restage a source binding');
        }
      }
      const operation = this.#mediaSession.stageRunBinding(event!.frame, state, kind);
      if (this.#pendingOfferWarm?.offer === operation.offer) {
        this.#pendingOfferWarm = null;
      }
      const existing = kind === 'baseline' ? room.current : room.candidate;
      if (existing) {
        if (existing.operation !== operation) {
          throw new Error('Guest run operation conflicted with an active preparation');
        }
        acknowledge();
        return;
      }
      const prepared: GuestPreparedRun = {
        kind,
        state,
        operation,
        statePreparation: null,
        stateOperation: null,
        rendezvousTarget: null,
        primedPositionSeconds: null,
        recoveryTargetAllowed: false,
        assetLease: null,
        manifestAdmission: null,
        audioGraph: null,
        staged: null,
        participant: null,
        readyPublished: false,
        attempt: null,
        status: 'preparing',
      };
      if (kind === 'baseline') room.current = prepared;
      else room.candidate = prepared;
      acknowledge();
      this.#enqueue('source preparation', async () => this.#prepareRun(room, prepared));
    } catch (error) {
      throw this.#fatal('Guest auxiliary media adoption failed', error);
    }
  }

  adoptPeerRangeBulk(
    value: Readonly<FilePlaybackPeerRangeAdoptionEvent>,
    acknowledge: () => void,
  ): void {
    try {
      const event = snapshotExactRecord(value, PEER_EVENT_KEYS);
      this.#assertPeerEvent(event);
      if (typeof acknowledge !== 'function') {
        throw new TypeError('Guest peer-range acknowledgement is invalid');
      }
      this.#peerTransport.acceptBulk(this.#context.connectionToken, event!.frame);
      this.#assertLive();
      acknowledge();
    } catch (error) {
      throw this.#fatal('Guest peer-range bulk adoption failed', error);
    }
  }

  adoptWireMessage(value: Readonly<FilePlaybackWireAdoptionEvent>, acknowledge: () => void): void {
    try {
      const event = snapshotExactRecord(value, WIRE_EVENT_KEYS);
      this.#assertWireEvent(event);
      if (typeof acknowledge !== 'function') {
        throw new TypeError('Guest wire acknowledgement is invalid');
      }
      const room = this.#requireRoom();
      const message = event!.message as Readonly<FilePlaybackWireMessage>;
      if (message.kind === 'file-playback-prepare') {
        if (event!.attemptLease !== null) {
          throw new Error('Guest same-run PREPARE unexpectedly owned an attempt lease');
        }
        const current = room.current;
        const expected = stateFromTimeline(room.timeline);
        const successor = readPlaybackStateIdentity({
          queueItemId: message.queueItemId,
          runId: message.runId,
          revision: message.revision,
        });
        if (
          !current ||
          current.status !== 'current' ||
          room.candidate !== null ||
          !expected ||
          !successor ||
          !sameState(current.state, expected) ||
          message.expectedQueueItemId !== expected.queueItemId ||
          message.expectedRunId !== expected.runId ||
          message.expectedRevision !== expected.revision ||
          successor.queueItemId !== expected.queueItemId ||
          successor.runId !== expected.runId ||
          successor.revision !== expected.revision + 1 ||
          message.sourceIdentity !== current.operation.binding.sourceIdentity ||
          message.transferSessionId !== current.operation.binding.transferSessionId
        ) {
          throw new Error('Guest same-run PREPARE is not the exact current successor');
        }
        const statePreparation = this.#mediaSession.adoptAdmittedSameRunStatePreparation(
          current.operation,
          expected,
          successor,
          event!.stateLease as FilePlaybackWireStateLease,
        );
        const candidate: GuestPreparedRun = {
          kind: 'state-successor',
          state: successor,
          operation: current.operation,
          statePreparation,
          stateOperation: null,
          rendezvousTarget: freezeCanonical({
            positionSeconds: message.positionSeconds,
            playbackRate: message.playbackRate,
          }),
          primedPositionSeconds: null,
          recoveryTargetAllowed: false,
          assetLease: current.assetLease,
          manifestAdmission: current.manifestAdmission,
          audioGraph: current.audioGraph,
          staged: null,
          participant: null,
          readyPublished: false,
          attempt: null,
          status: 'preparing',
        };
        room.candidate = candidate;
        acknowledge();
        this.#enqueue('same-run state successor preparation', async () => {
          await this.#prepareSameSourceCandidate(room, candidate);
          await this.#publishSameSourceReady(room, candidate);
        });
        return;
      }
      if (message.kind === 'rendezvous-arm') {
        if (!event!.attemptLease || typeof event!.attemptLease !== 'object') {
          throw new Error('Guest rendezvous arm has no exact attempt lease');
        }
        const prepared = this.#preparedForMessage(room, message);
        if (
          prepared === room.current &&
          prepared?.attempt?.committed === true &&
          room.candidate === null
        ) {
          const recovery: GuestPreparedRun = {
            kind: 'recovery',
            state: prepared.state,
            operation: prepared.operation,
            statePreparation: null,
            stateOperation: null,
            rendezvousTarget: freezeCanonical({
              positionSeconds: message.positionSeconds,
              playbackRate: message.playbackRate,
            }),
            primedPositionSeconds: null,
            recoveryTargetAllowed: false,
            assetLease: prepared.assetLease,
            manifestAdmission: prepared.manifestAdmission,
            audioGraph: prepared.audioGraph,
            staged: null,
            participant: null,
            readyPublished: false,
            attempt: null,
            status: 'preparing',
          };
          room.candidate = recovery;
          const attemptLease = event!.attemptLease as FilePlaybackWireAttemptLease;
          acknowledge();
          this.#enqueue('same-state recovery arm', async () => {
            await this.#prepareSameSourceCandidate(room, recovery);
            const attempt = this.#createAttempt(recovery, message, attemptLease, null, null);
            recovery.attempt = attempt;
            attempt.armTask = this.#executeArm(room, recovery, attempt);
            await attempt.armTask;
          });
          return;
        }
        if (!prepared || !prepared.readyPublished || !prepared.participant) {
          throw new Error('Guest rendezvous arm has no exact ready source');
        }
        if (prepared.attempt) throw new Error('Guest prepared run already owns an attempt');
        if (
          prepared.kind === 'state-successor' &&
          (!prepared.statePreparation || prepared.rendezvousTarget === null)
        ) {
          throw new Error('Guest same-run ARM disagreed with its exact PREPARE target');
        }
        if (
          prepared.rendezvousTarget !== null &&
          (message.playbackRate !== prepared.rendezvousTarget.playbackRate ||
            (!prepared.recoveryTargetAllowed &&
              message.positionSeconds !== prepared.rendezvousTarget.positionSeconds))
        ) {
          throw new Error('Guest rendezvous ARM disagreed with its canonical target');
        }
        if (prepared.rendezvousTarget === null) {
          prepared.rendezvousTarget = freezeCanonical({
            positionSeconds: message.positionSeconds,
            playbackRate: message.playbackRate,
          });
        }
        const stateOperation =
          prepared.kind === 'state-successor'
            ? this.#mediaSession.attachAdmittedSameRunStateAttempt(
                prepared.statePreparation!,
                message.rendezvousId,
                event!.stateLease as FilePlaybackWireStateLease,
                event!.attemptLease as FilePlaybackWireAttemptLease,
              )
            : null;
        if (stateOperation) {
          prepared.stateOperation = stateOperation;
          prepared.statePreparation = null;
        }
        const admittedAttempt =
          prepared.kind === 'successor'
            ? this.#mediaSession.adoptAdmittedPreparedRunAttempt(
                prepared.operation,
                prepared.state,
                message.rendezvousId,
                event!.stateLease as FilePlaybackWireStateLease,
                event!.attemptLease as FilePlaybackWireAttemptLease,
              )
            : null;
        const attempt = this.#createAttempt(
          prepared,
          message,
          event!.attemptLease as FilePlaybackWireAttemptLease,
          admittedAttempt,
          stateOperation,
        );
        prepared.recoveryTargetAllowed = false;
        prepared.attempt = attempt;
        acknowledge();
        this.#enqueue('rendezvous arm', async () => {
          attempt.armTask = this.#executeArm(room, prepared, attempt);
          await attempt.armTask;
        });
        return;
      }
      if (message.kind === 'rendezvous-finalize') {
        const prepared = this.#preparedForMessage(room, message);
        const attempt = prepared?.attempt;
        if (
          !prepared ||
          !attempt ||
          event!.attemptLease !== attempt.attemptLease ||
          message.rendezvousId !== attempt.rendezvousId ||
          attempt.finalizeTask
        ) {
          throw new Error('Guest rendezvous finalize has no exact armed attempt');
        }
        const intent = freezeCanonical({
          protocolVersion: 2 as const,
          kind: 'rendezvous-finalize' as const,
          ...attempt.identity,
          recipientId: this.#context.guestParticipantId,
          startAtRoomTimeMs: message.startAtRoomTimeMs,
          finalizedAtRoomTimeMs: message.finalizedAtRoomTimeMs,
        });
        acknowledge();
        this.#enqueue('rendezvous finalize', async () => {
          attempt.finalizeTask = this.#executeFinalize(room, prepared, attempt, intent);
          await attempt.finalizeTask;
        });
        return;
      }
      if (message.kind === 'file-playback-cancel') {
        const prepared = this.#preparedForMessage(room, message);
        const attempt = prepared?.attempt;
        const terminalRecoveryCancel = isTerminalRemoteRecoveryCancelReason(message.reasonCode);
        if (
          !prepared ||
          !attempt ||
          !this.#cancelAuthorityIsCurrent(room, prepared, attempt) ||
          event!.attemptLease !== attempt.attemptLease ||
          message.rendezvousId !== attempt.rendezvousId ||
          message.rendezvousId !== attempt.identity.rendezvousId ||
          !sameState(prepared.state, attempt.identity)
        ) {
          throw new Error('Guest rendezvous cancel has no exact uncommitted attempt');
        }
        if (
          terminalRecoveryCancel &&
          (prepared.kind !== 'recovery' || room.candidate !== prepared)
        ) {
          throw new Error(
            'Guest terminal recovery cancel did not own the exact recovery candidate',
          );
        }
        const intent: Readonly<FilePlaybackCancelIntent> = freezeCanonical({
          kind: 'file-playback-cancel' as const,
          ...attempt.identity,
          reasonCode: message.reasonCode,
        });
        // Reserve this exact attempt before acknowledging so a hostile
        // synchronous acknowledgement re-entry cannot cancel it twice.
        attempt.cancelled = true;
        this.#cancelAttempt(
          room,
          prepared,
          attempt,
          intent,
          terminalRecoveryCancel ? 'terminal' : 'retry',
        );
        acknowledge();
        return;
      }
      const current = room.current;
      if (!current || !messageMatchesCurrentSuccessor(message, this.#context, current)) {
        throw new Error('Guest successor wire does not match the exact current run');
      }
      if (
        message.kind !== 'file-playback-pause' &&
        message.kind !== 'file-playback-seek' &&
        message.kind !== 'file-playback-stop' &&
        message.kind !== 'file-playback-ended'
      ) {
        throw new Error(`Guest wire kind is unsupported: ${message.kind}`);
      }
      const expected = stateFromTimeline(room.timeline);
      const successor = readPlaybackStateIdentity({
        queueItemId: message.queueItemId,
        runId: message.runId,
        revision: message.revision,
      });
      if (
        !expected ||
        !successor ||
        message.expectedQueueItemId !== expected.queueItemId ||
        message.expectedRunId !== expected.runId ||
        message.expectedRevision !== expected.revision ||
        !sameState(current.state, expected) ||
        !isExactNextState(room.timeline, successor)
      ) {
        throw new Error('Guest state wire is not the exact current successor');
      }
      // The host retires the current rendezvous lease before publishing this
      // successor. Fence the old heartbeat before acknowledgement can re-enter
      // or the scheduled native transition can yield back to the event loop.
      this.#stopRendererHealthHeartbeat(current);
      acknowledge();
      this.#enqueue(message.kind, async () =>
        this.#applyStateSuccessor(
          room,
          current,
          expected,
          successor,
          message,
          event!.stateLease as FilePlaybackWireStateLease,
        ),
      );
    } catch (error) {
      throw this.#fatal('Guest playback wire adoption failed', error);
    }
  }

  revoke(value: Readonly<FilePlaybackProductSessionRouterConnectionContext>): void {
    if (value !== this.#context) {
      throw this.#fatal('Guest media owner revoke context did not match its exact owner');
    }
    void this.#beginClose();
  }

  async #prepareRun(room: GuestRoomState, prepared: GuestPreparedRun): Promise<void> {
    try {
      this.#assertPrepared(room, prepared);
      const operation = prepared.operation;
      const graph = await this.#resolveAudioGraph(room, prepared);
      this.#assertRunningAudioGraph(graph);
      this.#assertPrepared(room, prepared);
      prepared.audioGraph = graph;
      const warmClaim =
        operation.offer.transport === 'peer-range-manifest'
          ? null
          : await this.#claimOfferWarm(room, prepared, graph);
      this.#assertPrepared(room, prepared);
      let assetLease = warmClaim?.assetLease ?? null;
      let staged = warmClaim?.staged ?? null;
      if (!assetLease) {
        if (operation.offer.transport === 'peer-range-manifest') {
          const acquired = await this.#acquireManifestAsset(operation);
          this.#assertPrepared(room, prepared);
          assetLease = acquired.assetLease;
          prepared.manifestAdmission = acquired.manifestAdmission;
        } else {
          const acquired = await this.#acquireAsset(operation);
          this.#assertPrepared(room, prepared);
          assetLease = acquired.assetLease;
        }
      }
      prepared.assetLease = assetLease;
      if (!staged) {
        const clockBindings = await this.#awaitClockBindings(room, prepared, graph.audioContext);
        this.#assertPrepared(room, prepared);
        staged = await this.#stagePreparedAsset(room, prepared, graph, clockBindings);
        // A resolved stage has already transferred a candidate port into the
        // manager. Retain it before any fallible authority or binding check so
        // late revocation can still retire that exact port during close.
        prepared.staged = staged;
      }
      this.#assertPrepared(room, prepared);
      if (
        staged.asset.queueItemId !== prepared.state.queueItemId ||
        staged.asset.sourceIdentity !== operation.binding.sourceIdentity ||
        staged.asset.transferSessionId !== operation.binding.transferSessionId
      ) {
        throw new Error('Guest staged source does not match its baseline operation');
      }
      const quality = Reflect.apply(channelQuality, this.#context.channel, []);
      this.#assertPrepared(room, prepared);
      const participant = this.#runtime.createParticipant({
        participantId: this.#context.guestParticipantId,
        rttP95Ms: quality.rttP95Ms,
        armP95Ms: this.#armP95Ms,
        manager: this.#manager,
        candidatePort: staged.cutoverPort,
      });
      if (!isParticipant(participant, this.#context.guestParticipantId)) {
        throw new TypeError('Guest cutover participant is invalid');
      }
      prepared.participant = participant;
      this.#assertPrepared(room, prepared);
      this.#assertRunningAudioGraph(graph);
      if (prepared.kind === 'baseline') {
        this.#mediaSession.commitPreparedPausedBaseline(operation, prepared.state, () =>
          this.#preparedCurrent(room, prepared),
        );
      }
      this.#assertPrepared(room, prepared);
      const observedAtRoomTimeMs = this.#nowRoomTimeMs();
      const wire = (
        prepared.kind === 'baseline'
          ? this.#mediaSession.createPreparedSourceReadyWire.bind(this.#mediaSession)
          : this.#mediaSession.createCandidateSourceReadyWire.bind(this.#mediaSession)
      )(operation, {
        kind: 'source-ready',
        observedAtRoomTimeMs,
        readyLeaseUntilRoomTimeMs: observedAtRoomTimeMs + this.#readyLeaseMs,
        backend: staged.backend,
        durationSeconds: staged.readiness.durationSeconds,
        bufferedAheadSeconds: staged.readiness.bufferedAheadSeconds,
        outputSampleRateHz: staged.readiness.outputSampleRateHz,
        channelCount: staged.readiness.channelCount,
      });
      this.#assertPrepared(room, prepared);
      await this.#sendRequired(wire);
      this.#assertPrepared(room, prepared);
      prepared.readyPublished = true;
      prepared.status = 'ready';
      if (prepared.kind === 'baseline' && room.timeline.phase === 'paused') {
        this.#publishActiveBaselineTimeline(room, prepared, 'paused');
      }
    } catch (error) {
      if (!this.#closed) throw error;
    }
  }

  async #prepareSameSourceCandidate(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
  ): Promise<void> {
    if (
      !prepared.assetLease ||
      !prepared.audioGraph ||
      (prepared.kind === 'state-successor' && !prepared.statePreparation)
    ) {
      throw new Error('Guest same-source candidate is incomplete');
    }
    this.#assertPrepared(room, prepared);
    this.#assertRunningAudioGraph(prepared.audioGraph);
    const clockBindings = await this.#awaitClockBindings(
      room,
      prepared,
      prepared.audioGraph.audioContext,
    );
    this.#assertPrepared(room, prepared);
    const staged = await this.#stagePreparedAsset(
      room,
      prepared,
      prepared.audioGraph,
      clockBindings,
    );
    // Recovery handoff has the same ownership boundary as initial staging:
    // close must see the manager-owned port even if authority flips now.
    prepared.staged = staged;
    this.#assertPrepared(room, prepared);
    if (
      staged.asset.queueItemId !== prepared.state.queueItemId ||
      staged.asset.sourceIdentity !== prepared.operation.binding.sourceIdentity ||
      staged.asset.transferSessionId !== prepared.operation.binding.transferSessionId
    ) {
      throw new Error('Guest same-source candidate changed its bound asset');
    }
    if (prepared.kind === 'state-successor' && !prepared.recoveryTargetAllowed) {
      const target = prepared.rendezvousTarget;
      if (!target) throw new Error('Guest same-run candidate has no exact target to prime');
      await this.#primePreparedCandidate(room, prepared, target.positionSeconds);
      this.#assertPrepared(room, prepared);
    } else {
      // A cancelled-attempt recovery may be assigned a newly projected target
      // only by its later ARM. Keep that legacy path explicitly unprimed until
      // a target-ready recovery handshake exists.
      prepared.primedPositionSeconds = null;
    }
    const quality = Reflect.apply(channelQuality, this.#context.channel, []);
    const participant = this.#runtime.createParticipant({
      participantId: this.#context.guestParticipantId,
      rttP95Ms: quality.rttP95Ms,
      armP95Ms: this.#armP95Ms,
      manager: this.#manager,
      candidatePort: staged.cutoverPort,
    });
    if (!isParticipant(participant, this.#context.guestParticipantId)) {
      throw new TypeError('Guest recovery participant is invalid');
    }
    prepared.participant = participant;
    prepared.readyPublished = false;
    prepared.status = 'ready';
  }

  async #primePreparedCandidate(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    positionSeconds: number,
  ): Promise<void> {
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
      throw new RangeError('Guest candidate prime position is invalid');
    }
    const staged = prepared.staged;
    if (!staged) throw new Error('Guest candidate prime has no exact staged source');
    this.#assertPrepared(room, prepared);
    const primeTask = this.#runtime.primeCandidate(
      this.#manager,
      staged.cutoverPort,
      positionSeconds,
      this.#preparedSignal(prepared),
    );
    if (!(primeTask instanceof Promise)) {
      throw new TypeError('Guest candidate prime must return a native Promise');
    }
    await primeTask;
    this.#assertPrepared(room, prepared);
    if (prepared.staged !== staged) {
      throw new Error('Guest candidate changed while its target position was priming');
    }
    prepared.primedPositionSeconds = positionSeconds;
  }

  async #publishSameSourceReady(room: GuestRoomState, prepared: GuestPreparedRun): Promise<void> {
    this.#assertPrepared(room, prepared);
    const preparation = prepared.statePreparation;
    const staged = prepared.staged;
    if (
      !staged ||
      !prepared.participant ||
      prepared.status !== 'ready' ||
      prepared.readyPublished ||
      (prepared.kind === 'state-successor' && !preparation)
    ) {
      throw new Error('Guest same-source preparation did not produce an exact ready candidate');
    }
    const observedAtRoomTimeMs = this.#nowRoomTimeMs();
    const payload = {
      kind: 'source-ready',
      observedAtRoomTimeMs,
      readyLeaseUntilRoomTimeMs: observedAtRoomTimeMs + this.#readyLeaseMs,
      backend: staged.backend,
      durationSeconds: staged.readiness.durationSeconds,
      bufferedAheadSeconds: staged.readiness.bufferedAheadSeconds,
      outputSampleRateHz: staged.readiness.outputSampleRateHz,
      channelCount: staged.readiness.channelCount,
    } as const;
    const wire =
      prepared.kind === 'state-successor'
        ? this.#mediaSession.createStatePreparationSourceWire(preparation!, payload)
        : prepared.kind === 'successor'
          ? this.#mediaSession.createCandidateSourceReadyWire(prepared.operation, payload)
          : this.#mediaSession.createPreparedSourceReadyWire(prepared.operation, payload);
    this.#assertPrepared(room, prepared);
    await this.#sendRequired(wire);
    this.#assertPrepared(room, prepared);
    prepared.readyPublished = true;
  }

  async #stagePreparedAsset(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    graph: Readonly<FilePlaybackProductGuestAudioGraph>,
    clockBindings: Readonly<FilePlaybackClockBindings>,
  ): Promise<Readonly<StagedFilePlaybackAssetSource>> {
    const operation = prepared.operation;
    const assetLease = prepared.assetLease;
    if (!assetLease) throw new Error('Guest prepared source has no exact asset lease');
    if (operation.offer.transport !== 'peer-range-manifest') {
      return this.#runtime.stageAssetSource({
        registry: this.#registry,
        roomToken: this.#roomToken,
        assetLease,
        expectedBinding: assetBinding(operation),
        manager: this.#manager,
        audioContext: graph.audioContext,
        destination: graph.destination,
        clockBindings,
        signal: this.#preparedSignal(prepared),
        isCurrent: () => this.#preparedCurrent(room, prepared),
        decodeOrdinaryAudio: this.#decodeOrdinaryAudio,
        ...(this.#boundedRoutePolicy ? { boundedRoutePolicy: this.#boundedRoutePolicy } : {}),
      });
    }

    const manifestAdmission = prepared.manifestAdmission;
    if (!manifestAdmission) {
      throw new Error('Guest manifest source has no exact admission authority');
    }
    const construction = await this.#runtime.prepareManifestDecoderConstruction({
      registry: this.#registry,
      roomToken: this.#roomToken,
      assetLease,
      manifestAdmission,
      signal: this.#preparedSignal(prepared),
    });
    try {
      this.#assertPrepared(room, prepared);
      const diagnostics = snapshotExactRecord(construction, MANIFEST_CONSTRUCTION_KEYS);
      if (
        !diagnostics ||
        (diagnostics.codec !== 'adts-aac-lc' && diagnostics.codec !== 'mp3-no-frame-count') ||
        diagnostics.queueItemId !== operation.binding.queueItemId ||
        diagnostics.sourceIdentity !== operation.binding.sourceIdentity ||
        diagnostics.sourceSize !== operation.offer.encodedSize
      ) {
        throw new Error('Guest manifest decoder construction changed its exact asset binding');
      }
      if (
        !isFilePlaybackPeerRangeManifestCodecEnabled(
          this.#manifestBoundedRoutePolicy,
          diagnostics.codec,
        )
      ) {
        throw new Error('FILE_PLAYBACK_PEER_RANGE_MANIFEST_CODEC_GATED_OFF');
      }
      return await this.#runtime.stageManifestAssetSource({
        construction,
        registry: this.#registry,
        roomToken: this.#roomToken,
        assetLease,
        expectedBinding: assetBinding(operation),
        manager: this.#manager,
        audioContext: graph.audioContext,
        destination: graph.destination,
        clockBindings,
        signal: this.#preparedSignal(prepared),
        isCurrent: () => this.#preparedCurrent(room, prepared),
      });
    } catch (error) {
      try {
        await this.#runtime.retireManifestDecoderConstruction(construction);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Guest manifest decoder construction cleanup failed',
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }

  #scheduleOfferWarm(preparation: Readonly<FilePlaybackConnectionMediaOfferPreparation>): void {
    if (preparation.offer.transport !== 'peer-range') return;
    if (this.#registry.leaseForBinding(this.#roomToken, preparationAssetBinding(preparation))) {
      return;
    }
    const active = this.#offerWarm;
    if (active?.preparation === preparation) return;
    if (active && active.preparation.offer.queueItemId !== preparation.offer.queueItemId) {
      this.#pendingOfferWarm = preparation;
      return;
    }
    this.#beginOfferWarm(preparation, active);
  }

  #beginOfferWarm(
    preparation: Readonly<FilePlaybackConnectionMediaOfferPreparation>,
    previous: GuestOfferWarmOperation | null,
  ): void {
    const controller = new AbortController();
    const operation: GuestOfferWarmOperation = {
      preparation,
      binding: preparationAssetBinding(preparation),
      controller,
      removePreparationAbort: () => undefined,
      task: null,
      provisionalLease: null,
      authority: null,
      claimedBy: null,
      promoted: false,
      retiring: false,
      retirementPromise: null,
    };
    const retireForPreparation = (): void => {
      const reason =
        preparation.fence.signal.reason ??
        new DOMException('Guest source-offer preparation expired', 'AbortError');
      controller.abort(reason);
      this.#observeOfferWarmRetirement(this.#retireOfferWarm(operation, reason));
    };
    preparation.fence.signal.addEventListener('abort', retireForPreparation, { once: true });
    operation.removePreparationAbort = () => {
      preparation.fence.signal.removeEventListener('abort', retireForPreparation);
    };
    this.#offerWarm = operation;
    if (this.#pendingOfferWarm === preparation) this.#pendingOfferWarm = null;
    const task = Promise.resolve().then(() => this.#executeOfferWarm(operation, previous));
    operation.task = task;
    void task.catch((error: unknown) => {
      if (error instanceof GuestOfferWarmCleanupError && !this.#closed) {
        this.#fatal('Guest offer warm cleanup failed', error);
      }
      const retirement = operation.retirementPromise;
      if (retirement) {
        const lateCleanup = retirement.then(
          () => this.#cleanupOfferWarmResources(operation),
          () => this.#cleanupOfferWarmResources(operation),
        );
        this.#observeOfferWarmRetirement(lateCleanup);
        return;
      }
      if (
        !this.#closed &&
        this.#offerWarm === operation &&
        (!this.#offerWarmCurrent(operation) ||
          operation.controller.signal.aborted ||
          (!operation.provisionalLease && !operation.authority))
      ) {
        this.#observeOfferWarmRetirement(this.#retireOfferWarm(operation, error));
      }
    });
    if (preparation.fence.signal.aborted) retireForPreparation();
  }

  async #executeOfferWarm(
    operation: GuestOfferWarmOperation,
    previous: GuestOfferWarmOperation | null,
  ): Promise<GuestOfferWarmOutcome> {
    if (previous && previous !== operation) {
      await this.#retireOfferWarm(
        previous,
        new Error('Guest source-offer warm operation was superseded'),
      );
    }
    this.#assertOfferWarm(operation);
    const graph = await this.#resolveOfferWarmAudioGraph(operation);
    const clockBindings = await this.#awaitOfferWarmClockBindings(operation, graph.audioContext);
    this.#assertOfferWarm(operation);

    const offer = operation.preparation.offer;
    if (offer.transport !== 'peer-range') {
      throw new Error('Guest offer warm requires an exact peer-range descriptor');
    }
    const asset = new PeerRangeEncodedAudioAsset({
      size: offer.encodedSize,
      identity: offer.sourceIdentity,
      metadata: { name: offer.name, mime: offer.mime },
      transport: this.#peerTransport,
      handleId: offer.handleId,
    });
    const provisionalLease = Reflect.apply(registryAdmitProvisionalEncoded, this.#registry, [
      this.#roomToken,
      operation.binding,
      asset,
    ]);
    operation.provisionalLease = provisionalLease;
    const snapshot = Reflect.apply(registrySnapshot, this.#registry, [
      this.#roomToken,
      provisionalLease,
    ]);
    if (!sameOfferedAsset(snapshot, operation.binding, operation.preparation)) {
      throw new Error('Guest provisional peer-range asset admission was inconsistent');
    }
    this.#assertOfferWarm(operation);

    const authority = await this.#runtime.prepareWarmSource({
      registry: this.#registry,
      roomToken: this.#roomToken,
      assetLease: provisionalLease,
      expectedBinding: operation.binding,
      audioContext: graph.audioContext,
      clockBindings,
      signal: operation.controller.signal,
      isCurrent: () => this.#offerWarmCurrent(operation),
      decodeOrdinaryAudio: this.#decodeOrdinaryAudio,
      ...(this.#boundedRoutePolicy ? { boundedRoutePolicy: this.#boundedRoutePolicy } : {}),
    });
    operation.authority = authority;
    this.#assertOfferWarm(operation);
    if (authority.backend !== 'bounded-stream') {
      try {
        await this.#runtime.retireWarmSource(authority);
      } catch (error) {
        throw new GuestOfferWarmCleanupError('Guest non-bounded warm source cleanup failed', {
          cause: error,
        });
      }
      operation.authority = null;
      this.#assertOfferWarm(operation);
      return 'cold-retained';
    }
    return 'warmed';
  }

  async #claimOfferWarm(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    graph: Readonly<FilePlaybackProductGuestAudioGraph>,
  ): Promise<Readonly<GuestOfferWarmClaim> | null> {
    const warm = this.#offerWarm;
    if (!warm || warm.preparation.offer !== prepared.operation.offer || !warm.task) return null;

    let outcome: GuestOfferWarmOutcome;
    try {
      outcome = await this.#awaitOwnerTask(warm.task);
    } catch (error) {
      this.#assertPrepared(room, prepared);
      if (error instanceof GuestOfferWarmCleanupError) throw error;
      outcome = 'cold-retained';
    }
    this.#assertPrepared(room, prepared);
    if (warm.retiring || warm.retirementPromise) {
      if (!warm.retirementPromise) return null;
      await this.#awaitOwnerTask(warm.retirementPromise);
      this.#assertPrepared(room, prepared);
      return null;
    }
    if (this.#offerWarm !== warm || warm.preparation.offer !== prepared.operation.offer) {
      return null;
    }
    const provisionalLease = warm.provisionalLease;
    if (!provisionalLease) {
      await this.#retireOfferWarm(
        warm,
        new Error('Guest source-offer warm operation retained no provisional asset'),
      );
      return null;
    }
    const snapshot = Reflect.apply(registrySnapshot, this.#registry, [
      this.#roomToken,
      provisionalLease,
    ]);
    if (!sameOfferedAsset(snapshot, warm.binding, warm.preparation)) {
      throw new Error('Guest source-offer warm asset became stale before RUN handoff');
    }
    this.#assertPrepared(room, prepared);

    const promotedLease = Reflect.apply(registryPromoteProvisional, this.#registry, [
      this.#roomToken,
      provisionalLease,
    ]);
    if (promotedLease !== provisionalLease) {
      throw new Error('Guest source-offer warm promotion changed its exact lease identity');
    }
    warm.promoted = true;
    warm.claimedBy = prepared;
    warm.removePreparationAbort();
    prepared.assetLease = promotedLease;

    const authority = warm.authority;
    if (outcome === 'warmed') {
      if (!authority || authority.backend !== 'bounded-stream') {
        throw new Error('Guest warmed source lost its exact bounded authority');
      }
      try {
        const staged = await this.#runtime.handoffWarmSource({
          authority,
          manager: this.#manager,
          destination: graph.destination,
          signal: prepared.operation.fence.signal,
          isCurrent: () => this.#preparedCurrent(room, prepared),
        });
        // Warm handoff is also a manager ownership transfer. Publish the port
        // to teardown before checking whether the operation stayed current.
        prepared.staged = staged;
        this.#assertPrepared(room, prepared);
        return freezeCanonical({ assetLease: promotedLease, staged });
      } finally {
        this.#settleClaimedOfferWarm(warm);
      }
    }

    this.#settleClaimedOfferWarm(warm);
    return freezeCanonical({ assetLease: promotedLease, staged: null });
  }

  async #awaitOwnerTask<T>(task: Promise<T>): Promise<T> {
    const signal = this.#abort.signal;
    if (signal.aborted) throw signal.reason ?? new Error('Guest media owner was revoked');
    let rejectForAbort!: (reason?: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectForAbort = reject;
    });
    const onAbort = (): void => {
      rejectForAbort(signal.reason ?? new Error('Guest media owner was revoked'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      return await Promise.race([task, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  #settleClaimedOfferWarm(operation: GuestOfferWarmOperation): void {
    operation.removePreparationAbort();
    operation.authority = null;
    operation.provisionalLease = null;
    if (this.#offerWarm === operation) this.#offerWarm = null;
    this.#drainPendingOfferWarm();
  }

  #retireOfferWarm(operation: GuestOfferWarmOperation, reason: unknown): Promise<void> {
    if (operation.retirementPromise) return operation.retirementPromise;
    operation.removePreparationAbort();
    operation.retiring = true;
    const retirement = Promise.resolve().then(async () => {
      const cleanup = this.#cleanupOfferWarmResources(operation);
      const completed = await Promise.race([
        cleanup.then(() => true),
        lifecycleDelay(WARM_CLOSE_GRACE_MS).then(() => false),
      ]);
      if (!completed) {
        throw new GuestOfferWarmCleanupError('Guest warm resource cleanup timed out');
      }
      if (this.#offerWarm === operation) {
        this.#offerWarm = null;
        this.#drainPendingOfferWarm();
      }
    });
    operation.retirementPromise = retirement;
    if (!operation.claimedBy && !operation.promoted) operation.controller.abort(reason);
    return retirement;
  }

  async #cleanupOfferWarmResources(operation: GuestOfferWarmOperation): Promise<void> {
    if (operation.claimedBy || operation.promoted) return;
    const cleanups: Promise<void>[] = [];
    const authority = operation.authority;
    if (authority) {
      operation.authority = null;
      try {
        cleanups.push(
          Promise.resolve(this.#runtime.retireWarmSource(authority)).then(() => undefined),
        );
      } catch (error) {
        cleanups.push(Promise.reject(error));
      }
    }
    const provisionalLease = operation.provisionalLease;
    if (provisionalLease) {
      try {
        const discard = Reflect.apply(registryDiscardProvisional, this.#registry, [
          this.#roomToken,
          provisionalLease,
        ]);
        operation.provisionalLease = null;
        cleanups.push(
          Promise.resolve(discard).then((discarded) => {
            if (discarded !== true) {
              throw new Error('Guest provisional warm asset was not discarded');
            }
          }),
        );
      } catch (error) {
        cleanups.push(Promise.reject(error));
      }
    }
    if (cleanups.length === 0) return;
    const results = await Promise.allSettled(cleanups);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new GuestOfferWarmCleanupError('Guest warm resource cleanup failed', {
        cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
      });
    }
  }

  #observeOfferWarmRetirement(retirement: Promise<void>): void {
    const observed = retirement.then(
      () => undefined,
      (error: unknown) => {
        if (!this.#closed) this.#fatal('Guest detached offer warm cleanup failed', error);
      },
    );
    this.#warmTasks.add(observed);
    void observed.then(() => this.#warmTasks.delete(observed));
  }

  #drainPendingOfferWarm(): void {
    if (this.#closed || this.#offerWarm) return;
    const preparation = this.#pendingOfferWarm;
    this.#pendingOfferWarm = null;
    if (!preparation || preparation.offer.transport !== 'peer-range') return;
    if (!this.#offerPreparationCurrent(preparation)) return;
    const existing = this.#registry.leaseForBinding(
      this.#roomToken,
      preparationAssetBinding(preparation),
    );
    if (existing) return;
    this.#beginOfferWarm(preparation, null);
  }

  #offerPreparationCurrent(
    preparation: Readonly<FilePlaybackConnectionMediaOfferPreparation>,
  ): boolean {
    try {
      return (
        !this.#closed &&
        !this.#abort.signal.aborted &&
        !preparation.fence.signal.aborted &&
        preparation.fence.isCurrent() === true
      );
    } catch {
      return false;
    }
  }

  #offerWarmCurrent(operation: GuestOfferWarmOperation): boolean {
    const claimed = operation.claimedBy;
    if (claimed) {
      const room = this.#room;
      return Boolean(
        room &&
        claimed.operation.offer === operation.preparation.offer &&
        this.#preparedCurrent(room, claimed),
      );
    }
    return (
      !operation.retiring &&
      this.#offerWarm === operation &&
      this.#offerPreparationCurrent(operation.preparation)
    );
  }

  #assertOfferWarm(operation: GuestOfferWarmOperation): void {
    this.#assertLive();
    if (operation.controller.signal.aborted || !this.#offerWarmCurrent(operation)) {
      throw operation.controller.signal.reason ?? new Error('Guest source-offer warm is stale');
    }
    this.#assertLive();
  }

  async #resolveOfferWarmAudioGraph(
    operation: GuestOfferWarmOperation,
  ): Promise<Readonly<FilePlaybackProductGuestAudioGraph>> {
    this.#assertOfferWarm(operation);
    const graph = await this.#resolveSharedAudioGraph();
    this.#assertOfferWarm(operation);
    this.#assertRunningAudioGraph(graph);
    return graph;
  }

  async #awaitOfferWarmClockBindings(
    operation: GuestOfferWarmOperation,
    audioContext: AudioContext,
  ): Promise<Readonly<FilePlaybackClockBindings>> {
    for (;;) {
      this.#assertOfferWarm(operation);
      if (Reflect.apply(channelClockReady, this.#context.channel, [])) {
        const bindings = Reflect.apply(channelClockBindings, this.#context.channel, [audioContext]);
        this.#assertOfferWarm(operation);
        return bindings;
      }
      await this.#runtime.waitForClockPoll(operation.controller.signal);
    }
  }

  async #acquireAsset(
    operation: Readonly<FilePlaybackConnectionMediaOperation>,
  ): Promise<Readonly<FilePlaybackR2WholeBlobAcquisition>> {
    if (operation.offer.transport === 'peer-range-manifest') {
      throw new Error('FILE_PLAYBACK_PEER_RANGE_MANIFEST_GATED_OFF');
    }
    const binding = assetBinding(operation);
    const existingLease = this.#registry.leaseForBinding(this.#roomToken, binding);
    if (existingLease) {
      const snapshot = Reflect.apply(registrySnapshot, this.#registry, [
        this.#roomToken,
        existingLease,
      ]);
      if (!sameAsset(snapshot, binding, operation)) {
        throw new Error('Guest reusable asset binding disagreed with the source offer');
      }
      return freezeCanonical({ assetLease: existingLease, asset: snapshot });
    }
    if (operation.offer.transport === 'r2-whole-blob') {
      return this.#r2Acquirer.acquire(operation);
    }
    if (operation.offer.transport !== 'peer-range') {
      throw new Error('Guest file media transport is unsupported');
    }
    this.#assertLive();
    const asset = new PeerRangeEncodedAudioAsset({
      size: operation.offer.encodedSize,
      identity: operation.offer.sourceIdentity,
      metadata: { name: operation.offer.name, mime: operation.offer.mime },
      transport: this.#peerTransport,
      handleId: operation.offer.handleId,
    });
    const assetLease = Reflect.apply(registryAdmitEncoded, this.#registry, [
      this.#roomToken,
      binding,
      asset,
    ]);
    const snapshot = Reflect.apply(registrySnapshot, this.#registry, [this.#roomToken, assetLease]);
    if (!sameAsset(snapshot, binding, operation) || snapshot.kind !== 'peer-range') {
      throw new Error('Guest peer-range asset registry admission was inconsistent');
    }
    return freezeCanonical({ assetLease, asset: snapshot });
  }

  async #acquireManifestAsset(
    operation: Readonly<FilePlaybackConnectionMediaOperation>,
  ): Promise<Readonly<FilePlaybackPeerRangeManifestAcquisition>> {
    if (operation.offer.transport !== 'peer-range-manifest') {
      throw new Error('Guest manifest acquisition requires an exact manifest operation');
    }
    const acquired = await this.#runtime.acquireManifestAsset({
      operation,
      registry: this.#registry,
      roomToken: this.#roomToken,
      transport: this.#peerTransport,
    });
    if (
      !sameAsset(acquired.asset, assetBinding(operation), operation) ||
      acquired.asset.kind !== 'peer-range' ||
      acquired.manifestAdmission === null ||
      typeof acquired.manifestAdmission !== 'object'
    ) {
      throw new Error('Guest manifest asset acquisition was inconsistent');
    }
    return acquired;
  }

  async #awaitClockBindings(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    audioContext: AudioContext,
  ): Promise<Readonly<FilePlaybackClockBindings>> {
    for (;;) {
      this.#assertPrepared(room, prepared);
      if (Reflect.apply(channelClockReady, this.#context.channel, [])) {
        const bindings = Reflect.apply(channelClockBindings, this.#context.channel, [audioContext]);
        this.#assertPrepared(room, prepared);
        return bindings;
      }
      await this.#runtime.waitForClockPoll(this.#preparedSignal(prepared));
      this.#assertPrepared(room, prepared);
    }
  }

  async #resolveAudioGraph(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
  ): Promise<Readonly<FilePlaybackProductGuestAudioGraph>> {
    this.#assertPrepared(room, prepared);
    const graph = await this.#resolveSharedAudioGraph();
    this.#assertPrepared(room, prepared);
    this.#assertRunningAudioGraph(graph);
    return graph;
  }

  #resolveSharedAudioGraph(): Promise<Readonly<FilePlaybackProductGuestAudioGraph>> {
    if (!this.#audioGraphPromise) {
      let graphTask: Promise<Readonly<FilePlaybackProductGuestAudioGraph>>;
      try {
        graphTask = Reflect.apply(this.#getAudioGraph, undefined, []);
      } catch (error) {
        throw new Error('Guest audio graph provider threw', { cause: error });
      }
      if (!(graphTask instanceof Promise)) {
        throw new TypeError('Guest audio graph provider must return a native Promise');
      }
      const canonicalTask = graphTask.then((value) => {
        const graph = canonicalAudioGraph(value);
        if (!graph) throw new TypeError('Guest audio graph provider returned a mismatched graph');
        return graph;
      });
      this.#audioGraphPromise = canonicalTask;
      void canonicalTask.then(undefined, () => {
        if (this.#audioGraphPromise === canonicalTask) this.#audioGraphPromise = null;
      });
    }
    return this.#audioGraphPromise;
  }

  async #executeArm(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    attempt: GuestAttempt,
  ): Promise<void> {
    this.#assertAttempt(room, prepared, attempt);
    this.#assertRunningAudioGraph(prepared.audioGraph);
    if (
      prepared.primedPositionSeconds !== null &&
      prepared.primedPositionSeconds !== attempt.armIntent.positionSeconds
    ) {
      throw new Error('Guest rendezvous ARM changed an already primed target');
    }
    const receipt = await attempt.participant.arm(attempt.armIntent);
    this.#assertAttempt(room, prepared, attempt);
    const canonical = readRendezvousArmReceipt(receipt);
    if (
      !canonical ||
      canonical.queueItemId !== attempt.identity.queueItemId ||
      canonical.runId !== attempt.identity.runId ||
      canonical.revision !== attempt.identity.revision ||
      canonical.rendezvousId !== attempt.identity.rendezvousId ||
      canonical.participantId !== this.#context.guestParticipantId
    ) {
      throw new Error('Guest rendezvous arm receipt was invalid');
    }
    attempt.armReceipt = canonical;
    const payload = {
      kind: 'rendezvous-armed',
      rendezvousId: canonical.rendezvousId,
      status: canonical.status,
      observedAtRoomTimeMs: canonical.observedAtRoomTimeMs,
      bufferedAheadSeconds: canonical.bufferedAheadSeconds,
      reasonCode: canonical.reasonCode,
    } as const;
    const wire = attempt.stateOperation
      ? this.#mediaSession.createStateAttemptWire(attempt.stateOperation, payload)
      : attempt.admittedAttempt
        ? this.#mediaSession.createPreparedRunAttemptWire(attempt.admittedAttempt, payload)
        : this.#createAttemptWire(attempt.attemptLease, payload);
    await this.#sendRequired(wire);
    this.#assertAttempt(room, prepared, attempt);
  }

  async #executeFinalize(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    attempt: GuestAttempt,
    intent: Readonly<RendezvousFinalizeIntent>,
  ): Promise<void> {
    await attempt.armTask;
    this.#assertAttempt(room, prepared, attempt);
    this.#assertRunningAudioGraph(prepared.audioGraph);
    if (attempt.armReceipt?.status !== 'armed') {
      throw new Error('Guest rendezvous finalize followed a rejected arm');
    }
    const receipt = await attempt.participant.finalize(intent);
    this.#assertAttempt(room, prepared, attempt);
    const canonical = readRendezvousFinalizeReceipt(receipt);
    if (
      !canonical ||
      canonical.queueItemId !== attempt.identity.queueItemId ||
      canonical.runId !== attempt.identity.runId ||
      canonical.revision !== attempt.identity.revision ||
      canonical.rendezvousId !== attempt.identity.rendezvousId ||
      canonical.participantId !== this.#context.guestParticipantId
    ) {
      throw new Error('Guest rendezvous finalize receipt was invalid');
    }
    const finalizedPayload = {
      kind: 'rendezvous-finalized',
      rendezvousId: canonical.rendezvousId,
      status: canonical.status,
      observedAtRoomTimeMs: canonical.observedAtRoomTimeMs,
      reasonCode: canonical.reasonCode,
    } as const;
    const finalizedWire = attempt.stateOperation
      ? this.#mediaSession.createStateAttemptWire(attempt.stateOperation, finalizedPayload)
      : attempt.admittedAttempt
        ? this.#mediaSession.createPreparedRunAttemptWire(attempt.admittedAttempt, finalizedPayload)
        : this.#createAttemptWire(attempt.attemptLease, finalizedPayload);
    await this.#sendRequired(finalizedWire);
    this.#assertAttempt(room, prepared, attempt);
    if (canonical.status !== 'accepted') return;

    const evidenceValue = await attempt.participant.started(attempt.identity);
    this.#assertAttempt(room, prepared, attempt);
    const evidence = canonicalStartEvidence(evidenceValue);
    if (!evidence) throw new Error('Guest physical start evidence was invalid');
    const staged = prepared.staged!;
    const currentPort = this.#runtime.currentPort(this.#manager);
    const snapshot = this.#runtime.currentSnapshot(this.#manager, staged.cutoverPort);
    if (
      currentPort !== staged.cutoverPort ||
      !snapshot ||
      snapshot.phase !== 'playing' ||
      snapshot.backend !== staged.backend ||
      snapshot.queueItemId !== prepared.state.queueItemId ||
      snapshot.run?.queueItemId !== prepared.state.queueItemId ||
      snapshot.run.runId !== prepared.state.runId ||
      snapshot.run.revision !== prepared.state.revision
    ) {
      throw new Error('Guest manager lacks exact physical renderer evidence');
    }
    const canonicalRendezvousTarget =
      prepared.kind === 'successor' || prepared.kind === 'state-successor'
        ? prepared.rendezvousTarget
        : null;
    if (
      (prepared.kind === 'successor' || prepared.kind === 'state-successor') &&
      canonicalRendezvousTarget === null
    ) {
      throw new Error('Guest successor has no canonical rendezvous target');
    }
    this.#assertAttempt(room, prepared, attempt);
    if (!attempt.participant.commitAttempt(attempt.identity)) {
      throw new Error('Guest cutover participant rejected physical commit');
    }
    const afterCommit = this.#runtime.currentSnapshot(this.#manager, staged.cutoverPort);
    if (
      this.#runtime.currentPort(this.#manager) !== staged.cutoverPort ||
      !afterCommit ||
      afterCommit.phase !== 'playing' ||
      afterCommit.run?.revision !== prepared.state.revision
    ) {
      throw new Error('Guest renderer changed during participant commit');
    }
    if (attempt.stateOperation) {
      this.#mediaSession.commitStateSuccessor(attempt.stateOperation, prepared.state, () =>
        this.#physicalMatches(prepared),
      );
    } else if (attempt.admittedAttempt) {
      this.#mediaSession.commitPreparedRunAttemptStarted(
        attempt.admittedAttempt,
        prepared.state,
        () => this.#physicalMatches(prepared),
      );
    } else {
      Reflect.apply(channelCommitAttempt, this.#context.channel, [attempt.attemptLease]);
    }
    attempt.committed = true;
    prepared.status = 'current';
    if (prepared.kind === 'successor' || prepared.kind === 'state-successor') {
      const previous = room.current;
      if (previous && previous !== prepared) previous.status = 'retired';
      room.current = prepared;
      room.candidate = null;
      room.physical = freezeCanonical({
        state: prepared.state,
        phase: 'playing' as const,
        positionSeconds: canonicalRendezvousTarget!.positionSeconds,
      });
    } else if (prepared.kind === 'recovery') {
      const previous = room.current;
      if (previous && previous !== prepared) previous.status = 'retired';
      room.current = prepared;
      room.candidate = null;
    }
    const observedAtRoomTimeMs = this.#nowRoomTimeMs();
    const renderedFrame =
      evidence.kind === 'worklet-observed' ? evidence.actualStartFrame : evidence.targetFrame;
    const healthPayload = {
      kind: 'renderer-health',
      rendezvousId: attempt.rendezvousId,
      value: 'healthy',
      observedAtRoomTimeMs,
      leaseUntilRoomTimeMs: observedAtRoomTimeMs + this.#rendererHealthLeaseMs,
      renderedFrame,
      underrunCount: afterCommit.underrunCount,
      reasonCode: null,
    } as const;
    const healthWire = this.#createRendererHealthWire(attempt, healthPayload);
    await this.#sendRequired(healthWire);
    this.#assertAttempt(room, prepared, attempt);
    if (prepared.kind === 'baseline') {
      this.#publishActiveBaselineTimeline(room, prepared, 'playing');
    }
    if (attempt.stateOperation && prepared.stateOperation === attempt.stateOperation) {
      // The media session retains committed state authority for wire replay.
      // The prepared renderer must stop gating later pause/seek/stop work on
      // this fence because the next ordinary state successor retires it.
      prepared.stateOperation = null;
    }
    this.#startRendererHealthHeartbeat(room, prepared, attempt, renderedFrame);
  }

  #createRendererHealthWire(
    attempt: GuestAttempt,
    payload: Readonly<{
      kind: 'renderer-health';
      rendezvousId: string;
      value: 'healthy';
      observedAtRoomTimeMs: number;
      leaseUntilRoomTimeMs: number;
      renderedFrame: number;
      underrunCount: number;
      reasonCode: null;
    }>,
  ): FilePlaybackWireMessage {
    return attempt.stateOperation
      ? this.#mediaSession.createStateAttemptWire(attempt.stateOperation, payload)
      : attempt.admittedAttempt
        ? this.#mediaSession.createPreparedRunAttemptWire(attempt.admittedAttempt, payload)
        : this.#createAttemptWire(attempt.attemptLease, payload);
  }

  #startRendererHealthHeartbeat(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    attempt: GuestAttempt,
    renderedFrame: number,
  ): void {
    this.#stopRendererHealthHeartbeat();
    const heartbeat: GuestRendererHealthHeartbeat = {
      generation: this.#rendererHealthHeartbeatGeneration,
      room,
      prepared,
      attempt,
      renderedFrame,
      timerHandle: null,
      timerLifecycleLease: null,
    };
    this.#rendererHealthHeartbeat = heartbeat;
    // A successor can be physically current before its canonical timeline
    // update arrives. Retain the exact generation now, but do not publish a
    // heartbeat until both authorities name the same playing state.
    if (this.#rendererHealthSnapshot(heartbeat)) this.#scheduleRendererHealthHeartbeat(heartbeat);
  }

  #scheduleRendererHealthHeartbeat(heartbeat: GuestRendererHealthHeartbeat): void {
    if (
      this.#rendererHealthHeartbeat !== heartbeat ||
      heartbeat.generation !== this.#rendererHealthHeartbeatGeneration ||
      heartbeat.timerHandle !== null ||
      heartbeat.timerLifecycleLease !== null
    ) {
      return;
    }
    if (!this.#rendererHealthSnapshot(heartbeat)) return;

    const timerLifecycleLease = acquireFilePlaybackUniversalLifecycleLease('timers');
    let timerHandle: TimerHandle | null = null;
    let firedSynchronously = false;
    let timerLifecycleSettled = false;
    const releaseTimerLifecycle = (): void => {
      if (timerLifecycleSettled) return;
      timerLifecycleSettled = true;
      timerLifecycleLease.beginRetire().release();
    };
    const forceTimerLifecycle = (): void => {
      if (timerLifecycleSettled) return;
      timerLifecycleSettled = true;
      timerLifecycleLease.forceUnconfirmed();
    };
    try {
      const scheduledHandle = this.#runtime.scheduleTimeout(
        () => {
          if (timerHandle === null) {
            firedSynchronously = true;
            return;
          }
          this.#rendererHealthHeartbeatTimerFired(heartbeat, timerHandle, timerLifecycleLease);
        },
        Math.max(1, Math.floor(this.#rendererHealthLeaseMs / RENDERER_HEALTH_HEARTBEAT_DIVISOR)),
      );
      if (typeof scheduledHandle !== 'string' || scheduledHandle.length === 0) {
        throw new TypeError('Guest renderer-health timer handle is invalid');
      }
      timerHandle = scheduledHandle;
      if (firedSynchronously) {
        try {
          this.#runtime.cancelTimeout(scheduledHandle);
          releaseTimerLifecycle();
        } catch {
          forceTimerLifecycle();
        }
        throw new Error('Guest renderer-health timer fired synchronously while scheduling');
      }
    } catch (error) {
      releaseTimerLifecycle();
      throw error;
    }
    heartbeat.timerHandle = timerHandle;
    heartbeat.timerLifecycleLease = timerLifecycleLease;
  }

  #rendererHealthHeartbeatTimerFired(
    heartbeat: GuestRendererHealthHeartbeat,
    timerHandle: TimerHandle,
    timerLifecycleLease: FilePlaybackUniversalLifecycleLease,
  ): void {
    if (
      this.#rendererHealthHeartbeat !== heartbeat ||
      heartbeat.generation !== this.#rendererHealthHeartbeatGeneration ||
      heartbeat.timerHandle !== timerHandle ||
      heartbeat.timerLifecycleLease !== timerLifecycleLease
    ) {
      return;
    }
    heartbeat.timerHandle = null;
    heartbeat.timerLifecycleLease = null;
    timerLifecycleLease.beginRetire().release();
    if (!this.#rendererHealthSnapshot(heartbeat)) {
      this.#stopRendererHealthHeartbeat();
      return;
    }
    this.#dispatchRendererHealthHeartbeat(heartbeat);
  }

  #dispatchRendererHealthHeartbeat(heartbeat: GuestRendererHealthHeartbeat): void {
    // Candidate acquisition and decoder construction intentionally serialize on
    // the media lane, but they must not consume the live renderer's health
    // lease. This task has its own single-flight cadence (the next timeout is
    // scheduled only after this send settles) while the exact heartbeat
    // generation and attempt lease fence it from every transition and close.
    // Defer the body by one microtask so this tracked identity is published
    // before a send callback can synchronously re-enter revoke or transition.
    const task = Promise.resolve().then(() => this.#publishRendererHealthHeartbeat(heartbeat));
    const tracked = task.catch((error: unknown) => {
      if (!this.#closed) this.#fatal('Guest media owner renderer-health heartbeat failed', error);
    });
    this.#tasks.add(tracked);
    void tracked.then(() => this.#tasks.delete(tracked));
  }

  async #publishRendererHealthHeartbeat(heartbeat: GuestRendererHealthHeartbeat): Promise<void> {
    const snapshot = this.#rendererHealthSnapshot(heartbeat);
    if (!snapshot) {
      this.#stopRendererHealthHeartbeat();
      return;
    }
    const observedAtRoomTimeMs = this.#nowRoomTimeMs();
    if (!this.#rendererHealthSnapshot(heartbeat)) {
      this.#stopRendererHealthHeartbeat();
      return;
    }
    const healthWire = this.#createRendererHealthWire(heartbeat.attempt, {
      kind: 'renderer-health',
      rendezvousId: heartbeat.attempt.rendezvousId,
      value: 'healthy',
      observedAtRoomTimeMs,
      leaseUntilRoomTimeMs: observedAtRoomTimeMs + this.#rendererHealthLeaseMs,
      renderedFrame: heartbeat.renderedFrame,
      underrunCount: snapshot.underrunCount,
      reasonCode: null,
    });
    if (!this.#rendererHealthSnapshot(heartbeat)) {
      this.#stopRendererHealthHeartbeat();
      return;
    }
    await this.#sendRequired(healthWire);
    if (!this.#rendererHealthSnapshot(heartbeat)) {
      this.#stopRendererHealthHeartbeat();
      return;
    }
    this.#scheduleRendererHealthHeartbeat(heartbeat);
  }

  #rendererHealthSnapshot(
    heartbeat: GuestRendererHealthHeartbeat,
  ): FilePlaybackSourceSnapshot | null {
    try {
      const { room, prepared, attempt } = heartbeat;
      const staged = prepared.staged;
      const graph = prepared.audioGraph;
      const timelineState = stateFromTimeline(room.timeline);
      if (
        this.#closed ||
        this.#abort.signal.aborted ||
        this.#rendererHealthHeartbeat !== heartbeat ||
        heartbeat.generation !== this.#rendererHealthHeartbeatGeneration ||
        room !== this.#room ||
        room.current !== prepared ||
        prepared.status !== 'current' ||
        prepared.attempt !== attempt ||
        !attempt.committed ||
        attempt.cancelled ||
        !sameState(prepared.state, attempt.identity) ||
        room.timeline.phase !== 'playing' ||
        !timelineState ||
        !sameState(timelineState, prepared.state) ||
        !staged ||
        !graph ||
        graph.audioContext.state !== 'running' ||
        prepared.operation.fence.signal.aborted ||
        prepared.operation.fence.isCurrent() !== true ||
        this.#runtime.currentPort(this.#manager) !== staged.cutoverPort
      ) {
        return null;
      }
      if (
        attempt.stateOperation &&
        (attempt.stateOperation.fence.signal.aborted ||
          attempt.stateOperation.fence.isCurrent() !== true)
      ) {
        return null;
      }
      if (
        attempt.admittedAttempt &&
        (attempt.admittedAttempt.fence.signal.aborted ||
          attempt.admittedAttempt.fence.isCurrent() !== true)
      ) {
        return null;
      }
      const snapshot = this.#runtime.currentSnapshot(this.#manager, staged.cutoverPort);
      return snapshot &&
        snapshot.phase === 'playing' &&
        snapshot.backend === staged.backend &&
        snapshot.queueItemId === prepared.state.queueItemId &&
        snapshot.run &&
        sameState(snapshot.run, prepared.state) &&
        this.#runtime.currentPort(this.#manager) === staged.cutoverPort
        ? snapshot
        : null;
    } catch {
      return null;
    }
  }

  #stopRendererHealthHeartbeat(prepared?: GuestPreparedRun): void {
    const heartbeat = this.#rendererHealthHeartbeat;
    if (prepared && heartbeat?.prepared !== prepared) return;
    this.#rendererHealthHeartbeatGeneration += 1;
    this.#rendererHealthHeartbeat = null;
    if (!heartbeat) return;
    const timerHandle = heartbeat.timerHandle;
    const timerLifecycleLease = heartbeat.timerLifecycleLease;
    heartbeat.timerHandle = null;
    heartbeat.timerLifecycleLease = null;
    if (timerHandle === null || timerLifecycleLease === null) return;
    try {
      this.#runtime.cancelTimeout(timerHandle);
      timerLifecycleLease.beginRetire().release();
    } catch {
      timerLifecycleLease.forceUnconfirmed();
    }
  }

  #createAttempt(
    prepared: GuestPreparedRun,
    message: Extract<FilePlaybackWireMessage, { readonly kind: 'rendezvous-arm' }>,
    attemptLease: FilePlaybackWireAttemptLease,
    admittedAttempt: Readonly<FilePlaybackConnectionMediaPreparedRunAttempt> | null,
    stateOperation: Readonly<FilePlaybackConnectionMediaStateOperation> | null,
  ): GuestAttempt {
    const identity = attemptIdentity(prepared.state, message.rendezvousId);
    const intent = freezeCanonical({
      protocolVersion: 2 as const,
      kind: 'rendezvous-arm' as const,
      ...identity,
      recipientId: this.#context.guestParticipantId,
      positionSeconds: message.positionSeconds,
      playbackRate: message.playbackRate,
      startAtRoomTimeMs: message.startAtRoomTimeMs,
      finalizeByRoomTimeMs: message.finalizeByRoomTimeMs,
    });
    return {
      rendezvousId: message.rendezvousId,
      attemptLease,
      admittedAttempt,
      stateOperation,
      participant: prepared.participant!,
      identity,
      armIntent: intent,
      armReceipt: null,
      armTask: Promise.resolve(),
      finalizeTask: null,
      committed: false,
      cancelled: false,
    };
  }

  #cancelAuthorityIsCurrent(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    attempt: GuestAttempt,
  ): boolean {
    if (
      attempt.cancelled ||
      attempt.committed ||
      prepared.attempt !== attempt ||
      prepared.participant !== attempt.participant ||
      !this.#preparedCurrent(room, prepared)
    ) {
      return false;
    }
    try {
      if (attempt.stateOperation) {
        return (
          prepared.kind === 'state-successor' &&
          prepared.stateOperation === attempt.stateOperation &&
          attempt.admittedAttempt === null &&
          !attempt.stateOperation.fence.signal.aborted &&
          attempt.stateOperation.fence.isCurrent() === true
        );
      }
      if (attempt.admittedAttempt) {
        return (
          prepared.kind === 'successor' &&
          attempt.stateOperation === null &&
          !attempt.admittedAttempt.fence.signal.aborted &&
          attempt.admittedAttempt.fence.isCurrent() === true
        );
      }
      return (
        (prepared.kind === 'baseline' || prepared.kind === 'recovery') &&
        attempt.stateOperation === null &&
        attempt.admittedAttempt === null
      );
    } catch {
      return false;
    }
  }

  #cancelAttempt(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    attempt: GuestAttempt,
    intent: Readonly<FilePlaybackCancelIntent>,
    disposition: 'retry' | 'terminal',
  ): void {
    const retiringStaged = prepared.staged;
    if (!retiringStaged) {
      throw new Error('Guest rendezvous cancellation lost its exact staged source');
    }
    const terminalCurrent = disposition === 'terminal' ? room.current : null;
    const terminalSurvivor = terminalCurrent?.staged?.cutoverPort ?? null;
    if (
      disposition === 'terminal' &&
      (!terminalCurrent ||
        terminalCurrent === prepared ||
        terminalSurvivor === null ||
        this.#runtime.currentPort(this.#manager) !== terminalSurvivor ||
        this.#runtime.recoveryRequired(this.#manager))
    ) {
      throw new Error('Guest terminal recovery cancellation has no exact current survivor');
    }
    const participantCancellation = invokePhysicalCleanup(() => attempt.participant.cancel(intent));
    // The cancellation can reject before the ordered media lane reaches it.
    // Attach a rejection observer now, while the lane still awaits and
    // rethrows the original Promise for fail-close handling below.
    void participantCancellation.catch(() => undefined);
    let restageAfterCancellation = false;
    // Track physical retirement immediately. The one-shot manager participant
    // destroys its exact cutover port, so a valid retry must wait for that
    // cleanup before re-staging from the retained in-memory asset.
    this.#enqueuePhysicalCleanup('rendezvous cancel cleanup', async () => {
      await participantCancellation;
      if (this.#closed) return;
      if (disposition === 'terminal') {
        if (
          prepared.staged !== retiringStaged ||
          room.candidate !== prepared ||
          room.current !== terminalCurrent ||
          terminalCurrent?.staged?.cutoverPort !== terminalSurvivor ||
          this.#runtime.currentPort(this.#manager) !== terminalSurvivor ||
          this.#runtime.recoveryRequired(this.#manager)
        ) {
          throw new Error(
            'Guest terminal recovery cancellation could not preserve the current renderer',
          );
        }
        prepared.staged = null;
        room.candidate = null;
        return;
      }
      if (!restageAfterCancellation) return;
      this.#assertPrepared(room, prepared);
      if (prepared.staged !== retiringStaged) {
        throw new Error('Guest rendezvous cancellation replaced its staged source');
      }
      // Keep the exact old port reachable until participant cancellation has
      // physically retired it. A rejected cancellation closes the owner while
      // this reference is still present, allowing forced retirement to find it.
      prepared.staged = null;
      await this.#prepareSameSourceCandidate(room, prepared);
      await this.#publishSameSourceReady(room, prepared);
    });
    try {
      if (attempt.stateOperation) {
        const preparation = this.#mediaSession.retireStateSuccessorAttempt(attempt.stateOperation);
        if (prepared.stateOperation === attempt.stateOperation) prepared.stateOperation = null;
        prepared.statePreparation = preparation;
      } else if (attempt.admittedAttempt) {
        this.#mediaSession.retirePreparedRunAttempt(attempt.admittedAttempt);
      } else {
        Reflect.apply(channelRetireAttempt, this.#context.channel, [attempt.attemptLease]);
      }
      if (disposition === 'retry') {
        prepared.recoveryTargetAllowed = true;
        restageAfterCancellation = true;
      }
    } finally {
      if (prepared.attempt === attempt) prepared.attempt = null;
      prepared.readyPublished = false;
      prepared.participant = null;
      prepared.status = disposition === 'terminal' ? 'retired' : 'preparing';
    }
  }

  async #applyStateSuccessor(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    expected: Readonly<PlaybackStateIdentity>,
    successor: Readonly<PlaybackStateIdentity>,
    message: Extract<
      FilePlaybackWireMessage,
      {
        readonly kind:
          | 'file-playback-pause'
          | 'file-playback-seek'
          | 'file-playback-stop'
          | 'file-playback-ended';
      }
    >,
    stateLease: FilePlaybackWireStateLease,
  ): Promise<void> {
    this.#assertPrepared(room, prepared);
    if (message.kind === 'file-playback-ended') {
      this.#assertAudioGraphIdentity(prepared.audioGraph);
    } else {
      this.#assertRunningAudioGraph(prepared.audioGraph);
    }
    const port = prepared.staged?.cutoverPort;
    if (!port || this.#runtime.currentPort(this.#manager) !== port) {
      throw new Error('Guest state successor has no exact current renderer');
    }
    if (message.kind === 'file-playback-ended') {
      const intent: Readonly<FilePlaybackRemoteEndedTransitionIntent> = freezeCanonical({
        kind: 'file-playback-remote-ended-transition' as const,
        from: expected,
        to: successor,
        hostObservedAtRoomTimeMs: message.hostObservedAtRoomTimeMs,
      });
      const evidence = await this.#runtime.remoteEndCurrent(this.#manager, port, intent);
      this.#assertPrepared(room, prepared);
      if (!readFilePlaybackRemoteEndedTransitionEvidence(evidence, intent)) {
        throw new Error('Guest remote-end retirement evidence is invalid');
      }
      this.#mediaSession.commitAdmittedStop(
        prepared.operation,
        expected,
        successor,
        stateLease,
        () => this.#room === room && room.current === prepared,
      );
      prepared.status = 'retired';
      room.current = null;
      room.physical = freezeCanonical({
        state: successor,
        phase: 'stopped' as const,
        positionSeconds: 0,
      });
      return;
    }
    if (message.kind === 'file-playback-stop') {
      const graph = prepared.audioGraph!;
      const bindings = Reflect.apply(channelClockBindings, this.#context.channel, [
        graph.audioContext,
      ]);
      const contextTimeSeconds = bindings.roomTimeMsToContextTime(message.atRoomTimeMs);
      const targetFrame = Math.round(contextTimeSeconds * graph.audioContext.sampleRate);
      const intent: Readonly<FilePlaybackStopTransitionIntent> = freezeCanonical({
        kind: 'file-playback-stop-transition' as const,
        from: expected,
        to: successor,
        atRoomTimeMs: message.atRoomTimeMs,
        target: freezeCanonical({
          audioContext: graph.audioContext,
          contextTimeSeconds,
          targetFrame,
        }),
      });
      const result = await this.#runtime.stopCurrent(this.#manager, port, intent);
      this.#assertPrepared(room, prepared);
      if (result.status !== 'scheduled') throw new Error('Guest native stop was not scheduled');
      await result.applied;
      this.#assertLive();
      this.#mediaSession.commitAdmittedStop(
        prepared.operation,
        expected,
        successor,
        stateLease,
        () => this.#room === room && room.current === prepared,
      );
      prepared.status = 'retired';
      room.current = null;
      room.physical = freezeCanonical({
        state: successor,
        phase: 'stopped' as const,
        positionSeconds: 0,
      });
      return;
    }

    const intent: Readonly<FilePlaybackPauseTransitionIntent | FilePlaybackSeekTransitionIntent> =
      message.kind === 'file-playback-pause'
        ? freezeCanonical({
            kind: 'file-playback-pause-transition' as const,
            from: expected,
            to: successor,
            atRoomTimeMs: message.atRoomTimeMs,
          })
        : freezeCanonical({
            kind: 'file-playback-seek-transition' as const,
            from: expected,
            to: successor,
            positionSeconds: message.positionSeconds,
            atRoomTimeMs: message.atRoomTimeMs,
          });
    const result =
      intent.kind === 'file-playback-pause-transition'
        ? await this.#runtime.pauseCurrent(this.#manager, port, intent)
        : await this.#runtime.seekCurrent(this.#manager, port, intent);
    this.#assertPrepared(room, prepared);
    if (result.status !== 'scheduled') {
      throw new Error(`Guest native ${message.kind} was rejected: ${result.reason}`);
    }
    await result.applied;
    this.#assertPrepared(room, prepared);
    this.#mediaSession.commitAdmittedStateSuccessor(
      prepared.operation,
      expected,
      successor,
      stateLease,
      () => this.#preparedCurrent(room, prepared),
    );
    prepared.state = successor;
    room.physical = freezeCanonical({
      state: successor,
      phase: 'paused' as const,
      positionSeconds: message.kind === 'file-playback-seek' ? message.positionSeconds : null,
    });
  }

  #publishActiveBaselineTimeline(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    phase: 'playing' | 'paused',
  ): void {
    this.#assertPrepared(room, prepared);
    const timeline = room.timeline;
    const timelineState = stateFromTimeline(timeline);
    const media = this.#mediaSession.snapshot();
    if (
      prepared.kind !== 'baseline' ||
      room.current !== prepared ||
      room.activeBaselineProjected ||
      timeline.phase !== phase ||
      !timelineState ||
      !sameState(timelineState, prepared.state) ||
      media.status !== 'active' ||
      media.current?.kind !== 'baseline' ||
      !media.currentState ||
      !sameState(media.currentState, prepared.state)
    ) {
      throw new Error('Guest active baseline projection authority is invalid');
    }
    if (phase === 'playing') {
      if (
        prepared.status !== 'current' ||
        prepared.attempt?.committed !== true ||
        !this.#physicalMatches(prepared)
      ) {
        throw new Error('Guest playing baseline lacks exact physical renderer evidence');
      }
    } else if (
      prepared.status !== 'ready' ||
      !prepared.readyPublished ||
      prepared.attempt !== null
    ) {
      throw new Error('Guest paused baseline lacks exact prepared source evidence');
    }
    room.activeBaselineProjected = true;
    this.#publishTimelineRendered(room, timeline);
  }

  #publishTimelineRendered(
    room: GuestRoomState,
    timeline: Readonly<PlaybackTimelineSnapshot>,
  ): void {
    this.#assertRoom(room);
    this.#timelineCallbackActive = true;
    try {
      Reflect.apply(this.#onTimelineRendered, undefined, [timeline]);
    } finally {
      this.#timelineCallbackActive = false;
    }
    this.#assertRoom(room);
  }

  async #commitTimelineUpdate(
    room: GuestRoomState,
    timeline: Readonly<PlaybackTimelineSnapshot>,
  ): Promise<void> {
    this.#assertRoom(room);
    if (sameTimeline(room.timeline, timeline)) return;
    if (timeline.revision !== room.timeline.revision + 1) {
      throw new Error('Guest rendered timeline skipped or replayed a stale revision');
    }
    const physical = room.physical;
    if (
      !physical ||
      physical.state.revision !== timeline.revision ||
      physical.phase !== timeline.phase
    ) {
      throw new Error('Guest timeline metadata arrived before its physical commit');
    }
    const timelineState = stateFromTimeline(timeline);
    if (timeline.phase === 'stopped') {
      if (timelineState !== null || room.current !== null) {
        throw new Error('Guest stopped timeline retained a renderer');
      }
    } else if (
      !timelineState ||
      !sameState(timelineState, physical.state) ||
      !room.current ||
      !sameState(room.current.state, timelineState)
    ) {
      throw new Error('Guest timeline metadata does not match its current renderer');
    }
    if (
      physical.positionSeconds !== null &&
      timeline.positionSeconds !== physical.positionSeconds
    ) {
      throw new Error('Guest timeline position disagreed with native transition');
    }
    room.timeline = timeline;
    room.physical = null;
    this.#assertRoom(room);
    const heartbeat = this.#rendererHealthHeartbeat;
    if (heartbeat) this.#scheduleRendererHealthHeartbeat(heartbeat);
    this.#publishTimelineRendered(room, timeline);
  }

  #preparedForMessage(
    room: GuestRoomState,
    message: Readonly<FilePlaybackWireMessage>,
  ): GuestPreparedRun | null {
    const candidate = room.candidate;
    if (candidate && messageMatchesPrepared(message, this.#context, candidate)) return candidate;
    const current = room.current;
    if (current && messageMatchesPrepared(message, this.#context, current)) return current;
    return null;
  }

  #physicalMatches(prepared: GuestPreparedRun): boolean {
    const staged = prepared.staged;
    if (!staged || this.#runtime.currentPort(this.#manager) !== staged.cutoverPort) return false;
    const snapshot = this.#runtime.currentSnapshot(this.#manager, staged.cutoverPort);
    return Boolean(
      snapshot &&
      snapshot.phase === 'playing' &&
      snapshot.run &&
      sameState(snapshot.run, prepared.state),
    );
  }

  #createAttemptWire(
    lease: FilePlaybackWireAttemptLease,
    payload: unknown,
  ): FilePlaybackWireMessage {
    return Reflect.apply(channelCreateWire, this.#context.channel, [
      lease as FilePlaybackWireLease,
      payload,
    ]) as FilePlaybackWireMessage;
  }

  async #sendPeerControl(frame: PeerRangeControlFrame): Promise<void> {
    await this.#sendRequired(frame);
  }

  async #sendRequired(frame: unknown): Promise<void> {
    this.#assertLive();
    const accepted = await Promise.resolve(
      Reflect.apply(this.#sendRequiredCallback, undefined, [this.#context, frame]),
    );
    this.#assertLive();
    if (accepted !== true) throw new Error('Guest media owner required send failed');
  }

  #assertAuxiliaryEvent(event: ExactRecord | null): void {
    this.#assertLive();
    if (
      !event ||
      event.connection !== this.#context.connection ||
      event.channel !== this.#context.channel ||
      event.connectionToken !== this.#context.connectionToken
    ) {
      throw new Error('Guest auxiliary event context is stale');
    }
  }

  #assertPeerEvent(event: ExactRecord | null): void {
    this.#assertLive();
    if (
      !event ||
      event.connection !== this.#context.connection ||
      event.channel !== this.#context.channel ||
      event.connectionToken !== this.#context.connectionToken ||
      event.role !== 'guest' ||
      event.lane !== 'bulk'
    ) {
      throw new Error('Guest peer-range event context is stale');
    }
  }

  #assertWireEvent(event: ExactRecord | null): void {
    this.#assertLive();
    if (
      !event ||
      event.connection !== this.#context.connection ||
      event.channel !== this.#context.channel ||
      event.message === null ||
      typeof event.message !== 'object' ||
      event.stateLease === null ||
      typeof event.stateLease !== 'object'
    ) {
      throw new Error('Guest wire event context is stale');
    }
  }

  #frameType(value: unknown): string | null {
    try {
      const descriptor =
        value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'type') : null;
      return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
        ? (descriptor.value as string)
        : null;
    } catch {
      return null;
    }
  }

  #requireRoom(): GuestRoomState {
    this.#assertLive();
    if (!this.#room) throw new Error('Guest PRODUCT READY timeline is unavailable');
    return this.#room;
  }

  #assertRoom(room: GuestRoomState): void {
    this.#assertLive();
    if (this.#room !== room) throw new Error('Guest room state is stale');
  }

  #preparedCurrent(room: GuestRoomState, prepared: GuestPreparedRun): boolean {
    try {
      const stateFence = prepared.stateOperation?.fence ?? prepared.statePreparation?.fence ?? null;
      return (
        !this.#closed &&
        this.#room === room &&
        (room.current === prepared || room.candidate === prepared) &&
        prepared.status !== 'retired' &&
        !this.#abort.signal.aborted &&
        !prepared.operation.fence.signal.aborted &&
        prepared.operation.fence.isCurrent() === true &&
        (!stateFence || (!stateFence.signal.aborted && stateFence.isCurrent() === true))
      );
    } catch {
      return false;
    }
  }

  #preparedSignal(prepared: GuestPreparedRun): AbortSignal {
    return (
      prepared.stateOperation?.fence.signal ??
      prepared.statePreparation?.fence.signal ??
      prepared.operation.fence.signal
    );
  }

  #assertPrepared(room: GuestRoomState, prepared: GuestPreparedRun): void {
    this.#assertLive();
    if (!this.#preparedCurrent(room, prepared)) {
      throw new Error('Guest prepared media operation is stale');
    }
    this.#assertLive();
  }

  #assertAttempt(room: GuestRoomState, prepared: GuestPreparedRun, attempt: GuestAttempt): void {
    if (attempt.cancelled) throw new GuestRendezvousAttemptCancelledError();
    this.#assertPrepared(room, prepared);
    if (prepared.attempt !== attempt) throw new Error('Guest rendezvous attempt is stale');
  }

  #assertRunningAudioGraph(
    graph: Readonly<FilePlaybackProductGuestAudioGraph> | null,
  ): asserts graph is Readonly<FilePlaybackProductGuestAudioGraph> {
    this.#assertAudioGraphIdentity(graph);
    if (graph.audioContext.state !== 'running') {
      throw new Error('Guest file playback AudioContext is not running');
    }
  }

  #assertAudioGraphIdentity(
    graph: Readonly<FilePlaybackProductGuestAudioGraph> | null,
  ): asserts graph is Readonly<FilePlaybackProductGuestAudioGraph> {
    if (!graph) throw new Error('Guest file playback audio graph is unavailable');
    let destinationContext: BaseAudioContext | null = null;
    try {
      destinationContext = graph.destination.context;
    } catch {
      // The exact mismatch is handled below.
    }
    if (destinationContext !== graph.audioContext) {
      throw new Error('Guest file playback audio graph became stale');
    }
  }

  #assertLive(): void {
    if (this.#closed || this.#abort.signal.aborted) {
      throw this.#fatalError ?? new Error('Guest media owner is revoked');
    }
    if (this.#timelineCallbackActive) {
      throw this.#fatal('Guest timeline rendered callback re-entered its owner');
    }
    try {
      const binding = Reflect.apply(channelBinding, this.#context.channel, []);
      if (
        Reflect.apply(channelClosed, this.#context.channel, []) ||
        Reflect.apply(channelRole, this.#context.channel, []) !== 'guest' ||
        Reflect.apply(channelToken, this.#context.channel, []) !== this.#context.connectionToken ||
        !binding ||
        binding.sessionId !== this.#context.sessionId ||
        binding.connectionId !== this.#context.connectionId ||
        binding.hostParticipantId !== this.#context.hostParticipantId ||
        binding.guestParticipantId !== this.#context.guestParticipantId
      ) {
        throw new Error('stale connection channel');
      }
    } catch {
      throw this.#fatal('Guest media owner connection authority is stale');
    }
  }

  #nowRoomTimeMs(): number {
    this.#assertLive();
    const value = Reflect.apply(channelNowRoomTime, this.#context.channel, []);
    if (!finiteNonNegative(value)) throw new Error('Guest room time is invalid');
    this.#assertLive();
    return value;
  }

  #enqueue(label: string, operation: () => Promise<void>): void {
    const task = this.#lane.then(async () => {
      this.#assertLive();
      await operation();
      this.#assertLive();
    });
    const tracked = task.catch((error: unknown) => {
      if (error instanceof GuestRendezvousAttemptCancelledError) return;
      if (!this.#closed) this.#fatal(`Guest media owner ${label} failed`, error);
    });
    this.#lane = tracked;
    this.#tasks.add(tracked);
    void tracked.then(() => this.#tasks.delete(tracked));
  }

  #enqueuePhysicalCleanup(label: string, operation: () => Promise<void>): void {
    // Unlike ordinary media work, physical cleanup must run and settle even
    // after an acknowledgement synchronously revokes this owner. Register its
    // exact identity before ACK so close snapshots cannot miss the barrier.
    const task = this.#lane.then(operation);
    const tracked = task.catch((error: unknown) => {
      if (!this.#closed) this.#fatal(`Guest media owner ${label} failed`, error);
    });
    this.#lane = tracked;
    this.#tasks.add(tracked);
    void tracked.then(() => this.#tasks.delete(tracked));
  }

  #beginClose(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    let settleClose!: () => void;
    const stableClosePromise = new Promise<void>((resolve) => {
      settleClose = resolve;
    });
    // Publish the one stable close identity before abort/revoke/transport code
    // can synchronously re-enter through a callback.
    this.#closePromise = stableClosePromise;
    const physicalRetirement = (() => {
      try {
        this.#stopRendererHealthHeartbeat();
        this.#closed = true;
        const reason = this.#fatalError ?? new Error('Guest media owner revoked');
        const warm = this.#offerWarm;
        this.#pendingOfferWarm = null;
        this.#abort.abort(reason);
        this.#mediaSession.revoke();
        const warmRetirement = warm ? this.#retireOfferWarm(warm, reason) : Promise.resolve();
        const warmTasks = [...this.#warmTasks, warmRetirement];
        const closePeerTransport = (): Promise<void> =>
          invokePhysicalCleanup(() => this.#peerTransport.close(reason));
        const peerCloseTask =
          warm || this.#warmTasks.size > 0
            ? Promise.race([
                Promise.allSettled(warmTasks),
                lifecycleDelay(WARM_CLOSE_GRACE_MS),
              ]).then(closePeerTransport)
            : closePeerTransport();
        const tasks = [...this.#tasks];
        const retiredPorts = new Set<FilePlaybackCutoverCandidatePort>();
        const retirePreparedPorts = async (): Promise<void> => {
          const ports = new Set(
            [this.#room?.current, this.#room?.candidate]
              .filter((value): value is GuestPreparedRun => Boolean(value?.staged))
              .map((prepared) => prepared.staged!.cutoverPort),
          );
          await settlePhysicalCleanupStrictly(
            [...ports]
              .filter((port) => {
                if (retiredPorts.has(port)) return false;
                retiredPorts.add(port);
                return true;
              })
              .map(async (port) => {
                const current = this.#runtime.currentPort(this.#manager);
                if (current === port) await this.#runtime.retireCurrent(this.#manager, port);
                else await this.#runtime.retireCandidate(this.#manager, port);
              }),
            'Multiple prepared guest playback ports failed to retire',
          );
        };
        const initialRetirement = retirePreparedPorts();
        const operationDrain = Promise.allSettled(tasks).then(() => undefined);
        const finalPreparedRetirement = operationDrain.then(() => retirePreparedPorts());
        const preparedRetirement = settlePhysicalCleanupStrictly(
          [initialRetirement, finalPreparedRetirement],
          'Multiple guest playback port retirement barriers failed',
        );
        return settlePhysicalCleanupStrictly(
          [
            invokePhysicalCleanup(() => this.#r2Acquirer.close()),
            peerCloseTask,
            preparedRetirement,
          ],
          'Multiple guest media owner cleanup operations failed',
        );
      } catch (cause) {
        return Promise.reject(cause);
      }
    })();
    void physicalRetirement.then(settleClose, settleClose);
    void confirmFilePlaybackUniversalLifecycleRetirement(
      this.#lifecycleLease,
      () => physicalRetirement,
    );
    return stableClosePromise;
  }

  #fatal(message: string, cause?: unknown): FilePlaybackProductGuestMediaOwnerFatalError {
    if (this.#fatalError) return this.#fatalError;
    const error = new FilePlaybackProductGuestMediaOwnerFatalError(
      message,
      cause === undefined ? undefined : { cause },
    );
    this.#fatalError = error;
    void this.#beginClose();
    if (!this.#fatalPublished) {
      this.#fatalPublished = true;
      try {
        this.#onFatalConnection(this.#context, error);
      } catch {
        // The exact connection is already quarantined and closing.
      }
    }
    return error;
  }
}

/**
 * Constructs one exact guest connection owner. The five-method null-prototype
 * result is directly compatible with the router once its timeline callback is
 * added to the guest owner port contract.
 */
export function createFilePlaybackProductGuestMediaOwner(
  options: FilePlaybackProductGuestMediaOwnerOptions,
): Readonly<FilePlaybackProductGuestMediaOwnerPort> {
  const owner = new GuestMediaOwner(options);
  return freezeCanonical({
    onTimelineAdopted: (event: FilePlaybackApplicationTimelineAdoptedEvent) =>
      owner.onTimelineAdopted(event),
    onTimelineUpdated: (event: FilePlaybackApplicationTimelineUpdatedEvent) =>
      owner.onTimelineUpdated(event),
    adoptAuxiliaryMessage: (
      event: Readonly<FilePlaybackAuxiliaryAdoptionEvent>,
      acknowledge: () => void,
    ) => owner.adoptAuxiliaryMessage(event, acknowledge),
    adoptWireMessage: (event: Readonly<FilePlaybackWireAdoptionEvent>, acknowledge: () => void) =>
      owner.adoptWireMessage(event, acknowledge),
    adoptPeerRangeBulk: (
      event: Readonly<FilePlaybackPeerRangeAdoptionEvent>,
      acknowledge: () => void,
    ) => owner.adoptPeerRangeBulk(event, acknowledge),
    revoke: (context: Readonly<FilePlaybackProductSessionRouterConnectionContext>) =>
      owner.revoke(context),
  });
}
