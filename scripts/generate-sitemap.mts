import { readFile, writeFile } from 'node:fs/promises';

import {
  LANGUAGE_OPTIONS,
  localizedAboutPath,
  localizedAppPath,
  type LanguageCode,
} from '../src/i18n/locales.ts';

const ORIGIN = 'https://musixquare.com';
const OUTPUT_PATH = 'public/sitemap.xml';
const LOCALIZED_LASTMOD = '2026-08-31';
const ENGLISH_ONLY_PAGES = [
  { path: '/blog', lastmod: '2026-07-18', changefreq: 'weekly', priority: '0.8' },
  { path: '/history', lastmod: '2026-08-23', changefreq: 'monthly', priority: '0.8' },
  { path: '/privacy', lastmod: '2026-08-17', changefreq: 'yearly', priority: '0.6' },
  { path: '/terms', lastmod: '2026-08-17', changefreq: 'yearly', priority: '0.6' },
  { path: '/faq', lastmod: '2026-08-17', changefreq: 'monthly', priority: '0.7' },
  { path: '/developers', lastmod: '2026-08-17', changefreq: 'monthly', priority: '0.7' },
  { path: '/designsystem', lastmod: '2026-08-23', changefreq: 'monthly', priority: '0.5' },
] as const;

function absolute(path: string): string {
  return `${ORIGIN}${path}`;
}

function localizedEntry(
  code: LanguageCode,
  pathFor: (language: LanguageCode) => string,
  priority: string,
): string {
  const alternates = LANGUAGE_OPTIONS.map(
    (option) =>
      `    <xhtml:link rel="alternate" hreflang="${option.htmlLang}" href="${absolute(pathFor(option.code))}" />`,
  );
  alternates.push(
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${absolute(pathFor('en'))}" />`,
  );
  return [
    '  <url>',
    `    <loc>${absolute(pathFor(code))}</loc>`,
    ...alternates,
    `    <lastmod>${LOCALIZED_LASTMOD}</lastmod>`,
    '    <changefreq>weekly</changefreq>',
    `    <priority>${priority}</priority>`,
    '  </url>',
  ].join('\n');
}

function englishOnlyEntry(page: (typeof ENGLISH_ONLY_PAGES)[number]): string {
  return [
    '  <url>',
    `    <loc>${absolute(page.path)}</loc>`,
    `    <lastmod>${page.lastmod}</lastmod>`,
    `    <changefreq>${page.changefreq}</changefreq>`,
    `    <priority>${page.priority}</priority>`,
    '  </url>',
  ].join('\n');
}

export function renderSitemap(): string {
  const entries = [
    ...LANGUAGE_OPTIONS.map(({ code }) => localizedEntry(code, localizedAppPath, '1.0')),
    ...LANGUAGE_OPTIONS.map(({ code }) => localizedEntry(code, localizedAboutPath, '0.9')),
    ...ENGLISH_ONLY_PAGES.map(englishOnlyEntry),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n');
}

const expected = renderSitemap();
if (process.argv.includes('--check')) {
  const actual = await readFile(OUTPUT_PATH, 'utf8');
  if (actual.replace(/\r\n/gu, '\n') !== expected) {
    throw new Error(`Localized sitemap is stale. Run: npm run generate:sitemap`);
  }
  process.stdout.write(
    `[sitemap] ${LANGUAGE_OPTIONS.length * 2 + ENGLISH_ONLY_PAGES.length} URLs verified.\n`,
  );
} else {
  await writeFile(OUTPUT_PATH, expected, 'utf8');
  process.stdout.write(
    `[sitemap] ${LANGUAGE_OPTIONS.length * 2 + ENGLISH_ONLY_PAGES.length} URLs written.\n`,
  );
}
