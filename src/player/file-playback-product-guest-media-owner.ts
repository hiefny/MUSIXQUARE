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
import type { FilePlaybackApplicationTimelineAdoptedEvent } from './file-playback-application-controller.ts';
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
} from './file-playback-source.ts';
import type { OrdinaryAudioDecoder } from './file-playback-source-factory.ts';
import type {
  FilePlaybackWireAttemptLease,
  FilePlaybackWireLease,
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
}

interface ActiveBaseline {
  readonly roomGeneration: number;
  readonly timeline: Readonly<PlaybackTimelineSnapshot>;
  readonly state: Readonly<PlaybackStateIdentity>;
  operation: Readonly<FilePlaybackConnectionMediaOperation> | null;
  assetLease: FilePlaybackAssetLease | null;
  audioGraph: Readonly<FilePlaybackProductGuestAudioGraph> | null;
  staged: Readonly<StagedFilePlaybackAssetSource> | null;
  participant: GuestRendezvousParticipantPort | null;
  readyPublished: boolean;
  attempt: GuestAttempt | null;
}

interface GuestAttempt {
  readonly rendezvousId: string;
  readonly attemptLease: FilePlaybackWireAttemptLease;
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
const registryAdmitEncoded = FilePlaybackAssetRegistry.prototype.admitEncodedAsset;
const registrySnapshot = FilePlaybackAssetRegistry.prototype.snapshotForLease;
const managerCurrentPort = FilePlaybackManager.prototype.currentCutoverPort;
const managerCurrentSnapshot = FilePlaybackManager.prototype.currentCutoverSnapshot;
const managerRetireCandidate = FilePlaybackManager.prototype.retireCutoverCandidate;
const managerRetireCurrent = FilePlaybackManager.prototype.retireCurrentCutover;

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

function messageMatchesBaseline(
  message: Readonly<FilePlaybackWireMessage>,
  context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  baseline: ActiveBaseline,
  operation: Readonly<FilePlaybackConnectionMediaOperation>,
): boolean {
  return (
    message.sessionId === context.sessionId &&
    message.connectionId === context.connectionId &&
    message.senderParticipantId === context.hostParticipantId &&
    message.recipientParticipantId === context.guestParticipantId &&
    message.queueItemId === baseline.state.queueItemId &&
    message.runId === baseline.state.runId &&
    message.revision === baseline.state.revision &&
    message.sourceIdentity === operation.binding.sourceIdentity &&
    message.transferSessionId === operation.binding.transferSessionId
  );
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
  #baseline: ActiveBaseline | null = null;
  #closed = false;
  #fatalError: FilePlaybackProductGuestMediaOwnerFatalError | null = null;
  #closePromise: Promise<void> | null = null;
  #fatalPublished = false;
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
      const existing = this.#baseline;
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
      this.#baseline = {
        roomGeneration: event.roomGeneration,
        timeline,
        state,
        operation: null,
        assetLease: null,
        audioGraph: null,
        staged: null,
        participant: null,
        readyPublished: false,
        attempt: null,
      };
      this.#assertLive();
    } catch (error) {
      throw this.#fatal('Guest timeline adoption failed', error);
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
      const baseline = this.#requireBaseline();
      if (type === FILE_MEDIA_SOURCE_OFFER_V2_TYPE) {
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
      const operation = this.#mediaSession.stageRunBinding(
        event!.frame,
        baseline.state,
        'baseline',
      );
      if (baseline.operation && baseline.operation !== operation) {
        throw new Error('Guest baseline operation conflicted with an active preparation');
      }
      baseline.operation = operation;
      acknowledge();
      if (!this.#tasks.size) this.#launch(this.#prepareBaseline(baseline, operation));
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
      const baseline = this.#requireReadyBaseline();
      const operation = baseline.operation!;
      const message = event!.message as Readonly<FilePlaybackWireMessage>;
      if (!messageMatchesBaseline(message, this.#context, baseline, operation)) {
        throw new Error('Guest wire message does not match the prepared baseline');
      }
      if (message.kind === 'rendezvous-arm') {
        if (!event!.attemptLease || typeof event!.attemptLease !== 'object') {
          throw new Error('Guest rendezvous arm has no exact attempt lease');
        }
        if (baseline.attempt) throw new Error('Guest baseline already owns a rendezvous attempt');
        const participant = baseline.participant!;
        const identity = attemptIdentity(baseline.state, message.rendezvousId);
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
        const attempt: GuestAttempt = {
          rendezvousId: message.rendezvousId,
          attemptLease: event!.attemptLease as FilePlaybackWireAttemptLease,
          participant,
          identity,
          armIntent: intent,
          armReceipt: null,
          armTask: Promise.resolve(),
          finalizeTask: null,
          committed: false,
        };
        baseline.attempt = attempt;
        attempt.armTask = this.#executeArm(baseline, attempt);
        acknowledge();
        this.#launch(attempt.armTask);
        return;
      }
      if (message.kind !== 'rendezvous-finalize') {
        throw new Error(
          `Guest wire kind is not implemented by the baseline owner: ${message.kind}`,
        );
      }
      const attempt = baseline.attempt;
      if (
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
      attempt.finalizeTask = this.#executeFinalize(baseline, attempt, intent);
      acknowledge();
      this.#launch(attempt.finalizeTask);
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

  async #prepareBaseline(
    baseline: ActiveBaseline,
    operation: Readonly<FilePlaybackConnectionMediaOperation>,
  ): Promise<void> {
    try {
      this.#assertOperation(baseline, operation);
      const graph = await this.#resolveAudioGraph(baseline, operation);
      this.#assertRunningAudioGraph(graph);
      this.#assertOperation(baseline, operation);
      baseline.audioGraph = graph;
      const acquired = await this.#acquireAsset(operation);
      this.#assertOperation(baseline, operation);
      baseline.assetLease = acquired.assetLease;
      const clockBindings = await this.#awaitClockBindings(baseline, operation, graph.audioContext);
      this.#assertOperation(baseline, operation);
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
        isCurrent: () => this.#operationCurrent(baseline, operation),
        decodeOrdinaryAudio: this.#decodeOrdinaryAudio,
      });
      this.#assertOperation(baseline, operation);
      if (
        staged.asset.queueItemId !== baseline.state.queueItemId ||
        staged.asset.sourceIdentity !== operation.binding.sourceIdentity ||
        staged.asset.transferSessionId !== operation.binding.transferSessionId
      ) {
        throw new Error('Guest staged source does not match its baseline operation');
      }
      baseline.staged = staged;
      const quality = Reflect.apply(channelQuality, this.#context.channel, []);
      this.#assertOperation(baseline, operation);
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
      baseline.participant = participant;
      this.#assertOperation(baseline, operation);
      this.#assertRunningAudioGraph(graph);
      this.#mediaSession.commitPreparedPausedBaseline(operation, baseline.state, () =>
        this.#operationCurrent(baseline, operation),
      );
      this.#assertOperation(baseline, operation);
      const observedAtRoomTimeMs = this.#nowRoomTimeMs();
      const wire = this.#mediaSession.createPreparedSourceReadyWire(operation, {
        kind: 'source-ready',
        observedAtRoomTimeMs,
        readyLeaseUntilRoomTimeMs: observedAtRoomTimeMs + this.#readyLeaseMs,
        backend: staged.backend,
        durationSeconds: staged.readiness.durationSeconds,
        bufferedAheadSeconds: staged.readiness.bufferedAheadSeconds,
        outputSampleRateHz: staged.readiness.outputSampleRateHz,
        channelCount: staged.readiness.channelCount,
      });
      this.#assertOperation(baseline, operation);
      await this.#sendRequired(wire);
      this.#assertOperation(baseline, operation);
      baseline.readyPublished = true;
    } catch (error) {
      if (!this.#closed) throw error;
    }
  }

  async #acquireAsset(
    operation: Readonly<FilePlaybackConnectionMediaOperation>,
  ): Promise<Readonly<FilePlaybackR2WholeBlobAcquisition>> {
    const binding = assetBinding(operation);
    if (operation.offer.transport === 'r2-whole-blob') {
      return this.#r2Acquirer.acquire(operation);
    }
    this.#assertOperation(this.#requireBaseline(), operation);
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
    baseline: ActiveBaseline,
    operation: Readonly<FilePlaybackConnectionMediaOperation>,
    audioContext: AudioContext,
  ): Promise<Readonly<FilePlaybackClockBindings>> {
    for (;;) {
      this.#assertOperation(baseline, operation);
      if (Reflect.apply(channelClockReady, this.#context.channel, [])) {
        const bindings = Reflect.apply(channelClockBindings, this.#context.channel, [audioContext]);
        this.#assertOperation(baseline, operation);
        return bindings;
      }
      await this.#runtime.waitForClockPoll(operation.fence.signal);
      this.#assertOperation(baseline, operation);
    }
  }

  async #resolveAudioGraph(
    baseline: ActiveBaseline,
    operation: Readonly<FilePlaybackConnectionMediaOperation>,
  ): Promise<Readonly<FilePlaybackProductGuestAudioGraph>> {
    this.#assertOperation(baseline, operation);
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
    this.#assertOperation(baseline, operation);
    return graph;
  }

  async #executeArm(baseline: ActiveBaseline, attempt: GuestAttempt): Promise<void> {
    this.#assertAttempt(baseline, attempt);
    this.#assertRunningAudioGraph(baseline.audioGraph);
    const receipt = await attempt.participant.arm(attempt.armIntent);
    this.#assertAttempt(baseline, attempt);
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
    const wire = this.#createAttemptWire(attempt.attemptLease, {
      kind: 'rendezvous-armed',
      rendezvousId: canonical.rendezvousId,
      status: canonical.status,
      observedAtRoomTimeMs: canonical.observedAtRoomTimeMs,
      bufferedAheadSeconds: canonical.bufferedAheadSeconds,
      reasonCode: canonical.reasonCode,
    });
    await this.#sendRequired(wire);
    this.#assertAttempt(baseline, attempt);
  }

  async #executeFinalize(
    baseline: ActiveBaseline,
    attempt: GuestAttempt,
    intent: Readonly<RendezvousFinalizeIntent>,
  ): Promise<void> {
    await attempt.armTask;
    this.#assertAttempt(baseline, attempt);
    this.#assertRunningAudioGraph(baseline.audioGraph);
    if (attempt.armReceipt?.status !== 'armed') {
      throw new Error('Guest rendezvous finalize followed a rejected arm');
    }
    const receipt = await attempt.participant.finalize(intent);
    this.#assertAttempt(baseline, attempt);
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
    const finalizedWire = this.#createAttemptWire(attempt.attemptLease, {
      kind: 'rendezvous-finalized',
      rendezvousId: canonical.rendezvousId,
      status: canonical.status,
      observedAtRoomTimeMs: canonical.observedAtRoomTimeMs,
      reasonCode: canonical.reasonCode,
    });
    await this.#sendRequired(finalizedWire);
    this.#assertAttempt(baseline, attempt);
    if (canonical.status !== 'accepted') return;

    const evidenceValue = await attempt.participant.started(attempt.identity);
    this.#assertAttempt(baseline, attempt);
    const evidence = canonicalStartEvidence(evidenceValue);
    if (!evidence) throw new Error('Guest physical start evidence was invalid');
    const staged = baseline.staged!;
    const currentPort = this.#runtime.currentPort(this.#manager);
    const snapshot = this.#runtime.currentSnapshot(this.#manager, staged.cutoverPort);
    if (
      currentPort !== staged.cutoverPort ||
      !snapshot ||
      snapshot.phase !== 'playing' ||
      snapshot.backend !== staged.backend ||
      snapshot.queueItemId !== baseline.state.queueItemId ||
      snapshot.run?.queueItemId !== baseline.state.queueItemId ||
      snapshot.run.runId !== baseline.state.runId ||
      snapshot.run.revision !== baseline.state.revision
    ) {
      throw new Error('Guest manager lacks exact physical renderer evidence');
    }
    this.#assertAttempt(baseline, attempt);
    if (!attempt.participant.commitAttempt(attempt.identity)) {
      throw new Error('Guest cutover participant rejected physical commit');
    }
    const afterCommit = this.#runtime.currentSnapshot(this.#manager, staged.cutoverPort);
    if (
      this.#runtime.currentPort(this.#manager) !== staged.cutoverPort ||
      !afterCommit ||
      afterCommit.phase !== 'playing' ||
      afterCommit.run?.revision !== baseline.state.revision
    ) {
      throw new Error('Guest renderer changed during participant commit');
    }
    attempt.committed = true;
    const observedAtRoomTimeMs = this.#nowRoomTimeMs();
    const renderedFrame =
      evidence.kind === 'worklet-observed' ? evidence.actualStartFrame : evidence.targetFrame;
    const healthWire = this.#createAttemptWire(attempt.attemptLease, {
      kind: 'renderer-health',
      rendezvousId: attempt.rendezvousId,
      value: 'healthy',
      observedAtRoomTimeMs,
      leaseUntilRoomTimeMs: observedAtRoomTimeMs + this.#rendererHealthLeaseMs,
      renderedFrame,
      underrunCount: afterCommit.underrunCount,
      reasonCode: null,
    });
    await this.#sendRequired(healthWire);
    this.#assertAttempt(baseline, attempt);
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

  #requireBaseline(): ActiveBaseline {
    this.#assertLive();
    if (!this.#baseline) throw new Error('Guest PRODUCT READY timeline is unavailable');
    return this.#baseline;
  }

  #requireReadyBaseline(): ActiveBaseline {
    const baseline = this.#requireBaseline();
    if (
      !baseline.operation ||
      !baseline.staged ||
      !baseline.participant ||
      !baseline.readyPublished
    ) {
      throw new Error('Guest prepared baseline has not published SOURCE_READY');
    }
    this.#assertOperation(baseline, baseline.operation);
    return baseline;
  }

  #operationCurrent(
    baseline: ActiveBaseline,
    operation: Readonly<FilePlaybackConnectionMediaOperation>,
  ): boolean {
    try {
      return (
        !this.#closed &&
        this.#baseline === baseline &&
        baseline.operation === operation &&
        !this.#abort.signal.aborted &&
        !operation.fence.signal.aborted &&
        operation.fence.isCurrent() === true
      );
    } catch {
      return false;
    }
  }

  #assertOperation(
    baseline: ActiveBaseline,
    operation: Readonly<FilePlaybackConnectionMediaOperation>,
  ): void {
    this.#assertLive();
    if (!this.#operationCurrent(baseline, operation)) {
      throw new Error('Guest media operation is stale');
    }
    this.#assertLive();
  }

  #assertAttempt(baseline: ActiveBaseline, attempt: GuestAttempt): void {
    this.#assertOperation(baseline, baseline.operation!);
    if (baseline.attempt !== attempt) throw new Error('Guest rendezvous attempt is stale');
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

  #launch(task: Promise<void>): void {
    const tracked = task.catch((error: unknown) => {
      if (!this.#closed) this.#fatal('Guest media owner asynchronous operation failed', error);
    });
    this.#tasks.add(tracked);
    void tracked.then(() => this.#tasks.delete(tracked));
  }

  #beginClose(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#abort.abort(this.#fatalError ?? new Error('Guest media owner revoked'));
    this.#peerTransport.close(this.#abort.signal.reason);
    this.#mediaSession.revoke();
    const staged = this.#baseline?.staged;
    const retireTask = staged
      ? Promise.resolve().then(async () => {
          const current = this.#runtime.currentPort(this.#manager);
          if (current === staged.cutoverPort) {
            await this.#runtime.retireCurrent(this.#manager, staged.cutoverPort);
          } else {
            await this.#runtime.retireCandidate(this.#manager, staged.cutoverPort);
          }
        })
      : Promise.resolve();
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
