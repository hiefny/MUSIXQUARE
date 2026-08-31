import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { hasLocaleFont } from '../locale-fonts.ts';
import { LANGUAGE_OPTIONS } from '../locales.ts';
import { bindStaticLocaleFontAssets, localeFontAssetInlineLimit } from '../../../vite.config.ts';

const LOCALE_FONT_STYLESHEETS = [
  'css/fonts/noto-arabic.css',
  'css/fonts/noto-bengali.css',
  'css/fonts/noto-cyrillic.css',
  'css/fonts/noto-devanagari.css',
  'css/fonts/noto-greek.css',
  'css/fonts/noto-gujarati.css',
  'css/fonts/noto-gurmukhi.css',
  'css/fonts/noto-hebrew.css',
  'css/fonts/noto-jp.css',
  'css/fonts/noto-kannada.css',
  'css/fonts/noto-malayalam.css',
  'css/fonts/noto-sc.css',
  'css/fonts/noto-tamil.css',
  'css/fonts/noto-tc.css',
  'css/fonts/noto-telugu.css',
  'css/fonts/noto-thai.css',
] as const;

describe('self-hosted locale font assets', () => {
  it('keeps authored locale CSS external until the build rebinds it to processed assets', async () => {
    expect(localeFontAssetInlineLimit('/workspace/css/fonts/noto-arabic.css')).toBe(false);
    expect(localeFontAssetInlineLimit('C:\\workspace\\css\\fonts\\noto-hebrew.css')).toBe(false);
    expect(localeFontAssetInlineLimit('/workspace/public/editorial-base.css')).toBeUndefined();
    expect(localeFontAssetInlineLimit('/workspace/fonts/noto/arabic.woff2')).toBe(false);
    expect(localeFontAssetInlineLimit('/workspace/fonts/PretendardVariable.woff2')).toBeUndefined();
    expect(bindStaticLocaleFontAssets().name).toBe('bind-static-locale-font-assets');

    const viteConfig = await readFile('vite.config.ts', 'utf8');
    expect(viteConfig).toMatch(/flattenWorkshopHtml\(\),\s*bindStaticLocaleFontAssets\(\),/u);
  });

  it('applies loaded Cyrillic fonts and preserves physical channel order in RTL layouts', async () => {
    const [editorialCss, rtlCss, editorialRtlCss, staticLanguageCss] = await Promise.all([
      readFile('public/editorial-base.css', 'utf8'),
      readFile('css/rtl.css', 'utf8'),
      readFile('public/editorial-rtl.css', 'utf8'),
      readFile('public/static-language.css', 'utf8'),
    ]);

    expect(editorialCss).toMatch(/:root:lang\(ru\)[^{]*\{[^}]*'Noto Sans'/su);
    for (const selector of ['#grid-standard', '#setup-role-grid', '.demo-role-segmented']) {
      expect(rtlCss, selector).toContain(selector);
    }
    expect(rtlCss).toMatch(/#youtube-url-input\s*\{[^}]*unicode-bidi:\s*plaintext;/su);
    expect(rtlCss).toMatch(
      /\.track-artist\s*\{[^}]*unicode-bidi:\s*plaintext;[^}]*text-align:\s*right;/su,
    );
    expect(rtlCss).toMatch(/:where\([^)]*\.play-btn-group[^)]*\)\s*\{[^}]*direction:\s*ltr;/su);
    expect(editorialRtlCss).toMatch(/\.lp-room-count strong[^}]*direction:\s*ltr;/su);
    expect(editorialRtlCss).toMatch(/\.lp-sync__label\s*\{[^}]*direction:\s*rtl;/su);
    expect(staticLanguageCss).toMatch(/\.static-lang-menu\s*\{[^}]*inset-inline-end:\s*0;/su);
  });

  it('exposes every script stylesheet through the lazy About loader', async () => {
    const [runtime, bootstrap, html] = await Promise.all([
      readFile('browser/classic-runtime/static-language.ts', 'utf8'),
      readFile('browser/classic-runtime/landing-bootstrap.ts', 'utf8'),
      readFile('.workshop/landing/landing.html', 'utf8'),
    ]);
    for (const cssPath of LOCALE_FONT_STYLESHEETS) {
      expect(runtime, cssPath).toContain(`'/${cssPath}'`);
      const authoredLink = new RegExp(
        `<link\\s+[^>]*href="/${cssPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"[^>]*>`,
        'u',
      ).exec(html)?.[0];
      expect(authoredLink, cssPath).toContain('data-static-lang-font-codes=');
      expect(authoredLink, `${cssPath} must start disabled`).toMatch(/\sdisabled(?:\s|>)/u);
    }
    const authoredCodes = [...html.matchAll(/data-static-lang-font-codes="([^"]+)"/gu)]
      .flatMap((match) => match[1]!.split(/\s+/u))
      .sort();
    const expectedCodes = LANGUAGE_OPTIONS.map(({ code }) => code)
      .filter(hasLocaleFont)
      .sort();
    expect(authoredCodes).toEqual(expectedCodes);
    expect(bootstrap).toContain('MXQRStaticLang?.ensureFont?.(lang)');
  });

  it.each(LOCALE_FONT_STYLESHEETS)('%s references valid local WOFF2 shards', async (cssPath) => {
    const css = await readFile(cssPath, 'utf8');
    const urls = [...css.matchAll(/url\(([^)]+\.woff2)\)/gu)].map((match) =>
      match[1]!.replace(/^['"]|['"]$/gu, ''),
    );

    expect(urls.length, cssPath).toBeGreaterThan(0);
    expect(css, cssPath).toMatch(/fonts\/NOTO_(?:SANS|CJK|THAI)_LICENSE\.txt/u);

    for (const url of urls) {
      expect(url, `${cssPath} must remain self-hosted`).not.toMatch(/^https?:/u);
      const body = await readFile(resolve(dirname(cssPath), url));
      expect(body.subarray(0, 4).toString('ascii'), `${cssPath} -> ${url}`).toBe('wOF2');
      // Some CJK unicode-range shards intentionally contain only a small set of glyphs.
      expect(body.byteLength, `${cssPath} -> ${url}`).toBeGreaterThan(1_000);
    }
  });
});
