import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { MATERIAL_ELASTIC_SPINNER_PARTS } from '../material-elastic-spinner.ts';

// The shared loader moves by turning layers only (transforms), which the
// compositor runs without the page. iOS stops painting a page it is leaving:
// on the session refresh screen the old loader's animated stroke dash froze
// there while its turn ran on, a short or long arc at one steady speed.
const INDEX = readFileSync('index.html', 'utf8');
const STYLE = readFileSync('css/style.css', 'utf8');
const SPLASH_CSS = INDEX.match(/<style data-boot-splash>([\s\S]*?)<\/style>/u)?.[1] ?? '';
const EDITORIAL = readFileSync('public/editorial-design.css', 'utf8');
const DESIGN_SYSTEM = readFileSync('public/designsystem/index.html', 'utf8');

const SHEETS = [
  {
    name: 'css/style.css',
    css: STYLE,
    root: '.material-elastic-spinner',
    prefix: 'material-elastic',
  },
  {
    name: 'index.html splash sheet',
    css: SPLASH_CSS,
    root: '.boot-splash-spinner',
    prefix: 'boot-splash',
  },
  {
    name: 'public/editorial-design.css',
    css: EDITORIAL,
    root: '.material-elastic-spinner',
    prefix: 'material-elastic',
  },
] as const;

function keyframesBody(css: string, name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  expect(start, `@keyframes ${name}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(css.indexOf('{', start) + 1, index);
  }
  throw new Error(`Unclosed @keyframes ${name}`);
}

/** Each keyframe's offset with the properties it sets and its rotation, if any. */
function keyframeSteps(css: string, name: string) {
  return [...keyframesBody(css, name).matchAll(/([^{}]+)\{([^}]*)\}/gu)].map(
    ([, offsets = '', declarations = '']) => ({
      offsets: offsets.split(',').map((offset) =>
        offset
          .trim()
          .replace(/^from$/u, '0%')
          .replace(/^to$/u, '100%'),
      ),
      properties: [...declarations.matchAll(/([a-z-]+)\s*:/gu)].map(([, property]) => property),
      rotation: Number(declarations.match(/transform:\s*rotate\((-?[\d.]+)deg\)/u)?.[1]),
    }),
  );
}

interface Rule {
  selectors: string[];
  declarations: string;
  /** The at-rules around it, outermost first (layers, media, keyframes). */
  within: string[];
}

/** Every style rule in the sheet with the at-rules it sits in. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const found: Rule[] = [];
  const open: { prelude: string; start: number; nested: boolean }[] = [];
  let preludeStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') {
      const parent = open.at(-1);
      if (parent) parent.nested = true;
      const prelude = text.slice(preludeStart, index).trim().replace(/\s+/gu, ' ');
      open.push({ prelude, start: index + 1, nested: false });
      preludeStart = index + 1;
    } else if (char === '}') {
      const block = open.pop();
      if (block && !block.nested && !open.some((outer) => outer.prelude.startsWith('@keyframes'))) {
        found.push({
          selectors: block.prelude.split(',').map((selector) => selector.trim()),
          declarations: text.slice(block.start, index),
          within: open.map((outer) => outer.prelude),
        });
      }
      preludeStart = index + 1;
    } else if (char === ';') {
      preludeStart = index + 1;
    }
  }
  return found;
}

const reduced = (rule: Rule) =>
  rule.within.some((prelude) => prelude.includes('prefers-reduced-motion'));

/** A property's value for a selector, from the last rule that sets it. */
function declaration(
  css: string,
  selector: string,
  property: string,
  { reducedMotion = false } = {},
): string | undefined {
  let value: string | undefined;
  for (const rule of rules(css)) {
    if (reduced(rule) !== reducedMotion || !rule.selectors.includes(selector)) continue;
    const match = rule.declarations.match(new RegExp(`(?:^|[\\s;])${property}:\\s*([^;]+);`, 'u'));
    if (match?.[1]) value = match[1].trim();
  }
  return value;
}

/** The static rotation reduced motion gives a part. */
function staticRotation(css: string, selector: string): number {
  const transform = declaration(css, selector, 'transform', { reducedMotion: true });
  expect(transform, `reduced-motion transform for ${selector}`).toMatch(/^rotate\(-?[\d.]+deg\)$/u);
  return Number(transform?.match(/rotate\((-?[\d.]+)deg\)/u)?.[1]);
}

// The dash the loader drew before, in its own units (100 per turn): a dash of
// `length` that starts `-offset` units clockwise from 3 o'clock.
const DASH_KEYFRAMES = [
  { offset: '0%', length: 2, dashOffset: 0 },
  { offset: '48%', length: 74, dashOffset: -12 },
  { offset: '100%', length: 2, dashOffset: -100 },
] as const;
const REDUCED_DASH = { length: 58, dashOffset: -18 } as const;
// The arc's middle (degrees clockwise from 3 o'clock) and half its length.
const middle = (dash: { length: number; dashOffset: number }) =>
  3.6 * (-dash.dashOffset + dash.length / 2);
const half = (dash: { length: number }) => 1.8 * dash.length;

describe('shared loader (material elastic spinner)', () => {
  it.each(SHEETS)('moves only by transforms and opacity in $name', ({ css, root, prefix }) => {
    const animated = rules(css).filter(
      (rule) =>
        rule.selectors.some((selector) => selector.includes(root)) &&
        /(?:^|[\s;])animation(?:-name)?\s*:/u.test(rule.declarations),
    );
    const names = new Set(
      animated
        .map(
          (rule) => rule.declarations.match(/(?:^|[\s;])animation(?:-name)?\s*:\s*([\w-]+)/u)?.[1],
        )
        .filter((name): name is string => !!name && name !== 'none'),
    );
    expect([...names]).toEqual(
      expect.arrayContaining([
        `${prefix}-spin`,
        `${prefix}-arc`,
        `${prefix}-tail`,
        `${prefix}-head`,
      ]),
    );
    for (const name of names) {
      for (const step of keyframeSteps(css, name)) {
        for (const property of step.properties) {
          expect(
            ['transform', 'opacity'],
            `${name} ${step.offsets.join(',')} ${property}`,
          ).toContain(property);
        }
      }
    }
    // The stroke dash is drawn once, never animated.
    expect(css).not.toContain(`@keyframes ${prefix}-dash`);
  });

  it.each(SHEETS)('draws the arc the dash drew, in $name', ({ css, root, prefix }) => {
    expect(keyframeSteps(css, `${prefix}-spin`)).toEqual([
      { offsets: ['100%'], properties: ['transform'], rotation: 360 },
    ]);
    // The frame turns its 12 o'clock to the arc's middle; the tail ring turns
    // its end to half the arc before it, the head ring to half the arc after.
    const expected = {
      arc: DASH_KEYFRAMES.map((dash) => middle(dash) + 90),
      tail: DASH_KEYFRAMES.map((dash) => -(90 + half(dash))),
      head: DASH_KEYFRAMES.map((dash) => 90 + half(dash)),
    };
    for (const [part, rotations] of Object.entries(expected)) {
      const steps = keyframeSteps(css, `${prefix}-${part}`);
      expect(steps.map((step) => step.offsets)).toEqual(
        DASH_KEYFRAMES.map((dash) => [dash.offset]),
      );
      steps.forEach((step, index) => {
        expect(step.properties, `${part} ${step.offsets[0]}`).toEqual(['transform']);
        expect(step.rotation, `${part} ${step.offsets[0]}`).toBeCloseTo(rotations[index] ?? NaN, 6);
      });
    }
    // One turn later the arc is where it began: no jump between cycles.
    expect(expected.arc[2]! - expected.arc[0]!).toBeCloseTo(360, 6);

    // Same clocks as the dash: one turn per 1.85 s, the arc 1.45 s ease-in-out.
    const parts = {
      spin: `${root} .material-elastic-turn`,
      arc: `${root} .material-elastic-arc`,
      tail: `${root} .material-elastic-tail > svg`,
      head: `${root} .material-elastic-head > svg`,
    };
    expect(declaration(css, parts.spin, 'animation')).toBe(`${prefix}-spin 1.85s linear infinite`);
    for (const part of ['arc', 'tail', 'head'] as const) {
      expect(declaration(css, parts[part], 'animation')).toBe(
        `${prefix}-${part} 1.45s ease-in-out infinite`,
      );
    }

    // Reduced motion holds the same static arc the dash held (58 of 100 from 18).
    expect(staticRotation(css, parts.arc)).toBeCloseTo(middle(REDUCED_DASH) + 90, 6);
    expect(staticRotation(css, parts.tail)).toBeCloseTo(-(90 + half(REDUCED_DASH)), 6);
    expect(staticRotation(css, parts.head)).toBeCloseTo(90 + half(REDUCED_DASH), 6);

    // Every turning part turns about the loader's centre in px: WebKit takes a
    // percentage origin of a box snapped to device pixels, which set nested
    // parts on different centres at sizes such as 13.444 px.
    const centre =
      root === '.boot-splash-spinner'
        ? '12px 12px'
        : 'calc(var(--material-elastic-size) / 2) calc(var(--material-elastic-size) / 2)';
    for (const selector of Object.values(parts)) {
      expect(declaration(css, selector, 'transform-origin'), selector).toBe(centre);
    }
  });

  it.each(SHEETS)('clips each half ring to its half of the frame, in $name', ({ css, root }) => {
    for (const side of ['tail', 'head']) {
      expect(declaration(css, `${root} .material-elastic-${side}`, 'overflow')).toBe('hidden');
      expect(declaration(css, `${root} .material-elastic-${side}`, 'width')).toMatch(
        /^(?:50%|12px)$/u,
      );
      // Each half ring is the whole loader's size, centred on the frame's centre.
      expect(declaration(css, `${root} .material-elastic-${side} > svg`, 'width')).toMatch(
        /^(?:200%|24px)$/u,
      );
    }
    expect(declaration(css, `${root} .material-elastic-tail`, 'left')).toBe('0');
    expect(declaration(css, `${root} .material-elastic-head`, 'left')).toMatch(/^(?:50%|12px)$/u);
    expect(declaration(css, `${root} .material-elastic-tail > svg`, 'left')).toBe('0');
    expect(declaration(css, `${root} .material-elastic-head > svg`, 'left')).toMatch(
      /^(?:-100%|-12px)$/u,
    );
  });

  it('carries the same parts in every copy of the loader', () => {
    const parts = (root: Element) =>
      [...root.querySelectorAll('*')].map((element) =>
        [
          element.localName,
          element.getAttribute('class') ?? '',
          element.getAttribute('viewBox') ?? '',
          element.getAttribute('d') ?? '',
          element.parentElement === root ? 'top' : '',
        ].join('|'),
      );
    const canonical = new JSDOM(
      `<span class="material-elastic-spinner">${MATERIAL_ELASTIC_SPINNER_PARTS}</span>`,
    ).window.document.querySelector('span')!;
    const expected = parts(canonical);
    expect(expected[0]).toBe('span|material-elastic-turn|||top');

    const copies: [string, Element][] = [];
    for (const [file, html] of [
      ['index.html', INDEX],
      ['public/designsystem/index.html', DESIGN_SYSTEM],
    ] as const) {
      const document = new JSDOM(html).window.document;
      for (const loader of document.querySelectorAll(
        '.material-elastic-spinner, .boot-splash-spinner',
      )) {
        copies.push([`${file} ${loader.getAttribute('class')}`, loader]);
      }
    }
    // The splash, seven app loaders and the design-system page's large one.
    expect(copies).toHaveLength(9);
    for (const [label, loader] of copies) {
      expect(parts(loader), label).toEqual(expected);
      expect(loader.getAttribute('aria-hidden'), label).toBe('true');
    }
  });

  it('builds its loaders from the shared parts and draws no dash anywhere', () => {
    const sources = readdirSync('src', { recursive: true, encoding: 'utf8' })
      .filter((path) => path.endsWith('.ts') && !path.split(/[\\/]/u).includes('__tests__'))
      .map((path) => [path, readFileSync(join('src', path), 'utf8')] as const);
    const builders = sources
      .filter(
        ([, source]) =>
          /material-elastic-spinner/u.test(source) && /innerHTML|`\s*<span/u.test(source),
      )
      .map(([path]) => path.replace(/\\/gu, '/'));
    expect(builders.sort()).toEqual(['ui/connect.ts', 'ui/playlist-view.ts']);
    for (const [path, source] of sources) {
      expect(source, path).not.toMatch(/pathLength="100"|<circle cx="22" cy="22" r="18"/u);
      if (builders.includes(path.replace(/\\/gu, '/'))) {
        expect(source, path).toContain('MATERIAL_ELASTIC_SPINNER_PARTS');
      }
    }
    for (const [file, text] of [
      ['index.html', INDEX],
      ['public/designsystem/index.html', DESIGN_SYSTEM],
    ] as const) {
      expect(text, file).not.toMatch(/<circle cx="22" cy="22" r="18"/u);
    }
  });

  it("puts the seam patch exactly on the shortest arc, at the frame's 12 o'clock", () => {
    const document = new JSDOM(`<span>${MATERIAL_ELASTIC_SPINNER_PARTS}</span>`).window.document;
    const seam = document.querySelector('.material-elastic-seam path')?.getAttribute('d') ?? '';
    const point = (degrees: number) =>
      [22 + 18 * Math.cos((degrees * Math.PI) / 180), 22 + 18 * Math.sin((degrees * Math.PI) / 180)]
        .map((value) => value.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, ''))
        .join(' ');
    const shortest = half(DASH_KEYFRAMES[0]);
    expect(seam).toBe(`M${point(270 - shortest)}A18 18 0 0 1 ${point(270 + shortest)}`);
    // Each half ring: the ring's bottom half, from 3 o'clock to 9 o'clock.
    for (const side of ['tail', 'head']) {
      expect(
        document.querySelector(`.material-elastic-${side} > svg > path`)?.getAttribute('d'),
      ).toBe('M40 22a18 18 0 0 1-36 0');
    }
  });
});
