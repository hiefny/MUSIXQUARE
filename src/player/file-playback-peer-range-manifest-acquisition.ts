import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetBinding,
  type FilePlaybackAssetLease,
  type FilePlaybackAssetSnapshot,
} from './file-playback-asset-registry.ts';
import {
  assertFilePlaybackConnectionMediaOperationCurrent,
  type FilePlaybackConnectionMediaOperation,
} from './file-playback-connection-media-session.ts';
import {
  derivePeerRangeManifestBundleSize,
  parseFileMediaSourceOfferV2,
  type PeerRangeManifestFileMediaSourceOfferV2,
} from './file-media-source-offer.ts';
import {
  parseFilePlaybackRunBindingV2,
  type FilePlaybackRunBindingV2,
} from './file-playback-run-binding.ts';
import {
  CODEC_TIMELINE_MANIFEST_SOURCE_BINDING_BYTES,
  parseCodecTimelineManifest,
  type CodecTimelineManifest,
} from './manifests/codec-timeline-manifest.ts';
import { computeCodecTimelineSourceBindingSha256 } from './manifests/codec-timeline-source-binding.ts';
import { SharedEncodedAudioAsset } from './sources/encoded-audio-asset.ts';
import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  throwIfAborted,
} from './sources/encoded-audio-source.ts';
import { OffsetEncodedAudioSource } from './sources/offset-encoded-audio-source.ts';
import {
  PEER_RANGE_MAX_READ_BYTES,
  PeerRangeEncodedAudioSource,
  type PeerRangeReadRequest,
  type PeerRangeTransport,
} from './sources/peer-range-encoded-audio-source.ts';

const OPTIONS_KEYS = Object.freeze(['operation', 'registry', 'roomToken', 'transport'] as const);
const OPERATION_KEYS = Object.freeze(['binding', 'fence', 'kind', 'offer'] as const);
const FENCE_KEYS = Object.freeze(['epoch', 'isCurrent', 'signal'] as const);
const SHA_256_BYTES = 32;
const MAX_MANIFEST_READS = 4;
const MAX_HANDLE_CLAIMS_PER_TRANSPORT = 1_024;

declare const peerRangeManifestAdmissionBrand: unique symbol;

/**
 * Non-serializable proof that one exact media-only registry asset passed the
 * bounded manifest-prefix verification pipeline.
 */
export interface FilePlaybackPeerRangeManifestAdmission {
  readonly [peerRangeManifestAdmissionBrand]: never;
}

export interface FilePlaybackPeerRangeManifestAcquisition {
  readonly assetLease: FilePlaybackAssetLease;
  readonly asset: Readonly<FilePlaybackAssetSnapshot>;
  readonly manifestAdmission: FilePlaybackPeerRangeManifestAdmission;
}

export interface FilePlaybackPeerRangeManifestAdmissionEvidence {
  readonly asset: Readonly<FilePlaybackAssetSnapshot>;
  readonly manifest: Readonly<CodecTimelineManifest>;
}

export interface AcquireFilePlaybackPeerRangeManifestOptions {
  readonly operation: Readonly<FilePlaybackConnectionMediaOperation>;
  readonly roomToken: object;
  readonly registry: FilePlaybackAssetRegistry;
  readonly transport: PeerRangeTransport;
}

type ExactRecord = Readonly<Record<string, unknown>>;

interface CanonicalOperation {
  readonly operation: Readonly<FilePlaybackConnectionMediaOperation>;
  readonly kind: 'baseline' | 'successor';
  readonly offer: Readonly<PeerRangeManifestFileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  readonly fence: {
    readonly epoch: object;
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
  };
}

interface CanonicalInput {
  readonly operation: CanonicalOperation;
  readonly roomToken: object;
  readonly registry: FilePlaybackAssetRegistry;
  readonly transportIdentity: object;
  readonly transport: PeerRangeTransport;
}

interface AdmissionRecord {
  readonly authority: FilePlaybackPeerRangeManifestAdmission;
  readonly registry: FilePlaybackAssetRegistry;
  readonly roomToken: object;
  readonly assetLease: FilePlaybackAssetLease;
  readonly offer: Readonly<PeerRangeManifestFileMediaSourceOfferV2>;
  readonly evidence: Readonly<FilePlaybackPeerRangeManifestAdmissionEvidence>;
  readonly result: Readonly<FilePlaybackPeerRangeManifestAcquisition>;
}

interface TransportHandleClaimBucket {
  count: number;
  readonly bySourceIdentity: Map<string, Map<string, HandleClaim>>;
}

interface HandleClaim {
  readonly bucket: TransportHandleClaimBucket;
  readonly registry: FilePlaybackAssetRegistry;
  readonly roomToken: object;
  readonly transportIdentity: object;
  readonly sourceIdentity: string;
  readonly handleId: string;
  readonly offer: Readonly<PeerRangeManifestFileMediaSourceOfferV2>;
  readonly primaryOperation: object;
  status: 'opening' | 'live' | 'tombstone' | 'released';
  opened: boolean;
  promise: Promise<Readonly<FilePlaybackPeerRangeManifestAcquisition>> | null;
  result: Readonly<FilePlaybackPeerRangeManifestAcquisition> | null;
}

interface ClaimedHandle {
  readonly claim: HandleClaim;
  readonly created: boolean;
}

const registryIsClosed = FilePlaybackAssetRegistry.prototype.isClosed;
const registryActiveAssetCount = FilePlaybackAssetRegistry.prototype.activeAssetCount;
const registryLeaseForBinding = FilePlaybackAssetRegistry.prototype.leaseForBinding;
const registryLeaseForSourceIdentity = FilePlaybackAssetRegistry.prototype.leaseForSourceIdentity;
const registryAdmitEncodedAsset = FilePlaybackAssetRegistry.prototype.admitEncodedAsset;
const registrySnapshotForLease = FilePlaybackAssetRegistry.prototype.snapshotForLease;
const registryRetire = FilePlaybackAssetRegistry.prototype.retire;
const uint8ArraySet = Uint8Array.prototype.set;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) as object | null;
const typedArrayByteLengthGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
  : undefined;
const typedArrayBufferGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
  : undefined;
const typedArrayTagGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get
  : undefined;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;

const ADMISSIONS = new WeakMap<object, AdmissionRecord>();
const ADMISSIONS_BY_LEASE = new WeakMap<object, AdmissionRecord>();
const OPERATION_HANDLE_CLAIMS = new WeakMap<object, HandleClaim>();
const HANDLE_CLAIMS = new WeakMap<object, TransportHandleClaimBucket>();

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const expected = new Set(expectedKeys);
    if (
      keys.length !== expected.size ||
      keys.some((key) => typeof key !== 'string' || !expected.has(key))
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
  } catch (error) {
    throw new TypeError(`${label} could not be inspected`, { cause: error });
  }
}

function snapshotTransport(value: unknown): {
  readonly identity: object;
  readonly transport: PeerRangeTransport;
} | null {
  try {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return null;
    const read = Reflect.get(value, 'read') as unknown;
    const closeHandle = Reflect.get(value, 'closeHandle') as unknown;
    if (
      typeof read !== 'function' ||
      (closeHandle !== undefined && typeof closeHandle !== 'function')
    ) {
      return null;
    }
    return Object.freeze({
      identity: value as object,
      transport: Object.freeze({
        read: (request: PeerRangeReadRequest) =>
          Reflect.apply(read, value, [request]) as Promise<ArrayBuffer | Uint8Array>,
        ...(typeof closeHandle === 'function'
          ? {
              closeHandle: (handleId: string, sourceIdentity: string) =>
                Reflect.apply(closeHandle, value, [
                  handleId,
                  sourceIdentity,
                ]) as void | Promise<void>,
            }
          : {}),
      }),
    });
  } catch {
    return null;
  }
}

function offerMatchesBinding(
  offer: Readonly<PeerRangeManifestFileMediaSourceOfferV2>,
  binding: Readonly<FilePlaybackRunBindingV2>,
): boolean {
  return (
    offer.sessionId === binding.sessionId &&
    offer.connectionId === binding.connectionId &&
    offer.prepareId === binding.prepareId &&
    offer.prepareRevision === binding.prepareRevision &&
    offer.queueItemId === binding.queueItemId &&
    offer.sourceIdentity === binding.sourceIdentity &&
    offer.transferSessionId === binding.transferSessionId
  );
}

function sameManifestOffer(
  left: Readonly<PeerRangeManifestFileMediaSourceOfferV2>,
  right: Readonly<PeerRangeManifestFileMediaSourceOfferV2>,
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.type === right.type &&
    left.transport === right.transport &&
    left.sessionId === right.sessionId &&
    left.connectionId === right.connectionId &&
    left.prepareId === right.prepareId &&
    left.prepareRevision === right.prepareRevision &&
    left.queueItemId === right.queueItemId &&
    left.sourceIdentity === right.sourceIdentity &&
    left.transferSessionId === right.transferSessionId &&
    left.handleId === right.handleId &&
    left.encodedSize === right.encodedSize &&
    left.manifestByteLength === right.manifestByteLength &&
    left.manifestSha256B64 === right.manifestSha256B64 &&
    left.name === right.name &&
    left.mime === right.mime &&
    left.expiresAtRoomTimeMs === right.expiresAtRoomTimeMs
  );
}

function snapshotOperation(value: unknown): CanonicalOperation | null {
  const operation = snapshotExactDataRecord(value, OPERATION_KEYS, 'Peer manifest operation');
  if (!operation || (operation.kind !== 'baseline' && operation.kind !== 'successor')) return null;
  const offer = parseFileMediaSourceOfferV2(operation.offer);
  const binding = parseFilePlaybackRunBindingV2(operation.binding);
  const fence = snapshotExactDataRecord(operation.fence, FENCE_KEYS, 'Peer manifest fence');
  if (
    !offer ||
    offer.transport !== 'peer-range-manifest' ||
    !binding ||
    !offerMatchesBinding(offer, binding) ||
    !fence ||
    !(fence.signal instanceof AbortSignal) ||
    typeof fence.isCurrent !== 'function' ||
    fence.epoch === null ||
    typeof fence.epoch !== 'object'
  ) {
    return null;
  }
  return {
    operation: value as Readonly<FilePlaybackConnectionMediaOperation>,
    kind: operation.kind,
    offer,
    binding,
    fence: {
      epoch: fence.epoch,
      signal: fence.signal,
      isCurrent: fence.isCurrent as () => boolean,
    },
  };
}

function snapshotInput(options: ExactRecord): CanonicalInput | null {
  try {
    const operation = snapshotOperation(options.operation);
    const transport = snapshotTransport(options.transport);
    if (
      !operation ||
      !transport ||
      options.roomToken === null ||
      typeof options.roomToken !== 'object' ||
      options.registry === null ||
      typeof options.registry !== 'object' ||
      Reflect.getPrototypeOf(options.registry) !== FilePlaybackAssetRegistry.prototype
    ) {
      return null;
    }
    return Object.freeze({
      operation,
      roomToken: options.roomToken,
      registry: options.registry as FilePlaybackAssetRegistry,
      transportIdentity: transport.identity,
      transport: transport.transport,
    });
  } catch {
    return null;
  }
}

function assetBinding(
  binding: Readonly<FilePlaybackRunBindingV2>,
): Readonly<FilePlaybackAssetBinding> {
  return freezeCanonical({
    queueItemId: binding.queueItemId,
    sourceIdentity: binding.sourceIdentity,
    transferSessionId: binding.transferSessionId,
  });
}

function sameAsset(
  value: Readonly<FilePlaybackAssetSnapshot> | null,
  expected: Readonly<FilePlaybackAssetBinding>,
  offer: Readonly<PeerRangeManifestFileMediaSourceOfferV2>,
): value is Readonly<FilePlaybackAssetSnapshot> {
  return (
    value !== null &&
    value.queueItemId === expected.queueItemId &&
    value.sourceIdentity === expected.sourceIdentity &&
    value.transferSessionId === expected.transferSessionId &&
    value.kind === 'peer-range' &&
    value.size === offer.encodedSize &&
    value.name === offer.name &&
    value.mime === offer.mime
  );
}

function assertCurrent(input: CanonicalInput): void {
  // Exact module-issued identity is the root authority. Do not consult even a
  // structurally valid caller signal before this verifier accepts the object.
  assertFilePlaybackConnectionMediaOperationCurrent(input.operation.operation);
  throwIfAborted(input.operation.fence.signal);
  if (Reflect.apply(registryIsClosed, input.registry, [])) {
    throw new Error('File playback peer manifest registry is closed');
  }
  if (Reflect.apply(registryActiveAssetCount, input.registry, [input.roomToken]) === null) {
    throw new Error('File playback peer manifest room token is invalid');
  }
}

function integrityError(message: string, cause?: unknown): EncodedSourceIntegrityError {
  const error = new EncodedSourceIntegrityError(message);
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
}

function exactLocalBytes(value: unknown, expectedLength: number, label: string): Uint8Array {
  try {
    if (
      !typedArrayByteLengthGetter ||
      !typedArrayBufferGetter ||
      !typedArrayTagGetter ||
      !arrayBufferByteLengthGetter ||
      Reflect.apply(typedArrayTagGetter, value, []) !== 'Uint8Array'
    ) {
      throw integrityError(`${label} is not an exact Uint8Array`);
    }
    const length = Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
    const buffer = Reflect.apply(typedArrayBufferGetter, value, []) as unknown;
    Reflect.apply(arrayBufferByteLengthGetter, buffer, []);
    if (length !== expectedLength) {
      throw integrityError(`${label} must contain exactly ${expectedLength} bytes`);
    }
    const copy = new Uint8Array(expectedLength);
    Reflect.apply(uint8ArraySet, copy, [value, 0]);
    return copy;
  } catch (error) {
    if (error instanceof EncodedSourceIntegrityError) throw error;
    throw integrityError(`${label} could not be copied`, error);
  }
}

function copySha256Result(value: unknown): Uint8Array {
  try {
    if (!arrayBufferByteLengthGetter) {
      throw integrityError('Peer manifest SHA-256 result is unavailable');
    }
    const length = Reflect.apply(arrayBufferByteLengthGetter, value, []) as number;
    if (length !== SHA_256_BYTES) {
      throw integrityError(`Peer manifest SHA-256 must contain exactly ${SHA_256_BYTES} bytes`);
    }
    return exactLocalBytes(
      new Uint8Array(value as ArrayBuffer),
      SHA_256_BYTES,
      'Peer manifest SHA-256',
    );
  } catch (error) {
    if (error instanceof EncodedSourceIntegrityError) throw error;
    throw integrityError('Peer manifest SHA-256 result is invalid', error);
  }
}

function decodeOfferedDigest(value: string): Uint8Array {
  try {
    const binary = atob(value);
    if (value.length !== 44 || binary.length !== SHA_256_BYTES || btoa(binary) !== value) {
      throw integrityError('Offered manifest SHA-256 length is invalid');
    }
    const bytes = new Uint8Array(SHA_256_BYTES);
    for (let index = 0; index < SHA_256_BYTES; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (error) {
    if (error instanceof EncodedSourceIntegrityError) throw error;
    throw integrityError('Offered manifest SHA-256 is invalid', error);
  }
}

function equalSha256(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  let difference = left.length ^ SHA_256_BYTES;
  difference |= right.length ^ SHA_256_BYTES;
  for (let index = 0; index < SHA_256_BYTES; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function claimMatchesInput(claim: HandleClaim, input: CanonicalInput): boolean {
  return (
    claim.registry === input.registry &&
    claim.roomToken === input.roomToken &&
    claim.transportIdentity === input.transportIdentity &&
    claim.sourceIdentity === input.operation.offer.sourceIdentity &&
    claim.handleId === input.operation.offer.handleId &&
    sameManifestOffer(claim.offer, input.operation.offer)
  );
}

function handleClaimBucket(transportIdentity: object): TransportHandleClaimBucket {
  const existing = HANDLE_CLAIMS.get(transportIdentity);
  if (existing) return existing;
  const created: TransportHandleClaimBucket = {
    count: 0,
    bySourceIdentity: new Map(),
  };
  HANDLE_CLAIMS.set(transportIdentity, created);
  return created;
}

function claimHandle(input: CanonicalInput): ClaimedHandle {
  const operation = input.operation.operation as object;
  const operationClaim = OPERATION_HANDLE_CLAIMS.get(operation);
  if (operationClaim) {
    if (operationClaim.status === 'released') {
      OPERATION_HANDLE_CLAIMS.delete(operation);
    } else {
      if (!claimMatchesInput(operationClaim, input)) {
        throw new Error('Peer manifest operation is already bound to another handle owner');
      }
      return { claim: operationClaim, created: false };
    }
  }

  const bucket = handleClaimBucket(input.transportIdentity);
  let byHandle = bucket.bySourceIdentity.get(input.operation.offer.sourceIdentity);
  const existing = byHandle?.get(input.operation.offer.handleId);
  if (existing) {
    if (!claimMatchesInput(existing, input)) {
      throw new Error('Peer manifest handle is already bound to another exact offer');
    }
    OPERATION_HANDLE_CLAIMS.set(operation, existing);
    return { claim: existing, created: false };
  }
  if (bucket.count >= MAX_HANDLE_CLAIMS_PER_TRANSPORT) {
    throw new Error('Peer manifest handle claim capacity is exhausted');
  }
  if (!byHandle) {
    byHandle = new Map();
    bucket.bySourceIdentity.set(input.operation.offer.sourceIdentity, byHandle);
  }
  const claim: HandleClaim = {
    bucket,
    registry: input.registry,
    roomToken: input.roomToken,
    transportIdentity: input.transportIdentity,
    sourceIdentity: input.operation.offer.sourceIdentity,
    handleId: input.operation.offer.handleId,
    offer: input.operation.offer,
    primaryOperation: operation,
    status: 'opening',
    opened: false,
    promise: null,
    result: null,
  };
  byHandle.set(claim.handleId, claim);
  bucket.count += 1;
  OPERATION_HANDLE_CLAIMS.set(operation, claim);
  return { claim, created: true };
}

function releaseUnopenedClaim(claim: HandleClaim): void {
  if (claim.status !== 'opening' || claim.opened) return;
  const byHandle = claim.bucket.bySourceIdentity.get(claim.sourceIdentity);
  if (byHandle?.get(claim.handleId) === claim) {
    byHandle.delete(claim.handleId);
    if (byHandle.size === 0) claim.bucket.bySourceIdentity.delete(claim.sourceIdentity);
    claim.bucket.count -= 1;
  }
  claim.status = 'released';
}

function tombstoneClaim(claim: HandleClaim): void {
  if (claim.status === 'released') return;
  claim.status = 'tombstone';
  claim.result = null;
}

function resolveSha256Digest(): (data: Uint8Array) => Promise<ArrayBuffer> {
  try {
    const subtle = globalThis.crypto?.subtle;
    const digest = subtle?.digest;
    if (!subtle || typeof digest !== 'function') {
      throw new Error('Web Crypto SHA-256 is unavailable');
    }
    return (data) => Reflect.apply(digest, subtle, ['SHA-256', data]) as Promise<ArrayBuffer>;
  } catch (error) {
    throw integrityError('Web Crypto SHA-256 is unavailable', error);
  }
}

async function readManifestBytes(
  input: CanonicalInput,
  source: PeerRangeEncodedAudioSource,
): Promise<Uint8Array> {
  const manifestLength = input.operation.offer.manifestByteLength;
  const readCount = Math.ceil(manifestLength / PEER_RANGE_MAX_READ_BYTES);
  if (readCount < 1 || readCount > MAX_MANIFEST_READS) {
    throw new RangeError('Peer manifest read count exceeds its fixed bound');
  }
  const manifest = new Uint8Array(manifestLength);
  let offset = 0;
  for (let index = 0; index < readCount; index += 1) {
    assertCurrent(input);
    const length = Math.min(PEER_RANGE_MAX_READ_BYTES, manifestLength - offset);
    const bytes = await source.readAt(offset, length, input.operation.fence.signal);
    assertCurrent(input);
    Reflect.apply(uint8ArraySet, manifest, [bytes, offset]);
    offset += length;
  }
  if (offset !== manifestLength) {
    throw integrityError('Peer manifest read geometry is incomplete');
  }
  return manifest;
}

function reuseExisting(
  input: CanonicalInput,
  binding: Readonly<FilePlaybackAssetBinding>,
): Readonly<FilePlaybackPeerRangeManifestAcquisition> | null {
  const lease = Reflect.apply(registryLeaseForBinding, input.registry, [input.roomToken, binding]);
  if (!lease) return null;
  const record = ADMISSIONS_BY_LEASE.get(lease as object);
  if (
    !record ||
    record.registry !== input.registry ||
    record.roomToken !== input.roomToken ||
    record.assetLease !== lease ||
    !sameManifestOffer(record.offer, input.operation.offer)
  ) {
    throw new Error('Existing file playback asset has no matching manifest admission');
  }
  readFilePlaybackPeerRangeManifestAdmission(record.authority, lease);
  return record.result;
}

function assertSourceIdentityAvailable(input: CanonicalInput): void {
  const lease = Reflect.apply(registryLeaseForSourceIdentity, input.registry, [
    input.roomToken,
    input.operation.offer.sourceIdentity,
  ]);
  if (lease) {
    throw new Error('Peer manifest source identity is already owned by another live asset');
  }
}

function publishAdmission(
  input: CanonicalInput,
  authority: FilePlaybackPeerRangeManifestAdmission,
  lease: FilePlaybackAssetLease,
  asset: Readonly<FilePlaybackAssetSnapshot>,
  manifest: Readonly<CodecTimelineManifest>,
): Readonly<FilePlaybackPeerRangeManifestAcquisition> {
  const evidence = freezeCanonical({ asset, manifest });
  const result = freezeCanonical({
    assetLease: lease,
    asset,
    manifestAdmission: authority,
  });
  const record: AdmissionRecord = {
    authority,
    registry: input.registry,
    roomToken: input.roomToken,
    assetLease: lease,
    offer: input.operation.offer,
    evidence,
    result,
  };
  try {
    ADMISSIONS.set(authority as object, record);
    ADMISSIONS_BY_LEASE.set(lease as object, record);
    return result;
  } catch (error) {
    // Publication is all-or-nothing even if a monkey-patched WeakMap method
    // throws after mutating one of the two indexes.
    ADMISSIONS.delete(authority as object);
    ADMISSIONS_BY_LEASE.delete(lease as object);
    throw error;
  }
}

async function suppressClose(source: EncodedAudioSource | SharedEncodedAudioAsset): Promise<void> {
  try {
    await source.close();
  } catch {
    // Ownership is terminal even when a hostile cleanup callback rejects.
  }
}

async function acquirePhysical(
  input: CanonicalInput,
  claim: HandleClaim,
): Promise<Readonly<FilePlaybackPeerRangeManifestAcquisition>> {
  const offer = input.operation.offer;
  const binding = assetBinding(input.operation.binding);
  let ownedSource: EncodedAudioSource | null = null;
  let ownedAsset: SharedEncodedAudioAsset | null = null;
  let registryLease: FilePlaybackAssetLease;
  try {
    assertCurrent(input);
    const reusedAtStart = reuseExisting(input, binding);
    if (reusedAtStart) return reusedAtStart;
    assertSourceIdentityAvailable(input);

    const bundleSize = derivePeerRangeManifestBundleSize(
      offer.encodedSize,
      offer.manifestByteLength,
    );
    if (bundleSize === null) {
      throw new RangeError('Peer manifest bundle size is invalid');
    }
    const digestManifest = resolveSha256Digest();
    const expectedManifestDigest = decodeOfferedDigest(offer.manifestSha256B64);
    if (claim.status !== 'opening' || !claimMatchesInput(claim, input)) {
      throw new Error('Peer manifest handle ownership changed before opening');
    }
    const rawSource = new PeerRangeEncodedAudioSource({
      size: bundleSize,
      identity: offer.sourceIdentity,
      metadata: { name: offer.name, mime: offer.mime },
      transport: input.transport,
      handleId: offer.handleId,
    });
    claim.opened = true;
    ownedSource = rawSource;

    const manifestBytes = await readManifestBytes(input, rawSource);
    assertCurrent(input);
    let digestValue: unknown;
    try {
      digestValue = await digestManifest(manifestBytes);
    } catch (error) {
      assertCurrent(input);
      throw integrityError('Peer manifest SHA-256 failed', error);
    }
    assertCurrent(input);
    const actualManifestDigest = copySha256Result(digestValue);
    if (!equalSha256(actualManifestDigest, expectedManifestDigest)) {
      throw integrityError('Peer manifest SHA-256 does not match its offer');
    }

    let manifest: Readonly<CodecTimelineManifest>;
    try {
      manifest = parseCodecTimelineManifest(manifestBytes);
    } catch (error) {
      throw integrityError('Peer manifest is not canonical', error);
    }
    if (manifest.sourceSize !== offer.encodedSize) {
      throw integrityError('Peer manifest sourceSize does not match its media offer');
    }
    assertCurrent(input);

    const mediaSource = new OffsetEncodedAudioSource({
      source: rawSource,
      mediaOffset: offer.manifestByteLength,
      mediaSize: offer.encodedSize,
    });
    ownedSource = mediaSource;
    const sourceBinding = await computeCodecTimelineSourceBindingSha256(
      {
        schemaVersion: 1,
        queueItemId: binding.queueItemId,
        sourceIdentity: binding.sourceIdentity,
        transferSessionId: binding.transferSessionId,
        encodedSize: offer.encodedSize,
        name: offer.name,
        mime: offer.mime,
      },
      mediaSource,
      input.operation.fence.signal,
    );
    assertCurrent(input);
    const exactSourceBinding = exactLocalBytes(
      sourceBinding,
      CODEC_TIMELINE_MANIFEST_SOURCE_BINDING_BYTES,
      'Peer manifest source binding',
    );
    if (!equalSha256(exactSourceBinding, manifest.sourceBindingSha256)) {
      throw integrityError('Peer manifest source binding does not match its media source');
    }

    const reusedBeforeCommit = reuseExisting(input, binding);
    if (reusedBeforeCommit) return reusedBeforeCommit;
    const authority = Object.freeze(Object.create(null)) as FilePlaybackPeerRangeManifestAdmission;
    const asset = new SharedEncodedAudioAsset(mediaSource);
    ownedSource = null;
    ownedAsset = asset;
    assertCurrent(input);

    try {
      registryLease = Reflect.apply(registryAdmitEncodedAsset, input.registry, [
        input.roomToken,
        binding,
        asset,
      ]);
    } catch (error) {
      // The registry may have claimed and already closed this asset. Its close
      // operation is idempotent, so joining it here cannot close the handle twice.
      await suppressClose(asset);
      ownedAsset = null;
      throw error;
    }
    ownedAsset = null;
    let published = false;
    try {
      const snapshot = Reflect.apply(registrySnapshotForLease, input.registry, [
        input.roomToken,
        registryLease,
      ]);
      if (!sameAsset(snapshot, binding, offer)) {
        throw new Error('Registry admitted a mismatched peer manifest asset');
      }

      // Commit-dominant boundary: publication writes both opaque indexes
      // synchronously; no caller callback or await occurs inside it.
      const result = publishAdmission(input, authority, registryLease, snapshot, manifest);
      published = true;
      return result;
    } catch (error) {
      if (published) throw error;
      const admittedLease = registryLease;
      try {
        await Reflect.apply(registryRetire, input.registry, [input.roomToken, admittedLease]);
      } catch (retirementError) {
        throw new AggregateError(
          [error, retirementError],
          'Peer manifest admission publication and exact lease retirement both failed',
          { cause: retirementError },
        );
      }
      throw error;
    }
  } finally {
    if (ownedAsset) await suppressClose(ownedAsset);
    if (ownedSource) await suppressClose(ownedSource);
  }
}

function startHandleClaim(
  input: CanonicalInput,
  claim: HandleClaim,
): Promise<Readonly<FilePlaybackPeerRangeManifestAcquisition>> {
  const promise = Promise.resolve()
    .then(() => acquirePhysical(input, claim))
    .then(
      (result) => {
        claim.result = result;
        claim.status = 'live';
        return result;
      },
      (error: unknown) => {
        if (claim.opened) tombstoneClaim(claim);
        else releaseUnopenedClaim(claim);
        throw error;
      },
    );
  claim.promise = promise;
  return promise;
}

function joinOpeningClaim(
  input: CanonicalInput,
  claim: HandleClaim,
): Promise<Readonly<FilePlaybackPeerRangeManifestAcquisition>> {
  const promise = claim.promise;
  if (!promise) {
    return Promise.reject(new Error('Peer manifest handle claim has no opening transaction'));
  }
  if (claim.primaryOperation === input.operation.operation) return promise;
  return promise.then((result) => {
    assertCurrent(input);
    return result;
  });
}

function reuseLiveClaim(
  input: CanonicalInput,
  claim: HandleClaim,
): Promise<Readonly<FilePlaybackPeerRangeManifestAcquisition>> {
  try {
    assertCurrent(input);
  } catch (error) {
    return Promise.reject(error);
  }
  const result = claim.result;
  if (!result) {
    tombstoneClaim(claim);
    return Promise.reject(new Error('Peer manifest live handle claim has no admission'));
  }
  try {
    readFilePlaybackPeerRangeManifestAdmission(result.manifestAdmission, result.assetLease);
  } catch (error) {
    tombstoneClaim(claim);
    return Promise.reject(error);
  }
  try {
    assertCurrent(input);
    return Promise.resolve(result);
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Acquire, verify, and register only the media window from one exact
 * `[manifest][media]` peer handle. This cold RUN/live-admission unit does not
 * provide OFFER-time warm/provisional ownership. It is intentionally not
 * wired into the product guest owner while the bounded route gate remains off.
 */
export function acquireFilePlaybackPeerRangeManifestAsset(
  options: AcquireFilePlaybackPeerRangeManifestOptions,
): Promise<Readonly<FilePlaybackPeerRangeManifestAcquisition>> {
  let optionsSnapshot: ExactRecord | null;
  try {
    optionsSnapshot = snapshotExactDataRecord(
      options,
      OPTIONS_KEYS,
      'Peer manifest acquisition options',
    );
  } catch (error) {
    return Promise.reject(error);
  }
  if (!optionsSnapshot) {
    return Promise.reject(new TypeError('Peer manifest acquisition options are invalid'));
  }
  try {
    assertFilePlaybackConnectionMediaOperationCurrent(optionsSnapshot.operation);
  } catch (error) {
    return Promise.reject(error);
  }
  const input = snapshotInput(optionsSnapshot);
  if (!input) {
    return Promise.reject(new TypeError('Peer manifest acquisition options are invalid'));
  }
  try {
    assertCurrent(input);
    const { claim, created } = claimHandle(input);
    if (created) return startHandleClaim(input, claim);
    if (claim.status === 'opening') return joinOpeningClaim(input, claim);
    if (claim.status === 'live') return reuseLiveClaim(input, claim);
    if (claim.status === 'tombstone') {
      return Promise.reject(
        new Error('Peer manifest handle is permanently closed and cannot be reopened'),
      );
    }
    return Promise.reject(new Error('Peer manifest handle claim was released before acquisition'));
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Read immutable evidence only while the exact admitted registry lease is live. */
export function readFilePlaybackPeerRangeManifestAdmission(
  admission: FilePlaybackPeerRangeManifestAdmission,
  assetLease: FilePlaybackAssetLease,
): Readonly<FilePlaybackPeerRangeManifestAdmissionEvidence> {
  const record =
    admission !== null && typeof admission === 'object'
      ? ADMISSIONS.get(admission as object)
      : undefined;
  if (!record || record.authority !== admission) {
    throw new Error('File playback peer manifest admission is forged or stale');
  }
  if (assetLease !== record.assetLease) {
    throw new Error('File playback peer manifest admission belongs to another asset lease');
  }
  const snapshot = Reflect.apply(registrySnapshotForLease, record.registry, [
    record.roomToken,
    record.assetLease,
  ]);
  if (!sameAsset(snapshot, record.evidence.asset, record.offer)) {
    ADMISSIONS.delete(record.authority as object);
    ADMISSIONS_BY_LEASE.delete(record.assetLease as object);
    throw new Error('File playback peer manifest admission is stale');
  }
  return record.evidence;
}
