import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { localeFontAssetInlineLimit } from '../../../vite.config.ts';

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
  it('keeps font CSS and font files external', async () => {
    expect(localeFontAssetInlineLimit('/workspace/css/fonts/noto-arabic.css')).toBe(false);
    expect(localeFontAssetInlineLimit('C:\\workspace\\css\\fonts\\noto-hebrew.css')).toBe(false);
    expect(localeFontAssetInlineLimit('/workspace/public/editorial-base.css')).toBeUndefined();
    expect(localeFontAssetInlineLimit('/workspace/fonts/noto/arabic.woff2')).toBe(false);
    expect(localeFontAssetInlineLimit('/workspace/fonts/PretendardVariable.woff2')).toBeUndefined();
    // The app's generated sheets and the Inter subsets stay external and lazy too.
    expect(localeFontAssetInlineLimit('/workspace/css/fonts/app/font-noto-kr.css')).toBe(false);
    expect(localeFontAssetInlineLimit('C:\\workspace\\css\\fonts\\app\\font-inter.css')).toBe(
      false,
    );
    expect(localeFontAssetInlineLimit('/workspace/fonts/inter/inter-latin.woff2')).toBe(false);
    expect(localeFontAssetInlineLimit('C:\\workspace\\fonts\\inter\\inter-greek.woff2')).toBe(
      false,
    );
    expect(localeFontAssetInlineLimit('/workspace/fonts/noto/noto-sans-kr/PbykFm.119.woff2')).toBe(
      false,
    );
    // The baked app faces too: three of them are under Vite's 4 KiB inline limit.
    expect(localeFontAssetInlineLimit('/workspace/fonts/app/inter/inter-latin.woff2')).toBe(false);
    expect(
      localeFontAssetInlineLimit(
        'C:\\workspace\\fonts\\app\\noto-sans-tc\\-nF7OG829Oofr2wohFbTp9iFOkMQAewlpbGXhhyYs0QF3kPVyLylzU95vTq1Ltj5xQez1g.97.woff2',
      ),
    ).toBe(false);
    expect(localeFontAssetInlineLimit('/workspace/fonts/app/noto-sans-sc/shard.4.woff2')).toBe(
      false,
    );
    // A characterisation pin, not a new rule: the fonts/app/ pattern already
    // keeps the Hangul faces (#95 is 1.4 KB, #119 3.3 KB) out of inlining.
    expect(localeFontAssetInlineLimit('/workspace/fonts/app/hangul/hangul.95.woff2')).toBe(false);
    expect(localeFontAssetInlineLimit('C:\\workspace\\fonts\\app\\hangul\\hangul.119.woff2')).toBe(
      false,
    );
    expect(localeFontAssetInlineLimit('/workspace/fonts/app-faces.json')).toBeUndefined();
    expect(localeFontAssetInlineLimit('/workspace/css/fonts/app/notes.txt')).toBeUndefined();

    // The public pages take the app's processed sheets through /web-fonts/
    // (public-font-sheets.test.ts); nothing rebinds About's links any more.
    const viteConfig = await readFile('vite.config.ts', 'utf8');
    expect(viteConfig).not.toMatch(/bindStaticLocaleFontAssets|STATIC_LOCALE_FONT_STYLESHEETS/u);
  });

  it('preserves physical channel order in RTL layouts', async () => {
    const [rtlCss, editorialRtlCss, staticLanguageCss] = await Promise.all([
      readFile('css/rtl.css', 'utf8'),
      readFile('public/editorial-rtl.css', 'utf8'),
      readFile('public/static-language.css', 'utf8'),
    ]);

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
