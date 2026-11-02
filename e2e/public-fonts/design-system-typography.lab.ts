/**
 * The design system's Typography section (public/designsystem/index.html
 * #typography) draws every specimen with the face its label names, from the
 * app's own faces (/web-fonts/first.css and rest.css) and stacks
 * (/web-fonts/stacks.css). At 1440, 768, 390 and 360 px wide, device pixel
 * ratio 1, in a browser that lists English only:
 * - each specimen grapheme is drawn by exactly one self-hosted face: the
 *   labelled one for the Scripts runs, the four 述 cells, the Han marker rows
 *   and the Faces rows; the app's rules for the unlabelled blocks (Latin and
 *   digits Inter, Hangul MUSIXQUARE Hangul or Noto Sans KR where that family
 *   lacks it, unmarked Han Noto Sans KR, kana Noto Sans JP). The faces come
 *   from CSS.getPlatformFontsForNode on a hidden copy of each grapheme with
 *   the element's computed font properties;
 * - the four 述 cells draw four different pictures;
 * - the printed line heights, leading pitches and the optical size ratio are
 *   what the browser lays out;
 * - the samples share one left edge, and nothing is wider than the viewport;
 * - each Leading rule paints one crisp pixel row, directly under its line's
 *   glyphs on the first line;
 * - the network: the shared sheets and the Han order script once each, every
 *   face file 2xx and declared by the shared sheets, nothing of Pretendard,
 *   /css/fonts/ or /designsystem/fonts/.
 * Pictures of the section at 1440 and 390 px go to the test's output folder.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';

import {
  PUBLIC_FONT_SHEET_URLS,
  PUBLIC_HAN_ORDER_SCRIPT_URL,
} from '../../src/i18n/public-font-urls.ts';
import { isBenignPageError } from '../helpers/page-errors.ts';

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 360, height: 740 },
] as const;

/** Viewport widths whose whole section is saved as a picture. */
const PICTURE_WIDTHS: ReadonlySet<number> = new Set([1440, 390]);

/** The width at and below which the section's phone layout applies. */
const PHONE_MAX_WIDTH = 720;

/** The width below which the Han rows stack their face under the sample. */
const STACKED_HAN_MAX_WIDTH = 1023;

const RETIRED_FONT_REQUEST = /pretendard|\/css\/fonts\/|\/designsystem\/fonts\//iu;

/** The code points MUSIXQUARE Hangul draws (fonts/hangul-faces.json). */
const HANGUL_FAMILY_CODE_POINTS: ReadonlySet<number> = (() => {
  const record = JSON.parse(
    readFileSync(new URL('../../fonts/hangul-faces.json', import.meta.url), 'utf8'),
  ) as { faces: { unicodeRange: string }[] };
  const codePoints = new Set<number>();
  for (const { unicodeRange } of record.faces) {
    for (const token of unicodeRange.split(',')) {
      const [start = '', end] = token.trim().slice(2).split('-');
      for (let at = Number.parseInt(start, 16); at <= Number.parseInt(end ?? start, 16); at += 1) {
        codePoints.add(at);
      }
    }
  }
  return codePoints;
})();

/** The Indic families the Faces row names together as "Indic". */
const INDIC =
  /^Noto Sans (?:Devanagari|Bengali|Tamil|Telugu|Gujarati|Kannada|Malayalam|Gurmukhi)$/u;

/**
 * The family the app's rules give a grapheme of text with no label, in a
 * browser that lists no Japanese or Chinese (Han is Korean first). `han`
 * replaces the Han family where the text is marked Japanese or Chinese.
 */
function ruleFamily(grapheme: string, han = 'Noto Sans KR'): string | null {
  if (!grapheme.trim()) return null;
  if (/\p{Script=Hangul}/u.test(grapheme)) {
    return [...grapheme].every((character) =>
      HANGUL_FAMILY_CODE_POINTS.has(character.codePointAt(0) ?? 0),
    )
      ? 'MUSIXQUARE Hangul'
      : 'Noto Sans KR';
  }
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(grapheme)) return 'Noto Sans JP';
  if (/\p{Script=Han}/u.test(grapheme)) return han;
  if (/\p{Script=Thai}/u.test(grapheme)) return 'Noto Sans Thai';
  if (/\p{Script=Arabic}/u.test(grapheme)) return 'Noto Sans Arabic';
  if (/\p{Script=Hebrew}/u.test(grapheme)) return 'Noto Sans Hebrew';
  if (/\p{Script=Devanagari}/u.test(grapheme)) return 'Noto Sans Devanagari';
  return 'Inter';
}

interface Specimen {
  readonly key: string;
  readonly text: string;
  /** Per grapheme, the family it must be drawn with, or null to skip it (spaces). */
  readonly expected: readonly (string | null)[];
}

interface Drawn {
  readonly key: string;
  readonly grapheme: string;
  readonly faces: readonly { familyName: string; isCustomFont: boolean }[];
}

/**
 * Every specimen of the section with its expected family per grapheme, from
 * the page's own labels where it has them. Marks each element with
 * data-typo-target.
 */
async function readSpecimens(page: Page): Promise<Specimen[]> {
  const raw = await page.evaluate(() => {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const graphemes = (text: string) => [...segmenter.segment(text)].map(({ segment }) => segment);
    const label = (element: Element | null | undefined) =>
      (element?.textContent ?? '').replace(/\s+/gu, ' ').trim();
    const section = document.querySelector('#typography');
    if (!section) throw new Error('no Typography section');
    const list: {
      key: string;
      text: string;
      graphemes: string[];
      label: string | null;
      kind: 'labelled' | 'han-row' | 'face-row' | 'rule';
      hanLabel: string | null;
    }[] = [];
    let index = 0;
    const add = (
      element: HTMLElement,
      kind: (typeof list)[number]['kind'],
      labelText: string | null,
      hanLabel: string | null = null,
    ) => {
      const key = `t${index++}`;
      element.dataset.typoTarget = key;
      const text = element.textContent ?? '';
      list.push({ key, text, graphemes: graphemes(text), label: labelText, kind, hanLabel });
    };
    for (const run of section.querySelectorAll<HTMLElement>('.typo-run')) {
      const text = run.querySelector<HTMLElement>('.typo-run-text');
      if (text) add(text, 'labelled', label(run.querySelector('.typo-run-face')));
    }
    for (const cell of section.querySelectorAll<HTMLElement>('.typo-han-forms > li')) {
      const glyph = cell.querySelector<HTMLElement>('.typo-han-glyph');
      if (glyph) add(glyph, 'labelled', label(cell.querySelector('.typo-label')));
    }
    for (const row of section.querySelectorAll<HTMLElement>('.typo-han-row')) {
      const sample = row.querySelector<HTMLElement>('.typo-han-sample');
      if (sample) add(sample, 'han-row', null, label(row.querySelector('.typo-han-face')));
    }
    for (const row of section.querySelectorAll<HTMLElement>('.typo-face')) {
      const glyph = row.querySelector<HTMLElement>('.typo-face-glyph');
      if (glyph) add(glyph, 'face-row', label(row.querySelector('.typo-face-name')));
    }
    for (const element of section.querySelectorAll<HTMLElement>(
      [
        '.typo-box-line',
        '.typo-track-word',
        '.typo-scale .spec > :not(.tag)',
        '.typo-lead-sample',
        '.weight-row .gl',
      ].join(', '),
    )) {
      add(element, 'rule', null);
    }
    return list;
  });
  const specimens: Specimen[] = [];
  for (const entry of raw) {
    const expected = entry.graphemes.map((grapheme): string | null => {
      if (!grapheme.trim()) return null;
      switch (entry.kind) {
        case 'labelled':
          return entry.label;
        case 'han-row':
          return ruleFamily(grapheme, entry.hanLabel ?? '');
        case 'face-row':
        case 'rule':
          return ruleFamily(grapheme);
      }
    });
    if (entry.kind === 'face-row') {
      // The row's name says which families draw its glyphs.
      for (const family of expected) {
        if (family === null) continue;
        const word = INDIC.test(family) ? 'Indic' : family.replace(/^Noto Sans /u, '');
        expect(entry.label, `${entry.text}: ${family}`).toContain(word);
      }
    }
    specimens.push({ key: entry.key, text: entry.text, expected });
  }
  return specimens;
}

/**
 * The faces of every grapheme of every [data-typo-target] element: a hidden
 * copy of each grapheme beside the element, with its computed font
 * properties and language, read with CSS.getPlatformFontsForNode.
 */
async function readFaces(page: Page): Promise<Drawn[]> {
  const order = await page.evaluate(() => {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const properties = [
      'font-family',
      'font-weight',
      'font-style',
      'font-size',
      'font-stretch',
      'font-feature-settings',
      'font-variant-ligatures',
      'font-variant-numeric',
      'font-variant-east-asian',
      'font-kerning',
      'font-optical-sizing',
      'font-variation-settings',
      'letter-spacing',
    ];
    const list: { key: string; grapheme: string }[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('[data-typo-target]')) {
      const key = element.dataset.typoTarget ?? '';
      const style = getComputedStyle(element);
      const probe = document.createElement('span');
      probe.dataset.typoProbe = key;
      const lang = element.closest('[lang]')?.getAttribute('lang');
      if (lang) probe.lang = lang;
      for (const property of properties) {
        probe.style.setProperty(property, style.getPropertyValue(property));
      }
      probe.style.cssText +=
        ';position:absolute;left:0;top:0;visibility:hidden;white-space:pre;pointer-events:none;';
      for (const { segment } of segmenter.segment(element.textContent ?? '')) {
        // Its own inline-block, so no shaping crosses graphemes.
        const span = document.createElement('span');
        span.style.display = 'inline-block';
        span.textContent = segment;
        probe.append(span);
        list.push({ key, grapheme: segment });
      }
      element.parentElement?.append(probe);
    }
    return list;
  });
  const drawn: Drawn[] = [];
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: '[data-typo-probe] > span',
    });
    expect(nodeIds.length, 'one probe per grapheme').toBe(order.length);
    for (const [index, nodeId] of nodeIds.entries()) {
      const entry = order[index];
      if (!entry) continue;
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      drawn.push({
        key: entry.key,
        grapheme: entry.grapheme,
        faces: fonts.map(({ familyName, isCustomFont }) => ({ familyName, isCustomFont })),
      });
    }
  } finally {
    await cdp.detach().catch(() => undefined);
    await page.evaluate(() => {
      for (const probe of document.querySelectorAll('[data-typo-probe]')) probe.remove();
    });
  }
  return drawn;
}

/** Specimen graphemes not drawn by exactly their one expected self-hosted face. */
function faceBreaks(specimens: readonly Specimen[], drawn: readonly Drawn[]): string[] {
  const breaks: string[] = [];
  for (const specimen of specimens) {
    const graphemes = drawn.filter(({ key }) => key === specimen.key);
    expect(graphemes.length, specimen.text).toBe(specimen.expected.length);
    for (const [index, { grapheme, faces }] of graphemes.entries()) {
      const family = specimen.expected[index];
      if (!family) continue;
      const names = faces.map(({ familyName, isCustomFont }) =>
        isCustomFont ? familyName : `${familyName} (device)`,
      );
      const [face] = faces;
      // A variable face may report an instance name, such as "Noto Sans KR Thin".
      const right =
        faces.length === 1 &&
        face?.isCustomFont === true &&
        (face.familyName === family || face.familyName.startsWith(`${family} `));
      if (!right)
        breaks.push(`${specimen.text} '${grapheme}' should be ${family}: ${names.join(', ')}`);
    }
  }
  return breaks;
}

/** Each @font-face of the shared sheets: its file path and family. */
async function sheetFaces(page: Page): Promise<Map<string, string>> {
  const faces = new Map<string, string>();
  for (const url of [PUBLIC_FONT_SHEET_URLS.first, PUBLIC_FONT_SHEET_URLS.rest]) {
    const response = await page.request.get(url);
    expect(response.status(), url).toBe(200);
    for (const [, body = ''] of (await response.text()).matchAll(/@font-face\s*\{([^}]*)\}/gu)) {
      const family = /font-family:\s*(['"]?)([^;'"]+)\1/u.exec(body)?.[2]?.trim();
      for (const [, , file = ''] of body.matchAll(/url\((['"]?)([^'")]+)\1\)/gu)) {
        if (family) faces.set(new URL(file, new URL(url, page.url())).pathname, family);
      }
    }
  }
  return faces;
}

interface Opened {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly requests: string[];
  readonly failed: string[];
  readonly errors: string[];
}

async function openDesignSystem(
  browser: Browser,
  viewport: { width: number; height: number },
  baseURL: string,
): Promise<Opened> {
  const context = await browser.newContext({
    baseURL,
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    locale: 'en-US',
  });
  await context.route('**/*', (route) => {
    const { hostname } = new URL(route.request().url());
    return hostname === '127.0.0.1' || hostname === 'localhost' ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const requests: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === new URL(baseURL).origin && response.status() >= 400) {
      failed.push(`${response.status()} ${url.pathname}`);
    }
  });
  page.on('pageerror', (error) => {
    if (!isBenignPageError(error)) errors.push(error.message);
  });
  await page.goto('/designsystem');
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
  return { context, page, requests, failed, errors };
}

/** Pixel rows of a screenshot, decoded in a blank page of the same browser context. */
async function decodeColumns(
  context: BrowserContext,
  png: Buffer,
  columns: readonly { x0: number; x1: number }[],
): Promise<{ width: number; height: number; columns: number[][][] }> {
  const helper = await context.newPage();
  try {
    return await helper.evaluate(
      async ({ data, columns }) => {
        const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context2d = canvas.getContext('2d');
        if (!context2d) throw new Error('no 2d context');
        context2d.drawImage(bitmap, 0, 0);
        const pixels = context2d.getImageData(0, 0, bitmap.width, bitmap.height).data;
        return {
          width: bitmap.width,
          height: bitmap.height,
          // Per column range, per row, the RGB of each pixel in the range.
          columns: columns.map(({ x0, x1 }) => {
            const rows: number[][] = [];
            for (let y = 0; y < bitmap.height; y += 1) {
              const row: number[] = [];
              for (let x = x0; x <= x1; x += 1) {
                const at = (y * bitmap.width + x) * 4;
                row.push(pixels[at] ?? 0, pixels[at + 1] ?? 0, pixels[at + 2] ?? 0);
              }
              rows.push(row);
            }
            return rows;
          }),
        };
      },
      { data: png.toString('base64'), columns },
    );
  } finally {
    await helper.close();
  }
}

const rgb = (value: string): number[] =>
  (/rgba?\(([^)]+)\)/u.exec(value)?.[1] ?? '')
    .split(',')
    .slice(0, 3)
    .map((part) => Number.parseFloat(part));

const near = (pixel: readonly number[], color: readonly number[], tolerance: number): boolean =>
  color.every((channel, index) => Math.abs((pixel[index] ?? 0) - channel) <= tolerance);

/**
 * At device pixel ratio 1, each Leading rule is one row of the rule colour
 * where the browser snapped its mark's baseline, and the first line's rule
 * is the row right under the glyphs (the left stem of its first letter, N).
 */
async function leadingRuleProblems(
  context: BrowserContext,
  page: Page,
  testInfo: TestInfo,
): Promise<string[]> {
  const problems: string[] = [];
  const leads = page.locator('#typography .typo-lead');
  for (let index = 0; index < (await leads.count()); index += 1) {
    const lead = leads.nth(index);
    // Well inside the viewport, so the clip below is all on screen.
    await lead.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const geometry = await lead.evaluate((element) => {
      const sample = element.querySelector<HTMLElement>('.typo-lead-sample');
      const marks = [...element.querySelectorAll<HTMLElement>('.typo-lead-mark')];
      if (!sample || marks.length !== 2) throw new Error('a Leading sample without two marks');
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(sample);
      return {
        top: box.top,
        right: box.right,
        height: box.height,
        marks: marks.map((mark) => mark.getBoundingClientRect().top),
        textLeft: sample.getBoundingClientRect().left,
        fontSize: Number.parseFloat(style.fontSize),
        first: sample.textContent?.trim()[0] ?? '',
        rule: getComputedStyle(marks[0] as Element, '::after').borderTopColor,
        background: getComputedStyle(document.body).backgroundColor,
      };
    });
    expect(geometry.first, 'the first line starts with N').toBe('N');
    const originY = Math.floor(geometry.top);
    const png = await page.screenshot({
      clip: {
        x: 0,
        y: originY,
        width: page.viewportSize()?.width ?? 0,
        height: Math.ceil(geometry.height) + 2,
      },
      animations: 'disabled',
      caret: 'hide',
    });
    const ruleX = Math.floor(geometry.right) - 4;
    const stemX = Math.round(geometry.textLeft);
    const stemWidth = Math.max(3, Math.round(geometry.fontSize * 0.3));
    const decoded = await decodeColumns(context, png, [
      { x0: ruleX, x1: ruleX },
      { x0: stemX, x1: stemX + stemWidth },
    ]);
    const [ruleColumn = [], stemColumn = []] = decoded.columns;
    const ruleColor = rgb(geometry.rule);
    const background = rgb(geometry.background);
    const ruleRows = ruleColumn.flatMap((pixel, row) => (near(pixel, ruleColor, 48) ? [row] : []));
    const before = problems.length;
    for (const [line, markTop] of geometry.marks.entries()) {
      const at = markTop - originY;
      const rows = ruleRows.filter((row) => Math.abs(row - at) <= 1.5);
      if (rows.length !== 1) {
        problems.push(`lead ${index} line ${line}: ${rows.length} rule rows near ${at.toFixed(3)}`);
        continue;
      }
      const [row = -1] = rows;
      if (line !== 0) continue;
      // The last row above the rule with ink of the N stem.
      let ink = -1;
      for (let y = row - 1; y >= 0; y -= 1) {
        const pixels = stemColumn[y] ?? [];
        let inked = false;
        for (let x = 0; x + 2 < pixels.length; x += 3) {
          const pixel = pixels.slice(x, x + 3);
          if (!near(pixel, ruleColor, 48) && !near(pixel, background, 96)) inked = true;
        }
        if (inked) {
          ink = y;
          break;
        }
      }
      if (row !== ink + 1) {
        problems.push(`lead ${index}: the rule is row ${row}, the glyphs end on row ${ink}`);
      }
    }
    if (problems.length > before) {
      await testInfo.attach(`leading-${index}`, { body: png, contentType: 'image/png' });
    }
  }
  return problems;
}

/** A picture of the whole section, without the page's fixed header and tabs over it. */
async function savePicture(page: Page, testInfo: TestInfo, width: number): Promise<void> {
  const path = testInfo.outputPath(`typography-${width}.png`);
  await page.locator('#typography').screenshot({
    path,
    animations: 'disabled',
    caret: 'hide',
    style: '.lp-header, .editorial-site-tabs { visibility: hidden !important; }',
  });
  await testInfo.attach(`typography-${width}`, { path, contentType: 'image/png' });
}

for (const viewport of VIEWPORTS) {
  test(`every specimen draws with its labelled face at ${viewport.width} px`, async ({
    browser,
    baseURL,
  }, testInfo) => {
    const { context, page, requests, failed, errors } = await openDesignSystem(
      browser,
      viewport,
      baseURL ?? '',
    );
    try {
      // Faces.
      const specimens = await readSpecimens(page);
      expect(specimens.length).toBeGreaterThan(20);
      const drawn = await readFaces(page);
      expect(faceBreaks(specimens, drawn)).toEqual([]);
      const checked: Record<string, number> = {};
      for (const { expected } of specimens) {
        for (const family of expected) if (family) checked[family] = (checked[family] ?? 0) + 1;
      }
      const summary = testInfo.outputPath('faces-checked.json');
      writeFileSync(summary, JSON.stringify({ specimens: specimens.length, graphemes: checked }));
      await testInfo.attach('faces-checked', { path: summary, contentType: 'application/json' });

      // The four 述 cells draw four pictures.
      const cells = page.locator('#typography .typo-han-glyph');
      await expect(cells).toHaveCount(4);
      const pictures: Buffer[] = [];
      for (let index = 0; index < 4; index += 1) {
        pictures.push(await cells.nth(index).screenshot({ animations: 'disabled' }));
      }
      for (let left = 0; left < pictures.length; left += 1) {
        for (let right = left + 1; right < pictures.length; right += 1) {
          expect(
            pictures[left]?.equals(pictures[right] ?? Buffer.alloc(0)),
            `述 ${left}, ${right}`,
          ).toBe(false);
        }
      }

      // The printed measurements are what the browser lays out.
      const measured = await page.evaluate(() => {
        const section = document.querySelector<HTMLElement>('#typography');
        if (!section) throw new Error('no Typography section');
        const number = (text: string | null | undefined) =>
          Number.parseFloat((text ?? '').replace(/[^0-9.]/gu, ''));
        // line-height: normal, in each script and at the body and title weights.
        const lines = [...section.querySelectorAll('.typo-measure > div')].map((row) => {
          const size = number(row.querySelector('dt')?.textContent);
          const printed = number(row.querySelector('dd')?.textContent);
          const heights: string[] = [];
          for (const weight of [400, 700]) {
            for (const text of ['Ag', '한', '漢', 'あ']) {
              const probe = document.createElement('div');
              probe.textContent = text;
              probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font-size:${size}px;font-weight:${weight};line-height:normal;`;
              section.append(probe);
              heights.push(`${text}@${weight}=${probe.getBoundingClientRect().height}`);
              probe.remove();
            }
          }
          return { size, printed, heights };
        });
        const pitches = [...section.querySelectorAll('.typo-lead')].map((lead) => {
          const marks = [...lead.querySelectorAll<HTMLElement>('.typo-lead-mark')];
          return {
            printed: number(marks[1]?.dataset.pitch),
            laidOut:
              (marks[1]?.getBoundingClientRect().top ?? 0) -
              (marks[0]?.getBoundingClientRect().top ?? 0),
          };
        });
        const words = [
          ...section.querySelectorAll<HTMLElement>('.typo-optical .typo-track-word'),
        ].map((word) => word.getBoundingClientRect().width);
        return { lines, pitches, words };
      });
      for (const { size, printed, heights } of measured.lines) {
        expect(heights, `${size} px`).toEqual(
          heights.map((entry) => entry.replace(/=.*$/u, `=${printed}`)),
        );
      }
      for (const { printed, laidOut } of measured.pitches) {
        // Layout runs in 1/64 px units.
        expect(Math.abs(laidOut - printed), `pitch ${printed}`).toBeLessThanOrEqual(1 / 32);
      }
      const [small = 0, large = 0] = measured.words;
      // "opsz 32 sets the word about 5% narrower".
      expect(1 - large / small).toBeGreaterThan(0.04);
      expect(1 - large / small).toBeLessThan(0.065);

      // One sample edge, and nothing wider than the viewport.
      const layout = await page.evaluate(() => {
        const left = (selector: string) =>
          document.querySelector(`#typography ${selector}`)?.getBoundingClientRect().left ?? NaN;
        const wide = [...document.querySelectorAll<HTMLElement>('#typography, #typography *')]
          .filter(
            (element) =>
              getComputedStyle(element).position !== 'absolute' &&
              element.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5,
          )
          .map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
        return {
          scale: left('.typo-scale .spec .s28'),
          faceName: left('.typo-face-name'),
          faceUse: left('.typo-face-use'),
          lead: left('.typo-lead-sample'),
          hanFace: left('.typo-han-face'),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          wide,
        };
      });
      expect(layout.overflow).toBe(0);
      expect(layout.wide).toEqual([]);
      expect(layout.faceName).toBe(layout.scale);
      if (viewport.width > PHONE_MAX_WIDTH) expect(layout.lead).toBe(layout.scale);
      if (viewport.width > STACKED_HAN_MAX_WIDTH) expect(layout.hanFace).toBe(layout.faceUse);

      // The Leading rules at 1x.
      expect(await leadingRuleProblems(context, page, testInfo)).toEqual([]);

      // The network.
      const paths = requests.map((url) => new URL(url).pathname);
      for (const url of [...Object.values(PUBLIC_FONT_SHEET_URLS), PUBLIC_HAN_ORDER_SCRIPT_URL]) {
        expect(
          paths.filter((path) => path === url),
          url,
        ).toHaveLength(1);
      }
      expect(requests.filter((url) => RETIRED_FONT_REQUEST.test(url))).toEqual([]);
      expect(failed).toEqual([]);
      expect(errors).toEqual([]);
      const declared = await sheetFaces(page);
      const fetched = paths.filter((path) => path.endsWith('.woff2'));
      expect(fetched.filter((path) => !declared.has(path))).toEqual([]);
      const fetchedFamilies = new Set(fetched.map((path) => declared.get(path)));
      const loaded = await page.evaluate(() =>
        [...document.fonts]
          .filter((face) => face.status === 'loaded')
          .map((face) => face.family.replace(/^(['"])(.*)\1$/u, '$2')),
      );
      for (const family of new Set(
        specimens.flatMap(({ expected }) => expected.filter((name) => name !== null)),
      )) {
        expect(fetchedFamilies.has(family), `${family} fetched`).toBe(true);
        expect(loaded, `${family} loaded`).toContain(family);
      }

      if (PICTURE_WIDTHS.has(viewport.width)) await savePicture(page, testInfo, viewport.width);
    } finally {
      await context.close();
    }
  });
}
