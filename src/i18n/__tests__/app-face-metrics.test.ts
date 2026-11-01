/**
 * The table patch that bakes a line box into an app face
 * (scripts/fonts/app-face-metrics.mts) and the per-face pipeline of its
 * generator (scripts/fonts/build-app-faces.mts): decode the WOFF2 input, patch
 * hhea, the OS/2 typo metrics and USE_TYPO_METRICS, fix the checksums, encode
 * again. Also the generator's default mode, which npm run generate:font-sheets
 * runs, around an encoder update: a recorded face baked again must give its
 * recorded bytes, so only --record can change the copies (and with them every
 * font URL) after a wawoff2 update.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  bakeLineMetrics,
  readLineMetrics,
  sfntChecksumsValid,
} from '../../../scripts/fonts/app-face-metrics.mts';
import { bakeFace, buildAppFaces } from '../../../scripts/fonts/build-app-faces.mts';
import {
  APP_FACES_PATH,
  APP_FACE_FAMILIES,
  decodeFontBytes,
  digestOf,
  parseAppFaces,
  writeAppFaces,
} from '../../../scripts/fonts/font-files.mts';
import { CJK_FACE_METRICS, INTER_FACE_METRICS } from '../font-metrics.ts';

const ROOT = resolve('.');
const KR_SHARD = 'PbykFmXiEBPT4ITbgNA5Cgm20xz64px_1hVWr0wuPNGmlQNMEfD4.119.woff2';
const KR_INPUT = `fonts/noto/noto-sans-kr/${KR_SHARD}`;
const KR_OUTPUT = `fonts/app/noto-sans-kr/${KR_SHARD}`;
const INTER_INPUT = 'fonts/inter/inter-latin.woff2';
const CJK_TARGET = {
  unitsPerEm: CJK_FACE_METRICS.unitsPerEm,
  ascender: CJK_FACE_METRICS.ascender,
  descender: CJK_FACE_METRICS.descender,
  lineGap: CJK_FACE_METRICS.lineGap,
};
const INTER_TARGET = {
  unitsPerEm: INTER_FACE_METRICS.unitsPerEm,
  ascender: INTER_FACE_METRICS.ascender,
  descender: INTER_FACE_METRICS.descender,
  lineGap: INTER_FACE_METRICS.lineGap,
};

/** A copy of a file's sfnt: the decoder returns a view into memory it reuses. */
async function decoded(path: string): Promise<Uint8Array> {
  return Uint8Array.from(await decodeFontBytes(await readFile(join(ROOT, path))));
}

/** The directory record of a table: its offset in the font and the record's own offset. */
function tableRecord(sfnt: Uint8Array, tag: string): { record: number; offset: number } {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  for (let index = 0; index < view.getUint16(4); index += 1) {
    const record = 12 + index * 16;
    if (String.fromCharCode(...sfnt.subarray(record, record + 4)) === tag) {
      return { record, offset: view.getUint32(record + 8) };
    }
  }
  throw new Error(`no ${tag} table`);
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

describe('baking a line box into a face', () => {
  it('reads the line metrics of the inputs as Google ships them', async () => {
    expect(readLineMetrics(await decoded(INTER_INPUT))).toEqual({
      unitsPerEm: 2048,
      hhea: { ascender: 1984, descender: 494, lineGap: 0 },
      typo: { ascender: 1984, descender: 494, lineGap: 0 },
      useTypoMetrics: true,
      winAscent: 2269,
      winDescent: 660,
    });
    expect(readLineMetrics(await decoded(KR_INPUT))).toEqual({
      unitsPerEm: 1000,
      hhea: { ascender: 1160, descender: 288, lineGap: 0 },
      typo: { ascender: 880, descender: 120, lineGap: 0 },
      useTypoMetrics: false,
      winAscent: 1160,
      winDescent: 288,
    });
  });

  it('writes the box into hhea and the OS/2 typo metrics, sets USE_TYPO_METRICS and keeps the win metrics', async () => {
    const input = await decoded(KR_INPUT);
    const copy = Uint8Array.from(input);
    const baked = bakeLineMetrics(input, CJK_TARGET);
    expect(input).toEqual(copy);
    expect(readLineMetrics(baked)).toEqual({
      unitsPerEm: 1000,
      hhea: { ascender: 1013, descender: 257, lineGap: 0 },
      typo: { ascender: 1013, descender: 257, lineGap: 0 },
      useTypoMetrics: true,
      winAscent: 1160,
      winDescent: 288,
    });

    // Only the patched fields, the checksums of their tables and head's
    // checkSumAdjustment change.
    const head = tableRecord(input, 'head');
    const hhea = tableRecord(input, 'hhea');
    const os2 = tableRecord(input, 'OS/2');
    const allowed = [
      [head.offset + 8, head.offset + 12],
      [hhea.offset + 4, hhea.offset + 10],
      [os2.offset + 62, os2.offset + 64],
      [os2.offset + 68, os2.offset + 74],
      ...[head, hhea, os2].map(({ record }) => [record + 4, record + 8]),
    ];
    expect(
      differingBytes(input, baked).filter(
        (offset) => !allowed.some(([start = 0, end = 0]) => offset >= start && offset < end),
      ),
    ).toEqual([]);
  });

  it('keeps every table checksum and head.checkSumAdjustment valid', async () => {
    const input = await decoded(INTER_INPUT);
    expect(sfntChecksumsValid(input)).toBe(true);
    const baked = bakeLineMetrics(input, INTER_TARGET);
    expect(sfntChecksumsValid(baked)).toBe(true);

    const glyph = Uint8Array.from(baked);
    const glyf = tableRecord(glyph, 'glyf');
    glyph[glyf.offset + 20] = (glyph[glyf.offset + 20] ?? 0) ^ 0xff;
    expect(sfntChecksumsValid(glyph)).toBe(false);
    const adjustment = Uint8Array.from(baked);
    const head = tableRecord(adjustment, 'head');
    adjustment[head.offset + 11] = (adjustment[head.offset + 11] ?? 0) ^ 0x01;
    expect(sfntChecksumsValid(adjustment)).toBe(false);
  });

  it('is idempotent', async () => {
    const once = bakeLineMetrics(await decoded(INTER_INPUT), INTER_TARGET);
    expect(bakeLineMetrics(once, INTER_TARGET)).toEqual(once);
  });

  it('encodes the same WOFF2 bytes every time, and a baked face bakes to itself', async () => {
    const input = await readFile(join(ROOT, KR_INPUT));
    const first = await bakeFace(input, CJK_TARGET);
    const second = await bakeFace(input, CJK_TARGET);
    expect(Buffer.from(second.woff2).equals(Buffer.from(first.woff2))).toBe(true);
    // The committed copy is that output, and baking it again changes nothing.
    const committed = await readFile(join(ROOT, KR_OUTPUT));
    expect(Buffer.from(first.woff2).equals(committed)).toBe(true);
    const again = await bakeFace(committed, CJK_TARGET);
    expect(Buffer.from(again.woff2).equals(committed)).toBe(true);
    // The WOFF2 round trip keeps the patched tables exactly.
    expect(Uint8Array.from(await decodeFontBytes(first.woff2))).toEqual(first.sfnt);
    expect(first.sfnt).toEqual(bakeLineMetrics(await decoded(KR_INPUT), CJK_TARGET));
  }, 60_000);

  it('refuses bytes that are not an sfnt and a face without hhea', async () => {
    const woff2 = await readFile(join(ROOT, KR_INPUT));
    expect(() => bakeLineMetrics(woff2, CJK_TARGET)).toThrow(/not an sfnt/u);
    const renamed = Uint8Array.from(await decoded(KR_INPUT));
    renamed.set([0x68, 0x68, 0x65, 0x7a], tableRecord(renamed, 'hhea').record);
    expect(() => bakeLineMetrics(renamed, CJK_TARGET)).toThrow(/no hhea table/u);
  });

  it('refuses an OS/2 table older than version 4, which has no USE_TYPO_METRICS bit', async () => {
    const old = Uint8Array.from(await decoded(KR_INPUT));
    const os2 = tableRecord(old, 'OS/2');
    old.set([0, 3], os2.offset);
    expect(() => bakeLineMetrics(old, CJK_TARGET)).toThrow(/OS\/2 version 3/u);
  });

  it('refuses a units-per-em other than the target box was computed for', async () => {
    const inter = await decoded(INTER_INPUT);
    expect(() => bakeLineMetrics(inter, CJK_TARGET)).toThrow(/unitsPerEm 2048.*1000/u);
  });

  it('refuses a face whose MVAR varies a line metric', async () => {
    const varied = Uint8Array.from(await decoded(INTER_INPUT));
    const mvar = tableRecord(varied, 'MVAR');
    // The first value record's tag becomes 'hasc' (the OS/2 typo ascender).
    varied.set([0x68, 0x61, 0x73, 0x63], mvar.offset + 12);
    expect(() => bakeLineMetrics(varied, INTER_TARGET)).toThrow(/MVAR varies hasc/u);
  });
});

/** The installed wawoff2 version, which the generator reads from node_modules. */
async function installedEncoder(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(join(ROOT, 'node_modules', 'wawoff2', 'package.json'), 'utf8'),
  );
  const version =
    typeof manifest === 'object' && manifest !== null && 'version' in manifest
      ? manifest.version
      : undefined;
  if (typeof version !== 'string') throw new Error('no wawoff2 version');
  return version;
}

interface SmallRepository {
  readonly root: string;
  /** The face list the generator bakes, one input per app sheet. */
  readonly inputs: { sheet: string; files: string[] }[];
  /** The committed copy of each family's face. */
  readonly outputs: string[];
}

/**
 * A repository holding the smallest face of each family: its input, its
 * committed copy and their record entry, recorded as made by the given
 * wawoff2 version, and node_modules naming the installed version.
 */
async function smallRepository(recordedEncoder: string): Promise<SmallRepository> {
  const record = parseAppFaces(await readFile(join(ROOT, APP_FACES_PATH), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'app-faces-'));
  const inputs: { sheet: string; files: string[] }[] = [];
  const outputs: string[] = [];
  const families = [];
  for (const family of record.families) {
    const sheet = APP_FACE_FAMILIES.find((spec) => spec.family === family.family)?.sheet;
    const [face] = [...family.faces].sort((left, right) => left.input.bytes - right.input.bytes);
    if (!sheet || !face) throw new Error(`no ${family.family} face`);
    for (const folder of [family.input, family.output]) {
      await mkdir(join(root, folder), { recursive: true });
      await copyFile(join(ROOT, folder, face.file), join(root, folder, face.file));
    }
    inputs.push({ sheet, files: [`${family.input}/${face.file}`] });
    outputs.push(`${family.output}/${face.file}`);
    families.push({ ...family, faces: [face] });
  }
  await writeAppFaces(root, { ...record, tools: { wawoff2: recordedEncoder }, families });
  await mkdir(join(root, 'node_modules', 'wawoff2'), { recursive: true });
  await writeFile(
    join(root, 'node_modules', 'wawoff2', 'package.json'),
    JSON.stringify({ name: 'wawoff2', version: await installedEncoder() }),
  );
  return { root, inputs, outputs };
}

/** Whether a copy in the small repository has the bytes of the committed one. */
async function sameAsCommitted(root: string, output: string): Promise<boolean> {
  return (await readFile(join(root, output))).equals(await readFile(join(ROOT, output)));
}

describe('the default mode of the face generator', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('keeps every recorded copy without baking it again', async () => {
    const repository = await smallRepository(await installedEncoder());
    roots.push(repository.root);
    const before = await readFile(join(repository.root, APP_FACES_PATH), 'utf8');

    const result = await buildAppFaces(repository.root, 'write', repository.inputs);

    expect(result.baked).toBe(0);
    expect(result.changed).toEqual([]);
    expect(await readFile(join(repository.root, APP_FACES_PATH), 'utf8')).toBe(before);
  }, 60_000);

  it('takes a new wawoff2 version that gives the recorded bytes', async () => {
    const repository = await smallRepository('0.0.0-recorded');
    roots.push(repository.root);

    const result = await buildAppFaces(repository.root, 'write', repository.inputs);

    expect(result.baked).toBe(repository.outputs.length);
    expect(result.changed).toEqual([]);
    for (const output of repository.outputs) {
      expect(await sameAsCommitted(repository.root, output), output).toBe(true);
    }
    const record = parseAppFaces(await readFile(join(repository.root, APP_FACES_PATH), 'utf8'));
    expect(record.tools).toEqual({ wawoff2: await installedEncoder() });
  }, 60_000);

  it('writes nothing when a new wawoff2 version gives other bytes than recorded', async () => {
    const repository = await smallRepository('0.0.0-recorded');
    roots.push(repository.root);
    // As the recorded version might have left them: one copy with other bytes,
    // in its file and its record entry, and one face new to the record.
    const [changedCopy, newCopy] = [repository.outputs.at(-1), repository.outputs.at(-2)];
    if (!changedCopy || !newCopy) throw new Error('two faces needed');
    const older = Buffer.concat([
      await readFile(join(repository.root, changedCopy)),
      Buffer.alloc(4),
    ]);
    await writeFile(join(repository.root, changedCopy), older);
    await rm(join(repository.root, newCopy));
    const record = parseAppFaces(await readFile(join(repository.root, APP_FACES_PATH), 'utf8'));
    await writeAppFaces(repository.root, {
      ...record,
      families: record.families.map((family) => ({
        ...family,
        faces: family.faces.flatMap((face) => {
          const output = `${family.output}/${face.file}`;
          if (output === newCopy) return [];
          return output === changedCopy ? [{ ...face, output: digestOf(older) }] : [face];
        }),
      })),
    });
    const recorded = await readFile(join(repository.root, APP_FACES_PATH), 'utf8');

    await expect(buildAppFaces(repository.root, 'write', repository.inputs)).rejects.toThrow(
      /other bytes than recorded[\s\S]*--record/u,
    );
    expect((await readFile(join(repository.root, changedCopy))).equals(older)).toBe(true);
    await expect(readFile(join(repository.root, newCopy))).rejects.toThrow(/ENOENT/u);
    expect(await readFile(join(repository.root, APP_FACES_PATH), 'utf8')).toBe(recorded);

    // --record accepts the new bytes.
    const accepted = await buildAppFaces(repository.root, 'record', repository.inputs);
    expect([...accepted.changed].sort()).toEqual([changedCopy, newCopy].sort());
    for (const output of repository.outputs) {
      expect(await sameAsCommitted(repository.root, output), output).toBe(true);
    }
    const after = parseAppFaces(await readFile(join(repository.root, APP_FACES_PATH), 'utf8'));
    expect(after.tools).toEqual({ wawoff2: await installedEncoder() });
  }, 60_000);
});
