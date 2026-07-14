import {
  EncodedSourceClosedError,
  EncodedSourceRangeError,
  type EncodedAudioSource,
  type EncodedAudioSourceKind,
  type EncodedAudioSourceMetadata,
  throwIfAborted,
  validateExactRead,
} from './encoded-audio-source.ts';
import {
  closeReadControllers,
  runAbortableExactRead,
  safeAddSourceSize,
  snapshotEncodedAudioSource,
} from './encoded-audio-source-view-internals.ts';
import { PEER_RANGE_MAX_READ_BYTES } from './peer-range-protocol.ts';

export interface OffsetEncodedAudioSourceOptions {
  /** Ownership transfers only after this constructor validates successfully. */
  readonly source: EncodedAudioSource;
  readonly mediaOffset: number;
  readonly mediaSize: number;
}

/**
 * Owned, exact logical media window over a larger encoded source.
 *
 * Construction validates every field before ownership transfers. If the
 * constructor throws, the caller still owns `options.source` and must close it.
 */
export class OffsetEncodedAudioSource implements EncodedAudioSource {
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: Readonly<EncodedAudioSourceMetadata>;
  readonly mediaOffset: number;

  readonly #source: ReturnType<typeof snapshotEncodedAudioSource>;
  readonly #mediaOffset: number;
  readonly #activeReads = new Set<AbortController>();
  readonly #physicalTasks = new Set<Promise<Uint8Array>>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: OffsetEncodedAudioSourceOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('Offset source options are required');
    }
    // Read each caller-controlled option once before any ownership claim.
    const sourceValue = Reflect.get(options, 'source') as EncodedAudioSource;
    const mediaOffset = Reflect.get(options, 'mediaOffset') as number;
    const mediaSize = Reflect.get(options, 'mediaSize') as number;
    // Snapshot first, then finish every fallible geometry check before claim.
    const source = snapshotEncodedAudioSource(sourceValue);
    validateExactRead(source.size, mediaOffset, mediaSize);
    // Validate the physical end independently against safe-integer overflow.
    safeAddSourceSize(mediaOffset, mediaSize, 'Offset source physical end');

    this.#source = source;
    this.#mediaOffset = mediaOffset;
    this.kind = source.kind;
    this.size = mediaSize;
    this.identity = source.identity;
    this.metadata = source.metadata;
    this.mediaOffset = mediaOffset;
    Object.freeze(this);
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.#closed) throw new EncodedSourceClosedError();
    validateExactRead(this.size, offset, length);
    if (length > PEER_RANGE_MAX_READ_BYTES) {
      throw new EncodedSourceRangeError(
        `Offset source read length ${length} exceeds the ${PEER_RANGE_MAX_READ_BYTES}-byte limit`,
      );
    }
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError('Encoded source read signal must be an AbortSignal');
    }
    throwIfAborted(signal);
    if (length === 0) return new Uint8Array(0);
    const physicalOffset = safeAddSourceSize(
      this.#mediaOffset,
      offset,
      'Offset source read offset',
    );

    return runAbortableExactRead({
      signal,
      expectedLength: length,
      activeReads: this.#activeReads,
      physicalTasks: this.#physicalTasks,
      isClosed: () => this.#closed,
      read: (readSignal) => this.#source.readAt(physicalOffset, length, readSignal),
      label: 'Offset source read',
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const closePromise = Promise.resolve();
    this.#closePromise = closePromise;
    this.#closed = true;
    closeReadControllers(this.#activeReads);
    try {
      void Promise.resolve(this.#source.close()).catch(() => undefined);
    } catch {
      // Local ownership is already terminal; cleanup remains best-effort.
    }
    return closePromise;
  }
}
