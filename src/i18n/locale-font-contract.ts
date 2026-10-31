/**
 * The languages whose static pages load a script sheet of their own: About's
 * disabled locale font links and the sitemap page (static-page-fonts.ts). The
 * app declares every font family in every UI and does not use this list
 * (app-font-contract.ts holds the app's sheets).
 */
const LOCALE_FONT_CODES = [
  'ar',
  'bn',
  'bg',
  'el',
  'fa',
  'gu',
  'he',
  'hi',
  'ja',
  'kn',
  'ml',
  'mr',
  'pa',
  'ru',
  'ta',
  'te',
  'th',
  'uk',
  'ur',
  'zh-hans',
  'zh-hant',
] as const;

export type LocaleFontCode = (typeof LOCALE_FONT_CODES)[number];

const LOCALE_FONT_CODE_SET = new Set<string>(LOCALE_FONT_CODES);

export function hasLocaleFont(code: string): code is LocaleFontCode {
  return LOCALE_FONT_CODE_SET.has(code);
}
