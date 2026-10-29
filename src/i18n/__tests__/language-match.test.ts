import { describe, expect, it } from 'vitest';
import { matchLanguage, resolvePreferredLanguage } from '../language-match.ts';
import { LANGUAGE_OPTIONS } from '../locales.ts';

describe('shared language matching', () => {
  it.each([
    ['ko', 'ko'],
    ['ko-KR', 'ko'],
    ['ja', 'ja'],
    ['de-AT', 'de'],
    ['fr_CA', 'fr'],
    ['zh-TW', 'zh-hant'],
    ['zh-HK', 'zh-hant'],
    ['zh-Hant-SG', 'zh-hant'],
    ['zh-CN', 'zh-hans'],
    ['zh-Hans-TW', 'zh-hans'],
    ['pt-PT', 'pt-br'],
    ['pt-BR', 'pt-br'],
    ['in-ID', 'id'],
    ['iw', 'he'],
    ['no-NO', 'nb'],
    ['tl', 'fil'],
    ['FIL-ph', 'fil'],
    [' en-GB ', 'en'],
  ])('maps %s to %s', (tag, expected) => {
    expect(matchLanguage(tag)).toBe(expected);
  });

  it.each(['', 'sw-KE', 'x-klingon', '<img src=x>', null, undefined])(
    'leaves unsupported tag %s unmatched',
    (tag) => {
      expect(matchLanguage(tag)).toBeNull();
    },
  );

  it('accepts every supported code as itself', () => {
    for (const { code } of LANGUAGE_OPTIONS) expect(matchLanguage(code), code).toBe(code);
  });

  it('takes the first supported browser preference in order, then English', () => {
    expect(resolvePreferredLanguage({ languages: ['sw-KE', 'de-AT', 'ko'], language: 'sw' })).toBe(
      'de',
    );
    expect(resolvePreferredLanguage({ languages: [], language: 'ja-JP' })).toBe('ja');
    expect(resolvePreferredLanguage({ languages: ['sw-KE'], language: 'sw-KE' })).toBe('en');
    expect(resolvePreferredLanguage({ languages: [], language: '' })).toBe('en');
  });
});
