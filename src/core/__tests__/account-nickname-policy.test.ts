import { describe, expect, it } from 'vitest';

import {
  accountNicknameKey,
  normalizeAccountNickname,
  normalizeNewAccountNickname,
} from '../../../cloudflare/account-nickname.js';

describe('account nickname length policy', () => {
  it('accepts at most 12 Unicode code points for every new profile write', () => {
    expect(normalizeNewAccountNickname('🎵'.repeat(12))).toBe('🎵'.repeat(12));
    expect(normalizeNewAccountNickname('🎵'.repeat(13))).toBeNull();
  });

  it('keeps pre-existing 13-to-20-code-point nicknames readable', () => {
    expect(normalizeAccountNickname('x'.repeat(13))).toBe('x'.repeat(13));
    expect(normalizeAccountNickname('x'.repeat(20))).toBe('x'.repeat(20));
    expect(normalizeAccountNickname('x'.repeat(21))).toBeNull();
  });

  it('allows Korean text while rejecting only standalone English profanity', () => {
    expect(normalizeNewAccountNickname('청년개발자')).toBe('청년개발자');
    expect(normalizeNewAccountNickname('시발')).toBe('시발');
    expect(normalizeNewAccountNickname('ssibal')).toBe('ssibal');
    expect(normalizeNewAccountNickname('saekki')).toBe('saekki');
    expect(normalizeNewAccountNickname('nyeon')).toBe('nyeon');
    expect(normalizeNewAccountNickname('fuck')).toBeNull();
    expect(normalizeNewAccountNickname('Cassidy')).toBe('Cassidy');
    expect(normalizeNewAccountNickname('assignment')).toBe('assignment');
  });

  it('rejects every whitespace form and folds case and compatibility glyphs into one key', () => {
    for (const nickname of [
      'Min su',
      ' Minsu',
      'Minsu ',
      'Minsu\u00a0',
      'Min\u1680su',
      'Min\u2000su',
      'Min\u2028su',
      'Min\u2029su',
      'Min\u202fsu',
      'Min\u205fsu',
      'Min\u3000su',
      'Min\tsu',
      'Min\nsu',
    ]) {
      expect(normalizeNewAccountNickname(nickname), nickname).toBeNull();
    }
    expect(accountNicknameKey('MUSIXQUARE')).toBe('musixquare');
    expect(accountNicknameKey('ＭＵＳＩＸＱＵＡＲＥ')).toBe('musixquare');
    expect(accountNicknameKey('e\u0301')).toBe('\u00e9');
  });

  it('rejects visually blank fillers and unsafe default-ignorable characters', () => {
    for (const hidden of [
      '\u00ad',
      '\u0600',
      '\u061c',
      '\u115f',
      '\u1160',
      '\u180e',
      '\u2800',
      '\u3164',
      '\uffa0',
      '\ufff9',
    ]) {
      expect(normalizeNewAccountNickname(hidden), JSON.stringify(hidden)).toBeNull();
      expect(normalizeNewAccountNickname(`Min${hidden}su`), JSON.stringify(hidden)).toBeNull();
    }
    expect(normalizeNewAccountNickname('\uff9e')).toBeNull();
    expect(normalizeNewAccountNickname('\uff9f')).toBeNull();
    expect(normalizeNewAccountNickname('☕️')).toBe('☕️');
    expect(normalizeNewAccountNickname('A️')).toBe('A️');
    expect(normalizeNewAccountNickname('#️1')).toBeNull();
  });

  it('keeps legacy read normalization while bounding NFKC key expansion in storage', () => {
    expect(normalizeAccountNickname(' 민수 ')).toBe('민수');
    expect(normalizeNewAccountNickname(' 민수 ')).toBeNull();
    // U+3316 expands to six code points under NFKC. Twelve display code
    // points therefore exceed the old 64-character database key ceiling.
    expect(Array.from(accountNicknameKey('㌖'.repeat(12)) || '')).toHaveLength(72);
    expect(normalizeNewAccountNickname('㌖'.repeat(12))).toBe('㌖'.repeat(12));
  });
});
