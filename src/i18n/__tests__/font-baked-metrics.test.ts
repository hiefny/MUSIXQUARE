/**
 * The line box baked into every app face (owner decision 2026-11-01).
 *
 * Safari applies size-adjust but not ascent-override, descent-override or
 * line-gap-override, so a line-height: normal line takes its box from the
 * face's own vertical metrics there: a 15 px Hangul line came out about 20 px
 * high instead of 18 px. Every Inter and CJK face of the app sheets therefore
 * carries the line box of src/i18n/font-metrics.ts in its tables: hhea and the
 * OS/2 typo metrics hold its ascender, descender and line gap, and
 * USE_TYPO_METRICS is set, so an engine that ignores the overrides measures
 * the same lines as one that applies them. The win metrics keep the input's
 * values, so an engine that clips to them clips nothing new.
 *
 * The faces live in fonts/app/. Each is a copy of an input file, recorded in
 * fonts/app-faces.json by scripts/fonts/build-app-faces.mts, that differs from
 * its input only in head, hhea and OS/2, but Inter's latin face, the one that
 * holds the digits 0-9: its cmap maps them to the glyphs Inter's tnum gives
 * them, zero.tf to nine.tf, so every digit in the app takes one advance (owner
 * decision 2026-11-05). This test reads the tables itself, not through the
 * generator's modules.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import * as hb from 'harfbuzzjs';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  decodeFontBytes,
  parseFontFaceRules,
  sha256Hex,
} from '../../../scripts/fonts/font-files.mts';
import { APP_FONT_SHEETS } from '../app-font-contract.ts';
import { CJK_FACE_METRICS, INTER_FACE_METRICS } from '../font-metrics.ts';

const ROOT = resolve('.');
const RECORD_PATH = 'fonts/app-faces.json';
const OUTPUT_ROOT = 'fonts/app';
/** MVAR tags that would vary the line box or the win metrics across instances. */
const LINE_METRIC_MVAR_TAGS = ['hasc', 'hdsc', 'hlgp', 'hcla', 'hcld'];
/** The bytes an engine may change in each table; every other byte stays the input's. */
const PATCHED_BYTES: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  // checkSumAdjustment
  head: [[8, 12]],
  // ascender, descender, lineGap
  hhea: [[4, 10]],
  // fsSelection, then sTypoAscender, sTypoDescender, sTypoLineGap
  'OS/2': [
    [62, 64],
    [68, 74],
  ],
};

type FaceMetrics = typeof INTER_FACE_METRICS;

/**
 * The baked families: their sheet, metrics home, the input's win metrics and
 * whether the face that holds the digits maps them to its tabular glyphs.
 */
const BAKED_FAMILIES = [
  {
    id: 'font-inter',
    metrics: INTER_FACE_METRICS,
    win: [2269, 660],
    faces: 7,
    tabularDigits: true,
  },
  // 53 of 120: the shards that held only Hangul left with it (MUSIXQUARE Hangul).
  {
    id: 'font-noto-kr',
    metrics: CJK_FACE_METRICS,
    win: [1160, 288],
    faces: 53,
    tabularDigits: false,
  },
  {
    id: 'font-noto-jp',
    metrics: CJK_FACE_METRICS,
    win: [1160, 288],
    faces: 120,
    tabularDigits: false,
  },
  {
    id: 'font-noto-sc',
    metrics: CJK_FACE_METRICS,
    win: [1160, 288],
    faces: 95,
    tabularDigits: false,
  },
  {
    id: 'font-noto-tc',
    metrics: CJK_FACE_METRICS,
    win: [1160, 288],
    faces: 98,
    tabularDigits: false,
  },
] as const;
/** The one face whose digits take Inter's tabular glyphs. */
const TABULAR_DIGIT_FACE = 'fonts/app/inter/inter-latin.woff2';
/** U+0030-0039. */
const DIGITS = Array.from({ length: 10 }, (_, index) => 0x30 + index);
/** The instances of Inter the app draws: weights 400 to 700, optical sizes 14 to 32. */
const INTER_APP_INSTANCES: readonly (readonly [string, number])[][] = [
  [],
  ...[400, 500, 600, 700].flatMap((wght) =>
    [14, 32].map((opsz): [string, number][] => [
      ['wght', wght],
      ['opsz', opsz],
    ]),
  ),
];

interface RecordDigest {
  readonly sha256: string;
  readonly bytes: number;
}

interface RecordFamily {
  readonly family: string;
  readonly input: string;
  readonly output: string;
  readonly tabularDigits: boolean;
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  readonly winAscent: number;
  readonly winDescent: number;
  readonly faces: readonly { file: string; input: RecordDigest; output: RecordDigest }[];
}

interface AppFacesRecord {
  readonly note: string;
  readonly tools: Readonly<Record<string, string>>;
  readonly families: readonly RecordFamily[];
}

interface SfntTable {
  readonly checksum: number;
  readonly bytes: Uint8Array;
}

interface Face {
  readonly family: string;
  readonly metrics: FaceMetrics;
  readonly win: readonly number[];
  /** Repository path of the WOFF2 file the sheet names. */
  readonly path: string;
  readonly file: string;
  readonly woff2: Buffer;
  readonly sfnt: Uint8Array;
}

function tablesOf(sfnt: Uint8Array): Map<string, SfntTable> {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const tables = new Map<string, SfntTable>();
  for (let index = 0; index < view.getUint16(4); index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(...sfnt.subarray(record, record + 4));
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    tables.set(tag, {
      checksum: view.getUint32(record + 4),
      bytes: sfnt.subarray(offset, offset + length),
    });
  }
  return tables;
}

function tableView(tables: Map<string, SfntTable>, tag: string): DataView {
  const table = tables.get(tag);
  if (!table) throw new Error(`no ${tag} table`);
  return new DataView(table.bytes.buffer, table.bytes.byteOffset, table.bytes.byteLength);
}

/** The vertical metrics as the tables store them (descenders negative). */
function lineTables(sfnt: Uint8Array) {
  const tables = tablesOf(sfnt);
  const head = tableView(tables, 'head');
  const hhea = tableView(tables, 'hhea');
  const os2 = tableView(tables, 'OS/2');
  return {
    unitsPerEm: head.getUint16(18),
    hhea: [hhea.getInt16(4), hhea.getInt16(6), hhea.getInt16(8)],
    typo: [os2.getInt16(68), os2.getInt16(70), os2.getInt16(72)],
    useTypoMetrics: (os2.getUint16(62) & 0x80) !== 0,
    win: [os2.getUint16(74), os2.getUint16(76)],
  };
}

/** What the tables must hold for a family's metrics. */
function bakedTables(metrics: FaceMetrics, win: readonly number[]) {
  const box = [metrics.ascender, -metrics.descender, metrics.lineGap];
  return { unitsPerEm: metrics.unitsPerEm, hhea: box, typo: box, useTypoMetrics: true, win };
}

/** The sum of big-endian 32-bit words, the last one padded with zeros. */
function wordSum(bytes: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    const word =
      ((bytes[index] ?? 0) * 0x1000000 +
        ((bytes[index + 1] ?? 0) << 16) +
        ((bytes[index + 2] ?? 0) << 8) +
        (bytes[index + 3] ?? 0)) >>>
      0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

/** Tables whose recorded checksum is wrong, and 'checkSumAdjustment' when the font's is. */
function checksumErrors(sfnt: Uint8Array): string[] {
  const errors: string[] = [];
  for (const [tag, { checksum, bytes }] of tablesOf(sfnt)) {
    const counted = Uint8Array.from(bytes);
    if (tag === 'head') counted.fill(0, 8, 12);
    if (wordSum(counted) !== checksum) errors.push(tag);
  }
  if (wordSum(sfnt) !== 0xb1b0afba) errors.push('checkSumAdjustment');
  return errors;
}

function mvarTags(sfnt: Uint8Array): string[] {
  const mvar = tablesOf(sfnt).get('MVAR')?.bytes;
  if (!mvar) return [];
  const view = new DataView(mvar.buffer, mvar.byteOffset, mvar.byteLength);
  const size = view.getUint16(6);
  return Array.from({ length: view.getUint16(8) }, (_, index) =>
    String.fromCharCode(...mvar.subarray(12 + index * size, 16 + index * size)),
  );
}

/**
 * Tables, or byte ranges of the patched tables, in which two fonts differ.
 * With digitsMapped, the cmap may differ too: digitMappingProblems compares it
 * code point by code point.
 */
function differences(input: Uint8Array, output: Uint8Array, digitsMapped: boolean): string[] {
  const before = tablesOf(input);
  const after = tablesOf(output);
  const found: string[] = [];
  for (const tag of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(tag)?.bytes;
    const right = after.get(tag)?.bytes;
    if (!left || !right || left.length !== right.length) {
      found.push(`${tag} (added, removed or resized)`);
      continue;
    }
    if (tag === 'cmap' && digitsMapped) continue;
    const allowed = PATCHED_BYTES[tag] ?? [];
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] === right[index]) continue;
      if (allowed.some(([start, end]) => index >= start && index < end)) continue;
      found.push(`${tag} byte ${index}`);
      break;
    }
  }
  return found;
}

const DIGIT_NAMES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
];
/** Inter's tabular digits, which its tnum feature gives. */
const TABULAR_DIGIT_NAMES = DIGIT_NAMES.map((name) => `${name}.tf`);

function holdsDigits(sfnt: Uint8Array): boolean {
  const codePoints = new hb.Face(new hb.Blob(sfnt), 0).collectUnicodes();
  return DIGITS.some((digit) => codePoints.includes(digit));
}

/**
 * Where the copy's cmap is not the input's with each digit mapped to the glyph
 * the input's tnum gives it, which must be zero.tf to nine.tf. Empty when it
 * is exactly that.
 */
function digitMappingProblems(input: Uint8Array, output: Uint8Array): string[] {
  const before = new hb.Face(new hb.Blob(input), 0);
  const after = new hb.Face(new hb.Blob(output), 0);
  const [from, to] = [new hb.Font(before), new hb.Font(after)];
  const codePoints = [...before.collectUnicodes()];
  const copied = new Set(after.collectUnicodes());
  const found: string[] = [];
  if (copied.size !== codePoints.length || codePoints.some((code) => !copied.has(code))) {
    found.push('other code points');
  }
  for (const codePoint of codePoints) {
    let wanted = from.nominalGlyph(codePoint);
    const digit = DIGITS.indexOf(codePoint);
    if (digit >= 0) {
      const buffer = new hb.Buffer();
      buffer.addText(String.fromCodePoint(codePoint));
      buffer.guessSegmentProperties();
      hb.shape(from, buffer, [new hb.Feature('tnum')]);
      wanted = buffer.getGlyphInfos()[0]?.codepoint;
      const name = wanted === undefined ? '' : from.glyphName(wanted);
      if (name !== TABULAR_DIGIT_NAMES[digit]) found.push(`tnum gives ${name}`);
    }
    const glyph = to.nominalGlyph(codePoint);
    if (glyph !== wanted)
      found.push(`U+${codePoint.toString(16)} to glyph ${glyph}, not ${wanted}`);
  }
  return found;
}

function sheetOf(id: string): (typeof APP_FONT_SHEETS)[number] {
  const sheet = APP_FONT_SHEETS.find((entry) => entry.id === id);
  if (!sheet) throw new Error(`${id} is not an app font sheet`);
  return sheet;
}

async function readRecord(): Promise<AppFacesRecord | null> {
  try {
    return JSON.parse(await readFile(join(ROOT, RECORD_PATH), 'utf8')) as AppFacesRecord;
  } catch {
    return null;
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(join(ROOT, directory), { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(child)));
    else files.push(child);
  }
  return files;
}

/** Faces grouped by what a summary of each returns, as [summary, count] pairs. */
function tally<T>(faces: readonly Face[], summary: (face: Face) => T): [T, number][] {
  const counts = new Map<string, [T, number]>();
  for (const face of faces) {
    const value = summary(face);
    const key = JSON.stringify(value);
    const entry = counts.get(key);
    if (entry) entry[1] += 1;
    else counts.set(key, [value, 1]);
  }
  return [...counts.values()];
}

const faces: Face[] = [];
let record: AppFacesRecord | null = null;

beforeAll(async () => {
  record = await readRecord();
  for (const { id, metrics, win } of BAKED_FAMILIES) {
    const sheet = sheetOf(id);
    const css = await readFile(join(ROOT, sheet.path), 'utf8');
    for (const rule of parseFontFaceRules(css)) {
      const path = posix.normalize(posix.join(posix.dirname(sheet.path), rule.url));
      const woff2 = await readFile(join(ROOT, path));
      faces.push({
        family: sheet.family,
        metrics,
        win,
        path,
        file: rule.file,
        woff2,
        // A copy: the decoder returns a view into memory it reuses on the next call.
        sfnt: Uint8Array.from(await decodeFontBytes(woff2)),
      });
    }
  }
}, 180_000);

describe('the line box baked into the app faces', () => {
  it('reads every face of the five sheets', () => {
    expect(tally(faces, ({ family }) => family)).toEqual(
      BAKED_FAMILIES.map(({ id, faces: count }) => [sheetOf(id).family, count]),
    );
  });

  it('holds the line box of font-metrics.ts in hhea and the OS/2 typo metrics, with USE_TYPO_METRICS', () => {
    for (const { id, metrics, win, faces: count } of BAKED_FAMILIES) {
      const family = sheetOf(id).family;
      expect(
        tally(
          faces.filter((face) => face.family === family),
          ({ sfnt }) => lineTables(sfnt),
        ),
        family,
      ).toEqual([[bakedTables(metrics, win), count]]);
    }
  });

  it('keeps the win metrics of the inputs, which still hold the baked box', () => {
    for (const face of faces) {
      const { win } = lineTables(face.sfnt);
      expect(win, face.path).toEqual(face.win);
      expect(win[0] ?? 0, face.path).toBeGreaterThanOrEqual(face.metrics.ascender);
      expect(win[1] ?? 0, face.path).toBeGreaterThanOrEqual(face.metrics.descender);
    }
  });

  it('keeps valid table checksums and head.checkSumAdjustment', () => {
    const broken = faces
      .map((face) => [face.path, checksumErrors(face.sfnt)] as const)
      .filter(([, errors]) => errors.length > 0);
    expect(broken).toEqual([]);
  });

  it('varies no line metric across instances (no MVAR line-metric record)', () => {
    const varied = faces
      .map((face) => [face.path, mvarTags(face.sfnt)] as const)
      .filter(([, tags]) => tags.some((tag) => LINE_METRIC_MVAR_TAGS.includes(tag)));
    expect(varied).toEqual([]);
  });

  it('gives HarfBuzz the baked extents at the instances the app draws', () => {
    for (const { id, metrics } of BAKED_FAMILIES) {
      const family = sheetOf(id).family;
      const instances: readonly (readonly [string, number])[][] =
        id === 'font-inter'
          ? [
              [],
              [
                ['opsz', 14],
                ['wght', 400],
              ],
              [
                ['opsz', 14],
                ['wght', 700],
              ],
              [
                ['opsz', 32],
                ['wght', 400],
              ],
              [
                ['opsz', 32],
                ['wght', 700],
              ],
            ]
          : [[], [['wght', 400]], [['wght', 700]]];
      const extents = tally(
        faces.filter((face) => face.family === family),
        ({ sfnt }) => {
          const face = new hb.Face(new hb.Blob(sfnt), 0);
          return instances.map((variations) => {
            const font = new hb.Font(face);
            if (variations.length) {
              font.setVariations(variations.map(([tag, value]) => new hb.Variation(tag, value)));
            }
            const { ascender, descender, lineGap } = font.hExtents();
            return [ascender, descender, lineGap];
          });
        },
      );
      const box = [metrics.ascender, -metrics.descender, metrics.lineGap];
      expect(extents, family).toEqual([
        [instances.map(() => box), faces.filter((face) => face.family === family).length],
      ]);
    }
  });

  it('serves every face from a recorded copy under fonts/app', async () => {
    expect(record, `${RECORD_PATH} is missing`).not.toBeNull();
    const outputs = new Map<string, RecordDigest>();
    for (const family of record?.families ?? []) {
      for (const face of family.faces) outputs.set(`${family.output}/${face.file}`, face.output);
    }
    const unrecorded = faces
      .filter(({ path }) => !path.startsWith(`${OUTPUT_ROOT}/`) || !outputs.has(path))
      .map(({ path }) => path);
    expect(unrecorded).toEqual([]);
    for (const face of faces) {
      const recorded = outputs.get(face.path);
      if (!recorded) continue;
      expect({ sha256: sha256Hex(face.woff2), bytes: face.woff2.byteLength }, face.path).toEqual(
        recorded,
      );
    }
    // Nothing under fonts/app/ that the record does not list, but the Hangul
    // faces in fonts/app/hangul/, which keep their source's own line box and
    // fonts/hangul-faces.json records (hangul-faces.test.ts).
    expect(
      (await listFiles(OUTPUT_ROOT)).filter(
        (path) => !outputs.has(path) && !path.startsWith(`${OUTPUT_ROOT}/hangul/`),
      ),
    ).toEqual([]);
  });

  it('records each family with the metrics of font-metrics.ts, the win metrics it keeps and whether it maps the digits', () => {
    expect(
      (record?.families ?? []).map(
        ({
          family,
          tabularDigits,
          unitsPerEm,
          ascender,
          descender,
          lineGap,
          winAscent,
          winDescent,
        }) => ({
          family,
          tabularDigits,
          unitsPerEm,
          ascender,
          descender,
          lineGap,
          winAscent,
          winDescent,
        }),
      ),
    ).toEqual(
      BAKED_FAMILIES.map(({ id, metrics, win: [winAscent, winDescent], tabularDigits }) => ({
        family: sheetOf(id).family,
        tabularDigits,
        unitsPerEm: metrics.unitsPerEm,
        ascender: metrics.ascender,
        descender: metrics.descender,
        lineGap: metrics.lineGap,
        winAscent,
        winDescent,
      })),
    );
  });

  it("maps the digits of Inter's latin face to zero.tf to nine.tf, one advance at every instance the app draws", () => {
    const inter = faces.filter(({ family }) => family === sheetOf('font-inter').family);
    expect(inter.filter(({ sfnt }) => holdsDigits(sfnt)).map(({ path }) => path)).toEqual([
      TABULAR_DIGIT_FACE,
    ]);
    const face = inter.find(({ path }) => path === TABULAR_DIGIT_FACE);
    if (!face) throw new Error(`${TABULAR_DIGIT_FACE} is not in the Inter sheet`);
    const font = new hb.Font(new hb.Face(new hb.Blob(face.sfnt), 0));
    expect(DIGITS.map((digit) => font.glyphName(font.nominalGlyph(digit) ?? 0))).toEqual(
      TABULAR_DIGIT_NAMES,
    );
    // Shaped as the app sets a run of digits (default features: calt, kern),
    // each digit takes the same advance at each instance.
    const advances = INTER_APP_INSTANCES.map((variations) => {
      font.setVariations(variations.map(([tag, value]) => new hb.Variation(tag, value)));
      const buffer = new hb.Buffer();
      buffer.addText('0123456789');
      buffer.guessSegmentProperties();
      hb.shape(font, buffer);
      expect(buffer.getGlyphInfos().map(({ codepoint }) => font.glyphName(codepoint))).toEqual(
        TABULAR_DIGIT_NAMES,
      );
      return new Set(buffer.getGlyphPositions().map(({ xAdvance }) => xAdvance)).size;
    });
    expect(advances).toEqual(INTER_APP_INSTANCES.map(() => 1));
  });

  it("differs from each recorded input only in head, hhea and OS/2, and Inter's latin face in its digits", async () => {
    expect(record, `${RECORD_PATH} is missing`).not.toBeNull();
    const tabular = new Set<string>(
      BAKED_FAMILIES.filter(({ tabularDigits }) => tabularDigits).map(
        ({ id }) => sheetOf(id).family,
      ),
    );
    const changed: [string, string[]][] = [];
    const mapped: string[] = [];
    let compared = 0;
    for (const family of record?.families ?? []) {
      for (const entry of family.faces) {
        const face = faces.find(({ path }) => path === `${family.output}/${entry.file}`);
        if (!face) continue;
        const input = await readFile(join(ROOT, family.input, entry.file));
        expect({ sha256: sha256Hex(input), bytes: input.byteLength }, entry.file).toEqual(
          entry.input,
        );
        const decoded = Uint8Array.from(await decodeFontBytes(input));
        const digitsMapped = tabular.has(family.family) && holdsDigits(decoded);
        if (digitsMapped) mapped.push(face.path);
        const found = [
          ...differences(decoded, face.sfnt, digitsMapped),
          ...(digitsMapped ? digitMappingProblems(decoded, face.sfnt) : []),
        ];
        if (found.length) changed.push([face.path, found]);
        compared += 1;
      }
    }
    expect(changed).toEqual([]);
    expect(mapped).toEqual([TABULAR_DIGIT_FACE]);
    expect(compared).toBe(faces.length);
  }, 180_000);
});
