/**
 * Inter's symbol faces (owner decisions 2026-11-17 and 2026-11-18): the
 * subsets of the full Inter (fonts/inter-full.ttf) in fonts/app/inter-symbols/
 * that scripts/fonts/build-inter-symbol-faces.mts writes and
 * fonts/inter-symbol-faces.json records.
 *
 * They hold the symbols the full Inter has and Google's Inter subsets lack,
 * but private use, combining marks, emoji, the enclosed alphanumerics and
 * ↩ ↪ ⏏ ❤, with the full Inter's outlines and advances at every instance, in
 * Inter's base forms (Google's feature set), with the Inter line box baked in
 * as in the other Inter faces, a glyf table OTS accepts, and Inter's own name.
 */
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { readLineMetrics, sfntTables } from '../../../scripts/fonts/app-face-metrics.mts';
import {
  buildInterSymbolFace,
  buildInterSymbolFaces,
  readInterSymbolSource,
  type InterSymbolSource,
} from '../../../scripts/fonts/build-inter-symbol-faces.mts';
import {
  INTER_INSTANCES,
  decodeFontBytes,
  digestOf,
  drawnGlyph,
  fontCodePoints,
  fontLayoutFeatures,
  formatUnicodeRange,
  interBuildProblems,
  interInstanceFonts,
  openFontBytes,
  openFontFile,
  parseFontFaceRules,
  parseUnicodeRange,
  readFontSources,
  verifyShippedFontFiles,
} from '../../../scripts/fonts/font-files.mts';
import {
  INTER_SYMBOL_FEATURES,
  interSubsetCodePoints,
  interSymbolFrame,
  interSymbolPartition,
  interSymbolSelection,
  readInterSymbolFaces,
  recordedExclusions,
  verifyInterSymbolFaces,
  type InterSymbolFaces,
} from '../../../scripts/fonts/inter-symbol-faces.mts';
import { readNameTable } from '../../../scripts/fonts/sfnt-names.mts';
import { INTER_FACE_METRICS } from '../font-metrics.ts';

const ROOT = resolve('.');
const DIRECTORY = 'fonts/app/inter-symbols';
const SOURCE = {
  sha256: '29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031',
  bytes: 876_576,
};
/** The faces in sheet order, with their code point counts. */
const FACES = [
  ['spaces', 15],
  ['punctuation', 49],
  ['arrows', 34],
  ['math', 19],
  ['letterlike', 55],
  ['fractions', 59],
  ['shapes', 49],
] as const;

let record: InterSymbolFaces;
let source: InterSymbolSource;
const sfnts = new Map<string, Uint8Array>();

beforeAll(async () => {
  record = await readInterSymbolFaces(ROOT);
  source = await readInterSymbolSource(ROOT);
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

/** The name IDs a font keeps, sorted. */
const nameIds = (sfnt: Uint8Array): number[] =>
  [...new Set(readNameTable(sfnt).records.map(({ nameId }) => nameId))].sort((a, b) => a - b);

describe("Inter's symbol faces", () => {
  it('record the full Inter they are cut from, the tools, the features, the names and the line box', async () => {
    expect(record.source).toEqual({
      file: 'fonts/inter-full.ttf',
      version: '4.001 (git-66647c0bb)',
      ...SOURCE,
      license: 'fonts/INTER_LICENSE.txt',
      axes: { opsz: [14, 32], wght: [100, 900] },
    });
    expect(digestOf(source.bytes)).toEqual(SOURCE);
    const { interFull } = await readFontSources(ROOT);
    expect(interFull.source).toEqual(SOURCE);
    expect(interFull.version).toBe(record.source.version);
    expect(record.tools).toEqual({
      'subset-font': await installedVersion('subset-font'),
      harfbuzzjs: await installedVersion('harfbuzzjs'),
      fontverter: await installedVersion('fontverter'),
      wawoff2: await installedVersion('wawoff2'),
    });
    // The box every Inter face holds, from its one home.
    expect(record.box).toEqual({
      unitsPerEm: INTER_FACE_METRICS.unitsPerEm,
      ascender: INTER_FACE_METRICS.ascender,
      descender: INTER_FACE_METRICS.descender,
      lineGap: INTER_FACE_METRICS.lineGap,
    });
    expect(record.directory).toBe(DIRECTORY);
    // What Google's subsets keep: their features and their name records.
    const { inter } = await readFontSources(ROOT);
    const googleFeatures = new Set<string>();
    const googleNames = new Set<number>();
    for (const face of inter.faces) {
      const bytes = await readFile(join(ROOT, inter.directory, face.file));
      const sfnt = Uint8Array.from(await decodeFontBytes(bytes));
      for (const feature of fontLayoutFeatures(await openFontBytes(sfnt))) {
        googleFeatures.add(feature);
      }
      for (const nameId of nameIds(sfnt)) googleNames.add(nameId);
    }
    expect([...record.features].sort()).toEqual([...googleFeatures].sort());
    expect(record.nameIds).toEqual([...googleNames].sort((a, b) => a - b));
  });

  it("select the symbols the full Inter has and the Google subsets lack, but the owner's exclusions", async () => {
    const selection = interSymbolSelection(
      source.codePoints,
      await interSubsetCodePoints(ROOT, await readFontSources(ROOT)),
    );
    expect(selection.codePoints).toHaveLength(280);
    expect(recordedExclusions(selection).map(({ name, count }) => [name, count])).toEqual([
      ['private use', 745],
      ['combining marks', 123],
      ['emoji presentation', 1],
      ['enclosed alphanumerics', 74],
      ['symbols a device font draws', 4],
    ]);
    expect(record.excluded).toEqual(recordedExclusions(selection));
    // Owner decision 2026-11-18: no enclosed series, and ↩ ↪ ⏏ ❤ stay as they are.
    expect(record.excluded.slice(2).map(({ unicodeRange }) => unicodeRange)).toEqual([
      'U+2B1C',
      'U+2460-2468, U+24B6-24CF, U+24EA, U+2780-2788, U+1F12F-1F149, U+1F16A-1F16B',
      'U+21A9-21AA, U+23CF, U+2764',
    ]);
    const faces = interSymbolPartition(selection.codePoints);
    expect(faces.map(({ name, codePoints }) => [name, codePoints.length])).toEqual(FACES);
    expect(record.faces.map(({ name, file, unicodeRange }) => [name, file, unicodeRange])).toEqual(
      faces.map(({ name, file, codePoints }) => [name, file, formatUnicodeRange(codePoints)]),
    );
    // The app's own symbols: the player's bitrate labels (≤ ≈), the help
    // lists' arrows (→ ←) and the French catalog's narrow no-break space.
    const holds = (name: string, characters: string) => {
      const codePoints = faces.find((face) => face.name === name)?.codePoints ?? [];
      return [...characters].every((character) =>
        codePoints.includes(character.codePointAt(0) ?? 0),
      );
    };
    expect([holds('math', '≤≈'), holds('arrows', '→←'), holds('spaces', '\u{202F}')]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('are exactly the recorded files, each mapping its own range, after Google’s seven in the Inter sheet', async () => {
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
    const sheet = 'css/fonts/app/font-inter.css';
    const rules = parseFontFaceRules(await readFile(join(ROOT, sheet), 'utf8'));
    expect(rules.slice(7).map(({ url, unicodeRange }) => [url, unicodeRange])).toEqual(
      record.faces.map(({ file, unicodeRange }) => [`../../../${DIRECTORY}/${file}`, unicodeRange]),
    );
    for (const rule of rules.slice(7)) {
      const file = resolve(dirname(join(ROOT, sheet)), rule.url);
      expect(fontCodePoints(await openFontFile(file)).size, rule.file).toBeGreaterThan(0);
    }
  });

  it("hold the Inter line box, the full Inter's win metrics and axes, Google's features and names, and a glyf table OTS accepts", async () => {
    const box = {
      ascender: INTER_FACE_METRICS.ascender,
      descender: INTER_FACE_METRICS.descender,
      lineGap: INTER_FACE_METRICS.lineGap,
    };
    expect(readLineMetrics(source.sfnt)).toMatchObject({ winAscent: 2269, winDescent: 660 });
    for (const face of record.faces) {
      const sfnt = sfnts.get(face.file)!;
      expect(readLineMetrics(sfnt), face.file).toEqual({
        unitsPerEm: 2048,
        hhea: box,
        typo: box,
        useTypoMetrics: true,
        winAscent: 2269,
        winDescent: 660,
      });
      expect(sfntTables(sfnt).get('glyf')?.length, face.file).toBeGreaterThan(0);
      const font = await openFontBytes(sfnt);
      const axes = font.getAxisInfos();
      expect([axes.opsz?.min, axes.opsz?.max, axes.wght?.min, axes.wght?.max], face.file).toEqual([
        14, 32, 100, 900,
      ]);
      // Inter's base forms: no case, stylistic sets, character variants or superiors.
      expect(
        [...fontLayoutFeatures(font)].filter((feature) => !INTER_SYMBOL_FEATURES.includes(feature)),
        face.file,
      ).toEqual([]);
      expect(nameIds(sfnt).filter((nameId) => !record.nameIds.includes(nameId))).toEqual([]);
      expect(font.getName(1, 'en'), face.file).toBe('Inter');
      expect(font.getName(5, 'en'), face.file).toBe('Version 4.001;git-66647c0bb');
    }
  });

  it("draw the full Inter's own outlines and advances at the default and every opsz and wght corner", async () => {
    for (const face of record.faces) {
      const codePoints = [...parseUnicodeRange(face.unicodeRange)];
      const fonts = interInstanceFonts(await openFontBytes(sfnts.get(face.file)!));
      for (const [index] of INTER_INSTANCES.entries()) {
        const [cut, full] = [fonts[index]!, source.fonts[index]!];
        for (const codePoint of codePoints) {
          expect(drawnGlyph(cut, codePoint), `${face.file} U+${codePoint.toString(16)}`).toBe(
            drawnGlyph(full, codePoint),
          );
        }
      }
    }
  });

  it('pass the verifier', async () => {
    expect(await verifyInterSymbolFaces(ROOT)).toEqual([]);
  });

  it('come out of the generator byte for byte', async () => {
    const frame = interSymbolFrame(source.bytes, source.version, record.source.license);
    for (const name of ['spaces', 'math']) {
      const face = record.faces.find((entry) => entry.name === name)!;
      const built = await buildInterSymbolFace(
        source,
        [...parseUnicodeRange(face.unicodeRange)],
        frame,
      );
      expect(digestOf(built), face.file).toEqual({ sha256: face.sha256, bytes: face.bytes });
    }
  }, 60_000);

  it('refuse a face whose glyf table would hold no bytes, which OTS refuses', async () => {
    // Spaces alone: every glyph is empty, so the glyf table is too, and
    // Chromium left such a face in error. The spaces face carries the dashes.
    const frame = interSymbolFrame(source.bytes, source.version, record.source.license);
    await expect(buildInterSymbolFace(source, [0x2003, 0x202f], frame)).rejects.toThrow(
      /glyf table has no bytes, which OTS refuses/u,
    );
  });

  it('take the full Inter only as the build of the Google subsets', async () => {
    const { inter } = await readFontSources(ROOT);
    const subsets: { file: string; face: Awaited<ReturnType<typeof openFontFile>> }[] = [];
    for (const face of inter.faces) {
      const file = `${inter.directory}/${face.file}`;
      subsets.push({ file, face: await openFontFile(join(ROOT, file)) });
    }
    expect(interBuildProblems(source.face, subsets)).toEqual([]);
    // The baked latin copy maps the digits to Inter's tabular glyphs: the same
    // build, other glyphs for ten code points, which the check finds.
    const baked = 'fonts/app/inter/inter-latin.woff2';
    expect(
      interBuildProblems(source.face, [
        { file: baked, face: await openFontFile(join(ROOT, baked)) },
      ]),
    ).toEqual([
      `${baked} draws 10 code points unlike the full Inter: U+0030 at the default instance, U+0031 at the default instance, U+0032 at the default instance, U+0033 at the default instance`,
    ]);
    // Another build or font: its name ID 5 differs.
    const other =
      'fonts/noto/noto-sans-kr/PbykFmXiEBPT4ITbgNA5Cgm20xz64px_1hVWr0wuPNGmlQNMEfD4.0.woff2';
    expect(
      interBuildProblems(source.face, [
        { file: other, face: await openFontFile(join(ROOT, other)) },
      ]),
    ).toEqual([
      expect.stringMatching(
        /names ".*" in its name ID 5, the full Inter "Version 4\.001;git-66647c0bb"$/u,
      ),
    ]);
  });

  it('let the font guard catch a full Inter that is not the recorded download', async () => {
    const sources = await readFontSources(ROOT);
    expect(await verifyShippedFontFiles(ROOT, sources, ['interFull'])).toEqual([]);
    const tampered = {
      ...sources,
      interFull: { ...sources.interFull, gitBlob: '0'.repeat(40), version: '4.000 (git-0)' },
    };
    expect(await verifyShippedFontFiles(ROOT, tampered, ['interFull'])).toEqual([
      'fonts/inter-full.ttf is not the Git blob 0000000000000000000000000000000000000000 of its record',
      'fonts/inter-full.ttf is Inter 4.001 (git-66647c0bb), the record 4.000 (git-0)',
    ]);
  });

  it('are not cut again from a full Inter that differs from its record unless --record accepts it', async () => {
    // A copy of what the default mode reads before it cuts anything, with a
    // full Inter of other bytes: the same font with four bytes appended.
    const scratch = await mkdtemp(join(tmpdir(), 'inter-symbol-faces-'));
    try {
      const { inter } = await readFontSources(ROOT);
      const files = [
        'fonts/inter-symbol-faces.json',
        'fonts/font-sources.json',
        ...inter.faces.map(({ file }) => `${inter.directory}/${file}`),
        ...record.faces.map(({ file }) => `${DIRECTORY}/${file}`),
      ];
      for (const file of files) {
        await mkdir(dirname(join(scratch, file)), { recursive: true });
        await copyFile(join(ROOT, file), join(scratch, file));
      }
      for (const tool of Object.keys(record.tools)) {
        await mkdir(join(scratch, 'node_modules', tool), { recursive: true });
        await copyFile(
          join(ROOT, 'node_modules', tool, 'package.json'),
          join(scratch, 'node_modules', tool, 'package.json'),
        );
      }
      await writeFile(
        join(scratch, 'fonts/inter-full.ttf'),
        Buffer.concat([Buffer.from(source.bytes), Buffer.alloc(4)]),
      );
      const snapshot = async () =>
        Promise.all(
          files.map(async (file) => [file, digestOf(await readFile(join(scratch, file)))] as const),
        );
      const before = await snapshot();
      await expect(buildInterSymbolFaces(scratch, 'write')).rejects.toThrow(
        'fonts/inter-full.ttf or the cut differs from its record in fonts/inter-symbol-faces.json (source). Nothing was written. Rerun with --record after review',
      );
      expect(await snapshot()).toEqual(before);
      expect((await readdir(join(scratch, DIRECTORY))).length).toBe(record.faces.length);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
