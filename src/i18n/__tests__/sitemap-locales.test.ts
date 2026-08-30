import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { LANGUAGE_OPTIONS, localizedAboutPath, localizedAppPath } from '../locales.ts';

const ORIGIN = 'https://musixquare.com';
const SITEMAP_PATH = 'public/sitemap.xml';
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

const ENGLISH_ONLY_PAGES = [
  { path: '/blog', lastmod: '2026-07-18', changefreq: 'weekly', priority: '0.8' },
  { path: '/history', lastmod: '2026-08-23', changefreq: 'monthly', priority: '0.8' },
  { path: '/privacy', lastmod: '2026-08-17', changefreq: 'yearly', priority: '0.6' },
  { path: '/terms', lastmod: '2026-08-17', changefreq: 'yearly', priority: '0.6' },
  { path: '/faq', lastmod: '2026-08-17', changefreq: 'monthly', priority: '0.7' },
  { path: '/developers', lastmod: '2026-08-17', changefreq: 'monthly', priority: '0.7' },
  { path: '/designsystem', lastmod: '2026-08-23', changefreq: 'monthly', priority: '0.5' },
] as const;

function absoluteUrl(path: string): string {
  return `${ORIGIN}${path}`;
}

async function readSitemap(): Promise<Document> {
  return new JSDOM(await readFile(SITEMAP_PATH, 'utf8'), {
    contentType: 'application/xml',
  }).window.document;
}

function urlEntries(document: Document): Element[] {
  return Array.from(document.querySelectorAll('url'));
}

function entryLocation(entry: Element): string {
  return entry.querySelector('loc')?.textContent?.trim() ?? '';
}

function findEntry(entries: Element[], url: string): Element {
  const matches = entries.filter((entry) => entryLocation(entry) === url);
  expect(matches, url).toHaveLength(1);
  const entry = matches[0];
  if (!entry) throw new Error(`Missing sitemap entry for ${url}`);
  return entry;
}

function alternateMap(entry: Element): Map<string, string> {
  const links = Array.from(entry.getElementsByTagNameNS(XHTML_NAMESPACE, 'link'));
  expect(links.every((link) => link.getAttribute('rel') === 'alternate')).toBe(true);

  const alternates = new Map<string, string>();
  for (const link of links) {
    const hrefLang = link.getAttribute('hreflang');
    const href = link.getAttribute('href');
    if (!hrefLang || !href) throw new Error('Alternate sitemap links require hreflang and href');
    expect(alternates.has(hrefLang), hrefLang).toBe(false);
    alternates.set(hrefLang, href);
  }
  return alternates;
}

describe('localized sitemap', () => {
  it('lists every app and About locale exactly once without an /en prefix', async () => {
    const document = await readSitemap();
    const entries = urlEntries(document);
    const localizedUrls = [
      ...LANGUAGE_OPTIONS.map(({ code }) => absoluteUrl(localizedAppPath(code))),
      ...LANGUAGE_OPTIONS.map(({ code }) => absoluteUrl(localizedAboutPath(code))),
    ];

    expect(document.documentElement.getAttribute('xmlns:xhtml')).toBe(XHTML_NAMESPACE);
    expect(localizedUrls).toHaveLength(34);
    expect(new Set(localizedUrls).size).toBe(34);
    expect(entries).toHaveLength(34 + ENGLISH_ONLY_PAGES.length);
    expect(entries.filter((entry) => localizedUrls.includes(entryLocation(entry))).length).toBe(34);
    expect(localizedUrls.some((url) => /\/en(?:\/|$)/u.test(new URL(url).pathname))).toBe(false);

    for (const url of localizedUrls) {
      const entry = findEntry(entries, url);
      expect(entry.querySelector('lastmod')?.textContent?.trim(), url).toBe('2026-08-31');
    }
  });

  it.each([
    ['app', localizedAppPath],
    ['about', localizedAboutPath],
  ] as const)(
    'keeps the %s locale cluster reciprocal with htmlLang hreflang values',
    async (_, pathFor) => {
      const entries = urlEntries(await readSitemap());
      const expectedAlternates = new Map<string, string>(
        LANGUAGE_OPTIONS.map(({ code, htmlLang }) => [htmlLang, absoluteUrl(pathFor(code))]),
      );
      expectedAlternates.set('x-default', absoluteUrl(pathFor('en')));

      for (const { code } of LANGUAGE_OPTIONS) {
        const entry = findEntry(entries, absoluteUrl(pathFor(code)));
        const alternates = alternateMap(entry);

        expect(alternates.size, code).toBe(LANGUAGE_OPTIONS.length + 1);
        expect(Object.fromEntries(alternates), code).toEqual(
          Object.fromEntries(expectedAlternates),
        );
        for (const href of alternates.values()) findEntry(entries, href);
      }
    },
  );

  it('preserves the existing English-only pages and their metadata', async () => {
    const entries = urlEntries(await readSitemap());

    for (const page of ENGLISH_ONLY_PAGES) {
      const entry = findEntry(entries, absoluteUrl(page.path));
      expect(entry.querySelector('lastmod')?.textContent?.trim(), page.path).toBe(page.lastmod);
      expect(entry.querySelector('changefreq')?.textContent?.trim(), page.path).toBe(
        page.changefreq,
      );
      expect(entry.querySelector('priority')?.textContent?.trim(), page.path).toBe(page.priority);
      expect(entry.getElementsByTagNameNS(XHTML_NAMESPACE, 'link'), page.path).toHaveLength(0);
    }
  });
});
