/**
 * The app's Hangul faces (owner decision 2026-11-02: Pretendard draws Hangul
 * again): the subsets of fonts/PretendardVariable.woff2 in fonts/app/hangul/
 * that scripts/fonts/build-hangul-faces.mts writes and fonts/hangul-faces.json
 * records.
 *
 * They must draw exactly Pretendard's Hangul (its outlines and advances at
 * the weights the app uses), nothing but Hangul, with Pretendard's own line
 * box (the box every other app face is sized to), no layout feature that
 * html lang could switch, and a name of their own under the SIL OFL.
 */
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as hb from 'harfbuzzjs';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  bakeLineMetrics,
  readLineMetrics,
  sfntTables,
} from '../../../scripts/fonts/app-face-metrics.mts';
import {
  buildHangulFace,
  buildHangulFaces,
  readHangulSource,
  type HangulSource,
} from '../../../scripts/fonts/build-hangul-faces.mts';
import {
  decodeFontBytes,
  digestOf,
  fontCodePoints,
  fontLayoutFeatures,
  hangulFaceProblems,
  isHangul,
  openFontBytes,
  parseUnicodeRange,
  readHangulFaces,
  verifyHangulFaces,
  type HangulFaces,
} from '../../../scripts/fonts/font-files.mts';
import {
  nameText,
  readNameTable,
  renameRecords,
  withNameRecords,
} from '../../../scripts/fonts/sfnt-names.mts';
import { HANGUL_LINE_BOX } from '../font-metrics.ts';

const ROOT = resolve('.');
const DIRECTORY = 'fonts/app/hangul';
const SOURCE_SHA256 = '9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4';
/** Google's Noto Sans KR v40 shards that declare Hangul, and 0 for the halfwidth jamo. */
const SHARDS = [
  0,
  ...Array.from({ length: 64 }, (_, index) => 2 + index),
  94,
  95,
  ...Array.from({ length: 20 }, (_, index) => 100 + index),
];
const HALFWIDTH_JAMO = 'U+FFA1-FFBE, U+FFC2-FFC7, U+FFCA-FFCF, U+FFD2-FFD7, U+FFDA-FFDC';

let record: HangulFaces;
let source: HangulSource;
const sfnts = new Map<string, Uint8Array>();

beforeAll(async () => {
  record = await readHangulFaces(ROOT);
  source = await readHangulSource(ROOT);
  for (const face of record.faces) {
    const bytes = await readFile(join(ROOT, DIRECTORY, face.file));
    sfnts.set(face.file, Uint8Array.from(await decodeFontBytes(bytes)));
  }
}, 60_000);

async function installedVersion(name: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'),
  ) as { version: string };
  return manifest.version;
}

describe('the Hangul faces', () => {
  it('record their source, its license, the tools and the line box', async () => {
    const bytes = await readFile(join(ROOT, 'fonts/PretendardVariable.woff2'));
    expect(digestOf(bytes)).toEqual({ sha256: SOURCE_SHA256, bytes: 2_057_688 });
    expect(record.source).toEqual({
      file: 'fonts/PretendardVariable.woff2',
      version: '1.309 (name ID 5)',
      sha256: SOURCE_SHA256,
      bytes: 2_057_688,
      license: 'fonts/PRETENDARD_LICENSE.txt',
      wght: [45, 930],
    });
    const license = await readFile(join(ROOT, record.source.license), 'utf8');
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(license).toContain('Reserved Font Name Pretendard');
    expect(record.names).toEqual({ family: 'MUSIXQUARE Hangul', postscript: 'MUSIXQUAREHangul' });
    expect(record.box).toEqual({ ...HANGUL_LINE_BOX });
    expect(record.directory).toBe(DIRECTORY);
    expect(record.tools).toEqual({
      'subset-font': await installedVersion('subset-font'),
      harfbuzzjs: await installedVersion('harfbuzzjs'),
      fontverter: await installedVersion('fontverter'),
      wawoff2: await installedVersion('wawoff2'),
    });
  });

  it('partition all of Pretendard’s Hangul by the Noto Sans KR shards, and nothing else', () => {
    expect(record.faces.map(({ shard }) => shard)).toEqual(SHARDS);
    expect(record.faces.map(({ file }) => file)).toEqual(
      SHARDS.map((shard) => `hangul.${shard}.woff2`),
    );
    const seen = new Set<number>();
    for (const face of record.faces) {
      for (const codePoint of parseUnicodeRange(face.unicodeRange)) {
        expect(seen.has(codePoint), `U+${codePoint.toString(16)} twice`).toBe(false);
        expect(isHangul(codePoint), `U+${codePoint.toString(16)} in ${face.file}`).toBe(true);
        seen.add(codePoint);
      }
    }
    expect(seen.size).toBe(11_277);
    const sourceHangul = [...source.codePoints].filter(isHangul);
    expect(sourceHangul.filter((codePoint) => !seen.has(codePoint))).toEqual([]);
    for (let codePoint = 0xac00; codePoint <= 0xd7a3; codePoint += 1) {
      expect(seen.has(codePoint)).toBe(true);
    }
    // ㈜ is Hangul Pretendard draws. It lacks ㉠, which Noto Sans KR keeps, and the
    // conjoining jamo, which no app face declares (a device font draws them).
    expect(seen.has(0x321c)).toBe(true);
    expect(seen.has(0x3260)).toBe(false);
    expect(seen.has(0x1100)).toBe(false);
    // No kana, Latin or punctuation of Pretendard.
    expect(seen.has(0x3042) || seen.has(0x0041) || seen.has(0x3001)).toBe(false);
    expect(record.faces[0]?.unicodeRange).toBe(HALFWIDTH_JAMO);
  });

  it('are exactly the recorded files, each mapping its own range', async () => {
    expect((await readdir(join(ROOT, DIRECTORY))).sort()).toEqual(
      record.faces.map(({ file }) => file).sort(),
    );
    for (const face of record.faces) {
      const bytes = await readFile(join(ROOT, DIRECTORY, face.file));
      expect(digestOf(bytes), face.file).toEqual({ sha256: face.sha256, bytes: face.bytes });
      const cmap = fontCodePoints(await openFontBytes(sfnts.get(face.file)!));
      expect(
        [...cmap].sort((a, b) => a - b),
        face.file,
      ).toEqual([...parseUnicodeRange(face.unicodeRange)].sort((a, b) => a - b));
    }
  });

  it("keep Pretendard's line box, wght axis and no layout feature", async () => {
    const box = { ascender: 1950, descender: 494, lineGap: 0 };
    for (const face of record.faces) {
      const sfnt = sfnts.get(face.file)!;
      expect(readLineMetrics(sfnt), face.file).toEqual({
        unitsPerEm: 2048,
        hhea: box,
        typo: box,
        useTypoMetrics: true,
        winAscent: 1950,
        winDescent: 494,
      });
      expect(sfntTables(sfnt).has('MVAR'), face.file).toBe(false);
      const font = await openFontBytes(sfnt);
      expect(font.getAxisInfos().wght, face.file).toMatchObject({ min: 45, max: 930 });
      // No locl or anything else: html lang cannot change how Hangul is shaped.
      expect([...fontLayoutFeatures(font)], face.file).toEqual([]);
    }
    expect(readLineMetrics(source.sfnt)).toMatchObject({
      unitsPerEm: HANGUL_LINE_BOX.unitsPerEm,
      hhea: box,
      typo: box,
    });
  });

  it('carry a name of their own and the source’s copyright and license records', () => {
    const sourceRecords = readNameTable(source.sfnt).records;
    const of = (records: typeof sourceRecords, nameId: number) =>
      records.filter((entry) => entry.nameId === nameId).map(nameText);
    for (const face of record.faces) {
      const records = readNameTable(sfnts.get(face.file)!).records;
      expect(records.filter((entry) => /pretendard/iu.test(nameText(entry) ?? ''))).toEqual([]);
      expect(of(records, 1), face.file).toEqual(['MUSIXQUARE Hangul']);
      expect(of(records, 6), face.file).toEqual(['MUSIXQUAREHangul-Regular']);
      for (const nameId of [0, 13, 14]) {
        expect(of(records, nameId), `${face.file} ID ${nameId}`).toEqual(of(sourceRecords, nameId));
      }
    }
    expect(of(sourceRecords, 0)).toHaveLength(2);
  });

  it("draw Pretendard's own outlines and advances at 400 and 700", async () => {
    for (const face of record.faces) {
      const codePoints = [...parseUnicodeRange(face.unicodeRange)];
      const samples = [
        codePoints[0],
        codePoints[Math.floor(codePoints.length / 2)],
        codePoints.at(-1),
      ];
      const subset = await openFontBytes(sfnts.get(face.file)!);
      const sourceFace = await openFontBytes(source.sfnt);
      for (const weight of [400, 700]) {
        const fonts = [sourceFace, subset].map((entry) => {
          const font = new hb.Font(entry);
          font.setVariations([new hb.Variation('wght', weight)]);
          return font;
        });
        for (const codePoint of samples) {
          const [before, after] = fonts.map((font) => {
            const glyph = font.nominalGlyph(codePoint ?? 0)!;
            return `${font.glyphHAdvance(glyph)} ${font.glyphToPath(glyph)}`;
          });
          expect(after, `${face.file} U+${codePoint?.toString(16)} wght ${weight}`).toBe(before);
        }
      }
    }
  });

  it('pass the verifier, which finds a renamed-back or re-boxed face', async () => {
    expect(await verifyHangulFaces(ROOT)).toEqual([]);
    const face = record.faces.at(-1)!;
    const sfnt = sfnts.get(face.file)!;
    const codePoints = parseUnicodeRange(face.unicodeRange);
    expect(await hangulFaceProblems(sfnt, source.sfnt, codePoints, record)).toEqual([]);
    const renamed = withNameRecords(
      sfnt,
      renameRecords(readNameTable(sfnt).records, [['MUSIXQUARE Hangul', 'Pretendard Variable']]),
    );
    expect((await hangulFaceProblems(renamed, source.sfnt, codePoints, record)).join('\n')).toMatch(
      /still name Pretendard/u,
    );
    const reboxed = bakeLineMetrics(sfnt, {
      unitsPerEm: 2048,
      ascender: 2000,
      descender: 500,
      lineGap: 0,
    });
    expect((await hangulFaceProblems(reboxed, source.sfnt, codePoints, record)).join('\n')).toMatch(
      /"ascender":2000/u,
    );
  });

  it('come out of the generator byte for byte', async () => {
    for (const shard of [0, 95, 119]) {
      const face = record.faces.find((entry) => entry.shard === shard)!;
      const built = await buildHangulFace(source, [...parseUnicodeRange(face.unicodeRange)]);
      expect(digestOf(built), face.file).toEqual({ sha256: face.sha256, bytes: face.bytes });
    }
  }, 60_000);

  it('are not cut again from a source that differs from its record unless --record accepts it', async () => {
    // A copy of what the default mode reads before it cuts anything: the
    // record, the tool manifests, the faces and a source file with other
    // bytes (the same font, as an uncompressed sfnt, which the generator
    // reads as readily as WOFF2).
    const scratch = await mkdtemp(join(tmpdir(), 'hangul-faces-'));
    try {
      await mkdir(join(scratch, DIRECTORY), { recursive: true });
      for (const file of [
        'fonts/hangul-faces.json',
        ...record.faces.map(({ file }) => `${DIRECTORY}/${file}`),
      ]) {
        await copyFile(join(ROOT, file), join(scratch, file));
      }
      for (const tool of Object.keys(record.tools)) {
        await mkdir(join(scratch, 'node_modules', tool), { recursive: true });
        await copyFile(
          join(ROOT, 'node_modules', tool, 'package.json'),
          join(scratch, 'node_modules', tool, 'package.json'),
        );
      }
      await writeFile(join(scratch, 'fonts/PretendardVariable.woff2'), source.sfnt);
      const snapshot = async () =>
        Promise.all(
          [
            'fonts/hangul-faces.json',
            ...record.faces.map(({ file }) => `${DIRECTORY}/${file}`),
          ].map(async (file) => [file, digestOf(await readFile(join(scratch, file)))] as const),
        );
      const before = await snapshot();
      await expect(buildHangulFaces(scratch, 'write')).rejects.toThrow(
        'fonts/PretendardVariable.woff2 differs from its record in fonts/hangul-faces.json (source.sha256, source.bytes). Nothing was written. Rerun with --record after review',
      );
      expect(await snapshot()).toEqual(before);
      expect((await readdir(join(scratch, DIRECTORY))).length).toBe(record.faces.length);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
