import type { QueueItemId } from '../types/index.ts';
import {
  createDefaultAacStreamingWorker,
  StreamingAacPlaybackSource,
  type StreamingAacPlaybackSourceOptions,
} from './backends/streaming-aac-playback-source.ts';
import {
  StreamingMp3PlaybackSource,
  type StreamingMp3PlaybackSourceOptions,
} from './backends/streaming-mp3-playback-source.ts';
import {
  reconstructAdtsManifestStructure,
  type AdtsManifestStructuralReconstruction,
} from './aac/adts-manifest-structural-reconstruction.ts';
import {
  createAdtsDecoderTimelineEvidenceFromManifestReconstruction,
  type AdtsDecoderTimelineEvidence,
} from './aac/decoder-timeline-evidence.ts';
import { AdtsIncrementalFrameReader } from './aac/incremental-frame-reader.ts';
import {
  probeAacWebCodecsAdtsFrameInWorker,
  type AacWorkerCapabilityProbeRuntime,
} from './aac/worker-capability-probe.ts';
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
import { createMp3DecoderTimelineEvidenceFromManifestReconstruction } from './mp3/decoder-helpers.ts';
import type { Mp3DecoderTimelineEvidence } from './mp3/decoder-timeline-evidence.ts';
import {
  reconstructMp3ManifestStructure,
  type Mp3ManifestStructuralReconstruction,
} from './mp3/manifest-structural-reconstruction.ts';
import {
  type EncodedAudioSource,
  EncodedSourceIntegrityError,
} from './sources/encoded-audio-source.ts';
import type { BoundedStreamingCodecRuntime } from './streaming/bounded-codec-runtime.ts';

const PREPARE_OPTION_KEYS = Object.freeze([
  'registry',
  'roomToken',
  'assetLease',
  'manifestAdmission',
  'signal',
  'aacRuntime',
  'mp3Runtime',
  'runtimeForTests',
] as const);
const PREPARE_OPTIONAL_KEYS = new Set<(typeof PREPARE_OPTION_KEYS)[number]>([
  'aacRuntime',
  'mp3Runtime',
  'runtimeForTests',
]);
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
const CODEC_RUNTIME_KEYS = Object.freeze([
  'loadWorklet',
  'createWorker',
  'createWorkletNode',
  'createMessageChannel',
] as const satisfies readonly (keyof BoundedStreamingCodecRuntime)[]);
const TEST_RUNTIME_KEYS = Object.freeze([
  'aacCapabilityProbe',
  'createStreamingAacSource',
  'createStreamingMp3Source',
] as const);

type ExactRecord = Readonly<Record<string, unknown>>;
type AnyMethod = (...args: never[]) => unknown;

type AacCapabilityProbe = (
  frame: Uint8Array,
  signal: AbortSignal,
  runtime: AacWorkerCapabilityProbeRuntime,
) => Promise<void>;
type CreateStreamingAacSource = (
  options: StreamingAacPlaybackSourceOptions,
) => StreamingAacPlaybackSource;
type CreateStreamingMp3Source = (
  options: StreamingMp3PlaybackSourceOptions,
) => StreamingMp3PlaybackSource;

/** Browser/native seams used only by focused bridge boundary tests. */
export interface FilePlaybackPeerRangeManifestDecoderBridgeRuntimeForTests {
  readonly aacCapabilityProbe?: AacCapabilityProbe;
  readonly createStreamingAacSource?: CreateStreamingAacSource;
  readonly createStreamingMp3Source?: CreateStreamingMp3Source;
}

export interface PrepareFilePlaybackPeerRangeManifestDecoderConstructionOptions {
  readonly registry: FilePlaybackAssetRegistry;
  readonly roomToken: object;
  readonly assetLease: FilePlaybackAssetLease;
  readonly manifestAdmission: FilePlaybackPeerRangeManifestAdmission;
  readonly signal: AbortSignal;
  /** The same snapshotted worker authority is used by the ADTS canary and playback. */
  readonly aacRuntime?: Partial<BoundedStreamingCodecRuntime>;
  readonly mp3Runtime?: Partial<BoundedStreamingCodecRuntime>;
  readonly runtimeForTests?: FilePlaybackPeerRangeManifestDecoderBridgeRuntimeForTests;
}

declare const manifestDecoderConstructionBrand: unique symbol;

/**
 * Body-free, non-serializable authority over one disconnected decoder source.
 * Timeline evidence and the encoded source remain private in a WeakMap.
 */
export interface FilePlaybackPeerRangeManifestDecoderConstruction {
  readonly [manifestDecoderConstructionBrand]: never;
  readonly codec: 'adts-aac-lc' | 'mp3-no-frame-count';
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

export type FilePlaybackPeerRangeManifestDecoderSource =
  | StreamingAacPlaybackSource
  | StreamingMp3PlaybackSource;

interface TestRuntimeSnapshot {
  readonly aacCapabilityProbe: AacCapabilityProbe;
  readonly createStreamingAacSource: CreateStreamingAacSource;
  readonly createStreamingMp3Source: CreateStreamingMp3Source;
}

interface ConstructionRecord {
  readonly authority: Readonly<FilePlaybackPeerRangeManifestDecoderConstruction>;
  readonly registry: FilePlaybackAssetRegistry;
  readonly roomToken: object;
  readonly assetLease: FilePlaybackAssetLease;
  readonly manifestAdmission: FilePlaybackPeerRangeManifestAdmission;
  readonly admissionEvidence: Readonly<FilePlaybackPeerRangeManifestAdmissionEvidence>;
  readonly source: EncodedAudioSource;
  readonly signal: AbortSignal;
  readonly codecRuntime: Readonly<Partial<BoundedStreamingCodecRuntime>>;
  readonly runtimeForTests: TestRuntimeSnapshot;
  readonly decoderEvidence:
    | Readonly<AdtsDecoderTimelineEvidence>
    | Readonly<Mp3DecoderTimelineEvidence>;
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

function snapshotOptionalMethods(
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, AnyMethod>> {
  if (value === undefined) return Object.freeze(Object.create(null));
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${label} must be an exact record`);
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must be an exact record`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(keys);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
      throw new TypeError(`${label} has unknown methods`);
    }
    const result = Object.create(null) as Record<string, AnyMethod>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if (
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function'
      ) {
        throw new TypeError(`${label} ${key} must be an enumerable data method`);
      }
      const method = descriptor.value as AnyMethod;
      const receiver = value;
      result[key] = ((...args: never[]) => Reflect.apply(method, receiver, args)) as AnyMethod;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(label)) throw error;
    throw new TypeError(`${label} could not be snapshotted`, { cause: error });
  }
}

function snapshotCodecRuntime(
  value: unknown,
  codec: 'adts-aac-lc' | 'mp3-no-frame-count',
): Readonly<Partial<BoundedStreamingCodecRuntime>> {
  const methods = snapshotOptionalMethods(value, CODEC_RUNTIME_KEYS, `${codec} playback runtime`);
  const runtime = Object.create(null) as Partial<BoundedStreamingCodecRuntime>;
  for (const key of CODEC_RUNTIME_KEYS) {
    const method = methods[key] as BoundedStreamingCodecRuntime[typeof key] | undefined;
    if (method) Object.defineProperty(runtime, key, { enumerable: true, value: method });
  }
  if (codec === 'adts-aac-lc' && runtime.createWorker === undefined) {
    Object.defineProperty(runtime, 'createWorker', {
      enumerable: true,
      value: createDefaultAacStreamingWorker,
    });
  }
  return Object.freeze(runtime);
}

function snapshotTestRuntime(value: unknown): TestRuntimeSnapshot {
  const methods = snapshotOptionalMethods(
    value,
    TEST_RUNTIME_KEYS,
    'manifest decoder test runtime',
  );
  return Object.freeze({
    aacCapabilityProbe:
      (methods.aacCapabilityProbe as AacCapabilityProbe | undefined) ??
      probeAacWebCodecsAdtsFrameInWorker,
    createStreamingAacSource:
      (methods.createStreamingAacSource as CreateStreamingAacSource | undefined) ??
      ((options: StreamingAacPlaybackSourceOptions) => new StreamingAacPlaybackSource(options)),
    createStreamingMp3Source:
      (methods.createStreamingMp3Source as CreateStreamingMp3Source | undefined) ??
      ((options: StreamingMp3PlaybackSourceOptions) => new StreamingMp3PlaybackSource(options)),
  });
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
  const codecRuntime = snapshotCodecRuntime(
    manifest.codec === 'adts-aac-lc' ? input.aacRuntime : input.mp3Runtime,
    manifest.codec,
  );
  const runtimeForTests = snapshotTestRuntime(input.runtimeForTests);

  let source: EncodedAudioSource | null = null;
  let published = false;
  try {
    const acquiredSource = Reflect.apply(registryAcquireSource, registry, [roomToken, assetLease]);
    source = acquiredSource;
    assertSourceMatchesAsset(acquiredSource, admissionEvidence.asset);
    abortThrowIfAborted(signal);

    let reconstruction: AdtsManifestStructuralReconstruction | Mp3ManifestStructuralReconstruction;
    let decoderEvidence:
      | Readonly<AdtsDecoderTimelineEvidence>
      | Readonly<Mp3DecoderTimelineEvidence>;
    if (manifest.codec === 'adts-aac-lc') {
      reconstruction = await reconstructAdtsManifestStructure({
        manifest,
        signal,
        source: acquiredSource,
      });
      decoderEvidence = createAdtsDecoderTimelineEvidenceFromManifestReconstruction(reconstruction);

      const firstFrameLength = reconstruction.endpointChecks.firstFrameByteLength;
      const reader = new AdtsIncrementalFrameReader({
        source: acquiredSource,
        start: { byteOffset: manifest.audioStartByte, frameOrdinal: 0 },
        expectedConfig: reconstruction.coreConfiguration,
        pageBytes: firstFrameLength,
      });
      const firstFrame = await reader.readNext(signal);
      if (
        !firstFrame ||
        firstFrame.bytes.byteLength !== firstFrameLength ||
        firstFrame.descriptor.frameOrdinal !== 0 ||
        firstFrame.descriptor.byteOffset !== manifest.audioStartByte ||
        firstFrame.descriptor.byteEndOffset !== manifest.audioStartByte + firstFrameLength ||
        firstFrame.descriptor.header.frameLengthBytes !== firstFrameLength
      ) {
        throw new EncodedSourceIntegrityError(
          'ADTS manifest canary reread contradicts its reconstructed first endpoint',
        );
      }
      try {
        const probeTask = runtimeForTests.aacCapabilityProbe(
          firstFrame.bytes,
          signal,
          codecRuntime as AacWorkerCapabilityProbeRuntime,
        );
        if (!(probeTask instanceof Promise)) {
          throw new TypeError('AAC manifest capability probe must return a native Promise');
        }
        await probeTask;
      } finally {
        try {
          firstFrame.bytes.fill(0);
        } catch {
          // The one-frame canary copy is bounded and becomes unreachable here.
        }
      }
    } else {
      reconstruction = await reconstructMp3ManifestStructure({
        manifest,
        signal,
        source: acquiredSource,
      });
      decoderEvidence = createMp3DecoderTimelineEvidenceFromManifestReconstruction(reconstruction);
    }

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
      codec: manifest.codec,
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
      codecRuntime,
      runtimeForTests,
      decoderEvidence,
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
    const common = {
      queueItemId: record.authority.queueItemId,
      encodedSource: record.source,
      audioContext: input.audioContext as AudioContext,
      nowRoomTimeMs: clock.nowRoomTimeMs,
      roomTimeMsToContextTime: clock.roomTimeMsToContextTime,
      localPerformanceMsToContextTime: clock.localPerformanceMsToContextTime,
      runtime: record.codecRuntime,
    } as const;
    const source: FilePlaybackPeerRangeManifestDecoderSource =
      record.authority.codec === 'adts-aac-lc'
        ? record.runtimeForTests.createStreamingAacSource({
            ...common,
            timelineEvidence: record.decoderEvidence as Readonly<AdtsDecoderTimelineEvidence>,
            backendId: 'webcodecs',
          })
        : record.runtimeForTests.createStreamingMp3Source({
            ...common,
            timelineEvidence: record.decoderEvidence as Readonly<Mp3DecoderTimelineEvidence>,
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
