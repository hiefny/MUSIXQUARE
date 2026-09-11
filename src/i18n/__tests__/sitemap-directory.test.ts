import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import {
  LANGUAGE_OPTIONS,
  languageDirection,
  localizedAboutEntryPath,
  localizedAppEntryPath,
} from '../locales.ts';

it('keeps the crawlable sitemap directory aligned with all supported language entry URLs', async () => {
  const source = await readFile('.workshop/sitemap/sitemap.html', 'utf8');
  const document = new JSDOM(source).window.document;
  const rows = [...document.querySelectorAll('[data-locale]')];
  expect(rows.map((row) => row.getAttribute('data-locale'))).toEqual(
    LANGUAGE_OPTIONS.map(({ code }) => code),
  );

  for (const locale of LANGUAGE_OPTIONS) {
    const row = document.querySelector(`[data-locale="${locale.code}"]`);
    const name = row?.querySelector('.native-name');
    expect(name?.textContent, locale.code).toBe(locale.nativeName);
    expect(name?.getAttribute('lang'), locale.code).toBe(locale.htmlLang);
    expect(name?.getAttribute('dir'), locale.code).toBe(languageDirection(locale.code));
    expect([...row!.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      localizedAppEntryPath(locale.code),
      localizedAboutEntryPath(locale.code),
    ]);
  }
});
