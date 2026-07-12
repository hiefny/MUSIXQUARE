/**
 * Additive R2 record-crypto core. This module is deliberately disconnected
 * from the current whole-file V1 upload/download path.
 *
 * Public R2 metadata never contains the AES key. A protected secret descriptor
 * is emitted once, explicitly, by `takeSecretDescriptor()`; its caller owns
 * that descriptor and must deliver it over protected signaling, retain it only
 * as long as recovery/late join requires, and then drop every reference. Never
 * put the secret descriptor or `keyB64` in R2 metadata or an R2 request body.
 *
 * A successful ciphertext lease is the sole retry artifact. Upload retries
 * must reuse its immutable Blob; encrypting a second plaintext under the same
 * (key, noncePrefix, recordIndex) tuple is forbidden. No persistent browser
 * storage is used here. If an encryptor poisons, the caller must discard its
 * secret descriptor and every uploaded part, then restart with a fresh
 * encryptor/object identity.
 */

const FORMAT_VERSION = 2 as const;
const RECORD_PLAINTEXT_BYTES = 8 * 1024 * 1024;
const AES_GCM_TAG_BYTES = 16;
const AES_KEY_BYTES = 32;
const NONCE_PREFIX_BYTES = 8;
const IV_BYTES = 12;
const UINT32_MAX = 0xffff_ffff;
const AES_GCM_TAG_BITS = AES_GCM_TAG_BYTES * 8;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const OBJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const METADATA_KEYS = Object.freeze([
  'formatVersion',
  'objectId',
  'plaintextSize',
  'recordSize',
  'recordCount',
  'noncePrefixB64',
] as const);
const SECRET_DESCRIPTOR_KEYS = Object.freeze([...METADATA_KEYS, 'keyB64'] as const);
const AAD_DOMAIN = new TextEncoder().encode('MUSIXQUARE\0R2\0AES-256-GCM\0RECORD\0');
const OBJECT_ID_BYTES = 36;
const AAD_BYTES = AAD_DOMAIN.byteLength + 4 + OBJECT_ID_BYTES + 8 + 4 + 4 + 4 + 4;

interface R2RecordCryptoV2Metadata {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly objectId: string;
  readonly plaintextSize: number;
  readonly recordSize: typeof RECORD_PLAINTEXT_BYTES;
  readonly recordCount: number;
  readonly noncePrefixB64: string;
}

interface R2RecordCryptoV2SecretDescriptor extends R2RecordCryptoV2Metadata {
  readonly keyB64: string;
}

interface R2RecordCryptoV2Layout {
  readonly recordIndex: number;
  readonly plaintextOffset: number;
  readonly plaintextLength: number;
  readonly ciphertextOffset: number;
  readonly ciphertextLength: number;
}

type RecordBytes = ArrayBuffer | Uint8Array<ArrayBuffer>;
type EncryptorState = 'active' | 'complete' | 'poisoned' | 'disposed';

interface CiphertextLeaseState {
  active: boolean;
  blob: Blob | null;
  acknowledge: (() => void) | null;
}

const canonicalMetadata = new WeakSet<object>();
const canonicalSecrets = new WeakSet<object>();
const ENCRYPTOR_CONSTRUCTION_TOKEN = Object.freeze(Object.create(null) as object);
const DECRYPTOR_CONSTRUCTION_TOKEN = Object.freeze(Object.create(null) as object);
let descriptorSnapshotActive = false;
let descriptorSnapshotReentered = false;

const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteOffset',
)?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength',
)?.get;
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get;
const NativeBlob = globalThis.Blob;
const blobSizeGetter = Object.getOwnPropertyDescriptor(NativeBlob.prototype, 'size')?.get;
const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;

function fail(code: string, cause?: unknown): never {
  throw new Error(code, cause === undefined ? undefined : { cause });
}

function signalIsAborted(signal?: AbortSignal): boolean {
  if (signal === undefined) return false;
  if (!abortSignalAbortedGetter || typeof signal !== 'object' || signal === null) {
    fail('R2_V2_ABORT_SIGNAL_INVALID');
  }
  try {
    return Reflect.apply(abortSignalAbortedGetter, signal, []) as boolean;
  } catch (cause) {
    fail('R2_V2_ABORT_SIGNAL_INVALID', cause);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signalIsAborted(signal)) fail('R2_V2_ABORTED');
}

function encodeBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let encoded = '';
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const a = bytes[index] ?? 0;
    const hasB = index + 1 < bytes.byteLength;
    const hasC = index + 2 < bytes.byteLength;
    const b = hasB ? (bytes[index + 1] ?? 0) : 0;
    const c = hasC ? (bytes[index + 2] ?? 0) : 0;
    encoded += BASE64_ALPHABET[a >>> 2];
    encoded += BASE64_ALPHABET[((a & 0x03) << 4) | (b >>> 4)];
    encoded += hasB ? BASE64_ALPHABET[((b & 0x0f) << 2) | (c >>> 6)] : '=';
    encoded += hasC ? BASE64_ALPHABET[c & 0x3f] : '=';
  }
  return encoded;
}

function decodeStrictBase64(value: string, expectedBytes: number): Uint8Array<ArrayBuffer> {
  const expectedLength = Math.ceil(expectedBytes / 3) * 4;
  const expectedPadding = (3 - (expectedBytes % 3)) % 3;
  if (value.length !== expectedLength) fail('R2_V2_DESCRIPTOR_INVALID');

  const dataLength = value.length - expectedPadding;
  for (let index = 0; index < dataLength; index += 1) {
    if (BASE64_ALPHABET.indexOf(value[index] ?? '') < 0) fail('R2_V2_DESCRIPTOR_INVALID');
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value[index] !== '=') fail('R2_V2_DESCRIPTOR_INVALID');
  }

  if (expectedPadding === 1) {
    const finalValue = BASE64_ALPHABET.indexOf(value[dataLength - 1] ?? '');
    if ((finalValue & 0x03) !== 0) fail('R2_V2_DESCRIPTOR_INVALID');
  } else if (expectedPadding === 2) {
    const finalValue = BASE64_ALPHABET.indexOf(value[dataLength - 1] ?? '');
    if ((finalValue & 0x0f) !== 0) fail('R2_V2_DESCRIPTOR_INVALID');
  }

  const decoded = new Uint8Array(expectedBytes);
  let output = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(value[index] ?? '');
    const b = BASE64_ALPHABET.indexOf(value[index + 1] ?? '');
    const c = value[index + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[index + 2] ?? '');
    const d = value[index + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[index + 3] ?? '');
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    if (output < expectedBytes) decoded[output++] = (packed >>> 16) & 0xff;
    if (output < expectedBytes) decoded[output++] = (packed >>> 8) & 0xff;
    if (output < expectedBytes) decoded[output++] = packed & 0xff;
  }
  if (output !== expectedBytes || encodeBase64(decoded) !== value) {
    fail('R2_V2_DESCRIPTOR_INVALID');
  }
  return decoded;
}

function expectedRecordCount(plaintextSize: number): number {
  return plaintextSize === 0 ? 0 : Math.ceil(plaintextSize / RECORD_PLAINTEXT_BYTES);
}

function validateDescriptorNumbers(
  plaintextSize: unknown,
  recordSize: unknown,
  recordCount: unknown,
): asserts plaintextSize is number {
  if (
    typeof plaintextSize !== 'number' ||
    !Number.isSafeInteger(plaintextSize) ||
    Object.is(plaintextSize, -0) ||
    plaintextSize < 0 ||
    recordSize !== RECORD_PLAINTEXT_BYTES ||
    typeof recordCount !== 'number' ||
    !Number.isSafeInteger(recordCount) ||
    Object.is(recordCount, -0) ||
    recordCount < 0 ||
    recordCount > UINT32_MAX ||
    recordCount !== expectedRecordCount(plaintextSize)
  ) {
    fail('R2_V2_DESCRIPTOR_INVALID');
  }
  const tagBytes = recordCount * AES_GCM_TAG_BYTES;
  if (!Number.isSafeInteger(tagBytes) || !Number.isSafeInteger(plaintextSize + tagBytes)) {
    fail('R2_V2_DESCRIPTOR_INVALID');
  }
}

function snapshotExactDescriptor(
  input: unknown,
  expectedKeys: readonly string[],
  branded: WeakSet<object>,
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null) fail('R2_V2_DESCRIPTOR_INVALID');
  if (branded.has(input)) return input as unknown as Record<string, unknown>;
  if (descriptorSnapshotActive) {
    descriptorSnapshotReentered = true;
    fail('R2_V2_DESCRIPTOR_REENTRANT');
  }

  descriptorSnapshotActive = true;
  descriptorSnapshotReentered = false;
  try {
    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(input) as object | null;
      descriptors = Object.getOwnPropertyDescriptors(input);
    } catch (cause) {
      fail('R2_V2_DESCRIPTOR_INVALID', cause);
    }
    if (descriptorSnapshotReentered) fail('R2_V2_DESCRIPTOR_REENTRANT');
    if (prototype !== Object.prototype && prototype !== null) fail('R2_V2_DESCRIPTOR_INVALID');

    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    ) {
      fail('R2_V2_DESCRIPTOR_INVALID');
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('R2_V2_DESCRIPTOR_INVALID');
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } finally {
    descriptorSnapshotActive = false;
    descriptorSnapshotReentered = false;
  }
}

function freezeMetadata(fields: {
  objectId: string;
  plaintextSize: number;
  recordCount: number;
  noncePrefixB64: string;
}): R2RecordCryptoV2Metadata {
  const metadata = Object.create(null) as R2RecordCryptoV2Metadata;
  Object.defineProperties(metadata, {
    formatVersion: { value: FORMAT_VERSION, enumerable: true },
    objectId: { value: fields.objectId, enumerable: true },
    plaintextSize: { value: fields.plaintextSize, enumerable: true },
    recordSize: { value: RECORD_PLAINTEXT_BYTES, enumerable: true },
    recordCount: { value: fields.recordCount, enumerable: true },
    noncePrefixB64: { value: fields.noncePrefixB64, enumerable: true },
  });
  Object.freeze(metadata);
  canonicalMetadata.add(metadata);
  return metadata;
}

function canonicalizeMetadata(input: unknown): R2RecordCryptoV2Metadata {
  if (typeof input === 'object' && input !== null && canonicalMetadata.has(input)) {
    return input as R2RecordCryptoV2Metadata;
  }
  const snapshot = snapshotExactDescriptor(input, METADATA_KEYS, canonicalMetadata);
  if (
    snapshot.formatVersion !== FORMAT_VERSION ||
    typeof snapshot.objectId !== 'string' ||
    !OBJECT_ID_RE.test(snapshot.objectId) ||
    typeof snapshot.noncePrefixB64 !== 'string'
  ) {
    fail('R2_V2_DESCRIPTOR_INVALID');
  }
  validateDescriptorNumbers(snapshot.plaintextSize, snapshot.recordSize, snapshot.recordCount);
  const nonce = decodeStrictBase64(snapshot.noncePrefixB64, NONCE_PREFIX_BYTES);
  nonce.fill(0);
  return freezeMetadata({
    objectId: snapshot.objectId,
    plaintextSize: snapshot.plaintextSize,
    recordCount: snapshot.recordCount as number,
    noncePrefixB64: snapshot.noncePrefixB64,
  });
}

function freezeSecretDescriptor(
  metadata: R2RecordCryptoV2Metadata,
  keyB64: string,
): R2RecordCryptoV2SecretDescriptor {
  const secret = Object.create(null) as R2RecordCryptoV2SecretDescriptor;
  Object.defineProperties(secret, {
    formatVersion: { value: metadata.formatVersion, enumerable: true },
    objectId: { value: metadata.objectId, enumerable: true },
    plaintextSize: { value: metadata.plaintextSize, enumerable: true },
    recordSize: { value: metadata.recordSize, enumerable: true },
    recordCount: { value: metadata.recordCount, enumerable: true },
    noncePrefixB64: { value: metadata.noncePrefixB64, enumerable: true },
    keyB64: { value: keyB64, enumerable: true },
  });
  Object.freeze(secret);
  canonicalSecrets.add(secret);
  return secret;
}

function canonicalizeSecretDescriptor(input: unknown): R2RecordCryptoV2SecretDescriptor {
  if (typeof input === 'object' && input !== null && canonicalSecrets.has(input)) {
    return input as R2RecordCryptoV2SecretDescriptor;
  }
  const snapshot = snapshotExactDescriptor(input, SECRET_DESCRIPTOR_KEYS, canonicalSecrets);
  if (typeof snapshot.keyB64 !== 'string') fail('R2_V2_DESCRIPTOR_INVALID');
  const metadata = canonicalizeMetadata({
    formatVersion: snapshot.formatVersion,
    objectId: snapshot.objectId,
    plaintextSize: snapshot.plaintextSize,
    recordSize: snapshot.recordSize,
    recordCount: snapshot.recordCount,
    noncePrefixB64: snapshot.noncePrefixB64,
  });
  const key = decodeStrictBase64(snapshot.keyB64, AES_KEY_BYTES);
  key.fill(0);
  return freezeSecretDescriptor(metadata, snapshot.keyB64);
}

function validateCreateInputs(objectId: unknown, plaintextSize: unknown): number {
  if (
    typeof objectId !== 'string' ||
    !OBJECT_ID_RE.test(objectId) ||
    typeof plaintextSize !== 'number' ||
    !Number.isSafeInteger(plaintextSize) ||
    Object.is(plaintextSize, -0) ||
    plaintextSize < 0
  ) {
    fail('R2_V2_DESCRIPTOR_INVALID');
  }
  const recordCount = expectedRecordCount(plaintextSize);
  validateDescriptorNumbers(plaintextSize, RECORD_PLAINTEXT_BYTES, recordCount);
  return recordCount;
}

function createMetadata(
  objectId: string,
  plaintextSize: number,
  noncePrefixB64: string,
): R2RecordCryptoV2Metadata {
  const recordCount = validateCreateInputs(objectId, plaintextSize);
  return canonicalizeMetadata({
    formatVersion: FORMAT_VERSION,
    objectId,
    plaintextSize,
    recordSize: RECORD_PLAINTEXT_BYTES,
    recordCount,
    noncePrefixB64,
  });
}

function recordLayout(metadataInput: unknown, recordIndex: number): R2RecordCryptoV2Layout {
  const metadata = canonicalizeMetadata(metadataInput);
  if (
    !Number.isSafeInteger(recordIndex) ||
    Object.is(recordIndex, -0) ||
    recordIndex < 0 ||
    recordIndex > UINT32_MAX ||
    recordIndex >= metadata.recordCount
  ) {
    fail('R2_V2_RECORD_INDEX_INVALID');
  }

  const plaintextOffset = recordIndex * RECORD_PLAINTEXT_BYTES;
  const ciphertextOffset = recordIndex * (RECORD_PLAINTEXT_BYTES + AES_GCM_TAG_BYTES);
  const plaintextLength =
    recordIndex === metadata.recordCount - 1
      ? metadata.plaintextSize - plaintextOffset
      : RECORD_PLAINTEXT_BYTES;
  const ciphertextLength = plaintextLength + AES_GCM_TAG_BYTES;
  if (
    !Number.isSafeInteger(plaintextOffset) ||
    !Number.isSafeInteger(ciphertextOffset) ||
    !Number.isSafeInteger(plaintextLength) ||
    !Number.isSafeInteger(ciphertextLength) ||
    plaintextLength <= 0 ||
    plaintextLength > RECORD_PLAINTEXT_BYTES ||
    plaintextOffset + plaintextLength > metadata.plaintextSize ||
    ciphertextOffset + ciphertextLength >
      metadata.plaintextSize + metadata.recordCount * AES_GCM_TAG_BYTES
  ) {
    fail('R2_V2_RECORD_SIZE_OVERFLOW');
  }

  return Object.freeze(
    Object.assign(Object.create(null) as R2RecordCryptoV2Layout, {
      recordIndex,
      plaintextOffset,
      plaintextLength,
      ciphertextOffset,
      ciphertextLength,
    }),
  );
}

function nativeArrayBufferLength(value: unknown): number {
  if (!arrayBufferByteLengthGetter || typeof value !== 'object' || value === null) {
    fail('R2_V2_RECORD_BYTES_INVALID');
  }
  try {
    return Reflect.apply(arrayBufferByteLengthGetter, value, []) as number;
  } catch (cause) {
    fail('R2_V2_RECORD_BYTES_INVALID', cause);
  }
}

/** Uses only native brand getters. No `instanceof`, prototype walk, or property read can hit a Proxy trap. */
function toRecordView(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'object' || value === null) fail('R2_V2_RECORD_BYTES_INVALID');

  if (arrayBufferByteLengthGetter) {
    try {
      const byteLength = Reflect.apply(arrayBufferByteLengthGetter, value, []) as number;
      return new Uint8Array(value as ArrayBuffer, 0, byteLength);
    } catch {
      // A genuine Uint8Array is checked through %TypedArray% native slots below.
    }
  }

  if (
    !typedArrayBufferGetter ||
    !typedArrayByteOffsetGetter ||
    !typedArrayByteLengthGetter ||
    !typedArrayTagGetter
  ) {
    fail('R2_V2_RECORD_BYTES_INVALID');
  }
  try {
    const tag = Reflect.apply(typedArrayTagGetter, value, []) as string | undefined;
    if (tag !== 'Uint8Array') fail('R2_V2_RECORD_BYTES_INVALID');
    const buffer = Reflect.apply(typedArrayBufferGetter, value, []) as unknown;
    const byteOffset = Reflect.apply(typedArrayByteOffsetGetter, value, []) as number;
    const byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
    nativeArrayBufferLength(buffer);
    return new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength);
  } catch (cause) {
    fail('R2_V2_RECORD_BYTES_INVALID', cause);
  }
}

function buildIv(
  noncePrefix: Uint8Array<ArrayBuffer>,
  recordIndex: number,
): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(IV_BYTES);
  iv.set(noncePrefix, 0);
  new DataView(iv.buffer).setUint32(NONCE_PREFIX_BYTES, recordIndex, false);
  return iv;
}

function buildAdditionalData(
  metadata: R2RecordCryptoV2Metadata,
  layout: R2RecordCryptoV2Layout,
): Uint8Array<ArrayBuffer> {
  const objectId = new TextEncoder().encode(metadata.objectId);
  if (objectId.byteLength !== OBJECT_ID_BYTES) fail('R2_V2_DESCRIPTOR_INVALID');

  const aad = new Uint8Array(AAD_BYTES);
  aad.set(AAD_DOMAIN, 0);
  let offset = AAD_DOMAIN.byteLength;
  const view = new DataView(aad.buffer);
  view.setUint32(offset, metadata.formatVersion, false);
  offset += 4;
  aad.set(objectId, offset);
  offset += OBJECT_ID_BYTES;
  view.setBigUint64(offset, BigInt(metadata.plaintextSize), false);
  offset += 8;
  view.setUint32(offset, metadata.recordSize, false);
  offset += 4;
  view.setUint32(offset, metadata.recordCount, false);
  offset += 4;
  view.setUint32(offset, layout.recordIndex, false);
  offset += 4;
  view.setUint32(offset, layout.plaintextLength, false);
  return aad;
}

function invalidateLeaseState(state: CiphertextLeaseState | null): void {
  if (!state) return;
  state.active = false;
  state.blob = null;
  state.acknowledge = null;
}

class R2RecordCiphertextLeaseV2 {
  readonly recordIndex: number;
  readonly ciphertextLength: number;
  readonly #state: CiphertextLeaseState;

  constructor(recordIndex: number, ciphertextLength: number, state: CiphertextLeaseState) {
    this.recordIndex = recordIndex;
    this.ciphertextLength = ciphertextLength;
    this.#state = state;
    Object.freeze(this);
  }

  bytesForUpload(): Blob {
    if (!this.#state.active || !this.#state.blob) fail('R2_V2_RECORD_LEASE_RELEASED');
    return this.#state.blob;
  }

  acknowledgeUploaded(): void {
    if (!this.#state.active || !this.#state.acknowledge) {
      fail('R2_V2_RECORD_LEASE_RELEASED');
    }
    this.#state.acknowledge();
  }
}

class R2RecordEncryptorV2 {
  readonly metadata: R2RecordCryptoV2Metadata;

  #key: CryptoKey | null;
  #noncePrefix: Uint8Array<ArrayBuffer> | null;
  #pendingRawKey: Uint8Array<ArrayBuffer> | null;
  #subtle: SubtleCrypto;
  #state: EncryptorState = 'active';
  #operationActive = false;
  #secretTaken = false;
  #nextRecordIndex = 0;
  #leaseState: CiphertextLeaseState | null = null;

  constructor(
    constructionToken: object,
    metadata: R2RecordCryptoV2Metadata,
    key: CryptoKey,
    noncePrefix: Uint8Array<ArrayBuffer>,
    pendingRawKey: Uint8Array<ArrayBuffer> | null,
    subtle: SubtleCrypto,
  ) {
    if (constructionToken !== ENCRYPTOR_CONSTRUCTION_TOKEN) {
      fail('R2_V2_INTERNAL_CONSTRUCTION_FORBIDDEN');
    }
    this.metadata = metadata;
    this.#key = key;
    this.#noncePrefix = noncePrefix;
    this.#pendingRawKey = pendingRawKey;
    this.#subtle = subtle;
    Object.freeze(this);
  }

  toJSON(): R2RecordCryptoV2Metadata {
    return this.metadata;
  }

  /** One-shot protected descriptor export. The caller owns and must retire the returned key string. */
  takeSecretDescriptor(): R2RecordCryptoV2SecretDescriptor {
    this.#assertActive();
    if (this.#secretTaken || !this.#pendingRawKey) fail('R2_V2_SECRET_ALREADY_TAKEN');
    const rawKey = this.#pendingRawKey;
    try {
      const secret = freezeSecretDescriptor(this.metadata, encodeBase64(rawKey));
      this.#secretTaken = true;
      if (this.metadata.recordCount === 0) this.#complete();
      return secret;
    } catch (cause) {
      this.#poison();
      fail('R2_V2_SECRET_EXPORT_FAILED', cause);
    } finally {
      rawKey.fill(0);
      this.#pendingRawKey = null;
    }
  }

  async encryptRecord(
    recordIndex: number,
    plaintext: RecordBytes,
    signal?: AbortSignal,
  ): Promise<R2RecordCiphertextLeaseV2> {
    this.#assertActive();
    if (this.#operationActive) fail('R2_V2_RECORD_OPERATION_IN_PROGRESS');
    if (this.#leaseState) fail('R2_V2_RECORD_LEASE_PENDING');
    if (!this.#secretTaken) fail('R2_V2_SECRET_NOT_TAKEN');
    if (recordIndex !== this.#nextRecordIndex) fail('R2_V2_RECORD_SEQUENCE_INVALID');

    this.#operationActive = true;
    try {
      // Every error through this point is preflight-only and leaves the same
      // index retryable under the same key.
      throwIfAborted(signal);
      const layout = recordLayout(this.metadata, recordIndex);
      const plainView = toRecordView(plaintext);
      if (plainView.byteLength !== layout.plaintextLength) {
        fail('R2_V2_PLAINTEXT_LENGTH_INVALID');
      }
      const key = this.#key;
      const noncePrefix = this.#noncePrefix;
      if (!key || !noncePrefix) fail('R2_V2_ENCRYPTOR_POISONED');
      const iv = buildIv(noncePrefix, recordIndex);
      const additionalData = buildAdditionalData(this.metadata, layout);
      throwIfAborted(signal);

      let encrypted: ArrayBuffer;
      try {
        // From this exact point the nonce has entered SubtleCrypto. Any
        // ambiguous outcome permanently poisons this encryptor.
        encrypted = await this.#subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData, tagLength: AES_GCM_TAG_BITS },
          key,
          plainView,
        );
      } catch (cause) {
        const aborted = signalIsAborted(signal);
        const disposed = this.#state === 'disposed';
        this.#poison();
        if (aborted) fail('R2_V2_ABORTED');
        if (disposed) fail('R2_V2_ENCRYPTOR_DISPOSED');
        fail('R2_V2_RECORD_ENCRYPT_FAILED', cause);
      }

      if (this.#state === 'disposed') fail('R2_V2_ENCRYPTOR_DISPOSED');
      if (signalIsAborted(signal)) {
        this.#poison();
        fail('R2_V2_ABORTED');
      }

      let blob: Blob;
      try {
        if (nativeArrayBufferLength(encrypted) !== layout.ciphertextLength) {
          fail('R2_V2_CIPHERTEXT_LENGTH_INVALID');
        }
        blob = new NativeBlob([encrypted], { type: 'application/octet-stream' });
        const blobSize = blobSizeGetter
          ? (Reflect.apply(blobSizeGetter, blob, []) as number)
          : Number.NaN;
        if (blobSize !== layout.ciphertextLength) fail('R2_V2_CIPHERTEXT_LENGTH_INVALID');
        Object.freeze(blob);
      } catch (cause) {
        this.#poison();
        fail('R2_V2_CIPHERTEXT_LENGTH_INVALID', cause);
      }

      try {
        const leaseState: CiphertextLeaseState = { active: true, blob, acknowledge: null };
        leaseState.acknowledge = () => this.#acknowledgeLease(leaseState);
        this.#leaseState = leaseState;
        return new R2RecordCiphertextLeaseV2(recordIndex, layout.ciphertextLength, leaseState);
      } catch (cause) {
        this.#poison();
        fail('R2_V2_RECORD_LEASE_FAILED', cause);
      }
    } finally {
      this.#operationActive = false;
    }
  }

  dispose(): void {
    if (this.#state === 'disposed') return;
    this.#state = 'disposed';
    this.#discardSecretsAndLease();
  }

  #assertActive(): void {
    if (this.#state === 'disposed') fail('R2_V2_ENCRYPTOR_DISPOSED');
    if (this.#state === 'poisoned') fail('R2_V2_ENCRYPTOR_POISONED');
    if (this.#state === 'complete') fail('R2_V2_ENCRYPTION_COMPLETE');
  }

  #acknowledgeLease(leaseState: CiphertextLeaseState): void {
    this.#assertActive();
    if (this.#operationActive || this.#leaseState !== leaseState || !leaseState.active) {
      fail('R2_V2_RECORD_LEASE_RELEASED');
    }
    invalidateLeaseState(leaseState);
    this.#leaseState = null;
    this.#nextRecordIndex += 1;
    if (this.#nextRecordIndex === this.metadata.recordCount) this.#complete();
  }

  #complete(): void {
    this.#state = 'complete';
    this.#discardSecretsAndLease();
  }

  #poison(): void {
    if (this.#state !== 'disposed') this.#state = 'poisoned';
    this.#discardSecretsAndLease();
  }

  #discardSecretsAndLease(): void {
    this.#key = null;
    this.#noncePrefix?.fill(0);
    this.#noncePrefix = null;
    this.#pendingRawKey?.fill(0);
    this.#pendingRawKey = null;
    invalidateLeaseState(this.#leaseState);
    this.#leaseState = null;
  }
}

class R2RecordDecryptorV2 {
  readonly metadata: R2RecordCryptoV2Metadata;

  #key: CryptoKey | null;
  #noncePrefix: Uint8Array<ArrayBuffer> | null;
  #subtle: SubtleCrypto;
  #operationActive = false;
  #disposed = false;

  constructor(
    constructionToken: object,
    metadata: R2RecordCryptoV2Metadata,
    key: CryptoKey,
    noncePrefix: Uint8Array<ArrayBuffer>,
    subtle: SubtleCrypto,
  ) {
    if (constructionToken !== DECRYPTOR_CONSTRUCTION_TOKEN) {
      fail('R2_V2_INTERNAL_CONSTRUCTION_FORBIDDEN');
    }
    this.metadata = metadata;
    this.#key = key;
    this.#noncePrefix = noncePrefix;
    this.#subtle = subtle;
    Object.freeze(this);
  }

  toJSON(): R2RecordCryptoV2Metadata {
    return this.metadata;
  }

  async decryptRecord(
    recordIndex: number,
    ciphertext: RecordBytes,
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#disposed) fail('R2_V2_DECRYPTOR_DISPOSED');
    if (this.#operationActive) fail('R2_V2_RECORD_OPERATION_IN_PROGRESS');
    this.#operationActive = true;
    try {
      throwIfAborted(signal);
      const layout = recordLayout(this.metadata, recordIndex);
      const encryptedView = toRecordView(ciphertext);
      if (encryptedView.byteLength !== layout.ciphertextLength) {
        fail('R2_V2_CIPHERTEXT_LENGTH_INVALID');
      }
      const key = this.#key;
      const noncePrefix = this.#noncePrefix;
      if (!key || !noncePrefix) fail('R2_V2_DECRYPTOR_DISPOSED');
      const iv = buildIv(noncePrefix, recordIndex);
      const additionalData = buildAdditionalData(this.metadata, layout);
      throwIfAborted(signal);

      let decrypted: ArrayBuffer;
      try {
        decrypted = await this.#subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData, tagLength: AES_GCM_TAG_BITS },
          key,
          encryptedView,
        );
      } catch (cause) {
        if (signalIsAborted(signal)) fail('R2_V2_ABORTED');
        fail('R2_V2_RECORD_AUTH_FAILED', cause);
      }
      if (this.#disposed) fail('R2_V2_DECRYPTOR_DISPOSED');
      throwIfAborted(signal);
      if (nativeArrayBufferLength(decrypted) !== layout.plaintextLength) {
        fail('R2_V2_PLAINTEXT_LENGTH_INVALID');
      }
      return new Uint8Array(decrypted);
    } finally {
      this.#operationActive = false;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#key = null;
    this.#noncePrefix?.fill(0);
    this.#noncePrefix = null;
  }
}

async function importAesKey(
  rawKey: Uint8Array<ArrayBuffer>,
  usage: KeyUsage,
  signal?: AbortSignal,
): Promise<{ readonly key: CryptoKey; readonly subtle: SubtleCrypto }> {
  throwIfAborted(signal);
  const subtle = globalThis.crypto.subtle;
  let key: CryptoKey;
  try {
    key = await subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, [usage]);
  } catch (cause) {
    throwIfAborted(signal);
    fail('R2_V2_KEY_IMPORT_FAILED', cause);
  }
  throwIfAborted(signal);
  return { key, subtle };
}

/** Namespace-style public surface; V1, network, and Worker code intentionally do not import it yet. */
export class R2RecordCryptoV2 {
  static readonly FORMAT_VERSION = FORMAT_VERSION;
  static readonly RECORD_PLAINTEXT_BYTES = RECORD_PLAINTEXT_BYTES;
  static readonly AES_GCM_TAG_BYTES = AES_GCM_TAG_BYTES;
  static readonly AES_KEY_BYTES = AES_KEY_BYTES;
  static readonly NONCE_PREFIX_BYTES = NONCE_PREFIX_BYTES;

  static canonicalizeMetadata(input: unknown): R2RecordCryptoV2Metadata {
    return canonicalizeMetadata(input);
  }

  static canonicalizeSecretDescriptor(input: unknown): R2RecordCryptoV2SecretDescriptor {
    return canonicalizeSecretDescriptor(input);
  }

  static getCiphertextSize(metadataInput: unknown): number {
    const metadata = canonicalizeMetadata(metadataInput);
    const size = metadata.plaintextSize + metadata.recordCount * AES_GCM_TAG_BYTES;
    if (!Number.isSafeInteger(size)) fail('R2_V2_RECORD_SIZE_OVERFLOW');
    return size;
  }

  static getRecordLayout(metadataInput: unknown, recordIndex: number): R2RecordCryptoV2Layout {
    return recordLayout(metadataInput, recordIndex);
  }

  static async createEncryptor(
    objectId: string,
    plaintextSize: number,
    signal?: AbortSignal,
  ): Promise<R2RecordEncryptorV2> {
    throwIfAborted(signal);
    validateCreateInputs(objectId, plaintextSize);
    const noncePrefix = new Uint8Array(NONCE_PREFIX_BYTES);
    const rawKey = new Uint8Array(AES_KEY_BYTES);
    let transferred = false;
    try {
      globalThis.crypto.getRandomValues(noncePrefix);
      throwIfAborted(signal);
      globalThis.crypto.getRandomValues(rawKey);
      throwIfAborted(signal);
      const metadata = createMetadata(objectId, plaintextSize, encodeBase64(noncePrefix));
      const imported = await importAesKey(rawKey, 'encrypt', signal);
      throwIfAborted(signal);
      const encryptor = new R2RecordEncryptorV2(
        ENCRYPTOR_CONSTRUCTION_TOKEN,
        metadata,
        imported.key,
        noncePrefix,
        rawKey,
        imported.subtle,
      );
      transferred = true;
      return encryptor;
    } finally {
      if (!transferred) {
        noncePrefix.fill(0);
        rawKey.fill(0);
      }
    }
  }

  static async createDecryptor(
    secretInput: unknown,
    signal?: AbortSignal,
  ): Promise<R2RecordDecryptorV2> {
    throwIfAborted(signal);
    const secret = canonicalizeSecretDescriptor(secretInput);
    const metadata = canonicalizeMetadata({
      formatVersion: secret.formatVersion,
      objectId: secret.objectId,
      plaintextSize: secret.plaintextSize,
      recordSize: secret.recordSize,
      recordCount: secret.recordCount,
      noncePrefixB64: secret.noncePrefixB64,
    });
    const rawKey = decodeStrictBase64(secret.keyB64, AES_KEY_BYTES);
    const noncePrefix = decodeStrictBase64(secret.noncePrefixB64, NONCE_PREFIX_BYTES);
    let transferred = false;
    try {
      const imported = await importAesKey(rawKey, 'decrypt', signal);
      throwIfAborted(signal);
      const decryptor = new R2RecordDecryptorV2(
        DECRYPTOR_CONSTRUCTION_TOKEN,
        metadata,
        imported.key,
        noncePrefix,
        imported.subtle,
      );
      transferred = true;
      return decryptor;
    } finally {
      rawKey.fill(0);
      if (!transferred) noncePrefix.fill(0);
    }
  }
}
