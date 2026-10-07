import en from './en.ts';
import { PLURAL_PARAM_BY_KEY, type LocalePluralMessages } from './plural-contract.ts';
import type { LanguageCode } from './locales.ts';

export interface LocaleModule {
  readonly default: Record<string, string>;
  readonly pluralMessages?: LocalePluralMessages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecovery(code: LanguageCode, value: unknown): LocaleModule {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.locale !== code ||
    !isRecord(value.dictionary)
  ) {
    throw new Error('Invalid locale recovery data');
  }
  const dictionary = value.dictionary;
  const keys = Object.keys(en);
  if (
    Object.keys(dictionary).length !== keys.length ||
    keys.some((key) => typeof dictionary[key] !== 'string')
  ) {
    throw new Error('Incomplete locale recovery dictionary');
  }
  const forms = value.pluralMessages;
  if (!isRecord(forms)) throw new Error('Invalid locale recovery plurals');
  for (const [key, categories] of Object.entries(forms)) {
    if (!Object.prototype.hasOwnProperty.call(PLURAL_PARAM_BY_KEY, key) || !isRecord(categories)) {
      throw new Error('Unknown locale recovery plural key');
    }
    for (const [category, text] of Object.entries(categories)) {
      if (
        !['zero', 'one', 'two', 'few', 'many', 'other'].includes(category) ||
        typeof text !== 'string'
      ) {
        throw new Error('Invalid locale recovery plural form');
      }
    }
  }
  return {
    default: dictionary as Record<string, string>,
    pluralMessages: forms as LocalePluralMessages,
  };
}

/** Fetch data only; retry never evaluates source, rewrites import URLs, or reloads an active room. */
export async function loadLocaleRecovery(code: LanguageCode): Promise<LocaleModule> {
  const urls =
    typeof __MXQR_LOCALE_RECOVERY_URLS__ === 'undefined' ? {} : __MXQR_LOCALE_RECOVERY_URLS__;
  const url = urls[code];
  if (!url) throw new Error(`Locale recovery asset unavailable: ${code}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Locale recovery failed: ${response.status}`);
  return parseRecovery(code, await response.json());
}
