import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import {
  APP_DICTIONARIES,
  renderLocalizedAbout,
  renderLocalizedApp,
  SITE_ORIGIN,
} from '../../../scripts/localized-html-lib.mts';
import { localeSeoMetadata } from '../../../scripts/locale-seo-metadata.mts';
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

function alternateMap(document: Document): Map<string, string> {
  return new Map(
    Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="alternate"][hreflang]'),
      (link) => [link.hreflang, link.href] as const,
    ),
  );
}

describe('localized static HTML materialization', () => {
  it('keeps the authored app shell alternate cluster in sync with every supported locale', () => {
    const expectedAlternates = new Map(
      LANGUAGE_OPTIONS.map(
        ({ code }) =>
          [localeSeoMetadata(code).hrefLang, `${SITE_ORIGIN}${localizedAppPath(code)}`] as const,
      ),
    );
    expectedAlternates.set('x-default', `${SITE_ORIGIN}/`);
    const document = documentFor(appHtml);

    expect(alternateMap(document)).toEqual(expectedAlternates);
    expect(document.querySelectorAll('link[rel="alternate"][hreflang]')).toHaveLength(
      LANGUAGE_OPTIONS.length + 1,
    );
  });

  it('keeps one complete locale-native app search description per supported language', () => {
    const descriptions = LANGUAGE_OPTIONS.map(
      ({ code }) => APP_DICTIONARIES[code]['app.search_description'],
    );

    expect(new Set(descriptions).size).toBe(LANGUAGE_OPTIONS.length);
    for (const [index, description] of descriptions.entries()) {
      const code = LANGUAGE_OPTIONS[index]?.code;
      expect(description.trim(), `${code} trimmed description`).toBe(description);
      expect(description.length, `${code} meaningful description`).toBeGreaterThan(40);
      expect(description, `${code} plain-text description`).not.toMatch(/<[^>]+>/u);
    }
  });

  it(`renders complete, self-canonical app and About documents for all ${LANGUAGE_OPTIONS.length} locales`, () => {
    const expectedAppAlternates = new Map(
      LANGUAGE_OPTIONS.map(
        ({ code }) =>
          [localeSeoMetadata(code).hrefLang, `${SITE_ORIGIN}${localizedAppPath(code)}`] as const,
      ),
    );
    expectedAppAlternates.set('x-default', `${SITE_ORIGIN}/`);
    const expectedAboutAlternates = new Map(
      LANGUAGE_OPTIONS.map(
        ({ code }) =>
          [localeSeoMetadata(code).hrefLang, `${SITE_ORIGIN}${localizedAboutPath(code)}`] as const,
      ),
    );
    expectedAboutAlternates.set('x-default', `${SITE_ORIGIN}/about`);

    for (const option of LANGUAGE_OPTIONS) {
      const about = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, option.code);
      const app = renderLocalizedApp(appHtml, option.code, about.metadata);
      const appDocument = documentFor(app);
      const aboutDocument = documentFor(about.html);
      const dictionary = APP_DICTIONARIES[option.code];
      const expectedTitle = dictionary['app.search_title'];
      const expectedDescription = dictionary['app.search_description'];

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
      expect(alternateMap(appDocument), `${option.code} app alternate cluster`).toEqual(
        expectedAppAlternates,
      );
      expect(alternateMap(aboutDocument), `${option.code} About alternate cluster`).toEqual(
        expectedAboutAlternates,
      );

      for (const document of [appDocument, aboutDocument]) {
        expect(document.querySelectorAll('link[rel="alternate"][hreflang]').length).toBe(
          LANGUAGE_OPTIONS.length + 1,
        );
        expect(document.querySelector('link[hreflang="x-default"]')).not.toBeNull();
        expect(document.querySelectorAll('meta[property="og:locale:alternate"]').length).toBe(
          LANGUAGE_OPTIONS.length - 1,
        );
      }

      expect(appDocument.querySelectorAll('[data-i18n]').length).toBeGreaterThan(150);
      expect(aboutDocument.querySelectorAll('[data-i18n]').length).toBeGreaterThan(50);
      expect(appDocument.querySelectorAll('h1')).toHaveLength(1);
      expect(appDocument.title, `${option.code} app title`).toBe(expectedTitle);
      const appHeading = appDocument.querySelector<HTMLElement>('h1[data-i18n="app.search_title"]');
      const appSummary = appDocument.querySelector<HTMLElement>(
        '[data-i18n="app.search_description"]',
      );
      expect(appHeading?.textContent, `${option.code} app heading`).toBe(expectedTitle);
      expect(appHeading?.classList.contains('sr-only'), `${option.code} hidden heading`).toBe(true);
      expect(appHeading?.hasAttribute('aria-hidden'), `${option.code} accessible heading`).toBe(
        false,
      );
      expect(appSummary?.textContent, `${option.code} app summary`).toBe(expectedDescription);
      expect(appSummary?.classList.contains('sr-only'), `${option.code} hidden summary`).toBe(true);
      expect(appSummary?.hasAttribute('aria-hidden'), `${option.code} accessible summary`).toBe(
        false,
      );
      expect(appDocument.querySelector<HTMLMetaElement>('meta[name="twitter:site"]')?.content).toBe(
        '@musixquare',
      );
      expect(
        aboutDocument.querySelector<HTMLMetaElement>('meta[name="twitter:site"]')?.content,
      ).toBe('@musixquare');
      expect(
        appDocument
          .querySelector<HTMLLinkElement>('#app-manifest[rel~="manifest"]')
          ?.getAttribute('href'),
        `${option.code} app manifest`,
      ).toBe(option.code === 'en' ? null : `/manifests/${option.code}.webmanifest`);

      const appDescription = appDocument.querySelector<HTMLMetaElement>(
        'meta[name="description"]',
      )?.content;
      expect(appDescription, `${option.code} app description`).toBe(expectedDescription);
      expect(
        appDocument.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content,
        `${option.code} app Open Graph description`,
      ).toBe(appDescription);
      expect(
        appDocument.querySelector<HTMLMetaElement>('meta[name="twitter:description"]')?.content,
        `${option.code} app Twitter description`,
      ).toBe(appDescription);
      expect(
        appDocument.querySelectorAll('[data-nosnippet]'),
        `${option.code} snippet exclusions`,
      ).toHaveLength(0);
    }
  }, 45_000);

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
        expect(new Set(alternateContents()).size, option.code).toBe(LANGUAGE_OPTIONS.length - 1);
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
    expect(englishApp).not.toMatch(/\n{2,}/u);
    for (const svg of englishApp.matchAll(/<svg\b[\s\S]*?<\/svg>/gu)) {
      expect(svg[0]).not.toMatch(/>\s+</u);
    }
  });

  it('uses one uppercase app brand title while keeping localized descriptions', () => {
    const koreanAbout = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, 'ko');
    const japaneseAbout = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, 'ja');
    const koreanApp = documentFor(renderLocalizedApp(appHtml, 'ko', koreanAbout.metadata));
    const japaneseApp = documentFor(renderLocalizedApp(appHtml, 'ja', japaneseAbout.metadata));

    for (const option of LANGUAGE_OPTIONS) {
      expect(APP_DICTIONARIES[option.code]['app.search_title'], option.code).toBe('MUSIXQUARE');
    }
    expect(koreanApp.title).toBe('MUSIXQUARE');
    expect(japaneseApp.title).toBe('MUSIXQUARE');
    expect(koreanApp.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      '스마트폰, 태블릿, PC를 연결해 하나의 동기화된 무선 오디오 시스템을 만들어 보세요. 음악·YouTube·시스템 오디오를 설치 없이 브라우저에서 함께 재생할 수 있습니다.',
    );
    expect(
      koreanApp.querySelector('meta[property="og:description"]')?.getAttribute('content'),
    ).toBe(
      '스마트폰, 태블릿, PC를 연결해 하나의 동기화된 무선 오디오 시스템을 만들어 보세요. 음악·YouTube·시스템 오디오를 설치 없이 브라우저에서 함께 재생할 수 있습니다.',
    );
    expect(
      koreanApp.querySelector('meta[name="twitter:description"]')?.getAttribute('content'),
    ).toBe(
      '스마트폰, 태블릿, PC를 연결해 하나의 동기화된 무선 오디오 시스템을 만들어 보세요. 음악·YouTube·시스템 오디오를 설치 없이 브라우저에서 함께 재생할 수 있습니다.',
    );
    expect(koreanApp.querySelector('meta[name="application-name"]')?.getAttribute('content')).toBe(
      'MUSIXQUARE',
    );
    expect(
      japaneseApp.querySelector('meta[property="og:site_name"]')?.getAttribute('content'),
    ).toBe('MUSIXQUARE');
  });

  it('keeps English as x-default and emits one canonical brand in root WebSite data', () => {
    const englishAbout = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, 'en');
    const englishApp = documentFor(renderLocalizedApp(appHtml, 'en', englishAbout.metadata));
    const koreanAbout = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, 'ko');
    const koreanApp = documentFor(renderLocalizedApp(appHtml, 'ko', koreanAbout.metadata));

    expect(englishApp.title).toBe('MUSIXQUARE');
    expect(englishApp.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'Turn phones, tablets, and computers into one synchronized wireless audio system. Play music, YouTube, and system audio together in your browser, with no installation required.',
    );
    expect(
      englishApp.querySelector('meta[property="og:description"]')?.getAttribute('content'),
    ).toBe(
      'Turn phones, tablets, and computers into one synchronized wireless audio system. Play music, YouTube, and system audio together in your browser, with no installation required.',
    );
    expect(
      englishApp.querySelector('meta[name="twitter:description"]')?.getAttribute('content'),
    ).toBe(
      'Turn phones, tablets, and computers into one synchronized wireless audio system. Play music, YouTube, and system audio together in your browser, with no installation required.',
    );
    expect(englishApp.querySelectorAll('[data-mxqr-website-schema]')).toHaveLength(1);
    const websiteSchema = JSON.parse(
      englishApp.querySelector('[data-mxqr-website-schema]')?.textContent || '{}',
    ) as Record<string, unknown>;
    expect(websiteSchema.name).toBe('MUSIXQUARE');
    expect(websiteSchema).not.toHaveProperty('alternateName');
    expect(englishApp.querySelector('[data-mxqr-website-schema]')?.textContent).toContain(
      'https://x.com/musixquare',
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

      for (const path of ['/blog', '/history', '/designsystem']) {
        const link = Array.from(about.querySelectorAll<HTMLAnchorElement>('a[href]')).find(
          (candidate) =>
            new URL(candidate.getAttribute('href') || '/', SITE_ORIGIN).pathname === path,
        );
        const target = link ? new URL(link.getAttribute('href') || '/', SITE_ORIGIN) : null;
        expect(target, `${option.code} ${path} link`).not.toBeNull();
        expect(target?.searchParams.get('lang'), `${option.code} ${path} locale intent`).toBe(
          option.code === 'en' ? null : option.code,
        );
      }
    }
  });
});
