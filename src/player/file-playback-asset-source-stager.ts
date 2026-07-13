import type { QueueItemId } from '../types/index.ts';
import {
  FilePlaybackAssetRegistry,
  parseFilePlaybackAssetBinding,
  type FilePlaybackAssetBinding,
  type FilePlaybackAssetLease,
  type FilePlaybackAssetMetadata,
  type FilePlaybackAssetSnapshot,
  type FilePlaybackBlobResolution,
} from './file-playback-asset-registry.ts';
import type { FilePlaybackClockBindings } from './file-playback-clock.ts';
import {
  FilePlaybackManager,
  isExactFilePlaybackManager,
  type FilePlaybackCutoverCandidateOptions,
  type FilePlaybackCutoverCandidatePort,
} from './file-playback-manager.ts';
import {
  createFilePlaybackSourceSnapshot,
  type FilePlaybackCutoverSource,
  type FilePlaybackSourceSnapshot,
} from './file-playback-source.ts';
import {
  createBlobFilePlaybackSource,
  createEncodedFilePlaybackSource,
  type BlobFilePlaybackSourceResult,
  type CreateBlobFilePlaybackSourceOptions,
  type CreateEncodedFilePlaybackSourceOptions,
  type OrdinaryAudioDecoder,
} from './file-playback-source-factory.ts';
import type { EncodedAudioSource } from './sources/encoded-audio-source.ts';

const OPTION_KEYS = Object.freeze([
  'registry',
  'roomToken',
  'assetLease',
  'expectedBinding',
  'manager',
  'audioContext',
  'destination',
  'clockBindings',
  'signal',
  'isCurrent',
  'decodeOrdinaryAudio',
  'runtime',
] as const);
const REQUIRED_OPTION_KEYS = OPTION_KEYS.filter((key) => key !== 'runtime');
const RUNTIME_KEYS = Object.freeze([
  'createBlobSource',
  'createEncodedSource',
  'stageCandidate',
  'retireCandidate',
] as const);
const CLOCK_KEYS = Object.freeze([
  'nowRoomTimeMs',
  'roomTimeMsToContextTime',
  'localPerformanceMsToContextTime',
] as const);
const SNAPSHOT_KEYS = Object.freeze([
  'queueItemId',
  'sourceIdentity',
  'transferSessionId',
  'kind',
  'size',
  'name',
  'mime',
] as const);
const BLOB_RESOLUTION_KEYS = Object.freeze(['blob', 'binding', 'metadata'] as const);
const METADATA_KEYS = Object.freeze(['name', 'mime'] as const);
const AUDIO_BUFFER_FACTORY_RESULT_KEYS = Object.freeze([
  'backend',
  'source',
  'sourceIdentity',
  'audioBuffer',
  'releaseConstructionLease',
  'flacMetadata',
] as const);
const STREAMING_FACTORY_RESULT_KEYS = Object.freeze([
  'backend',
  'source',
  'sourceIdentity',
  'releaseConstructionLease',
  'flacMetadata',
] as const);
const CUTOVER_SOURCE_METHODS = Object.freeze([
  'prepare',
  'connect',
  'arm',
  'armForCutover',
  'finalize',
  'cancel',
  'pause',
  'pauseRevisioned',
  'seek',
  'seekRevisioned',
  'positionAt',
  'getSnapshot',
  'destroy',
] as const);

type DataMethod = (...args: never[]) => unknown;
type ExactRecord = Readonly<Record<string, unknown>>;

type CreateBlobSource = (
  options: CreateBlobFilePlaybackSourceOptions,
) => Promise<BlobFilePlaybackSourceResult>;
type CreateEncodedSource = (
  options: CreateEncodedFilePlaybackSourceOptions,
) => Promise<BlobFilePlaybackSourceResult>;
type StageCandidate = (
  manager: FilePlaybackManager,
  options: FilePlaybackCutoverCandidateOptions,
) => Promise<FilePlaybackCutoverCandidatePort>;
type RetireCandidate = (
  manager: FilePlaybackManager,
  port: FilePlaybackCutoverCandidatePort,
) => Promise<boolean>;

/** Test-only seams around asynchronous browser/native boundaries. */
export interface FilePlaybackAssetSourceStagerRuntimeForTests {
  readonly createBlobSource?: CreateBlobSource;
  readonly createEncodedSource?: CreateEncodedSource;
  readonly stageCandidate?: StageCandidate;
  readonly retireCandidate?: RetireCandidate;
}

export interface StageFilePlaybackAssetSourceOptions {
  readonly registry: FilePlaybackAssetRegistry;
  readonly roomToken: object;
  readonly assetLease: FilePlaybackAssetLease;
  readonly expectedBinding: FilePlaybackAssetBinding;
  readonly manager: FilePlaybackManager;
  readonly audioContext: AudioContext;
  readonly destination: AudioNode;
  readonly clockBindings: FilePlaybackClockBindings;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly runtime?: FilePlaybackAssetSourceStagerRuntimeForTests;
}

/** Body-free result retained by the application controller. */
export interface StagedFilePlaybackAssetSource {
  readonly cutoverPort: FilePlaybackCutoverCandidatePort;
  readonly backend: BlobFilePlaybackSourceResult['backend'];
  readonly sourceIdentity: string;
  readonly asset: Readonly<FilePlaybackAssetSnapshot>;
  readonly metadata: Readonly<FilePlaybackAssetMetadata>;
  /** Exact body-free readiness observed from the manager-owned silent source. */
  readonly readiness: Readonly<FilePlaybackPreparedSourceReadiness>;
}

export interface FilePlaybackPreparedSourceReadiness {
  readonly durationSeconds: number;
  readonly bufferedAheadSeconds: number;
  readonly outputSampleRateHz: number;
  readonly channelCount: number;
}

interface RuntimeSnapshot {
  readonly createBlobSource: CreateBlobSource;
  readonly createEncodedSource: CreateEncodedSource;
  readonly stageCandidate: StageCandidate;
  readonly retireCandidate: RetireCandidate;
}

interface FactoryResultSnapshot {
  readonly backend: BlobFilePlaybackSourceResult['backend'];
  readonly source: FilePlaybackCutoverSource;
  readonly sourceIdentity: string;
  readonly releaseConstructionLease: () => void;
  readonly destroySource: () => Promise<void>;
  readonly getSnapshot: () => unknown;
}

const registrySnapshotForLease = FilePlaybackAssetRegistry.prototype.snapshotForLease;
const registryResolveBlobAsset = FilePlaybackAssetRegistry.prototype.resolveBlobAsset;
const registryAcquireSource = FilePlaybackAssetRegistry.prototype.acquireSource;
const managerStageCutoverCandidate = FilePlaybackManager.prototype.stageCutoverCandidate;
const managerRetireCutoverCandidate = FilePlaybackManager.prototype.retireCutoverCandidate;
const nativeAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;

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
    const expected = new Set<string>(keys);
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

function snapshotOptions(value: unknown): ExactRecord | null {
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
      if (key === 'runtime' && !descriptor) {
        snapshot[key] = undefined;
        continue;
      }
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotOptionalMethods(value: unknown): Readonly<Record<string, DataMethod>> | null {
  if (value === undefined) return Object.freeze(Object.create(null));
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(RUNTIME_KEYS);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) return null;
    const snapshot = Object.create(null) as Record<string, DataMethod>;
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
      snapshot[key] = descriptor.value as DataMethod;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function findDataMethod(value: object, name: string): DataMethod | null {
  try {
    let cursor: object | null = value;
    const seen = new WeakSet<object>();
    for (let depth = 0; cursor && depth < 32; depth += 1) {
      if (seen.has(cursor)) return null;
      seen.add(cursor);
      const descriptor = Reflect.getOwnPropertyDescriptor(cursor, name);
      if (descriptor) {
        return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
          ? (descriptor.value as DataMethod)
          : null;
      }
      cursor = Reflect.getPrototypeOf(cursor);
    }
  } catch {
    return null;
  }
  return null;
}

function exactRegistry(value: unknown): value is FilePlaybackAssetRegistry {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      Reflect.getPrototypeOf(value) === FilePlaybackAssetRegistry.prototype
    );
  } catch {
    return false;
  }
}

function clockSnapshot(value: unknown): Readonly<FilePlaybackClockBindings> | null {
  const snapshot = snapshotExactRecord(value, CLOCK_KEYS);
  if (
    !snapshot ||
    typeof snapshot.nowRoomTimeMs !== 'function' ||
    typeof snapshot.roomTimeMsToContextTime !== 'function' ||
    typeof snapshot.localPerformanceMsToContextTime !== 'function'
  ) {
    return null;
  }
  const receiver = value as FilePlaybackClockBindings;
  const nowRoomTimeMs = snapshot.nowRoomTimeMs as FilePlaybackClockBindings['nowRoomTimeMs'];
  const roomTimeMsToContextTime =
    snapshot.roomTimeMsToContextTime as FilePlaybackClockBindings['roomTimeMsToContextTime'];
  const localPerformanceMsToContextTime =
    snapshot.localPerformanceMsToContextTime as FilePlaybackClockBindings['localPerformanceMsToContextTime'];
  return freezeCanonical({
    nowRoomTimeMs: () => Reflect.apply(nowRoomTimeMs, receiver, []),
    roomTimeMsToContextTime: (roomTimeMs: number) =>
      Reflect.apply(roomTimeMsToContextTime, receiver, [roomTimeMs]),
    localPerformanceMsToContextTime: (localPerformanceTimeMs: number) =>
      Reflect.apply(localPerformanceMsToContextTime, receiver, [localPerformanceTimeMs]),
  });
}

function runtimeSnapshot(value: unknown): RuntimeSnapshot | null {
  const methods = snapshotOptionalMethods(value);
  if (!methods) return null;
  return Object.freeze({
    createBlobSource:
      (methods.createBlobSource as CreateBlobSource | undefined) ?? createBlobFilePlaybackSource,
    createEncodedSource:
      (methods.createEncodedSource as CreateEncodedSource | undefined) ??
      createEncodedFilePlaybackSource,
    stageCandidate:
      (methods.stageCandidate as StageCandidate | undefined) ??
      ((manager: FilePlaybackManager, options: FilePlaybackCutoverCandidateOptions) =>
        Reflect.apply(managerStageCutoverCandidate, manager, [options])),
    retireCandidate:
      (methods.retireCandidate as RetireCandidate | undefined) ??
      ((manager: FilePlaybackManager, port: FilePlaybackCutoverCandidatePort) =>
        Reflect.apply(managerRetireCutoverCandidate, manager, [port])),
  });
}

function throwIfAborted(signal: AbortSignal): void {
  Reflect.apply(nativeAbortThrowIfAborted, signal, []);
}

function sameBinding(
  snapshot: Readonly<FilePlaybackAssetSnapshot>,
  binding: Readonly<FilePlaybackAssetBinding>,
): boolean {
  return (
    snapshot.queueItemId === binding.queueItemId &&
    snapshot.sourceIdentity === binding.sourceIdentity &&
    snapshot.transferSessionId === binding.transferSessionId
  );
}

function sameSnapshot(
  left: Readonly<FilePlaybackAssetSnapshot>,
  right: Readonly<FilePlaybackAssetSnapshot>,
): boolean {
  return SNAPSHOT_KEYS.every((key) => left[key] === right[key]);
}

function canonicalSnapshot(value: unknown): Readonly<FilePlaybackAssetSnapshot> | null {
  const snapshot = snapshotExactRecord(value, SNAPSHOT_KEYS);
  const binding = snapshot
    ? parseFilePlaybackAssetBinding({
        queueItemId: snapshot.queueItemId,
        sourceIdentity: snapshot.sourceIdentity,
        transferSessionId: snapshot.transferSessionId,
      })
    : null;
  if (
    !snapshot ||
    !binding ||
    (snapshot.kind !== 'blob' &&
      snapshot.kind !== 'peer-range' &&
      snapshot.kind !== 'r2-records') ||
    typeof snapshot.size !== 'number' ||
    !Number.isSafeInteger(snapshot.size) ||
    snapshot.size <= 0 ||
    typeof snapshot.name !== 'string' ||
    snapshot.name.length === 0 ||
    typeof snapshot.mime !== 'string' ||
    snapshot.mime.length === 0
  ) {
    return null;
  }
  return freezeCanonical({
    ...binding,
    kind: snapshot.kind,
    size: snapshot.size,
    name: snapshot.name,
    mime: snapshot.mime,
  });
}

function canonicalMetadata(
  value: unknown,
  expected: Readonly<FilePlaybackAssetSnapshot>,
): Readonly<FilePlaybackAssetMetadata> | null {
  const metadata = snapshotExactRecord(value, METADATA_KEYS);
  if (
    !metadata ||
    metadata.name !== expected.name ||
    metadata.mime !== expected.mime ||
    typeof metadata.name !== 'string' ||
    typeof metadata.mime !== 'string'
  ) {
    return null;
  }
  return freezeCanonical({ name: metadata.name, mime: metadata.mime });
}

function canonicalBlobResolution(
  value: unknown,
  expected: Readonly<FilePlaybackAssetSnapshot>,
): Readonly<FilePlaybackBlobResolution> | null {
  const resolution = snapshotExactRecord(value, BLOB_RESOLUTION_KEYS);
  if (!resolution || !(resolution.blob instanceof Blob)) return null;
  const binding = parseFilePlaybackAssetBinding(resolution.binding);
  const metadata = canonicalMetadata(resolution.metadata, expected);
  if (!binding || !sameBinding(expected, binding) || !metadata) return null;
  return freezeCanonical({ blob: resolution.blob, binding, metadata });
}

function oneShotSourceDestroyer(source: unknown): (() => Promise<void>) | null {
  if (source === null || typeof source !== 'object') return null;
  const destroy = findDataMethod(source, 'destroy');
  if (!destroy) return null;
  let promise: Promise<void> | null = null;
  return () => {
    if (promise) return promise;
    try {
      promise = Promise.resolve(Reflect.apply(destroy, source, []));
    } catch (error) {
      promise = Promise.reject(error);
    }
    return promise;
  };
}

function cutoverSourceDestroyer(source: unknown): (() => Promise<void>) | null {
  if (source === null || typeof source !== 'object') return null;
  for (const name of CUTOVER_SOURCE_METHODS) {
    if (!findDataMethod(source, name)) return null;
  }
  return oneShotSourceDestroyer(source);
}

function inspectFactoryResult(
  value: unknown,
  expectedSourceIdentity: string,
): FactoryResultSnapshot | null {
  if (value === null || typeof value !== 'object') return null;
  let backend: unknown;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, 'backend');
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    backend = descriptor.value;
  } catch {
    return null;
  }
  const keys =
    backend === 'audio-buffer'
      ? AUDIO_BUFFER_FACTORY_RESULT_KEYS
      : backend === 'bounded-stream'
        ? STREAMING_FACTORY_RESULT_KEYS
        : null;
  const result = keys ? snapshotExactRecord(value, keys) : null;
  if (
    !result ||
    result.sourceIdentity !== expectedSourceIdentity ||
    typeof result.releaseConstructionLease !== 'function' ||
    result.source === null ||
    typeof result.source !== 'object'
  ) {
    return null;
  }
  const destroySource = cutoverSourceDestroyer(result.source);
  const getSnapshot = findDataMethod(result.source as object, 'getSnapshot');
  if (!destroySource || !getSnapshot) return null;
  if (
    (backend === 'audio-buffer' && result.flacMetadata !== null) ||
    (backend === 'bounded-stream' &&
      (result.flacMetadata === null || typeof result.flacMetadata !== 'object'))
  ) {
    return null;
  }
  return Object.freeze({
    backend: backend as BlobFilePlaybackSourceResult['backend'],
    source: result.source as FilePlaybackCutoverSource,
    sourceIdentity: expectedSourceIdentity,
    releaseConstructionLease: result.releaseConstructionLease as () => void,
    destroySource,
    getSnapshot: () => Reflect.apply(getSnapshot, result.source, []),
  });
}

function preparedReadiness(
  factory: FactoryResultSnapshot,
  expected: Readonly<FilePlaybackAssetSnapshot>,
): Readonly<FilePlaybackPreparedSourceReadiness> | null {
  let snapshot: FilePlaybackSourceSnapshot;
  try {
    snapshot = createFilePlaybackSourceSnapshot(
      factory.getSnapshot() as FilePlaybackSourceSnapshot,
    );
  } catch {
    return null;
  }
  if (
    snapshot.queueItemId !== expected.queueItemId ||
    snapshot.backend !== factory.backend ||
    snapshot.phase !== 'connected' ||
    snapshot.revision !== 0 ||
    snapshot.run !== null ||
    snapshot.durationSeconds === null ||
    snapshot.durationSeconds <= 0 ||
    snapshot.bufferedAheadSeconds < 0 ||
    snapshot.bufferedAheadSeconds > snapshot.durationSeconds ||
    snapshot.outputSampleRateHz === null ||
    snapshot.channelCount === null ||
    snapshot.errorCode !== null
  ) {
    return null;
  }
  return freezeCanonical({
    durationSeconds: snapshot.durationSeconds,
    bufferedAheadSeconds: snapshot.bufferedAheadSeconds,
    outputSampleRateHz: snapshot.outputSampleRateHz,
    channelCount: snapshot.channelCount,
  });
}

function potentialFactoryCleanup(value: unknown): {
  readonly release: (() => void) | null;
  readonly destroy: (() => Promise<void>) | null;
} {
  try {
    if (value === null || typeof value !== 'object') return { release: null, destroy: null };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const release = descriptors.releaseConstructionLease;
    const source = descriptors.source;
    return {
      release:
        release?.enumerable &&
        Object.hasOwn(release, 'value') &&
        typeof release.value === 'function'
          ? (release.value as () => void)
          : null,
      destroy:
        source?.enumerable && Object.hasOwn(source, 'value')
          ? oneShotSourceDestroyer(source.value)
          : null,
    };
  } catch {
    return { release: null, destroy: null };
  }
}

async function suppressCleanup(operation: (() => Promise<unknown>) | null): Promise<void> {
  if (!operation) return;
  try {
    await operation();
  } catch {
    // The error that caused cleanup remains authoritative.
  }
}

function suppressRelease(release: (() => void) | null): void {
  if (!release) return;
  try {
    release();
  } catch {
    // The error that caused cleanup remains authoritative.
  }
}

function assertCutoverPort(value: unknown): asserts value is FilePlaybackCutoverCandidatePort {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('File playback manager returned an invalid cutover candidate port');
  }
}

/**
 * Constructs one exact renderer from a room asset and atomically hands it to
 * the manager's silent cutover slot. Media bodies and native source objects
 * never cross the returned application boundary.
 */
export async function stageFilePlaybackAssetSource(
  options: StageFilePlaybackAssetSourceOptions,
): Promise<Readonly<StagedFilePlaybackAssetSource>> {
  const input = snapshotOptions(options);
  if (!input) throw new TypeError('File playback asset staging options are invalid');

  const registry = input.registry;
  const roomToken = input.roomToken;
  const assetLease = input.assetLease;
  const expectedBinding = parseFilePlaybackAssetBinding(input.expectedBinding);
  const manager = input.manager;
  const audioContext = input.audioContext;
  const destination = input.destination;
  const signal = input.signal;
  const isCurrent = input.isCurrent;
  const decodeOrdinaryAudio = input.decodeOrdinaryAudio;
  const clock = clockSnapshot(input.clockBindings);
  const runtime = runtimeSnapshot(input.runtime);

  if (!exactRegistry(registry)) {
    throw new TypeError('An exact file playback asset registry is required');
  }
  if (roomToken === null || typeof roomToken !== 'object') {
    throw new TypeError('An opaque file playback room token is required');
  }
  if (assetLease === null || typeof assetLease !== 'object' || !expectedBinding) {
    throw new TypeError('An exact file playback asset lease and binding are required');
  }
  if (!isExactFilePlaybackManager(manager)) {
    throw new TypeError('An exact file playback manager is required');
  }
  if (
    audioContext === null ||
    typeof audioContext !== 'object' ||
    destination === null ||
    typeof destination !== 'object'
  ) {
    throw new TypeError('File playback audio graph dependencies are required');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('An exact file playback AbortSignal is required');
  }
  if (typeof isCurrent !== 'function' || typeof decodeOrdinaryAudio !== 'function') {
    throw new TypeError('File playback authority and ordinary decoder callbacks are required');
  }
  if (!clock || !runtime) {
    throw new TypeError('File playback clock bindings or runtime seams are invalid');
  }

  let canonicalAsset: Readonly<FilePlaybackAssetSnapshot> | null = null;
  let checkingAuthority = false;
  const currentSnapshot = (): Readonly<FilePlaybackAssetSnapshot> | null => {
    try {
      return canonicalSnapshot(
        Reflect.apply(registrySnapshotForLease, registry, [roomToken, assetLease]),
      );
    } catch {
      return null;
    }
  };
  const assertAuthority = (): void => {
    if (checkingAuthority) throw new Error('File playback asset authority was re-entered');
    throwIfAborted(signal);
    const before = currentSnapshot();
    if (!before || !sameBinding(before, expectedBinding)) {
      throw new Error('File playback asset authority is stale');
    }
    if (canonicalAsset && !sameSnapshot(before, canonicalAsset)) {
      throw new Error('File playback asset metadata changed during construction');
    }
    checkingAuthority = true;
    let accepted: unknown;
    try {
      accepted = Reflect.apply(isCurrent as () => boolean, undefined, []);
    } finally {
      checkingAuthority = false;
    }
    if (accepted !== true) throw new Error('File playback asset staging was superseded');
    throwIfAborted(signal);
    const after = currentSnapshot();
    if (
      !after ||
      !sameBinding(after, expectedBinding) ||
      (canonicalAsset !== null && !sameSnapshot(after, canonicalAsset))
    ) {
      throw new Error('File playback asset authority changed during construction');
    }
  };
  const managerAuthority = (): boolean => {
    try {
      assertAuthority();
      return true;
    } catch {
      return false;
    }
  };

  assertAuthority();
  canonicalAsset = currentSnapshot();
  if (!canonicalAsset || !sameBinding(canonicalAsset, expectedBinding)) {
    throw new Error('File playback asset lease is unavailable');
  }
  assertAuthority();

  const rawResolution = Reflect.apply(registryResolveBlobAsset, registry, [roomToken, assetLease]);
  const blobResolution: Readonly<FilePlaybackBlobResolution> | null =
    rawResolution === null ? null : canonicalBlobResolution(rawResolution, canonicalAsset);
  if (
    (canonicalAsset.kind === 'blob' && blobResolution === null) ||
    (canonicalAsset.kind !== 'blob' && blobResolution !== null)
  ) {
    throw new Error('File playback asset body does not match its canonical kind');
  }
  assertAuthority();

  let rawFactoryResult: unknown = null;
  let factoryResult: FactoryResultSnapshot | null = null;
  let factoryOwnsGenericLease = false;
  let acquiredGenericSource: EncodedAudioSource | null = null;
  let managerOwnsSource = false;
  let cutoverPort: FilePlaybackCutoverCandidatePort | null = null;
  let releaseCalled = false;

  try {
    let factoryTask: Promise<BlobFilePlaybackSourceResult>;
    if (blobResolution) {
      const sourceMetadata = freezeCanonical({
        name: canonicalAsset.name,
        mime: canonicalAsset.mime,
      });
      factoryTask = Reflect.apply(runtime.createBlobSource, undefined, [
        {
          blob: blobResolution.blob,
          sourceIdentity: canonicalAsset.sourceIdentity,
          sourceMetadata,
          queueItemId: canonicalAsset.queueItemId as QueueItemId,
          audioContext: audioContext as AudioContext,
          nowRoomTimeMs: clock.nowRoomTimeMs,
          roomTimeMsToContextTime: clock.roomTimeMsToContextTime,
          localPerformanceMsToContextTime: clock.localPerformanceMsToContextTime,
          signal,
          decodeOrdinaryAudio: decodeOrdinaryAudio as OrdinaryAudioDecoder,
        },
      ]);
    } else {
      acquiredGenericSource = Reflect.apply(registryAcquireSource, registry, [
        roomToken,
        assetLease,
      ]);
      assertAuthority();
      factoryTask = Reflect.apply(runtime.createEncodedSource, undefined, [
        {
          encodedSource: acquiredGenericSource,
          queueItemId: canonicalAsset.queueItemId as QueueItemId,
          audioContext: audioContext as AudioContext,
          nowRoomTimeMs: clock.nowRoomTimeMs,
          roomTimeMsToContextTime: clock.roomTimeMsToContextTime,
          localPerformanceMsToContextTime: clock.localPerformanceMsToContextTime,
          signal,
        },
      ]);
      factoryOwnsGenericLease = true;
    }
    if (!(factoryTask instanceof Promise)) {
      throw new TypeError('File playback source factory must return a native Promise');
    }
    rawFactoryResult = await factoryTask;
    assertAuthority();
    factoryResult = inspectFactoryResult(rawFactoryResult, canonicalAsset.sourceIdentity);
    if (!factoryResult) {
      throw new TypeError('File playback source factory returned an invalid exact result');
    }
    assertAuthority();

    const candidateOptions = freezeCanonical({
      source: factoryResult.source,
      destination: destination as AudioNode,
      authority: managerAuthority,
    }) as FilePlaybackCutoverCandidateOptions;
    assertAuthority();
    const stageTask = Reflect.apply(runtime.stageCandidate, undefined, [manager, candidateOptions]);
    if (!(stageTask instanceof Promise)) {
      throw new TypeError('File playback manager staging must return a native Promise');
    }
    managerOwnsSource = true;

    let postHandoffError: unknown = null;
    try {
      assertAuthority();
    } catch (error) {
      postHandoffError = error;
    }
    try {
      cutoverPort = await stageTask;
    } catch (error) {
      throw postHandoffError ?? error;
    }
    if (postHandoffError !== null) throw postHandoffError;
    assertCutoverPort(cutoverPort);
    assertAuthority();
    const readiness = preparedReadiness(factoryResult, canonicalAsset);
    if (!readiness) {
      throw new TypeError('File playback staged source readiness is invalid');
    }
    assertAuthority();

    try {
      releaseCalled = true;
      Reflect.apply(factoryResult.releaseConstructionLease, undefined, []);
    } catch (error) {
      await suppressCleanup(() =>
        Reflect.apply(runtime.retireCandidate, undefined, [manager, cutoverPort!]),
      );
      cutoverPort = null;
      throw error;
    }
    assertAuthority();

    const metadata = freezeCanonical({ name: canonicalAsset.name, mime: canonicalAsset.mime });
    return freezeCanonical({
      cutoverPort,
      backend: factoryResult.backend,
      sourceIdentity: factoryResult.sourceIdentity,
      asset: canonicalAsset,
      metadata,
      readiness,
    });
  } catch (error) {
    if (cutoverPort) {
      await suppressCleanup(() =>
        Reflect.apply(runtime.retireCandidate, undefined, [manager, cutoverPort!]),
      );
      cutoverPort = null;
    } else if (!managerOwnsSource) {
      const cleanup = factoryResult
        ? { destroy: factoryResult.destroySource, release: factoryResult.releaseConstructionLease }
        : potentialFactoryCleanup(rawFactoryResult);
      await suppressCleanup(cleanup.destroy);
      if (!releaseCalled) {
        releaseCalled = true;
        suppressRelease(cleanup.release);
      }
      if (acquiredGenericSource && !factoryOwnsGenericLease) {
        await suppressCleanup(() => acquiredGenericSource!.close());
      }
    }
    throw error;
  } finally {
    if (factoryResult && !releaseCalled) {
      suppressRelease(factoryResult.releaseConstructionLease);
    }
  }
}
