import type {
  FilePlaybackPeerRangeAdoptionEvent,
  FilePlaybackWireAdoptionEvent,
} from '../network/file-playback-application-session.ts';
import type { FilePlaybackApplicationControllerConnectionSnapshot } from './file-playback-application-controller.ts';
import { FilePlaybackConnectionChannel } from '../network/file-playback-connection-channel.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import type { DataConnection } from '../types/index.ts';
import {
  createFileMediaPrepareId,
  createPeerRangeFileMediaSourceOfferV2,
  createR2WholeBlobFileMediaSourceOfferV2,
  type FileMediaSourceOfferV2,
  type PeerRangeFileMediaSourceOfferV2,
} from './file-media-source-offer.ts';
import { createFileMediaSourceRevokeV2 } from './file-media-source-revoke.ts';
import type {
  HostPreparedLocalTrack,
  HostPreparedRemoteParticipant,
  HostLocalTrackSourceLease,
  HostPeerPlaybackPublication,
  HostPeerRangeSource,
  HostRemoteRecoveryCommit,
  RecoverHostRemoteParticipantOptions,
  ResolvePreparedHostPeerRangeSourceOptions,
  ResolveHostPeerRangeSourceOptions,
  ResolveWarmHostPeerRangeSourceOptions,
} from './file-playback-host-first-file-engine.ts';
import type { FilePlaybackProductHostLocalTrackWarmResult } from './file-playback-product-host-room.ts';
import { FilePlaybackR2WholeBlobPublisher } from './file-playback-r2-whole-blob-publisher.ts';
import {
  createFilePlaybackRunBindingV2,
  type FilePlaybackRunBindingV2,
} from './file-playback-run-binding.ts';
import type {
  FilePlaybackProductSessionRouterConnectionContext,
  FilePlaybackProductSessionRouterHostMediaOwnerPort,
} from './file-playback-product-session-router.ts';
import type { HostRendezvousAttempt } from './rendezvous-coordinator.ts';
import {
  createFilePlaybackTimelineUpdateV2,
  timelineFromFilePlaybackTimelineUpdateV2,
  type FilePlaybackTimelineUpdateV2,
} from './file-playback-timeline-update.ts';
import type { PlaybackTimelineSnapshot } from './playback-timeline.ts';
import { RemoteRendezvousParticipant } from './remote-rendezvous-participant.ts';
import {
  ParticipantHealthMonitor,
  type ParticipantHealthAction,
  type ParticipantHealthSignal,
  type ParticipantHealthTransition,
} from './participant-health.ts';
import type {
  FilePlaybackWireAttemptLease,
  FilePlaybackWireLease,
  FilePlaybackWireStateLease,
} from './file-playback-wire-binding.ts';
import type {
  FilePlaybackWireMessageForKind,
  FilePlaybackWirePayloadByKind,
} from './file-playback-wire-sender.ts';
import {
  bindPeerRangeTrustedConnection,
  PeerRangeHostResponder,
} from './sources/peer-range-transport.ts';
import {
  parsePeerRangeControlFrame,
  type PeerRangeBulkFrame,
} from './sources/peer-range-protocol.ts';
import type { EncodedAudioSource } from './sources/encoded-audio-source.ts';

const OPTION_KEYS = Object.freeze([
  'closeConnection',
  'context',
  'hostRoom',
  'onHealthSystemMessage',
  'publisher',
  'resolvePreparedPeerRangeSource',
  'resolveWarmPeerRangeSource',
  'runtimeForTests',
  'sendRequired',
  'sendWire',
] as const);
const REQUIRED_OPTION_KEYS = OPTION_KEYS.filter(
  (key) =>
    key !== 'resolvePreparedPeerRangeSource' &&
    key !== 'resolveWarmPeerRangeSource' &&
    key !== 'runtimeForTests',
);
const RUNTIME_KEYS = Object.freeze([
  'cancelTimeoutForTests',
  'cancelIntervalForTests',
  'createMediaIdForTests',
  'nowEpochMsForTests',
  'scheduleTimeoutForTests',
  'scheduleIntervalForTests',
] as const);
const CONTEXT_KEYS = Object.freeze([
  'channel',
  'connection',
  'connectionId',
  'connectionToken',
  'guestParticipantId',
  'hostParticipantId',
  'role',
  'routerToken',
  'schemaVersion',
  'sessionId',
] as const);
const WIRE_EVENT_KEYS = Object.freeze([
  'attemptLease',
  'channel',
  'connection',
  'message',
  'stateLease',
] as const);
const PEER_RANGE_EVENT_KEYS = Object.freeze([
  'channel',
  'connection',
  'connectionToken',
  'frame',
  'lane',
  'role',
] as const);
const READY_KEYS = Object.freeze([
  'baselineId',
  'baselineStatus',
  'clockReady',
  'connectionId',
  'epoch',
  'playbackRevision',
  'ready',
  'role',
  'roomGeneration',
  'schemaVersion',
  'sessionId',
] as const);
const ACTIVATE_PREPARED_KEYS = Object.freeze(['prepared', 'timeline'] as const);
const PEER_RANGE_BUFFERED_AMOUNT_LIMIT = 256 * 1024;
export const FILE_PLAYBACK_PRODUCT_OFFER_LIFETIME_MS = 15 * 60 * 1_000;
const HEALTH_LEASE_MS = 2_000;
const HEALTH_TICK_MS = 250;

type ExactRecord = Readonly<Record<string, unknown>>;
type TimerHandle = string;
let healthTimerSequence = 0;
let warmOfferTimerSequence = 0;

export interface FilePlaybackProductHostMediaRoomPort {
  currentPeerPublication(): Readonly<HostPeerPlaybackPublication> | null;
  resolveCurrentPeerRangeSource(
    options: ResolveHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource>;
  recoverRemoteParticipant(
    options: RecoverHostRemoteParticipantOptions,
  ): Promise<Readonly<HostRemoteRecoveryCommit>>;
}

export interface FilePlaybackProductHostHealthSystemMessage {
  readonly schemaVersion: 1;
  readonly participantId: string;
  readonly messageKey: 'participant-connection-unstable-recovering';
}

export interface FilePlaybackProductHostMediaOwnerRuntimeForTests {
  readonly createMediaIdForTests?: () => string;
  readonly nowEpochMsForTests?: () => number;
  readonly scheduleIntervalForTests?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancelIntervalForTests?: (handle: TimerHandle) => void;
  readonly scheduleTimeoutForTests?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancelTimeoutForTests?: (handle: TimerHandle) => void;
}

export interface FilePlaybackProductHostMediaOwnerOptions {
  readonly context: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  readonly hostRoom: FilePlaybackProductHostMediaRoomPort;
  readonly publisher: FilePlaybackR2WholeBlobPublisher;
  readonly sendRequired: (connection: DataConnection, frame: unknown) => boolean;
  readonly sendWire: <Kind extends keyof FilePlaybackWirePayloadByKind>(
    connection: DataConnection,
    lease: FilePlaybackWireLease,
    payload: FilePlaybackWirePayloadByKind[Kind],
  ) => FilePlaybackWireMessageForKind<Kind> | null;
  readonly closeConnection: (connection: DataConnection) => void;
  readonly onHealthSystemMessage: (
    message: Readonly<FilePlaybackProductHostHealthSystemMessage>,
  ) => void;
  /** Exact room/engine resolver for an opaque prepared candidate capability. */
  readonly resolvePreparedPeerRangeSource?: (
    options: ResolvePreparedHostPeerRangeSourceOptions,
  ) => Promise<HostPeerRangeSource>;
  /** Exact room/engine resolver for an opaque bounded warm-source lease. */
  readonly resolveWarmPeerRangeSource?: (
    options: ResolveWarmHostPeerRangeSourceOptions,
  ) => Promise<HostPeerRangeSource>;
  readonly runtimeForTests?: FilePlaybackProductHostMediaOwnerRuntimeForTests;
}

export interface FilePlaybackProductHostPublicationCommit {
  readonly schemaVersion: 1;
  readonly publication: Readonly<HostPeerPlaybackPublication>;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
}

/** Body-free result after one prepared candidate has been offered but not committed. */
export interface FilePlaybackProductHostPreparedPublicationCommit {
  readonly schemaVersion: 1;
  readonly prepared: Readonly<HostPreparedLocalTrack>;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
}

/** Body-free result after an exact bounded warm lease has been offered. */
export interface FilePlaybackProductHostSourceLeasePublicationCommit {
  readonly schemaVersion: 1;
  readonly sourceLease: HostLocalTrackSourceLease;
  readonly offer: Readonly<PeerRangeFileMediaSourceOfferV2>;
}

export interface ActivateFilePlaybackProductHostPreparedOptions {
  readonly prepared: Readonly<HostPreparedLocalTrack>;
  readonly timeline: Readonly<PlaybackTimelineSnapshot>;
}

interface RuntimeSnapshot {
  readonly createMediaId: () => string;
  readonly nowEpochMs: () => number;
  readonly scheduleInterval: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancelInterval: (handle: TimerHandle) => void;
  readonly scheduleTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancelTimeout: (handle: TimerHandle) => void;
}

interface PublicationRecord {
  readonly epoch: number;
  readonly publication: Readonly<HostPeerPlaybackPublication>;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  readonly stateLease: FilePlaybackWireStateLease;
  readonly handleId: string | null;
  readonly commit: Readonly<FilePlaybackProductHostPublicationCommit>;
  readonly transferredWarmSource: WarmSourceOfferRecord | null;
  participant: RemoteRendezvousParticipant | null;
  status: 'publishing' | 'published';
}

interface CandidateSourceRecord {
  readonly prepared: Readonly<HostPreparedLocalTrack>;
  readonly resolve: NonNullable<
    FilePlaybackProductHostMediaOwnerOptions['resolvePreparedPeerRangeSource']
  >;
}

interface PreparedPublicationRecord {
  readonly epoch: number;
  readonly prepared: Readonly<HostPreparedLocalTrack>;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  stateLease: FilePlaybackWireStateLease | null;
  readonly handleId: string | null;
  readonly source: CandidateSourceRecord;
  readonly commit: Readonly<FilePlaybackProductHostPreparedPublicationCommit>;
  readonly transferredWarmSource: WarmSourceOfferRecord | null;
  readonly ready: Promise<Readonly<HostPreparedRemoteParticipant>>;
  readonly resolveReady: (value: Readonly<HostPreparedRemoteParticipant>) => void;
  readonly rejectReady: (error: Error) => void;
  participant: RemoteRendezvousParticipant | null;
  capability: Readonly<HostPreparedRemoteParticipant> | null;
  offerSent: boolean;
  offerRevokeSent: boolean;
  status: 'offering' | 'offered' | 'binding' | 'published' | 'activated' | 'retired';
}

/** Independent offer-only authority: it never owns prepared/run/wire state. */
interface WarmSourceOfferRecord {
  readonly epoch: number;
  readonly authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>;
  readonly sourceLease: HostLocalTrackSourceLease;
  readonly offer: Readonly<PeerRangeFileMediaSourceOfferV2>;
  readonly handleId: string;
  readonly resolve: NonNullable<
    FilePlaybackProductHostMediaOwnerOptions['resolveWarmPeerRangeSource']
  >;
  readonly controller: AbortController;
  readonly commit: Readonly<FilePlaybackProductHostSourceLeasePublicationCommit>;
  expiryTimer: TimerHandle | null;
  offerSent: boolean;
  offerRevokeSent: boolean;
  status: 'offering' | 'offered' | 'transferred' | 'retired';
}

interface PreparedRetirementRecord {
  readonly prepared: Readonly<HostPreparedLocalTrack>;
  readonly promise: Promise<void>;
}

interface AttemptRecord {
  readonly mode: 'prepared' | 'recovery';
  readonly publicationEpoch: number;
  readonly participant: RemoteRendezvousParticipant;
  readonly attempt: HostRendezvousAttempt;
  readonly lease: FilePlaybackWireAttemptLease;
  readonly stateLease: FilePlaybackWireStateLease;
  readonly state: Readonly<HostPreparedLocalTrack['state']>;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly evidence: Promise<void>;
  readonly resolveEvidence: () => void;
  readonly rejectEvidence: (error: Error) => void;
  readonly preparedRecord: PreparedPublicationRecord | null;
  outcome: 'pending' | 'succeeded' | 'failed';
  stateCommitted: boolean;
  status: 'candidate' | 'current' | 'retired';
}

function hasPreparedSourceAuthority(record: PreparedPublicationRecord): boolean {
  return (
    record.status === 'offering' ||
    record.status === 'offered' ||
    record.status === 'binding' ||
    record.status === 'published'
  );
}

class HostMediaOwnerConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HostMediaOwnerConnectionError';
  }
}

const trustedChannelRole = FilePlaybackConnectionChannel.prototype.role;
const trustedChannelBinding = FilePlaybackConnectionChannel.prototype.establishedBinding;
const trustedChannelToken = FilePlaybackConnectionChannel.prototype.liveConnectionToken;
const trustedChannelClosed = FilePlaybackConnectionChannel.prototype.isClosed;
const trustedChannelNow = FilePlaybackConnectionChannel.prototype.nowRoomTimeMs;
const trustedChannelQuality = FilePlaybackConnectionChannel.prototype.quality;
const trustedChannelClockReady = FilePlaybackConnectionChannel.prototype.clockReady;
const trustedChannelBootstrapCurrent =
  FilePlaybackConnectionChannel.prototype.bootstrapCurrentMedia;
const trustedChannelBootstrapStopped = FilePlaybackConnectionChannel.prototype.bootstrapStopped;
const trustedChannelStageMedia = FilePlaybackConnectionChannel.prototype.stageMedia;
const trustedChannelCommitMedia = FilePlaybackConnectionChannel.prototype.commitMedia;
const trustedChannelRetireMedia = FilePlaybackConnectionChannel.prototype.retireMedia;
const trustedChannelStageAttempt = FilePlaybackConnectionChannel.prototype.stageAttempt;
const trustedChannelCommitAttempt = FilePlaybackConnectionChannel.prototype.commitAttempt;
const trustedChannelRetireAttempt = FilePlaybackConnectionChannel.prototype.retireAttempt;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotExactRecord(value: unknown, expectedKeys: readonly string[]): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = new Set(expectedKeys);
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
      createMediaId: () => createFileMediaPrepareId(),
      nowEpochMs: () => Date.now(),
      scheduleInterval: (callback: () => void, delayMs: number) => {
        const name = `file-playback-host-media-health-${++healthTimerSequence}`;
        setManagedTimer(name, callback, delayMs, { interval: true });
        return name;
      },
      cancelInterval: (handle: TimerHandle) => clearManagedTimer(handle),
      scheduleTimeout: (callback: () => void, delayMs: number) => {
        const name = `file-playback-host-media-warm-offer-${++warmOfferTimerSequence}`;
        setManagedTimer(name, callback, delayMs);
        return name;
      },
      cancelTimeout: (handle: TimerHandle) => clearManagedTimer(handle),
    });
  }
  const snapshot = snapshotExactRecord(
    value,
    RUNTIME_KEYS.filter((key) => Object.hasOwn(value as object, key)),
  );
  if (!snapshot) return null;
  const createMediaId = snapshot.createMediaIdForTests;
  const nowEpochMs = snapshot.nowEpochMsForTests;
  const scheduleInterval = snapshot.scheduleIntervalForTests;
  const cancelInterval = snapshot.cancelIntervalForTests;
  const scheduleTimeout = snapshot.scheduleTimeoutForTests;
  const cancelTimeout = snapshot.cancelTimeoutForTests;
  if (
    (createMediaId !== undefined && typeof createMediaId !== 'function') ||
    (nowEpochMs !== undefined && typeof nowEpochMs !== 'function') ||
    (scheduleInterval !== undefined && typeof scheduleInterval !== 'function') ||
    (cancelInterval !== undefined && typeof cancelInterval !== 'function') ||
    (scheduleTimeout !== undefined && typeof scheduleTimeout !== 'function') ||
    (cancelTimeout !== undefined && typeof cancelTimeout !== 'function')
  ) {
    return null;
  }
  return freezeCanonical({
    createMediaId:
      (createMediaId as (() => string) | undefined) ?? (() => createFileMediaPrepareId()),
    nowEpochMs: (nowEpochMs as (() => number) | undefined) ?? (() => Date.now()),
    scheduleInterval:
      (scheduleInterval as RuntimeSnapshot['scheduleInterval'] | undefined) ??
      ((callback, delayMs) => {
        const name = `file-playback-host-media-health-${++healthTimerSequence}`;
        setManagedTimer(name, callback, delayMs, { interval: true });
        return name;
      }),
    cancelInterval:
      (cancelInterval as RuntimeSnapshot['cancelInterval'] | undefined) ??
      ((handle) => clearManagedTimer(handle)),
    scheduleTimeout:
      (scheduleTimeout as RuntimeSnapshot['scheduleTimeout'] | undefined) ??
      ((callback, delayMs) => {
        const name = `file-playback-host-media-warm-offer-${++warmOfferTimerSequence}`;
        setManagedTimer(name, callback, delayMs);
        return name;
      }),
    cancelTimeout:
      (cancelTimeout as RuntimeSnapshot['cancelTimeout'] | undefined) ??
      ((handle) => clearManagedTimer(handle)),
  });
}

function isEncodedSource(value: HostPeerRangeSource): value is EncodedAudioSource {
  return !(value instanceof Blob);
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

function observe(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}

function signalError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

/**
 * Stops this exact owner from awaiting shared work as soon as its authority is
 * aborted. The underlying resolver/upload remains untouched for other owners;
 * a late encoded lease is closed because nobody can safely adopt it afterward.
 */
function awaitWhileOwned<T>(
  task: Promise<T>,
  signal: AbortSignal,
  onDetachedValue?: (value: T) => void | Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let detached = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      detached = true;
      cleanup();
      reject(signalError(signal, 'Host media publication was aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(
      (value) => {
        if (detached) {
          if (onDetachedValue) {
            void Promise.resolve(onDetachedValue(value)).catch(() => undefined);
          }
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function deferredEvidence(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}> {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  let settled = false;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    reject = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
  });
  observe(promise);
  return freezeCanonical({ promise, resolve, reject });
}

function deferredReadyCapability(): Readonly<{
  promise: Promise<Readonly<HostPreparedRemoteParticipant>>;
  resolve: (value: Readonly<HostPreparedRemoteParticipant>) => void;
  reject: (error: Error) => void;
}> {
  let resolve!: (value: Readonly<HostPreparedRemoteParticipant>) => void;
  let reject!: (error: Error) => void;
  let settled = false;
  const promise = new Promise<Readonly<HostPreparedRemoteParticipant>>(
    (resolvePromise, rejectPromise) => {
      resolve = (value) => {
        if (settled) return;
        settled = true;
        resolvePromise(value);
      };
      reject = (error) => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      };
    },
  );
  observe(promise);
  return freezeCanonical({ promise, resolve, reject });
}

/**
 * One exact host->guest media owner. Room media and R2 lifetimes are injected;
 * revoking this owner can therefore isolate one peer without stopping either.
 */
export class FilePlaybackProductHostMediaOwner {
  readonly #context: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  readonly #hostRoom: FilePlaybackProductHostMediaRoomPort;
  readonly #publisher: FilePlaybackR2WholeBlobPublisher;
  readonly #sendRequired: FilePlaybackProductHostMediaOwnerOptions['sendRequired'];
  readonly #sendWire: FilePlaybackProductHostMediaOwnerOptions['sendWire'];
  readonly #closeConnection: FilePlaybackProductHostMediaOwnerOptions['closeConnection'];
  readonly #onHealthSystemMessage: FilePlaybackProductHostMediaOwnerOptions['onHealthSystemMessage'];
  readonly #resolvePreparedPeerRangeSource: NonNullable<
    FilePlaybackProductHostMediaOwnerOptions['resolvePreparedPeerRangeSource']
  > | null;
  readonly #resolveWarmPeerRangeSource: NonNullable<
    FilePlaybackProductHostMediaOwnerOptions['resolveWarmPeerRangeSource']
  > | null;
  readonly #runtime: RuntimeSnapshot;
  readonly #port: Readonly<FilePlaybackProductSessionRouterHostMediaOwnerPort>;
  readonly #health: ParticipantHealthMonitor;
  readonly #responder: PeerRangeHostResponder;
  readonly #healthTimer: TimerHandle;
  #publicationEpoch = 0;
  #publicationController = new AbortController();
  #prepareRevision = 0;
  #wireBootstrapped = false;
  #publication: PublicationRecord | null = null;
  #publicationTask: Promise<Readonly<FilePlaybackProductHostPublicationCommit>> | null = null;
  #publicationTaskIdentity: Readonly<HostPeerPlaybackPublication> | null = null;
  #candidateEpoch = 0;
  #candidateController = new AbortController();
  #candidate: PreparedPublicationRecord | null = null;
  #candidateTask: Promise<Readonly<FilePlaybackProductHostPreparedPublicationCommit>> | null = null;
  #candidateTaskIdentity: Readonly<HostPreparedLocalTrack> | null = null;
  #candidateBindingTask: Promise<
    Readonly<FilePlaybackProductHostPreparedPublicationCommit>
  > | null = null;
  #candidateBindingTaskIdentity: Readonly<HostPreparedLocalTrack> | null = null;
  #candidateRetirement: PreparedRetirementRecord | null = null;
  readonly #preparedRetirements = new WeakMap<object, Promise<void>>();
  readonly #issuedMediaIds = new Set<string>();
  #warmOfferEpoch = 0;
  #warmOffer: WarmSourceOfferRecord | null = null;
  #warmOfferTask: Promise<Readonly<FilePlaybackProductHostSourceLeasePublicationCommit>> | null =
    null;
  #warmOfferTaskAuthority: Readonly<FilePlaybackProductHostLocalTrackWarmResult> | null = null;
  #warmOfferTaskController: AbortController | null = null;
  readonly #warmOfferRetirements = new WeakMap<object, Promise<void>>();
  readonly #promotedWarmSourceLeases = new WeakSet<object>();
  readonly #warmOfferAuthorities = new WeakMap<
    object,
    Readonly<FilePlaybackProductHostLocalTrackWarmResult>
  >();
  #mediaLane: Promise<void> = Promise.resolve();
  #attempt: AttemptRecord | null = null;
  readonly #attemptsById = new Map<string, AttemptRecord>();
  #closed = false;
  #fatal = false;

  constructor(options: FilePlaybackProductHostMediaOwnerOptions) {
    const input = snapshotOptions(options);
    const context = snapshotExactRecord(input?.context, CONTEXT_KEYS);
    const runtime = runtimeSnapshot(input?.runtimeForTests);
    if (
      !input ||
      !context ||
      !runtime ||
      context.schemaVersion !== 1 ||
      context.role !== 'host' ||
      !(context.channel instanceof FilePlaybackConnectionChannel) ||
      context.connection === null ||
      typeof context.connection !== 'object' ||
      context.connectionToken === null ||
      typeof context.connectionToken !== 'object' ||
      context.routerToken === null ||
      typeof context.routerToken !== 'object' ||
      typeof context.sessionId !== 'string' ||
      typeof context.connectionId !== 'string' ||
      typeof context.hostParticipantId !== 'string' ||
      typeof context.guestParticipantId !== 'string' ||
      input.hostRoom === null ||
      typeof input.hostRoom !== 'object' ||
      typeof (input.hostRoom as Partial<FilePlaybackProductHostMediaRoomPort>)
        .currentPeerPublication !== 'function' ||
      typeof (input.hostRoom as Partial<FilePlaybackProductHostMediaRoomPort>)
        .resolveCurrentPeerRangeSource !== 'function' ||
      typeof (input.hostRoom as Partial<FilePlaybackProductHostMediaRoomPort>)
        .recoverRemoteParticipant !== 'function' ||
      input.publisher === null ||
      typeof input.publisher !== 'object' ||
      Reflect.getPrototypeOf(input.publisher) !== FilePlaybackR2WholeBlobPublisher.prototype ||
      typeof input.sendRequired !== 'function' ||
      typeof input.sendWire !== 'function' ||
      typeof input.closeConnection !== 'function' ||
      typeof input.onHealthSystemMessage !== 'function' ||
      (input.resolvePreparedPeerRangeSource !== undefined &&
        typeof input.resolvePreparedPeerRangeSource !== 'function') ||
      (input.resolveWarmPeerRangeSource !== undefined &&
        typeof input.resolveWarmPeerRangeSource !== 'function')
    ) {
      throw new TypeError('File playback product host media owner options are invalid');
    }
    const channel = context.channel as FilePlaybackConnectionChannel;
    const binding = Reflect.apply(trustedChannelBinding, channel, []);
    if (
      Reflect.apply(trustedChannelRole, channel, []) !== 'host' ||
      Reflect.apply(trustedChannelClosed, channel, []) ||
      Reflect.apply(trustedChannelToken, channel, []) !== context.connectionToken ||
      !binding ||
      binding.sessionId !== context.sessionId ||
      binding.connectionId !== context.connectionId ||
      binding.hostParticipantId !== context.hostParticipantId ||
      binding.guestParticipantId !== context.guestParticipantId
    ) {
      throw new Error('Host media owner connection context is stale');
    }

    this.#context = input.context as Readonly<FilePlaybackProductSessionRouterConnectionContext>;
    this.#hostRoom = input.hostRoom as FilePlaybackProductHostMediaRoomPort;
    this.#publisher = input.publisher as FilePlaybackR2WholeBlobPublisher;
    this.#sendRequired =
      input.sendRequired as FilePlaybackProductHostMediaOwnerOptions['sendRequired'];
    this.#sendWire = input.sendWire as FilePlaybackProductHostMediaOwnerOptions['sendWire'];
    this.#closeConnection =
      input.closeConnection as FilePlaybackProductHostMediaOwnerOptions['closeConnection'];
    this.#onHealthSystemMessage =
      input.onHealthSystemMessage as FilePlaybackProductHostMediaOwnerOptions['onHealthSystemMessage'];
    this.#resolvePreparedPeerRangeSource =
      (input.resolvePreparedPeerRangeSource as
        | NonNullable<FilePlaybackProductHostMediaOwnerOptions['resolvePreparedPeerRangeSource']>
        | undefined) ?? null;
    this.#resolveWarmPeerRangeSource =
      (input.resolveWarmPeerRangeSource as
        | NonNullable<FilePlaybackProductHostMediaOwnerOptions['resolveWarmPeerRangeSource']>
        | undefined) ?? null;
    this.#runtime = runtime;

    const now = this.#nowRoomTimeMs();
    this.#health = new ParticipantHealthMonitor({
      participantId: this.#context.guestParticipantId,
      now: () => this.#nowRoomTimeMs(),
      initialLeaseUntilMs: now + HEALTH_LEASE_MS,
      degradationGraceMs: 1_500,
    });
    const trustedPeerContext = bindPeerRangeTrustedConnection(
      this.#context.connectionToken,
      this.#context.connectionId,
    );
    this.#responder = new PeerRangeHostResponder({
      connection: trustedPeerContext,
      sources: {
        resolve: (sourceIdentity, signal) => this.#resolvePeerSource(null, sourceIdentity, signal),
        resolveHandle: (handleId, sourceIdentity, signal) =>
          this.#resolvePeerSource(handleId, sourceIdentity, signal),
      },
      onFatalConnection: (_connection, error) => this.#failConnection(error),
      canSend: () => this.#canSendPeerRange(),
      sendBulk: (frame) => this.#sendPeerRangeBulk(frame),
    });
    this.#healthTimer = this.#runtime.scheduleInterval(() => this.#tickHealth(), HEALTH_TICK_MS);
    this.#port = freezeCanonical({
      onHostReady: (snapshot: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>) =>
        this.#onHostReady(snapshot),
      adoptWireMessage: (event: Readonly<FilePlaybackWireAdoptionEvent>, acknowledge: () => void) =>
        this.#adoptWireMessage(event, acknowledge),
      adoptPeerRangeControl: (
        event: Readonly<FilePlaybackPeerRangeAdoptionEvent>,
        acknowledge: () => void,
      ) => this.#adoptPeerRangeControl(event, acknowledge),
      revoke: (revokeContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>) =>
        this.#revoke(revokeContext),
    });
  }

  port(): Readonly<FilePlaybackProductSessionRouterHostMediaOwnerPort> {
    return this.#port;
  }

  publishCurrent(): Promise<Readonly<FilePlaybackProductHostPublicationCommit>> {
    if (this.#closed) return Promise.reject(new Error('Host media owner is closed'));
    if (this.#candidateRetirement) {
      return Promise.reject(new Error('Host prepared publication retirement is settling'));
    }
    const publication = this.#hostRoom.currentPeerPublication();
    if (!publication) {
      return Promise.reject(new Error('Host media owner has no current peer publication'));
    }
    if (this.#publication?.publication === publication) {
      return Promise.resolve(this.#publication.commit);
    }
    if (this.#publicationTask && this.#publicationTaskIdentity === publication) {
      return this.#publicationTask;
    }
    if (this.#publicationTask) {
      return Promise.reject(new Error('Host current publication already has exact authority'));
    }
    const task = this.#enqueueMediaLane(async () => {
      if (this.#closed) throw new Error('Host media owner is closed');
      if (this.#candidateRetirement) {
        throw new Error('Host prepared publication retirement is settling');
      }
      if (this.#candidate) {
        throw new Error('Host prepared publication already has exact authority');
      }
      if (this.#publication?.publication === publication) return this.#publication.commit;
      if (this.#hostRoom.currentPeerPublication() !== publication) {
        throw new Error('Host current publication authority is stale');
      }
      this.#publicationEpoch += 1;
      const epoch = this.#publicationEpoch;
      this.#publicationController.abort(new Error('Host media publication was superseded'));
      this.#publicationController = new AbortController();
      this.#retireAttempt(new Error('Host media publication was superseded'));
      this.#revokePublishedHandle(new Error('Host media publication was superseded'));
      this.#publication = null;
      return this.#publish(publication, epoch);
    }).finally(() => {
      if (this.#publicationTask === task) {
        this.#publicationTask = null;
        this.#publicationTaskIdentity = null;
      }
    });
    this.#publicationTask = task;
    this.#publicationTaskIdentity = publication;
    return task;
  }

  /** Publishes one exact bounded warm lease without claiming playback or wire state. */
  publishSourceLease(
    authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>,
  ): Promise<Readonly<FilePlaybackProductHostSourceLeasePublicationCommit>> {
    if (this.#closed) return Promise.reject(new Error('Host media owner is closed'));
    if (!this.#resolveWarmPeerRangeSource) {
      return Promise.reject(new Error('Host warm source resolver is unavailable'));
    }
    let sourceLease: HostLocalTrackSourceLease;
    try {
      sourceLease = this.#requireWarmSourceOfferAuthority(authority);
      this.#expireWarmSourceOfferIfNeeded();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#warmOfferRetirements.has(sourceLease)) {
      return Promise.reject(new Error('Host warm source offer authority was retired'));
    }
    if (this.#promotedWarmSourceLeases.has(sourceLease)) {
      return Promise.reject(new Error('Host warm source lease was promoted to prepared authority'));
    }
    const knownAuthority = this.#warmOfferAuthorities.get(sourceLease);
    if (knownAuthority && knownAuthority !== authority) {
      return Promise.reject(new Error('Host warm source result is not the exact authority'));
    }
    if (this.#warmOfferTask && this.#warmOfferTaskAuthority?.sourceLease === sourceLease) {
      if (
        this.#warmOfferTaskAuthority !== authority ||
        !this.#sameWarmSourceOfferBinding(this.#warmOfferTaskAuthority, authority)
      ) {
        return Promise.reject(new Error('Host warm source result is not the exact authority'));
      }
      return this.#warmOfferTask;
    }
    const current = this.#warmOffer;
    if (current?.sourceLease === sourceLease) {
      if (
        current.authority !== authority ||
        !this.#sameWarmSourceOfferBinding(current.authority, authority)
      ) {
        return Promise.reject(new Error('Host warm source result is not the exact authority'));
      }
      if (current.status !== 'offered') {
        return Promise.reject(new Error('Host warm source offer is not yet stable'));
      }
      if (this.#warmOfferTask && this.#warmOfferTaskAuthority?.sourceLease !== sourceLease) {
        this.#warmOfferEpoch += 1;
        this.#warmOfferTaskController?.abort(
          new Error('Host warm source replacement was superseded by the exact live offer'),
        );
      }
      return Promise.resolve(current.commit);
    }

    this.#warmOfferEpoch += 1;
    const epoch = this.#warmOfferEpoch;
    this.#warmOfferTaskController?.abort(new Error('Host warm source offer was superseded'));
    const controller = new AbortController();
    this.#warmOfferTaskController = controller;
    const task = this.#publishWarmSourceOffer(authority, sourceLease, epoch, controller).finally(
      () => {
        if (this.#warmOfferTask === task) {
          this.#warmOfferTask = null;
          this.#warmOfferTaskAuthority = null;
          this.#warmOfferTaskController = null;
        }
      },
    );
    this.#warmOfferTask = task;
    this.#warmOfferTaskAuthority = authority;
    return task;
  }

  /** Retires only the exact offer-only warm lease; the connection remains reusable. */
  retireSourceLease(sourceLease: HostLocalTrackSourceLease, reason: Error): Promise<void> {
    if (sourceLease === null || typeof sourceLease !== 'object' || !(reason instanceof Error)) {
      return Promise.reject(new TypeError('Host warm source offer retirement is invalid'));
    }
    const replay = this.#warmOfferRetirements.get(sourceLease);
    if (replay) return replay;
    if (this.#promotedWarmSourceLeases.has(sourceLease)) {
      return Promise.reject(new Error('Host warm source offer authority was already promoted'));
    }
    const pending =
      this.#warmOfferTaskAuthority?.sourceLease === sourceLease ? this.#warmOfferTask : null;
    const record = this.#warmOffer?.sourceLease === sourceLease ? this.#warmOffer : null;
    if (!pending && !record) {
      return Promise.reject(new Error('Host warm source offer retirement authority is stale'));
    }
    const promise = Promise.resolve()
      .then(() => pending?.catch(() => undefined))
      .then(() => undefined);
    this.#warmOfferRetirements.set(sourceLease, promise);
    if (pending) {
      this.#warmOfferEpoch += 1;
      this.#warmOfferTaskController?.abort(reason);
    }
    if (record) this.#retireWarmSourceOffer(record, reason);
    return promise;
  }

  /** Publishes one exact silent candidate without changing current wire truth. */
  publishPrepared(
    prepared: Readonly<HostPreparedLocalTrack>,
  ): Promise<Readonly<FilePlaybackProductHostPreparedPublicationCommit>> {
    if (this.#closed) return Promise.reject(new Error('Host media owner is closed'));
    if (!this.#resolvePreparedPeerRangeSource) {
      return Promise.reject(new Error('Host prepared source resolver is unavailable'));
    }
    if (prepared === null || typeof prepared !== 'object') {
      return Promise.reject(new TypeError('Host prepared publication authority is invalid'));
    }
    if (this.#preparedRetirements.has(prepared as object)) {
      return Promise.reject(new Error('Host prepared publication authority was retired'));
    }
    if (this.#candidateRetirement) {
      return Promise.reject(new Error('Host prepared publication retirement is settling'));
    }
    if (this.#candidateTask && this.#candidateTaskIdentity === prepared) {
      return this.#candidateTask;
    }
    if (this.#candidate?.prepared === prepared && this.#candidate.status !== 'retired') {
      return Promise.resolve(this.#candidate.commit);
    }
    if (this.#candidate || this.#candidateTask || this.#candidateBindingTask) {
      return Promise.reject(new Error('Host prepared publication already has exact authority'));
    }
    const task = this.#enqueueMediaLane(async () => {
      if (this.#closed) throw new Error('Host media owner is closed');
      if (
        this.#candidateRetirement?.prepared === prepared ||
        this.#preparedRetirements.has(prepared as object)
      ) {
        throw new Error('Host prepared publication authority was retired');
      }
      if (this.#candidate) {
        throw new Error('Host prepared publication already has exact authority');
      }
      this.#candidateEpoch += 1;
      const epoch = this.#candidateEpoch;
      this.#candidateController.abort(new Error('Host prepared publication was superseded'));
      this.#candidateController = new AbortController();
      return this.#publishPrepared(prepared, epoch);
    }).finally(() => {
      if (this.#candidateTask === task) {
        this.#candidateTask = null;
        this.#candidateTaskIdentity = null;
      }
    });
    this.#candidateTask = task;
    this.#candidateTaskIdentity = prepared;
    return task;
  }

  /** Claims wire state and sends RUN for one exact source offer. */
  bindPrepared(
    prepared: Readonly<HostPreparedLocalTrack>,
  ): Promise<Readonly<FilePlaybackProductHostPreparedPublicationCommit>> {
    if (this.#closed) return Promise.reject(new Error('Host media owner is closed'));
    if (prepared === null || typeof prepared !== 'object') {
      return Promise.reject(new TypeError('Host prepared binding authority is invalid'));
    }
    if (this.#preparedRetirements.has(prepared as object)) {
      return Promise.reject(new Error('Host prepared publication authority was retired'));
    }
    if (this.#candidateRetirement) {
      return Promise.reject(new Error('Host prepared publication retirement is settling'));
    }
    if (this.#candidateBindingTask && this.#candidateBindingTaskIdentity === prepared) {
      return this.#candidateBindingTask;
    }
    const record = this.#candidate;
    if (!record || record.prepared !== prepared || record.status === 'retired') {
      return Promise.reject(new Error('Host prepared binding authority is stale'));
    }
    if (record.status === 'published') return Promise.resolve(record.commit);
    if (record.status !== 'offered' || this.#candidateBindingTask) {
      return Promise.reject(new Error('Host prepared publication is not bindable'));
    }
    const task = this.#enqueueMediaLane(async () => {
      if (this.#closed) throw new Error('Host media owner is closed');
      if (
        this.#candidateRetirement?.prepared === prepared ||
        this.#preparedRetirements.has(prepared as object)
      ) {
        throw new Error('Host prepared publication authority was retired');
      }
      const exact = this.#candidate;
      if (!exact || exact !== record || exact.prepared !== prepared) {
        throw new Error('Host prepared binding authority is stale');
      }
      if (exact.status === 'published') return exact.commit;
      if (exact.status !== 'offered') {
        throw new Error('Host prepared publication is not bindable');
      }
      return this.#bindPreparedRun(exact);
    }).finally(() => {
      if (this.#candidateBindingTask === task) {
        this.#candidateBindingTask = null;
        this.#candidateBindingTaskIdentity = null;
      }
    });
    this.#candidateBindingTask = task;
    this.#candidateBindingTaskIdentity = prepared;
    return task;
  }

  /**
   * Retires one exact uncommitted candidate. Once a wire state was staged the
   * connection is renewed because the revision tombstone cannot be rolled back.
   */
  retirePrepared(prepared: Readonly<HostPreparedLocalTrack>, reason: Error): Promise<void> {
    if (prepared === null || typeof prepared !== 'object' || !(reason instanceof Error)) {
      return Promise.reject(new TypeError('Host prepared retirement authority is invalid'));
    }
    const replay = this.#preparedRetirements.get(prepared as object);
    if (replay) return replay;
    if (
      this.#candidate?.prepared !== prepared &&
      this.#candidateTaskIdentity !== prepared &&
      this.#candidateBindingTaskIdentity !== prepared
    ) {
      return Promise.reject(new Error('Host prepared retirement authority is stale'));
    }
    const pendingPublication =
      this.#candidateTaskIdentity === prepared ? this.#candidateTask : null;
    const pendingBinding =
      this.#candidateBindingTaskIdentity === prepared ? this.#candidateBindingTask : null;
    let staged = false;
    const promise = Promise.resolve()
      .then(async () => {
        await Promise.all([
          pendingPublication?.catch(() => undefined),
          pendingBinding?.catch(() => undefined),
        ]);
        if (this.#candidate?.prepared === prepared) {
          staged = this.#retirePreparedCandidate(reason) || staged;
        }
        if (staged && !this.#closed) {
          this.#close(
            true,
            new Error('Host prepared retirement requires connection renewal', {
              cause: reason,
            }),
          );
        }
      })
      .finally(() => {
        if (this.#candidateRetirement?.promise === promise) {
          this.#candidateRetirement = null;
        }
      });
    const retirement: PreparedRetirementRecord = { prepared, promise };
    this.#candidateRetirement = retirement;
    this.#preparedRetirements.set(prepared as object, promise);
    this.#candidateEpoch += 1;
    this.#candidateController.abort(reason);
    staged = this.#retirePreparedCandidate(reason);
    return promise;
  }

  /** Stable per-candidate readiness capability; a slow peer remains locally pending. */
  whenPreparedRemoteReady(
    prepared: Readonly<HostPreparedLocalTrack>,
  ): Promise<Readonly<HostPreparedRemoteParticipant>> {
    const record = this.#candidate;
    if (!record || record.prepared !== prepared || record.status !== 'published') {
      return Promise.reject(new Error('Host prepared publication authority is stale'));
    }
    return record.ready;
  }

  /**
   * Promotes the exact candidate after the host has committed canonical truth.
   * Remote renderer acceptance is deliberately settled independently.
   */
  activatePrepared(
    options: ActivateFilePlaybackProductHostPreparedOptions,
  ): Readonly<FilePlaybackProductHostPublicationCommit> {
    const input = snapshotExactRecord(options, ACTIVATE_PREPARED_KEYS);
    const record = this.#candidate;
    if (!input || !record || input.prepared !== record.prepared) {
      throw new Error('Host prepared activation authority is stale');
    }
    this.#assertCandidateRecord(record);
    const stateLease = record.stateLease;
    if (record.status !== 'published' || !stateLease) {
      throw new Error('Host prepared publication is not activatable');
    }
    const publication = this.#hostRoom.currentPeerPublication();
    if (
      !publication ||
      publication.roomGeneration !== record.prepared.roomGeneration ||
      publication.backend !== record.prepared.backend ||
      publication.state.queueItemId !== record.prepared.state.queueItemId ||
      publication.state.runId !== record.prepared.state.runId ||
      publication.state.revision !== record.prepared.state.revision ||
      publication.timeline !== input.timeline ||
      publication.asset.binding.queueItemId !== record.prepared.asset.binding.queueItemId ||
      publication.asset.binding.sourceIdentity !== record.prepared.asset.binding.sourceIdentity ||
      publication.asset.binding.transferSessionId !==
        record.prepared.asset.binding.transferSessionId ||
      publication.asset.kind !== record.prepared.asset.kind ||
      publication.asset.metadata.name !== record.prepared.asset.metadata.name ||
      publication.asset.metadata.mime !== record.prepared.asset.metadata.mime ||
      publication.asset.encodedSize !== record.prepared.asset.encodedSize
    ) {
      throw new Error('Host room did not commit the exact prepared publication');
    }
    const update = createFilePlaybackTimelineUpdateV2({
      sessionId: this.#context.sessionId,
      connectionId: this.#context.connectionId,
      roomGeneration: record.prepared.roomGeneration,
      timeline: publication.timeline,
    });
    this.#assertTimelineMatchesPrepared(update, record.prepared);
    const timeline = timelineFromFilePlaybackTimelineUpdateV2(update);
    if (!timeline) throw new Error('Host prepared committed timeline is invalid');

    Reflect.apply(trustedChannelCommitMedia, this.#context.channel, [stateLease]);
    this.#revokePublishedHandle(new Error('Host current publication was superseded'));
    this.#publicationEpoch += 1;
    this.#publicationController.abort(new Error('Host current publication was superseded'));
    this.#publicationController = new AbortController();
    if (timeline.revision !== publication.timeline.revision) {
      throw new Error('Host prepared committed timeline changed during activation');
    }
    const commit = freezeCanonical({
      schemaVersion: 1 as const,
      publication,
      offer: record.offer,
      binding: record.binding,
    });
    const publicationRecord: PublicationRecord = {
      epoch: this.#publicationEpoch,
      publication,
      offer: record.offer,
      binding: record.binding,
      stateLease,
      handleId: record.handleId,
      commit,
      transferredWarmSource: record.transferredWarmSource,
      participant: record.participant,
      status: 'published',
    };
    if (!record.capability) {
      record.rejectReady(new Error('Host committed before this remote candidate became ready'));
    }
    record.status = 'activated';
    this.#publication = publicationRecord;
    this.#candidate = null;
    this.#sendRequiredFrame(update);
    const attempt = this.#attempt;
    if (attempt?.mode === 'prepared' && attempt.preparedRecord === record) {
      attempt.stateCommitted = true;
      this.#settlePreparedAttempt(attempt);
    }
    return commit;
  }

  setDocumentHidden(hidden: boolean): void {
    if (this.#closed) return;
    this.#applyHealth(this.#health.setDocumentHidden(hidden));
  }

  #onHostReady(value: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>): void {
    const snapshot = snapshotExactRecord(value, READY_KEYS);
    if (
      !snapshot ||
      snapshot.schemaVersion !== 1 ||
      snapshot.role !== 'host' ||
      snapshot.sessionId !== this.#context.sessionId ||
      snapshot.connectionId !== this.#context.connectionId ||
      snapshot.baselineStatus !== 'ready' ||
      snapshot.clockReady !== true ||
      snapshot.ready !== true
    ) {
      throw new TypeError('Host media owner READY snapshot is invalid');
    }
    queueMicrotask(() => observe(this.publishCurrent()));
  }

  async #publishWarmSourceOffer(
    authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>,
    sourceLease: HostLocalTrackSourceLease,
    epoch: number,
    controller: AbortController,
  ): Promise<Readonly<FilePlaybackProductHostSourceLeasePublicationCommit>> {
    await Promise.resolve();
    this.#assertWarmSourceOfferTask(authority, sourceLease, epoch, controller);
    const resolve = this.#resolveWarmPeerRangeSource;
    if (!resolve) throw new Error('Host warm source resolver is unavailable');
    const asset = authority.asset;
    const exactSource = await awaitWhileOwned(
      Promise.resolve().then(() =>
        resolve({
          sourceLease,
          sourceIdentity: asset.binding.sourceIdentity,
          signal: controller.signal,
        }),
      ),
      controller.signal,
      async (lateSource) => {
        if (isEncodedSource(lateSource)) await lateSource.close();
      },
    );
    try {
      this.#assertWarmSourceOfferTask(authority, sourceLease, epoch, controller);
    } catch (error) {
      if (isEncodedSource(exactSource)) await exactSource.close().catch(() => undefined);
      throw error;
    }
    if (
      exactSource.size !== asset.encodedSize ||
      (isEncodedSource(exactSource) &&
        (exactSource.identity !== asset.binding.sourceIdentity ||
          exactSource.metadata.name !== asset.metadata.name ||
          exactSource.metadata.mime !== asset.metadata.mime))
    ) {
      if (isEncodedSource(exactSource)) await exactSource.close().catch(() => undefined);
      throw new Error('Host warm source changed its exact lease binding');
    }
    if (isEncodedSource(exactSource)) await exactSource.close();
    this.#assertWarmSourceOfferTask(authority, sourceLease, epoch, controller);
    const expiresAtRoomTimeMs = this.#nowRoomTimeMs() + FILE_PLAYBACK_PRODUCT_OFFER_LIFETIME_MS;
    const prepareId = this.#freshMediaId([
      asset.binding.queueItemId,
      asset.binding.sourceIdentity,
      asset.binding.transferSessionId,
    ]);
    const handleId = this.#freshMediaId([
      prepareId,
      asset.binding.queueItemId,
      asset.binding.sourceIdentity,
      asset.binding.transferSessionId,
    ]);
    this.#assertWarmSourceOfferTask(authority, sourceLease, epoch, controller);

    const previous = this.#warmOffer;
    if (previous) {
      this.#retireWarmSourceOffer(previous, new Error('Host warm source offer was superseded'));
      this.#assertWarmSourceOfferTask(authority, sourceLease, epoch, controller);
    }
    let revisionAllocated = false;
    let offerDelivered = false;
    let record: WarmSourceOfferRecord | null = null;
    try {
      // From revision allocation through OFFER delivery this must remain one
      // synchronous critical section. Warm publication does not share the
      // media lane, so yielding here can otherwise put revision N+1 on wire
      // before revision N.
      const prepareRevision = this.#nextPrepareRevision();
      revisionAllocated = true;
      const offer = createPeerRangeFileMediaSourceOfferV2({
        sessionId: this.#context.sessionId,
        connectionId: this.#context.connectionId,
        prepareId,
        prepareRevision,
        queueItemId: asset.binding.queueItemId,
        sourceIdentity: asset.binding.sourceIdentity,
        transferSessionId: asset.binding.transferSessionId,
        encodedSize: asset.encodedSize,
        name: asset.metadata.name,
        mime: asset.metadata.mime,
        handleId,
        expiresAtRoomTimeMs,
      });
      const commit = freezeCanonical({ schemaVersion: 1 as const, sourceLease, offer });
      const createdRecord: WarmSourceOfferRecord = {
        epoch,
        authority,
        sourceLease,
        offer,
        handleId,
        resolve,
        controller,
        commit,
        expiryTimer: null,
        offerSent: false,
        offerRevokeSent: false,
        status: 'offering',
      };
      record = createdRecord;
      this.#warmOffer = createdRecord;
      this.#assertWarmSourceOfferRecord(createdRecord);
      createdRecord.offerSent = true;
      this.#sendRequiredFrame(offer);
      offerDelivered = true;
      this.#assertWarmSourceOfferRecord(createdRecord);
      createdRecord.status = 'offered';
      let expiryCallbackRan = false;
      try {
        const timer = this.#runtime.scheduleTimeout(() => {
          expiryCallbackRan = true;
          this.#expireWarmSourceOffer(createdRecord);
        }, FILE_PLAYBACK_PRODUCT_OFFER_LIFETIME_MS);
        if (expiryCallbackRan) {
          this.#runtime.cancelTimeout(timer);
          throw new Error('Host warm source offer expired while scheduling its lease');
        }
        createdRecord.expiryTimer = timer;
      } catch (error) {
        this.#retireWarmSourceOffer(
          createdRecord,
          asError(error, 'Host warm source offer expiry could not be scheduled'),
        );
        throw error;
      }
      this.#assertWarmSourceOfferRecord(createdRecord);
      this.#warmOfferAuthorities.set(sourceLease, authority);
      return commit;
    } catch (error) {
      if (record) {
        this.#retireWarmSourceOffer(
          record,
          asError(error, 'Host warm source offer publication failed'),
        );
      }
      if (revisionAllocated && !offerDelivered && !this.#closed) {
        throw this.#failConnection(error);
      }
      throw error;
    }
  }

  async #publish(
    publication: Readonly<HostPeerPlaybackPublication>,
    epoch: number,
  ): Promise<Readonly<FilePlaybackProductHostPublicationCommit>> {
    await Promise.resolve();
    this.#assertPublicationAuthority(publication, epoch);
    let peerRangeExpiresAtRoomTimeMs: number | null = null;
    let r2OfferFields: Readonly<{
      storageRoomId: string;
      objectId: string;
      encryptedSize: number;
      keyB64: string;
      ivB64: string;
      expiresAtRoomTimeMs: number;
    }> | null = null;
    if (publication.backend === 'bounded-stream') {
      peerRangeExpiresAtRoomTimeMs =
        this.#nowRoomTimeMs() + FILE_PLAYBACK_PRODUCT_OFFER_LIFETIME_MS;
    } else {
      const signal = this.#publicationSignal(epoch);
      const source = await awaitWhileOwned(
        Promise.resolve().then(() =>
          this.#hostRoom.resolveCurrentPeerRangeSource({
            publication,
            sourceIdentity: publication.asset.binding.sourceIdentity,
            signal,
          }),
        ),
        signal,
        async (lateSource) => {
          if (isEncodedSource(lateSource)) await lateSource.close();
        },
      );
      if (!(source instanceof Blob)) {
        await source.close().catch(() => undefined);
        throw new Error('Ordinary host publication requires its exact Blob source');
      }
      this.#assertPublicationAuthority(publication, epoch);
      const published = await awaitWhileOwned(
        this.#publisher.publish({
          queueItemId: publication.state.queueItemId,
          sourceIdentity: publication.asset.binding.sourceIdentity,
          transferSessionId: publication.asset.binding.transferSessionId,
          blob: source,
          name: publication.asset.metadata.name,
          mime: publication.asset.metadata.mime,
        }),
        signal,
      );
      this.#assertPublicationAuthority(publication, epoch);
      const epochNow = this.#runtime.nowEpochMs();
      if (!Number.isFinite(epochNow) || epochNow < 0) {
        throw new Error('Host media owner epoch clock is invalid');
      }
      r2OfferFields = freezeCanonical({
        storageRoomId: published.storageRoomId,
        objectId: published.objectId,
        encryptedSize: published.encryptedSize,
        keyB64: published.keyB64,
        ivB64: published.ivB64,
        expiresAtRoomTimeMs:
          this.#nowRoomTimeMs() + Math.max(0, published.expiresAtEpochMs - epochNow),
      });
    }

    this.#assertPublicationAuthority(publication, epoch);
    const prepareId = this.#freshMediaId([
      publication.state.queueItemId,
      publication.state.runId,
      publication.asset.binding.sourceIdentity,
      publication.asset.binding.transferSessionId,
    ]);
    const handleId =
      publication.backend === 'bounded-stream'
        ? this.#freshMediaId([
            prepareId,
            publication.state.queueItemId,
            publication.asset.binding.sourceIdentity,
            publication.asset.binding.transferSessionId,
          ])
        : null;
    const base = {
      sessionId: this.#context.sessionId,
      connectionId: this.#context.connectionId,
      prepareId,
      queueItemId: publication.state.queueItemId,
      sourceIdentity: publication.asset.binding.sourceIdentity,
      transferSessionId: publication.asset.binding.transferSessionId,
      encodedSize: publication.asset.encodedSize,
      name: publication.asset.metadata.name,
      mime: publication.asset.metadata.mime,
    } as const;
    this.#assertPublicationAuthority(publication, epoch);

    let revisionAllocated = false;
    try {
      // No await may enter this section: prepare revisions are a reliable
      // ordered wire lane shared with warm and prepared publication.
      const prepareRevision = this.#nextPrepareRevision();
      revisionAllocated = true;
      let offer: Readonly<FileMediaSourceOfferV2>;
      if (publication.backend === 'bounded-stream') {
        if (handleId === null || peerRangeExpiresAtRoomTimeMs === null) {
          throw new Error('Host peer-range offer plan is incomplete');
        }
        offer = createPeerRangeFileMediaSourceOfferV2({
          ...base,
          prepareRevision,
          handleId,
          expiresAtRoomTimeMs: peerRangeExpiresAtRoomTimeMs,
        });
      } else {
        if (!r2OfferFields) throw new Error('Host R2 offer plan is incomplete');
        offer = createR2WholeBlobFileMediaSourceOfferV2({
          ...base,
          prepareRevision,
          ...r2OfferFields,
        });
      }
      const binding = createFilePlaybackRunBindingV2({
        sessionId: this.#context.sessionId,
        connectionId: this.#context.connectionId,
        prepareId: offer.prepareId,
        prepareRevision: offer.prepareRevision,
        queueItemId: offer.queueItemId,
        sourceIdentity: offer.sourceIdentity,
        transferSessionId: offer.transferSessionId,
        runId: publication.state.runId,
        playbackRevision: publication.state.revision,
      });
      const stateLease = this.#installCurrentState(publication);
      const commit = freezeCanonical({
        schemaVersion: 1 as const,
        publication,
        offer,
        binding,
      });
      const record: PublicationRecord = {
        epoch,
        publication,
        offer,
        binding,
        stateLease,
        handleId,
        commit,
        transferredWarmSource: null,
        participant: null,
        status: 'publishing',
      };
      this.#publication = record;
      this.#assertRecord(record);
      this.#sendRequiredFrame(offer);
      this.#assertRecord(record);
      this.#sendRequiredFrame(binding);
      this.#assertRecord(record);
      record.status = 'published';
      return commit;
    } catch (error) {
      if (revisionAllocated && !this.#closed) throw this.#failConnection(error);
      throw error;
    }
  }

  async #publishPrepared(
    prepared: Readonly<HostPreparedLocalTrack>,
    epoch: number,
  ): Promise<Readonly<FilePlaybackProductHostPreparedPublicationCommit>> {
    await Promise.resolve();
    this.#assertPreparedCandidateAuthority(prepared, epoch);
    const resolve = this.#resolvePreparedPeerRangeSource;
    if (!resolve) throw new Error('Host prepared source resolver is unavailable');
    const signal = this.#candidateSignal(epoch);
    await this.#awaitPendingWarmSourceForPrepared(prepared, epoch, signal);
    this.#assertPreparedCandidateAuthority(prepared, epoch);
    const warmAtStart = this.#transferableWarmSourceForPrepared(prepared);
    const exactSource = await awaitWhileOwned(
      Promise.resolve().then(() =>
        resolve({
          prepared,
          sourceIdentity: prepared.asset.binding.sourceIdentity,
          signal,
        }),
      ),
      signal,
      async (lateSource) => {
        if (isEncodedSource(lateSource)) await lateSource.close();
      },
    );
    try {
      this.#assertPreparedCandidateAuthority(prepared, epoch);
    } catch (error) {
      if (isEncodedSource(exactSource)) await exactSource.close().catch(() => undefined);
      throw error;
    }
    if (
      exactSource.size !== prepared.asset.encodedSize ||
      (isEncodedSource(exactSource) &&
        (exactSource.identity !== prepared.asset.binding.sourceIdentity ||
          exactSource.metadata.name !== prepared.asset.metadata.name ||
          exactSource.metadata.mime !== prepared.asset.metadata.mime))
    ) {
      if (isEncodedSource(exactSource)) await exactSource.close().catch(() => undefined);
      throw new Error('Host prepared source changed its exact candidate binding');
    }

    let exactSourceClosed = false;
    if (warmAtStart && this.#canTransferWarmSourceToPrepared(prepared, warmAtStart)) {
      if (isEncodedSource(exactSource)) {
        await exactSource.close();
        exactSourceClosed = true;
      }
      this.#assertPreparedCandidateAuthority(prepared, epoch);
      if (this.#canTransferWarmSourceToPrepared(prepared, warmAtStart)) {
        return this.#transferWarmSourceToPrepared(prepared, epoch, warmAtStart, resolve);
      }
    }

    let peerRangeExpiresAtRoomTimeMs: number | null = null;
    let r2OfferFields: Readonly<{
      storageRoomId: string;
      objectId: string;
      encryptedSize: number;
      keyB64: string;
      ivB64: string;
      expiresAtRoomTimeMs: number;
    }> | null = null;
    if (prepared.backend === 'bounded-stream') {
      if (isEncodedSource(exactSource) && !exactSourceClosed) {
        await exactSource.close();
      }
      this.#assertPreparedCandidateAuthority(prepared, epoch);
      this.#fenceSameLeaseWarmSourceForPreparedRepair(prepared);
      this.#assertPreparedCandidateAuthority(prepared, epoch);
      peerRangeExpiresAtRoomTimeMs =
        this.#nowRoomTimeMs() + FILE_PLAYBACK_PRODUCT_OFFER_LIFETIME_MS;
    } else {
      if (!(exactSource instanceof Blob)) {
        await exactSource.close().catch(() => undefined);
        throw new Error('Ordinary prepared publication requires its exact Blob source');
      }
      this.#assertPreparedCandidateAuthority(prepared, epoch);
      const published = await awaitWhileOwned(
        this.#publisher.publish({
          queueItemId: prepared.state.queueItemId,
          sourceIdentity: prepared.asset.binding.sourceIdentity,
          transferSessionId: prepared.asset.binding.transferSessionId,
          blob: exactSource,
          name: prepared.asset.metadata.name,
          mime: prepared.asset.metadata.mime,
        }),
        signal,
      );
      this.#assertPreparedCandidateAuthority(prepared, epoch);
      const epochNow = this.#runtime.nowEpochMs();
      if (!Number.isFinite(epochNow) || epochNow < 0) {
        throw new Error('Host media owner epoch clock is invalid');
      }
      r2OfferFields = freezeCanonical({
        storageRoomId: published.storageRoomId,
        objectId: published.objectId,
        encryptedSize: published.encryptedSize,
        keyB64: published.keyB64,
        ivB64: published.ivB64,
        expiresAtRoomTimeMs:
          this.#nowRoomTimeMs() + Math.max(0, published.expiresAtEpochMs - epochNow),
      });
    }
    this.#assertPreparedCandidateAuthority(prepared, epoch);
    const prepareId = this.#freshMediaId([
      prepared.state.queueItemId,
      prepared.state.runId,
      prepared.asset.binding.sourceIdentity,
      prepared.asset.binding.transferSessionId,
    ]);
    const handleId =
      prepared.backend === 'bounded-stream'
        ? this.#freshMediaId([
            prepareId,
            prepared.state.queueItemId,
            prepared.asset.binding.sourceIdentity,
            prepared.asset.binding.transferSessionId,
          ])
        : null;
    const base = {
      sessionId: this.#context.sessionId,
      connectionId: this.#context.connectionId,
      prepareId,
      queueItemId: prepared.state.queueItemId,
      sourceIdentity: prepared.asset.binding.sourceIdentity,
      transferSessionId: prepared.asset.binding.transferSessionId,
      encodedSize: prepared.asset.encodedSize,
      name: prepared.asset.metadata.name,
      mime: prepared.asset.metadata.mime,
    } as const;
    this.#assertPreparedCandidateAuthority(prepared, epoch);

    let revisionAllocated = false;
    let offerDelivered = false;
    try {
      // Keep the exact prepared OFFER on the same synchronous revision lane as
      // current and warm publication.
      const prepareRevision = this.#nextPrepareRevision();
      revisionAllocated = true;
      let offer: Readonly<FileMediaSourceOfferV2>;
      if (prepared.backend === 'bounded-stream') {
        if (handleId === null || peerRangeExpiresAtRoomTimeMs === null) {
          throw new Error('Host prepared peer-range offer plan is incomplete');
        }
        offer = createPeerRangeFileMediaSourceOfferV2({
          ...base,
          prepareRevision,
          handleId,
          expiresAtRoomTimeMs: peerRangeExpiresAtRoomTimeMs,
        });
      } else {
        if (!r2OfferFields) throw new Error('Host prepared R2 offer plan is incomplete');
        offer = createR2WholeBlobFileMediaSourceOfferV2({
          ...base,
          prepareRevision,
          ...r2OfferFields,
        });
      }
      const record = this.#createPreparedPublicationRecord({
        epoch,
        prepared,
        offer,
        handleId,
        resolve,
        transferredWarmSource: null,
        offerSent: false,
        status: 'offering',
      });
      this.#candidate = record;
      this.#assertCandidateRecord(record);
      record.offerSent = true;
      this.#sendRequiredFrame(offer);
      offerDelivered = true;
      this.#assertCandidateRecord(record);
      record.status = 'offered';
      return record.commit;
    } catch (error) {
      if (revisionAllocated && !offerDelivered && !this.#closed) {
        throw this.#failConnection(error);
      }
      throw error;
    }
  }

  #createPreparedPublicationRecord(
    options: Readonly<{
      epoch: number;
      prepared: Readonly<HostPreparedLocalTrack>;
      offer: Readonly<FileMediaSourceOfferV2>;
      handleId: string | null;
      resolve: NonNullable<
        FilePlaybackProductHostMediaOwnerOptions['resolvePreparedPeerRangeSource']
      >;
      transferredWarmSource: WarmSourceOfferRecord | null;
      offerSent: boolean;
      status: 'offering' | 'offered';
    }>,
  ): PreparedPublicationRecord {
    const binding = createFilePlaybackRunBindingV2({
      sessionId: this.#context.sessionId,
      connectionId: this.#context.connectionId,
      prepareId: options.offer.prepareId,
      prepareRevision: options.offer.prepareRevision,
      queueItemId: options.offer.queueItemId,
      sourceIdentity: options.offer.sourceIdentity,
      transferSessionId: options.offer.transferSessionId,
      runId: options.prepared.state.runId,
      playbackRevision: options.prepared.state.revision,
    });
    const ready = deferredReadyCapability();
    const commit = freezeCanonical({
      schemaVersion: 1 as const,
      prepared: options.prepared,
      offer: options.offer,
      binding,
    });
    return {
      epoch: options.epoch,
      prepared: options.prepared,
      offer: options.offer,
      binding,
      stateLease: null,
      handleId: options.handleId,
      source: freezeCanonical({ prepared: options.prepared, resolve: options.resolve }),
      commit,
      transferredWarmSource: options.transferredWarmSource,
      ready: ready.promise,
      resolveReady: ready.resolve,
      rejectReady: ready.reject,
      participant: null,
      capability: null,
      offerSent: options.offerSent,
      offerRevokeSent: false,
      status: options.status,
    };
  }

  #transferableWarmSourceForPrepared(
    prepared: Readonly<HostPreparedLocalTrack>,
  ): WarmSourceOfferRecord | null {
    const sourceLease = prepared.sourceLease;
    if (prepared.backend !== 'bounded-stream' || !sourceLease) return null;

    const pending = this.#warmOfferTaskAuthority;
    if (pending?.sourceLease === sourceLease) {
      this.#assertPreparedMatchesWarmAuthority(prepared, pending);
      return null;
    }
    const warm = this.#warmOffer;
    if (!warm || warm.sourceLease !== sourceLease) return null;
    this.#assertPreparedMatchesWarmSource(prepared, warm);
    if (!this.#canTransferWarmSourceToPrepared(prepared, warm)) return null;
    return warm;
  }

  async #awaitPendingWarmSourceForPrepared(
    prepared: Readonly<HostPreparedLocalTrack>,
    epoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    const sourceLease = prepared.sourceLease;
    if (prepared.backend !== 'bounded-stream' || !sourceLease) return;
    const authority = this.#warmOfferTaskAuthority;
    const task = this.#warmOfferTask;
    if (!authority || authority.sourceLease !== sourceLease || !task) return;
    this.#assertPreparedMatchesWarmAuthority(prepared, authority);
    try {
      await awaitWhileOwned(task, signal);
    } catch {
      // Candidate cancellation only detaches this wait. A failed warm task may
      // fall through to one fresh candidate offer while exact authority lives.
      this.#assertPreparedCandidateAuthority(prepared, epoch);
    }
  }

  #canTransferWarmSourceToPrepared(
    prepared: Readonly<HostPreparedLocalTrack>,
    warm: WarmSourceOfferRecord,
  ): boolean {
    const sourceLease = prepared.sourceLease;
    if (prepared.backend !== 'bounded-stream' || !sourceLease) return false;
    const pending = this.#warmOfferTaskAuthority;
    if (pending?.sourceLease === sourceLease) {
      this.#assertPreparedMatchesWarmAuthority(prepared, pending);
      return false;
    }
    const current = this.#warmOffer;
    if (current?.sourceLease === sourceLease) {
      this.#assertPreparedMatchesWarmSource(prepared, current);
    }
    if (current !== warm || warm.status !== 'offered') return false;
    if (warm.offer.expiresAtRoomTimeMs <= this.#nowRoomTimeMs()) {
      this.#expireWarmSourceOffer(warm);
      return false;
    }
    return true;
  }

  #assertPreparedMatchesWarmSource(
    prepared: Readonly<HostPreparedLocalTrack>,
    warm: WarmSourceOfferRecord,
  ): void {
    if (warm.sourceLease !== prepared.sourceLease) {
      throw new Error('Host prepared source contradicts the exact warm offer');
    }
    this.#assertPreparedMatchesWarmAuthority(prepared, warm.authority);
  }

  #assertPreparedMatchesWarmAuthority(
    prepared: Readonly<HostPreparedLocalTrack>,
    authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>,
  ): void {
    const sourceLease = this.#requireWarmSourceOfferAuthority(authority);
    const asset = authority.asset;
    if (
      prepared.backend !== 'bounded-stream' ||
      prepared.sourceLease !== sourceLease ||
      prepared.roomGeneration !== authority.roomGeneration ||
      prepared.asset.kind !== asset.kind ||
      prepared.asset.binding.queueItemId !== asset.binding.queueItemId ||
      prepared.asset.binding.sourceIdentity !== asset.binding.sourceIdentity ||
      prepared.asset.binding.transferSessionId !== asset.binding.transferSessionId ||
      prepared.asset.metadata.name !== asset.metadata.name ||
      prepared.asset.metadata.mime !== asset.metadata.mime ||
      prepared.asset.encodedSize !== asset.encodedSize
    ) {
      throw new Error('Host prepared source contradicts the exact warm offer');
    }
  }

  #fenceSameLeaseWarmSourceForPreparedRepair(prepared: Readonly<HostPreparedLocalTrack>): void {
    const sourceLease = prepared.sourceLease;
    if (prepared.backend !== 'bounded-stream' || !sourceLease) return;

    const pending = this.#warmOfferTaskAuthority;
    if (pending?.sourceLease === sourceLease) {
      this.#assertPreparedMatchesWarmAuthority(prepared, pending);
    }
    const warm = this.#warmOffer;
    if (warm?.sourceLease === sourceLease) {
      this.#assertPreparedMatchesWarmSource(prepared, warm);
    }

    // Fence the lease before abort/revoke hooks can synchronously republish it.
    this.#promotedWarmSourceLeases.add(sourceLease);
    if (pending?.sourceLease === sourceLease) {
      this.#warmOfferEpoch += 1;
      this.#warmOfferTaskController?.abort(
        new Error('Host warm source offer was superseded by prepared repair'),
      );
    }
    if (warm?.sourceLease === sourceLease) {
      this.#retireWarmSourceOffer(
        warm,
        new Error('Host warm source offer was superseded by prepared repair'),
      );
    }
  }

  #transferWarmSourceToPrepared(
    prepared: Readonly<HostPreparedLocalTrack>,
    epoch: number,
    warm: WarmSourceOfferRecord,
    resolve: NonNullable<
      FilePlaybackProductHostMediaOwnerOptions['resolvePreparedPeerRangeSource']
    >,
  ): Readonly<FilePlaybackProductHostPreparedPublicationCommit> {
    this.#assertPreparedCandidateAuthority(prepared, epoch);
    this.#assertPreparedMatchesWarmSource(prepared, warm);
    if (!this.#canTransferWarmSourceToPrepared(prepared, warm)) {
      throw new Error('Host warm source offer transfer authority raced away');
    }

    const record = this.#createPreparedPublicationRecord({
      epoch,
      prepared,
      offer: warm.offer,
      handleId: warm.handleId,
      resolve,
      transferredWarmSource: warm,
      offerSent: true,
      status: 'offered',
    });
    const timer = warm.expiryTimer;
    warm.expiryTimer = null;
    warm.status = 'transferred';
    this.#warmOffer = null;
    this.#promotedWarmSourceLeases.add(warm.sourceLease);
    this.#candidate = record;

    if (timer !== null) {
      try {
        this.#runtime.cancelTimeout(timer);
      } catch {
        // Candidate authority already owns this exact offer and handle.
      }
    }
    this.#assertCandidateRecord(record);
    return record.commit;
  }

  #bindPreparedRun(
    record: PreparedPublicationRecord,
  ): Readonly<FilePlaybackProductHostPreparedPublicationCommit> {
    this.#assertCandidateRecord(record);
    if (record.status !== 'offered' || record.stateLease !== null) {
      throw new Error('Host prepared publication is not bindable');
    }
    if (record.offer.expiresAtRoomTimeMs <= this.#nowRoomTimeMs()) {
      const error = new Error('Host prepared source offer expired before binding');
      this.#candidateEpoch += 1;
      this.#candidateController.abort(error);
      this.#retirePreparedCandidate(error);
      throw error;
    }
    record.status = 'binding';
    this.#retireAttempt(new Error('Host prepared candidate superseded current recovery'));
    let stateLease: FilePlaybackWireStateLease;
    try {
      stateLease = this.#installCandidateState(record.prepared);
    } catch (error) {
      throw this.#failConnection(error);
    }
    record.stateLease = stateLease;
    this.#sendRequiredFrame(record.binding);
    this.#assertCandidateRecord(record);
    record.status = 'published';
    return record.commit;
  }

  #installCurrentState(
    publication: Readonly<HostPeerPlaybackPublication>,
  ): FilePlaybackWireStateLease {
    const binding = freezeCanonical({
      run: publication.state,
      sourceIdentity: publication.asset.binding.sourceIdentity,
      transferSessionId: publication.asset.binding.transferSessionId,
    });
    if (!this.#wireBootstrapped) {
      const lease = Reflect.apply(trustedChannelBootstrapCurrent, this.#context.channel, [binding]);
      this.#wireBootstrapped = true;
      return lease;
    }
    const lease = Reflect.apply(trustedChannelStageMedia, this.#context.channel, [binding]);
    Reflect.apply(trustedChannelCommitMedia, this.#context.channel, [lease]);
    return lease;
  }

  #installCandidateState(prepared: Readonly<HostPreparedLocalTrack>): FilePlaybackWireStateLease {
    const binding = freezeCanonical({
      run: prepared.state,
      sourceIdentity: prepared.asset.binding.sourceIdentity,
      transferSessionId: prepared.asset.binding.transferSessionId,
    });
    if (!this.#wireBootstrapped) {
      Reflect.apply(trustedChannelBootstrapStopped, this.#context.channel, [
        prepared.state.revision - 1,
      ]);
      this.#wireBootstrapped = true;
    }
    return Reflect.apply(trustedChannelStageMedia, this.#context.channel, [binding]);
  }

  #adoptWireMessage(value: Readonly<FilePlaybackWireAdoptionEvent>, acknowledge: () => void): void {
    const event = snapshotExactRecord(value, WIRE_EVENT_KEYS);
    if (!event || typeof acknowledge !== 'function') {
      throw new TypeError('Host media owner wire adoption is invalid');
    }
    this.#assertEventConnection(event);
    const message = event.message as FilePlaybackWireAdoptionEvent['message'];
    const candidate = this.#candidate;
    const record = this.#publication;

    if (message.kind === 'source-ready' || message.kind === 'source-not-ready') {
      if (candidate && candidate.stateLease !== null && event.stateLease === candidate.stateLease) {
        if (event.attemptLease !== null || candidate.status !== 'published') {
          acknowledge();
          return;
        }
        this.#assertMessageState(
          message,
          candidate.prepared.state,
          candidate.prepared.asset.binding.sourceIdentity,
          candidate.prepared.asset.binding.transferSessionId,
        );
        if (message.kind === 'source-not-ready') {
          candidate.rejectReady(new Error(`Guest source is not ready: ${message.reasonCode}`));
          this.#reportHealth({
            dimension: 'media-readiness',
            value: 'unhealthy',
            observedAtMs: message.observedAtRoomTimeMs,
            leaseUntilMs: message.observedAtRoomTimeMs,
            reasonCode: message.reasonCode,
          });
          acknowledge();
          return;
        }
        if (message.backend !== candidate.prepared.backend) {
          throw new Error('Guest SOURCE_READY backend does not match host candidate');
        }
        this.#reportHealth({
          dimension: 'media-readiness',
          value: 'healthy',
          observedAtMs: message.observedAtRoomTimeMs,
          leaseUntilMs: message.readyLeaseUntilRoomTimeMs,
        });
        acknowledge();
        this.#publishPreparedRemoteCapability(candidate);
        return;
      }
      if (!record || record.status !== 'published') {
        throw new Error('Host media owner received wire before publication');
      }
      if (event.stateLease !== record.stateLease || event.attemptLease !== null) {
        acknowledge();
        return;
      }
      this.#assertMessagePublication(message, record.publication);
      if (message.kind === 'source-not-ready') {
        this.#reportHealth({
          dimension: 'media-readiness',
          value: 'unhealthy',
          observedAtMs: message.observedAtRoomTimeMs,
          leaseUntilMs: message.observedAtRoomTimeMs,
          reasonCode: message.reasonCode,
        });
        acknowledge();
        return;
      }
      if (message.backend !== record.publication.backend) {
        throw new Error('Guest SOURCE_READY backend does not match host publication');
      }
      this.#reportHealth({
        dimension: 'media-readiness',
        value: 'healthy',
        observedAtMs: message.observedAtRoomTimeMs,
        leaseUntilMs: message.readyLeaseUntilRoomTimeMs,
      });
      acknowledge();
      // A paused late join is already correct after the guest commits its
      // prepared paused baseline. Only an actively playing publication needs
      // a physical ARM/FINALIZE recovery attempt.
      if (record.publication.timeline.phase === 'playing') {
        queueMicrotask(() => this.#beginRecovery(record));
      }
      return;
    }

    const attempt = this.#attempt;
    if (
      !attempt ||
      event.stateLease !== attempt.stateLease ||
      event.attemptLease !== attempt.lease
    ) {
      acknowledge();
      return;
    }
    this.#assertMessageState(
      message,
      attempt.state,
      attempt.sourceIdentity,
      attempt.transferSessionId,
    );
    if (!('rendezvousId' in message) || message.rendezvousId !== attempt.attempt.rendezvousId) {
      acknowledge();
      return;
    }
    if (message.kind === 'rendezvous-armed') {
      const accepted = attempt.participant.acceptArmReceipt({
        protocolVersion: 2,
        kind: 'rendezvous-armed',
        queueItemId: message.queueItemId,
        runId: message.runId,
        revision: message.revision,
        rendezvousId: message.rendezvousId,
        participantId: message.senderParticipantId,
        status: message.status,
        observedAtRoomTimeMs: message.observedAtRoomTimeMs,
        bufferedAheadSeconds: message.bufferedAheadSeconds,
        reasonCode: message.reasonCode,
      });
      if (!accepted) throw new Error('Guest rendezvous ARM receipt was stale or invalid');
      acknowledge();
      return;
    }
    if (message.kind === 'rendezvous-finalized') {
      const accepted = attempt.participant.acceptFinalizeReceipt({
        protocolVersion: 2,
        kind: 'rendezvous-finalized',
        queueItemId: message.queueItemId,
        runId: message.runId,
        revision: message.revision,
        rendezvousId: message.rendezvousId,
        participantId: message.senderParticipantId,
        status: message.status,
        observedAtRoomTimeMs: message.observedAtRoomTimeMs,
        reasonCode: message.reasonCode,
      });
      if (!accepted) throw new Error('Guest rendezvous FINALIZE receipt was stale or invalid');
      acknowledge();
      return;
    }
    if (message.kind === 'renderer-health') {
      const accepted = attempt.participant.acceptRendererStartEvidence(message);
      this.#reportHealth({
        dimension: 'renderer',
        value: message.value,
        observedAtMs: message.observedAtRoomTimeMs,
        leaseUntilMs:
          message.value === 'healthy' ? message.leaseUntilRoomTimeMs : message.observedAtRoomTimeMs,
        reasonCode: message.reasonCode,
      });
      if (message.value === 'healthy' && accepted) {
        attempt.resolveEvidence();
        this.#reportHealth({
          dimension: 'media-readiness',
          value: 'healthy',
          observedAtMs: message.observedAtRoomTimeMs,
          leaseUntilMs: message.leaseUntilRoomTimeMs,
        });
      }
      acknowledge();
      return;
    }
    throw new Error(`Host media owner cannot consume ${message.kind}`);
  }

  #adoptPeerRangeControl(
    value: Readonly<FilePlaybackPeerRangeAdoptionEvent>,
    acknowledge: () => void,
  ): void {
    const event = snapshotExactRecord(value, PEER_RANGE_EVENT_KEYS);
    if (!event || typeof acknowledge !== 'function') {
      throw new TypeError('Host media owner peer-range adoption is invalid');
    }
    this.#assertEventConnection(event);
    if (event.role !== 'host' || event.lane !== 'control') {
      throw new Error('Host media owner received the wrong peer-range lane');
    }
    this.#expireWarmSourceOfferIfNeeded();
    const frame = parsePeerRangeControlFrame(event.frame);
    const candidate = this.#candidate;
    const current = this.#publication;
    const warm = this.#warmOffer;
    const authority =
      candidate !== null &&
      hasPreparedSourceAuthority(candidate) &&
      candidate.handleId === frame.handleId &&
      candidate.offer.transport === 'peer-range'
        ? {
            handleId: candidate.handleId,
            sourceIdentity: candidate.prepared.asset.binding.sourceIdentity,
          }
        : current?.status === 'published' &&
            current.handleId === frame.handleId &&
            current.offer.transport === 'peer-range'
          ? {
              handleId: current.handleId,
              sourceIdentity: current.publication.asset.binding.sourceIdentity,
            }
          : warm?.status === 'offered' &&
              warm.handleId === frame.handleId &&
              warm.offer.transport === 'peer-range'
            ? {
                handleId: warm.handleId,
                sourceIdentity: warm.authority.asset.binding.sourceIdentity,
              }
            : null;
    if (
      !authority ||
      frame.connectionId !== this.#context.connectionId ||
      frame.sourceIdentity !== authority.sourceIdentity ||
      frame.handleId !== authority.handleId
    ) {
      throw new Error('Peer-range request does not match the current publication');
    }
    this.#responder.acceptControl(this.#context.connectionToken, frame);
    acknowledge();
  }

  #createRemoteParticipant(
    state: Readonly<HostPreparedLocalTrack['state']>,
    sourceIdentity: string,
    transferSessionId: string,
  ): RemoteRendezvousParticipant {
    return new RemoteRendezvousParticipant({
      participantId: this.#context.guestParticipantId,
      rendererEvidenceScope: freezeCanonical({
        sessionId: this.#context.sessionId,
        connectionId: this.#context.connectionId,
        recipientParticipantId: this.#context.hostParticipantId,
        sourceIdentity,
        transferSessionId,
      }),
      rttP95Ms: () => Reflect.apply(trustedChannelQuality, this.#context.channel, []).rttP95Ms,
      armP95Ms: 0,
      nowRoomTimeMs: () => this.#nowRoomTimeMs(),
      dispatchArm: (intent) => {
        if (
          intent.queueItemId !== state.queueItemId ||
          intent.runId !== state.runId ||
          intent.revision !== state.revision
        ) {
          return Promise.reject(new Error('Host remote ARM state authority is stale'));
        }
        return this.#dispatchAttemptWire('rendezvous-arm', intent.rendezvousId, {
          kind: 'rendezvous-arm',
          rendezvousId: intent.rendezvousId,
          positionSeconds: intent.positionSeconds,
          playbackRate: intent.playbackRate,
          startAtRoomTimeMs: intent.startAtRoomTimeMs,
          finalizeByRoomTimeMs: intent.finalizeByRoomTimeMs,
        });
      },
      dispatchFinalize: (intent) =>
        this.#dispatchAttemptWire('rendezvous-finalize', intent.rendezvousId, {
          kind: 'rendezvous-finalize',
          rendezvousId: intent.rendezvousId,
          startAtRoomTimeMs: intent.startAtRoomTimeMs,
          finalizedAtRoomTimeMs: intent.finalizedAtRoomTimeMs,
        }),
      dispatchCancel: (intent) =>
        this.#dispatchAttemptWire('file-playback-cancel', intent.rendezvousId, {
          kind: 'file-playback-cancel',
          rendezvousId: intent.rendezvousId,
          reasonCode: intent.reasonCode,
        }),
    });
  }

  #publishPreparedRemoteCapability(record: PreparedPublicationRecord): void {
    if (record.capability) return;
    const participant = this.#createRemoteParticipant(
      record.prepared.state,
      record.prepared.asset.binding.sourceIdentity,
      record.prepared.asset.binding.transferSessionId,
    );
    const capability = freezeCanonical({
      participant,
      bindAttempt: (attempt: HostRendezvousAttempt) => this.#bindPreparedAttempt(record, attempt),
    }) satisfies Readonly<HostPreparedRemoteParticipant>;
    record.participant = participant;
    record.capability = capability;
    record.resolveReady(capability);
  }

  #bindPreparedAttempt(
    record: PreparedPublicationRecord,
    attempt: HostRendezvousAttempt,
  ): Promise<void> {
    const stateLease = record.stateLease;
    if (
      this.#closed ||
      this.#candidate !== record ||
      record.status !== 'published' ||
      !stateLease ||
      !record.participant ||
      typeof attempt?.rendezvousId !== 'string' ||
      typeof attempt.whenParticipantAccepted !== 'function'
    ) {
      return Promise.reject(new Error('Host prepared attempt authority is stale'));
    }
    if (this.#attempt?.preparedRecord === record) {
      if (this.#attempt.attempt === attempt) return this.#attempt.evidence;
      return Promise.reject(new Error('Host prepared candidate is already attempt-bound'));
    }
    const evidence = deferredEvidence();
    let lease: FilePlaybackWireAttemptLease;
    try {
      lease = Reflect.apply(trustedChannelStageAttempt, this.#context.channel, [
        stateLease,
        attempt.rendezvousId,
      ]);
    } catch (error) {
      evidence.reject(asError(error, 'Host prepared attempt staging failed'));
      return evidence.promise;
    }
    const previous = this.#attempt;
    if (previous?.status === 'candidate') this.#retireAttemptLease(previous);
    const attemptRecord: AttemptRecord = {
      mode: 'prepared',
      publicationEpoch: record.epoch,
      participant: record.participant,
      attempt,
      lease,
      stateLease,
      state: record.prepared.state,
      sourceIdentity: record.prepared.asset.binding.sourceIdentity,
      transferSessionId: record.prepared.asset.binding.transferSessionId,
      evidence: evidence.promise,
      resolveEvidence: evidence.resolve,
      rejectEvidence: evidence.reject,
      preparedRecord: record,
      outcome: 'pending',
      stateCommitted: false,
      status: 'candidate',
    };
    this.#attempt = attemptRecord;
    this.#attemptsById.set(attempt.rendezvousId, attemptRecord);
    let accepted: Promise<unknown>;
    try {
      accepted = attempt.whenParticipantAccepted(record.participant.participantId);
    } catch (error) {
      this.#failPreparedAttempt(attemptRecord, error);
      return evidence.promise;
    }
    observe(
      Promise.all([accepted, evidence.promise]).then(
        () => {
          if (attemptRecord.status === 'retired') return;
          attemptRecord.outcome = 'succeeded';
          this.#settlePreparedAttempt(attemptRecord);
        },
        (error) => this.#failPreparedAttempt(attemptRecord, error),
      ),
    );
    return evidence.promise;
  }

  #settlePreparedAttempt(attempt: AttemptRecord): void {
    if (
      attempt.mode !== 'prepared' ||
      !attempt.stateCommitted ||
      attempt.outcome !== 'succeeded' ||
      attempt.status !== 'candidate' ||
      this.#attempt !== attempt
    ) {
      return;
    }
    try {
      Reflect.apply(trustedChannelCommitAttempt, this.#context.channel, [attempt.lease]);
      attempt.status = 'current';
    } catch (error) {
      this.#failConnection(error);
    }
  }

  #failPreparedAttempt(attempt: AttemptRecord, error: unknown): void {
    if (attempt.mode !== 'prepared' || attempt.status === 'retired') return;
    attempt.outcome = 'failed';
    attempt.rejectEvidence(asError(error, 'Host prepared remote attempt failed'));
    this.#retireAttemptLease(attempt);
    if (this.#attempt === attempt) this.#attempt = null;
  }

  #beginRecovery(record: PublicationRecord, force = false): void {
    if (this.#closed || this.#publication !== record) return;
    if (
      this.#attempt?.publicationEpoch === record.epoch &&
      (this.#attempt.status === 'candidate' || (!force && this.#attempt.status === 'current'))
    ) {
      return;
    }
    const participant =
      record.participant ??
      this.#createRemoteParticipant(
        record.publication.state,
        record.publication.asset.binding.sourceIdentity,
        record.publication.asset.binding.transferSessionId,
      );
    record.participant = participant;
    const evidence = deferredEvidence();
    const recovery = this.#hostRoom.recoverRemoteParticipant({
      publication: record.publication,
      participant,
      signal: this.#publicationSignal(record.epoch),
      bindAttempt: (attempt) => {
        if (this.#closed || this.#publication !== record) {
          return Promise.reject(new Error('Host media recovery publication is stale'));
        }
        const lease = Reflect.apply(trustedChannelStageAttempt, this.#context.channel, [
          record.stateLease,
          attempt.rendezvousId,
        ]);
        const previous = this.#attempt;
        if (previous?.status === 'candidate') this.#retireAttemptLease(previous);
        this.#attempt = {
          mode: 'recovery',
          publicationEpoch: record.epoch,
          participant,
          attempt,
          lease,
          stateLease: record.stateLease,
          state: record.publication.state,
          sourceIdentity: record.publication.asset.binding.sourceIdentity,
          transferSessionId: record.publication.asset.binding.transferSessionId,
          evidence: evidence.promise,
          resolveEvidence: evidence.resolve,
          rejectEvidence: evidence.reject,
          preparedRecord: null,
          outcome: 'pending',
          stateCommitted: true,
          status: 'candidate',
        };
        this.#attemptsById.set(attempt.rendezvousId, this.#attempt);
        return evidence.promise;
      },
    });
    observe(
      recovery.then(
        () => this.#commitRecovery(record, participant),
        (error) => this.#rejectRecovery(record, participant, error),
      ),
    );
  }

  #commitRecovery(record: PublicationRecord, participant: RemoteRendezvousParticipant): void {
    const attempt = this.#attempt;
    if (
      !attempt ||
      this.#closed ||
      this.#publication !== record ||
      attempt.participant !== participant ||
      attempt.publicationEpoch !== record.epoch ||
      attempt.status !== 'candidate'
    ) {
      return;
    }
    Reflect.apply(trustedChannelCommitAttempt, this.#context.channel, [attempt.lease]);
    attempt.status = 'current';
    for (const [rendezvousId, stale] of this.#attemptsById) {
      if (stale === attempt) continue;
      stale.status = 'retired';
      this.#attemptsById.delete(rendezvousId);
    }
    this.#applyHealth(this.#health.completeRejoin(true));
  }

  #rejectRecovery(
    record: PublicationRecord,
    participant: RemoteRendezvousParticipant,
    error: unknown,
  ): void {
    const attempt = this.#attempt;
    if (
      attempt &&
      this.#publication === record &&
      attempt.participant === participant &&
      attempt.publicationEpoch === record.epoch &&
      attempt.status === 'candidate'
    ) {
      attempt.rejectEvidence(asError(error, 'Host participant recovery failed'));
      this.#retireAttemptLease(attempt);
      this.#attemptsById.delete(attempt.attempt.rendezvousId);
      if (this.#attempt === attempt) this.#attempt = null;
    }
    this.#applyHealth(this.#health.completeRejoin(false));
  }

  #dispatchAttemptWire<
    Kind extends 'file-playback-cancel' | 'rendezvous-arm' | 'rendezvous-finalize',
  >(kind: Kind, rendezvousId: string, payload: FilePlaybackWirePayloadByKind[Kind]): Promise<void> {
    return Promise.resolve().then(() => {
      const attempt = this.#attemptsById.get(rendezvousId) ?? null;
      if (
        !attempt ||
        attempt.attempt.rendezvousId !== rendezvousId ||
        attempt.status === 'retired' ||
        this.#closed
      ) {
        throw new Error(`Host ${kind} attempt authority is stale`);
      }
      let sent: FilePlaybackWireMessageForKind<Kind> | null;
      try {
        sent = this.#sendWire(this.#context.connection, attempt.lease, payload);
      } catch (error) {
        throw this.#failConnection(error);
      }
      if (!sent) throw this.#failConnection(new Error(`Host ${kind} send failed`));
      if (kind === 'file-playback-cancel') {
        attempt.status = 'retired';
        this.#attemptsById.delete(rendezvousId);
      }
    });
  }

  async #resolvePeerSource(
    handleId: string | null,
    sourceIdentity: string,
    signal: AbortSignal,
  ): Promise<HostPeerRangeSource | null> {
    this.#expireWarmSourceOfferIfNeeded();
    const candidate = this.#candidate;
    if (
      candidate !== null &&
      hasPreparedSourceAuthority(candidate) &&
      candidate.offer.transport === 'peer-range' &&
      (handleId === null || handleId === candidate.handleId) &&
      sourceIdentity === candidate.prepared.asset.binding.sourceIdentity
    ) {
      const source = await candidate.source.resolve({
        prepared: candidate.prepared,
        sourceIdentity,
        signal,
      });
      if (this.#closed || this.#candidate !== candidate || !hasPreparedSourceAuthority(candidate)) {
        if (isEncodedSource(source)) await source.close().catch(() => undefined);
        return null;
      }
      return source;
    }
    const record = this.#publication;
    if (
      record &&
      record.offer.transport === 'peer-range' &&
      (handleId === null || handleId === record.handleId) &&
      sourceIdentity === record.publication.asset.binding.sourceIdentity
    ) {
      const source = await this.#hostRoom.resolveCurrentPeerRangeSource({
        publication: record.publication,
        sourceIdentity,
        signal,
      });
      if (this.#closed || this.#publication !== record) {
        if (isEncodedSource(source)) await source.close().catch(() => undefined);
        return null;
      }
      if (this.#hostRoom.currentPeerPublication() !== record.publication) {
        if (isEncodedSource(source)) await source.close().catch(() => undefined);
        return null;
      }
      return source;
    }

    const warm = this.#warmOffer;
    if (
      !warm ||
      warm.status !== 'offered' ||
      warm.offer.transport !== 'peer-range' ||
      (handleId !== null && handleId !== warm.handleId) ||
      sourceIdentity !== warm.authority.asset.binding.sourceIdentity
    ) {
      return null;
    }
    const source = await warm.resolve({
      sourceLease: warm.sourceLease,
      sourceIdentity,
      signal,
    });
    const stillWarm = this.#warmOffer === warm && warm.status === 'offered';
    if (this.#closed || (!stillWarm && !this.#hasTransferredWarmSourceAuthority(warm))) {
      if (isEncodedSource(source)) await source.close().catch(() => undefined);
      return null;
    }
    const asset = warm.authority.asset;
    if (
      source.size !== asset.encodedSize ||
      (isEncodedSource(source) &&
        (source.identity !== asset.binding.sourceIdentity ||
          source.metadata.name !== asset.metadata.name ||
          source.metadata.mime !== asset.metadata.mime))
    ) {
      if (isEncodedSource(source)) await source.close().catch(() => undefined);
      throw new Error('Host warm peer source changed its exact offer binding');
    }
    return source;
  }

  #hasTransferredWarmSourceAuthority(warm: WarmSourceOfferRecord): boolean {
    const candidate = this.#candidate;
    if (
      candidate?.transferredWarmSource === warm &&
      candidate.offer === warm.offer &&
      candidate.handleId === warm.handleId &&
      candidate.prepared.sourceLease === warm.sourceLease &&
      candidate.prepared.asset.binding.sourceIdentity ===
        warm.authority.asset.binding.sourceIdentity &&
      hasPreparedSourceAuthority(candidate)
    ) {
      return true;
    }
    const publication = this.#publication;
    return Boolean(
      publication?.transferredWarmSource === warm &&
      publication.offer === warm.offer &&
      publication.handleId === warm.handleId &&
      publication.publication.asset.binding.sourceIdentity ===
        warm.authority.asset.binding.sourceIdentity &&
      publication.status === 'published',
    );
  }

  #sendPeerRangeBulk(frame: PeerRangeBulkFrame): Promise<void> {
    return Promise.resolve().then(() => {
      if (this.#closed || !this.#canSendPeerRange()) {
        throw new HostMediaOwnerConnectionError('Peer-range bulk connection is unavailable');
      }
      if (!this.#sendRequired(this.#context.connection, frame)) {
        throw this.#failConnection(new Error('Peer-range bulk send failed'));
      }
    });
  }

  #canSendPeerRange(): boolean {
    const connection = this.#context.connection;
    const dataChannel = connection.dataChannel;
    return (
      !this.#closed &&
      connection.open === true &&
      dataChannel?.readyState === 'open' &&
      Number.isFinite(dataChannel.bufferedAmount) &&
      dataChannel.bufferedAmount <= PEER_RANGE_BUFFERED_AMOUNT_LIMIT
    );
  }

  #tickHealth(): void {
    if (this.#closed) return;
    try {
      const now = this.#nowRoomTimeMs();
      const transportHealthy =
        this.#context.connection.open === true &&
        Reflect.apply(trustedChannelToken, this.#context.channel, []) ===
          this.#context.connectionToken;
      const clockHealthy =
        transportHealthy && Reflect.apply(trustedChannelClockReady, this.#context.channel, []);
      const signals: ParticipantHealthSignal[] = [
        {
          dimension: 'transport',
          value: transportHealthy ? 'healthy' : 'unhealthy',
          observedAtMs: now,
          leaseUntilMs: transportHealthy ? now + HEALTH_LEASE_MS : now,
          reasonCode: transportHealthy ? null : 'transport-disconnected',
        },
        {
          dimension: 'clock',
          value: clockHealthy ? 'healthy' : 'unhealthy',
          observedAtMs: now,
          leaseUntilMs: clockHealthy ? now + HEALTH_LEASE_MS : now,
          reasonCode: clockHealthy ? null : 'clock-not-ready',
        },
      ];
      if (!this.#publication?.participant) {
        signals.push(
          {
            dimension: 'media-readiness',
            value: 'healthy',
            observedAtMs: now,
            leaseUntilMs: now + HEALTH_LEASE_MS,
          },
          {
            dimension: 'renderer',
            value: 'healthy',
            observedAtMs: now,
            leaseUntilMs: now + HEALTH_LEASE_MS,
          },
        );
      }
      this.#applyHealth(this.#health.reportMany(signals));
      this.#applyHealth(this.#health.tick());
    } catch (error) {
      this.#failConnection(error);
    }
  }

  #reportHealth(signal: ParticipantHealthSignal): void {
    try {
      this.#applyHealth(this.#health.report(signal));
    } catch (error) {
      this.#failConnection(error);
    }
  }

  #applyHealth(transition: ParticipantHealthTransition): void {
    for (const action of transition.actions) this.#applyHealthAction(action);
  }

  #applyHealthAction(action: ParticipantHealthAction): void {
    if (action.type === 'emit-degraded-system-message') {
      try {
        this.#onHealthSystemMessage(
          freezeCanonical({
            schemaVersion: 1 as const,
            participantId: action.participantId,
            messageKey: action.messageKey,
          }),
        );
      } catch {
        // Presentation failure cannot change participant or room authority.
      }
      return;
    }
    if (action.type === 'request-rejoin') {
      this.#health.beginRejoin();
      const record = this.#publication;
      if (record?.participant) queueMicrotask(() => this.#beginRecovery(record, true));
    }
  }

  #revoke(value: Readonly<FilePlaybackProductSessionRouterConnectionContext>): void {
    if (value !== this.#context) {
      throw new Error('Host media owner revoke context is stale');
    }
    this.#close(false, new Error('Host media owner was revoked'));
  }

  #failConnection(cause: unknown): HostMediaOwnerConnectionError {
    const error =
      cause instanceof HostMediaOwnerConnectionError
        ? cause
        : new HostMediaOwnerConnectionError('Host media connection failed', cause);
    if (this.#fatal || this.#closed) return error;
    this.#fatal = true;
    this.#close(true, error);
    return error;
  }

  #close(closeConnection: boolean, reason: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#publicationEpoch += 1;
    this.#candidateEpoch += 1;
    this.#warmOfferEpoch += 1;
    this.#publicationController.abort(reason);
    this.#candidateController.abort(reason);
    this.#warmOfferTaskController?.abort(reason);
    this.#runtime.cancelInterval(this.#healthTimer);
    this.#retireAttempt(reason);
    this.#retirePreparedCandidate(reason, false);
    if (this.#warmOffer) this.#retireWarmSourceOffer(this.#warmOffer, reason, false);
    this.#revokePublishedHandle(reason);
    this.#responder.close(reason);
    this.#publication = null;
    this.#publicationTask = null;
    this.#publicationTaskIdentity = null;
    this.#candidateTask = null;
    this.#candidateTaskIdentity = null;
    this.#candidateBindingTask = null;
    this.#candidateBindingTaskIdentity = null;
    this.#warmOfferTask = null;
    this.#warmOfferTaskAuthority = null;
    this.#warmOfferTaskController = null;
    this.#attemptsById.clear();
    if (closeConnection) {
      try {
        this.#closeConnection(this.#context.connection);
      } catch {
        // Exact connection authority is already terminal in this owner.
      }
    }
  }

  #retireAttempt(reason: Error): void {
    const attempt = this.#attempt;
    if (!attempt) return;
    attempt.rejectEvidence(reason);
    this.#retireAttemptLease(attempt);
    this.#attemptsById.delete(attempt.attempt.rendezvousId);
    this.#attempt = null;
  }

  #retireAttemptLease(attempt: AttemptRecord): void {
    if (attempt.status === 'retired') return;
    try {
      Reflect.apply(trustedChannelRetireAttempt, this.#context.channel, [attempt.lease]);
    } catch {
      // A closing channel has already revoked this exact lease.
    }
    attempt.status = 'retired';
    this.#attemptsById.delete(attempt.attempt.rendezvousId);
  }

  #revokePublishedHandle(reason: Error): void {
    const record = this.#publication;
    if (!record?.handleId) return;
    try {
      this.#responder.revokeHandle(
        this.#context.connectionToken,
        record.handleId,
        record.publication.asset.binding.sourceIdentity,
        reason,
      );
    } catch {
      // Responder close remains the terminal ownership fence.
    }
  }

  #retireWarmSourceOffer(
    record: WarmSourceOfferRecord,
    reason: Error,
    notifyGuest = true,
  ): boolean {
    if (record.status === 'retired' || record.status === 'transferred') return false;
    const timer = record.expiryTimer;
    record.expiryTimer = null;
    record.status = 'retired';
    if (this.#warmOffer === record) this.#warmOffer = null;
    if (timer !== null) {
      try {
        this.#runtime.cancelTimeout(timer);
      } catch {
        // The exact offer is already fenced; remaining cleanup must still run.
      }
    }
    record.controller.abort(reason);

    if (notifyGuest && record.offerSent && !record.offerRevokeSent) {
      record.offerRevokeSent = true;
      const offer = record.offer;
      const revoke = createFileMediaSourceRevokeV2({
        sessionId: offer.sessionId,
        connectionId: offer.connectionId,
        prepareId: offer.prepareId,
        prepareRevision: offer.prepareRevision,
        queueItemId: offer.queueItemId,
        sourceIdentity: offer.sourceIdentity,
        transferSessionId: offer.transferSessionId,
      });
      try {
        this.#sendRequiredFrame(revoke);
      } catch {
        // Required-send failure already fail-closed this exact connection owner.
      }
    }
    try {
      this.#responder.revokeHandle(
        this.#context.connectionToken,
        record.handleId,
        record.authority.asset.binding.sourceIdentity,
        reason,
      );
    } catch {
      // Responder close remains the terminal ownership fence.
    }
    return true;
  }

  #expireWarmSourceOffer(record: WarmSourceOfferRecord): void {
    if (this.#closed || this.#warmOffer !== record || record.status !== 'offered') return;
    this.#retireWarmSourceOffer(record, new Error('Host warm source offer expired'));
  }

  #expireWarmSourceOfferIfNeeded(): boolean {
    const record = this.#warmOffer;
    if (
      !record ||
      record.status !== 'offered' ||
      record.offer.expiresAtRoomTimeMs > this.#nowRoomTimeMs()
    ) {
      return false;
    }
    this.#expireWarmSourceOffer(record);
    return true;
  }

  #retirePreparedCandidate(reason: Error, notifyGuest = true): boolean {
    const record = this.#candidate;
    if (!record) return false;
    const stateLease = record.stateLease;
    const offerSendWasAmbiguous =
      notifyGuest && stateLease === null && record.status === 'offering' && record.offerSent;
    if (
      notifyGuest &&
      stateLease === null &&
      record.status === 'offered' &&
      record.offerSent &&
      !record.offerRevokeSent
    ) {
      record.offerRevokeSent = true;
      const offer = record.offer;
      const revoke = createFileMediaSourceRevokeV2({
        sessionId: offer.sessionId,
        connectionId: offer.connectionId,
        prepareId: offer.prepareId,
        prepareRevision: offer.prepareRevision,
        queueItemId: offer.queueItemId,
        sourceIdentity: offer.sourceIdentity,
        transferSessionId: offer.transferSessionId,
      });
      try {
        this.#sendRequiredFrame(revoke);
      } catch {
        // Required-send failure already fail-closed and retired this exact owner.
      }
      if (this.#candidate !== record) return stateLease !== null;
    }
    record.rejectReady(reason);
    if (this.#attempt?.preparedRecord === record) this.#retireAttempt(reason);
    if (record.handleId) {
      try {
        this.#responder.revokeHandle(
          this.#context.connectionToken,
          record.handleId,
          record.prepared.asset.binding.sourceIdentity,
          reason,
        );
      } catch {
        // Responder close remains the terminal ownership fence.
      }
    }
    if (stateLease) {
      try {
        Reflect.apply(trustedChannelRetireMedia, this.#context.channel, [stateLease]);
      } catch {
        // A closing channel has already revoked this exact lease.
      }
    }
    record.status = 'retired';
    this.#candidate = null;
    return stateLease !== null || offerSendWasAmbiguous;
  }

  #enqueueMediaLane<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#mediaLane.catch(() => undefined);
    const task = predecessor.then(operation);
    this.#mediaLane = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  #candidateSignal(epoch: number): AbortSignal {
    if (this.#closed || this.#candidateEpoch !== epoch) {
      const stale = new AbortController();
      stale.abort(new Error('Host prepared publication is stale'));
      return stale.signal;
    }
    return this.#candidateController.signal;
  }

  #requireWarmSourceOfferAuthority(
    authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>,
  ): HostLocalTrackSourceLease {
    const asset = authority?.asset;
    const binding = asset?.binding;
    const metadata = asset?.metadata;
    const sourceLease = authority?.sourceLease;
    if (
      !authority ||
      typeof authority !== 'object' ||
      authority.schemaVersion !== 1 ||
      authority.status !== 'warmed' ||
      authority.backend !== 'bounded-stream' ||
      !Number.isSafeInteger(authority.roomGeneration) ||
      authority.roomGeneration <= 0 ||
      authority.applicationSessionId !== this.#context.sessionId ||
      authority.hostParticipantId !== this.#context.hostParticipantId ||
      sourceLease === null ||
      typeof sourceLease !== 'object' ||
      !asset ||
      typeof asset !== 'object' ||
      !binding ||
      typeof binding !== 'object' ||
      typeof binding.queueItemId !== 'string' ||
      typeof binding.sourceIdentity !== 'string' ||
      typeof binding.transferSessionId !== 'string' ||
      !metadata ||
      typeof metadata !== 'object' ||
      typeof metadata.name !== 'string' ||
      typeof metadata.mime !== 'string' ||
      !Number.isSafeInteger(asset.encodedSize) ||
      asset.encodedSize < 0
    ) {
      throw new TypeError('Host warm source offer authority is invalid');
    }
    return sourceLease;
  }

  #sameWarmSourceOfferBinding(
    left: Readonly<FilePlaybackProductHostLocalTrackWarmResult>,
    right: Readonly<FilePlaybackProductHostLocalTrackWarmResult>,
  ): boolean {
    return (
      left.schemaVersion === right.schemaVersion &&
      left.roomGeneration === right.roomGeneration &&
      left.applicationSessionId === right.applicationSessionId &&
      left.hostParticipantId === right.hostParticipantId &&
      left.status === right.status &&
      left.backend === right.backend &&
      left.asset.kind === right.asset.kind &&
      left.asset.binding.queueItemId === right.asset.binding.queueItemId &&
      left.asset.binding.sourceIdentity === right.asset.binding.sourceIdentity &&
      left.asset.binding.transferSessionId === right.asset.binding.transferSessionId &&
      left.asset.metadata.name === right.asset.metadata.name &&
      left.asset.metadata.mime === right.asset.metadata.mime &&
      left.asset.encodedSize === right.asset.encodedSize
    );
  }

  #assertWarmSourceOfferTask(
    authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>,
    sourceLease: HostLocalTrackSourceLease,
    epoch: number,
    controller: AbortController,
  ): void {
    this.#assertConnection();
    if (
      this.#warmOfferEpoch !== epoch ||
      this.#warmOfferTaskAuthority !== authority ||
      this.#warmOfferTaskController !== controller ||
      controller.signal.aborted ||
      this.#requireWarmSourceOfferAuthority(authority) !== sourceLease
    ) {
      throw new Error('Host warm source offer authority is stale');
    }
  }

  #assertWarmSourceOfferRecord(record: WarmSourceOfferRecord): void {
    this.#assertConnection();
    if (
      this.#warmOffer !== record ||
      (record.status !== 'offering' && record.status !== 'offered') ||
      record.controller.signal.aborted ||
      this.#requireWarmSourceOfferAuthority(record.authority) !== record.sourceLease
    ) {
      throw new Error('Host warm source offer was superseded');
    }
  }

  #assertPreparedCandidateAuthority(
    prepared: Readonly<HostPreparedLocalTrack>,
    epoch: number,
  ): void {
    this.#assertConnection();
    if (
      this.#candidateEpoch !== epoch ||
      !prepared ||
      typeof prepared !== 'object' ||
      prepared.schemaVersion !== 1 ||
      !Number.isSafeInteger(prepared.roomGeneration) ||
      prepared.roomGeneration <= 0 ||
      (prepared.backend !== 'audio-buffer' && prepared.backend !== 'bounded-stream')
    ) {
      throw new Error('Host prepared publication authority is stale');
    }
  }

  #assertCandidateRecord(record: PreparedPublicationRecord): void {
    this.#assertPreparedCandidateAuthority(record.prepared, record.epoch);
    if (this.#candidate !== record || record.status === 'retired') {
      throw new Error('Host prepared publication was superseded');
    }
  }

  #publicationSignal(epoch: number): AbortSignal {
    if (this.#closed || this.#publicationEpoch !== epoch) {
      const stale = new AbortController();
      stale.abort(new Error('Host media publication is stale'));
      return stale.signal;
    }
    return this.#publicationController.signal;
  }

  #assertPublicationAuthority(
    publication: Readonly<HostPeerPlaybackPublication>,
    epoch: number,
  ): void {
    this.#assertConnection();
    if (
      this.#publicationEpoch !== epoch ||
      this.#hostRoom.currentPeerPublication() !== publication
    ) {
      throw new Error('Host media publication authority is stale');
    }
  }

  #assertRecord(record: PublicationRecord): void {
    this.#assertPublicationAuthority(record.publication, record.epoch);
    if (this.#publication !== record) throw new Error('Host media publication was superseded');
  }

  #assertConnection(): void {
    if (
      this.#closed ||
      Reflect.apply(trustedChannelClosed, this.#context.channel, []) ||
      Reflect.apply(trustedChannelToken, this.#context.channel, []) !==
        this.#context.connectionToken
    ) {
      throw new Error('Host media owner connection authority is stale');
    }
  }

  #assertEventConnection(event: ExactRecord): void {
    this.#assertConnection();
    if (
      event.connection !== this.#context.connection ||
      event.channel !== this.#context.channel ||
      (Object.hasOwn(event, 'connectionToken') &&
        event.connectionToken !== this.#context.connectionToken)
    ) {
      throw new Error('Host media owner event connection is stale');
    }
  }

  #assertMessagePublication(
    message: FilePlaybackWireAdoptionEvent['message'],
    publication: Readonly<HostPeerPlaybackPublication>,
  ): void {
    this.#assertMessageState(
      message,
      publication.state,
      publication.asset.binding.sourceIdentity,
      publication.asset.binding.transferSessionId,
    );
  }

  #assertMessageState(
    message: FilePlaybackWireAdoptionEvent['message'],
    state: Readonly<HostPreparedLocalTrack['state']>,
    sourceIdentity: string,
    transferSessionId: string,
  ): void {
    if (
      message.sessionId !== this.#context.sessionId ||
      message.connectionId !== this.#context.connectionId ||
      message.senderParticipantId !== this.#context.guestParticipantId ||
      message.recipientParticipantId !== this.#context.hostParticipantId ||
      message.queueItemId !== state.queueItemId ||
      message.runId !== state.runId ||
      message.revision !== state.revision ||
      message.sourceIdentity !== sourceIdentity ||
      message.transferSessionId !== transferSessionId
    ) {
      throw new Error('Host media wire does not match the current publication');
    }
  }

  #assertTimelineMatchesPrepared(
    update: Readonly<FilePlaybackTimelineUpdateV2>,
    prepared: Readonly<HostPreparedLocalTrack>,
  ): void {
    if (
      update.sessionId !== this.#context.sessionId ||
      update.connectionId !== this.#context.connectionId ||
      update.roomGeneration !== prepared.roomGeneration ||
      update.phase !== 'playing' ||
      update.queueItemId !== prepared.state.queueItemId ||
      update.runId !== prepared.state.runId ||
      update.revision !== prepared.state.revision ||
      update.positionSeconds !== prepared.positionSeconds ||
      update.rate !== prepared.playbackRate
    ) {
      throw new Error('Host committed timeline does not match the exact prepared candidate');
    }
  }

  #sendRequiredFrame(frame: unknown): void {
    this.#assertConnection();
    let sent: boolean;
    try {
      sent = this.#sendRequired(this.#context.connection, frame);
    } catch (error) {
      throw this.#failConnection(error);
    }
    if (!sent) {
      throw this.#failConnection(new Error('Host required media frame send failed'));
    }
  }

  #nextPrepareRevision(): number {
    if (this.#prepareRevision >= Number.MAX_SAFE_INTEGER) {
      throw this.#failConnection(new Error('Host media prepare revision exhausted'));
    }
    this.#prepareRevision += 1;
    return this.#prepareRevision;
  }

  #freshMediaId(excluded: readonly string[]): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#runtime.createMediaId();
      if (typeof id === 'string' && !excluded.includes(id) && !this.#issuedMediaIds.has(id)) {
        this.#issuedMediaIds.add(id);
        return id;
      }
    }
    throw new Error('Host media owner could not create a distinct media ID');
  }

  #nowRoomTimeMs(): number {
    const now = Reflect.apply(trustedChannelNow, this.#context.channel, []);
    if (!Number.isFinite(now) || now < 0) throw new Error('Host media room clock is invalid');
    return now;
  }
}
