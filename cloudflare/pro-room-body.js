/**
 * Bounded request-body primitives shared by the PRO room facade and its
 * service-control Durable Object.
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
  const chunks = [];
  let totalBytes = 0;
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const timeout = setTimeout(() => {
    stop({ kind: 'timeout' });
    cancelReadableBody(reader, 'PRO_ROOM_REQUEST_BODY_TIMEOUT');
  }, timeoutMs);
  const abort = () => {
    stop({ kind: 'aborted' });
    cancelReadableBody(reader, request.signal.reason);
  };
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });

  try {
    while (true) {
      const outcome = await Promise.race([
        reader.read().then(
          (value) => ({ kind: 'read', value }),
          () => ({ kind: 'invalid' }),
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

export function cancelReadableBody(bodyOrReader, reason) {
  const body = bodyOrReader?.body || bodyOrReader;
  if (!body || typeof body.cancel !== 'function') return;
  try {
    Promise.resolve(body.cancel(reason)).catch(() => {});
  } catch {
    // Cancellation is best-effort and must never extend the bounded outcome.
  }
}
