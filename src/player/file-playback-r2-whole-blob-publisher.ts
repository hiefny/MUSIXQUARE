import * as playerState from './_state.ts';
import {
  isAudioDecodeAdmissionError,
  reserveRemoteTransportMemoryWithinBudget,
  resolveDecodeMemoryBudget,
  waitForInFlightMemoryReservationChange,
  type RemoteTransportMemoryReservation,
} from './decode-admission.ts';
import { encryptR2WholeBlobV2 } from '../share/crypto.ts';
import {
  completeR2RecordUpload,
  createR2RecordSet,
  deleteR2RecordSet,
  deleteR2WholeBlobObject,
  requestR2RecordUploadAuthority,
  uploadR2RecordCiphertext,
  uploadR2WholeBlobObject,
  type ProgressHandler,
  type R2RecordSetUploadSession,
  type R2WholeBlobDeleteResult,
} from '../share/r2-client.ts';
import { R2RecordCryptoV2 } from '../share/r2-record-crypto-v2.ts';
import type { QueueItemId } from '../types/index.ts';
import { delay } from '../core/timers.ts';
import { isQueueItemId } from './queue-model.ts';

const SOURCE_KEYS = Object.freeze([
  'blob',
  'mime',
  'name',
  'queueItemId',
  'sourceIdentity',
  'transferSessionId',
] as const);
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_FILE_NAME_LENGTH = 512;
const MAX_MIME_LENGTH = 128;
const MIME_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;

type DecodeMemoryBudget = ReturnType<typeof resolveDecodeMemoryBudget>;

export interface FilePlaybackR2WholeBlobPublishSource {
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly blob: Blob;
  readonly name: string;
  readonly mime: string;
}

/** Body-free R2 object authority. The cleanup token remains publisher-private. */
interface FilePlaybackR2WholeBlobPublication {
  readonly schemaVersion: 1;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly storageRoomId: string;
  readonly objectId: string;
  readonly encodedSize: number;
  readonly encryptedSize: number;
  readonly keyB64: string;
  readonly ivB64: string;
  readonly name: string;
  readonly mime: string;
  readonly expiresAtEpochMs: number;
}

interface FilePlaybackR2RecordPublicationRecord {
  readonly index: number;
  readonly objectId: string;
  readonly plaintextSize: number;
  readonly encryptedSize: number;
}

export interface FilePlaybackR2RecordPublication {
  readonly schemaVersion: 1;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly applicationSessionId: string;
  readonly storageRoomId: string;
  readonly setId: string;
  readonly encodedSize: number;
  readonly recordSize: number;
  readonly recordCount: number;
  readonly cryptoSecretDescriptor: ReturnType<typeof R2RecordCryptoV2.canonicalizeSecretDescriptor>;
  readonly records: readonly Readonly<FilePlaybackR2RecordPublicationRecord>[];
  readonly name: string;
  readonly mime: string;
  readonly expiresAtEpochMs: number;
}

export interface FilePlaybackR2WholeBlobPublisherRuntime {
  readonly createStorageRoomId: () => string;
  readonly encrypt: typeof encryptR2WholeBlobV2;
  readonly upload: typeof uploadR2WholeBlobObject;
  readonly deleteObject: typeof deleteR2WholeBlobObject;
  readonly createRecordSet: typeof createR2RecordSet;
  readonly requestRecordUpload: typeof requestR2RecordUploadAuthority;
  readonly uploadRecord: typeof uploadR2RecordCiphertext;
  readonly completeRecord: typeof completeR2RecordUpload;
  readonly deleteRecordSet: typeof deleteR2RecordSet;
  readonly reserveTransport: (
    encodedBytes: number,
    options: {
      readonly budget: DecodeMemoryBudget;
      readonly fileName: string;
      readonly retainedPcmBytes: number;
    },
  ) => RemoteTransportMemoryReservation;
  readonly resolveMemoryBudget: () => DecodeMemoryBudget;
  readonly livePcmBytes: () => number;
  readonly waitForMemoryReservationChange: (signal: AbortSignal) => Promise<boolean>;
}

interface FilePlaybackR2WholeBlobPublisherOptions {
  readonly roomToken: object;
  readonly runtime?: Partial<FilePlaybackR2WholeBlobPublisherRuntime>;
}

interface CanonicalSource extends Omit<FilePlaybackR2WholeBlobPublishSource, 'blob'> {
  readonly blob: Blob;
}

interface PublicationRecord {
  readonly source: CanonicalSource;
  readonly publication: Readonly<FilePlaybackR2WholeBlobPublication>;
  readonly cleanupToken: string;
}

interface InFlightRecord {
  readonly source: CanonicalSource;
  readonly controller: AbortController;
  readonly promise: Promise<Readonly<FilePlaybackR2WholeBlobPublication>>;
}

interface RecordPublicationRecord {
  readonly source: CanonicalSource;
  readonly applicationSessionId: string;
  readonly storageRoomId: string;
  readonly publication: Readonly<FilePlaybackR2RecordPublication>;
  readonly session: Readonly<R2RecordSetUploadSession>;
}

interface RecordInFlightRecord {
  readonly source: CanonicalSource;
  readonly applicationSessionId: string;
  readonly storageRoomId: string;
  readonly controller: AbortController;
  readonly ready: Promise<Readonly<FilePlaybackR2RecordPublication>>;
  readonly complete: Promise<void>;
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set(expectedKeys);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
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
  } catch {
    return null;
  }
}

function isIdentifier(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value !== value.trim()
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

function canonicalSource(value: unknown): CanonicalSource | null {
  const source = snapshotExactRecord(value, SOURCE_KEYS);
  if (
    !source ||
    !isQueueItemId(source.queueItemId) ||
    !isIdentifier(source.sourceIdentity) ||
    !isIdentifier(source.transferSessionId) ||
    !(source.blob instanceof Blob) ||
    !Number.isSafeInteger(source.blob.size) ||
    source.blob.size <= 0 ||
    typeof source.name !== 'string' ||
    source.name.length === 0 ||
    source.name.length > MAX_FILE_NAME_LENGTH ||
    typeof source.mime !== 'string' ||
    source.mime.length > MAX_MIME_LENGTH ||
    !MIME_PATTERN.test(source.mime)
  ) {
    return null;
  }
  return freezeCanonical({
    queueItemId: source.queueItemId,
    sourceIdentity: source.sourceIdentity,
    transferSessionId: source.transferSessionId,
    blob: source.blob,
    name: source.name,
    mime: source.mime,
  });
}

function sameSource(left: CanonicalSource, right: CanonicalSource): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.sourceIdentity === right.sourceIdentity &&
    left.transferSessionId === right.transferSessionId &&
    left.blob === right.blob &&
    left.blob.size === right.blob.size &&
    left.name === right.name &&
    left.mime === right.mime
  );
}

function isTransientRecordUploadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('_NETWORK') ||
      error.message.includes('_STALLED') ||
      error.message.endsWith('_HTTP_404') ||
      error.message.endsWith('_HTTP_409') ||
      error.message.endsWith('_HTTP_503'))
  );
}

function waitForRecordRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
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
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void delay(delayMs).then(finish);
  });
}

function defaultStorageRoomId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid !== 'string') throw new Error('REMOTE_SHARE_V2_STORAGE_ROOM_ID_UNAVAILABLE');
  return uuid;
}

const defaultRuntime: Readonly<FilePlaybackR2WholeBlobPublisherRuntime> = Object.freeze({
  createStorageRoomId: defaultStorageRoomId,
  encrypt: encryptR2WholeBlobV2,
  upload: uploadR2WholeBlobObject,
  deleteObject: deleteR2WholeBlobObject,
  createRecordSet: createR2RecordSet,
  requestRecordUpload: requestR2RecordUploadAuthority,
  uploadRecord: uploadR2RecordCiphertext,
  completeRecord: completeR2RecordUpload,
  deleteRecordSet: deleteR2RecordSet,
  reserveTransport: reserveRemoteTransportMemoryWithinBudget,
  resolveMemoryBudget: resolveDecodeMemoryBudget,
  livePcmBytes: () => playerState.liveAudioBufferPcmBytes(),
  waitForMemoryReservationChange: (signal: AbortSignal) =>
    waitForInFlightMemoryReservationChange(signal),
});

function runtimeSnapshot(
  value: Partial<FilePlaybackR2WholeBlobPublisherRuntime> | undefined,
): Readonly<FilePlaybackR2WholeBlobPublisherRuntime> {
  const runtime = { ...defaultRuntime, ...value };
  if (
    typeof runtime.createStorageRoomId !== 'function' ||
    typeof runtime.encrypt !== 'function' ||
    typeof runtime.upload !== 'function' ||
    typeof runtime.deleteObject !== 'function' ||
    typeof runtime.createRecordSet !== 'function' ||
    typeof runtime.requestRecordUpload !== 'function' ||
    typeof runtime.uploadRecord !== 'function' ||
    typeof runtime.completeRecord !== 'function' ||
    typeof runtime.deleteRecordSet !== 'function' ||
    typeof runtime.reserveTransport !== 'function' ||
    typeof runtime.resolveMemoryBudget !== 'function' ||
    typeof runtime.livePcmBytes !== 'function' ||
    typeof runtime.waitForMemoryReservationChange !== 'function'
  ) {
    throw new TypeError('File playback R2 whole-Blob publisher runtime is invalid');
  }
  return Object.freeze(runtime);
}

/** Room-scoped, upload-once publisher shared by every guest connection. */
export class FilePlaybackR2WholeBlobPublisher {
  readonly #runtime: Readonly<FilePlaybackR2WholeBlobPublisherRuntime>;
  readonly #storageRoomId: string;
  readonly #inFlight = new Map<QueueItemId, InFlightRecord>();
  readonly #publications = new Map<QueueItemId, PublicationRecord>();
  readonly #recordInFlight = new Map<QueueItemId, RecordInFlightRecord>();
  readonly #recordPublications = new Map<QueueItemId, RecordPublicationRecord>();
  readonly #removedQueueItems = new Set<QueueItemId>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: FilePlaybackR2WholeBlobPublisherOptions) {
    if (!options || typeof options !== 'object' || !options.roomToken) {
      throw new TypeError('File playback R2 whole-Blob publisher options are invalid');
    }
    if (typeof options.roomToken !== 'object') {
      throw new TypeError('File playback R2 whole-Blob publisher requires a room token');
    }
    this.#runtime = runtimeSnapshot(options.runtime);
    this.#storageRoomId = this.#runtime.createStorageRoomId();
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(this.#storageRoomId)) {
      throw new Error('REMOTE_SHARE_V2_STORAGE_ROOM_ID_INVALID');
    }
  }

  publish(
    value: Readonly<FilePlaybackR2WholeBlobPublishSource>,
    onProgress?: ProgressHandler,
  ): Promise<Readonly<FilePlaybackR2WholeBlobPublication>> {
    if (this.#closed) return Promise.reject(new Error('FILE_PLAYBACK_R2_PUBLISHER_CLOSED'));
    if (onProgress !== undefined && typeof onProgress !== 'function') {
      return Promise.reject(new TypeError('File playback R2 upload progress callback is invalid'));
    }
    const source = canonicalSource(value);
    if (!source) {
      return Promise.reject(new TypeError('File playback R2 publish source is invalid'));
    }
    if (this.#removedQueueItems.has(source.queueItemId)) {
      return Promise.reject(new Error('FILE_PLAYBACK_R2_PUBLISH_SOURCE_RETIRED'));
    }
    const published = this.#publications.get(source.queueItemId);
    if (published) {
      return sameSource(published.source, source)
        ? Promise.resolve(published.publication)
        : Promise.reject(new Error('FILE_PLAYBACK_R2_PUBLISH_SOURCE_CONFLICT'));
    }
    const pending = this.#inFlight.get(source.queueItemId);
    if (pending) {
      return sameSource(pending.source, source)
        ? pending.promise
        : Promise.reject(new Error('FILE_PLAYBACK_R2_PUBLISH_SOURCE_CONFLICT'));
    }

    const controller = new AbortController();
    const promise = this.#publishPhysical(source, controller.signal, onProgress).finally(() => {
      if (this.#inFlight.get(source.queueItemId)?.controller === controller) {
        this.#inFlight.delete(source.queueItemId);
      }
    });
    this.#inFlight.set(source.queueItemId, { source, controller, promise });
    return promise;
  }

  current(queueItemId: QueueItemId): Readonly<FilePlaybackR2WholeBlobPublication> | null {
    return this.#publications.get(queueItemId)?.publication ?? null;
  }

  /**
   * Publish one independently encrypted record set shared by every eligible
   * guest connection in this exact room/application/source incarnation.
   * The returned promise becomes ready after record 0 is durably completed;
   * remaining records continue in the room-owned background task.
   */
  publishRecordSet(
    value: Readonly<FilePlaybackR2WholeBlobPublishSource>,
    options: {
      readonly storageRoomId: string;
      readonly applicationSessionId: string;
    },
  ): Promise<Readonly<FilePlaybackR2RecordPublication>> {
    if (this.#closed) return Promise.reject(new Error('FILE_PLAYBACK_R2_PUBLISHER_CLOSED'));
    const source = canonicalSource(value);
    if (
      !source ||
      !options ||
      typeof options !== 'object' ||
      !/^[1-9]\d{5}$/u.test(options.storageRoomId) ||
      !isIdentifier(options.applicationSessionId)
    ) {
      return Promise.reject(new TypeError('File playback R2 record publish source is invalid'));
    }
    if (this.#removedQueueItems.has(source.queueItemId)) {
      return Promise.reject(new Error('FILE_PLAYBACK_R2_PUBLISH_SOURCE_RETIRED'));
    }
    const published = this.#recordPublications.get(source.queueItemId);
    if (published) {
      return sameSource(published.source, source) &&
        published.storageRoomId === options.storageRoomId &&
        published.applicationSessionId === options.applicationSessionId
        ? Promise.resolve(published.publication)
        : Promise.reject(new Error('FILE_PLAYBACK_R2_RECORD_PUBLISH_SOURCE_CONFLICT'));
    }
    const pending = this.#recordInFlight.get(source.queueItemId);
    if (pending) {
      return sameSource(pending.source, source) &&
        pending.storageRoomId === options.storageRoomId &&
        pending.applicationSessionId === options.applicationSessionId
        ? pending.ready
        : Promise.reject(new Error('FILE_PLAYBACK_R2_RECORD_PUBLISH_SOURCE_CONFLICT'));
    }

    const controller = new AbortController();
    let resolveReady!: (value: Readonly<FilePlaybackR2RecordPublication>) => void;
    let rejectReady!: (error: unknown) => void;
    let readySettled = false;
    const ready = new Promise<Readonly<FilePlaybackR2RecordPublication>>((resolve, reject) => {
      resolveReady = (publication) => {
        if (readySettled) return;
        readySettled = true;
        resolve(publication);
      };
      rejectReady = (error) => {
        if (readySettled) return;
        readySettled = true;
        reject(error);
      };
    });
    const complete = this.#publishRecordSetPhysical(
      source,
      options.storageRoomId,
      options.applicationSessionId,
      controller.signal,
      resolveReady,
    )
      .catch((error) => {
        rejectReady(error);
        throw error;
      })
      .finally(() => {
        if (this.#recordInFlight.get(source.queueItemId)?.controller === controller) {
          this.#recordInFlight.delete(source.queueItemId);
        }
      });
    const record: RecordInFlightRecord = {
      source,
      storageRoomId: options.storageRoomId,
      applicationSessionId: options.applicationSessionId,
      controller,
      ready,
      complete,
    };
    this.#recordInFlight.set(source.queueItemId, record);
    void complete.catch(() => undefined);
    return ready;
  }

  currentRecordSet(queueItemId: QueueItemId): Readonly<FilePlaybackR2RecordPublication> | null {
    return this.#recordPublications.get(queueItemId)?.publication ?? null;
  }

  async removeQueueItem(queueItemId: QueueItemId): Promise<boolean> {
    if (!isQueueItemId(queueItemId)) {
      throw new TypeError('File playback R2 queue item ID is invalid');
    }
    this.#removedQueueItems.add(queueItemId);
    const pending = this.#inFlight.get(queueItemId);
    if (pending) pending.controller.abort(new Error('FILE_PLAYBACK_R2_PUBLISH_SOURCE_RETIRED'));
    const pendingRecord = this.#recordInFlight.get(queueItemId);
    if (pendingRecord) {
      pendingRecord.controller.abort(new Error('FILE_PLAYBACK_R2_PUBLISH_SOURCE_RETIRED'));
    }
    const pendingTasks: Promise<unknown>[] = [];
    if (pending) pendingTasks.push(pending.promise);
    if (pendingRecord) pendingTasks.push(pendingRecord.complete);
    await Promise.allSettled(pendingTasks);
    const publication = this.#publications.get(queueItemId);
    const recordPublication = this.#recordPublications.get(queueItemId);
    this.#publications.delete(queueItemId);
    this.#recordPublications.delete(queueItemId);
    await Promise.allSettled([
      ...(publication ? [this.#delete(publication)] : []),
      ...(recordPublication ? [this.#deleteRecordPublication(recordPublication)] : []),
    ]);
    return !!(pending || pendingRecord || publication || recordPublication);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const pending = [...this.#inFlight.values()];
    for (const record of pending) {
      record.controller.abort(new Error('FILE_PLAYBACK_R2_PUBLISHER_CLOSED'));
    }
    const publications = [...this.#publications.values()];
    const pendingRecords = [...this.#recordInFlight.values()];
    for (const record of pendingRecords) {
      record.controller.abort(new Error('FILE_PLAYBACK_R2_PUBLISHER_CLOSED'));
    }
    const recordPublications = [...this.#recordPublications.values()];
    this.#publications.clear();
    this.#recordPublications.clear();
    this.#closePromise = (async () => {
      await Promise.allSettled([
        ...pending.map((record) => record.promise),
        ...pendingRecords.map((record) => record.complete),
      ]);
      await Promise.allSettled([
        ...publications.map((record) => this.#delete(record)),
        ...recordPublications.map((record) => this.#deleteRecordPublication(record)),
      ]);
    })();
    return this.#closePromise;
  }

  async #publishPhysical(
    source: CanonicalSource,
    signal: AbortSignal,
    onProgress: ProgressHandler | undefined,
  ): Promise<Readonly<FilePlaybackR2WholeBlobPublication>> {
    const budget = this.#runtime.resolveMemoryBudget();
    let reservation: RemoteTransportMemoryReservation | null = null;
    try {
      for (;;) {
        this.#assertCurrent(source, signal);
        try {
          reservation = this.#runtime.reserveTransport(source.blob.size + 16, {
            budget,
            fileName: source.name,
            retainedPcmBytes: budget.tier === 'ios' ? this.#runtime.livePcmBytes() : 0,
          });
          break;
        } catch (error) {
          if (isAudioDecodeAdmissionError(error) && error.reason === 'transport-working-set') {
            const changed = await this.#runtime.waitForMemoryReservationChange(signal);
            this.#assertCurrent(source, signal);
            if (changed) continue;
          }
          throw error;
        }
      }

      this.#assertCurrent(source, signal);
      const encrypted = await this.#runtime.encrypt(source.blob, signal);
      this.#assertCurrent(source, signal);
      if (
        encrypted.plaintextSize !== source.blob.size ||
        encrypted.encryptedSize !== source.blob.size + 16 ||
        encrypted.encryptedBlob.size !== encrypted.encryptedSize
      ) {
        throw new Error('REMOTE_SHARE_V2_ENCRYPTED_SIZE_MISMATCH');
      }
      const uploaded = await this.#runtime.upload(
        encrypted.encryptedBlob,
        {
          storageRoomId: this.#storageRoomId,
          queueItemId: source.queueItemId,
          name: source.name,
          mime: source.mime,
          plaintextSize: source.blob.size,
        },
        onProgress,
        signal,
      );
      let committed = false;
      try {
        this.#assertCurrent(source, signal);
        const publication = freezeCanonical({
          schemaVersion: 1 as const,
          queueItemId: source.queueItemId,
          sourceIdentity: source.sourceIdentity,
          transferSessionId: source.transferSessionId,
          storageRoomId: this.#storageRoomId,
          objectId: uploaded.objectId,
          encodedSize: encrypted.plaintextSize,
          encryptedSize: encrypted.encryptedSize,
          keyB64: encrypted.keyB64,
          ivB64: encrypted.ivB64,
          name: source.name,
          mime: source.mime,
          expiresAtEpochMs: uploaded.expiresAt,
        });
        const record: PublicationRecord = {
          source,
          publication,
          cleanupToken: uploaded.cleanupToken,
        };
        this.#assertCurrent(source, signal);
        this.#publications.set(source.queueItemId, record);
        committed = true;
        return publication;
      } finally {
        if (!committed) {
          await Promise.resolve(
            this.#runtime.deleteObject(
              this.#storageRoomId,
              uploaded.objectId,
              uploaded.cleanupToken,
            ),
          ).catch(() => undefined);
        }
      }
    } finally {
      reservation?.release();
    }
  }

  async #publishRecordSetPhysical(
    source: CanonicalSource,
    storageRoomId: string,
    applicationSessionId: string,
    signal: AbortSignal,
    resolveReady: (publication: Readonly<FilePlaybackR2RecordPublication>) => void,
  ): Promise<void> {
    this.#assertRecordCurrent(source, storageRoomId, applicationSessionId, signal);
    const recordSize = R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES;
    const recordCount = Math.ceil(source.blob.size / recordSize);
    let session: Readonly<R2RecordSetUploadSession> | null = null;
    let encryptor: Awaited<ReturnType<typeof R2RecordCryptoV2.createEncryptor>> | null = null;
    try {
      const activeSession = await this.#runtime.createRecordSet(
        {
          storageRoomId,
          applicationSessionId,
          queueItemId: source.queueItemId,
          sourceIdentity: source.sourceIdentity,
          name: source.name,
          mime: source.mime,
          plaintextSize: source.blob.size,
          recordSize,
          recordCount,
        },
        signal,
      );
      session = activeSession;
      this.#assertRecordCurrent(source, storageRoomId, applicationSessionId, signal);
      encryptor = await R2RecordCryptoV2.createEncryptor(session.setId, source.blob.size, signal);
      const activeEncryptor = encryptor;
      const secret = activeEncryptor.takeSecretDescriptor();
      if (
        secret.objectId !== session.setId ||
        secret.recordSize !== session.recordSize ||
        secret.recordCount !== session.recordCount ||
        secret.plaintextSize !== source.blob.size
      ) {
        throw new Error('FILE_PLAYBACK_R2_RECORD_CRYPTO_LAYOUT_MISMATCH');
      }
      const records = session.records.map((record, index) => {
        const layout = R2RecordCryptoV2.getRecordLayout(activeEncryptor.metadata, index);
        if (
          record.index !== index ||
          record.plaintextSize !== layout.plaintextLength ||
          record.encryptedSize !== layout.ciphertextLength
        ) {
          throw new Error('FILE_PLAYBACK_R2_RECORD_SERVER_LAYOUT_MISMATCH');
        }
        return freezeCanonical({
          index,
          objectId: record.objectId,
          plaintextSize: record.plaintextSize,
          encryptedSize: record.encryptedSize,
        });
      });
      const publication = freezeCanonical({
        schemaVersion: 1 as const,
        queueItemId: source.queueItemId,
        sourceIdentity: source.sourceIdentity,
        transferSessionId: source.transferSessionId,
        applicationSessionId,
        storageRoomId,
        setId: session.setId,
        encodedSize: source.blob.size,
        recordSize: session.recordSize,
        recordCount: session.recordCount,
        cryptoSecretDescriptor: secret,
        records: Object.freeze(records),
        name: source.name,
        mime: source.mime,
        expiresAtEpochMs: session.expiresAt,
      });

      for (let recordIndex = 0; recordIndex < session.recordCount; recordIndex += 1) {
        this.#assertRecordCurrent(source, storageRoomId, applicationSessionId, signal);
        const layout = R2RecordCryptoV2.getRecordLayout(activeEncryptor.metadata, recordIndex);
        const plaintext = new Uint8Array(
          await source.blob
            .slice(layout.plaintextOffset, layout.plaintextOffset + layout.plaintextLength)
            .arrayBuffer(),
        );
        this.#assertRecordCurrent(source, storageRoomId, applicationSessionId, signal);
        const lease = await activeEncryptor.encryptRecord(recordIndex, plaintext, signal);
        plaintext.fill(0);
        const ciphertext = lease.bytesForUpload();
        let completion: Awaited<
          ReturnType<FilePlaybackR2WholeBlobPublisherRuntime['completeRecord']>
        > | null = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          this.#assertRecordCurrent(source, storageRoomId, applicationSessionId, signal);
          try {
            const authority = await this.#runtime.requestRecordUpload(session, recordIndex, signal);
            await this.#runtime.uploadRecord(authority, ciphertext, undefined, signal);
            for (let completeAttempt = 0; completeAttempt < 4; completeAttempt += 1) {
              try {
                completion = await this.#runtime.completeRecord(session, recordIndex, signal);
                break;
              } catch (error) {
                if (!isTransientRecordUploadError(error) || completeAttempt === 3) throw error;
                await waitForRecordRetry(signal, 100 * (completeAttempt + 1));
              }
            }
            if (completion) break;
          } catch (error) {
            if (!isTransientRecordUploadError(error) || attempt === 2) throw error;
            // The exact immutable lease is deliberately reused. Never invoke
            // encryptRecord again for this index after an ambiguous PUT.
            await waitForRecordRetry(signal, 150 * (attempt + 1));
          }
        }
        if (
          !completion ||
          completion.index !== recordIndex ||
          completion.readyRecordCount < recordIndex + 1
        ) {
          throw new Error('FILE_PLAYBACK_R2_RECORD_COMPLETION_INVALID');
        }
        lease.acknowledgeUploaded();
        if (recordIndex === 0) {
          this.#assertRecordCurrent(source, storageRoomId, applicationSessionId, signal);
          const record: RecordPublicationRecord = {
            source,
            storageRoomId,
            applicationSessionId,
            publication,
            session,
          };
          this.#recordPublications.set(source.queueItemId, record);
          resolveReady(publication);
        }
      }
    } catch (error) {
      const published = this.#recordPublications.get(source.queueItemId);
      if (session && published?.session === session) {
        this.#recordPublications.delete(source.queueItemId);
      }
      if (session) {
        await this.#runtime.deleteRecordSet(session).catch(() => undefined);
      }
      throw error;
    } finally {
      encryptor?.dispose();
    }
  }

  #assertRecordCurrent(
    source: CanonicalSource,
    storageRoomId: string,
    applicationSessionId: string,
    signal: AbortSignal,
  ): void {
    const existing = this.#recordPublications.get(source.queueItemId);
    if (
      this.#closed ||
      signal.aborted ||
      this.#removedQueueItems.has(source.queueItemId) ||
      (existing &&
        (!sameSource(existing.source, source) ||
          existing.storageRoomId !== storageRoomId ||
          existing.applicationSessionId !== applicationSessionId))
    ) {
      throw new Error('FILE_PLAYBACK_R2_RECORD_PUBLISH_SOURCE_STALE');
    }
  }

  async #deleteRecordPublication(record: RecordPublicationRecord): Promise<void> {
    await this.#runtime.deleteRecordSet(record.session);
  }

  #assertCurrent(source: CanonicalSource, signal: AbortSignal): void {
    if (
      this.#closed ||
      signal.aborted ||
      this.#removedQueueItems.has(source.queueItemId) ||
      (this.#publications.has(source.queueItemId) &&
        !sameSource(this.#publications.get(source.queueItemId)!.source, source))
    ) {
      throw new Error('FILE_PLAYBACK_R2_PUBLISH_SOURCE_STALE');
    }
  }

  async #delete(record: PublicationRecord): Promise<R2WholeBlobDeleteResult> {
    return this.#runtime.deleteObject(
      record.publication.storageRoomId,
      record.publication.objectId,
      record.cleanupToken,
    );
  }
}
