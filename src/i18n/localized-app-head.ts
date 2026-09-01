import {
  LANGUAGE_OPTIONS,
  languageDirection,
  localizedAppPath,
  type LanguageCode,
} from './locales.ts';
import { currentAppPathMatchesLanguage } from './localized-app-document.ts';

const META_SELECTORS = [
  'meta[name="description"]',
  'meta[property="og:title"]',
  'meta[property="og:description"]',
  'meta[property="og:url"]',
  'meta[property="og:image"]',
  'meta[property="og:image:alt"]',
  'meta[property="og:locale"]',
  'meta[name="twitter:title"]',
  'meta[name="twitter:description"]',
  'meta[name="twitter:image"]',
] as const;
const OG_ALTERNATE = 'meta[property="og:locale:alternate"]';
const WEBSITE_SCHEMA = '[data-mxqr-website-schema]';

let _generation = 0;
let _controller: AbortController | null = null;

function hasLocalizedHeadTarget(): boolean {
  return (
    Boolean(document.querySelector('link[rel="canonical"]')) &&
    META_SELECTORS.every((selector) => document.querySelector(selector))
  );
}

export function cancelLocalizedAppHeadSync(): void {
  _generation += 1;
  _controller?.abort();
  _controller = null;
}

function expectedCanonicalUrl(code: LanguageCode): string {
  return `https://musixquare.com${localizedAppPath(code)}`;
}

function isExpectedDocument(source: Document, code: LanguageCode): boolean {
  const expectedUrl = expectedCanonicalUrl(code);
  return Boolean(
    source.documentElement.lang ===
      LANGUAGE_OPTIONS.find((candidate) => candidate.code === code)?.htmlLang &&
    source.documentElement.dir === languageDirection(code) &&
    source.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href === expectedUrl &&
    source.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content === expectedUrl &&
    source.title.trim(),
  );
}

function applyLocalizedHead(source: Document, forceDocumentTitle: boolean): boolean {
  const metaPairs = META_SELECTORS.map(
    (selector) =>
      [
        document.querySelector<HTMLMetaElement>(selector),
        source.querySelector<HTMLMetaElement>(selector)?.content.trim(),
      ] as const,
  );
  const sourceCanonical = source.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  const targetCanonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  const sourceAlternates = Array.from(
    source.querySelectorAll<HTMLMetaElement>(OG_ALTERNATE),
    (meta) => meta.content,
  );
  const targetAlternates = document.querySelectorAll<HTMLMetaElement>(OG_ALTERNATE);
  if (
    !sourceCanonical ||
    !targetCanonical ||
    metaPairs.some(([target, content]) => !target || !content) ||
    sourceAlternates.length !== targetAlternates.length
  ) {
    return false;
  }

  const previousPageTitle = document
    .querySelector<HTMLMetaElement>('meta[property="og:title"]')
    ?.content.trim();
  const pageOwnsTitle =
    forceDocumentTitle || !previousPageTitle || document.title === previousPageTitle;
  for (const [target, content] of metaPairs) target!.content = content!;
  targetCanonical.href = sourceCanonical.href;
  targetAlternates.forEach((target, index) => (target.content = sourceAlternates[index]));

  document.querySelector(WEBSITE_SCHEMA)?.remove();
  const sourceSchema = source.querySelector(WEBSITE_SCHEMA);
  if (sourceSchema) document.head.appendChild(sourceSchema.cloneNode(true));
  if (pageOwnsTitle) document.title = source.title;
  return true;
}

/** Copy the exact build-materialized metadata for an interactively selected locale. */
export async function synchronizeLocalizedAppHead(
  code: LanguageCode,
  isCurrent: () => boolean,
  options: { forceDocumentTitle?: boolean } = {},
): Promise<boolean> {
  cancelLocalizedAppHeadSync();
  // Partial/embedded documents cannot accept the complete localized head, so
  // avoid fetching a locale document that applyLocalizedHead must reject.
  if (!hasLocalizedHeadTarget()) return false;

  const generation = _generation;
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  _controller = controller;

  try {
    // English keeps `/en/` as its user-facing locale entry but its canonical
    // document is the root app shell. Fetch the canonical locale document so
    // head synchronization does not depend on an `/en/` rewrite being
    // available (for example, while previewing the static `dist` directory).
    const response = await fetch(localizedAppPath(code), {
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
      signal: controller?.signal,
    });
    if (!response.ok) return false;
    const source = new DOMParser().parseFromString(await response.text(), 'text/html');
    if (
      !isExpectedDocument(source, code) ||
      generation !== _generation ||
      !isCurrent() ||
      !currentAppPathMatchesLanguage(code)
    ) {
      return false;
    }
    return applyLocalizedHead(source, options.forceDocumentTitle === true);
  } catch {
    return false;
  } finally {
    if (generation === _generation) _controller = null;
  }
}
