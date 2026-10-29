import { LANGUAGE_OPTIONS } from '../../src/i18n/locales';
import { resolvePreferredLanguage } from '../../src/i18n/language-match';

/** The phrase selected when the address names none that the catalog holds. */
export const DEFAULT_PHRASE_ID = 'about:hero.h1';
// Copy of the bound in cloudflare/account-auth.ts, pinned by a parity test. The
// Worker replaces a longer returnTo with `/`, which would lose this page.
const RETURN_TO_MAX_UTF8_BYTES = 1024;

export interface TranslateAddress {
  /** A supported catalog code. */
  locale: string;
  /** Untrusted. Only ever compared with catalog ids. */
  phrase: string | null;
}

/** ?locale when it is a supported code, else the browser language as the App matches it. */
export function readTranslateAddress(
  search: string,
  preferences: Partial<Pick<Navigator, 'language' | 'languages'>>,
): TranslateAddress {
  const params = new URLSearchParams(search);
  const requested = params.get('locale');
  const supported = LANGUAGE_OPTIONS.find(({ code }) => code === requested)?.code;
  return {
    locale: supported ?? resolvePreferredLanguage(preferences),
    phrase: params.get('phrase'),
  };
}

type SignInResult = 'success' | 'cancelled' | 'error';

/** The Worker's `accountAuth` sign-in marker, and the query without it. */
export function takeSignInResult(search: string): {
  result: SignInResult | null;
  search: string;
} {
  const params = new URLSearchParams(search);
  if (!params.has('accountAuth')) return { result: null, search };
  const value = params.get('accountAuth');
  params.delete('accountAuth');
  const rest = `${params}`;
  return {
    result: value === 'success' || value === 'cancelled' || value === 'error' ? value : null,
    search: rest ? `?${rest}` : '',
  };
}

/** The current query with this page's locale and phrase set; other parameters stay. */
export function translateAddressSearch(search: string, locale: string, phrase: string): string {
  const params = new URLSearchParams(search);
  params.set('locale', locale);
  params.set('phrase', phrase);
  return `?${params}`;
}

/**
 * Return after sign-in to the shown language and catalog phrase. Raw query text is
 * never carried. The phrase is dropped when the Worker would reject the length.
 */
export function translateSignInReturn(
  pathname: string,
  locale: string,
  phrase: string | null,
): string {
  if (phrase) {
    const withPhrase = `${pathname}?${new URLSearchParams({ locale, phrase })}`;
    if (new TextEncoder().encode(withPhrase).byteLength <= RETURN_TO_MAX_UTF8_BYTES) {
      return withPhrase;
    }
  }
  return `${pathname}?${new URLSearchParams({ locale })}`;
}
