#!/usr/bin/env node
/**
 * Generate the app's font sheets in css/fonts/app/ (see APP_FONT_SHEETS in
 * src/i18n/app-font-contract.ts).
 *
 *   npm run generate:font-sheets              bake the app faces, then write the sheets and the prefetch table
 *   npm run generate:font-sheets -- --check   fail when a committed output differs
 *
 * Inputs: fonts/font-sources.json (Inter and Noto Sans KR files with Google's
 * ranges), Google's sheets css/fonts/noto-{jp,sc,tc,thai}.css (read, never
 * changed: the static pages keep using them), the cmaps of the input files,
 * the descriptors in src/i18n/font-metrics.ts, and fonts/app-faces.json.
 *
 * The Inter and CJK faces point at the copies in fonts/app/ that
 * scripts/fonts/build-app-faces.mts bakes the line box of
 * src/i18n/font-metrics.ts into; the cuts below read the input files, whose
 * cmaps the copies keep. The first stage of the write mode runs that
 * generator, which bakes only new or changed faces.
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
 *   html lang). Hangul that Noto Sans KR draws stays only in KR and kana
 *   that Noto Sans JP draws only in JP, each found by block or by Unicode
 *   Script (parenthesized and circled Hangul such as ㈜ and ㉠, circled and
 *   square katakana such as ㋖ and ㌔ sit outside the blocks); a character the
 *   owner lacks, such as the halfwidth jamo, stays in the family that draws
 *   it. The invisible and space marks U+200B-200F, U+202F, U+2060-2064 and
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
  APP_FACES_PATH,
  appFaceOutputs,
  fontCodePoints,
  formatUnicodeRange,
  openFontFile,
  parseFontFaceRules,
  parseUnicodeRange,
  readAppFaces,
  readFontSources,
  verifyAppFaces,
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

/** The repository path of a face's baked copy, by its input's path. */
type BakedPath = (input: string) => string;

/** Inter's faces (input files and Google's ranges) and the code points they draw. */
async function interFaces(
  repoRoot: string,
  sources: FontSources,
): Promise<{ faces: { file: string; unicodeRange: string }[]; drawn: Set<number> }> {
  const { inter } = sources;
  const drawn = new Set<number>();
  const faces: { file: string; unicodeRange: string }[] = [];
  for (const face of inter.faces) {
    const file = `${inter.directory}/${face.file}`;
    const declared = parseUnicodeRange(face.unicodeRange);
    for (const codePoint of fontCodePoints(await openFontFile(path.join(repoRoot, file)))) {
      if (declared.has(codePoint)) drawn.add(codePoint);
    }
    faces.push({ file, unicodeRange: face.unicodeRange });
  }
  if (drawn.size === 0) throw new Error('Inter draws no code point');
  return { faces, drawn };
}

function interSheet(
  sources: FontSources,
  faces: readonly { file: string; unicodeRange: string }[],
  baked: BakedPath,
): string {
  const { inter } = sources;
  const sheet = appSheet('font-inter');
  return sheetText(
    [
      'Inter for the app.',
      `Generated by ${GENERATOR} from fonts/font-sources.json and ${APP_FACES_PATH}. Do not edit by hand.`,
      `Faces: Inter ${inter.version}, one per Google subset of ${inter.sourceCss}, with Google's unicode-range. Each file is Google's with the line box of src/i18n/font-metrics.ts baked in (scripts/fonts/build-app-faces.mts).`,
      'Metrics: src/i18n/font-metrics.ts',
      `License: ${inter.license} (SIL OFL 1.1)`,
    ],
    faces.map(({ file, unicodeRange }) =>
      fontFace(sheet.family, INTER_FACE_METRICS, sheet.path, baked(file), unicodeRange),
    ),
  );
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

/** Hangul by block or by Script=Hangul: ㈜ and ㉠ sit outside the Hangul blocks. */
const isHangul = (codePoint: number): boolean =>
  inRanges(codePoint, HANGUL) || /\p{Script=Hangul}/u.test(String.fromCodePoint(codePoint));

/** Kana by block or by Script=Hiragana/Katakana: ㋖ and ㌔ sit outside the kana blocks. */
const isKana = (codePoint: number): boolean =>
  inRanges(codePoint, KANA) ||
  /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(String.fromCodePoint(codePoint));

/** A CJK family's faces before the cut by script: each face with the code points it keeps. */
interface CjkFaces {
  readonly recipe: CjkFamily;
  readonly origin: readonly string[];
  readonly license: string;
  readonly faces: readonly { readonly file: string; readonly kept: readonly number[] }[];
}

/**
 * A CJK family's faces with Google's ranges minus every code point the face's
 * own file lacks, every code point Inter draws and the invisible marks.
 */
async function cjkFaces(
  repoRoot: string,
  sources: FontSources,
  recipe: CjkFamily,
  interDrawn: ReadonlySet<number>,
): Promise<CjkFaces> {
  const sheet = appSheet(recipe.id);
  let sourceFaces: SourceFace[];
  let origin: string[];
  let license: string;
  const baking = `with the line box of src/i18n/font-metrics.ts baked in (scripts/fonts/build-app-faces.mts)`;
  if (recipe.googleSheet === null) {
    const { notoSansKr } = sources;
    sourceFaces = notoSansKr.faces.map((face) => ({
      file: `${notoSansKr.directory}/${face.file}`,
      codePoints: parseUnicodeRange(face.unicodeRange),
    }));
    origin = [
      `Generated by ${GENERATOR} from fonts/font-sources.json and ${APP_FACES_PATH}. Do not edit by hand.`,
      `Faces: ${sheet.family} ${notoSansKr.version}, the numbered shards of ${notoSansKr.sourceCss}, shipped without the Korean locl lookup (scripts/fonts/build-noto-kr-nolocl.mts) and ${baking}.`,
    ];
    license = notoSansKr.license;
  } else {
    const google = await googleCjkFaces(repoRoot, recipe.googleSheet, sheet.family);
    sourceFaces = google.faces;
    origin = [
      `Generated by ${GENERATOR} from ${recipe.googleSheet} and ${APP_FACES_PATH}. Do not edit by hand.`,
      `Faces: the numbered shards of that sheet (${headerValue(google.css, 'Source CSS', recipe.googleSheet)}), ${baking}.`,
    ];
    license = headerValue(google.css, 'License', recipe.googleSheet);
  }
  const faces: { file: string; kept: number[] }[] = [];
  for (const face of sourceFaces) {
    const drawn = fontCodePoints(await openFontFile(path.join(repoRoot, face.file)));
    const kept = [...face.codePoints].filter(
      (codePoint) =>
        drawn.has(codePoint) && !interDrawn.has(codePoint) && !inRanges(codePoint, INVISIBLE),
    );
    faces.push({ file: face.file, kept });
  }
  return { recipe, origin, license, faces };
}

/**
 * A CJK family's faces minus the Hangul that Noto Sans KR draws (for every
 * family but KR) and the kana that Noto Sans JP draws (for every family but
 * JP), each by block or by script property. A character the owning family
 * lacks, such as the halfwidth jamo only JP draws, stays where it is drawn. A
 * face left with nothing is dropped.
 */
function keptFaces(
  family: CjkFaces,
  koreanHangul: ReadonlySet<number>,
  japaneseKana: ReadonlySet<number>,
): { file: string; kept: number[] }[] {
  const { recipe } = family;
  return family.faces
    .map((face) => ({
      file: face.file,
      kept: face.kept.filter(
        (codePoint) =>
          !(recipe.dropHangul && koreanHangul.has(codePoint)) &&
          !(recipe.dropKana && japaneseKana.has(codePoint)),
      ),
    }))
    .filter(({ kept }) => kept.length > 0);
}

/** A CJK family's sheet: its kept faces, each pointing at its baked copy. */
function cjkSheet(
  family: CjkFaces,
  faces: readonly { file: string; kept: readonly number[] }[],
  baked: BakedPath,
): string {
  const { recipe, origin, license } = family;
  const sheet = appSheet(recipe.id);
  const dropped = [
    "every code point the face's own file lacks",
    'every code point Inter draws (its cmap inside its own ranges)',
    ...(recipe.dropHangul ? ['the Hangul Noto Sans KR draws (by block or script)'] : []),
    ...(recipe.dropKana ? ['the kana Noto Sans JP draws (by block or script)'] : []),
    `the invisible marks ${INVISIBLE_TEXT}`,
  ];
  return sheetText(
    [
      `${sheet.family} for the app.`,
      ...origin,
      `Ranges: Google's, minus ${dropped.slice(0, -1).join(', ')} and ${dropped.at(-1) ?? ''}. Faces left with no code point are dropped.`,
      'Metrics: src/i18n/font-metrics.ts',
      `License: ${license} (SIL OFL 1.1)`,
    ],
    faces.map(({ file, kept }) =>
      fontFace(sheet.family, CJK_FACE_METRICS, sheet.path, baked(file), formatUnicodeRange(kept)),
    ),
  );
}

/** The code points of a family's faces that a script test holds. */
function familyCodePoints(family: CjkFaces, test: (codePoint: number) => boolean): Set<number> {
  const codePoints = new Set<number>();
  for (const face of family.faces) {
    for (const codePoint of face.kept) if (test(codePoint)) codePoints.add(codePoint);
  }
  return codePoints;
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

/** Every Inter and CJK face the app sheets keep, by its input file, after the cuts. */
interface KeptAppFaces {
  readonly sources: FontSources;
  readonly inter: readonly { file: string; unicodeRange: string }[];
  readonly cjk: readonly { family: CjkFaces; faces: { file: string; kept: number[] }[] }[];
}

async function computeKeptFaces(repoRoot: string): Promise<KeptAppFaces> {
  const sources = await readFontSources(repoRoot);
  const inter = await interFaces(repoRoot, sources);
  const families: CjkFaces[] = [];
  for (const recipe of CJK_FAMILIES) {
    families.push(await cjkFaces(repoRoot, sources, recipe, inter.drawn));
  }
  const owner = (id: string): CjkFaces => {
    const family = families.find(({ recipe }) => recipe.id === id);
    if (!family) throw new Error(`${GENERATOR} has no recipe for ${id}`);
    return family;
  };
  const koreanHangul = familyCodePoints(owner('font-noto-kr'), isHangul);
  const japaneseKana = familyCodePoints(owner('font-noto-jp'), isKana);
  return {
    sources,
    inter: inter.faces,
    cjk: families.map((family) => ({
      family,
      faces: keptFaces(family, koreanHangul, japaneseKana),
    })),
  };
}

/**
 * The input files of the faces the app sheets keep, by sheet id (Inter and the
 * four CJK families, in sheet order): the files scripts/fonts/build-app-faces.mts
 * bakes.
 */
export async function appFaceInputs(
  repoRoot: string,
): Promise<{ readonly sheet: string; readonly files: readonly string[] }[]> {
  const kept = await computeKeptFaces(repoRoot);
  return [
    { sheet: 'font-inter', files: kept.inter.map(({ file }) => file) },
    ...kept.cjk.map(({ family, faces }) => ({
      sheet: family.recipe.id,
      files: faces.map(({ file }) => file),
    })),
  ];
}

/** The baked copy of each input file, from fonts/app-faces.json. */
async function bakedPaths(repoRoot: string): Promise<BakedPath> {
  const outputs = appFaceOutputs(await readAppFaces(repoRoot));
  return (input) => {
    const output = outputs.get(input);
    if (!output) {
      throw new Error(
        `${APP_FACES_PATH} has no baked copy of ${input}; run npm run generate:app-faces`,
      );
    }
    return output;
  };
}

/** The generated sheets in APP_FONT_SHEETS order. */
export async function buildFontSheets(repoRoot: string): Promise<GeneratedFontSheet[]> {
  const kept = await computeKeptFaces(repoRoot);
  const baked = await bakedPaths(repoRoot);
  const built = new Map<string, string>([
    ['font-inter', interSheet(kept.sources, kept.inter, baked)],
  ]);
  for (const { family, faces } of kept.cjk) {
    built.set(family.recipe.id, cjkSheet(family, faces, baked));
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
      .map((rule, place) => ({
        shard: shardNumber(rule.file),
        place,
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
      shards.push(
        `{ shard: ${face.shard}, face: ${face.place}, sample: '${sample}', bytes: ${bytes} }`,
      );
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
 * its face's place in the sheet, one letter only it declares in its family,
 * which loads it, and its file size.
 */

import type { LanguageCode } from './locales.ts';

interface FontPrefetchShard {
  /** The shard's number in its family's sheet. */
  readonly shard: number;
  /**
   * The place of the shard's face among its family's faces in the sheet,
   * which phase C reads first instead of scanning every face's unicode-range.
   */
  readonly face: number;
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
    const faces = await verifyAppFaces(repoRoot);
    if (faces.length) {
      console.error(
        `The baked app faces do not match ${APP_FACES_PATH}:\n${faces.map((line) => `  - ${line}`).join('\n')}`,
      );
      process.exitCode = 1;
    }
    const stale = await findStaleFontSheets(repoRoot);
    if (stale.length) {
      console.error(
        `App font sheets are out of date (run npm run generate:font-sheets):\n${stale.map((file) => `  - ${file}`).join('\n')}`,
      );
      process.exitCode = 1;
    }
    if (faces.length || stale.length) return;
    console.log('The baked app faces match their record and the app font sheets the generator.');
    return;
  }
  // The baked faces first: the sheets name their files. A dynamic import, as
  // the face generator reads appFaceInputs from this module.
  const { buildAppFaces } = await import('./build-app-faces.mts');
  await buildAppFaces(repoRoot, 'write');
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
