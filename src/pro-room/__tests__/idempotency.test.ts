import { describe, expect, it } from 'vitest';
import { createProRoomIdempotencyKey, type ProRoomCryptoRandomSource } from '../idempotency.ts';

function deterministicSource(start: number): ProRoomCryptoRandomSource {
  return {
    getRandomValues<T extends ArrayBufferView>(array: T): T {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      bytes.forEach((_value, index) => {
        bytes[index] = (start + index) & 0xff;
      });
      return array;
    },
  };
}

describe('PRO room idempotency keys', () => {
  it('uses 192 bits from Web Crypto and emits an API-safe opaque key', () => {
    const key = createProRoomIdempotencyKey(deterministicSource(0));

    expect(key).toBe('mxqr-pro-000102030405060708090a0b0c0d0e0f1011121314151617');
    expect(key).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/);
    expect(key).not.toMatch(/room|participant|timestamp/i);
  });

  it('reflects independent random input instead of a timestamp or counter', () => {
    expect(createProRoomIdempotencyKey(deterministicSource(1))).not.toBe(
      createProRoomIdempotencyKey(deterministicSource(2)),
    );
  });

  it('fails closed when secure randomness is unavailable', () => {
    expect(() =>
      createProRoomIdempotencyKey({
        getRandomValues: undefined,
      } as unknown as ProRoomCryptoRandomSource),
    ).toThrow('PRO_ROOM_SECURE_RANDOM_UNAVAILABLE');
  });
});
