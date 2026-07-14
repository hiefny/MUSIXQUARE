import type { QueueItemId } from '../../types/index.ts';
import {
  isScannerIssuedAdtsFrameScanResult,
  type AdtsFrameScanResult,
} from '../aac/frame-scanner.ts';
import { scannerIssuedMp3MetadataSource, type Mp3Metadata } from '../mp3/metadata.ts';
import { throwIfAborted, type EncodedRandomAccessSource } from '../sources/encoded-audio-source.ts';
import {
  sealAdtsFrameScanTimelineManifest,
  sealMp3MetadataTimelineManifest,
  type CodecTimelineManifestSeal,
} from './codec-timeline-manifest-seal.ts';
import {
  parseCodecTimelineManifest,
  type CodecTimelineManifest,
} from './codec-timeline-manifest.ts';
import { computeCodecTimelineSourceBindingSha256 } from './codec-timeline-source-binding.ts';

const BINDING_KEYS = Object.freeze([
  'queueItemId',
  'sourceIdentity',
  'transferSessionId',
  'encodedSize',
  'name',
  'mime',
] as const);
const CREATE_KEYS = Object.freeze(['binding', 'source', 'timeline', 'signal'] as const);
const COPY_KEYS = Object.freeze(['artifact', 'binding'] as const);
const SHA_256_BYTES = 32;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const Uint8ArrayIntrinsic = Uint8Array;
const uint8ArraySet = Uint8ArrayIntrinsic.prototype.set;
const uint8ArrayFill = Uint8ArrayIntrinsic.prototype.fill;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;

type ExactRecord = Readonly<Record<string, unknown>>;

export interface CodecTimelineHostArtifactBinding {
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly encodedSize: number;
  readonly name: string;
  readonly mime: string;
}

export interface CreateCodecTimelineHostArtifactOptions {
  readonly binding: CodecTimelineHostArtifactBinding;
  readonly source: EncodedRandomAccessSource;
  readonly timeline: Readonly<AdtsFrameScanResult> | Readonly<Mp3Metadata>;
  readonly signal: AbortSignal;
}

declare const codecTimelineHostArtifactBrand: unique symbol;

/**
 * Body-free host diagnostics for one canonical codec timeline manifest.
 *
 * Authenticity and bytes remain module-private. The prototype diagnostics are
 * intentionally non-enumerable, so serializing or spreading an artifact does
 * not reproduce its authority.
 */
export interface CodecTimelineHostArtifact {
  readonly [codecTimelineHostArtifactBrand]: never;
  readonly codec: CodecTimelineManifest['codec'];
  readonly binding: Readonly<CodecTimelineHostArtifactBinding>;
  readonly manifestByteLength: number;
  readonly manifestSha256B64: string;
}

export interface CopyCodecTimelineHostArtifactManifestOptions {
  readonly artifact: CodecTimelineHostArtifact;
  /** Exact live source identity expected by the caller's owning registry. */
  readonly binding: CodecTimelineHostArtifactBinding;
}

interface ArtifactRecord {
  readonly codec: CodecTimelineManifest['codec'];
  readonly binding: Readonly<CodecTimelineHostArtifactBinding>;
  readonly manifestByteLength: number;
  readonly manifestSha256B64: string;
  readonly manifestBytes: Uint8Array;
}

export class CodecTimelineHostArtifactError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CodecTimelineHostArtifactError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

const ARTIFACTS = new WeakMap<object, ArtifactRecord>();

function fail(message: string, cause?: unknown): never {
  throw new CodecTimelineHostArtifactError(message, cause);
}

function artifactRecord(value: unknown): ArtifactRecord {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return fail('Codec timeline host artifact is not authentic');
  }
  const record = ARTIFACTS.get(value);
  if (!record) return fail('Codec timeline host artifact is not authentic');
  return record;
}

class OpaqueCodecTimelineHostArtifact implements CodecTimelineHostArtifact {
  declare readonly [codecTimelineHostArtifactBrand]: never;

  get codec(): CodecTimelineManifest['codec'] {
    return artifactRecord(this).codec;
  }

  get binding(): Readonly<CodecTimelineHostArtifactBinding> {
    return artifactRecord(this).binding;
  }

  get manifestByteLength(): number {
    return artifactRecord(this).manifestByteLength;
  }

  get manifestSha256B64(): string {
    return artifactRecord(this).manifestSha256B64;
  }
}

Object.setPrototypeOf(OpaqueCodecTimelineHostArtifact.prototype, null);
Object.freeze(OpaqueCodecTimelineHostArtifact.prototype);

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): ExactRecord {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail(`${label} must be an exact data record`);
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail(`${label} must have a plain or null prototype`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set(expectedKeys);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return fail(`${label} fields are not exact`);
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return fail(`${label} field ${key} must be enumerable data`);
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof CodecTimelineHostArtifactError) throw error;
    return fail(`${label} could not be inspected`, error);
  }
}

function canonicalBinding(snapshot: ExactRecord): Readonly<CodecTimelineHostArtifactBinding> {
  return Object.freeze(
    Object.assign(Object.create(null), {
      queueItemId: snapshot.queueItemId as QueueItemId,
      sourceIdentity: snapshot.sourceIdentity as string,
      transferSessionId: snapshot.transferSessionId as string,
      encodedSize: snapshot.encodedSize as number,
      name: snapshot.name as string,
      mime: snapshot.mime as string,
    }),
  ) as Readonly<CodecTimelineHostArtifactBinding>;
}

function sourceBindingDescriptor(binding: ExactRecord): ExactRecord {
  return Object.freeze(
    Object.assign(Object.create(null), {
      schemaVersion: 1,
      queueItemId: binding.queueItemId,
      sourceIdentity: binding.sourceIdentity,
      transferSessionId: binding.transferSessionId,
      encodedSize: binding.encodedSize,
      name: binding.name,
      mime: binding.mime,
    }),
  ) as ExactRecord;
}

function sameBinding(
  left: Readonly<CodecTimelineHostArtifactBinding>,
  right: ExactRecord,
): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.sourceIdentity === right.sourceIdentity &&
    left.transferSessionId === right.transferSessionId &&
    left.encodedSize === right.encodedSize &&
    left.name === right.name &&
    left.mime === right.mime
  );
}

function sameBytes(left: readonly number[], right: Uint8Array): boolean {
  return left.length === right.byteLength && left.every((value, index) => value === right[index]);
}

function assertSourceStillMatchesBinding(
  source: EncodedRandomAccessSource,
  binding: ExactRecord,
  expectedMetadataPresence?: boolean,
): boolean {
  try {
    if (source === null || (typeof source !== 'object' && typeof source !== 'function')) {
      return fail('Host artifact source is invalid');
    }
    if (
      Reflect.get(source, 'identity') !== binding.sourceIdentity ||
      Reflect.get(source, 'size') !== binding.encodedSize
    ) {
      return fail('Host artifact source changed after its bounded identity probe');
    }
    const metadata = Reflect.get(source, 'metadata') as unknown;
    const hasMetadata = metadata !== undefined;
    if (expectedMetadataPresence !== undefined && hasMetadata !== expectedMetadataPresence) {
      return fail(
        'Host artifact source metadata presence changed after its bounded identity probe',
      );
    }
    if (metadata !== undefined) {
      if (
        metadata === null ||
        typeof metadata !== 'object' ||
        Reflect.get(metadata, 'name') !== binding.name ||
        Reflect.get(metadata, 'mime') !== binding.mime
      ) {
        return fail('Host artifact source metadata changed after its bounded identity probe');
      }
    }
    return hasMetadata;
  } catch (error) {
    if (error instanceof CodecTimelineHostArtifactError) throw error;
    return fail('Host artifact source could not be revalidated', error);
  }
}

function selectSeal(
  timeline: unknown,
  binding: ExactRecord,
  sourceBindingSha256: Uint8Array,
): CodecTimelineManifestSeal {
  const isAdts = isScannerIssuedAdtsFrameScanResult(timeline);
  const mp3Source = scannerIssuedMp3MetadataSource(timeline);
  if (isAdts === (mp3Source !== null)) {
    return fail('Timeline must be exactly one scanner-issued ADTS or MP3 result');
  }

  const expectedSourceIdentity = binding.sourceIdentity;
  const expectedSize = binding.encodedSize;
  if (isAdts) {
    if (
      timeline.sourceIdentity !== expectedSourceIdentity ||
      timeline.sourceSize !== expectedSize
    ) {
      return fail('ADTS timeline does not match the exact artifact source binding');
    }
    return sealAdtsFrameScanTimelineManifest(timeline, sourceBindingSha256);
  }

  if (
    !mp3Source ||
    mp3Source.sourceIdentity !== expectedSourceIdentity ||
    mp3Source.sourceSize !== expectedSize
  ) {
    return fail('MP3 timeline does not match the exact artifact source binding');
  }
  return sealMp3MetadataTimelineManifest(timeline, sourceBindingSha256);
}

function copyArrayBufferDigest(value: unknown): Uint8Array {
  try {
    if (!arrayBufferByteLengthGetter) return fail('SHA-256 result is invalid');
    const byteLength = arrayBufferByteLengthGetter.call(value) as number;
    if (byteLength !== SHA_256_BYTES) {
      return fail(`SHA-256 result must contain exactly ${SHA_256_BYTES} bytes`);
    }
    const copy = new Uint8ArrayIntrinsic(SHA_256_BYTES);
    uint8ArraySet.call(copy, new Uint8ArrayIntrinsic(value as ArrayBuffer), 0);
    return copy;
  } catch (error) {
    if (error instanceof CodecTimelineHostArtifactError) throw error;
    return fail('SHA-256 result could not be copied', error);
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let encoded = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const first = bytes[offset] ?? 0;
    const secondPresent = offset + 1 < bytes.byteLength;
    const thirdPresent = offset + 2 < bytes.byteLength;
    const second = secondPresent ? (bytes[offset + 1] ?? 0) : 0;
    const third = thirdPresent ? (bytes[offset + 2] ?? 0) : 0;
    const value = (first << 16) | (second << 8) | third;
    encoded += BASE64_ALPHABET[(value >>> 18) & 0x3f];
    encoded += BASE64_ALPHABET[(value >>> 12) & 0x3f];
    encoded += secondPresent ? BASE64_ALPHABET[(value >>> 6) & 0x3f] : '=';
    encoded += thirdPresent ? BASE64_ALPHABET[value & 0x3f] : '=';
  }
  return encoded;
}

async function manifestSha256Base64(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  let digest: SubtleCrypto['digest'];
  let subtle: SubtleCrypto;
  try {
    subtle = globalThis.crypto?.subtle;
    digest = subtle?.digest;
    if (!subtle || typeof digest !== 'function') {
      return fail('Web Crypto SHA-256 is unavailable');
    }
  } catch (error) {
    if (error instanceof CodecTimelineHostArtifactError) throw error;
    return fail('Web Crypto SHA-256 is unavailable', error);
  }

  let result: unknown;
  try {
    const inputCopy = new Uint8ArrayIntrinsic(bytes.byteLength);
    uint8ArraySet.call(inputCopy, bytes, 0);
    result = await digest.call(subtle, 'SHA-256', inputCopy);
  } catch (error) {
    throwIfAborted(signal);
    return fail('Manifest SHA-256 digest failed', error);
  }
  throwIfAborted(signal);
  const digestBytes = copyArrayBufferDigest(result);
  try {
    return encodeBase64(digestBytes);
  } finally {
    uint8ArrayFill.call(digestBytes, 0);
  }
}

function issueArtifact(record: ArtifactRecord): Readonly<CodecTimelineHostArtifact> {
  const artifact = new OpaqueCodecTimelineHostArtifact();
  ARTIFACTS.set(artifact, record);
  Object.freeze(artifact);
  return artifact;
}

/**
 * Compose one scanner-issued timeline with the exact bounded source binding.
 * The source is observed but never closed or transferred by this function.
 */
export async function createCodecTimelineHostArtifact(
  optionsValue: unknown,
): Promise<Readonly<CodecTimelineHostArtifact>> {
  const options = snapshotExactDataRecord(optionsValue, CREATE_KEYS, 'Host artifact options');
  const bindingSnapshot = snapshotExactDataRecord(
    options.binding,
    BINDING_KEYS,
    'Host artifact binding',
  );
  const source = options.source as EncodedRandomAccessSource;
  const signal = options.signal;
  if (!(signal instanceof AbortSignal)) {
    return fail('Host artifact signal must be an AbortSignal');
  }
  throwIfAborted(signal);

  // Reject copied or unrelated scanner evidence before performing source probes.
  const timeline = options.timeline;
  const isAdts = isScannerIssuedAdtsFrameScanResult(timeline);
  const mp3Source = scannerIssuedMp3MetadataSource(timeline);
  if (isAdts === (mp3Source !== null)) {
    return fail('Timeline must be exactly one scanner-issued ADTS or MP3 result');
  }
  const timelineSource = isAdts
    ? Object.freeze({
        sourceIdentity: timeline.sourceIdentity,
        sourceSize: timeline.sourceSize,
      })
    : mp3Source;
  if (
    !timelineSource ||
    timelineSource.sourceIdentity !== bindingSnapshot.sourceIdentity ||
    timelineSource.sourceSize !== bindingSnapshot.encodedSize
  ) {
    return fail('Scanner-issued timeline does not match the exact artifact source binding');
  }

  const sourceBindingSha256 = await computeCodecTimelineSourceBindingSha256(
    sourceBindingDescriptor(bindingSnapshot),
    source,
    signal,
  );
  try {
    throwIfAborted(signal);
    const sourceHasMetadata = assertSourceStillMatchesBinding(source, bindingSnapshot);
    const seal = selectSeal(timeline, bindingSnapshot, sourceBindingSha256);
    if (
      seal.sourceIdentity !== bindingSnapshot.sourceIdentity ||
      seal.sourceSize !== bindingSnapshot.encodedSize
    ) {
      return fail('Manifest seal does not match the exact artifact source binding');
    }

    const manifestBytes = seal.copyBytes();
    if (manifestBytes.byteLength !== seal.byteLength) {
      return fail('Manifest seal byte length is inconsistent');
    }
    const parsedBeforeHash = parseCodecTimelineManifest(manifestBytes);
    if (
      parsedBeforeHash.codec !== seal.codec ||
      parsedBeforeHash.sourceSize !== bindingSnapshot.encodedSize ||
      !sameBytes(parsedBeforeHash.sourceBindingSha256, sourceBindingSha256)
    ) {
      return fail('Manifest seal does not reconstruct the exact source binding');
    }

    const manifestSha256B64 = await manifestSha256Base64(manifestBytes, signal);
    throwIfAborted(signal);
    assertSourceStillMatchesBinding(source, bindingSnapshot, sourceHasMetadata);
    throwIfAborted(signal);
    // Hashing receives a detached copy. Reparse owned storage before publication
    // so even a hostile test digest cannot mutate the retained body.
    const parsedAfterHash = parseCodecTimelineManifest(manifestBytes);
    if (
      parsedAfterHash.codec !== parsedBeforeHash.codec ||
      !sameBytes(parsedAfterHash.sourceBindingSha256, sourceBindingSha256)
    ) {
      return fail('Manifest bytes changed while the host artifact was being issued');
    }

    const binding = canonicalBinding(bindingSnapshot);
    return issueArtifact(
      Object.freeze({
        codec: parsedAfterHash.codec,
        binding,
        manifestByteLength: manifestBytes.byteLength,
        manifestSha256B64,
        manifestBytes,
      }),
    );
  } finally {
    uint8ArrayFill.call(sourceBindingSha256, 0);
  }
}

/**
 * Copy a reusable artifact body for one guest handle only after the caller
 * presents the exact source identity it currently owns. Every successful read
 * returns isolated storage; mutating one guest's prefix cannot affect another.
 */
export function copyCodecTimelineHostArtifactManifest(optionsValue: unknown): Uint8Array {
  const options = snapshotExactDataRecord(optionsValue, COPY_KEYS, 'Host artifact copy options');
  const record = artifactRecord(options.artifact);
  const expectedBinding = snapshotExactDataRecord(
    options.binding,
    BINDING_KEYS,
    'Host artifact copy binding',
  );
  if (!sameBinding(record.binding, expectedBinding)) {
    return fail('Host artifact copy binding does not match its exact source identity');
  }

  const copy = new Uint8ArrayIntrinsic(record.manifestBytes.byteLength);
  uint8ArraySet.call(copy, record.manifestBytes, 0);
  return copy;
}
