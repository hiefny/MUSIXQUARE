import { readFileSync } from 'node:fs';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import {
  createViteConfig,
  LEGACY_APP_BROWSER_TARGET,
  prioritizeActiveStylesheetsInHtml,
  transformAppCssForLegacyBrowsers,
} from '../../../vite.config.ts';

describe('legacy smart-TV app compatibility', () => {
  it('builds the app, CSS, and first-paint cleanup for the Chromium 79 floor', () => {
    const config = createViteConfig({});
    expect(LEGACY_APP_BROWSER_TARGET).toBe('chrome79');
    expect(config.build?.target).toBe(LEGACY_APP_BROWSER_TARGET);
    expect(config.build?.cssTarget).toBe(LEGACY_APP_BROWSER_TARGET);
    const cleanupAsset = CLASSIC_RUNTIME_ASSETS.find(
      ({ outputPath }) => outputPath === 'fouc-cleanup.js',
    );
    expect(cleanupAsset && 'target' in cleanupAsset ? cleanupAsset.target : undefined).toBe(
      'es2018',
    );

    const serviceWorkerSource = readFileSync('scripts/service-worker-asset.ts', 'utf8');
    expect(serviceWorkerSource).toContain("target: 'chrome79'");
  });

  it('feeds the complete ordered app cascade through one stylesheet entry', () => {
    expect(readFileSync('css/app.css', 'utf8').match(/@import\s+['"][^'"]+['"]/gu)).toEqual([
      "@import './style.css'",
      "@import './desktop.css'",
      "@import './rtl.css'",
    ]);

    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain('<link rel="stylesheet" href="css/app.css" />');
    expect(html).toContain('<noscript><link rel="stylesheet" href="/noscript.css" /></noscript>');
    expect(html).not.toContain('href="css/style.css"');
    expect(html).not.toContain('href="css/desktop.css"');
    expect(html).not.toContain('href="css/rtl.css"');

    const noScriptCss = readFileSync('public/noscript.css', 'utf8');
    expect(noScriptCss).toContain('opacity: 1 !important');
    expect(noScriptCss).not.toMatch(/:(?:has|is|where)\(/u);
    expect(noScriptCss).not.toMatch(/@layer\b/u);
  });

  it('keeps no-script CSS inert while prioritizing the active app stylesheet', () => {
    const transformed = prioritizeActiveStylesheetsInHtml(`<!doctype html><html><head>
      <script type="module" src="/assets/main.js"></script>
      <noscript><link rel="stylesheet" href="/noscript.css"></noscript>
      <link rel="stylesheet" href="/assets/main.css">
    </head></html>`);
    const dom = new JSDOM(transformed);
    expect(
      [...dom.window.document.querySelectorAll('link[rel="stylesheet"]')]
        .filter((link) => !link.closest('noscript, template'))
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/assets/main.css']);
    expect(transformed).toMatch(
      /<noscript><link rel="stylesheet" href="\/noscript\.css"><\/noscript>/u,
    );
    expect(transformed.indexOf('/assets/main.css')).toBeLessThan(
      transformed.indexOf('type="module"'),
    );
    dom.window.close();
  });

  it('lowers layers while preserving normal and important cascade order', async () => {
    const transformed = await transformAppCssForLegacyBrowsers(`
      @layer base, desktop;
      @layer base {
        #normal { color: red; }
        .important { color: red !important; }
      }
      @layer desktop {
        .normal { color: green; }
        #important { color: green; }
      }
      #normal { color: blue; }
      #important { color: blue !important; }
    `);

    expect(transformed).not.toMatch(/@layer\b/u);
    expect(transformed).not.toMatch(/\brevert-layer\b/u);
    // The first layer's important declaration receives two impossible-ID
    // specificity bumps, preserving the standards-defined reverse layer order.
    expect(transformed).toContain('.important:not(#\\#):not(#\\#)');

    const dom = new JSDOM(
      `<style>${transformed}</style><div id="normal" class="normal"></div><div id="important" class="important"></div>`,
      { pretendToBeVisual: true },
    );
    const normal = dom.window.document.querySelector('#normal');
    const important = dom.window.document.querySelector('#important');
    expect(normal).not.toBeNull();
    expect(important).not.toBeNull();
    expect(dom.window.getComputedStyle(normal!).color).toBe('rgb(0, 0, 255)');
    // jsdom does not include :not() arguments in specificity. The transformed
    // selector above fixes that ordering in real browsers, while this check
    // still exercises normal layered precedence through an actual stylesheet.
    dom.window.close();
  });

  it('fails closed on layer constructs the compatibility transform cannot preserve', async () => {
    await expect(
      transformAppCssForLegacyBrowsers('@layer base { .value { color: revert-layer; } }'),
    ).rejects.toThrow('Legacy CSS transform warning');
    await expect(
      transformAppCssForLegacyBrowsers(
        '@layer base, desktop; @layer desktop { .value { color: red !important; } }',
      ),
    ).rejects.toThrow('desktop layer cannot contain !important');
  });

  it('installs the missing Chromium 79 DOM and listener primitives before app startup', async () => {
    const bootstrapAsset = CLASSIC_RUNTIME_ASSETS.find(
      ({ outputPath }) => outputPath === 'bootstrap.js',
    );
    expect(bootstrapAsset).toBeDefined();
    const { code } = await compileClassicRuntimeAsset(process.cwd(), bootstrapAsset!);
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      pretendToBeVisual: true,
      runScripts: 'outside-only',
      url: 'https://musixquare.test/',
    });
    const { window } = dom;

    delete (window.Element.prototype as Partial<ParentNode>).replaceChildren;
    delete (window.Document.prototype as Partial<ParentNode>).replaceChildren;
    delete (window.DocumentFragment.prototype as Partial<ParentNode>).replaceChildren;
    Object.defineProperty(window.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
    Reflect.deleteProperty(window.AbortSignal.prototype, 'reason');
    Reflect.deleteProperty(window.AbortSignal.prototype, 'throwIfAborted');
    const nativeAbort = window.AbortController.prototype.abort;
    Object.defineProperty(window.AbortController.prototype, 'abort', {
      configurable: true,
      writable: true,
      value: function (this: AbortController) {
        nativeAbort.call(this);
      },
    });

    // Model Chromium 79 accepting the options object while ignoring `signal`.
    const nativeAdd = window.EventTarget.prototype.addEventListener;
    Object.defineProperty(window.EventTarget.prototype, 'addEventListener', {
      configurable: true,
      writable: true,
      value: function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) {
        const legacyOptions =
          options && typeof options === 'object'
            ? { capture: options.capture, once: options.once, passive: options.passive }
            : options;
        nativeAdd.call(this, type, listener, legacyOptions);
      },
    });

    window.eval(code);

    const parent = window.document.createElement('div');
    parent.append('old');
    const child = window.document.createElement('span');
    child.textContent = 'new';
    parent.replaceChildren('prefix-', child);
    expect(parent.textContent).toBe('prefix-new');
    expect(window.crypto.randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    const target = new window.EventTarget();
    const controller = new window.AbortController();
    let calls = 0;
    target.addEventListener(
      'legacy-signal',
      () => {
        calls += 1;
      },
      { signal: controller.signal },
    );
    controller.abort();
    target.dispatchEvent(new window.Event('legacy-signal'));
    expect(calls).toBe(0);

    const reasonController = new window.AbortController();
    const reason = new Error('semantic-route-change');
    reasonController.abort(reason);
    expect(reasonController.signal.reason).toBe(reason);
    expect(() => reasonController.signal.throwIfAborted()).toThrow(reason);
    dom.window.close();
  });
});
