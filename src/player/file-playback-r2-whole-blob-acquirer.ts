import { liveAudioBufferPcmBytes } from './_state.ts';
import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetBinding,
  type FilePlaybackAssetLease,
  type FilePlaybackAssetSnapshot,
} from './file-playback-asset-registry.ts';
import type { FilePlaybackConnectionMediaOperation } from './file-playback-connection-media-session.ts';
import {
  parseFileMediaSourceOfferV2,
  type R2WholeBlobFileMediaSourceOfferV2,
} from './file-media-source-offer.ts';
import {
  parseFilePlaybackRunBindingV2,
  type FilePlaybackRunBindingV2,
} from './file-playback-run-binding.ts';
import {
  isAudioDecodeAdmissionError,
  reserveRemoteTransportMemoryWithinBudget,
  resolveDecodeMemoryBudget,
  waitForInFlightMemoryReservationChange,
  type EncodedReceiveMemoryReservation,
  type RemoteTransportMemoryReservation,
} from './decode-admission.ts';
import { decryptR2WholeBlobV2, type R2WholeBlobDecryptionV2Options } from '../share/crypto.ts';
import { downloadR2WholeBlobObject, type ProgressHandler } from '../share/r2-client.ts';
import type { QueueItemId } from '../types/index.ts';
import { isQueueItemId } from './queue-model.ts';

const OPERATION_KEYS = Object.freeze(['binding', 'fence', 'kind', 'offer'] as const);
const FENCE_KEYS = Object.freeze(['epoch', 'isCurrent', 'signal'] as const);

type DecodeMemoryBudget = ReturnType<typeof resolveDecodeMemoryBudget>;
type DownloadWholeBlob = typeof downloadR2WholeBlobObject;
type DecryptWholeBlob = typeof decryptR2WholeBlobV2;

export interface FilePlaybackR2WholeBlobAcquirerRuntime {
  readonly download: DownloadWholeBlob;
  readonly decrypt: DecryptWholeBlob;
  readonly reserveTransport: (
    encryptedBytes: number,
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

export interface FilePlaybackR2WholeBlobAcquirerOptions {
  readonly roomToken: object;
  readonly registry: FilePlaybackAssetRegistry;
  readonly onFatalRoom?: (
    roomToken: object,
    error: FilePlaybackR2WholeBlobAcquirerFatalError,
  ) => void;
  readonly runtime?: Partial<FilePlaybackR2WholeBlobAcquirerRuntime>;
}

/** Body-free proof that one exact room Blob asset is ready for source staging. */
export interface FilePlaybackR2WholeBlobAcquisition {
  readonly assetLease: FilePlaybackAssetLease;
  readonly asset: Readonly<FilePlaybackAssetSnapshot>;
}

interface CanonicalOperation {
  readonly operation: Readonly<FilePlaybackConnectionMediaOperation>;
  readonly offer: Readonly<R2WholeBlobFileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  readonly fence: {
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
  };
}

interface InFlightRecord {
  readonly canonical: CanonicalOperation;
  readonly controller: AbortController;
  readonly promise: Promise<Readonly<FilePlaybackR2WholeBlobAcquisition>>;
}

interface OwnedAssetRecord {
  readonly binding: Readonly<FilePlaybackAssetBinding>;
  readonly result: Readonly<FilePlaybackR2WholeBlobAcquisition>;
  readonly reservation: EncodedReceiveMemoryReservation;
  released: boolean;
}

const defaultRuntime: Readonly<FilePlaybackR2WholeBlobAcquirerRuntime> = Object.freeze({
  download: downloadR2WholeBlobObject,
  decrypt: decryptR2WholeBlobV2,
  reserveTransport: reserveRemoteTransportMemoryWithinBudget,
  resolveMemoryBudget: resolveDecodeMemoryBudget,
  livePcmBytes: liveAudioBufferPcmBytes,
  waitForMemoryReservationChange: (signal: AbortSignal) =>
    waitForInFlightMemoryReservationChange(signal),
});

const registryLeaseForBinding = FilePlaybackAssetRegistry.prototype.leaseForBinding;
const registrySnapshotForLease = FilePlaybackAssetRegistry.prototype.snapshotForLease;
const registryAdmitBlob = FilePlaybackAssetRegistry.prototype.admitBlob;
const registryRetire = FilePlaybackAssetRegistry.prototype.retire;
const registryClose = FilePlaybackAssetRegistry.prototype.close;
const registryIsClosed = FilePlaybackAssetRegistry.prototype.isClosed;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
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
  } catch {
    return null;
  }
}

function sameBinding(
  left: Readonly<FilePlaybackAssetBinding>,
  right: Readonly<FilePlaybackAssetBinding>,
): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.sourceIdentity === right.sourceIdentity &&
    left.transferSessionId === right.transferSessionId
  );
}

function offerMatchesBinding(
  offer: Readonly<R2WholeBlobFileMediaSourceOfferV2>,
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

function assetBinding(
  binding: Readonly<FilePlaybackRunBindingV2>,
): Readonly<FilePlaybackAssetBinding> {
  return freezeCanonical({
    queueItemId: binding.queueItemId,
    sourceIdentity: binding.sourceIdentity,
    transferSessionId: binding.transferSessionId,
  });
}

function snapshotOperation(value: unknown): CanonicalOperation | null {
  const operation = snapshotExactDataRecord(value, OPERATION_KEYS);
  if (!operation || (operation.kind !== 'baseline' && operation.kind !== 'successor')) return null;
  const offer = parseFileMediaSourceOfferV2(operation.offer);
  const binding = parseFilePlaybackRunBindingV2(operation.binding);
  const fence = snapshotExactDataRecord(operation.fence, FENCE_KEYS);
  if (
    !offer ||
    offer.transport !== 'r2-whole-blob' ||
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
    offer,
    binding,
    fence: {
      signal: fence.signal,
      isCurrent: fence.isCurrent as () => boolean,
    },
  };
}

function runtimeSnapshot(
  runtime: Partial<FilePlaybackR2WholeBlobAcquirerRuntime> | undefined,
): Readonly<FilePlaybackR2WholeBlobAcquirerRuntime> {
  const selected = { ...defaultRuntime, ...runtime };
  if (
    typeof selected.download !== 'function' ||
    typeof selected.decrypt !== 'function' ||
    typeof selected.reserveTransport !== 'function' ||
    typeof selected.resolveMemoryBudget !== 'function' ||
    typeof selected.livePcmBytes !== 'function' ||
    typeof selected.waitForMemoryReservationChange !== 'function'
  ) {
    throw new TypeError('File playback R2 whole-Blob runtime is invalid');
  }
  return Object.freeze(selected);
}

function isTransientDownloadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'REMOTE_SHARE_DOWNLOAD_NETWORK' ||
      error.message === 'REMOTE_SHARE_DOWNLOAD_STALLED')
  );
}

function isExpectedAssetSnapshot(
  snapshot: Readonly<FilePlaybackAssetSnapshot> | null,
  binding: Readonly<FilePlaybackAssetBinding>,
  offer: Readonly<R2WholeBlobFileMediaSourceOfferV2>,
): snapshot is Readonly<FilePlaybackAssetSnapshot> {
  return (
    snapshot !== null &&
    sameBinding(snapshot, binding) &&
    snapshot.kind === 'blob' &&
    snapshot.size === offer.encodedSize &&
    snapshot.name === offer.name &&
    snapshot.mime === offer.mime
  );
}

function sameAssetSnapshot(
  left: Readonly<FilePlaybackAssetSnapshot>,
  right: Readonly<FilePlaybackAssetSnapshot>,
): boolean {
  return (
    sameBinding(left, right) &&
    left.kind === right.kind &&
    left.size === right.size &&
    left.name === right.name &&
    left.mime === right.mime
  );
}

function releaseOwnedReservation(record: OwnedAssetRecord): void {
  if (record.released) return;
  record.released = true;
  record.reservation.release();
}

export class FilePlaybackR2WholeBlobAcquirerFatalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FilePlaybackR2WholeBlobAcquirerFatalError';
  }
}

/**
 * Room-local owner of temporary whole-Blob R2 receives.
 *
 * Operation fences own only acquisition work. Once the final synchronous
 * handoff succeeds, the Blob and its one-copy reservation belong to the room
 * queue asset until explicit queue retirement or room close.
 */
export class FilePlaybackR2WholeBlobAcquirer {
  readonly #roomToken: object;
  readonly #registry: FilePlaybackAssetRegistry;
  readonly #runtime: Readonly<FilePlaybackR2WholeBlobAcquirerRuntime>;
  readonly #onFatalRoom: NonNullable<FilePlaybackR2WholeBlobAcquirerOptions['onFatalRoom']>;
  readonly #inFlightByOperation = new WeakMap<
    Readonly<FilePlaybackConnectionMediaOperation>,
    InFlightRecord
  >();
  readonly #inFlight = new Set<InFlightRecord>();
  readonly #assets = new Map<QueueItemId, OwnedAssetRecord>();
  readonly #removedQueueItems = new Set<QueueItemId>();
  readonly #retirements = new Map<QueueItemId, Promise<boolean>>();
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #fatalError: FilePlaybackR2WholeBlobAcquirerFatalError | null = null;

  constructor(options: FilePlaybackR2WholeBlobAcquirerOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('File playback R2 whole-Blob acquirer options are invalid');
    }
    if (!options.roomToken || typeof options.roomToken !== 'object') {
      throw new TypeError('File playback R2 whole-Blob acquirer requires a room token');
    }
    if (!(options.registry instanceof FilePlaybackAssetRegistry)) {
      throw new TypeError('File playback R2 whole-Blob acquirer requires an asset registry');
    }
    if (options.onFatalRoom !== undefined && typeof options.onFatalRoom !== 'function') {
      throw new TypeError('File playback R2 whole-Blob fatal callback is invalid');
    }
    this.#roomToken = options.roomToken;
    this.#registry = options.registry;
    this.#runtime = runtimeSnapshot(options.runtime);
    this.#onFatalRoom = options.onFatalRoom ?? (() => undefined);
  }

  isClosed(): boolean {
    return this.#closed;
  }

  activeAssetCount(): number {
    return this.#assets.size;
  }

  acquire(
    operation: Readonly<FilePlaybackConnectionMediaOperation>,
    onProgress?: ProgressHandler,
  ): Promise<Readonly<FilePlaybackR2WholeBlobAcquisition>> {
    if (this.#closed || Reflect.apply(registryIsClosed, this.#registry, [])) {
      return Promise.reject(
        this.#fatalError ?? new Error('FILE_PLAYBACK_R2_WHOLE_BLOB_ACQUIRER_CLOSED'),
      );
    }
    if (onProgress !== undefined && typeof onProgress !== 'function') {
      return Promise.reject(new TypeError('File playback R2 progress callback is invalid'));
    }
    const canonical = snapshotOperation(operation);
    if (!canonical) {
      return Promise.reject(
        this.#fatal('File playback R2 whole-Blob operation is malformed or mismatched'),
      );
    }
    const existingTask = this.#inFlightByOperation.get(canonical.operation);
    if (existingTask) return existingTask.promise;
    try {
      this.#assertOperationCurrent(canonical, null);
      const reused = this.#reuseExisting(canonical);
      if (reused) return Promise.resolve(reused);
    } catch (error) {
      return Promise.reject(error);
    }

    const controller = new AbortController();
    const onOperationAbort = (): void => controller.abort(canonical.fence.signal.reason);
    canonical.fence.signal.addEventListener('abort', onOperationAbort, { once: true });
    if (canonical.fence.signal.aborted) onOperationAbort();
    const detachOperationAbort = (): void =>
      canonical.fence.signal.removeEventListener('abort', onOperationAbort);

    const promise = this.#acquirePhysical(canonical, controller, onProgress).finally(() => {
      detachOperationAbort();
      const active = this.#inFlightByOperation.get(canonical.operation);
      if (active) this.#inFlight.delete(active);
      this.#inFlightByOperation.delete(canonical.operation);
    });
    const record: InFlightRecord = { canonical, controller, promise };
    this.#inFlight.add(record);
    this.#inFlightByOperation.set(canonical.operation, record);
    return promise;
  }

  removeQueueItem(queueItemId: QueueItemId): Promise<boolean> {
    const existing = this.#retirements.get(queueItemId);
    if (existing) return existing;
    if (this.#closed) return Promise.resolve(false);
    const retirement = this.#removeQueueItem(queueItemId);
    this.#retirements.set(queueItemId, retirement);
    return retirement;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    for (const record of this.#inFlight) {
      record.controller.abort(new Error('FILE_PLAYBACK_R2_WHOLE_BLOB_ACQUIRER_CLOSED'));
    }
    const assets = [...this.#assets.values()];
    this.#assets.clear();
    const inFlight = [...this.#inFlight].map((record) => record.promise);
    this.#closePromise = (async () => {
      let closeError: unknown;
      try {
        await Reflect.apply(registryClose, this.#registry, [this.#roomToken]);
      } catch (error) {
        closeError = error;
      } finally {
        for (const asset of assets) releaseOwnedReservation(asset);
      }
      await Promise.allSettled(inFlight);
      if (closeError !== undefined) throw closeError;
    })();
    return this.#closePromise;
  }

  async #acquirePhysical(
    canonical: CanonicalOperation,
    controller: AbortController,
    onProgress: ProgressHandler | undefined,
  ): Promise<Readonly<FilePlaybackR2WholeBlobAcquisition>> {
    const signal = controller.signal;
    const offer = canonical.offer;
    const budget = this.#runtime.resolveMemoryBudget();
    let transportReservation: RemoteTransportMemoryReservation | null = null;
    let transportOwned = false;
    try {
      for (;;) {
        this.#assertOperationCurrent(canonical, signal);
        try {
          transportReservation = this.#runtime.reserveTransport(offer.encryptedSize, {
            budget,
            fileName: offer.name,
            retainedPcmBytes: budget.tier === 'ios' ? this.#runtime.livePcmBytes() : 0,
          });
          transportOwned = true;
          break;
        } catch (error) {
          if (isAudioDecodeAdmissionError(error) && error.reason === 'transport-working-set') {
            this.#assertOperationCurrent(canonical, signal);
            const changed = await this.#runtime.waitForMemoryReservationChange(signal);
            this.#assertOperationCurrent(canonical, signal);
            if (changed) continue;
          }
          throw error;
        }
      }

      let encrypted: ArrayBuffer | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        this.#assertOperationCurrent(canonical, signal);
        try {
          encrypted = await this.#runtime.download(
            offer.storageRoomId,
            offer.objectId,
            offer.encryptedSize,
            onProgress,
            signal,
          );
          this.#assertOperationCurrent(canonical, signal);
          break;
        } catch (error) {
          this.#assertOperationCurrent(canonical, signal);
          if (attempt === 0 && isTransientDownloadError(error)) continue;
          throw error;
        }
      }
      if (!(encrypted instanceof ArrayBuffer) || encrypted.byteLength !== offer.encryptedSize) {
        throw new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');
      }

      const decryptOptions: R2WholeBlobDecryptionV2Options = {
        expectedPlaintextSize: offer.encodedSize,
        expectedEncryptedSize: offer.encryptedSize,
        keyB64: offer.keyB64,
        ivB64: offer.ivB64,
        name: offer.name,
        mime: offer.mime,
        signal,
      };
      this.#assertOperationCurrent(canonical, signal);
      const file = await this.#runtime.decrypt(encrypted, decryptOptions);
      this.#assertOperationCurrent(canonical, signal);
      if (
        !(file instanceof File) ||
        file.size !== offer.encodedSize ||
        file.name !== offer.name ||
        file.type !== offer.mime ||
        file.lastModified !== 0
      ) {
        throw new Error('FILE_PLAYBACK_R2_WHOLE_BLOB_DECRYPT_RESULT_INVALID');
      }

      const reused = this.#reuseExisting(canonical);
      if (reused) return reused;

      // Final commit is deliberately synchronous and commit-dominant. There is
      // no await or authority callback after this last fence check.
      this.#assertOperationCurrent(canonical, signal);
      const binding = assetBinding(canonical.binding);
      const retained = transportReservation.handoffToRetainedEncoded(file, offer.encodedSize);
      transportOwned = false;
      let lease: FilePlaybackAssetLease | null = null;
      try {
        lease = Reflect.apply(registryAdmitBlob, this.#registry, [
          this.#roomToken,
          binding,
          file,
          { name: offer.name, mime: offer.mime },
        ]);
        const snapshot = Reflect.apply(registrySnapshotForLease, this.#registry, [
          this.#roomToken,
          lease,
        ]);
        if (!isExpectedAssetSnapshot(snapshot, binding, offer)) {
          throw new Error('File playback R2 Blob admission returned mismatched authority');
        }
        const result = freezeCanonical({ assetLease: lease, asset: snapshot });
        this.#assets.set(binding.queueItemId, {
          binding,
          result,
          reservation: retained,
          released: false,
        });
        return result;
      } catch (error) {
        if (lease === null) retained.release();
        else this.#discardUnpublishedAsset(lease, retained);
        throw this.#fatal('File playback R2 Blob admission failed', error);
      }
    } finally {
      if (transportOwned) transportReservation?.release();
    }
  }

  #reuseExisting(
    canonical: CanonicalOperation,
  ): Readonly<FilePlaybackR2WholeBlobAcquisition> | null {
    const binding = assetBinding(canonical.binding);
    const owned = this.#assets.get(binding.queueItemId);
    if (!owned) {
      const foreignLease = Reflect.apply(registryLeaseForBinding, this.#registry, [
        this.#roomToken,
        binding,
      ]);
      if (foreignLease) {
        throw this.#fatal('File playback R2 registry contains an unowned Blob binding');
      }
      return null;
    }
    const snapshot = Reflect.apply(registrySnapshotForLease, this.#registry, [
      this.#roomToken,
      owned.result.assetLease,
    ]);
    if (
      !sameBinding(owned.binding, binding) ||
      !isExpectedAssetSnapshot(snapshot, binding, canonical.offer) ||
      !sameAssetSnapshot(snapshot, owned.result.asset)
    ) {
      throw this.#fatal('File playback R2 source identity changed within the room');
    }
    return owned.result;
  }

  #assertOperationCurrent(canonical: CanonicalOperation, localSignal: AbortSignal | null): void {
    if (this.#closed || this.#removedQueueItems.has(canonical.binding.queueItemId)) {
      throw new Error('FILE_PLAYBACK_R2_WHOLE_BLOB_OPERATION_STALE');
    }
    if (localSignal?.aborted || canonical.fence.signal.aborted) {
      throw new Error('FILE_PLAYBACK_R2_WHOLE_BLOB_OPERATION_STALE');
    }
    let current: boolean;
    try {
      current = Reflect.apply(canonical.fence.isCurrent, undefined, []) === true;
    } catch {
      current = false;
    }
    if (!current || localSignal?.aborted || canonical.fence.signal.aborted) {
      throw new Error('FILE_PLAYBACK_R2_WHOLE_BLOB_OPERATION_STALE');
    }
  }

  async #removeQueueItem(queueItemId: QueueItemId): Promise<boolean> {
    if (!isQueueItemId(queueItemId)) {
      throw new TypeError('File playback R2 queue item ID is invalid');
    }
    this.#removedQueueItems.add(queueItemId);
    const tasks: Promise<unknown>[] = [];
    let found = false;
    for (const record of this.#inFlight) {
      if (record.canonical.binding.queueItemId !== queueItemId) continue;
      found = true;
      record.controller.abort(new Error('FILE_PLAYBACK_R2_WHOLE_BLOB_QUEUE_REMOVED'));
      tasks.push(record.promise);
    }
    if (tasks.length > 0) await Promise.allSettled(tasks);

    const asset = this.#assets.get(queueItemId);
    if (!asset) return found;
    found = true;
    this.#assets.delete(queueItemId);
    try {
      await Reflect.apply(registryRetire, this.#registry, [
        this.#roomToken,
        asset.result.assetLease,
      ]);
    } finally {
      releaseOwnedReservation(asset);
    }
    return found;
  }

  #discardUnpublishedAsset(
    lease: FilePlaybackAssetLease,
    reservation: EncodedReceiveMemoryReservation,
  ): void {
    try {
      const retirement = Reflect.apply(registryRetire, this.#registry, [this.#roomToken, lease]);
      void Promise.resolve(retirement).then(
        () => reservation.release(),
        () => reservation.release(),
      );
    } catch {
      // A synchronous retirement failure means the registry already rejected
      // or revoked this unpublished lease; no room asset can retain the Blob.
      reservation.release();
    }
  }

  #fatal(message: string, cause?: unknown): FilePlaybackR2WholeBlobAcquirerFatalError {
    if (this.#fatalError) return this.#fatalError;
    const error = new FilePlaybackR2WholeBlobAcquirerFatalError(
      message,
      cause === undefined ? undefined : { cause },
    );
    this.#fatalError = error;
    void this.close();
    try {
      this.#onFatalRoom(this.#roomToken, error);
    } catch {
      // Room acquisition authority is already quarantined.
    }
    return error;
  }
}
