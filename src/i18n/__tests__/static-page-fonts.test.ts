/**
 * @vitest-environment jsdom
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hasLocaleFont } from '../locale-font-contract.ts';
import { LANGUAGE_OPTIONS } from '../locales.ts';

/**
 * The static pages (About's disabled links and the sitemap page) keep the
 * original Google sheets in css/fonts/, and only this loader imports them
 * dynamically, which keeps their processed copies in the build.
 */

const sheets = vi.hoisted(() => ({
  registered: [] as string[],
  requests: [] as string[],
  behaviour: new Map<string, () => Promise<unknown>>(),
}));

vi.mock('../retryable-stylesheet.ts', () => ({
  createRetryableStylesheet: (sourceName: string) => {
    sheets.registered.push(sourceName);
    return () => {
      sheets.requests.push(sourceName);
      return sheets.behaviour.get(sourceName)?.() ?? Promise.resolve();
    };
  },
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const STATIC_SHEETS = [
  'noto-arabic',
  'noto-bengali',
  'noto-cyrillic',
  'noto-devanagari',
  'noto-greek',
  'noto-gujarati',
  'noto-gurmukhi',
  'noto-hebrew',
  'noto-jp',
  'noto-kannada',
  'noto-malayalam',
  'noto-sc',
  'noto-tamil',
  'noto-tc',
  'noto-telugu',
  'noto-thai',
] as const;

const SHEET_BY_CODE = {
  ar: 'noto-arabic',
  bn: 'noto-bengali',
  bg: 'noto-cyrillic',
  el: 'noto-greek',
  fa: 'noto-arabic',
  gu: 'noto-gujarati',
  he: 'noto-hebrew',
  hi: 'noto-devanagari',
  ja: 'noto-jp',
  kn: 'noto-kannada',
  ml: 'noto-malayalam',
  mr: 'noto-devanagari',
  pa: 'noto-gurmukhi',
  ru: 'noto-cyrillic',
  ta: 'noto-tamil',
  te: 'noto-telugu',
  th: 'noto-thai',
  uk: 'noto-cyrillic',
  ur: 'noto-arabic',
  'zh-hans': 'noto-sc',
  'zh-hant': 'noto-tc',
} as const;

async function freshLoader() {
  vi.resetModules();
  sheets.registered.length = 0;
  return (await import('../static-page-fonts.ts')).default;
}

beforeEach(() => {
  sheets.requests.length = 0;
  sheets.behaviour.clear();
});

describe('static page locale fonts', () => {
  it('keeps one loader for each of the 16 original sheets', async () => {
    await freshLoader();
    expect([...sheets.registered].sort()).toEqual([...STATIC_SHEETS]);

    const source = readFileSync('src/i18n/static-page-fonts.ts', 'utf8');
    const imports = [...source.matchAll(/import\('\.\.\/\.\.\/(css\/fonts\/[^']+)'\)/gu)].map(
      (match) => match[1],
    );
    expect(imports.sort()).toEqual(STATIC_SHEETS.map((name) => `css/fonts/${name}.css`));
  });

  it('maps the 21 locale codes of the static pages', () => {
    expect(
      LANGUAGE_OPTIONS.map(({ code }) => code)
        .filter(hasLocaleFont)
        .sort(),
    ).toEqual(Object.keys(SHEET_BY_CODE).sort());
  });

  it.each(Object.entries(SHEET_BY_CODE))('loads the %s sheet %s', async (code, sheet) => {
    const loader = await freshLoader();

    await loader.loadLocaleFont(code as keyof typeof SHEET_BY_CODE);

    expect(sheets.requests).toEqual([sheet]);
  });

  it('shares a load, keeps a loaded sheet and retries after a failure', async () => {
    let attempts = 0;
    sheets.behaviour.set('noto-thai', () =>
      ++attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(),
    );
    const loader = await freshLoader();

    const first = loader.loadLocaleFont('th');
    expect(loader.loadLocaleFont('th')).toBe(first);
    await first;
    await loader.loadLocaleFont('th');
    await loader.loadLocaleFont('th');

    expect(sheets.requests).toEqual(['noto-thai', 'noto-thai']);
  });

  it('is imported by the sitemap page and by nothing in the app', () => {
    const importers: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') visit(target);
        } else if (/\.(?:m?ts|js)$/u.test(entry.name)) {
          if (/static-page-fonts(?:\.ts)?['"]/u.test(readFileSync(target, 'utf8'))) {
            importers.push(target.replace(/\\/gu, '/'));
          }
        }
      }
    };
    for (const root of ['src', 'browser', '.workshop']) visit(root);

    expect(importers).toEqual(['.workshop/sitemap/main.ts']);
  });
});
