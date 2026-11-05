/**
 * The tabular digits of the app's Inter (owner decision 2026-11-05: every
 * digit in the app takes one width): scripts/fonts/app-face-digits.mts maps
 * U+0030-0039 in the cmap of the face that holds them to the glyphs the
 * face's own tnum feature gives them (zero.tf to nine.tf in Inter), and the
 * face generator (scripts/fonts/build-app-faces.mts) does so before it bakes
 * the line box. Only the digits' cmap entries change, through the idDelta of
 * a format 4 segment that holds only digits or the digits' entries of a
 * segment's glyphIdArray. The rewrite refuses a face it would not describe
 * exactly: one that holds only some digits, whose tnum leaves a digit as it
 * is or gives two digits one glyph, whose tabular digits take more than one
 * advance at an instance, or whose cmap has a layout it does not rewrite.
 *
 * The test faces are Google's Inter latin and Cyrillic inputs, some changed
 * in one table: a cmap rebuilt from the input's mapping, or one hmtx or HVAR
 * entry.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as hb from 'harfbuzzjs';
import { describe, expect, it } from 'vitest';

import {
  DIGIT_CODE_POINTS,
  tabularDigitGlyphs,
  tabularDigitsProblems,
  withTabularDigits,
} from '../../../scripts/fonts/app-face-digits.mts';
import { sfntTables } from '../../../scripts/fonts/app-face-metrics.mts';
import { bakeFace } from '../../../scripts/fonts/build-app-faces.mts';
import { decodeFontBytes } from '../../../scripts/fonts/font-files.mts';
import { INTER_FACE_METRICS } from '../font-metrics.ts';

const ROOT = resolve('.');
const INTER_LATIN = 'fonts/inter/inter-latin.woff2';
const INTER_CYRILLIC = 'fonts/inter/inter-cyrillic.woff2';
const APP_INTER_LATIN = 'fonts/app/inter/inter-latin.woff2';
const INTER_TARGET = {
  unitsPerEm: INTER_FACE_METRICS.unitsPerEm,
  ascender: INTER_FACE_METRICS.ascender,
  descender: INTER_FACE_METRICS.descender,
  lineGap: INTER_FACE_METRICS.lineGap,
};
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
const TABULAR_NAMES = DIGIT_NAMES.map((name) => `${name}.tf`);
const SLASH = 0x2f;
const COLON = 0x3a;

/** A copy of a file's sfnt: the decoder returns a view into memory it reuses. */
async function decoded(path: string): Promise<Uint8Array> {
  return Uint8Array.from(await decodeFontBytes(await readFile(join(ROOT, path))));
}

function fontOf(sfnt: Uint8Array): hb.Font {
  return new hb.Font(new hb.Face(new hb.Blob(sfnt), 0));
}

/** Each code point the face maps, with its glyph. */
function mappingOf(sfnt: Uint8Array): Map<number, number> {
  const face = new hb.Face(new hb.Blob(sfnt), 0);
  const font = new hb.Font(face);
  return new Map([...face.collectUnicodes()].map((code) => [code, font.nominalGlyph(code) ?? 0]));
}

function glyphNames(sfnt: Uint8Array, glyphs: readonly number[]): string[] {
  const font = fontOf(sfnt);
  return glyphs.map((glyph) => font.glyphName(glyph));
}

/** The input's mapping with each digit mapped to its tabular glyph. */
function mappedDigits(sfnt: Uint8Array): Map<number, number> {
  const font = fontOf(sfnt);
  const mapping = mappingOf(sfnt);
  DIGIT_CODE_POINTS.forEach((code, index) => {
    mapping.set(code, font.glyphFromName(TABULAR_NAMES[index] ?? '') ?? 0);
  });
  return mapping;
}

/** Byte offsets at which two fonts of the same size differ. */
function differingBytes(left: Uint8Array, right: Uint8Array): number[] {
  expect(right.length).toBe(left.length);
  const offsets: number[] = [];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) offsets.push(index);
  }
  return offsets;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function tableOf(sfnt: Uint8Array, tag: string): { offset: number; length: number } {
  const table = sfntTables(sfnt).get(tag);
  if (!table) throw new Error(`no ${tag} table`);
  return table;
}

interface Segment {
  readonly start: number;
  readonly end: number;
  /** Where the segment's idDelta is, in the font. */
  readonly deltaAt: number;
  /** Where the glyphIdArray entry of each of its code points is, or null with idDelta only. */
  readonly entryAt: ((code: number) => number) | null;
}

/** The segments of every distinct format 4 subtable of the font's cmap. */
function format4Segments(sfnt: Uint8Array): Segment[][] {
  const view = viewOf(sfnt);
  const cmap = tableOf(sfnt, 'cmap').offset;
  const subtables = new Set<number>();
  for (let index = 0; index < view.getUint16(cmap + 2); index += 1) {
    subtables.add(cmap + view.getUint32(cmap + 8 + index * 8));
  }
  return [...subtables]
    .filter((at) => view.getUint16(at) === 4)
    .map((at) => {
      const segmentsX2 = view.getUint16(at + 6);
      const ends = at + 14;
      const starts = ends + segmentsX2 + 2;
      const deltas = starts + segmentsX2;
      const rangeOffsets = deltas + segmentsX2;
      return Array.from({ length: segmentsX2 / 2 }, (_, segment): Segment => {
        const start = view.getUint16(starts + segment * 2);
        const rangeAt = rangeOffsets + segment * 2;
        const rangeOffset = view.getUint16(rangeAt);
        return {
          start,
          end: view.getUint16(ends + segment * 2),
          deltaAt: deltas + segment * 2,
          entryAt:
            rangeOffset === 0 ? null : (code: number) => rangeAt + rangeOffset + (code - start) * 2,
        };
      });
    });
}

/**
 * A cmap format 4 subtable for a BMP mapping: runs of code points whose
 * glyphs keep one delta take the idDelta, and each of `arrayRanges` is one
 * segment that takes its glyphs from the glyphIdArray (0 where it maps none).
 */
function format4(
  mapping: ReadonlyMap<number, number>,
  arrayRanges: readonly (readonly [number, number])[] = [],
): Uint8Array {
  const codes = [...mapping.keys()].filter((code) => code < 0xffff).sort((a, b) => a - b);
  const glyph = (code: number): number => mapping.get(code) ?? 0;
  const rangeOf = (code: number) => arrayRanges.find(([from, to]) => code >= from && code <= to);
  const segments: { start: number; end: number; delta: number; glyphs: number[] | null }[] = [];
  for (let index = 0; index < codes.length;) {
    const start = codes[index] ?? 0;
    const range = rangeOf(start);
    if (range) {
      const [from, to] = range;
      const glyphs = Array.from({ length: to - from + 1 }, (_, offset) => glyph(from + offset));
      segments.push({ start: from, end: to, delta: 0, glyphs });
      while (index < codes.length && (codes[index] ?? 0) <= to) index += 1;
      continue;
    }
    const delta = glyph(start) - start;
    let end = start;
    index += 1;
    while (
      index < codes.length &&
      codes[index] === end + 1 &&
      glyph(end + 1) - (end + 1) === delta &&
      !rangeOf(end + 1)
    ) {
      end += 1;
      index += 1;
    }
    segments.push({ start, end, delta, glyphs: null });
  }
  segments.push({ start: 0xffff, end: 0xffff, delta: 1, glyphs: null });

  const count = segments.length;
  const arrayLength = segments.reduce((sum, { glyphs }) => sum + (glyphs?.length ?? 0), 0);
  const length = 16 + count * 8 + arrayLength * 2;
  const bytes = new Uint8Array(length);
  const view = viewOf(bytes);
  const power = 2 ** Math.floor(Math.log2(count));
  view.setUint16(0, 4);
  view.setUint16(2, length);
  view.setUint16(6, count * 2);
  view.setUint16(8, power * 2);
  view.setUint16(10, Math.log2(power));
  view.setUint16(12, count * 2 - power * 2);
  const ends = 14;
  const starts = ends + count * 2 + 2;
  const deltas = starts + count * 2;
  const rangeOffsets = deltas + count * 2;
  let entry = rangeOffsets + count * 2;
  segments.forEach(({ start, end, delta, glyphs }, segment) => {
    view.setUint16(ends + segment * 2, end);
    view.setUint16(starts + segment * 2, start);
    view.setUint16(deltas + segment * 2, delta & 0xffff);
    if (!glyphs) return;
    view.setUint16(rangeOffsets + segment * 2, entry - (rangeOffsets + segment * 2));
    for (const value of glyphs) {
      view.setUint16(entry, value);
      entry += 2;
    }
  });
  return bytes;
}

/** A cmap format 12 subtable for a mapping. */
function format12(mapping: ReadonlyMap<number, number>): Uint8Array {
  const codes = [...mapping.keys()].sort((a, b) => a - b);
  const groups: [number, number, number][] = [];
  for (const code of codes) {
    const glyph = mapping.get(code) ?? 0;
    const last = groups.at(-1);
    if (last && code === last[1] + 1 && glyph === last[2] + code - last[0]) last[1] = code;
    else groups.push([code, code, glyph]);
  }
  const bytes = new Uint8Array(16 + groups.length * 12);
  const view = viewOf(bytes);
  view.setUint16(0, 12);
  view.setUint32(4, bytes.length);
  view.setUint32(12, groups.length);
  groups.forEach(([start, end, glyph], index) => {
    view.setUint32(16 + index * 12, start);
    view.setUint32(20 + index * 12, end);
    view.setUint32(24 + index * 12, glyph);
  });
  return bytes;
}

/** A cmap table: encoding records (platform, encoding, subtable index), sorted, and the subtables. */
function cmapTable(
  records: readonly (readonly [number, number, number])[],
  subtables: readonly Uint8Array[],
): Uint8Array {
  const header = 4 + records.length * 8;
  const offsets: number[] = [];
  let length = header;
  for (const subtable of subtables) {
    offsets.push(length);
    length += subtable.length;
  }
  const bytes = new Uint8Array(length);
  const view = viewOf(bytes);
  view.setUint16(2, records.length);
  records.forEach(([platform, encoding, subtable], index) => {
    view.setUint16(4 + index * 8, platform);
    view.setUint16(6 + index * 8, encoding);
    view.setUint32(8 + index * 8, offsets[subtable] ?? 0);
  });
  subtables.forEach((subtable, index) => bytes.set(subtable, offsets[index] ?? 0));
  return bytes;
}

/** The font with one table replaced (checksums left as they are: HarfBuzz reads none). */
function withTable(sfnt: Uint8Array, tag: string, table: Uint8Array): Uint8Array {
  const tables = [...sfntTables(sfnt)];
  const contents = new Map(
    tables.map(([name, { offset, length }]) => [
      name,
      name === tag ? table : sfnt.subarray(offset, offset + length),
    ]),
  );
  const directory = 12 + tables.length * 16;
  const size = [...contents.values()].reduce(
    (sum, bytes) => sum + Math.ceil(bytes.length / 4) * 4,
    directory,
  );
  const font = new Uint8Array(size);
  font.set(sfnt.subarray(0, 12));
  const out = viewOf(font);
  let at = directory;
  // The directory keeps its order; the tables follow it in their old order.
  const layout = [...tables].sort(([, left], [, right]) => left.offset - right.offset);
  const placed = new Map<string, number>();
  for (const [name] of layout) {
    const bytes = contents.get(name) ?? new Uint8Array();
    font.set(bytes, at);
    placed.set(name, at);
    at += Math.ceil(bytes.length / 4) * 4;
  }
  tables.forEach(([name, { record }], index) => {
    const entry = 12 + index * 16;
    font.set(sfnt.subarray(record, record + 8), entry);
    out.setUint32(entry + 8, placed.get(name) ?? 0);
    out.setUint32(entry + 12, contents.get(name)?.length ?? 0);
  });
  return font;
}

/** The font with its cmap rebuilt: (0,3) and (3,1) share one format 4 subtable. */
function withMapping(
  sfnt: Uint8Array,
  mapping: ReadonlyMap<number, number>,
  arrayRanges: readonly (readonly [number, number])[] = [],
): Uint8Array {
  return withTable(
    sfnt,
    'cmap',
    cmapTable(
      [
        [0, 3, 0],
        [3, 1, 0],
      ],
      [format4(mapping, arrayRanges)],
    ),
  );
}

describe('the tabular glyphs of a face', () => {
  it("are Inter latin's zero.tf to nine.tf, other glyphs than its digits'", async () => {
    const input = await decoded(INTER_LATIN);
    const glyphs = tabularDigitGlyphs(input);
    expect(glyphs).not.toBeNull();
    expect(glyphNames(input, glyphs ?? [])).toEqual(TABULAR_NAMES);
    const mapping = mappingOf(input);
    expect(
      glyphNames(
        input,
        DIGIT_CODE_POINTS.map((code) => mapping.get(code) ?? 0),
      ),
    ).toEqual(DIGIT_NAMES);
  });

  it('take one advance at the default and every corner of the wght and opsz axes', async () => {
    const input = await decoded(INTER_LATIN);
    const glyphs = tabularDigitGlyphs(input) ?? [];
    const font = fontOf(input);
    for (const wght of [100, 400, 700, 900]) {
      for (const opsz of [14, 32]) {
        font.setVariations([new hb.Variation('wght', wght), new hb.Variation('opsz', opsz)]);
        expect(new Set(glyphs.map((glyph) => font.glyphHAdvance(glyph))).size).toBe(1);
      }
    }
  });

  it('are none in a face without digits', async () => {
    expect(tabularDigitGlyphs(await decoded(INTER_CYRILLIC))).toBeNull();
  });
});

describe('mapping the digits to the tabular glyphs', () => {
  it("rewrites only the idDelta of Inter latin's digit segment", async () => {
    const input = await decoded(INTER_LATIN);
    const copy = Uint8Array.from(input);
    const mapped = withTabularDigits(input);
    expect(input).toEqual(copy);
    expect(mappingOf(mapped)).toEqual(mappedDigits(input));

    // (0,3) and (3,1) share one subtable, whose segment U+0030-U+0039 maps
    // the digits through its idDelta.
    const subtables = format4Segments(input);
    expect(subtables).toHaveLength(1);
    const digits = subtables[0]?.find(({ start }) => start === 0x30);
    expect(digits && [digits.start, digits.end, digits.entryAt]).toEqual([0x30, 0x39, null]);
    const deltaAt = digits?.deltaAt ?? 0;
    const changed = differingBytes(input, mapped);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.filter((offset) => offset < deltaAt || offset >= deltaAt + 2)).toEqual([]);
  });

  it("rewrites only the digits' entries of a segment that takes the glyphIdArray", async () => {
    const input = await decoded(INTER_LATIN);
    // One segment for / 0-9 :, its glyphs in the glyphIdArray.
    const arrayed = withMapping(input, mappingOf(input), [[SLASH, COLON]]);
    expect(mappingOf(arrayed)).toEqual(mappingOf(input));
    const segment = format4Segments(arrayed)[0]?.find(({ start }) => start === SLASH);
    const entryAt = segment?.entryAt;
    if (!entryAt) throw new Error('no glyphIdArray segment for / to :');

    const mapped = withTabularDigits(arrayed);
    expect(mappingOf(mapped)).toEqual(mappedDigits(input));
    const entries = DIGIT_CODE_POINTS.map(entryAt);
    const changed = differingBytes(arrayed, mapped);
    expect(changed.length).toBeGreaterThan(0);
    expect(
      changed.filter((offset) => !entries.some((at) => offset >= at && offset < at + 2)),
    ).toEqual([]);
    // The slash and the colon keep their glyphs, in the same segment.
    expect([SLASH, COLON].map((code) => mappingOf(mapped).get(code))).toEqual([
      mappingOf(input).get(SLASH),
      mappingOf(input).get(COLON),
    ]);
  });

  it('returns an unchanged copy of a face without digits', async () => {
    const input = await decoded(INTER_CYRILLIC);
    const copy = withTabularDigits(input);
    expect(copy).not.toBe(input);
    expect(copy).toEqual(input);
  });
});

describe('the faces the digit mapping refuses', () => {
  it('a face that holds only some of the digits', async () => {
    const input = await decoded(INTER_LATIN);
    const mapping = mappingOf(input);
    for (const code of [0x36, 0x37, 0x38, 0x39]) mapping.delete(code);
    const partial = withMapping(input, mapping);
    expect(() => tabularDigitGlyphs(partial)).toThrow(/the face holds 6 of the ten digits/u);
    expect(() => withTabularDigits(partial)).toThrow(/the face holds 6 of the ten digits/u);
  });

  it('a face whose tnum leaves a digit as it is: one already mapped', async () => {
    const mapped = withTabularDigits(await decoded(INTER_LATIN));
    expect(() => tabularDigitGlyphs(mapped)).toThrow(/tnum leaves U\+0030 as it is/u);
    expect(() => withTabularDigits(mapped)).toThrow(/tnum leaves U\+0030 as it is/u);
  });

  it('a face whose tnum gives two digits one glyph', async () => {
    const input = await decoded(INTER_LATIN);
    const mapping = mappingOf(input);
    // 1 drawn with the glyph of 0: tnum gives both zero.tf.
    mapping.set(0x31, mapping.get(0x30) ?? 0);
    const shared = withMapping(input, mapping);
    expect(() => withTabularDigits(shared)).toThrow(/tnum gives two digits one glyph/u);
  });

  it('a face whose tabular digits take two advances at the default', async () => {
    const input = await decoded(INTER_LATIN);
    const oneTf = fontOf(input).glyphFromName('one.tf') ?? 0;
    const wider = Uint8Array.from(input);
    // numberOfHMetrics covers every glyph, so one.tf's advance is its own hmtx entry.
    const at = tableOf(wider, 'hmtx').offset + oneTf * 4;
    viewOf(wider).setUint16(at, viewOf(wider).getUint16(at) + 1);
    expect(() => withTabularDigits(wider)).toThrow(
      /the tabular digits take 2 advances at the default/u,
    );
  });

  it('a face whose tabular digits take one advance at the default but two at another instance', async () => {
    const input = await decoded(INTER_LATIN);
    const font = fontOf(input);
    const [one, oneTf] = [font.glyphFromName('one') ?? 0, font.glyphFromName('one.tf') ?? 0];
    const varied = Uint8Array.from(input);
    const view = viewOf(varied);
    // HVAR's advance map points one.tf at the deltas of the proportional 1.
    const hvar = tableOf(varied, 'HVAR').offset;
    const map = hvar + view.getUint32(hvar + 8);
    expect(view.getUint32(hvar + 8)).toBeGreaterThan(0);
    const format = view.getUint8(map);
    const size = ((view.getUint8(map + 1) >> 4) & 3) + 1;
    const entries = map + (format === 0 ? 4 : 6);
    varied.copyWithin(entries + oneTf * size, entries + one * size, entries + (one + 1) * size);
    expect(differingBytes(input, varied).length).toBeGreaterThan(0);
    expect(() => withTabularDigits(varied)).toThrow(
      /the tabular digits take 2 advances at wght 100, opsz 14/u,
    );
  });

  it('a cmap with a subtable other than format 4', async () => {
    const input = await decoded(INTER_LATIN);
    const mapping = mappingOf(input);
    // A format 12 subtable for (3,10), which HarfBuzz reads first, beside the format 4 one.
    const twelve = withTable(
      input,
      'cmap',
      cmapTable(
        [
          [0, 3, 0],
          [3, 1, 0],
          [3, 10, 1],
        ],
        [format4(mapping), format12(mapping)],
      ),
    );
    expect(mappingOf(twelve)).toEqual(mapping);
    expect(tabularDigitGlyphs(twelve)).toEqual(tabularDigitGlyphs(input));
    expect(() => withTabularDigits(twelve)).toThrow(/the cmap has a format 12 subtable/u);
  });

  it('an idDelta segment that holds more than the digits', async () => {
    const input = await decoded(INTER_LATIN);
    const mapping = mappingOf(input);
    // The slash on the glyph before zero joins the digits' idDelta segment.
    mapping.set(SLASH, (mapping.get(0x30) ?? 0) - 1);
    const joined = withMapping(input, mapping);
    expect(format4Segments(joined)[0]?.find(({ end }) => end === 0x39)?.start).toBe(SLASH);
    expect(() => withTabularDigits(joined)).toThrow(
      /the cmap segment U\+002F-U\+0039 holds more than digits/u,
    );
  });
});

describe("checking a copy's cmap against its input", () => {
  it('finds nothing in the mapped copy with tabularDigits or an unchanged copy without', async () => {
    const input = await decoded(INTER_LATIN);
    const mapped = withTabularDigits(input);
    expect(tabularDigitsProblems(input, mapped, true)).toEqual([]);
    expect(tabularDigitsProblems(input, Uint8Array.from(input), false)).toEqual([]);
    const cyrillic = await decoded(INTER_CYRILLIC);
    expect(tabularDigitsProblems(cyrillic, Uint8Array.from(cyrillic), true)).toEqual([]);
  });

  it('names each digit left proportional with tabularDigits, or mapped without', async () => {
    const input = await decoded(INTER_LATIN);
    const mapped = withTabularDigits(input);
    const plain = DIGIT_CODE_POINTS.map((code) => mappingOf(input).get(code));
    const tabular = tabularDigitGlyphs(input) ?? [];
    const hex = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    expect(tabularDigitsProblems(input, Uint8Array.from(input), true)).toEqual(
      DIGIT_CODE_POINTS.map(
        (code, index) =>
          `the copy maps ${hex(code)} to glyph ${plain[index]}, not ${tabular[index]}`,
      ),
    );
    expect(tabularDigitsProblems(input, mapped, false)).toEqual(
      DIGIT_CODE_POINTS.map(
        (code, index) =>
          `the copy maps ${hex(code)} to glyph ${tabular[index]}, not ${plain[index]}`,
      ),
    );
  });

  it('names any other code point mapped to another glyph, and a copy that maps other code points', async () => {
    const input = await decoded(INTER_LATIN);
    const mapping = mappedDigits(input);
    const a = mapping.get(0x41) ?? 0;
    mapping.set(0x41, mapping.get(0x42) ?? 0);
    expect(tabularDigitsProblems(input, withMapping(input, mapping), true)).toEqual([
      `the copy maps U+0041 to glyph ${mapping.get(0x42)}, not ${a}`,
    ]);
    mapping.delete(0x41);
    expect(tabularDigitsProblems(input, withMapping(input, mapping), true)).toEqual([
      'the copy maps other code points than its input',
    ]);
  });
});

describe('the face generator with tabularDigits', () => {
  it('bakes Inter latin into the committed copy, its digits on the tabular glyphs', async () => {
    const input = await readFile(join(ROOT, INTER_LATIN));
    const baked = await bakeFace(input, INTER_TARGET, true);
    expect(Buffer.from(baked.woff2).equals(await readFile(join(ROOT, APP_INTER_LATIN)))).toBe(true);
    expect(mappingOf(baked.sfnt)).toEqual(mappedDigits(await decoded(INTER_LATIN)));
  }, 60_000);

  it('keeps the proportional digits without it', async () => {
    const input = await readFile(join(ROOT, INTER_LATIN));
    const baked = await bakeFace(input, INTER_TARGET);
    expect(mappingOf(baked.sfnt)).toEqual(mappingOf(await decoded(INTER_LATIN)));
  }, 60_000);
});
