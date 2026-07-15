import type {
  FilePlaybackPeerRangeAdoptionEvent,
  FilePlaybackWireAdoptionEvent,
} from '../network/file-playback-application-session.ts';
import type { FilePlaybackApplicationControllerConnectionSnapshot } from './file-playback-application-controller.ts';
import { FilePlaybackConnectionChannel } from '../network/file-playback-connection-channel.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import type { DataConnection } from '../types/index.ts';
import {
  acquireFilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleLease,
} from './diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import { confirmFilePlaybackUniversalLifecycleRetirement } from './diagnostics/file-playback-universal-lifecycle-retirement.ts';
import {
  createFileMediaPrepareId,
  createPeerRangeFileMediaSourceOfferV2,
  createPeerRangeManifestFileMediaSourceOfferV2,
  createR2WholeBlobFileMediaSourceOfferV2,
  derivePeerRangeManifestBundleSize,
  type AnyPeerRangeFileMediaSourceOfferV2,
  type FileMediaSourceOfferV2,
} from './file-media-source-offer.ts';
import { createFileMediaSourceRevokeV2 } from './file-media-source-revoke.ts';
import {
  isFilePlaybackPeerRangeManifestCodecEnabled,
  snapshotFilePlaybackBoundedRoutePolicy,
  type FilePlaybackBoundedRoutePolicy,
} from './file-playback-bounded-route-policy.ts';
import type {
  HostPreparedLocalTrack,
  HostPreparedRemoteParticipant,
  HostCurrentPlaybackTimelineCommittedEvent,
  HostCurrentPlaybackTransitionScheduledEvent,
  HostRemoteEndRequiredEvent,
  HostLocalTrackSourceLease,
  HostPeerPlaybackAssetPublication,
  HostPeerPlaybackPublication,
  HostPeerRangeManifestPublication,
  HostPeerRangeSource,
  HostRemoteRecoveryCommit,
  RecoverHostRemoteParticipantOptions,
  ResolvePreparedHostPeerRangeSourceOptions,
  ResolveHostPeerRangeSourceOptions,
  ResolveWarmHostPeerRangeSourceOptions,
} from './file-playback-host-first-file-engine.ts';
import { readPlaybackStateIdentity, type PlaybackStateIdentity } from './playback-identity.ts';
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
  'boundedRoutePolicy',
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
    key !== 'boundedRoutePolicy' &&
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
const ACTIVATE_PREPARED_KEYS = Object.freeze([
  'initialCohortAdmitted',
  'prepared',
  'timeline',
] as const);
const CURRENT_TRANSITION_SCHEDULED_KEYS = Object.freeze([
  'schemaVersion',
  'roomGeneration',
  'kind',
  'from',
  'to',
  'atRoomTimeMs',
  'positionSeconds',
] as const);
const REMOTE_END_REQUIRED_KEYS = Object.freeze([
  'schemaVersion',
  'roomGeneration',
  'from',
  'to',
  'hostObservedAtRoomTimeMs',
] as const);
const CURRENT_TIMELINE_COMMITTED_KEYS = Object.freeze([
  'schemaVersion',
  'roomGeneration',
  'kind',
  'previous',
  'timeline',
] as const);
const PEER_RANGE_MANIFEST_KEYS = Object.freeze([
  'codec',
  'manifestByteLength',
  'manifestSha256B64',
] as const);
const SHA_256_BYTES = 32;
const SHA_256_BASE64_LENGTH = 44;
export const FILE_PLAYBACK_PRODUCT_PEER_RANGE_BUFFERED_AMOUNT_LIMIT = 256 * 1024;
export const FILE_PLAYBACK_PRODUCT_OFFER_LIFETIME_MS = 15 * 60 * 1_000;
const HEALTH_LEASE_MS = 2_000;
const HEALTH_TICK_MS = 250;
const HOST_REMOTE_ARM_P95_FLOOR_MS = 500;

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
  /** Fixed for this connection owner and canonicalized before any publication work. */
  readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
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
  readonly offer: Readonly<AnyPeerRangeFileMediaSourceOfferV2>;
}

export interface ActivateFilePlaybackProductHostPreparedOptions {
  /** Frozen by the runtime at the exact initial cohort admission boundary. */
  readonly initialCohortAdmitted: boolean;
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

interface PeerRangeOfferPlan {
  /** Null means the exact direct peer-range route; non-null is an engine-issued selector. */
  readonly peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null;
  /** Direct media bytes or the exact `[manifest][media]` bundle bytes exposed by the responder. */
  readonly expectedSourceSize: number;
}

interface PublicationRecord {
  readonly epoch: number;
  publication: Readonly<HostPeerPlaybackPublication>;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  stateLease: FilePlaybackWireStateLease;
  readonly handleId: string | null;
  readonly peerRangeOfferPlan: Readonly<PeerRangeOfferPlan> | null;
  commit: Readonly<FilePlaybackProductHostPublicationCommit>;
  readonly transferredWarmSource: WarmSourceOfferRecord | null;
  participant: RemoteRendezvousParticipant | null;
  pendingTimelineUpdate: Readonly<FilePlaybackTimelineUpdateV2> | null;
  status: 'publishing' | 'published';
}

interface CurrentTransitionRecord {
  readonly kind: HostCurrentPlaybackTimelineCommittedEvent['kind'];
  readonly from: Readonly<PlaybackStateIdentity>;
  readonly to: Readonly<PlaybackStateIdentity>;
  readonly atRoomTimeMs: number;
  readonly positionSeconds: number | null;
  readonly publication: PublicationRecord;
  readonly previousTimeline: Readonly<PlaybackTimelineSnapshot>;
  readonly stateLease: FilePlaybackWireStateLease;
}

interface CandidateSourceRecord {
  readonly prepared: Readonly<HostPreparedLocalTrack>;
  readonly resolve: NonNullable<
    FilePlaybackProductHostMediaOwnerOptions['resolvePreparedPeerRangeSource']
  >;
}

interface PreparedPublicationRecord {
  readonly mode: 'source' | 'same-run-state';
  readonly epoch: number;
  readonly prepared: Readonly<HostPreparedLocalTrack>;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  stateLease: FilePlaybackWireStateLease | null;
  readonly handleId: string | null;
  readonly peerRangeOfferPlan: Readonly<PeerRangeOfferPlan> | null;
  readonly source: CandidateSourceRecord | null;
  readonly commit: Readonly<FilePlaybackProductHostPreparedPublicationCommit>;
  readonly transferredWarmSource: WarmSourceOfferRecord | null;
  readonly ready: Promise<Readonly<HostPreparedRemoteParticipant>>;
  readonly resolveReady: (value: Readonly<HostPreparedRemoteParticipant>) => void;
  readonly rejectReady: (error: Error) => void;
  participant: RemoteRendezvousParticipant | null;
  capability: Readonly<HostPreparedRemoteParticipant> | null;
  failure: Error | null;
  attemptFailure: Error | null;
  awaitingAttemptRecoveryReady: boolean;
  attemptRecoveryReady: boolean;
  offerSent: boolean;
  offerRevokeSent: boolean;
  status: 'offering' | 'offered' | 'binding' | 'published' | 'activated' | 'retired';
}

/** Independent offer-only authority: it never owns prepared/run/wire state. */
interface WarmSourceOfferRecord {
  readonly epoch: number;
  readonly authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>;
  readonly sourceLease: HostLocalTrackSourceLease;
  readonly offer: Readonly<AnyPeerRangeFileMediaSourceOfferV2>;
  readonly handleId: string;
  readonly peerRangeOfferPlan: Readonly<PeerRangeOfferPlan>;
  readonly resolve: NonNullable<
    FilePlaybackProductHostMediaOwnerOptions['resolveWarmPeerRangeSource']
  >;
  readonly controller: AbortController;
  readonly commit: Readonly<FilePlaybackProductHostSourceLeasePublicationCommit>;
  expiryTimer: TimerHandle | null;
  expiryTimerLifecycleLease: FilePlaybackUniversalLifecycleLease | null;
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
  publicationEpoch: number;
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
  cancelling: boolean;
  cancelDispatch: Promise<void> | null;
  cancelRetirement: Promise<void> | null;
  cancelDispatchSucceeded: boolean;
  outcome: 'pending' | 'succeeded' | 'failed';
  stateCommitted: boolean;
  status: 'candidate' | 'current' | 'retired';
}

function hasPreparedSourceAuthority(record: PreparedPublicationRecord): boolean {
  return (
    record.mode === 'source' &&
    record.source !== null &&
    (record.status === 'offering' ||
      record.status === 'offered' ||
      record.status === 'binding' ||
      record.status === 'published')
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
const trustedChannelCommitStop = FilePlaybackConnectionChannel.prototype.commitStop;
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

function isCanonicalSha256Base64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== SHA_256_BASE64_LENGTH) return false;
  try {
    const decoded = atob(value);
    return decoded.length === SHA_256_BYTES && btoa(decoded) === value;
  } catch {
    return false;
  }
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

function isAnyPeerRangeOffer(
  offer: Readonly<FileMediaSourceOfferV2>,
): offer is Readonly<AnyPeerRangeFileMediaSourceOfferV2> {
  return offer.transport === 'peer-range' || offer.transport === 'peer-range-manifest';
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
  readonly #lifecycleLease: FilePlaybackUniversalLifecycleLease;
  readonly #boundedRoutePolicy: Readonly<FilePlaybackBoundedRoutePolicy>;
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
  readonly #healthTimerLifecycleLease: FilePlaybackUniversalLifecycleLease;
  #publicationEpoch = 0;
  #publicationController = new AbortController();
  #prepareRevision = 0;
  #wireBootstrapped = false;
  #publication: PublicationRecord | null = null;
  #publicationTask: Promise<Readonly<FilePlaybackProductHostPublicationCommit>> | null = null;
  #publicationTaskIdentity: Readonly<HostPeerPlaybackPublication> | null = null;
  #currentTransition: CurrentTransitionRecord | null = null;
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
  #recoveryAuthority: object | null = null;
  #closed = false;
  #fatal = false;

  constructor(options: FilePlaybackProductHostMediaOwnerOptions) {
    const input = snapshotOptions(options);
    const context = snapshotExactRecord(input?.context, CONTEXT_KEYS);
    const runtime = runtimeSnapshot(input?.runtimeForTests);
    let boundedRoutePolicy: Readonly<FilePlaybackBoundedRoutePolicy> | null = null;
    try {
      if (input) {
        boundedRoutePolicy = snapshotFilePlaybackBoundedRoutePolicy(input.boundedRoutePolicy);
      }
    } catch {
      // Fold an invalid policy into the constructor's single fail-closed options error.
    }
    if (
      !input ||
      !context ||
      !runtime ||
      !boundedRoutePolicy ||
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

    this.#boundedRoutePolicy = boundedRoutePolicy;
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
    const healthTimerLifecycleLease = acquireFilePlaybackUniversalLifecycleLease('timers');
    try {
      this.#healthTimer = this.#runtime.scheduleInterval(() => this.#tickHealth(), HEALTH_TICK_MS);
    } catch (error) {
      healthTimerLifecycleLease.beginRetire().release();
      void this.#responder.close(error);
      throw error;
    }
    this.#healthTimerLifecycleLease = healthTimerLifecycleLease;
    try {
      this.#lifecycleLease = acquireFilePlaybackUniversalLifecycleLease('connectionOwners');
    } catch (error) {
      try {
        this.#runtime.cancelInterval(this.#healthTimer);
        this.#healthTimerLifecycleLease.beginRetire().release();
      } catch {
        this.#healthTimerLifecycleLease.forceUnconfirmed();
      }
      void this.#responder.close(error);
      throw error;
    }
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
    if (this.#publication?.pendingTimelineUpdate) {
      return Promise.reject(
        this.#failConnection(
          new Error('Host cannot replace a peer before its prior timeline update commits'),
        ),
      );
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
      if (this.#publication?.pendingTimelineUpdate) {
        throw this.#failConnection(
          new Error('Host cannot replace a peer before its prior timeline update commits'),
        );
      }
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

  /**
   * Stages one exact same-source successor and publishes its physical command.
   * This boundary is deliberately synchronous: the successor wire must enter
   * the ordered connection lane after the host renderer accepted scheduling,
   * but before canonical timeline truth can be published.
   */
  stageCurrentTransition(value: Readonly<HostCurrentPlaybackTransitionScheduledEvent>): void {
    try {
      const event = snapshotExactRecord(value, CURRENT_TRANSITION_SCHEDULED_KEYS);
      const from = event ? readPlaybackStateIdentity(event.from) : null;
      const to = event ? readPlaybackStateIdentity(event.to) : null;
      const kind = event?.kind;
      const atRoomTimeMs = event?.atRoomTimeMs;
      const positionSeconds = event?.positionSeconds;
      const publication = this.#publication;
      if (
        !event ||
        event.schemaVersion !== 1 ||
        event.roomGeneration !== publication?.publication.roomGeneration ||
        (kind !== 'pause' && kind !== 'seek' && kind !== 'stop') ||
        !from ||
        !to ||
        !Number.isFinite(atRoomTimeMs) ||
        (atRoomTimeMs as number) < 0 ||
        (kind === 'seek' &&
          (!Number.isFinite(positionSeconds) || (positionSeconds as number) < 0)) ||
        (kind !== 'seek' && positionSeconds !== null) ||
        this.#closed ||
        this.#currentTransition !== null ||
        !publication ||
        publication.status !== 'published' ||
        publication.pendingTimelineUpdate !== null ||
        publication.publication.roomGeneration !== event.roomGeneration ||
        publication.publication.state.queueItemId !== from.queueItemId ||
        publication.publication.state.runId !== from.runId ||
        publication.publication.state.revision !== from.revision ||
        to.queueItemId !== from.queueItemId ||
        to.runId !== from.runId ||
        to.revision !== from.revision + 1
      ) {
        throw new Error('Host current transition schedule authority is invalid');
      }

      const stateLease = Reflect.apply(trustedChannelStageMedia, this.#context.channel, [
        freezeCanonical({
          run: to,
          sourceIdentity: publication.publication.asset.binding.sourceIdentity,
          transferSessionId: publication.publication.asset.binding.transferSessionId,
        }),
      ]) as FilePlaybackWireStateLease;
      const transition: CurrentTransitionRecord = {
        kind,
        from,
        to,
        atRoomTimeMs: atRoomTimeMs as number,
        positionSeconds: positionSeconds as number | null,
        publication,
        previousTimeline: publication.publication.timeline,
        stateLease,
      };
      this.#currentTransition = transition;
      this.#retireAttempt(new Error('Host current state transition superseded its rendezvous'));

      const common = {
        expectedQueueItemId: from.queueItemId,
        expectedRunId: from.runId,
        expectedRevision: from.revision,
        atRoomTimeMs: transition.atRoomTimeMs,
      } as const;
      const sent =
        kind === 'pause'
          ? this.#sendWire(this.#context.connection, stateLease, {
              kind: 'file-playback-pause',
              ...common,
            })
          : kind === 'seek'
            ? this.#sendWire(this.#context.connection, stateLease, {
                kind: 'file-playback-seek',
                ...common,
                positionSeconds: transition.positionSeconds as number,
              })
            : this.#sendWire(this.#context.connection, stateLease, {
                kind: 'file-playback-stop',
                ...common,
              });
      if (!sent) throw new Error('Host current transition wire send failed');
      if (this.#currentTransition !== transition || this.#closed) {
        throw new Error('Host current transition changed during wire send');
      }
    } catch (error) {
      throw this.#failConnection(error);
    }
  }

  /**
   * Stages the dedicated natural-end successor after host physical end
   * evidence, but before the host publishes canonical stopped truth.
   */
  stageRemoteEnd(value: Readonly<HostRemoteEndRequiredEvent>): void {
    try {
      const event = snapshotExactRecord(value, REMOTE_END_REQUIRED_KEYS);
      const from = event ? readPlaybackStateIdentity(event.from) : null;
      const to = event ? readPlaybackStateIdentity(event.to) : null;
      const hostObservedAtRoomTimeMs = event?.hostObservedAtRoomTimeMs;
      const publication = this.#publication;
      if (
        !event ||
        event.schemaVersion !== 1 ||
        event.roomGeneration !== publication?.publication.roomGeneration ||
        !from ||
        !to ||
        !Number.isFinite(hostObservedAtRoomTimeMs) ||
        (hostObservedAtRoomTimeMs as number) < 0 ||
        this.#closed ||
        this.#currentTransition !== null ||
        !publication ||
        publication.status !== 'published' ||
        publication.pendingTimelineUpdate !== null ||
        publication.publication.state.queueItemId !== from.queueItemId ||
        publication.publication.state.runId !== from.runId ||
        publication.publication.state.revision !== from.revision ||
        to.queueItemId !== from.queueItemId ||
        to.runId !== from.runId ||
        to.revision !== from.revision + 1
      ) {
        throw new Error('Host remote-end successor authority is invalid');
      }

      const stateLease = Reflect.apply(trustedChannelStageMedia, this.#context.channel, [
        freezeCanonical({
          run: to,
          sourceIdentity: publication.publication.asset.binding.sourceIdentity,
          transferSessionId: publication.publication.asset.binding.transferSessionId,
        }),
      ]) as FilePlaybackWireStateLease;
      const transition: CurrentTransitionRecord = {
        kind: 'ended',
        from,
        to,
        atRoomTimeMs: hostObservedAtRoomTimeMs as number,
        positionSeconds: null,
        publication,
        previousTimeline: publication.publication.timeline,
        stateLease,
      };
      this.#currentTransition = transition;
      this.#retireAttempt(new Error('Host natural end superseded its rendezvous'));

      const sent = this.#sendWire(this.#context.connection, stateLease, {
        kind: 'file-playback-ended',
        expectedQueueItemId: from.queueItemId,
        expectedRunId: from.runId,
        expectedRevision: from.revision,
        hostObservedAtRoomTimeMs: transition.atRoomTimeMs,
      });
      if (!sent) throw new Error('Host remote-end wire send failed');
      if (this.#currentTransition !== transition || this.#closed) {
        throw new Error('Host remote-end successor changed during wire send');
      }
    } catch (error) {
      throw this.#failConnection(error);
    }
  }

  /** Commits the staged successor, then publishes exact canonical timeline truth. */
  commitCurrentTimeline(value: Readonly<HostCurrentPlaybackTimelineCommittedEvent>): void {
    try {
      const event = snapshotExactRecord(value, CURRENT_TIMELINE_COMMITTED_KEYS);
      const transition = this.#currentTransition;
      if (
        !event ||
        event.schemaVersion !== 1 ||
        event.roomGeneration !== transition?.publication.publication.roomGeneration ||
        !transition ||
        event.kind !== transition.kind ||
        event.previous !== transition.previousTimeline ||
        !event.timeline ||
        typeof event.timeline !== 'object'
      ) {
        throw new Error('Host current timeline commit authority is invalid');
      }
      const timeline = event.timeline as Readonly<PlaybackTimelineSnapshot>;
      const update = createFilePlaybackTimelineUpdateV2({
        sessionId: this.#context.sessionId,
        connectionId: this.#context.connectionId,
        roomGeneration: event.roomGeneration as number,
        timeline,
      });
      const committedTimeline = timelineFromFilePlaybackTimelineUpdateV2(update);
      const timelineState = committedTimeline?.run
        ? readPlaybackStateIdentity({
            queueItemId: committedTimeline.run.queueItemId,
            runId: committedTimeline.run.runId,
            revision: committedTimeline.revision,
          })
        : null;
      if (
        !committedTimeline ||
        committedTimeline.revision !== transition.to.revision ||
        (transition.kind === 'stop' || transition.kind === 'ended'
          ? committedTimeline.phase !== 'stopped' || committedTimeline.run !== null
          : !timelineState ||
            timelineState.queueItemId !== transition.to.queueItemId ||
            timelineState.runId !== transition.to.runId ||
            timelineState.revision !== transition.to.revision ||
            committedTimeline.phase !== 'paused' ||
            (transition.kind === 'seek' &&
              committedTimeline.positionSeconds !== transition.positionSeconds))
      ) {
        throw new Error('Host committed timeline does not match its staged transition');
      }
      if (this.#publication !== transition.publication || this.#closed) {
        throw new Error('Host current transition publication became stale');
      }

      if (transition.kind === 'stop' || transition.kind === 'ended') {
        if (this.#hostRoom.currentPeerPublication() !== null) {
          throw new Error('Host stopped transition retained a current peer publication');
        }
        Reflect.apply(trustedChannelCommitStop, this.#context.channel, [
          transition.stateLease,
          transition.from,
        ]);
        this.#sendRequiredFrame(update);
        this.#revokePublishedHandle(new Error('Host current publication stopped'));
        this.#publicationEpoch += 1;
        this.#publicationController.abort(new Error('Host current publication stopped'));
        this.#publicationController = new AbortController();
        this.#publication = null;
        this.#currentTransition = null;
        return;
      }

      const current = this.#hostRoom.currentPeerPublication();
      if (
        !current ||
        current.timeline !== event.timeline ||
        current.roomGeneration !== event.roomGeneration ||
        current.state.queueItemId !== transition.to.queueItemId ||
        current.state.runId !== transition.to.runId ||
        current.state.revision !== transition.to.revision ||
        current.backend !== transition.publication.publication.backend ||
        current.asset.binding.queueItemId !==
          transition.publication.publication.asset.binding.queueItemId ||
        current.asset.binding.sourceIdentity !==
          transition.publication.publication.asset.binding.sourceIdentity ||
        current.asset.binding.transferSessionId !==
          transition.publication.publication.asset.binding.transferSessionId
      ) {
        throw new Error('Host current peer publication does not match its staged transition');
      }
      Reflect.apply(trustedChannelCommitMedia, this.#context.channel, [transition.stateLease]);
      const commit = freezeCanonical({
        schemaVersion: 1 as const,
        publication: current,
        offer: transition.publication.offer,
        binding: transition.publication.binding,
      });
      transition.publication.publication = current;
      transition.publication.stateLease = transition.stateLease;
      transition.publication.commit = commit;
      transition.publication.pendingTimelineUpdate = update;
      this.#currentTransition = null;
      this.#sendPendingTimelineUpdate(transition.publication);
    } catch (error) {
      throw this.#failConnection(error);
    }
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
    if (this.#publication?.pendingTimelineUpdate) {
      return Promise.reject(
        this.#failConnection(
          new Error('Host cannot advance a peer before its prior timeline update commits'),
        ),
      );
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
      if (this.#publication?.pendingTimelineUpdate) {
        throw this.#failConnection(
          new Error('Host cannot advance a peer before its prior timeline update commits'),
        );
      }
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
    if (
      !input ||
      typeof input.initialCohortAdmitted !== 'boolean' ||
      !record ||
      input.prepared !== record.prepared
    ) {
      throw new Error('Host prepared activation authority is stale');
    }
    this.#assertCandidateRecord(record);
    const stateLease = record.stateLease;
    if (record.status !== 'published' || !stateLease) {
      throw new Error('Host prepared publication is not activatable');
    }
    const publication = this.#hostRoom.currentPeerPublication();
    const peerRangeOfferPlan =
      publication?.backend === 'bounded-stream'
        ? this.#createPeerRangeOfferPlan(publication.backend, publication.asset)
        : null;
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
      publication.asset.encodedSize !== record.prepared.asset.encodedSize ||
      !samePeerRangeManifestPublication(
        publication.asset.peerRangeManifest,
        record.prepared.asset.peerRangeManifest,
      )
    ) {
      throw new Error('Host room did not commit the exact prepared publication');
    }
    this.#assertSamePeerRangeOfferPlan(
      record.peerRangeOfferPlan,
      peerRangeOfferPlan,
      'Host committed publication changed its peer-range offer plan',
    );
    if (isAnyPeerRangeOffer(record.offer)) {
      if (!peerRangeOfferPlan) {
        throw new Error('Host committed publication lost its peer-range offer plan');
      }
      this.#assertPeerRangeOfferMatchesPlan(record.offer, peerRangeOfferPlan);
    } else if (peerRangeOfferPlan !== null) {
      throw new Error('Host committed publication changed its R2 offer plan');
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

    if (record.mode === 'same-run-state') {
      return this.#activateSameRunPrepared(
        record,
        publication,
        timeline,
        update,
        stateLease,
        input.initialCohortAdmitted as boolean,
      );
    }

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
      peerRangeOfferPlan,
      commit,
      transferredWarmSource: record.transferredWarmSource,
      participant: record.participant,
      pendingTimelineUpdate: update,
      status: 'published',
    };
    if (!record.capability) {
      record.rejectReady(new Error('Host committed before this remote candidate became ready'));
    }
    record.status = 'activated';
    this.#publication = publicationRecord;
    this.#candidate = null;
    this.#completePreparedActivation(
      record,
      publicationRecord,
      input.initialCohortAdmitted as boolean,
    );
    return commit;
  }

  #activateSameRunPrepared(
    record: PreparedPublicationRecord,
    publication: Readonly<HostPeerPlaybackPublication>,
    timeline: Readonly<PlaybackTimelineSnapshot>,
    update: Readonly<FilePlaybackTimelineUpdateV2>,
    stateLease: FilePlaybackWireStateLease,
    initialCohortAdmitted: boolean,
  ): Readonly<FilePlaybackProductHostPublicationCommit> {
    const current = this.#publication;
    if (
      !current ||
      current.status !== 'published' ||
      current.offer !== record.offer ||
      current.binding !== record.binding ||
      current.handleId !== record.handleId ||
      current.peerRangeOfferPlan !== record.peerRangeOfferPlan ||
      current.pendingTimelineUpdate !== null ||
      current.publication.state.queueItemId !== record.prepared.state.queueItemId ||
      current.publication.state.runId !== record.prepared.state.runId ||
      current.publication.state.revision + 1 !== record.prepared.state.revision
    ) {
      throw new Error('Host same-run activation changed its current source authority');
    }

    Reflect.apply(trustedChannelCommitMedia, this.#context.channel, [stateLease]);
    const commit = freezeCanonical({
      schemaVersion: 1 as const,
      publication,
      offer: current.offer,
      binding: current.binding,
    });
    current.publication = publication;
    current.stateLease = stateLease;
    current.commit = commit;
    current.participant = record.participant;
    current.pendingTimelineUpdate = update;
    this.#assertRecord(current);

    if (!record.capability) {
      record.rejectReady(new Error('Host committed before this remote state became ready'));
    }
    record.status = 'activated';
    this.#candidate = null;
    this.#completePreparedActivation(record, current, initialCohortAdmitted);
    if (timeline.revision !== publication.timeline.revision) {
      throw new Error('Host same-run activation changed its committed timeline');
    }
    return commit;
  }

  #completePreparedActivation(
    prepared: PreparedPublicationRecord,
    current: PublicationRecord,
    initialCohortAdmitted: boolean,
  ): void {
    const attempt = this.#attempt;
    const exactAttempt =
      attempt?.mode === 'prepared' && attempt.preparedRecord === prepared ? attempt : null;
    if (prepared.failure) throw this.#failConnection(prepared.failure);
    const exactAttemptUnavailable =
      exactAttempt !== null &&
      (exactAttempt.status === 'retired' || exactAttempt.outcome === 'failed');
    if (initialCohortAdmitted && (prepared.attemptFailure || exactAttemptUnavailable)) {
      if (!prepared.capability || !prepared.participant) {
        throw this.#failConnection(
          new Error('Host admitted peer lost its prepared recovery capability'),
        );
      }
      if (exactAttempt) this.#retireAttemptLease(exactAttempt);
      if (this.#attempt === exactAttempt) this.#attempt = null;
      // An exact CANCEL destroys the guest's one-shot physical cutover port.
      // Do not spend a new ARM deadline while that port is still retiring.
      // The guest re-stages from its retained asset and refreshes SOURCE_READY;
      // a refresh which raced activation is remembered on the prepared record.
      if (current.publication.timeline.phase === 'playing' && prepared.attemptRecoveryReady) {
        queueMicrotask(() => this.#beginRecovery(current));
      }
      return;
    }
    if (initialCohortAdmitted) {
      if (!prepared.capability || !exactAttempt) {
        throw this.#failConnection(
          new Error('Host admitted peer has no exact prepared rendezvous attempt'),
        );
      }
      exactAttempt.publicationEpoch = current.epoch;
      exactAttempt.stateCommitted = true;
      this.#settlePreparedAttempt(exactAttempt);
      return;
    }
    if (exactAttempt) {
      throw this.#failConnection(
        new Error('Host late-recovery peer unexpectedly owns an initial rendezvous attempt'),
      );
    }
    if (prepared.participant && current.publication.timeline.phase === 'playing') {
      queueMicrotask(() => this.#beginRecovery(current));
    }
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
    const peerRangeOfferPlan = this.#createPeerRangeOfferPlan(authority.backend, asset);
    const exactSource = await awaitWhileOwned(
      Promise.resolve().then(() =>
        resolve({
          sourceLease,
          sourceIdentity: asset.binding.sourceIdentity,
          peerRangeManifest: peerRangeOfferPlan.peerRangeManifest,
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
    await this.#assertResolvedPeerSource(
      exactSource,
      asset,
      peerRangeOfferPlan,
      'Host warm source changed its exact lease binding',
    );
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
      const base = {
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
      } as const;
      const manifest = peerRangeOfferPlan.peerRangeManifest;
      const offer = manifest
        ? createPeerRangeManifestFileMediaSourceOfferV2({
            ...base,
            manifestByteLength: manifest.manifestByteLength,
            manifestSha256B64: manifest.manifestSha256B64,
          })
        : createPeerRangeFileMediaSourceOfferV2(base);
      const commit = freezeCanonical({ schemaVersion: 1 as const, sourceLease, offer });
      const createdRecord: WarmSourceOfferRecord = {
        epoch,
        authority,
        sourceLease,
        offer,
        handleId,
        peerRangeOfferPlan,
        resolve,
        controller,
        commit,
        expiryTimer: null,
        expiryTimerLifecycleLease: null,
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
      const expiryTimerLifecycleLease = acquireFilePlaybackUniversalLifecycleLease('timers');
      createdRecord.expiryTimerLifecycleLease = expiryTimerLifecycleLease;
      try {
        const timer = this.#runtime.scheduleTimeout(() => {
          expiryCallbackRan = true;
          const timerLease = createdRecord.expiryTimerLifecycleLease;
          createdRecord.expiryTimerLifecycleLease = null;
          timerLease?.beginRetire().release();
          this.#expireWarmSourceOffer(createdRecord);
        }, FILE_PLAYBACK_PRODUCT_OFFER_LIFETIME_MS);
        if (expiryCallbackRan) {
          this.#runtime.cancelTimeout(timer);
          throw new Error('Host warm source offer expired while scheduling its lease');
        }
        createdRecord.expiryTimer = timer;
      } catch (error) {
        if (createdRecord.expiryTimerLifecycleLease === expiryTimerLifecycleLease) {
          createdRecord.expiryTimerLifecycleLease = null;
          expiryTimerLifecycleLease.beginRetire().release();
        }
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
    const peerRangeOfferPlan =
      publication.backend === 'bounded-stream'
        ? this.#createPeerRangeOfferPlan(publication.backend, publication.asset)
        : null;
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
            peerRangeManifest: peerRangeOfferPlan?.peerRangeManifest ?? null,
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
        if (
          handleId === null ||
          peerRangeExpiresAtRoomTimeMs === null ||
          peerRangeOfferPlan === null
        ) {
          throw new Error('Host peer-range offer plan is incomplete');
        }
        const peerBase = {
          ...base,
          prepareRevision,
          handleId,
          expiresAtRoomTimeMs: peerRangeExpiresAtRoomTimeMs,
        } as const;
        const manifest = peerRangeOfferPlan.peerRangeManifest;
        offer = manifest
          ? createPeerRangeManifestFileMediaSourceOfferV2({
              ...peerBase,
              manifestByteLength: manifest.manifestByteLength,
              manifestSha256B64: manifest.manifestSha256B64,
            })
          : createPeerRangeFileMediaSourceOfferV2(peerBase);
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
        peerRangeOfferPlan,
        commit,
        transferredWarmSource: null,
        participant: null,
        pendingTimelineUpdate: null,
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
    const current = this.#sameRunCurrentPublication(prepared);
    if (current) return this.#createSameRunPreparedPublication(prepared, current, epoch);
    const peerRangeOfferPlan =
      prepared.backend === 'bounded-stream'
        ? this.#createPeerRangeOfferPlan(prepared.backend, prepared.asset)
        : null;
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
          peerRangeManifest: peerRangeOfferPlan?.peerRangeManifest ?? null,
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
    await this.#assertResolvedPeerSource(
      exactSource,
      prepared.asset,
      peerRangeOfferPlan,
      'Host prepared source changed its exact candidate binding',
    );

    let exactSourceClosed = false;
    if (warmAtStart && this.#canTransferWarmSourceToPrepared(prepared, warmAtStart)) {
      if (isEncodedSource(exactSource)) {
        await exactSource.close();
        exactSourceClosed = true;
      }
      this.#assertPreparedCandidateAuthority(prepared, epoch);
      if (this.#canTransferWarmSourceToPrepared(prepared, warmAtStart)) {
        if (!peerRangeOfferPlan) {
          throw new Error('Host prepared peer-range offer plan is unavailable');
        }
        return this.#transferWarmSourceToPrepared(
          prepared,
          epoch,
          warmAtStart,
          resolve,
          peerRangeOfferPlan,
        );
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
        if (
          handleId === null ||
          peerRangeExpiresAtRoomTimeMs === null ||
          peerRangeOfferPlan === null
        ) {
          throw new Error('Host prepared peer-range offer plan is incomplete');
        }
        const peerBase = {
          ...base,
          prepareRevision,
          handleId,
          expiresAtRoomTimeMs: peerRangeExpiresAtRoomTimeMs,
        } as const;
        const manifest = peerRangeOfferPlan.peerRangeManifest;
        offer = manifest
          ? createPeerRangeManifestFileMediaSourceOfferV2({
              ...peerBase,
              manifestByteLength: manifest.manifestByteLength,
              manifestSha256B64: manifest.manifestSha256B64,
            })
          : createPeerRangeFileMediaSourceOfferV2(peerBase);
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
        peerRangeOfferPlan,
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
      peerRangeOfferPlan: Readonly<PeerRangeOfferPlan> | null;
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
      mode: 'source',
      epoch: options.epoch,
      prepared: options.prepared,
      offer: options.offer,
      binding,
      stateLease: null,
      handleId: options.handleId,
      peerRangeOfferPlan: options.peerRangeOfferPlan,
      source: freezeCanonical({ prepared: options.prepared, resolve: options.resolve }),
      commit,
      transferredWarmSource: options.transferredWarmSource,
      ready: ready.promise,
      resolveReady: ready.resolve,
      rejectReady: ready.reject,
      participant: null,
      capability: null,
      failure: null,
      attemptFailure: null,
      awaitingAttemptRecoveryReady: false,
      attemptRecoveryReady: false,
      offerSent: options.offerSent,
      offerRevokeSent: false,
      status: options.status,
    };
  }

  #createSameRunPreparedPublication(
    prepared: Readonly<HostPreparedLocalTrack>,
    current: PublicationRecord,
    epoch: number,
  ): Readonly<FilePlaybackProductHostPreparedPublicationCommit> {
    this.#assertPreparedCandidateAuthority(prepared, epoch);
    if (this.#publication !== current || current.status !== 'published') {
      throw new Error('Host same-run publication authority is stale');
    }
    const ready = deferredReadyCapability();
    const commit = freezeCanonical({
      schemaVersion: 1 as const,
      prepared,
      offer: current.offer,
      binding: current.binding,
    });
    const record: PreparedPublicationRecord = {
      mode: 'same-run-state',
      epoch,
      prepared,
      offer: current.offer,
      binding: current.binding,
      stateLease: null,
      handleId: current.handleId,
      peerRangeOfferPlan: current.peerRangeOfferPlan,
      source: null,
      commit,
      transferredWarmSource: null,
      ready: ready.promise,
      resolveReady: ready.resolve,
      rejectReady: ready.reject,
      participant: null,
      capability: null,
      failure: null,
      attemptFailure: null,
      awaitingAttemptRecoveryReady: false,
      attemptRecoveryReady: false,
      offerSent: false,
      offerRevokeSent: false,
      status: 'offered',
    };
    this.#candidate = record;
    this.#assertCandidateRecord(record);
    return commit;
  }

  #sameRunCurrentPublication(prepared: Readonly<HostPreparedLocalTrack>): PublicationRecord | null {
    const current = this.#publication;
    const publication = current?.publication;
    const asset = publication?.asset;
    const preparedAsset = prepared.asset;
    if (
      !current ||
      current.status !== 'published' ||
      !publication ||
      !asset ||
      prepared.roomGeneration !== publication.roomGeneration ||
      prepared.backend !== publication.backend ||
      prepared.state.queueItemId !== publication.state.queueItemId ||
      prepared.state.runId !== publication.state.runId ||
      prepared.state.revision !== publication.state.revision + 1 ||
      preparedAsset.kind !== asset.kind ||
      preparedAsset.binding.queueItemId !== asset.binding.queueItemId ||
      preparedAsset.binding.sourceIdentity !== asset.binding.sourceIdentity ||
      preparedAsset.binding.transferSessionId !== asset.binding.transferSessionId ||
      preparedAsset.metadata.name !== asset.metadata.name ||
      preparedAsset.metadata.mime !== asset.metadata.mime ||
      preparedAsset.encodedSize !== asset.encodedSize ||
      !samePeerRangeManifestPublication(preparedAsset.peerRangeManifest, asset.peerRangeManifest)
    ) {
      return null;
    }
    return current;
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
      prepared.asset.encodedSize !== asset.encodedSize ||
      !samePeerRangeManifestPublication(prepared.asset.peerRangeManifest, asset.peerRangeManifest)
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
    peerRangeOfferPlan: Readonly<PeerRangeOfferPlan>,
  ): Readonly<FilePlaybackProductHostPreparedPublicationCommit> {
    this.#assertPreparedCandidateAuthority(prepared, epoch);
    this.#assertPreparedMatchesWarmSource(prepared, warm);
    if (!this.#canTransferWarmSourceToPrepared(prepared, warm)) {
      throw new Error('Host warm source offer transfer authority raced away');
    }
    this.#assertSamePeerRangeOfferPlan(
      warm.peerRangeOfferPlan,
      peerRangeOfferPlan,
      'Host warm source offer changed its manifest plan during transfer',
    );
    this.#assertPeerRangeOfferMatchesPlan(warm.offer, peerRangeOfferPlan);

    const record = this.#createPreparedPublicationRecord({
      epoch,
      prepared,
      offer: warm.offer,
      handleId: warm.handleId,
      peerRangeOfferPlan,
      resolve,
      transferredWarmSource: warm,
      offerSent: true,
      status: 'offered',
    });
    const timer = warm.expiryTimer;
    const timerLease = warm.expiryTimerLifecycleLease;
    warm.expiryTimer = null;
    warm.expiryTimerLifecycleLease = null;
    warm.status = 'transferred';
    this.#warmOffer = null;
    this.#promotedWarmSourceLeases.add(warm.sourceLease);
    this.#candidate = record;

    if (timer !== null) {
      try {
        this.#runtime.cancelTimeout(timer);
        timerLease?.beginRetire().release();
      } catch {
        timerLease?.forceUnconfirmed();
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
    if (record.mode === 'source' && record.offer.expiresAtRoomTimeMs <= this.#nowRoomTimeMs()) {
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
    if (record.mode === 'source') {
      this.#sendRequiredFrame(record.binding);
      this.#assertCandidateRecord(record);
      record.status = 'published';
    } else {
      // PREPARE is a state-scoped, attempt-free successor. Mark the record
      // published first so a loopback test transport cannot make an exact
      // SOURCE_READY look premature during the synchronous send callback.
      record.status = 'published';
      this.#sendSameRunPrepare(record, stateLease);
      this.#assertCandidateRecord(record);
    }
    return record.commit;
  }

  #sendSameRunPrepare(
    record: PreparedPublicationRecord,
    stateLease: FilePlaybackWireStateLease,
  ): void {
    const current = this.#publication;
    const expected = current?.publication.state;
    if (
      record.mode !== 'same-run-state' ||
      !current ||
      current.status !== 'published' ||
      current.pendingTimelineUpdate !== null ||
      !expected ||
      expected.queueItemId !== record.prepared.state.queueItemId ||
      expected.runId !== record.prepared.state.runId ||
      expected.revision + 1 !== record.prepared.state.revision
    ) {
      throw this.#failConnection(new Error('Host same-run PREPARE authority is stale'));
    }
    let sent: FilePlaybackWireMessageForKind<'file-playback-prepare'> | null;
    try {
      sent = this.#sendWire(this.#context.connection, stateLease, {
        kind: 'file-playback-prepare',
        expectedQueueItemId: expected.queueItemId,
        expectedRunId: expected.runId,
        expectedRevision: expected.revision,
        positionSeconds: record.prepared.positionSeconds,
        playbackRate: record.prepared.playbackRate,
      });
    } catch (error) {
      throw this.#failConnection(error);
    }
    if (!sent) throw this.#failConnection(new Error('Host same-run PREPARE send failed'));
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
          const failure = new Error(`Guest source is not ready: ${message.reasonCode}`);
          candidate.failure = failure;
          candidate.rejectReady(failure);
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
        if (candidate.awaitingAttemptRecoveryReady) {
          candidate.attemptRecoveryReady = true;
        }
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
        if (record.pendingTimelineUpdate) {
          this.#failConnection(
            new Error(`Guest source is not ready for pending timeline: ${message.reasonCode}`),
          );
        }
        return;
      }
      if (message.backend !== record.publication.backend) {
        throw new Error('Guest SOURCE_READY backend does not match host publication');
      }
      const preparedAttempt = this.#attempt;
      const preparedRecord =
        preparedAttempt?.mode === 'prepared' &&
        preparedAttempt.publicationEpoch === record.epoch &&
        preparedAttempt.stateLease === record.stateLease
          ? preparedAttempt.preparedRecord
          : null;
      if (preparedRecord?.awaitingAttemptRecoveryReady) {
        // Activation can win the race with the failed prepared-attempt
        // continuation. Remember the post-CANCEL readiness refresh so that
        // the continuation can start recovery after retiring its exact lease.
        preparedRecord.attemptRecoveryReady = true;
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
      const admission = attempt.participant.admitArmReceipt({
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
      if (admission.disposition === 'invalid') {
        throw new Error(`Guest rendezvous ARM receipt was invalid: ${admission.reason}`);
      }
      acknowledge();
      return;
    }
    if (message.kind === 'rendezvous-finalized') {
      const admission = attempt.participant.admitFinalizeReceipt({
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
      if (admission.disposition === 'invalid') {
        throw new Error(`Guest rendezvous FINALIZE receipt was invalid: ${admission.reason}`);
      }
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
      isAnyPeerRangeOffer(candidate.offer)
        ? {
            handleId: candidate.handleId,
            sourceIdentity: candidate.prepared.asset.binding.sourceIdentity,
          }
        : current?.status === 'published' &&
            current.handleId === frame.handleId &&
            isAnyPeerRangeOffer(current.offer)
          ? {
              handleId: current.handleId,
              sourceIdentity: current.publication.asset.binding.sourceIdentity,
            }
          : warm?.status === 'offered' &&
              warm.handleId === frame.handleId &&
              isAnyPeerRangeOffer(warm.offer)
            ? {
                handleId: warm.handleId,
                sourceIdentity: warm.authority.asset.binding.sourceIdentity,
              }
            : null;
    if (frame.connectionId !== this.#context.connectionId) {
      throw new Error('Peer-range request does not match the current publication');
    }
    if (authority) {
      if (
        frame.sourceIdentity !== authority.sourceIdentity ||
        frame.handleId !== authority.handleId
      ) {
        throw new Error('Peer-range request does not match the current publication');
      }
    } else if (
      !this.#responder.matchesRevokedHandle(
        this.#context.connectionToken,
        frame.handleId,
        frame.sourceIdentity,
      )
    ) {
      throw new Error('Peer-range request does not match the current publication');
    }
    // Responder protocol/acquisition faults intentionally propagate into the
    // session router's adoption barrier. Its fail-close catch retires this
    // exact owner and connection; swallowing here would leave partial state.
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
      armP95Ms: HOST_REMOTE_ARM_P95_FLOOR_MS,
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
        this.#dispatchAttemptCancelWire(intent.rendezvousId, {
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
    record.attemptFailure = null;
    record.awaitingAttemptRecoveryReady = false;
    record.attemptRecoveryReady = false;
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
      cancelling: false,
      cancelDispatch: null,
      cancelRetirement: null,
      cancelDispatchSucceeded: false,
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
      attempt.cancelling ||
      !attempt.stateCommitted ||
      attempt.outcome !== 'succeeded' ||
      attempt.status !== 'candidate' ||
      this.#attempt !== attempt
    ) {
      return;
    }
    try {
      const publication = this.#publication;
      if (
        !publication ||
        publication.epoch !== attempt.publicationEpoch ||
        publication.stateLease !== attempt.stateLease ||
        publication.publication.state.queueItemId !== attempt.state.queueItemId ||
        publication.publication.state.runId !== attempt.state.runId ||
        publication.publication.state.revision !== attempt.state.revision
      ) {
        throw new Error('Host prepared attempt lost its committed publication authority');
      }
      Reflect.apply(trustedChannelCommitAttempt, this.#context.channel, [attempt.lease]);
      attempt.status = 'current';
      for (const [rendezvousId, stale] of this.#attemptsById) {
        if (stale === attempt) continue;
        stale.status = 'retired';
        this.#attemptsById.delete(rendezvousId);
      }
      this.#sendPendingTimelineUpdate(publication);
    } catch (error) {
      this.#failConnection(error);
    }
  }

  #failPreparedAttempt(attempt: AttemptRecord, error: unknown): void {
    if (attempt.mode !== 'prepared' || attempt.status === 'retired') return;
    const failure = asError(error, 'Host prepared remote attempt failed');
    attempt.outcome = 'failed';
    if (attempt.preparedRecord) attempt.preparedRecord.attemptFailure = failure;
    attempt.rejectEvidence(failure);
    if (attempt.cancelling && attempt.cancelRetirement) {
      observe(
        attempt.cancelRetirement.then(() => this.#completePreparedAttemptFailure(attempt, failure)),
      );
      return;
    }
    this.#completePreparedAttemptFailure(attempt, failure);
  }

  #completePreparedAttemptFailure(attempt: AttemptRecord, failure: Error): void {
    this.#retireAttemptLease(attempt);
    if (this.#attempt !== attempt) return;
    this.#attempt = null;
    if (!attempt.stateCommitted) return;

    const publication = this.#publication;
    const prepared = attempt.preparedRecord;
    if (
      !publication ||
      !prepared ||
      publication.epoch !== attempt.publicationEpoch ||
      publication.stateLease !== attempt.stateLease ||
      publication.participant !== attempt.participant ||
      publication.pendingTimelineUpdate === null ||
      publication.publication.state.queueItemId !== attempt.state.queueItemId ||
      publication.publication.state.runId !== attempt.state.runId ||
      publication.publication.state.revision !== attempt.state.revision
    ) {
      this.#failConnection(failure);
      return;
    }

    // Canonical state is already committed locally, but its timeline is still
    // withheld from this peer. The guest's exact CANCEL cleanup re-stages the
    // one-shot renderer and proves that with a fresh SOURCE_READY. A refresh
    // which raced this continuation is retained on the prepared record.
    if (publication.publication.timeline.phase === 'playing' && prepared.attemptRecoveryReady) {
      queueMicrotask(() => this.#beginRecovery(publication));
    }
  }

  #beginRecovery(record: PublicationRecord, force = false): void {
    if (
      this.#closed ||
      this.#publication !== record ||
      this.#currentTransition !== null ||
      record.publication.timeline.phase !== 'playing'
    ) {
      return;
    }
    if (
      this.#attempt?.publicationEpoch === record.epoch &&
      ((this.#attempt.cancelling && this.#attempt.status !== 'retired') ||
        this.#attempt.status === 'candidate' ||
        (!force && this.#attempt.status === 'current'))
    ) {
      return;
    }
    const publication = record.publication;
    const stateLease = record.stateLease;
    const publicationEpoch = record.epoch;
    const participant =
      record.participant ??
      this.#createRemoteParticipant(
        publication.state,
        publication.asset.binding.sourceIdentity,
        publication.asset.binding.transferSessionId,
      );
    record.participant = participant;
    const recoveryAuthority = Object.freeze(Object.create(null));
    this.#recoveryAuthority = recoveryAuthority;
    let recoveryAttempt: AttemptRecord | null = null;
    const evidence = deferredEvidence();
    const recovery = this.#hostRoom.recoverRemoteParticipant({
      publication,
      participant,
      signal: this.#publicationSignal(publicationEpoch),
      bindAttempt: (attempt) => {
        if (
          this.#closed ||
          this.#publication !== record ||
          this.#recoveryAuthority !== recoveryAuthority ||
          this.#currentTransition !== null ||
          record.publication.timeline.phase !== 'playing' ||
          record.epoch !== publicationEpoch ||
          record.publication !== publication ||
          record.stateLease !== stateLease ||
          record.participant !== participant
        ) {
          return Promise.reject(new Error('Host media recovery publication is stale'));
        }
        const lease = Reflect.apply(trustedChannelStageAttempt, this.#context.channel, [
          stateLease,
          attempt.rendezvousId,
        ]);
        const previous = this.#attempt;
        if (previous?.status === 'candidate') this.#retireAttemptLease(previous);
        const attemptRecord: AttemptRecord = {
          mode: 'recovery',
          publicationEpoch,
          participant,
          attempt,
          lease,
          stateLease,
          state: publication.state,
          sourceIdentity: publication.asset.binding.sourceIdentity,
          transferSessionId: publication.asset.binding.transferSessionId,
          evidence: evidence.promise,
          resolveEvidence: evidence.resolve,
          rejectEvidence: evidence.reject,
          preparedRecord: null,
          cancelling: false,
          cancelDispatch: null,
          cancelRetirement: null,
          cancelDispatchSucceeded: false,
          outcome: 'pending',
          stateCommitted: true,
          status: 'candidate',
        };
        recoveryAttempt = attemptRecord;
        this.#attempt = attemptRecord;
        this.#attemptsById.set(attempt.rendezvousId, attemptRecord);
        return evidence.promise;
      },
    });
    observe(
      recovery.then(
        () =>
          this.#commitRecovery(
            record,
            publication,
            stateLease,
            participant,
            recoveryAuthority,
            recoveryAttempt,
          ),
        (error) =>
          this.#rejectRecovery(
            record,
            publication,
            stateLease,
            participant,
            recoveryAuthority,
            recoveryAttempt,
            error,
          ),
      ),
    );
  }

  #commitRecovery(
    record: PublicationRecord,
    publication: Readonly<HostPeerPlaybackPublication>,
    stateLease: FilePlaybackWireStateLease,
    participant: RemoteRendezvousParticipant,
    recoveryAuthority: object,
    recoveryAttempt: AttemptRecord | null,
  ): void {
    if (
      recoveryAttempt?.cancelling &&
      recoveryAttempt.status !== 'retired' &&
      recoveryAttempt.cancelRetirement
    ) {
      observe(
        recoveryAttempt.cancelRetirement.then(() =>
          this.#commitRecovery(
            record,
            publication,
            stateLease,
            participant,
            recoveryAuthority,
            recoveryAttempt,
          ),
        ),
      );
      return;
    }
    if (
      this.#closed ||
      this.#recoveryAuthority !== recoveryAuthority ||
      this.#publication !== record ||
      this.#currentTransition !== null ||
      record.publication !== publication ||
      record.stateLease !== stateLease ||
      record.participant !== participant
    ) {
      return;
    }
    if (!recoveryAttempt) {
      this.#recoveryAuthority = null;
      this.#failConnection(new Error('Host recovery completed without binding an exact attempt'));
      return;
    }
    if (this.#attempt !== recoveryAttempt || recoveryAttempt.status === 'retired') {
      this.#recoveryAuthority = null;
      return;
    }
    if (
      recoveryAttempt.participant !== participant ||
      recoveryAttempt.publicationEpoch !== record.epoch ||
      recoveryAttempt.stateLease !== stateLease ||
      recoveryAttempt.state !== publication.state ||
      recoveryAttempt.status !== 'candidate'
    ) {
      this.#failConnection(new Error('Host recovery lost its exact committed attempt authority'));
      return;
    }
    try {
      this.#recoveryAuthority = null;
      Reflect.apply(trustedChannelCommitAttempt, this.#context.channel, [recoveryAttempt.lease]);
      recoveryAttempt.status = 'current';
      for (const [rendezvousId, stale] of this.#attemptsById) {
        if (stale === recoveryAttempt) continue;
        stale.status = 'retired';
        this.#attemptsById.delete(rendezvousId);
      }
      this.#sendPendingTimelineUpdate(record);
      this.#applyHealth(this.#health.completeRejoin(true));
    } catch (error) {
      this.#failConnection(error);
    }
  }

  #rejectRecovery(
    record: PublicationRecord,
    publication: Readonly<HostPeerPlaybackPublication>,
    stateLease: FilePlaybackWireStateLease,
    participant: RemoteRendezvousParticipant,
    recoveryAuthority: object,
    recoveryAttempt: AttemptRecord | null,
    error: unknown,
  ): void {
    if (
      recoveryAttempt?.cancelling &&
      recoveryAttempt.status !== 'retired' &&
      recoveryAttempt.cancelRetirement
    ) {
      observe(
        recoveryAttempt.cancelRetirement.then(() =>
          this.#rejectRecovery(
            record,
            publication,
            stateLease,
            participant,
            recoveryAuthority,
            recoveryAttempt,
            error,
          ),
        ),
      );
      return;
    }
    const exactRecovery =
      !this.#closed &&
      this.#recoveryAuthority === recoveryAuthority &&
      this.#publication === record &&
      this.#currentTransition === null &&
      record.publication === publication &&
      record.stateLease === stateLease &&
      record.participant === participant;
    const cancelledPendingTimelineRecovery =
      exactRecovery &&
      record.pendingTimelineUpdate !== null &&
      recoveryAttempt !== null &&
      recoveryAttempt.cancelDispatchSucceeded &&
      recoveryAttempt.status === 'retired';
    if (cancelledPendingTimelineRecovery) {
      // The guest destroys its one-shot renderer only after consuming the
      // exact CANCEL, then publishes a fresh SOURCE_READY after re-staging.
      // Keep the canonical timeline withheld and let that readiness refresh
      // create the next recovery generation. A live/non-cancel failure still
      // follows the fatal pending-timeline branch below.
      if (this.#attempt === recoveryAttempt) this.#attempt = null;
      this.#recoveryAuthority = null;
      return;
    }
    if (
      exactRecovery &&
      recoveryAttempt &&
      this.#attempt === recoveryAttempt &&
      recoveryAttempt.participant === participant &&
      recoveryAttempt.publicationEpoch === record.epoch &&
      recoveryAttempt.stateLease === stateLease &&
      recoveryAttempt.state === publication.state &&
      recoveryAttempt.status === 'candidate'
    ) {
      recoveryAttempt.rejectEvidence(asError(error, 'Host participant recovery failed'));
      this.#retireAttemptLease(recoveryAttempt);
      this.#attemptsById.delete(recoveryAttempt.attempt.rendezvousId);
      if (this.#attempt === recoveryAttempt) this.#attempt = null;
    }
    if (exactRecovery) this.#recoveryAuthority = null;
    if (exactRecovery && record.pendingTimelineUpdate) {
      this.#failConnection(asError(error, 'Host late peer recovery failed'));
      return;
    }
    if (exactRecovery) this.#applyHealth(this.#health.completeRejoin(false));
  }

  #dispatchAttemptWire<Kind extends 'rendezvous-arm' | 'rendezvous-finalize'>(
    kind: Kind,
    rendezvousId: string,
    payload: FilePlaybackWirePayloadByKind[Kind],
  ): Promise<void> {
    return Promise.resolve().then(() => {
      const attempt = this.#attemptsById.get(rendezvousId) ?? null;
      if (
        !attempt ||
        attempt.attempt.rendezvousId !== rendezvousId ||
        attempt.cancelling ||
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
    });
  }

  #dispatchAttemptCancelWire(
    rendezvousId: string,
    payload: FilePlaybackWirePayloadByKind['file-playback-cancel'],
  ): Promise<void> {
    const attempt = this.#attemptsById.get(rendezvousId) ?? null;
    if (
      !attempt ||
      attempt.attempt.rendezvousId !== rendezvousId ||
      attempt.status === 'retired' ||
      this.#closed
    ) {
      return Promise.reject(new Error('Host file-playback-cancel attempt authority is stale'));
    }
    if (attempt.cancelDispatch) return attempt.cancelDispatch;

    // Capture and fence the exact record before yielding. Remote participant
    // cancellation deliberately does not await transport, so an already
    // queued acceptance/recovery failure must not retire this lease first.
    attempt.cancelling = true;
    const dispatch = Promise.resolve().then(() => {
      let sent: FilePlaybackWireMessageForKind<'file-playback-cancel'> | null;
      try {
        sent = this.#sendWire(this.#context.connection, attempt.lease, payload);
      } catch (error) {
        throw new HostMediaOwnerConnectionError('Host media connection failed', error);
      }
      if (!sent) {
        throw new HostMediaOwnerConnectionError(
          'Host media connection failed',
          new Error('Host file-playback-cancel send failed'),
        );
      }
      attempt.cancelDispatchSucceeded = true;
      if (attempt.preparedRecord) {
        attempt.preparedRecord.awaitingAttemptRecoveryReady = true;
        attempt.preparedRecord.attemptRecoveryReady = false;
      }
    });
    attempt.cancelDispatch = dispatch;
    const retirement = dispatch.then(
      () => this.#completeAttemptRetirement(attempt),
      () => this.#completeAttemptRetirement(attempt),
    );
    attempt.cancelRetirement = retirement;
    observe(retirement);
    observe(
      dispatch.catch(async (error) => {
        await retirement;
        this.#failConnection(error);
      }),
    );
    return dispatch;
  }

  async #resolvePeerSource(
    handleId: string | null,
    sourceIdentity: string,
    signal: AbortSignal,
  ): Promise<HostPeerRangeSource | null> {
    this.#expireWarmSourceOfferIfNeeded();
    const candidate = this.#candidate;
    const candidateSource = candidate?.source ?? null;
    if (
      candidate !== null &&
      candidateSource !== null &&
      hasPreparedSourceAuthority(candidate) &&
      isAnyPeerRangeOffer(candidate.offer) &&
      (handleId === null || handleId === candidate.handleId) &&
      sourceIdentity === candidate.prepared.asset.binding.sourceIdentity
    ) {
      const peerRangeOfferPlan = this.#requirePeerRangeOfferPlan(
        candidate.offer,
        candidate.peerRangeOfferPlan,
      );
      const source = await candidateSource.resolve({
        prepared: candidate.prepared,
        sourceIdentity,
        peerRangeManifest: peerRangeOfferPlan.peerRangeManifest,
        signal,
      });
      if (this.#closed || this.#candidate !== candidate || !hasPreparedSourceAuthority(candidate)) {
        if (isEncodedSource(source)) await source.close().catch(() => undefined);
        return null;
      }
      await this.#assertResolvedPeerSource(
        source,
        candidate.prepared.asset,
        peerRangeOfferPlan,
        'Host prepared peer source changed its exact offer binding',
      );
      return source;
    }
    const record = this.#publication;
    if (
      record &&
      isAnyPeerRangeOffer(record.offer) &&
      (handleId === null || handleId === record.handleId) &&
      sourceIdentity === record.publication.asset.binding.sourceIdentity
    ) {
      const peerRangeOfferPlan = this.#requirePeerRangeOfferPlan(
        record.offer,
        record.peerRangeOfferPlan,
      );
      const source = await this.#hostRoom.resolveCurrentPeerRangeSource({
        publication: record.publication,
        sourceIdentity,
        peerRangeManifest: peerRangeOfferPlan.peerRangeManifest,
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
      await this.#assertResolvedPeerSource(
        source,
        record.publication.asset,
        peerRangeOfferPlan,
        'Host current peer source changed its exact offer binding',
      );
      return source;
    }

    const warm = this.#warmOffer;
    if (
      !warm ||
      warm.status !== 'offered' ||
      !isAnyPeerRangeOffer(warm.offer) ||
      (handleId !== null && handleId !== warm.handleId) ||
      sourceIdentity !== warm.authority.asset.binding.sourceIdentity
    ) {
      return null;
    }
    this.#assertPeerRangeOfferMatchesPlan(warm.offer, warm.peerRangeOfferPlan);
    const source = await warm.resolve({
      sourceLease: warm.sourceLease,
      sourceIdentity,
      peerRangeManifest: warm.peerRangeOfferPlan.peerRangeManifest,
      signal,
    });
    const stillWarm = this.#warmOffer === warm && warm.status === 'offered';
    if (this.#closed || (!stillWarm && !this.#hasTransferredWarmSourceAuthority(warm))) {
      if (isEncodedSource(source)) await source.close().catch(() => undefined);
      return null;
    }
    await this.#assertResolvedPeerSource(
      source,
      warm.authority.asset,
      warm.peerRangeOfferPlan,
      'Host warm peer source changed its exact offer binding',
    );
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
    const bufferedBytes = dataChannel?.bufferedAmount;
    return (
      !this.#closed &&
      connection.open === true &&
      dataChannel?.readyState === 'open' &&
      typeof bufferedBytes === 'number' &&
      Number.isFinite(bufferedBytes) &&
      bufferedBytes <= FILE_PLAYBACK_PRODUCT_PEER_RANGE_BUFFERED_AMOUNT_LIMIT
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
      const publication = this.#publication;
      if (!publication?.participant || publication.publication.timeline.phase === 'paused') {
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
      const reported = this.#health.reportMany(signals);
      this.#applyHealth(reported);
      if (!publication || publication.publication.timeline.phase === 'paused') {
        let snapshot = this.#health.getSnapshot();
        if (snapshot.rejoinRequired && snapshot.unhealthyDimensions.length === 0) {
          if (snapshot.state === 'DEGRADED') {
            this.#applyHealth(this.#health.beginRejoin());
            snapshot = this.#health.getSnapshot();
          }
          if (snapshot.state === 'REJOINING') {
            this.#applyHealth(this.#health.completeRejoin(true));
          }
        }
      }
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
    try {
      this.#runtime.cancelInterval(this.#healthTimer);
      this.#healthTimerLifecycleLease.beginRetire().release();
    } catch {
      this.#healthTimerLifecycleLease.forceUnconfirmed();
    }
    this.#retireAttempt(reason);
    this.#retirePreparedCandidate(reason, false);
    if (this.#warmOffer) this.#retireWarmSourceOffer(this.#warmOffer, reason, false);
    this.#revokePublishedHandle(reason);
    const responderRetirement = invokePhysicalCleanup(() => this.#responder.close(reason));
    // Retirement helpers above may synchronously publish their exact cleanup
    // Promise. Snapshot the barrier only after those ownership transitions.
    const pendingTasks = [
      this.#mediaLane,
      this.#publicationTask,
      this.#candidateTask,
      this.#candidateBindingTask,
      this.#candidateRetirement?.promise ?? null,
      this.#warmOfferTask,
    ].filter((task) => task !== null) as Promise<unknown>[];
    this.#publication = null;
    this.#currentTransition = null;
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
    let connectionRetirement = Promise.resolve();
    if (closeConnection) {
      try {
        this.#closeConnection(this.#context.connection);
      } catch (cause) {
        connectionRetirement = Promise.reject(cause);
      }
    }
    void confirmFilePlaybackUniversalLifecycleRetirement(this.#lifecycleLease, async () => {
      await Promise.allSettled(pendingTasks);
      await settlePhysicalCleanupStrictly(
        [responderRetirement, connectionRetirement],
        'Multiple host media owner cleanup operations failed',
      );
    });
  }

  #retireAttempt(reason: Error): void {
    const attempt = this.#attempt;
    if (!attempt) return;
    if (attempt.mode === 'recovery') this.#recoveryAuthority = null;
    attempt.rejectEvidence(reason);
    this.#retireAttemptLease(attempt);
    if (attempt.status === 'retired') {
      this.#deleteExactAttemptRecord(attempt);
    }
    this.#attempt = null;
  }

  #retireAttemptLease(attempt: AttemptRecord): void {
    if (attempt.status === 'retired') return;
    if (attempt.cancelling && attempt.cancelRetirement) return;
    this.#completeAttemptRetirement(attempt);
  }

  #completeAttemptRetirement(attempt: AttemptRecord): void {
    if (attempt.status === 'retired') return;
    try {
      Reflect.apply(trustedChannelRetireAttempt, this.#context.channel, [attempt.lease]);
    } catch {
      // A closing channel has already revoked this exact lease.
    }
    attempt.status = 'retired';
    this.#deleteExactAttemptRecord(attempt);
  }

  #deleteExactAttemptRecord(attempt: AttemptRecord): void {
    const rendezvousId = attempt.attempt.rendezvousId;
    if (this.#attemptsById.get(rendezvousId) === attempt) {
      this.#attemptsById.delete(rendezvousId);
    }
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
    const timerLease = record.expiryTimerLifecycleLease;
    record.expiryTimer = null;
    record.expiryTimerLifecycleLease = null;
    record.status = 'retired';
    if (this.#warmOffer === record) this.#warmOffer = null;
    if (timer !== null) {
      try {
        this.#runtime.cancelTimeout(timer);
        timerLease?.beginRetire().release();
      } catch {
        timerLease?.forceUnconfirmed();
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
    if (record.mode === 'source' && record.handleId) {
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

  #createPeerRangeOfferPlan(
    backend: HostPreparedLocalTrack['backend'],
    asset: Readonly<HostPeerPlaybackAssetPublication>,
  ): Readonly<PeerRangeOfferPlan> {
    if (backend !== 'bounded-stream') {
      throw new Error('Host peer-range offer plan requires a bounded publication');
    }
    if (!Number.isSafeInteger(asset.encodedSize) || asset.encodedSize <= 0) {
      throw new Error('Host peer-range media size is invalid');
    }
    const issued = asset.peerRangeManifest;
    if (issued === null) {
      return freezeCanonical({ peerRangeManifest: null, expectedSourceSize: asset.encodedSize });
    }
    const diagnostics = snapshotExactRecord(issued, PEER_RANGE_MANIFEST_KEYS);
    if (
      !diagnostics ||
      (diagnostics.codec !== 'adts-aac-lc' && diagnostics.codec !== 'mp3-no-frame-count') ||
      !Number.isSafeInteger(diagnostics.manifestByteLength) ||
      !isCanonicalSha256Base64(diagnostics.manifestSha256B64)
    ) {
      throw new Error('Host peer-range manifest diagnostics are invalid');
    }
    const manifest = issued as Readonly<HostPeerRangeManifestPublication>;
    const bundleSize = derivePeerRangeManifestBundleSize(
      asset.encodedSize,
      manifest.manifestByteLength,
    );
    if (bundleSize === null) {
      throw new Error('Host peer-range manifest bundle geometry is invalid');
    }
    if (!isFilePlaybackPeerRangeManifestCodecEnabled(this.#boundedRoutePolicy, manifest.codec)) {
      return freezeCanonical({ peerRangeManifest: null, expectedSourceSize: asset.encodedSize });
    }
    return freezeCanonical({ peerRangeManifest: manifest, expectedSourceSize: bundleSize });
  }

  #assertSamePeerRangeOfferPlan(
    left: Readonly<PeerRangeOfferPlan> | null,
    right: Readonly<PeerRangeOfferPlan> | null,
    message: string,
  ): void {
    if (
      left === null ||
      right === null ||
      left.expectedSourceSize !== right.expectedSourceSize ||
      !samePeerRangeManifestPublication(left.peerRangeManifest, right.peerRangeManifest)
    ) {
      if (left === null && right === null) return;
      throw new Error(message);
    }
  }

  #assertPeerRangeOfferMatchesPlan(
    offer: Readonly<AnyPeerRangeFileMediaSourceOfferV2>,
    plan: Readonly<PeerRangeOfferPlan>,
  ): void {
    const manifest = plan.peerRangeManifest;
    if (manifest === null) {
      if (offer.transport !== 'peer-range' || offer.encodedSize !== plan.expectedSourceSize) {
        throw new Error('Host direct peer-range offer changed its exact plan');
      }
      return;
    }
    if (
      offer.transport !== 'peer-range-manifest' ||
      offer.manifestByteLength !== manifest.manifestByteLength ||
      offer.manifestSha256B64 !== manifest.manifestSha256B64 ||
      derivePeerRangeManifestBundleSize(offer.encodedSize, offer.manifestByteLength) !==
        plan.expectedSourceSize
    ) {
      throw new Error('Host manifest peer-range offer changed its exact plan');
    }
  }

  #requirePeerRangeOfferPlan(
    offer: Readonly<AnyPeerRangeFileMediaSourceOfferV2>,
    plan: Readonly<PeerRangeOfferPlan> | null,
  ): Readonly<PeerRangeOfferPlan> {
    if (!plan) throw new Error('Host peer-range offer lost its exact plan');
    this.#assertPeerRangeOfferMatchesPlan(offer, plan);
    return plan;
  }

  async #assertResolvedPeerSource(
    source: HostPeerRangeSource,
    asset: Readonly<HostPeerPlaybackAssetPublication>,
    plan: Readonly<PeerRangeOfferPlan> | null,
    message: string,
  ): Promise<void> {
    const expectedSourceSize = plan?.expectedSourceSize ?? asset.encodedSize;
    const encodedSource = isEncodedSource(source) ? source : null;
    const manifestRequiresEncodedSource = plan !== null && plan.peerRangeManifest !== null;
    if (
      source.size === expectedSourceSize &&
      (!manifestRequiresEncodedSource || encodedSource !== null) &&
      (!encodedSource ||
        (encodedSource.identity === asset.binding.sourceIdentity &&
          encodedSource.metadata.name === asset.metadata.name &&
          encodedSource.metadata.mime === asset.metadata.mime))
    ) {
      return;
    }
    if (encodedSource) await encodedSource.close().catch(() => undefined);
    throw new Error(message);
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
      left.asset.encodedSize === right.asset.encodedSize &&
      samePeerRangeManifestPublication(left.asset.peerRangeManifest, right.asset.peerRangeManifest)
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
    if (record.offer.handleId !== record.handleId) {
      throw new Error('Host warm source offer changed its exact handle');
    }
    this.#assertPeerRangeOfferMatchesPlan(record.offer, record.peerRangeOfferPlan);
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
    if (record.mode === 'same-run-state') {
      const current = this.#publication;
      if (
        record.source !== null ||
        record.offerSent ||
        record.transferredWarmSource !== null ||
        !current ||
        current.status !== 'published' ||
        record.offer !== current.offer ||
        record.binding !== current.binding ||
        record.handleId !== current.handleId ||
        record.peerRangeOfferPlan !== current.peerRangeOfferPlan ||
        record.prepared.state.queueItemId !== current.publication.state.queueItemId ||
        record.prepared.state.runId !== current.publication.state.runId ||
        record.prepared.state.revision !== current.publication.state.revision + 1
      ) {
        throw new Error('Host same-run prepared publication changed its current authority');
      }
    } else if (record.source === null) {
      throw new Error('Host prepared source publication lost its resolver authority');
    }
    if (isAnyPeerRangeOffer(record.offer)) {
      if (record.handleId !== record.offer.handleId) {
        throw new Error('Host prepared peer-range publication changed its exact handle');
      }
      this.#requirePeerRangeOfferPlan(record.offer, record.peerRangeOfferPlan);
    } else if (record.peerRangeOfferPlan !== null || record.handleId !== null) {
      throw new Error('Host prepared R2 publication changed its exact plan');
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
    if (isAnyPeerRangeOffer(record.offer)) {
      if (record.handleId !== record.offer.handleId) {
        throw new Error('Host peer-range publication changed its exact handle');
      }
      this.#requirePeerRangeOfferPlan(record.offer, record.peerRangeOfferPlan);
    } else if (record.peerRangeOfferPlan !== null || record.handleId !== null) {
      throw new Error('Host R2 publication changed its exact plan');
    }
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

  #sendPendingTimelineUpdate(record: PublicationRecord): void {
    const update = record.pendingTimelineUpdate;
    if (!update) return;
    if (this.#publication !== record || record.status !== 'published') {
      throw this.#failConnection(new Error('Host pending timeline publication is stale'));
    }
    this.#sendRequiredFrame(update);
    if (this.#publication !== record) {
      throw this.#failConnection(new Error('Host timeline publication changed during send'));
    }
    record.pendingTimelineUpdate = null;
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
