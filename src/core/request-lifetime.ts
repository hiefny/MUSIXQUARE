export const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 15_000;

class ControlResponseTooLargeError extends Error {
  constructor() {
    super('CONTROL_RESPONSE_TOO_LARGE');
    this.name = 'ControlResponseTooLargeError';
  }
}

export interface LinkedAbortScope {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  cleanup(): void;
}

function timeoutError(reason: string): Error {
  const error = new Error(reason);
  error.name = 'TimeoutError';
  return error;
}

/**
 * Own one abort signal whose lifetime is bounded by both its caller and an
 * intrinsic deadline. The deadline remains armed until cleanup(), so callers
 * can cover response-body consumption rather than only the response headers.
 */
export function createLinkedAbortScope(
  externalSignal?: AbortSignal,
  timeoutMs = DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
  timeoutReason = 'REQUEST_DEADLINE_EXCEEDED',
): LinkedAbortScope {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let cleaned = false;

  const abortFromExternal = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    abortFromExternal();
  } else if (externalSignal) {
    externalSignal.addEventListener('abort', abortFromExternal, { once: true });
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && !controller.signal.aborted) {
    // Operation-scoped safety deadlines deliberately do not use the
    // page/session managed-timer registry. `leaveSession()` clears that
    // registry for UI lifecycle cleanup; cancelling this timer without
    // aborting its request would leave a shared Promise or transfer pinned.
    // eslint-disable-next-line no-restricted-globals -- request safety deadline must survive session timer cleanup
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      if (!controller.signal.aborted) controller.abort(timeoutError(timeoutReason));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    abort(reason?: unknown) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      timeoutHandle = null;
      externalSignal?.removeEventListener('abort', abortFromExternal);
    },
  };
}

/**
 * Settle at an AbortSignal boundary even when the underlying promise ignores
 * that signal. Both branches stay observed after the race, and an optional
 * late-value disposer can release a response that arrives after cancellation
 * without making cleanup part of the caller's critical path.
 */
export function raceWithAbortSignal<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  disposeLateValue?: (value: T) => void | PromiseLike<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (callback: () => void) => {
      if (settled) return false;
      settled = true;
      cleanup();
      callback();
      return true;
    };
    const onAbort = () => finish(() => reject(responseAbortReason(signal)));
    const disposeLate = (value: T) => {
      if (!disposeLateValue) return;
      try {
        void Promise.resolve(disposeLateValue(value)).catch(() => undefined);
      } catch {
        // Late cleanup is best effort and never replaces the abort outcome.
      }
    };

    if (!signal.aborted) signal.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve(operation).then(
      (value) => {
        if (!finish(() => resolve(value))) disposeLate(value);
      },
      (error) => {
        finish(() => reject(error));
      },
    );
    if (signal.aborted) onAbort();
  });
}

export async function withRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    timeoutReason?: string;
  } = {},
): Promise<T> {
  const scope = createLinkedAbortScope(options.signal, options.timeoutMs, options.timeoutReason);
  try {
    if (scope.signal.aborted) throw responseAbortReason(scope.signal);

    const pending = operation(scope.signal);
    return await raceWithAbortSignal(pending, scope.signal);
  } finally {
    scope.cleanup();
  }
}

/**
 * Progress-based watchdog for transfers whose total duration is intentionally
 * unbounded. Every successful byte/read event calls touch(); only a completely
 * stalled interval expires the operation.
 */
export function createIdleWatchdog(
  onIdle: () => void,
  timeoutMs: number,
): { touch(): void; cleanup(): void } {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let cleaned = false;

  const arm = () => {
    if (cleaned || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    // eslint-disable-next-line no-restricted-globals -- transfer watchdog must survive session timer cleanup
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      if (!cleaned) onIdle();
    }, timeoutMs);
  };

  arm();
  return {
    touch: arm,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      timeoutHandle = null;
    },
  };
}

/**
 * Release a response that the caller intentionally will not consume. Fetch
 * resolves when headers arrive, so returning early without cancelling the
 * body can otherwise leave the connection and its server-side work alive.
 */
export function cancelResponseBody(response: Response): Promise<void> {
  try {
    if (response.body) {
      response.body.cancel().catch(() => {
        // Body cancellation is cleanup only; preserve the caller's primary outcome.
      });
    }
  } catch {
    // Cancellation is cleanup only; preserve the caller's primary outcome.
  }
  return Promise.resolve();
}

function responseAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function cancelReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): void {
  try {
    void Promise.resolve(reader.cancel(reason)).catch(() => undefined);
  } catch {
    // Cancellation is cleanup only; never replace the primary outcome.
  }
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw responseAbortReason(signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(responseAbortReason(signal));
      cancelReaderBestEffort(reader, signal.reason);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    void reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Read a small control-plane response without letting a fast, malformed body
 * allocate unbounded memory. This limit is deliberately separate from media
 * transfer sizes and never applies to audio/video bytes.
 */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }

  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      await cancelResponseBody(response);
      throw new ControlResponseTooLargeError();
    }
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await readResponseChunk(reader, signal);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        cancelReaderBestEffort(reader, 'CONTROL_RESPONSE_TOO_LARGE');
        throw new ControlResponseTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    cancelReaderBestEffort(reader, error);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Aborted native streams can already be unlocked.
    }
  }
}

export async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, maxBytes, signal);
  return text ? (JSON.parse(text) as unknown) : {};
}
