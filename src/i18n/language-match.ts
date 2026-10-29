/**
 * Language matching shared by the App and the public translation page, so a
 * visitor sees both in the same language. Pure: callers pass the tags.
 */

import { LANGUAGE_OPTIONS, type LanguageCode } from './locales.ts';

type LanguagePreferences = Partial<Pick<Navigator, 'language' | 'languages'>>;

/** Map one browser or stored language tag to a supported language, or `null`. */
export function matchLanguage(value: string | null | undefined): LanguageCode | null {
  const normalized = String(value || '')
    .trim()
    .replace(/_/g, '-')
    .toLowerCase();
  if (!normalized) return null;

  if (normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) return 'zh-hans';
  if (normalized === 'zh-hant' || normalized.startsWith('zh-hant-')) return 'zh-hant';
  if (normalized.startsWith('zh')) {
    if (
      normalized.includes('tw') ||
      normalized.includes('hk') ||
      normalized.includes('mo') ||
      normalized.includes('hant')
    ) {
      return 'zh-hant';
    }
    return 'zh-hans';
  }

  if (normalized === 'pt-br' || normalized.startsWith('pt-br-')) return 'pt-br';
  if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt-br';
  if (normalized === 'in' || normalized.startsWith('in-')) return 'id';
  if (normalized === 'iw' || normalized.startsWith('iw-')) return 'he';
  if (normalized === 'no' || normalized.startsWith('no-')) return 'nb';
  if (normalized === 'tl' || normalized.startsWith('tl-')) return 'fil';

  const primary = normalized.split('-')[0];
  if (LANGUAGE_OPTIONS.some((lang) => lang.code === primary)) return primary as LanguageCode;
  return null;
}

/** The first supported browser preference, in order, or English. */
export function resolvePreferredLanguage(preferences: LanguagePreferences): LanguageCode {
  const languages = preferences.languages?.length
    ? preferences.languages
    : [preferences.language || ''];
  for (const language of languages) {
    const matched = matchLanguage(language);
    if (matched) return matched;
  }
  return 'en';
}
