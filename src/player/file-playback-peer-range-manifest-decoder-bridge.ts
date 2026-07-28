import type { QueueItemId } from '../types/index.ts';
import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetLease,
  type FilePlaybackAssetSnapshot,
} from './file-playback-asset-registry.ts';
import type { FilePlaybackClockBindings } from './file-playback-clock.ts';
import {
  readFilePlaybackPeerRangeManifestAdmission,
  type FilePlaybackPeerRangeManifestAdmission,
  type FilePlaybackPeerRangeManifestAdmissionEvidence,
} from './file-playback-peer-range-manifest-acquisition.ts';
import {
  bindManifestCodecHandler,
  MANIFEST_CODEC_HANDLER_RUNTIME_OPTION_KEYS,
  type ManifestCodecDecoderSource,
  type ManifestCodecHandlerRuntimeForTests,
  type ManifestCodecHandlerRuntimeOptions,
  type PreparedManifestCodecHandler,
} from './file-playback-peer-range-manifest-codec-handler.ts';
import type { CodecTimelineManifestCodec } from './manifests/codec-timeline-manifest.ts';
import {
  type EncodedAudioSource,
  EncodedSourceIntegrityError,
} from './sources/encoded-audio-source.ts';

const PREPARE_OPTION_KEYS = Object.freeze([
  'registry',
  'roomToken',
  'assetLease',
  'manifestAdmission',
  'signal',
  ...MANIFEST_CODEC_HANDLER_RUNTIME_OPTION_KEYS,
] as const);
const PREPARE_OPTIONAL_KEYS = new Set<(typeof PREPARE_OPTION_KEYS)[number]>(
  MANIFEST_CODEC_HANDLER_RUNTIME_OPTION_KEYS,
);
const CONSTRUCT_OPTION_KEYS = Object.freeze([
  'authority',
  'registry',
  'roomToken',
  'assetLease',
  'audioContext',
  'clockBindings',
] as const);
const CLOCK_KEYS = Object.freeze([
  'nowRoomTimeMs',
  'roomTimeMsToContextTime',
  'localPerformanceMsToContextTime',
] as const);
type ExactRecord = Readonly<Record<string, unknown>>;
type AnyMethod = (...args: never[]) => unknown;

/** Browser/native seams used only by focused bridge boundary tests. */
export type FilePlaybackPeerRangeManifestDecoderBridgeRuntimeForTests =
  ManifestCodecHandlerRuntimeForTests;

export interface PrepareFilePlaybackPeerRangeManifestDecoderConstructionOptions extends ManifestCodecHandlerRuntimeOptions {
  readonly registry: FilePlaybackAssetRegistry;
  readonly roomToken: object;
  readonly assetLease: FilePlaybackAssetLease;
  readonly manifestAdmission: FilePlaybackPeerRangeManifestAdmission;
  readonly signal: AbortSignal;
}

declare const manifestDecoderConstructionBrand: unique symbol;

/**
 * Body-free, non-serializable authority over one disconnected decoder source.
 * Timeline evidence and the encoded source remain private in a WeakMap.
 */
export interface FilePlaybackPeerRangeManifestDecoderConstruction {
  readonly [manifestDecoderConstructionBrand]: never;
  readonly codec: CodecTimelineManifestCodec;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly sourceSize: number;
}

export interface ConstructFilePlaybackPeerRangeManifestDecoderOptions {
  readonly authority: FilePlaybackPeerRangeManifestDecoderConstruction;
  /** Must be the exact registry authority captured during preparation. */
  readonly registry: FilePlaybackAssetRegistry;
  readonly roomToken: object;
  readonly assetLease: FilePlaybackAssetLease;
  readonly audioContext: AudioContext;
  readonly clockBindings: FilePlaybackClockBindings;
}

export type FilePlaybackPeerRangeManifestDecoderSource = ManifestCodecDecoderSource;

interface ConstructionRecord {
  readonly authority: Readonly<FilePlaybackPeerRangeManifestDecoderConstruction>;
  readonly registry: FilePlaybackAssetRegistry;
  readonly roomToken: object;
  readonly assetLease: FilePlaybackAssetLease;
  readonly manifestAdmission: FilePlaybackPeerRangeManifestAdmission;
  readonly admissionEvidence: Readonly<FilePlaybackPeerRangeManifestAdmissionEvidence>;
  readonly source: EncodedAudioSource;
  readonly signal: AbortSignal;
  readonly codecHandler: Readonly<PreparedManifestCodecHandler>;
  status: 'available' | 'constructing' | 'consumed' | 'retiring' | 'retired';
  revoked: boolean;
  cleanupStarted: boolean;
  removeAbortListener: () => void;
  retirementPromise: Promise<boolean> | null;
  retirementResolve: ((retired: boolean) => void) | null;
  retirementReject: ((error: unknown) => void) | null;
}

const CONSTRUCTIONS = new WeakMap<object, ConstructionRecord>();
const RETIREMENTS = new WeakMap<object, Promise<boolean>>();

const registryAcquireSource = FilePlaybackAssetRegistry.prototype.acquireSource;
const nativeAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const nativeAddEventListener = EventTarget.prototype.addEventListener;
const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;

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
    const allowed = new Set<string>(keys);
    if (
      ownKeys.length !== allowed.size ||
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))
    ) {
      return null;
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

function snapshotPrepareOptions(value: unknown): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(PREPARE_OPTION_KEYS);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      PREPARE_OPTION_KEYS.some(
        (key) => !PREPARE_OPTIONAL_KEYS.has(key) && !Object.hasOwn(descriptors, key),
      )
    ) {
      return null;
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of PREPARE_OPTION_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor) {
        result[key] = undefined;
        continue;
      }
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
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

function abortThrowIfAborted(signal: AbortSignal): void {
  Reflect.apply(nativeAbortThrowIfAborted, signal, []);
}

function sameAsset(
  left: Readonly<FilePlaybackAssetSnapshot>,
  right: Readonly<FilePlaybackAssetSnapshot>,
): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.sourceIdentity === right.sourceIdentity &&
    left.transferSessionId === right.transferSessionId &&
    left.kind === right.kind &&
    left.size === right.size &&
    left.name === right.name &&
    left.mime === right.mime
  );
}

function assertSourceMatchesAsset(
  source: EncodedAudioSource,
  asset: Readonly<FilePlaybackAssetSnapshot>,
): void {
  if (
    source.kind !== asset.kind ||
    source.identity !== asset.sourceIdentity ||
    source.size !== asset.size ||
    source.metadata.name !== asset.name ||
    source.metadata.mime !== asset.mime
  ) {
    throw new EncodedSourceIntegrityError(
      'Manifest decoder source does not match its admitted registry asset',
    );
  }
}

function assertLiveAuthority(record: ConstructionRecord): void {
  abortThrowIfAborted(record.signal);
  const evidence = readFilePlaybackPeerRangeManifestAdmission(
    record.manifestAdmission,
    record.assetLease,
  );
  if (
    evidence !== record.admissionEvidence ||
    !sameAsset(evidence.asset, record.admissionEvidence.asset)
  ) {
    throw new Error('File playback manifest decoder admission changed during construction');
  }
  assertSourceMatchesAsset(record.source, record.admissionEvidence.asset);
  abortThrowIfAborted(record.signal);
}

function clockSnapshot(value: unknown): Readonly<FilePlaybackClockBindings> | null {
  const record = snapshotExactRecord(value, CLOCK_KEYS);
  if (
    !record ||
    typeof record.nowRoomTimeMs !== 'function' ||
    typeof record.roomTimeMsToContextTime !== 'function' ||
    typeof record.localPerformanceMsToContextTime !== 'function'
  ) {
    return null;
  }
  const receiver = value as FilePlaybackClockBindings;
  const nowRoomTimeMs = record.nowRoomTimeMs as FilePlaybackClockBindings['nowRoomTimeMs'];
  const roomTimeMsToContextTime =
    record.roomTimeMsToContextTime as FilePlaybackClockBindings['roomTimeMsToContextTime'];
  const localPerformanceMsToContextTime =
    record.localPerformanceMsToContextTime as FilePlaybackClockBindings['localPerformanceMsToContextTime'];
  return freezeCanonical({
    nowRoomTimeMs: () => Reflect.apply(nowRoomTimeMs, receiver, []),
    roomTimeMsToContextTime: (roomTimeMs: number) =>
      Reflect.apply(roomTimeMsToContextTime, receiver, [roomTimeMs]),
    localPerformanceMsToContextTime: (localPerformanceTimeMs: number) =>
      Reflect.apply(localPerformanceMsToContextTime, receiver, [localPerformanceTimeMs]),
  });
}

async function closeSource(source: EncodedAudioSource): Promise<void> {
  await source.close();
}

async function suppressClose(source: EncodedAudioSource): Promise<void> {
  try {
    await closeSource(source);
  } catch {
    // Preserve the admission/reconstruction failure that made cleanup necessary.
  }
}

function removeAbortListener(record: ConstructionRecord): void {
  const remove = record.removeAbortListener;
  record.removeAbortListener = () => undefined;
  try {
    remove();
  } catch {
    // A native listener is advisory; source retirement remains authoritative.
  }
}

function findDataMethod(value: object, name: string): AnyMethod | null {
  try {
    let cursor: object | null = value;
    const seen = new WeakSet<object>();
    for (let depth = 0; cursor && depth < 32; depth += 1) {
      if (seen.has(cursor)) return null;
      seen.add(cursor);
      const descriptor = Reflect.getOwnPropertyDescriptor(cursor, name);
      if (descriptor) {
        return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
          ? (descriptor.value as AnyMethod)
          : null;
      }
      cursor = Reflect.getPrototypeOf(cursor);
    }
  } catch {
    return null;
  }
  return null;
}

function decoderSourceDestroyer(value: unknown): (() => Promise<void>) | null {
  if (value === null || typeof value !== 'object') return null;
  const destroy = findDataMethod(value, 'destroy');
  if (!destroy) return null;
  let promise: Promise<void> | null = null;
  return () => {
    if (promise) return promise;
    try {
      const result = Reflect.apply(destroy, value, []);
      promise =
        result instanceof Promise
          ? (result as Promise<void>)
          : Promise.reject(new TypeError('Manifest decoder source destroy must return a Promise'));
    } catch (error) {
      promise = Promise.reject(error);
    }
    return promise;
  };
}

function ensureRetirementPromise(record: ConstructionRecord): Promise<boolean> {
  if (record.retirementPromise) return record.retirementPromise;
  const task = new Promise<boolean>((resolve, reject) => {
    record.retirementResolve = resolve;
    record.retirementReject = reject;
  });
  record.retirementPromise = task;
  RETIREMENTS.set(record.authority as object, task);
  return task;
}

function beginRetirementCleanup(
  record: ConstructionRecord,
  cleanup: () => Promise<void>,
): Promise<boolean> {
  const task = ensureRetirementPromise(record);
  if (record.cleanupStarted) return task;
  record.cleanupStarted = true;
  record.status = 'retiring';
  removeAbortListener(record);
  CONSTRUCTIONS.delete(record.authority as object);
  void Promise.resolve()
    .then(cleanup)
    .then(
      () => {
        record.status = 'retired';
        const resolve = record.retirementResolve;
        record.retirementResolve = null;
        record.retirementReject = null;
        resolve?.(true);
      },
      (error: unknown) => {
        record.status = 'retired';
        const reject = record.retirementReject;
        record.retirementResolve = null;
        record.retirementReject = null;
        reject?.(error);
      },
    );
  return task;
}

function retireRecord(record: ConstructionRecord): Promise<boolean> {
  if (record.status === 'consumed') return Promise.resolve(false);
  record.revoked = true;
  if (record.status === 'constructing') {
    return ensureRetirementPromise(record);
  }
  return beginRetirementCleanup(record, () => closeSource(record.source));
}

/**
 * Resolve one exact live manifest admission into a disconnected, one-shot
 * decoder construction. This module is deliberately not wired into the
 * product factory while the peer-manifest feature gate remains off.
 */
export async function prepareFilePlaybackPeerRangeManifestDecoderConstruction(
  options: PrepareFilePlaybackPeerRangeManifestDecoderConstructionOptions,
): Promise<Readonly<FilePlaybackPeerRangeManifestDecoderConstruction>> {
  const input = snapshotPrepareOptions(options);
  if (!input) throw new TypeError('Manifest decoder construction options are invalid');

  const registry = input.registry;
  const roomToken = input.roomToken;
  const assetLease = input.assetLease;
  const manifestAdmission = input.manifestAdmission;
  const signal = input.signal;
  if (!exactRegistry(registry)) {
    throw new TypeError('An exact file playback asset registry is required');
  }
  if (roomToken === null || typeof roomToken !== 'object') {
    throw new TypeError('An opaque file playback room token is required');
  }
  if (assetLease === null || typeof assetLease !== 'object') {
    throw new TypeError('An exact file playback asset lease is required');
  }
  if (manifestAdmission === null || typeof manifestAdmission !== 'object') {
    throw new TypeError('An exact file playback manifest admission is required');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('An exact manifest decoder AbortSignal is required');
  }
  abortThrowIfAborted(signal);

  const admissionEvidence = readFilePlaybackPeerRangeManifestAdmission(
    manifestAdmission as FilePlaybackPeerRangeManifestAdmission,
    assetLease as FilePlaybackAssetLease,
  );
  const manifest = admissionEvidence.manifest;
  const boundCodecHandler = bindManifestCodecHandler(manifest, input);

  let source: EncodedAudioSource | null = null;
  let published = false;
  try {
    const acquiredSource = Reflect.apply(registryAcquireSource, registry, [roomToken, assetLease]);
    source = acquiredSource;
    assertSourceMatchesAsset(acquiredSource, admissionEvidence.asset);
    abortThrowIfAborted(signal);

    const codecHandler = await boundCodecHandler.prepare(acquiredSource, signal);

    abortThrowIfAborted(signal);
    const liveEvidence = readFilePlaybackPeerRangeManifestAdmission(
      manifestAdmission as FilePlaybackPeerRangeManifestAdmission,
      assetLease as FilePlaybackAssetLease,
    );
    if (liveEvidence !== admissionEvidence) {
      throw new Error('File playback manifest decoder admission changed during preparation');
    }
    assertSourceMatchesAsset(acquiredSource, admissionEvidence.asset);

    const authority = freezeCanonical({
      codec: codecHandler.codec,
      queueItemId: admissionEvidence.asset.queueItemId as QueueItemId,
      sourceIdentity: admissionEvidence.asset.sourceIdentity,
      sourceSize: admissionEvidence.asset.size,
    }) as unknown as Readonly<FilePlaybackPeerRangeManifestDecoderConstruction>;
    const record: ConstructionRecord = {
      authority,
      registry,
      roomToken: roomToken as object,
      assetLease: assetLease as FilePlaybackAssetLease,
      manifestAdmission: manifestAdmission as FilePlaybackPeerRangeManifestAdmission,
      admissionEvidence,
      source: acquiredSource,
      signal,
      codecHandler,
      status: 'available',
      revoked: false,
      cleanupStarted: false,
      removeAbortListener: () => undefined,
      retirementPromise: null,
      retirementResolve: null,
      retirementReject: null,
    };
    CONSTRUCTIONS.set(authority as object, record);
    try {
      const onAbort = (): void => {
        void retireRecord(record).catch(() => undefined);
      };
      Reflect.apply(nativeAddEventListener, signal, ['abort', onAbort, { once: true }]);
      record.removeAbortListener = () => {
        Reflect.apply(nativeRemoveEventListener, signal, ['abort', onAbort]);
      };
      assertLiveAuthority(record);
    } catch (error) {
      if (record.retirementPromise) {
        await record.retirementPromise.catch(() => undefined);
        source = null;
      } else {
        removeAbortListener(record);
        record.status = 'retired';
        CONSTRUCTIONS.delete(authority as object);
      }
      throw error;
    }
    published = true;
    return authority;
  } catch (error) {
    if (source && !published) await suppressClose(source);
    throw error;
  }
}

/**
 * Consume a prepared capability exactly once and transfer its exact source
 * lease directly to the codec wrapper. Raw decoder evidence never crosses the
 * generic product source-factory API.
 */
export async function constructFilePlaybackPeerRangeManifestDecoder(
  options: ConstructFilePlaybackPeerRangeManifestDecoderOptions,
): Promise<FilePlaybackPeerRangeManifestDecoderSource> {
  const input = snapshotExactRecord(options, CONSTRUCT_OPTION_KEYS);
  if (!input) throw new TypeError('Manifest decoder construct options are invalid');
  const authority = input.authority;
  const record =
    authority !== null && typeof authority === 'object'
      ? CONSTRUCTIONS.get(authority as object)
      : undefined;
  if (!record || record.authority !== authority || record.status !== 'available') {
    throw new Error('File playback manifest decoder construction is stale');
  }
  if (
    input.registry !== record.registry ||
    input.roomToken !== record.roomToken ||
    input.assetLease !== record.assetLease
  ) {
    throw new Error('File playback manifest decoder construction belongs to another asset lease');
  }
  if (input.audioContext === null || typeof input.audioContext !== 'object') {
    throw new TypeError('A manifest decoder AudioContext is required');
  }
  const clock = clockSnapshot(input.clockBindings);
  if (!clock) throw new TypeError('Manifest decoder clock bindings are invalid');

  record.status = 'constructing';
  let destroyConstructedSource: (() => Promise<void>) | null = null;
  try {
    assertLiveAuthority(record);
    if (record.revoked) {
      throw new Error('File playback manifest decoder construction was revoked');
    }
    const source = record.codecHandler.constructSource({
      queueItemId: record.authority.queueItemId,
      encodedSource: record.source,
      audioContext: input.audioContext as AudioContext,
      nowRoomTimeMs: clock.nowRoomTimeMs,
      roomTimeMsToContextTime: clock.roomTimeMsToContextTime,
      localPerformanceMsToContextTime: clock.localPerformanceMsToContextTime,
    });
    destroyConstructedSource = decoderSourceDestroyer(source);
    if (!destroyConstructedSource) {
      throw new TypeError('Manifest decoder factory returned an invalid destroyable source');
    }
    assertLiveAuthority(record);
    if (record.revoked) {
      throw new Error('File playback manifest decoder construction was revoked');
    }
    removeAbortListener(record);
    record.status = 'consumed';
    CONSTRUCTIONS.delete(record.authority as object);
    return source;
  } catch (error) {
    record.revoked = true;
    const cleanup = beginRetirementCleanup(
      record,
      destroyConstructedSource ?? (() => closeSource(record.source)),
    );
    await cleanup.catch(() => undefined);
    throw error;
  }
}

/** Close one still-disconnected source. Repeated calls join the same cleanup. */
export function retireFilePlaybackPeerRangeManifestDecoderConstruction(
  authority: FilePlaybackPeerRangeManifestDecoderConstruction,
): Promise<boolean> {
  const record =
    authority !== null && typeof authority === 'object'
      ? CONSTRUCTIONS.get(authority as object)
      : undefined;
  if (!record || record.authority !== authority) {
    return authority !== null && typeof authority === 'object'
      ? (RETIREMENTS.get(authority as object) ?? Promise.resolve(false))
      : Promise.resolve(false);
  }
  return retireRecord(record);
}
