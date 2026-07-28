import { ensureRunning } from '../audio/context.ts';
import { getAudioContext, getFilePlaybackDestination, initAudio } from '../audio/engine.ts';
import { isFilePlaybackSessionId } from '../network/file-playback-session-handshake.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  acquireFilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleLease,
} from './diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import { confirmFilePlaybackUniversalLifecycleRetirement } from './diagnostics/file-playback-universal-lifecycle-retirement.ts';
import { FilePlaybackApplicationController } from './file-playback-application-controller.ts';
import {
  snapshotFilePlaybackBoundedRoutePolicy,
  type FilePlaybackBoundedRoutePolicy,
} from './file-playback-bounded-route-policy.ts';
import {
  FilePlaybackHostFirstFileEngine,
  type FilePlaybackHostFirstFileEngineOptions,
  type HostCurrentPlaybackOperationOptions,
  type HostCurrentPlaybackTimelineCommittedEvent,
  type HostCurrentPlaybackTransitionScheduledEvent,
  type HostRemoteEndRequiredEvent,
  type HostCurrentPlaybackTransitionCommit,
  type ClearHostLocalTrackWarmOptions,
  type HostFirstLocalFilePlaybackCommit,
  type HostLocalTrackSourceLease,
  type HostLocalTrackWarmResult,
  type HostPeerPlaybackPublication,
  type HostPeerRangeManifestPublication,
  type HostPeerRangeSource,
  type HostPreparedLocalTrack,
  type HostPreparedRemoteParticipant,
  type HostRemoteRecoveryCommit,
  type RecoverHostRemoteParticipantOptions,
  type ResolvePreparedHostPeerRangeSourceOptions,
  type ResolveHostPeerRangeSourceOptions,
  type ResolveWarmHostPeerRangeSourceOptions,
  type SeekHostPausedOptions,
  type SeekHostPlayingOptions,
  type StartPreparedHostLocalTrackOptions,
  type StartHostFirstLocalFileOptions,
  type StartHostLocalTrackOptions,
  type WarmHostLocalTrackOptions,
} from './file-playback-host-first-file-engine.ts';
import { FilePlaybackRoomClock, getFilePlaybackRoomClock } from './file-playback-room-clock.ts';
import type { FilePlaybackPosition, FilePlaybackSourceSnapshot } from './file-playback-source.ts';
import type { OrdinaryAudioDecoder } from './file-playback-source-factory.ts';
import { decodeOrdinaryAudio } from './ordinary-audio-decoder.ts';
import { isQueueItemId } from './queue-model.ts';

const OPTION_KEYS = Object.freeze([
  'controller',
  'hostRoomSnapshot',
  'boundedRoutePolicy',
  'onFatalRoom',
  'onRemoteEndRequired',
  'onTimelineCommitted',
  'onTransitionScheduled',
  'roomClock',
  'runtimeForTests',
] as const);
const REQUIRED_OPTION_KEYS = OPTION_KEYS.filter(
  (key) =>
    key !== 'boundedRoutePolicy' &&
    key !== 'onRemoteEndRequired' &&
    key !== 'onTimelineCommitted' &&
    key !== 'onTransitionScheduled' &&
    key !== 'roomClock' &&
    key !== 'runtimeForTests',
);
const FIRST_FILE_KEYS = Object.freeze(['file', 'queueItemId', 'signal'] as const);
const CLEAR_WARM_TRACK_KEYS = Object.freeze(['queueItemId', 'signal'] as const);
const CLEAR_WARM_TRACK_BY_LEASE_KEYS = Object.freeze(['signal', 'sourceLease'] as const);
const TRACK_KEYS = Object.freeze(['file', 'positionSeconds', 'queueItemId', 'signal'] as const);
const COHORT_TRACK_KEYS = Object.freeze([...TRACK_KEYS, 'prepareRemoteParticipants'] as const);
const CURRENT_KEYS = Object.freeze(['signal'] as const);
const COHORT_CURRENT_KEYS = Object.freeze([...CURRENT_KEYS, 'prepareRemoteParticipants'] as const);
const SEEK_KEYS = Object.freeze(['positionSeconds', 'signal'] as const);
const COHORT_SEEK_KEYS = Object.freeze([...SEEK_KEYS, 'prepareRemoteParticipants'] as const);
const RESOLVE_PEER_SOURCE_KEYS = Object.freeze([
  'peerRangeManifest',
  'publication',
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
const HOST_ROOM_KEYS = Object.freeze([
  'applicationSessionId',
  'hostParticipantId',
  'roomGeneration',
  'schemaVersion',
] as const);
const RUNTIME_KEYS = Object.freeze([
  'createEngineForTests',
  'createRoomTokenForTests',
  'decodeOrdinaryAudioForTests',
  'ensureRunningForTests',
  'getAudioContextForTests',
  'getFilePlaybackDestinationForTests',
  'initAudioForTests',
  'onTerminalReferencesReleasedForTests',
] as const);

type ExactRecord = Readonly<Record<string, unknown>>;

/** Narrow private capability retained by the room facade. */
export interface FilePlaybackProductHostFirstEnginePort {
  warmLocalTrack(options: WarmHostLocalTrackOptions): Promise<Readonly<HostLocalTrackWarmResult>>;
  clearWarmLocalTrack(options: ClearHostLocalTrackWarmOptions): Promise<boolean>;
  resolveWarmPeerRangeSource(
    options: ResolveWarmHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource>;
  startFirstLocalFile(
    options: StartHostFirstLocalFileOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>>;
  startLocalTrack(
    options: StartHostLocalTrackOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>>;
  prepareLocalTrack(options: StartHostLocalTrackOptions): Promise<Readonly<HostPreparedLocalTrack>>;
  preparePlayingSeek(options: SeekHostPlayingOptions): Promise<Readonly<HostPreparedLocalTrack>>;
  prepareResumeCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostPreparedLocalTrack>>;
  prepareReplayCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostPreparedLocalTrack>>;
  startPreparedLocalTrack(
    options: StartPreparedHostLocalTrackOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>>;
  resolvePreparedPeerRangeSource(
    options: ResolvePreparedHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource>;
  pauseCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>>;
  seekPlaying(options: SeekHostPlayingOptions): Promise<Readonly<HostFirstLocalFilePlaybackCommit>>;
  seekPaused(
    options: SeekHostPausedOptions,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>>;
  resumeCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>>;
  replayCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>>;
  stopCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>>;
  settleEndedCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>>;
  currentPeerPublication(): Readonly<HostPeerPlaybackPublication> | null;
  resolveCurrentPeerRangeSource(
    options: ResolveHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource>;
  recoverRemoteParticipant(
    options: RecoverHostRemoteParticipantOptions,
  ): Promise<Readonly<HostRemoteRecoveryCommit>>;
  close(): Promise<void>;
  currentRendererSnapshot(): FilePlaybackSourceSnapshot | null;
  positionAt(localPerformanceTimeMs: number): FilePlaybackPosition | null;
}

/**
 * Exact source-native natural-end observation for the still-playing host truth.
 *
 * This is deliberately separate from `currentRendererSnapshot()`: ordinary
 * projections keep requiring source and controller phases to agree, while the
 * ended-settlement boundary may observe the one valid transitional mismatch
 * (`source=ended`, `controller=playing`).
 */
export interface FilePlaybackProductHostTerminalObservation extends FilePlaybackSourceSnapshot {
  readonly phase: 'ended';
  readonly run: NonNullable<FilePlaybackSourceSnapshot['run']>;
}

/**
 * Exact source-native renderer failure for the still-playing host truth.
 *
 * Like the natural-end observation, this is intentionally kept out of the
 * ordinary renderer projection. Consumers may use it only to recover the exact
 * playing incarnation; stale renderer failures remain fail-closed.
 */
export interface FilePlaybackProductHostFailureObservation extends FilePlaybackSourceSnapshot {
  readonly phase: 'failed';
  readonly run: NonNullable<FilePlaybackSourceSnapshot['run']>;
}

export interface FilePlaybackProductHostRoomRuntimeForTests {
  readonly initAudioForTests?: () => Promise<void>;
  readonly ensureRunningForTests?: () => Promise<void>;
  readonly getAudioContextForTests?: () => AudioContext;
  readonly getFilePlaybackDestinationForTests?: () => AudioNode | null;
  readonly decodeOrdinaryAudioForTests?: OrdinaryAudioDecoder;
  readonly createRoomTokenForTests?: () => object;
  readonly createEngineForTests?: (
    options: Readonly<FilePlaybackHostFirstFileEngineOptions>,
  ) => FilePlaybackProductHostFirstEnginePort;
  readonly onTerminalReferencesReleasedForTests?: (
    snapshot: Readonly<{
      readonly activeTaskRetained: false;
      readonly engineRetained: false;
      readonly fileRetained: false;
    }>,
  ) => void;
}

export interface FilePlaybackProductHostRoomOptions {
  readonly controller: FilePlaybackApplicationController;
  readonly hostRoomSnapshot: Readonly<FilePlaybackProductHostRoomAuthority>;
  /** Fixed for this room; omission preserves the current bounded routing contract. */
  readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
  /** Product code omits this and consumes the one process room clock. */
  readonly roomClock?: FilePlaybackRoomClock;
  readonly onFatalRoom: (error: Error) => void;
  readonly onTransitionScheduled?: (
    event: Readonly<HostCurrentPlaybackTransitionScheduledEvent>,
  ) => void;
  readonly onRemoteEndRequired?: (event: Readonly<HostRemoteEndRequiredEvent>) => void;
  readonly onTimelineCommitted?: (
    event: Readonly<HostCurrentPlaybackTimelineCommittedEvent>,
  ) => void;
  readonly runtimeForTests?: FilePlaybackProductHostRoomRuntimeForTests;
}

/** Neutral structural authority accepted from the gate-aware product runtime. */
export interface FilePlaybackProductHostRoomAuthority {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly applicationSessionId: string;
  readonly hostParticipantId: string;
}

export interface StartFilePlaybackProductHostFirstLocalFileOptions {
  readonly queueItemId: QueueItemId;
  readonly file: File;
  readonly signal: AbortSignal;
}

/** Revision-free intent for warming one bounded local source. */
export type WarmFilePlaybackProductHostLocalTrackOptions =
  StartFilePlaybackProductHostFirstLocalFileOptions;

/** Exact queue-scoped retirement for the room's retained warm source. */
export interface ClearFilePlaybackProductHostLocalTrackWarmOptions {
  readonly queueItemId: QueueItemId;
  readonly signal: AbortSignal;
}

/** Local-only exact capability clear; callers must retain the issued object identity. */
export interface ClearFilePlaybackProductHostLocalTrackWarmByLeaseOptions {
  readonly sourceLease: HostLocalTrackSourceLease;
  readonly signal: AbortSignal;
}

export interface StartFilePlaybackProductHostLocalTrackOptions extends StartFilePlaybackProductHostFirstLocalFileOptions {
  readonly positionSeconds: number;
}

export interface FilePlaybackProductHostPreparedCohortContext {
  /** Body-free exact capability for this one silent engine candidate. */
  readonly prepared: Readonly<HostPreparedLocalTrack>;
  /** The room-owned signal for the complete prepare/publish/start operation. */
  readonly signal: AbortSignal;
  /** Resolves only the encoded source bound to `prepared`, under one exact peer-owner signal. */
  readonly resolveSource: (
    sourceIdentity: string,
    peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null,
    signal: AbortSignal,
  ) => Promise<HostPeerRangeSource>;
}

export type PrepareFilePlaybackProductHostRemoteParticipants = (
  context: Readonly<FilePlaybackProductHostPreparedCohortContext>,
) => Promise<readonly Readonly<HostPreparedRemoteParticipant>[]>;

/**
 * One non-dangling room operation: prepare the local candidate, establish the
 * exact ready remote cohort, then start their shared rendezvous.
 */
export interface StartFilePlaybackProductHostLocalTrackWithCohortOptions extends StartFilePlaybackProductHostLocalTrackOptions {
  readonly prepareRemoteParticipants: PrepareFilePlaybackProductHostRemoteParticipants;
}

export interface FilePlaybackProductHostCurrentOptions {
  readonly signal: AbortSignal;
}

export interface FilePlaybackProductHostCurrentWithCohortOptions extends FilePlaybackProductHostCurrentOptions {
  readonly prepareRemoteParticipants: PrepareFilePlaybackProductHostRemoteParticipants;
}

export interface FilePlaybackProductHostSeekOptions extends FilePlaybackProductHostCurrentOptions {
  readonly positionSeconds: number;
}

export interface FilePlaybackProductHostSeekWithCohortOptions extends FilePlaybackProductHostSeekOptions {
  readonly prepareRemoteParticipants: PrepareFilePlaybackProductHostRemoteParticipants;
}

/** Frozen, serializable control result. Encoded bodies and native graph objects stay private. */
export interface FilePlaybackProductHostLocalTrackCommit extends HostFirstLocalFilePlaybackCommit {
  readonly status: 'committed';
  readonly applicationSessionId: string;
  readonly hostParticipantId: string;
}

/** Frozen, body-free observation of one revision-free local warm result. */
export interface FilePlaybackProductHostLocalTrackWarmResult extends HostLocalTrackWarmResult {
  readonly applicationSessionId: string;
  readonly hostParticipantId: string;
  /** Opaque local capability. It must never be serialized or structurally copied. */
  readonly sourceLease: HostLocalTrackSourceLease | null;
}

export interface FilePlaybackProductHostTransitionCommit extends HostCurrentPlaybackTransitionCommit {
  readonly status: 'committed';
  readonly applicationSessionId: string;
  readonly hostParticipantId: string;
}

/** Compatibility name retained until the product runtime migrates its first-file surface. */
export type FilePlaybackProductHostFirstLocalFileCommit = FilePlaybackProductHostLocalTrackCommit;

interface RuntimeSnapshot {
  readonly initAudio: () => Promise<void>;
  readonly ensureRunning: () => Promise<void>;
  readonly getAudioContext: () => AudioContext;
  readonly getFilePlaybackDestination: () => AudioNode | null;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly createRoomToken: () => object;
  readonly createEngine: (
    options: Readonly<FilePlaybackHostFirstFileEngineOptions>,
  ) => FilePlaybackProductHostFirstEnginePort;
  readonly allowStructuralEngine: boolean;
  readonly onTerminalReferencesReleased:
    | ((
        snapshot: Readonly<{
          readonly activeTaskRetained: false;
          readonly engineRetained: false;
          readonly fileRetained: false;
        }>,
      ) => void)
    | null;
}

interface FileIntent {
  readonly queueItemId: QueueItemId;
  readonly file: File;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly lastModified: number;
  readonly positionSeconds: number;
  readonly signal: AbortSignal;
}

interface AudioRuntime {
  readonly audioContext: AudioContext;
  readonly destination: AudioNode;
}

interface EngineRecord {
  readonly token: object;
  readonly engine: FilePlaybackProductHostFirstEnginePort;
}

interface RoomOperation {
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal;
  readonly removeExternalAbort: () => void;
  readonly settlement: Promise<void>;
  readonly settle: () => void;
  cleanupFailure: unknown;
}

const claimedRoomTokens = new WeakSet<object>();

class ProductHostRoomCleanupError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'ProductHostRoomCleanupError';
  }
}

const trustedControllerSnapshot = FilePlaybackApplicationController.prototype.snapshot;
const trustedControllerTimeline = FilePlaybackApplicationController.prototype.timelineSnapshot;
const trustedRoomClockRole = FilePlaybackRoomClock.prototype.role;
const trustedRoomClockNow = FilePlaybackRoomClock.prototype.nowRoomTimeMs;
const trustedAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const trustedEventTargetAdd = EventTarget.prototype.addEventListener;
const trustedEventTargetRemove = EventTarget.prototype.removeEventListener;
const trustedAbortControllerAbort = AbortController.prototype.abort;
const trustedAbortReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get;

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

function runtimeSnapshot(value: unknown): RuntimeSnapshot | null {
  if (value === undefined) {
    return freezeCanonical({
      initAudio,
      ensureRunning,
      getAudioContext,
      getFilePlaybackDestination,
      decodeOrdinaryAudio,
      createRoomToken: () => Object.freeze(Object.create(null) as object),
      createEngine: (options: Readonly<FilePlaybackHostFirstFileEngineOptions>) =>
        new FilePlaybackHostFirstFileEngine(options),
      allowStructuralEngine: false,
      onTerminalReferencesReleased: null,
    });
  }
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set<string>(RUNTIME_KEYS);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))) {
      return null;
    }
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      if (descriptor.value !== undefined && typeof descriptor.value !== 'function') return null;
    }
    const createEngine = descriptors.createEngineForTests?.value as
      | RuntimeSnapshot['createEngine']
      | undefined;
    return freezeCanonical({
      initAudio:
        (descriptors.initAudioForTests?.value as RuntimeSnapshot['initAudio'] | undefined) ??
        initAudio,
      ensureRunning:
        (descriptors.ensureRunningForTests?.value as
          | RuntimeSnapshot['ensureRunning']
          | undefined) ?? ensureRunning,
      getAudioContext:
        (descriptors.getAudioContextForTests?.value as
          | RuntimeSnapshot['getAudioContext']
          | undefined) ?? getAudioContext,
      getFilePlaybackDestination:
        (descriptors.getFilePlaybackDestinationForTests?.value as
          | RuntimeSnapshot['getFilePlaybackDestination']
          | undefined) ?? getFilePlaybackDestination,
      decodeOrdinaryAudio:
        (descriptors.decodeOrdinaryAudioForTests?.value as OrdinaryAudioDecoder | undefined) ??
        decodeOrdinaryAudio,
      createRoomToken:
        (descriptors.createRoomTokenForTests?.value as
          | RuntimeSnapshot['createRoomToken']
          | undefined) ?? (() => Object.freeze(Object.create(null) as object)),
      createEngine:
        createEngine ??
        ((options: Readonly<FilePlaybackHostFirstFileEngineOptions>) =>
          new FilePlaybackHostFirstFileEngine(options)),
      allowStructuralEngine: createEngine !== undefined,
      onTerminalReferencesReleased:
        (descriptors.onTerminalReferencesReleasedForTests?.value as
          | NonNullable<RuntimeSnapshot['onTerminalReferencesReleased']>
          | undefined) ?? null,
    });
  } catch {
    return null;
  }
}

function snapshotHostRoom(value: unknown): Readonly<FilePlaybackProductHostRoomAuthority> | null {
  const snapshot = snapshotExactRecord(value, HOST_ROOM_KEYS);
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    !Number.isSafeInteger(snapshot.roomGeneration) ||
    (snapshot.roomGeneration as number) <= 0 ||
    !isFilePlaybackSessionId(snapshot.applicationSessionId) ||
    !isFilePlaybackSessionId(snapshot.hostParticipantId)
  ) {
    return null;
  }
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: snapshot.roomGeneration as number,
    applicationSessionId: snapshot.applicationSessionId,
    hostParticipantId: snapshot.hostParticipantId,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  Reflect.apply(trustedAbortThrowIfAborted, signal, []);
}

function readAbortReason(signal: AbortSignal): unknown {
  return trustedAbortReason ? Reflect.apply(trustedAbortReason, signal, []) : undefined;
}

function abortController(controller: AbortController, reason?: unknown): void {
  Reflect.apply(trustedAbortControllerAbort, controller, [reason]);
}

function addAbortListener(signal: AbortSignal, listener: EventListener): void {
  Reflect.apply(trustedEventTargetAdd, signal, ['abort', listener, { once: true }]);
}

function removeAbortListener(signal: AbortSignal, listener: EventListener): void {
  Reflect.apply(trustedEventTargetRemove, signal, ['abort', listener]);
}

async function awaitAbortableNativeTask<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort: EventListener = () => {
    try {
      rejectAbort(readAbortReason(signal));
    } catch (error) {
      rejectAbort(error);
    }
  };
  addAbortListener(signal, abort);
  const raced = Promise.race([task, aborted]);
  try {
    throwIfAborted(signal);
    return await raced;
  } finally {
    removeAbortListener(signal, abort);
  }
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

function containsCleanupFailure(value: unknown): boolean {
  if (value instanceof ProductHostRoomCleanupError) return true;
  return value instanceof AggregateError && value.errors.some(containsCleanupFailure);
}

function mergeCleanupFailure(current: unknown, next: unknown): unknown {
  return current === null
    ? next
    : new AggregateError([current, next], 'Multiple product host-room cleanup operations failed');
}

function isEnginePort(
  value: unknown,
  structural: boolean,
): value is FilePlaybackProductHostFirstEnginePort {
  if (!structural && !(value instanceof FilePlaybackHostFirstFileEngine)) return false;
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<FilePlaybackProductHostFirstEnginePort>;
  return (
    typeof candidate.startFirstLocalFile === 'function' &&
    typeof candidate.warmLocalTrack === 'function' &&
    typeof candidate.clearWarmLocalTrack === 'function' &&
    typeof candidate.resolveWarmPeerRangeSource === 'function' &&
    typeof candidate.startLocalTrack === 'function' &&
    typeof candidate.prepareLocalTrack === 'function' &&
    typeof candidate.preparePlayingSeek === 'function' &&
    typeof candidate.prepareResumeCurrent === 'function' &&
    typeof candidate.prepareReplayCurrent === 'function' &&
    typeof candidate.startPreparedLocalTrack === 'function' &&
    typeof candidate.resolvePreparedPeerRangeSource === 'function' &&
    typeof candidate.pauseCurrent === 'function' &&
    typeof candidate.seekPlaying === 'function' &&
    typeof candidate.seekPaused === 'function' &&
    typeof candidate.resumeCurrent === 'function' &&
    typeof candidate.replayCurrent === 'function' &&
    typeof candidate.stopCurrent === 'function' &&
    typeof candidate.settleEndedCurrent === 'function' &&
    typeof candidate.currentPeerPublication === 'function' &&
    typeof candidate.resolveCurrentPeerRangeSource === 'function' &&
    typeof candidate.recoverRemoteParticipant === 'function' &&
    typeof candidate.close === 'function' &&
    typeof candidate.currentRendererSnapshot === 'function' &&
    typeof candidate.positionAt === 'function'
  );
}

function assertBodyFree(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    throw new TypeError('File playback product result contained an encoded or native body');
  }
  if (seen.has(value)) return;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.hasOwn(descriptor, 'value')) assertBodyFree(descriptor.value, seen);
  }
}

function validateAudioContext(value: unknown): asserts value is AudioContext {
  if (
    value === null ||
    typeof value !== 'object' ||
    (value as Partial<AudioContext>).state !== 'running' ||
    typeof (value as Partial<AudioContext>).sampleRate !== 'number'
  ) {
    throw new Error('File playback product audio context is not running');
  }
}

function validateDestination(
  value: unknown,
  audioContext: AudioContext,
): asserts value is AudioNode {
  if (
    value === null ||
    typeof value !== 'object' ||
    (value as Partial<AudioNode>).context !== audioContext ||
    typeof (value as Partial<AudioNode>).connect !== 'function'
  ) {
    throw new Error('File playback product destination is missing or belongs to another context');
  }
}

function readSignalOptions(value: unknown, keys: readonly string[], label: string): AbortSignal {
  const input = snapshotExactRecord(value, keys);
  if (!input || !(input.signal instanceof AbortSignal)) {
    throw new TypeError(`Product ${label} options are invalid`);
  }
  return input.signal;
}

function readSeekOptions(
  value: unknown,
  label: string,
  keys: readonly string[] = SEEK_KEYS,
): Readonly<{ positionSeconds: number; signal: AbortSignal }> {
  const input = snapshotExactRecord(value, keys);
  if (
    !input ||
    !(input.signal instanceof AbortSignal) ||
    typeof input.positionSeconds !== 'number' ||
    !Number.isFinite(input.positionSeconds) ||
    input.positionSeconds < 0
  ) {
    throw new TypeError(`Product ${label} options are invalid`);
  }
  return freezeCanonical({ positionSeconds: input.positionSeconds, signal: input.signal });
}

function readFileIntent(
  value: unknown,
  keys: readonly string[],
  defaultPositionSeconds?: number,
): FileIntent {
  const input = snapshotExactRecord(value, keys);
  const positionSeconds = defaultPositionSeconds ?? input?.positionSeconds;
  if (
    !input ||
    !isQueueItemId(input.queueItemId) ||
    typeof File === 'undefined' ||
    !(input.file instanceof File) ||
    !(input.signal instanceof AbortSignal) ||
    typeof positionSeconds !== 'number' ||
    !Number.isFinite(positionSeconds) ||
    positionSeconds < 0
  ) {
    throw new TypeError('Product local track options are invalid');
  }
  const file = input.file;
  return Object.freeze({
    queueItemId: input.queueItemId,
    file,
    name: file.name,
    mime: file.type,
    size: file.size,
    lastModified: file.lastModified,
    positionSeconds,
    signal: input.signal,
  });
}

/**
 * Product-only owner for one exact host room's complete local-file renderer lifetime.
 *
 * The facade owns one engine and one graph binding until room close. Track changes
 * are engine candidate cutovers, while pause/seek/resume/stop/end remain physical
 * operations on that same authority. Peer publication and connection-scoped
 * recovery are forwarded without initializing or retaining another audio graph.
 */
export class FilePlaybackProductHostRoom {
  readonly #lifecycleLease: FilePlaybackUniversalLifecycleLease;
  readonly #controller: FilePlaybackApplicationController;
  readonly #hostRoom: Readonly<FilePlaybackProductHostRoomAuthority>;
  readonly #boundedRoutePolicy: Readonly<FilePlaybackBoundedRoutePolicy> | null;
  readonly #roomClock: FilePlaybackRoomClock;
  readonly #roomToken: object;
  readonly #onFatalRoom: (error: Error) => void;
  readonly #onTransitionScheduled:
    | ((event: Readonly<HostCurrentPlaybackTransitionScheduledEvent>) => void)
    | null;
  readonly #onRemoteEndRequired: ((event: Readonly<HostRemoteEndRequiredEvent>) => void) | null;
  readonly #onTimelineCommitted:
    | ((event: Readonly<HostCurrentPlaybackTimelineCommittedEvent>) => void)
    | null;
  readonly #runtime: RuntimeSnapshot;
  readonly #operations = new Set<RoomOperation>();
  readonly #issuedWarmSourceLeases = new WeakSet<object>();
  #engineRecord: EngineRecord | null = null;
  #initPromise: Promise<void> | null = null;
  #graphPromise: Promise<AudioRuntime> | null = null;
  #audioRuntime: AudioRuntime | null = null;
  #candidateOperation: RoomOperation | null = null;
  #transitionOperation: RoomOperation | null = null;
  #closed = false;
  #fatalError: Error | null = null;
  #fatalNotified = false;
  #closePromise: Promise<void> | null = null;
  #referencesReleased = false;

  constructor(options: FilePlaybackProductHostRoomOptions) {
    const input = snapshotOptions(options);
    const hostRoom = snapshotHostRoom(input?.hostRoomSnapshot);
    const runtime = runtimeSnapshot(input?.runtimeForTests);
    if (!input || !hostRoom || !runtime) {
      throw new TypeError('File playback product host room options are invalid');
    }
    const boundedRoutePolicy =
      input.boundedRoutePolicy === undefined
        ? null
        : snapshotFilePlaybackBoundedRoutePolicy(input.boundedRoutePolicy);
    if (!isExactController(input.controller)) {
      throw new TypeError('File playback product host room requires the exact controller');
    }
    if (
      typeof input.onFatalRoom !== 'function' ||
      (input.onTransitionScheduled !== undefined &&
        typeof input.onTransitionScheduled !== 'function') ||
      (input.onRemoteEndRequired !== undefined &&
        typeof input.onRemoteEndRequired !== 'function') ||
      (input.onTimelineCommitted !== undefined && typeof input.onTimelineCommitted !== 'function')
    ) {
      throw new TypeError('File playback product host room callback is invalid');
    }
    const roomClock = input.roomClock ?? getFilePlaybackRoomClock();
    if (!isExactRoomClock(roomClock)) {
      throw new TypeError('File playback product host room requires the exact room clock');
    }
    const roomToken = Reflect.apply(runtime.createRoomToken, undefined, []);
    if (roomToken === null || typeof roomToken !== 'object' || claimedRoomTokens.has(roomToken)) {
      throw new TypeError('File playback product room token factory returned an invalid token');
    }
    claimedRoomTokens.add(roomToken);

    this.#controller = input.controller;
    this.#hostRoom = hostRoom;
    this.#boundedRoutePolicy = boundedRoutePolicy;
    this.#roomClock = roomClock;
    this.#roomToken = roomToken;
    this.#onFatalRoom = input.onFatalRoom as (error: Error) => void;
    this.#onTransitionScheduled =
      (input.onTransitionScheduled as
        | ((event: Readonly<HostCurrentPlaybackTransitionScheduledEvent>) => void)
        | undefined) ?? null;
    this.#onRemoteEndRequired =
      (input.onRemoteEndRequired as
        | ((event: Readonly<HostRemoteEndRequiredEvent>) => void)
        | undefined) ?? null;
    this.#onTimelineCommitted =
      (input.onTimelineCommitted as
        | ((event: Readonly<HostCurrentPlaybackTimelineCommittedEvent>) => void)
        | undefined) ?? null;
    this.#runtime = runtime;
    this.#assertRoomAuthority();
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (timeline.phase !== 'stopped' || timeline.run !== null) {
      throw new Error('File playback product host room requires stopped initial authority');
    }
    this.#lifecycleLease = acquireFilePlaybackUniversalLifecycleLease('roomOwners');
  }

  warmLocalTrack(
    options: WarmFilePlaybackProductHostLocalTrackOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackWarmResult>> {
    let intent: FileIntent;
    try {
      intent = readFileIntent(options, FIRST_FILE_KEYS, 0);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueuePeer(intent.signal, async (operation) => {
      const audioRuntime = await this.#prepareGraph(operation);
      this.#assertOperationReady(operation);
      const record = await this.#getOrCreateEngine(operation);
      this.#assertOperationReady(operation);
      const result = await record.engine.warmLocalTrack({
        queueItemId: intent.queueItemId,
        blob: intent.file,
        name: intent.name,
        mime: intent.mime,
        audioContext: audioRuntime.audioContext,
        decodeOrdinaryAudio: this.#runtime.decodeOrdinaryAudio,
        signal: operation.controller.signal,
      });
      this.#assertOperationReady(operation);
      return this.#projectWarmResult(result, intent);
    });
  }

  clearWarmLocalTrack(
    options: ClearFilePlaybackProductHostLocalTrackWarmOptions,
  ): Promise<boolean> {
    const input = snapshotExactRecord(options, CLEAR_WARM_TRACK_KEYS);
    if (!input || !isQueueItemId(input.queueItemId) || !(input.signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError('Product local track warm clear options are invalid'));
    }
    return this.#enqueuePeer(input.signal, async (operation) => {
      this.#assertOperationReady(operation);
      const record = this.#engineRecord;
      if (!record) return false;
      const cleared = await record.engine.clearWarmLocalTrack({
        queueItemId: input.queueItemId as QueueItemId,
      });
      this.#assertOperationReady(operation);
      if (typeof cleared !== 'boolean') {
        throw new TypeError('File playback product host engine returned an invalid warm clear');
      }
      return cleared;
    });
  }

  clearWarmLocalTrackByLease(
    options: ClearFilePlaybackProductHostLocalTrackWarmByLeaseOptions,
  ): Promise<boolean> {
    const input = snapshotExactRecord(options, CLEAR_WARM_TRACK_BY_LEASE_KEYS);
    if (
      !input ||
      !(input.signal instanceof AbortSignal) ||
      input.sourceLease === null ||
      typeof input.sourceLease !== 'object'
    ) {
      return Promise.reject(
        new TypeError('Product exact local track warm clear options are invalid'),
      );
    }
    const sourceLease = input.sourceLease as HostLocalTrackSourceLease;
    if (!this.#issuedWarmSourceLeases.has(sourceLease)) {
      return Promise.reject(new Error('Product warm source lease was not issued by this room'));
    }
    return this.#enqueuePeer(input.signal, async (operation) => {
      const record = this.#requireEngine(operation);
      const cleared = await record.engine.clearWarmLocalTrack({ sourceLease });
      this.#assertOperationReady(operation);
      if (typeof cleared !== 'boolean') {
        throw new TypeError('File playback product host engine returned an invalid warm clear');
      }
      return cleared;
    });
  }

  resolveWarmPeerRangeSource(
    options: ResolveWarmHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource> {
    const input = snapshotExactRecord(options, RESOLVE_WARM_PEER_SOURCE_KEYS);
    if (
      !input ||
      !(input.signal instanceof AbortSignal) ||
      typeof input.sourceIdentity !== 'string' ||
      (input.peerRangeManifest !== null &&
        (typeof input.peerRangeManifest !== 'object' || input.peerRangeManifest === null)) ||
      input.sourceLease === null ||
      typeof input.sourceLease !== 'object'
    ) {
      return Promise.reject(new TypeError('Product warm peer-range source options are invalid'));
    }
    const sourceLease = input.sourceLease as HostLocalTrackSourceLease;
    if (!this.#issuedWarmSourceLeases.has(sourceLease)) {
      return Promise.reject(new Error('Product warm source lease was not issued by this room'));
    }
    const record = this.#engineRecord;
    if (!record) {
      return Promise.reject(new Error('File playback product host renderer is unavailable'));
    }
    const signal = input.signal;
    const sourceIdentity = input.sourceIdentity;
    return (async () => {
      this.#assertWarmSourceRoomReady(record, signal);
      const source = await record.engine.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity,
        peerRangeManifest:
          input.peerRangeManifest as Readonly<HostPeerRangeManifestPublication> | null,
        signal,
      });
      try {
        this.#assertWarmSourceRoomReady(record, signal);
        return source;
      } catch (error) {
        if (!(source instanceof Blob)) {
          try {
            await source.close();
          } catch {
            // The stale room/peer authority remains the primary rejection.
          }
        }
        throw error;
      }
    })();
  }

  startFirstLocalFile(
    options: StartFilePlaybackProductHostFirstLocalFileOptions,
  ): Promise<Readonly<FilePlaybackProductHostFirstLocalFileCommit>> {
    let intent: FileIntent;
    try {
      intent = readFileIntent(options, FIRST_FILE_KEYS, 0);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueueCandidate(intent.signal, async (operation) =>
      this.#startTrackWithCohort(operation, intent, async () => []),
    );
  }

  startLocalTrack(
    options: StartFilePlaybackProductHostLocalTrackOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    let intent: FileIntent;
    try {
      intent = readFileIntent(options, TRACK_KEYS);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueueCandidate(intent.signal, async (operation) =>
      this.#startTrackWithCohort(operation, intent, async () => []),
    );
  }

  startLocalTrackWithCohort(
    options: StartFilePlaybackProductHostLocalTrackWithCohortOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    const input = snapshotExactRecord(options, COHORT_TRACK_KEYS);
    let intent: FileIntent;
    if (!input || typeof input.prepareRemoteParticipants !== 'function') {
      return Promise.reject(new TypeError('Product local track cohort options are invalid'));
    }
    try {
      intent = readFileIntent(options, COHORT_TRACK_KEYS);
    } catch (error) {
      return Promise.reject(error);
    }
    const prepareRemoteParticipants =
      input.prepareRemoteParticipants as PrepareFilePlaybackProductHostRemoteParticipants;
    return this.#enqueueCandidate(intent.signal, async (operation) =>
      this.#startTrackWithCohort(operation, intent, prepareRemoteParticipants),
    );
  }

  pauseCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    return this.#enqueueCurrent(options, 'pause', (engine, signal) =>
      engine.pauseCurrent({ signal }),
    );
  }

  seekPlaying(
    options: FilePlaybackProductHostSeekOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    let input: Readonly<{ positionSeconds: number; signal: AbortSignal }>;
    try {
      input = readSeekOptions(options, 'playing seek');
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueueCandidate(input.signal, async (operation) => {
      const record = this.#requireEngine(operation);
      return this.#invokeCandidate(operation, null, () =>
        record.engine.seekPlaying({
          positionSeconds: input.positionSeconds,
          signal: operation.controller.signal,
        }),
      );
    });
  }

  seekPlayingWithCohort(
    options: FilePlaybackProductHostSeekWithCohortOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    const input = snapshotExactRecord(options, COHORT_SEEK_KEYS);
    let seek: Readonly<{ positionSeconds: number; signal: AbortSignal }>;
    if (!input || typeof input.prepareRemoteParticipants !== 'function') {
      return Promise.reject(new TypeError('Product playing seek cohort options are invalid'));
    }
    try {
      seek = readSeekOptions(options, 'playing seek cohort', COHORT_SEEK_KEYS);
    } catch (error) {
      return Promise.reject(error);
    }
    const prepareRemoteParticipants =
      input.prepareRemoteParticipants as PrepareFilePlaybackProductHostRemoteParticipants;
    return this.#enqueueCandidate(seek.signal, async (operation) => {
      const record = this.#requireEngine(operation);
      return this.#startPreparedCandidateWithCohort({
        operation,
        record,
        expectedQueueItemId: null,
        prepare: () =>
          record.engine.preparePlayingSeek({
            positionSeconds: seek.positionSeconds,
            signal: operation.controller.signal,
          }),
        prepareRemoteParticipants,
        resolveSource: async () => {
          throw new Error('Same-run state successor must reuse its current source binding');
        },
      });
    });
  }

  seekPaused(
    options: FilePlaybackProductHostSeekOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    let input: Readonly<{ positionSeconds: number; signal: AbortSignal }>;
    try {
      input = readSeekOptions(options, 'paused seek');
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueueTransition(input.signal, async (operation) => {
      const record = this.#requireEngine(operation);
      return this.#invokeTransition(operation, 'seek', () =>
        record.engine.seekPaused({
          positionSeconds: input.positionSeconds,
          signal: operation.controller.signal,
        }),
      );
    });
  }

  resumeCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    return this.#enqueueCandidateCurrent(options, 'resume', (engine, signal) =>
      engine.resumeCurrent({ signal }),
    );
  }

  resumeCurrentWithCohort(
    options: FilePlaybackProductHostCurrentWithCohortOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    const input = snapshotExactRecord(options, COHORT_CURRENT_KEYS);
    let signal: AbortSignal;
    if (!input || typeof input.prepareRemoteParticipants !== 'function') {
      return Promise.reject(new TypeError('Product resume cohort options are invalid'));
    }
    try {
      signal = readSignalOptions(options, COHORT_CURRENT_KEYS, 'resume cohort');
    } catch (error) {
      return Promise.reject(error);
    }
    const prepareRemoteParticipants =
      input.prepareRemoteParticipants as PrepareFilePlaybackProductHostRemoteParticipants;
    return this.#enqueueCandidate(signal, async (operation) => {
      const record = this.#requireEngine(operation);
      return this.#startPreparedCandidateWithCohort({
        operation,
        record,
        expectedQueueItemId: null,
        prepare: () =>
          record.engine.prepareResumeCurrent({
            signal: operation.controller.signal,
          }),
        prepareRemoteParticipants,
        resolveSource: async () => {
          throw new Error('Same-run resume must reuse its current source binding');
        },
      });
    });
  }

  replayCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    return this.#enqueueCandidateCurrent(options, 'replay', (engine, signal) =>
      engine.replayCurrent({ signal }),
    );
  }

  replayCurrentWithCohort(
    options: FilePlaybackProductHostCurrentWithCohortOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    const input = snapshotExactRecord(options, COHORT_CURRENT_KEYS);
    let signal: AbortSignal;
    if (!input || typeof input.prepareRemoteParticipants !== 'function') {
      return Promise.reject(new TypeError('Product replay cohort options are invalid'));
    }
    try {
      signal = readSignalOptions(options, COHORT_CURRENT_KEYS, 'replay cohort');
    } catch (error) {
      return Promise.reject(error);
    }
    const prepareRemoteParticipants =
      input.prepareRemoteParticipants as PrepareFilePlaybackProductHostRemoteParticipants;
    return this.#enqueueCandidate(signal, async (operation) => {
      const record = this.#requireEngine(operation);
      return this.#startPreparedCandidateWithCohort({
        operation,
        record,
        expectedQueueItemId: null,
        prepare: () =>
          record.engine.prepareReplayCurrent({
            signal: operation.controller.signal,
          }),
        prepareRemoteParticipants,
        resolveSource: async (
          prepared: Readonly<HostPreparedLocalTrack>,
          sourceIdentity: string,
          peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null,
          sourceSignal: AbortSignal,
        ): Promise<HostPeerRangeSource> => {
          if (
            typeof sourceIdentity !== 'string' ||
            (peerRangeManifest !== null &&
              (typeof peerRangeManifest !== 'object' || peerRangeManifest === null)) ||
            !(sourceSignal instanceof AbortSignal)
          ) {
            throw new TypeError('Product prepared replay peer-range source identity is invalid');
          }
          this.#assertPreparedSourceRoomReady(record, sourceSignal);
          const source = await record.engine.resolvePreparedPeerRangeSource({
            prepared,
            sourceIdentity,
            peerRangeManifest,
            signal: sourceSignal,
          });
          try {
            this.#assertPreparedSourceRoomReady(record, sourceSignal);
            return source;
          } catch (error) {
            if (!(source instanceof Blob)) {
              try {
                await source.close();
              } catch {
                // The stale room/peer authority remains the primary rejection.
              }
            }
            throw error;
          }
        },
      });
    });
  }

  stopCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    return this.#enqueueCurrent(options, 'stop', (engine, signal) =>
      engine.stopCurrent({ signal }),
    );
  }

  settleEndedCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    return this.#enqueueCurrent(options, 'ended', (engine, signal) =>
      engine.settleEndedCurrent({ signal }),
    );
  }

  currentPeerPublication(): Readonly<HostPeerPlaybackPublication> | null {
    try {
      const record = this.#engineRecord;
      if (!record || !this.#hasProjectionAuthority()) return null;
      const publication = record.engine.currentPeerPublication();
      if (!publication || !this.#hasProjectionAuthority()) return null;
      assertBodyFree(publication);
      return publication;
    } catch {
      return null;
    }
  }

  resolveCurrentPeerRangeSource(
    options: ResolveHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource> {
    const input = snapshotExactRecord(options, RESOLVE_PEER_SOURCE_KEYS);
    if (
      !input ||
      !(input.signal instanceof AbortSignal) ||
      typeof input.sourceIdentity !== 'string' ||
      (input.peerRangeManifest !== null &&
        (typeof input.peerRangeManifest !== 'object' || input.peerRangeManifest === null))
    ) {
      return Promise.reject(new TypeError('Product host peer-range source options are invalid'));
    }
    return this.#enqueuePeer(input.signal, async (operation) => {
      const record = this.#requireEngine(operation);
      const source = await record.engine.resolveCurrentPeerRangeSource({
        publication: input.publication as Readonly<HostPeerPlaybackPublication>,
        sourceIdentity: input.sourceIdentity as string,
        peerRangeManifest:
          input.peerRangeManifest as Readonly<HostPeerRangeManifestPublication> | null,
        signal: operation.controller.signal,
      });
      try {
        this.#assertOperationReady(operation);
        return source;
      } catch (error) {
        if (!(source instanceof Blob)) {
          try {
            await source.close();
          } catch {
            // The stale room authority remains the primary rejection.
          }
        }
        throw error;
      }
    });
  }

  recoverRemoteParticipant(
    options: RecoverHostRemoteParticipantOptions,
  ): Promise<Readonly<HostRemoteRecoveryCommit>> {
    const input = snapshotExactRecord(options, RECOVER_REMOTE_KEYS);
    if (
      !input ||
      !(input.signal instanceof AbortSignal) ||
      typeof input.bindAttempt !== 'function'
    ) {
      return Promise.reject(new TypeError('Product host remote recovery options are invalid'));
    }
    return this.#enqueuePeer(input.signal, async (operation) => {
      const record = this.#requireEngine(operation);
      const commit = await record.engine.recoverRemoteParticipant({
        publication: input.publication as Readonly<HostPeerPlaybackPublication>,
        participant: input.participant as RecoverHostRemoteParticipantOptions['participant'],
        signal: operation.controller.signal,
        bindAttempt: input.bindAttempt as RecoverHostRemoteParticipantOptions['bindAttempt'],
      });
      this.#assertOperationReady(operation);
      assertBodyFree(commit);
      return commit;
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;

    let resolveClose!: () => void;
    let rejectClose!: (reason: unknown) => void;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    // Publish terminal identity before aborting a renderer or invoking any
    // engine-owned callback. Both boundaries may synchronously re-enter close.
    this.#closePromise = closePromise;
    this.#closed = true;
    const operations = [...this.#operations];
    let synchronousFailure: unknown = null;
    for (const operation of operations) {
      try {
        abortController(operation.controller, new Error('File playback product host room closed'));
      } catch (error) {
        synchronousFailure = mergeCleanupFailure(synchronousFailure, error);
      }
    }
    const record = this.#engineRecord;
    let engineClose: Promise<void> | null = null;
    if (record) {
      try {
        engineClose = record.engine.close();
      } catch (error) {
        engineClose = Promise.reject(error);
      }
    }
    const cleanup = this.#closeOwnedRoom(operations, engineClose, synchronousFailure);
    void confirmFilePlaybackUniversalLifecycleRetirement(this.#lifecycleLease, () => cleanup);
    void cleanup.then(resolveClose, rejectClose);
    return closePromise;
  }

  currentRendererSnapshot(): FilePlaybackSourceSnapshot | null {
    const record = this.#engineRecord;
    if (!record || !this.#hasProjectionAuthority()) return null;
    const snapshot = record.engine.currentRendererSnapshot();
    return snapshot && this.#matchesTimeline(snapshot) && this.#hasProjectionAuthority()
      ? snapshot
      : null;
  }

  currentTerminalRendererObservation(): FilePlaybackProductHostTerminalObservation | null {
    try {
      const record = this.#engineRecord;
      if (!record || !this.#hasProjectionAuthority()) return null;
      const snapshot = record.engine.currentRendererSnapshot();
      return snapshot &&
        this.#matchesTerminalTimeline(snapshot) &&
        this.#hasProjectionAuthority() &&
        this.#matchesTerminalTimeline(snapshot)
        ? snapshot
        : null;
    } catch {
      return null;
    }
  }

  currentFailedRendererObservation(): FilePlaybackProductHostFailureObservation | null {
    try {
      const record = this.#engineRecord;
      if (!record || !this.#hasProjectionAuthority()) return null;
      const snapshot = record.engine.currentRendererSnapshot();
      return snapshot &&
        this.#matchesFailedTimeline(snapshot) &&
        this.#hasProjectionAuthority() &&
        this.#matchesFailedTimeline(snapshot)
        ? snapshot
        : null;
    } catch {
      return null;
    }
  }

  positionAt(localPerformanceTimeMs: number): FilePlaybackPosition | null {
    if (
      typeof localPerformanceTimeMs !== 'number' ||
      !Number.isFinite(localPerformanceTimeMs) ||
      localPerformanceTimeMs < 0
    ) {
      return null;
    }
    const record = this.#engineRecord;
    if (!record || !this.#hasProjectionAuthority()) return null;
    const position = record.engine.positionAt(localPerformanceTimeMs);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    return position &&
      timeline.run &&
      position.run &&
      position.queueItemId === timeline.run.queueItemId &&
      position.run.runId === timeline.run.runId &&
      position.run.revision === timeline.revision &&
      this.#hasProjectionAuthority()
      ? position
      : null;
  }

  #enqueueCandidateCurrent(
    options: FilePlaybackProductHostCurrentOptions,
    label: string,
    invoke: (
      engine: FilePlaybackProductHostFirstEnginePort,
      signal: AbortSignal,
    ) => Promise<Readonly<HostFirstLocalFilePlaybackCommit>>,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    let signal: AbortSignal;
    try {
      signal = readSignalOptions(options, CURRENT_KEYS, label);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueueCandidate(signal, async (operation) => {
      const record = this.#requireEngine(operation);
      return this.#invokeCandidate(operation, null, () =>
        invoke(record.engine, operation.controller.signal),
      );
    });
  }

  #enqueueCurrent(
    options: FilePlaybackProductHostCurrentOptions,
    kind: HostCurrentPlaybackTransitionCommit['kind'],
    invoke: (
      engine: FilePlaybackProductHostFirstEnginePort,
      signal: AbortSignal,
    ) => Promise<Readonly<HostCurrentPlaybackTransitionCommit>>,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    let signal: AbortSignal;
    try {
      signal = readSignalOptions(options, CURRENT_KEYS, kind);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueueTransition(signal, async (operation) => {
      const record = this.#requireEngine(operation);
      return this.#invokeTransition(operation, kind, () =>
        invoke(record.engine, operation.controller.signal),
      );
    });
  }

  #enqueueCandidate<T>(
    externalSignal: AbortSignal,
    execute: (operation: RoomOperation) => Promise<T>,
  ): Promise<T> {
    if (this.#transitionOperation) {
      return Promise.reject(
        new Error('Product host candidate conflicts with an active renderer transition'),
      );
    }
    const predecessor = this.#candidateOperation;
    const created = this.#createOperation(externalSignal);
    if (!created.operation) return created.failure as Promise<T>;
    const operation = created.operation;
    this.#candidateOperation = operation;
    if (predecessor) {
      try {
        abortController(predecessor.controller, new Error('Product host candidate was superseded'));
      } catch (error) {
        operation.cleanupFailure = error;
        this.#quarantine(asError(error, 'Product host candidate supersession failed'));
      }
    }
    return this.#executeOperation(operation, predecessor?.settlement ?? null, execute, 'candidate');
  }

  #enqueueTransition<T>(
    externalSignal: AbortSignal,
    execute: (operation: RoomOperation) => Promise<T>,
  ): Promise<T> {
    if (this.#candidateOperation || this.#transitionOperation) {
      return Promise.reject(new Error('Product host renderer transition is busy'));
    }
    const created = this.#createOperation(externalSignal);
    if (!created.operation) return created.failure as Promise<T>;
    const operation = created.operation;
    this.#transitionOperation = operation;
    return this.#executeOperation(operation, null, execute, 'transition');
  }

  #enqueuePeer<T>(
    externalSignal: AbortSignal,
    execute: (operation: RoomOperation) => Promise<T>,
  ): Promise<T> {
    const created = this.#createOperation(externalSignal);
    if (!created.operation) return created.failure as Promise<T>;
    return this.#executeOperation(created.operation, null, execute, 'peer');
  }

  #createOperation(externalSignal: AbortSignal): Readonly<{
    operation: RoomOperation | null;
    failure: Promise<never> | null;
  }> {
    if (!(externalSignal instanceof AbortSignal)) {
      return Object.freeze({
        operation: null,
        failure: Promise.reject(new TypeError('Product host operation requires an AbortSignal')),
      });
    }
    if (this.#closed) {
      return Object.freeze({
        operation: null,
        failure: Promise.reject(
          this.#fatalError ?? new Error('File playback product host room is closed'),
        ),
      });
    }
    try {
      throwIfAborted(externalSignal);
    } catch (error) {
      return Object.freeze({ operation: null, failure: Promise.reject(error) });
    }
    const controller = new AbortController();
    const forwardAbort: EventListener = () => {
      let reason: unknown;
      try {
        reason = readAbortReason(externalSignal);
      } catch (error) {
        reason = error;
      }
      try {
        abortController(controller, reason);
      } catch {
        // The exact operation still revalidates the external signal before
        // every authority boundary; a broken platform abort cannot publish.
      }
    };
    try {
      addAbortListener(externalSignal, forwardAbort);
      // Close the add-listener race for a signal which aborted between the
      // first throwIfAborted() and listener registration.
      throwIfAborted(externalSignal);
    } catch (error) {
      try {
        removeAbortListener(externalSignal, forwardAbort);
      } catch {
        // No room-owned operation has been published yet.
      }
      return Object.freeze({ operation: null, failure: Promise.reject(error) });
    }
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const operation: RoomOperation = {
      controller,
      externalSignal,
      removeExternalAbort: () => removeAbortListener(externalSignal, forwardAbort),
      settlement,
      settle,
      cleanupFailure: null,
    };
    this.#operations.add(operation);
    return Object.freeze({ operation, failure: null });
  }

  #executeOperation<T>(
    operation: RoomOperation,
    predecessor: Promise<void> | null,
    execute: (operation: RoomOperation) => Promise<T>,
    kind: 'candidate' | 'transition' | 'peer',
  ): Promise<T> {
    const task = (async () => {
      if (predecessor) await predecessor;
      try {
        this.#assertOperationReady(operation);
        return await execute(operation);
      } catch (error) {
        if (containsCleanupFailure(error)) {
          operation.cleanupFailure = mergeCleanupFailure(operation.cleanupFailure, error);
        }
        throw error;
      } finally {
        try {
          operation.removeExternalAbort();
        } catch {
          // The trusted EventTarget method should not fail for an AbortSignal.
          // Authority removal and settlement remain terminal either way.
        } finally {
          this.#operations.delete(operation);
          if (kind === 'candidate' && this.#candidateOperation === operation) {
            this.#candidateOperation = null;
          }
          if (kind === 'transition' && this.#transitionOperation === operation) {
            this.#transitionOperation = null;
          }
          operation.settle();
        }
      }
    })();
    return task;
  }

  async #startTrackWithCohort(
    operation: RoomOperation,
    intent: FileIntent,
    prepareRemoteParticipants: PrepareFilePlaybackProductHostRemoteParticipants,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    const audioRuntime = await this.#prepareGraph(operation);
    this.#assertOperationReady(operation);
    const record = await this.#getOrCreateEngine(operation);
    this.#assertOperationReady(operation);
    return this.#startPreparedCandidateWithCohort({
      operation,
      record,
      expectedQueueItemId: intent.queueItemId,
      prepare: () =>
        record.engine.prepareLocalTrack({
          queueItemId: intent.queueItemId,
          blob: intent.file,
          name: intent.name,
          mime: intent.mime,
          positionSeconds: intent.positionSeconds,
          audioContext: audioRuntime.audioContext,
          destination: audioRuntime.destination,
          decodeOrdinaryAudio: this.#runtime.decodeOrdinaryAudio,
          signal: operation.controller.signal,
        }),
      prepareRemoteParticipants,
      resolveSource: async (
        prepared: Readonly<HostPreparedLocalTrack>,
        sourceIdentity: string,
        peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null,
        signal: AbortSignal,
      ): Promise<HostPeerRangeSource> => {
        if (
          typeof sourceIdentity !== 'string' ||
          (peerRangeManifest !== null &&
            (typeof peerRangeManifest !== 'object' || peerRangeManifest === null)) ||
          !(signal instanceof AbortSignal)
        ) {
          throw new TypeError('Product prepared peer-range source identity is invalid');
        }
        this.#assertPreparedSourceRoomReady(record, signal);
        const source = await record.engine.resolvePreparedPeerRangeSource({
          prepared,
          sourceIdentity,
          peerRangeManifest,
          signal,
        });
        try {
          this.#assertPreparedSourceRoomReady(record, signal);
          return source;
        } catch (error) {
          if (!(source instanceof Blob)) {
            try {
              await source.close();
            } catch {
              // The stale room/peer authority remains the primary rejection.
            }
          }
          throw error;
        }
      },
    });
  }

  async #startPreparedCandidateWithCohort(
    input: Readonly<{
      operation: RoomOperation;
      record: EngineRecord;
      expectedQueueItemId: QueueItemId | null;
      prepare: () => Promise<Readonly<HostPreparedLocalTrack>>;
      prepareRemoteParticipants: PrepareFilePlaybackProductHostRemoteParticipants;
      resolveSource: (
        prepared: Readonly<HostPreparedLocalTrack>,
        sourceIdentity: string,
        peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null,
        signal: AbortSignal,
      ) => Promise<HostPeerRangeSource>;
    }>,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    const { operation, record, expectedQueueItemId, prepareRemoteParticipants, resolveSource } =
      input;
    const prepared = await input.prepare();
    this.#assertOperationReady(operation);
    assertBodyFree(prepared);
    try {
      const context = freezeCanonical({
        prepared,
        signal: operation.controller.signal,
        resolveSource: (
          sourceIdentity: string,
          peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null,
          signal: AbortSignal,
        ) => resolveSource(prepared, sourceIdentity, peerRangeManifest, signal),
      });
      this.#assertOperationReady(operation);
      const cohortTask = Reflect.apply(prepareRemoteParticipants, undefined, [context]) as unknown;
      if (!(cohortTask instanceof Promise)) {
        throw new TypeError('Product remote cohort preparation must return a native Promise');
      }
      const remoteParticipants = await awaitAbortableNativeTask(
        cohortTask,
        operation.controller.signal,
      );
      this.#assertOperationReady(operation);
      if (!Array.isArray(remoteParticipants)) {
        throw new TypeError('Product remote cohort preparation returned an invalid cohort');
      }
      return await this.#invokeCandidate(operation, expectedQueueItemId, () =>
        record.engine.startPreparedLocalTrack({
          prepared,
          remoteParticipants,
        }),
      );
    } catch (cause) {
      try {
        abortController(operation.controller, cause);
      } catch (cleanupFailure) {
        const error = new ProductHostRoomCleanupError(
          'Prepared product host candidate cleanup failed',
          new AggregateError([cause, cleanupFailure], 'Prepared candidate cleanup failed'),
        );
        this.#quarantine(error);
        throw error;
      }
      throw cause;
    }
  }

  async #prepareGraph(operation: RoomOperation): Promise<AudioRuntime> {
    if (this.#audioRuntime) return this.#audioRuntime;
    if (!this.#initPromise) {
      let resolveInit!: () => void;
      let rejectInit!: (reason: unknown) => void;
      const pendingInit = new Promise<void>((resolve, reject) => {
        resolveInit = resolve;
        rejectInit = reject;
      });
      this.#initPromise = pendingInit;
      // The sentinel is installed before an injected/runtime callback can
      // re-enter room close or supersede this operation.
      void Promise.resolve()
        .then(() => {
          this.#assertOperationReady(operation);
          return this.#runtime.initAudio();
        })
        .then(resolveInit, rejectInit);
      void pendingInit.catch(() => {
        if (this.#initPromise === pendingInit && !this.#closed) this.#initPromise = null;
      });
    }
    await this.#initPromise;
    this.#assertOperationReady(operation);
    if (this.#audioRuntime) return this.#audioRuntime;
    if (!this.#graphPromise) {
      let resolveGraph!: (runtime: AudioRuntime) => void;
      let rejectGraph!: (reason: unknown) => void;
      const pending = new Promise<AudioRuntime>((resolve, reject) => {
        resolveGraph = resolve;
        rejectGraph = reject;
      });
      this.#graphPromise = pending;
      void (async () => {
        this.#assertOperationReady(operation);
        await this.#runtime.ensureRunning();
        this.#assertOperationReady(operation);
        const audioContext = this.#runtime.getAudioContext();
        this.#assertOperationReady(operation);
        validateAudioContext(audioContext);
        const destination = this.#runtime.getFilePlaybackDestination();
        this.#assertOperationReady(operation);
        validateDestination(destination, audioContext);
        return Object.freeze({ audioContext, destination });
      })().then(resolveGraph, rejectGraph);
      void pending.catch(() => {
        if (this.#graphPromise === pending && !this.#closed) this.#graphPromise = null;
      });
    }
    const runtime = await this.#graphPromise;
    this.#assertOperationReady(operation);
    if (!this.#audioRuntime) this.#audioRuntime = runtime;
    return this.#audioRuntime;
  }

  async #getOrCreateEngine(operation: RoomOperation): Promise<EngineRecord> {
    if (this.#engineRecord) return this.#engineRecord;
    this.#assertOperationReady(operation);
    const token = Object.freeze(Object.create(null) as object);
    let pendingFatal: Error | null = null;
    const engine = this.#runtime.createEngine({
      controller: this.#controller,
      roomGeneration: this.#hostRoom.roomGeneration,
      applicationScopeId: this.#hostRoom.applicationSessionId,
      roomToken: this.#roomToken,
      roomClock: this.#roomClock,
      hostParticipantId: this.#hostRoom.hostParticipantId,
      ...(this.#boundedRoutePolicy ? { boundedRoutePolicy: this.#boundedRoutePolicy } : {}),
      onFatalRoom: (error) => {
        if (this.#engineRecord?.token === token) this.#handleEngineFatal(token, error);
        else pendingFatal = asError(error, 'File playback product host engine failed');
      },
      ...(this.#onTransitionScheduled
        ? { onTransitionScheduled: this.#onTransitionScheduled }
        : {}),
      ...(this.#onRemoteEndRequired ? { onRemoteEndRequired: this.#onRemoteEndRequired } : {}),
      ...(this.#onTimelineCommitted ? { onTimelineCommitted: this.#onTimelineCommitted } : {}),
    });
    if (!isEnginePort(engine, this.#runtime.allowStructuralEngine)) {
      throw new TypeError('File playback product host engine factory returned an invalid engine');
    }
    try {
      if (pendingFatal) throw pendingFatal;
      this.#assertOperationReady(operation);
      if (this.#engineRecord !== null) {
        throw new Error('File playback product engine was installed during factory re-entry');
      }
    } catch (cause) {
      let cleanupFailure: unknown = null;
      try {
        await engine.close();
      } catch (error) {
        cleanupFailure = error;
      }
      if (pendingFatal) this.#quarantine(pendingFatal);
      if (cleanupFailure !== null) {
        throw new ProductHostRoomCleanupError(
          'Stale product host engine candidate cleanup failed',
          new AggregateError([cause, cleanupFailure], 'Candidate cleanup failed after re-entry'),
        );
      }
      throw cause;
    }
    const record = Object.freeze({ token, engine });
    this.#engineRecord = record;
    return record;
  }

  #requireEngine(operation: RoomOperation): EngineRecord {
    this.#assertOperationReady(operation);
    const record = this.#engineRecord;
    if (!record) throw new Error('File playback product host renderer is unavailable');
    return record;
  }

  async #invokeCandidate(
    operation: RoomOperation,
    expectedQueueItemId: QueueItemId | null,
    invoke: () => Promise<Readonly<HostFirstLocalFilePlaybackCommit>>,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    this.#assertOperationReady(operation);
    const commit = await invoke();
    try {
      return this.#projectCandidateCommit(commit, expectedQueueItemId);
    } catch (cause) {
      this.#quarantine(asError(cause, 'File playback product candidate failed after commit'));
      throw cause;
    }
  }

  async #invokeTransition(
    operation: RoomOperation,
    kind: HostCurrentPlaybackTransitionCommit['kind'],
    invoke: () => Promise<Readonly<HostCurrentPlaybackTransitionCommit>>,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    this.#assertOperationReady(operation);
    const commit = await invoke();
    try {
      return this.#projectTransitionCommit(commit, kind);
    } catch (cause) {
      this.#quarantine(asError(cause, 'File playback product transition failed after commit'));
      throw cause;
    }
  }

  #projectCandidateCommit(
    commit: Readonly<HostFirstLocalFilePlaybackCommit>,
    expectedQueueItemId: QueueItemId | null,
  ): Readonly<FilePlaybackProductHostLocalTrackCommit> {
    if (!commit || typeof commit !== 'object') {
      throw new TypeError('File playback product host engine returned an invalid commit');
    }
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    const queueItemId = expectedQueueItemId ?? timeline.run?.queueItemId ?? null;
    if (
      !queueItemId ||
      commit.schemaVersion !== 1 ||
      commit.roomGeneration !== this.#hostRoom.roomGeneration ||
      commit.attempt?.queueItemId !== queueItemId ||
      commit.timeline !== timeline ||
      timeline.phase !== 'playing' ||
      timeline.run?.queueItemId !== queueItemId ||
      timeline.run.runId !== commit.attempt.runId ||
      timeline.revision !== commit.attempt.revision ||
      commit.asset?.queueItemId !== queueItemId
    ) {
      throw new Error('File playback product host engine commit did not match room truth');
    }
    const result = freezeCanonical({
      schemaVersion: 1 as const,
      status: 'committed' as const,
      roomGeneration: commit.roomGeneration,
      applicationSessionId: this.#hostRoom.applicationSessionId,
      hostParticipantId: this.#hostRoom.hostParticipantId,
      backend: commit.backend,
      asset: commit.asset,
      attempt: commit.attempt,
      schedule: commit.schedule,
      startEvidence: commit.startEvidence,
      timeline: commit.timeline,
    });
    assertBodyFree(result);
    this.#assertRoomAuthority(true);
    return result;
  }

  #projectWarmResult(
    result: Readonly<HostLocalTrackWarmResult>,
    intent: FileIntent,
  ): Readonly<FilePlaybackProductHostLocalTrackWarmResult> {
    const expectedMime = intent.mime.trim().length === 0 ? 'application/octet-stream' : intent.mime;
    const sourceLeaseDescriptor =
      result && typeof result === 'object'
        ? Object.getOwnPropertyDescriptor(result, 'sourceLease')
        : undefined;
    const hasExactSourceLease =
      sourceLeaseDescriptor?.enumerable === true && Object.hasOwn(sourceLeaseDescriptor, 'value');
    const sourceLease = hasExactSourceLease ? sourceLeaseDescriptor.value : undefined;
    if (
      !result ||
      typeof result !== 'object' ||
      result.schemaVersion !== 1 ||
      result.roomGeneration !== this.#hostRoom.roomGeneration ||
      (result.status !== 'warmed' && result.status !== 'skipped-non-bounded') ||
      (result.status === 'warmed' && result.backend !== 'bounded-stream') ||
      (result.status === 'skipped-non-bounded' && result.backend === 'bounded-stream') ||
      !hasExactSourceLease ||
      (result.status === 'warmed'
        ? sourceLease === null || typeof sourceLease !== 'object'
        : sourceLease !== null) ||
      result.asset?.binding?.queueItemId !== intent.queueItemId ||
      result.asset?.metadata?.name !== intent.name ||
      result.asset?.metadata?.mime !== expectedMime ||
      result.asset?.encodedSize !== intent.size
    ) {
      throw new Error('File playback product host warm result did not match room intent');
    }
    const projected = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: result.roomGeneration,
      applicationSessionId: this.#hostRoom.applicationSessionId,
      hostParticipantId: this.#hostRoom.hostParticipantId,
      status: result.status,
      backend: result.backend,
      asset: result.asset,
      readiness: result.readiness,
      sourceLease: sourceLease as HostLocalTrackSourceLease | null,
    });
    assertBodyFree(projected);
    this.#assertRoomAuthority();
    if (projected.sourceLease) this.#issuedWarmSourceLeases.add(projected.sourceLease);
    return projected;
  }

  #projectTransitionCommit(
    commit: Readonly<HostCurrentPlaybackTransitionCommit>,
    expectedKind: HostCurrentPlaybackTransitionCommit['kind'],
  ): Readonly<FilePlaybackProductHostTransitionCommit> {
    if (!commit || typeof commit !== 'object') {
      throw new TypeError('File playback product host engine returned an invalid transition');
    }
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    const expectedPhase =
      expectedKind === 'pause' || expectedKind === 'seek' ? 'paused' : 'stopped';
    if (
      commit.schemaVersion !== 1 ||
      commit.kind !== expectedKind ||
      commit.roomGeneration !== this.#hostRoom.roomGeneration ||
      commit.timeline !== timeline ||
      timeline.phase !== expectedPhase ||
      (expectedPhase === 'stopped' ? timeline.run !== null : timeline.run === null)
    ) {
      throw new Error('File playback product host transition did not match room truth');
    }
    const result = freezeCanonical({
      schemaVersion: 1 as const,
      status: 'committed' as const,
      kind: commit.kind,
      roomGeneration: commit.roomGeneration,
      applicationSessionId: this.#hostRoom.applicationSessionId,
      hostParticipantId: this.#hostRoom.hostParticipantId,
      evidence: commit.evidence,
      timeline: commit.timeline,
    });
    assertBodyFree(result);
    this.#assertRoomAuthority(true);
    return result;
  }

  #assertOperationReady(operation: RoomOperation): void {
    throwIfAborted(operation.externalSignal);
    throwIfAborted(operation.controller.signal);
    if (this.#closed || !this.#operations.has(operation)) {
      throw this.#fatalError ?? new Error('File playback product operation was superseded');
    }
    this.#assertRoomAuthority();
    throwIfAborted(operation.externalSignal);
    throwIfAborted(operation.controller.signal);
  }

  #assertPreparedSourceRoomReady(record: EngineRecord, signal: AbortSignal): void {
    throwIfAborted(signal);
    if (this.#closed || this.#engineRecord !== record) {
      throw this.#fatalError ?? new Error('File playback product prepared source room is stale');
    }
    this.#assertRoomAuthority();
    throwIfAborted(signal);
    if (this.#closed || this.#engineRecord !== record) {
      throw this.#fatalError ?? new Error('File playback product prepared source room changed');
    }
  }

  #assertWarmSourceRoomReady(record: EngineRecord, signal: AbortSignal): void {
    throwIfAborted(signal);
    if (this.#closed || this.#engineRecord !== record) {
      throw this.#fatalError ?? new Error('File playback product warm source room is stale');
    }
    this.#assertRoomAuthority();
    throwIfAborted(signal);
    if (this.#closed || this.#engineRecord !== record) {
      throw this.#fatalError ?? new Error('File playback product warm source room changed');
    }
  }

  #assertRoomAuthority(allowClosed = false): void {
    this.#assertClockAuthority();
    const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (
      (!allowClosed && this.#closed) ||
      snapshot.roomGeneration !== this.#hostRoom.roomGeneration ||
      snapshot.roomRole !== 'host' ||
      snapshot.timeline !== timeline
    ) {
      throw this.#fatalError ?? new Error('File playback product host room authority is stale');
    }
    this.#assertClockAuthority();
  }

  #assertClockAuthority(): void {
    const role = Reflect.apply(trustedRoomClockRole, this.#roomClock, []);
    const now = Reflect.apply(trustedRoomClockNow, this.#roomClock, []);
    if (role !== 'host' || !Number.isFinite(now) || now < 0) {
      throw new Error('File playback product host room clock authority is stale');
    }
  }

  #hasProjectionAuthority(): boolean {
    try {
      if (this.#closed || !this.#engineRecord) return false;
      this.#assertRoomAuthority();
      const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
      return timeline.phase !== 'stopped' && timeline.run !== null;
    } catch {
      return false;
    }
  }

  #matchesTimeline(snapshot: FilePlaybackSourceSnapshot): boolean {
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    return (
      timeline.run !== null &&
      snapshot.queueItemId === timeline.run.queueItemId &&
      snapshot.run?.runId === timeline.run.runId &&
      snapshot.run.revision === timeline.revision &&
      snapshot.phase === timeline.phase
    );
  }

  #matchesTerminalTimeline(
    snapshot: FilePlaybackSourceSnapshot,
  ): snapshot is FilePlaybackProductHostTerminalObservation {
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    return (
      timeline.phase === 'playing' &&
      timeline.run !== null &&
      snapshot.phase === 'ended' &&
      snapshot.run !== null &&
      snapshot.queueItemId === timeline.run.queueItemId &&
      snapshot.run.queueItemId === timeline.run.queueItemId &&
      snapshot.run.runId === timeline.run.runId &&
      snapshot.revision === timeline.revision &&
      snapshot.run.revision === timeline.revision
    );
  }

  #matchesFailedTimeline(
    snapshot: FilePlaybackSourceSnapshot,
  ): snapshot is FilePlaybackProductHostFailureObservation {
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    return (
      timeline.phase === 'playing' &&
      timeline.run !== null &&
      snapshot.phase === 'failed' &&
      snapshot.run !== null &&
      snapshot.queueItemId === timeline.run.queueItemId &&
      snapshot.run.queueItemId === timeline.run.queueItemId &&
      snapshot.run.runId === timeline.run.runId &&
      snapshot.revision === timeline.revision &&
      snapshot.run.revision === timeline.revision
    );
  }

  #handleEngineFatal(token: object, value: unknown): void {
    const record = this.#engineRecord;
    if (!record || record.token !== token || this.#fatalError) return;
    this.#quarantine(asError(value, 'File playback product host engine failed'));
  }

  #quarantine(error: Error): void {
    if (this.#fatalError) return;
    this.#fatalError = error;
    const cleanup = this.close();
    void cleanup.then(
      () => this.#notifyFatalOnce(error),
      () => this.#notifyFatalOnce(error),
    );
  }

  #notifyFatalOnce(error: Error): void {
    if (this.#fatalNotified) return;
    this.#fatalNotified = true;
    try {
      this.#onFatalRoom(error);
    } catch {
      // Owner notification is terminal and must not produce an unhandled task.
    }
  }

  async #closeOwnedRoom(
    operations: readonly RoomOperation[],
    engineClose: Promise<void> | null,
    synchronousFailure: unknown,
  ): Promise<void> {
    let failure: unknown = synchronousFailure;
    const settlements = await Promise.allSettled([
      Promise.all(operations.map((operation) => operation.settlement)),
      engineClose ?? Promise.resolve(),
      Promise.all([
        this.#initPromise ?? Promise.resolve(),
        this.#graphPromise ?? Promise.resolve(),
      ]),
    ]);
    for (const operation of operations) {
      if (operation.cleanupFailure !== null) {
        failure = mergeCleanupFailure(failure, operation.cleanupFailure);
      }
    }
    const engineSettlement = settlements[1];
    if (engineSettlement?.status === 'rejected') {
      failure = mergeCleanupFailure(failure, engineSettlement.reason);
    }
    this.#engineRecord = null;
    this.#audioRuntime = null;
    this.#initPromise = null;
    this.#graphPromise = null;
    this.#candidateOperation = null;
    this.#transitionOperation = null;
    this.#operations.clear();
    this.#releaseReferencesOnce();
    if (failure !== null) throw failure;
  }

  #releaseReferencesOnce(): void {
    if (this.#referencesReleased) return;
    this.#referencesReleased = true;
    try {
      this.#runtime.onTerminalReferencesReleased?.(
        freezeCanonical({
          activeTaskRetained: false as const,
          engineRetained: false as const,
          fileRetained: false as const,
        }),
      );
    } catch {
      // A test/diagnostic observer cannot weaken terminal native cleanup.
    }
  }
}
