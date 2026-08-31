import {
  appLanguageFromPathname,
  LANGUAGE_OPTIONS,
  languageDirection,
  localizedAppEntryPath,
  localizedAppPath,
  type LanguageCode,
} from './locales.ts';

const SITE_ORIGIN = 'https://musixquare.com';

const LOCALIZED_META_SELECTORS = [
  'meta[name="description"]',
  'meta[property="og:title"]',
  'meta[property="og:description"]',
  'meta[property="og:url"]',
  'meta[property="og:image:alt"]',
  'meta[property="og:locale"]',
  'meta[name="twitter:title"]',
  'meta[name="twitter:description"]',
] as const;

type LocalizedAppPathUpdate = 'unowned' | 'unchanged' | 'replaced' | 'navigating';

let _headSyncGeneration = 0;
let _headSyncController: AbortController | null = null;

export function currentAppPathLanguage(): LanguageCode | null {
  try {
    return appLanguageFromPathname(window.location.pathname);
  } catch {
    return null;
  }
}

function expectedCanonicalUrl(code: LanguageCode): string {
  return `${SITE_ORIGIN}${localizedAppPath(code)}`;
}

function updateKnownUrlMetadata(code: LanguageCode): void {
  const canonicalUrl = expectedCanonicalUrl(code);
  try {
    document
      .querySelector<HTMLLinkElement>('link[rel="canonical"]')
      ?.setAttribute('href', canonicalUrl);
    document
      .querySelector<HTMLMetaElement>('meta[property="og:url"]')
      ?.setAttribute('content', canonicalUrl);
  } catch {
    /* Metadata synchronization is best-effort; the URL change remains authoritative. */
  }
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

/**
 * Replace one explicit locale entry with another without adding history or
 * discarding live room/app state. A real navigation remains the fail-safe for
 * browsers whose History API is unavailable, throws, or silently no-ops.
 */
export function updateLocalizedAppPath(resolved: LanguageCode): LocalizedAppPathUpdate {
  if (currentAppPathLanguage() === null) return 'unowned';

  const nextPath = localizedAppEntryPath(resolved);
  if (window.location.pathname === nextPath) return 'unchanged';

  const href = `${nextPath}${window.location.search}${window.location.hash}`;
  try {
    window.history.replaceState(window.history.state, '', href);
    if (
      window.location.pathname === nextPath &&
      window.location.search + window.location.hash ===
        `${new URL(href, window.location.href).search}${new URL(href, window.location.href).hash}`
    ) {
      updateKnownUrlMetadata(resolved);
      return 'replaced';
    }
  } catch {
    /* Fall through to a full document navigation. */
  }

  return requestFullDocumentNavigation(href) ? 'navigating' : 'unchanged';
}

export function cancelLocalizedAppHeadSync(): void {
  _headSyncGeneration += 1;
  _headSyncController?.abort();
  _headSyncController = null;
}

function requiredHeadSnapshot(documentToRead: Document): ReadonlyMap<string, string> | null {
  const snapshot = new Map<string, string>();
  for (const selector of LOCALIZED_META_SELECTORS) {
    const content = documentToRead.querySelector<HTMLMetaElement>(selector)?.content.trim();
    if (!content) return null;
    snapshot.set(selector, content);
  }
  return snapshot;
}

function copyOpenGraphAlternates(source: Document): void {
  const targetPrimary = document.querySelector<HTMLMetaElement>('meta[property="og:locale"]');
  if (!targetPrimary) return;

  for (const alternate of document.querySelectorAll('meta[property="og:locale:alternate"]')) {
    alternate.remove();
  }

  let insertionPoint: Element = targetPrimary;
  for (const sourceAlternate of source.querySelectorAll<HTMLMetaElement>(
    'meta[property="og:locale:alternate"]',
  )) {
    const alternate = document.createElement('meta');
    alternate.setAttribute('property', 'og:locale:alternate');
    alternate.content = sourceAlternate.content;
    insertionPoint.insertAdjacentElement('afterend', alternate);
    insertionPoint = alternate;
  }
}

function copyWebsiteSchema(source: Document): void {
  for (const schema of document.querySelectorAll('[data-mxqr-website-schema]')) schema.remove();

  const sourceSchema = source.querySelector<HTMLScriptElement>('[data-mxqr-website-schema]');
  if (!sourceSchema) return;

  const schema = document.createElement('script');
  schema.type = 'application/ld+json';
  schema.setAttribute('data-mxqr-website-schema', '');
  schema.textContent = sourceSchema.textContent;
  document.head.appendChild(schema);
}

function applyLocalizedHead(source: Document, snapshot: ReadonlyMap<string, string>): void {
  const previousPageTitle = document
    .querySelector<HTMLMetaElement>('meta[property="og:title"]')
    ?.content.trim();
  const pageOwnsTitle = !previousPageTitle || document.title === previousPageTitle;

  for (const [selector, content] of snapshot) {
    document.querySelector<HTMLMetaElement>(selector)?.setAttribute('content', content);
  }

  const sourceCanonical = source.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  const targetCanonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (sourceCanonical && targetCanonical) targetCanonical.href = sourceCanonical.href;

  copyOpenGraphAlternates(source);
  copyWebsiteSchema(source);
  if (pageOwnsTitle) document.title = source.title;
}

function isExpectedLocalizedDocument(source: Document, code: LanguageCode): boolean {
  const option = LANGUAGE_OPTIONS.find((candidate) => candidate.code === code);
  const canonical = source.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  const openGraphUrl = source.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content;
  return Boolean(
    option &&
    source.documentElement.lang === option.htmlLang &&
    source.documentElement.dir === languageDirection(code) &&
    canonical === expectedCanonicalUrl(code) &&
    openGraphUrl === expectedCanonicalUrl(code) &&
    source.title.trim(),
  );
}

/**
 * Copy the exact build-materialized metadata for an interactively selected
 * locale. The visible translation has already completed when this begins;
 * network or parsing failure therefore cannot roll back the language or URL.
 */
export async function synchronizeLocalizedAppHead(
  code: LanguageCode,
  isCurrent: () => boolean,
): Promise<boolean> {
  cancelLocalizedAppHeadSync();
  const generation = _headSyncGeneration;
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  _headSyncController = controller;

  try {
    const response = await fetch(localizedAppEntryPath(code), {
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
      signal: controller?.signal,
    });
    if (!response.ok) return false;

    const source = new DOMParser().parseFromString(await response.text(), 'text/html');
    const snapshot = requiredHeadSnapshot(source);
    if (!snapshot || !isExpectedLocalizedDocument(source, code)) return false;
    if (generation !== _headSyncGeneration || !isCurrent() || currentAppPathLanguage() !== code) {
      return false;
    }

    applyLocalizedHead(source, snapshot);
    return true;
  } catch {
    return false;
  } finally {
    if (generation === _headSyncGeneration) _headSyncController = null;
  }
}
