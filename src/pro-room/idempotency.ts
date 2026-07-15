const IDEMPOTENCY_RANDOM_BYTES = 24;

interface ProRoomCryptoRandomSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

export type { ProRoomCryptoRandomSource as ProRoomCryptoRandomSourceForTests };

/**
 * Generate an opaque, API-safe idempotency key with 192 bits of entropy.
 *
 * There is deliberately no timestamp or room identifier in the key: neither
 * operational metadata nor a participant identity should leak through an R2
 * request header. The optional source exists for deterministic unit tests;
 * production callers always use Web Crypto.
 */
export function createProRoomIdempotencyKey(
  source: ProRoomCryptoRandomSource | undefined = globalThis.crypto,
): string {
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error('PRO_ROOM_SECURE_RANDOM_UNAVAILABLE');
  }

  const bytes = new Uint8Array(IDEMPOTENCY_RANDOM_BYTES);
  source.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `mxqr-pro-${token}`;
}
