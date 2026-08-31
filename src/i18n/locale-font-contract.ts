export const LOCALE_FONT_CODES = [
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
