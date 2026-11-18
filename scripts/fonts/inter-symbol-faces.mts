/**
 * Inter's symbol faces (owner decisions 2026-11-17 and 2026-11-18): the
 * symbols the full Inter draws and Google's Inter subsets lack, served as
 * seven faces after Google's seven in css/fonts/app/font-inter.css.
 *
 * The owner decided on 2026-11-17 that Inter draws Latin and its symbols in
 * Inter's base forms and the digits in its tabular forms, and on 2026-11-18
 * which symbols. Google serves Inter only as seven subsets (fonts/inter/),
 * which lack ※ → ≤ ≈ ★ ✓ and the rest, so Noto Sans KR or JP, or a device
 * font, drew those beside Inter's ± × ÷ ↑ ↓. The symbol faces are cut from the
 * full Inter (fonts/inter-full.ttf, interFull in fonts/font-sources.json),
 * the build the subsets were cut from, by
 * scripts/fonts/build-inter-symbol-faces.mts.
 *
 * The selection: every code point the full Inter maps and no Google subset
 * maps, but the INTER_SYMBOL_EXCLUSIONS (private use, combining marks, emoji
 * presentation, and by owner decision the enclosed alphanumerics and U+21A9,
 * U+21AA, U+23CF and U+2764). INTER_SYMBOL_FACE_SPECS partitions it by block:
 * each code point goes to the first face that holds it, a face left with
 * none is dropped, and a code point no face holds stops the run. A page
 * downloads a face only when it shows one of its code points, so the common
 * symbols sit in small faces and the rare sets in faces of their own.
 *
 * fonts/inter-symbol-faces.json records the source, the tool versions, the
 * rule and what each exclusion left out, the layout features and name
 * records the faces keep, the line box baked into them and each face's code
 * points (its cmap) and digest. Only the generator writes it;
 * verifyInterSymbolFaces checks the files against it without cutting them
 * again.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { INTER_FACE_METRICS } from '../../src/i18n/font-metrics.ts';
import {
  readLineMetrics,
  sfntChecksumsValid,
  sfntTables,
  type BakedLineBox,
} from './app-face-metrics.mts';
import {
  FONT_SOURCES_PATH,
  INTER_AXES,
  INTER_FULL_PATH,
  INTER_SYMBOL_FACES_DIRECTORY,
  decodeFontBytes,
  digestOf,
  fontCodePoints,
  fontLayoutFeatures,
  formatUnicodeRange,
  interBuild,
  isWoff2,
  openFontBytes,
  parseUnicodeRange,
  readFontSources,
  type FontSources,
} from './font-files.mts';
import { readNameTable } from './sfnt-names.mts';

export { INTER_SYMBOL_FACES_DIRECTORY } from './font-files.mts';

export const INTER_SYMBOL_FACES_PATH = 'fonts/inter-symbol-faces.json';
/** The tools whose versions the record keeps. */
export const INTER_SYMBOL_TOOLS = ['subset-font', 'harfbuzzjs', 'fontverter', 'wawoff2'] as const;
/**
 * The layout features the faces keep: those Google's Inter subsets keep, so
 * the faces shape as the subsets do. No case, ss, cv or sups: Inter's base
 * forms. tnum stays, as the app sets tabular figures in places.
 */
export const INTER_SYMBOL_FEATURES: readonly string[] = [
  'calt',
  'ccmp',
  'dnom',
  'frac',
  'kern',
  'locl',
  'mark',
  'mkmk',
  'numr',
  'pnum',
  'tnum',
];
/**
 * The name records the faces keep: those Google's Inter subsets keep, IDs 0-6
 * and 14, the axis names 256 and 257 and the style names 303-321. The family
 * stays Inter: Inter's OFL names no Reserved Font Name.
 */
export const INTER_SYMBOL_NAME_IDS: readonly number[] = [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  14,
  256,
  257,
  ...Array.from({ length: 19 }, (_, index) => 303 + index),
];
/** The line box baked into the faces: the one every Inter face holds. */
export const INTER_SYMBOL_BOX: BakedLineBox = {
  unitsPerEm: INTER_FACE_METRICS.unitsPerEm,
  ascender: INTER_FACE_METRICS.ascender,
  descender: INTER_FACE_METRICS.descender,
  lineGap: INTER_FACE_METRICS.lineGap,
};
const SELECTION =
  'The code points the full Inter maps and no Google Inter subset (fonts/inter/) maps, but the excluded ones below; each goes to the first face whose blocks hold it.';

type CodePointRange = readonly [number, number];

const inRanges = (codePoint: number, ranges: readonly CodePointRange[]): boolean =>
  ranges.some(([start, end]) => codePoint >= start && codePoint <= end);

const hex = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

/** What the selection leaves out, and why, in the order it tests. */
export interface InterSymbolExclusion {
  readonly name: string;
  readonly reason: string;
  readonly test: (codePoint: number) => boolean;
}

export const INTER_SYMBOL_EXCLUSIONS: readonly InterSymbolExclusion[] = [
  {
    name: 'private use',
    reason: "Inter's alternate glyphs (such as G.1), which have no standard meaning.",
    test: (codePoint) =>
      inRanges(codePoint, [
        [0xe000, 0xf8ff],
        [0xf0000, 0x10ffff],
      ]),
  },
  {
    name: 'combining marks',
    reason:
      'A mark joins only a base of its own font, and a browser shapes a grapheme with one font, so a mark in a face of its own would never join a letter of the Google subsets. The device font keeps drawing them.',
    test: (codePoint) => /\p{M}/u.test(String.fromCodePoint(codePoint)),
  },
  {
    name: 'emoji presentation',
    reason: 'It draws with the emoji font by default.',
    test: (codePoint) => /\p{Emoji_Presentation}/u.test(String.fromCodePoint(codePoint)),
  },
  {
    name: 'enclosed alphanumerics',
    reason:
      'Owner decision 2026-11-18: Inter has ① to ⑨, ⓪, Ⓐ to Ⓩ, ➀ to ➈ and the squared letters, but not ⑩, ⓐ or ➉, so a series would switch family midway. They stay with the families that draw them.',
    test: (codePoint) =>
      inRanges(codePoint, [
        [0x2460, 0x24ff],
        [0x2776, 0x2793],
        [0x1f100, 0x1f1ff],
      ]),
  },
  {
    name: 'symbols a device font draws',
    reason:
      'Owner decision 2026-11-18: ↩ ↪ ⏏ ❤ keep the look a device font gives them, which a phone may show as color emoji.',
    test: (codePoint) => [0x21a9, 0x21aa, 0x23cf, 0x2764].includes(codePoint),
  },
];

/** A symbol face: its name and the blocks it holds, in sheet order. */
export interface InterSymbolFaceSpec {
  readonly name: string;
  readonly holds: string;
  readonly test: (codePoint: number) => boolean;
}

export const INTER_SYMBOL_FACE_SPECS: readonly InterSymbolFaceSpec[] = [
  {
    name: 'spaces',
    holds:
      'The spaces (Zs) and the dashes U+2010-2015: a face of spaces alone has a glyf table of no bytes, which OTS refuses.',
    test: (codePoint) =>
      /\p{Zs}/u.test(String.fromCodePoint(codePoint)) || inRanges(codePoint, [[0x2010, 0x2015]]),
  },
  {
    name: 'punctuation',
    holds:
      'General Punctuation from U+2016, Spacing Modifier Letters, Supplemental Punctuation and U+A92E.',
    test: (codePoint) =>
      inRanges(codePoint, [
        [0x02b0, 0x02ff],
        [0x2016, 0x206f],
        [0x2e00, 0x2e7f],
        [0xa92e, 0xa92e],
      ]),
  },
  {
    name: 'arrows',
    holds:
      'Arrows, Supplemental Arrows-A, -B and -C, and the arrows of Miscellaneous Symbols and Arrows.',
    test: (codePoint) =>
      inRanges(codePoint, [
        [0x2190, 0x21ff],
        [0x27f0, 0x27ff],
        [0x2900, 0x297f],
        [0x1f800, 0x1f8ff],
        [0x2b00, 0x2b11],
        [0x2b30, 0x2b4f],
        [0x2b5a, 0x2bb7],
      ]),
  },
  {
    name: 'math',
    holds:
      'Mathematical Operators, Supplemental Mathematical Operators and Miscellaneous Mathematical Symbols-A.',
    test: (codePoint) =>
      inRanges(codePoint, [
        [0x2200, 0x22ff],
        [0x2a00, 0x2aff],
        [0x27c0, 0x27ef],
      ]),
  },
  {
    name: 'letterlike',
    holds:
      'Letterlike Symbols, the Roman numerals and letters of Number Forms (U+2160-2188) and the baht sign.',
    test: (codePoint) =>
      inRanges(codePoint, [
        [0x2100, 0x214f],
        [0x2160, 0x2188],
        [0x0e3f, 0x0e3f],
      ]),
  },
  {
    name: 'fractions',
    holds: 'The fractions of Number Forms (U+2150-215F, U+2189), Superscripts and Subscripts.',
    test: (codePoint) =>
      inRanges(codePoint, [
        [0x2150, 0x215f],
        [0x2189, 0x2189],
        [0x2070, 0x209f],
      ]),
  },
  {
    name: 'shapes',
    holds:
      'Geometric Shapes, Miscellaneous Symbols, Dingbats, the shapes of Miscellaneous Symbols and Arrows, Miscellaneous Technical and Control Pictures.',
    test: (codePoint) =>
      inRanges(codePoint, [
        [0x25a0, 0x25ff],
        [0x2600, 0x26ff],
        [0x2700, 0x27bf],
        [0x2b00, 0x2bff],
        [0x2300, 0x23ff],
        [0x2400, 0x243f],
      ]),
  },
];

/** The file name of a symbol face. */
export const interSymbolFaceFile = (name: string): string => `inter-symbols-${name}.woff2`;

export interface InterSymbolSelection {
  /** The selected code points, sorted. */
  readonly codePoints: readonly number[];
  /** What each exclusion left out of the candidates, sorted, in INTER_SYMBOL_EXCLUSIONS order. */
  readonly excluded: readonly { readonly name: string; readonly codePoints: readonly number[] }[];
}

/**
 * The code points the full Inter maps and no Google subset maps, without
 * those an exclusion takes (the first that holds a code point takes it).
 */
export function interSymbolSelection(
  full: ReadonlySet<number>,
  subsets: ReadonlySet<number>,
): InterSymbolSelection {
  const excluded = INTER_SYMBOL_EXCLUSIONS.map(({ name }) => ({
    name,
    codePoints: [] as number[],
  }));
  const codePoints: number[] = [];
  for (const codePoint of [...full].sort((left, right) => left - right)) {
    if (subsets.has(codePoint)) continue;
    const exclusion = INTER_SYMBOL_EXCLUSIONS.findIndex(({ test }) => test(codePoint));
    if (exclusion >= 0) excluded[exclusion]?.codePoints.push(codePoint);
    else codePoints.push(codePoint);
  }
  return { codePoints, excluded };
}

/**
 * The faces of a selection, in INTER_SYMBOL_FACE_SPECS order: each code point
 * in the first face that holds it. A face left with no code point is dropped;
 * a code point no face holds throws, so a new symbol in a new Inter needs a
 * face or an exclusion of its own.
 */
export function interSymbolPartition(
  codePoints: readonly number[],
): { readonly name: string; readonly file: string; readonly codePoints: readonly number[] }[] {
  const faces = INTER_SYMBOL_FACE_SPECS.map(({ name }) => ({
    name,
    file: interSymbolFaceFile(name),
    codePoints: [] as number[],
  }));
  for (const codePoint of codePoints) {
    const face = faces[INTER_SYMBOL_FACE_SPECS.findIndex(({ test }) => test(codePoint))];
    if (!face) {
      throw new Error(
        `${hex(codePoint)} ${String.fromCodePoint(codePoint)} is in no Inter symbol face: give it a face or an exclusion in scripts/fonts/inter-symbol-faces.mts`,
      );
    }
    face.codePoints.push(codePoint);
  }
  return faces.filter((face) => face.codePoints.length > 0);
}

export interface InterSymbolFace {
  readonly name: string;
  readonly holds: string;
  readonly file: string;
  /** The face's code points, which are its cmap. */
  readonly unicodeRange: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface InterSymbolFaces {
  readonly note: string;
  readonly tools: Readonly<Record<string, string>>;
  readonly source: {
    readonly file: string;
    /** The full Inter's version and build, from its name ID 5. */
    readonly version: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly license: string;
    readonly axes: {
      readonly opsz: readonly [number, number];
      readonly wght: readonly [number, number];
    };
  };
  readonly selection: string;
  /** What each exclusion left out of the candidates. */
  readonly excluded: readonly {
    readonly name: string;
    readonly reason: string;
    readonly count: number;
    readonly unicodeRange: string;
  }[];
  readonly features: readonly string[];
  readonly nameIds: readonly number[];
  /** The line box in hhea and the OS/2 typo metrics: INTER_FACE_METRICS. */
  readonly box: BakedLineBox;
  readonly directory: string;
  readonly faces: readonly InterSymbolFace[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(where: string, what: string): never {
  throw new TypeError(`${INTER_SYMBOL_FACES_PATH}: ${where} must be ${what}`);
}

function readText(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') fail(`${where}.${key}`, 'a non-empty string');
  return value;
}

function readCount(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${where}.${key}`, 'a whole number');
  }
  return value;
}

function readPair(value: unknown, where: string): readonly [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  ) {
    fail(where, '[min, max]');
  }
  return [value[0] as number, value[1] as number];
}

function readList<T>(value: unknown, where: string, read: (entry: unknown, at: string) => T): T[] {
  if (!Array.isArray(value)) fail(where, 'a list');
  return value.map((entry: unknown, index) => read(entry, `${where}[${index}]`));
}

export function parseInterSymbolFaces(text: string): InterSymbolFaces {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) fail('the file', 'an object');
  const { source, box, tools } = value;
  if (!isRecord(source) || !isRecord(source.axes)) fail('source', 'an object with axes');
  if (!isRecord(box)) fail('box', 'an object');
  if (!isRecord(tools)) fail('tools', 'an object');
  return {
    note: readText(value, 'note', 'root'),
    tools: Object.fromEntries(
      Object.entries(tools).map(([name, version]) => {
        if (typeof version !== 'string') fail(`tools.${name}`, 'a string');
        return [name, version];
      }),
    ),
    source: {
      file: readText(source, 'file', 'source'),
      version: readText(source, 'version', 'source'),
      sha256: readText(source, 'sha256', 'source'),
      bytes: readCount(source, 'bytes', 'source'),
      license: readText(source, 'license', 'source'),
      axes: {
        opsz: readPair(source.axes.opsz, 'source.axes.opsz'),
        wght: readPair(source.axes.wght, 'source.axes.wght'),
      },
    },
    selection: readText(value, 'selection', 'root'),
    excluded: readList(value.excluded, 'excluded', (entry, at) => {
      if (!isRecord(entry)) fail(at, 'an object');
      return {
        name: readText(entry, 'name', at),
        reason: readText(entry, 'reason', at),
        count: readCount(entry, 'count', at),
        unicodeRange: typeof entry.unicodeRange === 'string' ? entry.unicodeRange : '',
      };
    }),
    features: readList(value.features, 'features', (entry, at) => {
      if (typeof entry !== 'string') fail(at, 'a feature tag');
      return entry;
    }),
    nameIds: readList(value.nameIds, 'nameIds', (entry, at) => {
      if (typeof entry !== 'number' || !Number.isSafeInteger(entry)) fail(at, 'a name ID');
      return entry;
    }),
    box: {
      unitsPerEm: readCount(box, 'unitsPerEm', 'box'),
      ascender: readCount(box, 'ascender', 'box'),
      descender: readCount(box, 'descender', 'box'),
      lineGap: readCount(box, 'lineGap', 'box'),
    },
    directory: readText(value, 'directory', 'root'),
    faces: readList(value.faces, 'faces', (entry, at) => {
      if (!isRecord(entry)) fail(at, 'an object');
      return {
        name: readText(entry, 'name', at),
        holds: readText(entry, 'holds', at),
        file: readText(entry, 'file', at),
        unicodeRange: readText(entry, 'unicodeRange', at),
        sha256: readText(entry, 'sha256', at),
        bytes: readCount(entry, 'bytes', at),
      };
    }),
  };
}

export async function readInterSymbolFaces(repoRoot: string): Promise<InterSymbolFaces> {
  return parseInterSymbolFaces(
    await readFile(path.join(repoRoot, INTER_SYMBOL_FACES_PATH), 'utf8'),
  );
}

export async function writeInterSymbolFaces(
  repoRoot: string,
  record: InterSymbolFaces,
): Promise<void> {
  await writeFile(
    path.join(repoRoot, INTER_SYMBOL_FACES_PATH),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
}

/** The record fields that follow from the source file and this module, not from the cut. */
export type InterSymbolFrame = Pick<
  InterSymbolFaces,
  'source' | 'selection' | 'features' | 'nameIds' | 'box' | 'directory'
>;

/** The frame of a record for the full Inter's bytes, its version and the Inter license. */
export function interSymbolFrame(
  sourceBytes: Uint8Array,
  version: string,
  license: string,
): InterSymbolFrame {
  return {
    source: {
      file: INTER_FULL_PATH,
      version,
      ...digestOf(sourceBytes),
      license,
      axes: { opsz: [...INTER_AXES.opsz], wght: [...INTER_AXES.wght] },
    },
    selection: SELECTION,
    features: [...INTER_SYMBOL_FEATURES],
    nameIds: [...INTER_SYMBOL_NAME_IDS],
    box: { ...INTER_SYMBOL_BOX },
    directory: INTER_SYMBOL_FACES_DIRECTORY,
  };
}

/** The record's exclusions for a selection. */
export function recordedExclusions(selection: InterSymbolSelection): InterSymbolFaces['excluded'] {
  return INTER_SYMBOL_EXCLUSIONS.map(({ name, reason }, index) => {
    const codePoints = selection.excluded[index]?.codePoints ?? [];
    return { name, reason, count: codePoints.length, unicodeRange: formatUnicodeRange(codePoints) };
  });
}

/** The code points Google's Inter subsets map: their cmaps, as fonts/font-sources.json lists them. */
export async function interSubsetCodePoints(
  repoRoot: string,
  sources: FontSources,
): Promise<ReadonlySet<number>> {
  const codePoints = new Set<number>();
  for (const face of sources.inter.faces) {
    const bytes = await readFile(path.join(repoRoot, sources.inter.directory, face.file));
    for (const codePoint of fontCodePoints(await openFontBytes(bytes))) codePoints.add(codePoint);
  }
  return codePoints;
}

/**
 * What is wrong with one symbol face's decoded sfnt, given the full Inter's
 * decoded sfnt, the face's code points and the record: an empty list when
 * its cmap is the code points, its glyf table holds bytes (OTS, in Chromium
 * and Firefox, refuses a face whose glyf table has none), it holds the box in
 * hhea and the OS/2 typo metrics with USE_TYPO_METRICS and the full Inter's
 * win metrics, keeps the opsz and wght axes, keeps no layout feature beyond
 * the recorded ones and no name record beyond the recorded IDs, has valid
 * checksums, and is named Inter with the full Inter's version.
 */
export async function interSymbolFaceProblems(
  sfnt: Uint8Array,
  source: Uint8Array,
  codePoints: ReadonlySet<number>,
  record: Pick<InterSymbolFaces, 'box' | 'source' | 'features' | 'nameIds'>,
): Promise<string[]> {
  const problems: string[] = [];
  const face = await openFontBytes(sfnt);
  const cmap = fontCodePoints(face);
  if (cmap.size !== codePoints.size || [...cmap].some((codePoint) => !codePoints.has(codePoint))) {
    problems.push(`its cmap (${cmap.size} code points) is not its range (${codePoints.size})`);
  }
  const tables = sfntTables(sfnt);
  if (!tables.get('glyf')?.length) {
    problems.push(
      'its glyf table has no bytes, which OTS refuses (Chromium and Firefox leave the face in error): give the face a code point with an outline',
    );
  }
  const metrics = readLineMetrics(sfnt);
  const sourceMetrics = readLineMetrics(source);
  const { unitsPerEm, ascender, descender, lineGap } = record.box;
  const box = { ascender, descender, lineGap };
  const wanted = {
    unitsPerEm,
    hhea: box,
    typo: box,
    useTypoMetrics: true,
    winAscent: sourceMetrics.winAscent,
    winDescent: sourceMetrics.winDescent,
  };
  if (JSON.stringify(metrics) !== JSON.stringify(wanted)) {
    problems.push(`it holds ${JSON.stringify(metrics)}, not ${JSON.stringify(wanted)}`);
  }
  const axes = face.getAxisInfos();
  for (const [tag, [min, max]] of Object.entries(record.source.axes)) {
    const axis = axes[tag];
    if (axis?.min !== min || axis.max !== max) {
      problems.push(`its ${tag} axis is ${axis?.min}-${axis?.max}, not ${min}-${max}`);
    }
  }
  const extra = [...fontLayoutFeatures(face)].filter(
    (feature) => !record.features.includes(feature),
  );
  if (extra.length) {
    problems.push(`it keeps layout features beyond the record: ${extra.join(', ')}`);
  }
  if (!sfntChecksumsValid(sfnt)) problems.push('it has a wrong checksum');
  const names = [...new Set(readNameTable(sfnt).records.map(({ nameId }) => nameId))];
  const extraNames = names.filter((nameId) => !record.nameIds.includes(nameId));
  if (extraNames.length) {
    problems.push(`it keeps name IDs beyond the record: ${extraNames.join(', ')}`);
  }
  const sourceFace = await openFontBytes(source);
  if (face.getName(1, 'en') !== 'Inter') {
    problems.push(`its family name is ${face.getName(1, 'en')}, not Inter`);
  }
  if (face.getName(5, 'en') !== sourceFace.getName(5, 'en')) {
    problems.push(`its name ID 5 is not the full Inter's ${sourceFace.getName(5, 'en')}`);
  }
  return problems;
}

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

/**
 * Check Inter's symbol faces against fonts/inter-symbol-faces.json without
 * cutting them again (a second or two): the record's source is the full
 * Inter of fonts/font-sources.json with its bytes, version, license and
 * axes; its rule, features, name IDs, box and folder are this module's and
 * src/i18n/font-metrics.ts's; its exclusions and faces are the selection and
 * partition of the full Inter's cmap by the Google subsets' cmaps;
 * fonts/app/inter-symbols/ holds exactly the recorded files with their
 * digests; and every face passes interSymbolFaceProblems.
 * `npm run generate:inter-symbol-faces -- --check` also cuts every face again
 * and compares its outlines with the full Inter's.
 */
export async function verifyInterSymbolFaces(
  repoRoot: string,
  record?: InterSymbolFaces,
  sources?: FontSources,
): Promise<string[]> {
  const failures: string[] = [];
  let faces: InterSymbolFaces;
  try {
    faces = record ?? (await readInterSymbolFaces(repoRoot));
  } catch (error) {
    return [
      `${INTER_SYMBOL_FACES_PATH} cannot be read (run npm run generate:inter-symbol-faces): ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  for (const tool of INTER_SYMBOL_TOOLS) {
    if (typeof faces.tools[tool] !== 'string') {
      failures.push(`${INTER_SYMBOL_FACES_PATH} does not record the ${tool} version`);
    }
  }
  const fontSources = sources ?? (await readFontSources(repoRoot));
  const sourceBytes = await readOptional(path.join(repoRoot, INTER_FULL_PATH));
  if (!sourceBytes) return [...failures, `${INTER_FULL_PATH} is missing`];
  const source = Uint8Array.from(await decodeFontBytes(sourceBytes));
  const sourceFace = await openFontBytes(source);
  const frame = interSymbolFrame(
    sourceBytes,
    interBuild(sourceFace),
    fontSources.interFull.license,
  );
  if (
    fontSources.interFull.source.sha256 !== frame.source.sha256 ||
    fontSources.interFull.version !== frame.source.version
  ) {
    failures.push(`${INTER_FULL_PATH} is not the full Inter ${FONT_SOURCES_PATH} records`);
  }
  for (const key of Object.keys(frame) as (keyof InterSymbolFrame)[]) {
    if (JSON.stringify(faces[key]) !== JSON.stringify(frame[key])) {
      failures.push(
        `${INTER_SYMBOL_FACES_PATH} ${key} ${JSON.stringify(faces[key])} is not ${JSON.stringify(frame[key])}`,
      );
    }
  }
  const selection = interSymbolSelection(
    fontCodePoints(sourceFace),
    await interSubsetCodePoints(repoRoot, fontSources),
  );
  if (JSON.stringify(faces.excluded) !== JSON.stringify(recordedExclusions(selection))) {
    failures.push(`${INTER_SYMBOL_FACES_PATH} excluded is not what the exclusions leave out`);
  }
  const expected = interSymbolPartition(selection.codePoints).map(({ name, file, codePoints }) => ({
    name,
    holds: INTER_SYMBOL_FACE_SPECS.find((spec) => spec.name === name)?.holds,
    file,
    unicodeRange: formatUnicodeRange(codePoints),
  }));
  const actual = faces.faces.map(({ name, holds, file, unicodeRange }) => ({
    name,
    holds,
    file,
    unicodeRange,
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${INTER_SYMBOL_FACES_PATH} faces are not the partition of the full Inter's symbols the Google subsets lack`,
    );
  }

  const listed = new Set(faces.faces.map(({ file }) => file));
  let present: string[] = [];
  try {
    present = await readdir(path.join(repoRoot, INTER_SYMBOL_FACES_DIRECTORY));
  } catch {
    failures.push(`${INTER_SYMBOL_FACES_DIRECTORY} is missing`);
  }
  for (const file of present) {
    if (!listed.has(file)) {
      failures.push(`${INTER_SYMBOL_FACES_DIRECTORY}/${file} is not in ${INTER_SYMBOL_FACES_PATH}`);
    }
  }
  for (const face of faces.faces) {
    const where = `${INTER_SYMBOL_FACES_DIRECTORY}/${face.file}`;
    const bytes = await readOptional(path.join(repoRoot, where));
    if (!bytes) {
      failures.push(`${where} is missing`);
      continue;
    }
    const digest = digestOf(bytes);
    if (digest.sha256 !== face.sha256 || digest.bytes !== face.bytes) {
      failures.push(
        `${where} differs from its digest in ${INTER_SYMBOL_FACES_PATH} (run npm run generate:inter-symbol-faces)`,
      );
      continue;
    }
    if (!isWoff2(bytes)) {
      failures.push(`${where} is not WOFF2`);
      continue;
    }
    const sfnt = Uint8Array.from(await decodeFontBytes(bytes));
    const problems = await interSymbolFaceProblems(
      sfnt,
      source,
      parseUnicodeRange(face.unicodeRange),
      faces,
    ).catch((error: unknown) => [error instanceof Error ? error.message : String(error)]);
    failures.push(...problems.map((problem) => `${where}: ${problem}`));
  }
  return failures;
}
