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
  snapshotFilePlaybackBoundedRoutePolicy,
  type FilePlaybackBoundedRoutePolicy,
} from './file-playback-bounded-route-policy.ts';
import {
  FilePlaybackManager,
  isExactFilePlaybackManager,
  type FilePlaybackCutoverCandidateOptions,
  type FilePlaybackCutoverCandidatePort,
} from './file-playback-manager.ts';
import {
  constructFilePlaybackPeerRangeManifestDecoder,
  retireFilePlaybackPeerRangeManifestDecoderConstruction,
  type FilePlaybackPeerRangeManifestDecoderConstruction,
} from './file-playback-peer-range-manifest-decoder-bridge.ts';
import {
  createFilePlaybackSourceSnapshot,
  type FilePlaybackCutoverSource,
  type FilePlaybackSourceSnapshot,
} from './file-playback-source.ts';
import {
  createBlobFilePlaybackSource,
  createEncodedFilePlaybackSource,
  codecTimelineHostArtifactForFilePlaybackSourceResult,
  type BlobFilePlaybackSourceResult,
  type CreateBlobFilePlaybackSourceOptions,
  type CreateEncodedFilePlaybackSourceOptions,
  type OrdinaryAudioDecoder,
} from './file-playback-source-factory.ts';
import {
  describeCodecTimelineHostArtifactForLease,
  installCodecTimelineHostArtifactForLease,
} from './manifests/codec-timeline-host-artifact-lease-store.ts';
import type {
  CodecTimelineHostArtifact,
  CodecTimelineHostArtifactBinding,
} from './manifests/codec-timeline-host-artifact.ts';
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
  'boundedRoutePolicy',
  'installCodecTimelineHostArtifact',
  'runtime',
] as const);
const OPTIONAL_OPTION_KEYS = new Set<(typeof OPTION_KEYS)[number]>([
  'boundedRoutePolicy',
  'installCodecTimelineHostArtifact',
  'runtime',
]);
const REQUIRED_OPTION_KEYS = OPTION_KEYS.filter((key) => !OPTIONAL_OPTION_KEYS.has(key));
const WARM_OPTION_KEYS = Object.freeze([
  'registry',
  'roomToken',
  'assetLease',
  'expectedBinding',
  'audioContext',
  'clockBindings',
  'signal',
  'isCurrent',
  'decodeOrdinaryAudio',
  'boundedRoutePolicy',
  'installCodecTimelineHostArtifact',
  'runtime',
] as const);
const OPTIONAL_WARM_OPTION_KEYS = new Set<(typeof WARM_OPTION_KEYS)[number]>([
  'boundedRoutePolicy',
  'installCodecTimelineHostArtifact',
  'runtime',
]);
const REQUIRED_WARM_OPTION_KEYS = WARM_OPTION_KEYS.filter(
  (key) => !OPTIONAL_WARM_OPTION_KEYS.has(key),
);
const WARM_HANDOFF_OPTION_KEYS = Object.freeze([
  'authority',
  'manager',
  'destination',
  'signal',
  'isCurrent',
] as const);
const MANIFEST_WARM_OPTION_KEYS = Object.freeze([
  'construction',
  'registry',
  'roomToken',
  'assetLease',
  'expectedBinding',
  'audioContext',
  'clockBindings',
  'signal',
  'isCurrent',
  'runtime',
] as const);
const OPTIONAL_MANIFEST_WARM_OPTION_KEYS = new Set<(typeof MANIFEST_WARM_OPTION_KEYS)[number]>([
  'runtime',
]);
const REQUIRED_MANIFEST_WARM_OPTION_KEYS = MANIFEST_WARM_OPTION_KEYS.filter(
  (key) => !OPTIONAL_MANIFEST_WARM_OPTION_KEYS.has(key),
);
const MANIFEST_STAGE_OPTION_KEYS = Object.freeze([
  ...MANIFEST_WARM_OPTION_KEYS,
  'manager',
  'destination',
] as const);
const MANIFEST_CONSTRUCTION_KEYS = Object.freeze([
  'codec',
  'queueItemId',
  'sourceIdentity',
  'sourceSize',
] as const);
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
] as const);
const STREAMING_FACTORY_RESULT_KEYS = Object.freeze([
  'backend',
  'source',
  'sourceIdentity',
  'releaseConstructionLease',
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
  /** Omit to preserve the current AudioBuffer route for MP3/M4A. */
  readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
  /** Exact opt-in for issuing and lease-binding a reusable host codec timeline. */
  readonly installCodecTimelineHostArtifact?: true;
  readonly runtime?: FilePlaybackAssetSourceStagerRuntimeForTests;
}

/**
 * Revision-free construction boundary for one exact room-local asset.
 *
 * Manager, destination, run and playback revision deliberately do not belong
 * to this contract. The returned capability is runtime-opaque; its enumerable
 * fields are frozen, body-free diagnostics only.
 */
export interface PrepareFilePlaybackAssetSourceWarmOptions {
  readonly registry: FilePlaybackAssetRegistry;
  readonly roomToken: object;
  readonly assetLease: FilePlaybackAssetLease;
  readonly expectedBinding: FilePlaybackAssetBinding;
  readonly audioContext: AudioContext;
  readonly clockBindings: FilePlaybackClockBindings;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
  readonly installCodecTimelineHostArtifact?: true;
  readonly runtime?: FilePlaybackAssetSourceStagerRuntimeForTests;
}

/**
 * Narrow test seams for the final manager handoff. Decoder construction is
 * deliberately not replaceable through this contract.
 */
export interface FilePlaybackPeerRangeManifestAssetSourceStagerRuntimeForTests {
  readonly stageCandidate?: FilePlaybackAssetSourceStagerRuntimeForTests['stageCandidate'];
  readonly retireCandidate?: FilePlaybackAssetSourceStagerRuntimeForTests['retireCandidate'];
}

/**
 * Consumes one opaque manifest-decoder construction into the existing warm
 * source boundary. Raw source leases and timeline evidence never enter this
 * public contract.
 */
export interface PrepareFilePlaybackPeerRangeManifestAssetSourceWarmOptions {
  readonly construction: FilePlaybackPeerRangeManifestDecoderConstruction;
  readonly registry: FilePlaybackAssetRegistry;
  readonly roomToken: object;
  readonly assetLease: FilePlaybackAssetLease;
  readonly expectedBinding: FilePlaybackAssetBinding;
  readonly audioContext: AudioContext;
  readonly clockBindings: FilePlaybackClockBindings;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly runtime?: FilePlaybackPeerRangeManifestAssetSourceStagerRuntimeForTests;
}

export interface StageFilePlaybackPeerRangeManifestAssetSourceOptions extends PrepareFilePlaybackPeerRangeManifestAssetSourceWarmOptions {
  readonly manager: FilePlaybackManager;
  readonly destination: AudioNode;
}

declare const warmSourceAuthorityBrand: unique symbol;

/** Opaque, exact one-shot authority over a prepared but disconnected source. */
export interface FilePlaybackWarmSourceAuthority {
  readonly [warmSourceAuthorityBrand]: never;
  readonly backend: BlobFilePlaybackSourceResult['backend'];
  readonly sourceIdentity: string;
  readonly asset: Readonly<FilePlaybackAssetSnapshot>;
  readonly metadata: Readonly<FilePlaybackAssetMetadata>;
  readonly readiness: Readonly<FilePlaybackPreparedSourceReadiness>;
}

export interface HandoffFilePlaybackWarmSourceOptions {
  readonly authority: FilePlaybackWarmSourceAuthority;
  readonly manager: FilePlaybackManager;
  readonly destination: AudioNode;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
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
  readonly prepareSource: (signal: AbortSignal) => unknown;
  readonly getSnapshot: () => unknown;
}

type WarmSourceStatus = 'prepared' | 'handing-off' | 'handed-off' | 'retiring' | 'retired';

interface WarmSourceRecord {
  readonly authority: Readonly<FilePlaybackWarmSourceAuthority>;
  readonly registry: FilePlaybackAssetRegistry;
  readonly roomToken: object;
  readonly assetLease: FilePlaybackAssetLease;
  readonly expectedBinding: Readonly<FilePlaybackAssetBinding>;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly runtime: RuntimeSnapshot;
  readonly factory: FactoryResultSnapshot;
  readonly asset: Readonly<FilePlaybackAssetSnapshot>;
  readonly readiness: Readonly<FilePlaybackPreparedSourceReadiness>;
  status: WarmSourceStatus;
  checkingAuthority: boolean;
  removeAbortListener: () => void;
  handoffPromise: Promise<Readonly<StagedFilePlaybackAssetSource>> | null;
  retirementPromise: Promise<boolean> | null;
  retirementReason: Error | null;
}

const WARM_SOURCE_RECORDS = new WeakMap<object, WarmSourceRecord>();
/** Lets an owner join mandatory cleanup even after an abort listener removed the live record. */
const WARM_SOURCE_RETIREMENTS = new WeakMap<object, Promise<boolean>>();

const registrySnapshotForLease = FilePlaybackAssetRegistry.prototype.snapshotForLease;
const registryResolveBlobAsset = FilePlaybackAssetRegistry.prototype.resolveBlobAsset;
const registryAcquireSource = FilePlaybackAssetRegistry.prototype.acquireSource;
const managerStageCutoverCandidate = FilePlaybackManager.prototype.stageCutoverCandidate;
const managerRetireCutoverCandidate = FilePlaybackManager.prototype.retireCutoverCandidate;
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
      if (OPTIONAL_OPTION_KEYS.has(key) && !descriptor) {
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

function snapshotWarmOptions(value: unknown): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(WARM_OPTION_KEYS);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      REQUIRED_WARM_OPTION_KEYS.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of WARM_OPTION_KEYS) {
      const descriptor = descriptors[key];
      if (OPTIONAL_WARM_OPTION_KEYS.has(key) && !descriptor) {
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

function snapshotManifestWarmOptions(value: unknown): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(MANIFEST_WARM_OPTION_KEYS);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      REQUIRED_MANIFEST_WARM_OPTION_KEYS.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of MANIFEST_WARM_OPTION_KEYS) {
      const descriptor = descriptors[key];
      if (OPTIONAL_MANIFEST_WARM_OPTION_KEYS.has(key) && !descriptor) {
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

function snapshotManifestStageOptions(value: unknown): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(MANIFEST_STAGE_OPTION_KEYS);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      MANIFEST_STAGE_OPTION_KEYS.some(
        (key) => key !== 'runtime' && !Object.hasOwn(descriptors, key),
      )
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of MANIFEST_STAGE_OPTION_KEYS) {
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

function snapshotWarmHandoffOptions(value: unknown): ExactRecord | null {
  return snapshotExactRecord(value, WARM_HANDOFF_OPTION_KEYS);
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

function manifestRuntimeSnapshot(value: unknown): RuntimeSnapshot | null {
  if (value === undefined) return runtimeSnapshot(undefined);
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(['stageCandidate', 'retireCandidate']);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) return null;
    const snapshot = Object.create(null) as Record<string, DataMethod>;
    for (const key of allowed) {
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
    return runtimeSnapshot(Object.freeze(snapshot));
  } catch {
    return null;
  }
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

function codecTimelineHostArtifactBindingFromAsset(
  asset: Readonly<FilePlaybackAssetSnapshot>,
): Readonly<CodecTimelineHostArtifactBinding> {
  return freezeCanonical({
    queueItemId: asset.queueItemId,
    sourceIdentity: asset.sourceIdentity,
    transferSessionId: asset.transferSessionId,
    encodedSize: asset.size,
    name: asset.name,
    mime: asset.mime,
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
    // Publish the one-shot promise before entering source-owned cleanup. A
    // synchronous destroy side effect may re-enter warm retirement; deferring
    // the invocation makes that path join this exact promise instead of
    // observing an empty slot and invoking destroy a second time.
    promise = Promise.resolve()
      .then(() => Reflect.apply(destroy, source, []))
      .then(() => undefined);
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
  const prepare = findDataMethod(result.source as object, 'prepare');
  const getSnapshot = findDataMethod(result.source as object, 'getSnapshot');
  if (!destroySource || !prepare || !getSnapshot) return null;
  const rawRelease = result.releaseConstructionLease as () => void;
  let released = false;
  return Object.freeze({
    backend: backend as BlobFilePlaybackSourceResult['backend'],
    source: result.source as FilePlaybackCutoverSource,
    sourceIdentity: expectedSourceIdentity,
    releaseConstructionLease: () => {
      if (released) return;
      released = true;
      Reflect.apply(rawRelease, undefined, []);
    },
    destroySource,
    prepareSource: (signal: AbortSignal) => Reflect.apply(prepare, result.source, [signal]),
    getSnapshot: () => Reflect.apply(getSnapshot, result.source, []),
  });
}

function sourceReadiness(
  factory: FactoryResultSnapshot,
  expected: Readonly<FilePlaybackAssetSnapshot>,
  expectedPhase: 'ready' | 'connected',
  value: unknown = factory.getSnapshot(),
): Readonly<FilePlaybackPreparedSourceReadiness> | null {
  let snapshot: FilePlaybackSourceSnapshot;
  try {
    snapshot = createFilePlaybackSourceSnapshot(value as FilePlaybackSourceSnapshot);
  } catch {
    return null;
  }
  if (
    snapshot.queueItemId !== expected.queueItemId ||
    snapshot.backend !== factory.backend ||
    snapshot.phase !== expectedPhase ||
    snapshot.revision !== 0 ||
    snapshot.run !== null ||
    snapshot.durationSeconds === null ||
    snapshot.durationSeconds <= 0 ||
    snapshot.positionSeconds !== 0 ||
    snapshot.bufferedAheadSeconds < 0 ||
    snapshot.bufferedAheadSeconds > snapshot.durationSeconds ||
    snapshot.outputSampleRateHz === null ||
    snapshot.channelCount === null ||
    snapshot.underrunCount !== 0 ||
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

function sameReadiness(
  left: Readonly<FilePlaybackPreparedSourceReadiness>,
  right: Readonly<FilePlaybackPreparedSourceReadiness>,
): boolean {
  return (
    left.durationSeconds === right.durationSeconds &&
    left.outputSampleRateHz === right.outputSampleRateHz &&
    left.channelCount === right.channelCount
  );
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

function currentWarmAsset(record: WarmSourceRecord): Readonly<FilePlaybackAssetSnapshot> | null {
  try {
    return canonicalSnapshot(
      Reflect.apply(registrySnapshotForLease, record.registry, [
        record.roomToken,
        record.assetLease,
      ]),
    );
  } catch {
    return null;
  }
}

function removeWarmAbortListener(record: WarmSourceRecord): void {
  const remove = record.removeAbortListener;
  record.removeAbortListener = () => undefined;
  try {
    remove();
  } catch {
    // Ownership and explicit cleanup remain authoritative.
  }
}

function retireWarmRecord(record: WarmSourceRecord): Promise<boolean> {
  if (record.status === 'handed-off') return Promise.resolve(false);
  if (record.status === 'handing-off') {
    record.retirementReason ??= new Error('File playback warm source was retired during handoff');
    return (
      record.handoffPromise?.then(
        () => false,
        () => false,
      ) ?? Promise.resolve(false)
    );
  }
  if (record.retirementPromise) return record.retirementPromise;

  record.status = 'retiring';
  removeWarmAbortListener(record);
  record.retirementPromise = (async () => {
    let failure: unknown = null;
    try {
      await record.factory.destroySource();
    } catch (error) {
      failure = error;
    } finally {
      try {
        record.factory.releaseConstructionLease();
      } catch (error) {
        failure ??= error;
      }
      record.status = 'retired';
      WARM_SOURCE_RECORDS.delete(record.authority as object);
    }
    if (failure !== null) throw failure;
    return true;
  })();
  WARM_SOURCE_RETIREMENTS.set(record.authority as object, record.retirementPromise);
  return record.retirementPromise;
}

function assertWarmRecordAuthority(
  record: WarmSourceRecord,
  signal: AbortSignal,
  isCurrent: () => boolean,
  includePreparationAuthority: boolean,
): void {
  if (record.retirementReason) throw record.retirementReason;
  if (record.status !== 'handing-off' && record.status !== 'handed-off') {
    throw new Error('File playback warm source authority is stale');
  }
  if (record.status === 'handing-off') throwIfAborted(record.signal);
  throwIfAborted(signal);
  const before = currentWarmAsset(record);
  if (
    !before ||
    !sameBinding(before, record.expectedBinding) ||
    !sameSnapshot(before, record.asset)
  ) {
    throw new Error('File playback warm asset authority is stale');
  }

  if (record.checkingAuthority) {
    throw new Error('File playback warm source authority was re-entered');
  }
  record.checkingAuthority = true;
  let preparationAccepted: unknown = true;
  let handoffAccepted: unknown;
  try {
    if (includePreparationAuthority) {
      preparationAccepted = Reflect.apply(record.isCurrent, undefined, []);
    }
    handoffAccepted = Reflect.apply(isCurrent, undefined, []);
  } finally {
    record.checkingAuthority = false;
  }
  if (record.retirementReason) throw record.retirementReason;
  if (preparationAccepted !== true || handoffAccepted !== true) {
    throw new Error('File playback warm source handoff was superseded');
  }
  if (record.status === 'handing-off') throwIfAborted(record.signal);
  throwIfAborted(signal);
  const after = currentWarmAsset(record);
  if (!after || !sameBinding(after, record.expectedBinding) || !sameSnapshot(after, record.asset)) {
    throw new Error('File playback warm asset authority changed during handoff');
  }
}

/**
 * Constructs and prepares one exact renderer without occupying a manager slot
 * or binding it to a playback revision. The capability owns the disconnected
 * source until a one-shot handoff or retirement.
 */
export async function prepareFilePlaybackAssetSourceWarm(
  options: PrepareFilePlaybackAssetSourceWarmOptions,
): Promise<Readonly<FilePlaybackWarmSourceAuthority>> {
  const input = snapshotWarmOptions(options);
  if (!input) throw new TypeError('File playback warm source options are invalid');

  const registry = input.registry;
  const roomToken = input.roomToken;
  const assetLease = input.assetLease;
  const expectedBinding = parseFilePlaybackAssetBinding(input.expectedBinding);
  const audioContext = input.audioContext;
  const signal = input.signal;
  const isCurrent = input.isCurrent;
  const decodeOrdinaryAudio = input.decodeOrdinaryAudio;
  const boundedRoutePolicy =
    input.boundedRoutePolicy === undefined
      ? undefined
      : snapshotFilePlaybackBoundedRoutePolicy(input.boundedRoutePolicy);
  const installCodecTimelineHostArtifact = input.installCodecTimelineHostArtifact;
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
  if (audioContext === null || typeof audioContext !== 'object') {
    throw new TypeError('A file playback AudioContext is required');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('An exact file playback AbortSignal is required');
  }
  if (typeof isCurrent !== 'function' || typeof decodeOrdinaryAudio !== 'function') {
    throw new TypeError('File playback authority and ordinary decoder callbacks are required');
  }
  if (installCodecTimelineHostArtifact !== undefined && installCodecTimelineHostArtifact !== true) {
    throw new TypeError('Host codec timeline artifact installation must be the literal true');
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

  assertAuthority();
  canonicalAsset = currentSnapshot();
  if (!canonicalAsset || !sameBinding(canonicalAsset, expectedBinding)) {
    throw new Error('File playback asset lease is unavailable');
  }
  assertAuthority();

  let codecTimelineHostArtifactBinding: Readonly<CodecTimelineHostArtifactBinding> | null = null;
  if (installCodecTimelineHostArtifact === true) {
    const existing = describeCodecTimelineHostArtifactForLease({
      registry,
      roomToken: roomToken as object,
      lease: assetLease as FilePlaybackAssetLease,
    });
    assertAuthority();
    if (existing === null) {
      codecTimelineHostArtifactBinding = codecTimelineHostArtifactBindingFromAsset(canonicalAsset);
    }
  }

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
  let codecTimelineHostArtifact: Readonly<CodecTimelineHostArtifact> | null = null;
  let factoryOwnsGenericLease = false;
  let acquiredGenericSource: EncodedAudioSource | null = null;
  let releaseCalled = false;
  let published = false;

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
          ...(boundedRoutePolicy ? { boundedRoutePolicy } : {}),
          ...(codecTimelineHostArtifactBinding ? { codecTimelineHostArtifactBinding } : {}),
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
          ...(boundedRoutePolicy ? { boundedRoutePolicy } : {}),
          ...(codecTimelineHostArtifactBinding ? { codecTimelineHostArtifactBinding } : {}),
        },
      ]);
    }
    if (!(factoryTask instanceof Promise)) {
      throw new TypeError('File playback source factory must return a native Promise');
    }
    if (acquiredGenericSource !== null) factoryOwnsGenericLease = true;
    rawFactoryResult = await factoryTask;
    assertAuthority();
    factoryResult = inspectFactoryResult(rawFactoryResult, canonicalAsset.sourceIdentity);
    if (!factoryResult) {
      throw new TypeError('File playback source factory returned an invalid exact result');
    }
    if (codecTimelineHostArtifactBinding) {
      codecTimelineHostArtifact =
        codecTimelineHostArtifactForFilePlaybackSourceResult(rawFactoryResult);
    }
    assertAuthority();

    const prepareTask = factoryResult.prepareSource(signal as AbortSignal);
    if (!(prepareTask instanceof Promise)) {
      throw new TypeError('File playback source prepare must return a native Promise');
    }
    const preparedValue = await prepareTask;
    assertAuthority();
    const returnedReadiness = sourceReadiness(
      factoryResult,
      canonicalAsset,
      'ready',
      preparedValue,
    );
    const observedReadiness = sourceReadiness(factoryResult, canonicalAsset, 'ready');
    if (
      !returnedReadiness ||
      !observedReadiness ||
      !sameReadiness(returnedReadiness, observedReadiness) ||
      observedReadiness.outputSampleRateHz !== (audioContext as AudioContext).sampleRate
    ) {
      throw new TypeError('File playback warm source readiness is invalid');
    }
    assertAuthority();

    if (codecTimelineHostArtifact) {
      const leaseAccess = {
        registry,
        roomToken: roomToken as object,
        lease: assetLease as FilePlaybackAssetLease,
      };
      const installed = describeCodecTimelineHostArtifactForLease(leaseAccess);
      if (installed === null) {
        installCodecTimelineHostArtifactForLease({
          ...leaseAccess,
          artifact: codecTimelineHostArtifact,
        });
      } else if (
        installed.codec !== codecTimelineHostArtifact.codec ||
        installed.manifestByteLength !== codecTimelineHostArtifact.manifestByteLength ||
        installed.manifestSha256B64 !== codecTimelineHostArtifact.manifestSha256B64
      ) {
        throw new Error('Installed host codec timeline artifact conflicts with this source');
      }
      assertAuthority();
    }

    const metadata = freezeCanonical({ name: canonicalAsset.name, mime: canonicalAsset.mime });
    const authority = freezeCanonical({
      backend: factoryResult.backend,
      sourceIdentity: factoryResult.sourceIdentity,
      asset: canonicalAsset,
      metadata,
      readiness: observedReadiness,
    }) as unknown as Readonly<FilePlaybackWarmSourceAuthority>;
    const record: WarmSourceRecord = {
      authority,
      registry,
      roomToken: roomToken as object,
      assetLease: assetLease as FilePlaybackAssetLease,
      expectedBinding,
      signal,
      isCurrent: isCurrent as () => boolean,
      runtime,
      factory: factoryResult,
      asset: canonicalAsset,
      readiness: observedReadiness,
      status: 'prepared',
      checkingAuthority: false,
      removeAbortListener: () => undefined,
      handoffPromise: null,
      retirementPromise: null,
      retirementReason: null,
    };
    WARM_SOURCE_RECORDS.set(authority, record);
    try {
      const onAbort = (): void => {
        void retireWarmRecord(record).catch(() => undefined);
      };
      Reflect.apply(nativeAddEventListener, signal, ['abort', onAbort, { once: true }]);
      record.removeAbortListener = () => {
        Reflect.apply(nativeRemoveEventListener, signal, ['abort', onAbort]);
      };
      assertAuthority();
    } catch (error) {
      await suppressCleanup(() => retireWarmRecord(record));
      throw error;
    }
    published = true;
    return authority;
  } catch (error) {
    if (!published) {
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
    if (!published && factoryResult && !releaseCalled) {
      suppressRelease(factoryResult.releaseConstructionLease);
    }
  }
}

/**
 * Transfers one exact manifest-decoder construction into the ordinary warm
 * source lifecycle without exposing its encoded source or timeline evidence.
 *
 * Once an exact option record is accepted this function owns the construction:
 * failure retires it, while success consumes it into the returned warm source.
 * A caller that never invokes this function may explicitly retire the unused
 * construction through retireFilePlaybackPeerRangeManifestDecoderConstruction().
 */
export async function prepareFilePlaybackPeerRangeManifestAssetSourceWarm(
  options: PrepareFilePlaybackPeerRangeManifestAssetSourceWarmOptions,
): Promise<Readonly<FilePlaybackWarmSourceAuthority>> {
  const input = snapshotManifestWarmOptions(options);
  if (!input) {
    throw new TypeError('File playback manifest warm source options are invalid');
  }

  const construction = input.construction as FilePlaybackPeerRangeManifestDecoderConstruction;
  try {
    const constructionSnapshot = snapshotExactRecord(construction, MANIFEST_CONSTRUCTION_KEYS);
    const registry = input.registry;
    const roomToken = input.roomToken;
    const assetLease = input.assetLease;
    const expectedBinding = parseFilePlaybackAssetBinding(input.expectedBinding);
    const audioContext = input.audioContext;
    const signal = input.signal;
    const isCurrent = input.isCurrent;
    const clock = clockSnapshot(input.clockBindings);
    const runtime = manifestRuntimeSnapshot(input.runtime);

    if (
      !constructionSnapshot ||
      (constructionSnapshot.codec !== 'adts-aac-lc' &&
        constructionSnapshot.codec !== 'mp3-no-frame-count')
    ) {
      throw new TypeError('An exact manifest decoder construction is required');
    }
    if (!exactRegistry(registry)) {
      throw new TypeError('An exact file playback asset registry is required');
    }
    if (roomToken === null || typeof roomToken !== 'object') {
      throw new TypeError('An opaque file playback room token is required');
    }
    if (assetLease === null || typeof assetLease !== 'object' || !expectedBinding) {
      throw new TypeError('An exact file playback asset lease and binding are required');
    }
    if (audioContext === null || typeof audioContext !== 'object') {
      throw new TypeError('A file playback AudioContext is required');
    }
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError('An exact file playback AbortSignal is required');
    }
    if (typeof isCurrent !== 'function') {
      throw new TypeError('A file playback staging authority callback is required');
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
      if (checkingAuthority) {
        throw new Error('File playback manifest asset authority was re-entered');
      }
      throwIfAborted(signal);
      const before = currentSnapshot();
      if (!before || !sameBinding(before, expectedBinding)) {
        throw new Error('File playback manifest asset authority is stale');
      }
      if (canonicalAsset && !sameSnapshot(before, canonicalAsset)) {
        throw new Error('File playback manifest asset metadata changed during construction');
      }
      checkingAuthority = true;
      let accepted: unknown;
      try {
        accepted = Reflect.apply(isCurrent as () => boolean, undefined, []);
      } finally {
        checkingAuthority = false;
      }
      if (accepted !== true) {
        throw new Error('File playback manifest asset staging was superseded');
      }
      throwIfAborted(signal);
      const after = currentSnapshot();
      if (
        !after ||
        !sameBinding(after, expectedBinding) ||
        (canonicalAsset !== null && !sameSnapshot(after, canonicalAsset))
      ) {
        throw new Error('File playback manifest asset authority changed during construction');
      }
    };

    assertAuthority();
    canonicalAsset = currentSnapshot();
    if (
      !canonicalAsset ||
      canonicalAsset.kind !== 'peer-range' ||
      !sameBinding(canonicalAsset, expectedBinding) ||
      constructionSnapshot.queueItemId !== canonicalAsset.queueItemId ||
      constructionSnapshot.sourceIdentity !== canonicalAsset.sourceIdentity ||
      constructionSnapshot.sourceSize !== canonicalAsset.size
    ) {
      throw new Error('Manifest decoder construction does not match its canonical asset');
    }
    assertAuthority();

    let rawFactoryResult: unknown = null;
    let factoryResult: FactoryResultSnapshot | null = null;
    let releaseCalled = false;
    let published = false;

    try {
      const constructTask = constructFilePlaybackPeerRangeManifestDecoder({
        authority: construction,
        registry,
        roomToken: roomToken as object,
        assetLease: assetLease as FilePlaybackAssetLease,
        audioContext: audioContext as AudioContext,
        clockBindings: clock,
      });
      if (!(constructTask instanceof Promise)) {
        throw new TypeError('Manifest decoder construction must return a native Promise');
      }
      const source = await constructTask;
      rawFactoryResult = freezeCanonical({
        backend: 'bounded-stream' as const,
        source,
        sourceIdentity: canonicalAsset.sourceIdentity,
        releaseConstructionLease: () => undefined,
      });
      assertAuthority();
      factoryResult = inspectFactoryResult(rawFactoryResult, canonicalAsset.sourceIdentity);
      if (!factoryResult || factoryResult.backend !== 'bounded-stream') {
        throw new TypeError('Manifest decoder construction returned an invalid exact source');
      }
      assertAuthority();

      const prepareTask = factoryResult.prepareSource(signal as AbortSignal);
      if (!(prepareTask instanceof Promise)) {
        throw new TypeError('File playback manifest source prepare must return a native Promise');
      }
      const preparedValue = await prepareTask;
      assertAuthority();
      const returnedReadiness = sourceReadiness(
        factoryResult,
        canonicalAsset,
        'ready',
        preparedValue,
      );
      const observedReadiness = sourceReadiness(factoryResult, canonicalAsset, 'ready');
      if (
        !returnedReadiness ||
        !observedReadiness ||
        !sameReadiness(returnedReadiness, observedReadiness) ||
        observedReadiness.outputSampleRateHz !== (audioContext as AudioContext).sampleRate
      ) {
        throw new TypeError('File playback manifest warm source readiness is invalid');
      }
      assertAuthority();

      const metadata = freezeCanonical({ name: canonicalAsset.name, mime: canonicalAsset.mime });
      const authority = freezeCanonical({
        backend: factoryResult.backend,
        sourceIdentity: factoryResult.sourceIdentity,
        asset: canonicalAsset,
        metadata,
        readiness: observedReadiness,
      }) as unknown as Readonly<FilePlaybackWarmSourceAuthority>;
      const record: WarmSourceRecord = {
        authority,
        registry,
        roomToken: roomToken as object,
        assetLease: assetLease as FilePlaybackAssetLease,
        expectedBinding,
        signal,
        isCurrent: isCurrent as () => boolean,
        runtime,
        factory: factoryResult,
        asset: canonicalAsset,
        readiness: observedReadiness,
        status: 'prepared',
        checkingAuthority: false,
        removeAbortListener: () => undefined,
        handoffPromise: null,
        retirementPromise: null,
        retirementReason: null,
      };
      WARM_SOURCE_RECORDS.set(authority, record);
      try {
        const onAbort = (): void => {
          void retireWarmRecord(record).catch(() => undefined);
        };
        Reflect.apply(nativeAddEventListener, signal, ['abort', onAbort, { once: true }]);
        record.removeAbortListener = () => {
          Reflect.apply(nativeRemoveEventListener, signal, ['abort', onAbort]);
        };
        assertAuthority();
      } catch (error) {
        await suppressCleanup(() => retireWarmRecord(record));
        throw error;
      }
      published = true;
      return authority;
    } catch (error) {
      if (!published) {
        const cleanup = factoryResult
          ? {
              destroy: factoryResult.destroySource,
              release: factoryResult.releaseConstructionLease,
            }
          : potentialFactoryCleanup(rawFactoryResult);
        await suppressCleanup(cleanup.destroy);
        if (!releaseCalled) {
          releaseCalled = true;
          suppressRelease(cleanup.release);
        }
      }
      throw error;
    } finally {
      if (!published && factoryResult && !releaseCalled) {
        suppressRelease(factoryResult.releaseConstructionLease);
      }
    }
  } catch (error) {
    await suppressCleanup(() =>
      retireFilePlaybackPeerRangeManifestDecoderConstruction(construction),
    );
    throw error;
  }
}

/** One-shot prepare-and-handoff facade for an admitted manifest decoder. */
export async function stageFilePlaybackPeerRangeManifestAssetSource(
  options: StageFilePlaybackPeerRangeManifestAssetSourceOptions,
): Promise<Readonly<StagedFilePlaybackAssetSource>> {
  const input = snapshotManifestStageOptions(options);
  if (!input) {
    throw new TypeError('File playback manifest asset staging options are invalid');
  }
  const warm = await prepareFilePlaybackPeerRangeManifestAssetSourceWarm({
    construction: input.construction as FilePlaybackPeerRangeManifestDecoderConstruction,
    registry: input.registry as FilePlaybackAssetRegistry,
    roomToken: input.roomToken as object,
    assetLease: input.assetLease as FilePlaybackAssetLease,
    expectedBinding: input.expectedBinding as FilePlaybackAssetBinding,
    audioContext: input.audioContext as AudioContext,
    clockBindings: input.clockBindings as FilePlaybackClockBindings,
    signal: input.signal as AbortSignal,
    isCurrent: input.isCurrent as () => boolean,
    ...(input.runtime === undefined
      ? {}
      : {
          runtime: input.runtime as FilePlaybackPeerRangeManifestAssetSourceStagerRuntimeForTests,
        }),
  });
  try {
    return await handoffFilePlaybackAssetSourceWarm({
      authority: warm,
      manager: input.manager as FilePlaybackManager,
      destination: input.destination as AudioNode,
      signal: input.signal as AbortSignal,
      isCurrent: input.isCurrent as () => boolean,
    });
  } catch (error) {
    await suppressCleanup(() => retireFilePlaybackAssetSourceWarm(warm));
    throw error;
  }
}

/** Returns body-free readiness only while the exact warm capability is live. */
export function readFilePlaybackAssetSourceWarmReadiness(
  authority: FilePlaybackWarmSourceAuthority,
): Readonly<FilePlaybackPreparedSourceReadiness> {
  const record =
    authority !== null && typeof authority === 'object'
      ? WARM_SOURCE_RECORDS.get(authority as object)
      : undefined;
  if (!record || record.authority !== authority || record.status !== 'prepared') {
    throw new Error('File playback warm source authority is stale');
  }
  return record.readiness;
}

/** Destroys one still-disconnected warm source. Manager-owned sources are never touched. */
export function retireFilePlaybackAssetSourceWarm(
  authority: FilePlaybackWarmSourceAuthority,
): Promise<boolean> {
  const record =
    authority !== null && typeof authority === 'object'
      ? WARM_SOURCE_RECORDS.get(authority as object)
      : undefined;
  if (!record || record.authority !== authority) {
    return authority !== null && typeof authority === 'object'
      ? (WARM_SOURCE_RETIREMENTS.get(authority as object) ?? Promise.resolve(false))
      : Promise.resolve(false);
  }
  return retireWarmRecord(record);
}

/**
 * Transfers a warm source exactly once into the manager's silent candidate
 * slot. From the native staging call onward, the manager owns destruction.
 */
export function handoffFilePlaybackAssetSourceWarm(
  options: HandoffFilePlaybackWarmSourceOptions,
): Promise<Readonly<StagedFilePlaybackAssetSource>> {
  const input = snapshotWarmHandoffOptions(options);
  if (!input)
    return Promise.reject(new TypeError('File playback warm handoff options are invalid'));
  const authority = input.authority;
  const record =
    authority !== null && typeof authority === 'object'
      ? WARM_SOURCE_RECORDS.get(authority as object)
      : undefined;
  const manager = input.manager;
  const destination = input.destination;
  const signal = input.signal;
  const isCurrent = input.isCurrent;
  if (!record || record.authority !== authority || record.status !== 'prepared') {
    return Promise.reject(new Error('File playback warm source authority is stale'));
  }
  if (!isExactFilePlaybackManager(manager)) {
    return Promise.reject(new TypeError('An exact file playback manager is required'));
  }
  if (destination === null || typeof destination !== 'object') {
    return Promise.reject(new TypeError('A file playback destination is required'));
  }
  if (!(signal instanceof AbortSignal) || typeof isCurrent !== 'function') {
    return Promise.reject(new TypeError('File playback warm handoff authority is invalid'));
  }

  record.status = 'handing-off';
  removeWarmAbortListener(record);
  const task = Promise.resolve().then(async () => {
    let managerOwnsSource = false;
    let cutoverPort: FilePlaybackCutoverCandidatePort | null = null;
    const assertAuthority = (includePreparationAuthority: boolean): void => {
      assertWarmRecordAuthority(
        record,
        signal,
        isCurrent as () => boolean,
        includePreparationAuthority,
      );
    };
    const managerAuthority = (): boolean => {
      try {
        assertAuthority(false);
        return true;
      } catch {
        return false;
      }
    };

    try {
      assertAuthority(true);
      const candidateOptions = freezeCanonical({
        source: record.factory.source,
        destination: destination as AudioNode,
        authority: managerAuthority,
      }) as FilePlaybackCutoverCandidateOptions;
      const stageTask = Reflect.apply(record.runtime.stageCandidate, undefined, [
        manager,
        candidateOptions,
      ]);
      if (!(stageTask instanceof Promise)) {
        throw new TypeError('File playback manager staging must return a native Promise');
      }
      managerOwnsSource = true;

      let postHandoffError: unknown = null;
      try {
        assertAuthority(false);
      } catch (error) {
        postHandoffError = error;
      }
      try {
        cutoverPort = await stageTask;
      } catch (error) {
        if (postHandoffError === null) {
          try {
            assertAuthority(false);
          } catch (authorityError) {
            postHandoffError = authorityError;
          }
        }
        throw postHandoffError ?? error;
      }
      if (postHandoffError !== null) throw postHandoffError;
      assertCutoverPort(cutoverPort);
      assertAuthority(false);
      const connectedReadiness = sourceReadiness(record.factory, record.asset, 'connected');
      if (!connectedReadiness || !sameReadiness(record.readiness, connectedReadiness)) {
        throw new TypeError('File playback staged source readiness changed during handoff');
      }
      assertAuthority(false);
      record.factory.releaseConstructionLease();
      assertAuthority(false);
      record.status = 'handed-off';
      WARM_SOURCE_RECORDS.delete(record.authority as object);
      return freezeCanonical({
        cutoverPort,
        backend: record.factory.backend,
        sourceIdentity: record.factory.sourceIdentity,
        asset: record.asset,
        metadata: record.authority.metadata,
        readiness: connectedReadiness,
      });
    } catch (error) {
      if (cutoverPort) {
        await suppressCleanup(() =>
          Reflect.apply(record.runtime.retireCandidate, undefined, [manager, cutoverPort!]),
        );
      } else if (!managerOwnsSource) {
        await suppressCleanup(record.factory.destroySource);
      }
      suppressRelease(record.factory.releaseConstructionLease);
      record.status = 'retired';
      WARM_SOURCE_RECORDS.delete(record.authority as object);
      throw error;
    }
  });
  record.handoffPromise = task;
  return task;
}

/**
 * Backward-compatible one-shot staging facade. Construction is revision-free;
 * the exact source is bound to a manager only at the final handoff boundary.
 */
export async function stageFilePlaybackAssetSource(
  options: StageFilePlaybackAssetSourceOptions,
): Promise<Readonly<StagedFilePlaybackAssetSource>> {
  const input = snapshotOptions(options);
  if (!input) throw new TypeError('File playback asset staging options are invalid');
  if (
    input.installCodecTimelineHostArtifact !== undefined &&
    input.installCodecTimelineHostArtifact !== true
  ) {
    throw new TypeError('Host codec timeline artifact installation must be the literal true');
  }
  const warm = await prepareFilePlaybackAssetSourceWarm({
    registry: input.registry as FilePlaybackAssetRegistry,
    roomToken: input.roomToken as object,
    assetLease: input.assetLease as FilePlaybackAssetLease,
    expectedBinding: input.expectedBinding as FilePlaybackAssetBinding,
    audioContext: input.audioContext as AudioContext,
    clockBindings: input.clockBindings as FilePlaybackClockBindings,
    signal: input.signal as AbortSignal,
    isCurrent: input.isCurrent as () => boolean,
    decodeOrdinaryAudio: input.decodeOrdinaryAudio as OrdinaryAudioDecoder,
    ...(input.boundedRoutePolicy === undefined
      ? {}
      : { boundedRoutePolicy: input.boundedRoutePolicy as FilePlaybackBoundedRoutePolicy }),
    ...(input.installCodecTimelineHostArtifact === true
      ? { installCodecTimelineHostArtifact: true as const }
      : {}),
    ...(input.runtime === undefined
      ? {}
      : { runtime: input.runtime as FilePlaybackAssetSourceStagerRuntimeForTests }),
  });
  try {
    return await handoffFilePlaybackAssetSourceWarm({
      authority: warm,
      manager: input.manager as FilePlaybackManager,
      destination: input.destination as AudioNode,
      signal: input.signal as AbortSignal,
      isCurrent: input.isCurrent as () => boolean,
    });
  } catch (error) {
    await suppressCleanup(() => retireFilePlaybackAssetSourceWarm(warm));
    throw error;
  }
}
