import type { LanguageCode } from '../src/i18n/locales.ts';

export interface LocaleSeoMetadata {
  readonly hrefLang: string;
  readonly ogLocale: string;
}

/** Build-time-only search/social metadata kept out of the browser runtime catalog. */
const LOCALE_SEO_METADATA = {
  en: { hrefLang: 'en', ogLocale: 'en_US' },
  ko: { hrefLang: 'ko', ogLocale: 'ko_KR' },
  ja: { hrefLang: 'ja', ogLocale: 'ja_JP' },
  'zh-hans': { hrefLang: 'zh-Hans', ogLocale: 'zh_CN' },
  'zh-hant': { hrefLang: 'zh-Hant', ogLocale: 'zh_TW' },
  es: { hrefLang: 'es', ogLocale: 'es_ES' },
  'pt-br': { hrefLang: 'pt-BR', ogLocale: 'pt_BR' },
  fr: { hrefLang: 'fr', ogLocale: 'fr_FR' },
  de: { hrefLang: 'de', ogLocale: 'de_DE' },
  nl: { hrefLang: 'nl', ogLocale: 'nl_NL' },
  it: { hrefLang: 'it', ogLocale: 'it_IT' },
  pl: { hrefLang: 'pl', ogLocale: 'pl_PL' },
  ru: { hrefLang: 'ru', ogLocale: 'ru_RU' },
  tr: { hrefLang: 'tr', ogLocale: 'tr_TR' },
  id: { hrefLang: 'id', ogLocale: 'id_ID' },
  vi: { hrefLang: 'vi', ogLocale: 'vi_VN' },
  th: { hrefLang: 'th', ogLocale: 'th_TH' },
  hi: { hrefLang: 'hi', ogLocale: 'hi_IN' },
  bn: { hrefLang: 'bn', ogLocale: 'bn_BD' },
  ta: { hrefLang: 'ta', ogLocale: 'ta_IN' },
  te: { hrefLang: 'te', ogLocale: 'te_IN' },
  ms: { hrefLang: 'ms', ogLocale: 'ms_MY' },
  // Google Search only accepts ISO 639-1 language codes in hreflang. Filipino
  // has no ISO 639-1 code, so use its supported Tagalog code for the search
  // annotation while keeping the document's valid BCP 47 `fil-PH` language.
  fil: { hrefLang: 'tl-PH', ogLocale: 'fil_PH' },
  ar: { hrefLang: 'ar', ogLocale: 'ar_SA' },
  ur: { hrefLang: 'ur', ogLocale: 'ur_PK' },
  he: { hrefLang: 'he', ogLocale: 'he_IL' },
  uk: { hrefLang: 'uk', ogLocale: 'uk_UA' },
  ro: { hrefLang: 'ro', ogLocale: 'ro_RO' },
  cs: { hrefLang: 'cs', ogLocale: 'cs_CZ' },
  el: { hrefLang: 'el', ogLocale: 'el_GR' },
  fa: { hrefLang: 'fa', ogLocale: 'fa_IR' },
  mr: { hrefLang: 'mr', ogLocale: 'mr_IN' },
  gu: { hrefLang: 'gu', ogLocale: 'gu_IN' },
  kn: { hrefLang: 'kn', ogLocale: 'kn_IN' },
  ml: { hrefLang: 'ml', ogLocale: 'ml_IN' },
  pa: { hrefLang: 'pa', ogLocale: 'pa_IN' },
  sv: { hrefLang: 'sv', ogLocale: 'sv_SE' },
  da: { hrefLang: 'da', ogLocale: 'da_DK' },
  nb: { hrefLang: 'nb', ogLocale: 'nb_NO' },
  fi: { hrefLang: 'fi', ogLocale: 'fi_FI' },
  hu: { hrefLang: 'hu', ogLocale: 'hu_HU' },
  bg: { hrefLang: 'bg', ogLocale: 'bg_BG' },
} as const satisfies Readonly<Record<LanguageCode, LocaleSeoMetadata>>;

export function localeSeoMetadata(code: LanguageCode): LocaleSeoMetadata {
  return LOCALE_SEO_METADATA[code];
}
