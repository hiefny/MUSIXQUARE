import { describe, expect, it } from 'vitest';

import {
  INITIAL_PRO_ROOM_GENERATION,
  isProRoomGeneration,
  MAX_PRO_ROOM_GENERATION,
  proRoomGenerationHeaderValue,
  proRoomMediaPrefix,
  proRoomObjectName,
} from '../../../cloudflare/pro-room-generation.ts';

// These builders name the generation's Durable Object and its R2 media prefix,
// so malformed input must never reach either namespace.
const INVALID_ROOM_CODES = [
  '100001',
  '00001',
  '0000001',
  '000001\n',
  '000001/../x',
  '',
  null,
  undefined,
] as const;
const INVALID_GENERATIONS = [
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  '0',
  null,
] as const;

describe('PRO room generation addressing', () => {
  it('starts at zero and stops at the largest safe integer', () => {
    expect(INITIAL_PRO_ROOM_GENERATION).toBe(0);
    expect(MAX_PRO_ROOM_GENERATION).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('accepts only safe non-negative integer generations', () => {
    for (const generation of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(isProRoomGeneration(generation)).toBe(true);
    }
    for (const generation of [
      ...INVALID_GENERATIONS,
      Number.NEGATIVE_INFINITY,
      undefined,
      true,
      0n,
      [0],
    ]) {
      expect(isProRoomGeneration(generation)).toBe(false);
    }
  });

  it('builds the Durable Object name, media prefix, and header value', () => {
    expect(proRoomObjectName('000001', 0)).toBe('000001:generation:0');
    expect(proRoomObjectName('012345', Number.MAX_SAFE_INTEGER)).toBe(
      `012345:generation:${Number.MAX_SAFE_INTEGER}`,
    );
    expect(proRoomMediaPrefix('000001', 7)).toBe('pro-room-incarnations/000001/generation-7');
    expect(proRoomMediaPrefix('012345', Number.MAX_SAFE_INTEGER)).toBe(
      `pro-room-incarnations/012345/generation-${Number.MAX_SAFE_INTEGER}`,
    );
    expect(proRoomGenerationHeaderValue(0)).toBe('0');
    expect(proRoomGenerationHeaderValue(Number.MAX_SAFE_INTEGER)).toBe(
      String(Number.MAX_SAFE_INTEGER),
    );
  });

  it.each(INVALID_ROOM_CODES)('rejects room code %j in every address', (roomCode) => {
    expect(() => proRoomObjectName(roomCode, 0)).toThrow('Invalid PRO room generation address');
    expect(() => proRoomMediaPrefix(roomCode, 0)).toThrow('Invalid PRO room generation address');
  });

  it.each(INVALID_GENERATIONS)('rejects generation %s in every address', (generation) => {
    expect(() => proRoomObjectName('000001', generation)).toThrow(
      'Invalid PRO room generation address',
    );
    expect(() => proRoomMediaPrefix('000001', generation)).toThrow(
      'Invalid PRO room generation address',
    );
    expect(() => proRoomGenerationHeaderValue(generation)).toThrow('Invalid PRO room generation');
  });
});
