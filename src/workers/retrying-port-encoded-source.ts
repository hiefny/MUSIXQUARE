import {
  EncodedSourceClosedError,
  type EncodedRandomAccessSource,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from '../player/sources/encoded-audio-source.js';
import {
  ENCODED_SOURCE_PORT_MAX_READ_BYTES,
  EncodedSourcePortError,
} from '../player/sources/encoded-source-port.js';

const BUSY_RETRY_LIMIT = 128;
const BUSY_INITIAL_DELAY_MS = 2;
const BUSY_MAX_DELAY_MS = 64;

type RetryingPortEncodedSourceErrorCode = 'source-read-overrun' | 'source-busy-timeout';

/** Fixed worker-domain failures produced above the encoded-source port. */
export class RetryingPortEncodedSourceError extends Error {
  constructor(
    readonly code: RetryingPortEncodedSourceErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'RetryingPortEncodedSourceError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

/** Narrow structural seam implemented by EncodedSourcePortClient. */
interface RetryingPortEncodedSourceClient {
  readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}

interface RetryingPortEncodedSourceOptions {
  readonly size: number;
  readonly identity: string;
  /** Ownership transfers after all constructor validation succeeds. */
  readonly client: RetryingPortEncodedSourceClient;
  /** PII-free worker telemetry mirrored by the owning main-thread adapter. */
  readonly onRetryWaitDelta?: (delta: 1 | -1, activeRetryWaits: number) => void;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = (): void => {
      settle(() => {
        try {
          throwIfAborted(signal);
        } catch (error) {
          reject(error);
        }
      });
    };
    const timer = globalThis.setTimeout(() => settle(resolve), milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/**
 * Codec-neutral exact byte source over one worker-owned MessagePort client.
 *
 * Only the broker's explicit transient `busy` result is retried. Attempts and
 * delays are fixed, every wait preserves the caller's exact abort reason, and
 * all other failures cross this boundary immediately. The wrapper owns its
 * client after construction and closes it at most once; it deliberately has no
 * transport kind or presentation metadata to invent inside the Worker realm.
 */
export class RetryingPortEncodedSource implements EncodedRandomAccessSource {
  readonly size: number;
  readonly identity: string;

  readonly #client: RetryingPortEncodedSourceClient;
  readonly #onRetryWaitDelta: ((delta: 1 | -1, activeRetryWaits: number) => void) | null;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #activeRetryWaits = 0;
  readonly #retryWaitDrainResolvers = new Set<() => void>();

  constructor(options: RetryingPortEncodedSourceOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('Retrying port encoded source options are required');
    }
    validateExactRead(options.size, 0, 0);
    if (!isEncodedAudioSourceIdentity(options.identity)) {
      throw new TypeError('Retrying port encoded source identity is invalid');
    }
    if (
      !options.client ||
      typeof options.client.readAt !== 'function' ||
      typeof options.client.close !== 'function'
    ) {
      throw new TypeError('Retrying port encoded source client is invalid');
    }
    this.size = options.size;
    this.identity = options.identity;
    this.#client = options.client;
    if (options.onRetryWaitDelta !== undefined && typeof options.onRetryWaitDelta !== 'function') {
      throw new TypeError('Retry wait delta observer must be a function');
    }
    this.#onRetryWaitDelta = options.onRetryWaitDelta ?? null;
  }

  get activeRetryWaitCount(): number {
    return this.#activeRetryWaits;
  }

  whenRetryWaitsDrained(): Promise<void> {
    if (this.#activeRetryWaits === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#retryWaitDrainResolvers.add(resolve);
      if (this.#activeRetryWaits === 0 && this.#retryWaitDrainResolvers.delete(resolve)) resolve();
    });
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    validateExactRead(this.size, offset, length);
    if (length > ENCODED_SOURCE_PORT_MAX_READ_BYTES) {
      throw new RetryingPortEncodedSourceError(
        'source-read-overrun',
        `Encoded source read exceeds ${ENCODED_SOURCE_PORT_MAX_READ_BYTES} bytes`,
      );
    }

    for (let attempt = 0; attempt <= BUSY_RETRY_LIMIT; attempt += 1) {
      throwIfAborted(signal);
      if (this.#closed) throw new EncodedSourceClosedError();
      try {
        const bytes = await this.#client.readAt(offset, length, signal);
        throwIfAborted(signal);
        if (this.#closed) throw new EncodedSourceClosedError();
        return bytes;
      } catch (error) {
        throwIfAborted(signal);
        if (this.#closed) throw new EncodedSourceClosedError();
        if (!(error instanceof EncodedSourcePortError) || error.code !== 'busy') throw error;
        if (attempt === BUSY_RETRY_LIMIT) {
          throw new RetryingPortEncodedSourceError(
            'source-busy-timeout',
            'Encoded source remained busy beyond the bounded retry window',
            error,
          );
        }
        const delay = Math.min(
          BUSY_MAX_DELAY_MS,
          BUSY_INITIAL_DELAY_MS * 2 ** Math.min(attempt, 5),
        );
        this.#changeRetryWaits(1);
        try {
          await abortableDelay(delay, signal);
        } finally {
          this.#changeRetryWaits(-1);
        }
      }
    }
    throw new RetryingPortEncodedSourceError(
      'source-busy-timeout',
      'Encoded source retry loop exhausted',
    );
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;

    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    // Claim terminal ownership before invoking a potentially reentrant client.
    this.#closePromise = closePromise;
    try {
      void Promise.resolve(this.#client.close()).then(resolveClose, rejectClose);
    } catch (error) {
      rejectClose(error);
    }
    return closePromise;
  }

  #changeRetryWaits(delta: 1 | -1): void {
    const next = this.#activeRetryWaits + delta;
    if (!Number.isSafeInteger(next) || next < 0) {
      throw new RetryingPortEncodedSourceError(
        'source-busy-timeout',
        'Encoded source retry wait accounting became inconsistent',
      );
    }
    this.#activeRetryWaits = next;
    try {
      this.#onRetryWaitDelta?.(delta, next);
    } catch {
      // Diagnostics are observational and cannot change decoder behavior.
    }
    if (next === 0) {
      const resolvers = [...this.#retryWaitDrainResolvers];
      this.#retryWaitDrainResolvers.clear();
      for (const resolve of resolvers) resolve();
    }
  }
}
