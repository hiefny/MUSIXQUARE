/**
 * The public pages' font sheets: dist/web-fonts/first.css and rest.css, the
 * byte concatenations of the app's processed font sheets
 * (scripts/public-font-sheets.mts), so every page outside the app declares
 * the same faces as the app and shares its font files. The groups are
 * src/i18n/public-font-contract.ts (public-font-contract.test.ts pins them to
 * the app's own loader); the app never links either sheet.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';

import { APP_FONT_SHEETS, type AppFontSheetId } from '../app-font-contract.ts';
import { PUBLIC_FONT_SHEET_GROUPS } from '../public-font-contract.ts';
import { PUBLIC_FONT_SHEET_URLS } from '../public-font-urls.ts';
import {
  PUBLIC_FONT_SHEET_FILES,
  concatenateFontSheets,
  publicFontSheetSource,
  publicFontSheets,
} from '../../../scripts/public-font-sheets.mts';
import { createViteConfig } from '../../../vite.config.ts';

const ROOT = resolve('.');

interface FakeAsset {
  type: 'asset';
  fileName: string;
  source: string | Uint8Array;
}

interface FakeChunk {
  type: 'chunk';
  fileName: string;
  isEntry: boolean;
  imports: string[];
  modules: Record<string, unknown>;
  viteMetadata?: { importedCss: Set<string> };
}

type FakeBundle = Record<string, FakeAsset | FakeChunk>;

function hashOf(index: number): string {
  return `H${String(index).padStart(7, '0')}`;
}

/**
 * A bundle holding every processed app sheet with one root-relative font file
 * each, the app entry chunk with its own stylesheet, and the app document.
 */
function fakeBundle(): FakeBundle {
  const bundle: FakeBundle = {};
  APP_FONT_SHEETS.forEach(({ id, family }, index) => {
    const font = `assets/${id}-shard-${hashOf(index)}.woff2`;
    const css = `@font-face{font-family:"${family}";src:url(/${font})format("woff2");unicode-range:U+${index.toString(16)}}`;
    const fileName = `assets/${id}-${hashOf(index)}.css`;
    bundle[fileName] = { type: 'asset', fileName, source: css };
    bundle[font] = {
      type: 'asset',
      fileName: font,
      source: new Uint8Array([0x77, 0x4f, 0x46, 0x32]),
    };
  });
  bundle['assets/main-AbCdEfGh.css'] = {
    type: 'asset',
    fileName: 'assets/main-AbCdEfGh.css',
    source: 'body{color:red}',
  };
  bundle['assets/main-AbCdEfGh.js'] = {
    type: 'chunk',
    fileName: 'assets/main-AbCdEfGh.js',
    isEntry: true,
    imports: ['assets/log-AbCdEfGh.js'],
    modules: { '/repo/src/app.ts': {} },
    viteMetadata: { importedCss: new Set(['assets/main-AbCdEfGh.css']) },
  };
  bundle['assets/log-AbCdEfGh.js'] = {
    type: 'chunk',
    fileName: 'assets/log-AbCdEfGh.js',
    isEntry: false,
    imports: [],
    modules: { '/repo/src/core/log.ts': {} },
    viteMetadata: { importedCss: new Set() },
  };
  bundle['index.html'] = {
    type: 'asset',
    fileName: 'index.html',
    source:
      '<!doctype html><link rel="stylesheet" href="/assets/main-AbCdEfGh.css"><script type="module" src="/assets/main-AbCdEfGh.js"></script>',
  };
  return bundle;
}

function sheetFile(bundle: FakeBundle, id: AppFontSheetId): string {
  const fileName = Object.keys(bundle).find(
    (name) =>
      name.startsWith(`assets/${id}-`) && name.endsWith('.css') && !name.includes('-shard-'),
  );
  if (!fileName) throw new Error(`fixture has no ${id}`);
  return fileName;
}

function sheetText(bundle: FakeBundle, id: AppFontSheetId): string {
  const output = bundle[sheetFile(bundle, id)];
  if (output?.type !== 'asset') throw new Error(`fixture has no ${id}`);
  return String(output.source);
}

function runGenerateBundle(bundle: FakeBundle): Map<string, string> {
  const emitted = new Map<string, string>();
  const plugin = publicFontSheets();
  const hook = plugin.generateBundle;
  const handler = typeof hook === 'function' ? hook : hook?.handler;
  if (!handler) throw new Error('publicFontSheets has no generateBundle hook');
  const context = {
    emitFile(file: { type: string; fileName: string; source: string }) {
      emitted.set(file.fileName, file.source);
      return file.fileName;
    },
    error(message: string): never {
      throw new Error(message);
    },
  };
  (handler as (this: unknown, options: unknown, bundle: unknown) => void).call(context, {}, bundle);
  return emitted;
}

describe('the build emits the public font sheets', () => {
  it('at the URLs the public pages link', () => {
    expect(PUBLIC_FONT_SHEET_URLS).toEqual({
      first: '/web-fonts/first.css',
      stacks: '/web-fonts/stacks.css',
      rest: '/web-fonts/rest.css',
    });
    expect(PUBLIC_FONT_SHEET_FILES).toEqual({
      first: 'web-fonts/first.css',
      rest: 'web-fonts/rest.css',
    });
  });

  it('as exact concatenations of the processed app sheets', () => {
    const bundle = fakeBundle();
    const emitted = runGenerateBundle(bundle);

    expect([...emitted.keys()].sort()).toEqual(
      [PUBLIC_FONT_SHEET_FILES.first, PUBLIC_FONT_SHEET_FILES.rest].sort(),
    );
    for (const group of ['first', 'rest'] as const) {
      expect(emitted.get(PUBLIC_FONT_SHEET_FILES[group])).toBe(
        concatenateFontSheets(PUBLIC_FONT_SHEET_GROUPS[group].map((id) => sheetText(bundle, id))),
      );
    }
    expect(concatenateFontSheets(['a{}', 'b{}\n', 'c{}\n\n'])).toBe('a{}\nb{}\nc{}\n');
  });

  it('fails on a missing sheet', () => {
    const bundle = fakeBundle();
    delete bundle[sheetFile(bundle, 'noto-tamil')];
    expect(() => runGenerateBundle(bundle)).toThrow(/noto-tamil/u);
  });

  it('fails on a duplicate sheet', () => {
    const bundle = fakeBundle();
    const fileName = 'assets/font-noto-kr-Zz999999.css';
    bundle[fileName] = { type: 'asset', fileName, source: sheetText(bundle, 'font-noto-kr') };
    expect(() => runGenerateBundle(bundle)).toThrow(/font-noto-kr/u);
  });

  it('fails on a font file the bundle does not hold', () => {
    const bundle = fakeBundle();
    const font = Object.keys(bundle).find((name) => name.startsWith('assets/font-inter-shard-'));
    if (!font) throw new Error('fixture has no Inter file');
    delete bundle[font];
    expect(() => runGenerateBundle(bundle)).toThrow(/font-inter/u);
  });

  it('fails without the app entry', () => {
    const bundle = fakeBundle();
    delete bundle['assets/main-AbCdEfGh.js'];
    expect(() => runGenerateBundle(bundle)).toThrow(/app entry/u);
  });

  it("fails when an app sheet reaches the app entry's initial CSS graph", () => {
    const bundle = fakeBundle();
    const log = bundle['assets/log-AbCdEfGh.js'];
    if (log?.type !== 'chunk') throw new Error('fixture has no log chunk');
    log.viteMetadata = { importedCss: new Set([sheetFile(bundle, 'font-noto-jp')]) };
    expect(() => runGenerateBundle(bundle)).toThrow(/initial app CSS graph/u);
  });

  it.each(['first', 'rest'] as const)('fails when the app document links %s.css', (group) => {
    const bundle = fakeBundle();
    const document = bundle['index.html'];
    if (document?.type !== 'asset') throw new Error('fixture has no app document');
    document.source = String(document.source).replace(
      '<script',
      `<link rel="stylesheet" href="${PUBLIC_FONT_SHEET_URLS[group]}"><script`,
    );
    expect(() => runGenerateBundle(bundle)).toThrow(/app document/u);
  });

  it('fails without the app document', () => {
    const bundle = fakeBundle();
    delete bundle['index.html'];
    expect(() => runGenerateBundle(bundle)).toThrow(/app document/u);
  });

  it('is part of the build and the dev server, after the About font binding', () => {
    const names = (createViteConfig({}).plugins ?? []).flatMap((candidate) =>
      candidate !== null && typeof candidate === 'object' && 'name' in candidate
        ? [(candidate as Plugin).name]
        : [],
    );
    const index = names.indexOf('public-font-sheets');
    expect(index).toBeGreaterThan(-1);
    // About's raw locale sheet copies share a name stem with the app's
    // processed script sheets until bind-static-locale-font-assets removes them.
    expect(index).toBeGreaterThan(names.indexOf('bind-static-locale-font-assets'));
    expect(typeof publicFontSheets().configureServer).toBe('function');
  });
});

describe('the dev server serves the public font sheets from the source sheets', () => {
  it.each(['first', 'rest'] as const)('%s.css: every face points at a committed file', (group) => {
    const css = publicFontSheetSource(ROOT, group);
    const urls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gu)].map(
      (match) => match[2] ?? '',
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, url).toMatch(
        /^\/fonts\/(?:app\/(?:inter|hangul|noto-sans-(?:kr|jp|sc|tc))|noto\/noto-sans-[a-z]+)\/[^/]+\.woff2$/u,
      );
      expect(existsSync(resolve(ROOT, url.slice(1))), url).toBe(true);
    }
    const families = new Set(
      [...css.matchAll(/font-family:\s*(['"]?)([^'";]+)\1/gu)].map((match) => match[2]),
    );
    expect([...families].sort()).toEqual(
      APP_FONT_SHEETS.filter(({ id }) => PUBLIC_FONT_SHEET_GROUPS[group].includes(id))
        .map(({ family }) => family)
        .sort(),
    );
  });
});
