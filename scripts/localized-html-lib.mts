import { JSDOM } from 'jsdom';

import de from '../src/i18n/de.ts';
import en from '../src/i18n/en.ts';
import es from '../src/i18n/es.ts';
import fr from '../src/i18n/fr.ts';
import id from '../src/i18n/id.ts';
import it from '../src/i18n/it.ts';
import ja from '../src/i18n/ja.ts';
import ko from '../src/i18n/ko.ts';
import nl from '../src/i18n/nl.ts';
import pl from '../src/i18n/pl.ts';
import ptBr from '../src/i18n/pt-br.ts';
import ru from '../src/i18n/ru.ts';
import th from '../src/i18n/th.ts';
import tr from '../src/i18n/tr.ts';
import vi from '../src/i18n/vi.ts';
import zhHans from '../src/i18n/zh-hans.ts';
import zhHant from '../src/i18n/zh-hant.ts';
import {
  LANGUAGE_OPTIONS,
  localizedAboutPath,
  localizedAppPath,
  type LanguageCode,
} from '../src/i18n/locales.ts';

export const SITE_ORIGIN = 'https://musixquare.com';

type TranslationDictionary = Readonly<Record<string, string>>;

export const APP_DICTIONARIES: Readonly<Record<LanguageCode, TranslationDictionary>> = {
  de,
  en,
  es,
  fr,
  id,
  it,
  ja,
  ko,
  nl,
  pl,
  'pt-br': ptBr,
  ru,
  th,
  tr,
  vi,
  'zh-hans': zhHans,
  'zh-hant': zhHant,
};

const APP_ATTRIBUTE_BINDINGS = [
  ['placeholder', 'data-i18n-placeholder'],
  ['aria-label', 'data-i18n-aria-label'],
  ['title', 'data-i18n-title'],
  ['alt', 'data-i18n-alt'],
  ['data-placeholder', 'data-i18n-data-placeholder'],
] as const;

const APP_SEARCH_TITLES: Readonly<Partial<Record<LanguageCode, string>>> = {
  ko: '뮤직스퀘어 | MUSIXQUARE',
  ja: 'ミュージックスクエア | MUSIXQUARE',
};

const APP_SEARCH_DESCRIPTIONS: Readonly<Partial<Record<LanguageCode, string>>> = {
  en: 'Turn phones, tablets, desktops into a synchronized wireless audio system.',
  ko: '여러 기기를 연결해 동기화된 서라운드 사운드를 만들어 보세요.',
};

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
    link.hreflang = option.hrefLang;
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
  meta(document, 'meta[property="og:locale"]').content =
    LANGUAGE_OPTIONS.find((option) => option.code === code)?.ogLocale ?? 'en_US';
  for (const element of document.querySelectorAll('meta[property="og:locale:alternate"]')) {
    element.remove();
  }
  const primary = meta(document, 'meta[property="og:locale"]');
  for (const option of LANGUAGE_OPTIONS) {
    if (option.code === code) continue;
    const alternate = document.createElement('meta');
    alternate.setAttribute('property', 'og:locale:alternate');
    alternate.content = option.ogLocale;
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
    inLanguage: 'en',
  });
  document.head.appendChild(schema);
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

export function localizeAppDocument(
  document: Document,
  code: LanguageCode,
  aboutMetadata: AboutMetadata,
): void {
  const option = LANGUAGE_OPTIONS.find((candidate) => candidate.code === code);
  if (!option) throw new Error(`Unsupported app locale: ${code}`);

  applyAppDictionary(document, code);
  document.documentElement.lang = option.htmlLang;

  const title = APP_SEARCH_TITLES[code] ?? 'MUSIXQUARE';
  const description = APP_SEARCH_DESCRIPTIONS[code] ?? aboutMetadata.description;
  const pageUrl = `${SITE_ORIGIN}${localizedAppPath(code)}`;

  document.title = title;
  meta(document, 'meta[name="description"]').content = description;
  meta(document, 'meta[property="og:title"]').content = title;
  meta(document, 'meta[property="og:description"]').content = aboutMetadata.ogDescription;
  meta(document, 'meta[property="og:url"]').content = pageUrl;
  meta(document, 'meta[property="og:image:alt"]').content = aboutMetadata.ogImageAlt;
  meta(document, 'meta[name="twitter:title"]').content = title;
  meta(document, 'meta[name="twitter:description"]').content = aboutMetadata.twitterDescription;
  canonical(document).href = pageUrl;

  replaceAlternateLinks(document, 'app');
  replaceOpenGraphLocales(document, code);
  replaceWebsiteSchema(document, code === 'en');
}

export function localizeAboutDocument(document: Document, code: LanguageCode): AboutMetadata {
  const option = LANGUAGE_OPTIONS.find((candidate) => candidate.code === code);
  if (!option) throw new Error(`Unsupported About locale: ${code}`);

  document.documentElement.lang = option.htmlLang;
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
    link.setAttribute('href', localizedAppPath(code));
  }

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
  const html = dom.serialize().replace(/^[\t ]+/gmu, '');
  dom.window.close();
  return html;
}
