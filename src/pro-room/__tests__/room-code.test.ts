import { describe, expect, it } from 'vitest';
import {
  formatProRoomPinForTests as formatProRoomPin,
  isProRoomCode,
  normalizeProRoomPin,
} from '../room-code.ts';

describe('PRO room code namespace', () => {
  it('accepts the dynamically provisioned PRO range without overlapping standard rooms', () => {
    expect(isProRoomCode('000000')).toBe(true);
    expect(isProRoomCode('000001')).toBe(true);
    expect(isProRoomCode('000002')).toBe(true);
    expect(isProRoomCode('099999')).toBe(true);
    expect(isProRoomCode('100000')).toBe(false);
    expect(isProRoomCode('999999')).toBe(false);
    expect(isProRoomCode('00000')).toBe(false);
  });
});

describe('PRO room PIN presentation', () => {
  it('normalizes formatted numeric input and rejects incomplete input', () => {
    expect(normalizeProRoomPin('1234-5678')).toBe('12345678');
    expect(normalizeProRoomPin(' 0000 0001 ')).toBe('00000001');
    expect(normalizeProRoomPin('1234567')).toBeNull();
    expect(normalizeProRoomPin(null)).toBeNull();
  });

  it('formats a valid PIN in the existing 4-4 presentation', () => {
    expect(formatProRoomPin('12345678')).toBe('1234-5678');
    expect(() => formatProRoomPin('1234')).toThrow('Invalid PRO room PIN');
  });
});
