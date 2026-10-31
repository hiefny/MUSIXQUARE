#!/usr/bin/env node
/**
 * The app font guard (npm run guard:font-assets, and guard:font-build with
 * --dist after a build).
 *
 * The app draws text with Inter and Noto only, from one font stack shared by
 * the Korean and English UIs, and its font owner src/i18n/locale-fonts.ts is
 * the only code that loads the font sheets. Source checks:
 * - the shipped Inter and Noto Sans KR files match fonts/font-sources.json,
 *   and css/fonts/app/ is exactly the output of its generator;
 * - every Inter and CJK face carries the metric descriptors of
 *   src/i18n/font-metrics.ts, and the script faces carry none;
 * - the stacks: the Korean and English UIs read one stack under every Han
 *   order, every UI names every app family, Inter ahead of the CJK families;
 * - one source per script: Latin, Cyrillic and Greek that Inter draws come
 *   only from Inter, Hangul only from Noto Sans KR, kana only from Noto Sans
 *   JP, in every UI;
 * - coverage: every non-PUA character Pretendard drew, and every character
 *   of the catalogs and index.html, resolves to a self-hosted face in the
 *   Korean and English stack, except the recorded list in
 *   scripts/fonts/uncovered-code-points.txt;
 * - no Pretendard in the app, no Pretendard runtime, no service worker font
 *   group, and no font preload in any HTML.
 * --dist adds the built output: no font in the initial graph of the app
 * document or its localized copies, each of the 16 app sheets its own lazy
 * CSS asset with the expected descriptors and resolvable files, the built
 * Inter and Noto Sans KR bytes equal to the sources, no font sheet or file in
 * the service worker's install manifests, About's locale links bound to the
 * processed original sheets, and Pretendard deployed once for the public
 * pages.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASSIC_RUNTIME_ASSETS, compileClassicRuntimeAsset } from './classic-runtime-assets.ts';
import { findStaleFontSheets } from './fonts/build-font-sheets.mts';
import { fontCodePoints, openFontFile, verifyShippedFontFiles } from './fonts/font-files.mts';
import { readFaceResolver, readFontStacks } from './fonts/font-stacks.mts';
import {
  builtAssetStem,
  declaresFontFace,
  faceDescriptorMismatches,
  fontPreloadHrefs,
  initialAssetUrls,
  localDistAssetPath,
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
for (const sheet of APP_FONT_SHEETS) {
  const css = await readFile(path.join(repoRoot, sheet.path), 'utf8');
  for (const mismatch of faceDescriptorMismatches(css, FACE_METRICS)) {
    failures.push(`${sheet.path}: ${mismatch}`);
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
const HAN_ORDERS = [null, 'ja', 'zh-hans', 'zh-hant'] as const;
for (const hanOrder of HAN_ORDERS) {
  const attributes: Record<string, string> =
    hanOrder === null ? {} : { 'data-mxqr-han-order': hanOrder };
  const orderLabel = `Han order ${hanOrder ?? 'ko'}`;
  check(
    JSON.stringify(fontStacks.fontSans({ htmlLang: 'ko', attributes })) ===
      JSON.stringify(fontStacks.fontSans({ htmlLang: 'en', attributes })),
    `the Korean and English UIs read different font stacks (${orderLabel})`,
  );
  for (const { code, htmlLang } of LANGUAGE_OPTIONS) {
    const stack = fontStacks.fontSans({ htmlLang, dir: languageDirection(code), attributes });
    const where = `the ${code} UI font stack (${orderLabel})`;
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

// ── Source: one source per script, and coverage ────────────────────

const resolver = await readFaceResolver(repoRoot, APP_FONT_SHEETS);
const interCodePoints = new Set<number>();
for (const sheet of APP_FONT_SHEETS.filter(({ family }) => family === 'Inter')) {
  const css = await readFile(path.join(repoRoot, sheet.path), 'utf8');
  for (const url of woff2Urls(css)) {
    const file = path.join(repoRoot, path.dirname(sheet.path), url);
    for (const codePoint of fontCodePoints(await openFontFile(file)))
      interCodePoints.add(codePoint);
  }
}
const isHangul = (codePoint: number) =>
  (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
  (codePoint >= 0x3130 && codePoint <= 0x318f) ||
  (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
  (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
  (codePoint >= 0xd7b0 && codePoint <= 0xd7ff);
const isKana = (codePoint: number) =>
  (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
  (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
  (codePoint >= 0xff66 && codePoint <= 0xff9f);
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
  [
    'Hangul',
    Array.from({ length: 0xd800 - 0x1100 }, (_, index) => 0x1100 + index).filter(isHangul),
    'Noto Sans KR',
  ],
  [
    'kana',
    Array.from({ length: 0x3100 - 0x3041 }, (_, index) => 0x3041 + index).filter(isKana),
    'Noto Sans JP',
  ],
];
const representativeUis = ['ko', 'en', 'ja', 'zh-hans', 'zh-hant', 'th', 'ar', 'hi'] as const;
for (const code of representativeUis) {
  const option = LANGUAGE_OPTIONS.find((language) => language.code === code);
  if (!option) continue;
  for (const hanOrder of HAN_ORDERS) {
    const attributes: Record<string, string> =
      hanOrder === null ? {} : { 'data-mxqr-han-order': hanOrder };
    const stack = fontStacks.fontSans({
      htmlLang: option.htmlLang,
      dir: languageDirection(code),
      attributes,
    });
    for (const [label, codePoints, owner] of ownerChecks) {
      const strays = codePoints.filter((codePoint) => {
        const face = resolver.faceFor(stack, codePoint);
        return face !== null && face.family !== owner;
      });
      check(
        strays.length === 0,
        `${label} in the ${code} UI (Han order ${hanOrder ?? 'ko'}) come from a family other than ${owner}: ${strays
          .slice(0, 8)
          .map(hex)
          .join(', ')}`,
      );
    }
    const missingHangul = hangulSyllables.filter(
      (codePoint) => !resolver.faceFor(stack, codePoint),
    );
    check(
      missingHangul.length === 0,
      `${code} UI: ${missingHangul.length} Hangul syllables have no face`,
    );
  }
}

const isPrivateUse = (codePoint: number) =>
  (codePoint >= 0xe000 && codePoint <= 0xf8ff) || codePoint >= 0xf0000;
const isControlOrSpace = (codePoint: number) =>
  codePoint <= 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
const required = new Set<number>();
for (const codePoint of fontCodePoints(await openFontFile(PRETENDARD_SOURCE))) {
  if (!isPrivateUse(codePoint) && !isControlOrSpace(codePoint)) required.add(codePoint);
}
for (const source of [...LANGUAGE_OPTIONS.map(({ code }) => `src/i18n/${code}.ts`), 'index.html']) {
  for (const character of await readFile(path.join(repoRoot, source), 'utf8')) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (!isControlOrSpace(codePoint)) required.add(codePoint);
  }
}
const koreanStack = fontStacks.fontSans({ htmlLang: 'ko' });
const uncovered = [...required].filter((codePoint) => !resolver.faceFor(koreanStack, codePoint));
const recordedUncovered = new Set(
  (await readFile(path.join(repoRoot, UNCOVERED_LIST), 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^U\+[0-9A-F]{4,6}$/u.test(line))
    .map((line) => Number.parseInt(line.slice(2), 16)),
);
const newGaps = uncovered.filter((codePoint) => !recordedUncovered.has(codePoint));
check(
  newGaps.length === 0,
  `${newGaps.length} characters the app may show have no self-hosted face in the Korean and English stack: ${newGaps
    .slice(0, 12)
    .map(hex)
    .join(', ')}`,
);
const staleGaps = [...recordedUncovered].filter((codePoint) => !uncovered.includes(codePoint));
check(
  staleGaps.length === 0,
  `${UNCOVERED_LIST} lists ${staleGaps.length} characters that now have a face: ${staleGaps
    .slice(0, 12)
    .map(hex)
    .join(', ')}`,
);

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
    `App font guard passed (Inter and Noto files and sheets, stacks, one source per script, coverage with ${uncovered.length} recorded gaps${distMode ? ', built sheets, initial graph and install manifests' : ''}).`,
  );
}
