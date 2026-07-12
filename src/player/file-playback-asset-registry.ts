import type { QueueItemId } from '../types/index.ts';
import { isQueueItemId } from './queue-model.ts';
import { BlobEncodedAudioAsset } from './sources/blob-encoded-audio-asset.ts';
import type { EncodedAudioAsset } from './sources/encoded-audio-asset.ts';
import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  throwIfAborted,
  validateExactRead,
  type EncodedAudioSource,
  type EncodedAudioSourceKind,
  type EncodedAudioSourceMetadata,
} from './sources/encoded-audio-source.ts';

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_NAME_LENGTH = 512;
const MAX_MIME_LENGTH = 128;
const DEFAULT_MAX_LIVE_ASSETS = 128;
const MAX_LIVE_ASSETS = 1_024;
const DEFAULT_MAX_RETIRED_ASSETS = 4_096;
const MAX_RETIRED_ASSETS = 65_536;
const BINDING_KEYS = Object.freeze(['queueItemId', 'sourceIdentity', 'transferSessionId'] as const);
const METADATA_KEYS = Object.freeze(['mime', 'name'] as const);
const OPTION_KEYS = Object.freeze([
  'liveRoomToken',
  'maxLiveAssets',
  'maxRetiredAssets',
  'onFatalRoom',
] as const);
const transferredAssetOwners = new WeakMap<object, object>();
const retiredTransferredAssets = new WeakSet<object>();

declare const assetLeaseBrand: unique symbol;

export interface FilePlaybackAssetBinding {
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
}

export interface FilePlaybackAssetMetadata {
  readonly name: string;
  readonly mime: string;
}

/** Opaque authority for one exact live room-local asset. */
export interface FilePlaybackAssetLease {
  readonly [assetLeaseBrand]: never;
}

export interface FilePlaybackAssetSnapshot extends FilePlaybackAssetBinding {
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly name: string;
  readonly mime: string;
}

/** Exact ordinary-decode body plus its immutable distributed identity/metadata. */
export interface FilePlaybackBlobResolution {
  readonly blob: Blob;
  readonly binding: Readonly<FilePlaybackAssetBinding>;
  readonly metadata: Readonly<FilePlaybackAssetMetadata>;
}

export interface FilePlaybackAssetRegistryOptions {
  readonly liveRoomToken: object;
  readonly onFatalRoom: (token: object, error: FilePlaybackAssetRegistryFatalError) => void;
  readonly maxLiveAssets?: number;
  readonly maxRetiredAssets?: number;
}

interface AssetAdapter {
  readonly asset: EncodedAudioAsset;
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: Readonly<FilePlaybackAssetMetadata>;
  readonly acquire: (this: EncodedAudioAsset) => EncodedAudioSource;
  readonly close: (this: EncodedAudioAsset) => Promise<void>;
}

interface SourceAdapter {
  readonly source: EncodedAudioSource;
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: Readonly<FilePlaybackAssetMetadata>;
  readonly readAt: EncodedAudioSource['readAt'];
  readonly close: EncodedAudioSource['close'];
}

interface AssetEntry {
  readonly lease: FilePlaybackAssetLease;
  readonly binding: Readonly<FilePlaybackAssetBinding>;
  readonly adapter: AssetAdapter;
  readonly blob: Blob | null;
  readonly transferredGeneric: boolean;
  status: 'live' | 'retired';
  closePromise: Promise<void> | null;
}

type OptionsSnapshot = Readonly<Record<(typeof OPTION_KEYS)[number], unknown>>;
type DataMethod = (...args: never[]) => unknown;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function snapshotExactDataRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set(keys);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotOptions(value: unknown): OptionsSnapshot | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const required = OPTION_KEYS.filter(
      (key) => key !== 'maxLiveAssets' && key !== 'maxRetiredAssets',
    );
    const allowed = new Set<string>(OPTION_KEYS);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      required.some((key) => !ownKeys.includes(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<(typeof OPTION_KEYS)[number], unknown>;
    for (const key of OPTION_KEYS) {
      const descriptor = descriptors[key];
      if ((key === 'maxLiveAssets' || key === 'maxRetiredAssets') && !descriptor) {
        snapshot[key] = undefined;
        continue;
      }
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

export function parseFilePlaybackAssetBinding(
  value: unknown,
): Readonly<FilePlaybackAssetBinding> | null {
  const snapshot = snapshotExactDataRecord(value, BINDING_KEYS);
  if (
    !snapshot ||
    !isQueueItemId(snapshot.queueItemId) ||
    !isIdentifier(snapshot.sourceIdentity) ||
    !isIdentifier(snapshot.transferSessionId) ||
    new Set([snapshot.queueItemId, snapshot.sourceIdentity, snapshot.transferSessionId]).size !== 3
  ) {
    return null;
  }
  return freezeCanonical({
    queueItemId: snapshot.queueItemId,
    sourceIdentity: snapshot.sourceIdentity,
    transferSessionId: snapshot.transferSessionId,
  });
}

function parseMetadata(value: unknown): Readonly<FilePlaybackAssetMetadata> | null {
  const snapshot = snapshotExactDataRecord(value, METADATA_KEYS);
  if (
    !snapshot ||
    typeof snapshot.name !== 'string' ||
    snapshot.name.trim().length === 0 ||
    snapshot.name.length > MAX_NAME_LENGTH ||
    containsControlCharacter(snapshot.name) ||
    typeof snapshot.mime !== 'string' ||
    snapshot.mime.trim().length === 0 ||
    snapshot.mime.length > MAX_MIME_LENGTH ||
    snapshot.mime !== snapshot.mime.trim() ||
    containsControlCharacter(snapshot.mime)
  ) {
    return null;
  }
  return freezeCanonical({ name: snapshot.name, mime: snapshot.mime });
}

function findDataMethod(value: object, name: 'acquire' | 'close' | 'readAt'): DataMethod | null {
  try {
    let cursor: object | null = value;
    const seen = new WeakSet<object>();
    let depth = 0;
    while (cursor && depth < 32) {
      if (seen.has(cursor)) return null;
      seen.add(cursor);
      const descriptor = Reflect.getOwnPropertyDescriptor(cursor, name);
      if (descriptor) {
        return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
          ? descriptor.value
          : null;
      }
      cursor = Reflect.getPrototypeOf(cursor);
      depth += 1;
    }
  } catch {
    return null;
  }
  return null;
}

function readOwnData(value: object, name: string): unknown {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, name);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function snapshotAsset(value: unknown): AssetAdapter | null {
  if (value === null || typeof value !== 'object') return null;
  const kind = readOwnData(value, 'kind');
  const size = readOwnData(value, 'size');
  const identity = readOwnData(value, 'identity');
  const metadata = parseMetadata(readOwnData(value, 'metadata'));
  const acquire = findDataMethod(value, 'acquire');
  const close = findDataMethod(value, 'close');
  if (
    (kind !== 'blob' && kind !== 'peer-range' && kind !== 'r2-records') ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !isIdentifier(identity) ||
    !metadata ||
    !acquire ||
    !close
  ) {
    return null;
  }
  return Object.freeze({
    asset: value as EncodedAudioAsset,
    kind,
    size,
    identity,
    metadata,
    acquire: acquire as AssetAdapter['acquire'],
    close: close as AssetAdapter['close'],
  });
}

function snapshotSource(value: unknown): SourceAdapter | null {
  if (value === null || typeof value !== 'object') return null;
  const kind = readOwnData(value, 'kind');
  const size = readOwnData(value, 'size');
  const identity = readOwnData(value, 'identity');
  const metadata = parseMetadata(readOwnData(value, 'metadata'));
  const readAt = findDataMethod(value, 'readAt');
  const close = findDataMethod(value, 'close');
  if (
    (kind !== 'blob' && kind !== 'peer-range' && kind !== 'r2-records') ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !isIdentifier(identity) ||
    !metadata ||
    !readAt ||
    !close
  ) {
    return null;
  }
  return Object.freeze({
    source: value as EncodedAudioSource,
    kind,
    size,
    identity,
    metadata,
    readAt: readAt as EncodedAudioSource['readAt'],
    close: close as EncodedAudioSource['close'],
  });
}

function createCanonicalSourceLease(adapter: SourceAdapter): EncodedAudioSource {
  let closed = false;
  let closePromise: Promise<void> | null = null;
  const readAt: EncodedAudioSource['readAt'] = async (offset, length, signal) => {
    if (closed) throw new EncodedSourceClosedError();
    validateExactRead(adapter.size, offset, length);
    throwIfAborted(signal);
    if (length === 0) return new Uint8Array(0);
    const bytes = await adapter.readAt.call(adapter.source, offset, length, signal);
    throwIfAborted(signal);
    if (closed) throw new EncodedSourceClosedError();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new EncodedSourceIntegrityError(
        `Encoded asset lease returned ${bytes instanceof Uint8Array ? bytes.byteLength : 'invalid'} bytes; expected ${length}`,
      );
    }
    return bytes;
  };
  const close: EncodedAudioSource['close'] = () => {
    if (closePromise) return closePromise;
    closed = true;
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    try {
      Promise.resolve(adapter.close.call(adapter.source)).then(resolveClose, rejectClose);
    } catch (error) {
      rejectClose(error);
    }
    return closePromise;
  };
  return freezeCanonical({
    kind: adapter.kind,
    size: adapter.size,
    identity: adapter.identity,
    metadata: adapter.metadata,
    readAt,
    close,
  });
}

function readCloseMethod(value: unknown): AssetAdapter['close'] | null {
  if (value === null || typeof value !== 'object') return null;
  return findDataMethod(value, 'close') as AssetAdapter['close'] | null;
}

function configuredLimit(value: unknown, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (
    typeof selected !== 'number' ||
    !Number.isSafeInteger(selected) ||
    selected <= 0 ||
    selected > maximum
  ) {
    throw new RangeError(`${label} must be a positive safe integer up to ${maximum}`);
  }
  return selected;
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

function sameMetadata(
  left: Readonly<FilePlaybackAssetMetadata>,
  right: Readonly<FilePlaybackAssetMetadata>,
): boolean {
  return left.name === right.name && left.mime === right.mime;
}

function createAssetLease(): FilePlaybackAssetLease {
  return Object.freeze(Object.create(null)) as FilePlaybackAssetLease;
}

function snapshotEntry(entry: AssetEntry): Readonly<FilePlaybackAssetSnapshot> {
  return freezeCanonical({
    ...entry.binding,
    kind: entry.adapter.kind,
    size: entry.adapter.size,
    name: entry.adapter.metadata.name,
    mime: entry.adapter.metadata.mime,
  });
}

export class FilePlaybackAssetRegistryFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilePlaybackAssetRegistryFatalError';
  }
}

/**
 * Room-local ownership registry. Queue order is deliberately absent: an
 * immutable QueueItemId remains the only occurrence key across reorder.
 */
export class FilePlaybackAssetRegistry {
  readonly #token: object;
  readonly #ownerIdentity = Object.freeze(Object.create(null)) as object;
  readonly #onFatalRoom: FilePlaybackAssetRegistryOptions['onFatalRoom'];
  readonly #maxLiveAssets: number;
  readonly #maxRetiredAssets: number;
  readonly #entriesByQueue = new Map<QueueItemId, AssetEntry>();
  readonly #entriesBySource = new Map<string, AssetEntry>();
  readonly #entriesByTransfer = new Map<string, AssetEntry>();
  readonly #leases = new WeakMap<FilePlaybackAssetLease, AssetEntry>();
  readonly #ownedAssets = new WeakMap<object, AssetEntry>();
  readonly #blobEntries = new WeakMap<Blob, AssetEntry>();
  readonly #rejectedClosePromises = new WeakMap<object, Promise<void>>();
  readonly #discardedSourceClosePromises = new WeakMap<object, Promise<void>>();
  readonly #retiredQueueItems = new Set<QueueItemId>();
  readonly #retiredSourceIdentities = new Set<string>();
  readonly #retiredTransferSessions = new Set<string>();
  readonly #pendingCleanup = new Set<Promise<void>>();
  readonly #maxPendingCleanupClaims: number;
  #closed = false;
  #mutating = false;
  #cleanupCallbackDepth = 0;
  #fatalError: FilePlaybackAssetRegistryFatalError | null = null;
  #closePromise: Promise<void> | null = null;
  #bindingLookupActive = false;

  constructor(options: FilePlaybackAssetRegistryOptions) {
    const snapshot = snapshotOptions(options);
    if (!snapshot) throw new TypeError('File playback asset registry options are invalid');
    if (snapshot.liveRoomToken === null || typeof snapshot.liveRoomToken !== 'object') {
      throw new TypeError('File playback asset registry requires an opaque room token');
    }
    if (typeof snapshot.onFatalRoom !== 'function') {
      throw new TypeError('File playback asset registry fatal callback is required');
    }
    this.#token = snapshot.liveRoomToken;
    this.#onFatalRoom = snapshot.onFatalRoom as FilePlaybackAssetRegistryOptions['onFatalRoom'];
    this.#maxLiveAssets = configuredLimit(
      snapshot.maxLiveAssets,
      DEFAULT_MAX_LIVE_ASSETS,
      MAX_LIVE_ASSETS,
      'maxLiveAssets',
    );
    this.#maxRetiredAssets = configuredLimit(
      snapshot.maxRetiredAssets,
      DEFAULT_MAX_RETIRED_ASSETS,
      MAX_RETIRED_ASSETS,
      'maxRetiredAssets',
    );
    this.#maxPendingCleanupClaims = this.#maxLiveAssets + 16;
  }

  isClosed(): boolean {
    return this.#closed;
  }

  activeAssetCount(token: object): number | null {
    return token === this.#token && !this.#closed ? this.#entriesByQueue.size : null;
  }

  retiredAssetCount(token: object): number | null {
    return token === this.#token && !this.#closed ? this.#retiredQueueItems.size : null;
  }

  leaseForBinding(token: object, value: unknown): FilePlaybackAssetLease | null {
    if (token !== this.#token || this.#closed || this.#bindingLookupActive) return null;
    this.#bindingLookupActive = true;
    try {
      const binding = parseFilePlaybackAssetBinding(value);
      if (!binding || this.#closed) return null;
      const entry = this.#entriesByQueue.get(binding.queueItemId);
      return entry?.status === 'live' && sameBinding(entry.binding, binding) ? entry.lease : null;
    } finally {
      this.#bindingLookupActive = false;
    }
  }

  leaseForSourceIdentity(token: object, sourceIdentity: unknown): FilePlaybackAssetLease | null {
    if (token !== this.#token || this.#closed || !isIdentifier(sourceIdentity)) return null;
    const entry = this.#entriesBySource.get(sourceIdentity);
    return entry?.status === 'live' && entry.binding.sourceIdentity === sourceIdentity
      ? entry.lease
      : null;
  }

  admitBlob(
    token: object,
    value: unknown,
    blob: Blob,
    metadata: EncodedAudioSourceMetadata,
  ): FilePlaybackAssetLease {
    return this.#mutate(token, () => {
      const binding = parseFilePlaybackAssetBinding(value);
      this.#assertStillOpen();
      if (!binding) throw new TypeError('File playback asset binding is invalid');
      if (!(blob instanceof Blob)) throw new TypeError('File playback Blob asset is invalid');
      const safeMetadata = parseMetadata(metadata);
      this.#assertStillOpen();
      if (!safeMetadata) throw new TypeError('File playback Blob metadata is invalid');

      const replay = this.#blobEntries.get(blob);
      if (replay) {
        if (
          replay.status === 'live' &&
          sameBinding(replay.binding, binding) &&
          sameMetadata(replay.adapter.metadata, safeMetadata)
        ) {
          return replay.lease;
        }
        throw new Error('File playback Blob is already owned by another live binding');
      }
      this.#assertAdmissionAvailable(binding);

      let asset: BlobEncodedAudioAsset | null = null;
      let admitted = false;
      try {
        asset = new BlobEncodedAudioAsset(blob, {
          identity: binding.sourceIdentity,
          metadata: safeMetadata,
        });
        const adapter = snapshotAsset(asset);
        if (!adapter) throw new TypeError('Constructed Blob encoded asset is invalid');
        const entry = this.#admitEntry(binding, adapter, blob);
        admitted = true;
        return entry.lease;
      } finally {
        if (!admitted && asset) {
          this.#beginRejectedClose(asset, readCloseMethod(asset));
        }
      }
    });
  }

  admitEncodedAsset(
    token: object,
    value: unknown,
    asset: EncodedAudioAsset,
  ): FilePlaybackAssetLease {
    // Foreign and already-terminal registries reject before ownership. While
    // open, the process-wide weak claim is installed before any asset-owned
    // descriptor callback, preventing another room registry from closing or
    // double-owning the exact object during reentry.
    if (token !== this.#token) throw new Error('File playback room token is invalid');
    if (this.#closed) throw this.#fatalError ?? new Error('File playback asset registry is closed');
    if (!asset || typeof asset !== 'object') {
      throw new TypeError('Transferred encoded asset is invalid');
    }
    const owner = transferredAssetOwners.get(asset);
    if (owner && owner !== this.#ownerIdentity) {
      throw new Error('Encoded asset object is owned by another room registry');
    }
    if (retiredTransferredAssets.has(asset)) {
      throw new Error('Encoded asset object is retired');
    }
    const existing = owner === this.#ownerIdentity ? this.#ownedAssets.get(asset) : undefined;
    const transferred = owner === undefined;
    if (transferred) {
      if (this.#pendingCleanup.size >= this.#maxPendingCleanupClaims) {
        throw this.#fatal('File playback rejected-cleanup capacity is exhausted');
      }
      transferredAssetOwners.set(asset, this.#ownerIdentity);
    }
    let close: AssetAdapter['close'] | null = null;
    let admitted = false;
    try {
      return this.#mutate(token, () => {
        if (transferred) {
          close = readCloseMethod(asset);
          this.#assertStillOpen();
        }
        const binding = parseFilePlaybackAssetBinding(value);
        this.#assertStillOpen();
        if (!binding) throw new TypeError('File playback asset binding is invalid');
        if (existing) {
          if (existing.status === 'live' && sameBinding(existing.binding, binding)) {
            return existing.lease;
          }
          throw new Error('Encoded asset object is already owned by another live binding');
        }
        if (!transferred && !existing) {
          throw this.#fatal('Encoded asset ownership claim is inconsistent');
        }

        const adapter = snapshotAsset(asset);
        this.#assertStillOpen();
        if (!adapter) throw new TypeError('Transferred encoded asset is invalid');
        if (adapter.identity !== binding.sourceIdentity) {
          throw new Error('Encoded asset identity does not match its distributed binding');
        }
        this.#assertAdmissionAvailable(binding);
        const entry = this.#admitEntry(binding, adapter, null);
        admitted = true;
        return entry.lease;
      });
    } finally {
      if (transferred && !admitted) {
        if (transferredAssetOwners.get(asset) === this.#ownerIdentity) {
          transferredAssetOwners.delete(asset);
        }
        retiredTransferredAssets.add(asset);
        // When #mutate could not enter, it has already closed/fail-closed the
        // registry. Only that terminal state permits an unfenced fallback
        // descriptor read for ownership cleanup.
        if (!close && this.#closed) close = readCloseMethod(asset);
        this.#beginRejectedClose(asset, close);
      }
    }
  }

  snapshotForLease(
    token: object,
    lease: FilePlaybackAssetLease,
  ): Readonly<FilePlaybackAssetSnapshot> | null {
    if (token !== this.#token || this.#closed) return null;
    const entry = lease && typeof lease === 'object' ? this.#leases.get(lease) : undefined;
    return entry?.status === 'live' ? snapshotEntry(entry) : null;
  }

  resolveBlobAsset(
    token: object,
    lease: FilePlaybackAssetLease,
  ): Readonly<FilePlaybackBlobResolution> | null {
    if (token !== this.#token || this.#closed) return null;
    const entry = lease && typeof lease === 'object' ? this.#leases.get(lease) : undefined;
    return entry?.status === 'live' && entry.blob
      ? freezeCanonical({
          blob: entry.blob,
          binding: entry.binding,
          metadata: entry.adapter.metadata,
        })
      : null;
  }

  acquireSource(token: object, lease: FilePlaybackAssetLease): EncodedAudioSource {
    return this.#mutate(token, () => {
      const entry = this.#requireEntry(lease);
      let source: unknown = null;
      try {
        source = entry.adapter.acquire.call(entry.adapter.asset);
        this.#assertStillOpen();
        const safeSource = snapshotSource(source);
        this.#assertStillOpen();
        if (
          !safeSource ||
          safeSource.kind !== entry.adapter.kind ||
          safeSource.size !== entry.adapter.size ||
          safeSource.identity !== entry.binding.sourceIdentity ||
          !sameMetadata(safeSource.metadata, entry.adapter.metadata)
        ) {
          this.#closeSourceWithoutWaiting(source);
          throw this.#fatal('Encoded asset returned a mismatched or invalid source lease');
        }
        return createCanonicalSourceLease(safeSource);
      } catch (error) {
        if (source) this.#closeSourceWithoutWaiting(source);
        throw error;
      }
    });
  }

  retire(token: object, lease: FilePlaybackAssetLease): Promise<void> {
    return this.#mutate(token, () => {
      const entry = this.#requireEntry(lease);
      this.#ensureRetirementCapacity(entry);
      this.#revokeEntry(entry, true);
      return this.#beginEntryClose(entry);
    });
  }

  close(token: object): Promise<void> {
    if (token !== this.#token)
      return Promise.reject(new Error('File playback room token is invalid'));
    if (this.#closePromise) return this.#closePromise;
    if (this.#mutating || this.#cleanupCallbackDepth > 0) {
      this.#fatal('File playback asset registry close re-entered a mutation');
      return this.#closePromise!;
    }
    return this.#revokeAll();
  }

  #mutate<T>(token: object, operation: () => T): T {
    if (token !== this.#token) throw new Error('File playback room token is invalid');
    this.#assertStillOpen();
    if (this.#mutating || this.#cleanupCallbackDepth > 0) {
      throw this.#fatal('File playback asset registry mutation was re-entered');
    }
    this.#mutating = true;
    try {
      const result = operation();
      this.#assertStillOpen();
      return result;
    } finally {
      this.#mutating = false;
    }
  }

  #assertAdmissionAvailable(binding: Readonly<FilePlaybackAssetBinding>): void {
    if (
      this.#retiredQueueItems.has(binding.queueItemId) ||
      this.#retiredSourceIdentities.has(binding.sourceIdentity) ||
      this.#retiredTransferSessions.has(binding.transferSessionId)
    ) {
      throw new Error('File playback queue, source, or transfer authority is retired');
    }
    if (
      this.#entriesByQueue.has(binding.queueItemId) ||
      this.#entriesBySource.has(binding.sourceIdentity) ||
      this.#entriesByTransfer.has(binding.transferSessionId)
    ) {
      throw new Error('File playback asset binding conflicts with a live asset');
    }
    if (this.#entriesByQueue.size >= this.#maxLiveAssets) {
      throw this.#fatal('File playback live asset capacity is exhausted');
    }
  }

  #admitEntry(
    binding: Readonly<FilePlaybackAssetBinding>,
    adapter: AssetAdapter,
    blob: Blob | null,
  ): AssetEntry {
    const lease = createAssetLease();
    const entry: AssetEntry = {
      lease,
      binding,
      adapter,
      blob,
      transferredGeneric: blob === null,
      status: 'live',
      closePromise: null,
    };
    this.#entriesByQueue.set(binding.queueItemId, entry);
    this.#entriesBySource.set(binding.sourceIdentity, entry);
    this.#entriesByTransfer.set(binding.transferSessionId, entry);
    this.#leases.set(lease, entry);
    this.#ownedAssets.set(adapter.asset, entry);
    if (blob) this.#blobEntries.set(blob, entry);
    return entry;
  }

  #requireEntry(lease: FilePlaybackAssetLease): AssetEntry {
    const entry = lease && typeof lease === 'object' ? this.#leases.get(lease) : undefined;
    if (!entry || entry.status !== 'live') {
      throw new Error('File playback asset lease is forged or retired');
    }
    return entry;
  }

  #ensureRetirementCapacity(entry: AssetEntry): void {
    if (this.#retiredQueueItems.has(entry.binding.queueItemId)) return;
    if (this.#retiredQueueItems.size >= this.#maxRetiredAssets) {
      throw this.#fatal('File playback asset tombstone capacity is exhausted');
    }
  }

  #revokeEntry(entry: AssetEntry, tombstone: boolean): void {
    if (entry.status !== 'live') return;
    entry.status = 'retired';
    if (this.#entriesByQueue.get(entry.binding.queueItemId) === entry) {
      this.#entriesByQueue.delete(entry.binding.queueItemId);
    }
    if (this.#entriesBySource.get(entry.binding.sourceIdentity) === entry) {
      this.#entriesBySource.delete(entry.binding.sourceIdentity);
    }
    if (this.#entriesByTransfer.get(entry.binding.transferSessionId) === entry) {
      this.#entriesByTransfer.delete(entry.binding.transferSessionId);
    }
    this.#leases.delete(entry.lease);
    this.#ownedAssets.delete(entry.adapter.asset);
    if (
      entry.transferredGeneric &&
      transferredAssetOwners.get(entry.adapter.asset) === this.#ownerIdentity
    ) {
      transferredAssetOwners.delete(entry.adapter.asset);
      retiredTransferredAssets.add(entry.adapter.asset);
    }
    if (entry.blob) this.#blobEntries.delete(entry.blob);
    if (tombstone) {
      this.#retiredQueueItems.add(entry.binding.queueItemId);
      this.#retiredSourceIdentities.add(entry.binding.sourceIdentity);
      this.#retiredTransferSessions.add(entry.binding.transferSessionId);
    }
  }

  #beginEntryClose(entry: AssetEntry): Promise<void> {
    if (entry.closePromise) return entry.closePromise;
    let resolveClose!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    entry.closePromise = promise;
    this.#trackCleanup(promise);
    this.#cleanupCallbackDepth += 1;
    try {
      Promise.resolve(entry.adapter.close.call(entry.adapter.asset)).then(
        resolveClose,
        resolveClose,
      );
    } catch {
      resolveClose();
    } finally {
      this.#cleanupCallbackDepth -= 1;
    }
    return promise;
  }

  #beginRejectedClose(asset: object, close: AssetAdapter['close'] | null): Promise<void> {
    const existing = this.#rejectedClosePromises.get(asset);
    if (existing) return existing;
    let resolveClose!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    this.#rejectedClosePromises.set(asset, promise);
    this.#trackCleanup(promise);
    if (!close) {
      resolveClose();
      return promise;
    }
    this.#cleanupCallbackDepth += 1;
    try {
      Promise.resolve(close.call(asset as EncodedAudioAsset)).then(resolveClose, resolveClose);
    } catch {
      resolveClose();
    } finally {
      this.#cleanupCallbackDepth -= 1;
    }
    return promise;
  }

  #trackCleanup(promise: Promise<void>): void {
    this.#pendingCleanup.add(promise);
    void promise.finally(() => this.#pendingCleanup.delete(promise));
  }

  #closeSourceWithoutWaiting(source: unknown): Promise<void> {
    if (!source || typeof source !== 'object') return Promise.resolve();
    const existing = this.#discardedSourceClosePromises.get(source);
    if (existing) return existing;
    let resolveClose!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    this.#discardedSourceClosePromises.set(source, promise);
    this.#trackCleanup(promise);
    this.#cleanupCallbackDepth += 1;
    try {
      const close = findDataMethod(source, 'close');
      if (close) Promise.resolve(close.call(source)).then(resolveClose, resolveClose);
      else resolveClose();
    } catch {
      resolveClose();
    } finally {
      this.#cleanupCallbackDepth -= 1;
    }
    return promise;
  }

  #revokeAll(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    let resolveClose!: () => void;
    this.#closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const entries = [...this.#entriesByQueue.values()];
    for (const entry of entries) this.#revokeEntry(entry, false);
    for (const entry of entries) this.#beginEntryClose(entry);
    this.#entriesByQueue.clear();
    this.#entriesBySource.clear();
    this.#entriesByTransfer.clear();
    this.#retiredQueueItems.clear();
    this.#retiredSourceIdentities.clear();
    this.#retiredTransferSessions.clear();
    void this.#settleCloseAfterCleanup(resolveClose);
    return this.#closePromise;
  }

  async #settleCloseAfterCleanup(resolveClose: () => void): Promise<void> {
    // Yield once so an exact-token admission whose mutation just fail-closed
    // can publish its transferred-asset cleanup from its synchronous finally.
    await Promise.resolve();
    while (this.#pendingCleanup.size > 0) {
      const batch = [...this.#pendingCleanup];
      await Promise.all(batch);
      for (const promise of batch) this.#pendingCleanup.delete(promise);
    }
    resolveClose();
  }

  #assertStillOpen(): void {
    if (!this.#closed) return;
    throw this.#fatalError ?? new Error('File playback asset registry is closed');
  }

  #fatal(message: string): FilePlaybackAssetRegistryFatalError {
    if (this.#fatalError) return this.#fatalError;
    const error = new FilePlaybackAssetRegistryFatalError(message);
    this.#fatalError = error;
    this.#revokeAll();
    try {
      this.#onFatalRoom(this.#token, error);
    } catch {
      // The room-local asset authority is already quarantined.
    }
    return error;
  }
}
