import { describe, expect, it } from 'vitest';

import {
  hasVisibleDisplayNameContent,
  isSafeVisibleDisplayName,
  sanitizeDisplayNameForValidation,
} from '../../../cloudflare/display-name-policy.js';

describe('visible display-name policy', () => {
  it('rejects default-ignorable and blank filler characters anywhere', () => {
    const unsafeCharacters = [
      '\u00ad', // soft hyphen
      '\u034f', // combining grapheme joiner
      '\u0600', // Arabic number sign
      '\u061c', // Arabic letter mark
      '\u115f', // Hangul choseong filler
      '\u1160', // Hangul jungseong filler
      '\u17b4', // Khmer vowel inherent AQ
      '\u180e', // Mongolian vowel separator
      '\u200b', // zero-width space
      '\u2065', // reserved default-ignorable format slot
      '\u2800', // braille pattern blank
      '\u3164', // Hangul filler
      '\ufeff', // zero-width no-break space
      '\uffa0', // halfwidth Hangul filler
      '\ufff9', // interlinear annotation anchor
    ];

    for (const character of unsafeCharacters) {
      expect(
        isSafeVisibleDisplayName(character),
        `standalone U+${character.codePointAt(0)?.toString(16)}`,
      ).toBe(false);
      expect(
        isSafeVisibleDisplayName(`Min${character}su`),
        `embedded U+${character.codePointAt(0)?.toString(16)}`,
      ).toBe(false);
      expect(sanitizeDisplayNameForValidation(character)).toBe('');
    }
  });

  it('allows a variation selector only after visible base content', () => {
    expect(isSafeVisibleDisplayName('☕️')).toBe(true);
    expect(isSafeVisibleDisplayName('A️')).toBe(true);
    expect(isSafeVisibleDisplayName('️')).toBe(false);
  });

  it('preserves contextual script selectors and well-formed emoji tag flags', () => {
    expect(isSafeVisibleDisplayName('\u1820\u180b')).toBe(true);
    expect(isSafeVisibleDisplayName(`葛${String.fromCodePoint(0xe0100)}`)).toBe(true);
    const englandFlag = String.fromCodePoint(
      0x1f3f4,
      0xe0067,
      0xe0062,
      0xe0065,
      0xe006e,
      0xe0067,
      0xe007f,
    );
    expect(isSafeVisibleDisplayName(englandFlag)).toBe(true);
  });

  it('allows only ordinary ASCII spaces in shared display labels', () => {
    expect(isSafeVisibleDisplayName('Replacement owner')).toBe(true);
    for (const whitespace of ['\u00a0', '\u1680', '\u2000', '\u202f', '\u3000']) {
      expect(isSafeVisibleDisplayName(`Owner${whitespace}name`)).toBe(false);
    }
  });

  it('requires visible content while allowing normal multilingual labels', () => {
    expect(hasVisibleDisplayNameContent('\u0301\u0308')).toBe(false);
    expect(isSafeVisibleDisplayName('\u0301\u0308')).toBe(false);
    expect(isSafeVisibleDisplayName('\uff9e')).toBe(false);
    expect(isSafeVisibleDisplayName('\uff9f')).toBe(false);
    expect(isSafeVisibleDisplayName('민수')).toBe(true);
    expect(isSafeVisibleDisplayName('🎵')).toBe(true);
  });
});
