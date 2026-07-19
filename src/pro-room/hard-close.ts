/**
 * Bound how long explicit leave waits before falling back to the ordinary
 * presence endpoint. The original request is deliberately not aborted: a
 * browser keepalive fetch may still reach the Durable Object after the local
 * deadline and both close operations are idempotent.
 */
export async function waitForProRoomPresenceClose(
  request: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('PRO_ROOM_PRESENCE_CLOSE_TIMEOUT_INVALID');
  }
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    await Promise.race([
      request,
      new Promise<void>((_resolve, reject) => {
        timeout = globalThis.setTimeout(
          () => reject(new Error('PRO_ROOM_PRESENCE_CLOSE_TIMEOUT')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
}
