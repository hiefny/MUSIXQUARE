import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

type LandingWindow = Window & typeof globalThis & { __landingLang?: string };

describe('static locale fallbacks without the shared resolver', () => {
  it('resolves every supported query locale before the About page paints', async () => {
    const source = await readFile('public/landing-bootstrap.js', 'utf8');
    const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
      runScripts: 'outside-only',
      url: 'https://musixquare.com/about?lang=nl-NL',
    });

    dom.window.eval(source);

    const window = dom.window as unknown as LandingWindow;
    expect(window.__landingLang).toBe('nl');
    expect(window.document.documentElement.lang).toBe('nl');
    dom.window.close();
  });

  it('preserves explicit Chinese script tags and canonical Open Graph locales', async () => {
    const source = await readFile('public/landing-i18n.js', 'utf8');
    const dom = new JSDOM(
      '<!doctype html><html lang="en"><head><meta property="og:locale" content="en_US"></head><body><span data-i18n="header.try"></span></body></html>',
      {
        runScripts: 'outside-only',
        url: 'https://musixquare.com/about?lang=zh-Hans-TW',
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
