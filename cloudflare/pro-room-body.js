/**
 * Bounded request-body primitives shared by the PRO room facade and its
 * service-control Durable Object.
 */

/** @typedef {{ kind: 'timeout' } | { kind: 'aborted' }} BodyStopOutcome */
/** @typedef {{ kind: 'read', value: ReadableStreamReadResult<Uint8Array> } | { kind: 'invalid' } | BodyStopOutcome} BodyReadOutcome */
/** @typedef {{ cancel?: (reason?: unknown) => unknown, body?: CancellableBody | null }} CancellableBody */

/**
 * @param {Request} request
 * @param {number} maxBytes
 * @param {number} timeoutMs
 * @returns {Promise<{ body: Uint8Array | null } | { error: 'invalid' | 'too-large' | 'timeout' | 'aborted' }>}
 */
export async function readBodyBytesLimited(request, maxBytes, timeoutMs) {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const normalized = declared.trim();
    if (!/^\d+$/.test(normalized)) return { error: 'invalid' };
    if (Number(normalized) > maxBytes) return { error: 'too-large' };
  }
  if (!request.body) return { body: null };

  const reader = request.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let totalBytes = 0;
  /** @type {((outcome: BodyStopOutcome) => void) | undefined} */
  let stop;
  /** @type {Promise<BodyStopOutcome>} */
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const timeout = setTimeout(() => {
    /** @type {(outcome: BodyStopOutcome) => void} */ (stop)({ kind: 'timeout' });
    cancelReadableBody(reader, 'PRO_ROOM_REQUEST_BODY_TIMEOUT');
  }, timeoutMs);
  const abort = () => {
    /** @type {(outcome: BodyStopOutcome) => void} */ (stop)({ kind: 'aborted' });
    cancelReadableBody(reader, request.signal.reason);
  };
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });

  try {
    while (true) {
      /** @type {BodyReadOutcome} */
      const outcome = await Promise.race([
        reader.read().then(
          (value) => /** @type {const} */ ({ kind: 'read', value }),
          () => /** @type {const} */ ({ kind: 'invalid' }),
        ),
        stopped,
      ]);
      if (outcome.kind !== 'read') return { error: outcome.kind };
      if (outcome.value.done) break;
      const bytes =
        outcome.value.value instanceof Uint8Array
          ? outcome.value.value
          : new Uint8Array(outcome.value.value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        cancelReadableBody(reader, 'PRO_ROOM_REQUEST_BODY_TOO_LARGE');
        return { error: 'too-large' };
      }
      chunks.push(bytes);
    }
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abort);
    try {
      reader.releaseLock();
    } catch {
      /* pending non-cooperative stream read */
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body };
}

/**
 * @param {CancellableBody | null | undefined} bodyOrReader
 * @param {unknown} reason
 * @returns {void}
 */
export function cancelReadableBody(bodyOrReader, reason) {
  const body = bodyOrReader?.body || bodyOrReader;
  if (!body || typeof body.cancel !== 'function') return;
  try {
    Promise.resolve(body.cancel(reason)).catch(() => {});
  } catch {
    // Cancellation is best-effort and must never extend the bounded outcome.
  }
}
