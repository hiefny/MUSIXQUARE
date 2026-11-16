import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import {
  MATERIAL_ELASTIC_ARC_PERIOD_MS,
  MATERIAL_ELASTIC_SPINNER_PARTS,
  MATERIAL_ELASTIC_TURN_PERIOD_MS,
} from '../material-elastic-spinner.ts';

// The shared loader moves by turning layers only (transforms), which the
// compositor runs without the page. iOS stops painting a page it is leaving:
// on the session refresh screen the old loader's animated stroke dash froze
// there while its turn ran on, a short or long arc at one steady speed.
// It turns as Google's Material circular progress does (Material Components
// Web 14, @material/circular-progress, MIT), the owner's choice of 2026-11-16
// after seeing the two side by side on Windows.
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

// Google's motion, part for part: our turn is its container, our arc its
// spinner layer, our tail and head its left and right circle clippers, our
// seam its gap patch. The container turns once per 1568.2352941176 ms, kept
// here to the whole ms so the period reads the same wherever it is copied or
// parsed (a minifier writes the long one as 1.56824s); the layer steps 135
// degrees eight times per 5332 ms, and the clippers' rings swing every 1333
// ms, four swings per layer cycle, so one phase serves the layer and both.
const STANDARD_CURVE = 'cubic-bezier(0.4, 0, 0.2, 1)';
const CLOCKS = {
  spin: `${MATERIAL_ELASTIC_TURN_PERIOD_MS / 1000}s linear infinite`,
  arc: `${MATERIAL_ELASTIC_ARC_PERIOD_MS / 1000}s ${STANDARD_CURVE} infinite both`,
  tail: `${MATERIAL_ELASTIC_ARC_PERIOD_MS / 4000}s ${STANDARD_CURVE} infinite both`,
  head: `${MATERIAL_ELASTIC_ARC_PERIOD_MS / 4000}s ${STANDARD_CURVE} infinite both`,
} as const;
const LAYER_STEPS = Array.from({ length: 9 }, (_, step) => ({
  offset: `${step * 12.5}%`,
  rotation: step * 135,
}));
// The left ring swings 265 -> 130 -> 265 degrees, the right one the mirror.
const SWING = [
  { offset: '0%', left: 265 },
  { offset: '50%', left: 130 },
  { offset: '100%', left: 265 },
] as const;
// A left ring turned by L shows the part of its half that falls in the left
// half of the layer: from L to 12 o'clock (270), so half the arc is 270 - L,
// and the right ring, turned by -L, shows as much after 12 o'clock.
const halfArc = (left: number) => 270 - left;
// Reduced motion holds the still arc the loader has held since 9.0.49: 58 of
// 100 units from 18 units on, its middle 169.2 degrees clockwise from 3
// o'clock (the layer's 12 o'clock turned there) and half of it 104.4.
const STILL = { middle: 3.6 * (18 + 58 / 2), half: 1.8 * 58 } as const;
const mod360 = (degrees: number) => ((degrees % 360) + 360) % 360;

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

  it.each(SHEETS)(
    "turns as Google's Material circular progress does, in $name",
    ({ name, css, root, prefix }) => {
      expect(keyframeSteps(css, `${prefix}-spin`)).toEqual([
        { offsets: ['100%'], properties: ['transform'], rotation: 360 },
      ]);
      // The layer steps 135 degrees at every eighth of its cycle, so its 12
      // o'clock, the arc's middle, lands three turns on: no jump between cycles.
      expect(keyframeSteps(css, `${prefix}-arc`)).toEqual(
        LAYER_STEPS.map(({ offset, rotation }) => ({
          offsets: [offset],
          properties: ['transform'],
          rotation,
        })),
      );
      expect(LAYER_STEPS.at(-1)!.rotation % 360).toBe(0);
      for (const [part, sign] of [
        ['tail', 1],
        ['head', -1],
      ] as const) {
        expect(keyframeSteps(css, `${prefix}-${part}`)).toEqual(
          SWING.map(({ offset, left }) => ({
            offsets: [offset],
            properties: ['transform'],
            rotation: sign * left,
          })),
        );
      }
      // From the shortest arc, 5 degrees each side of 12 o'clock, to 140.
      expect(SWING.map(({ left }) => halfArc(left))).toEqual([5, 140, 5]);

      const parts = {
        spin: `${root} .material-elastic-turn`,
        arc: `${root} .material-elastic-arc`,
        tail: `${root} .material-elastic-tail > .material-elastic-ring`,
        head: `${root} .material-elastic-head > .material-elastic-ring`,
      };
      for (const part of ['spin', 'arc', 'tail', 'head'] as const) {
        expect(declaration(css, parts[part], 'animation'), part).toBe(
          `${prefix}-${part} ${CLOCKS[part]}`,
        );
      }

      // The app's loaders take their phase from two variables (playlist-view.ts
      // sets them on a rebuilt upload row): the turn its own, the layer and its
      // two rings one they share, since four ring swings make one layer cycle;
      // apart, the arc would leave the layer's 12 o'clock. Each delay comes
      // after the shorthand, which would otherwise reset it.
      expect(MATERIAL_ELASTIC_ARC_PERIOD_MS % 4).toBe(0);
      if (name === 'css/style.css') {
        for (const [part, variable] of [
          ['spin', '--material-elastic-spin-delay'],
          ['arc', '--material-elastic-dash-delay'],
          ['tail', '--material-elastic-dash-delay'],
          ['head', '--material-elastic-dash-delay'],
        ] as const) {
          const rule = rules(css).find(
            (candidate) =>
              !reduced(candidate) &&
              candidate.selectors.includes(parts[part]) &&
              /(?:^|[\s;])animation:/u.test(candidate.declarations),
          );
          const declarations = rule?.declarations ?? '';
          expect(declarations, parts[part]).toMatch(
            new RegExp(`animation:[^;]+;[\\s\\S]*animation-delay: var\\(${variable}, 0ms\\);`, 'u'),
          );
        }
      }

      // Reduced motion holds the still arc: the layer's 12 o'clock (270 degrees)
      // turned to its middle, each ring turned to show half of it.
      expect(mod360(270 + staticRotation(css, parts.arc))).toBeCloseTo(STILL.middle, 6);
      expect(staticRotation(css, parts.tail)).toBeCloseTo(270 - STILL.half, 6);
      expect(staticRotation(css, parts.head)).toBeCloseTo(-(270 - STILL.half), 6);
      expect(halfArc(staticRotation(css, parts.tail))).toBeCloseTo(STILL.half, 6);

      // Every turning part turns about the loader's centre in px: WebKit takes a
      // percentage origin of a box snapped to device pixels on its main thread.
      const centre =
        root === '.boot-splash-spinner'
          ? '12px 12px'
          : 'calc(var(--material-elastic-size) / 2) calc(var(--material-elastic-size) / 2)';
      for (const selector of Object.values(parts)) {
        expect(declaration(css, selector, 'transform-origin'), selector).toBe(centre);
      }
    },
  );

  it.each(SHEETS)(
    "draws the seam at 80 % of the ring's stroke, as Google's gap patch, in $name",
    ({ css, root }) => {
      const ring = declaration(css, `${root} path`, 'stroke-width');
      const seam = declaration(css, `${root} .material-elastic-seam path`, 'stroke-width');
      if (root === '.boot-splash-spinner') {
        // The splash draws the app's default 24px loader in fixed lengths.
        expect(ring).toBe(
          declaration(STYLE, '.material-elastic-spinner', '--material-elastic-stroke'),
        );
        expect(Number(seam)).toBeCloseTo(Number(ring) * 0.8, 9);
      } else {
        // Every size's own stroke, through the variable each host sets.
        expect(ring).toBe('var(--material-elastic-stroke)');
        expect(seam).toBe('calc(var(--material-elastic-stroke) * 0.8px)');
      }
    },
  );

  it('turns every moving part as an HTML box, which every compositor runs', () => {
    // Chromium runs a transform animation on an <svg> on the main thread
    // whenever the device scale is not 1, so on a 125 % or 150 % Windows
    // display or a phone the rings stopped whenever the page was busy while
    // the turn and the layer kept going, and the arc's parts moved apart. Each
    // ring turns on a span holding its drawing.
    for (const { css, root } of SHEETS) {
      for (const rule of rules(css)) {
        if (!rule.selectors.some((selector) => selector.includes(root))) continue;
        const animation = rule.declarations.match(
          /(?:^|[\s;])animation(?:-name)?\s*:\s*([^;]+);/u,
        )?.[1];
        if (!animation || /^none\b/u.test(animation.trim())) continue;
        for (const selector of rule.selectors) {
          expect(selector, `${root}: ${selector}`).not.toMatch(
            /(?:^|[\s>+~])(?:svg|path|circle)(?:[.:[]|$)/u,
          );
        }
      }
    }
    const document = new JSDOM(`<span>${MATERIAL_ELASTIC_SPINNER_PARTS}</span>`).window.document;
    for (const part of ['turn', 'arc', 'ring']) {
      const elements = [...document.querySelectorAll(`.material-elastic-${part}`)];
      expect(elements.length, part).toBeGreaterThan(0);
      for (const element of elements) expect(element.localName, part).toBe('span');
    }
    for (const side of ['tail', 'head']) {
      expect(
        document.querySelectorAll(
          `.material-elastic-${side} > .material-elastic-ring > svg > path`,
        ),
        side,
      ).toHaveLength(1);
    }
  });

  it('sizes every loader to an even whole number of px', () => {
    // WebKit rounds each composited part's pivot to a device pixel but draws
    // its ring about the exact centre, so a loader whose half is not a whole
    // pixel turns its two half rings about points apart: a step at the arc's
    // middle that flips sides every cycle, and a wobble. Half an even whole
    // px is whole at 1x, 2x and 3x (at 100 % page zoom). A ring drawn smaller
    // keeps its even box and sits inside it (--material-elastic-ring-size).
    // Every sheet and page the app or its public pages ship:
    const files = [
      'index.html',
      ...['css', 'public'].flatMap((dir) =>
        readdirSync(dir, { recursive: true, encoding: 'utf8' })
          .filter((path) => /\.(?:css|html)$/u.test(path))
          .map((path) => join(dir, path)),
      ),
    ];
    const declared = (property: string) =>
      files.flatMap((path) =>
        [
          ...readFileSync(path, 'utf8').matchAll(new RegExp(`${property}:\\s*([^;"]+)[;"]`, 'gu')),
        ].map(([, value]) => [path, value!.trim()] as const),
      );
    const sizes = [
      ...declared('--material-elastic-size'),
      [
        'index.html',
        declaration(SPLASH_CSS, '.boot-splash-spinner .material-elastic-turn', 'width') ?? '',
      ] as const,
    ];
    expect(sizes.length).toBeGreaterThan(10);
    for (const [path, size] of sizes) {
      expect(size, `${path} ${size}`).toMatch(/^\d+px$/u);
      expect(Number.parseInt(size, 10) % 2, `${path} ${size}`).toBe(0);
    }
    // The stroke is a number of viewBox units, which the seam's calc() needs.
    const strokes = declared('--material-elastic-stroke');
    expect(strokes.length).toBeGreaterThan(5);
    for (const [path, stroke] of strokes) {
      expect(stroke, `${path} ${stroke}`).toMatch(/^\d+(?:\.\d+)?$/u);
    }
    // No script gives a loader a size or a stroke of its own.
    for (const path of readdirSync('src', { recursive: true, encoding: 'utf8' })) {
      if (!path.endsWith('.ts') || path.split(/[\\/]/u).includes('__tests__')) continue;
      const source = readFileSync(join('src', path), 'utf8');
      expect(source, path).not.toContain('--material-elastic-size');
      expect(source, path).not.toContain('--material-elastic-stroke');
    }
  });

  it('keeps the periods the app phases its loaders by equal to the sheets', () => {
    expect(
      declaration(STYLE, '.material-elastic-spinner .material-elastic-turn', 'animation'),
    ).toBe(`material-elastic-spin ${MATERIAL_ELASTIC_TURN_PERIOD_MS / 1000}s linear infinite`);
    expect(declaration(STYLE, '.material-elastic-spinner .material-elastic-arc', 'animation')).toBe(
      `material-elastic-arc ${MATERIAL_ELASTIC_ARC_PERIOD_MS / 1000}s ${STANDARD_CURVE} infinite both`,
    );
    // Whole ms, written exactly in seconds wherever a sheet or minifier puts them.
    expect(Number.isInteger(MATERIAL_ELASTIC_TURN_PERIOD_MS)).toBe(true);
    expect(Number.isInteger(MATERIAL_ELASTIC_ARC_PERIOD_MS / 4)).toBe(true);
  });

  it.each(SHEETS)('clips each half ring to its half of the frame, in $name', ({ css, root }) => {
    for (const side of ['tail', 'head']) {
      expect(declaration(css, `${root} .material-elastic-${side}`, 'overflow')).toBe('hidden');
      expect(declaration(css, `${root} .material-elastic-${side}`, 'width')).toMatch(
        /^(?:50%|12px)$/u,
      );
      // Each half ring is the whole loader's size, centred on the frame's centre.
      expect(
        declaration(css, `${root} .material-elastic-${side} > .material-elastic-ring`, 'width'),
      ).toMatch(/^(?:200%|24px)$/u);
    }
    expect(declaration(css, `${root} .material-elastic-tail`, 'left')).toBe('0');
    expect(declaration(css, `${root} .material-elastic-head`, 'left')).toMatch(/^(?:50%|12px)$/u);
    expect(
      declaration(css, `${root} .material-elastic-tail > .material-elastic-ring`, 'left'),
    ).toBe('0');
    expect(
      declaration(css, `${root} .material-elastic-head > .material-elastic-ring`, 'left'),
    ).toMatch(/^(?:-100%|-12px)$/u);
    // Each ring's drawing sits inside it at the ring's drawn size, by default
    // the whole box; the seam's likewise inside the frame. The splash draws the
    // default 24px loader in fixed lengths.
    const drawing =
      root === '.boot-splash-spinner'
        ? { size: '24px', offset: undefined }
        : {
            size: 'var(--material-elastic-ring-size, 100%)',
            offset: 'calc((100% - var(--material-elastic-ring-size, 100%)) / 2)',
          };
    for (const part of ['.material-elastic-ring > svg', '.material-elastic-seam']) {
      expect(declaration(css, `${root} ${part}`, 'width'), part).toBe(drawing.size);
      expect(declaration(css, `${root} ${part}`, 'height'), part).toBe(drawing.size);
      if (drawing.offset) {
        expect(declaration(css, `${root} ${part}`, 'left'), part).toBe(drawing.offset);
        expect(declaration(css, `${root} ${part}`, 'top'), part).toBe(drawing.offset);
      }
    }
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
    // A source that gives an element the loader's class, in markup or by className.
    const builders = sources
      .filter(([, source]) =>
        /class(?:Name)?\s*=\s*["'`][^"'`]*\bmaterial-elastic-spinner\b/u.test(source),
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

  it("keeps the seam patch inside the shortest arc, at the layer's 12 o'clock", () => {
    const document = new JSDOM(`<span>${MATERIAL_ELASTIC_SPINNER_PARTS}</span>`).window.document;
    const seam = document.querySelector('.material-elastic-seam path')?.getAttribute('d') ?? '';
    const point = (degrees: number) =>
      [22 + 18 * Math.cos((degrees * Math.PI) / 180), 22 + 18 * Math.sin((degrees * Math.PI) / 180)]
        .map((value) => value.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, ''))
        .join(' ');
    // 3.6 degrees each side of 12 o'clock (Google's gap patch covers about
    // 3.5 at this ring), inside the shortest arc's 5, so the halves' ink
    // always lies past both of its ends.
    const seamHalf = 3.6;
    expect(seam).toBe(`M${point(270 - seamHalf)}A18 18 0 0 1 ${point(270 + seamHalf)}`);
    expect(seamHalf).toBeLessThan(Math.min(...SWING.map(({ left }) => halfArc(left))));
  });

  it("draws each ring only where it can show, its hidden end well away from the halves' shared edge", () => {
    const document = new JSDOM(`<span>${MATERIAL_ELASTIC_SPINNER_PARTS}</span>`).window.document;
    // A clockwise arc of the r = 18 ring as drawn: its start and end angles
    // (degrees clockwise from 3 o'clock, in the ring's own unturned frame).
    const span = (side: 'tail' | 'head') => {
      const d =
        document
          .querySelector(`.material-elastic-${side} > .material-elastic-ring > svg > path`)
          ?.getAttribute('d') ?? '';
      // One move and one clockwise arc of radius 18, the arc absolute (A) or relative (a).
      const arc = d.match(
        /^M(-?[\d.]+)[ ,](-?[\d.]+)([Aa])18[ ,]18[ ,]0[ ,]0[ ,]1[ ,]?(-?[\d.]+)[ ,]?(-?[\d.]+)$/u,
      );
      expect(arc, `${side}: ${d}`).not.toBeNull();
      const [x0 = 0, y0 = 0, x = 0, y = 0] = [arc?.[1], arc?.[2], arc?.[4], arc?.[5]].map(Number);
      const [x1, y1] = arc?.[3] === 'a' ? [x0 + x, y0 + y] : [x, y];
      const angle = (px: number, py: number) =>
        ((((Math.atan2(py - 22, px - 22) * 180) / Math.PI) % 360) + 360) % 360;
      expect(Math.hypot(x0 - 22, y0 - 22), side).toBeCloseTo(18, 3);
      expect(Math.hypot(x1 - 22, y1 - 22), side).toBeCloseTo(18, 3);
      const start = angle(x0, y0);
      const end = angle(x1, y1) || 360;
      return { start, end: end < start ? end + 360 : end };
    };
    const tail = span('tail');
    const head = span('head');
    // Every half arc the loader shows: the swing's range and the still arc.
    const halves = [...SWING.map(({ left }) => halfArc(left)), STILL.half];
    const longest = Math.max(...halves);
    const shortestHalf = Math.min(...halves);
    // The tail ring turns by 270 - h and shows its first h degrees; the head
    // ring turns by h - 270 and shows its last h degrees. Google draws whole
    // half rings; their hidden ends come within 5 degrees of 6 o'clock at the
    // shortest arc, where 9.0.50 saw such an end show through as a speck.
    expect(tail.start).toBeCloseTo(0, 3);
    expect(head.end).toBeCloseTo(180, 3);
    expect(tail.end - tail.start).toBeGreaterThanOrEqual(longest + 10);
    expect(head.end - head.start).toBeGreaterThanOrEqual(longest + 10);
    // Where each ring's far end sits in the layer, for every half arc in range:
    // well away from 6 o'clock (90), where no ink covers the halves' shared
    // edge, and clear of 12 o'clock (270) by more than any snapping, though
    // the other ring's ink lies over it there.
    const distance = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
    for (let tenth = Math.round(shortestHalf * 10); tenth <= Math.round(longest * 10); tenth += 1) {
      const h = tenth / 10;
      for (const farEnd of [tail.end + 270 - h, head.start + h - 270]) {
        expect(distance(farEnd, 90), `far end ${farEnd} at h ${h}`).toBeGreaterThanOrEqual(30);
        // Near 12 o'clock only under the other ring's ink, 2 degrees inside it.
        const fromNoon = distance(farEnd, 270);
        expect(fromNoon >= 30 || fromNoon <= h - 2, `far end ${farEnd} at h ${h}`).toBe(true);
      }
    }
  });
});
