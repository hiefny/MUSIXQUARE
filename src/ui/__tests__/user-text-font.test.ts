/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadLocaleFont } = vi.hoisted(() => ({
  loadLocaleFont: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../i18n/locale-fonts.ts', () => ({ loadLocaleFont }));

import { applyUserTextFontFallback, detectUserTextFontCodesForTests } from '../user-text-font.ts';

beforeEach(() => {
  loadLocaleFont.mockClear();
});

describe('script-aware user text font fallback', () => {
  it.each([
    ['かなカナ', ['ja']],
    ['Привет', ['ru']],
    ['สวัสดี', ['th']],
    ['ㄅㄆㄇ', ['zh-hant']],
    ['这本书', ['zh-hans']],
    ['這本書', ['zh-hant']],
    ['习近平', ['zh-hans']],
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
    expect(loadLocaleFont).not.toHaveBeenCalled();
  });

  it('loads and composes every confidently detected shard in mixed text', () => {
    const element = document.createElement('span');
    const codes = applyUserTextFontFallback(element, 'かな Привет สวัสดี ㄅ');

    expect(codes).toEqual(['ja', 'ru', 'th', 'zh-hant']);
    expect(element.dataset.userTextFonts).toBe('ja ru th zh-hant');
    expect(element.classList).toContain('user-text-font');
    expect(element.classList).toContain('user-text-font-ja');
    expect(element.classList).toContain('user-text-font-ru');
    expect(element.classList).toContain('user-text-font-th');
    expect(element.classList).toContain('user-text-font-zh-hant');
    expect(loadLocaleFont.mock.calls.map(([code]) => code)).toEqual(['ja', 'ru', 'th', 'zh-hant']);
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
