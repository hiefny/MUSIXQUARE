import {
  EncodedSourceBusyError,
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  type EncodedAudioSourceKind,
  type EncodedAudioSourceMetadata,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from './encoded-audio-source.ts';

export const ENCODED_SOURCE_LIFETIME_DEFAULT_MAX_READ_TASKS = 8;
export const ENCODED_SOURCE_LIFETIME_MAX_READ_TASKS = 64;

const SOURCE_KINDS = new Set<EncodedAudioSourceKind>(['blob', 'peer-range', 'r2-records']);
const METADATA_KEYS = Object.freeze(['name', 'mime'] as const);
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) as object | null;
const typedArrayByteLengthGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
  : undefined;
const uint8ArraySet = Uint8Array.prototype.set;

interface SourceSnapshot {
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: Readonly<EncodedAudioSourceMetadata>;
  readonly readAt: EncodedAudioSource['readAt'];
  readonly close: EncodedAudioSource['close'];
}

interface LeaseState {
  readonly generation: number;
  readonly controllers: Set<AbortController>;
  closed: boolean;
  closePromise: Promise<void> | null;
}

type LeaseRead = EncodedAudioSource['readAt'];
type LeaseClose = EncodedAudioSource['close'];

export interface EncodedAudioSourceLifetimeOptions {
  /** Ownership transfers after this constructor validates successfully. */
  readonly source: EncodedAudioSource;
  /** Shared by every sequential worker lease, including tasks from retired leases. */
  readonly maxReadTasks?: number;
}

export class EncodedSourceLifetimeCapacityError extends EncodedSourceBusyError {
  readonly maximum: number;

  constructor(maximum: number) {
    super(`Encoded source lifetime already owns ${maximum} unsettled source read tasks`);
    this.name = 'EncodedSourceLifetimeCapacityError';
    this.maximum = maximum;
  }
}

export class EncodedSourceLifetimeLeaseActiveError extends Error {
  constructor() {
    super('Encoded source lifetime already has an active worker lease');
    this.name = 'EncodedSourceLifetimeLeaseActiveError';
  }
}

function snapshotMetadata(value: unknown): Readonly<EncodedAudioSourceMetadata> {
  try {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      throw new TypeError('Encoded source metadata must be an object');
    }
    const name = Reflect.get(value, METADATA_KEYS[0]);
    const mime = Reflect.get(value, METADATA_KEYS[1]);
    if (typeof name !== 'string' || typeof mime !== 'string') {
      throw new TypeError('Encoded source metadata name and mime must be strings');
    }
    return Object.freeze({
      name,
      mime,
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Encoded source metadata could not be inspected', { cause: error });
  }
}

function snapshotSource(source: EncodedAudioSource): SourceSnapshot {
  try {
    if (source === null || (typeof source !== 'object' && typeof source !== 'function')) {
      throw new TypeError('Encoded audio source is required');
    }
    const kind = source.kind;
    const size = source.size;
    const identity = source.identity;
    const metadata = snapshotMetadata(source.metadata);
    const readAt = source.readAt;
    const close = source.close;
    if (!SOURCE_KINDS.has(kind)) throw new TypeError('Encoded source kind is invalid');
    validateExactRead(size, 0, 0);
    if (!isEncodedAudioSourceIdentity(identity)) {
      throw new TypeError('Encoded source identity is invalid');
    }
    if (typeof readAt !== 'function' || typeof close !== 'function') {
      throw new TypeError('Encoded source methods are invalid');
    }
    return Object.freeze({
      kind,
      size,
      identity,
      metadata,
      readAt: (offset: number, length: number, signal: AbortSignal) =>
        Reflect.apply(readAt, source, [offset, length, signal]),
      close: () => Reflect.apply(close, source, []),
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new TypeError('Encoded audio source could not be inspected', { cause: error });
  }
}

function configuredReadTaskLimit(value: number | undefined): number {
  const limit = value ?? ENCODED_SOURCE_LIFETIME_DEFAULT_MAX_READ_TASKS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ENCODED_SOURCE_LIFETIME_MAX_READ_TASKS) {
    throw new RangeError(
      `maxReadTasks must be an integer from 1 to ${ENCODED_SOURCE_LIFETIME_MAX_READ_TASKS}`,
    );
  }
  return limit;
}

function exactTypedArrayByteLength(value: unknown): number | null {
  if (!(value instanceof Uint8Array) || !typedArrayByteLengthGetter) return null;
  try {
    return Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
  } catch {
    return null;
  }
}

function copyExactBytes(value: unknown, expectedLength: number): Uint8Array {
  if (exactTypedArrayByteLength(value) !== expectedLength) {
    throw new EncodedSourceIntegrityError(
      `Encoded source read did not return exactly ${expectedLength} bytes`,
    );
  }
  const copy = new Uint8Array(expectedLength);
  try {
    Reflect.apply(uint8ArraySet, copy, [value, 0]);
  } catch {
    throw new EncodedSourceIntegrityError('Encoded source bytes could not be copied');
  }
  return copy;
}

function abortControllerFrom(controller: AbortController, signal: AbortSignal): void {
  if (!controller.signal.aborted) controller.abort(signal.reason);
}

function createAbortGate(signal: AbortSignal): {
  readonly promise: Promise<never>;
  readonly dispose: () => void;
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
    dispose: () => signal.removeEventListener('abort', onAbort),
  };
}

/**
 * Non-owning worker-generation view of one encoded source lifetime.
 *
 * This object can be passed directly to `EncodedSourcePortBroker`. Closing the
 * broker closes only this lease. The owning lifetime remains available for a
 * successor worker realm.
 */
export class EncodedAudioSourceLease implements EncodedAudioSource {
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: Readonly<EncodedAudioSourceMetadata>;
  readonly leaseGeneration: number;

  readonly #state: LeaseState;
  readonly #read: (offset: number, length: number, signal: AbortSignal) => Promise<Uint8Array>;
  readonly #close: () => Promise<void>;

  constructor(snapshot: SourceSnapshot, state: LeaseState, read: LeaseRead, close: LeaseClose) {
    this.kind = snapshot.kind;
    this.size = snapshot.size;
    this.identity = snapshot.identity;
    this.metadata = snapshot.metadata;
    this.leaseGeneration = state.generation;
    this.#state = state;
    this.#read = read;
    this.#close = close;
  }

  get closed(): boolean {
    return this.#state.closed;
  }

  readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    return this.#read(offset, length, signal);
  }

  close(): Promise<void> {
    return this.#close();
  }
}

/**
 * One source-read ledger and one ownership boundary shared by sequential
 * decoder-worker realms.
 *
 * Only one lease may be active at a time. Retiring it aborts its logical reads
 * immediately, but an abort-resistant `source.readAt()` Promise keeps consuming
 * this global budget until that Promise actually settles. A source adapter that
 * settles `readAt()` before lower transport work finishes must independently
 * bound that hidden work; this lifetime deliberately cannot observe it.
 */
export class EncodedAudioSourceLifetime {
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: Readonly<EncodedAudioSourceMetadata>;
  readonly maxReadTasks: number;

  readonly #source: SourceSnapshot;
  readonly #readTasks = new Set<Promise<Uint8Array>>();
  #activeLease: LeaseState | null = null;
  #nextLeaseGeneration = 1;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: EncodedAudioSourceLifetimeOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('Encoded source lifetime options are required');
    }
    const source = snapshotSource(options.source);
    this.#source = source;
    this.kind = source.kind;
    this.size = source.size;
    this.identity = source.identity;
    this.metadata = source.metadata;
    this.maxReadTasks = configuredReadTaskLimit(options.maxReadTasks);
  }

  get closed(): boolean {
    return this.#closed;
  }

  get hasActiveLease(): boolean {
    return this.#activeLease !== null;
  }

  /** Includes retired leases until their returned source read Promises settle. */
  get readTaskCount(): number {
    return this.#readTasks.size;
  }

  acquireLease(): EncodedAudioSourceLease {
    if (this.#closed) throw new EncodedSourceClosedError();
    if (this.#activeLease) throw new EncodedSourceLifetimeLeaseActiveError();
    const generation = this.#nextLeaseGeneration;
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new RangeError('Encoded source lease generation space is exhausted');
    }
    this.#nextLeaseGeneration += 1;
    const state: LeaseState = {
      generation,
      controllers: new Set(),
      closed: false,
      closePromise: null,
    };
    this.#activeLease = state;
    return new EncodedAudioSourceLease(
      this.#source,
      state,
      (offset, length, signal) => this.#readFromLease(state, offset, length, signal),
      () => this.#closeLease(state),
    );
  }

  /**
   * Publishes the local terminal state and starts owned-source cleanup once.
   * The returned Promise does not wait for adapter-controlled async cleanup.
   */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    // close() is the lifetime's local terminal boundary, not an acknowledgement
    // from source-controlled cleanup. Publish an already-settled sentinel before
    // invoking that cleanup so even an async source close callback can safely
    // await a reentrant lifetime.close() without forming a Promise cycle.
    const closePromise = Promise.resolve();
    this.#closePromise = closePromise;
    this.#closed = true;
    const active = this.#activeLease;
    if (active) void this.#closeLease(active);
    try {
      void Promise.resolve(this.#source.close()).catch(() => undefined);
    } catch {
      // Closing is best-effort after the local lifetime reaches its terminal state.
    }
    return closePromise;
  }

  #readFromLease(
    state: LeaseState,
    offset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (this.#closed || state.closed || this.#activeLease !== state) {
      return Promise.reject(new EncodedSourceClosedError());
    }
    if (!(signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError('Encoded source read signal must be an AbortSignal'));
    }
    try {
      validateExactRead(this.size, offset, length);
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (length === 0) return Promise.resolve(new Uint8Array(0));
    if (this.#readTasks.size >= this.maxReadTasks) {
      return Promise.reject(new EncodedSourceLifetimeCapacityError(this.maxReadTasks));
    }

    const controller = new AbortController();
    const onCallerAbort = (): void => abortControllerFrom(controller, signal);
    signal.addEventListener('abort', onCallerAbort, { once: true });
    state.controllers.add(controller);
    if (signal.aborted) onCallerAbort();

    const readTask = Promise.resolve()
      .then(() => {
        throwIfAborted(controller.signal);
        return this.#source.readAt(offset, length, controller.signal);
      })
      .then((bytes) => {
        throwIfAborted(controller.signal);
        if (this.#closed || state.closed || this.#activeLease !== state) {
          throw new EncodedSourceClosedError();
        }
        return copyExactBytes(bytes, length);
      });
    this.#readTasks.add(readTask);
    void readTask.then(
      () => this.#readTasks.delete(readTask),
      () => this.#readTasks.delete(readTask),
    );

    const abortGate = createAbortGate(controller.signal);
    return Promise.race([readTask, abortGate.promise]).finally(() => {
      signal.removeEventListener('abort', onCallerAbort);
      abortGate.dispose();
      state.controllers.delete(controller);
    });
  }

  #closeLease(state: LeaseState): Promise<void> {
    if (state.closePromise) return state.closePromise;
    const closePromise = Promise.resolve();
    // Claim this lease before abort listeners can reenter close().
    state.closePromise = closePromise;
    state.closed = true;
    if (this.#activeLease === state) this.#activeLease = null;
    const reason = new EncodedSourceClosedError();
    for (const controller of state.controllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
    state.controllers.clear();
    return closePromise;
  }
}
