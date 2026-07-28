import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  EncodedSourceRangeError,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  throwIfAborted,
  validateExactRead,
} from './encoded-audio-source.ts';
import {
  PEER_RANGE_MAX_HANDLE_ID_LENGTH,
  PEER_RANGE_MAX_READ_BYTES,
  PEER_RANGE_MAX_SOURCE_IDENTITY_LENGTH,
  validatePeerRangeOpaqueId,
} from './peer-range-protocol.ts';
import {
  acquireFilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleLease,
} from '../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import { confirmFilePlaybackUniversalLifecycleRetirement } from '../diagnostics/file-playback-universal-lifecycle-retirement.ts';

export { PEER_RANGE_MAX_READ_BYTES } from './peer-range-protocol.ts';

const MAX_METADATA_LENGTH = 512;
let runtimeIdSequence = 0;

export interface PeerRangeReadRequest {
  readonly sourceIdentity: string;
  /** Distinguishes overlapping handles for the same immutable byte source. */
  readonly handleId: string;
  /** Unique for this handle's lifetime. A settled request ID is never reused. */
  readonly requestId: string;
  readonly offset: number;
  readonly length: number;
  readonly signal: AbortSignal;
}

/**
 * Product transport boundary for bounded peer reads. The RTC implementation
 * owns control/bulk framing and backpressure; this adapter owns source
 * lifetime, exact-read validation, and late-result suppression.
 */
export interface PeerRangeTransport {
  read(request: PeerRangeReadRequest): Promise<ArrayBuffer | Uint8Array>;
  /** Local handle cleanup only; implementations must not wait for a remote ACK. */
  closeHandle?(handleId: string, sourceIdentity: string): void | Promise<void>;
}

export interface PeerRangeEncodedAudioSourceOptions {
  readonly size: number;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata;
  readonly transport: PeerRangeTransport;
  readonly maxReadBytes?: number;
  /** Exact offer/asset handle. Direct callers may omit it to allocate one. */
  readonly handleId?: string;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function boundedMetadata(value: string, label: string): string {
  if (
    value.trim().length === 0 ||
    value.length > MAX_METADATA_LENGTH ||
    containsControlCharacter(value)
  ) {
    throw new TypeError(`${label} must be non-empty bounded text`);
  }
  return value;
}

function positiveReadLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > PEER_RANGE_MAX_READ_BYTES) {
    throw new RangeError(`maxReadBytes must be an integer from 1 to ${PEER_RANGE_MAX_READ_BYTES}`);
  }
  return value;
}

function runtimeId(prefix: string): string {
  if (runtimeIdSequence >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Peer range runtime identifier space is exhausted');
  }
  runtimeIdSequence += 1;
  const sequence = runtimeIdSequence.toString(36);
  const cryptoApi = globalThis.crypto;
  const randomUUID = cryptoApi?.randomUUID;
  if (typeof randomUUID === 'function') {
    return `${prefix}:${randomUUID.call(cryptoApi)}:${sequence}`;
  }
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const words = new Uint32Array(4);
    cryptoApi.getRandomValues(words);
    return `${prefix}:${[...words]
      .map((word) => word.toString(16).padStart(8, '0'))
      .join('')}:${sequence}`;
  }
  return `${prefix}:runtime-${sequence}`;
}

function abortWithReason(controller: AbortController, signal: AbortSignal): void {
  if (controller.signal.aborted) return;
  controller.abort(signal.reason);
}

function createAbortGate(signal: AbortSignal): {
  readonly promise: Promise<never>;
  dispose(): void;
} {
  let onAbort = (): void => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
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

/**
 * Random-access source backed by exact, bounded RTC peer reads.
 *
 * No encoded body is persisted or accumulated here. Every response is copied
 * into an exact-size transferable buffer so a small view cannot retain a much
 * larger transport allocation. Closing aborts all in-flight reads and makes
 * every late transport completion inert.
 */
export class PeerRangeEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'peer-range' as const;
  readonly size: number;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata;

  readonly #transport: PeerRangeTransport;
  readonly #maxReadBytes: number;
  readonly #handleId: string;
  readonly #lifecycleLease: FilePlaybackUniversalLifecycleLease;
  readonly #activeReads = new Map<string, AbortController>();
  readonly #physicalReads = new Set<Promise<ArrayBuffer | Uint8Array>>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: PeerRangeEncodedAudioSourceOptions) {
    validateExactRead(options.size, 0, 0);
    if (!options.transport || typeof options.transport.read !== 'function') {
      throw new TypeError('Peer range transport is required');
    }

    this.size = options.size;
    this.identity = validatePeerRangeOpaqueId(
      options.identity,
      'identity',
      PEER_RANGE_MAX_SOURCE_IDENTITY_LENGTH,
    );
    this.metadata = Object.freeze({
      name: boundedMetadata(options.metadata.name, 'metadata.name'),
      mime: boundedMetadata(options.metadata.mime, 'metadata.mime'),
    });
    this.#handleId = validatePeerRangeOpaqueId(
      options.handleId ?? runtimeId('peer-range-handle'),
      'handleId',
      PEER_RANGE_MAX_HANDLE_ID_LENGTH,
    );
    this.#transport = options.transport;
    this.#maxReadBytes = positiveReadLimit(options.maxReadBytes ?? PEER_RANGE_MAX_READ_BYTES);
    this.#lifecycleLease = acquireFilePlaybackUniversalLifecycleLease('encodedSources');
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.#closed) throw new EncodedSourceClosedError();
    validateExactRead(this.size, offset, length);
    if (length > this.#maxReadBytes) {
      throw new EncodedSourceRangeError(
        `Peer range read length ${length} exceeds the ${this.#maxReadBytes}-byte limit`,
      );
    }
    throwIfAborted(signal);
    if (length === 0) return new Uint8Array(0);

    // Runtime IDs carry a monotonic suffix as well as entropy, so this handle
    // never reuses a descriptor even if an RNG implementation repeats output.
    const id = runtimeId('peer-range-request');
    const controller = new AbortController();
    const abortGate = createAbortGate(controller.signal);
    const onAbort = () => abortWithReason(controller, signal);
    signal.addEventListener('abort', onAbort, { once: true });
    this.#activeReads.set(id, controller);

    try {
      const physicalRead = Promise.resolve().then(() => {
        throwIfAborted(controller.signal);
        if (this.#closed) throw new EncodedSourceClosedError();
        return this.#transport.read({
          sourceIdentity: this.identity,
          handleId: this.#handleId,
          requestId: id,
          offset,
          length,
          signal: controller.signal,
        });
      });
      this.#physicalReads.add(physicalRead);
      void physicalRead.then(
        () => this.#physicalReads.delete(physicalRead),
        () => this.#physicalReads.delete(physicalRead),
      );
      const response = await Promise.race([physicalRead, abortGate.promise]);

      throwIfAborted(signal);
      throwIfAborted(controller.signal);
      if (this.#closed) throw new EncodedSourceClosedError();

      const bytes = response instanceof Uint8Array ? response : new Uint8Array(response);
      if (bytes.byteLength !== length) {
        throw new EncodedSourceIntegrityError(
          `Peer range read returned ${bytes.byteLength} bytes; expected ${length}`,
        );
      }
      return Uint8Array.from(bytes);
    } finally {
      signal.removeEventListener('abort', onAbort);
      abortGate.dispose();
      this.#activeReads.delete(id);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    let resolveClose!: () => void;
    let rejectClose!: (reason: unknown) => void;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    // Transport abort listeners may synchronously reenter close(). Claim the
    // one public result and cleanup right before dispatching either abort or
    // transport-owned close hooks so every caller joins this exact barrier.
    this.#closePromise = closePromise;
    this.#closed = true;
    for (const controller of this.#activeReads.values()) {
      if (!controller.signal.aborted) controller.abort(new EncodedSourceClosedError());
    }
    this.#activeReads.clear();

    // Source destruction must not depend on a remote acknowledgement. The
    // transport owns any async control frame and scopes cleanup to this exact
    // handle so a stale close cannot tear down a successor with the same byte
    // identity.
    const closeHandle = Promise.resolve().then(() =>
      this.#transport.closeHandle?.(this.#handleId, this.identity),
    );
    // Public logical close stays prompt once the local handle-close operation
    // settles. Abort-resistant transport promises are diagnostic/physical
    // ownership, not a reason to hang room teardown or an aborted acquisition.
    void closeHandle.then(resolveClose, rejectClose);
    const physicalClosePromise = Promise.allSettled([
      Promise.allSettled([...this.#physicalReads]).then(() => undefined),
      closeHandle,
    ]).then((settlements) => {
      const failures = settlements
        .filter(
          (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected',
        )
        .map((settlement) => settlement.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Multiple peer-range source cleanup operations failed');
      }
    });
    void confirmFilePlaybackUniversalLifecycleRetirement(
      this.#lifecycleLease,
      () => physicalClosePromise,
    ).catch(() => undefined);
    return closePromise;
  }
}
