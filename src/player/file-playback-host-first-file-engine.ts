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
import { createPlaybackStateIdentity, type PlaybackAttemptIdentity } from './playback-identity.ts';
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

interface AdmittedFirstFile {
  readonly queueItemId: QueueItemId;
  readonly blob: Blob;
  readonly name: string;
  readonly mime: string;
  readonly binding: Readonly<FilePlaybackAssetBinding>;
  readonly lease: FilePlaybackAssetLease;
  readonly runId: string;
}

interface ActiveStartOperation {
  readonly epoch: number;
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal;
  readonly removeExternalAbort: () => void;
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

function mergeCleanupFailure(current: unknown, next: unknown): unknown {
  if (current === null) return next;
  return new AggregateError([current, next], 'Multiple host first-file cleanup operations failed');
}

function containsCleanupFailure(value: unknown): boolean {
  if (value instanceof HostFirstFileCleanupError) return true;
  return value instanceof AggregateError && value.errors.some(containsCleanupFailure);
}

/**
 * One-room, host-only first vertical slice for V2 file playback.
 *
 * This intentionally has no peer publication or room-wide participant set.
 * Multi-peer rendezvous remains a later product slice; this class accepts only
 * a claimed host controller with zero active guest connections. One instance
 * owns exactly one logical queue asset. Product intent replacement must close
 * it and construct a fresh instance instead of changing its asset identity.
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
  readonly #baselineTimeline: PlaybackTimelineSnapshot;
  readonly #ownedPorts = new Set<FilePlaybackCutoverCandidatePort>();
  readonly #portRetirements = new Map<FilePlaybackCutoverCandidatePort, Promise<void>>();
  #audioContext: AudioContext | null = null;
  #destination: AudioNode | null = null;
  #clockBindings: FilePlaybackClockBindings | null = null;
  #asset: AdmittedFirstFile | null = null;
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
    this.#baselineTimeline = baselineTimeline;
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
    if (this.#startingSynchronously) {
      return Promise.reject(new Error('Host first-file start re-entered synchronous admission'));
    }
    this.#startingSynchronously = true;
    try {
      const input = snapshotExactRecord(options, START_KEYS);
      if (!input) throw new TypeError('Host first local file options are invalid');
      if (this.#closed) throw this.#fatalError ?? new Error('Host first-file engine is closed');
      if (!isQueueItemId(input.queueItemId)) {
        throw new TypeError('Host first local file queue item ID is invalid');
      }
      if (!(input.blob instanceof Blob)) {
        throw new TypeError('Host first local file body must be a Blob or File');
      }
      if (typeof input.name !== 'string' || typeof input.mime !== 'string') {
        throw new TypeError('Host first local file metadata is invalid');
      }
      if (
        input.audioContext === null ||
        typeof input.audioContext !== 'object' ||
        input.destination === null ||
        typeof input.destination !== 'object' ||
        typeof input.decodeOrdinaryAudio !== 'function'
      ) {
        throw new TypeError('Host first local file audio graph is invalid');
      }
      if (!(input.signal instanceof AbortSignal)) {
        throw new TypeError('Host first local file requires an exact AbortSignal');
      }
      throwIfAborted(input.signal);
      this.#assertStoppedRoomFence();
      if (currentPort(this.#manager) !== null) {
        throw new Error('Host first local file cannot replace an audible renderer');
      }

      const audioContext = input.audioContext as AudioContext;
      const destination = input.destination as AudioNode;
      if (this.#audioContext && this.#audioContext !== audioContext) {
        throw new Error('Host first-file room AudioContext cannot change');
      }
      if (this.#destination && this.#destination !== destination) {
        throw new Error('Host first-file room destination cannot change');
      }
      const clockBindings =
        this.#clockBindings ?? Reflect.apply(trustedRoomClockBind, this.#roomClock, [audioContext]);
      if (clockBindings === null || typeof clockBindings !== 'object') {
        throw new TypeError('Host first-file room clock returned invalid bindings');
      }
      this.#assertStoppedRoomFence();
      if (currentPort(this.#manager) !== null) {
        throw new Error('Host first local file became audible during clock binding');
      }

      const queueItemId = input.queueItemId;
      const blob = input.blob;
      const name = input.name;
      const mime = normalizeMime(input.mime);
      let admitted = this.#asset;
      if (admitted) {
        if (
          admitted.queueItemId !== queueItemId ||
          admitted.blob !== blob ||
          admitted.name !== name ||
          admitted.mime !== mime
        ) {
          throw new Error(
            'Host first-file engine owns one logical queue asset; create a fresh engine for another asset',
          );
        }
      } else {
        const scope = createFilePlaybackMediaScope(this.#applicationScopeId, queueItemId);
        const binding = freezeCanonical({ queueItemId, ...scope });
        const runId = Reflect.apply(this.#runtime.createRunId, undefined, []);
        const state = createPlaybackStateIdentity({
          queueItemId,
          runId,
          revision: this.#baselineTimeline.revision + 1,
        });
        this.#assertStoppedRoomFence();
        const lease = this.#registry.admitBlob(this.#roomToken, binding, blob, { name, mime });
        admitted = Object.freeze({
          queueItemId,
          blob,
          name,
          mime,
          binding,
          lease,
          runId: state.runId,
        });
        this.#asset = admitted;
        if (this.#runtime.fatalAfterAdmission) {
          this.#handleRegistryFatal(new Error('Fixture registry fatal after admission'));
        }
      }
      this.#assertStoppedRoomFence();
      if (currentPort(this.#manager) !== null) {
        throw new Error('Host first local file became audible during admission');
      }

      this.#audioContext ??= audioContext;
      this.#destination ??= destination;
      this.#clockBindings ??= clockBindings;
      this.#operationEpoch += 1;
      const epoch = this.#operationEpoch;
      const operationController = new AbortController();
      const externalSignal = input.signal;
      const forwardExternalAbort = () => operationController.abort(externalSignal.reason);
      externalSignal.addEventListener('abort', forwardExternalAbort, { once: true });
      const operation: ActiveStartOperation = {
        epoch,
        controller: operationController,
        externalSignal,
        removeExternalAbort: () =>
          externalSignal.removeEventListener('abort', forwardExternalAbort),
        task: null,
      };
      const previous = this.#activeOperation;
      this.#activeOperation = operation;
      previous?.controller.abort(new Error('Host first local file was superseded'));

      const task = this.#executeStart(
        operation,
        admitted,
        audioContext,
        destination,
        input.decodeOrdinaryAudio as OrdinaryAudioDecoder,
        clockBindings,
      );
      operation.task = task;
      return task;
    } catch (error) {
      return Promise.reject(error);
    } finally {
      this.#startingSynchronously = false;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#operationEpoch += 1;
    const coordinatorFailure = this.#closeCoordinatorOnce();
    if (this.#closePromise) return this.#closePromise;
    const active = this.#activeOperation;
    active?.controller.abort(new Error('Host first-file room closed'));
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

  async #executeStart(
    operation: ActiveStartOperation,
    admitted: AdmittedFirstFile,
    audioContext: AudioContext,
    destination: AudioNode,
    decodeOrdinaryAudio: OrdinaryAudioDecoder,
    clockBindings: FilePlaybackClockBindings,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    let started: Readonly<StartedLocalFilePlayback> | null = null;
    try {
      this.#assertOperationFence(operation);
      const playbackState = createPlaybackStateIdentity({
        queueItemId: admitted.queueItemId,
        runId: admitted.runId,
        revision: this.#baselineTimeline.revision + 1,
      });
      const task = startLocalFilePlayback({
        registry: this.#registry,
        roomToken: this.#roomToken,
        assetLease: admitted.lease,
        expectedBinding: admitted.binding,
        manager: this.#manager,
        audioContext,
        destination,
        clockBindings,
        signal: operation.controller.signal,
        isCurrent: () => {
          try {
            this.#assertOperationFence(operation);
            return true;
          } catch {
            return false;
          }
        },
        decodeOrdinaryAudio,
        playbackState,
        positionSeconds: 0,
        playbackRate: 1,
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
      this.#assertOperationFence(operation);
      if (currentPort(this.#manager) !== started.port) {
        throw new Error('Host first local file lost its exact promoted renderer');
      }

      this.#runtime.beforeControllerCommit?.();
      this.#assertOperationFence(operation);
      const committed = Reflect.apply(trustedControllerCommit, this.#controller, [
        {
          roomGeneration: this.#roomGeneration,
          expectedPreviousRevision: this.#baselineTimeline.revision,
          attempt: started.attempt,
          schedule: started.schedule,
          startEvidence: started.startEvidence,
        },
      ]) as Readonly<FilePlaybackHostStartedPlaybackCommit>;
      if (
        committed.previous !== this.#baselineTimeline ||
        committed.timeline.revision !== started.attempt.revision ||
        committed.timeline.anchorMonotonicMs !== started.schedule.startAtRoomTimeMs ||
        committed.timeline.run?.queueItemId !== admitted.queueItemId ||
        committed.timeline.run.runId !== admitted.runId
      ) {
        throw new Error('Host first local file timeline commit did not match physical start');
      }
      this.#committedPort = started.port;

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
      if (started) {
        try {
          await this.#retireOwnedPort(started.port);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Host first-file start and renderer cleanup both failed',
            { cause: cleanupError },
          );
        }
      }
      throw error;
    } finally {
      operation.removeExternalAbort();
      if (this.#activeOperation === operation) this.#activeOperation = null;
    }
  }

  #assertStoppedRoomFence(): void {
    this.#assertRoomClockAuthority();
    const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (
      this.#closed ||
      snapshot.roomGeneration !== this.#roomGeneration ||
      snapshot.roomRole !== 'host' ||
      snapshot.activeConnectionCount !== 0 ||
      snapshot.timeline !== this.#baselineTimeline ||
      timeline !== this.#baselineTimeline ||
      timeline.phase !== 'stopped' ||
      timeline.run !== null
    ) {
      throw this.#fatalError ?? new Error('Host first-file room authority is stale');
    }
    this.#assertRoomClockAuthority();
  }

  #hasLiveProjectionAuthority(): boolean {
    try {
      if (
        this.#closed ||
        this.#coordinatorClosed ||
        this.#committedPort === null ||
        this.#asset === null
      ) {
        return false;
      }
      this.#assertRoomClockAuthority();
      const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
      const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
      return (
        !this.#closed &&
        !this.#coordinatorClosed &&
        snapshot.roomGeneration === this.#roomGeneration &&
        snapshot.roomRole === 'host' &&
        snapshot.activeConnectionCount === 0 &&
        snapshot.timeline === timeline &&
        timeline !== this.#baselineTimeline &&
        timeline.run?.queueItemId === this.#asset.queueItemId &&
        timeline.run.runId === this.#asset.runId
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
    if (this.#activeOperation !== operation || this.#operationEpoch !== operation.epoch) {
      throw new Error('Host first local file operation was superseded');
    }
    this.#assertStoppedRoomFence();
    throwIfAborted(operation.externalSignal);
    throwIfAborted(operation.controller.signal);
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
    if (this.#fatalNotified) return;
    this.#fatalNotified = true;
    void this.#closePromise.then(
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
    this.#asset = null;
    this.#committedPort = null;
    this.#audioContext = null;
    this.#destination = null;
    this.#clockBindings = null;
    const assetReferenceCount = this.#asset === null ? 0 : 1;
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
