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
// after seeing the two side by side on Windows, and is drawn as the owner then
// proposed the same day: one still ring mask over two turning filled wedges.
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
// spinner layer, our tail and head its left and right circle clippers, each
// turning a wedge (.material-elastic-ring) where Google turns a half ring.
// The container turns once per 1568.2352941176 ms, kept here to the whole ms
// so the period reads the same wherever it is copied or parsed (a minifier
// writes the long one as 1.56824s); the layer steps 135 degrees eight times
// per 5332 ms, and the clippers' wedges swing every 1333 ms, four swings per
// layer cycle, so one phase serves the layer and both.
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

// The ring is one still mask image over the turning parts: the r = 18 circle
// of the 44 unit box at a host's stroke, drawn once at the ring's drawn size
// and never turned (a circle looks the same at every angle). Two ring pieces
// drawn and turned apart, Google's as ours, met a fraction of a device pixel
// apart at some sizes and scales, the smaller the worse; under one mask the
// ring's inner and outer edges are a single drawing, and the two wedges that
// turn inside it only decide where the arc starts and ends (the owner's idea,
// chosen in the spinner lab on 2026-11-16: clean at every size and scale, and
// smooth while the page is busy).
const ringMask = (stroke: string) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 44 44'%3E` +
  `%3Ccircle cx='22' cy='22' r='18' fill='none' stroke='black' stroke-width='${stroke}'/%3E%3C/svg%3E")`;
/** The stroke, in viewBox units, of a value that must be a ring mask. */
function maskStroke(mask: string | undefined): string {
  const stroke = mask?.match(/stroke-width='(\d+(?:\.\d+)?)'/u)?.[1] ?? '';
  expect(mask, 'a ring mask').toBe(ringMask(stroke));
  return stroke;
}

// Each wedge: a move to the ring's centre, a line out along its first side, a
// clockwise arc of one radius, and back. Its angles in degrees clockwise from
// 3 o'clock, in the ring's own unturned frame.
function wedge(side: 'tail' | 'head') {
  const document = new JSDOM(`<span>${MATERIAL_ELASTIC_SPINNER_PARTS}</span>`).window.document;
  const d =
    document
      .querySelector(`.material-elastic-${side} > .material-elastic-ring > svg > path`)
      ?.getAttribute('d') ?? '';
  const match = d.match(/^M22 22L(-?[\d.]+) (-?[\d.]+)A([\d.]+) \3 0 0 1 (-?[\d.]+) (-?[\d.]+)Z$/u);
  expect(match, `${side}: ${d}`).not.toBeNull();
  const [x0 = 0, y0 = 0, radius = 0, x1 = 0, y1 = 0] = [
    match?.[1],
    match?.[2],
    match?.[3],
    match?.[4],
    match?.[5],
  ].map(Number);
  expect(Math.hypot(x0 - 22, y0 - 22), side).toBeCloseTo(radius, 3);
  expect(Math.hypot(x1 - 22, y1 - 22), side).toBeCloseTo(radius, 3);
  const angle = (px: number, py: number) =>
    ((((Math.atan2(py - 22, px - 22) * 180) / Math.PI) % 360) + 360) % 360;
  const start = angle(x0, y0);
  const end = angle(x1, y1) || 360;
  return { start, end: end < start ? end + 360 : end, radius };
}

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
    'draws the ring once, as a still mask over the turning wedges, in $name',
    ({ css, root }) => {
      // On the loader itself, which never turns, in the prefixed form older
      // Chromium and WebKit read and the standard one.
      const both = (property: string) => [
        declaration(css, root, `-webkit-${property}`),
        declaration(css, root, property),
      ];
      if (root === '.boot-splash-spinner') {
        // The app's default 24px loader in fixed lengths, at the bottom of the
        // splash loader's 48px box.
        const mask = declaration(STYLE, '.material-elastic-spinner', '--material-elastic-mask');
        expect(both('mask-image')).toEqual([mask, mask]);
        expect(both('mask-size')).toEqual(['24px 24px', '24px 24px']);
        expect(both('mask-position')).toEqual(['center bottom', 'center bottom']);
      } else {
        // Each host's ring, at the ring's drawn size, centred in the box.
        expect(both('mask-image')).toEqual(Array(2).fill('var(--material-elastic-mask)'));
        expect(both('mask-size')).toEqual(
          Array(2).fill(
            'var(--material-elastic-ring-size, 100%) var(--material-elastic-ring-size, 100%)',
          ),
        );
        expect(both('mask-position')).toEqual(['center', 'center']);
        expect(maskStroke(declaration(css, root, '--material-elastic-mask'))).toBe('4.75');
      }
      expect(both('mask-repeat')).toEqual(['no-repeat', 'no-repeat']);
      // Nothing inside it carries a mask of its own: what turns only fills.
      for (const rule of rules(css)) {
        if (!rule.selectors.some((selector) => selector.startsWith(`${root} `))) continue;
        expect(rule.declarations, rule.selectors.join(', ')).not.toMatch(
          /(?:^|[\s;])(?:-webkit-)?mask/u,
        );
      }
      expect(declaration(css, `${root} path`, 'fill')).toBe('currentColor');
      expect(declaration(css, `${root} path`, 'stroke')).toBe('none');
    },
  );

  it('draws every ring mask as one well-formed SVG circle', () => {
    const data = ringMask('4.75').slice('url("data:image/svg+xml,'.length, -'")'.length);
    const svg = new JSDOM(decodeURIComponent(data), { contentType: 'image/svg+xml' }).window
      .document.documentElement;
    expect(svg.localName).toBe('svg');
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 44 44');
    expect(
      [...svg.children].map((child) => [
        child.localName,
        ...['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width'].map((name) =>
          child.getAttribute(name),
        ),
      ]),
    ).toEqual([['circle', '22', '22', '18', 'none', 'black', '4.75']]);
    // Nothing a CSS string or a data URL would end early on.
    expect(data).not.toMatch(/["#;<>]/u);
  });

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
    // Each host's stroke lives in its ring mask alone: the app's default, the
    // current row's, the upload row's, and the public pages' default and large.
    const masks = files.flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(/--material-elastic-mask:\s*([^;]+);/gu)].map(
        ([, value]) => [path, value!.trim()] as const,
      ),
    );
    expect(masks.map(([path, mask]) => `${path} ${maskStroke(mask)}`).sort()).toEqual([
      `${join('css', 'style.css')} 4.75`,
      `${join('css', 'style.css')} 5.516`,
      `${join('css', 'style.css')} 6.545`,
      `${join('public', 'editorial-design.css')} 4.25`,
      `${join('public', 'editorial-design.css')} 4.75`,
    ]);
    expect(declared('--material-elastic-stroke')).toEqual([]);
    // No script gives a loader a size or a ring of its own.
    for (const path of readdirSync('src', { recursive: true, encoding: 'utf8' })) {
      if (!path.endsWith('.ts') || path.split(/[\\/]/u).includes('__tests__')) continue;
      const source = readFileSync(join('src', path), 'utf8');
      expect(source, path).not.toContain('--material-elastic-size');
      expect(source, path).not.toContain('--material-elastic-mask');
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

  it.each(SHEETS)(
    'clips each wedge to its half of the frame, each half reaching 1px past its middle, in $name',
    ({ css, root }) => {
      // Each half reaches 1px past the frame's middle, so both wedges' ink
      // covers the line where the halves meet (always inside the arc, at its
      // middle): two edges each drawn soft there let the background through
      // as a faint line. The splash draws the default 24px loader in fixed
      // lengths.
      const splash = root === '.boot-splash-spinner';
      const box = splash ? '24px' : 'var(--material-elastic-size)';
      for (const side of ['tail', 'head']) {
        const half = `${root} .material-elastic-${side}`;
        expect(declaration(css, half, 'overflow')).toBe('hidden');
        expect(declaration(css, half, 'width')).toBe(splash ? '13px' : 'calc(50% + 1px)');
        // Each wedge turns in a box of the whole loader's size and place.
        expect(declaration(css, `${half} > .material-elastic-ring`, 'width')).toBe(box);
        expect(declaration(css, `${half} > .material-elastic-ring`, 'height')).toBe(box);
      }
      expect(declaration(css, `${root} .material-elastic-tail`, 'left')).toBe('0');
      expect(declaration(css, `${root} .material-elastic-head`, 'left')).toBe(
        splash ? '11px' : 'calc(50% - 1px)',
      );
      expect(
        declaration(css, `${root} .material-elastic-tail > .material-elastic-ring`, 'left'),
      ).toBe('0');
      expect(
        declaration(css, `${root} .material-elastic-head > .material-elastic-ring`, 'left'),
      ).toBe(splash ? '-11px' : 'calc(1px - var(--material-elastic-size) / 2)');
      // Each wedge's drawing fills the box that turns it: its straight sides
      // run from the ring's centre, so their angles hold at any drawn size.
      for (const property of ['width', 'height']) {
        expect(declaration(css, `${root} .material-elastic-ring > svg`, property)).toBe(
          splash ? '24px' : '100%',
        );
      }
      // Google's gap patch over that line is no longer needed.
      expect(css).not.toContain('material-elastic-seam');
    },
  );

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

  it('draws each wedge from the ring centre out past the drawing, so the mask alone draws its edges', () => {
    // The round side lies beyond the 44 unit box's corners, so inside the
    // drawing a wedge ends only at its two straight sides: the arc's ends.
    for (const side of ['tail', 'head'] as const) {
      expect(wedge(side).radius, side).toBeGreaterThan(Math.hypot(22, 22));
      expect(wedge(side).end - wedge(side).start, side).toBeLessThan(180);
    }
  });

  it("draws each wedge only where it can show, its hidden side well away from the halves' shared edge", () => {
    const tail = wedge('tail');
    const head = wedge('head');
    // Every half arc the loader shows: the swing's range and the still arc.
    const halves = [...SWING.map(({ left }) => halfArc(left)), STILL.half];
    const longest = Math.max(...halves);
    const shortestHalf = Math.min(...halves);
    // The tail wedge turns by 270 - h and shows its first h degrees; the head
    // wedge turns by h - 270 and shows its last h degrees. Google draws whole
    // half rings; their hidden ends come within 5 degrees of 6 o'clock at the
    // shortest arc, where 9.0.50 saw such an end show through as a speck.
    expect(tail.start).toBeCloseTo(0, 3);
    expect(head.end).toBeCloseTo(180, 3);
    expect(tail.end - tail.start).toBeGreaterThanOrEqual(longest + 10);
    expect(head.end - head.start).toBeGreaterThanOrEqual(longest + 10);
    // Each half reaches 1px past the frame's middle. At the smallest ring's
    // inner edge (the current row's ring, drawn at 13.444px with a 6.545
    // stroke) that 1px spans under 13 degrees.
    const row = '.track-type-slot.playlist-current-leading .track-playback-loading-indicator';
    const drawn = Number.parseFloat(declaration(STYLE, row, '--material-elastic-ring-size') ?? '');
    const stroke = Number(maskStroke(declaration(STYLE, row, '--material-elastic-mask')));
    const reach = (Math.asin(1 / (((18 - stroke / 2) * drawn) / 44)) * 180) / Math.PI;
    expect(reach).toBeLessThan(13);
    // Where each wedge's hidden side sits in the layer, for every half arc in
    // range: well past that reach from 6 o'clock (90), where no ink covers the
    // halves' shared edge, and from 12 o'clock (270) unless the other wedge's
    // ink lies over it there.
    const distance = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
    for (let tenth = Math.round(shortestHalf * 10); tenth <= Math.round(longest * 10); tenth += 1) {
      const h = tenth / 10;
      for (const farEnd of [tail.end + 270 - h, head.start + h - 270]) {
        expect(distance(farEnd, 90), `far side ${farEnd} at h ${h}`).toBeGreaterThanOrEqual(30);
        // Near 12 o'clock only under the other wedge's ink, 2 degrees inside it.
        const fromNoon = distance(farEnd, 270);
        expect(fromNoon >= 30 || fromNoon <= h - 2, `far side ${farEnd} at h ${h}`).toBe(true);
      }
    }
  });
});
