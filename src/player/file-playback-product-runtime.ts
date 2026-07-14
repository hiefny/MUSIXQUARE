import {
  getFilePlaybackApplicationSessionManager,
  installFilePlaybackApplicationSessionHooks,
  snapshotFilePlaybackHostApplicationSessionAuthority,
  type FilePlaybackApplicationSessionHooks,
  type FilePlaybackHostApplicationSessionAuthority,
} from '../network/file-playback-application-session.ts';
import { getPrimedFilePlaybackProductAudio } from '../audio/file-playback-audio-readiness.ts';
import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { delay } from '../core/timers.ts';
import { isFilePlaybackSessionId } from '../network/file-playback-session-handshake.ts';
import type { DataConnection, QueueItemId } from '../types/index.ts';
import {
  FilePlaybackApplicationController,
  type FilePlaybackApplicationControllerConnectionSnapshot,
  type FilePlaybackApplicationTimelineAdoptedEvent,
  type FilePlaybackApplicationTimelineUpdatedEvent,
} from './file-playback-application-controller.ts';
import { FilePlaybackAssetRegistry } from './file-playback-asset-registry.ts';
import {
  snapshotFilePlaybackBoundedRoutePolicy,
  type FilePlaybackBoundedRoutePolicy,
} from './file-playback-bounded-route-policy.ts';
import { FilePlaybackManager } from './file-playback-manager.ts';
import { isFilePlaybackEngineV2Enabled } from './file-playback-engine-gate.ts';
import type {
  HostLocalTrackSourceLease,
  HostPreparedLocalTrack,
  HostPreparedRemoteParticipant,
  HostPeerPlaybackPublication,
  HostPeerRangeManifestPublication,
  HostPeerRangeSource,
  HostRemoteRecoveryCommit,
  RecoverHostRemoteParticipantOptions,
  ResolvePreparedHostPeerRangeSourceOptions,
  ResolveHostPeerRangeSourceOptions,
  ResolveWarmHostPeerRangeSourceOptions,
} from './file-playback-host-first-file-engine.ts';
import { FilePlaybackProductBaselineIdIssuer } from './file-playback-product-baseline-session.ts';
import {
  createFilePlaybackProductGuestMediaOwner,
  type FilePlaybackProductGuestMediaOwnerOptions,
} from './file-playback-product-guest-media-owner.ts';
import {
  FILE_PLAYBACK_PRODUCT_OFFER_LIFETIME_MS,
  FILE_PLAYBACK_PRODUCT_PEER_RANGE_BUFFERED_AMOUNT_LIMIT,
  FilePlaybackProductHostMediaOwner,
  type ActivateFilePlaybackProductHostPreparedOptions,
  type FilePlaybackProductHostHealthSystemMessage,
  type FilePlaybackProductHostMediaOwnerOptions,
  type FilePlaybackProductHostPreparedPublicationCommit,
  type FilePlaybackProductHostPublicationCommit,
  type FilePlaybackProductHostSourceLeasePublicationCommit,
} from './file-playback-product-host-media-owner.ts';
import {
  FilePlaybackProductHostRoom,
  type ClearFilePlaybackProductHostLocalTrackWarmByLeaseOptions,
  type ClearFilePlaybackProductHostLocalTrackWarmOptions,
  type FilePlaybackProductHostCurrentOptions,
  type FilePlaybackProductHostCurrentWithCohortOptions,
  type FilePlaybackProductHostFirstLocalFileCommit,
  type FilePlaybackProductHostLocalTrackWarmResult,
  type FilePlaybackProductHostLocalTrackCommit,
  type FilePlaybackProductHostRoomOptions,
  type FilePlaybackProductHostSeekOptions,
  type FilePlaybackProductHostSeekWithCohortOptions,
  type FilePlaybackProductHostTransitionCommit,
  type FilePlaybackProductHostTerminalObservation,
  type PrepareFilePlaybackProductHostRemoteParticipants,
  type StartFilePlaybackProductHostFirstLocalFileOptions,
  type StartFilePlaybackProductHostLocalTrackWithCohortOptions,
  type StartFilePlaybackProductHostLocalTrackOptions,
  type WarmFilePlaybackProductHostLocalTrackOptions,
} from './file-playback-product-host-room.ts';
import { getFilePlaybackRoomClock } from './file-playback-room-clock.ts';
import { FilePlaybackR2WholeBlobPublisher } from './file-playback-r2-whole-blob-publisher.ts';
import {
  FilePlaybackProductSessionRouter,
  type FilePlaybackProductSessionRouterConnectionContext,
  type FilePlaybackProductSessionRouterGuestMediaOwnerPort,
  type FilePlaybackProductSessionRouterHostMediaOwnerPort,
  type FilePlaybackProductSessionRouterOptions,
  type FilePlaybackProductSessionRouterSnapshot,
} from './file-playback-product-session-router.ts';
import type { FilePlaybackPosition, FilePlaybackSourceSnapshot } from './file-playback-source.ts';
import { isQueueItemId } from './queue-model.ts';
import { decodeOrdinaryAudio } from './ordinary-audio-decoder.ts';
import type { FilePlaybackWireLease } from './file-playback-wire-binding.ts';
import type {
  FilePlaybackWireMessageForKind,
  FilePlaybackWirePayloadByKind,
} from './file-playback-wire-sender.ts';
import {
  createStoppedPlaybackTimeline,
  type PlaybackTimelineSnapshot,
} from './playback-timeline.ts';

const DEFAULT_ENABLED = isFilePlaybackEngineV2Enabled();
// Peer-range streaming never materializes the full encoded body in RAM. Keep
// its offer policy independent from the temporary 200 MiB whole-Blob R2 cap.
const FILE_PLAYBACK_PRODUCT_MAX_PEER_ENCODED_BYTES = 5 * 1024 * 1024 * 1024;
const FILE_PLAYBACK_PRODUCT_COHORT_ADMISSION_MS = 2_500;

type RuntimeState = 'idle' | 'initializing' | 'ready' | 'failed';

export interface FilePlaybackProductRuntimeSessionAdapter {
  installHooks(hooks: Readonly<FilePlaybackApplicationSessionHooks>): void;
  beginHostRoom(hostParticipantId: string): Readonly<FilePlaybackHostApplicationSessionAuthority>;
  endRoom(): void;
  handleWake(connection?: DataConnection): boolean;
  nowRoomTimeMs(): number;
  sendRequired(connection: DataConnection, frame: unknown): boolean;
  sendWire<const Kind extends keyof FilePlaybackWirePayloadByKind>(
    connection: DataConnection,
    lease: FilePlaybackWireLease,
    payload: FilePlaybackWirePayloadByKind[Kind],
  ): FilePlaybackWireMessageForKind<Kind> | null;
  closeConnection(connection: DataConnection): void;
}

/** Body-free identity and ABA fence for the exact active product host room. */
export interface FilePlaybackProductHostRoomSnapshot {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly applicationSessionId: string;
  readonly hostParticipantId: string;
}

export interface FilePlaybackProductRuntimeControllerFactoryInput {
  readonly initialTimeline: PlaybackTimelineSnapshot;
  readonly sessions: FilePlaybackProductRuntimeSessionAdapter;
  readonly onHostReady: (
    snapshot: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>,
  ) => void;
  readonly onTimelineAdopted: (
    event: Readonly<FilePlaybackApplicationTimelineAdoptedEvent>,
  ) => void;
  readonly onTimelineUpdated: (
    event: Readonly<FilePlaybackApplicationTimelineUpdatedEvent>,
  ) => void;
}

interface FilePlaybackProductRuntimeSessionRouterPort {
  applicationSessionHooks(): Readonly<FilePlaybackApplicationSessionHooks>;
  notifyHostReady(snapshot: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>): boolean;
  notifyTimelineAdopted(event: Readonly<FilePlaybackApplicationTimelineAdoptedEvent>): boolean;
  notifyTimelineUpdated(event: Readonly<FilePlaybackApplicationTimelineUpdatedEvent>): boolean;
  snapshot(): Readonly<FilePlaybackProductSessionRouterSnapshot>;
  close(): void;
}

interface FilePlaybackProductRuntimeHostMediaOwnerPort extends FilePlaybackProductSessionRouterHostMediaOwnerPort {
  publishCurrent(): Promise<Readonly<FilePlaybackProductHostPublicationCommit>>;
  publishSourceLease(
    authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>,
  ): Promise<Readonly<FilePlaybackProductHostSourceLeasePublicationCommit>>;
  retireSourceLease(sourceLease: HostLocalTrackSourceLease, reason: Error): Promise<void>;
  publishPrepared(
    prepared: Readonly<HostPreparedLocalTrack>,
  ): Promise<Readonly<FilePlaybackProductHostPreparedPublicationCommit>>;
  bindPrepared(
    prepared: Readonly<HostPreparedLocalTrack>,
  ): Promise<Readonly<FilePlaybackProductHostPreparedPublicationCommit>>;
  whenPreparedRemoteReady(
    prepared: Readonly<HostPreparedLocalTrack>,
  ): Promise<Readonly<HostPreparedRemoteParticipant>>;
  activatePrepared(
    options: ActivateFilePlaybackProductHostPreparedOptions,
  ): Readonly<FilePlaybackProductHostPublicationCommit>;
  retirePrepared(prepared: Readonly<HostPreparedLocalTrack>, reason: Error): Promise<void>;
}

interface FilePlaybackProductRuntimeMediaFactoriesForTests {
  readonly createSessionRouter?: (
    options: Readonly<FilePlaybackProductSessionRouterOptions>,
  ) => FilePlaybackProductRuntimeSessionRouterPort;
  readonly createHostPublisher?: (roomToken: object) => FilePlaybackR2WholeBlobPublisher;
  readonly createGuestRegistry?: (
    roomToken: object,
    onFatalRoom: (token: object, error: Error) => void,
  ) => FilePlaybackAssetRegistry;
  readonly createGuestManager?: () => FilePlaybackManager;
  readonly createHostMediaOwner?: (
    options: Readonly<FilePlaybackProductHostMediaOwnerOptions>,
  ) => FilePlaybackProductRuntimeHostMediaOwnerPort;
  readonly createGuestMediaOwner?: (
    options: Readonly<FilePlaybackProductGuestMediaOwnerOptions>,
  ) => FilePlaybackProductSessionRouterGuestMediaOwnerPort;
}

/** Narrow room capability retained by the product runtime. */
export interface FilePlaybackProductRuntimeHostRoomPort {
  warmLocalTrack(
    options: WarmFilePlaybackProductHostLocalTrackOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackWarmResult>>;
  clearWarmLocalTrack(options: ClearFilePlaybackProductHostLocalTrackWarmOptions): Promise<boolean>;
  clearWarmLocalTrackByLease(
    options: ClearFilePlaybackProductHostLocalTrackWarmByLeaseOptions,
  ): Promise<boolean>;
  resolveWarmPeerRangeSource(
    options: ResolveWarmHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource>;
  startFirstLocalFile(
    options: StartFilePlaybackProductHostFirstLocalFileOptions,
  ): Promise<Readonly<FilePlaybackProductHostFirstLocalFileCommit>>;
  startLocalTrack(
    options: StartFilePlaybackProductHostLocalTrackOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>>;
  startLocalTrackWithCohort(
    options: StartFilePlaybackProductHostLocalTrackWithCohortOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>>;
  pauseCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>>;
  seekPlaying(
    options: FilePlaybackProductHostSeekOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>>;
  seekPlayingWithCohort(
    options: FilePlaybackProductHostSeekWithCohortOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>>;
  seekPaused(
    options: FilePlaybackProductHostSeekOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>>;
  resumeCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>>;
  replayCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>>;
  replayCurrentWithCohort(
    options: FilePlaybackProductHostCurrentWithCohortOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>>;
  stopCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>>;
  settleEndedCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>>;
  currentPeerPublication(): Readonly<HostPeerPlaybackPublication> | null;
  resolveCurrentPeerRangeSource(
    options: ResolveHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource>;
  recoverRemoteParticipant(
    options: RecoverHostRemoteParticipantOptions,
  ): Promise<Readonly<HostRemoteRecoveryCommit>>;
  close(): Promise<void>;
  currentRendererSnapshot(): FilePlaybackSourceSnapshot | null;
  currentTerminalRendererObservation(): FilePlaybackProductHostTerminalObservation | null;
  positionAt(localPerformanceTimeMs: number): FilePlaybackPosition | null;
}

export interface FilePlaybackProductRuntimeOptions {
  /** Fixed for this facade's entire lifetime. It is never re-read at runtime. */
  readonly enabled?: boolean;
  /** Fixed codec route for every host and guest room owned by this facade. */
  readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
  readonly sessions?: FilePlaybackProductRuntimeSessionAdapter;
  readonly createController?: (
    input: Readonly<FilePlaybackProductRuntimeControllerFactoryInput>,
  ) => FilePlaybackApplicationController;
  readonly nowMonotonicMs?: () => number;
  readonly createHostRoom?: (
    options: Readonly<FilePlaybackProductHostRoomOptions>,
  ) => FilePlaybackProductRuntimeHostRoomPort;
  readonly onHealthSystemMessage?: (
    message: Readonly<FilePlaybackProductHostHealthSystemMessage>,
  ) => void;
  readonly mediaFactoriesForTests?: Readonly<FilePlaybackProductRuntimeMediaFactoriesForTests>;
}

interface ActiveProductHostRoom {
  readonly token: object;
  readonly roomGeneration: number;
  readonly port: FilePlaybackProductRuntimeHostRoomPort;
  readonly publisher: FilePlaybackR2WholeBlobPublisher;
}

interface ActiveProductGuestRoom {
  readonly token: object;
  readonly roomGeneration: number;
  readonly roomToken: object;
  readonly registry: FilePlaybackAssetRegistry;
  readonly manager: FilePlaybackManager;
}

interface HostPreparedCohortEntry {
  readonly context: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  readonly owner: FilePlaybackProductRuntimeHostMediaOwnerPort;
  readonly publicationTask: Promise<Readonly<FilePlaybackProductHostPreparedPublicationCommit>>;
  readonly cancelPublicationTask: (reason: Error) => void;
  readinessTask: Promise<void>;
  publication: Readonly<FilePlaybackProductHostPreparedPublicationCommit> | null;
  capability: Readonly<HostPreparedRemoteParticipant> | null;
  publicationFailure: Error | null;
  /** Immutable after the admission wait ends; late READY cannot promote it. */
  initialCohortAdmitted: boolean;
  activated: boolean;
}

interface HostPreparedCohortCycle {
  readonly active: ActiveProductHostRoom;
  readonly prepared: Readonly<HostPreparedLocalTrack>;
  readonly signal: AbortSignal;
  readonly resolveSource: (
    sourceIdentity: string,
    peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null,
    signal: AbortSignal,
  ) => Promise<HostPeerRangeSource>;
  readonly contexts: ReadonlySet<Readonly<FilePlaybackProductSessionRouterConnectionContext>>;
  readonly entries: HostPreparedCohortEntry[];
  status: 'preparing' | 'committed' | 'failed';
}

interface NextLocalTrackWarmIntent {
  readonly epoch: number;
  readonly active: ActiveProductHostRoom;
  readonly room: Readonly<FilePlaybackProductHostRoomSnapshot>;
  readonly queueItemId: QueueItemId;
  readonly file: File;
  readonly controller: AbortController;
  authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult> | null;
  status: 'warming' | 'warmed' | 'consumed' | 'retired';
  task: Promise<boolean>;
}

export interface FilePlaybackProductNextLocalTrackWarmOptions {
  readonly queueItemId: QueueItemId;
  readonly file: File;
}

function productionSessionAdapter(): FilePlaybackProductRuntimeSessionAdapter {
  const manager = () => getFilePlaybackApplicationSessionManager();
  return Object.freeze({
    installHooks: (hooks: Readonly<FilePlaybackApplicationSessionHooks>) => {
      installFilePlaybackApplicationSessionHooks(hooks);
    },
    beginHostRoom: (hostParticipantId: string) => manager().beginHostRoom(hostParticipantId),
    endRoom: () => manager().endRoom(),
    handleWake: (connection?: DataConnection) => manager().handleWake(connection),
    nowRoomTimeMs: () => getFilePlaybackRoomClock().nowRoomTimeMs(),
    sendRequired: (connection: DataConnection, frame: unknown) =>
      manager().sendRequired(connection, frame),
    sendWire: <const Kind extends keyof FilePlaybackWirePayloadByKind>(
      connection: DataConnection,
      lease: FilePlaybackWireLease,
      payload: FilePlaybackWirePayloadByKind[Kind],
    ): FilePlaybackWireMessageForKind<Kind> | null =>
      manager().sendWire(connection, lease, payload),
    closeConnection: (connection: DataConnection) => manager().closeConnection(connection, true),
  });
}

function defaultControllerFactory(
  input: Readonly<FilePlaybackProductRuntimeControllerFactoryInput>,
): FilePlaybackApplicationController {
  return new FilePlaybackApplicationController({
    initialTimeline: input.initialTimeline,
    idIssuer: new FilePlaybackProductBaselineIdIssuer(),
    sendRequired: (connection, frame) => input.sessions.sendRequired(connection, frame),
    closeConnection: (connection) => input.sessions.closeConnection(connection),
    onHostReady: input.onHostReady,
    onTimelineAdopted: input.onTimelineAdopted,
    onTimelineUpdated: input.onTimelineUpdated,
  });
}

function defaultMonotonicNow(): number {
  return globalThis.performance?.now?.() ?? 0;
}

function defaultHostRoomFactory(
  options: Readonly<FilePlaybackProductHostRoomOptions>,
): FilePlaybackProductRuntimeHostRoomPort {
  return new FilePlaybackProductHostRoom(options);
}

function defaultSessionRouterFactory(
  options: Readonly<FilePlaybackProductSessionRouterOptions>,
): FilePlaybackProductRuntimeSessionRouterPort {
  return new FilePlaybackProductSessionRouter(options);
}

function defaultHostPublisherFactory(roomToken: object): FilePlaybackR2WholeBlobPublisher {
  return new FilePlaybackR2WholeBlobPublisher({ roomToken });
}

function defaultGuestRegistryFactory(
  roomToken: object,
  onFatalRoom: (token: object, error: Error) => void,
): FilePlaybackAssetRegistry {
  return new FilePlaybackAssetRegistry({ liveRoomToken: roomToken, onFatalRoom });
}

function defaultGuestManagerFactory(): FilePlaybackManager {
  return new FilePlaybackManager();
}

function defaultHostMediaOwnerFactory(
  options: Readonly<FilePlaybackProductHostMediaOwnerOptions>,
): FilePlaybackProductRuntimeHostMediaOwnerPort {
  const owner = new FilePlaybackProductHostMediaOwner(options);
  return Object.freeze({
    ...owner.port(),
    publishCurrent: () => owner.publishCurrent(),
    publishSourceLease: (authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>) =>
      owner.publishSourceLease(authority),
    retireSourceLease: (sourceLease: HostLocalTrackSourceLease, reason: Error) =>
      owner.retireSourceLease(sourceLease, reason),
    publishPrepared: (prepared: Readonly<HostPreparedLocalTrack>) =>
      owner.publishPrepared(prepared),
    bindPrepared: (prepared: Readonly<HostPreparedLocalTrack>) => owner.bindPrepared(prepared),
    whenPreparedRemoteReady: (prepared: Readonly<HostPreparedLocalTrack>) =>
      owner.whenPreparedRemoteReady(prepared),
    activatePrepared: (input: ActivateFilePlaybackProductHostPreparedOptions) =>
      owner.activatePrepared(input),
    retirePrepared: (prepared: Readonly<HostPreparedLocalTrack>, reason: Error) =>
      owner.retirePrepared(prepared, reason),
  });
}

function defaultGuestMediaOwnerFactory(
  options: Readonly<FilePlaybackProductGuestMediaOwnerOptions>,
): FilePlaybackProductSessionRouterGuestMediaOwnerPort {
  return createFilePlaybackProductGuestMediaOwner(options);
}

function defaultHealthSystemMessage(message: Readonly<FilePlaybackProductHostHealthSystemMessage>) {
  // Keep chat/state out of the gate-off runtime's eager module graph. Health
  // presentation is needed only after a live V2 host owner reports sustained
  // degradation, at which point the ordinary chat bootstrap is already live.
  void Promise.all([import('../core/state.ts'), import('../chat/protocol.ts')])
    .then(([state, chat]) => {
      const peerLabel = state.getState('network.peerLabels')?.[message.participantId];
      const connectedLabel = state
        .getState('network.connectedPeers')
        .find((peer) => peer.id === message.participantId)?.label;
      chat.broadcastSystemMessage('chat.participant_connection_unstable_recovering', {
        name: peerLabel || connectedLabel || 'Peer',
      });
    })
    .catch(() => {
      // Health reporting must never destabilize playback or replace the exact
      // connection recovery which is already in progress.
    });
}

function assertSessionAdapter(value: FilePlaybackProductRuntimeSessionAdapter): void {
  if (
    !value ||
    typeof value.installHooks !== 'function' ||
    typeof value.beginHostRoom !== 'function' ||
    typeof value.endRoom !== 'function' ||
    typeof value.handleWake !== 'function' ||
    typeof value.nowRoomTimeMs !== 'function' ||
    typeof value.sendRequired !== 'function' ||
    typeof value.sendWire !== 'function' ||
    typeof value.closeConnection !== 'function'
  ) {
    throw new TypeError('File playback product runtime session adapter is invalid');
  }
}

function assertHostRoomPort(
  value: FilePlaybackProductRuntimeHostRoomPort,
): asserts value is FilePlaybackProductRuntimeHostRoomPort {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.warmLocalTrack !== 'function' ||
    typeof value.clearWarmLocalTrack !== 'function' ||
    typeof value.clearWarmLocalTrackByLease !== 'function' ||
    typeof value.resolveWarmPeerRangeSource !== 'function' ||
    typeof value.startFirstLocalFile !== 'function' ||
    typeof value.startLocalTrack !== 'function' ||
    typeof value.startLocalTrackWithCohort !== 'function' ||
    typeof value.pauseCurrent !== 'function' ||
    typeof value.seekPlaying !== 'function' ||
    typeof value.seekPlayingWithCohort !== 'function' ||
    typeof value.seekPaused !== 'function' ||
    typeof value.resumeCurrent !== 'function' ||
    typeof value.replayCurrent !== 'function' ||
    typeof value.replayCurrentWithCohort !== 'function' ||
    typeof value.stopCurrent !== 'function' ||
    typeof value.settleEndedCurrent !== 'function' ||
    typeof value.currentPeerPublication !== 'function' ||
    typeof value.resolveCurrentPeerRangeSource !== 'function' ||
    typeof value.recoverRemoteParticipant !== 'function' ||
    typeof value.close !== 'function' ||
    typeof value.currentRendererSnapshot !== 'function' ||
    typeof value.currentTerminalRendererObservation !== 'function' ||
    typeof value.positionAt !== 'function'
  ) {
    throw new TypeError('File playback product host room factory is invalid');
  }
}

function assertHostMediaOwnerPort(
  value: FilePlaybackProductRuntimeHostMediaOwnerPort,
): asserts value is FilePlaybackProductRuntimeHostMediaOwnerPort {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.adoptWireMessage !== 'function' ||
    typeof value.adoptPeerRangeControl !== 'function' ||
    typeof value.revoke !== 'function' ||
    typeof value.publishCurrent !== 'function' ||
    typeof value.publishSourceLease !== 'function' ||
    typeof value.retireSourceLease !== 'function' ||
    typeof value.publishPrepared !== 'function' ||
    typeof value.bindPrepared !== 'function' ||
    typeof value.whenPreparedRemoteReady !== 'function' ||
    typeof value.activatePrepared !== 'function' ||
    typeof value.retirePrepared !== 'function'
  ) {
    throw new TypeError('File playback product host media owner factory is invalid');
  }
}

function assertSessionRouterPort(
  value: FilePlaybackProductRuntimeSessionRouterPort,
): asserts value is FilePlaybackProductRuntimeSessionRouterPort {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.applicationSessionHooks !== 'function' ||
    typeof value.notifyHostReady !== 'function' ||
    typeof value.notifyTimelineAdopted !== 'function' ||
    typeof value.notifyTimelineUpdated !== 'function' ||
    typeof value.snapshot !== 'function' ||
    typeof value.close !== 'function'
  ) {
    throw new TypeError('File playback product session router factory is invalid');
  }
}

function requireAnchor(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative monotonic time`);
  }
  return value;
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error('File playback product runtime failed', { cause: value });
}

function createBoundedHostPublicationTask<T>(
  sourceTask: Promise<T>,
  signal: AbortSignal,
  onDeadline: (error: Error) => void,
  releaseAuthority: () => void,
): Readonly<{ promise: Promise<T>; cancel: (reason: Error) => void }> {
  let resolveTask!: (value: T) => void;
  let rejectTask!: (reason: Error) => void;
  let settled = false;
  let released = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const cleanup = () => {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
    signal.removeEventListener('abort', onAbort);
    if (!released) {
      released = true;
      releaseAuthority();
    }
  };
  const rejectOnce = (reason: Error): boolean => {
    if (settled) return false;
    settled = true;
    cleanup();
    rejectTask(reason);
    return true;
  };
  const onAbort = () => {
    rejectOnce(
      signal.reason instanceof Error
        ? signal.reason
        : new Error('File playback product prepared publication was aborted'),
    );
  };
  const promise = new Promise<T>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  } else {
    timer = globalThis.setTimeout(() => {
      const error = new Error('File playback product prepared publication exceeded offer lifetime');
      if (rejectOnce(error)) onDeadline(error);
    }, FILE_PLAYBACK_PRODUCT_OFFER_LIFETIME_MS);
  }
  sourceTask.then(
    (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveTask(value);
    },
    (cause: unknown) => rejectOnce(asError(cause)),
  );
  return Object.freeze({ promise, cancel: rejectOnce });
}

function snapshotProductBoundedRoutePolicy(
  options: FilePlaybackProductRuntimeOptions,
): Readonly<FilePlaybackBoundedRoutePolicy> | null {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(options, 'boundedRoutePolicy');
    if (!descriptor) return null;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('File playback product route policy must be own enumerable data');
    }
    return descriptor.value === undefined
      ? null
      : snapshotFilePlaybackBoundedRoutePolicy(descriptor.value);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('File playback product route policy could not be inspected', {
      cause: error,
    });
  }
}

function snapshotNextLocalTrackWarmOptions(
  value: unknown,
): Readonly<FilePlaybackProductNextLocalTrackWarmOptions> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length !== 2 ||
      !Object.hasOwn(descriptors, 'queueItemId') ||
      !Object.hasOwn(descriptors, 'file')
    ) {
      return null;
    }
    const queueItemId = descriptors.queueItemId;
    const file = descriptors.file;
    if (
      !queueItemId?.enumerable ||
      !file?.enumerable ||
      !Object.hasOwn(queueItemId, 'value') ||
      !Object.hasOwn(file, 'value') ||
      !isQueueItemId(queueItemId.value) ||
      typeof File === 'undefined' ||
      !(file.value instanceof File)
    ) {
      return null;
    }
    return Object.freeze({ queueItemId: queueItemId.value, file: file.value });
  } catch {
    return null;
  }
}

/**
 * Gate-aware owner of the product controller and application-session hooks.
 *
 * `beginHostRoom()` and `beginGuestRoom()` are document-room transitions, not
 * transport reconnect operations. Call either exactly once for each genuine
 * new room. In particular, replacing a host-to-guest PeerJS connection must
 * not begin a new host room or advance the controller room generation.
 *
 * Product bootstrap must call `initializeBeforeProtocol()` before protocol
 * listeners can accept a connection. A selected V2 runtime fails closed; it
 * never changes its fixed gate or silently falls back to the legacy engine.
 */
export class FilePlaybackProductRuntime {
  readonly #enabled: boolean;
  readonly #boundedRoutePolicy: Readonly<FilePlaybackBoundedRoutePolicy> | null;
  readonly #providedSessions: FilePlaybackProductRuntimeSessionAdapter | null;
  readonly #createController: (
    input: Readonly<FilePlaybackProductRuntimeControllerFactoryInput>,
  ) => FilePlaybackApplicationController;
  readonly #nowMonotonicMs: () => number;
  readonly #createHostRoom: (
    options: Readonly<FilePlaybackProductHostRoomOptions>,
  ) => FilePlaybackProductRuntimeHostRoomPort;
  readonly #createSessionRouter: (
    options: Readonly<FilePlaybackProductSessionRouterOptions>,
  ) => FilePlaybackProductRuntimeSessionRouterPort;
  readonly #createHostPublisher: (roomToken: object) => FilePlaybackR2WholeBlobPublisher;
  readonly #createGuestRegistry: (
    roomToken: object,
    onFatalRoom: (token: object, error: Error) => void,
  ) => FilePlaybackAssetRegistry;
  readonly #createGuestManager: () => FilePlaybackManager;
  readonly #createHostMediaOwner: (
    options: Readonly<FilePlaybackProductHostMediaOwnerOptions>,
  ) => FilePlaybackProductRuntimeHostMediaOwnerPort;
  readonly #createGuestMediaOwner: (
    options: Readonly<FilePlaybackProductGuestMediaOwnerOptions>,
  ) => FilePlaybackProductSessionRouterGuestMediaOwnerPort;
  readonly #onHealthSystemMessage: (
    message: Readonly<FilePlaybackProductHostHealthSystemMessage>,
  ) => void;
  #sessions: FilePlaybackProductRuntimeSessionAdapter | null = null;
  #controller: FilePlaybackApplicationController | null = null;
  #router: FilePlaybackProductRuntimeSessionRouterPort | null = null;
  #state: RuntimeState = 'idle';
  #failure: Error | null = null;
  #roomActive = false;
  #hostRoomSnapshot: Readonly<FilePlaybackProductHostRoomSnapshot> | null = null;
  #activeHostRoom: ActiveProductHostRoom | null = null;
  #activeGuestRoom: ActiveProductGuestRoom | null = null;
  readonly #connectionContexts = new Set<
    Readonly<FilePlaybackProductSessionRouterConnectionContext>
  >();
  readonly #hostMediaOwners = new Map<
    Readonly<FilePlaybackProductSessionRouterConnectionContext>,
    FilePlaybackProductRuntimeHostMediaOwnerPort
  >();
  readonly #readyHostMediaOwners = new WeakSet<FilePlaybackProductRuntimeHostMediaOwnerPort>();
  readonly #hostMediaOwnerPublicationBarriers = new WeakMap<
    FilePlaybackProductRuntimeHostMediaOwnerPort,
    Promise<void>
  >();
  readonly #hostMediaOwnerWarmAuthorities = new WeakMap<
    FilePlaybackProductRuntimeHostMediaOwnerPort,
    Readonly<FilePlaybackProductHostLocalTrackWarmResult>
  >();
  readonly #hostPreparedCohorts = new Map<
    Readonly<HostPreparedLocalTrack>,
    HostPreparedCohortCycle
  >();
  #hostRoomRetirement: Promise<void> = Promise.resolve();
  #nextLocalTrackWarmEpoch = 0;
  #nextLocalTrackWarmIntent: NextLocalTrackWarmIntent | null = null;
  #nextLocalTrackWarmLane: Promise<void> = Promise.resolve();

  constructor(options: FilePlaybackProductRuntimeOptions = {}) {
    if (
      typeof options !== 'object' ||
      options === null ||
      (options.enabled !== undefined && typeof options.enabled !== 'boolean') ||
      (options.createController !== undefined && typeof options.createController !== 'function') ||
      (options.nowMonotonicMs !== undefined && typeof options.nowMonotonicMs !== 'function') ||
      (options.createHostRoom !== undefined && typeof options.createHostRoom !== 'function') ||
      (options.onHealthSystemMessage !== undefined &&
        typeof options.onHealthSystemMessage !== 'function') ||
      (options.mediaFactoriesForTests !== undefined &&
        (options.mediaFactoriesForTests === null ||
          typeof options.mediaFactoriesForTests !== 'object' ||
          Array.isArray(options.mediaFactoriesForTests)))
    ) {
      throw new TypeError('File playback product runtime options are invalid');
    }
    const media = options.mediaFactoriesForTests ?? {};
    if (
      Object.values(media).some((factory) => factory !== undefined && typeof factory !== 'function')
    ) {
      throw new TypeError('File playback product runtime media factories are invalid');
    }
    if (options.sessions !== undefined) assertSessionAdapter(options.sessions);
    const boundedRoutePolicy = snapshotProductBoundedRoutePolicy(options);
    this.#enabled = options.enabled ?? DEFAULT_ENABLED;
    this.#boundedRoutePolicy = boundedRoutePolicy;
    this.#providedSessions = options.sessions ?? null;
    this.#createController = options.createController ?? defaultControllerFactory;
    this.#nowMonotonicMs = options.nowMonotonicMs ?? defaultMonotonicNow;
    this.#createHostRoom = options.createHostRoom ?? defaultHostRoomFactory;
    this.#createSessionRouter = media.createSessionRouter ?? defaultSessionRouterFactory;
    this.#createHostPublisher = media.createHostPublisher ?? defaultHostPublisherFactory;
    this.#createGuestRegistry = media.createGuestRegistry ?? defaultGuestRegistryFactory;
    this.#createGuestManager = media.createGuestManager ?? defaultGuestManagerFactory;
    this.#createHostMediaOwner = media.createHostMediaOwner ?? defaultHostMediaOwnerFactory;
    this.#createGuestMediaOwner = media.createGuestMediaOwner ?? defaultGuestMediaOwnerFactory;
    this.#onHealthSystemMessage = options.onHealthSystemMessage ?? defaultHealthSystemMessage;
  }

  enabled(): boolean {
    return this.#enabled;
  }

  /** Returns false only when the facade was permanently constructed gate-off. */
  initializeBeforeProtocol(): boolean {
    if (!this.#enabled) return false;
    if (this.#state === 'ready') return true;
    if (this.#state === 'failed') throw this.#failure;
    if (this.#state === 'initializing') {
      const error = new Error('File playback product runtime initialization re-entry');
      this.#state = 'failed';
      this.#failure = error;
      throw error;
    }

    this.#state = 'initializing';
    try {
      const sessions = this.#providedSessions ?? productionSessionAdapter();
      assertSessionAdapter(sessions);
      const controller = this.#createController(
        Object.freeze({
          initialTimeline: createStoppedPlaybackTimeline(
            requireAnchor(this.#nowMonotonicMs(), 'Initial playback anchor'),
            0,
          ),
          sessions,
          onHostReady: (snapshot: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>) =>
            this.#queueHostReadyNotification(snapshot),
          onTimelineAdopted: (event: Readonly<FilePlaybackApplicationTimelineAdoptedEvent>) =>
            this.#queueTimelineAdoptedNotification(event),
          onTimelineUpdated: (event: Readonly<FilePlaybackApplicationTimelineUpdatedEvent>) =>
            this.#queueTimelineUpdatedNotification(event),
        }),
      );
      if (!(controller instanceof FilePlaybackApplicationController)) {
        throw new TypeError('File playback product runtime controller factory is invalid');
      }
      this.#sessions = sessions;
      this.#controller = controller;
      this.#installFreshRouter(controller, sessions);
      this.#state = 'ready';
      return true;
    } catch (cause) {
      const error = asError(cause);
      try {
        this.#router?.close();
      } catch {
        // Initialization failure remains primary.
      }
      this.#router = null;
      this.#sessions = null;
      this.#controller = null;
      this.#roomActive = false;
      this.#hostRoomSnapshot = null;
      this.#activeHostRoom = null;
      this.#activeGuestRoom = null;
      this.#connectionContexts.clear();
      this.#hostMediaOwners.clear();
      this.#hostPreparedCohorts.clear();
      this.#state = 'failed';
      this.#failure = error;
      throw error;
    }
  }

  /** Gate-off returns null; selected V2 must have initialized successfully. */
  controller(): FilePlaybackApplicationController | null {
    if (!this.#enabled) return null;
    return this.#requireReady().controller;
  }

  /** Gate-off, guest, ended, and failed room generations return null. */
  hostRoomSnapshot(): Readonly<FilePlaybackProductHostRoomSnapshot> | null {
    return this.#enabled ? this.#hostRoomSnapshot : null;
  }

  /** Compatibility alias retained while the first product callsite migrates. */
  async startHostFirstLocalFile(
    options: StartFilePlaybackProductHostFirstLocalFileOptions,
  ): Promise<Readonly<FilePlaybackProductHostFirstLocalFileCommit>> {
    return this.#runPreparedCohort('first local file start', (port, prepareRemoteParticipants) =>
      port.startLocalTrackWithCohort({
        ...options,
        positionSeconds: 0,
        prepareRemoteParticipants,
      }),
    );
  }

  /**
   * Speculatively warms one local source without creating run or timeline
   * authority. A permanently gate-off runtime and a non-host room are exact
   * no-ops so the legacy product path allocates no audio resources.
   */
  warmLocalTrack(
    options: WarmFilePlaybackProductHostLocalTrackOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackWarmResult> | null> {
    if (!this.#enabled) return Promise.resolve(null);
    const active = this.#activeHostRoom;
    if (!active || !this.#ownsExactHostRoom(active)) return Promise.resolve(null);
    return this.#dispatchExactHostRoom('local track warm', (port) => port.warmLocalTrack(options));
  }

  /** Retires only the matching speculative source; gate-off/non-host is a no-op. */
  clearWarmLocalTrack(
    options: ClearFilePlaybackProductHostLocalTrackWarmOptions,
  ): Promise<boolean> {
    if (!this.#enabled) return Promise.resolve(false);
    const active = this.#activeHostRoom;
    if (!active || !this.#ownsExactHostRoom(active)) return Promise.resolve(false);
    return this.#dispatchExactHostRoom('local track warm clear', (port) =>
      port.clearWarmLocalTrack(options),
    );
  }

  /**
   * Owns the one speculative next-track warm for this exact host room. Calls
   * for the same queue occurrence and File identity coalesce; a replacement
   * aborts prior construction before entering the serialized warm lane.
   */
  warmNextLocalTrack(options: FilePlaybackProductNextLocalTrackWarmOptions): Promise<boolean> {
    if (!this.#enabled) return Promise.resolve(false);
    const input = snapshotNextLocalTrackWarmOptions(options);
    if (!input) {
      return Promise.reject(new TypeError('File playback next local warm options are invalid'));
    }
    const active = this.#activeHostRoom;
    const room = this.#hostRoomSnapshot;
    if (
      !active ||
      !room ||
      room.roomGeneration !== active.roomGeneration ||
      !this.#ownsExactHostRoom(active)
    ) {
      return Promise.resolve(false);
    }

    const current = this.#nextLocalTrackWarmIntent;
    if (
      current &&
      current.active === active &&
      current.queueItemId === input.queueItemId &&
      current.file === input.file
    ) {
      return current.task;
    }

    this.#nextLocalTrackWarmEpoch += 1;
    const epoch = this.#nextLocalTrackWarmEpoch;
    current?.controller.abort(new Error('File playback next local warm was superseded'));
    const controller = new AbortController();
    const intent: NextLocalTrackWarmIntent = {
      epoch,
      active,
      room,
      queueItemId: input.queueItemId,
      file: input.file,
      controller,
      authority: null,
      status: 'warming',
      task: Promise.resolve(false),
    };
    this.#nextLocalTrackWarmIntent = intent;
    const predecessor = this.#nextLocalTrackWarmLane;
    const task = (async () => {
      await predecessor;
      if (current) {
        await this.#retireNextLocalTrackWarmIntent(
          current,
          new Error('File playback next local warm was superseded'),
        );
      }
      if (
        this.#nextLocalTrackWarmIntent !== intent ||
        this.#nextLocalTrackWarmEpoch !== epoch ||
        controller.signal.aborted ||
        !this.#ownsExactHostRoom(active)
      ) {
        return false;
      }
      try {
        const result = await active.port.warmLocalTrack({
          queueItemId: input.queueItemId,
          file: input.file,
          signal: controller.signal,
        });
        const sourceLease = this.#validateNextLocalTrackWarmResult(intent, result);
        if (!sourceLease) {
          intent.status = 'retired';
          if (this.#nextLocalTrackWarmIntent === intent) {
            this.#nextLocalTrackWarmIntent = null;
          }
          return false;
        }
        intent.authority = result;
        intent.status = 'warmed';
        if (
          this.#nextLocalTrackWarmIntent === intent &&
          this.#nextLocalTrackWarmEpoch === epoch &&
          !controller.signal.aborted &&
          this.#ownsExactHostRoom(active)
        ) {
          this.#fanOutNextLocalTrackWarm(intent);
          return true;
        }
        await this.#retireNextLocalTrackWarmIntent(
          intent,
          new Error('File playback next local warm settled after its authority changed'),
        );
        return false;
      } catch (cause) {
        if (this.#nextLocalTrackWarmIntent === intent) this.#nextLocalTrackWarmIntent = null;
        if (controller.signal.aborted) return false;
        throw cause;
      }
    })();
    intent.task = task;
    this.#nextLocalTrackWarmLane = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** Clears the current speculative target in lane order, preventing queue-ID ABA. */
  clearNextLocalTrackWarm(): Promise<boolean> {
    if (!this.#enabled) return Promise.resolve(false);
    const intent = this.#nextLocalTrackWarmIntent;
    if (!intent) return Promise.resolve(false);
    this.#nextLocalTrackWarmEpoch += 1;
    this.#nextLocalTrackWarmIntent = null;
    intent.controller.abort(new Error('File playback next local warm was cleared'));
    const predecessor = this.#nextLocalTrackWarmLane;
    const task = (async () => {
      await predecessor;
      return this.#retireNextLocalTrackWarmIntent(
        intent,
        new Error('File playback next local warm was cleared'),
      );
    })();
    this.#nextLocalTrackWarmLane = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  startLocalTrack(
    options: StartFilePlaybackProductHostLocalTrackOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    return this.#runPreparedCohort('local track start', (port, prepareRemoteParticipants) =>
      port.startLocalTrackWithCohort({ ...options, prepareRemoteParticipants }),
    );
  }

  pauseCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    return this.#dispatchExactHostRoom('pause', (port) => port.pauseCurrent(options));
  }

  seekPlaying(
    options: FilePlaybackProductHostSeekOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    return this.#runPreparedCohort('playing seek', (port, prepareRemoteParticipants) =>
      port.seekPlayingWithCohort({ ...options, prepareRemoteParticipants }),
    );
  }

  seekPaused(
    options: FilePlaybackProductHostSeekOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    return this.#dispatchExactHostRoom('paused seek', (port) => port.seekPaused(options));
  }

  resumeCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    return this.#dispatchExactHostRoom('resume', (port) => port.resumeCurrent(options));
  }

  replayCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    return this.#runPreparedCohort('replay', (port, prepareRemoteParticipants) =>
      port.replayCurrentWithCohort({ ...options, prepareRemoteParticipants }),
    );
  }

  stopCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    return this.#dispatchExactHostRoom('stop', (port) => port.stopCurrent(options));
  }

  settleEndedCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    return this.#dispatchExactHostRoom('ended settlement', (port) =>
      port.settleEndedCurrent(options),
    );
  }

  currentHostPeerPublication(): Readonly<HostPeerPlaybackPublication> | null {
    const active = this.#activeHostRoom;
    if (!this.#enabled || !active || !this.#ownsExactHostRoom(active)) return null;
    try {
      const publication = active.port.currentPeerPublication();
      return publication && this.#ownsExactHostRoom(active) ? publication : null;
    } catch {
      return null;
    }
  }

  resolveCurrentHostPeerRangeSource(
    options: ResolveHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource> {
    return this.#dispatchExactHostRoom('peer-range source resolution', (port) =>
      port.resolveCurrentPeerRangeSource(options),
    );
  }

  recoverHostRemoteParticipant(
    options: RecoverHostRemoteParticipantOptions,
  ): Promise<Readonly<HostRemoteRecoveryCommit>> {
    return this.#dispatchExactHostRoom('remote participant recovery', (port) =>
      port.recoverRemoteParticipant(options),
    );
  }

  currentHostRendererSnapshot(): FilePlaybackSourceSnapshot | null {
    const active = this.#activeHostRoom;
    if (!this.#enabled || !active || !this.#ownsExactHostRoom(active)) return null;
    return active.port.currentRendererSnapshot();
  }

  currentHostTerminalRendererObservation(): FilePlaybackProductHostTerminalObservation | null {
    const active = this.#activeHostRoom;
    if (!this.#enabled || !active || !this.#ownsExactHostRoom(active)) return null;
    try {
      const observation = active.port.currentTerminalRendererObservation();
      return observation &&
        this.#ownsExactHostRoom(active) &&
        this.#matchesCurrentHostTerminalObservation(observation) &&
        this.#ownsExactHostRoom(active)
        ? observation
        : null;
    } catch {
      return null;
    }
  }

  hostPositionAt(localPerformanceTimeMs: number): FilePlaybackPosition | null {
    const active = this.#activeHostRoom;
    if (!this.#enabled || !active || !this.#ownsExactHostRoom(active)) return null;
    return active.port.positionAt(localPerformanceTimeMs);
  }

  beginHostRoom(hostParticipantId: string): boolean {
    if (!this.#enabled) return false;
    const { controller, sessions } = this.#requireReady();
    this.#assertCanBeginRoom();
    this.#ensureRouter(controller, sessions);
    if (!isFilePlaybackSessionId(hostParticipantId)) {
      throw new TypeError('Host participant ID is invalid');
    }

    let candidate: FilePlaybackProductRuntimeHostRoomPort | null = null;
    let publisher: FilePlaybackR2WholeBlobPublisher | null = null;
    try {
      const authority = snapshotFilePlaybackHostApplicationSessionAuthority(
        sessions.beginHostRoom(hostParticipantId),
      );
      if (!authority || authority.hostParticipantId !== hostParticipantId) {
        throw new TypeError('Host application-session authority is invalid');
      }
      const anchor = requireAnchor(sessions.nowRoomTimeMs(), 'Host room playback anchor');
      controller.beginRoom(createStoppedPlaybackTimeline(anchor, 0));
      const claimed = controller.claimRoomRole('host');
      if (
        claimed.roomRole !== 'host' ||
        !Number.isSafeInteger(claimed.roomGeneration) ||
        claimed.roomGeneration <= 0
      ) {
        throw new Error('Host controller room authority is invalid');
      }
      const hostRoomSnapshot = Object.freeze({
        schemaVersion: 1 as const,
        roomGeneration: claimed.roomGeneration,
        applicationSessionId: authority.applicationSessionId,
        hostParticipantId: authority.hostParticipantId,
      });
      const token = Object.freeze(Object.create(null) as object);
      let pendingFatal: Error | null = null;
      let published = false;
      candidate = this.#createHostRoom(
        Object.freeze({
          controller,
          hostRoomSnapshot,
          ...(this.#boundedRoutePolicy ? { boundedRoutePolicy: this.#boundedRoutePolicy } : {}),
          onFatalRoom: (value: Error) => {
            const error = asError(value);
            if (this.#activeHostRoom?.token === token) {
              this.#handleExactHostRoomFatal(token, error);
            } else if (!published) {
              pendingFatal = error;
            }
          },
        }),
      );
      assertHostRoomPort(candidate);
      if (pendingFatal) throw pendingFatal;
      publisher = this.#createHostPublisher(token);
      if (
        !(publisher instanceof FilePlaybackR2WholeBlobPublisher) ||
        typeof publisher.close !== 'function'
      ) {
        throw new TypeError('File playback product host publisher factory is invalid');
      }
      this.#hostRoomSnapshot = hostRoomSnapshot;
      this.#activeHostRoom = Object.freeze({
        token,
        roomGeneration: claimed.roomGeneration,
        port: candidate,
        publisher,
      });
      this.#activeGuestRoom = null;
      published = true;
      this.#roomActive = true;
      return true;
    } catch (cause) {
      if (publisher) void publisher.close().catch(() => undefined);
      if (candidate) this.#retireHostRoomPort(candidate);
      this.#activeHostRoom = null;
      this.#activeGuestRoom = null;
      this.#hostRoomSnapshot = null;
      try {
        sessions.endRoom();
      } catch {
        // Preserve the original room-start failure while still attempting the
        // required fail-close cleanup.
      }
      try {
        controller.beginRoom(createStoppedPlaybackTimeline(0, 0));
      } catch {
        // A cleanup failure must not replace the initiating room-start error.
      }
      this.#roomActive = false;
      throw cause;
    }
  }

  beginGuestRoom(): boolean {
    if (!this.#enabled) return false;
    const { controller, sessions } = this.#requireReady();
    this.#assertCanBeginRoom();
    this.#ensureRouter(controller, sessions);
    this.#hostRoomSnapshot = null;
    this.#activeHostRoom = null;
    let registry: FilePlaybackAssetRegistry | null = null;
    let manager: FilePlaybackManager | null = null;
    const token = Object.freeze(Object.create(null) as object);
    const roomToken = Object.freeze(Object.create(null) as object);
    try {
      // Before the guest application handshake there is no shared room clock.
      // Zero is the only safe stopped baseline anchor: an arbitrary local
      // performance timestamp could survive an equal-revision replay and then
      // reject the host's lower room-clock anchors.
      controller.beginRoom(createStoppedPlaybackTimeline(0, 0));
      const claimed = controller.claimRoomRole('guest');
      if (
        claimed.roomRole !== 'guest' ||
        !Number.isSafeInteger(claimed.roomGeneration) ||
        claimed.roomGeneration <= 0
      ) {
        throw new Error('Guest controller room authority is invalid');
      }
      registry = this.#createGuestRegistry(roomToken, (fatalToken, error) => {
        if (fatalToken !== roomToken) return;
        queueMicrotask(() => this.#handleExactGuestRoomFatal(token, asError(error)));
      });
      manager = this.#createGuestManager();
      if (
        !(registry instanceof FilePlaybackAssetRegistry) ||
        !(manager instanceof FilePlaybackManager)
      ) {
        throw new TypeError('File playback product guest room factory is invalid');
      }
      this.#activeGuestRoom = Object.freeze({
        token,
        roomGeneration: claimed.roomGeneration,
        roomToken,
        registry,
        manager,
      });
      this.#roomActive = true;
      return true;
    } catch (cause) {
      if (manager) void manager.clear().catch(() => undefined);
      if (registry) void registry.close(roomToken).catch(() => undefined);
      this.#activeGuestRoom = null;
      try {
        controller.beginRoom(createStoppedPlaybackTimeline(0, 0));
      } catch {
        // Preserve the initiating guest-room failure.
      }
      this.#roomActive = false;
      throw cause;
    }
  }

  endRoom(): void {
    if (!this.#enabled) return;
    const { controller, sessions } = this.#requireReady();
    this.#abandonNextLocalTrackWarm('File playback product room ended');
    this.#cancelAllPreparedCohorts(new Error('File playback product room ended'));
    if (!this.#roomActive) {
      const orphan = this.#activeHostRoom;
      this.#activeHostRoom = null;
      if (orphan) {
        this.#retireHostRoomPort(orphan.port);
        void orphan.publisher.close().catch(() => undefined);
      }
      const guestOrphan = this.#activeGuestRoom;
      this.#activeGuestRoom = null;
      if (guestOrphan) this.#retireGuestRoom(guestOrphan);
      this.#hostRoomSnapshot = null;
      return;
    }

    const activeHostRoom = this.#activeHostRoom;
    this.#activeHostRoom = null;
    if (activeHostRoom) {
      this.#retireHostRoomPort(activeHostRoom.port);
    }
    const activeGuestRoom = this.#activeGuestRoom;
    this.#activeGuestRoom = null;
    // Clear public host identity before any synchronous teardown callback can
    // observe a room whose manager authority is already being revoked.
    this.#hostRoomSnapshot = null;

    let failure: unknown;
    let failed = false;
    try {
      // Revocation hooks must observe the still-current controller generation.
      sessions.endRoom();
    } catch (cause) {
      failure = cause;
      failed = true;
    }
    // The application-session manager owns a document-lifetime, one-shot hook
    // installation. Its synchronous revoke callbacks empty this router's room
    // records; the router itself must survive for the next room generation.
    this.#connectionContexts.clear();
    this.#hostMediaOwners.clear();
    this.#hostPreparedCohorts.clear();
    if (activeHostRoom) void activeHostRoom.publisher.close().catch(() => undefined);
    if (activeGuestRoom) this.#retireGuestRoom(activeGuestRoom);
    try {
      controller.beginRoom(createStoppedPlaybackTimeline(0, 0));
    } catch (cause) {
      if (!failed) {
        failure = cause;
        failed = true;
      }
    } finally {
      this.#roomActive = false;
      this.#hostRoomSnapshot = null;
      this.#activeHostRoom = null;
      this.#activeGuestRoom = null;
    }
    if (failed) throw failure;
  }

  handleWake(connection?: DataConnection): boolean {
    if (!this.#enabled || this.#state !== 'ready' || !this.#sessions) return false;
    return this.#sessions.handleWake(connection);
  }

  #installFreshRouter(
    controller: FilePlaybackApplicationController,
    sessions: FilePlaybackProductRuntimeSessionAdapter,
  ): void {
    if (this.#router) throw new Error('File playback product session router already exists');
    const hooks = controller.applicationSessionHooks();
    const controllerPort = Object.freeze({
      onLifecycleEvent: (event: Parameters<NonNullable<typeof hooks.onLifecycleEvent>>[0]) =>
        hooks.onLifecycleEvent?.(event),
      adoptAuxiliaryMessage: (
        event: Parameters<NonNullable<typeof hooks.adoptAuxiliaryMessage>>[0],
        acknowledge: () => void,
      ) => hooks.adoptAuxiliaryMessage?.(event, acknowledge),
    });
    const routerOptions: Readonly<FilePlaybackProductSessionRouterOptions> = Object.freeze({
      controller: controllerPort,
      createHostMediaOwner: (
        context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
      ) => this.#createExactHostMediaOwner(context),
      createGuestMediaOwner: (
        context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
      ) => this.#createExactGuestMediaOwner(context),
    });
    const router = this.#createSessionRouter(routerOptions);
    assertSessionRouterPort(router);
    this.#router = router;
    try {
      sessions.installHooks(router.applicationSessionHooks());
    } catch (cause) {
      this.#router = null;
      try {
        router.close();
      } catch {
        // Hook installation failure remains primary.
      }
      throw cause;
    }
  }

  #ensureRouter(
    controller: FilePlaybackApplicationController,
    sessions: FilePlaybackProductRuntimeSessionAdapter,
  ): void {
    if (this.#router) return;
    this.#installFreshRouter(controller, sessions);
  }

  #createExactHostMediaOwner(
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  ): FilePlaybackProductSessionRouterHostMediaOwnerPort {
    const active = this.#activeHostRoom;
    const sessions = this.#sessions;
    if (!active || !sessions || !this.#ownsExactHostRoom(active)) {
      throw new Error('File playback product host media room is unavailable');
    }
    this.#connectionContexts.add(context);
    try {
      let exactOwner: FilePlaybackProductRuntimeHostMediaOwnerPort | null = null;
      const ownerOptions: Readonly<FilePlaybackProductHostMediaOwnerOptions> = Object.freeze({
        context,
        hostRoom: active.port,
        publisher: active.publisher,
        ...(this.#boundedRoutePolicy ? { boundedRoutePolicy: this.#boundedRoutePolicy } : {}),
        sendRequired: (connection: DataConnection, frame: unknown) =>
          sessions.sendRequired(connection, frame),
        sendWire: <Kind extends keyof FilePlaybackWirePayloadByKind>(
          connection: DataConnection,
          lease: FilePlaybackWireLease,
          payload: FilePlaybackWirePayloadByKind[Kind],
        ) => sessions.sendWire(connection, lease, payload),
        closeConnection: (connection: DataConnection) => sessions.closeConnection(connection),
        onHealthSystemMessage: (message: Readonly<FilePlaybackProductHostHealthSystemMessage>) =>
          this.#onHealthSystemMessage(message),
        resolvePreparedPeerRangeSource: (input: ResolvePreparedHostPeerRangeSourceOptions) => {
          if (!exactOwner) {
            return Promise.reject(
              new Error('File playback product prepared source owner is unavailable'),
            );
          }
          return this.#resolvePreparedHostPeerSource(active, context, exactOwner, input);
        },
        resolveWarmPeerRangeSource: (input: ResolveWarmHostPeerRangeSourceOptions) => {
          if (!exactOwner) {
            return Promise.reject(
              new Error('File playback product warm source owner is unavailable'),
            );
          }
          return this.#resolveWarmHostPeerSource(active, context, exactOwner, input);
        },
      });
      const owner = this.#createHostMediaOwner(ownerOptions);
      assertHostMediaOwnerPort(owner);
      exactOwner = owner;
      this.#hostMediaOwners.set(context, owner);
      return Object.freeze({
        ...(owner.onHostReady
          ? {
              onHostReady: (
                snapshot: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>,
              ) => {
                if (
                  snapshot.roomGeneration !== active.roomGeneration ||
                  this.#hostMediaOwners.get(context) !== owner ||
                  !this.#connectionContexts.has(context) ||
                  !this.#ownsExactHostRoom(active)
                ) {
                  throw new Error('File playback product host media READY authority is stale');
                }
                owner.onHostReady?.(snapshot);
                this.#readyHostMediaOwners.add(owner);
                this.#synchronizeReadyHostMediaOwner(active, context, owner);
              },
            }
          : {}),
        adoptWireMessage: (...args: Parameters<typeof owner.adoptWireMessage>) =>
          owner.adoptWireMessage(...args),
        adoptPeerRangeControl: (...args: Parameters<typeof owner.adoptPeerRangeControl>) =>
          owner.adoptPeerRangeControl(...args),
        revoke: (revokeContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>) => {
          try {
            owner.revoke(revokeContext);
          } finally {
            this.#cancelPreparedCohortOwner(
              context,
              owner,
              new Error('File playback product host media owner was revoked'),
            );
            if (this.#hostMediaOwners.get(context) === owner) {
              this.#hostMediaOwners.delete(context);
            }
            this.#connectionContexts.delete(context);
          }
        },
      });
    } catch (cause) {
      this.#hostMediaOwners.delete(context);
      this.#connectionContexts.delete(context);
      throw cause;
    }
  }

  #createExactGuestMediaOwner(
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  ): FilePlaybackProductSessionRouterGuestMediaOwnerPort {
    const active = this.#activeGuestRoom;
    const sessions = this.#sessions;
    if (!active || !sessions || !this.#ownsExactGuestRoom(active)) {
      throw new Error('File playback product guest media room is unavailable');
    }
    this.#connectionContexts.add(context);
    try {
      const ownerOptions: Readonly<FilePlaybackProductGuestMediaOwnerOptions> = Object.freeze({
        context,
        roomToken: active.roomToken,
        registry: active.registry,
        manager: active.manager,
        getAudioGraph: getPrimedFilePlaybackProductAudio,
        maxEncodedSize: FILE_PLAYBACK_PRODUCT_MAX_PEER_ENCODED_BYTES,
        decodeOrdinaryAudio,
        ...(this.#boundedRoutePolicy ? { boundedRoutePolicy: this.#boundedRoutePolicy } : {}),
        sendRequired: (
          ownerContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
          frame: unknown,
        ) =>
          this.#connectionContexts.has(ownerContext) &&
          ownerContext === context &&
          sessions.sendRequired(context.connection, frame),
        canSendPeerControl: (
          ownerContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
        ) => {
          const connection = context.connection;
          const dataChannel = connection.dataChannel;
          return (
            this.#connectionContexts.has(ownerContext) &&
            ownerContext === context &&
            connection.open === true &&
            dataChannel?.readyState === 'open' &&
            Number.isFinite(dataChannel.bufferedAmount) &&
            dataChannel.bufferedAmount <= FILE_PLAYBACK_PRODUCT_PEER_RANGE_BUFFERED_AMOUNT_LIMIT
          );
        },
        onFatalConnection: (
          ownerContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
          error: Error,
        ) => {
          if (!this.#connectionContexts.has(ownerContext) || ownerContext !== context) return;
          log.error('[FilePlayback] Guest media owner failed closed', error);
          try {
            sessions.closeConnection(context.connection);
          } catch {
            // The exact connection is already terminal.
          }
        },
        onTimelineRendered: (timeline: Readonly<PlaybackTimelineSnapshot>) => {
          if (
            !this.#connectionContexts.has(context) ||
            this.#activeGuestRoom !== active ||
            !this.#ownsExactGuestRoom(active)
          ) {
            return;
          }
          bus.emit(
            'player:v2-guest-timeline-rendered',
            timeline.run?.queueItemId ?? null,
            timeline.phase,
            timeline.positionSeconds,
          );
        },
      });
      const owner = this.#createGuestMediaOwner(ownerOptions);
      return Object.freeze({
        ...(owner.onTimelineAdopted
          ? {
              onTimelineAdopted: (event: Readonly<FilePlaybackApplicationTimelineAdoptedEvent>) =>
                owner.onTimelineAdopted?.(event),
            }
          : {}),
        ...(owner.onTimelineUpdated
          ? {
              onTimelineUpdated: (event: Readonly<FilePlaybackApplicationTimelineUpdatedEvent>) =>
                owner.onTimelineUpdated?.(event),
            }
          : {}),
        adoptAuxiliaryMessage: (...args: Parameters<typeof owner.adoptAuxiliaryMessage>) =>
          owner.adoptAuxiliaryMessage(...args),
        adoptWireMessage: (...args: Parameters<typeof owner.adoptWireMessage>) =>
          owner.adoptWireMessage(...args),
        adoptPeerRangeBulk: (...args: Parameters<typeof owner.adoptPeerRangeBulk>) =>
          owner.adoptPeerRangeBulk(...args),
        revoke: (revokeContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>) => {
          try {
            owner.revoke(revokeContext);
          } finally {
            this.#connectionContexts.delete(context);
          }
        },
      });
    } catch (cause) {
      this.#connectionContexts.delete(context);
      throw cause;
    }
  }

  #queueHostReadyNotification(
    snapshot: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>,
  ): void {
    const router = this.#router;
    if (!router) return;
    queueMicrotask(() => {
      if (
        this.#router !== router ||
        this.#controller?.snapshot().roomGeneration !== snapshot.roomGeneration
      ) {
        return;
      }
      const connection = this.#notificationConnection(snapshot.sessionId, snapshot.connectionId);
      try {
        router.notifyHostReady(snapshot);
      } catch {
        this.#closeNotificationConnection(connection);
      }
    });
  }

  #queueTimelineAdoptedNotification(
    event: Readonly<FilePlaybackApplicationTimelineAdoptedEvent>,
  ): void {
    const router = this.#router;
    if (!router) return;
    queueMicrotask(() => {
      if (
        this.#router !== router ||
        this.#controller?.snapshot().roomGeneration !== event.roomGeneration
      ) {
        return;
      }
      const connection = this.#notificationConnection(event.sessionId, event.connectionId);
      try {
        router.notifyTimelineAdopted(event);
      } catch {
        this.#closeNotificationConnection(connection);
      }
    });
  }

  #queueTimelineUpdatedNotification(
    event: Readonly<FilePlaybackApplicationTimelineUpdatedEvent>,
  ): void {
    const router = this.#router;
    const localRoomGeneration = this.#controller?.snapshot().roomGeneration;
    if (!router || localRoomGeneration === undefined) return;
    // The controller callback runs inside its adoption mutation. Defer router
    // delivery so an exact guest owner can start its own physical transition
    // without re-entering controller or router authority.
    queueMicrotask(() => {
      if (
        this.#router !== router ||
        this.#controller?.snapshot().roomGeneration !== localRoomGeneration
      ) {
        return;
      }
      const connection = this.#notificationConnection(event.sessionId, event.connectionId);
      try {
        router.notifyTimelineUpdated(event);
      } catch {
        this.#closeNotificationConnection(connection);
      }
    });
  }

  #notificationConnection(sessionId: string, connectionId: string): DataConnection | null {
    const matches = [...this.#connectionContexts].filter(
      (context) => context.sessionId === sessionId && context.connectionId === connectionId,
    );
    return matches.length === 1 ? matches[0]!.connection : null;
  }

  #closeNotificationConnection(connection: DataConnection | null): void {
    const sessions = this.#sessions;
    if (!sessions || !connection) return;
    try {
      sessions.closeConnection(connection);
    } catch {
      // The exact failed connection is already terminal.
    }
  }

  async #runPreparedCohort(
    label: string,
    start: (
      port: FilePlaybackProductRuntimeHostRoomPort,
      prepareRemoteParticipants: PrepareFilePlaybackProductHostRemoteParticipants,
    ) => Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>>,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    let cycle: HostPreparedCohortCycle | null = null;
    try {
      const commit = await this.#dispatchExactHostRoom(label, async (port) => {
        const active = this.#activeHostRoom;
        if (!active || active.port !== port || !this.#ownsExactHostRoom(active)) {
          throw new Error(`File playback product host room changed before ${label}`);
        }
        return start(port, async (context) => {
          if (cycle) throw new Error('File playback product host cohort was prepared twice');
          const owners = [...this.#hostMediaOwners.entries()].filter(
            ([ownerContext, owner]) =>
              this.#connectionContexts.has(ownerContext) &&
              this.#hostMediaOwners.get(ownerContext) === owner,
          );
          const contexts = new Set(owners.map(([ownerContext]) => ownerContext));
          const created: HostPreparedCohortCycle = {
            active,
            prepared: context.prepared,
            signal: context.signal,
            resolveSource: context.resolveSource,
            contexts,
            entries: [],
            status: 'preparing',
          };
          cycle = created;
          this.#hostPreparedCohorts.set(context.prepared, created);
          const offers = owners.map(([ownerContext, owner]) => ({
            ownerContext,
            owner,
            task: Promise.resolve().then(() => owner.publishPrepared(context.prepared)),
          }));
          for (const { ownerContext, owner, task: offerTask } of offers) {
            // Connections are independent publication authorities. Each peer
            // needs only its own OFFER before its own RUN; a never-settling
            // peer must not hold every other owner behind a room-wide barrier.
            let bindAuthority: Readonly<{
              active: ActiveProductHostRoom;
              cycle: HostPreparedCohortCycle;
              owner: FilePlaybackProductRuntimeHostMediaOwnerPort;
              ownerContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
              prepared: Readonly<HostPreparedLocalTrack>;
              signal: AbortSignal;
            }> | null = Object.freeze({
              active,
              cycle: created,
              owner,
              ownerContext,
              prepared: context.prepared,
              signal: context.signal,
            });
            const ownerTask = offerTask.then((publication) => {
              const authority = bindAuthority;
              if (
                !authority ||
                (authority.cycle.status !== 'preparing' &&
                  authority.cycle.status !== 'committed') ||
                this.#hostPreparedCohorts.get(authority.prepared) !== authority.cycle ||
                this.#hostMediaOwners.get(authority.ownerContext) !== authority.owner ||
                !this.#connectionContexts.has(authority.ownerContext) ||
                authority.signal.aborted ||
                !this.#ownsExactHostRoom(authority.active)
              ) {
                throw new Error('File playback product prepared offer became stale before bind');
              }
              return authority.owner.bindPrepared(authority.prepared).then(() => publication);
            });
            const bounded = createBoundedHostPublicationTask(
              ownerTask,
              context.signal,
              (error) => this.#closeExactHostMediaOwner(ownerContext, owner, error),
              () => {
                bindAuthority = null;
              },
            );
            const publicationTask = bounded.promise;
            this.#setHostMediaOwnerPublicationBarrier(
              owner,
              publicationTask.then(() => undefined),
            );
            const entry: HostPreparedCohortEntry = {
              context: ownerContext,
              owner,
              publicationTask,
              cancelPublicationTask: bounded.cancel,
              readinessTask: Promise.resolve(),
              publication: null,
              capability: null,
              publicationFailure: null,
              initialCohortAdmitted: false,
              activated: false,
            };
            entry.readinessTask = publicationTask.then(
              async (publication) => {
                entry.publication = publication;
                try {
                  entry.capability = await owner.whenPreparedRemoteReady(context.prepared);
                } catch {
                  // A published but slow/not-ready peer becomes a late-recovery peer
                  // after canonical host activation; it never blocks the room.
                }
              },
              (cause) => {
                entry.publicationFailure = asError(cause);
              },
            );
            created.entries.push(entry);
          }
          await this.#awaitPreparedCohortAdmission(created);
          if (
            created.status !== 'preparing' ||
            this.#hostPreparedCohorts.get(created.prepared) !== created ||
            !this.#ownsExactHostRoom(active)
          ) {
            throw new Error('File playback product host cohort authority is stale');
          }
          const admittedParticipants: Readonly<HostPreparedRemoteParticipant>[] = [];
          for (const entry of created.entries) {
            const capability = entry.capability;
            if (!capability) continue;
            entry.initialCohortAdmitted = true;
            admittedParticipants.push(capability);
          }
          return Object.freeze(admittedParticipants);
        });
      });
      if (cycle) {
        this.#commitPreparedCohort(cycle, commit.timeline);
        this.#consumeNextLocalTrackWarm(cycle);
      }
      return commit;
    } catch (cause) {
      if (cycle) await this.#failPreparedCohort(cycle, asError(cause));
      throw cause;
    }
  }

  async #awaitPreparedCohortAdmission(cycle: HostPreparedCohortCycle): Promise<void> {
    if (cycle.entries.length === 0) return;
    let rejectAbort!: (reason: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort(
        cycle.signal.reason instanceof Error
          ? cycle.signal.reason
          : new Error('File playback product host cohort was aborted'),
      );
    cycle.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (cycle.signal.aborted) onAbort();
      await Promise.race([
        Promise.allSettled(cycle.entries.map((entry) => entry.readinessTask)),
        delay(FILE_PLAYBACK_PRODUCT_COHORT_ADMISSION_MS),
        aborted,
      ]);
    } finally {
      cycle.signal.removeEventListener('abort', onAbort);
    }
  }

  #commitPreparedCohort(
    cycle: HostPreparedCohortCycle,
    timeline: Readonly<PlaybackTimelineSnapshot>,
  ): void {
    if (cycle.status !== 'preparing' || this.#hostPreparedCohorts.get(cycle.prepared) !== cycle) {
      throw new Error('File playback product host cohort commit authority is stale');
    }
    cycle.status = 'committed';
    const activate = (entry: HostPreparedCohortEntry) => {
      if (
        !this.#ownsExactHostRoom(cycle.active) ||
        this.#hostMediaOwners.get(entry.context) !== entry.owner
      ) {
        return;
      }
      try {
        entry.owner.activatePrepared({
          prepared: cycle.prepared,
          timeline,
          initialCohortAdmitted: entry.initialCohortAdmitted,
        });
        entry.activated = true;
      } catch (cause) {
        this.#closeExactHostMediaOwner(entry.context, entry.owner, asError(cause));
      }
    };
    const pending: Promise<void>[] = [];
    for (const entry of cycle.entries) {
      if (entry.publication) {
        activate(entry);
        continue;
      }
      if (entry.publicationFailure) {
        this.#closeExactHostMediaOwner(entry.context, entry.owner, entry.publicationFailure);
        continue;
      }
      pending.push(
        entry.publicationTask.then(
          () => {
            if (
              cycle.status === 'committed' &&
              this.#hostPreparedCohorts.get(cycle.prepared) === cycle
            ) {
              activate(entry);
            }
          },
          (cause) => this.#closeExactHostMediaOwner(entry.context, entry.owner, asError(cause)),
        ),
      );
    }
    for (const [context, owner] of this.#hostMediaOwners) {
      if (cycle.contexts.has(context) || !this.#connectionContexts.has(context)) continue;
      // A READY owner may have joined while the cohort was preparing and still
      // be publishing the previous revision. Preserve its per-owner lane: once
      // that exact barrier settles, publish canonical post-commit truth.
      const predecessor = this.#hostMediaOwnerPublicationBarriers.get(owner) ?? Promise.resolve();
      const currentTask = predecessor.then(() => owner.publishCurrent()).then(() => undefined);
      this.#setHostMediaOwnerPublicationBarrier(owner, currentTask);
      void currentTask.then(
        () => this.#publishNextLocalTrackWarmToOwner(cycle.active, context, owner),
        () => undefined,
      );
      pending.push(
        currentTask.then(
          () => undefined,
          (cause) => this.#closeExactHostMediaOwner(context, owner, asError(cause)),
        ),
      );
    }
    void Promise.allSettled(pending).then(() => {
      if (this.#hostPreparedCohorts.get(cycle.prepared) === cycle) {
        this.#hostPreparedCohorts.delete(cycle.prepared);
      }
    });
  }

  async #failPreparedCohort(cycle: HostPreparedCohortCycle, reason: Error): Promise<void> {
    if (cycle.status === 'failed') return;
    cycle.status = 'failed';
    if (this.#hostPreparedCohorts.get(cycle.prepared) === cycle) {
      this.#hostPreparedCohorts.delete(cycle.prepared);
    }
    for (const entry of cycle.entries) entry.cancelPublicationTask(reason);
    await Promise.allSettled(
      cycle.entries.map((entry) => entry.owner.retirePrepared(cycle.prepared, reason)),
    );
  }

  #validateNextLocalTrackWarmResult(
    intent: NextLocalTrackWarmIntent,
    result: Readonly<FilePlaybackProductHostLocalTrackWarmResult>,
  ): HostLocalTrackSourceLease | null {
    const sourceLeaseDescriptor =
      result && typeof result === 'object'
        ? Object.getOwnPropertyDescriptor(result, 'sourceLease')
        : undefined;
    const hasExactSourceLease =
      sourceLeaseDescriptor?.enumerable === true && Object.hasOwn(sourceLeaseDescriptor, 'value');
    const sourceLease = hasExactSourceLease ? sourceLeaseDescriptor.value : undefined;
    const asset = result?.asset;
    const binding = asset?.binding;
    const metadata = asset?.metadata;
    const expectedMime =
      intent.file.type.trim().length === 0 ? 'application/octet-stream' : intent.file.type;
    if (
      !result ||
      typeof result !== 'object' ||
      result.schemaVersion !== 1 ||
      result.roomGeneration !== intent.room.roomGeneration ||
      result.applicationSessionId !== intent.room.applicationSessionId ||
      result.hostParticipantId !== intent.room.hostParticipantId ||
      !hasExactSourceLease ||
      !asset ||
      typeof asset !== 'object' ||
      !binding ||
      typeof binding !== 'object' ||
      binding.queueItemId !== intent.queueItemId ||
      typeof binding.sourceIdentity !== 'string' ||
      binding.sourceIdentity.length === 0 ||
      typeof binding.transferSessionId !== 'string' ||
      binding.transferSessionId.length === 0 ||
      !metadata ||
      typeof metadata !== 'object' ||
      metadata.name !== intent.file.name ||
      metadata.mime !== expectedMime ||
      !Number.isSafeInteger(asset.encodedSize) ||
      asset.encodedSize !== intent.file.size
    ) {
      throw new Error('File playback next local warm result did not match its exact intent');
    }
    if (result.status === 'warmed') {
      if (
        result.backend !== 'bounded-stream' ||
        sourceLease === null ||
        typeof sourceLease !== 'object'
      ) {
        throw new Error('File playback next local warm result had invalid bounded authority');
      }
      return sourceLease as HostLocalTrackSourceLease;
    }
    if (
      result.status !== 'skipped-non-bounded' ||
      result.backend === 'bounded-stream' ||
      sourceLease !== null
    ) {
      throw new Error('File playback next local warm result had invalid fallback authority');
    }
    return null;
  }

  #ownsNextLocalTrackWarmIntent(intent: NextLocalTrackWarmIntent): boolean {
    return (
      this.#nextLocalTrackWarmIntent === intent &&
      this.#nextLocalTrackWarmEpoch === intent.epoch &&
      intent.status === 'warmed' &&
      intent.authority !== null &&
      !intent.controller.signal.aborted &&
      this.#hostRoomSnapshot === intent.room &&
      this.#ownsExactHostRoom(intent.active)
    );
  }

  #setHostMediaOwnerPublicationBarrier(
    owner: FilePlaybackProductRuntimeHostMediaOwnerPort,
    barrier: Promise<void>,
  ): void {
    this.#hostMediaOwnerPublicationBarriers.set(owner, barrier);
    const release = () => {
      if (this.#hostMediaOwnerPublicationBarriers.get(owner) === barrier) {
        this.#hostMediaOwnerPublicationBarriers.delete(owner);
      }
    };
    void barrier.then(release, release);
  }

  async #awaitHostMediaOwnerPublicationBarrier(
    owner: FilePlaybackProductRuntimeHostMediaOwnerPort,
  ): Promise<void> {
    while (true) {
      const barrier = this.#hostMediaOwnerPublicationBarriers.get(owner);
      if (!barrier) return;
      await barrier;
      if (this.#hostMediaOwnerPublicationBarriers.get(owner) === barrier) return;
    }
  }

  #synchronizeReadyHostMediaOwner(
    active: ActiveProductHostRoom,
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
    owner: FilePlaybackProductRuntimeHostMediaOwnerPort,
  ): void {
    if (
      !this.#readyHostMediaOwners.has(owner) ||
      this.#hostMediaOwners.get(context) !== owner ||
      !this.#connectionContexts.has(context) ||
      !this.#ownsExactHostRoom(active)
    ) {
      return;
    }
    const currentTask = active.port.currentPeerPublication()
      ? Promise.resolve()
          .then(() => owner.publishCurrent())
          .then(() => undefined)
      : Promise.resolve();
    this.#setHostMediaOwnerPublicationBarrier(owner, currentTask);
    void currentTask.then(
      () => this.#publishNextLocalTrackWarmToOwner(active, context, owner),
      (cause) => this.#closeExactHostMediaOwner(context, owner, asError(cause)),
    );
  }

  #fanOutNextLocalTrackWarm(intent: NextLocalTrackWarmIntent): void {
    if (!this.#ownsNextLocalTrackWarmIntent(intent)) return;
    for (const [context, owner] of this.#hostMediaOwners) {
      this.#publishNextLocalTrackWarmToOwner(intent.active, context, owner);
    }
  }

  #publishNextLocalTrackWarmToOwner(
    active: ActiveProductHostRoom,
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
    owner: FilePlaybackProductRuntimeHostMediaOwnerPort,
  ): void {
    const intent = this.#nextLocalTrackWarmIntent;
    const authority = intent?.authority ?? null;
    if (
      !intent ||
      !authority ||
      intent.active !== active ||
      !this.#ownsNextLocalTrackWarmIntent(intent) ||
      !this.#readyHostMediaOwners.has(owner) ||
      this.#hostMediaOwners.get(context) !== owner ||
      !this.#connectionContexts.has(context)
    ) {
      return;
    }
    const sourceLease = authority.sourceLease;
    if (!sourceLease || this.#hostMediaOwnerWarmAuthorities.get(owner) === authority) return;
    this.#hostMediaOwnerWarmAuthorities.set(owner, authority);
    const task = (async () => {
      let published = false;
      try {
        await this.#awaitHostMediaOwnerPublicationBarrier(owner);
        if (
          intent.authority !== authority ||
          !this.#ownsNextLocalTrackWarmIntent(intent) ||
          !this.#readyHostMediaOwners.has(owner) ||
          this.#hostMediaOwners.get(context) !== owner ||
          !this.#connectionContexts.has(context)
        ) {
          return;
        }
        await owner.publishSourceLease(authority);
        published = true;
        if (intent.status === 'consumed') return;
        if (
          intent.authority !== authority ||
          !this.#ownsNextLocalTrackWarmIntent(intent) ||
          this.#hostMediaOwners.get(context) !== owner ||
          !this.#connectionContexts.has(context)
        ) {
          await owner
            .retireSourceLease(
              sourceLease,
              new Error('File playback next local source offer became stale after publication'),
            )
            .catch(() => undefined);
        }
      } finally {
        if (
          (!published ||
            intent.status !== 'warmed' ||
            this.#hostMediaOwners.get(context) !== owner ||
            !this.#connectionContexts.has(context)) &&
          this.#hostMediaOwnerWarmAuthorities.get(owner) === authority
        ) {
          this.#hostMediaOwnerWarmAuthorities.delete(owner);
        }
      }
    })();
    void task.catch(() => {
      if (this.#hostMediaOwnerWarmAuthorities.get(owner) === authority) {
        this.#hostMediaOwnerWarmAuthorities.delete(owner);
      }
    });
  }

  async #retireNextLocalTrackWarmIntent(
    intent: NextLocalTrackWarmIntent,
    reason: Error,
  ): Promise<boolean> {
    if (intent.status === 'consumed' || intent.status === 'retired') return false;
    const authority = intent.authority;
    intent.status = 'retired';
    intent.authority = null;
    if (!authority?.sourceLease) return false;
    const sourceLease = authority.sourceLease;
    const retirements: Promise<void>[] = [];
    if (this.#ownsExactHostRoom(intent.active)) {
      for (const [context, owner] of this.#hostMediaOwners) {
        if (
          this.#hostMediaOwners.get(context) !== owner ||
          !this.#connectionContexts.has(context)
        ) {
          continue;
        }
        if (this.#hostMediaOwnerWarmAuthorities.get(owner) === authority) {
          this.#hostMediaOwnerWarmAuthorities.delete(owner);
        }
        retirements.push(owner.retireSourceLease(sourceLease, reason));
      }
    }
    await Promise.allSettled(retirements);
    try {
      const cleared = await intent.active.port.clearWarmLocalTrackByLease({
        sourceLease,
        signal: new AbortController().signal,
      });
      if (typeof cleared !== 'boolean') {
        throw new TypeError('File playback product host room returned an invalid exact warm clear');
      }
      return cleared;
    } catch (cause) {
      if (this.#ownsExactHostRoom(intent.active)) throw cause;
      return false;
    }
  }

  #consumeNextLocalTrackWarm(cycle: HostPreparedCohortCycle): void {
    const intent = this.#nextLocalTrackWarmIntent;
    const authority = intent?.authority ?? null;
    if (
      !intent ||
      !authority?.sourceLease ||
      intent.status !== 'warmed' ||
      intent.active !== cycle.active ||
      cycle.prepared.sourceLease !== authority.sourceLease ||
      cycle.prepared.state.queueItemId !== intent.queueItemId ||
      cycle.prepared.asset.binding.queueItemId !== intent.queueItemId ||
      cycle.prepared.asset.binding.sourceIdentity !== authority.asset.binding.sourceIdentity ||
      cycle.prepared.asset.binding.transferSessionId !==
        authority.asset.binding.transferSessionId ||
      cycle.prepared.asset.encodedSize !== authority.asset.encodedSize ||
      cycle.prepared.asset.metadata.name !== authority.asset.metadata.name ||
      cycle.prepared.asset.metadata.mime !== authority.asset.metadata.mime
    ) {
      return;
    }
    intent.status = 'consumed';
    intent.authority = null;
    for (const owner of this.#hostMediaOwners.values()) {
      if (this.#hostMediaOwnerWarmAuthorities.get(owner) === authority) {
        this.#hostMediaOwnerWarmAuthorities.delete(owner);
      }
    }
    this.#nextLocalTrackWarmEpoch += 1;
    this.#nextLocalTrackWarmIntent = null;
  }

  async #resolveWarmHostPeerSource(
    active: ActiveProductHostRoom,
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
    owner: FilePlaybackProductRuntimeHostMediaOwnerPort,
    options: ResolveWarmHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource> {
    const intent = this.#nextLocalTrackWarmIntent;
    const authority = intent?.authority ?? null;
    if (
      !intent ||
      !authority?.sourceLease ||
      intent.active !== active ||
      options.sourceLease !== authority.sourceLease ||
      options.sourceIdentity !== authority.asset.binding.sourceIdentity ||
      options.signal.aborted ||
      !this.#ownsNextLocalTrackWarmIntent(intent) ||
      !this.#readyHostMediaOwners.has(owner) ||
      this.#hostMediaOwners.get(context) !== owner ||
      !this.#connectionContexts.has(context)
    ) {
      throw new Error('File playback product warm source authority is stale');
    }
    const source = await active.port.resolveWarmPeerRangeSource(options);
    if (
      options.signal.aborted ||
      intent.authority !== authority ||
      !this.#ownsNextLocalTrackWarmIntent(intent) ||
      !this.#readyHostMediaOwners.has(owner) ||
      this.#hostMediaOwners.get(context) !== owner ||
      !this.#connectionContexts.has(context)
    ) {
      if (!(source instanceof Blob)) await source.close().catch(() => undefined);
      throw new Error('File playback product warm source changed during resolution');
    }
    return source;
  }

  async #resolvePreparedHostPeerSource(
    active: ActiveProductHostRoom,
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
    owner: FilePlaybackProductRuntimeHostMediaOwnerPort,
    options: ResolvePreparedHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource> {
    const cycle = this.#hostPreparedCohorts.get(options.prepared);
    if (
      !cycle ||
      cycle.active !== active ||
      (cycle.status !== 'preparing' && cycle.status !== 'committed') ||
      !cycle.contexts.has(context) ||
      !this.#connectionContexts.has(context) ||
      this.#hostMediaOwners.get(context) !== owner ||
      options.signal.aborted ||
      cycle.signal.aborted ||
      options.sourceIdentity !== options.prepared.asset.binding.sourceIdentity ||
      !this.#ownsExactHostRoom(active)
    ) {
      throw new Error('File playback product prepared source authority is stale');
    }
    const source = await cycle.resolveSource(
      options.sourceIdentity,
      options.peerRangeManifest,
      options.signal,
    );
    if (
      this.#hostPreparedCohorts.get(options.prepared) !== cycle ||
      (cycle.status !== 'preparing' && cycle.status !== 'committed') ||
      !cycle.contexts.has(context) ||
      !this.#connectionContexts.has(context) ||
      this.#hostMediaOwners.get(context) !== owner ||
      options.signal.aborted ||
      cycle.signal.aborted ||
      options.sourceIdentity !== options.prepared.asset.binding.sourceIdentity ||
      !this.#ownsExactHostRoom(active)
    ) {
      if (!(source instanceof Blob)) await source.close().catch(() => undefined);
      throw new Error('File playback product prepared source changed during resolution');
    }
    return source;
  }

  #closeExactHostMediaOwner(
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
    owner: FilePlaybackProductRuntimeHostMediaOwnerPort,
    reason: Error,
  ): void {
    if (this.#hostMediaOwners.get(context) !== owner) return;
    this.#cancelPreparedCohortOwner(context, owner, reason);
    this.#hostMediaOwners.delete(context);
    this.#connectionContexts.delete(context);
    try {
      this.#sessions?.closeConnection(context.connection);
    } catch {
      // The exact failed connection is already terminal.
    }
  }

  #cancelPreparedCohortOwner(
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
    owner: FilePlaybackProductRuntimeHostMediaOwnerPort,
    reason: Error,
  ): void {
    for (const cycle of this.#hostPreparedCohorts.values()) {
      for (const entry of cycle.entries) {
        if (entry.context === context && entry.owner === owner) {
          entry.cancelPublicationTask(reason);
        }
      }
    }
  }

  #cancelAllPreparedCohorts(reason: Error): void {
    for (const cycle of this.#hostPreparedCohorts.values()) {
      cycle.status = 'failed';
      for (const entry of cycle.entries) entry.cancelPublicationTask(reason);
    }
    this.#hostPreparedCohorts.clear();
  }

  /**
   * Dispatches one renderer operation only after the previous-room native
   * cleanup barrier and an exact ABA-resistant host-room ownership check.
   */
  async #dispatchExactHostRoom<T>(
    label: string,
    dispatch: (port: FilePlaybackProductRuntimeHostRoomPort) => Promise<T>,
  ): Promise<T> {
    if (!this.#enabled) throw new Error('File playback product runtime is disabled');
    this.#requireReady();
    const active = this.#activeHostRoom;
    if (!active) throw new Error('File playback product host room is unavailable');
    const retirement = this.#hostRoomRetirement;
    try {
      await retirement;
    } catch (cause) {
      if (this.#activeHostRoom === active) {
        try {
          this.endRoom();
        } catch {
          // The renderer cleanup failure remains the primary media failure.
        }
      }
      throw asError(cause);
    }
    if (this.#hostRoomRetirement !== retirement || !this.#ownsExactHostRoom(active)) {
      throw new Error(`File playback product host room changed before ${label}`);
    }
    return dispatch(active.port);
  }

  #abandonNextLocalTrackWarm(reason: string): void {
    this.#nextLocalTrackWarmEpoch += 1;
    const intent = this.#nextLocalTrackWarmIntent;
    this.#nextLocalTrackWarmIntent = null;
    // A retired room cannot serialize work for its successor. Exact room
    // identity fences any late settlement from the detached predecessor.
    this.#nextLocalTrackWarmLane = Promise.resolve();
    if (!intent) return;
    const error = new Error(reason);
    intent.controller.abort(error);
    const authority = intent.authority;
    const sourceLease = authority?.sourceLease ?? null;
    intent.authority = null;
    if (intent.status !== 'consumed') intent.status = 'retired';
    if (!sourceLease) return;
    for (const [context, owner] of this.#hostMediaOwners) {
      if (this.#hostMediaOwners.get(context) !== owner) continue;
      if (authority && this.#hostMediaOwnerWarmAuthorities.get(owner) === authority) {
        this.#hostMediaOwnerWarmAuthorities.delete(owner);
      }
      void owner.retireSourceLease(sourceLease, error).catch(() => undefined);
    }
  }

  #ownsExactHostRoom(active: ActiveProductHostRoom): boolean {
    try {
      const hostRoom = this.#hostRoomSnapshot;
      const controller = this.#controller;
      if (
        !this.#roomActive ||
        this.#activeHostRoom !== active ||
        !hostRoom ||
        !controller ||
        hostRoom.roomGeneration !== active.roomGeneration
      ) {
        return false;
      }
      const snapshot = controller.snapshot();
      return (
        snapshot.roomGeneration === active.roomGeneration &&
        snapshot.roomRole === 'host' &&
        snapshot.timeline === controller.timelineSnapshot()
      );
    } catch {
      return false;
    }
  }

  #ownsExactGuestRoom(active: ActiveProductGuestRoom): boolean {
    try {
      const controller = this.#controller;
      if (!this.#roomActive || this.#activeGuestRoom !== active || !controller) return false;
      const snapshot = controller.snapshot();
      return snapshot.roomGeneration === active.roomGeneration && snapshot.roomRole === 'guest';
    } catch {
      return false;
    }
  }

  #matchesCurrentHostTerminalObservation(
    observation: FilePlaybackProductHostTerminalObservation,
  ): boolean {
    try {
      const controller = this.#controller;
      if (!controller) return false;
      const timeline = controller.timelineSnapshot();
      return (
        timeline.phase === 'playing' &&
        timeline.run !== null &&
        observation.phase === 'ended' &&
        observation.run !== null &&
        observation.queueItemId === timeline.run.queueItemId &&
        observation.run.queueItemId === timeline.run.queueItemId &&
        observation.run.runId === timeline.run.runId &&
        observation.revision === timeline.revision &&
        observation.run.revision === timeline.revision
      );
    } catch {
      return false;
    }
  }

  #handleExactHostRoomFatal(token: object, _error: Error): void {
    if (this.#activeHostRoom?.token !== token) return;
    try {
      this.endRoom();
    } catch {
      // The room and controller are fenced even when teardown reports an error.
    }
  }

  #handleExactGuestRoomFatal(token: object, _error: Error): void {
    if (this.#activeGuestRoom?.token !== token) return;
    try {
      this.endRoom();
    } catch {
      // The room, router, registry, and controller are fenced on every path.
    }
  }

  #retireGuestRoom(room: ActiveProductGuestRoom): void {
    const cleanup = Promise.allSettled([
      room.manager.clear(),
      room.registry.close(room.roomToken),
    ]).then(() => undefined);
    void cleanup.catch(() => undefined);
  }

  #retireHostRoomPort(port: FilePlaybackProductRuntimeHostRoomPort): void {
    let cleanup: Promise<void>;
    try {
      cleanup = Promise.resolve(port.close());
    } catch (cause) {
      cleanup = Promise.reject(cause);
    }
    const previous = this.#hostRoomRetirement;
    const retirement = Promise.allSettled([previous, cleanup]).then((settlements) => {
      const failures = settlements
        .filter(
          (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected',
        )
        .map((settlement) => settlement.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Multiple product host room cleanup operations failed');
      }
    });
    this.#hostRoomRetirement = retirement;
    void retirement.catch(() => undefined);
  }

  #assertCanBeginRoom(): void {
    if (this.#roomActive) {
      throw new Error('File playback product runtime already owns an active room');
    }
  }

  #requireReady(): {
    readonly controller: FilePlaybackApplicationController;
    readonly sessions: FilePlaybackProductRuntimeSessionAdapter;
  } {
    if (this.#state === 'failed') throw this.#failure;
    if (this.#state !== 'ready' || !this.#controller || !this.#sessions) {
      throw new Error('File playback product runtime was not initialized before protocol');
    }
    return { controller: this.#controller, sessions: this.#sessions };
  }
}

const filePlaybackProductRuntime = new FilePlaybackProductRuntime();

export function getFilePlaybackProductRuntime(): FilePlaybackProductRuntime {
  return filePlaybackProductRuntime;
}
