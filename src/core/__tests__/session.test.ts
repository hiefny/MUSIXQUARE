import { describe, it, expect } from 'vitest';
import { INSTANCE_ID, nextSessionId, validateSessionId } from '../session.ts';

describe('Session', () => {
  describe('INSTANCE_ID', () => {
    it('is a non-empty string', () => {
      expect(typeof INSTANCE_ID).toBe('string');
      expect(INSTANCE_ID.length).toBeGreaterThan(0);
    });
  });

  describe('nextSessionId', () => {
    it('returns a positive integer', () => {
      const id = nextSessionId();
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
    });

    it('returns strictly increasing IDs', () => {
      const a = nextSessionId();
      const b = nextSessionId();
      const c = nextSessionId();
      expect(b).toBe(a + 1);
      expect(c).toBe(b + 1);
    });
  });

  describe('validateSessionId', () => {
    it('accepts valid positive integers', () => {
      expect(validateSessionId(1)).toBe(1);
      expect(validateSessionId(42)).toBe(42);
      expect(validateSessionId(999999)).toBe(999999);
    });

    it('accepts numeric strings', () => {
      expect(validateSessionId('123')).toBe(123);
    });

    it('rejects 0', () => {
      expect(validateSessionId(0)).toBe(0);
    });

    it('rejects negative numbers', () => {
      expect(validateSessionId(-1)).toBe(0);
    });

    it('rejects NaN / undefined / null', () => {
      expect(validateSessionId(NaN)).toBe(0);
      expect(validateSessionId(undefined)).toBe(0);
      expect(validateSessionId(null)).toBe(0);
    });

    it('rejects non-numeric strings', () => {
      expect(validateSessionId('abc')).toBe(0);
    });

    it('truncates floating point to integer', () => {
      expect(validateSessionId(42.7)).toBe(42);
    });

    it('throws in strict mode for invalid IDs', () => {
      expect(() => validateSessionId(-1, true)).toThrow('Invalid sessionId');
      expect(() => validateSessionId(NaN, true)).toThrow();
    });

    it('does not throw in strict mode for valid IDs', () => {
      expect(() => validateSessionId(100, true)).not.toThrow();
      expect(validateSessionId(100, true)).toBe(100);
    });
  });
});
