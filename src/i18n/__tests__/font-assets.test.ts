/**
 * The self-hosted Inter and Noto Sans KR files and their provenance record,
 * fonts/font-sources.json.
 *
 * Inter ships Google's v20 subsets byte for byte. The Noto Sans KR files are
 * Google's v40 shards with the Korean locl lookup removed
 * (scripts/fonts/build-noto-kr-nolocl.mts), so a mark next to Hangul takes the
 * same glyph in the Korean and the English UI. The record keeps the Google
 * URL and the sha256 of both the downloaded and the shipped bytes.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  fontLayoutFeatures,
  openFontFile,
  readFontSources,
  sha256Hex,
  verifyShippedFontFiles,
} from '../../../scripts/fonts/font-files.mts';

const ROOT = resolve('.');
const INTER_SUBSETS = [
  'cyrillic-ext',
  'cyrillic',
  'greek-ext',
  'greek',
  'vietnamese',
  'latin-ext',
  'latin',
] as const;
const KR_SHARD_PREFIX = 'PbykFmXiEBPT4ITbgNA5Cgm20xz64px_1hVWr0wuPNGmlQNMEfD4.';

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

describe('self-hosted Inter and Noto Sans KR files', () => {
  it('records the 7 Inter subsets and the 120 numbered Noto Sans KR shards from Google Fonts', async () => {
    const { inter, notoSansKr } = await readFontSources(ROOT);

    expect(inter.family).toBe('Inter');
    expect(inter.directory).toBe('fonts/inter');
    expect(inter.license).toBe('fonts/INTER_LICENSE.txt');
    expect(inter.sourceCss).toBe(
      'https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,100..900&display=swap',
    );
    expect(inter.faces.map(({ subset }) => subset)).toEqual(INTER_SUBSETS);
    expect(inter.faces.map(({ file }) => file)).toEqual(
      INTER_SUBSETS.map((subset) => `inter-${subset}.woff2`),
    );
    for (const face of inter.faces) {
      expect(face.url, face.file).toMatch(
        /^https:\/\/fonts\.gstatic\.com\/s\/inter\/v20\/[\w-]+\.woff2$/u,
      );
      // Inter is shipped exactly as downloaded.
      expect(face.shipped, face.file).toEqual(face.source);
    }
    expect(sum(inter.faces.map(({ source }) => source.bytes))).toBe(340_256);

    expect(notoSansKr.family).toBe('Noto Sans KR');
    expect(notoSansKr.directory).toBe('fonts/noto/noto-sans-kr');
    expect(notoSansKr.license).toBe('fonts/NOTO_CJK_LICENSE.txt');
    expect(notoSansKr.sourceCss).toBe(
      'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@100..900&display=swap',
    );
    expect(notoSansKr.faces.map(({ subset }) => subset)).toEqual(
      Array.from({ length: 120 }, (_, shard) => String(shard)),
    );
    for (const face of notoSansKr.faces) {
      expect(face.file).toBe(`${KR_SHARD_PREFIX}${face.subset}.woff2`);
      expect(face.url).toBe(`https://fonts.gstatic.com/s/notosanskr/v40/${face.file}`);
      // The shipped copy is re-encoded without locl, so its bytes differ.
      expect(face.shipped?.sha256, face.file).toMatch(/^[0-9a-f]{64}$/u);
      expect(face.shipped?.sha256, face.file).not.toBe(face.source.sha256);
    }
    expect(sum(notoSansKr.faces.map(({ source }) => source.bytes))).toBe(3_454_616);
    expect(sum(notoSansKr.faces.map(({ shipped }) => shipped?.bytes ?? 0))).toBe(3_425_472);
  });

  it('ships every recorded file byte for byte', async () => {
    const { inter, notoSansKr } = await readFontSources(ROOT);
    for (const family of [inter, notoSansKr]) {
      for (const face of family.faces) {
        const bytes = await readFile(join(ROOT, family.directory, face.file));
        expect(bytes.subarray(0, 4).toString('latin1'), face.file).toBe('wOF2');
        expect(bytes.byteLength, face.file).toBe(face.shipped?.bytes);
        expect(sha256Hex(bytes), face.file).toBe(face.shipped?.sha256);
      }
    }
  });

  it('keeps the Korean locl lookup out of every Noto Sans KR shard', async () => {
    const { notoSansKr } = await readFontSources(ROOT);
    const features = new Set<string>();
    for (const face of notoSansKr.faces) {
      const shardFeatures = fontLayoutFeatures(
        await openFontFile(join(ROOT, notoSansKr.directory, face.file)),
      );
      expect(shardFeatures.has('locl'), face.file).toBe(false);
      for (const feature of shardFeatures) features.add(feature);
    }
    // Every other layout feature stays, for example kerning and proportional CJK widths.
    expect([...features]).toEqual(expect.arrayContaining(['kern', 'palt', 'vert']));
  }, 60_000);

  it("keeps Google's copyright and license URL in every Noto Sans KR shard", async () => {
    // These are modified OFL fonts deployed under /assets/ with no license
    // file beside them, so the pointer inside each file must survive.
    const { notoSansKr } = await readFontSources(ROOT);
    const names = new Map<string, number>();
    for (const face of notoSansKr.faces) {
      const font = await openFontFile(join(ROOT, notoSansKr.directory, face.file));
      for (const [id, expected] of [
        [0, "(c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'."],
        [14, 'http://scripts.sil.org/OFL'],
      ] as const) {
        const value = font.getName(id, 'en');
        names.set(`${id} ${value}`, (names.get(`${id} ${value}`) ?? 0) + 1);
        expect(value, `${face.file} name ID ${id}`).toBe(expected);
      }
    }
    expect([...names.values()]).toEqual([120, 120]);
  }, 60_000);

  it('carries the Noto CJK license with its copyright and Reserved Font Name next to the files', async () => {
    const license = await readFile(join(ROOT, 'fonts/NOTO_CJK_LICENSE.txt'), 'utf8');
    expect(license.split('\n')[0]).toBe(
      "Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.",
    );
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('ships Inter 4 as one variable opsz and wght face per subset, with its contextual alternates', async () => {
    const { inter } = await readFontSources(ROOT);
    for (const face of inter.faces) {
      const font = await openFontFile(join(ROOT, inter.directory, face.file));
      const axes = font.getAxisInfos();
      expect(Object.keys(axes).sort(), face.file).toEqual(['opsz', 'wght']);
      expect([axes.opsz?.min, axes.opsz?.max], face.file).toEqual([14, 32]);
      expect([axes.wght?.min, axes.wght?.max], face.file).toEqual([100, 900]);
    }
    const latin = await openFontFile(join(ROOT, inter.directory, 'inter-latin.woff2'));
    // The release owner kept Inter's default contextual alternates ('->' as an arrow, 3x4 as 3×4).
    expect(fontLayoutFeatures(latin).has('calt')).toBe(true);
  });

  it('carries the Inter license next to the files', async () => {
    const license = await readFile(join(ROOT, 'fonts/INTER_LICENSE.txt'), 'utf8');
    expect(license).toContain(
      'Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)',
    );
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('lets the font guard catch a shipped file that no longer matches its record', async () => {
    const sources = await readFontSources(ROOT);
    expect(await verifyShippedFontFiles(ROOT, sources)).toEqual([]);

    const [first, ...rest] = sources.notoSansKr.faces;
    if (!first?.shipped) throw new Error('Missing the first Noto Sans KR record');
    const tampered = {
      ...sources,
      notoSansKr: {
        ...sources.notoSansKr,
        faces: [{ ...first, shipped: { ...first.shipped, sha256: '0'.repeat(64) } }, ...rest],
      },
    };
    expect(await verifyShippedFontFiles(ROOT, tampered)).toEqual([
      expect.stringContaining(first.file),
    ]);
  }, 60_000);
});
