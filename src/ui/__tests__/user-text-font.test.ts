/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocaleFontCode } from '../../i18n/locale-fonts.ts';

const { preloadLocaleFontGlyphs } = vi.hoisted(() => ({
  preloadLocaleFontGlyphs: vi.fn<(code: LocaleFontCode, text: string) => Promise<boolean>>(() =>
    Promise.resolve(true),
  ),
}));
vi.mock('../../i18n/locale-fonts.ts', () => ({ preloadLocaleFontGlyphs }));

import { applyUserTextFontFallback, detectUserTextFontCodesForTests } from '../user-text-font.ts';

beforeEach(() => {
  preloadLocaleFontGlyphs.mockClear();
});

describe('script-aware user text font fallback', () => {
  it.each([
    ['かなカナ', ['ja']],
    ['Привет', ['ru']],
    ['Γεια σου', ['el']],
    ['مرحبا', ['ar']],
    ['שלום', ['he']],
    ['नमस्ते', ['hi']],
    ['স্বাগতম', ['bn']],
    ['வணக்கம்', ['ta']],
    ['నమస్కారం', ['te']],
    ['નમસ્તે', ['gu']],
    ['ನಮಸ್ಕಾರ', ['kn']],
    ['നമസ്കാരം', ['ml']],
    ['ਸਤ ਸ੍ਰੀ ਅਕਾਲ', ['pa']],
    ['สวัสดี', ['th']],
    ['ㄅㄆㄇ', ['zh-hant']],
    ['这本书', ['zh-hans']],
    ['這本書', ['zh-hant']],
    ['习近平', ['zh-hans']],
    ['山东省金寨岭锅包肉', ['zh-hans']],
    ['岭', []],
    ['练习 練習', ['zh-hans', 'zh-hant']],
  ])('detects confident script evidence in %s', (text, expected) => {
    expect(detectUserTextFontCodesForTests(text)).toEqual(expected);
  });

  it('does not guess a CJK shard for Han-only ambiguous text', () => {
    expect(detectUserTextFontCodesForTests('東京中文')).toEqual([]);
    expect(detectUserTextFontCodesForTests('練習')).toEqual([]);
  });

  it('does not load a shard for Latin or Hangul user text', () => {
    const element = document.createElement('span');

    expect(applyUserTextFontFallback(element, 'MUSIXQUARE 가나다')).toEqual([]);
    expect(preloadLocaleFontGlyphs).not.toHaveBeenCalled();
  });

  it('loads and composes every confidently detected shard in mixed text', () => {
    const element = document.createElement('span');
    const text =
      'かな Привет Γεια مرحبا שלום नमस्ते স্বাগতম வணக்கம் నమస్కారం નમસ્તે ನಮಸ್ಕಾರ നമസ്കാരം ਸਤ ਸ੍ਰੀ ਅਕਾਲ สวัสดี ㄅ';
    const codes = applyUserTextFontFallback(element, text);

    expect(codes).toEqual([
      'ja',
      'ru',
      'el',
      'ar',
      'he',
      'hi',
      'bn',
      'ta',
      'te',
      'gu',
      'kn',
      'ml',
      'pa',
      'th',
      'zh-hant',
    ]);
    expect(element.dataset.userTextFonts).toBe('ja ru el ar he hi bn ta te gu kn ml pa th zh-hant');
    expect(element.classList).toContain('user-text-font');
    expect(element.classList).toContain('user-text-font-ja');
    expect(element.classList).toContain('user-text-font-ru');
    expect(element.classList).toContain('user-text-font-el');
    expect(element.classList).toContain('user-text-font-ar');
    expect(element.classList).toContain('user-text-font-he');
    expect(element.classList).toContain('user-text-font-hi');
    expect(element.classList).toContain('user-text-font-bn');
    expect(element.classList).toContain('user-text-font-ta');
    expect(element.classList).toContain('user-text-font-te');
    expect(element.classList).toContain('user-text-font-gu');
    expect(element.classList).toContain('user-text-font-kn');
    expect(element.classList).toContain('user-text-font-ml');
    expect(element.classList).toContain('user-text-font-pa');
    expect(element.classList).toContain('user-text-font-th');
    expect(element.classList).toContain('user-text-font-zh-hant');
    expect(preloadLocaleFontGlyphs.mock.calls).toEqual([
      ['ja', text],
      ['ru', text],
      ['el', text],
      ['ar', text],
      ['he', text],
      ['hi', text],
      ['bn', text],
      ['ta', text],
      ['te', text],
      ['gu', text],
      ['kn', text],
      ['ml', text],
      ['pa', text],
      ['th', text],
      ['zh-hant', text],
    ]);
  });

  it('warms the exact Simplified Chinese glyphs used by an external label', () => {
    const element = document.createElement('span');
    const text = '山东省金寨岭锅包肉';

    expect(applyUserTextFontFallback(element, text)).toEqual(['zh-hans']);
    expect(element.dataset.userTextFonts).toBe('zh-hans');
    expect(element.classList).toContain('user-text-font-zh-hans');
    expect(preloadLocaleFontGlyphs).toHaveBeenCalledWith('zh-hans', text);
  });

  it('clears stale classes when a reused element no longer needs a shard', () => {
    const element = document.createElement('span');
    applyUserTextFontFallback(element, 'Привет');
    applyUserTextFontFallback(element, 'hello');

    expect(element.classList.contains('user-text-font')).toBe(false);
    expect(element.classList.contains('user-text-font-ru')).toBe(false);
    expect(element.dataset.userTextFonts).toBeUndefined();
  });
});
