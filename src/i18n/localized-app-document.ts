import {
  appLanguageFromPathname,
  localizedAppEntryPath,
  localizedAppPath,
  type LanguageCode,
} from './locales.ts';

type LocalizedAppPathUpdate = 'unowned' | 'unchanged' | 'replaced' | 'navigating';

export function currentAppPathLanguage(): LanguageCode | null {
  try {
    return appLanguageFromPathname(window.location.pathname);
  } catch {
    return null;
  }
}

export function updateKnownLocalizedAppUrlMetadata(code: LanguageCode): void {
  const url = `https://musixquare.com${localizedAppPath(code)}`;
  document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute('href', url);
  document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.setAttribute('content', url);
}

function requestFullDocumentNavigation(href: string): boolean {
  try {
    const navigationRequest = new CustomEvent<{ href: string }>('mxqr:locale-navigation-request', {
      cancelable: true,
      detail: { href },
    });
    if (!window.dispatchEvent(navigationRequest)) return true;
  } catch {
    /* CustomEvent may be unavailable in restricted or embedded contexts. */
  }

  try {
    window.location.assign(href);
    return true;
  } catch {
    return false;
  }
}

function isCanonicalRootAppPath(): boolean {
  try {
    return window.location.pathname === '/' || window.location.pathname === '/index.html';
  } catch {
    return false;
  }
}

export function currentAppPathMatchesLanguage(code: LanguageCode): boolean {
  const currentLanguage = currentAppPathLanguage();
  return currentLanguage === code || (code === 'en' && isCanonicalRootAppPath());
}

/**
 * Keep the canonical root English, and replace it or one explicit locale entry
 * with the selected locale without adding history or discarding live app
 * state. Six-digit room URLs and every other non-locale path remain unowned. A
 * real navigation remains the fail-safe for browsers whose History API is
 * unavailable, throws, or silently no-ops.
 */
export function updateLocalizedAppPath(resolved: LanguageCode): LocalizedAppPathUpdate {
  const currentLanguage = currentAppPathLanguage();
  const ownsCanonicalRoot = currentLanguage === null && isCanonicalRootAppPath();
  if (currentLanguage === null && !ownsCanonicalRoot) return 'unowned';

  const nextPath = ownsCanonicalRoot && resolved === 'en' ? '/' : localizedAppEntryPath(resolved);
  if (window.location.pathname === nextPath) return 'unchanged';

  const search = window.location.search;
  const hash = window.location.hash;
  const href = `${nextPath}${search}${hash}`;
  try {
    window.history.replaceState(window.history.state, '', href);
    if (
      window.location.pathname === nextPath &&
      window.location.search === search &&
      window.location.hash === hash
    ) {
      updateKnownLocalizedAppUrlMetadata(resolved);
      return 'replaced';
    }
  } catch {
    /* Fall through to a full document navigation. */
  }

  return requestFullDocumentNavigation(href) ? 'navigating' : 'unchanged';
}
