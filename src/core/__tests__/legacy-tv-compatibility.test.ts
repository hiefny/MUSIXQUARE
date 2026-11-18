import { readFileSync } from 'node:fs';

import { JSDOM } from 'jsdom';
import { parse as parseCss, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import {
  assertLegacyCss,
  assertTouchSelectionCss,
  findUnpolyfilledRuntimeCall,
} from '../../../scripts/check-legacy-tv-build.mts';
import { APP_CSS_BROWSER_TARGETS } from '../../../scripts/browser-target.ts';
import {
  createViteConfig,
  LEGACY_APP_BROWSER_TARGET,
  prioritizeActiveStylesheetsInHtml,
  transformAppCssForLegacyBrowsers,
} from '../../../vite.config.ts';

/**
 * The ids a selector puts into its specificity, counted the way the layer
 * lowering counts them: a functional pseudo-class adds the ids of its argument
 * with the most. Ids inside :where() count too, so the count never comes out
 * below the build's.
 */
function idCount(selector: string): number {
  // Comments, escaped characters, strings and attribute selectors hold no id.
  let rest = selector
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\\[\s\S]/gu, '_')
    .replace(/(['"])(?:(?!\1)[\s\S])*\1/gu, "''")
    .replace(/\[[^\]]*\]/gu, '[]');
  const innermostArguments = /\(([^()]*)\)/u;
  while (innermostArguments.test(rest)) {
    rest = rest.replace(innermostArguments, (_match: string, list: string) =>
      '#'.repeat(Math.max(...list.split(',').map((argument) => argument.split('#').length - 1))),
    );
  }
  return rest.split('#').length - 1;
}

/**
 * The rings an engine that knows :focus-visible but not :where() reads
 * (Chromium 86 and 87): every built stylesheet keeps them.
 */
const NO_WHERE_RINGS =
  '@supports not selector(:where(*)){:focus-visible{outline:2px solid blue}' +
  '.dialog-choice-radio:focus-visible+.dialog-choice-surface{outline:2px solid blue}}';

describe('legacy smart-TV app compatibility', () => {
  it('checks fullscreen physical edges independently of minifier declaration order', () => {
    const css = `
      :root{--bg:#fff}
      .onboarding-overlay{position:fixed}
      body.fouc-loaded{opacity:1}
      body.overlay-open .bottom-nav{display:none}
      html.setup-boot-block body{animation:boot 1s}
      body > .bootstrap-failure{display:block}
      .file-drop-feedback{top:0;bottom:0;left:0;right:0}
      ${NO_WHERE_RINGS}
    `;
    expect(() => assertLegacyCss(css)).not.toThrow();
    expect(() => assertLegacyCss(css.replace('right:0', 'right:1px'))).toThrow(
      'physical fullscreen overlay edges',
    );
    expect(() => assertLegacyCss(css.replace('top:0;bottom:0;left:0;right:0', 'inset:0'))).toThrow(
      'physical fullscreen overlay edges',
    );
  });

  it('keeps hover-gated selectors out of rules the TV engines must keep', () => {
    // Chromium 79 predates :where(), so it drops a whole rule whose selector
    // list contains one. A gated hover sharing a rule with a focus or press
    // selector would take that state style down with it on the TV floor.
    const css = `
      :root{--bg:#fff}
      .onboarding-overlay{position:fixed}
      body.fouc-loaded{opacity:1}
      body.overlay-open .bottom-nav{display:none}
      html.setup-boot-block body{animation:boot 1s}
      body > .bootstrap-failure{display:block}
      .file-drop-feedback{top:0;bottom:0;left:0;right:0}
      ${NO_WHERE_RINGS}
      :where(html[data-hover-pointer]) .row:hover{color:blue}
      .row:focus-visible{color:blue}
    `;
    expect(() => assertLegacyCss(css)).not.toThrow();
    expect(() =>
      assertLegacyCss(
        css.replace(
          ':where(html[data-hover-pointer]) .row:hover{color:blue}\n      .row:focus-visible{color:blue}',
          ':where(html[data-hover-pointer]) .row:hover,.row:focus-visible{color:blue}',
        ),
      ),
    ).toThrow('mixes :where()');
  });

  it('fails a build that loses the rings an engine without :where() reads', async () => {
    // Chromium 86 and 87 (for example 2022 LG webOS TVs, docs/known-accepted.md
    // #20) know :focus-visible but not :where(), so they drop every keyboard
    // gated focus rule. css/style.css keeps the app's global ring and the PIN
    // choice row's ring for them, ungated, under this @supports test; without
    // them several controls there show no focus at all.
    const sentinels = `
      :root{--bg:#fff}
      .onboarding-overlay{position:fixed}
      body.fouc-loaded{opacity:1}
      body.overlay-open .bottom-nav{display:none}
      html.setup-boot-block body{animation:boot 1s}
      body > .bootstrap-failure{display:block}
      .file-drop-feedback{top:0;bottom:0;left:0;right:0}
    `;
    const ring = ':focus-visible:not(#\\#){outline:2px solid blue}';
    const choice =
      '.dialog-choice-radio:focus-visible:not(#\\#)+.dialog-choice-surface{outline:2px solid blue}';
    const withoutWhere = (rules: string) => `@supports not selector(:where(*)){${rules}}`;
    expect(() => assertLegacyCss(sentinels + withoutWhere(ring + choice))).not.toThrow();
    expect(() => assertLegacyCss(sentinels)).toThrow('engines without :where()');
    expect(() => assertLegacyCss(sentinels + withoutWhere(ring))).toThrow('.dialog-choice-surface');
    expect(() => assertLegacyCss(sentinels + withoutWhere(choice))).toThrow(': :focus-visible');
    // Those engines drop a copy that names :where() itself, read no other
    // test as theirs, and a copy that only hides draws no ring.
    expect(() =>
      assertLegacyCss(sentinels + withoutWhere(`:where(html) ${ring}${choice}`)),
    ).toThrow('engines without :where()');
    expect(() =>
      assertLegacyCss(sentinels + `@supports selector(:focus-visible){${ring}${choice}}`),
    ).toThrow('engines without :where()');
    expect(() =>
      assertLegacyCss(sentinels + withoutWhere(`:focus-visible{outline:none}${choice}`)),
    ).toThrow('engines without :where()');

    // The layer lowering keeps the test and pads each copy as it pads the
    // reset before it, so the copy still follows the reset at equal weight.
    // As in css/style.css, base comes after safety, so it has padding.
    const lowered = await transformAppCssForLegacyBrowsers(`
      @layer safety, base, desktop;
      @layer base {
        .ob-nav-arrow{outline:none}
        :where(html:not([data-keyboard-navigation='off'])) :focus-visible{outline:2px solid blue}
        @supports not selector(:where(*)) { :focus-visible{outline:2px solid blue} }
      }
      @layer desktop { .row{color:blue} }
    `);
    const tails = new Map<string, number>();
    parseCss(lowered).walkRules((rule) => {
      const selector = rule.selector.replaceAll(':not(#\\#)', '');
      tails.set(selector, rule.selector.split(':not(#\\#)').length - 1);
    });
    expect(lowered).toContain('@supports not selector(:where(*))');
    expect(tails.get(':focus-visible')).toBeGreaterThan(0);
    expect(tails.get(':focus-visible')).toBe(tails.get('.ob-nav-arrow'));
  });

  it('requires the prefixed selection block that iOS Safari reads', () => {
    expect(() =>
      assertTouchSelectionCss('*{-webkit-user-select:none;user-select:none}'),
    ).not.toThrow();
    expect(() => assertTouchSelectionCss('*{user-select:none}')).toThrow('-webkit-user-select');
  });

  it('flags runtime calls the TV engines lack, not a spread of a minifier-named function', () => {
    expect(findUnpolyfilledRuntimeCall('const last = items.at(-1);')).toBe('.at(');
    expect(findUnpolyfilledRuntimeCall('value?.at(0)')).toBe('.at(');
    expect(findUnpolyfilledRuntimeCall('const copy = [...items.at(0)];')).toBe('.at(');
    // `at` is a minified function name here; its result is spread.
    expect(findUnpolyfilledRuntimeCall('return {...at(r), queueItemId: e};')).toBeNull();
    expect(findUnpolyfilledRuntimeCall('f(...at(r)); s.replaceAll("a", "b");')).toBe(
      '.replaceAll(',
    );
    expect(findUnpolyfilledRuntimeCall('Object.hasOwn(a, b)')).toBe('Object.hasOwn(');
    expect(findUnpolyfilledRuntimeCall('const x = list.slice(-1)[0];')).toBeNull();
  });

  it('finds legacy boot and overlay guards after layer-specificity lowering', async () => {
    const transformed = await transformAppCssForLegacyBrowsers(`
      @layer safety, base, components, states;
      @layer base {
        :root{--bg:#fff}
        .onboarding-overlay{position:fixed}
        body.fouc-loaded{opacity:1}
        .file-drop-feedback{top:0;bottom:0;left:0;right:0}
        ${NO_WHERE_RINGS}
      }
      @layer components { body > .bootstrap-failure{display:block} }
      @layer states { body.overlay-open .bottom-nav{display:none} }
      @layer safety { html.setup-boot-block body{animation:boot 1s !important} }
    `);
    expect(transformed).toContain(':not(#\\#)');
    expect(() => assertLegacyCss(transformed)).not.toThrow();
    expect(() => assertLegacyCss(transformed.replace('animation:', 'color:'))).toThrow(
      'selector-safe delayed boot failure',
    );
    expect(() =>
      assertLegacyCss(
        transformed.replaceAll('html.setup-boot-block', 'html:has(.setup-boot-block)'),
      ),
    ).toThrow('selector-safe delayed boot failure');
    expect(() => assertLegacyCss(transformed.replace('right:0', 'right:1px'))).toThrow(
      'physical fullscreen overlay edges',
    );
  });

  it('builds the app, CSS, and first-paint cleanup for the Chromium 79 floor', () => {
    const config = createViteConfig({});
    expect(LEGACY_APP_BROWSER_TARGET).toBe('chrome79');
    expect(config.build?.target).toBe(LEGACY_APP_BROWSER_TARGET);
    expect(config.build?.cssTarget).toEqual(APP_CSS_BROWSER_TARGETS);
    expect(APP_CSS_BROWSER_TARGETS).toContain(LEGACY_APP_BROWSER_TARGET);
    expect(APP_CSS_BROWSER_TARGETS).toEqual(expect.arrayContaining(['safari15', 'ios15']));
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
      "@import './playback-actions.css'",
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

  it("leaves a public page's /web-fonts/rest.css after its last body script", () => {
    // rest.css sits at the end of the body on purpose so it never blocks the
    // first paint (src/i18n/public-font-contract.ts); the page's own head
    // stylesheets still move before the module script.
    const transformed = prioritizeActiveStylesheetsInHtml(`<!doctype html><html><head>
      <script type="module" src="/assets/about.js"></script>
      <link rel="stylesheet" href="/web-fonts/first.css">
      <link rel="stylesheet" href="/assets/about.css">
    </head><body>
      <main>About</main>
      <script src="/landing-i18n.js"></script>
      <link rel="stylesheet" href="/web-fonts/rest.css">
    </body></html>`);
    const dom = new JSDOM(transformed);
    const { document } = dom.window;
    expect(
      [...document.head.querySelectorAll('link[rel="stylesheet"]')].map((link) =>
        link.getAttribute('href'),
      ),
    ).toEqual(['/web-fonts/first.css', '/assets/about.css']);
    expect(
      [...document.body.querySelectorAll('link[rel="stylesheet"]')].map((link) =>
        link.getAttribute('href'),
      ),
    ).toEqual(['/web-fonts/rest.css']);
    const moduleScript = transformed.indexOf('type="module"');
    expect(transformed.indexOf('/web-fonts/first.css')).toBeLessThan(moduleScript);
    expect(transformed.indexOf('/assets/about.css')).toBeLessThan(moduleScript);
    expect(transformed.indexOf('/web-fonts/rest.css')).toBeGreaterThan(
      transformed.indexOf('/landing-i18n.js'),
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

  it('names at most one id in any app selector, so each layer adds two tails', () => {
    // The layer lowering pads each layered selector with :not(#\#) tails, and
    // each layer up adds one tail more than the most ids any one selector in
    // the stylesheet names. A single selector with two ids would lengthen
    // every lowered selector by a tail per layer, about 30 KB of raw CSS.
    expect(idCount('#a :is(.b, #c) :not(#d, .e)')).toBe(3);
    expect(idCount(":where(#a) [href='#b'] .c\\#d")).toBe(1);

    const sheets = [
      ...readFileSync('css/app.css', 'utf8').matchAll(/@import\s+['"]\.\/([^'"]+)['"]/gu),
    ].map(([, file]) => `css/${file}`);
    const crowded: string[] = [];
    for (const sheet of sheets) {
      parseCss(readFileSync(sheet, 'utf8')).walkRules((rule) => {
        for (const selector of rule.selectors) {
          if (idCount(selector) > 1) crowded.push(`${sheet}: ${selector}`);
        }
      });
    }

    expect(sheets).toHaveLength(4);
    expect(crowded).toEqual([]);
  });

  // Owner report 2026-11-17: in the installed iOS app the strip under a short
  // first screen shows the page's background, body's over html's (inferred).
  // The boot splash sheet (index.html) holds the root's background on the
  // strip's colour with an animation, which outranks every normal declaration
  // however the build lowers it, and body takes the root's from @layer states.
  it("lets the installed app's body take the root's background over every body background the build lowers, and leaves the root's animation to the splash sheet", async () => {
    const sheets = [
      ...readFileSync('css/app.css', 'utf8').matchAll(/@import\s+['"]\.\/([^'"]+)['"]/gu),
    ].map(([, file]) => readFileSync(`css/${file}`, 'utf8'));
    expect(sheets).toHaveLength(4);
    const lowered = parseCss(await transformAppCssForLegacyBrowsers(sheets.join('\n')));

    const TAIL = ':not(#\\#)';
    const tails = (selector: string) => selector.split(TAIL).length - 1;
    const compounds = (selector: string) =>
      selector
        .replaceAll(TAIL, '')
        .trim()
        .split(/\s*[\s>+~]\s*/u);
    const sets = (rule: Rule, property: RegExp, important = false) =>
      rule.nodes.some(
        (node) =>
          node.type === 'decl' && property.test(node.prop) && (!important || node.important),
      );
    const installed: { tails: number; value: string }[] = [];
    const bodyBackgrounds: { tails: number; selector: string }[] = [];
    const rootOverrides: string[] = [];
    lowered.walkRules((rule) => {
      for (const selector of rule.selectors) {
        const parts = compounds(selector);
        const subject = parts[parts.length - 1] ?? '';
        if (selector.replaceAll(TAIL, '') === 'html[data-boot-installed] body') {
          rule.walkDecls('background-color', (declaration) => {
            installed.push({ tails: tails(selector), value: declaration.value });
          });
        } else if (/^body(?![\w-])/u.test(subject) && sets(rule, /^background(?:-color)?$/u)) {
          bodyBackgrounds.push({ tails: tails(selector), selector: selector.replaceAll(TAIL, '') });
        }
        // Only a lone compound can match the root, which has no ancestor. An
        // app animation there would replace the splash sheet's hold and rise,
        // and an important background would outrank them.
        if (parts.length === 1 && /^(?:html(?![\w-])|:root|\*)/u.test(subject)) {
          if (sets(rule, /^animation(?:-name)?$/u)) rootOverrides.push(`${selector} animation`);
          if (sets(rule, /^background(?:-color)?$/u, true)) {
            rootOverrides.push(`${selector} important background`);
          }
        }
      }
    });

    expect(installed.map(({ value }) => value)).toEqual(['inherit']);
    // Today base (2) and desktop (4).
    expect(bodyBackgrounds.length).toBeGreaterThanOrEqual(2);
    for (const { tails: count, selector } of bodyBackgrounds) {
      expect(installed[0]?.tails ?? 0, selector).toBeGreaterThan(count);
    }
    expect(rootOverrides).toEqual([]);
  });

  it('fails closed on layer constructs the compatibility transform cannot preserve', async () => {
    await expect(
      transformAppCssForLegacyBrowsers('@layer base { .value { color: revert-layer; } }'),
    ).rejects.toThrow('Legacy CSS transform warning');
    for (const layer of ['desktop', 'components', 'responsive', 'states']) {
      await expect(
        transformAppCssForLegacyBrowsers(
          `@layer base, ${layer}; @layer ${layer} { .value { color: red !important; } }`,
        ),
      ).rejects.toThrow(`${layer} layer cannot contain !important`);
    }
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
