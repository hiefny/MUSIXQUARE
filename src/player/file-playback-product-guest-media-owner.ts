import type {
  FilePlaybackAuxiliaryAdoptionEvent,
  FilePlaybackPeerRangeAdoptionEvent,
  FilePlaybackWireAdoptionEvent,
} from '../network/file-playback-application-session.ts';
import { delay } from '../core/timers.ts';
import { FilePlaybackConnectionChannel } from '../network/file-playback-connection-channel.ts';
import {
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
} from './file-playback-asset-registry.ts';
import {
  stageFilePlaybackAssetSource,
  type StageFilePlaybackAssetSourceOptions,
  type StagedFilePlaybackAssetSource,
} from './file-playback-asset-source-stager.ts';
import type { FilePlaybackClockBindings } from './file-playback-clock.ts';
import {
  FilePlaybackConnectionMediaSession,
  type FilePlaybackConnectionMediaOperation,
  type FilePlaybackConnectionMediaPreparedRunAttempt,
} from './file-playback-connection-media-session.ts';
import {
  FilePlaybackManager,
  isExactFilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from './file-playback-manager.ts';
import type {
  FilePlaybackProductSessionRouterConnectionContext,
  FilePlaybackProductSessionRouterGuestMediaOwnerPort,
} from './file-playback-product-session-router.ts';
import {
  FilePlaybackR2WholeBlobAcquirer,
  type FilePlaybackR2WholeBlobAcquirerOptions,
  type FilePlaybackR2WholeBlobAcquisition,
} from './file-playback-r2-whole-blob-acquirer.ts';
import {
  readFilePlaybackStartEvidence,
  type FilePlaybackSourceSnapshot,
  type FilePlaybackStartEvidence,
  type FilePlaybackPauseTransitionIntent,
  type FilePlaybackSeekTransitionIntent,
} from './file-playback-source.ts';
import type { FilePlaybackStopTransitionIntent } from './file-playback-stop-transition.ts';
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
    key !== 'runtimeForTests',
);
const RUNTIME_KEYS = Object.freeze([
  'stageAssetSource',
  'createR2Acquirer',
  'createPeerTransport',
  'createParticipant',
  'currentPort',
  'currentSnapshot',
  'retireCandidate',
  'retireCurrent',
  'pauseCurrent',
  'seekCurrent',
  'stopCurrent',
  'waitForClockPoll',
] as const);
const AUXILIARY_EVENT_KEYS = Object.freeze([
  'channel',
  'connection',
  'connectionToken',
  'frame',
] as const);
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
const DEFAULT_ARM_P95_MS = 75;
const DEFAULT_READY_LEASE_MS = 30_000;
const DEFAULT_RENDERER_HEALTH_LEASE_MS = 10_000;
const CLOCK_POLL_MS = 20;

type ExactRecord = Readonly<Record<string, unknown>>;
type MaybePromiseBoolean = boolean | PromiseLike<boolean>;
type StageAssetSource = (
  options: StageFilePlaybackAssetSourceOptions,
) => Promise<Readonly<StagedFilePlaybackAssetSource>>;

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
}

interface RuntimeSnapshot {
  readonly stageAssetSource: StageAssetSource;
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
  readonly waitForClockPoll: (signal: AbortSignal) => Promise<void>;
}

export interface FilePlaybackProductGuestMediaOwnerRuntimeForTests {
  readonly stageAssetSource?: RuntimeSnapshot['stageAssetSource'];
  readonly createR2Acquirer?: RuntimeSnapshot['createR2Acquirer'];
  readonly createPeerTransport?: RuntimeSnapshot['createPeerTransport'];
  readonly createParticipant?: RuntimeSnapshot['createParticipant'];
  readonly currentPort?: RuntimeSnapshot['currentPort'];
  readonly currentSnapshot?: RuntimeSnapshot['currentSnapshot'];
  readonly retireCandidate?: RuntimeSnapshot['retireCandidate'];
  readonly retireCurrent?: RuntimeSnapshot['retireCurrent'];
  readonly waitForClockPoll?: RuntimeSnapshot['waitForClockPoll'];
}

export interface FilePlaybackProductGuestMediaOwnerOptions {
  readonly context: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  readonly roomToken: object;
  readonly registry: FilePlaybackAssetRegistry;
  readonly manager: FilePlaybackManager;
  readonly getAudioGraph: () => Promise<Readonly<FilePlaybackProductGuestAudioGraph>>;
  readonly maxEncodedSize: number;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
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
  /** Called only after the exact native transition and media metadata both commit. */
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
  readonly kind: 'baseline' | 'recovery' | 'successor';
  state: Readonly<PlaybackStateIdentity>;
  readonly operation: Readonly<FilePlaybackConnectionMediaOperation>;
  assetLease: FilePlaybackAssetLease | null;
  audioGraph: Readonly<FilePlaybackProductGuestAudioGraph> | null;
  staged: Readonly<StagedFilePlaybackAssetSource> | null;
  participant: GuestRendezvousParticipantPort | null;
  readyPublished: boolean;
  attempt: GuestAttempt | null;
  status: 'preparing' | 'ready' | 'current' | 'retired';
}

interface GuestRoomState {
  readonly roomGeneration: number;
  timeline: Readonly<PlaybackTimelineSnapshot>;
  current: GuestPreparedRun | null;
  candidate: GuestPreparedRun | null;
  physical: GuestPhysicalCommit | null;
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
  readonly participant: GuestRendezvousParticipantPort;
  readonly identity: Readonly<PlaybackAttemptIdentity>;
  readonly armIntent: Readonly<RendezvousArmIntent>;
  armReceipt: Readonly<RendezvousArmReceipt> | null;
  armTask: Promise<void>;
  finalizeTask: Promise<void> | null;
  committed: boolean;
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
const registryAdmitEncoded = FilePlaybackAssetRegistry.prototype.admitEncodedAsset;
const registrySnapshot = FilePlaybackAssetRegistry.prototype.snapshotForLease;
const managerCurrentPort = FilePlaybackManager.prototype.currentCutoverPort;
const managerCurrentSnapshot = FilePlaybackManager.prototype.currentCutoverSnapshot;
const managerRetireCandidate = FilePlaybackManager.prototype.retireCutoverCandidate;
const managerRetireCurrent = FilePlaybackManager.prototype.retireCurrentCutover;
const managerPauseCurrent = FilePlaybackManager.prototype.pauseCurrentCutover;
const managerSeekCurrent = FilePlaybackManager.prototype.seekCurrentCutover;
const managerStopCurrent = FilePlaybackManager.prototype.stopCurrentCutover;

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

function waitForClockPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('Guest media owner was revoked', 'AbortError'),
    );
  }
  return delay(CLOCK_POLL_MS);
}

function runtimeSnapshot(value: unknown): RuntimeSnapshot | null {
  const runtime = snapshotOptionalRuntime(value);
  if (!runtime) return null;
  return Object.freeze({
    stageAssetSource:
      (runtime.stageAssetSource as RuntimeSnapshot['stageAssetSource'] | undefined) ??
      stageFilePlaybackAssetSource,
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
    waitForClockPoll:
      (runtime.waitForClockPoll as RuntimeSnapshot['waitForClockPoll'] | undefined) ??
      waitForClockPoll,
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
    typeof (value as GuestRendezvousParticipantPort).commitAttempt === 'function'
  );
}

export class FilePlaybackProductGuestMediaOwnerFatalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FilePlaybackProductGuestMediaOwnerFatalError';
  }
}

class GuestMediaOwner {
  readonly #context: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  readonly #roomToken: object;
  readonly #registry: FilePlaybackAssetRegistry;
  readonly #manager: FilePlaybackManager;
  readonly #getAudioGraph: FilePlaybackProductGuestMediaOwnerOptions['getAudioGraph'];
  readonly #decodeOrdinaryAudio: OrdinaryAudioDecoder;
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
  #room: GuestRoomState | null = null;
  #lane: Promise<void> = Promise.resolve();
  #closed = false;
  #fatalError: FilePlaybackProductGuestMediaOwnerFatalError | null = null;
  #closePromise: Promise<void> | null = null;
  #fatalPublished = false;
  #timelineCallbackActive = false;
  #audioGraphPromise: Promise<Readonly<FilePlaybackProductGuestAudioGraph>> | null = null;

  constructor(options: FilePlaybackProductGuestMediaOwnerOptions) {
    const input = snapshotAllowedOptions(options);
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
        assetLease: null,
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
            assetLease: prepared.assetLease,
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
            await this.#prepareRecovery(room, recovery);
            const attempt = this.#createAttempt(recovery, message, attemptLease, null);
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
        );
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
      const current = room.current;
      if (!current || !messageMatchesCurrentSuccessor(message, this.#context, current)) {
        throw new Error('Guest successor wire does not match the exact current run');
      }
      if (
        message.kind !== 'file-playback-pause' &&
        message.kind !== 'file-playback-seek' &&
        message.kind !== 'file-playback-stop'
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
      const acquired = await this.#acquireAsset(operation);
      this.#assertPrepared(room, prepared);
      prepared.assetLease = acquired.assetLease;
      const clockBindings = await this.#awaitClockBindings(room, prepared, graph.audioContext);
      this.#assertPrepared(room, prepared);
      const staged = await this.#runtime.stageAssetSource({
        registry: this.#registry,
        roomToken: this.#roomToken,
        assetLease: acquired.assetLease,
        expectedBinding: assetBinding(operation),
        manager: this.#manager,
        audioContext: graph.audioContext,
        destination: graph.destination,
        clockBindings,
        signal: operation.fence.signal,
        isCurrent: () => this.#preparedCurrent(room, prepared),
        decodeOrdinaryAudio: this.#decodeOrdinaryAudio,
      });
      this.#assertPrepared(room, prepared);
      if (
        staged.asset.queueItemId !== prepared.state.queueItemId ||
        staged.asset.sourceIdentity !== operation.binding.sourceIdentity ||
        staged.asset.transferSessionId !== operation.binding.transferSessionId
      ) {
        throw new Error('Guest staged source does not match its baseline operation');
      }
      prepared.staged = staged;
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
    } catch (error) {
      if (!this.#closed) throw error;
    }
  }

  async #prepareRecovery(room: GuestRoomState, prepared: GuestPreparedRun): Promise<void> {
    if (prepared.kind !== 'recovery' || !prepared.assetLease || !prepared.audioGraph) {
      throw new Error('Guest same-state recovery source is incomplete');
    }
    this.#assertPrepared(room, prepared);
    this.#assertRunningAudioGraph(prepared.audioGraph);
    const clockBindings = await this.#awaitClockBindings(
      room,
      prepared,
      prepared.audioGraph.audioContext,
    );
    this.#assertPrepared(room, prepared);
    const staged = await this.#runtime.stageAssetSource({
      registry: this.#registry,
      roomToken: this.#roomToken,
      assetLease: prepared.assetLease,
      expectedBinding: assetBinding(prepared.operation),
      manager: this.#manager,
      audioContext: prepared.audioGraph.audioContext,
      destination: prepared.audioGraph.destination,
      clockBindings,
      signal: prepared.operation.fence.signal,
      isCurrent: () => this.#preparedCurrent(room, prepared),
      decodeOrdinaryAudio: this.#decodeOrdinaryAudio,
    });
    this.#assertPrepared(room, prepared);
    if (
      staged.asset.queueItemId !== prepared.state.queueItemId ||
      staged.asset.sourceIdentity !== prepared.operation.binding.sourceIdentity ||
      staged.asset.transferSessionId !== prepared.operation.binding.transferSessionId
    ) {
      throw new Error('Guest recovery source changed its bound asset');
    }
    prepared.staged = staged;
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
    prepared.readyPublished = true;
    prepared.status = 'ready';
  }

  async #acquireAsset(
    operation: Readonly<FilePlaybackConnectionMediaOperation>,
  ): Promise<Readonly<FilePlaybackR2WholeBlobAcquisition>> {
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
      await this.#runtime.waitForClockPoll(prepared.operation.fence.signal);
      this.#assertPrepared(room, prepared);
    }
  }

  async #resolveAudioGraph(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
  ): Promise<Readonly<FilePlaybackProductGuestAudioGraph>> {
    this.#assertPrepared(room, prepared);
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
      this.#audioGraphPromise = graphTask.then((value) => {
        const graph = canonicalAudioGraph(value);
        if (!graph) throw new TypeError('Guest audio graph provider returned a mismatched graph');
        return graph;
      });
    }
    const graph = await this.#audioGraphPromise;
    this.#assertPrepared(room, prepared);
    this.#assertRunningAudioGraph(graph);
    return graph;
  }

  async #executeArm(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    attempt: GuestAttempt,
  ): Promise<void> {
    this.#assertAttempt(room, prepared, attempt);
    this.#assertRunningAudioGraph(prepared.audioGraph);
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
    const wire = attempt.admittedAttempt
      ? this.#mediaSession.createPreparedRunAttemptWire(attempt.admittedAttempt, {
          kind: 'rendezvous-armed',
          rendezvousId: canonical.rendezvousId,
          status: canonical.status,
          observedAtRoomTimeMs: canonical.observedAtRoomTimeMs,
          bufferedAheadSeconds: canonical.bufferedAheadSeconds,
          reasonCode: canonical.reasonCode,
        })
      : this.#createAttemptWire(attempt.attemptLease, {
          kind: 'rendezvous-armed',
          rendezvousId: canonical.rendezvousId,
          status: canonical.status,
          observedAtRoomTimeMs: canonical.observedAtRoomTimeMs,
          bufferedAheadSeconds: canonical.bufferedAheadSeconds,
          reasonCode: canonical.reasonCode,
        });
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
    const finalizedWire = attempt.admittedAttempt
      ? this.#mediaSession.createPreparedRunAttemptWire(attempt.admittedAttempt, {
          kind: 'rendezvous-finalized',
          rendezvousId: canonical.rendezvousId,
          status: canonical.status,
          observedAtRoomTimeMs: canonical.observedAtRoomTimeMs,
          reasonCode: canonical.reasonCode,
        })
      : this.#createAttemptWire(attempt.attemptLease, {
          kind: 'rendezvous-finalized',
          rendezvousId: canonical.rendezvousId,
          status: canonical.status,
          observedAtRoomTimeMs: canonical.observedAtRoomTimeMs,
          reasonCode: canonical.reasonCode,
        });
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
    if (attempt.admittedAttempt) {
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
    if (prepared.kind === 'successor') {
      const previous = room.current;
      if (previous && previous !== prepared) previous.status = 'retired';
      room.current = prepared;
      room.candidate = null;
      room.physical = freezeCanonical({
        state: prepared.state,
        phase: 'playing' as const,
        positionSeconds: attempt.armIntent.positionSeconds,
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
    const healthWire = attempt.admittedAttempt
      ? this.#mediaSession.createPreparedRunAttemptWire(attempt.admittedAttempt, healthPayload)
      : this.#createAttemptWire(attempt.attemptLease, healthPayload);
    await this.#sendRequired(healthWire);
    this.#assertAttempt(room, prepared, attempt);
  }

  #createAttempt(
    prepared: GuestPreparedRun,
    message: Extract<FilePlaybackWireMessage, { readonly kind: 'rendezvous-arm' }>,
    attemptLease: FilePlaybackWireAttemptLease,
    admittedAttempt: Readonly<FilePlaybackConnectionMediaPreparedRunAttempt> | null,
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
      participant: prepared.participant!,
      identity,
      armIntent: intent,
      armReceipt: null,
      armTask: Promise.resolve(),
      finalizeTask: null,
      committed: false,
    };
  }

  async #applyStateSuccessor(
    room: GuestRoomState,
    prepared: GuestPreparedRun,
    expected: Readonly<PlaybackStateIdentity>,
    successor: Readonly<PlaybackStateIdentity>,
    message: Extract<
      FilePlaybackWireMessage,
      {
        readonly kind: 'file-playback-pause' | 'file-playback-seek' | 'file-playback-stop';
      }
    >,
    stateLease: FilePlaybackWireStateLease,
  ): Promise<void> {
    this.#assertPrepared(room, prepared);
    this.#assertRunningAudioGraph(prepared.audioGraph);
    const port = prepared.staged?.cutoverPort;
    if (!port || this.#runtime.currentPort(this.#manager) !== port) {
      throw new Error('Guest state successor has no exact current renderer');
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
    this.#timelineCallbackActive = true;
    try {
      Reflect.apply(this.#onTimelineRendered, undefined, [timeline]);
    } finally {
      this.#timelineCallbackActive = false;
    }
    this.#assertRoom(room);
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
      return (
        !this.#closed &&
        this.#room === room &&
        (room.current === prepared || room.candidate === prepared) &&
        prepared.status !== 'retired' &&
        !this.#abort.signal.aborted &&
        !prepared.operation.fence.signal.aborted &&
        prepared.operation.fence.isCurrent() === true
      );
    } catch {
      return false;
    }
  }

  #assertPrepared(room: GuestRoomState, prepared: GuestPreparedRun): void {
    this.#assertLive();
    if (!this.#preparedCurrent(room, prepared)) {
      throw new Error('Guest prepared media operation is stale');
    }
    this.#assertLive();
  }

  #assertAttempt(room: GuestRoomState, prepared: GuestPreparedRun, attempt: GuestAttempt): void {
    this.#assertPrepared(room, prepared);
    if (prepared.attempt !== attempt) throw new Error('Guest rendezvous attempt is stale');
  }

  #assertRunningAudioGraph(
    graph: Readonly<FilePlaybackProductGuestAudioGraph> | null,
  ): asserts graph is Readonly<FilePlaybackProductGuestAudioGraph> {
    if (!graph || graph.audioContext.state !== 'running') {
      throw new Error('Guest file playback AudioContext is not running');
    }
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
      if (!this.#closed) this.#fatal(`Guest media owner ${label} failed`, error);
    });
    this.#lane = tracked;
    this.#tasks.add(tracked);
    void tracked.then(() => this.#tasks.delete(tracked));
  }

  #beginClose(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#abort.abort(this.#fatalError ?? new Error('Guest media owner revoked'));
    this.#peerTransport.close(this.#abort.signal.reason);
    this.#mediaSession.revoke();
    const preparedRuns = [this.#room?.current, this.#room?.candidate].filter(
      (value): value is GuestPreparedRun => Boolean(value?.staged),
    );
    const ports = new Set(preparedRuns.map((prepared) => prepared.staged!.cutoverPort));
    const retireTask = Promise.allSettled(
      [...ports].map(async (port) => {
        const current = this.#runtime.currentPort(this.#manager);
        if (current === port) await this.#runtime.retireCurrent(this.#manager, port);
        else await this.#runtime.retireCandidate(this.#manager, port);
      }),
    );
    const tasks = [...this.#tasks];
    this.#closePromise = Promise.allSettled([this.#r2Acquirer.close(), retireTask, ...tasks]).then(
      () => undefined,
    );
    return this.#closePromise;
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
