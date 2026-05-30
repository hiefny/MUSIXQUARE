import { describe, it, expect } from 'vitest';
import { filterProfanity, containsProfanity } from '../profanity.ts';

// The word set is sourced from content-shield (severity >= 2). These tests
// avoid pinning the exact dictionary: they assert the filter's *behavioural
// contract* (length-preserving masking, word-boundary matching for English,
// case-insensitivity, clean-text passthrough) plus the documented Cassidy
// false-positive regression. A single strong English token is used to prove
// masking actually fires.

describe('profanity', () => {
  describe('filterProfanity', () => {
    it('returns an empty string unchanged', () => {
      expect(filterProfanity('')).toBe('');
    });

    it('leaves clean text untouched', () => {
      const clean = 'hello world, how is the show going tonight';
      expect(filterProfanity(clean)).toBe(clean);
    });

    it('preserves overall length when masking (asterisk-per-char)', () => {
      const dirty = 'fuck';
      const masked = filterProfanity(dirty);
      expect(masked).toHaveLength(dirty.length);
      expect(masked).toBe('*'.repeat(dirty.length));
    });

    it('is case-insensitive for English tokens', () => {
      expect(filterProfanity('FUCK')).toBe('****');
    });

    it('masks only the matched token, not the surrounding words', () => {
      const out = filterProfanity('oh fuck that');
      expect(out.startsWith('oh ')).toBe(true);
      expect(out.endsWith(' that')).toBe(true);
      expect(out).not.toContain('fuck');
    });
  });

  describe('containsProfanity', () => {
    it('is false for empty and clean text', () => {
      expect(containsProfanity('')).toBe(false);
      expect(containsProfanity('a perfectly normal sentence')).toBe(false);
    });

    it('does not flag legitimate words that embed a token (Cassidy regression)', () => {
      // English matching is word-boundary'd specifically so names like
      // "Cassidy" / "classic" don't trip the "ass" family.
      expect(containsProfanity('Cassidy')).toBe(false);
      expect(containsProfanity('a classic assignment')).toBe(false);
    });

    it('detects a standalone English token', () => {
      expect(containsProfanity('what the fuck')).toBe(true);
    });
  });

  describe('filter/contains consistency', () => {
    it('text flagged by containsProfanity is changed by filterProfanity', () => {
      const dirty = 'fuck this';
      expect(containsProfanity(dirty)).toBe(true);
      expect(filterProfanity(dirty)).not.toBe(dirty);
    });

    it('text not flagged is left identical by the filter', () => {
      const clean = 'see you at the concert';
      expect(containsProfanity(clean)).toBe(false);
      expect(filterProfanity(clean)).toBe(clean);
    });
  });
});
