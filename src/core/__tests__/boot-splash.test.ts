import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JSDOM } from 'jsdom';
import { transformWithEsbuild } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

import { APP_RENDER_ASSETS_SLOT, prioritizeActiveStylesheetsInHtml } from '../../../vite.config.ts';
import {
  BOOT_SPLASH_CONTINUITY_BOX_KEY,
  BOOT_SPLASH_CONTINUITY_KEY,
} from '../navigation-contract.ts';

// The boot splash (index.html) is the only thing a slow first visit can paint
// before the start-up scripts, the app stylesheet and the module graph arrive.
const INDEX = readFileSync('index.html', 'utf8');
const STYLE = readFileSync('css/style.css', 'utf8');
const SPLASH_CSS = INDEX.match(/<style data-boot-splash>([\s\S]*?)<\/style>/u)?.[1] ?? '';

function block(css: string, opener: string): string {
  const start = css.indexOf(opener);
  expect(start, opener).toBeGreaterThan(-1);
  const end = css.indexOf('}', start);
  expect(end, opener).toBeGreaterThan(start);
  return css.slice(start + opener.length, end);
}

function declaration(css: string, opener: string, property: string): string {
  const match = block(css, opener).match(new RegExp(`(?:^|[\\s;])${property}:\\s*([^;]+);`, 'u'));
  expect(match, `${opener} ${property}`).not.toBeNull();
  return match?.[1]?.trim() ?? '';
}

/** A declaration of the rule whose whole selector is the opener's (not a list's last line). */
function ownDeclaration(css: string, opener: string, property: string): string {
  let start = css.indexOf(opener);
  while (start > -1 && /,\s*$/u.test(css.slice(0, start))) start = css.indexOf(opener, start + 1);
  expect(start, opener).toBeGreaterThan(-1);
  return declaration(css.slice(start), opener, property);
}

function keyframes(css: string, name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  expect(start, name).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) {
      return css
        .slice(css.indexOf('{', start) + 1, index)
        .replace(/\s+/gu, ' ')
        .trim();
    }
  }
  throw new Error(`Unclosed @keyframes ${name}`);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts') && !path.split(/[\\/]/u).includes('__tests__'))
    .map((path) => join(directory, path));
}

describe('boot splash', () => {
  it('paints from the document alone: nothing ahead of it blocks rendering or parsing', () => {
    expect(SPLASH_CSS).not.toBe('');
    const head = INDEX.slice(INDEX.indexOf('<head>'), INDEX.indexOf('</head>')).replace(
      /<noscript>[\s\S]*?<\/noscript>/gu,
      '',
    );
    expect(head.indexOf('<style data-boot-splash>')).toBeGreaterThan(-1);
    expect(head).not.toMatch(/<link\b[^>]*\brel=["']stylesheet["']/u);
    for (const [, attributes] of head.matchAll(/<script\b([^>]*)>/gu)) {
      expect(
        // The boot preflight runs inline: it waits for nothing (below).
        /\btype=["']application\/ld\+json["']|\bdefer\b|\btype=["']module["']|^ data-boot-preflight$/u.test(
          attributes ?? '',
        ),
        `blocking head script: ${attributes}`,
      ).toBe(true);
    }

    const dom = new JSDOM(INDEX);
    const splash = dom.window.document.body.firstElementChild;
    expect(splash?.className).toBe('boot-splash');
    expect(splash?.getAttribute('aria-hidden')).toBe('true');
    expect(splash?.querySelector('script, link, img, [tabindex]')).toBeNull();
    // The refresh screen copies the wordmark and the loader into a live
    // status region, so each carries its own aria-hidden.
    for (const selector of ['svg.boot-splash-logo', '.boot-splash-spinner']) {
      expect(splash?.querySelector(selector)?.getAttribute('aria-hidden'), selector).toBe('true');
    }
    for (const svg of splash?.querySelectorAll('svg') ?? []) {
      expect(svg.getAttribute('focusable')).toBe('false');
    }
    // The start-up scripts come right after the splash, then the drawing
    // runtime, which never blocks the parser: the parser reaches it only once
    // bootstrap.js has settled the splash after an app reset.
    const startUp = [...dom.window.document.querySelectorAll('body > script')]
      .slice(0, 3)
      .map((script) => [script.getAttribute('src'), script.hasAttribute('async')]);
    expect(splash?.nextElementSibling?.getAttribute('src')).toMatch(
      /^\/bootstrap\.js\?cache=v\d+$/u,
    );
    expect(startUp.slice(1)).toEqual([
      ['/fouc-cleanup.js', false],
      ['/wordmark-anim.js', true],
    ]);
    expect(dom.window.document.querySelectorAll('script[src="/wordmark-anim.js"]')).toHaveLength(1);
    dom.window.close();
  });

  it('starts the scripts, then the app stylesheet slot, right after the splash', () => {
    const order = [
      INDEX.indexOf('<body>'),
      INDEX.indexOf('<div class="boot-splash"'),
      INDEX.indexOf('<script src="/bootstrap.js?cache='),
      INDEX.indexOf('<script src="/fouc-cleanup.js"></script>'),
      INDEX.indexOf('<script src="/wordmark-anim.js" async></script>'),
      INDEX.indexOf('<link rel="stylesheet" href="css/app.css" />'),
      INDEX.indexOf(APP_RENDER_ASSETS_SLOT),
      INDEX.indexOf('class="skip-link"'),
    ];
    expect(order.every((position) => position > -1)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(INDEX.split(APP_RENDER_ASSETS_SLOT)).toHaveLength(2);
  });

  it('moves the built stylesheets, entry module and preloads into the slot, in that order', () => {
    const transformed = prioritizeActiveStylesheetsInHtml(`<!doctype html><html><head>
      <style data-boot-splash>.boot-splash{display:flex}</style>
      <noscript><link rel="stylesheet" href="/noscript.css"></noscript>
      <script type="module" crossorigin src="/assets/main-a.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/log-b.js">
      <link rel="modulepreload" crossorigin href="/assets/peer-c.js">
      <link rel="stylesheet" crossorigin href="/assets/main-d.css">
    </head><body>
      <div class="boot-splash"></div>
      <script src="/bootstrap.js?cache=v1"></script>
      <script src="/fouc-cleanup.js"></script>
      <script src="/wordmark-anim.js" async></script>
      ${APP_RENDER_ASSETS_SLOT}
      <a class="skip-link" href="#tab-play">Skip</a>
    </body></html>`);
    expect(transformed).not.toContain(APP_RENDER_ASSETS_SLOT);
    const dom = new JSDOM(transformed);
    const { document } = dom.window;
    expect(
      document.head.querySelector('script[type="module"], link[rel="modulepreload"]'),
    ).toBeNull();
    expect(
      [...document.head.querySelectorAll('link[rel="stylesheet"]')].filter(
        (link) => !link.closest('noscript'),
      ),
    ).toEqual([]);
    expect(
      [...document.body.children].map((element) =>
        [
          element.tagName.toLowerCase(),
          element.getAttribute('class') ??
            element.getAttribute('src') ??
            `${element.getAttribute('rel')} ${element.getAttribute('href')}`,
        ].join(' '),
      ),
    ).toEqual([
      'div boot-splash',
      'script /bootstrap.js?cache=v1',
      'script /fouc-cleanup.js',
      'script /wordmark-anim.js',
      'link stylesheet /assets/main-d.css',
      'script /assets/main-a.js',
      'link modulepreload /assets/log-b.js',
      'link modulepreload /assets/peer-c.js',
      'a skip-link',
    ]);
    expect(document.querySelector('noscript')?.innerHTML).toContain('/noscript.css');
    dom.window.close();
  });

  it('refuses a document with more than one slot', () => {
    expect(() =>
      prioritizeActiveStylesheetsInHtml(`<html><head>
        <script type="module" src="/assets/main.js"></script>
        <link rel="stylesheet" href="/assets/main.css">
      </head><body>${APP_RENDER_ASSETS_SLOT}${APP_RENDER_ASSETS_SLOT}</body></html>`),
    ).toThrow(/exactly one render-assets slot/u);
  });

  it('falls back to the colours the app opens on', () => {
    const dark = {
      bg: declaration(STYLE, '  :root {', '--bg'),
      fg: declaration(STYLE, '  :root {', '--text-main'),
    };
    const light = {
      bg: declaration(STYLE, "  html[data-theme='light'] {", '--bg'),
      fg: declaration(STYLE, "  html[data-theme='light'] {", '--text-main'),
    };
    expect(dark).toEqual({ bg: '#121212', fg: '#eeeeee' });
    expect(light).toEqual({ bg: '#f8f9fa', fg: '#303540' });

    for (const [opener, palette] of [
      ['      .boot-splash {', dark],
      ["      html[data-theme='dark'] .boot-splash {", dark],
      ["      html[data-theme='light'] .boot-splash {", light],
    ] as const) {
      expect(declaration(SPLASH_CSS, opener, '--boot-splash-bg'), opener).toBe(palette.bg);
      expect(declaration(SPLASH_CSS, opener, '--boot-splash-fg'), opener).toBe(palette.fg);
    }
    const systemLight = SPLASH_CSS.slice(
      SPLASH_CSS.indexOf('@media (prefers-color-scheme: light) {'),
    );
    expect(declaration(systemLight, '.boot-splash {', '--boot-splash-bg')).toBe(light.bg);
    expect(declaration(systemLight, '.boot-splash {', '--boot-splash-fg')).toBe(light.fg);
    // Once style.css has loaded, the app's own tokens (contrast palettes
    // included) take over from the fallbacks.
    expect(declaration(SPLASH_CSS, '      .boot-splash {', 'background')).toBe(
      'var(--bg, var(--boot-splash-bg))',
    );
    expect(declaration(SPLASH_CSS, '      .boot-splash {', 'color')).toBe(
      'var(--text-main, var(--boot-splash-fg))',
    );
  });

  it('keeps the app wordmark shapes in the loading screen logo, glyph for glyph', () => {
    const dom = new JSDOM(INDEX);
    const splashLogo = dom.window.document.querySelector('.boot-splash-logo');
    const shapes = [...(splashLogo?.querySelectorAll('polygon, path, rect') ?? [])]
      .filter((shape) => !shape.closest('defs'))
      .map((shape) =>
        ['points', 'd', 'x', 'y', 'width', 'height']
          .map((name) => shape.getAttribute(name))
          .filter((value) => value !== null)
          .join(' '),
      );
    expect(splashLogo?.getAttribute('viewBox')).toBe('43 12 214 24');
    // M U S I X Q U A R and the three bars of E. The header wordmark draws the
    // same shapes from unrounded coordinates, so these are pinned as text.
    expect(shapes).toEqual([
      '45.5 17.3 45.5 35.3 50 35.3 50 17.3 54.5 17.3 54.5 35.3 59 35.3 59 17.3 63.5 17.3 63.5 35.3 68 35.3 68 17.3 68 12.8 45.5 12.8 45.5 17.3',
      '86 30.8 77 30.8 77 12.8 72.5 12.8 72.5 30.8 72.5 35.3 90.5 35.3 90.5 30.8 90.5 12.8 86 12.8 86 30.8',
      '95 17.3 95 21.8 95 26.3 108.5 26.3 108.5 30.8 95 30.8 95 35.3 113 35.3 113 30.8 113 26.3 113 21.8 99.5 21.8 99.5 17.3 113 17.3 113 12.8 95 12.8 95 17.3',
      '117.5 12.8 4.5 22.5',
      '139.3 12.8 134.6 20.0 129.9 12.8 124.5 12.8 131.9 24.0 124.5 35.3 129.9 35.3 134.6 28.1 139.3 35.3 144.7 35.3 137.3 24.0 144.7 12.8 139.3 12.8',
      'M147.2,17.3l0,13.5 0,4.5 6.75,0 0,2.7 4.5,0 0-2.7 6.75,0 0-4.5 0-13.5 0-4.5-18,0 0,4.5ZM160.7,17.3l0,13.5-2.25,0 0-2.25-4.5,0 0,2.25-2.25,0 0-13.5 9,0Z',
      '183.2 30.8 174.2 30.8 174.2 12.8 169.7 12.8 169.7 30.8 169.7 35.3 187.7 35.3 187.7 30.8 187.7 12.8 183.2 12.8 183.2 30.8',
      'M192.2,17.3l0,18 4.5,0 0-9 9,0 0,9 4.5,0 0-18 0-4.5-18,0 0,4.5ZM205.7,17.3l0,4.5-9,0 0-4.5 9,0Z',
      'M232.7,26.3l0-13.5-18,0 0,13.5 0,9 4.5,0 0-9 4.6,0 5.8,10.1 3.9-2.3-4.5-7.8 3.7,0ZM219.2,17.3l9,0 0,4.5-9,0 0-4.5Z',
      '237.2 12.8 18 4.5',
      '237.2 21.8 13.5 4.5',
      '237.2 30.8 18 4.5',
    ]);
    expect(shapes).toHaveLength(12);
    dom.window.close();
    // The Q's tail (to y 38) and the R's leg (to y 36.4) reach below the
    // viewBox (y 12 to 36); every app wordmark draws them (.logo-svg).
    expect(declaration(STYLE, '  .logo-svg {', 'overflow')).toBe('visible');
    expect(declaration(SPLASH_CSS, '      .boot-splash-logo {', 'overflow')).toBe('visible');
  });

  it('puts the wordmark, the gap and the loader on one 24px unit on every screen', () => {
    // The wordmark is drawn 24 units tall (viewBox 43 12 214 24): at 24px one
    // unit is one pixel (owner decision 2026-11-15).
    const dom = new JSDOM(INDEX);
    expect(dom.window.document.querySelector('.boot-splash-logo')?.getAttribute('viewBox')).toBe(
      '43 12 214 24',
    );
    dom.window.close();
    expect(declaration(SPLASH_CSS, '      .boot-splash-logo {', 'height')).toBe('24px');
    expect(SPLASH_CSS).not.toMatch(/@media \((?:min|max)-width/u);
    // WebKit paints nothing until the page holds over 32x32 px of fixed-size
    // SVG (or 200 text characters). The splash has no text, so its two SVGs
    // carry fixed sizes whose area passes that; with an auto width the logo
    // did not count and a slow first visit stayed blank in WebKit (WebKit
    // bugs 208482 and 208663).
    const fixedSize = (opener: string) =>
      ['width', 'height'].map((property) => {
        const value = declaration(SPLASH_CSS, opener, property);
        expect(value, `${opener} ${property}`).toMatch(/^\d+px$/u);
        return Number.parseFloat(value);
      });
    const [logoWidth = 0, logoHeight = 0] = fixedSize('      .boot-splash-logo {');
    // The loader's three SVGs: the seam patch and the two half rings.
    const [seamWidth = 0, seamHeight = 0] = fixedSize(
      '      .boot-splash-spinner .material-elastic-arc,\n      .boot-splash-spinner .material-elastic-seam {',
    );
    const [ringWidth = 0, ringHeight = 0] = fixedSize(
      '      .boot-splash-spinner .material-elastic-tail > svg,\n      .boot-splash-spinner .material-elastic-head > svg {',
    );
    expect(
      logoWidth * logoHeight + seamWidth * seamHeight + 2 * ringWidth * ringHeight,
    ).toBeGreaterThan(32 * 32);
    // Exactly what the viewBox gives at that height, as auto would.
    const [, , boxWidth = 0, boxHeight = 0] = (
      new JSDOM(INDEX).window.document
        .querySelector('.boot-splash-logo')
        ?.getAttribute('viewBox') ?? ''
    )
      .split(/\s+/u)
      .map(Number);
    expect(logoWidth).toBe((boxWidth * logoHeight) / boxHeight);
    // The mark stands half the loader's 48px box lower until it rises.
    expect(declaration(SPLASH_CSS, '      .boot-splash-mark {', 'transform')).toBe(
      'translateY(24px)',
    );
    expect(keyframes(SPLASH_CSS, 'boot-splash-mark-rise')).toBe('to { transform: translateY(0); }');
    // The refresh screen draws the same wordmark at the same size.
    expect(declaration(STYLE, '  .session-reset-wordmark {', 'height')).toBe('24px');
  });

  it('draws the shared loader exactly as the app does, at its default 24px', () => {
    expect(declaration(STYLE, '  .material-elastic-spinner {', '--material-elastic-size')).toBe(
      '24px',
    );
    const turn = '      .boot-splash-spinner .material-elastic-turn {';
    expect(declaration(SPLASH_CSS, turn, 'width')).toBe('24px');
    expect(declaration(SPLASH_CSS, turn, 'height')).toBe('24px');
    // The 24px gap above the loader is part of its box (48 = 24 + 24), never a
    // margin or padding: style.css zeroes both on every element.
    expect(declaration(SPLASH_CSS, '      .boot-splash-spinner {', 'height')).toBe('48px');
    expect(declaration(SPLASH_CSS, '      .boot-splash-spinner {', 'align-items')).toBe('flex-end');
    expect(declaration(STYLE, '  * {', 'margin')).toBe('0');
    expect(declaration(STYLE, '  * {', 'padding')).toBe('0');
    expect(SPLASH_CSS).not.toMatch(/(?:^|[\s;{])(?:margin|padding)(?:-[a-z]+)?\s*:/u);
    expect(declaration(STYLE, '  .material-elastic-spinner {', '--material-elastic-stroke')).toBe(
      declaration(SPLASH_CSS, '      .boot-splash-spinner path {', 'stroke-width'),
    );

    // Each moving part runs on the app's clock, under the splash's own name
    // (the app sheet may load beside it); material-elastic-spinner.test.ts
    // pins the arc itself to the dash it replaces.
    const parts = [
      ['.material-elastic-turn {', 'spin', '1.85s linear infinite'],
      ['.material-elastic-arc {', 'arc', '1.45s ease-in-out infinite'],
      ['.material-elastic-tail > svg {', 'tail', '1.45s ease-in-out infinite'],
      ['.material-elastic-head > svg {', 'head', '1.45s ease-in-out infinite'],
    ] as const;
    for (const [part, name, clock] of parts) {
      expect(ownDeclaration(STYLE, `  .material-elastic-spinner ${part}`, 'animation')).toBe(
        `material-elastic-${name} ${clock}`,
      );
      expect(ownDeclaration(SPLASH_CSS, `      .boot-splash-spinner ${part}`, 'animation')).toBe(
        `boot-splash-${name} ${clock}`,
      );
      expect(keyframes(SPLASH_CSS, `boot-splash-${name}`)).toBe(
        keyframes(STYLE, `material-elastic-${name}`),
      );
    }
    for (const property of ['fill', 'stroke', 'stroke-linecap', 'shape-rendering']) {
      expect(declaration(SPLASH_CSS, '      .boot-splash-spinner path {', property)).toBe(
        declaration(STYLE, '  .material-elastic-spinner path {', property),
      );
    }
    for (const side of ['tail', 'head']) {
      expect(
        ownDeclaration(
          SPLASH_CSS,
          `      .boot-splash-spinner .material-elastic-${side} {`,
          'left',
        ),
      ).toBe(side === 'tail' ? '0' : '12px');
      expect(
        ownDeclaration(STYLE, `  .material-elastic-spinner .material-elastic-${side} {`, 'left'),
      ).toBe(side === 'tail' ? '0' : '50%');
    }

    // Reduced motion holds both on the same static arc: a rule of its own per
    // part, after the one that stops their animations.
    const staticArc = (css: string, root: string) =>
      ['.material-elastic-arc', '.material-elastic-tail > svg', '.material-elastic-head > svg'].map(
        (part) => {
          const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce) {'));
          const selector = `${root} ${part}`.replace(/\./gu, '\\.');
          return reduced.match(
            new RegExp(`\\n\\s*${selector} \\{\\s*transform: ([^;]+);`, 'u'),
          )?.[1];
        },
      );
    const staticSplash = staticArc(SPLASH_CSS, '.boot-splash-spinner');
    expect(staticSplash).toEqual(['rotate(259.2deg)', 'rotate(-194.4deg)', 'rotate(194.4deg)']);
    const appSheet = STYLE.slice(0, STYLE.indexOf('.header-safe-content {'));
    expect(staticArc(appSheet, '.material-elastic-spinner')).toEqual(staticSplash);
  });

  it('steps aside once the app takes the screen or boot fails, and never comes back', () => {
    expect(INDEX).toMatch(/<html lang="en" class="setup-boot-block">/u);
    expect(SPLASH_CSS).toMatch(
      /html:not\(\.setup-boot-block\) \.boot-splash,\s*html\.boot-splash-released \.boot-splash,\s*html\.setup-boot-failed \.boot-splash \{\s*pointer-events: none;\s*animation: boot-splash-out 0\.3s ease-out forwards;\s*\}/u,
    );
    expect(keyframes(SPLASH_CSS, 'boot-splash-out')).toBe('to { opacity: 0; visibility: hidden; }');
    // style.css switches transitions off while the app boots, which is exactly
    // when the splash hands over, so the fade over the app is an animation.
    expect(STYLE).toMatch(
      /html\.is-booting :not\(\.app-entrance\),[\s\S]{0,160}?transition: none !important;/u,
    );
    expect(SPLASH_CSS).not.toMatch(/(?:^|[\s;{])transition(?:-[a-z]+)?\s*:/u);
    // The loader keeps turning through the fade (owner decision 2026-11-15);
    // then the runtime takes the splash out of rendering, which ends every
    // animation inside it: the loader's infinite main-thread animation would
    // otherwise cost a style pass every frame all session.
    expect(block(SPLASH_CSS, '      .boot-splash[hidden] {')).toMatch(/^\s*display: none;\s*$/u);
    // Without the runtime nothing hides it, so everything inside freezes at
    // release instead (WebKit also keeps an unfinished fade-in running).
    expect(SPLASH_CSS).toMatch(
      /html:not\(\[data-boot-splash-runtime\]\):not\(\.setup-boot-block\) \.boot-splash \*,\s*html:not\(\[data-boot-splash-runtime\]\)\.boot-splash-released \.boot-splash \*,\s*html:not\(\[data-boot-splash-runtime\]\)\.setup-boot-failed \.boot-splash \* \{\s*animation-play-state: paused;\s*\}/u,
    );
    expect(SPLASH_CSS).not.toMatch(/html:not\(\.setup-boot-block\) \.boot-splash \*/u);
    // Only this release's runtime turns the no-runtime rules off: the one an
    // older release's service worker still serves on the update's first load
    // sets data-wordmark-runtime-ready, and that page keeps them.
    expect(SPLASH_CSS).not.toContain('data-wordmark-runtime-ready');
    const runtimeSource = readFileSync('browser/classic-runtime/wordmark-anim.ts', 'utf8');
    expect(runtimeSource).toMatch(/root\.setAttribute\('data-boot-splash-runtime', 'true'\);/u);
    expect(runtimeSource).not.toMatch(/setAttribute\('data-wordmark-runtime-ready'/u);
    // Last resort when nothing after the page file arrives: step aside 5 s
    // after the 15 s boot-failure fallbacks, on the same variable.
    expect(declaration(SPLASH_CSS, '      .boot-splash {', 'animation').replace(/\s+/gu, ' ')).toBe(
      'boot-splash-fail-open 0s linear calc(var(--setup-boot-failure-delay, 15s) + 5s) forwards',
    );
    expect(keyframes(SPLASH_CSS, 'boot-splash-fail-open')).toBe(
      'to { opacity: 0; visibility: hidden; }',
    );
    expect(STYLE).toMatch(/var\(--setup-boot-failure-delay, 15s\)/u);
    expect(readFileSync('browser/classic-runtime/fouc-cleanup.ts', 'utf8')).toMatch(
      /setTimeout\(failOpenSetupBootGuard, 15_000\)/u,
    );
    // The mark only shows when the load outlasts 0.3 s.
    expect(declaration(SPLASH_CSS, '      .boot-splash-mark {', 'animation')).toBe(
      'boot-splash-mark-in 0.2s ease-out 0.3s forwards',
    );
    // Above every app surface, below the reloadable failure surface.
    expect(Number(declaration(SPLASH_CSS, '      .boot-splash {', 'z-index'))).toBeLessThan(
      Number(declaration(STYLE, '  .bootstrap-failure {', 'z-index')),
    );

    // Setup may restore setup-boot-block before its overlay is ever shown; it
    // must latch the splash off first if the guard had already been lifted.
    const restores = sourceFiles('src').flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return [...source.matchAll(/classList\.add\('setup-boot-block'\)/gu)].map((match) => ({
        path,
        before: source.slice(Math.max(0, (match.index ?? 0) - 240), match.index),
      }));
    });
    expect(restores.length).toBeGreaterThan(0);
    for (const { path, before } of restores) {
      expect(before, path).toMatch(
        /if \(!root\.classList\.contains\('setup-boot-block'\)\) root\.classList\.add\('boot-splash-released'\);\s*root\.$/u,
      );
    }
  });

  it('draws the wordmark at the centre, then raises it as the loader joins', () => {
    const animation = (opener: string) =>
      declaration(SPLASH_CSS, opener, 'animation').replace(/\s+/gu, ' ');
    // Until the runtime takes it, the wordmark shows the reveal's own 15% ghost.
    expect(
      declaration(
        SPLASH_CSS,
        '      .boot-splash-logo:not([data-wordmark-ready]) > .wg {',
        'opacity',
      ),
    ).toBe('0.15');
    expect(declaration(SPLASH_CSS, '      .boot-splash .boot-splash-spinner {', 'opacity')).toBe(
      '0',
    );
    // The runtime's phase: the rise keeps the mark's fade-in by name, so the
    // fade does not restart.
    expect(animation("      .boot-splash[data-phase='loader'] .boot-splash-mark {")).toBe(
      'boot-splash-mark-in 0.2s ease-out 0.3s forwards, boot-splash-mark-rise 0.45s ease-in-out forwards',
    );
    expect(animation("      .boot-splash[data-phase='loader'] .boot-splash-spinner {")).toBe(
      'boot-splash-spinner-in 0.3s ease-out 0.15s forwards',
    );
    // Without the runtime the same motion runs on fixed times.
    expect(animation('      html:not([data-boot-splash-runtime]) .boot-splash-mark {')).toBe(
      'boot-splash-mark-in 0.2s ease-out 0.3s forwards, boot-splash-mark-rise 0.45s ease-in-out 3.2s forwards',
    );
    expect(
      animation('      html:not([data-boot-splash-runtime]) .boot-splash .boot-splash-spinner {'),
    ).toBe('boot-splash-spinner-in 0.3s ease-out 3.35s forwards');
    // After an app reset, or behind a fallback that already rose: the final
    // place at once.
    for (const opener of [
      "      .boot-splash[data-phase='settled'] .boot-splash-mark {",
      "      .boot-splash[data-phase='settled'] .boot-splash-spinner {",
    ]) {
      expect(declaration(SPLASH_CSS, opener, 'opacity'), opener).toBe('1');
      expect(declaration(SPLASH_CSS, opener, 'animation'), opener).toBe('none');
    }
    expect(
      declaration(
        SPLASH_CSS,
        "      .boot-splash[data-phase='settled'] .boot-splash-mark {",
        'transform',
      ),
    ).toBe('none');
    // The whole wordmark, whether or not the drawing runtime has run yet.
    const settledInk = "      .boot-splash[data-phase='settled'] .boot-splash-logo > .wg {";
    expect(declaration(SPLASH_CSS, settledInk, 'opacity')).toBe('1');
    expect(declaration(SPLASH_CSS, settledInk, 'animation')).toBe('none');
  });

  it('keeps the timings the runtime copies equal to the splash sheet', () => {
    // wordmark-anim.ts cannot import the page's sheet, so this pins its copies
    // (resource-ownership registry RO-55).
    const runtime = readFileSync('browser/classic-runtime/wordmark-anim.ts', 'utf8');
    const constant = (name: string) =>
      Number(runtime.match(new RegExp(`const ${name} = ([\\d_]+);`, 'u'))?.[1]?.replace(/_/gu, ''));
    const seconds = (value: string | undefined) =>
      Math.round(Number.parseFloat(value ?? '') * 1000);
    expect(constant('SPLASH_MARK_DELAY')).toBe(
      seconds(declaration(SPLASH_CSS, '      .boot-splash-mark {', 'animation').split(' ')[3]),
    );
    expect(constant('SPLASH_INK_FALLBACK')).toBe(
      seconds(
        declaration(
          SPLASH_CSS,
          '      .boot-splash-logo:not([data-wordmark-ready]) > .wg {',
          'animation',
        ).split(' ')[3],
      ),
    );
    const fallbackRise = declaration(
      SPLASH_CSS,
      '      html:not([data-boot-splash-runtime]) .boot-splash-mark {',
      'animation',
    ).replace(/\s+/gu, ' ');
    expect(constant('SPLASH_RISE_FALLBACK')).toBe(
      seconds(fallbackRise.match(/boot-splash-mark-rise [\d.]+s [a-z-]+ ([\d.]+s)/u)?.[1]),
    );
    expect(constant('SPLASH_FADE')).toBe(
      seconds(
        declaration(SPLASH_CSS, '      html.setup-boot-failed .boot-splash {', 'animation').split(
          ' ',
        )[1],
      ),
    );
    // The runtime retires the splash after exactly these two fades.
    for (const name of ['boot-splash-out', 'boot-splash-fail-open']) {
      expect(runtime).toContain(`'${name}'`);
      expect(SPLASH_CSS).toContain(`@keyframes ${name} {`);
    }
    // The reset writes the stamp the next page's bootstrap.js reads and
    // removes, in order before the app module; its key lives with the other
    // next-document keys (RO-23). The async runtime never touches it.
    const bootstrap = readFileSync('browser/classic-runtime/bootstrap.ts', 'utf8');
    expect(bootstrap.match(/const continuityKey = '([^']+)';/u)?.[1]).toBe(
      BOOT_SPLASH_CONTINUITY_KEY,
    );
    expect(runtime).not.toContain(BOOT_SPLASH_CONTINUITY_KEY);
    expect(readFileSync('src/core/session-reset.ts', 'utf8')).toMatch(
      /sessionStorage\.setItem\(BOOT_SPLASH_CONTINUITY_KEY,/u,
    );
    // The reset screen's box travels with the stamp: the same writer, and the
    // same start-up step reads nothing from it but removes it with the stamp.
    expect(bootstrap.match(/const continuityBoxKey = '([^']+)';/u)?.[1]).toBe(
      BOOT_SPLASH_CONTINUITY_BOX_KEY,
    );
    expect(runtime).not.toContain(BOOT_SPLASH_CONTINUITY_BOX_KEY);
    expect(readFileSync('src/core/session-reset.ts', 'utf8')).toMatch(
      /sessionStorage\.setItem\(\s*BOOT_SPLASH_CONTINUITY_BOX_KEY,/u,
    );
  });

  it('stays safe for the legacy TV engines and off without scripting', () => {
    expect(SPLASH_CSS).not.toMatch(/@layer\b|!important|:(?:is|where|has)\(|:not\([^)]*,/u);
    expect(SPLASH_CSS).not.toMatch(
      /(?:^|[\s;{])(?:inset|gap|inset-inline|inset-block|margin-inline|margin-block|padding-inline|padding-block)\s*:/u,
    );
    expect(readFileSync('public/noscript.css', 'utf8')).toMatch(
      /\.boot-splash \{\s*display: none !important;\s*\}/u,
    );
  });
});

// bootstrap.js's fifth preflight, run against the shipped splash markup: after
// an app reset it settles the splash, in order before the app module.
describe('boot splash continuity preflight (bootstrap.js)', () => {
  const NOW = 1_000_000;
  let preflight = '';

  beforeAll(async () => {
    const source = readFileSync('browser/classic-runtime/bootstrap.ts', 'utf8');
    const start = source.indexOf('(function () {\n  // 5. Boot splash continuity');
    expect(start).toBeGreaterThan(-1);
    preflight = (
      await transformWithEsbuild(source.slice(start), 'continuity-preflight.ts', {
        format: 'iife',
        loader: 'ts',
        target: 'es2018',
      })
    ).code;
  });

  function page({ stamp, phase, box }: { stamp?: string; phase?: string; box?: string } = {}) {
    const shipped = new JSDOM(INDEX).window.document.querySelector('.boot-splash')!.outerHTML;
    const dom = new JSDOM(
      `<!doctype html><html class="setup-boot-block"><body>${shipped}</body></html>`,
      { runScripts: 'outside-only', url: 'https://musixquare.com/' },
    );
    const { window } = dom;
    Object.defineProperty(window.Date, 'now', { value: () => NOW });
    // The loader's moving parts: one turn per 1.85 s, the arc's three parts 1.45 s.
    Object.defineProperty(window, 'getComputedStyle', {
      value: (element: Element) => ({
        animationDuration: element.matches('.material-elastic-turn')
          ? '1.85s'
          : element.matches(
                '.material-elastic-arc, .material-elastic-tail > svg, .material-elastic-head > svg',
              )
            ? '1.45s'
            : '0s',
      }),
    });
    if (stamp !== undefined) window.sessionStorage.setItem(BOOT_SPLASH_CONTINUITY_KEY, stamp);
    if (box !== undefined) window.sessionStorage.setItem(BOOT_SPLASH_CONTINUITY_BOX_KEY, box);
    const splash = window.document.querySelector<HTMLElement>('.boot-splash')!;
    if (phase !== undefined) splash.dataset.phase = phase;
    const delay = (selector: string) =>
      splash.querySelector<HTMLElement | SVGElement>(selector)?.style.animationDelay ?? null;
    return {
      run: () => window.eval(preflight),
      phase: () => splash.dataset.phase,
      stamp: () => window.sessionStorage.getItem(BOOT_SPLASH_CONTINUITY_KEY),
      box: () => window.sessionStorage.getItem(BOOT_SPLASH_CONTINUITY_BOX_KEY),
      delays: () =>
        [
          '.material-elastic-turn',
          '.material-elastic-arc',
          '.material-elastic-tail > svg',
          '.material-elastic-head > svg',
        ].map((part) => delay(`.boot-splash-spinner ${part}`)),
      // Every other part of the loader keeps no delay.
      stillParts: () =>
        [...splash.querySelectorAll<HTMLElement | SVGElement>('.boot-splash-spinner *')]
          .filter(
            (element) =>
              !element.matches(
                '.material-elastic-turn, .material-elastic-arc, .material-elastic-tail > svg, .material-elastic-head > svg',
              ),
          )
          .map((element) => element.style.animationDelay)
          .filter(Boolean),
      window,
    };
  }

  it("settles the splash after a reset under 15 s ago, once, its loader on the wall clock's phase", () => {
    const app = page({ stamp: String(NOW - 14_999) });
    app.run();
    expect(app.phase()).toBe('settled');
    expect(app.stamp()).toBeNull();
    // At 1 000 000 ms a 1 850 ms turn is 1 000 ms in and the 1 450 ms arc 950 ms in.
    expect(app.delays()).toEqual(['-1000ms', '-950ms', '-950ms', '-950ms']);
    expect(app.stillParts()).toEqual([]);
  });

  it.each([
    ['older than 15 s', String(NOW - 15_000)],
    ['unreadable', 'soon'],
    ['negative', String(-1)],
    ['from the future', String(NOW + 1)],
  ])('lets the splash draw after a stamp %s, and removes it', (_label, stamp) => {
    const app = page({ stamp });
    app.run();
    expect(app.phase()).toBeUndefined();
    expect(app.stamp()).toBeNull();
    expect(app.delays()).toEqual(['', '', '', '']);
  });

  it('settles a splash the head preflight already marked as continued, even once the stamp is gone, and leaves its loader phase alone', () => {
    const app = page();
    app.window.document.documentElement.setAttribute('data-boot-continued', '');
    app.run();
    expect(app.phase()).toBe('settled');
    // The preflight's CSS variables started the loader on the wall clock from
    // the first frame; a delay set now would add the time since then.
    expect(app.delays()).toEqual(['', '', '', '']);
  });

  it.each([
    ['a fresh stamp', String(NOW - 1000)],
    ['an old stamp', String(NOW - 15_000)],
    ['no stamp', undefined],
  ])(
    "removes the reset screen's box with %s (the head preflight already read it)",
    (_label, stamp) => {
      const app = page({ stamp, box: '390x844' });
      app.run();
      expect(app.box()).toBeNull();
    },
  );

  it('changes nothing without a stamp, with a phase already set, or without storage', () => {
    const none = page();
    none.run();
    expect(none.phase()).toBeUndefined();

    const set = page({ stamp: String(NOW - 1000), phase: 'loader' });
    set.run();
    expect(set.phase()).toBe('loader');

    const blocked = page();
    Object.defineProperty(blocked.window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    expect(() => blocked.run()).not.toThrow();
    expect(blocked.phase()).toBeUndefined();
  });
});

describe('boot preflight (index.html <head>): the stored theme and a reset continuity before the first paint', () => {
  // bootstrap.js runs from the top of <body>, after the splash, so the splash
  // can paint before it: that first paint used the device theme and an unsettled
  // splash, a frame of the wrong colour or without the wordmark after a refresh.
  const NOW = 1_000_000;
  const PREFLIGHT = INDEX.match(/<script data-boot-preflight>([\s\S]*?)<\/script>/u)?.[1] ?? '';

  function page({
    theme,
    stamp,
    box,
    width,
    height,
    deviceDark = false,
  }: {
    theme?: string;
    stamp?: string;
    box?: string;
    width?: number;
    height?: number;
    deviceDark?: boolean;
  } = {}) {
    const dom = new JSDOM('<!doctype html><html class="setup-boot-block"><head></head></html>', {
      runScripts: 'outside-only',
      url: 'https://musixquare.com/',
    });
    const { window } = dom;
    Object.defineProperty(window.Date, 'now', { value: () => NOW });
    // The first screen this page gets (jsdom's own is 1024 x 768).
    if (width !== undefined) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
    if (height !== undefined) {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    }
    if (box !== undefined) window.sessionStorage.setItem(BOOT_SPLASH_CONTINUITY_BOX_KEY, box);
    Object.defineProperty(window, 'matchMedia', {
      value: (query: string) => ({
        matches: deviceDark && query === '(prefers-color-scheme: dark)',
      }),
    });
    if (theme !== undefined) window.localStorage.setItem('musixquare-theme', theme);
    if (stamp !== undefined) window.sessionStorage.setItem(BOOT_SPLASH_CONTINUITY_KEY, stamp);
    const root = window.document.documentElement;
    return {
      run: () => window.eval(PREFLIGHT),
      state: () => ({
        theme: root.getAttribute('data-theme'),
        scheme: root.style.colorScheme,
        continued: root.hasAttribute('data-boot-continued'),
        delays: [
          root.style.getPropertyValue('--boot-splash-spin-delay'),
          root.style.getPropertyValue('--boot-splash-dash-delay'),
        ],
      }),
      stamp: () => window.sessionStorage.getItem(BOOT_SPLASH_CONTINUITY_KEY),
      box: () => window.sessionStorage.getItem(BOOT_SPLASH_CONTINUITY_BOX_KEY),
      height: () => root.style.getPropertyValue('--boot-continued-height'),
      window,
    };
  }

  it('is the one inline script, in <head> before the splash sheet, with no source to wait for', () => {
    expect(PREFLIGHT, 'index.html has no <script data-boot-preflight> in <head>').not.toBe('');
    const head = INDEX.slice(INDEX.indexOf('<head>'), INDEX.indexOf('</head>'));
    const preflightAt = head.indexOf('<script data-boot-preflight>');
    expect(preflightAt).toBeGreaterThan(-1);
    expect(preflightAt).toBeLessThan(head.indexOf('<style data-boot-splash>'));
    const inline = [...INDEX.matchAll(/<script\b([^>]*)>/gu)].filter(
      ([, attributes]) =>
        !/\bsrc=/u.test(attributes ?? '') &&
        !/\btype=["'](?:application\/ld\+json|application\/json|importmap)["']/u.test(
          attributes ?? '',
        ),
    );
    expect(inline.map(([tag]) => tag)).toEqual(['<script data-boot-preflight>']);
  });

  it.each([
    ['dark', false, 'dark'],
    ['light', true, 'light'],
    ['system', true, 'dark'],
    ['system', false, 'light'],
    [undefined, true, 'dark'],
    ['nonsense', false, 'light'],
  ] as const)(
    'applies the stored theme %s (device dark: %s) as %s',
    (theme, deviceDark, expected) => {
      const app = page({ theme, deviceDark });
      app.run();
      expect(app.state()).toEqual({
        theme: expected,
        scheme: expected,
        continued: false,
        delays: ['', ''],
      });
    },
  );

  it("marks a splash an app reset under 15 s ago continues, its loader on the wall clock's phase, and leaves the stamp to bootstrap.js", () => {
    const app = page({ theme: 'dark', stamp: String(NOW - 14_999) });
    app.run();
    // At 1 000 000 ms a 1 850 ms turn is 1 000 ms in and a 1 450 ms dash 950 ms in.
    expect(app.state()).toEqual({
      theme: 'dark',
      scheme: 'dark',
      continued: true,
      delays: ['-1000ms', '-950ms'],
    });
    expect(app.stamp()).toBe(String(NOW - 14_999));
  });

  it.each([
    ['older than 15 s', String(NOW - 15_000)],
    ['unreadable', 'soon'],
    ['negative', String(-1)],
    ['from the future', String(NOW + 1)],
    ['missing', undefined],
  ])('leaves the splash to draw after a stamp %s', (_label, stamp) => {
    const app = page({ stamp });
    app.run();
    expect(app.state().continued).toBe(false);
    expect(app.state().delays).toEqual(['', '']);
  });

  // Owner report 2026-11-16: on an iPhone a refresh showed the home indicator
  // strip for a moment while the wordmark and loader jumped up and back. iOS
  // gives the new page a first screen short by that strip, and the splash
  // centres in whatever screen it gets, so the reset screen's own height
  // carries the place across instead.
  it.each([
    ['as tall', 844],
    ['34 px shorter (an iPhone home indicator strip)', 810],
    ['64 px shorter', 780],
    ['64 px taller', 908],
  ])(
    "hands the sheet the reset screen's height for a first screen %s at the same width, and leaves its box to bootstrap.js",
    (_label, height) => {
      const app = page({ stamp: String(NOW - 1000), box: '390x844', width: 390, height });
      app.run();
      expect(app.state().continued).toBe(true);
      expect(app.height()).toBe('844px');
      expect(app.box()).toBe('390x844');
    },
  );

  it.each([
    ['another width (the device turned)', '844x390', 390, 810],
    ['more than 64 px shorter', '390x844', 390, 779],
    ['more than 64 px taller', '390x844', 390, 909],
    ['an unreadable box', 'tall', 390, 844],
    ['a box without a height', '390x', 390, 844],
    ['a zero height', '390x0', 390, 30],
    ['no box', undefined, 390, 844],
  ] as const)(
    'lets a continued splash fill its own first screen after %s',
    (_label, box, width, height) => {
      const app = page({ stamp: String(NOW - 1000), box, width, height });
      app.run();
      expect(app.state().continued).toBe(true);
      expect(app.height()).toBe('');
    },
  );

  it('reads no box without a fresh stamp', () => {
    const app = page({ stamp: String(NOW - 15_000), box: '390x844', width: 390, height: 810 });
    app.run();
    expect(app.state().continued).toBe(false);
    expect(app.height()).toBe('');
  });

  it("keeps a continued splash in the reset screen's box: from the top, as tall as the screen it left", () => {
    const opener = '        html[data-boot-continued] .boot-splash {';
    expect(declaration(SPLASH_CSS, opener, 'bottom')).toBe('auto');
    expect(declaration(SPLASH_CSS, opener, 'height')).toBe('var(--boot-continued-height, 100%)');
    // Never shorter than its own screen (a box left short by a size change
    // leaves no band under it), and never more than the preflight's window
    // taller (a screen turned after the first frame keeps the wordmark and
    // loader on it).
    const safeAreaDelta = Number(
      readFileSync('src/core/platform.ts', 'utf8').match(
        /const IOS_STANDALONE_SAFE_AREA_DELTA_MAX = (\d+);/u,
      )?.[1],
    );
    expect(declaration(SPLASH_CSS, opener, 'min-height')).toBe('100%');
    expect(declaration(SPLASH_CSS, opener, 'max-height')).toBe(`calc(100% + ${safeAreaDelta}px)`);
    // Without a kept height it fills its screen as before, from the same top.
    expect(ownDeclaration(SPLASH_CSS, '      .boot-splash {', 'top')).toBe('0');
    expect(ownDeclaration(SPLASH_CSS, '      .boot-splash {', 'position')).toBe('fixed');
  });

  it('leaves a continued splash to fill the page wherever the desktop layout scales body', () => {
    // css/desktop.css scales body (the splash's containing block once the app
    // stylesheet loads) from these sizes on; a kept px height would be scaled
    // with it, so the rule stands outside the smallest of them.
    const desktop = readFileSync('css/desktop.css', 'utf8');
    const scaled = [
      ...desktop.matchAll(
        /@media \(min-width: (\d+)px\) and \(min-height: (\d+)px\) \{\s*body \{\s*--desktop-ui-scale: ([\d.]+);/gu,
      ),
    ].map(([, width, height, scale]) => ({
      width: Number(width),
      height: Number(height),
      scale: Number(scale),
    }));
    expect(scaled.length).toBeGreaterThan(0);
    const smallest = scaled.reduce((a, b) => (a.width * a.height <= b.width * b.height ? a : b));
    expect(smallest.scale).toBeGreaterThan(1);
    for (const query of scaled) {
      expect(query.width).toBeGreaterThanOrEqual(smallest.width);
      expect(query.height).toBeGreaterThanOrEqual(smallest.height);
    }
    const guard = `      @media not all and (min-width: ${smallest.width}px) and (min-height: ${smallest.height}px) {`;
    const start = SPLASH_CSS.indexOf(guard);
    expect(start, guard).toBeGreaterThan(-1);
    const rule = SPLASH_CSS.indexOf('        html[data-boot-continued] .boot-splash {', start);
    expect(rule).toBeGreaterThan(start);
    // The rule is the guard's only content.
    expect(SPLASH_CSS.slice(start + guard.length, rule).trim()).toBe('');
    expect(SPLASH_CSS.indexOf('html[data-boot-continued] .boot-splash {')).toBe(rule + 8);
  });

  it('changes nothing it cannot read when storage is blocked', () => {
    const app = page();
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(app.window, name, {
        configurable: true,
        get() {
          throw new Error('denied');
        },
      });
    }
    expect(() => app.run()).not.toThrow();
    expect(app.state()).toEqual({ theme: null, scheme: '', continued: false, delays: ['', ''] });
  });

  it('shows a continued splash in its final place from the first frame, as the settled one', () => {
    const settled = (selector: string) =>
      block(SPLASH_CSS, `      .boot-splash[data-phase='settled'] ${selector} {`)
        .replace(/\s+/gu, ' ')
        .trim();
    const continued = (selector: string) =>
      block(SPLASH_CSS, `      html[data-boot-continued] .boot-splash ${selector} {`)
        .replace(/\s+/gu, ' ')
        .trim();
    for (const selector of [
      '.boot-splash-mark',
      '.boot-splash-spinner',
      '.boot-splash-logo > .wg',
    ]) {
      expect(continued(selector), selector).toBe(settled(selector));
    }
    expect(
      declaration(
        SPLASH_CSS,
        '      html[data-boot-continued] .boot-splash .boot-splash-spinner .material-elastic-turn {',
        'animation-delay',
      ),
    ).toBe('var(--boot-splash-spin-delay, 0ms)');
    // The arc's three parts share one phase.
    expect(
      declaration(
        SPLASH_CSS,
        [
          '      html[data-boot-continued] .boot-splash .boot-splash-spinner .material-elastic-arc,',
          '      html[data-boot-continued] .boot-splash .boot-splash-spinner .material-elastic-tail > svg,',
          '      html[data-boot-continued] .boot-splash .boot-splash-spinner .material-elastic-head > svg {',
        ].join('\n'),
        'animation-delay',
      ),
    ).toBe('var(--boot-splash-dash-delay, 0ms)');
  });

  it('keeps the copies it carries equal to their homes', () => {
    const bootstrap = readFileSync('browser/classic-runtime/bootstrap.ts', 'utf8');
    expect(PREFLIGHT).toContain(`localStorage.getItem('musixquare-theme')`);
    expect(bootstrap).toContain(`localStorage.getItem('musixquare-theme')`);
    expect(PREFLIGHT).toContain(`sessionStorage.getItem('${BOOT_SPLASH_CONTINUITY_KEY}')`);
    expect(PREFLIGHT).toContain(`sessionStorage.getItem('${BOOT_SPLASH_CONTINUITY_BOX_KEY}')`);
    // A kept height counts only within the largest safe-area difference the
    // installed iOS app shows between its height readings (src/core/platform.ts).
    const safeAreaDelta = Number(
      readFileSync('src/core/platform.ts', 'utf8').match(
        /const IOS_STANDALONE_SAFE_AREA_DELTA_MAX = (\d+);/u,
      )?.[1],
    );
    expect(safeAreaDelta).toBe(64);
    expect(PREFLIGHT).toContain(`<= ${safeAreaDelta}`);
    const window = Number(
      bootstrap.match(/const continuityWindowMs = ([\d_]+);/u)?.[1]?.replace(/_/gu, ''),
    );
    expect(window).toBe(15_000);
    expect(PREFLIGHT).toContain(`< ${window}`);
    const period = (part: string) =>
      Math.round(
        Number.parseFloat(
          ownDeclaration(SPLASH_CSS, `      .boot-splash-spinner ${part} {`, 'animation').split(
            ' ',
          )[1] ?? '',
        ) * 1000,
      );
    const spin = period('.material-elastic-turn');
    const dash = period('.material-elastic-arc');
    expect([spin, dash]).toEqual([1850, 1450]);
    expect([
      period('.material-elastic-tail > svg'),
      period('.material-elastic-head > svg'),
    ]).toEqual([dash, dash]);
    expect(PREFLIGHT).toContain(`now % ${spin}`);
    expect(PREFLIGHT).toContain(`now % ${dash}`);
  });
});
