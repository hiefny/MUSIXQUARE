import { downloadR2RecordObject } from '../../share/r2-client.ts';
import { R2RecordCryptoV2 } from '../../share/r2-record-crypto-v2.ts';
import { delay } from '../../core/timers.ts';
import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from './encoded-audio-source.ts';

export interface R2RecordEncodedAudioSourceRecord {
  readonly index: number;
  readonly objectId: string;
  readonly plaintextSize: number;
  readonly encryptedSize: number;
}

export interface R2RecordEncodedAudioSourceOptions {
  readonly storageRoomId: string;
  readonly setId: string;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata;
  readonly secretDescriptor: unknown;
  readonly records: readonly Readonly<R2RecordEncodedAudioSourceRecord>[];
  readonly expiresAtEpochMs: number;
}

interface CachedRecord {
  readonly index: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

const OBJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STANDARD_ROOM_CODE_RE = /^[1-9]\d{5}$/u;
const MAX_NAME_LENGTH = 512;
const MAX_MIME_LENGTH = 128;
const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const MAX_TRANSIENT_RECORD_WAIT_MS = 60_000;

function abortReason(signal: AbortSignal): unknown {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return error;
  }
  return new DOMException('The R2 record read was aborted', 'AbortError');
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void delay(delayMs).then(finish);
  });
}

function linkAbortSignals(
  caller: AbortSignal,
  lifetime: AbortSignal,
): { readonly signal: AbortSignal; readonly detach: () => void } {
  const controller = new AbortController();
  const forwardCaller = (): void => controller.abort(caller.reason);
  const forwardLifetime = (): void =>
    controller.abort(lifetime.reason ?? new EncodedSourceClosedError());
  caller.addEventListener('abort', forwardCaller, { once: true });
  lifetime.addEventListener('abort', forwardLifetime, { once: true });
  if (caller.aborted) forwardCaller();
  else if (lifetime.aborted) forwardLifetime();
  return {
    signal: controller.signal,
    detach: () => {
      caller.removeEventListener('abort', forwardCaller);
      lifetime.removeEventListener('abort', forwardLifetime);
    },
  };
}

function isTransientUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'REMOTE_SHARE_DOWNLOAD_NETWORK' ||
      error.message === 'REMOTE_SHARE_DOWNLOAD_STALLED' ||
      error.message === 'REMOTE_SHARE_DOWNLOAD_HTTP_404' ||
      error.message === 'REMOTE_SHARE_DOWNLOAD_HTTP_409' ||
      error.message === 'REMOTE_SHARE_DOWNLOAD_HTTP_503')
  );
}

function snapshotOptions(options: R2RecordEncodedAudioSourceOptions): {
  readonly storageRoomId: string;
  readonly setId: string;
  readonly identity: string;
  readonly metadata: Readonly<EncodedAudioSourceMetadata>;
  readonly secretDescriptor: ReturnType<typeof R2RecordCryptoV2.canonicalizeSecretDescriptor>;
  readonly records: readonly Readonly<R2RecordEncodedAudioSourceRecord>[];
  readonly expiresAtEpochMs: number;
} {
  if (
    !options ||
    typeof options !== 'object' ||
    !STANDARD_ROOM_CODE_RE.test(options.storageRoomId) ||
    !OBJECT_ID_RE.test(options.setId) ||
    !isEncodedAudioSourceIdentity(options.identity) ||
    !options.metadata ||
    typeof options.metadata.name !== 'string' ||
    options.metadata.name.length === 0 ||
    options.metadata.name.length > MAX_NAME_LENGTH ||
    typeof options.metadata.mime !== 'string' ||
    options.metadata.mime.length > MAX_MIME_LENGTH ||
    !MIME_RE.test(options.metadata.mime) ||
    !Number.isSafeInteger(options.expiresAtEpochMs) ||
    options.expiresAtEpochMs <= Date.now() ||
    !Array.isArray(options.records)
  ) {
    throw new TypeError('R2 record encoded source options are invalid');
  }
  const secret = R2RecordCryptoV2.canonicalizeSecretDescriptor(options.secretDescriptor);
  const cryptoMetadata = R2RecordCryptoV2.canonicalizeMetadata({
    formatVersion: secret.formatVersion,
    objectId: secret.objectId,
    plaintextSize: secret.plaintextSize,
    recordSize: secret.recordSize,
    recordCount: secret.recordCount,
    noncePrefixB64: secret.noncePrefixB64,
  });
  if (
    secret.objectId !== options.setId ||
    secret.recordSize !== R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES ||
    secret.recordCount !== options.records.length ||
    secret.plaintextSize <= 0
  ) {
    throw new TypeError('R2 record encoded source secret is mismatched');
  }
  const records = options.records.map((record, index) => {
    const layout = R2RecordCryptoV2.getRecordLayout(cryptoMetadata, index);
    if (
      !record ||
      record.index !== index ||
      !OBJECT_ID_RE.test(record.objectId) ||
      record.plaintextSize !== layout.plaintextLength ||
      record.encryptedSize !== layout.ciphertextLength
    ) {
      throw new TypeError('R2 record encoded source layout is invalid');
    }
    return Object.freeze({
      index,
      objectId: record.objectId,
      plaintextSize: record.plaintextSize,
      encryptedSize: record.encryptedSize,
    });
  });
  return Object.freeze({
    storageRoomId: options.storageRoomId,
    setId: options.setId,
    identity: options.identity,
    metadata: Object.freeze({
      name: options.metadata.name,
      mime: options.metadata.mime,
    }),
    secretDescriptor: secret,
    records: Object.freeze(records),
    expiresAtEpochMs: options.expiresAtEpochMs,
  });
}

/**
 * Exact random-access source backed by independently authenticated R2 records.
 *
 * At most one decrypted record is retained. Physical loads are serialized so
 * concurrent decoder probes cannot race the one-operation AES-GCM decryptor;
 * a later same-record read then consumes the shared one-record cache.
 */
export class R2RecordEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'r2-records' as const;
  readonly size: number;
  readonly identity: string;
  readonly metadata: Readonly<EncodedAudioSourceMetadata>;

  readonly #storageRoomId: string;
  readonly #records: readonly Readonly<R2RecordEncodedAudioSourceRecord>[];
  readonly #expiresAtEpochMs: number;
  readonly #decryptor: Awaited<ReturnType<typeof R2RecordCryptoV2.createDecryptor>>;
  readonly #lifetimeController = new AbortController();
  #cache: CachedRecord | null = null;
  #loadTail: Promise<void> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  private constructor(
    options: ReturnType<typeof snapshotOptions>,
    decryptor: Awaited<ReturnType<typeof R2RecordCryptoV2.createDecryptor>>,
  ) {
    this.#storageRoomId = options.storageRoomId;
    this.#records = options.records;
    this.#expiresAtEpochMs = options.expiresAtEpochMs;
    this.#decryptor = decryptor;
    this.size = options.secretDescriptor.plaintextSize;
    this.identity = options.identity;
    this.metadata = options.metadata;
  }

  static async create(
    options: R2RecordEncodedAudioSourceOptions,
    signal?: AbortSignal,
  ): Promise<R2RecordEncodedAudioSource> {
    const snapshot = snapshotOptions(options);
    const decryptor = await R2RecordCryptoV2.createDecryptor(snapshot.secretDescriptor, signal);
    if (signal?.aborted) {
      decryptor.dispose();
      throw abortReason(signal);
    }
    return new R2RecordEncodedAudioSource(snapshot, decryptor);
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.#closed) throw new EncodedSourceClosedError();
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    if (length === 0) return new Uint8Array(0);

    const linked = linkAbortSignals(signal, this.#lifetimeController.signal);
    try {
      const output = new Uint8Array(length);
      let sourceOffset = offset;
      let outputOffset = 0;
      while (sourceOffset < end) {
        throwIfAborted(linked.signal);
        if (this.#closed) throw new EncodedSourceClosedError();
        const recordIndex = Math.floor(sourceOffset / R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES);
        const record = await this.#loadRecord(recordIndex, linked.signal);
        const recordStart = recordIndex * R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES;
        const withinRecord = sourceOffset - recordStart;
        const available = record.byteLength - withinRecord;
        const copyLength = Math.min(available, end - sourceOffset);
        if (copyLength <= 0) {
          throw new EncodedSourceIntegrityError('R2 record read made no forward progress');
        }
        output.set(record.subarray(withinRecord, withinRecord + copyLength), outputOffset);
        sourceOffset += copyLength;
        outputOffset += copyLength;
      }
      throwIfAborted(linked.signal);
      if (this.#closed) throw new EncodedSourceClosedError();
      return output;
    } catch (error) {
      if (this.#closed) throw new EncodedSourceClosedError();
      throw error;
    } finally {
      linked.detach();
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const closePromise = Promise.resolve()
      .then(() => this.#loadTail.catch(() => undefined))
      .then(() => this.#decryptor.dispose());
    this.#closePromise = closePromise;
    this.#closed = true;
    this.#lifetimeController.abort(new EncodedSourceClosedError());
    this.#dropCache();
    return closePromise;
  }

  #loadRecord(recordIndex: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const cached = this.#cache;
    if (cached?.index === recordIndex) return Promise.resolve(cached.bytes);
    const task = this.#loadTail.then(async () => {
      throwIfAborted(signal);
      if (this.#closed) throw new EncodedSourceClosedError();
      if (this.#cache?.index === recordIndex) return;
      const descriptor = this.#records[recordIndex];
      if (!descriptor) throw new EncodedSourceIntegrityError('R2 record index is unavailable');

      let attempt = 0;
      let encrypted: ArrayBuffer;
      const unavailableSinceEpochMs = Date.now();
      for (;;) {
        throwIfAborted(signal);
        if (this.#closed) throw new EncodedSourceClosedError();
        if (Date.now() >= this.#expiresAtEpochMs) {
          throw new EncodedSourceIntegrityError('R2 record set expired before the requested read');
        }
        try {
          encrypted = await downloadR2RecordObject(
            this.#storageRoomId,
            descriptor.objectId,
            descriptor.encryptedSize,
            signal,
          );
          break;
        } catch (error) {
          throwIfAborted(signal);
          if (!isTransientUnavailable(error)) throw error;
          if (Date.now() - unavailableSinceEpochMs >= MAX_TRANSIENT_RECORD_WAIT_MS) {
            throw new EncodedSourceIntegrityError(
              'R2 record remained unavailable past its bounded wait',
            );
          }
          const retryMs = Math.min(1_000, 100 * 2 ** Math.min(attempt, 4));
          attempt += 1;
          await waitForRetry(retryMs, signal);
        }
      }
      if (encrypted.byteLength !== descriptor.encryptedSize) {
        throw new EncodedSourceIntegrityError('R2 record ciphertext size is invalid');
      }
      let plaintext: Uint8Array<ArrayBuffer>;
      try {
        plaintext = await this.#decryptor.decryptRecord(recordIndex, encrypted, signal);
      } catch {
        throwIfAborted(signal);
        if (this.#closed) throw new EncodedSourceClosedError();
        throw new EncodedSourceIntegrityError('R2 record authentication failed');
      }
      throwIfAborted(signal);
      if (this.#closed) {
        plaintext.fill(0);
        throw new EncodedSourceClosedError();
      }
      if (plaintext.byteLength !== descriptor.plaintextSize) {
        plaintext.fill(0);
        throw new EncodedSourceIntegrityError('R2 record plaintext size is invalid');
      }
      this.#dropCache();
      this.#cache = { index: recordIndex, bytes: plaintext };
    });
    this.#loadTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task.then(() => {
      const loaded = this.#cache;
      if (!loaded || loaded.index !== recordIndex) {
        throw new EncodedSourceIntegrityError('R2 record cache lost its exact read');
      }
      return loaded.bytes;
    });
  }

  #dropCache(): void {
    this.#cache?.bytes.fill(0);
    this.#cache = null;
  }
}
