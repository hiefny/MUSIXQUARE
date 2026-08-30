import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import {
  renderLocalizedAbout,
  renderLocalizedApp,
  SITE_ORIGIN,
} from '../../../scripts/localized-html-lib.mts';
import { LANGUAGE_OPTIONS, localizedAboutPath, localizedAppPath } from '../locales.ts';

const landingI18nAsset = CLASSIC_RUNTIME_ASSETS.find(
  ({ outputPath }) => outputPath === 'landing-i18n.js',
);

if (!landingI18nAsset)
  throw new Error('landing-i18n.js is missing from the classic asset manifest.');

let appHtml = '';
let aboutHtml = '';
let landingI18nJavaScript = '';

beforeAll(async () => {
  [appHtml, aboutHtml] = await Promise.all([
    readFile('index.html', 'utf8'),
    readFile('.workshop/landing/landing.html', 'utf8'),
  ]);
  landingI18nJavaScript = (await compileClassicRuntimeAsset(process.cwd(), landingI18nAsset)).code;
});

function documentFor(html: string): Document {
  return new JSDOM(html).window.document;
}

describe('localized static HTML materialization', () => {
  it('renders complete, self-canonical app and About documents for all 17 locales', () => {
    for (const option of LANGUAGE_OPTIONS) {
      const about = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, option.code);
      const app = renderLocalizedApp(appHtml, option.code, about.metadata);
      const appDocument = documentFor(app);
      const aboutDocument = documentFor(about.html);

      expect(appDocument.documentElement.lang, `${option.code} app lang`).toBe(option.htmlLang);
      expect(aboutDocument.documentElement.lang, `${option.code} About lang`).toBe(option.htmlLang);
      expect(
        appDocument.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
        `${option.code} app canonical`,
      ).toBe(`${SITE_ORIGIN}${localizedAppPath(option.code)}`);
      expect(
        aboutDocument.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
        `${option.code} About canonical`,
      ).toBe(`${SITE_ORIGIN}${localizedAboutPath(option.code)}`);

      for (const document of [appDocument, aboutDocument]) {
        expect(document.querySelectorAll('link[rel="alternate"][hreflang]').length).toBe(18);
        expect(document.querySelector('link[hreflang="x-default"]')).not.toBeNull();
        expect(document.querySelectorAll('meta[property="og:locale:alternate"]').length).toBe(16);
      }

      expect(appDocument.querySelectorAll('[data-i18n]').length).toBeGreaterThan(150);
      expect(aboutDocument.querySelectorAll('[data-i18n]').length).toBeGreaterThan(50);
    }
  });

  it('preserves every materialized Open Graph locale alternate during About hydration', () => {
    for (const option of LANGUAGE_OPTIONS) {
      const about = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, option.code);
      const dom = new JSDOM(about.html, {
        runScripts: 'outside-only',
        url: `${SITE_ORIGIN}${localizedAboutPath(option.code)}`,
      });
      const landingWindow = dom.window as typeof dom.window & { __landingLang?: string };
      const alternateContents = (): string[] =>
        Array.from(
          landingWindow.document.querySelectorAll<HTMLMetaElement>(
            'meta[property="og:locale:alternate"]',
          ),
          (element) => element.content,
        );
      const beforeHydration = alternateContents();

      try {
        landingWindow.__landingLang = option.code;
        landingWindow.eval(landingI18nJavaScript);

        expect(alternateContents(), option.code).toEqual(beforeHydration);
        expect(new Set(alternateContents()).size, option.code).toBe(16);
      } finally {
        landingWindow.close();
      }
    }
  });

  it('keeps the authored-license marker while omitting implementation comments from app output', () => {
    const englishAbout = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, 'en');
    const englishApp = renderLocalizedApp(appHtml, 'en', englishAbout.metadata);

    expect(englishApp).toContain('<!-- MUSIXQUARE-authored file:');
    expect(englishApp).not.toContain('Runtime insertion point');
    expect(englishApp).not.toContain('<!-- Slide 1: Invite -->');
    expect(englishApp).not.toMatch(/^[\t ]+/mu);
  });

  it('uses established Korean and Japanese search aliases without changing the global brand', () => {
    const koreanAbout = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, 'ko');
    const japaneseAbout = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, 'ja');
    const koreanApp = documentFor(renderLocalizedApp(appHtml, 'ko', koreanAbout.metadata));
    const japaneseApp = documentFor(renderLocalizedApp(appHtml, 'ja', japaneseAbout.metadata));

    expect(koreanApp.title).toBe('뮤직스퀘어 | MUSIXQUARE');
    expect(japaneseApp.title).toBe('ミュージックスクエア | MUSIXQUARE');
    expect(koreanApp.querySelector('meta[name="application-name"]')?.getAttribute('content')).toBe(
      'MUSIXQUARE',
    );
    expect(
      japaneseApp.querySelector('meta[property="og:site_name"]')?.getAttribute('content'),
    ).toBe('MUSIXQUARE');
  });

  it('keeps English as x-default and emits the brand aliases once in root WebSite data', () => {
    const englishAbout = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, 'en');
    const englishApp = documentFor(renderLocalizedApp(appHtml, 'en', englishAbout.metadata));
    const koreanAbout = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, 'ko');
    const koreanApp = documentFor(renderLocalizedApp(appHtml, 'ko', koreanAbout.metadata));

    expect(englishApp.title).toBe('MUSIXQUARE');
    expect(englishApp.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'Turn phones, tablets, desktops into a synchronized wireless audio system.',
    );
    expect(englishApp.querySelectorAll('[data-mxqr-website-schema]')).toHaveLength(1);
    expect(englishApp.querySelector('[data-mxqr-website-schema]')?.textContent).toContain(
      '뮤직스퀘어',
    );
    expect(koreanApp.querySelectorAll('[data-mxqr-website-schema]')).toHaveLength(0);
  });

  it('links each About locale to its explicit app-language entry without changing SEO paths', () => {
    for (const option of LANGUAGE_OPTIONS) {
      const about = documentFor(
        renderLocalizedAbout(aboutHtml, landingI18nJavaScript, option.code).html,
      );
      const appLinks = about.querySelectorAll<HTMLAnchorElement>(`a[href="/${option.code}/"]`);

      expect(appLinks.length, option.code).toBeGreaterThan(0);
      expect(
        about.querySelector<HTMLLinkElement>('link[hreflang="en"]')?.href,
        `${option.code} English hreflang`,
      ).toBe(`${SITE_ORIGIN}${localizedAboutPath('en')}`);
    }
  });
});
