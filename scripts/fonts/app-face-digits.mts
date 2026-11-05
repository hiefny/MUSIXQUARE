/**
 * Tabular digits in the app's Inter (owner decision 2026-11-05): the face that
 * holds the digits 0-9 maps U+0030-0039 to the glyphs its own tnum feature
 * gives them (Inter's zero.tf ... nine.tf), so every digit takes one advance,
 * and the 1 its base bar, wherever the app sets text. The digits stay in the
 * same face and run as the letters and punctuation next to them, so calt (the
 * colon raised between digits, the case forms of + - ( ) [ ] next to them,
 * 3x4 to 3×4) and kern still see them. Inter's kerning has no pairs with the
 * tabular glyphs, so the space between a digit and its neighbour loses the
 * kerning the proportional digit had.
 *
 * The patch rewrites only the digits' entries of the face's cmap, in place:
 * the idDelta of a format 4 segment that holds only digits whose tabular
 * glyphs keep one delta, or the digits' glyphIdArray entries of a segment
 * that uses that array. Any other cmap layout is refused. The cmap keeps its
 * length and every other byte, and no other table changes;
 * scripts/fonts/build-app-faces.mts bakes the line box next, which computes
 * the checksums again.
 */
import * as hb from 'harfbuzzjs';

import { sfntTables } from './app-face-metrics.mts';

/** U+0030-0039. */
export const DIGIT_CODE_POINTS: readonly number[] = Array.from({ length: 10 }, (_, i) => 0x30 + i);

/**
 * The instances at which the tnum glyphs must be the same glyphs and share
 * one advance: the default and the corners of Inter's wght and opsz axes.
 */
const CHECKED_INSTANCES: readonly (readonly [string, number][])[] = [
  [],
  ...[100, 400, 700, 900].flatMap((wght) =>
    [14, 32].map((opsz): [string, number][] => [
      ['wght', wght],
      ['opsz', opsz],
    ]),
  ),
];

const hex = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

function fontOf(sfnt: Uint8Array): { face: hb.Face; font: hb.Font } {
  const face = new hb.Face(new hb.Blob(sfnt), 0);
  return { face, font: new hb.Font(face) };
}

function tnumGlyph(font: hb.Font, codePoint: number): number {
  const buffer = new hb.Buffer();
  buffer.addText(String.fromCodePoint(codePoint));
  buffer.guessSegmentProperties();
  hb.shape(font, buffer, [new hb.Feature('tnum')]);
  const glyphs = buffer.getGlyphInfos();
  const [glyph, ...rest] = glyphs;
  if (!glyph || rest.length)
    throw new Error(`tnum gives ${hex(codePoint)} ${glyphs.length} glyphs`);
  return glyph.codepoint;
}

/**
 * The glyph the face's tnum feature gives each digit, in digit order, or null
 * when the face holds none of them. Throws when it holds only some, when tnum
 * leaves a digit as it is, gives two digits one glyph or another glyph at
 * another instance, or when the ten take more than one advance at an
 * instance.
 */
export function tabularDigitGlyphs(sfnt: Uint8Array): number[] | null {
  const { face, font } = fontOf(sfnt);
  const codePoints = new Set(face.collectUnicodes());
  const held = DIGIT_CODE_POINTS.filter((codePoint) => codePoints.has(codePoint));
  if (!held.length) return null;
  if (held.length !== DIGIT_CODE_POINTS.length) {
    throw new Error(`the face holds ${held.length} of the ten digits`);
  }
  const glyphs = DIGIT_CODE_POINTS.map((codePoint) => tnumGlyph(font, codePoint));
  DIGIT_CODE_POINTS.forEach((codePoint, index) => {
    if (glyphs[index] === font.nominalGlyph(codePoint)) {
      throw new Error(`tnum leaves ${hex(codePoint)} as it is`);
    }
  });
  if (new Set(glyphs).size !== glyphs.length) throw new Error('tnum gives two digits one glyph');
  for (const instance of CHECKED_INSTANCES) {
    font.setVariations(instance.map(([tag, value]) => new hb.Variation(tag, value)));
    const where = instance.map(([tag, value]) => `${tag} ${value}`).join(', ') || 'the default';
    if (
      DIGIT_CODE_POINTS.some((codePoint, index) => tnumGlyph(font, codePoint) !== glyphs[index])
    ) {
      throw new Error(`tnum gives other glyphs at ${where}`);
    }
    const advances = new Set(glyphs.map((glyph) => font.glyphHAdvance(glyph)));
    if (advances.size !== 1) {
      throw new Error(`the tabular digits take ${advances.size} advances at ${where}`);
    }
  }
  return glyphs;
}

/**
 * A copy of the font whose cmap maps the ten digits to their tabular glyphs,
 * or an unchanged copy when the face holds no digits. Only the digits' cmap
 * entries change; the checksums are left for the line box patch to compute.
 */
export function withTabularDigits(sfnt: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(sfnt);
  const glyphs = tabularDigitGlyphs(sfnt);
  if (!glyphs) return copy;
  const cmap = sfntTables(sfnt).get('cmap');
  if (!cmap) throw new Error('no cmap table');
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  // Several encoding records can share one subtable: patch each subtable once.
  const subtables = new Set<number>();
  for (let index = 0; index < view.getUint16(cmap.offset + 2); index += 1) {
    subtables.add(cmap.offset + view.getUint32(cmap.offset + 8 + index * 8));
  }
  for (const at of subtables) {
    const format = view.getUint16(at);
    if (format !== 4) throw new Error(`the cmap has a format ${format} subtable`);
    const segmentsX2 = view.getUint16(at + 6);
    const ends = at + 14;
    const starts = ends + segmentsX2 + 2;
    const deltas = starts + segmentsX2;
    const rangeOffsets = deltas + segmentsX2;
    for (let segment = 0; segment < segmentsX2 / 2; segment += 1) {
      const start = view.getUint16(starts + segment * 2);
      const end = view.getUint16(ends + segment * 2);
      const digits = DIGIT_CODE_POINTS.filter(
        (codePoint) => codePoint >= start && codePoint <= end,
      );
      if (!digits.length) continue;
      const target = (codePoint: number): number => glyphs[codePoint - 0x30] ?? 0;
      const rangeOffset = view.getUint16(rangeOffsets + segment * 2);
      const delta = view.getUint16(deltas + segment * 2);
      if (rangeOffset === 0) {
        const newDeltas = new Set(
          digits.map((codePoint) => (target(codePoint) - codePoint) & 0xffff),
        );
        if (start < 0x30 || end > 0x39 || newDeltas.size !== 1) {
          throw new Error(
            `the cmap segment ${hex(start)}-${hex(end)} holds more than digits whose tabular glyphs keep one delta`,
          );
        }
        for (const newDelta of newDeltas) view.setUint16(deltas + segment * 2, newDelta);
      } else {
        for (const codePoint of digits) {
          const entry = rangeOffsets + segment * 2 + rangeOffset + (codePoint - start) * 2;
          if (view.getUint16(entry) === 0)
            throw new Error(`the cmap maps ${hex(codePoint)} to no glyph`);
          view.setUint16(entry, (target(codePoint) - delta) & 0xffff);
        }
      }
    }
  }
  return copy;
}

/**
 * Where the output's cmap differs from what it should be: the input's cmap,
 * with the digits mapped to their tabular glyphs when tabularDigits is set.
 * Empty when it is exactly that.
 */
export function tabularDigitsProblems(
  input: Uint8Array,
  output: Uint8Array,
  tabularDigits: boolean,
): string[] {
  const glyphs = tabularDigits ? tabularDigitGlyphs(input) : null;
  const before = fontOf(input);
  const after = fontOf(output);
  const codePoints = new Set(before.face.collectUnicodes());
  const copyCodePoints = new Set(after.face.collectUnicodes());
  if (
    codePoints.size !== copyCodePoints.size ||
    [...codePoints].some((code) => !copyCodePoints.has(code))
  ) {
    return ['the copy maps other code points than its input'];
  }
  const problems: string[] = [];
  for (const codePoint of codePoints) {
    const digit = DIGIT_CODE_POINTS.indexOf(codePoint);
    const wanted = glyphs && digit >= 0 ? glyphs[digit] : before.font.nominalGlyph(codePoint);
    const found = after.font.nominalGlyph(codePoint);
    if (found !== wanted)
      problems.push(`the copy maps ${hex(codePoint)} to glyph ${found}, not ${wanted}`);
  }
  return problems;
}
