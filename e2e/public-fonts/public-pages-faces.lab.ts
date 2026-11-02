/**
 * The pages outside the app draw their text with the app's faces, as the
 * shared sheets (/web-fonts/first.css and rest.css) and the app's stacks
 * (/web-fonts/stacks.css) say, in a production build (plan §6 items 4 and 5
 * of the public-page font train; opt-in, never in the default suite).
 *
 * For About in eleven languages, the blog, history, events in Korean, 404
 * and the sign-in completion page in Korean, each visible grapheme is copied
 * into a hidden probe with its element's computed font properties, and
 * CSS.getPlatformFontsForNode reads the face Chromium draws it with:
 * - the face is the first family of the element's stack whose declared
 *   unicode-range holds the grapheme (a face of the shared sheets, so a
 *   missing sheet or file shows as a device face); where no declared family
 *   holds it, or a device family comes first (the Google label), a device
 *   face;
 * - the app's rules hold: Latin, Cyrillic, Greek and digits Inter; Hangul
 *   MUSIXQUARE Hangul, or Noto Sans KR where that family lacks it; kana
 *   Noto Sans JP; Han Noto Sans KR in a browser that lists English only, or
 *   the page's own family on the Japanese and Chinese copies; Thai, Arabic,
 *   Hebrew and Devanagari their Noto family. Code is skipped (device
 *   monospace);
 * - the sign-in completion page (the app's) draws with device faces only;
 * - the shared sheets and /han-order.js are requested once each (events: no
 *   rest.css; the sign-in completion page: none), no face is in error,
 *   nothing retired is requested, and nothing is wider than a 390 px phone;
 * - the Korean and English About pages draw one mixed line pixel for pixel
 *   alike, as the app does since 9.0.29.
 */
import { writeFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import {
  PUBLIC_FONT_SHEET_URLS,
  PUBLIC_HAN_ORDER_SCRIPT_URL,
} from '../../src/i18n/public-font-urls.ts';
import { isBenignPageError } from '../helpers/page-errors.ts';
import {
  HANGUL_FAMILY_CODE_POINTS,
  isFamily,
  platformFaces,
  RETIRED_FONT_REQUEST,
} from './faces.ts';

interface FacePage {
  readonly name: string;
  readonly path: string;
  readonly locale: string;
  /** The family Han draws with on this page. */
  readonly han: string;
  /** How the page loads the shared sheets. */
  readonly sheets: 'all' | 'no-rest' | 'none';
}

const ABOUT_LANGUAGES: readonly (readonly [code: string, han: string])[] = [
  ['en', 'Noto Sans KR'],
  ['ko', 'Noto Sans KR'],
  ['ja', 'Noto Sans JP'],
  ['zh-hans', 'Noto Sans SC'],
  ['zh-hant', 'Noto Sans TC'],
  ['th', 'Noto Sans KR'],
  ['ar', 'Noto Sans KR'],
  ['he', 'Noto Sans KR'],
  ['hi', 'Noto Sans KR'],
  ['ru', 'Noto Sans KR'],
  ['el', 'Noto Sans KR'],
];

const PAGES: readonly FacePage[] = [
  ...ABOUT_LANGUAGES.map(([code, han]) => ({
    name: `About (${code})`,
    path: code === 'en' ? '/about.html' : `/${code}/about.html`,
    locale: 'en-US',
    han,
    sheets: 'all' as const,
  })),
  { name: 'blog', path: '/blog/index.html', locale: 'en-US', han: 'Noto Sans KR', sheets: 'all' },
  {
    name: 'history',
    path: '/history/index.html',
    locale: 'en-US',
    han: 'Noto Sans KR',
    sheets: 'all',
  },
  {
    name: 'events (ko)',
    path: '/events/index.html',
    locale: 'ko-KR',
    han: 'Noto Sans KR',
    sheets: 'no-rest',
  },
  { name: '404', path: '/404.html', locale: 'en-US', han: 'Noto Sans KR', sheets: 'all' },
  {
    name: 'sign-in completion (ko)',
    path: '/account-complete.html?accountClient=lab-0001',
    locale: 'ko-KR',
    han: 'Noto Sans KR',
    sheets: 'none',
  },
];

/** Each family the shared sheets declare, with the code point ranges of its faces. */
type DeclaredFaces = ReadonlyMap<string, readonly (readonly [number, number])[]>;

function parseRange(token: string): [number, number] {
  const value = token.trim().replace(/^U\+/iu, '');
  if (value.includes('?')) {
    return [
      Number.parseInt(value.replaceAll('?', '0'), 16),
      Number.parseInt(value.replaceAll('?', 'F'), 16),
    ];
  }
  const [start = '', end] = value.split('-');
  return [Number.parseInt(start, 16), Number.parseInt(end ?? start, 16)];
}

async function declaredFaces(page: Page): Promise<DeclaredFaces> {
  const faces = new Map<string, [number, number][]>();
  for (const url of [PUBLIC_FONT_SHEET_URLS.first, PUBLIC_FONT_SHEET_URLS.rest]) {
    const response = await page.request.get(url);
    expect(response.status(), url).toBe(200);
    for (const [, body = ''] of (await response.text()).matchAll(/@font-face\s*\{([^}]*)\}/gu)) {
      const family = /font-family:\s*(['"]?)([^;'"]+)\1/u.exec(body)?.[2]?.trim();
      if (!family) continue;
      const range = /unicode-range:\s*([^;}]+)/u.exec(body)?.[1];
      const ranges = range ? range.split(',').map(parseRange) : [[0, 0x10ffff] as [number, number]];
      faces.set(family, [...(faces.get(family) ?? []), ...ranges]);
    }
  }
  return faces;
}

/** Code points no face needs: joiners, variation selectors and the like. */
const IGNORABLE = /[\u200b-\u200f\u2060\ufe00-\ufe0f]/u;

/** The families of the app's faces, declared by the shared sheets. */
const APP_FAMILY = /^(?:Inter|MUSIXQUARE Hangul|Noto Sans [A-Za-z ]+)$/u;

/** The first declared family of `stack` that holds every code point of `grapheme`. */
function stackFamily(
  stack: readonly string[],
  grapheme: string,
  declared: DeclaredFaces,
): { family: string | null; deviceFirst: boolean } {
  const codePoints = [...grapheme]
    .filter((character) => !IGNORABLE.test(character))
    .map((character) => character.codePointAt(0) ?? 0);
  // A device family before the app's families (the Google label) may draw
  // the grapheme; the system tail after them only takes what no app face holds.
  const firstApp = stack.findIndex((family) => APP_FAMILY.test(family));
  const deviceFirst = stack.findIndex((family) => !APP_FAMILY.test(family)) < firstApp;
  for (const family of stack) {
    // An app family the sheets do not declare is a missing face.
    const ranges = declared.get(family);
    if (!ranges) continue;
    if (codePoints.every((at) => ranges.some(([start, end]) => at >= start && at <= end))) {
      return { family, deviceFirst };
    }
  }
  return { family: null, deviceFirst };
}

/** The family the app's rules give a grapheme, or null where they leave it to the stack. */
function ruleFamily(grapheme: string, han: string): string | null {
  if (/^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}0-9]+$/u.test(grapheme)) return 'Inter';
  if (/\p{Script=Hangul}/u.test(grapheme)) {
    return [...grapheme].every((character) =>
      HANGUL_FAMILY_CODE_POINTS.has(character.codePointAt(0) ?? 0),
    )
      ? 'MUSIXQUARE Hangul'
      : 'Noto Sans KR';
  }
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(grapheme)) return 'Noto Sans JP';
  if (/^\p{Script=Han}+$/u.test(grapheme)) return han;
  if (/\p{Script=Thai}/u.test(grapheme)) return 'Noto Sans Thai';
  if (/\p{Script=Arabic}/u.test(grapheme)) return 'Noto Sans Arabic';
  if (/\p{Script=Hebrew}/u.test(grapheme)) return 'Noto Sans Hebrew';
  if (/\p{Script=Devanagari}/u.test(grapheme)) return 'Noto Sans Devanagari';
  return null;
}

interface Probe {
  readonly grapheme: string;
  readonly stack: string[];
  readonly where: string;
}

/**
 * One hidden probe per distinct visible grapheme and font: a copy of the
 * grapheme beside its text, with the element's computed font properties.
 */
async function addProbes(page: Page): Promise<Probe[]> {
  return page.evaluate(() => {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const properties = [
      'font-family',
      'font-weight',
      'font-style',
      'font-size',
      'font-stretch',
      'font-feature-settings',
      'font-variant-ligatures',
      'font-variant-east-asian',
      'font-optical-sizing',
      'font-variation-settings',
    ];
    const skip = 'script, style, noscript, template, code, pre, kbd, samp, svg';
    const seen = new Set<string>();
    const probes: { grapheme: string; stack: string[]; where: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const text of texts) {
      const element = text.parentElement;
      if (!element || element.closest(skip) || element.dataset.faceProbe !== undefined) continue;
      const style = getComputedStyle(element);
      if (style.visibility !== 'visible' || element.getClientRects().length === 0) continue;
      for (const { segment } of segmenter.segment(text.data)) {
        if (!segment.trim()) continue;
        const key = [
          segment,
          style.fontFamily,
          style.fontWeight,
          style.fontStyle,
          element.closest('[lang]')?.getAttribute('lang') ?? '',
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const probe = document.createElement('span');
        probe.dataset.faceProbe = '';
        for (const property of properties) {
          probe.style.setProperty(property, style.getPropertyValue(property));
        }
        probe.style.cssText +=
          ';position:absolute;left:0;top:0;visibility:hidden;white-space:pre;pointer-events:none;display:inline-block;';
        probe.textContent = segment;
        element.append(probe);
        probes.push({
          grapheme: segment,
          stack: style.fontFamily
            .split(',')
            .map((family) => family.trim().replace(/^(['"])(.*)\1$/u, '$2')),
          where: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(/\s+/u).join('.')}` : ''}`,
        });
      }
    }
    return probes;
  });
}

interface Opened {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly paths: string[];
  readonly problems: string[];
}

async function open(
  browser: Browser,
  baseURL: string,
  path: string,
  locale: string,
): Promise<Opened> {
  const origin = new URL(baseURL).origin;
  const context = await browser.newContext({
    baseURL,
    locale,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  });
  await context.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );
  const page = await context.newPage();
  const paths: string[] = [];
  const problems: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) paths.push(url.pathname);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400 && !url.pathname.startsWith('/api/')) {
      problems.push(`${response.status()} ${url.pathname}`);
    }
  });
  page.on('pageerror', (error) => {
    if (!isBenignPageError(error)) problems.push(`page error: ${error.message}`);
  });
  await page.goto(path);
  await expect
    .poll(
      () =>
        page.evaluate(() => [...document.fonts].filter((face) => face.status === 'loading').length),
      { timeout: 30_000 },
    )
    .toBe(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return { context, page, paths, problems };
}

for (const facePage of PAGES) {
  test(`${facePage.name} draws its text with the app's faces`, async ({
    browser,
    baseURL,
  }, testInfo) => {
    const { context, page, paths, problems } = await open(
      browser,
      baseURL ?? '',
      facePage.path,
      facePage.locale,
    );
    try {
      const declared = await declaredFaces(page);
      const probes = await addProbes(page);
      expect(probes.length, 'graphemes to read').toBeGreaterThan(10);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const drawn = await platformFaces(page, '[data-face-probe]');
      expect(drawn).toHaveLength(probes.length);
      const breaks: string[] = [];
      const counts: Record<string, number> = {};
      const device: string[] = [];
      for (const [index, { grapheme, stack, where }] of probes.entries()) {
        const faces = drawn[index] ?? [];
        const names = faces
          .map(({ familyName, isCustomFont }) =>
            isCustomFont ? familyName : `${familyName} (device)`,
          )
          .join(', ');
        const { family, deviceFirst } = stackFamily(stack, grapheme, declared);
        const rule = ruleFamily(grapheme, facePage.han);
        if (facePage.sheets === 'none') {
          if (faces.some(({ isCustomFont }) => isCustomFont)) {
            breaks.push(`${where} '${grapheme}' should be a device face: ${names}`);
          }
          continue;
        }
        if (rule !== null && !deviceFirst && family !== rule) {
          breaks.push(`${where} '${grapheme}': the stack gives ${family}, the app's rule ${rule}`);
          continue;
        }
        const [face] = faces;
        if (family !== null && faces.length === 1 && isFamily(face, family)) {
          counts[family] = (counts[family] ?? 0) + 1;
          continue;
        }
        if ((family === null || deviceFirst) && faces.every(({ isCustomFont }) => !isCustomFont)) {
          device.push(`${grapheme} U+${(grapheme.codePointAt(0) ?? 0).toString(16)} ${names}`);
          continue;
        }
        breaks.push(`${where} '${grapheme}' should be ${family ?? 'a device face'}: ${names}`);
      }
      const summary = testInfo.outputPath('faces.json');
      writeFileSync(summary, JSON.stringify({ page: facePage.path, counts, device }, null, 1));
      await testInfo.attach('faces', { path: summary, contentType: 'application/json' });
      expect(breaks).toEqual([]);

      // The network.
      const count = (url: string) => paths.filter((path) => path === url).length;
      const expectedCounts =
        facePage.sheets === 'none'
          ? { first: 0, stacks: 0, rest: 0, marker: 0 }
          : {
              first: 1,
              stacks: 1,
              rest: facePage.sheets === 'all' ? 1 : 0,
              marker: 1,
            };
      expect({
        first: count(PUBLIC_FONT_SHEET_URLS.first),
        stacks: count(PUBLIC_FONT_SHEET_URLS.stacks),
        rest: count(PUBLIC_FONT_SHEET_URLS.rest),
        marker: count(PUBLIC_HAN_ORDER_SCRIPT_URL),
      }).toEqual(expectedCounts);
      if (facePage.sheets === 'none') {
        expect(paths.filter((path) => path.endsWith('.woff2'))).toEqual([]);
      }
      expect(paths.filter((path) => RETIRED_FONT_REQUEST.test(path))).toEqual([]);
      expect(
        await page.evaluate(() =>
          [...document.fonts].filter((face) => face.status === 'error').map((face) => face.family),
        ),
      ).toEqual([]);
      expect(problems).toEqual([]);

      // Nothing wider than a phone.
      await page.evaluate(() => {
        for (const probe of document.querySelectorAll('[data-face-probe]')) probe.remove();
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
        'horizontal overflow at 390 px',
      ).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });
}

test('the Korean and English About pages draw a mixed line alike', async ({
  browser,
  baseURL,
}, testInfo) => {
  const line = 'Ag 한글 漢字 かな 0123 Жж Ωω';
  const pictures: Buffer[] = [];
  for (const path of ['/about.html', '/ko/about.html']) {
    const { context, page } = await open(browser, baseURL ?? '', path, 'en-US');
    try {
      await page.evaluate((text) => {
        const probe = document.createElement('div');
        probe.id = 'face-alike-probe';
        probe.textContent = text;
        probe.style.cssText =
          'position:fixed;left:0;top:0;z-index:2147483647;box-sizing:border-box;width:480px;height:52px;padding:8px;background:#fff;color:#000;font:400 24px/1.5 var(--font-sans);letter-spacing:0;white-space:nowrap;';
        document.body.append(probe);
      }, line);
      // Load every face the line needs before the picture.
      await page.evaluate(async (text) => {
        const probe = document.getElementById('face-alike-probe');
        if (!probe) throw new Error('no probe');
        await document.fonts.load(`400 24px ${getComputedStyle(probe).fontFamily}`, text);
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, line);
      pictures.push(
        await page
          .locator('#face-alike-probe')
          .screenshot({ animations: 'disabled', caret: 'hide' }),
      );
    } finally {
      await context.close();
    }
  }
  const [english, korean] = pictures;
  if (!english?.equals(korean ?? Buffer.alloc(0))) {
    for (const [name, picture] of [
      ['english', english],
      ['korean', korean],
    ] as const) {
      const file = testInfo.outputPath(`${name}.png`);
      writeFileSync(file, picture ?? Buffer.alloc(0));
      await testInfo.attach(name, { path: file, contentType: 'image/png' });
    }
  }
  expect(english?.equals(korean ?? Buffer.alloc(0))).toBe(true);
});
