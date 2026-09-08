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
 * The shared root keeps its URL and canonical while its UI follows the user's
 * language. Only explicit locale entries switch paths, without adding history
 * or discarding live app state. Room URLs and other paths remain unowned. A
 * real navigation remains the fail-safe for browsers whose History API is
 * unavailable, throws, or silently no-ops.
 */
export function updateLocalizedAppPath(resolved: LanguageCode): LocalizedAppPathUpdate {
  if (isCanonicalRootAppPath()) {
    updateKnownLocalizedAppUrlMetadata('en');
    return 'unchanged';
  }

  const currentLanguage = currentAppPathLanguage();
  if (currentLanguage === null) return 'unowned';

  const nextPath = localizedAppEntryPath(resolved);
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
