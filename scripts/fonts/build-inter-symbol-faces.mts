#!/usr/bin/env node
/**
 * Cut Inter's symbol faces from the full Inter: fonts/app/inter-symbols/.
 *
 *   npm run generate:inter-symbol-faces              cut new or changed faces, keep the rest
 *   npm run generate:inter-symbol-faces -- --record  cut every face and accept new bytes
 *   npm run generate:inter-symbol-faces -- --check   cut every face in memory and compare
 *
 * npm run generate:font-sheets runs the default mode first.
 *
 * Owner decisions 2026-11-17 and 2026-11-18: Inter draws Latin and its
 * symbols in Inter's base forms. The source is fonts/inter-full.ttf, the full
 * Inter 4.001 that fonts/font-sources.json records (interFull), the build
 * Google's seven subsets were cut from; fonts/inter-symbol-faces.json records
 * its digest and version. Before it cuts anything the run checks that build:
 * every code point a Google subset maps must have the full file's outline and
 * advance at the default instance and at every corner of opsz 14 and 32 with
 * wght 100, 400, 700 and 900, and the same name ID 5, or nothing is written,
 * so a Google refresh of the subsets alone cannot mix two builds of Inter in
 * one stack. A full Inter whose bytes or version differ from the record is
 * refused the same way, so replacing the file cannot cut every face again,
 * and move every face URL, unnoticed; --record accepts it after review.
 *
 * What it cuts (scripts/fonts/inter-symbol-faces.mts): the code points the
 * full Inter maps and no Google subset maps, but private use, combining
 * marks, emoji presentation, the enclosed alphanumerics and U+21A9, U+21AA,
 * U+23CF and U+2764, in one face per group of blocks.
 *
 * Each face is subset with the harfbuzz subsetter (subset-font on harfbuzzjs)
 * from the full Inter: its code points only, the whole opsz and wght axes, the
 * layout features and name records Google's subsets keep (so no case, ss or
 * cv forms: Inter's base forms), no glyph names. It is encoded with the
 * wawoff2 encoder and decoded again, as the served file is, which lays glyf
 * and loca out again; the line box of src/i18n/font-metrics.ts
 * (INTER_FACE_METRICS) is baked into that layout as into Google's Inter faces
 * (scripts/fonts/app-face-metrics.mts), and the result encoded. Before
 * anything is written, for every face:
 * - every table of the decoded WOFF2 equals the baked font's, and encoding
 *   the decoded copy again gives the same bytes;
 * - it differs from the unbaked layout only in the patched line box fields;
 * - every code point keeps the full Inter's outline and advance at the
 *   instances above;
 * - interSymbolFaceProblems finds nothing: the cmap is the face's code
 *   points, the glyf table holds bytes (OTS refuses a face whose glyf table
 *   has none, which a face of spaces alone would be), the box is in hhea and
 *   the OS/2 typo metrics with USE_TYPO_METRICS and the full Inter's win
 *   metrics, the axes, features and name records are the recorded ones, the
 *   checksums are valid and the face is named Inter.
 * A run that finds a problem in any face writes nothing.
 *
 * The default mode keeps a face whose record entry, source, tool versions and
 * committed file still match. A face it cuts again with its recorded source
 * and code points must give its recorded bytes, under the recorded tools or
 * new ones (new ones that do are recorded); otherwise the run writes nothing
 * and stops, so a tool update cannot change the faces, and with them their
 * URLs, unnoticed. --record accepts the new bytes after review.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type * as hb from 'harfbuzzjs';
import subsetFont from 'subset-font';

import { bakeLineMetrics, sfntTables, unpatchedDifferences } from './app-face-metrics.mts';
import {
  INTER_FULL_PATH,
  INTER_INSTANCES,
  decodeFontBytes,
  digestOf,
  drawnGlyph,
  encodeWoff2,
  fontCodePoints,
  formatUnicodeRange,
  interBuild,
  interBuildProblems,
  interInstanceFonts,
  interInstanceLabel,
  openFontBytes,
  parseUnicodeRange,
  readFontSources,
  type FontSources,
} from './font-files.mts';
import {
  INTER_SYMBOL_FACES_DIRECTORY,
  INTER_SYMBOL_FACES_PATH,
  INTER_SYMBOL_FACE_SPECS,
  INTER_SYMBOL_FEATURES,
  INTER_SYMBOL_NAME_IDS,
  INTER_SYMBOL_TOOLS,
  interSubsetCodePoints,
  interSymbolFaceProblems,
  interSymbolFrame,
  interSymbolPartition,
  interSymbolSelection,
  readInterSymbolFaces,
  recordedExclusions,
  verifyInterSymbolFaces,
  writeInterSymbolFaces,
  type InterSymbolFace,
  type InterSymbolFaces,
  type InterSymbolFrame,
} from './inter-symbol-faces.mts';

const NOTE =
  "Inter's symbol faces in fonts/app/inter-symbols/: harfbuzz subsets of fonts/inter-full.ttf, the full Inter (SIL OFL 1.1, no Reserved Font Name) of the build Google's Inter subsets were cut from, holding the code points it maps and no Google subset maps, but the excluded ones, one face per group of blocks. Each keeps the opsz and wght axes, the layout features and name records of Google's subsets (Inter's base forms) and the outlines of the full Inter, with the line box of src/i18n/font-metrics.ts baked in as in Google's Inter faces. sha256 and bytes are the digests of the WOFF2 files. Written by scripts/fonts/build-inter-symbol-faces.mts; checked by scripts/check-app-font.mts. Do not edit by hand.";

type Mode = 'write' | 'record' | 'check';

/** The full Inter, decoded, with its fonts at the compared instances. */
export interface InterSymbolSource {
  readonly bytes: Uint8Array;
  readonly sfnt: Uint8Array;
  readonly face: hb.Face;
  readonly codePoints: ReadonlySet<number>;
  /** Its version and build, from its name ID 5. */
  readonly version: string;
  readonly fonts: readonly hb.Font[];
}

export async function readInterSymbolSource(repoRoot: string): Promise<InterSymbolSource> {
  const bytes = Uint8Array.from(await readFile(path.join(repoRoot, INTER_FULL_PATH)));
  const sfnt = Uint8Array.from(await decodeFontBytes(bytes));
  const face = await openFontBytes(sfnt);
  return {
    bytes,
    sfnt,
    face,
    codePoints: fontCodePoints(face),
    version: interBuild(face),
    fonts: interInstanceFonts(face),
  };
}

/**
 * Throws unless the full Inter is the build Google's subsets were cut from
 * (interBuildProblems in font-files.mts).
 */
export async function assertSameInterBuild(
  repoRoot: string,
  source: InterSymbolSource,
  sources: FontSources,
): Promise<void> {
  const subsets: { file: string; face: hb.Face }[] = [];
  for (const face of sources.inter.faces) {
    const file = `${sources.inter.directory}/${face.file}`;
    subsets.push({ file, face: await openFontBytes(await readFile(path.join(repoRoot, file))) });
  }
  const problems = interBuildProblems(source.face, subsets);
  if (problems.length) {
    throw new Error(
      `${INTER_FULL_PATH} is not the build of Google's Inter subsets, so its symbols would not match them: ${problems.join('; ')}. Nothing was written. Record the full Inter of the subsets' build (node scripts/fonts/record-font-sources.mts --inter-full <file>).`,
    );
  }
}

/** The tables of two sfnt fonts that differ, or are only in one. */
function tablesEqual(left: Uint8Array, right: Uint8Array): string[] {
  const a = sfntTables(left);
  const b = sfntTables(right);
  const differing: string[] = [];
  for (const tag of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(tag);
    const y = b.get(tag);
    if (
      !x ||
      !y ||
      !Buffer.from(left.subarray(x.offset, x.offset + x.length)).equals(
        Buffer.from(right.subarray(y.offset, y.offset + y.length)),
      )
    ) {
      differing.push(tag);
    }
  }
  return differing;
}

/**
 * One symbol face: the WOFF2 bytes of the full Inter's subset to these code
 * points with the line box baked in. Throws unless it passes every check of
 * this file's header.
 */
export async function buildInterSymbolFace(
  source: InterSymbolSource,
  codePoints: readonly number[],
  frame: Pick<InterSymbolFrame, 'box' | 'source' | 'features' | 'nameIds'>,
): Promise<Uint8Array> {
  const text = codePoints.map((codePoint) => String.fromCodePoint(codePoint)).join('');
  const subset = Uint8Array.from(
    await subsetFont(Buffer.from(source.sfnt), text, {
      targetFormat: 'truetype',
      keepFeatures: [...INTER_SYMBOL_FEATURES],
      preserveNameIds: [...INTER_SYMBOL_NAME_IDS],
    }),
  );
  // The served WOFF2 lays glyf and loca out again; bake that layout, so the
  // file decodes to exactly the font checked here.
  const layout = Uint8Array.from(await decodeFontBytes(await encodeWoff2(subset)));
  const baked = bakeLineMetrics(layout, frame.box);
  const woff2 = await encodeWoff2(baked);
  const sfnt = Uint8Array.from(await decodeFontBytes(woff2));
  const lost = tablesEqual(baked, sfnt);
  if (lost.length) throw new Error(`the WOFF2 round trip changed ${lost.join(', ')}`);
  if (!Buffer.from(await encodeWoff2(sfnt)).equals(Buffer.from(woff2))) {
    throw new Error('encoding the decoded face again gives other WOFF2 bytes');
  }
  const changed = unpatchedDifferences(layout, sfnt);
  if (changed.length) {
    throw new Error(`the bake changed more than the line box: ${changed.join(', ')}`);
  }

  const fonts = interInstanceFonts(await openFontBytes(sfnt));
  for (const [index, variations] of INTER_INSTANCES.entries()) {
    const [cut, full] = [fonts[index], source.fonts[index]];
    for (const codePoint of codePoints) {
      const glyph = cut ? drawnGlyph(cut, codePoint) : null;
      if (glyph === null || !full || glyph !== drawnGlyph(full, codePoint)) {
        throw new Error(
          `U+${codePoint.toString(16).toUpperCase()} differs from the full Inter at ${interInstanceLabel(variations)}`,
        );
      }
    }
  }
  const problems = await interSymbolFaceProblems(sfnt, source.sfnt, new Set(codePoints), frame);
  if (problems.length) throw new Error(problems.join('; '));
  return woff2;
}

async function toolVersions(repoRoot: string): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const name of INTER_SYMBOL_TOOLS) {
    const manifest: unknown = JSON.parse(
      await readFile(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8'),
    );
    const version =
      typeof manifest === 'object' && manifest !== null && 'version' in manifest
        ? manifest.version
        : undefined;
    if (typeof version !== 'string') throw new Error(`Cannot read the ${name} version`);
    versions[name] = version;
  }
  return versions;
}

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

interface BuildResult {
  readonly record: InterSymbolFaces;
  /** How many faces this run cut. */
  readonly built: number;
  /** The files this run wrote or removed. */
  readonly changed: readonly string[];
  /** --check: what differs from the committed files and record. */
  readonly problems: readonly string[];
}

/**
 * Build Inter's symbol faces. 'write' cuts what is new or changed and writes
 * the faces and the record; 'record' cuts and writes every face; 'check'
 * cuts every face in memory and reports what differs from the committed
 * files.
 */
export async function buildInterSymbolFaces(repoRoot: string, mode: Mode): Promise<BuildResult> {
  const previous = await readInterSymbolFaces(repoRoot).catch(() => null);
  const tools = await toolVersions(repoRoot);
  const sameTools =
    previous !== null && INTER_SYMBOL_TOOLS.every((tool) => previous.tools[tool] === tools[tool]);
  const sources = await readFontSources(repoRoot);
  const source = await readInterSymbolSource(repoRoot);
  await assertSameInterBuild(repoRoot, source, sources);
  const frame = interSymbolFrame(source.bytes, source.version, sources.interFull.license);
  const frameKeys = Object.keys(frame) as (keyof InterSymbolFrame)[];
  const differing =
    previous === null
      ? []
      : frameKeys.filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(frame[key]));
  const sameFrame = previous !== null && differing.length === 0;
  if (mode === 'write' && previous !== null && !sameFrame) {
    throw new Error(
      `${INTER_FULL_PATH} or the cut differs from its record in ${INTER_SYMBOL_FACES_PATH} (${differing.join(', ')}). ` +
        'Nothing was written. Rerun with --record after review to cut every face again.',
    );
  }
  const selection = interSymbolSelection(
    source.codePoints,
    await interSubsetCodePoints(repoRoot, sources),
  );

  const faces: InterSymbolFace[] = [];
  const problems: string[] = [];
  const mismatches: string[] = [];
  const writes: { readonly file: string; readonly bytes: Uint8Array }[] = [];
  let built = 0;
  for (const { name, file, codePoints } of interSymbolPartition(selection.codePoints)) {
    const where = `${INTER_SYMBOL_FACES_DIRECTORY}/${file}`;
    const unicodeRange = formatUnicodeRange(codePoints);
    const holds = INTER_SYMBOL_FACE_SPECS.find((spec) => spec.name === name)?.holds ?? '';
    const found = previous?.faces.find((face) => face.file === file);
    const recorded =
      found !== undefined && sameFrame && found.unicodeRange === unicodeRange ? found : null;
    const committed = await readOptional(path.join(repoRoot, where));
    const committedDigest = committed ? digestOf(committed) : null;
    const matches = (digest: { sha256: string; bytes: number } | null) =>
      digest !== null &&
      recorded !== null &&
      digest.sha256 === recorded.sha256 &&
      digest.bytes === recorded.bytes;
    if (mode === 'write' && recorded && sameTools && matches(committedDigest)) {
      faces.push({ ...recorded, name, holds });
      continue;
    }
    let woff2: Uint8Array;
    try {
      woff2 = await buildInterSymbolFace(source, codePoints, frame);
    } catch (error) {
      throw new Error(
        `${where}: ${error instanceof Error ? error.message : String(error)}. Nothing was written.`,
        { cause: error },
      );
    }
    built += 1;
    const digest = digestOf(woff2);
    const face: InterSymbolFace = { name, holds, file, unicodeRange, ...digest };
    if (mode === 'check') {
      if (
        !committedDigest ||
        committedDigest.sha256 !== digest.sha256 ||
        committedDigest.bytes !== digest.bytes
      ) {
        problems.push(`${where} is not the cut of ${INTER_FULL_PATH} the generator makes`);
      }
      if (!found || found.unicodeRange !== unicodeRange) {
        problems.push(`${INTER_SYMBOL_FACES_PATH} records other code points for ${where}`);
      } else if (found.sha256 !== digest.sha256 || found.bytes !== digest.bytes) {
        problems.push(`${INTER_SYMBOL_FACES_PATH} records another digest for ${where}`);
      }
    } else if (mode === 'write' && recorded && !matches(digest)) {
      mismatches.push(where);
      faces.push(recorded);
      continue;
    } else if (
      !committedDigest ||
      committedDigest.sha256 !== digest.sha256 ||
      committedDigest.bytes !== digest.bytes
    ) {
      writes.push({ file, bytes: woff2 });
    }
    faces.push(face);
  }
  if (mismatches.length) {
    const cause = sameTools
      ? 'with the tools that recorded them, so the cut itself changed'
      : `with ${INTER_SYMBOL_TOOLS.map((tool) => `${tool} ${tools[tool]}`).join(', ')}, other versions than recorded`;
    throw new Error(
      `Cutting again gave other bytes than recorded for ${mismatches.join(', ')} (${cause}). ` +
        'Nothing was written. If the change is intended, rerun with --record to accept the new bytes.',
    );
  }

  // The key order the record is written in.
  const record: InterSymbolFaces = {
    note: NOTE,
    tools,
    source: frame.source,
    selection: frame.selection,
    excluded: recordedExclusions(selection),
    features: frame.features,
    nameIds: frame.nameIds,
    box: frame.box,
    directory: frame.directory,
    faces,
  };
  const changed: string[] = [];
  if (mode === 'check') {
    if (JSON.stringify(record) !== JSON.stringify(previous)) {
      problems.push(`${INTER_SYMBOL_FACES_PATH} is not the generator's record`);
    }
    problems.push(...(await verifyInterSymbolFaces(repoRoot)));
    return { record, built, changed, problems };
  }
  await mkdir(path.join(repoRoot, INTER_SYMBOL_FACES_DIRECTORY), { recursive: true });
  for (const { file, bytes } of writes) {
    await writeFile(path.join(repoRoot, INTER_SYMBOL_FACES_DIRECTORY, file), bytes);
    changed.push(`${INTER_SYMBOL_FACES_DIRECTORY}/${file}`);
  }
  const expected = new Set(faces.map(({ file }) => file));
  for (const file of await readdir(path.join(repoRoot, INTER_SYMBOL_FACES_DIRECTORY))) {
    if (!expected.has(file)) {
      await rm(path.join(repoRoot, INTER_SYMBOL_FACES_DIRECTORY, file));
      changed.push(`${INTER_SYMBOL_FACES_DIRECTORY}/${file} (removed)`);
    }
  }
  if (JSON.stringify(record) !== JSON.stringify(previous)) {
    await writeInterSymbolFaces(repoRoot, record);
    changed.push(INTER_SYMBOL_FACES_PATH);
  }
  return { record, built, changed, problems };
}

function summary(record: InterSymbolFaces): string {
  const bytes = record.faces.reduce((sum, face) => sum + face.bytes, 0);
  const codePoints = record.faces.reduce(
    (sum, face) => sum + parseUnicodeRange(face.unicodeRange).size,
    0,
  );
  return `${record.faces.length} faces, ${codePoints} code points, ${bytes} B`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      record: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
    },
  });
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const mode: Mode = values.check ? 'check' : values.record ? 'record' : 'write';
  const started = Date.now();
  const result = await buildInterSymbolFaces(repoRoot, mode);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (mode === 'check') {
    if (result.problems.length) {
      console.error(
        `Inter's symbol faces differ from the generator (run npm run generate:inter-symbol-faces):\n${result.problems.map((line) => `  - ${line}`).join('\n')}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `Cut ${result.built} Inter symbol faces again in ${seconds} s: every face in ${INTER_SYMBOL_FACES_DIRECTORY} and ${INTER_SYMBOL_FACES_PATH} match (${summary(result.record)}).`,
    );
    return;
  }
  for (const line of result.changed) console.log(`wrote ${line}`);
  console.log(
    `Cut ${result.built} Inter symbol faces in ${seconds} s, ${result.changed.length} files changed (${summary(result.record)}).`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
