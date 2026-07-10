/**
 * End-to-end encryption helpers for remote file sharing.
 *
 * Large files are never materialized as a second File. The host reads one
 * plaintext chunk from the user-selected File, encrypts it, uploads that
 * ciphertext as one R2 multipart part, and then releases both buffers. The
 * same independently authenticated records also make exact range playback
 * possible without persistent browser storage.
 */

import { REMOTE_SHARE_CRYPTO_CHUNK_BYTES, REMOTE_SHARE_GCM_TAG_BYTES } from '../core/constants.ts';

export interface ChunkEncryptionPlan {
  readonly keyB64: string;
  readonly ivB64: string;
  readonly cryptoVersion: 2;
  readonly plainSize: number;
  readonly encryptedSize: number;
  readonly chunkSize: number;
  readonly chunkCount: number;
  readonly tagBytes: number;
}

interface InternalChunkEncryptionPlan extends ChunkEncryptionPlan {
  readonly key: CryptoKey;
  readonly noncePrefix: Uint8Array;
}

interface ChunkedDecryptionInput {
  body: ReadableStream<Uint8Array>;
  keyB64: string;
  noncePrefixB64: string;
  plainSize: number;
  encryptedSize: number;
  chunkSize: number;
  chunkCount: number;
  tagBytes?: number;
  name: string;
  mime: string;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

const AES_ALGO = 'AES-GCM';
const AES_BITS = 256;
const IV_BYTES = 12;
const CHUNK_NONCE_PREFIX_BYTES = 8;
const CHUNK_TAG_BYTES = REMOTE_SHARE_GCM_TAG_BYTES;
const MAX_CHUNK_COUNT = 10_000;
const B64_CHUNK = 0x8000;
const CHUNK_AAD_MAGIC = 0x4d585132; // "MXQ2"

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function generateEncryptionKey(): Promise<{ key: CryptoKey; rawKey: Uint8Array }> {
  const key = await crypto.subtle.generateKey({ name: AES_ALGO, length: AES_BITS }, true, [
    'encrypt',
    'decrypt',
  ]);
  return {
    key,
    rawKey: new Uint8Array(await crypto.subtle.exportKey('raw', key)),
  };
}

function chunkIv(prefix: Uint8Array, index: number): Uint8Array {
  if (
    prefix.byteLength !== CHUNK_NONCE_PREFIX_BYTES ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > 0xffff_ffff
  ) {
    throw new Error('REMOTE_SHARE_CRYPTO_METADATA_INVALID');
  }
  const iv = new Uint8Array(IV_BYTES);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(CHUNK_NONCE_PREFIX_BYTES, index, false);
  return iv;
}

function chunkAdditionalData(
  plainSize: number,
  chunkSize: number,
  chunkCount: number,
  index: number,
): Uint8Array {
  const aad = new Uint8Array(28);
  const view = new DataView(aad.buffer);
  view.setUint32(0, CHUNK_AAD_MAGIC, false);
  view.setUint32(4, 2, false);
  view.setUint32(8, Math.floor(plainSize / 0x1_0000_0000), false);
  view.setUint32(12, plainSize >>> 0, false);
  view.setUint32(16, chunkSize, false);
  view.setUint32(20, chunkCount, false);
  view.setUint32(24, index, false);
  return aad;
}

export function validateChunkMetadata(
  plainSize: number,
  encryptedSize: number,
  chunkSize: number,
  chunkCount: number,
  tagBytes: number,
): void {
  if (
    !Number.isSafeInteger(plainSize) ||
    plainSize <= 0 ||
    !Number.isSafeInteger(encryptedSize) ||
    encryptedSize <= plainSize ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < 64 * 1024 ||
    chunkSize > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount > MAX_CHUNK_COUNT ||
    tagBytes !== CHUNK_TAG_BYTES ||
    chunkCount !== Math.ceil(plainSize / chunkSize) ||
    encryptedSize !== plainSize + chunkCount * tagBytes
  ) {
    throw new Error('REMOTE_SHARE_CRYPTO_METADATA_INVALID');
  }
}

export async function createChunkEncryptionPlan(file: Blob): Promise<ChunkEncryptionPlan> {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error('REMOTE_SHARE_CRYPTO_METADATA_INVALID');
  }
  const chunkSize = REMOTE_SHARE_CRYPTO_CHUNK_BYTES;
  const chunkCount = Math.ceil(file.size / chunkSize);
  const encryptedSize = file.size + chunkCount * CHUNK_TAG_BYTES;
  validateChunkMetadata(file.size, encryptedSize, chunkSize, chunkCount, CHUNK_TAG_BYTES);

  const { key, rawKey } = await generateEncryptionKey();
  const noncePrefix = new Uint8Array(CHUNK_NONCE_PREFIX_BYTES);
  crypto.getRandomValues(noncePrefix);

  const plan: InternalChunkEncryptionPlan = {
    key,
    noncePrefix,
    keyB64: bytesToBase64(rawKey),
    ivB64: bytesToBase64(noncePrefix),
    cryptoVersion: 2,
    plainSize: file.size,
    encryptedSize,
    chunkSize,
    chunkCount,
    tagBytes: CHUNK_TAG_BYTES,
  };
  return plan;
}

function asInternalPlan(plan: ChunkEncryptionPlan): InternalChunkEncryptionPlan {
  const internal = plan as InternalChunkEncryptionPlan;
  if (!internal.key || !internal.noncePrefix) {
    throw new Error('REMOTE_SHARE_CRYPTO_PLAN_INVALID');
  }
  validateChunkMetadata(
    internal.plainSize,
    internal.encryptedSize,
    internal.chunkSize,
    internal.chunkCount,
    internal.tagBytes,
  );
  return internal;
}

/** Encrypt exactly one independently authenticated record. */
export async function encryptFileChunk(
  file: Blob,
  plan: ChunkEncryptionPlan,
  index: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const internal = asInternalPlan(plan);
  if (
    file.size !== plan.plainSize ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= plan.chunkCount
  ) {
    throw new Error('REMOTE_SHARE_CRYPTO_PLAN_INVALID');
  }
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');

  const start = index * plan.chunkSize;
  const end = Math.min(file.size, start + plan.chunkSize);
  const plain = await file.slice(start, end).arrayBuffer();
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
  const cipher = await crypto.subtle.encrypt(
    {
      name: AES_ALGO,
      iv: copyToArrayBuffer(chunkIv(internal.noncePrefix, index)),
      additionalData: copyToArrayBuffer(
        chunkAdditionalData(plan.plainSize, plan.chunkSize, plan.chunkCount, index),
      ),
      tagLength: plan.tagBytes * 8,
    },
    internal.key,
    plain,
  );
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
  return cipher;
}

async function decryptCipherChunk(
  cipher: ArrayBuffer | Uint8Array,
  options: {
    keyB64: string;
    noncePrefixB64: string;
    plainSize: number;
    encryptedSize: number;
    chunkSize: number;
    chunkCount: number;
    tagBytes?: number;
    index: number;
  },
): Promise<ArrayBuffer> {
  const tagBytes = options.tagBytes ?? CHUNK_TAG_BYTES;
  validateChunkMetadata(
    options.plainSize,
    options.encryptedSize,
    options.chunkSize,
    options.chunkCount,
    tagBytes,
  );
  if (
    !Number.isSafeInteger(options.index) ||
    options.index < 0 ||
    options.index >= options.chunkCount
  ) {
    throw new Error('REMOTE_SHARE_CRYPTO_METADATA_INVALID');
  }
  const keyBytes = base64ToBytes(options.keyB64);
  const noncePrefix = base64ToBytes(options.noncePrefixB64);
  if (keyBytes.byteLength !== AES_BITS / 8 || noncePrefix.byteLength !== CHUNK_NONCE_PREFIX_BYTES) {
    throw new Error('REMOTE_SHARE_CRYPTO_METADATA_INVALID');
  }
  const expectedPlainBytes = Math.min(
    options.chunkSize,
    options.plainSize - options.index * options.chunkSize,
  );
  const cipherBytes = cipher instanceof Uint8Array ? cipher : new Uint8Array(cipher);
  if (cipherBytes.byteLength !== expectedPlainBytes + tagBytes) {
    throw new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    copyToArrayBuffer(keyBytes),
    { name: AES_ALGO },
    false,
    ['decrypt'],
  );
  return crypto.subtle.decrypt(
    {
      name: AES_ALGO,
      iv: copyToArrayBuffer(chunkIv(noncePrefix, options.index)),
      additionalData: copyToArrayBuffer(
        chunkAdditionalData(
          options.plainSize,
          options.chunkSize,
          options.chunkCount,
          options.index,
        ),
      ),
      tagLength: tagBytes * 8,
    },
    key,
    copyToArrayBuffer(cipherBytes),
  );
}

export const decryptCipherChunkForTests = decryptCipherChunk;

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
  if (keyBytes.byteLength !== AES_BITS / 8 || iv.byteLength !== IV_BYTES) {
    throw new Error('REMOTE_SHARE_CRYPTO_METADATA_INVALID');
  }
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

class ExactStreamReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private remainder = new Uint8Array(0);
  private ended = false;
  receivedBytes = 0;

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async readExact(size: number, signal?: AbortSignal): Promise<Uint8Array> {
    const output = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
      if (this.remainder.byteLength > 0) {
        const take = Math.min(size - offset, this.remainder.byteLength);
        output.set(this.remainder.subarray(0, take), offset);
        offset += take;
        this.remainder = this.remainder.subarray(take);
        continue;
      }
      const { done, value } = await this.reader.read();
      if (done) {
        this.ended = true;
        throw new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
      }
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      this.receivedBytes += bytes.byteLength;
      this.remainder = new Uint8Array(bytes);
    }
    return output;
  }

  async assertDone(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
    if (this.remainder.byteLength > 0) throw new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
    if (!this.ended) {
      const { done, value } = await this.reader.read();
      if (!done || (value?.byteLength ?? 0) > 0) {
        throw new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
      }
      this.ended = true;
    }
  }

  async cancel(reason?: unknown): Promise<void> {
    await this.reader.cancel(reason).catch(() => undefined);
  }

  release(): void {
    try {
      this.reader.releaseLock();
    } catch {
      // The reader can already be detached after cancellation.
    }
  }
}

/**
 * Small-file compatibility path. Callers must enforce a conservative size
 * ceiling before using it; large files use the service-worker range source.
 */
export async function decryptChunkedStreamToMemory({
  body,
  keyB64,
  noncePrefixB64,
  plainSize,
  encryptedSize,
  chunkSize,
  chunkCount,
  tagBytes = CHUNK_TAG_BYTES,
  name,
  mime,
  signal,
  onProgress,
}: ChunkedDecryptionInput): Promise<File> {
  validateChunkMetadata(plainSize, encryptedSize, chunkSize, chunkCount, tagBytes);
  const stream = new ExactStreamReader(body);
  const parts: ArrayBuffer[] = [];
  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const plainBytes = Math.min(chunkSize, plainSize - index * chunkSize);
      const cipher = await stream.readExact(plainBytes + tagBytes, signal);
      parts.push(
        await decryptCipherChunk(cipher, {
          keyB64,
          noncePrefixB64,
          plainSize,
          encryptedSize,
          chunkSize,
          chunkCount,
          tagBytes,
          index,
        }),
      );
      onProgress?.(Math.min(1, stream.receivedBytes / encryptedSize));
    }
    await stream.assertDone(signal);
    onProgress?.(1);
    return new File(parts, name, { type: mime || 'application/octet-stream' });
  } catch (error) {
    await stream.cancel(error);
    throw error;
  } finally {
    stream.release();
  }
}
