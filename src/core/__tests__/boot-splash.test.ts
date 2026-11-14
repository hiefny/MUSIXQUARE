import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { APP_RENDER_ASSETS_SLOT, prioritizeActiveStylesheetsInHtml } from '../../../vite.config.ts';

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
        /\btype=["']application\/ld\+json["']|\bdefer\b|\btype=["']module["']/u.test(
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
    expect(splash?.querySelector('svg.boot-splash-logo')?.getAttribute('focusable')).toBe('false');
    dom.window.close();
  });

  it('starts the scripts, then the app stylesheet slot, right after the splash', () => {
    const order = [
      INDEX.indexOf('<body>'),
      INDEX.indexOf('<div class="boot-splash"'),
      INDEX.indexOf('<script src="/bootstrap.js?cache='),
      INDEX.indexOf('<script src="/fouc-cleanup.js"></script>'),
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
      <script src="/wordmark-anim.js" defer></script>
      <script type="module" crossorigin src="/assets/main-a.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/log-b.js">
      <link rel="modulepreload" crossorigin href="/assets/peer-c.js">
      <link rel="stylesheet" crossorigin href="/assets/main-d.css">
    </head><body>
      <div class="boot-splash"></div>
      <script src="/bootstrap.js?cache=v1"></script>
      <script src="/fouc-cleanup.js"></script>
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

  it('draws the welcome wordmark whole, glyph for glyph', () => {
    const dom = new JSDOM(INDEX);
    const { document } = dom.window;
    const shapes = (svg: Element | null) =>
      [...(svg?.querySelectorAll('polygon, path, rect') ?? [])]
        .filter((shape) => !shape.closest('defs'))
        .map((shape) =>
          ['points', 'd', 'x', 'y', 'width', 'height']
            .map((name) => shape.getAttribute(name))
            .filter((value) => value !== null)
            .join(' '),
        );
    const splashLogo = document.querySelector('.boot-splash-logo');
    const welcomeLogo = document.querySelector('.logo-welcome');
    expect(splashLogo?.getAttribute('viewBox')).toBe(welcomeLogo?.getAttribute('viewBox'));
    expect(shapes(splashLogo)).toEqual(shapes(welcomeLogo));
    // M U S I X Q U A R and the three bars of E.
    expect(shapes(splashLogo)).toHaveLength(12);
    dom.window.close();
    // The Q's tail (to y 38) and the R's leg (to y 36.4) reach below the
    // viewBox (y 12 to 36); every app wordmark draws them (.logo-svg).
    expect(declaration(STYLE, '  .logo-svg {', 'overflow')).toBe('visible');
    expect(declaration(SPLASH_CSS, '      .boot-splash-logo {', 'overflow')).toBe('visible');
  });

  it('draws the shared loader exactly as the setup screen does', () => {
    expect(declaration(STYLE, '  .setup-qr-join-spinner {', '--material-elastic-size')).toBe(
      '42px',
    );
    expect(declaration(SPLASH_CSS, '      .boot-splash-spinner > svg {', 'width')).toBe('42px');
    expect(declaration(SPLASH_CSS, '      .boot-splash-spinner > svg {', 'height')).toBe('42px');
    // The 40px gap above the loader is part of its box (82 = 40 + 42), never a
    // margin or padding: style.css zeroes both on every element.
    expect(declaration(SPLASH_CSS, '      .boot-splash-spinner {', 'height')).toBe('82px');
    expect(declaration(SPLASH_CSS, '      .boot-splash-spinner {', 'align-items')).toBe('flex-end');
    expect(declaration(STYLE, '  * {', 'margin')).toBe('0');
    expect(declaration(STYLE, '  * {', 'padding')).toBe('0');
    expect(SPLASH_CSS).not.toMatch(/(?:^|[\s;{])(?:margin|padding)(?:-[a-z]+)?\s*:/u);
    expect(declaration(STYLE, '  .material-elastic-spinner {', '--material-elastic-stroke')).toBe(
      declaration(SPLASH_CSS, '      .boot-splash-spinner circle {', 'stroke-width'),
    );

    const component = block(STYLE, '  .material-elastic-spinner > svg {');
    const splash = block(SPLASH_CSS, '      .boot-splash-spinner > svg {');
    expect(component).toMatch(/animation: material-elastic-spin 1\.85s linear infinite;/u);
    expect(splash).toMatch(/animation: boot-splash-spin 1\.85s linear infinite;/u);
    for (const property of ['overflow', 'transform-box', 'transform-origin', 'shape-rendering']) {
      expect(declaration(SPLASH_CSS, '      .boot-splash-spinner > svg {', property)).toBe(
        declaration(STYLE, '  .material-elastic-spinner > svg {', property),
      );
    }

    expect(block(STYLE, '  .material-elastic-spinner circle {')).toMatch(
      /animation: material-elastic-dash 1\.45s ease-in-out infinite;/u,
    );
    expect(block(SPLASH_CSS, '      .boot-splash-spinner circle {')).toMatch(
      /animation: boot-splash-dash 1\.45s ease-in-out infinite;/u,
    );
    for (const property of [
      'fill',
      'stroke',
      'stroke-linecap',
      'stroke-dasharray',
      'stroke-dashoffset',
    ]) {
      expect(declaration(SPLASH_CSS, '      .boot-splash-spinner circle {', property)).toBe(
        declaration(STYLE, '  .material-elastic-spinner circle {', property),
      );
    }
    expect(keyframes(SPLASH_CSS, 'boot-splash-spin')).toBe(
      keyframes(STYLE, 'material-elastic-spin'),
    );
    expect(keyframes(SPLASH_CSS, 'boot-splash-dash')).toBe(
      keyframes(STYLE, 'material-elastic-dash'),
    );

    // Reduced motion freezes both on the same static arc.
    const staticArc = (section: string) => ({
      dasharray: section.match(/stroke-dasharray:\s*([^;]+);/u)?.[1],
      dashoffset: section.match(/stroke-dashoffset:\s*([^;]+);/u)?.[1],
    });
    const reducedComponent = STYLE.slice(
      STYLE.indexOf(
        '@media (prefers-reduced-motion: reduce) {',
        STYLE.indexOf('@keyframes material-elastic-dash'),
      ),
    );
    const reducedSplash = SPLASH_CSS.slice(
      SPLASH_CSS.indexOf('@media (prefers-reduced-motion: reduce) {'),
    );
    expect(staticArc(reducedSplash)).toEqual({ dasharray: '58 42', dashoffset: '-18' });
    expect(staticArc(reducedSplash)).toEqual(staticArc(reducedComponent));
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
