export const LANGUAGE_OPTIONS = [
  {
    code: 'en',
    htmlLang: 'en',
    hrefLang: 'en',
    ogLocale: 'en_US',
    nativeName: 'English',
    englishName: 'Default',
  },
  {
    code: 'ko',
    htmlLang: 'ko',
    hrefLang: 'ko',
    ogLocale: 'ko_KR',
    nativeName: '한국어',
    englishName: 'Korean',
  },
  {
    code: 'ja',
    htmlLang: 'ja',
    hrefLang: 'ja',
    ogLocale: 'ja_JP',
    nativeName: '日本語',
    englishName: 'Japanese',
  },
  {
    code: 'zh-hans',
    htmlLang: 'zh-Hans',
    hrefLang: 'zh-Hans',
    ogLocale: 'zh_CN',
    nativeName: '简体中文',
    englishName: 'Chinese (Simplified)',
  },
  {
    code: 'zh-hant',
    htmlLang: 'zh-Hant',
    hrefLang: 'zh-Hant',
    ogLocale: 'zh_TW',
    nativeName: '繁體中文',
    englishName: 'Chinese (Traditional)',
  },
  {
    code: 'es',
    htmlLang: 'es',
    hrefLang: 'es',
    ogLocale: 'es_ES',
    nativeName: 'Español',
    englishName: 'Spanish',
  },
  {
    code: 'pt-br',
    htmlLang: 'pt-BR',
    hrefLang: 'pt-BR',
    ogLocale: 'pt_BR',
    nativeName: 'Português (Brasil)',
    englishName: 'Portuguese (Brazil)',
  },
  {
    code: 'fr',
    htmlLang: 'fr',
    hrefLang: 'fr',
    ogLocale: 'fr_FR',
    nativeName: 'Français',
    englishName: 'French',
  },
  {
    code: 'de',
    htmlLang: 'de',
    hrefLang: 'de',
    ogLocale: 'de_DE',
    nativeName: 'Deutsch',
    englishName: 'German',
  },
  {
    code: 'nl',
    htmlLang: 'nl',
    hrefLang: 'nl',
    ogLocale: 'nl_NL',
    nativeName: 'Nederlands',
    englishName: 'Dutch',
  },
  {
    code: 'it',
    htmlLang: 'it',
    hrefLang: 'it',
    ogLocale: 'it_IT',
    nativeName: 'Italiano',
    englishName: 'Italian',
  },
  {
    code: 'pl',
    htmlLang: 'pl',
    hrefLang: 'pl',
    ogLocale: 'pl_PL',
    nativeName: 'Polski',
    englishName: 'Polish',
  },
  {
    code: 'ru',
    htmlLang: 'ru',
    hrefLang: 'ru',
    ogLocale: 'ru_RU',
    nativeName: 'Русский',
    englishName: 'Russian',
  },
  {
    code: 'tr',
    htmlLang: 'tr',
    hrefLang: 'tr',
    ogLocale: 'tr_TR',
    nativeName: 'Türkçe',
    englishName: 'Turkish',
  },
  {
    code: 'id',
    htmlLang: 'id',
    hrefLang: 'id',
    ogLocale: 'id_ID',
    nativeName: 'Bahasa Indonesia',
    englishName: 'Indonesian',
  },
  {
    code: 'vi',
    htmlLang: 'vi',
    hrefLang: 'vi',
    ogLocale: 'vi_VN',
    nativeName: 'Tiếng Việt',
    englishName: 'Vietnamese',
  },
  {
    code: 'th',
    htmlLang: 'th',
    hrefLang: 'th',
    ogLocale: 'th_TH',
    nativeName: 'ไทย',
    englishName: 'Thai',
  },
] as const;

export type LanguageCode = (typeof LANGUAGE_OPTIONS)[number]['code'];

const DEFAULT_LANGUAGE: LanguageCode = 'en';

const LANGUAGE_CODES = new Set<string>(LANGUAGE_OPTIONS.map(({ code }) => code));

function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && LANGUAGE_CODES.has(value);
}

function normalizeLanguageCode(value: unknown): LanguageCode | null {
  const normalized = String(value ?? '')
    .trim()
    .replace(/_/gu, '-')
    .toLowerCase();
  return isLanguageCode(normalized) ? normalized : null;
}

export function localizedAppPath(code: LanguageCode): string {
  return code === DEFAULT_LANGUAGE ? '/' : `/${code}/`;
}

export function localizedAboutPath(code: LanguageCode): string {
  return code === DEFAULT_LANGUAGE ? '/about' : `/${code}/about`;
}

export function appLanguageFromPathname(pathname: string): LanguageCode | null {
  const normalized = String(pathname || '/').toLowerCase();
  const match = /^\/([^/]+)(?:\/|\/index\.html)$/u.exec(normalized);
  const code = normalizeLanguageCode(match?.[1]);
  return code && code !== DEFAULT_LANGUAGE ? code : null;
}
