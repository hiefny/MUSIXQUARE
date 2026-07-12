import type { QueueItemId } from '../types/index.ts';
import {
  FilePlaybackApplicationController,
  type FilePlaybackHostStartedPlaybackCommit,
} from './file-playback-application-controller.ts';
import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetBinding,
  type FilePlaybackAssetLease,
  type FilePlaybackAssetSnapshot,
} from './file-playback-asset-registry.ts';
import type { FilePlaybackClockBindings } from './file-playback-clock.ts';
import {
  startLocalFilePlayback,
  type FilePlaybackLocalStartCoordinatorRuntimeForTests,
  type LocalFilePlaybackSchedule,
  type StartedLocalFilePlayback,
} from './file-playback-local-start-coordinator.ts';
import {
  FilePlaybackManager,
  isExactFilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from './file-playback-manager.ts';
import { createFilePlaybackMediaScope } from './file-playback-media-scope.ts';
import { createFilePlaybackRunId } from './file-playback-run-binding.ts';
import { FilePlaybackRoomClock } from './file-playback-room-clock.ts';
import type {
  FilePlaybackBackend,
  FilePlaybackPosition,
  FilePlaybackSourceSnapshot,
  FilePlaybackStartEvidence,
} from './file-playback-source.ts';
import type { OrdinaryAudioDecoder } from './file-playback-source-factory.ts';
import {
  createPlaybackStateIdentity,
  type PlaybackAttemptIdentity,
  type PlaybackStateIdentity,
} from './playback-identity.ts';
import type { PlaybackTimelineSnapshot } from './playback-timeline.ts';
import { isQueueItemId } from './queue-model.ts';
import { HostRendezvousCoordinator } from './rendezvous-coordinator.ts';

const DEFAULT_MIME = 'application/octet-stream';
const MAX_APPLICATION_SCOPE_ID_LENGTH = 128;
const MAX_PARTICIPANT_ID_LENGTH = 256;
const OPTION_KEYS = Object.freeze([
  'controller',
  'roomGeneration',
  'applicationScopeId',
  'roomToken',
  'roomClock',
  'hostParticipantId',
  'onFatalRoom',
  'runtimeForTests',
] as const);
const REQUIRED_OPTION_KEYS = OPTION_KEYS.filter((key) => key !== 'runtimeForTests');
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
const CURRENT_OPERATION_KEYS = Object.freeze(['signal'] as const);
const SEEK_PLAYING_KEYS = Object.freeze(['positionSeconds', 'signal'] as const);
const RUNTIME_KEYS = Object.freeze([
  'createRunIdForTests',
  'localStartRuntimeForTests',
  'beforeControllerCommitForTests',
  'onTerminalReferencesReleasedForTests',
  'createManagerForTests',
  'createRendezvousIdForTests',
  'fatalAfterAdmissionForTests',
  'onCoordinatorClosedForTests',
] as const);

type ExactRecord = Readonly<Record<string, unknown>>;

export interface FilePlaybackHostFirstFileEngineRuntimeForTests {
  /** Deterministic boundary seam. Product code always uses createFilePlaybackRunId(). */
  readonly createRunIdForTests?: () => string;
  readonly localStartRuntimeForTests?: FilePlaybackLocalStartCoordinatorRuntimeForTests;
  readonly beforeControllerCommitForTests?: () => void;
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
  readonly onFatalRoom: (error: Error) => void;
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

export interface HostCurrentPlaybackOperationOptions {
  readonly signal: AbortSignal;
}

export interface SeekHostPlayingOptions extends HostCurrentPlaybackOperationOptions {
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

interface RuntimeSnapshot {
  readonly createRunId: () => string;
  readonly localStartRuntime: FilePlaybackLocalStartCoordinatorRuntimeForTests | undefined;
  readonly beforeControllerCommit: (() => void) | null;
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
}

interface AdmittedLocalFile {
  readonly queueItemId: QueueItemId;
  readonly blob: Blob;
  readonly name: string;
  readonly mime: string;
  readonly binding: Readonly<FilePlaybackAssetBinding>;
  readonly lease: FilePlaybackAssetLease;
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

interface CandidateAudioRuntime {
  readonly audioContext: AudioContext;
  readonly destination: AudioNode;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly clockBindings: FilePlaybackClockBindings;
}

interface BeginCandidateOperationInput extends CandidateAudioRuntime {
  readonly action: CandidateAction;
  readonly previousTimeline: PlaybackTimelineSnapshot;
  readonly expectedCurrentPort: FilePlaybackCutoverCandidatePort | null;
  readonly asset: AdmittedLocalFile;
  readonly runId: string;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly signal: AbortSignal;
}

interface ActiveStartOperation {
  readonly epoch: number;
  readonly action: CandidateAction;
  readonly previousTimeline: PlaybackTimelineSnapshot;
  readonly expectedCurrentPort: FilePlaybackCutoverCandidatePort | null;
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal;
  readonly removeExternalAbort: () => void;
  commitDominant: boolean;
  published: boolean;
  task: Promise<Readonly<HostFirstLocalFilePlaybackCommit>> | null;
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
  FilePlaybackApplicationController.prototype.commitHostStartedPlayback;
const trustedManagerCurrentPort = FilePlaybackManager.prototype.currentCutoverPort;
const trustedManagerSnapshot = FilePlaybackManager.prototype.snapshot;
const trustedManagerClear = FilePlaybackManager.prototype.clear;
const trustedManagerRetireCandidate = FilePlaybackManager.prototype.retireCutoverCandidate;
const trustedManagerRetireCurrent = FilePlaybackManager.prototype.retireCurrentCutover;
const trustedManagerCurrentSnapshot = FilePlaybackManager.prototype.currentCutoverSnapshot;
const trustedManagerCurrentPosition = FilePlaybackManager.prototype.currentCutoverPosition;
const trustedRoomClockRole = FilePlaybackRoomClock.prototype.role;
const trustedRoomClockNow = FilePlaybackRoomClock.prototype.nowRoomTimeMs;
const trustedRoomClockBind = FilePlaybackRoomClock.prototype.bindAudioContext;
const trustedAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const trustedRendezvousCoordinatorClose = HostRendezvousCoordinator.prototype.close;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
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
      beforeControllerCommit: null,
      onTerminalReferencesReleased: null,
      createManager: () => new FilePlaybackManager(),
      createRendezvousId: () => createFilePlaybackRunId(),
      fatalAfterAdmission: false,
      onCoordinatorClosed: null,
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
    const localStartRuntime = descriptors.localStartRuntimeForTests?.value;
    const onTerminalReferencesReleased = descriptors.onTerminalReferencesReleasedForTests?.value;
    const createManager = descriptors.createManagerForTests?.value;
    const createRendezvousId = descriptors.createRendezvousIdForTests?.value;
    const fatalAfterAdmission = descriptors.fatalAfterAdmissionForTests?.value;
    const onCoordinatorClosed = descriptors.onCoordinatorClosedForTests?.value;
    if (
      (createRunId !== undefined && typeof createRunId !== 'function') ||
      (beforeControllerCommit !== undefined && typeof beforeControllerCommit !== 'function') ||
      (onTerminalReferencesReleased !== undefined &&
        typeof onTerminalReferencesReleased !== 'function') ||
      (createManager !== undefined && typeof createManager !== 'function') ||
      (createRendezvousId !== undefined && typeof createRendezvousId !== 'function') ||
      (fatalAfterAdmission !== undefined && typeof fatalAfterAdmission !== 'boolean') ||
      (onCoordinatorClosed !== undefined && typeof onCoordinatorClosed !== 'function') ||
      (localStartRuntime !== undefined &&
        (localStartRuntime === null || typeof localStartRuntime !== 'object'))
    ) {
      return null;
    }
    return freezeCanonical({
      createRunId: (createRunId as (() => string) | undefined) ?? (() => createFilePlaybackRunId()),
      localStartRuntime: localStartRuntime as
        | FilePlaybackLocalStartCoordinatorRuntimeForTests
        | undefined,
      beforeControllerCommit: (beforeControllerCommit as (() => void) | undefined) ?? null,
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
 * This intentionally has no peer publication or room-wide participant set.
 * Multi-peer rendezvous remains a later product slice; this class accepts only
 * a claimed host controller with zero active guest connections. The historical
 * class name and startFirstLocalFile method remain as compatibility surfaces;
 * one instance now owns the complete local-host room renderer lifetime.
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
  readonly #onFatalRoom: (error: Error) => void;
  readonly #runtime: RuntimeSnapshot;
  readonly #registry: FilePlaybackAssetRegistry;
  readonly #initialTimeline: PlaybackTimelineSnapshot;
  readonly #assets = new Map<QueueItemId, AdmittedLocalFile>();
  readonly #ownedPorts = new Set<FilePlaybackCutoverCandidatePort>();
  readonly #portRetirements = new Map<FilePlaybackCutoverCandidatePort, Promise<void>>();
  #audioContext: AudioContext | null = null;
  #destination: AudioNode | null = null;
  #clockBindings: FilePlaybackClockBindings | null = null;
  #decodeOrdinaryAudio: OrdinaryAudioDecoder | null = null;
  #legacyFirstQueueItemId: QueueItemId | null = null;
  #pendingNewRun: PendingNewRun | null = null;
  #committedPort: FilePlaybackCutoverCandidatePort | null = null;
  #operationEpoch = 0;
  #activeOperation: ActiveStartOperation | null = null;
  #startingSynchronously = false;
  #closed = false;
  #fatalError: Error | null = null;
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
    if (typeof input.onFatalRoom !== 'function') {
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
      controllerSnapshot.activeConnectionCount !== 0 ||
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
    this.#onFatalRoom = input.onFatalRoom as (error: Error) => void;
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
      return this.#beginCandidateOperation({
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
    });
  }

  replayCurrent(
    options: HostCurrentPlaybackOperationOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    return this.#runSynchronousCandidateStart(() => {
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
      return this.#beginCandidateOperation({
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
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#operationEpoch += 1;
    const coordinatorFailure = this.#closeCoordinatorOnce();
    if (this.#closePromise) return this.#closePromise;
    const active = this.#activeOperation;
    if (active && !active.commitDominant) {
      active.controller.abort(new Error('Host first-file room closed'));
    }
    this.#closePromise = this.#closeOwnedRoom(active?.task ?? null, coordinatorFailure);
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

  #captureTimeline(action: CandidateAction): PlaybackTimelineSnapshot {
    if (this.#activeOperation?.commitDominant) {
      throw new Error(`Host ${action} cannot supersede a physical renderer commit`);
    }
    this.#assertRoomClockAuthority();
    const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (
      this.#closed ||
      this.#fatalError ||
      snapshot.roomGeneration !== this.#roomGeneration ||
      snapshot.roomRole !== 'host' ||
      snapshot.activeConnectionCount !== 0 ||
      snapshot.timeline !== timeline ||
      timeline.revision === Number.MAX_SAFE_INTEGER
    ) {
      throw this.#fatalError ?? new Error(`Host ${action} room authority is stale`);
    }
    this.#assertRoomClockAuthority();
    return timeline;
  }

  #startFileCandidate(
    action: 'first' | 'track',
    input: Readonly<CanonicalFileCandidateInput>,
    previousTimeline: PlaybackTimelineSnapshot,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
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
    return this.#beginCandidateOperation({
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
    input: Readonly<CanonicalFileCandidateInput>,
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
      return existing;
    }
    this.#assertTimelineAuthority(previousTimeline, false);
    const scope = createFilePlaybackMediaScope(this.#applicationScopeId, input.queueItemId);
    const binding = freezeCanonical({ queueItemId: input.queueItemId, ...scope });
    const lease = this.#registry.admitBlob(this.#roomToken, binding, input.blob, {
      name: input.name,
      mime: input.mime,
    });
    const admitted = Object.freeze({
      queueItemId: input.queueItemId,
      blob: input.blob,
      name: input.name,
      mime: input.mime,
      binding,
      lease,
    });
    this.#assets.set(input.queueItemId, admitted);
    if (this.#runtime.fatalAfterAdmission) {
      this.#handleRegistryFatal(new Error('Fixture registry fatal after admission'));
    }
    return admitted;
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
    input: Readonly<BeginCandidateOperationInput>,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    const previousOperation = this.#activeOperation;
    if (previousOperation?.commitDominant) {
      throw new Error('Host renderer physical commit cannot be superseded');
    }
    throwIfAborted(input.signal);
    this.#operationEpoch += 1;
    const operationController = new AbortController();
    const forwardExternalAbort = () => operationController.abort(input.signal.reason);
    input.signal.addEventListener('abort', forwardExternalAbort, { once: true });
    const operation: ActiveStartOperation = {
      epoch: this.#operationEpoch,
      action: input.action,
      previousTimeline: input.previousTimeline,
      expectedCurrentPort: input.expectedCurrentPort,
      controller: operationController,
      externalSignal: input.signal,
      removeExternalAbort: () => input.signal.removeEventListener('abort', forwardExternalAbort),
      commitDominant: false,
      published: false,
      task: null,
    };
    this.#activeOperation = operation;
    previousOperation?.controller.abort(new Error('Host local file candidate was superseded'));
    if (input.signal.aborted) forwardExternalAbort();
    const task = this.#executeCandidateStart(operation, input);
    operation.task = task;
    return task;
  }

  async #executeCandidateStart(
    operation: ActiveStartOperation,
    input: Readonly<BeginCandidateOperationInput>,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    let started: Readonly<StartedLocalFilePlayback> | null = null;
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
      const task = startLocalFilePlayback({
        registry: this.#registry,
        roomToken: this.#roomToken,
        assetLease: input.asset.lease,
        expectedBinding: input.asset.binding,
        manager: this.#manager,
        audioContext: input.audioContext,
        destination: input.destination,
        clockBindings: input.clockBindings,
        signal: operation.controller.signal,
        isCurrent: () => this.#candidateAuthorityAllows(operation, playbackState),
        decodeOrdinaryAudio: input.decodeOrdinaryAudio,
        playbackState,
        positionSeconds: input.positionSeconds,
        playbackRate: input.playbackRate,
        participantId: this.#hostParticipantId,
        rttP95Ms: 0,
        armP95Ms: 0,
        rendezvousCoordinator: this.#rendezvousCoordinator,
        ...(this.#runtime.localStartRuntime
          ? { runtimeForTests: this.#runtime.localStartRuntime }
          : {}),
      });
      this.#assertOperationFence(operation);
      started = await task;
      this.#ownedPorts.add(started.port);
      operation.commitDominant = true;
      this.#assertCommitFence(operation, started.port);

      this.#runtime.beforeControllerCommit?.();
      this.#assertCommitFence(operation, started.port);
      const committed = Reflect.apply(trustedControllerCommit, this.#controller, [
        {
          roomGeneration: this.#roomGeneration,
          expectedPreviousRevision: operation.previousTimeline.revision,
          attempt: started.attempt,
          schedule: started.schedule,
          startEvidence: started.startEvidence,
        },
      ]) as Readonly<FilePlaybackHostStartedPlaybackCommit>;
      if (
        committed.previous !== operation.previousTimeline ||
        committed.timeline.revision !== started.attempt.revision ||
        committed.timeline.anchorMonotonicMs !== started.schedule.startAtRoomTimeMs ||
        committed.timeline.positionSeconds !== started.schedule.positionSeconds ||
        committed.timeline.rate !== started.schedule.playbackRate ||
        committed.timeline.run?.queueItemId !== input.asset.queueItemId ||
        committed.timeline.run.runId !== input.runId
      ) {
        throw new Error('Host local file timeline commit did not match physical start');
      }
      operation.published = true;
      this.#committedPort = started.port;
      if (
        this.#pendingNewRun?.queueItemId === input.asset.queueItemId &&
        this.#pendingNewRun.runId === input.runId &&
        this.#pendingNewRun.positionSeconds === input.positionSeconds
      ) {
        this.#pendingNewRun = null;
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
      if (started) this.#quarantineAfterPhysicalFailure(error);
      throw error;
    } finally {
      operation.removeExternalAbort();
      if (this.#activeOperation === operation) this.#activeOperation = null;
    }
  }

  #assertTimelineAuthority(
    expectedTimeline: PlaybackTimelineSnapshot,
    allowClosingCommit: boolean,
  ): void {
    this.#assertRoomClockAuthority();
    const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (
      (!allowClosingCommit && (this.#closed || this.#coordinatorClosed)) ||
      this.#fatalError ||
      snapshot.roomGeneration !== this.#roomGeneration ||
      snapshot.roomRole !== 'host' ||
      snapshot.activeConnectionCount !== 0 ||
      snapshot.timeline !== timeline ||
      timeline !== expectedTimeline
    ) {
      throw this.#fatalError ?? new Error('Host local-file room authority is stale');
    }
    this.#assertRoomClockAuthority();
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
        snapshot.activeConnectionCount === 0 &&
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

  #candidateAuthorityAllows(
    operation: ActiveStartOperation,
    playbackState: PlaybackStateIdentity,
  ): boolean {
    try {
      if (this.#activeOperation === operation && this.#operationEpoch === operation.epoch) {
        if (operation.commitDominant) {
          this.#assertTimelineAuthority(operation.previousTimeline, true);
        } else {
          this.#assertOperationFence(operation);
        }
        return true;
      }
      if (!operation.published || this.#closed || this.#coordinatorClosed || this.#fatalError) {
        return false;
      }
      this.#assertRoomClockAuthority();
      const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
      const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
      return (
        snapshot.roomGeneration === this.#roomGeneration &&
        snapshot.roomRole === 'host' &&
        snapshot.activeConnectionCount === 0 &&
        snapshot.timeline === timeline &&
        timeline.phase !== 'stopped' &&
        timeline.run?.queueItemId === playbackState.queueItemId &&
        timeline.run.runId === playbackState.runId
      );
    } catch {
      return false;
    }
  }

  #assertCommitFence(
    operation: ActiveStartOperation,
    promotedPort: FilePlaybackCutoverCandidatePort,
  ): void {
    if (
      !operation.commitDominant ||
      this.#activeOperation !== operation ||
      this.#operationEpoch !== operation.epoch
    ) {
      throw new Error('Host local file physical commit authority was superseded');
    }
    this.#assertTimelineAuthority(operation.previousTimeline, true);
    if (currentPort(this.#manager) !== promotedPort) {
      throw new Error('Host local file lost its exact promoted renderer');
    }
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
    activeTask: Promise<Readonly<HostFirstLocalFilePlaybackCommit>> | null,
    coordinatorFailure: unknown,
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
    this.#operationEpoch += 1;
    const coordinatorFailure = this.#closeCoordinatorOnce();
    this.#activeOperation?.controller.abort(error);
    if (!this.#closePromise) {
      // Never make terminal cleanup await the task that is currently invoking
      // this quarantine path. The promoted renderer is already manager truth;
      // closeOwnedRoom owns its exact retirement through #ownedPorts.
      this.#closePromise = this.#closeOwnedRoom(null, coordinatorFailure);
      observe(this.#closePromise);
    }
    this.#notifyFatalAfterTerminalCleanup(this.#fatalError);
  }

  #handleRegistryFatal(error: Error): void {
    if (!this.#fatalError) this.#fatalError = error;
    this.#closed = true;
    this.#operationEpoch += 1;
    const coordinatorFailure = this.#closeCoordinatorOnce();
    this.#activeOperation?.controller.abort(error);
    if (!this.#closePromise) {
      this.#closePromise = this.#closeOwnedRoom(
        this.#activeOperation?.task ?? null,
        coordinatorFailure,
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
