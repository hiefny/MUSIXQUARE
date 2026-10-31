#!/usr/bin/env node
/**
 * Generate the app's font sheets in css/fonts/app/ (see APP_FONT_SHEETS in
 * src/i18n/app-font-contract.ts).
 *
 *   npm run generate:font-sheets              write the sheets and the prefetch table
 *   npm run generate:font-sheets -- --check   fail when a committed output differs
 *
 * Inputs: fonts/font-sources.json (Inter and Noto Sans KR files with Google's
 * ranges), Google's sheets css/fonts/noto-{jp,sc,tc,thai}.css (read, never
 * changed: the static pages keep using them), the cmaps of fonts/inter/, and
 * the descriptors in src/i18n/font-metrics.ts.
 *
 * The range edits give every script exactly one family, so no browser can
 * draw one script from two families:
 * - Inter keeps Google's subsets and ranges unchanged.
 * - The four CJK families keep their numbered shards only. Each face keeps
 *   only the code points its own file draws: Google's ranges also claim
 *   characters some shards lack (emoji, a few Thai, Arabic, Hebrew and
 *   Devanagari letters), and with every CJK family in every UI's stack the
 *   browser would download such a shard for nothing before moving on. Each
 *   face also loses every code point Inter draws, which is Inter's cmap
 *   inside Inter's own ranges (cutting by Inter's declared ranges would drop
 *   marks Inter lacks, such as U+203B and U+203C, to a device font chosen by
 *   html lang). Hangul stays only in Noto Sans KR and kana only in Noto Sans
 *   JP. The invisible and space marks U+200B-200F, U+202F, U+2060-2064 and
 *   U+FEFF leave all four, so the device font draws them. A face left with
 *   nothing is dropped.
 * - Noto Sans Thai keeps only its Thai face, unchanged.
 * - Inter and the CJK faces carry the size-adjust and metric overrides of
 *   src/i18n/font-metrics.ts; the script faces carry none.
 *
 * It also writes src/i18n/font-prefetch-samples.ts, the idle prefetch table
 * of src/i18n/locale-fonts.ts: for the Korean, Japanese and Chinese UIs, the
 * most frequent shards of their own family (Google numbers shards by
 * frequency, the highest first) that fit within the face and byte caps of
 * src/i18n/font-loading-policy.ts, each with one letter only it declares.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { APP_FONT_SHEETS } from '../../src/i18n/app-font-contract.ts';
import {
  FONT_PREFETCH_MAX_BYTES,
  FONT_PREFETCH_MAX_FACES,
} from '../../src/i18n/font-loading-policy.ts';
import { CJK_FACE_METRICS, INTER_FACE_METRICS } from '../../src/i18n/font-metrics.ts';
import {
  fontCodePoints,
  formatUnicodeRange,
  openFontFile,
  parseFontFaceRules,
  parseUnicodeRange,
  readFontSources,
  type FontFaceRule,
  type FontSources,
} from './font-files.mts';

export interface GeneratedFontSheet {
  readonly path: string;
  readonly css: string;
}

export interface GeneratedFontFile {
  readonly path: string;
  readonly text: string;
}

type Range = readonly [number, number];
type FaceMetrics = typeof INTER_FACE_METRICS;

const GENERATOR = 'scripts/fonts/build-font-sheets.mts';
const OUTPUT_DIRECTORY = 'css/fonts/app';
const PREFETCH_TABLE = 'src/i18n/font-prefetch-samples.ts';
/** The UI languages with a prefetch list, and the family that draws their own words. */
const PREFETCH_LANGUAGES = [
  ['ko', 'font-noto-kr'],
  ['ja', 'font-noto-jp'],
  ['zh-hans', 'font-noto-sc'],
  ['zh-hant', 'font-noto-tc'],
] as const;
const HANGUL: readonly Range[] = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xd7b0, 0xd7ff],
];
const KANA: readonly Range[] = [
  [0x3040, 0x30ff],
  [0x31f0, 0x31ff],
  [0xff66, 0xff9f],
];
const INVISIBLE: readonly Range[] = [
  [0x200b, 0x200f],
  [0x202f, 0x202f],
  [0x2060, 0x2064],
  [0xfeff, 0xfeff],
];
const INVISIBLE_TEXT = 'U+200B-200F, U+202F, U+2060-2064 and U+FEFF';
/** The only descriptors a Google CJK face may carry; anything new must be reviewed here. */
const GOOGLE_CJK_DESCRIPTORS = new Map([
  ['font-style', 'normal'],
  ['font-weight', '100 900'],
  ['font-display', 'swap'],
]);

interface CjkFamily {
  readonly id: string;
  /** Google's sheet in css/fonts/, or null for Noto Sans KR from the record. */
  readonly googleSheet: string | null;
  readonly dropHangul: boolean;
  readonly dropKana: boolean;
}

const CJK_FAMILIES: readonly CjkFamily[] = [
  { id: 'font-noto-kr', googleSheet: null, dropHangul: false, dropKana: true },
  { id: 'font-noto-jp', googleSheet: 'css/fonts/noto-jp.css', dropHangul: true, dropKana: false },
  { id: 'font-noto-sc', googleSheet: 'css/fonts/noto-sc.css', dropHangul: true, dropKana: true },
  { id: 'font-noto-tc', googleSheet: 'css/fonts/noto-tc.css', dropHangul: true, dropKana: true },
];

interface SourceFace {
  /** Repository path of the WOFF2 file. */
  readonly file: string;
  readonly codePoints: ReadonlySet<number>;
}

const inRanges = (codePoint: number, ranges: readonly Range[]): boolean =>
  ranges.some(([start, end]) => codePoint >= start && codePoint <= end);

function appSheet(id: string): (typeof APP_FONT_SHEETS)[number] {
  const sheet = APP_FONT_SHEETS.find((entry) => entry.id === id);
  if (!sheet) throw new Error(`${id} is not in APP_FONT_SHEETS`);
  return sheet;
}

function headerValue(css: string, label: string, sheetPath: string): string {
  const value = new RegExp(`${label}: (\\S+)`, 'u').exec(css)?.[1];
  if (!value) throw new Error(`${sheetPath} has no "${label}:" header line`);
  return value;
}

function comment(lines: readonly string[]): string {
  const [first, ...rest] = lines;
  return [`/* ${first ?? ''}`, ...rest.map((line) => ` * ${line}`), ' */'].join('\n');
}

function metricDeclarations(metrics: FaceMetrics | null): string[] {
  if (!metrics) return [];
  return [
    `size-adjust: ${metrics.sizeAdjust}%`,
    `ascent-override: ${metrics.ascentOverride}%`,
    `descent-override: ${metrics.descentOverride}%`,
    `line-gap-override: ${metrics.lineGapOverride}%`,
  ];
}

function fontFace(
  family: string,
  metrics: FaceMetrics,
  sheetPath: string,
  file: string,
  unicodeRange: string,
): string {
  return block([
    `font-family: '${family}'`,
    'font-style: normal',
    'font-weight: 100 900',
    'font-display: swap',
    ...metricDeclarations(metrics),
    `src: url(${path.posix.relative(path.posix.dirname(sheetPath), file)}) format('woff2')`,
    `unicode-range: ${unicodeRange}`,
  ]);
}

function block(declarations: readonly string[]): string {
  return ['@font-face {', ...declarations.map((line) => `  ${line};`), '}'].join('\n');
}

function sheetText(header: readonly string[], faces: readonly string[]): string {
  return `${comment(header)}\n${faces.join('\n\n')}\n`;
}

function repoPathOf(sheetPath: string, url: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(sheetPath), url));
}

async function interSheet(
  repoRoot: string,
  sources: FontSources,
): Promise<{ css: string; drawn: Set<number> }> {
  const { inter } = sources;
  const sheet = appSheet('font-inter');
  const drawn = new Set<number>();
  const faces: string[] = [];
  for (const face of inter.faces) {
    const file = `${inter.directory}/${face.file}`;
    const declared = parseUnicodeRange(face.unicodeRange);
    for (const codePoint of fontCodePoints(await openFontFile(path.join(repoRoot, file)))) {
      if (declared.has(codePoint)) drawn.add(codePoint);
    }
    faces.push(fontFace(sheet.family, INTER_FACE_METRICS, sheet.path, file, face.unicodeRange));
  }
  if (drawn.size === 0) throw new Error('Inter draws no code point');
  const css = sheetText(
    [
      'Inter for the app.',
      `Generated by ${GENERATOR} from fonts/font-sources.json. Do not edit by hand.`,
      `Faces: Inter ${inter.version}, one per Google subset of ${inter.sourceCss}, with Google's files and unicode-range.`,
      'Metrics: src/i18n/font-metrics.ts',
      `License: ${inter.license} (SIL OFL 1.1)`,
    ],
    faces,
  );
  return { css, drawn };
}

async function googleCjkFaces(
  repoRoot: string,
  googleSheet: string,
  family: string,
): Promise<{ faces: SourceFace[]; css: string }> {
  const css = await readFile(path.join(repoRoot, googleSheet), 'utf8');
  const faces: SourceFace[] = [];
  for (const rule of parseFontFaceRules(css)) {
    if (!/\.\d+\.woff2$/u.test(rule.file)) continue;
    assertGoogleCjkRule(rule, family, googleSheet);
    faces.push({
      file: repoPathOf(googleSheet, rule.url),
      codePoints: parseUnicodeRange(rule.unicodeRange ?? ''),
    });
  }
  return { faces, css };
}

function assertGoogleCjkRule(rule: FontFaceRule, family: string, sheetPath: string): void {
  if (rule.family !== family || !rule.unicodeRange) {
    throw new Error(`${sheetPath}: ${rule.file} is not a ${family} face with a unicode-range`);
  }
  for (const [name, value] of rule.declarations) {
    if (['font-family', 'src', 'unicode-range'].includes(name)) continue;
    if (GOOGLE_CJK_DESCRIPTORS.get(name) !== value) {
      throw new Error(`${sheetPath}: ${rule.file} has an unexpected ${name}: ${value}`);
    }
  }
}

async function cjkSheet(
  repoRoot: string,
  sources: FontSources,
  recipe: CjkFamily,
  interDrawn: ReadonlySet<number>,
): Promise<string> {
  const sheet = appSheet(recipe.id);
  let sourceFaces: SourceFace[];
  let origin: string[];
  let license: string;
  if (recipe.googleSheet === null) {
    const { notoSansKr } = sources;
    sourceFaces = notoSansKr.faces.map((face) => ({
      file: `${notoSansKr.directory}/${face.file}`,
      codePoints: parseUnicodeRange(face.unicodeRange),
    }));
    origin = [
      `Generated by ${GENERATOR} from fonts/font-sources.json. Do not edit by hand.`,
      `Faces: ${sheet.family} ${notoSansKr.version}, the numbered shards of ${notoSansKr.sourceCss}, shipped without the Korean locl lookup (scripts/fonts/build-noto-kr-nolocl.mts).`,
    ];
    license = notoSansKr.license;
  } else {
    const google = await googleCjkFaces(repoRoot, recipe.googleSheet, sheet.family);
    sourceFaces = google.faces;
    origin = [
      `Generated by ${GENERATOR} from ${recipe.googleSheet}. Do not edit by hand.`,
      `Faces: the numbered shards of that sheet (${headerValue(google.css, 'Source CSS', recipe.googleSheet)}).`,
    ];
    license = headerValue(google.css, 'License', recipe.googleSheet);
  }
  const dropped = [
    "every code point the face's own file lacks",
    'every code point Inter draws (its cmap inside its own ranges)',
    ...(recipe.dropHangul ? ['Hangul'] : []),
    ...(recipe.dropKana ? ['kana'] : []),
    `the invisible marks ${INVISIBLE_TEXT}`,
  ];
  const faces: string[] = [];
  for (const face of sourceFaces) {
    const drawn = fontCodePoints(await openFontFile(path.join(repoRoot, face.file)));
    const kept = [...face.codePoints].filter(
      (codePoint) =>
        drawn.has(codePoint) &&
        !interDrawn.has(codePoint) &&
        !(recipe.dropHangul && inRanges(codePoint, HANGUL)) &&
        !(recipe.dropKana && inRanges(codePoint, KANA)) &&
        !inRanges(codePoint, INVISIBLE),
    );
    if (kept.length === 0) continue;
    faces.push(
      fontFace(sheet.family, CJK_FACE_METRICS, sheet.path, face.file, formatUnicodeRange(kept)),
    );
  }
  return sheetText(
    [
      `${sheet.family} for the app.`,
      ...origin,
      `Ranges: Google's, minus ${dropped.slice(0, -1).join(', ')} and ${dropped.at(-1) ?? ''}. Faces left with no code point are dropped.`,
      'Metrics: src/i18n/font-metrics.ts',
      `License: ${license} (SIL OFL 1.1)`,
    ],
    faces,
  );
}

async function thaiSheet(repoRoot: string): Promise<string> {
  const sheet = appSheet('font-noto-thai');
  const googleSheet = 'css/fonts/noto-thai.css';
  const css = await readFile(path.join(repoRoot, googleSheet), 'utf8');
  const thai = parseFontFaceRules(css).filter((rule) =>
    parseUnicodeRange(rule.unicodeRange ?? '').has(0x0e01),
  );
  const [rule] = thai;
  if (thai.length !== 1 || !rule || rule.family !== sheet.family) {
    throw new Error(`${googleSheet} must hold exactly one ${sheet.family} face for U+0E01`);
  }
  const url = path.posix.relative(
    path.posix.dirname(sheet.path),
    repoPathOf(googleSheet, rule.url),
  );
  const declarations = [...rule.declarations].map(([name, value]) =>
    name === 'src' ? `${name}: ${value.replace(rule.url, url)}` : `${name}: ${value}`,
  );
  return sheetText(
    [
      `${sheet.family} for the app.`,
      `Generated by ${GENERATOR} from ${googleSheet}. Do not edit by hand.`,
      `Face: the Thai face of that sheet (${headerValue(css, 'Source CSS', googleSheet)}), unchanged. Inter draws the ranges of its Latin faces.`,
      `License: ${headerValue(css, 'License', googleSheet)} (SIL OFL 1.1)`,
    ],
    [block(declarations)],
  );
}

/** The generated sheets in APP_FONT_SHEETS order. */
export async function buildFontSheets(repoRoot: string): Promise<GeneratedFontSheet[]> {
  const sources = await readFontSources(repoRoot);
  const inter = await interSheet(repoRoot, sources);
  const built = new Map<string, string>([['font-inter', inter.css]]);
  for (const recipe of CJK_FAMILIES) {
    built.set(recipe.id, await cjkSheet(repoRoot, sources, recipe, inter.drawn));
  }
  built.set('font-noto-thai', await thaiSheet(repoRoot));
  return APP_FONT_SHEETS.filter(({ path: sheetPath }) =>
    sheetPath.startsWith(`${OUTPUT_DIRECTORY}/`),
  ).map(({ id, path: sheetPath }) => {
    const css = built.get(id);
    if (css === undefined) throw new Error(`${GENERATOR} has no recipe for ${id}`);
    return { path: sheetPath, css };
  });
}

function shardNumber(file: string): number {
  const shard = /\.(\d+)\.woff2$/u.exec(file)?.[1];
  if (shard === undefined) throw new Error(`${file} is not a numbered shard`);
  return Number(shard);
}

/** The first letter (BMP first) that a face declares and no other face of its family does. */
function sampleLetter(
  own: ReadonlySet<number>,
  others: readonly ReadonlySet<number>[],
  where: string,
): string {
  const letters = [...own]
    .sort((left, right) => left - right)
    .filter(
      (codePoint) =>
        /\p{L}/u.test(String.fromCodePoint(codePoint)) &&
        !others.some((other) => other.has(codePoint)),
    );
  const sample = letters.find((codePoint) => codePoint <= 0xffff) ?? letters[0];
  if (sample === undefined) throw new Error(`${where} declares no letter of its own`);
  return String.fromCodePoint(sample);
}

/**
 * src/i18n/font-prefetch-samples.ts for the given generated sheets (the
 * generator output when omitted), formatted as the repository formats it.
 */
export async function buildFontPrefetchSamples(
  repoRoot: string,
  sheets?: readonly GeneratedFontSheet[],
): Promise<GeneratedFontFile> {
  const generated = sheets ?? (await buildFontSheets(repoRoot));
  const lists: string[] = [];
  for (const [code, id] of PREFETCH_LANGUAGES) {
    const sheet = appSheet(id);
    const css = generated.find(({ path: sheetPath }) => sheetPath === sheet.path)?.css;
    if (css === undefined) throw new Error(`${GENERATOR} did not generate ${sheet.path}`);
    const faces = parseFontFaceRules(css)
      .map((rule) => ({
        shard: shardNumber(rule.file),
        file: repoPathOf(sheet.path, rule.url),
        codePoints: parseUnicodeRange(rule.unicodeRange ?? ''),
      }))
      .sort((left, right) => right.shard - left.shard);
    const shards: string[] = [];
    let total = 0;
    for (const face of faces) {
      const bytes = (await stat(path.join(repoRoot, face.file))).size;
      if (shards.length + 1 > FONT_PREFETCH_MAX_FACES || total + bytes > FONT_PREFETCH_MAX_BYTES) {
        break;
      }
      total += bytes;
      const sample = sampleLetter(
        face.codePoints,
        faces.filter((other) => other !== face).map((other) => other.codePoints),
        `${sheet.family} #${face.shard}`,
      );
      shards.push(`{ shard: ${face.shard}, sample: '${sample}', bytes: ${bytes} }`);
    }
    lists.push(`'${code}': { family: '${sheet.family}', shards: [${shards.join(', ')}] }`);
  }
  const raw = `/**
 * The idle prefetch table: phase C of src/i18n/locale-fonts.ts.
 *
 * Generated by ${GENERATOR} from the app font
 * sheets. Do not edit by hand.
 *
 * For each UI language that draws its own words with a CJK family, the most
 * frequent shards of that family (Google numbers shards by frequency, the
 * highest first) that fit within FONT_PREFETCH_MAX_FACES and
 * FONT_PREFETCH_MAX_BYTES (src/i18n/font-loading-policy.ts). Each shard has
 * one letter only it declares in its family, which loads it, and its file size.
 */

import type { LanguageCode } from './locales.ts';

interface FontPrefetchShard {
  /** The shard's number in its family's sheet. */
  readonly shard: number;
  /** One letter only this shard declares. */
  readonly sample: string;
  /** The shard's WOFF2 size. */
  readonly bytes: number;
}

interface FontPrefetchList {
  readonly family: string;
  readonly shards: readonly FontPrefetchShard[];
}

export const FONT_PREFETCH_BY_LANGUAGE: Readonly<Partial<Record<LanguageCode, FontPrefetchList>>> = {
  ${lists.join(',\n  ')},
};
`;
  const prettier = await import('prettier');
  const filepath = path.join(repoRoot, PREFETCH_TABLE);
  const options = (await prettier.resolveConfig(filepath)) ?? {};
  return { path: PREFETCH_TABLE, text: await prettier.format(raw, { ...options, filepath }) };
}

/**
 * Paths in css/fonts/app/ that differ from the generator output, are missing,
 * or are not generated, and the prefetch table when it differs.
 */
export async function findStaleFontSheets(repoRoot: string): Promise<string[]> {
  const built = await buildFontSheets(repoRoot);
  const stale: string[] = [];
  const table = await buildFontPrefetchSamples(repoRoot, built);
  const committedTable = await readFile(path.join(repoRoot, table.path), 'utf8').catch(() => null);
  if (committedTable !== table.text) stale.push(table.path);
  for (const { path: sheetPath, css } of built) {
    let committed: string | null = null;
    try {
      committed = await readFile(path.join(repoRoot, sheetPath), 'utf8');
    } catch {
      committed = null;
    }
    if (committed !== css) stale.push(sheetPath);
  }
  const expected = new Set(built.map(({ path: sheetPath }) => path.posix.basename(sheetPath)));
  try {
    for (const file of await readdir(path.join(repoRoot, OUTPUT_DIRECTORY))) {
      if (!expected.has(file)) stale.push(`${OUTPUT_DIRECTORY}/${file}`);
    }
  } catch {
    // A missing folder already shows as missing sheets.
  }
  return stale;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (process.argv.includes('--check')) {
    const stale = await findStaleFontSheets(repoRoot);
    if (stale.length) {
      console.error(
        `App font sheets are out of date (run npm run generate:font-sheets):\n${stale.map((file) => `  - ${file}`).join('\n')}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('App font sheets match the generator.');
    return;
  }
  await mkdir(path.join(repoRoot, OUTPUT_DIRECTORY), { recursive: true });
  const sheets = await buildFontSheets(repoRoot);
  for (const { path: sheetPath, css } of sheets) {
    await writeFile(path.join(repoRoot, sheetPath), css, 'utf8');
    const faces = (css.match(/@font-face/gu) ?? []).length;
    console.log(`${sheetPath}: ${faces} faces, ${Buffer.byteLength(css)} B`);
  }
  const table = await buildFontPrefetchSamples(repoRoot, sheets);
  await writeFile(path.join(repoRoot, table.path), table.text, 'utf8');
  console.log(`${table.path}: written`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
