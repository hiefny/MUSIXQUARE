import { isQueueItemId } from '../queue-model.ts';
import { throwIfAborted, type EncodedRandomAccessSource } from '../sources/encoded-audio-source.ts';

/**
 * Binds a bounded codec timeline to one exact distributed source and to small,
 * non-overlapping probes of its encoded bytes.
 *
 * This module deliberately owns neither transport nor manifest policy. It
 * only produces the canonical 32-byte SHA-256 value consumed by those layers.
 */

const SCHEMA_VERSION = 1;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_NAME_LENGTH = 512;
const MAX_MIME_LENGTH = 128;
const MAX_PROBE_BYTES = 64 * 1_024;
const SHA_256_BYTES = 32;
const MIME_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const DESCRIPTOR_KEYS = Object.freeze([
  'schemaVersion',
  'queueItemId',
  'sourceIdentity',
  'transferSessionId',
  'encodedSize',
  'name',
  'mime',
] as const);
const DOMAIN = Uint8Array.of(
  0x4d,
  0x58,
  0x51,
  0x2d,
  0x43,
  0x54,
  0x53,
  0x2d,
  0x42,
  0x49,
  0x4e,
  0x44,
  0x00,
);

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
const uint8ArraySet = Uint8Array.prototype.set;

type Sha256Digest = (algorithm: 'SHA-256', data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;

interface SourceBindingDescriptor {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly queueItemId: string;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly encodedSize: number;
  readonly name: string;
  readonly mime: string;
}

interface ProbeGeometry {
  readonly firstOffset: 0;
  readonly firstLength: number;
  readonly tailOffset: number;
  readonly tailLength: number;
}

interface ValidatedSource {
  readonly readAt: EncodedRandomAccessSource['readAt'];
  readonly hasMetadata: boolean;
}

class CodecTimelineSourceBindingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CodecTimelineSourceBindingError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

function fail(message: string, cause?: unknown): never {
  throw new CodecTimelineSourceBindingError(message, cause);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value) &&
    !hasUnpairedSurrogate(value)
  );
}

function isName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_NAME_LENGTH &&
    !containsControlCharacter(value) &&
    !hasUnpairedSurrogate(value)
  );
}

function isMime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_MIME_LENGTH && MIME_PATTERN.test(value);
}

function snapshotDescriptor(value: unknown): SourceBindingDescriptor {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail('Source binding descriptor must be an exact data record');
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail('Source binding descriptor must have a plain or null prototype');
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expectedKeys = new Set<string>(DESCRIPTOR_KEYS);
    if (
      ownKeys.length !== DESCRIPTOR_KEYS.length ||
      ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))
    ) {
      return fail('Source binding descriptor fields are not exact');
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of DESCRIPTOR_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return fail(`Source binding descriptor field ${key} must be enumerable data`);
      }
      snapshot[key] = descriptor.value;
    }

    if (snapshot.schemaVersion !== SCHEMA_VERSION) {
      return fail('Source binding schemaVersion must be 1');
    }
    if (!isQueueItemId(snapshot.queueItemId)) {
      return fail('Source binding queueItemId is invalid');
    }
    if (!isIdentifier(snapshot.sourceIdentity)) {
      return fail('Source binding sourceIdentity is invalid');
    }
    if (!isIdentifier(snapshot.transferSessionId)) {
      return fail('Source binding transferSessionId is invalid');
    }
    if (
      new Set([snapshot.queueItemId, snapshot.sourceIdentity, snapshot.transferSessionId]).size !==
      3
    ) {
      return fail('Source binding identities must be distinct');
    }
    if (
      typeof snapshot.encodedSize !== 'number' ||
      !Number.isSafeInteger(snapshot.encodedSize) ||
      snapshot.encodedSize <= 0
    ) {
      return fail('Source binding encodedSize must be a positive safe integer');
    }
    if (!isName(snapshot.name)) {
      return fail('Source binding name is invalid');
    }
    if (!isMime(snapshot.mime)) {
      return fail('Source binding mime is invalid');
    }

    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      queueItemId: snapshot.queueItemId,
      sourceIdentity: snapshot.sourceIdentity,
      transferSessionId: snapshot.transferSessionId,
      encodedSize: snapshot.encodedSize,
      name: snapshot.name,
      mime: snapshot.mime,
    });
  } catch (error) {
    if (error instanceof CodecTimelineSourceBindingError) throw error;
    return fail('Source binding descriptor could not be inspected', error);
  }
}

function assertSourceMatchesDescriptor(
  source: EncodedRandomAccessSource,
  descriptor: SourceBindingDescriptor,
  expectedMetadataPresence?: boolean,
): boolean {
  try {
    if (source === null || (typeof source !== 'object' && typeof source !== 'function')) {
      fail('Encoded source is invalid');
    }
    if (Reflect.get(source, 'identity') !== descriptor.sourceIdentity) {
      fail('Encoded source identity does not match the binding descriptor');
    }
    if (Reflect.get(source, 'size') !== descriptor.encodedSize) {
      fail('Encoded source size does not match the binding descriptor');
    }

    const metadata = Reflect.get(source, 'metadata') as unknown;
    const hasMetadata = metadata !== undefined;
    if (expectedMetadataPresence !== undefined && hasMetadata !== expectedMetadataPresence) {
      fail('Encoded source metadata presence changed while binding');
    }
    if (metadata !== undefined) {
      if (metadata === null || typeof metadata !== 'object') {
        fail('Encoded source metadata is invalid');
      }
      if (
        Reflect.get(metadata, 'name') !== descriptor.name ||
        Reflect.get(metadata, 'mime') !== descriptor.mime
      ) {
        fail('Encoded source metadata does not match the binding descriptor');
      }
    }
    return hasMetadata;
  } catch (error) {
    if (error instanceof CodecTimelineSourceBindingError) throw error;
    fail('Encoded source could not be inspected', error);
  }
}

function validateSource(
  source: EncodedRandomAccessSource,
  descriptor: SourceBindingDescriptor,
): ValidatedSource {
  const hasMetadata = assertSourceMatchesDescriptor(source, descriptor);
  try {
    const readAt = Reflect.get(source, 'readAt') as unknown;
    if (typeof readAt !== 'function') {
      return fail('Encoded source readAt is unavailable');
    }
    return Object.freeze({
      readAt: readAt as EncodedRandomAccessSource['readAt'],
      hasMetadata,
    });
  } catch (error) {
    if (error instanceof CodecTimelineSourceBindingError) throw error;
    return fail('Encoded source readAt could not be inspected', error);
  }
}

function createProbeGeometry(size: number): ProbeGeometry {
  const firstLength = Math.min(MAX_PROBE_BYTES, size);
  const tailOffset = firstLength === size ? size : Math.max(firstLength, size - MAX_PROBE_BYTES);
  return Object.freeze({
    firstOffset: 0,
    firstLength,
    tailOffset,
    tailLength: size - tailOffset,
  });
}

function copyExactUint8Array(value: unknown, expectedLength: number): Uint8Array {
  try {
    if (
      !typedArrayByteLengthGetter ||
      !typedArrayBufferGetter ||
      !typedArrayTagGetter ||
      !arrayBufferByteLengthGetter ||
      typedArrayTagGetter.call(value) !== 'Uint8Array'
    ) {
      return fail('Encoded source probe must be a Uint8Array');
    }
    const byteLength = typedArrayByteLengthGetter.call(value) as number;
    const buffer = typedArrayBufferGetter.call(value) as unknown;
    arrayBufferByteLengthGetter.call(buffer);
    if (byteLength !== expectedLength) {
      return fail(`Encoded source probe was short: expected ${expectedLength}, got ${byteLength}`);
    }
    const copy = new Uint8Array(expectedLength);
    uint8ArraySet.call(copy, value as Uint8Array);
    return copy;
  } catch (error) {
    if (error instanceof CodecTimelineSourceBindingError) throw error;
    return fail('Encoded source probe could not be copied', error);
  }
}

async function readProbe(
  source: EncodedRandomAccessSource,
  readAt: EncodedRandomAccessSource['readAt'],
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  let bytes: unknown;
  try {
    bytes = await readAt.call(source, offset, length, signal);
  } catch (error) {
    throwIfAborted(signal);
    return fail(`Encoded source probe read [${offset}, ${offset + length}) failed`, error);
  }
  throwIfAborted(signal);
  return copyExactUint8Array(bytes, length);
}

function encodeStrings(descriptor: SourceBindingDescriptor): readonly Uint8Array[] {
  const encoder = new TextEncoder();
  return Object.freeze([
    encoder.encode(descriptor.queueItemId),
    encoder.encode(descriptor.sourceIdentity),
    encoder.encode(descriptor.transferSessionId),
    encoder.encode(descriptor.name),
    encoder.encode(descriptor.mime),
  ]);
}

function writeU64(view: DataView, offset: number, value: number): void {
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value - high * 0x1_0000_0000;
  view.setUint32(offset, high, false);
  view.setUint32(offset + 4, low, false);
}

function createPreimage(
  descriptor: SourceBindingDescriptor,
  geometry: ProbeGeometry,
  firstProbe: Uint8Array,
  tailProbe: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const strings = encodeStrings(descriptor);
  const stringsLength = strings.reduce((total, bytes) => total + 4 + bytes.byteLength, 0);
  const byteLength =
    DOMAIN.byteLength +
    2 +
    8 +
    stringsLength +
    8 +
    4 +
    8 +
    4 +
    firstProbe.byteLength +
    tailProbe.byteLength;
  const preimage = new Uint8Array(byteLength);
  const view = new DataView(preimage.buffer);
  let offset = 0;

  preimage.set(DOMAIN, offset);
  offset += DOMAIN.byteLength;
  view.setUint16(offset, descriptor.schemaVersion, false);
  offset += 2;
  writeU64(view, offset, descriptor.encodedSize);
  offset += 8;

  for (const bytes of strings) {
    view.setUint32(offset, bytes.byteLength, false);
    offset += 4;
    preimage.set(bytes, offset);
    offset += bytes.byteLength;
  }

  writeU64(view, offset, geometry.firstOffset);
  offset += 8;
  view.setUint32(offset, geometry.firstLength, false);
  offset += 4;
  writeU64(view, offset, geometry.tailOffset);
  offset += 8;
  view.setUint32(offset, geometry.tailLength, false);
  offset += 4;
  preimage.set(firstProbe, offset);
  offset += firstProbe.byteLength;
  preimage.set(tailProbe, offset);
  offset += tailProbe.byteLength;

  if (offset !== byteLength) return fail('Source binding preimage length is inconsistent');
  return preimage;
}

function resolveDigest(): Sha256Digest {
  try {
    const subtle = globalThis.crypto?.subtle;
    const digest = subtle?.digest;
    if (!subtle || typeof digest !== 'function') {
      return fail('Web Crypto SHA-256 is unavailable');
    }
    return (algorithm, data) => digest.call(subtle, algorithm, data);
  } catch (error) {
    if (error instanceof CodecTimelineSourceBindingError) throw error;
    return fail('Web Crypto SHA-256 is unavailable', error);
  }
}

function copyDigest(value: unknown): Uint8Array {
  try {
    if (!arrayBufferByteLengthGetter) return fail('SHA-256 result is invalid');
    const byteLength = arrayBufferByteLengthGetter.call(value) as number;
    if (byteLength !== SHA_256_BYTES) {
      return fail(`SHA-256 result must contain exactly ${SHA_256_BYTES} bytes`);
    }
    const view = new Uint8Array(value as ArrayBuffer);
    const copy = new Uint8Array(SHA_256_BYTES);
    uint8ArraySet.call(copy, view);
    return copy;
  } catch (error) {
    if (error instanceof CodecTimelineSourceBindingError) throw error;
    return fail('SHA-256 result could not be copied', error);
  }
}

/**
 * Compute the canonical source-binding digest for one exact encoded source.
 *
 * The digest authority is always snapshotted from
 * `crypto.subtle.digest('SHA-256', ...)`; there is intentionally no caller
 * override and no fallback.
 */
export async function computeCodecTimelineSourceBindingSha256(
  descriptorValue: unknown,
  source: EncodedRandomAccessSource,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!(signal instanceof AbortSignal)) {
    return fail('Source binding signal must be an AbortSignal');
  }
  throwIfAborted(signal);
  const descriptor = snapshotDescriptor(descriptorValue);
  const validatedSource = validateSource(source, descriptor);
  const digest = resolveDigest();
  const geometry = createProbeGeometry(descriptor.encodedSize);

  const firstProbe = await readProbe(
    source,
    validatedSource.readAt,
    geometry.firstOffset,
    geometry.firstLength,
    signal,
  );
  assertSourceMatchesDescriptor(source, descriptor, validatedSource.hasMetadata);
  const tailProbe =
    geometry.tailLength === 0
      ? new Uint8Array(0)
      : await readProbe(
          source,
          validatedSource.readAt,
          geometry.tailOffset,
          geometry.tailLength,
          signal,
        );
  if (geometry.tailLength > 0) {
    assertSourceMatchesDescriptor(source, descriptor, validatedSource.hasMetadata);
  }

  throwIfAborted(signal);
  const preimage = createPreimage(descriptor, geometry, firstProbe, tailProbe);
  let digestBuffer: unknown;
  try {
    digestBuffer = await digest('SHA-256', preimage);
  } catch (error) {
    throwIfAborted(signal);
    return fail('SHA-256 digest failed', error);
  }
  throwIfAborted(signal);
  assertSourceMatchesDescriptor(source, descriptor, validatedSource.hasMetadata);
  throwIfAborted(signal);
  return copyDigest(digestBuffer);
}
