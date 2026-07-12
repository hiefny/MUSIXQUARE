/**
 * MUSIXQUARE remote share crypto helpers.
 *
 * Encrypts local files before they leave the host browser. The AES key is
 * delivered over WebRTC, not through object storage.
 *
 * This is a whole-file Web Crypto path. Encryption can temporarily retain the
 * source Blob, its plaintext ArrayBuffer, the ciphertext ArrayBuffer, and the
 * returned Blob's backing bytes at the same time; decryption similarly overlaps
 * the encrypted ArrayBuffer, plaintext ArrayBuffer, and returned File bytes.
 * Browsers decide whether Blob/File backing storage shares or copies those
 * bytes and when unreachable buffers are collected.
 *
 * SubtleCrypto operations are not abortable here. Once file.arrayBuffer() or a
 * crypto operation starts, abandoning its Promise prevents no work and does not
 * guarantee immediate memory release.
 */

import {
  REMOTE_SHARE_AES_GCM_TAG_BYTES,
  REMOTE_SHARE_MAX_BYTES,
  REMOTE_SHARE_MAX_ENCRYPTED_BYTES,
} from '../core/constants.ts';

export interface RemoteEncryptionResult {
  encryptedBlob: Blob;
  keyB64: string;
  ivB64: string;
}

export interface R2WholeBlobEncryptionV2Result extends RemoteEncryptionResult {
  readonly plaintextSize: number;
  readonly encryptedSize: number;
}

export interface R2WholeBlobDecryptionV2Options {
  readonly expectedPlaintextSize: number;
  readonly expectedEncryptedSize: number;
  readonly keyB64: string;
  readonly ivB64: string;
  readonly name: string;
  readonly mime: string;
  readonly signal?: AbortSignal;
}

const AES_ALGO = 'AES-GCM';
const AES_BITS = 256;
const AES_KEY_BYTES = AES_BITS / 8;
const IV_BYTES = 12;
const AES_GCM_TAG_BITS = REMOTE_SHARE_AES_GCM_TAG_BYTES * 8;
const AES_KEY_BASE64_LENGTH = 44;
const IV_BASE64_LENGTH = 16;
const B64_CHUNK = 0x8000;
const MAX_NAME_LENGTH = 512;
const MAX_MIME_LENGTH = 128;
const MIME_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const nativeBlobArrayBuffer = Blob.prototype.arrayBuffer;

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    const chunk = bytes.subarray(i, i + B64_CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function canonicalBase64ToBytes(
  value: unknown,
  expectedEncodedLength: number,
  expectedBytes: number,
  errorCode: string,
): Uint8Array {
  if (typeof value !== 'string' || value.length !== expectedEncodedLength) {
    throw new Error(errorCode);
  }
  try {
    const bytes = base64ToBytes(value);
    if (bytes.byteLength !== expectedBytes || bytesToBase64(bytes) !== value) {
      throw new Error(errorCode);
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode, { cause: error });
  }
}

function assertAbortSignal(signal: AbortSignal | undefined): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('REMOTE_SHARE_V2_SIGNAL_INVALID');
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
}

function assertPlaintextSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0 || size > REMOTE_SHARE_MAX_BYTES) {
    throw new Error('REMOTE_SHARE_V2_PLAINTEXT_SIZE_INVALID');
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function assertDecryptionMetadata(name: unknown, mime: unknown): void {
  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    containsControlCharacter(name) ||
    typeof mime !== 'string' ||
    mime.length > MAX_MIME_LENGTH ||
    !MIME_PATTERN.test(mime)
  ) {
    throw new Error('REMOTE_SHARE_V2_FILE_METADATA_INVALID');
  }
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  );
}

export async function encryptFile(file: Blob): Promise<RemoteEncryptionResult> {
  const key = await crypto.subtle.generateKey({ name: AES_ALGO, length: AES_BITS }, true, [
    'encrypt',
    'decrypt',
  ]);
  const iv = new Uint8Array(new ArrayBuffer(IV_BYTES));
  crypto.getRandomValues(iv);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const plain = await file.arrayBuffer();
  const encrypted = await crypto.subtle.encrypt({ name: AES_ALGO, iv }, key, plain);

  return {
    encryptedBlob: new Blob([encrypted], { type: 'application/octet-stream' }),
    keyB64: bytesToBase64(rawKey),
    ivB64: bytesToBase64(iv),
  };
}

export async function decryptToFile(
  encrypted: ArrayBuffer,
  keyB64: string,
  ivB64: string,
  name: string,
  mime: string,
  lastModified = Date.now(),
): Promise<File> {
  const keyBytes = base64ToBytes(keyB64);
  const iv = base64ToBytes(ivB64);
  const key = await crypto.subtle.importKey(
    'raw',
    copyToArrayBuffer(keyBytes),
    { name: AES_ALGO },
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: AES_ALGO, iv: copyToArrayBuffer(iv) },
    key,
    encrypted,
  );
  return new File([plain], name, { type: mime || 'application/octet-stream', lastModified });
}

/**
 * Strict whole-Blob AES-256-GCM primitive for the temporary V2 R2 transport.
 * Cancellation is an ownership fence: native Blob/WebCrypto work still runs
 * to settlement, and its result is discarded when the signal changed.
 */
export async function encryptR2WholeBlobV2(
  blob: Blob,
  signal?: AbortSignal,
): Promise<Readonly<R2WholeBlobEncryptionV2Result>> {
  if (!(blob instanceof Blob)) throw new TypeError('REMOTE_SHARE_V2_BLOB_INVALID');
  assertAbortSignal(signal);
  assertPlaintextSize(blob.size);
  throwIfAborted(signal);

  const key = await crypto.subtle.generateKey({ name: AES_ALGO, length: AES_BITS }, true, [
    'encrypt',
  ]);
  throwIfAborted(signal);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  throwIfAborted(signal);
  if (rawKey.byteLength !== AES_KEY_BYTES || iv.byteLength !== IV_BYTES) {
    throw new Error('REMOTE_SHARE_V2_CRYPTO_MATERIAL_INVALID');
  }

  const plaintext = await Reflect.apply(nativeBlobArrayBuffer, blob, []);
  throwIfAborted(signal);
  if (!isArrayBuffer(plaintext) || plaintext.byteLength !== blob.size) {
    throw new Error('REMOTE_SHARE_V2_PLAINTEXT_SIZE_MISMATCH');
  }

  const encrypted = await crypto.subtle.encrypt(
    { name: AES_ALGO, iv, tagLength: AES_GCM_TAG_BITS },
    key,
    plaintext,
  );
  throwIfAborted(signal);
  const expectedEncryptedSize = blob.size + REMOTE_SHARE_AES_GCM_TAG_BYTES;
  if (
    !isArrayBuffer(encrypted) ||
    encrypted.byteLength !== expectedEncryptedSize ||
    encrypted.byteLength > REMOTE_SHARE_MAX_ENCRYPTED_BYTES
  ) {
    throw new Error('REMOTE_SHARE_V2_ENCRYPTED_SIZE_MISMATCH');
  }

  const encryptedBlob = new Blob([encrypted], { type: 'application/octet-stream' });
  if (encryptedBlob.size !== expectedEncryptedSize) {
    throw new Error('REMOTE_SHARE_V2_ENCRYPTED_SIZE_MISMATCH');
  }
  return freezeCanonical({
    encryptedBlob,
    plaintextSize: blob.size,
    encryptedSize: expectedEncryptedSize,
    keyB64: bytesToBase64(rawKey),
    ivB64: bytesToBase64(iv),
  });
}

/** Strict V2 counterpart to the legacy decryptToFile positional API. */
export async function decryptR2WholeBlobV2(
  encrypted: ArrayBuffer,
  options: R2WholeBlobDecryptionV2Options,
): Promise<File> {
  if (!isArrayBuffer(encrypted)) {
    throw new TypeError('REMOTE_SHARE_V2_CIPHERTEXT_INVALID');
  }
  if (!options || typeof options !== 'object') {
    throw new TypeError('REMOTE_SHARE_V2_DECRYPT_OPTIONS_INVALID');
  }
  const expectedPlaintextSize = options.expectedPlaintextSize;
  const expectedEncryptedSize = options.expectedEncryptedSize;
  const keyB64 = options.keyB64;
  const ivB64 = options.ivB64;
  const name = options.name;
  const mime = options.mime;
  const signal = options.signal;
  assertAbortSignal(signal);
  assertPlaintextSize(expectedPlaintextSize);
  if (
    !Number.isSafeInteger(expectedEncryptedSize) ||
    expectedEncryptedSize !== expectedPlaintextSize + REMOTE_SHARE_AES_GCM_TAG_BYTES ||
    expectedEncryptedSize > REMOTE_SHARE_MAX_ENCRYPTED_BYTES ||
    encrypted.byteLength !== expectedEncryptedSize
  ) {
    throw new Error('REMOTE_SHARE_V2_ENCRYPTED_SIZE_MISMATCH');
  }
  assertDecryptionMetadata(name, mime);
  const keyBytes = canonicalBase64ToBytes(
    keyB64,
    AES_KEY_BASE64_LENGTH,
    AES_KEY_BYTES,
    'REMOTE_SHARE_V2_KEY_INVALID',
  );
  const iv = canonicalBase64ToBytes(
    ivB64,
    IV_BASE64_LENGTH,
    IV_BYTES,
    'REMOTE_SHARE_V2_IV_INVALID',
  );
  throwIfAborted(signal);

  const key = await crypto.subtle.importKey(
    'raw',
    copyToArrayBuffer(keyBytes),
    { name: AES_ALGO, length: AES_BITS },
    false,
    ['decrypt'],
  );
  throwIfAborted(signal);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: AES_ALGO, iv: copyToArrayBuffer(iv), tagLength: AES_GCM_TAG_BITS },
      key,
      encrypted,
    );
  } catch (error) {
    throwIfAborted(signal);
    throw new Error('REMOTE_SHARE_V2_DECRYPT_FAILED', { cause: error });
  }
  throwIfAborted(signal);
  if (!isArrayBuffer(plaintext) || plaintext.byteLength !== expectedPlaintextSize) {
    throw new Error('REMOTE_SHARE_V2_PLAINTEXT_SIZE_MISMATCH');
  }

  const file = new File([plaintext], name, { type: mime, lastModified: 0 });
  if (file.size !== expectedPlaintextSize || file.lastModified !== 0) {
    throw new Error('REMOTE_SHARE_V2_PLAINTEXT_SIZE_MISMATCH');
  }
  return file;
}
