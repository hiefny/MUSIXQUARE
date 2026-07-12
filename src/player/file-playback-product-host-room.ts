import { ensureRunning } from '../audio/context.ts';
import { getAudioContext, getFilePlaybackDestination, initAudio } from '../audio/engine.ts';
import { isFilePlaybackSessionId } from '../network/file-playback-session-handshake.ts';
import type { QueueItemId } from '../types/index.ts';
import { FilePlaybackApplicationController } from './file-playback-application-controller.ts';
import {
  FilePlaybackHostFirstFileEngine,
  type FilePlaybackHostFirstFileEngineOptions,
  type HostFirstLocalFilePlaybackCommit,
  type StartHostFirstLocalFileOptions,
} from './file-playback-host-first-file-engine.ts';
import { FilePlaybackRoomClock, getFilePlaybackRoomClock } from './file-playback-room-clock.ts';
import type { FilePlaybackPosition, FilePlaybackSourceSnapshot } from './file-playback-source.ts';
import type { OrdinaryAudioDecoder } from './file-playback-source-factory.ts';
import { decodeOrdinaryAudio } from './ordinary-audio-decoder.ts';
import type { PlaybackTimelineSnapshot } from './playback-timeline.ts';
import { isQueueItemId } from './queue-model.ts';

const OPTION_KEYS = Object.freeze([
  'controller',
  'hostRoomSnapshot',
  'onFatalRoom',
  'roomClock',
  'runtimeForTests',
] as const);
const REQUIRED_OPTION_KEYS = OPTION_KEYS.filter(
  (key) => key !== 'roomClock' && key !== 'runtimeForTests',
);
const START_KEYS = Object.freeze(['file', 'queueItemId', 'signal'] as const);
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
  startFirstLocalFile(
    options: StartHostFirstLocalFileOptions,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>>;
  close(): Promise<void>;
  currentRendererSnapshot(): FilePlaybackSourceSnapshot | null;
  positionAt(localPerformanceTimeMs: number): FilePlaybackPosition | null;
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
  /** Product code omits this and consumes the one process room clock. */
  readonly roomClock?: FilePlaybackRoomClock;
  readonly onFatalRoom: (error: Error) => void;
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

/** Frozen, serializable control result. Encoded bodies and native graph objects stay private. */
export interface FilePlaybackProductHostFirstLocalFileCommit extends HostFirstLocalFilePlaybackCommit {
  readonly status: 'committed';
  readonly applicationSessionId: string;
  readonly hostParticipantId: string;
}

export interface FilePlaybackProductHostFirstLocalFileRejection {
  readonly schemaVersion: 1;
  readonly status: 'rejected';
  readonly reason: 'replacement-not-supported';
  readonly roomGeneration: number;
  readonly applicationSessionId: string;
  readonly currentQueueItemId: QueueItemId;
}

export type FilePlaybackProductHostFirstLocalFileResult = Readonly<
  FilePlaybackProductHostFirstLocalFileCommit | FilePlaybackProductHostFirstLocalFileRejection
>;

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
}

interface EngineRecord {
  readonly token: object;
  readonly engine: FilePlaybackProductHostFirstEnginePort;
  readonly intent: FileIntent;
  commitObserved: boolean;
}

interface StartOperation {
  readonly epoch: number;
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal;
  readonly removeExternalAbort: () => void;
  task: Promise<FilePlaybackProductHostFirstLocalFileResult> | null;
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
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Partial<FilePlaybackProductHostFirstEnginePort>).startFirstLocalFile ===
      'function' &&
    typeof (value as Partial<FilePlaybackProductHostFirstEnginePort>).close === 'function' &&
    typeof (value as Partial<FilePlaybackProductHostFirstEnginePort>).currentRendererSnapshot ===
      'function' &&
    typeof (value as Partial<FilePlaybackProductHostFirstEnginePort>).positionAt === 'function'
  );
}

function sameIntent(left: FileIntent, right: FileIntent): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.file === right.file &&
    left.name === right.name &&
    left.mime === right.mime &&
    left.size === right.size &&
    left.lastModified === right.lastModified
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

/**
 * Product-only owner for one exact host room's first local-file renderer.
 *
 * It deliberately performs no playlist, UI, network, or application-session
 * mutation. The product runtime owns room creation/teardown; this facade only
 * prepares the shared graph, serializes first-file intent replacement, and
 * delegates physical/timeline commit to a private host engine.
 */
export class FilePlaybackProductHostRoom {
  readonly #controller: FilePlaybackApplicationController;
  readonly #hostRoom: Readonly<FilePlaybackProductHostRoomAuthority>;
  readonly #baselineTimeline: PlaybackTimelineSnapshot;
  readonly #roomClock: FilePlaybackRoomClock;
  readonly #roomToken: object;
  readonly #onFatalRoom: (error: Error) => void;
  readonly #runtime: RuntimeSnapshot;
  #engineRecord: EngineRecord | null = null;
  #operationEpoch = 0;
  #activeOperation: StartOperation | null = null;
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
    if (!isExactController(input.controller)) {
      throw new TypeError('File playback product host room requires the exact controller');
    }
    if (typeof input.onFatalRoom !== 'function') {
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
    this.#roomClock = roomClock;
    this.#roomToken = roomToken;
    this.#onFatalRoom = input.onFatalRoom as (error: Error) => void;
    this.#runtime = runtime;
    this.#baselineTimeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    this.#assertStoppedAuthority();
  }

  startFirstLocalFile(
    options: StartFilePlaybackProductHostFirstLocalFileOptions,
  ): Promise<FilePlaybackProductHostFirstLocalFileResult> {
    const input = snapshotExactRecord(options, START_KEYS);
    if (!input)
      return Promise.reject(new TypeError('Product first local file options are invalid'));
    if (!isQueueItemId(input.queueItemId)) {
      return Promise.reject(new TypeError('Product first local file queue item ID is invalid'));
    }
    if (typeof File === 'undefined' || !(input.file instanceof File)) {
      return Promise.reject(new TypeError('Product first local file requires an exact File'));
    }
    if (!(input.signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError('Product first local file requires an AbortSignal'));
    }
    if (this.#closed) {
      return Promise.reject(
        this.#fatalError ?? new Error('File playback product host room is closed'),
      );
    }
    try {
      throwIfAborted(input.signal);
    } catch (error) {
      return Promise.reject(error);
    }

    const file = input.file;
    const intent: FileIntent = Object.freeze({
      queueItemId: input.queueItemId,
      file,
      name: file.name,
      mime: file.type,
      size: file.size,
      lastModified: file.lastModified,
    });
    this.#operationEpoch += 1;
    const controller = new AbortController();
    const externalSignal = input.signal;
    const forwardAbort = () => controller.abort(externalSignal.reason);
    externalSignal.addEventListener('abort', forwardAbort, { once: true });
    const operation: StartOperation = {
      epoch: this.#operationEpoch,
      controller,
      externalSignal,
      removeExternalAbort: () => externalSignal.removeEventListener('abort', forwardAbort),
      task: null,
    };
    const predecessor = this.#activeOperation;
    this.#activeOperation = operation;
    predecessor?.controller.abort(new Error('Product first local file intent was superseded'));
    const task = this.#executeStart(operation, intent, predecessor?.task ?? null);
    operation.task = task;
    return task;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#operationEpoch += 1;
    const active = this.#activeOperation;
    active?.controller.abort(new Error('File playback product host room closed'));
    const record = this.#engineRecord;
    let engineClose: Promise<void> | null = null;
    if (record) {
      try {
        // Invocation, not just awaiting, synchronously fences the private
        // engine and its rendezvous coordinator.
        engineClose = record.engine.close();
      } catch (error) {
        engineClose = Promise.reject(error);
      }
    }
    this.#closePromise = this.#closeOwnedRoom(active?.task ?? null, engineClose);
    return this.#closePromise;
  }

  currentRendererSnapshot(): FilePlaybackSourceSnapshot | null {
    const record = this.#engineRecord;
    if (!record || !this.#hasProjectionAuthority(record)) return null;
    const snapshot = record.engine.currentRendererSnapshot();
    return snapshot && this.#hasProjectionAuthority(record) ? snapshot : null;
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
    if (!record || !this.#hasProjectionAuthority(record)) return null;
    const position = record.engine.positionAt(localPerformanceTimeMs);
    return position && this.#hasProjectionAuthority(record) ? position : null;
  }

  async #executeStart(
    operation: StartOperation,
    intent: FileIntent,
    predecessor: Promise<unknown> | null,
  ): Promise<FilePlaybackProductHostFirstLocalFileResult> {
    let engineStartInvoked = false;
    try {
      if (predecessor) {
        try {
          await predecessor;
        } catch {
          // Supersession and user cancellation are expected. Exact room truth
          // below decides whether replacement is still permitted.
        }
      }
      this.#assertOperationEnvelope(operation);

      const controllerTimeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
      if (controllerTimeline !== this.#baselineTimeline) {
        return this.#replacementRejected();
      }
      this.#assertStoppedAuthority();

      let record = this.#engineRecord;
      if (record && !sameIntent(record.intent, intent)) {
        const retiring = record;
        try {
          // This call synchronously fences the old coordinator before any
          // successor graph or asset preparation can begin.
          const retired = retiring.engine.close();
          await retired;
        } catch (cause) {
          const error = asError(cause, 'File playback product engine replacement cleanup failed');
          this.#quarantine(error);
          throw error;
        }
        if (this.#engineRecord !== retiring) {
          throw new Error('File playback product engine ownership changed during replacement');
        }
        this.#engineRecord = null;
        record = null;
        this.#assertOperation(operation);
        this.#assertStoppedAuthority();
      }

      await this.#runtime.initAudio();
      this.#assertOperation(operation);
      await this.#runtime.ensureRunning();
      this.#assertOperation(operation);
      const audioContext = this.#runtime.getAudioContext();
      validateAudioContext(audioContext);
      const destination = this.#runtime.getFilePlaybackDestination();
      validateDestination(destination, audioContext);
      this.#assertOperation(operation);

      record ??= await this.#createEngine(operation, intent);
      if (this.#engineRecord !== record || !sameIntent(record.intent, intent)) {
        throw new Error('File playback product engine ownership changed before start');
      }
      this.#assertOperation(operation);
      engineStartInvoked = true;
      const commit = await record.engine.startFirstLocalFile({
        queueItemId: intent.queueItemId,
        blob: intent.file,
        name: intent.name,
        mime: intent.mime,
        audioContext,
        destination,
        decodeOrdinaryAudio: this.#runtime.decodeOrdinaryAudio,
        signal: operation.controller.signal,
      });
      const result = this.#projectCommit(record, commit);
      record.commitObserved = true;
      this.#assertCommittedPublication(record);
      return result;
    } catch (cause) {
      if (
        engineStartInvoked &&
        !this.#closed &&
        Reflect.apply(trustedControllerTimeline, this.#controller, []) !== this.#baselineTimeline
      ) {
        this.#quarantine(
          asError(cause, 'File playback product engine failed after timeline commit'),
        );
      }
      throw cause;
    } finally {
      operation.removeExternalAbort();
      if (this.#activeOperation === operation) this.#activeOperation = null;
    }
  }

  async #createEngine(operation: StartOperation, intent: FileIntent): Promise<EngineRecord> {
    this.#assertStoppedAuthority();
    const token = Object.freeze(Object.create(null) as object);
    let pendingFatal: Error | null = null;
    const engine = this.#runtime.createEngine({
      controller: this.#controller,
      roomGeneration: this.#hostRoom.roomGeneration,
      applicationScopeId: this.#hostRoom.applicationSessionId,
      roomToken: this.#roomToken,
      roomClock: this.#roomClock,
      hostParticipantId: this.#hostRoom.hostParticipantId,
      onFatalRoom: (error) => {
        if (this.#engineRecord?.token === token) this.#handleEngineFatal(token, error);
        else pendingFatal = asError(error, 'File playback product host engine failed');
      },
    });
    if (!isEnginePort(engine, this.#runtime.allowStructuralEngine)) {
      throw new TypeError('File playback product host engine factory returned an invalid engine');
    }
    try {
      if (pendingFatal) throw pendingFatal;
      this.#assertOperation(operation);
      if (this.#engineRecord !== null) {
        throw new Error('File playback product engine was installed during factory re-entry');
      }
    } catch (cause) {
      let cleanupFailure: unknown = null;
      try {
        // A factory re-entry may have revoked this operation. Close the
        // unpublished candidate synchronously and never install it afterward.
        const cleanup = engine.close();
        await cleanup;
      } catch (error) {
        cleanupFailure = error;
      }
      if (pendingFatal) this.#quarantine(pendingFatal);
      if (cleanupFailure !== null) {
        throw new ProductHostRoomCleanupError(
          'Stale product host engine candidate cleanup failed',
          new AggregateError(
            [cause, cleanupFailure],
            'Stale product host engine and candidate cleanup both failed',
          ),
        );
      }
      throw cause;
    }
    const record: EngineRecord = {
      token,
      engine,
      intent,
      commitObserved: false,
    };
    this.#engineRecord = record;
    return record;
  }

  #projectCommit(
    record: EngineRecord,
    commit: Readonly<HostFirstLocalFilePlaybackCommit>,
  ): Readonly<FilePlaybackProductHostFirstLocalFileCommit> {
    if (!commit || typeof commit !== 'object') {
      throw new TypeError('File playback product host engine returned an invalid commit');
    }
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (
      commit.schemaVersion !== 1 ||
      commit.roomGeneration !== this.#hostRoom.roomGeneration ||
      commit.attempt?.queueItemId !== record.intent.queueItemId ||
      commit.timeline !== timeline ||
      timeline === this.#baselineTimeline ||
      timeline.run?.queueItemId !== record.intent.queueItemId ||
      timeline.run.runId !== commit.attempt.runId ||
      timeline.revision !== commit.attempt.revision ||
      commit.asset?.queueItemId !== record.intent.queueItemId
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
    return result;
  }

  #assertOperation(operation: StartOperation, committed = false): void {
    this.#assertOperationEnvelope(operation);
    if (committed) this.#assertCommittedAuthority();
    else this.#assertStoppedAuthority();
    throwIfAborted(operation.externalSignal);
    throwIfAborted(operation.controller.signal);
  }

  #assertOperationEnvelope(operation: StartOperation): void {
    throwIfAborted(operation.externalSignal);
    throwIfAborted(operation.controller.signal);
    if (
      this.#closed ||
      this.#activeOperation !== operation ||
      this.#operationEpoch !== operation.epoch
    ) {
      throw this.#fatalError ?? new Error('File playback product operation was superseded');
    }
    this.#assertClockAuthority();
    const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (
      snapshot.roomGeneration !== this.#hostRoom.roomGeneration ||
      snapshot.roomRole !== 'host' ||
      snapshot.activeConnectionCount !== 0 ||
      snapshot.timeline !== timeline
    ) {
      throw new Error('File playback product host operation authority is stale');
    }
    this.#assertClockAuthority();
    throwIfAborted(operation.externalSignal);
    throwIfAborted(operation.controller.signal);
  }

  #assertStoppedAuthority(): void {
    this.#assertClockAuthority();
    const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    if (
      this.#closed ||
      snapshot.roomGeneration !== this.#hostRoom.roomGeneration ||
      snapshot.roomRole !== 'host' ||
      snapshot.activeConnectionCount !== 0 ||
      snapshot.timeline !== timeline ||
      timeline !== this.#baselineTimeline ||
      timeline.phase !== 'stopped' ||
      timeline.run !== null
    ) {
      throw this.#fatalError ?? new Error('File playback product stopped host authority is stale');
    }
    this.#assertClockAuthority();
  }

  #assertCommittedAuthority(): void {
    this.#assertClockAuthority();
    const snapshot = Reflect.apply(trustedControllerSnapshot, this.#controller, []);
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    const record = this.#engineRecord;
    if (
      this.#closed ||
      !record ||
      snapshot.roomGeneration !== this.#hostRoom.roomGeneration ||
      snapshot.roomRole !== 'host' ||
      snapshot.activeConnectionCount !== 0 ||
      snapshot.timeline !== timeline ||
      timeline === this.#baselineTimeline ||
      timeline.run?.queueItemId !== record.intent.queueItemId
    ) {
      throw (
        this.#fatalError ?? new Error('File playback product committed host authority is stale')
      );
    }
    this.#assertClockAuthority();
  }

  #assertCommittedPublication(record: EngineRecord): void {
    if (this.#closed || this.#engineRecord !== record) {
      throw this.#fatalError ?? new Error('Committed product renderer ownership is stale');
    }
    this.#assertCommittedAuthority();
    if (this.#closed || this.#engineRecord !== record) {
      throw this.#fatalError ?? new Error('Committed product renderer ownership is stale');
    }
  }

  #assertClockAuthority(): void {
    const role = Reflect.apply(trustedRoomClockRole, this.#roomClock, []);
    const now = Reflect.apply(trustedRoomClockNow, this.#roomClock, []);
    if (role !== 'host' || !Number.isFinite(now) || now < 0) {
      throw new Error('File playback product host room clock authority is stale');
    }
  }

  #hasProjectionAuthority(record: EngineRecord): boolean {
    try {
      if (this.#closed || this.#engineRecord !== record || !record.commitObserved) return false;
      this.#assertCommittedAuthority();
      return !this.#closed && this.#engineRecord === record;
    } catch {
      return false;
    }
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
    activeTask: Promise<unknown> | null,
    engineClose: Promise<void> | null,
  ): Promise<void> {
    let failure: unknown = null;
    const settlements = await Promise.allSettled([
      activeTask ?? Promise.resolve(),
      engineClose ?? Promise.resolve(),
    ]);
    const activeSettlement = settlements[0];
    if (
      activeSettlement?.status === 'rejected' &&
      containsCleanupFailure(activeSettlement.reason)
    ) {
      failure = mergeCleanupFailure(failure, activeSettlement.reason);
    }
    const engineSettlement = settlements[1];
    if (engineSettlement?.status === 'rejected') {
      failure = mergeCleanupFailure(failure, engineSettlement.reason);
    }
    this.#engineRecord = null;
    this.#activeOperation = null;
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

  #replacementRejected(): Readonly<FilePlaybackProductHostFirstLocalFileRejection> {
    this.#assertCommittedAuthority();
    const timeline = Reflect.apply(trustedControllerTimeline, this.#controller, []);
    const currentQueueItemId = timeline.run?.queueItemId;
    if (!currentQueueItemId) {
      throw new Error('Committed product playback has no queue identity');
    }
    return freezeCanonical({
      schemaVersion: 1 as const,
      status: 'rejected' as const,
      reason: 'replacement-not-supported' as const,
      roomGeneration: this.#hostRoom.roomGeneration,
      applicationSessionId: this.#hostRoom.applicationSessionId,
      currentQueueItemId,
    });
  }
}
