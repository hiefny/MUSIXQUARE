/**
 * The startup Han order: which CJK family draws Han first in every UI that is
 * not Japanese or Chinese.
 *
 * The Japanese, Simplified and Traditional Chinese UIs always draw Han from
 * their own family first (css/style.css html:lang rules). Every other UI,
 * Korean and English included, shares one order chosen once at startup from
 * the browser's language list: the first of Korean, Japanese, Simplified
 * Chinese or Traditional Chinese found, Korean when none is. The UI language
 * plays no part, so the Korean and English UIs always draw the same Han.
 *
 * src/i18n/locale-fonts.ts applies the result as html[data-mxqr-han-order].
 */

export type HanOrder = 'ko' | 'ja' | 'zh-hans' | 'zh-hant';

/** Browser language tags, matched by BCP 47 prefix, and the order each picks. */
const HAN_ORDER_TAGS: readonly (readonly [string, HanOrder])[] = [
  ['ko', 'ko'],
  ['ja', 'ja'],
  ['zh-hans', 'zh-hans'],
  ['zh-cn', 'zh-hans'],
  ['zh-hant', 'zh-hant'],
  ['zh-tw', 'zh-hant'],
  ['zh-hk', 'zh-hant'],
];

function hanOrderOf(tag: string): HanOrder | null {
  const normalized = tag.trim().replace(/_/gu, '-').toLowerCase();
  for (const [prefix, order] of HAN_ORDER_TAGS) {
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) return order;
  }
  return null;
}

/** The Han order of the first Korean, Japanese or Chinese tag in the list, else Korean. */
export function resolveHanOrder(languages: readonly string[]): HanOrder {
  for (const language of languages) {
    const order = hanOrderOf(language);
    if (order) return order;
  }
  return 'ko';
}
