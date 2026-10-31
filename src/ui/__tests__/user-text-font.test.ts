/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { applyUserTextFontFallback, detectUserTextFontCodesForTests } from '../user-text-font.ts';

// The three order classes css/style.css styles (font-stack-identity.test.ts
// pins those rules).
const USER_TEXT_FONT_ORDER_CLASSES = [
  'user-text-font-ja',
  'user-text-font-zh-hans',
  'user-text-font-zh-hant',
] as const;

/**
 * Every app font family is declared in every UI, so user text needs no sheet
 * of its own. What detection still decides is the Han order: text that is
 * confidently Japanese, Simplified or Traditional Chinese draws its Han from
 * that language's family first. Everything else, undetected Han included,
 * follows the UI's order.
 */
describe('user text Han order detection', () => {
  it.each([
    ['かなカナ', ['ja']],
    ['ｶﾀｶﾅ', ['ja']],
    ['ㄅㄆㄇ', ['zh-hant']],
    ['这本书', ['zh-hans']],
    ['這本書', ['zh-hant']],
    ['习近平', ['zh-hans']],
    ['山东省金寨岭锅包肉', ['zh-hans']],
    ['岭', []],
    ['练习 練習', ['zh-hans', 'zh-hant']],
    ['かな 这本书', ['ja', 'zh-hans']],
  ])('detects %s as %j', (text, expected) => {
    expect(detectUserTextFontCodesForTests(text)).toEqual(expected);
  });

  it('does not guess a language for Han-only ambiguous text', () => {
    expect(detectUserTextFontCodesForTests('東京中文')).toEqual([]);
    expect(detectUserTextFontCodesForTests('練習')).toEqual([]);
  });

  it.each([
    ['Latin and Hangul', 'MUSIXQUARE 가나다'],
    ['Cyrillic', 'Привет'],
    ['Greek', 'Γεια σου'],
    ['Arabic', 'مرحبا'],
    ['Hebrew', 'שלום'],
    ['Devanagari', 'नमस्ते'],
    ['Bengali', 'স্বাগতম'],
    ['Tamil', 'வணக்கம்'],
    ['Telugu', 'నమస్కారం'],
    ['Gujarati', 'નમસ્તે'],
    ['Kannada', 'ನಮಸ್ಕಾರ'],
    ['Malayalam', 'നമസ്കാരം'],
    ['Gurmukhi', 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ'],
    ['Thai', 'สวัสดี'],
  ])('leaves %s to the shared stack', (_script, text) => {
    const element = document.createElement('span');

    expect(detectUserTextFontCodesForTests(text)).toEqual([]);
    expect(applyUserTextFontFallback(element, text)).toEqual([]);
    expect(element.className).toBe('');
    expect(element.hasAttribute('data-user-text-fonts')).toBe(false);
  });
});

describe('user text Han order class', () => {
  function orderClasses(element: HTMLElement): string[] {
    return USER_TEXT_FONT_ORDER_CLASSES.filter((name) => element.classList.contains(name));
  }

  it.each([
    ['かな', 'user-text-font-ja', 'ja'],
    ['这本书', 'user-text-font-zh-hans', 'zh-hans'],
    ['這本書', 'user-text-font-zh-hant', 'zh-hant'],
    // Precedence: Japanese, then Simplified, then Traditional Chinese.
    ['这本书 かな', 'user-text-font-ja', 'zh-hans ja'],
    ['這本書 かな', 'user-text-font-ja', 'zh-hant ja'],
    ['练习 練習', 'user-text-font-zh-hans', 'zh-hans zh-hant'],
    ['ㄅ 这', 'user-text-font-zh-hans', 'zh-hant zh-hans'],
  ])('gives %s exactly one order class', (text, orderClass, detected) => {
    const element = document.createElement('span');

    applyUserTextFontFallback(element, text);

    expect(element.classList.contains('user-text-font')).toBe(true);
    expect(orderClasses(element)).toEqual([orderClass]);
    expect(element.classList).toHaveLength(2);
    expect(element.dataset.userTextFonts).toBe(detected);
  });

  it('returns the detected list', () => {
    const element = document.createElement('span');
    // Characters in order, then the variant pairs.
    expect(applyUserTextFontFallback(element, '练习 練習 かな')).toEqual([
      'zh-hans',
      'ja',
      'zh-hant',
    ]);
  });

  it('reads the element text when no text is passed', () => {
    const element = document.createElement('span');
    element.textContent = 'かな';

    applyUserTextFontFallback(element);

    expect(orderClasses(element)).toEqual(['user-text-font-ja']);
  });

  it('clears stale classes when a reused element no longer needs an order', () => {
    const element = document.createElement('span');
    element.classList.add('chat-text');
    applyUserTextFontFallback(element, 'かな');
    applyUserTextFontFallback(element, '这本书');
    expect(orderClasses(element)).toEqual(['user-text-font-zh-hans']);

    applyUserTextFontFallback(element, 'hello');

    expect(element.className).toBe('chat-text');
    expect(element.dataset.userTextFonts).toBeUndefined();
  });

  it('does not mutate the direction owned by the rendering boundary', () => {
    const inherited = document.createElement('span');
    const automatic = document.createElement('span');
    const physical = document.createElement('span');
    automatic.dir = 'auto';
    physical.dir = 'ltr';

    applyUserTextFontFallback(inherited, 'かな');
    applyUserTextFontFallback(automatic, 'かな');
    applyUserTextFontFallback(physical, 'かな');

    expect(inherited.hasAttribute('dir')).toBe(false);
    expect(automatic.dir).toBe('auto');
    expect(physical.dir).toBe('ltr');
  });
});

describe('user text font boundary', () => {
  it('neither imports the font loader nor loads a stylesheet', () => {
    const source = readFileSync('src/ui/user-text-font.ts', 'utf8');

    expect(source).not.toMatch(/\bimport\b[^;]*['"][^'"]*locale-fonts(?:\.ts)?['"]/u);
    expect(source).not.toMatch(/\bimport\s*\(/u);
    expect(source).not.toMatch(/locale-font-contract/u);
  });
});
