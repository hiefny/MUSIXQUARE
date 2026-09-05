import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
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
) => void;

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
  it('resolves the event page font to the deployed canonical Pretendard bytes', async () => {
    const html = await readFile(join(REPO_ROOT, 'public/events/index.html'), 'utf8');
    const document = new JSDOM(html, { url: 'https://musixquare.com/events/asamo' });
    const stylesheet =
      document.window.document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]');
    expect(stylesheet?.href).toBe('https://musixquare.com/events/event.css');
    const css = await readFile(join(REPO_ROOT, 'public/events/event.css'), 'utf8');
    const fontUrl = /@font-face\s*\{[^}]*src:\s*url\(['"]([^'"]+)['"]\)/u.exec(css)?.[1];
    expect(fontUrl).toBeTruthy();
    const assetUrl = new URL(fontUrl!, stylesheet!.href);
    expect(assetUrl.origin).toBe('https://musixquare.com');
    const deployedFont = await readFile(join(REPO_ROOT, 'public', assetUrl.pathname));
    const canonicalFont = await readFile(join(REPO_ROOT, 'fonts/PretendardVariable.woff2'));
    expect(deployedFont.subarray(0, 4).toString('ascii')).toBe('wOF2');
    expect(deployedFont.equals(canonicalFont)).toBe(true);
    document.window.close();
  });

  it('owns every source and stable output through one complete manifest', async () => {
    expect(CLASSIC_RUNTIME_ASSETS).toEqual([
      {
        sourcePath: 'browser/classic-runtime/account-complete.ts',
        outputPath: 'account-complete.js',
        target: 'es2018',
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
        minify: true,
        target: 'es2018',
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
        target: 'es2018',
      },
      {
        sourcePath: 'browser/classic-runtime/static-language.ts',
        outputPath: 'static-language.js',
      },
      {
        sourcePath: 'browser/classic-runtime/wordmark-anim.ts',
        outputPath: 'wordmark-anim.js',
        minify: true,
        target: 'es2018',
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
      'fouc-cleanup.js': 'setup-boot-failed',
      'landing-bootstrap.js': 'applyInitialLandingPreferences',
      'landing-i18n.js': '__landingT',
      'policy-accordion.js': 'details.policy-accordion',
      'primary-font-loader.js': '__mxqrPrimaryFontRuntime',
      'static-language.js': 'MXQRStaticLang',
      'wordmark-anim.js': '[data-wt]',
    };

    for (const asset of CLASSIC_RUNTIME_ASSETS) {
      const headers = new Map<string, string>();
      let body: string | undefined;
      let finishRequest = (): void => undefined;
      const requestHandled = new Promise<void>((resolve) => {
        finishRequest = resolve;
      });
      const next = vi.fn(() => {
        finishRequest();
      });
      const response = {
        statusCode: 0,
        setHeader(name: string, value: string) {
          headers.set(name.toLowerCase(), value);
        },
        end(value?: string) {
          body = value;
          finishRequest();
        },
      };

      middleware({ method: 'GET', url: `/${asset.outputPath}?hmr=1` }, response, next);
      await requestHandled;

      expect(next, asset.outputPath).not.toHaveBeenCalled();
      expect(response.statusCode, asset.outputPath).toBe(200);
      expect(headers.get('content-type'), asset.outputPath).toBe('text/javascript; charset=utf-8');
      expect(headers.get('cache-control'), asset.outputPath).toBe('no-cache');
      expect(body, asset.outputPath).toBe(expectedAssets.get(asset.outputPath));
      expect(body, asset.outputPath).toContain(outputMarkers[asset.outputPath]);
      expect(body, asset.outputPath).not.toContain('sourceMappingURL');

      const headHeaders = new Map<string, string>();
      let headBody: string | undefined;
      let finishHeadRequest = (): void => undefined;
      const headRequestHandled = new Promise<void>((resolve) => {
        finishHeadRequest = resolve;
      });
      const headNext = vi.fn(() => {
        finishHeadRequest();
      });
      const headResponse = {
        statusCode: 0,
        setHeader(name: string, value: string) {
          headHeaders.set(name.toLowerCase(), value);
        },
        end(value?: string) {
          headBody = value;
          finishHeadRequest();
        },
      };

      middleware({ method: 'HEAD', url: `/${asset.outputPath}?hmr=1` }, headResponse, headNext);
      await headRequestHandled;

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

  it.each([false, true])(
    'paginates compiled editorial cards with reduced motion %s without changing the classic DOMContentLoaded boundary',
    async (reducedMotion) => {
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
      Object.defineProperty(dom.window, 'matchMedia', {
        configurable: true,
        value: (query: string) => ({
          matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion,
        }),
      });

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
      expect(dom.window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'start',
      });
      dom.window.close();
    },
  );

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

  it.each([
    { page: 'editorial', reducedMotion: false },
    { page: 'editorial', reducedMotion: true },
    { page: 'about', reducedMotion: false },
    { page: 'about', reducedMotion: true },
  ])(
    '$page anchor navigation preserves modified browser gestures with reduced motion $reducedMotion',
    async ({ page, reducedMotion }) => {
      const { code } =
        page === 'editorial'
          ? await compiledAsset('editorial-pages.js')
          : await transformWithEsbuild(
              await readFile(resolve(REPO_ROOT, '.workshop/landing/main.ts'), 'utf8'),
              'landing-main.ts',
              { loader: 'ts', format: 'iife', target: 'es2018' },
            );
      const html = await readFile(
        resolve(
          REPO_ROOT,
          page === 'editorial' ? 'public/blog/index.html' : '.workshop/landing/landing.html',
        ),
        'utf8',
      );
      const dom = new JSDOM(html, {
        url: `https://musixquare.com/${page === 'editorial' ? 'blog' : 'about'}`,
        runScripts: 'outside-only',
      });
      try {
        Object.defineProperty(dom.window.document, 'readyState', {
          configurable: true,
          value: 'complete',
        });
        dom.window.requestAnimationFrame = vi.fn(() => 1);
        Object.defineProperty(dom.window, 'matchMedia', {
          configurable: true,
          value: vi.fn((query: string) => ({
            matches: query === '(prefers-reduced-motion: reduce)' ? reducedMotion : true,
            addEventListener: vi.fn(),
          })),
        });
        dom.window.scrollTo = vi.fn();
        dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
        dom.window.eval(code);
        const link = dom.window.document.querySelector<HTMLAnchorElement>('a[href="#top"]')!;
        expect(link).not.toBeNull();
        for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
          const gesture = new dom.window.MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
            [modifier]: true,
          });
          link.dispatchEvent(gesture);
          expect(gesture.defaultPrevented, modifier).toBe(false);
          expect(dom.window.scrollTo).not.toHaveBeenCalled();
        }
        const cancelled = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
        cancelled.preventDefault();
        link.dispatchEvent(cancelled);
        expect(dom.window.scrollTo).not.toHaveBeenCalled();
        const ordinary = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
        link.dispatchEvent(ordinary);
        expect(ordinary.defaultPrevented).toBe(true);
        expect(dom.window.scrollTo).toHaveBeenCalledExactlyOnceWith({
          top: 0,
          behavior: reducedMotion ? 'auto' : 'smooth',
        });
        const sectionLink =
          dom.window.document.querySelector<HTMLAnchorElement>('a.lp-btn[href^="#"]')!;
        const sectionClick = new dom.window.MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        });
        sectionLink.dispatchEvent(sectionClick);
        expect(sectionClick.defaultPrevented).toBe(true);
        expect(dom.window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
          behavior: reducedMotion ? 'auto' : 'smooth',
          block: 'start',
        });
      } finally {
        dom.window.close();
      }
    },
  );

  it('preserves explicit and stored locale intent across editorial and app links', async () => {
    const { code } = await compiledAsset('editorial-pages.js');
    const markup = `<!doctype html><html><body data-soro-view="article">
      <header><a class="lp-try" href="https://musixquare.com">Open app</a></header>
      <a class="lp-logo" href="https://musixquare.com">MUSIXQUARE</a>
      <nav>
        <a class="editorial-site-tab" href="/about">About</a>
        <a class="editorial-site-tab" href="/blog">Blog</a>
        <a class="editorial-site-tab" href="/history">History</a>
        <a class="editorial-site-tab" href="/designsystem">Design</a>
      </nav>
      <footer><a href="https://musixquare.com">App</a></footer>
    </body></html>`;

    const explicit = new JSDOM(markup, {
      runScripts: 'outside-only',
      url: 'https://musixquare.com/history?lang=ko',
    });
    explicit.window.localStorage.setItem('musixquare-lang', 'en');
    explicit.window.eval(code);
    explicit.window.document.dispatchEvent(new explicit.window.Event('DOMContentLoaded'));

    const explicitTabs = Array.from(
      explicit.window.document.querySelectorAll<HTMLAnchorElement>('.editorial-site-tab'),
      (link) => link.getAttribute('href'),
    );
    expect(explicitTabs).toEqual([
      '/ko/about',
      '/blog?lang=ko',
      '/history?lang=ko',
      '/designsystem?lang=ko',
    ]);
    expect(explicit.window.document.querySelector<HTMLAnchorElement>('.lp-try')?.pathname).toBe(
      '/ko/',
    );
    expect(explicit.window.document.querySelector<HTMLAnchorElement>('footer a')?.pathname).toBe(
      '/ko/',
    );
    expect(explicit.window.document.querySelector<HTMLAnchorElement>('.lp-logo')?.pathname).toBe(
      '/ko/',
    );
    explicit.window.close();

    const stored = new JSDOM(markup, {
      runScripts: 'outside-only',
      url: 'https://musixquare.com/blog?lang=unsupported',
    });
    stored.window.localStorage.setItem('musixquare-lang', 'ja');
    stored.window.eval(code);
    stored.window.document.dispatchEvent(new stored.window.Event('DOMContentLoaded'));

    expect(
      stored.window.document
        .querySelector<HTMLAnchorElement>('.editorial-site-tab')
        ?.getAttribute('href'),
    ).toBe('/ja/about');
    expect(stored.window.document.querySelector<HTMLAnchorElement>('.lp-try')?.pathname).toBe(
      '/ja/',
    );
    stored.window.close();

    const english = new JSDOM(markup, {
      runScripts: 'outside-only',
      url: 'https://musixquare.com/blog',
    });
    english.window.localStorage.setItem('musixquare-lang', 'en');
    english.window.eval(code);
    english.window.document.dispatchEvent(new english.window.Event('DOMContentLoaded'));

    expect(english.window.document.querySelector<HTMLAnchorElement>('.lp-try')?.pathname).toBe('/');
    expect(english.window.document.querySelector<HTMLAnchorElement>('footer a')?.pathname).toBe(
      '/',
    );
    expect(english.window.document.querySelector<HTMLAnchorElement>('.lp-logo')?.pathname).toBe(
      '/',
    );
    english.window.close();
  });

  it.each(['editorial', 'about'])(
    'restores %s navigation after returning from the back-forward cache',
    async (page) => {
      const { code } =
        page === 'editorial'
          ? await compiledAsset('editorial-pages.js')
          : await transformWithEsbuild(
              await readFile(resolve(REPO_ROOT, '.workshop/landing/main.ts'), 'utf8'),
              'landing-main.ts',
              { loader: 'ts', format: 'iife', target: 'es2018' },
            );
      const dom = new JSDOM(
        '<header class="lp-header"><a class="editorial-site-tab" href="/history">History</a></header>',
        { url: 'https://musixquare.com/blog', runScripts: 'outside-only' },
      );
      const assign = vi.fn();
      try {
        executeClassicScript(code, {
          window: {
            location: {
              href: dom.window.location.href,
              origin: dom.window.location.origin,
              assign,
            },
            addEventListener: dom.window.addEventListener.bind(dom.window),
            requestAnimationFrame: (callback: () => void) => {
              callback();
              return 1;
            },
            setTimeout: dom.window.setTimeout.bind(dom.window),
          },
          document: dom.window.document,
          location: dom.window.location,
          navigator: dom.window.navigator,
          localStorage: dom.window.localStorage,
          requestAnimationFrame: (callback: () => void) => {
            callback();
            return 1;
          },
        });
        dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
        const tab = dom.window.document.querySelector<HTMLAnchorElement>('.editorial-site-tab')!;
        tab.click();
        await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
        dom.window.dispatchEvent(
          new dom.window.PageTransitionEvent('pageshow', { persisted: true }),
        );
        tab.click();
        await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
      } finally {
        dom.window.close();
      }
    },
  );

  it('preserves keyboard pagination focus across rebuilt blog controls', async () => {
    const { code } = await compiledAsset('blog-pagination.js');
    const dom = new JSDOM(
      `<div id="soro-blog"><div class="soro-blog-list">${Array.from({ length: 21 }, () => '<article class="soro-blog-card"></article>').join('')}</div></div>`,
      { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://musixquare.com/blog' },
    );
    try {
      dom.window.eval(code);
      dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
      const { document } = dom.window;
      await vi.waitFor(() =>
        expect(document.querySelector('[data-blog-pagination]')).not.toBeNull(),
      );
      const next = () => document.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!;
      next().focus();
      next().click();
      expect(document.activeElement).toBe(next());
      expect(document.querySelectorAll('.soro-blog-card:not([hidden])')).toHaveLength(10);
      next().click();
      expect(next().disabled).toBe(true);
      expect(document.activeElement).toBe(document.querySelector('[aria-current="page"]'));
      expect(document.activeElement?.textContent).toBe('3');
    } finally {
      dom.window.close();
    }
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

  it.each(['normal', 'late-anonymous', 'late-failure'])(
    'observes compiled popup authentication after a %s session read',
    async (scenario) => {
      const [eventAsset, completionAsset, eventHtml, completionHtml] = await Promise.all([
        compiledAsset('events/event.js'),
        compiledAsset('account-complete.js'),
        readFile(resolve(REPO_ROOT, 'public/events/index.html'), 'utf8'),
        readFile(resolve(REPO_ROOT, 'public/account-complete.html'), 'utf8'),
      ]);
      const dom = new JSDOM(eventHtml, {
        pretendToBeVisual: true,
        runScripts: 'outside-only',
        url: 'https://musixquare.com/events/asamo-2026',
      });
      const channels = new Set<TestChannel>();
      let deliveredSignals = 0;
      class TestChannel {
        listeners: ((event: { data: unknown }) => void)[] = [];
        constructor(readonly name: string) {
          channels.add(this);
        }
        addEventListener(type: string, listener: (event: { data: unknown }) => void) {
          if (type === 'message') this.listeners.push(listener);
        }
        postMessage(data: unknown) {
          for (const target of channels) {
            if (target === this || target.name !== this.name) continue;
            for (const listener of target.listeners) {
              queueMicrotask(() => {
                listener({ data });
                deliveredSignals += 1;
              });
            }
          }
        }
        close() {
          channels.delete(this);
        }
      }
      let authenticated = false;
      let releaseOldRead: (() => void) | undefined;
      let loginUrl = '';
      const popup = {
        closed: false,
        opener: null,
        location: {
          replace: (url: string) => {
            loginUrl = url;
          },
        },
        focus() {},
        close() {
          this.closed = true;
        },
      };
      const fetchMock = vi.fn(async (path: string) => {
        expect(path).toBe('/api/pro-grants/campaigns/asamo-2026/session');
        // The server samples the cookie when the request starts, before its response arrives.
        const snapshot = {
          campaign: { slug: 'asamo-2026', status: 'active', title: 'MUSIXQUARE ASAMO' },
          account: {
            authenticated,
            profileComplete: authenticated,
            ...(authenticated ? { statsScope: 'A'.repeat(43) } : {}),
          },
          redemption: null,
        };
        if (scenario !== 'normal' && fetchMock.mock.calls.length === 2) {
          await new Promise<void>((resolve) => {
            releaseOldRead = resolve;
          });
          if (scenario === 'late-failure') throw new TypeError('Delayed network failure');
        }
        return Response.json(snapshot);
      });
      Object.assign(dom.window, {
        BroadcastChannel: TestChannel,
        open: () => popup,
        fetch: fetchMock,
      });
      let completion: JSDOM | undefined;
      try {
        dom.window.eval(eventAsset.code);
        const { document } = dom.window;
        await vi.waitFor(() => expect(document.documentElement.dataset.view).toBe('login'));
        document.getElementById('account-action')!.click();
        expect(loginUrl).toMatch(/^\/api\/auth\/google\/start\?returnTo=/);
        if (scenario !== 'normal') {
          dom.window.dispatchEvent(new dom.window.Event('focus'));
          await vi.waitFor(() => expect(releaseOldRead).toBeTypeOf('function'));
        }
        authenticated = true;
        const returnTo = new URL(loginUrl, dom.window.location.origin).searchParams.get(
          'returnTo',
        )!;
        completion = new JSDOM(completionHtml, {
          runScripts: 'outside-only',
          url: `https://musixquare.com${returnTo}&accountAuth=success`,
        });
        Object.assign(completion.window, { BroadcastChannel: TestChannel });
        completion.window.eval(completionAsset.code);
        await vi.waitFor(() => expect(deliveredSignals).toBe(1));
        releaseOldRead?.();
        await vi.waitFor(() => expect(document.documentElement.dataset.view).toBe('redeem'));
        expect(fetchMock).toHaveBeenCalledTimes(scenario === 'normal' ? 2 : 3);
        expect((document.getElementById('account-action') as HTMLButtonElement).disabled).toBe(
          false,
        );
      } finally {
        releaseOldRead?.();
        completion?.window.close();
        dom.window.close();
      }
    },
  );

  it.each(['normal', 'refresh', 'changed-cookie', 'replaced-dialog'])(
    'fences the compiled event nickname intent through %s',
    async (scenario) => {
      const [{ code }, eventHtml] = await Promise.all([
        compiledAsset('events/event.js'),
        readFile(resolve(REPO_ROOT, 'public/events/index.html'), 'utf8'),
      ]);
      const dom = new JSDOM(eventHtml, {
        pretendToBeVisual: true,
        runScripts: 'outside-only',
        url: 'https://musixquare.com/events/asamo-2026',
      });
      const scopeA = 'A'.repeat(43);
      const scopeB = 'B'.repeat(43);
      let serverScope = scopeA;
      let profileComplete = false;
      let resolveMutation: ((value: Response) => void) | null = null;
      const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
        if (path.endsWith('/session'))
          return Response.json({
            campaign: { slug: 'asamo-2026', status: 'active', title: 'MUSIXQUARE ASAMO' },
            account: { authenticated: true, profileComplete, statsScope: serverScope },
            redemption: null,
          });
        expect(path).toBe('/api/auth/profile');
        expect(new Headers(options?.headers).get('X-MXQR-Account-Expected-Scope')).toBe(scopeA);
        if (scenario === 'replaced-dialog')
          return new Promise<Response>((resolve) => {
            resolveMutation = resolve;
          });
        if (serverScope !== scopeA)
          return Response.json({ error: 'ACCOUNT_SESSION_CHANGED' }, { status: 409 });
        profileComplete = true;
        return Response.json({ authenticated: true });
      });
      Object.defineProperty(dom.window, 'fetch', { configurable: true, value: fetchMock });
      dom.window.HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute('open', '');
      };
      dom.window.HTMLDialogElement.prototype.close = function () {
        this.removeAttribute('open');
        this.dispatchEvent(new dom.window.Event('close'));
      };
      try {
        dom.window.eval(code);
        const dialog = dom.window.document.getElementById('nickname-dialog') as HTMLDialogElement;
        const input = dom.window.document.getElementById('nickname-input') as HTMLInputElement;
        const form = dom.window.document.getElementById('nickname-form') as HTMLFormElement;
        await vi.waitFor(() => expect(dialog.open).toBe(true));
        input.value = 'ConfirmedA';
        const refresh = () =>
          dom.window.dispatchEvent(
            new dom.window.MessageEvent('message', {
              origin: 'https://musixquare.com',
              data: { type: 'refresh' },
            }),
          );
        if (scenario === 'refresh') {
          refresh();
          await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
          expect(input.value).toBe('ConfirmedA');
        }
        if (scenario === 'changed-cookie') serverScope = scopeB;
        form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        if (scenario === 'replaced-dialog') {
          await vi.waitFor(() => expect(resolveMutation).not.toBeNull());
          serverScope = scopeB;
          refresh();
          await vi.waitFor(() => {
            expect(input.value).toBe('');
            expect(input.disabled).toBe(false);
            expect(dialog.open).toBe(true);
          });
          input.value = 'SuccessorB';
          resolveMutation!(Response.json({ authenticated: true }));
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(dialog.open).toBe(true);
          expect(input.value).toBe('SuccessorB');
          expect(dom.window.document.getElementById('toast')?.textContent).not.toBe(
            '닉네임을 설정했어요.',
          );
        } else if (scenario === 'changed-cookie') {
          await vi.waitFor(() =>
            expect(dom.window.document.getElementById('toast')?.textContent).toBe(
              '로그인 상태를 다시 확인해 주세요.',
            ),
          );
          expect(profileComplete).toBe(false);
          await vi.waitFor(() => expect(dialog.open).toBe(true));
          expect(input.value).toBe('');
        } else {
          await vi.waitFor(() =>
            expect(dom.window.document.documentElement.dataset.view).toBe('redeem'),
          );
          expect(dialog.open).toBe(false);
          expect(dom.window.document.getElementById('toast')?.textContent).toBe(
            '닉네임을 설정했어요.',
          );
        }
      } finally {
        dom.window.close();
      }
    },
  );

  it.each([
    'normal-refresh',
    'late-refresh',
    'late-refresh-error',
    'late-refresh-account-change',
    'changed-cookie',
    'stale-success',
    'stale-error',
  ])('keeps compiled event redemption with its captured account through %s', async (scenario) => {
    const [{ code }, eventHtml] = await Promise.all([
      compiledAsset('events/event.js'),
      readFile(resolve(REPO_ROOT, 'public/events/index.html'), 'utf8'),
    ]);
    const dom = new JSDOM(eventHtml, {
      pretendToBeVisual: true,
      runScripts: 'outside-only',
      url: 'https://musixquare.com/events/asamo-2026',
    });
    const scopeA = 'A'.repeat(43);
    let serverScope = scopeA;
    let finish: ((value: Response) => void) | null = null;
    let finishRefresh: (() => void) | null = null;
    let sessionReads = 0;
    let redeemed = false;
    const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith('/session')) {
        const snapshot = Response.json({
          campaign: { slug: 'asamo-2026', status: 'active', title: 'MUSIXQUARE ASAMO' },
          account: { authenticated: true, profileComplete: true, statsScope: serverScope },
          redemption:
            redeemed && serverScope === scopeA
              ? { status: 'redeemed', roomCode: '000100', roomGeneration: 0, setupRequired: false }
              : null,
        });
        if (++sessionReads === 2 && scenario.startsWith('late-refresh')) {
          await new Promise<void>((resolve) => {
            finishRefresh = resolve;
          });
          if (scenario === 'late-refresh-error')
            return Response.json({ error: 'SERVER_ERROR' }, { status: 503 });
        }
        return snapshot;
      }
      expect(path).toBe('/api/pro-grants/campaigns/asamo-2026/redeem');
      expect(new Headers(options?.headers).get('X-MXQR-Account-Expected-Scope')).toBe(scopeA);
      if (scenario === 'changed-cookie')
        return Response.json({ error: 'ACCOUNT_SESSION_CHANGED' }, { status: 409 });
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    Object.defineProperty(dom.window, 'fetch', { value: fetchMock });
    const refresh = () =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent('message', {
          origin: 'https://musixquare.com',
          data: { type: 'refresh' },
        }),
      );
    try {
      dom.window.eval(code);
      const doc = dom.window.document;
      const input = doc.getElementById('redeem-code') as HTMLInputElement;
      const button = doc.getElementById('redeem-submit') as HTMLButtonElement;
      await vi.waitFor(() => expect(doc.documentElement.dataset.view).toBe('redeem'));
      input.value = 'ABCDEFGH';
      if (scenario === 'changed-cookie') serverScope = 'B'.repeat(43);
      button.click();
      if (scenario === 'changed-cookie') {
        await vi.waitFor(() =>
          expect(doc.getElementById('toast')?.textContent).toBe(
            '로그인 상태를 다시 확인해 주세요.',
          ),
        );
        await vi.waitFor(() => expect(input.disabled).toBe(false));
        expect(doc.documentElement.dataset.view).toBe('redeem');
        return;
      }
      await vi.waitFor(() => expect(finish).not.toBeNull());
      // Repeated Enter dispatch must not start a second operation while busy.
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const sameAccount = scenario === 'normal-refresh' || scenario.startsWith('late-refresh');
      if (!sameAccount) serverScope = 'B'.repeat(43);
      if (scenario === 'late-refresh-account-change') serverScope = 'B'.repeat(43);
      refresh();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (!sameAccount) {
        expect(input.disabled).toBe(false);
        input.value = 'SUCCESSOR';
      }
      redeemed = true;
      finish!(
        scenario === 'stale-error'
          ? Response.json({ error: 'REDEEM_CODE_USED' }, { status: 409 })
          : Response.json({
              outcome: 'redeemed',
              roomCode: '000100',
              roomGeneration: 0,
              setupRequired: false,
            }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (sameAccount) {
        expect(doc.documentElement.dataset.view).toBe('success');
        expect(doc.getElementById('success-room-inline')?.textContent).toBe('000100');
        if (scenario.startsWith('late-refresh')) {
          expect(finishRefresh).not.toBeNull();
          finishRefresh!();
          await vi.waitFor(() => expect(sessionReads).toBe(3));
          if (scenario === 'late-refresh-account-change') {
            await vi.waitFor(() => expect(doc.documentElement.dataset.view).toBe('redeem'));
            expect(input.value).toBe('');
          } else {
            expect(doc.documentElement.dataset.view).toBe('success');
            expect(doc.getElementById('success-room-inline')?.textContent).toBe('000100');
          }
        }
      } else {
        expect(doc.documentElement.dataset.view).toBe('redeem');
        expect(input.value).toBe('SUCCESSOR');
        expect(button.disabled).toBe(false);
      }
    } finally {
      dom.window.close();
    }
  });

  it.each(['current', 'replaced', 'logout'])(
    'keeps compiled event setup navigation and copy feedback with %s ownership',
    async (scenario) => {
      const [{ code }, eventHtml] = await Promise.all([
        compiledAsset('events/event.js'),
        readFile(resolve(REPO_ROOT, 'public/events/index.html'), 'utf8'),
      ]);
      const navigation = vi.fn();
      const virtualConsole = new VirtualConsole();
      virtualConsole.on('jsdomError', (error) => {
        if (error.message.includes('navigation')) navigation();
        else throw error;
      });
      const dom = new JSDOM(eventHtml, {
        pretendToBeVisual: true,
        runScripts: 'outside-only',
        url: 'https://musixquare.com/events/asamo-2026',
        virtualConsole,
      });
      let serverScope: string | null = 'A'.repeat(43);
      let finishSetup: ((value: Response) => void) | null = null;
      let finishCopy: (() => void) | null = null;
      const fetchMock = vi.fn(async (path: string) => {
        if (path.endsWith('/session'))
          return Response.json({
            campaign: { slug: 'asamo-2026', status: 'active', title: 'MUSIXQUARE ASAMO' },
            account: {
              authenticated: !!serverScope,
              profileComplete: true,
              statsScope: serverScope,
            },
            redemption: serverScope
              ? {
                  status: 'redeemed',
                  roomCode: serverScope.startsWith('A') ? '000100' : '000101',
                  roomGeneration: 0,
                  setupRequired: true,
                }
              : null,
          });
        return new Promise<Response>((resolve) => {
          finishSetup = resolve;
        });
      });
      Object.defineProperty(dom.window, 'fetch', { value: fetchMock });
      Object.defineProperty(dom.window.navigator, 'clipboard', {
        value: {
          writeText: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                finishCopy = resolve;
              }),
          ),
        },
      });
      try {
        dom.window.eval(code);
        const doc = dom.window.document;
        await vi.waitFor(() => expect(doc.documentElement.dataset.view).toBe('success'));
        (doc.getElementById('open-room') as HTMLButtonElement).click();
        (doc.getElementById('copy-room') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(finishSetup).not.toBeNull());
        if (scenario !== 'current') {
          serverScope = scenario === 'logout' ? null : 'B'.repeat(43);
          dom.window.dispatchEvent(
            new dom.window.MessageEvent('message', {
              origin: 'https://musixquare.com',
              data: { type: 'refresh' },
            }),
          );
          await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
          await vi.waitFor(() => {
            if (scenario === 'logout') expect(doc.documentElement.dataset.view).toBe('login');
            else expect(doc.getElementById('success-room-inline')?.textContent).toBe('000101');
          });
        }
        finishSetup!(
          Response.json({
            roomCode: '000100',
            roomGeneration: 0,
            setupRequired: true,
            activationUrl: 'https://musixquare.com/000100#pro-claim=v1.claim.sig',
            expiresAt: Date.now() + 60_000,
          }),
        );
        finishCopy!();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(navigation).toHaveBeenCalledTimes(scenario === 'current' ? 1 : 0);
        if (scenario === 'current')
          expect(doc.getElementById('toast')?.textContent).toBe('000100을 복사했어요.');
        else expect(doc.getElementById('toast')?.textContent).toBe('');
        expect((doc.getElementById('open-room') as HTMLButtonElement).disabled).toBe(false);
      } finally {
        dom.window.close();
      }
    },
  );

  it.each([
    ['/ko/about?lang=ja', 'ko', 'ltr'],
    ['/ar/about', 'ar', 'rtl'],
    ['/pt-br/about', 'pt-BR', 'ltr'],
    ['/about?lang=ko', 'en', 'ltr'],
  ])(
    'preserves the About document language if its shared helper fails: %s',
    async (path, lang, dir) => {
      const [staticLanguage, bootstrap, translations, markup] = await Promise.all([
        compiledAsset('static-language.js'),
        compiledAsset('landing-bootstrap.js'),
        compiledAsset('landing-i18n.js'),
        readFile(resolve(REPO_ROOT, '.workshop/landing/landing.html'), 'utf8'),
      ]);
      const rendered: Array<{
        language: string;
        direction: string;
        title: string;
        heading: string;
      }> = [];
      for (const helperAvailable of [true, false]) {
        const dom = new JSDOM(markup, {
          runScripts: 'outside-only',
          url: `https://musixquare.com${path}`,
        });
        try {
          dom.window.localStorage.setItem('mxqr-landing-lang', 'fr');
          Object.defineProperty(dom.window.navigator, 'languages', { value: ['de-DE'] });
          // Same authored script order, with only the failed shared script omitted.
          if (helperAvailable) dom.window.eval(staticLanguage.code);
          dom.window.eval(bootstrap.code);
          dom.window.eval(translations.code);
          const doc = dom.window.document;
          rendered.push({
            language: doc.documentElement.lang,
            direction: doc.documentElement.dir,
            title: doc.title,
            heading: doc.querySelector('[data-i18n="hero.h1"]')!.innerHTML,
          });
        } finally {
          dom.window.close();
        }
      }
      expect(rendered[0]).toMatchObject({ language: lang, direction: dir });
      expect(rendered[1]).toEqual(rendered[0]);
    },
  );

  it.each(['constructor', 'constructor-US'])(
    'uses a valid language when the landing helper is unavailable and the query is %s',
    async (input) => {
      const { code } = await compiledAsset('landing-bootstrap.js');
      const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        runScripts: 'outside-only',
        url: `https://musixquare.com/.workshop/landing/landing.html?lang=${input}`,
      });
      try {
        Object.defineProperty(dom.window.navigator, 'languages', { value: ['ko-KR'] });
        dom.window.eval(code);
        expect(dom.window.document.documentElement.lang).toBe('ko');
        expect((dom.window as unknown as { __landingLang: string }).__landingLang).toBe('ko');
      } finally {
        dom.window.close();
      }
    },
  );

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
        direction(code: unknown): 'ltr' | 'rtl';
        setDocumentLang(code: unknown): void;
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
      direction: () => 'ltr',
      setDocumentLang: (code) => {
        landingWindow.document.documentElement.lang = code === 'zh-hant' ? 'zh-Hant' : String(code);
        landingWindow.document.documentElement.dir = 'ltr';
      },
      update: (code) => updates.push(String(code)),
    };
    landingWindow.__landingLang = 'nl';
    landingWindow.document.documentElement.dir = 'rtl';

    try {
      landingWindow.eval(code);
      expect(landingWindow.document.title).toBe('Over MUSIXQUARE');
      expect(landingWindow.document.documentElement.lang).toBe('nl');
      expect(landingWindow.document.documentElement.dir).toBe('ltr');
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
      expect(landingWindow.document.documentElement.dir).toBe('ltr');
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
    expect(landingHtml).toContain(
      '<link rel="stylesheet" href="/designsystem/colors_and_type.css" />',
    );
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
