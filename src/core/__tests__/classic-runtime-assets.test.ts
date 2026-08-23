import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { transformWithEsbuild } from 'vite';

import {
  CLASSIC_RUNTIME_ASSETS,
  assertClassicRuntimeManifest,
  assertClassicRuntimeSourceCompleteness,
  classicRuntimeAssetForRequestUrl,
  classicRuntimeAssets,
  compileClassicRuntimeAssets,
  type CompiledClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import { compileServiceWorkerAsset } from '../../../scripts/service-worker-asset.ts';

const REPO_ROOT = resolve(process.cwd());

async function compiledAsset(outputPath: string): Promise<CompiledClassicRuntimeAsset> {
  const assets = await compileClassicRuntimeAssets(REPO_ROOT);
  const asset = assets.find((candidate) => candidate.outputPath === outputPath);
  if (!asset) throw new Error(`Missing compiled classic-runtime fixture: ${outputPath}`);
  return asset;
}

function executeClassicScript(code: string, globals: Record<string, unknown>): void {
  const names = Object.keys(globals);
  const values = names.map((name) => globals[name]);
  Function(...names, code)(...values);
}

async function compiledContrastPreflight(): Promise<string> {
  const source = await readFile(join(REPO_ROOT, 'browser/classic-runtime/bootstrap.ts'), 'utf8');
  const marker = '(function () {\n  // 4. Per-device contrast preflight';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('Missing classic contrast preflight marker');
  const result = await transformWithEsbuild(source.slice(start), 'contrast-preflight.ts', {
    format: 'iife',
    loader: 'ts',
    target: 'es2018',
  });
  return result.code;
}

type DevMiddleware = (
  request: { method?: string; url?: string },
  response: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  },
  next: (error?: unknown) => void,
) => Promise<void>;

async function classicRuntimeDevMiddleware(): Promise<DevMiddleware> {
  const plugin = classicRuntimeAssets();
  let middleware: DevMiddleware | null = null;
  const configure = plugin.configureServer as unknown as (server: {
    config: { root: string };
    middlewares: { use(value: DevMiddleware): void };
  }) => Promise<void>;
  await configure({
    config: { root: REPO_ROOT },
    middlewares: { use: (value) => (middleware = value) },
  });
  if (!middleware) throw new Error('Classic-runtime dev middleware was not installed.');
  return middleware;
}

describe('strict TypeScript classic browser runtimes', () => {
  it('owns every source and stable output through one complete manifest', async () => {
    expect(CLASSIC_RUNTIME_ASSETS).toEqual([
      {
        sourcePath: 'browser/classic-runtime/account-complete.ts',
        outputPath: 'account-complete.js',
      },
      {
        sourcePath: 'browser/classic-runtime/admin.ts',
        outputPath: 'admin.js',
      },
      {
        sourcePath: 'browser/classic-runtime/analytics-bootstrap.ts',
        outputPath: 'analytics-bootstrap.js',
      },
      {
        sourcePath: 'browser/classic-runtime/blog-pagination.ts',
        outputPath: 'blog-pagination.js',
      },
      {
        sourcePath: 'browser/classic-runtime/clearable-editors.ts',
        outputPath: 'clearable-editors.js',
      },
      {
        sourcePath: 'browser/classic-runtime/bootstrap.ts',
        outputPath: 'bootstrap.js',
        minify: true,
        target: 'es2018',
      },
      {
        sourcePath: 'browser/classic-runtime/editorial-pages.ts',
        outputPath: 'editorial-pages.js',
      },
      {
        sourcePath: 'browser/classic-runtime/events/event.ts',
        outputPath: 'events/event.js',
      },
      {
        sourcePath: 'browser/classic-runtime/events/theme.ts',
        outputPath: 'events/theme.js',
      },
      {
        sourcePath: 'browser/classic-runtime/fouc-cleanup.ts',
        outputPath: 'fouc-cleanup.js',
      },
      {
        sourcePath: 'browser/classic-runtime/landing-bootstrap.ts',
        outputPath: 'landing-bootstrap.js',
      },
      {
        sourcePath: 'browser/classic-runtime/landing-i18n.ts',
        outputPath: 'landing-i18n.js',
      },
      {
        sourcePath: 'browser/classic-runtime/policy-accordion.ts',
        outputPath: 'policy-accordion.js',
      },
      {
        sourcePath: 'browser/classic-runtime/primary-font-loader.ts',
        outputPath: 'primary-font-loader.js',
      },
      {
        sourcePath: 'browser/classic-runtime/static-language.ts',
        outputPath: 'static-language.js',
      },
      {
        sourcePath: 'browser/classic-runtime/wordmark-anim.ts',
        outputPath: 'wordmark-anim.js',
      },
    ]);
    await expect(assertClassicRuntimeSourceCompleteness(REPO_ROOT)).resolves.toBeUndefined();

    expect(() =>
      assertClassicRuntimeManifest([
        ...CLASSIC_RUNTIME_ASSETS,
        {
          sourcePath: CLASSIC_RUNTIME_ASSETS[0].sourcePath,
          outputPath: 'duplicate.js',
        },
      ]),
    ).toThrow('Duplicate classic-runtime source');
  });

  it('fails closed when the owned source directory contains a non-TS file', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'mxqr-classic-runtime-'));
    const sourcePath = 'browser/classic-runtime/fixture.ts';
    try {
      await mkdir(resolve(fixtureRoot, 'browser/classic-runtime'), { recursive: true });
      await mkdir(resolve(fixtureRoot, 'public'), { recursive: true });
      await writeFile(resolve(fixtureRoot, sourcePath), '(function () {})();\n', 'utf8');
      await writeFile(
        resolve(fixtureRoot, 'browser/classic-runtime/unmanaged.js'),
        '(function () {})();\n',
        'utf8',
      );

      await expect(
        assertClassicRuntimeSourceCompleteness(fixtureRoot, [
          { sourcePath, outputPath: 'fixture.js' },
        ]),
      ).rejects.toThrow('unsupported: browser/classic-runtime/unmanaged.js');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('maps only the exact historic URLs, independent of query strings', () => {
    for (const asset of CLASSIC_RUNTIME_ASSETS) {
      expect(classicRuntimeAssetForRequestUrl(`/${asset.outputPath}?dev=1`)).toEqual(asset);
    }
    expect(classicRuntimeAssetForRequestUrl('/events/theme.ts')).toBeNull();
    expect(classicRuntimeAssetForRequestUrl('/wordmark-anim.js.map')).toBeNull();
    expect(classicRuntimeAssetForRequestUrl('/WORDMARK-ANIM.JS')).toBeNull();
  });

  it('serves stable dev URLs as generated classic JavaScript with no sourcemap', async () => {
    const middleware = await classicRuntimeDevMiddleware();
    const expectedAssets = new Map(
      (await compileClassicRuntimeAssets(REPO_ROOT)).map((asset) => [asset.outputPath, asset.code]),
    );
    const outputMarkers: Readonly<Record<string, string>> = {
      'account-complete.js': 'mxqr-account-refresh',
      'admin.js': 'ADMIN_SCRIPT_VERSION',
      'analytics-bootstrap.js': 'installStandaloneAnalytics',
      'blog-pagination.js': 'installBlogPagination',
      'clearable-editors.js': 'clearable-editor-button',
      'bootstrap.js': '__mxqrTakeProRoomFragmentClaims',
      'editorial-pages.js': 'installEditorialPageRuntime',
      'events/event.js': 'CAMPAIGN_SLUG_PATTERN',
      'events/theme.js': 'applyInitialEventTheme',
      'fouc-cleanup.js': 'installFoucCleanup',
      'landing-bootstrap.js': 'applyInitialLandingPreferences',
      'landing-i18n.js': '__landingT',
      'policy-accordion.js': 'details.policy-accordion',
      'primary-font-loader.js': '__mxqrPrimaryFontRuntime',
      'static-language.js': 'MXQRStaticLang',
      'wordmark-anim.js': 'installWordmarkTiming',
    };

    for (const asset of CLASSIC_RUNTIME_ASSETS) {
      const headers = new Map<string, string>();
      let body: string | undefined;
      const next = vi.fn();
      const response = {
        statusCode: 0,
        setHeader(name: string, value: string) {
          headers.set(name.toLowerCase(), value);
        },
        end(value?: string) {
          body = value;
        },
      };

      await middleware({ method: 'GET', url: `/${asset.outputPath}?hmr=1` }, response, next);

      expect(next, asset.outputPath).not.toHaveBeenCalled();
      expect(response.statusCode, asset.outputPath).toBe(200);
      expect(headers.get('content-type'), asset.outputPath).toBe('text/javascript; charset=utf-8');
      expect(headers.get('cache-control'), asset.outputPath).toBe('no-cache');
      expect(body, asset.outputPath).toBe(expectedAssets.get(asset.outputPath));
      expect(body, asset.outputPath).toContain(outputMarkers[asset.outputPath]);
      expect(body, asset.outputPath).not.toContain('sourceMappingURL');

      const headHeaders = new Map<string, string>();
      let headBody: string | undefined;
      const headNext = vi.fn();
      const headResponse = {
        statusCode: 0,
        setHeader(name: string, value: string) {
          headHeaders.set(name.toLowerCase(), value);
        },
        end(value?: string) {
          headBody = value;
        },
      };

      await middleware(
        { method: 'HEAD', url: `/${asset.outputPath}?hmr=1` },
        headResponse,
        headNext,
      );

      expect(headNext, asset.outputPath).not.toHaveBeenCalled();
      expect(headResponse.statusCode, asset.outputPath).toBe(200);
      expect(headHeaders.get('content-type'), asset.outputPath).toBe(
        'text/javascript; charset=utf-8',
      );
      expect(headHeaders.get('cache-control'), asset.outputPath).toBe('no-cache');
      expect(headBody, asset.outputPath).toBeUndefined();
    }
  });

  it('generates executable IIFE scripts without module or sourcemap syntax', async () => {
    for (const asset of await compileClassicRuntimeAssets(REPO_ROOT)) {
      expect(asset.code.trimStart()).toMatch(/^(?:"use strict";\s*)?\(\(\)\s*=>\s*\{/u);
      expect(asset.code).not.toMatch(/^\s*(?:import|export)\b/mu);
      expect(asset.code).not.toContain('sourceMappingURL');
      expect(() => Function(asset.code)).not.toThrow();
    }
  });

  it.each([
    ['on', 'more'],
    ['off', 'normal'],
    ['invalid', null],
    [null, null],
  ] as const)(
    'applies the first-paint contrast preflight for stored %s',
    async (stored, expected) => {
      const code = await compiledContrastPreflight();
      const rootAttributes = new Map<string, string>([['data-contrast', 'stale']]);
      const document = {
        documentElement: {
          setAttribute(name: string, value: string) {
            rootAttributes.set(name, value);
          },
          removeAttribute(name: string) {
            rootAttributes.delete(name);
          },
        },
      };

      executeClassicScript(code, {
        document,
        localStorage: { getItem: () => stored },
      });

      expect(rootAttributes.get('data-contrast') ?? null).toBe(expected);
    },
  );

  it('keeps first-paint contrast in auto when storage access is denied', async () => {
    const code = await compiledContrastPreflight();
    const rootAttributes = new Map<string, string>([['data-contrast', 'stale']]);
    const document = {
      documentElement: {
        setAttribute(name: string, value: string) {
          rootAttributes.set(name, value);
        },
        removeAttribute(name: string) {
          rootAttributes.delete(name);
        },
      },
    };

    executeClassicScript(code, {
      document,
      localStorage: {
        getItem() {
          throw new DOMException('blocked');
        },
      },
    });

    expect(rootAttributes.has('data-contrast')).toBe(false);
  });

  it('applies the event theme synchronously with the original global side effects', async () => {
    const { code } = await compiledAsset('events/theme.js');
    const rootAttributes = new Map<string, string>();
    const metadata = new Map<string, string>();
    const documentElement = {
      style: { colorScheme: '' },
      setAttribute(name: string, value: string) {
        rootAttributes.set(name, value);
      },
    };
    const document = {
      documentElement,
      querySelector(selector: string) {
        return {
          setAttribute(name: string, value: string) {
            metadata.set(`${selector}:${name}`, value);
          },
        };
      },
    };

    executeClassicScript(code, {
      document,
      localStorage: { getItem: () => 'system' },
      window: { matchMedia: () => ({ matches: true }) },
    });

    expect(rootAttributes.get('data-theme')).toBe('dark');
    expect(documentElement.style.colorScheme).toBe('dark');
    expect(metadata.get('meta[name="color-scheme"]:content')).toBe('dark');
    expect(metadata.get('meta[name="theme-color"]:content')).toBe('#121212');
  });

  it('preserves deferred wordmark timing and its DOMContentLoaded boundary', async () => {
    const { code } = await compiledAsset('wordmark-anim.js');
    const firstWrites = new Map<string, string>();
    const secondWrites = new Map<string, string>();
    const ready = vi.fn();
    const document = {
      readyState: 'loading',
      querySelectorAll: () => [
        {
          dataset: { wt: '120', wd: '30' },
          style: { setProperty: (name: string, value: string) => firstWrites.set(name, value) },
        },
        {
          dataset: { wt: '240' },
          style: { setProperty: (name: string, value: string) => secondWrites.set(name, value) },
        },
      ],
      addEventListener(eventName: string, listener: () => void) {
        expect(eventName).toBe('DOMContentLoaded');
        ready.mockImplementation(listener);
      },
    };

    executeClassicScript(code, { document });
    expect(firstWrites.size).toBe(0);

    ready();
    expect(Object.fromEntries(firstWrites)).toEqual({ '--wt': '120ms', '--wd': '30ms' });
    expect(Object.fromEntries(secondWrites)).toEqual({ '--wt': '240ms' });
  });

  it('paginates compiled editorial cards without changing the classic DOMContentLoaded boundary', async () => {
    const { code } = await compiledAsset('blog-pagination.js');
    const cards = Array.from(
      { length: 12 },
      (_, index) => `<article class="soro-blog-card" data-card="${index + 1}"></article>`,
    ).join('');
    const dom = new JSDOM(
      `<!doctype html><html><body><section id="articles"><div id="soro-blog"><div class="soro-blog-list">${cards}</div></div></section></body></html>`,
      { runScripts: 'outside-only', url: 'https://musixquare.com/blog' },
    );
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(dom.window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();

    dom.window.eval(code);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    frames.shift()?.(0);

    const renderedCards = Array.from(
      dom.window.document.querySelectorAll<HTMLElement>('.soro-blog-card'),
    );
    expect(renderedCards.slice(0, 10).every((card) => !card.hidden)).toBe(true);
    expect(renderedCards.slice(10).every((card) => card.hidden)).toBe(true);
    expect(dom.window.document.querySelector('.soro-blog-page-status')?.textContent).toBe(
      'Articles 1-10 of 12',
    );

    dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Next page"]')?.click();
    expect(renderedCards.slice(0, 10).every((card) => card.hidden)).toBe(true);
    expect(renderedCards.slice(10).every((card) => !card.hidden)).toBe(true);
    expect(dom.window.document.querySelector('.soro-blog-page-status')?.textContent).toBe(
      'Articles 11-12 of 12',
    );
    dom.window.close();
  });

  it('boots compiled editorial chrome and reveal behavior through the original parser boundary', async () => {
    const { code } = await compiledAsset('editorial-pages.js');
    const dom = new JSDOM(
      `<!doctype html><html><head><meta name="theme-color" content="#fff"></head><body>
        <header class="lp-header is-loading"><div class="lp-header-progress"></div></header>
        <main><section id="articles" data-animate></section></main>
      </body></html>`,
      { runScripts: 'outside-only', url: 'https://musixquare.com/blog' },
    );
    const timers: Array<() => void> = [];
    Object.defineProperty(dom.window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true, addEventListener: vi.fn() }),
    });
    Object.defineProperty(dom.window.navigator, 'standalone', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(dom.window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    Object.defineProperty(dom.window, 'setTimeout', {
      configurable: true,
      value: (callback: () => void) => {
        timers.push(callback);
        return timers.length;
      },
    });

    dom.window.eval(code);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

    const root = dom.window.document.documentElement;
    expect(root.style.colorScheme).toBe('dark');
    expect(root.classList.contains('standalone')).toBe(true);
    expect(root.classList.contains('ios-standalone')).toBe(true);
    expect(
      dom.window.document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    ).toBe('#1a1a1a');
    expect(dom.window.document.getElementById('articles')?.classList.contains('is-visible')).toBe(
      true,
    );

    expect(dom.window.document.querySelector('.lp-header')?.classList.contains('is-loading')).toBe(
      true,
    );
    timers.at(-1)?.();
    expect(dom.window.document.querySelector('.lp-header')?.classList.contains('is-loading')).toBe(
      false,
    );
    dom.window.close();
  });

  it('runs the deferred event runtime from compiled output against the parsed event document', async () => {
    const [{ code }, eventHtml] = await Promise.all([
      compiledAsset('events/event.js'),
      readFile(resolve(REPO_ROOT, 'public/events/index.html'), 'utf8'),
    ]);
    const dom = new JSDOM(eventHtml, {
      pretendToBeVisual: true,
      runScripts: 'outside-only',
      url: 'https://musixquare.com/events/asamo-2026',
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          campaign: { slug: 'asamo-2026', status: 'active', title: 'MUSIXQUARE ASAMO' },
          account: { authenticated: false, profileComplete: false },
          redemption: null,
        }),
    }));
    Object.defineProperty(dom.window, 'fetch', { configurable: true, value: fetchMock });

    try {
      dom.window.eval(code);
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(dom.window.document.documentElement.dataset.view).toBe('login');
      });
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/pro-grants/campaigns/asamo-2026/session',
        expect.objectContaining({ cache: 'no-store', credentials: 'same-origin', method: 'GET' }),
      );
      expect(dom.window.document.title).toBe('MUSIXQUARE ASAMO');
      expect(dom.window.document.getElementById('campaign-name')?.textContent).toBe('ASAMO');
    } finally {
      dom.window.close();
    }
  });

  it('applies compiled landing locale payloads and preserves the global change-listener contract', async () => {
    const [{ code }, landingHtml] = await Promise.all([
      compiledAsset('landing-i18n.js'),
      readFile(resolve(REPO_ROOT, '.workshop/landing/landing.html'), 'utf8'),
    ]);
    const dom = new JSDOM(landingHtml, {
      runScripts: 'outside-only',
      url: 'https://musixquare.com/about',
    });
    const updates: string[] = [];
    const normalize = (value: unknown): string | null => {
      const raw = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/_/gu, '-');
      if (raw === 'nl' || raw.startsWith('nl-')) return 'nl';
      if (raw === 'zh-hant' || raw.startsWith('zh-hant-')) return 'zh-hant';
      return raw === 'en' ? 'en' : null;
    };
    const landingWindow = dom.window as unknown as typeof dom.window & {
      MXQRStaticLang?: {
        normalize(value: unknown): string | null;
        resolve(fallback: unknown): string;
        htmlLang(code: unknown): string;
        locale(code: unknown): string;
        update(code: unknown): void;
      };
      __landingLang?: string;
      __landingT?: (key: string, fallback?: string) => string;
    };
    landingWindow.MXQRStaticLang = {
      normalize,
      resolve: () => 'nl',
      htmlLang: (code) => (code === 'zh-hant' ? 'zh-Hant' : String(code)),
      locale: (code) => (code === 'zh-hant' ? 'zh_TW' : code === 'nl' ? 'nl_NL' : 'en_US'),
      update: (code) => updates.push(String(code)),
    };
    landingWindow.__landingLang = 'nl';
    landingWindow.document.documentElement.dir = 'rtl';

    try {
      landingWindow.eval(code);
      expect(landingWindow.document.title).toBe('Over MUSIXQUARE');
      expect(landingWindow.document.documentElement.lang).toBe('nl');
      expect(landingWindow.document.documentElement.dir).toBe('rtl');
      expect(landingWindow.document.querySelector('[data-i18n="header.try"]')?.textContent).toBe(
        'Nu proberen',
      );
      expect(landingWindow.__landingT?.('missing.key', 'Fallback copy')).toBe('Fallback copy');

      landingWindow.dispatchEvent(
        new landingWindow.CustomEvent('mxqr:static-language-change', {
          detail: { lang: 'zh-Hant-TW' },
        }),
      );

      expect(landingWindow.__landingLang).toBe('zh-hant');
      expect(landingWindow.document.documentElement.lang).toBe('zh-Hant');
      expect(landingWindow.document.documentElement.dir).toBe('rtl');
      expect(landingWindow.document.title).toBe('關於 MUSIXQUARE');
      expect(
        landingWindow.document.querySelector('meta[property="og:locale"]')?.getAttribute('content'),
      ).toBe('zh_TW');
      expect(updates).toEqual(['nl', 'zh-hant']);
    } finally {
      landingWindow.close();
    }
  });

  it('keeps HTML, CSP-safe classic tags, and service-worker cache URLs unchanged', async () => {
    const [eventHtml, appHtml, landingHtml, faqHtml, accountHtml, blogHtml, serviceWorker] =
      await Promise.all([
        readFile(resolve(REPO_ROOT, 'public/events/index.html'), 'utf8'),
        readFile(resolve(REPO_ROOT, 'index.html'), 'utf8'),
        readFile(resolve(REPO_ROOT, '.workshop/landing/landing.html'), 'utf8'),
        readFile(resolve(REPO_ROOT, '.workshop/faq/faq.html'), 'utf8'),
        readFile(resolve(REPO_ROOT, 'public/account-complete.html'), 'utf8'),
        readFile(resolve(REPO_ROOT, 'public/blog/index.html'), 'utf8'),
        compileServiceWorkerAsset(REPO_ROOT).then(({ code }) => code),
      ]);

    expect(eventHtml).toContain('<script src="/events/theme.js"></script>');
    expect(eventHtml).toContain('<script src="/clearable-editors.js" defer></script>');
    expect(eventHtml).toContain('<script src="/events/event.js" defer></script>');
    expect(appHtml).toContain('<script src="/fouc-cleanup.js"></script>');
    expect(appHtml).toContain('<script src="/wordmark-anim.js" defer></script>');
    expect(appHtml).toMatch(/<script src="\/bootstrap\.js\?cache=v\d+"><\/script>/u);
    expect(landingHtml).toContain('<script src="/static-language.js"></script>');
    expect(landingHtml).toContain('<script src="/landing-bootstrap.js"></script>');
    expect(landingHtml).toContain('<script src="/landing-i18n.js"></script>');
    expect(landingHtml).toContain('<script defer src="/analytics-bootstrap.js"></script>');
    expect(faqHtml).toContain('<script defer src="/policy-accordion.js"></script>');
    expect(faqHtml).toContain('<script defer src="/analytics-bootstrap.js"></script>');
    expect(accountHtml).toContain('<script src="/account-complete.js" defer></script>');
    expect(blogHtml).toContain('<script src="/editorial-pages.js"></script>');
    expect(blogHtml).toContain('<script src="/blog-pagination.js" defer></script>');
    expect(eventHtml).not.toContain('type="module" src="/events/theme.js"');
    expect(eventHtml).not.toContain('type="module" src="/clearable-editors.js"');
    expect(eventHtml).not.toContain('type="module" src="/events/event.js"');
    expect(appHtml).not.toContain('type="module" src="/fouc-cleanup.js"');
    expect(appHtml).not.toContain('type="module" src="/wordmark-anim.js"');
    expect(appHtml).not.toContain('type="module" src="/bootstrap.js');
    expect(landingHtml).not.toContain('type="module" src="/static-language.js"');
    expect(landingHtml).not.toContain('type="module" src="/landing-i18n.js"');
    expect(accountHtml).not.toContain('type="module" src="/account-complete.js"');
    expect(blogHtml).not.toContain('type="module" src="/editorial-pages.js"');
    expect(blogHtml).not.toContain('type="module" src="/blog-pagination.js"');
    expect(serviceWorker).toContain('./account-complete.js');
    expect(serviceWorker).toContain('./fouc-cleanup.js');
    expect(serviceWorker).toContain('./wordmark-anim.js');
    expect(serviceWorker).toContain(
      'const BOOTSTRAP_CACHE_KEY = `./bootstrap.js?cache=${CACHE_VERSION}`;',
    );
    expect(eventHtml.indexOf('/events/theme.js')).toBeLessThan(
      eventHtml.indexOf('/clearable-editors.js'),
    );
    expect(eventHtml.indexOf('/clearable-editors.js')).toBeLessThan(
      eventHtml.indexOf('/events/event.js'),
    );
    expect(landingHtml.indexOf('/static-language.js')).toBeLessThan(
      landingHtml.indexOf('/landing-bootstrap.js'),
    );
    expect(landingHtml.indexOf('/landing-bootstrap.js')).toBeLessThan(
      landingHtml.indexOf('/landing-i18n.js'),
    );
  });
});
