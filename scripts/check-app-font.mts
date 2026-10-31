#!/usr/bin/env node
/**
 * The app font guard (npm run guard:font-assets, and guard:font-build with
 * --dist after a build).
 *
 * The app draws text with Inter and Noto only, from one font stack shared by
 * the Korean and English UIs, and its font owner src/i18n/locale-fonts.ts is
 * the only code that loads the font sheets. Source checks:
 * - the shipped Inter and Noto Sans KR files match fonts/font-sources.json
 *   (Noto Sans KR without its Korean locl lookup), and css/fonts/app/ is
 *   exactly the output of its generator;
 * - every face is self-hosted: one sheet-relative url() of a committed WOFF2
 *   file under fonts/, never local(), a remote URL or a second source;
 * - every Inter and CJK face carries the metric descriptors of
 *   src/i18n/font-metrics.ts, and the script faces carry none;
 * - the stacks: text takes its family from the app's stacks (a literal list
 *   only in the recorded LITERAL_FONT_FAMILY_RULES); every stack (the body's
 *   and each declaration that reads one) is the same in the Korean and
 *   English UIs under every Han order, and names every app family, Inter
 *   ahead of the CJK families;
 * - no app rule applies in only one of the Korean and English UIs, whatever
 *   it sets, but the recorded KOREAN_ENGLISH_COPY_RULES for translated copy;
 *   no rule turns Inter's contextual alternates off; css/app.css and its
 *   imports declare no @font-face;
 * - one source per script: Latin, Cyrillic and Greek that Inter draws come
 *   only from Inter, Hangul Noto Sans KR draws only from KR, kana Noto Sans JP
 *   draws only from JP (by block or by Unicode Script), in every stack of
 *   every UI;
 * - coverage: every non-PUA character Pretendard drew, every character of
 *   the catalogs and index.html, the KS X 1001 repertoire and the visible
 *   text-presentation symbols of the punctuation, letterlike, arrow, math,
 *   technical, geometric, symbol, dingbat and CJK punctuation blocks resolves
 *   by cmap to a self-hosted face in every stack, except the recorded list in
 *   scripts/fonts/uncovered-code-points.txt, which must name exactly the gaps
 *   (a device font picked by page language draws those, so a new gap is a
 *   new difference between the Korean and English UIs);
 * - no Pretendard in the app, no Pretendard runtime, no service worker font
 *   group, and no font preload in any HTML.
 * The initial transfer budget (scripts/check-initial-transfer-budget.mts)
 * holds the eager font bytes at 0, fonts of eager stylesheets included.
 * --dist adds the built output: no font in the initial graph of the app
 * document or its localized copies, each of the 16 app sheets its own lazy
 * CSS asset with the expected descriptors and root-relative WOFF2 files, the built
 * Inter and Noto Sans KR bytes equal to the sources, no font sheet or file in
 * the service worker's install manifests (which do install the font owner
 * chunk itself), About's locale links bound to the
 * processed original sheets, and Pretendard deployed once for the public
 * pages.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASSIC_RUNTIME_ASSETS, compileClassicRuntimeAsset } from './classic-runtime-assets.ts';
import { findStaleFontSheets } from './fonts/build-font-sheets.mts';
import { fontCodePoints, openFontFile, verifyShippedFontFiles } from './fonts/font-files.mts';
import { readFaceResolver, readFontStacks, type FaceResolver } from './fonts/font-stacks.mts';
import {
  builtAssetStem,
  declaresFontFace,
  disablesContextualAlternates,
  faceDescriptorMismatches,
  faceSourceProblems,
  fontFaceSheets,
  fontPreloadHrefs,
  initialAssetUrls,
  KOREAN_ENGLISH_COPY_RULES,
  ksX1001CodePoints,
  languageSplitTests,
  localDistAssetPath,
  parseCodePointList,
  stackCoverageGaps,
  textSymbolCodePoints,
  woff2Urls,
  type FaceMetricValues,
} from './lib/app-font-guard.mts';
import { APP_FONT_SHEETS } from '../src/i18n/app-font-contract.ts';
import { CJK_FACE_METRICS, INTER_FACE_METRICS } from '../src/i18n/font-metrics.ts';
import { LANGUAGE_OPTIONS, languageDirection } from '../src/i18n/locales.ts';
import { SERVICE_WORKER_SOURCE_PATH } from './service-worker-asset.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distMode = process.argv.includes('--dist');
const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function hex(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

async function collectFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(target)));
    else files.push(target);
  }
  return files;
}

const PRETENDARD_URL = '/designsystem/fonts/PretendardVariable.woff2';
const PRETENDARD_SOURCE = path.join(repoRoot, 'fonts', 'PretendardVariable.woff2');
const PRETENDARD_PUBLIC = path.join(
  repoRoot,
  'public',
  'designsystem',
  'fonts',
  'PretendardVariable.woff2',
);
const UNCOVERED_LIST = 'scripts/fonts/uncovered-code-points.txt';
const CJK_FAMILIES = ['Noto Sans KR', 'Noto Sans JP', 'Noto Sans SC', 'Noto Sans TC'];
const SYSTEM_FAMILIES = new Set([
  '-apple-system',
  'BlinkMacSystemFont',
  'Segoe UI',
  'Roboto',
  'sans-serif',
]);
const APP_FAMILIES: readonly string[] = APP_FONT_SHEETS.map(({ family }) => family);
const FACE_METRICS = new Map<string, FaceMetricValues | null>(
  APP_FONT_SHEETS.map(({ family }) => [
    family,
    family === 'Inter'
      ? INTER_FACE_METRICS
      : CJK_FAMILIES.includes(family)
        ? CJK_FACE_METRICS
        : null,
  ]),
);
// The static pages' original sheets, which About links and the sitemap page
// loads (src/i18n/static-page-fonts.ts). They keep their source names.
const STATIC_PAGE_SHEETS = [
  { family: 'Noto Sans Arabic', source: 'noto-arabic' },
  { family: 'Noto Sans Bengali', source: 'noto-bengali' },
  { family: 'Noto Sans', source: 'noto-cyrillic' },
  { family: 'Noto Sans Devanagari', source: 'noto-devanagari' },
  { family: 'Noto Sans', source: 'noto-greek' },
  { family: 'Noto Sans Gujarati', source: 'noto-gujarati' },
  { family: 'Noto Sans Gurmukhi', source: 'noto-gurmukhi' },
  { family: 'Noto Sans Hebrew', source: 'noto-hebrew' },
  { family: 'Noto Sans JP', source: 'noto-jp' },
  { family: 'Noto Sans Kannada', source: 'noto-kannada' },
  { family: 'Noto Sans Malayalam', source: 'noto-malayalam' },
  { family: 'Noto Sans SC', source: 'noto-sc' },
  { family: 'Noto Sans Tamil', source: 'noto-tamil' },
  { family: 'Noto Sans TC', source: 'noto-tc' },
  { family: 'Noto Sans Telugu', source: 'noto-telugu' },
  { family: 'Noto Sans Thai', source: 'noto-thai' },
] as const;

// ── Source: files, sheets and descriptors ──────────────────────────

failures.push(...(await verifyShippedFontFiles(repoRoot)));
for (const sheet of await findStaleFontSheets(repoRoot)) {
  failures.push(
    `${sheet} is not the output of scripts/fonts/build-font-sheets.mts; run npm run generate:font-sheets`,
  );
}
// Every face is self-hosted: one sheet-relative url() of a committed WOFF2
// file under fonts/, with format('woff2'), and the descriptors of its family.
const fontsDirectory = `${path.join(repoRoot, 'fonts')}${path.sep}`;
for (const sheet of APP_FONT_SHEETS) {
  const css = await readFile(path.join(repoRoot, sheet.path), 'utf8');
  for (const mismatch of faceDescriptorMismatches(css, FACE_METRICS)) {
    failures.push(`${sheet.path}: ${mismatch}`);
  }
  for (const problem of faceSourceProblems(css, 'relative')) {
    failures.push(`${sheet.path}: ${problem}`);
  }
  for (const url of woff2Urls(css)) {
    if (/^[a-z][a-z\d+.-]*:/iu.test(url) || url.startsWith('/')) continue;
    const file = path.resolve(repoRoot, path.dirname(sheet.path), url);
    check(
      file.startsWith(fontsDirectory),
      `${sheet.path}: ${url} points outside the committed fonts/ directory`,
    );
    const exists = await readFile(file).then(
      (bytes) => bytes.subarray(0, 4).toString('latin1') === 'wOF2',
      () => false,
    );
    check(exists, `${sheet.path}: ${url} is not a committed WOFF2 file`);
  }
}

// ── Source: stacks ─────────────────────────────────────────────────
// src/i18n/__tests__/font-stack-identity.test.ts holds the per-language orders.

const fontStacks = readFontStacks(repoRoot);
const appStyleText = (
  await Promise.all(fontStacks.sheets.map((sheet) => readFile(path.join(repoRoot, sheet), 'utf8')))
).join('\n');
check(!/pretendard/iu.test(appStyleText), 'the app stylesheets still name Pretendard');
check(
  !appStyleText.includes('data-mxqr-font-recovery'),
  'the app stylesheets still switch to a recovery font family',
);

// Text takes its family from the app's stacks (--font-sans and the stacks
// it is built from) or inherits it. A literal family list is allowed only
// where text is not the app's own or user content, as recorded here.
const LITERAL_FONT_FAMILY_RULES: Readonly<Record<string, string>> = {
  '.account-google-button': "Google's sign-in button follows Google's branding rules",
  '.noscript-fallback': 'shown when scripts are off, before any font sheet can load',
  '.debug-memory-content': 'diagnostic overlay, device monospace',
  '.debug-memory-graph-label': 'diagnostic overlay, device monospace',
  '.debug-memory-hint': 'diagnostic overlay',
  '.onboarding-diagnostics-status': 'diagnostic overlay, device monospace',
  '.onboarding-diagnostics-action': 'diagnostic overlay, device monospace',
};
const stackDeclarations: { selector: string; value: string }[] = [];
const literalSelectors = new Set<string>();
for (const { sheet, selector, rule } of fontStacks.rules) {
  for (const node of rule.nodes) {
    if (node.type !== 'decl') continue;
    const value = node.value.replace(/\s+/gu, ' ').trim();
    if (node.prop === 'font') {
      check(
        value === 'inherit',
        `${sheet} ${selector} sets a font family through 'font: ${value}'`,
      );
      continue;
    }
    if (node.prop !== 'font-family' || value === 'inherit') continue;
    if (/var\(--font-sans/u.test(value)) {
      stackDeclarations.push({ selector, value });
      continue;
    }
    literalSelectors.add(selector);
    check(
      selector in LITERAL_FONT_FAMILY_RULES,
      `${sheet} ${selector} sets its own font family (${value}) instead of an app stack`,
    );
  }
}
for (const selector of Object.keys(LITERAL_FONT_FAMILY_RULES)) {
  check(
    literalSelectors.has(selector),
    `${selector} no longer sets its own font family; drop it from LITERAL_FONT_FAMILY_RULES`,
  );
}

// The Korean and English UIs draw the same content the same way, so no app
// rule may apply in only one of them, whatever it sets (a lang test that
// answers differently for ko and en), except the recorded rules for the UI's
// own translated copy. Inter's contextual alternates stay on (decision 4), and
// faces live only in the generated sheets, never in css/app.css or its imports.
const koreanLang = LANGUAGE_OPTIONS.find(({ code }) => code === 'ko')?.htmlLang ?? 'ko';
const englishLang = LANGUAGE_OPTIONS.find(({ code }) => code === 'en')?.htmlLang ?? 'en';
const splitSelectors = new Set<string>();
for (const { sheet, selector, selectors, rule } of fontStacks.rules) {
  for (const single of selectors) {
    const tests = languageSplitTests(single, koreanLang, englishLang);
    if (tests.length === 0) continue;
    splitSelectors.add(single);
    check(
      single in KOREAN_ENGLISH_COPY_RULES,
      `${sheet} ${single} applies in only one of the Korean and English UIs (${tests.join(', ')})`,
    );
  }
  for (const node of rule.nodes) {
    if (node.type !== 'decl') continue;
    check(
      !disablesContextualAlternates(node.prop, node.value),
      `${sheet} ${selector} turns Inter's contextual alternates off (${node.prop}: ${node.value})`,
    );
  }
}
for (const selector of Object.keys(KOREAN_ENGLISH_COPY_RULES)) {
  check(
    splitSelectors.has(selector),
    `${selector} no longer tells the Korean and English UIs apart; drop it from KOREAN_ENGLISH_COPY_RULES`,
  );
}
const appStylesheets = await Promise.all(
  ['css/app.css', ...fontStacks.sheets].map(async (sheetPath) => ({
    path: sheetPath,
    css: await readFile(path.join(repoRoot, sheetPath), 'utf8'),
  })),
);
for (const sheetPath of fontFaceSheets(appStylesheets)) {
  failures.push(
    `${sheetPath} declares @font-face; the app's faces live only in the generated font sheets (APP_FONT_SHEETS)`,
  );
}

// Every text stack in every document state: the body's --font-sans and each
// declaration that reads a stack (detected Japanese and Chinese text, the
// language picker's native names), in every UI language under every Han order.
const HAN_ORDERS = [null, 'ja', 'zh-hans', 'zh-hant'] as const;
const hanAttributes = (hanOrder: (typeof HAN_ORDERS)[number]): Record<string, string> =>
  hanOrder === null ? {} : { 'data-mxqr-han-order': hanOrder };
const textStacks = new Map<string, readonly string[]>();
const stackKeys = new Set<string>();
for (const hanOrder of HAN_ORDERS) {
  const attributes = hanAttributes(hanOrder);
  const orderLabel = `Han order ${hanOrder ?? 'ko'}`;
  const stackIn = (htmlLang: string, value: string | null, dir: 'ltr' | 'rtl' = 'ltr'): string[] =>
    value === null
      ? fontStacks.fontSans({ htmlLang, dir, attributes })
      : fontStacks.families({ htmlLang, dir, attributes }, value);
  for (const { selector, value } of [
    { selector: '--font-sans', value: null },
    ...stackDeclarations,
  ]) {
    check(
      JSON.stringify(stackIn('ko', value)) === JSON.stringify(stackIn('en', value)),
      `the Korean and English UIs read different font stacks for ${selector} (${orderLabel})`,
    );
    for (const { code, htmlLang } of LANGUAGE_OPTIONS) {
      const stack = stackIn(htmlLang, value, languageDirection(code));
      const key = stack.join('|');
      if (stackKeys.has(key)) continue;
      stackKeys.add(key);
      const where = `${selector} in the ${code} UI (${orderLabel})`;
      textStacks.set(where, stack);
      const strays = stack.filter(
        (family) => !APP_FAMILIES.includes(family) && !SYSTEM_FAMILIES.has(family),
      );
      check(strays.length === 0, `${where} names ${strays.join(', ')}`);
      const missing = APP_FAMILIES.filter((family) => !stack.includes(family));
      check(missing.length === 0, `${where} omits ${missing.join(', ')}`);
      const inter = stack.indexOf('Inter');
      check(
        inter >= 0 && CJK_FAMILIES.every((family) => stack.indexOf(family) > inter),
        `${where} puts a CJK family before Inter`,
      );
    }
  }
}

// ── Source: one source per script, and coverage ────────────────────

// The faces are read from their files; a sheet that points at no readable
// file is reported above, and these checks then wait for it to be fixed.
const resolver = await readFaceResolver(repoRoot, APP_FONT_SHEETS).catch((error: unknown) => {
  failures.push(
    `the app font faces cannot be read, so the script and coverage checks did not run: ${error instanceof Error ? error.message : String(error)}`,
  );
  return null;
});
const recordedGapCount = resolver ? await checkScriptsAndCoverage(resolver) : 0;

/** One source per script and coverage in every text stack; returns the recorded gap count. */
async function checkScriptsAndCoverage(resolver: FaceResolver): Promise<number> {
  const hasFace = (families: readonly string[], codePoint: number): boolean =>
    resolver.faceFor(families, codePoint) !== null;
  const interCodePoints = new Set<number>();
  for (const sheet of APP_FONT_SHEETS.filter(({ family }) => family === 'Inter')) {
    const css = await readFile(path.join(repoRoot, sheet.path), 'utf8');
    for (const url of woff2Urls(css)) {
      const file = path.join(repoRoot, path.dirname(sheet.path), url);
      for (const codePoint of fontCodePoints(await openFontFile(file)))
        interCodePoints.add(codePoint);
    }
  }
  // Hangul and kana by block or by Unicode Script, as the sheet generator
  // cuts them: ㈜ and ㉠ are Hangul, ㋖ and ㌔ kana, outside the blocks.
  const isHangul = (codePoint: number) =>
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7ff) ||
    /\p{Script=Hangul}/u.test(String.fromCodePoint(codePoint));
  const isKana = (codePoint: number) =>
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0xff66 && codePoint <= 0xff9f) ||
    /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(String.fromCodePoint(codePoint));
  // Every non-surrogate code point of the first two planes; a script's owner
  // check holds the characters that owner draws (one it lacks, such as the
  // halfwidth jamo only JP draws, stays where it is drawn).
  const planeCodePoints = Array.from({ length: 0x20000 }, (_, index) => index).filter(
    (codePoint) => codePoint < 0xd800 || codePoint > 0xdfff,
  );
  const ownedBy = (family: string, test: (codePoint: number) => boolean): number[] =>
    planeCodePoints.filter(
      (codePoint) => test(codePoint) && resolver.faceFor([family], codePoint) !== null,
    );
  // The Latin, Cyrillic and Greek letters and the digits Inter draws (its cmap
  // inside its own unicode-ranges). Script-first stacks (Arabic, Hebrew, Indic)
  // may take shared marks such as dashes, joiners or the rupee sign from their
  // script face, as designed, so the check holds letters and digits only.
  const interLetters = [...interCodePoints].filter(
    (codePoint) =>
      /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Nd}]/u.test(
        String.fromCodePoint(codePoint),
      ) && resolver.faceFor(['Inter'], codePoint) !== null,
  );
  const hangulSyllables = Array.from({ length: 11_172 }, (_, index) => 0xac00 + index);
  const ownerChecks: [string, number[], string][] = [
    ['Latin, Cyrillic and Greek letters and digits', interLetters, 'Inter'],
    ['Hangul', ownedBy('Noto Sans KR', isHangul), 'Noto Sans KR'],
    ['kana', ownedBy('Noto Sans JP', isKana), 'Noto Sans JP'],
  ];
  for (const [where, stack] of textStacks) {
    for (const [label, codePoints, owner] of ownerChecks) {
      const strays = codePoints.filter((codePoint) => {
        const face = resolver.faceFor(stack, codePoint);
        return face !== null && face.family !== owner;
      });
      check(
        strays.length === 0,
        `${label} in ${where} come from a family other than ${owner}: ${strays
          .slice(0, 8)
          .map(hex)
          .join(', ')}`,
      );
    }
    const missingHangul = hangulSyllables.filter((codePoint) => !hasFace(stack, codePoint));
    check(
      missingHangul.length === 0,
      `${where}: ${missingHangul.length} Hangul syllables have no face`,
    );
  }

  // Coverage: every non-PUA character Pretendard drew (what the app could show
  // before the switch), every character of the catalogs and index.html, the
  // KS X 1001 repertoire (Korean text and input methods) and the text symbols
  // of the blocks the review swept has a self-hosted face in every text stack,
  // except the recorded gaps.
  const isPrivateUse = (codePoint: number) =>
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) || codePoint >= 0xf0000;
  const isControlOrSpace = (codePoint: number) =>
    codePoint <= 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
  const required = new Set<number>();
  for (const codePoint of fontCodePoints(await openFontFile(PRETENDARD_SOURCE))) {
    if (!isPrivateUse(codePoint) && !isControlOrSpace(codePoint)) required.add(codePoint);
  }
  for (const source of [
    ...LANGUAGE_OPTIONS.map(({ code }) => `src/i18n/${code}.ts`),
    'index.html',
  ]) {
    for (const character of await readFile(path.join(repoRoot, source), 'utf8')) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (!isControlOrSpace(codePoint)) required.add(codePoint);
    }
  }
  for (const codePoint of [...ksX1001CodePoints(), ...textSymbolCodePoints()]) {
    if (!isPrivateUse(codePoint) && !isControlOrSpace(codePoint)) required.add(codePoint);
  }
  const recordedList = parseCodePointList(
    await readFile(path.join(repoRoot, UNCOVERED_LIST), 'utf8'),
  );
  for (const problem of recordedList.problems) failures.push(`${UNCOVERED_LIST} ${problem}`);
  const recordedUncovered: ReadonlySet<number> = new Set(recordedList.codePoints);
  const coverage = stackCoverageGaps(textStacks, required, hasFace, recordedUncovered);
  for (const [where, missing] of [...coverage.unlisted].slice(0, 8)) {
    failures.push(
      `${missing.length} characters the app may show have no self-hosted face in ${where} and are not in ${UNCOVERED_LIST}: ${missing
        .slice(0, 12)
        .map(hex)
        .join(', ')}`,
    );
  }
  check(
    coverage.unlisted.size <= 8,
    `${coverage.unlisted.size - 8} more stacks miss characters that ${UNCOVERED_LIST} does not list`,
  );
  check(
    coverage.stale.length === 0,
    `${UNCOVERED_LIST} lists ${coverage.stale.length} characters that every stack now draws or that nothing requires: ${coverage.stale
      .slice(0, 12)
      .map(hex)
      .join(', ')}`,
  );
  return recordedUncovered.size;
}

// ── Source: no Pretendard and no second font machine in the app ────

const bootstrapAsset = CLASSIC_RUNTIME_ASSETS.find(
  ({ outputPath }) => outputPath === 'bootstrap.js',
);
if (!bootstrapAsset) throw new Error('Classic-runtime manifest omits bootstrap.js');
check(
  !CLASSIC_RUNTIME_ASSETS.some(({ outputPath }) => /font/iu.test(outputPath)),
  'a classic runtime still loads fonts',
);
const [appHtml, serviceWorkerSource, bootstrapSource, sourceFont, publicFont, packageJson] =
  await Promise.all([
    readFile(path.join(repoRoot, 'index.html'), 'utf8'),
    readFile(path.join(repoRoot, SERVICE_WORKER_SOURCE_PATH), 'utf8'),
    readFile(path.join(repoRoot, bootstrapAsset.sourcePath), 'utf8'),
    readFile(PRETENDARD_SOURCE),
    readFile(PRETENDARD_PUBLIC),
    readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ]);
// font-metrics.ts derives the descriptors from Pretendard's metrics and says so.
const productionSources = (await collectFiles(path.join(repoRoot, 'src'))).filter(
  (file) =>
    /\.(?:ts|css)$/u.test(file) &&
    !/[\\/]__tests__[\\/]/u.test(file) &&
    path.basename(file) !== 'font-metrics.ts',
);
for (const [label, text] of [
  ['index.html', appHtml],
  [SERVICE_WORKER_SOURCE_PATH, serviceWorkerSource],
  [bootstrapAsset.sourcePath, bootstrapSource],
  ...(await Promise.all(
    productionSources.map(
      async (file) =>
        [path.relative(repoRoot, file).replace(/\\/gu, '/'), await readFile(file, 'utf8')] as const,
    ),
  )),
] as const) {
  check(!/pretendard/iu.test(text), `${label} names Pretendard`);
}
check(
  !/primary-font|OPTIONAL_PRIMARY_FONT_ASSETS|mxqr-optional-ready/u.test(
    `${serviceWorkerSource}\n${bootstrapSource}`,
  ),
  'the service worker or the bootstrap still carries the Pretendard runtime or its font group',
);
for (const retired of [
  'browser/classic-runtime/primary-font-loader.ts',
  'public/primary-font.css',
  'public/primary-font-loader.js',
]) {
  const exists = await readFile(path.join(repoRoot, retired)).then(
    () => true,
    () => false,
  );
  check(!exists, `${retired} is back`);
}
// Pretendard stays deployed for the public pages until they switch.
check(sourceFont.subarray(0, 4).toString('ascii') === 'wOF2', 'the Pretendard source is not WOFF2');
check(sourceFont.equals(publicFont), 'the public Pretendard copy differs from fonts/');
for (const [label, file] of [
  ['app', 'index.html'],
  ['About', '.workshop/landing/landing.html'],
  ['blog', 'public/blog/index.html'],
  ['history', 'public/history/index.html'],
  ['design system', 'public/designsystem/index.html'],
] as const) {
  const preloads = fontPreloadHrefs(await readFile(path.join(repoRoot, file), 'utf8'));
  check(preloads.length === 0, `the ${label} HTML preloads fonts: ${preloads.join(', ')}`);
}
check(
  !/font:subset|guard:font-subsets|subset-app-font/u.test(packageJson),
  'package scripts still expose app font subsetting',
);

// ── Built output ───────────────────────────────────────────────────

if (distMode) {
  const distDirectory = path.join(repoRoot, 'dist');
  const distFiles = await collectFiles(distDirectory);
  const distFileSet = new Set(distFiles.map((file) => path.resolve(file)));
  const builtCss = await Promise.all(
    distFiles
      .filter((file) => file.endsWith('.css'))
      .map(async (file) => ({ file, css: await readFile(file, 'utf8') })),
  );
  const builtHtml = await Promise.all(
    distFiles
      .filter((file) => file.endsWith('.html'))
      .map(async (file) => ({ file, html: await readFile(file, 'utf8') })),
  );
  const relative = (file: string) => path.relative(distDirectory, file).replace(/\\/gu, '/');

  for (const { file, html } of builtHtml) {
    const preloads = fontPreloadHrefs(html);
    check(preloads.length === 0, `built ${relative(file)} preloads fonts: ${preloads.join(', ')}`);
  }

  // Each app sheet is its own lazy CSS asset, with its descriptors and files.
  const appSheetFiles = new Map<string, string>();
  for (const { id, family } of APP_FONT_SHEETS) {
    const matches = builtCss.filter(
      ({ file, css }) => builtAssetStem(file) === id && declaresFontFace(css, family),
    );
    check(
      matches.length === 1,
      `the app font sheet ${id} should be exactly one built CSS asset (found ${matches.length})`,
    );
    const [match] = matches;
    if (!match) continue;
    appSheetFiles.set(id, match.file);
    for (const mismatch of faceDescriptorMismatches(match.css, FACE_METRICS)) {
      failures.push(`built ${relative(match.file)}: ${mismatch}`);
    }
    for (const problem of faceSourceProblems(match.css, 'root')) {
      failures.push(`built ${relative(match.file)}: ${problem}`);
    }
    for (const url of woff2Urls(match.css)) {
      const fontFile = localDistAssetPath(distDirectory, url);
      check(
        fontFile !== null && distFileSet.has(path.resolve(fontFile)),
        `built ${relative(match.file)} points at a missing font file: ${url}`,
      );
    }
  }

  // The built Inter and Noto Sans KR files are the committed bytes.
  for (const [id, sourceDirectory] of [
    ['font-inter', 'fonts/inter'],
    ['font-noto-kr', 'fonts/noto/noto-sans-kr'],
  ] as const) {
    const sheetFile = appSheetFiles.get(id);
    if (!sheetFile) continue;
    const urls = woff2Urls(await readFile(sheetFile, 'utf8'));
    check(urls.length > 0, `built ${id} references no font files`);
    for (const url of urls) {
      const fontFile = localDistAssetPath(distDirectory, url);
      if (!fontFile || !distFileSet.has(path.resolve(fontFile))) continue;
      const source = path.join(repoRoot, sourceDirectory, `${builtAssetStem(fontFile)}.woff2`);
      const [built, original] = await Promise.all([
        readFile(fontFile),
        readFile(source).catch(() => null),
      ]);
      check(
        original !== null && built.equals(original),
        `built ${relative(fontFile)} differs from ${path.relative(repoRoot, source)}`,
      );
    }
  }

  // Nothing font-related in the initial graph of the app document and its
  // localized copies.
  const builtFontNames = distFiles
    .filter((file) => file.endsWith('.woff2'))
    .map((file) => path.basename(file));
  const appSheetSet = new Set([...appSheetFiles.values()].map((file) => path.resolve(file)));
  const appDocuments = builtHtml.filter(({ file }) =>
    /^(?:[a-z]{2,3}(?:-[a-z]+)?\/)?index\.html$/u.test(relative(file)),
  );
  check(appDocuments.length > 1, 'the built app document and its localized copies are missing');
  for (const { file, html } of appDocuments) {
    const initialFiles = initialAssetUrls(html)
      .filter((url) => /\.(?:css|m?js)(?:[?#]|$)/iu.test(url))
      .map((url) => localDistAssetPath(distDirectory, url))
      .filter((asset): asset is string => asset !== null);
    for (const asset of initialFiles) {
      check(
        !appSheetSet.has(path.resolve(asset)),
        `built ${relative(file)} links the font sheet ${relative(asset)} in its initial graph`,
      );
      const content = await readFile(asset, 'utf8').catch(() => '');
      check(
        !declaresFontFace(content),
        `built ${relative(asset)} in the initial graph of ${relative(file)} declares @font-face`,
      );
      const absorbed = builtFontNames.filter((name) => content.includes(name));
      check(
        absorbed.length === 0,
        `built ${relative(asset)} in the initial graph of ${relative(file)} names font files: ${absorbed
          .slice(0, 4)
          .join(', ')}`,
      );
    }
  }

  // The service worker installs no font: its manifests hold no sheet or file.
  const distServiceWorker = await readFile(path.join(distDirectory, 'service-worker.js'), 'utf8');
  const fontSheetStems = new Set<string>([
    ...APP_FONT_SHEETS.map(({ id }) => id),
    ...STATIC_PAGE_SHEETS.map(({ source }) => source),
  ]);
  for (const manifest of ['APP_SHELL', 'BUILD_ENTRY_ASSETS']) {
    const entries = [
      ...(new RegExp(`\\bconst\\s+${manifest}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`, 'u')
        .exec(distServiceWorker)?.[1]
        ?.matchAll(/["']([^"']+)["']/gu) ?? []),
    ].map((match) => match[1] ?? '');
    check(entries.length > 0, `built service worker ${manifest} was not found`);
    const fonts = entries.filter(
      (entry) => entry.endsWith('.woff2') || fontSheetStems.has(builtAssetStem(entry)),
    );
    check(
      fonts.length === 0,
      `built service worker ${manifest} installs fonts: ${fonts.join(', ')}`,
    );
    // The font owner itself installs with the app shell, so a failed import
    // can be retried offline (vite.config.ts REVIEWED_DEFERRED_APP_SHELL_ROOTS).
    if (manifest === 'BUILD_ENTRY_ASSETS') {
      check(
        entries.some((entry) => builtAssetStem(entry) === 'locale-fonts' && entry.endsWith('.js')),
        `built service worker ${manifest} does not install the font owner chunk (locale-fonts)`,
      );
    }
  }
  check(
    !/primary-font|OPTIONAL_PRIMARY_FONT_ASSETS|mxqr-optional-ready/u.test(distServiceWorker),
    'the built service worker still carries the Pretendard font group',
  );
  for (const retired of ['primary-font.css', 'primary-font-loader.js']) {
    check(!distFileSet.has(path.resolve(distDirectory, retired)), `dist/${retired} is still built`);
  }
  const distBootstrap = await readFile(path.join(distDirectory, 'bootstrap.js'), 'utf8');
  check(
    distBootstrap === (await compileClassicRuntimeAsset(repoRoot, bootstrapAsset)).code,
    'built early bootstrap runtime differs from the classic-runtime compiler output',
  );

  // About: its disabled locale links point at the processed original sheets.
  const staticSheetFiles = new Set<string>();
  for (const { family, source } of STATIC_PAGE_SHEETS) {
    const matches = builtCss.filter(
      ({ file, css }) => builtAssetStem(file) === source && declaresFontFace(css, family),
    );
    check(
      matches.length === 1,
      `the static pages' ${source} sheet should be exactly one built CSS asset (found ${matches.length})`,
    );
    for (const { file } of matches) staticSheetFiles.add(path.resolve(file));
  }
  const aboutHtml = builtHtml.find(({ file }) => relative(file) === 'about.html')?.html ?? '';
  const aboutLinks = [...aboutHtml.matchAll(/<link\b[^>]*>/giu)]
    .map((match) => match[0])
    .filter((tag) => /\bdata-static-lang-font-codes=["'][^"']+["']/iu.test(tag));
  check(
    aboutLinks.length === STATIC_PAGE_SHEETS.length,
    `built About HTML must expose ${STATIC_PAGE_SHEETS.length} lazy locale font links (found ${aboutLinks.length})`,
  );
  const aboutSheets = new Set<string>();
  for (const tag of aboutLinks) {
    const href = /\bhref=["']([^"']+)["']/iu.exec(tag)?.[1] ?? '';
    const file = localDistAssetPath(distDirectory, href);
    check(
      file !== null && staticSheetFiles.has(path.resolve(file)),
      `built About links a locale font sheet that is not a processed original: ${href || '(missing)'}`,
    );
    if (!file) continue;
    aboutSheets.add(path.resolve(file));
    for (const url of woff2Urls(await readFile(file, 'utf8').catch(() => ''))) {
      const fontFile = url.startsWith('/')
        ? localDistAssetPath(distDirectory, url)
        : path.resolve(path.dirname(file), url);
      check(
        fontFile !== null && distFileSet.has(path.resolve(fontFile)),
        `built About locale font file is unresolved: ${relative(file)} -> ${url}`,
      );
    }
  }
  check(
    aboutSheets.size === STATIC_PAGE_SHEETS.length,
    'built About locale font links must resolve to distinct sheets',
  );

  // Pretendard: deployed once, byte-identical, for the public pages.
  const deployedPretendard = distFiles.filter(
    (file) => path.basename(file) === 'PretendardVariable.woff2',
  );
  check(
    deployedPretendard.length === 1,
    `PretendardVariable.woff2 should be deployed exactly once (found ${deployedPretendard.length})`,
  );
  const [deployed] = deployedPretendard;
  if (deployed) {
    check(
      relative(deployed) === PRETENDARD_URL.slice(1),
      `PretendardVariable.woff2 moved to ${relative(deployed)}`,
    );
    check(
      (await readFile(deployed)).equals(sourceFont),
      'the built Pretendard differs from fonts/',
    );
  }
}

if (failures.length > 0) {
  console.error(`App font guard failed:\n${failures.map((line) => `  - ${line}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(
    `App font guard passed (Inter and Noto files and self-hosted sheets, ${textStacks.size} distinct text stacks, one source per script, coverage with ${recordedGapCount} recorded gaps${distMode ? ', built sheets, initial graph and install manifests' : ''}).`,
  );
}
