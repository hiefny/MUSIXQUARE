/**
 * The app's generated font sheets in css/fonts/app/ (scripts/fonts/build-font-sheets.mts).
 *
 * The range edits make each script come from exactly one family, so the
 * browser never picks a second family for it and the Korean and English UIs
 * draw the same content with the same faces:
 * - Inter draws every code point its cmap has inside its Google subset ranges.
 *   Those code points are cut from the four CJK families by Inter's cmap, never
 *   by its declared ranges, so the marks Inter lacks (※ ― ‥ ‰ ‼ ...) stay in
 *   the CJK families instead of falling to a device font.
 * - Hangul is only in Noto Sans KR and kana only in Noto Sans JP.
 * - Invisible and space marks Inter's subsets lack belong to no CJK family.
 * - A CJK face declares only what its file draws, so no character makes the
 *   browser download a shard that cannot draw it.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildFontSheets } from '../../../scripts/fonts/build-font-sheets.mts';
import {
  fontCodePoints,
  openFontFile,
  parseFontFaceRules,
  parseUnicodeRange,
  readFontSources,
  type FontFaceRule,
} from '../../../scripts/fonts/font-files.mts';
import { APP_FONT_SHEETS } from '../app-font-contract.ts';

const ROOT = resolve('.');
const GENERATED_SHEETS = APP_FONT_SHEETS.filter(({ path }) => path.startsWith('css/fonts/app/'));
const CJK_SHEET_IDS = ['font-noto-kr', 'font-noto-jp', 'font-noto-sc', 'font-noto-tc'] as const;

type Range = readonly [number, number];
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
/** Inside Inter's declared ranges, missing from Inter's cmap, drawn by Noto Sans KR. */
const MARKS_INTER_LACKS = [
  0x00ad, 0x2010, 0x2015, 0x2016, 0x2021, 0x2025, 0x2030, 0x2035, 0x203b, 0x203c, 0x2042,
];

const inRanges = (codePoint: number, ranges: readonly Range[]): boolean =>
  ranges.some(([start, end]) => codePoint >= start && codePoint <= end);

function sheetPath(id: string): string {
  const sheet = APP_FONT_SHEETS.find((entry) => entry.id === id);
  if (!sheet) throw new Error(`Unknown app font sheet ${id}`);
  return sheet.path;
}

async function readRules(id: string): Promise<readonly FontFaceRule[]> {
  return parseFontFaceRules(await readFile(join(ROOT, sheetPath(id)), 'utf8'));
}

async function declaredCodePoints(id: string): Promise<Set<number>> {
  const declared = new Set<number>();
  for (const rule of await readRules(id)) {
    for (const codePoint of parseUnicodeRange(rule.unicodeRange ?? '')) declared.add(codePoint);
  }
  return declared;
}

/** Code points a sheet's faces really draw: each file's cmap inside its own declared range. */
async function drawnCodePoints(id: string): Promise<Set<number>> {
  const drawn = new Set<number>();
  for (const rule of await readRules(id)) {
    const declared = parseUnicodeRange(rule.unicodeRange ?? '');
    const file = resolve(dirname(join(ROOT, sheetPath(id))), rule.url);
    for (const codePoint of fontCodePoints(await openFontFile(file))) {
      if (declared.has(codePoint)) drawn.add(codePoint);
    }
  }
  return drawn;
}

describe('generated app font sheets', () => {
  it('are the generator output byte for byte', async () => {
    const built = await buildFontSheets(ROOT);
    expect(built.map(({ path }) => path)).toEqual(GENERATED_SHEETS.map(({ path }) => path));
    for (const { path, css } of built) {
      expect(await readFile(join(ROOT, path), 'utf8'), path).toBe(css);
    }
  }, 60_000);

  it('declare one family per sheet with the numbered CJK shards only', async () => {
    const counts: Record<string, number> = {};
    for (const sheet of GENERATED_SHEETS) {
      const rules = await readRules(sheet.id);
      expect(new Set(rules.map(({ family }) => family)), sheet.path).toEqual(
        new Set([sheet.family]),
      );
      counts[sheet.id] = rules.length;
    }
    expect(counts).toEqual({
      'font-inter': 7,
      'font-noto-kr': 120,
      'font-noto-jp': 120,
      'font-noto-sc': 95,
      'font-noto-tc': 98,
      'font-noto-thai': 1,
    });
    for (const id of CJK_SHEET_IDS) {
      for (const rule of await readRules(id)) expect(rule.file, id).toMatch(/\.\d+\.woff2$/u);
    }
  });

  it("keep Google's Inter ranges, one face per recorded subset", async () => {
    const { inter } = await readFontSources(ROOT);
    const rules = await readRules('font-inter');
    expect(rules.map(({ file }) => file)).toEqual(inter.faces.map(({ file }) => file));
    for (const face of inter.faces) {
      const rule = rules.find(({ file }) => file === face.file);
      expect(rule?.unicodeRange, face.file).toBe(face.unicodeRange);
    }
  });

  it("give Latin, Cyrillic and Greek to Inter alone, cut by Inter's cmap", async () => {
    const interDrawn = await drawnCodePoints('font-inter');
    expect(interDrawn.size).toBe(1_622);
    for (const id of CJK_SHEET_IDS) {
      const declared = await declaredCodePoints(id);
      const overlap = [...interDrawn].filter((codePoint) => declared.has(codePoint));
      expect(
        overlap.map((codePoint) => codePoint.toString(16)),
        id,
      ).toEqual([]);
    }
    // A cut by Inter's declared ranges would drop these to a device font chosen by html lang.
    const korean = await declaredCodePoints('font-noto-kr');
    expect(MARKS_INTER_LACKS.filter((codePoint) => !korean.has(codePoint))).toEqual([]);
    expect(MARKS_INTER_LACKS.filter((codePoint) => interDrawn.has(codePoint))).toEqual([]);
  }, 60_000);

  it('give Hangul to Noto Sans KR and kana to Noto Sans JP only, and invisible marks to none', async () => {
    const declared = Object.fromEntries(
      await Promise.all(
        CJK_SHEET_IDS.map(async (id) => [id, [...(await declaredCodePoints(id))]] as const),
      ),
    ) as Record<(typeof CJK_SHEET_IDS)[number], number[]>;
    const hex = (codePoints: readonly number[]): string[] =>
      codePoints.map((codePoint) => codePoint.toString(16));

    for (const id of CJK_SHEET_IDS) {
      const codePoints = declared[id];
      expect(codePoints.length, id).toBeGreaterThan(0);
      expect(hex(codePoints.filter((codePoint) => inRanges(codePoint, INVISIBLE))), id).toEqual([]);
      if (id !== 'font-noto-kr') {
        expect(hex(codePoints.filter((codePoint) => inRanges(codePoint, HANGUL))), id).toEqual([]);
      }
      if (id !== 'font-noto-jp') {
        expect(hex(codePoints.filter((codePoint) => inRanges(codePoint, KANA))), id).toEqual([]);
      }
    }
    expect(declared['font-noto-kr'].some((codePoint) => inRanges(codePoint, HANGUL))).toBe(true);
    expect(declared['font-noto-jp'].some((codePoint) => inRanges(codePoint, KANA))).toBe(true);
  });

  it('declare in each CJK face only the code points its file draws', async () => {
    // Google's CJK ranges claim characters some shards do not draw: emoji,
    // regional indicators, and a few Thai, Arabic, Hebrew and Devanagari
    // letters. With the four CJK families in every UI's stack, the browser
    // would download such a shard for nothing and then move on to the next
    // family: 👍 in the Korean or English UI would fetch a 70 KB Traditional
    // Chinese shard, ❤ a Simplified and a Traditional one.
    const claimed: Record<string, { count: number; first: string[] }> = {};
    for (const id of CJK_SHEET_IDS) {
      const entry = { count: 0, first: [] as string[] };
      for (const rule of await readRules(id)) {
        const file = resolve(dirname(join(ROOT, sheetPath(id))), rule.url);
        const drawn = fontCodePoints(await openFontFile(file));
        for (const codePoint of parseUnicodeRange(rule.unicodeRange ?? '')) {
          if (drawn.has(codePoint)) continue;
          entry.count += 1;
          if (entry.first.length < 5) {
            entry.first.push(`${rule.file} U+${codePoint.toString(16).toUpperCase()}`);
          }
        }
      }
      claimed[id] = entry;
    }
    expect(claimed).toEqual(
      Object.fromEntries(CJK_SHEET_IDS.map((id) => [id, { count: 0, first: [] }])),
    );
  }, 60_000);

  it('cover every Hangul syllable in Noto Sans KR by cmap and range', async () => {
    const drawn = await drawnCodePoints('font-noto-kr');
    const missing: string[] = [];
    for (let codePoint = 0xac00; codePoint <= 0xd7a3; codePoint += 1) {
      if (!drawn.has(codePoint)) missing.push(codePoint.toString(16));
    }
    expect(missing).toEqual([]);
  }, 60_000);

  it('keep the Thai face of the Google sheet as it is', async () => {
    const [thai, ...others] = await readRules('font-noto-thai');
    expect(others).toEqual([]);
    const google = parseFontFaceRules(
      await readFile(join(ROOT, 'css/fonts/noto-thai.css'), 'utf8'),
    ).filter((rule) => parseUnicodeRange(rule.unicodeRange ?? '').has(0x0e01));
    expect(google).toHaveLength(1);
    expect(thai?.file).toBe(google[0]?.file);
    expect(thai && Object.fromEntries(thai.declarations)).toEqual({
      ...Object.fromEntries(google[0]?.declarations ?? []),
      src: google[0]?.declarations.get('src')?.replace('../../fonts/', '../../../fonts/'),
    });
  });

  it('point every face at a self-hosted WOFF2 file and name its license', async () => {
    for (const sheet of GENERATED_SHEETS) {
      const css = await readFile(join(ROOT, sheet.path), 'utf8');
      const license = /License: (fonts\/[A-Z_]+_LICENSE\.txt) \(SIL OFL 1\.1\)/u.exec(css)?.[1];
      expect(license, sheet.path).toBeDefined();
      await expect(readFile(join(ROOT, license ?? ''), 'utf8')).resolves.toContain(
        'SIL OPEN FONT LICENSE',
      );
      expect(css, sheet.path).toContain('Generated by scripts/fonts/build-font-sheets.mts');
      for (const rule of parseFontFaceRules(css)) {
        expect(rule.url, sheet.path).not.toMatch(/^(?:https?:)?\/\//u);
        const bytes = await readFile(resolve(dirname(join(ROOT, sheet.path)), rule.url));
        expect(bytes.subarray(0, 4).toString('latin1'), rule.url).toBe('wOF2');
      }
    }
  });
});
