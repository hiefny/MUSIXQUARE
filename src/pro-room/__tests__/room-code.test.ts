import { describe, expect, it } from 'vitest';
import {
  deriveTemporaryProRoomPin,
  formatProRoomPinForTests as formatProRoomPin,
  initialProRoomCodesForTests as INITIAL_PRO_ROOM_CODES,
  isInitialProRoomCodeForTests as isInitialProRoomCode,
  isProRoomCode,
  normalizeProRoomPin,
} from '../room-code.ts';

describe('PRO room code namespace', () => {
  it('reserves the leading-zero six-digit range without overlapping standard rooms', () => {
    expect(isProRoomCode('000000')).toBe(true);
    expect(isProRoomCode('000001')).toBe(true);
    expect(isProRoomCode('099999')).toBe(true);
    expect(isProRoomCode('100000')).toBe(false);
    expect(isProRoomCode('999999')).toBe(false);
    expect(isProRoomCode('00000')).toBe(false);
  });

  it('ships only the two explicitly provisioned beta rooms', () => {
    expect(INITIAL_PRO_ROOM_CODES).toEqual(['000000', '000001']);
    expect(isInitialProRoomCode('000000')).toBe(true);
    expect(isInitialProRoomCode('000001')).toBe(true);
    expect(isInitialProRoomCode('000002')).toBe(false);
  });

  it('derives the requested temporary bootstrap PIN from the room code', () => {
    expect(deriveTemporaryProRoomPin('000000')).toBe('00000000');
    expect(deriveTemporaryProRoomPin('000001')).toBe('00000001');
    expect(() => deriveTemporaryProRoomPin('100000')).toThrow('Invalid PRO room code');
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
