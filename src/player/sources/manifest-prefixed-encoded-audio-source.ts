import {
  CODEC_TIMELINE_MANIFEST_HEADER_BYTES,
  CODEC_TIMELINE_MANIFEST_MAX_BYTES,
} from '../manifests/codec-timeline-manifest.ts';
import {
  EncodedSourceClosedError,
  EncodedSourceRangeError,
  type EncodedAudioSource,
  type EncodedAudioSourceKind,
  type EncodedAudioSourceMetadata,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from './encoded-audio-source.ts';
import {
  closeReadControllers,
  readExactUint8ArrayByteLength,
  runAbortableExactRead,
  safeAddSourceSize,
  snapshotBoundedBytes,
  snapshotEncodedAudioSource,
  snapshotEncodedAudioSourceMetadata,
} from './encoded-audio-source-view-internals.ts';
import { PEER_RANGE_MAX_READ_BYTES } from './peer-range-protocol.ts';
import {
  acquireFilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleLease,
} from '../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import { confirmFilePlaybackUniversalLifecycleRetirement } from '../diagnostics/file-playback-universal-lifecycle-retirement.ts';

const blobSlice = Blob.prototype.slice;
const blobArrayBuffer = Blob.prototype.arrayBuffer;
const blobSizeGetter = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get;

interface ManifestPrefixedEncodedAudioSourceCommonOptions {
  readonly manifestBytes: Uint8Array;
}

export interface ManifestPrefixedOwnedSourceOptions extends ManifestPrefixedEncodedAudioSourceCommonOptions {
  /** Ownership transfers only after construction succeeds. */
  readonly media: EncodedAudioSource;
}

export interface ManifestPrefixedBorrowedBlobOptions extends ManifestPrefixedEncodedAudioSourceCommonOptions {
  /** Borrowed for this adapter's lifetime. close() never closes or mutates it. */
  readonly media: Blob;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata;
}

export type ManifestPrefixedEncodedAudioSourceOptions =
  | ManifestPrefixedOwnedSourceOptions
  | ManifestPrefixedBorrowedBlobOptions;

interface MediaSnapshot {
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: Readonly<EncodedAudioSourceMetadata>;
  readonly readAt: (offset: number, length: number, signal: AbortSignal) => Promise<unknown>;
  readonly close: (() => Promise<void> | void) | null;
}

function isBlob(value: unknown): value is Blob {
  try {
    return value instanceof Blob;
  } catch {
    return false;
  }
}

function snapshotBlobMedia(media: Blob, identity: unknown, metadataValue: unknown): MediaSnapshot {
  if (!blobSizeGetter) throw new TypeError('Blob size intrinsic is unavailable');
  if (!isEncodedAudioSourceIdentity(identity)) {
    throw new TypeError('Manifest-prefixed Blob identity is invalid');
  }
  let size: number;
  try {
    size = Reflect.apply(blobSizeGetter, media, []) as number;
  } catch (error) {
    throw new TypeError('Manifest-prefixed Blob could not be inspected', { cause: error });
  }
  validateExactRead(size, 0, 0);
  const metadata = snapshotEncodedAudioSourceMetadata(metadataValue);
  return Object.freeze({
    kind: 'blob' as const,
    size,
    identity,
    metadata,
    readAt: async (offset: number, length: number) => {
      const end = validateExactRead(size, offset, length);
      const part = Reflect.apply(blobSlice, media, [offset, end]);
      const buffer = (await Reflect.apply(blobArrayBuffer, part, [])) as ArrayBuffer;
      return new Uint8Array(buffer);
    },
    close: null,
  });
}

function snapshotOwnedMedia(media: EncodedAudioSource): MediaSnapshot {
  const snapshot = snapshotEncodedAudioSource(media);
  return Object.freeze({
    kind: snapshot.kind,
    size: snapshot.size,
    identity: snapshot.identity,
    metadata: snapshot.metadata,
    readAt: snapshot.readAt,
    close: snapshot.close,
  });
}

function snapshotManifest(value: unknown): Uint8Array {
  return snapshotBoundedBytes(
    value,
    CODEC_TIMELINE_MANIFEST_HEADER_BYTES,
    CODEC_TIMELINE_MANIFEST_MAX_BYTES,
    'Manifest prefix',
  );
}

function copyPrivateRange(
  target: Uint8Array,
  targetOffset: number,
  source: Uint8Array,
  start: number,
  end: number,
): void {
  // `subarray()` and `slice()` both consult TypedArray species and can hand a
  // hostile constructor the private source buffer. Every caller is already
  // bounded to 64 KiB, so an integer-index copy is small and species-free.
  let writeIndex = targetOffset;
  for (let readIndex = start; readIndex < end; readIndex += 1) {
    target[writeIndex] = source[readIndex]!;
    writeIndex += 1;
  }
}

/**
 * One exact peer-range byte authority laid out as `[manifest][encoded media]`.
 *
 * Blob input is borrowed. EncodedAudioSource input becomes owned only after
 * this constructor validates every option successfully; failed construction
 * leaves ownership with the caller.
 */
export class ManifestPrefixedEncodedAudioSource implements EncodedAudioSource {
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: Readonly<EncodedAudioSourceMetadata>;
  readonly manifestSize: number;
  readonly mediaSize: number;

  readonly #manifest: Uint8Array;
  readonly #manifestSize: number;
  readonly #media: MediaSnapshot;
  readonly #lifecycleLease: FilePlaybackUniversalLifecycleLease;
  readonly #activeReads = new Set<AbortController>();
  readonly #physicalTasks = new Set<Promise<Uint8Array>>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: ManifestPrefixedEncodedAudioSourceOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('Manifest-prefixed source options are required');
    }
    // Read each caller-controlled option once so accessors cannot create an
    // identity/media ABA between brand selection and the ownership snapshot.
    const manifestValue = Reflect.get(options, 'manifestBytes') as unknown;
    const mediaValue = Reflect.get(options, 'media') as unknown;
    const manifest = snapshotManifest(manifestValue);
    const manifestSize = readExactUint8ArrayByteLength(manifest, 'Owned manifest prefix');
    const media = isBlob(mediaValue)
      ? snapshotBlobMedia(
          mediaValue,
          Reflect.get(options, 'identity'),
          Reflect.get(options, 'metadata'),
        )
      : snapshotOwnedMedia(mediaValue as EncodedAudioSource);
    const size = safeAddSourceSize(manifestSize, media.size, 'Manifest-prefixed source size');

    this.#manifest = manifest;
    this.#manifestSize = manifestSize;
    this.#media = media;
    this.kind = media.kind;
    this.size = size;
    this.identity = media.identity;
    this.metadata = media.metadata;
    this.manifestSize = manifestSize;
    this.mediaSize = media.size;
    this.#lifecycleLease = acquireFilePlaybackUniversalLifecycleLease('encodedSources');
    Object.freeze(this);
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.#closed) throw new EncodedSourceClosedError();
    const end = validateExactRead(this.size, offset, length);
    if (length > PEER_RANGE_MAX_READ_BYTES) {
      throw new EncodedSourceRangeError(
        `Manifest-prefixed read length ${length} exceeds the ${PEER_RANGE_MAX_READ_BYTES}-byte limit`,
      );
    }
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError('Encoded source read signal must be an AbortSignal');
    }
    throwIfAborted(signal);
    if (length === 0) return new Uint8Array(0);

    const prefixEnd = Math.min(end, this.#manifestSize);
    const prefixLength = Math.max(0, prefixEnd - offset);
    const mediaLength = length - prefixLength;
    if (mediaLength === 0) {
      const result = new Uint8Array(length);
      copyPrivateRange(result, 0, this.#manifest, offset, end);
      throwIfAborted(signal);
      if (this.#closed) throw new EncodedSourceClosedError();
      return result;
    }

    const mediaOffset = Math.max(0, offset - this.#manifestSize);
    const mediaBytes = await runAbortableExactRead({
      signal,
      expectedLength: mediaLength,
      activeReads: this.#activeReads,
      physicalTasks: this.#physicalTasks,
      isClosed: () => this.#closed,
      read: (readSignal) => this.#media.readAt(mediaOffset, mediaLength, readSignal),
      label: 'Manifest-prefixed media read',
    });
    throwIfAborted(signal);
    if (this.#closed) throw new EncodedSourceClosedError();

    const result = new Uint8Array(length);
    if (prefixLength > 0) {
      copyPrivateRange(result, 0, this.#manifest, offset, prefixEnd);
    }
    copyPrivateRange(result, prefixLength, mediaBytes, 0, mediaLength);
    return result;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    // Publish a settled local sentinel before source-owned cleanup. Custom
    // source close callbacks may await this exact wrapper's close reentrantly.
    const closePromise = Promise.resolve();
    this.#closePromise = closePromise;
    this.#closed = true;
    closeReadControllers(this.#activeReads);
    let ownedMediaClose = Promise.resolve();
    if (this.#media.close) {
      try {
        ownedMediaClose = Promise.resolve(this.#media.close());
      } catch (error) {
        ownedMediaClose = Promise.reject(error);
      }
    }
    const cleanup = Promise.allSettled([...this.#physicalTasks])
      .then(() => ownedMediaClose)
      .then(() => undefined);
    void confirmFilePlaybackUniversalLifecycleRetirement(this.#lifecycleLease, () => cleanup);
    void cleanup.catch(() => undefined);
    return closePromise;
  }
}
