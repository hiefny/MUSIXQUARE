/**
 * Han order for text supplied by people or external systems.
 *
 * Every app font family is declared in every UI, so user text never needs a
 * sheet of its own: Latin, Cyrillic and Greek always draw from Inter, Hangul
 * from Noto Sans KR, kana from Noto Sans JP, and the other scripts from their
 * own Noto face. What the UI language cannot know is which Han forms a
 * nickname or message wants. When the text itself says it is Japanese,
 * Simplified Chinese or Traditional Chinese, the element gets one order class
 * and css/style.css draws its Han from that language's family first. Han alone
 * cannot tell the three apart, so undetected Han follows the UI's order.
 *
 * Detection reads only the text, so the same text is marked the same way in
 * every UI.
 */

type UserTextFontCode = 'ja' | 'zh-hans' | 'zh-hant';

const HIRAGANA_OR_KATAKANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const BOPOMOFO_RE = /\p{Script=Bopomofo}/u;

// Deliberately conservative, asymmetric markers. Common/ambiguous Han is not
// included, and Japanese shinjitai shared with Simplified Chinese is avoided.
const SIMPLIFIED_HAN_MARKER_RE =
  /[这们说话语书车门网网页电脑脑乐听边过还进远发达实应开关时么吗习练东锅]/u;
const TRADITIONAL_HAN_MARKER_RE = /[這們說腦樂聽邊發實應關體裡麼嗎]/u;

// A traditional form such as `練` or `習` is also ordinary Japanese kanji,
// so it is not strong evidence by itself. When both sides of a known variant
// pair occur in one user string, however, the text is Chinese in both forms.
const SIMPLIFIED_TRADITIONAL_VARIANT_PAIRS = [
  ['练', '練'],
  ['习', '習'],
] as const;

/**
 * The order classes in precedence order: when text is detected as more than
 * one language, the first one present wins.
 */
const USER_TEXT_FONT_ORDER: readonly UserTextFontCode[] = ['ja', 'zh-hans', 'zh-hant'];

const USER_TEXT_FONT_ORDER_CLASSES: readonly string[] = USER_TEXT_FONT_ORDER.map(
  (code) => `user-text-font-${code}`,
);

function detectUserTextFontCodes(text: string): UserTextFontCode[] {
  const detected: UserTextFontCode[] = [];
  const add = (code: UserTextFontCode) => {
    if (!detected.includes(code)) detected.push(code);
  };

  for (const character of text) {
    if (HIRAGANA_OR_KATAKANA_RE.test(character)) add('ja');
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
 * Mark one explicit rendering boundary with its Han order. Callers invoke this
 * after assigning text; no document-wide observer scans unrelated DOM.
 */
export function applyUserTextFontFallback(
  element: HTMLElement,
  text = element.textContent || '',
): readonly UserTextFontCode[] {
  const codes = detectUserTextFontCodes(text);
  element.classList.remove('user-text-font', ...USER_TEXT_FONT_ORDER_CLASSES);

  const order = USER_TEXT_FONT_ORDER.find((code) => codes.includes(code));
  if (!order) {
    delete element.dataset.userTextFonts;
    return codes;
  }

  element.classList.add('user-text-font', `user-text-font-${order}`);
  element.dataset.userTextFonts = codes.join(' ');
  return codes;
}
