import { describe, it, expect } from 'vitest';
import { KO } from 'content-shield/languages/ko';
import { EN } from 'content-shield/languages/en';
import { filterProfanity } from '../profanity.ts';

function sourceProjection(): { words: string[]; korean: RegExp | null; english: RegExp | null } {
  const words = new Set<string>();
  for (const entry of KO.profanity) {
    if (entry.severity >= 2) {
      for (const variation of entry.variations ?? []) words.add(variation.toLowerCase());
    }
  }
  for (const entry of EN.words) {
    if (entry.severity >= 2) {
      words.add(entry.word.toLowerCase());
      for (const variation of entry.variations) words.add(variation.toLowerCase());
    }
  }

  const korean: string[] = [];
  const english: string[] = [];
  for (const word of words) {
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (/[\uAC00-\uD7AF\u3131-\u3163]/.test(word)) korean.push(escaped);
    else english.push(escaped);
  }
  korean.sort((a, b) => b.length - a.length);
  english.sort((a, b) => b.length - a.length);
  return {
    words: [...words],
    korean: korean.length > 0 ? new RegExp(korean.join('|'), 'gi') : null,
    english: english.length > 0 ? new RegExp(`\\b(?:${english.join('|')})\\b`, 'gi') : null,
  };
}

function sourceFilter(text: string, projection: ReturnType<typeof sourceProjection>): string {
  let result = text;
  if (projection.korean) {
    projection.korean.lastIndex = 0;
    result = result.replace(projection.korean, (match) => '*'.repeat(match.length));
  }
  if (projection.english) {
    projection.english.lastIndex = 0;
    result = result.replace(projection.english, (match) => '*'.repeat(match.length));
  }
  return result;
}

// The word set is sourced from content-shield (severity >= 2). These tests
// avoid pinning the exact dictionary: they assert the filter's *behavioural
// contract* (length-preserving masking, word-boundary matching for English,
// case-insensitivity, clean-text passthrough) plus the documented Cassidy
// false-positive regression. A single strong English token is used to prove
// masking actually fires.

describe('profanity', () => {
  it('keeps the generated projection equivalent for every selected source variation', () => {
    const projection = sourceProjection();
    for (const word of projection.words) {
      const sample = /[\uAC00-\uD7AF\u3131-\u3163]/.test(word)
        ? `문장${word}끝`
        : `before ${word} after`;
      const expected = sourceFilter(sample, projection);
      expect(filterProfanity(sample)).toBe(expected);
    }
  });

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

  describe('filter identity as the match signal', () => {
    it('keeps empty and clean text identical', () => {
      expect(filterProfanity('')).toBe('');
      expect(filterProfanity('a perfectly normal sentence')).toBe(
        'a perfectly normal sentence',
      );
    });

    it('does not flag legitimate words that embed a token (Cassidy regression)', () => {
      // English matching is word-boundary'd specifically so names like
      // "Cassidy" / "classic" don't trip the "ass" family.
      expect(filterProfanity('Cassidy')).toBe('Cassidy');
      expect(filterProfanity('a classic assignment')).toBe('a classic assignment');
    });

    it('detects a standalone English token', () => {
      expect(filterProfanity('what the fuck')).not.toBe('what the fuck');
    });
  });

  describe('filter match consistency', () => {
    it('matched text is changed by filterProfanity', () => {
      const dirty = 'fuck this';
      expect(filterProfanity(dirty)).not.toBe(dirty);
    });

    it('text not flagged is left identical by the filter', () => {
      const clean = 'see you at the concert';
      expect(filterProfanity(clean)).toBe(clean);
    });
  });
});
