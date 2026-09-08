import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

type LandingWindow = Window & typeof globalThis & { __landingLang?: string };

async function classicRuntime(outputPath: string): Promise<string> {
  const asset = CLASSIC_RUNTIME_ASSETS.find((candidate) => candidate.outputPath === outputPath);
  if (!asset) throw new Error(`Classic runtime is missing from the manifest: ${outputPath}`);
  return (await compileClassicRuntimeAsset(process.cwd(), asset)).code;
}

describe('static locale fallbacks without the shared resolver', () => {
  it.each([
    { path: '/about', appPreference: 'ko', expected: 'ko' },
    { path: '/about.html', appPreference: 'ko', expected: 'ko' },
    { path: '/about', appPreference: 'system', expected: 'ko' },
    { path: '/about', appPreference: 'invalid', expected: 'ko' },
    { path: '/about', appPreference: null, expected: 'ko' },
    { path: '/en/about?lang=ja', appPreference: 'ko', expected: 'en' },
    { path: '/en/about.html?lang=ja', appPreference: 'ko', expected: 'en' },
    { path: '/ko/about?lang=ja', appPreference: 'en', expected: 'ko' },
  ])(
    'resolves $path with app preference $appPreference before first paint',
    async ({ path, appPreference, expected }) => {
      const source = await classicRuntime('landing-bootstrap.js');
      const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
        runScripts: 'outside-only',
        url: `https://musixquare.com${path}`,
      });
      dom.window.localStorage.setItem('mxqr-landing-lang', 'ja');
      if (appPreference !== null) dom.window.localStorage.setItem('musixquare-lang', appPreference);
      Object.defineProperty(dom.window.navigator, 'languages', { value: ['ko-KR'] });
      const historyLength = dom.window.history.length;

      dom.window.eval(source);

      const window = dom.window as unknown as LandingWindow;
      expect(window.__landingLang).toBe(expected);
      expect(window.document.documentElement.lang).toBe(expected);
      expect(window.location.pathname + window.location.search).toBe(path);
      expect(window.history.length).toBe(historyLength);
      expect(window.localStorage.getItem('musixquare-lang')).toBe(appPreference);
      expect(window.localStorage.getItem('mxqr-landing-lang')).toBe('ja');
      dom.window.close();
    },
  );

  it('resolves a regional query locale on the authored About alias before painting', async () => {
    const source = await classicRuntime('landing-bootstrap.js');
    const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
      runScripts: 'outside-only',
      url: 'https://musixquare.com/.workshop/landing/landing.html?lang=nl-NL',
    });

    dom.window.eval(source);

    const window = dom.window as unknown as LandingWindow;
    expect(window.__landingLang).toBe('nl');
    expect(window.document.documentElement.lang).toBe('nl');
    dom.window.close();
  });

  it('preserves explicit Chinese script tags and canonical Open Graph locales', async () => {
    const source = await classicRuntime('landing-i18n.js');
    const dom = new JSDOM(
      '<!doctype html><html lang="en"><head><meta property="og:locale" content="en_US"></head><body><span data-i18n="header.try"></span></body></html>',
      {
        runScripts: 'outside-only',
        url: 'https://musixquare.com/zh-hans/about?lang=zh-Hans-TW',
      },
    );
    const window = dom.window as unknown as LandingWindow;
    window.__landingLang = 'zh-Hans-TW';

    dom.window.eval(source);

    expect(window.__landingLang).toBe('zh-hans');
    expect(window.document.documentElement.lang).toBe('zh-Hans');
    expect(
      window.document.querySelector('meta[property="og:locale"]')?.getAttribute('content'),
    ).toBe('zh_CN');
    dom.window.close();
  });
});
