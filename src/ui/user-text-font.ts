/**
 * Script-aware font fallback for text supplied by people or external systems.
 *
 * UI language cannot identify a nickname/message's script, and Han alone
 * cannot distinguish Japanese, Simplified Chinese, and Traditional Chinese.
 * We therefore load only confidently detected shards. Ambiguous Han keeps the
 * existing conservative system/CJK fallback without making a locale guess.
 */

import { loadLocaleFont, type LocaleFontCode } from '../i18n/locale-fonts.ts';

const HIRAGANA_OR_KATAKANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const THAI_RE = /\p{Script=Thai}/u;
const BOPOMOFO_RE = /\p{Script=Bopomofo}/u;

// Deliberately conservative, asymmetric markers. Common/ambiguous Han is not
// included, and Japanese shinjitai shared with Simplified Chinese is avoided.
const SIMPLIFIED_HAN_MARKER_RE = /[这们说话语书车门网网页电脑脑乐听边过还进远发达实应开关时么吗习练]/u;
const TRADITIONAL_HAN_MARKER_RE = /[這們說腦樂聽邊發實應關體裡麼嗎]/u;

// A traditional form such as `練` or `習` is also ordinary Japanese kanji,
// so it is not strong evidence by itself. When both sides of a known variant
// pair occur in one user string, however, loading both Chinese shards is the
// least surprising result and correctly handles mixed-script names/messages.
const SIMPLIFIED_TRADITIONAL_VARIANT_PAIRS = [
  ['练', '練'],
  ['习', '習'],
] as const;

const USER_TEXT_FONT_CLASS_BY_CODE: Record<LocaleFontCode, string> = {
  ja: 'user-text-font-ja',
  ru: 'user-text-font-ru',
  th: 'user-text-font-th',
  'zh-hans': 'user-text-font-zh-hans',
  'zh-hant': 'user-text-font-zh-hant',
};
const USER_TEXT_FONT_CLASSES = Object.values(USER_TEXT_FONT_CLASS_BY_CODE);

function detectUserTextFontCodes(text: string): LocaleFontCode[] {
  const detected: LocaleFontCode[] = [];
  const seen = new Set<LocaleFontCode>();
  const add = (code: LocaleFontCode) => {
    if (seen.has(code)) return;
    seen.add(code);
    detected.push(code);
  };

  for (const character of text) {
    if (HIRAGANA_OR_KATAKANA_RE.test(character)) add('ja');
    else if (CYRILLIC_RE.test(character)) add('ru');
    else if (THAI_RE.test(character)) add('th');
    else if (BOPOMOFO_RE.test(character)) add('zh-hant');
    else if (SIMPLIFIED_HAN_MARKER_RE.test(character)) add('zh-hans');
    else if (TRADITIONAL_HAN_MARKER_RE.test(character)) add('zh-hant');
  }
  for (const [simplified, traditional] of SIMPLIFIED_TRADITIONAL_VARIANT_PAIRS) {
    if (text.includes(simplified) && text.includes(traditional)) {
      add('zh-hans');
      add('zh-hant');
    }
  }
  return detected;
}

export const detectUserTextFontCodesForTests = detectUserTextFontCodes;

/**
 * Mark one explicit rendering boundary and start any required lazy loads.
 * Callers invoke this after assigning text; no document-wide observer scans
 * unrelated DOM or turns ordinary mutations into font-loading work.
 */
export function applyUserTextFontFallback(
  element: HTMLElement,
  text = element.textContent || '',
): readonly LocaleFontCode[] {
  const codes = detectUserTextFontCodes(text);
  element.classList.remove('user-text-font', ...USER_TEXT_FONT_CLASSES);

  if (codes.length === 0) {
    delete element.dataset.userTextFonts;
    return codes;
  }

  element.classList.add('user-text-font');
  for (const code of codes) {
    element.classList.add(USER_TEXT_FONT_CLASS_BY_CODE[code]);
    void loadLocaleFont(code);
  }
  element.dataset.userTextFonts = codes.join(' ');
  return codes;
}
