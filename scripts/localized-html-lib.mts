import { JSDOM } from 'jsdom';

import { APP_DICTIONARIES, type TranslationDictionary } from '../src/i18n/catalogs.ts';
import { localeSeoMetadata } from './locale-seo-metadata.mts';
import {
  LANGUAGE_OPTIONS,
  languageDirection,
  localizedAboutPath,
  localizedAppEntryPath,
  localizedAppPath,
  type LanguageCode,
} from '../src/i18n/locales.ts';

export { APP_DICTIONARIES } from '../src/i18n/catalogs.ts';

export const SITE_ORIGIN = 'https://musixquare.com';

const APP_ATTRIBUTE_BINDINGS = [
  ['placeholder', 'data-i18n-placeholder'],
  ['aria-label', 'data-i18n-aria-label'],
  ['title', 'data-i18n-title'],
  ['alt', 'data-i18n-alt'],
  ['data-placeholder', 'data-i18n-data-placeholder'],
] as const;

interface AboutMetadata {
  readonly description: string;
  readonly ogDescription: string;
  readonly ogImageAlt: string;
  readonly twitterDescription: string;
}

function requireTranslation(dictionary: TranslationDictionary, key: string): string {
  const value = dictionary[key];
  if (value === undefined) throw new Error(`Missing app translation key: ${key}`);
  return value;
}

export function applyAppDictionary(document: Document, code: LanguageCode): void {
  const dictionary = APP_DICTIONARIES[code];

  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-html]')) {
    const key = element.getAttribute('data-i18n-html');
    if (key) element.innerHTML = requireTranslation(dictionary, key);
  }

  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    if (element.hasAttribute('data-i18n-html')) continue;
    const key = element.getAttribute('data-i18n');
    if (key) element.textContent = requireTranslation(dictionary, key);
  }

  for (const [attribute, binding] of APP_ATTRIBUTE_BINDINGS) {
    for (const element of document.querySelectorAll<HTMLElement>(`[${binding}]`)) {
      const key = element.getAttribute(binding);
      if (key) element.setAttribute(attribute, requireTranslation(dictionary, key));
    }
  }

  const aboutPath = localizedAboutPath(code);
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href="/about"]')) {
    link.setAttribute('href', aboutPath);
  }
}

function meta(document: Document, selector: string): HTMLMetaElement {
  const element = document.querySelector<HTMLMetaElement>(selector);
  if (!element) throw new Error(`Required metadata element is missing: ${selector}`);
  return element;
}

function canonical(document: Document): HTMLLinkElement {
  const element = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!element) throw new Error('Required canonical link is missing.');
  return element;
}

function replaceAlternateLinks(document: Document, page: 'app' | 'about'): void {
  for (const element of document.querySelectorAll('link[rel="alternate"][hreflang]')) {
    element.remove();
  }

  const canonicalElement = canonical(document);
  for (const option of LANGUAGE_OPTIONS) {
    const link = document.createElement('link');
    link.rel = 'alternate';
    link.hreflang = localeSeoMetadata(option.code).hrefLang;
    const path = page === 'app' ? localizedAppPath(option.code) : localizedAboutPath(option.code);
    link.href = `${SITE_ORIGIN}${path}`;
    canonicalElement.insertAdjacentElement('afterend', link);
  }

  const fallback = document.createElement('link');
  fallback.rel = 'alternate';
  fallback.hreflang = 'x-default';
  fallback.href = `${SITE_ORIGIN}${page === 'app' ? '/' : '/about'}`;
  canonicalElement.insertAdjacentElement('afterend', fallback);
}

function replaceOpenGraphLocales(document: Document, code: LanguageCode): void {
  meta(document, 'meta[property="og:locale"]').content = localeSeoMetadata(code).ogLocale;
  for (const element of document.querySelectorAll('meta[property="og:locale:alternate"]')) {
    element.remove();
  }
  const primary = meta(document, 'meta[property="og:locale"]');
  for (const option of LANGUAGE_OPTIONS) {
    if (option.code === code) continue;
    const alternate = document.createElement('meta');
    alternate.setAttribute('property', 'og:locale:alternate');
    alternate.content = localeSeoMetadata(option.code).ogLocale;
    primary.insertAdjacentElement('afterend', alternate);
  }
}

function replaceWebsiteSchema(document: Document, include: boolean): void {
  for (const element of document.querySelectorAll('[data-mxqr-website-schema]')) element.remove();
  if (!include) return;

  const schema = document.createElement('script');
  schema.type = 'application/ld+json';
  schema.setAttribute('data-mxqr-website-schema', '');
  schema.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_ORIGIN}/#website`,
    url: `${SITE_ORIGIN}/`,
    name: 'MUSIXQUARE',
    alternateName: ['뮤직스퀘어', 'ミュージックスクエア', 'musixquare.com'],
    sameAs: ['https://x.com/musixquare', 'https://github.com/hiefny/MUSIXQUARE'],
    inLanguage: 'en',
  });
  document.head.appendChild(schema);
}

function preserveAboutLocaleAcrossEditorialPages(document: Document, code: LanguageCode): void {
  if (code === 'en') return;
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    'a[href="/blog"], a[href="/history"], a[href="/designsystem"]',
  )) {
    const target = new URL(link.href, SITE_ORIGIN);
    target.searchParams.set('lang', code);
    link.setAttribute('href', target.pathname + target.search + target.hash);
  }
}

function removeNonLicenseComments(document: Document): void {
  const comments: Comment[] = [];
  const walker = document.createTreeWalker(document, 128 /* NodeFilter.SHOW_COMMENT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (
      node.nodeType === 8 &&
      !String(node.nodeValue || '')
        .trim()
        .startsWith('MUSIXQUARE-authored file:')
    ) {
      comments.push(node as Comment);
    }
  }
  for (const comment of comments) comment.remove();
}

function removeWhitespaceOnlyTextNodes(root: Node): void {
  const whitespaceNodes: Text[] = [];
  const walker = root.ownerDocument!.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 3 && !String(node.nodeValue || '').trim()) {
      whitespaceNodes.push(node as Text);
    }
  }
  for (const node of whitespaceNodes) node.remove();
}

export function localizeAppDocument(
  document: Document,
  code: LanguageCode,
  aboutMetadata: AboutMetadata,
): void {
  const option = LANGUAGE_OPTIONS.find((candidate) => candidate.code === code);
  if (!option) throw new Error(`Unsupported app locale: ${code}`);

  applyAppDictionary(document, code);
  document.documentElement.lang = option.htmlLang;
  document.documentElement.dir = languageDirection(code);

  const dictionary = APP_DICTIONARIES[code];
  const title = requireTranslation(dictionary, 'app.search_title');
  const description = requireTranslation(dictionary, 'app.search_description');
  const pageUrl = `${SITE_ORIGIN}${localizedAppPath(code)}`;
  const manifest = document.querySelector<HTMLLinkElement>('#app-manifest[rel~="manifest"]');

  document.title = title;
  meta(document, 'meta[name="description"]').content = description;
  meta(document, 'meta[property="og:title"]').content = title;
  meta(document, 'meta[property="og:description"]').content = description;
  meta(document, 'meta[property="og:url"]').content = pageUrl;
  meta(document, 'meta[property="og:image:alt"]').content = aboutMetadata.ogImageAlt;
  meta(document, 'meta[name="twitter:title"]').content = title;
  meta(document, 'meta[name="twitter:description"]').content = description;
  canonical(document).href = pageUrl;
  if (code === 'en') manifest?.removeAttribute('href');
  else manifest?.setAttribute('href', `/manifests/${code}.webmanifest`);

  replaceAlternateLinks(document, 'app');
  replaceOpenGraphLocales(document, code);
  replaceWebsiteSchema(document, code === 'en');
}

export function localizeAboutDocument(document: Document, code: LanguageCode): AboutMetadata {
  const option = LANGUAGE_OPTIONS.find((candidate) => candidate.code === code);
  if (!option) throw new Error(`Unsupported About locale: ${code}`);

  document.documentElement.lang = option.htmlLang;
  document.documentElement.dir = languageDirection(code);
  const pagePath = localizedAboutPath(code);
  const pageUrl = `${SITE_ORIGIN}${pagePath}`;
  canonical(document).href = pageUrl;
  meta(document, 'meta[property="og:url"]').content = pageUrl;
  replaceAlternateLinks(document, 'about');
  replaceOpenGraphLocales(document, code);
  replaceWebsiteSchema(document, false);

  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href="/about"]')) {
    link.setAttribute('href', pagePath);
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    'a[href="https://musixquare.com"]',
  )) {
    link.setAttribute('href', localizedAppEntryPath(code));
  }
  preserveAboutLocaleAcrossEditorialPages(document, code);

  return {
    description: meta(document, 'meta[name="description"]').content,
    ogDescription: meta(document, 'meta[property="og:description"]').content,
    ogImageAlt: meta(document, 'meta[property="og:image:alt"]').content,
    twitterDescription: meta(document, 'meta[name="twitter:description"]').content,
  };
}

export function renderLocalizedAbout(
  aboutHtml: string,
  landingI18nJavaScript: string,
  code: LanguageCode,
): { readonly html: string; readonly metadata: AboutMetadata } {
  const dom = new JSDOM(aboutHtml, {
    runScripts: 'outside-only',
    url: `${SITE_ORIGIN}${localizedAboutPath(code)}`,
  });
  dom.window.__landingLang = code;
  dom.window.eval(landingI18nJavaScript);
  const metadata = localizeAboutDocument(dom.window.document, code);
  const html = dom.serialize();
  dom.window.close();
  return { html, metadata };
}

export function renderLocalizedApp(
  appHtml: string,
  code: LanguageCode,
  aboutMetadata: AboutMetadata,
): string {
  const dom = new JSDOM(appHtml, { url: `${SITE_ORIGIN}${localizedAppPath(code)}` });
  localizeAppDocument(dom.window.document, code, aboutMetadata);
  // Production comments and source indentation are not user-visible and add
  // several compressed KiB to every localized app shell. Keep the authored-
  // license marker while the source remains fully documented and formatted.
  removeNonLicenseComments(dom.window.document);
  removeWhitespaceOnlyTextNodes(dom.window.document.head);
  for (const svg of dom.window.document.querySelectorAll('svg')) {
    removeWhitespaceOnlyTextNodes(svg);
  }
  const html = dom
    .serialize()
    .replace(/^[\t ]+/gmu, '')
    .replace(/\n{2,}/gu, '\n');
  dom.window.close();
  return html;
}
