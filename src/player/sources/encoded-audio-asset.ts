import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  type EncodedAudioSourceKind,
  type EncodedAudioSourceMetadata,
  throwIfAborted,
  validateExactRead,
} from './encoded-audio-source.ts';

/** One audible renderer plus one independently primed replacement. */
export const ENCODED_AUDIO_ASSET_MAX_LEASES = 2;

/**
 * Shareable lifetime above one exact encoded byte source.
 *
 * The asset owns the underlying transport/source handle. Each acquired source
 * is only a logical reader lease: closing it aborts that reader's work without
 * closing the shared handle. Closing the asset is the sole terminal boundary
 * for the underlying source.
 */
export interface EncodedAudioAsset {
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata;
  readonly activeLeaseCount: number;

  acquire(): EncodedAudioSource;
  close(): Promise<void>;
}

function abortError(signal: AbortSignal): unknown {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return error;
  }
  return new DOMException('The encoded audio read was aborted', 'AbortError');
}

function createAbortGate(signal: AbortSignal): {
  readonly promise: Promise<never>;
  dispose(): void;
} {
  let onAbort = (): void => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    dispose() {
      signal.removeEventListener('abort', onAbort);
    },
  };
}

function abortFromSignal(controller: AbortController, signal: AbortSignal): void {
  if (!controller.signal.aborted) controller.abort(abortError(signal));
}

class SharedEncodedAudioSourceLease implements EncodedAudioSource {
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata;

  readonly #readSource: EncodedAudioSource['readAt'];
  readonly #assetClosed: () => boolean;
  readonly #release: (lease: SharedEncodedAudioSourceLease) => void;
  readonly #activeReads = new Set<AbortController>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(
    asset: Pick<EncodedAudioAsset, 'identity' | 'kind' | 'metadata' | 'size'>,
    readSource: EncodedAudioSource['readAt'],
    assetClosed: () => boolean,
    release: (lease: SharedEncodedAudioSourceLease) => void,
  ) {
    this.#readSource = readSource;
    this.#assetClosed = assetClosed;
    this.#release = release;
    this.kind = asset.kind;
    this.size = asset.size;
    this.identity = asset.identity;
    this.metadata = asset.metadata;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.#closed || this.#assetClosed()) throw new EncodedSourceClosedError();
    validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    if (length === 0) return new Uint8Array(0);

    const controller = new AbortController();
    const abortGate = createAbortGate(controller.signal);
    const onAbort = (): void => abortFromSignal(controller, signal);
    signal.addEventListener('abort', onAbort, { once: true });
    this.#activeReads.add(controller);
    if (signal.aborted) onAbort();

    try {
      const bytes = await Promise.race([
        Promise.resolve().then(() => {
          if (this.#closed || this.#assetClosed()) throw new EncodedSourceClosedError();
          throwIfAborted(controller.signal);
          return this.#readSource(offset, length, controller.signal);
        }),
        abortGate.promise,
      ]);
      throwIfAborted(signal);
      throwIfAborted(controller.signal);
      if (this.#closed || this.#assetClosed()) throw new EncodedSourceClosedError();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
        throw new EncodedSourceIntegrityError(
          `Shared encoded source returned ${bytes instanceof Uint8Array ? bytes.byteLength : 'invalid'} bytes; expected ${length}`,
        );
      }
      return bytes;
    } finally {
      signal.removeEventListener('abort', onAbort);
      abortGate.dispose();
      this.#activeReads.delete(controller);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closeInternal(new EncodedSourceClosedError());
    this.#closePromise = Promise.resolve();
    return this.#closePromise;
  }

  closeFromAsset(reason: unknown): void {
    this.#closeInternal(reason);
    this.#closePromise ??= Promise.resolve();
  }

  #closeInternal(reason: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#activeReads) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
    this.#activeReads.clear();
    this.#release(this);
  }
}

/**
 * Ref-counted logical-reader facade over one exact owned source.
 *
 * Ownership of `source` transfers at construction. The root stays open even
 * when the current lease count reaches zero, allowing later seek/recovery
 * candidates to reuse the same peer handle. Only asset.close() closes it.
 */
export class SharedEncodedAudioAsset implements EncodedAudioAsset {
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata;

  readonly #source: EncodedAudioSource;
  readonly #leases = new Set<SharedEncodedAudioSourceLease>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(source: EncodedAudioSource) {
    if (
      !source ||
      typeof source.readAt !== 'function' ||
      typeof source.close !== 'function' ||
      (source.kind !== 'blob' && source.kind !== 'peer-range' && source.kind !== 'r2-records') ||
      typeof source.identity !== 'string' ||
      source.identity.length === 0 ||
      !source.metadata ||
      typeof source.metadata.name !== 'string' ||
      typeof source.metadata.mime !== 'string'
    ) {
      throw new TypeError('Encoded audio asset requires a valid owned source');
    }
    validateExactRead(source.size, 0, 0);
    this.#source = source;
    this.kind = source.kind;
    this.size = source.size;
    this.identity = source.identity;
    this.metadata = Object.freeze({
      name: source.metadata.name,
      mime: source.metadata.mime,
    });
  }

  get activeLeaseCount(): number {
    return this.#leases.size;
  }

  acquire(): EncodedAudioSource {
    if (this.#closed) throw new EncodedSourceClosedError();
    if (this.#leases.size >= ENCODED_AUDIO_ASSET_MAX_LEASES) {
      throw new RangeError(
        `Encoded audio asset supports at most ${ENCODED_AUDIO_ASSET_MAX_LEASES} concurrent leases`,
      );
    }
    const lease = new SharedEncodedAudioSourceLease(
      this,
      (offset, length, signal) => this.#source.readAt(offset, length, signal),
      () => this.#closed,
      (released) => this.#leases.delete(released),
    );
    this.#leases.add(lease);
    return lease;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const reason = new EncodedSourceClosedError();
    for (const lease of [...this.#leases]) lease.closeFromAsset(reason);
    this.#leases.clear();

    // Install the terminal promise before invoking source-owned code. A
    // custom source may synchronously re-enter asset.close(); that call must
    // join this exact close instead of invoking the physical close twice.
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    this.#closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    try {
      Promise.resolve(this.#source.close()).then(resolveClose, rejectClose);
    } catch (error) {
      rejectClose(error);
    }
    return this.#closePromise;
  }
}
