#!/usr/bin/env node
/**
 * Cut the app's Hangul faces from Pretendard: fonts/app/hangul/.
 *
 *   npm run generate:hangul-faces              subset new or changed faces, keep the rest
 *   npm run generate:hangul-faces -- --record  subset every face and accept new bytes
 *   npm run generate:hangul-faces -- --check   subset every face in memory and compare
 *
 * npm run generate:font-sheets runs the default mode first.
 *
 * The owner decided on 2026-11-02 that Pretendard draws the app's Hangul
 * again; Inter keeps Latin and digits, and Noto keeps Han, kana and the
 * Hangul Pretendard lacks. The source is fonts/PretendardVariable.woff2
 * (Pretendard Variable 1.309, its name ID 5), which the repository has kept
 * since the public pages first used it, and which now stays as the faces'
 * source. fonts/hangul-faces.json records its digest, version and axis: the
 * default mode refuses a file (or a line box or name in the code) that
 * differs from the record and writes nothing, so replacing the file cannot
 * cut every face again, and move every face URL, unnoticed; --record accepts
 * it after review.
 *
 * The faces: one per Noto Sans KR v40 numbered shard (fonts/font-sources.json)
 * that declares Hangul the source draws, with that shard's number and only
 * that Hangul, so the most frequent syllables share a file as Google groups
 * them; then a face numbered 0 for the Hangul no shard declares (the
 * halfwidth jamo). Hangul is found by block or by Unicode Script
 * (isHangul in font-files.mts), so ㈜ is in and the source's kana, Latin and
 * punctuation never are.
 *
 * Each face is subset with the harfbuzz subsetter (subset-font on
 * harfbuzzjs) from the decoded source: its code points only, the whole wght
 * axis (the outlines stay exactly Pretendard's at every weight), every layout
 * feature that still applies (none reach Hangul, so none is left) and the
 * name records 0-6, 13, 14 and 256-273. The source's copyright, license and
 * license URL records (IDs 0, 13 and 14, in every language) replace the
 * subsetter's, which keeps English only. The Reserved Font Name
 * (fonts/PRETENDARD_LICENSE.txt) may not be the primary name of a Modified
 * Version (SIL OFL 1.1, condition 3), so "Pretendard Variable" becomes
 * "MUSIXQUARE Hangul" and "PretendardVariable" "MUSIXQUAREHangul" in every
 * kept record (scripts/fonts/sfnt-names.mts). The face is encoded with the
 * wawoff2 encoder and decoded again. Before anything is written, for every
 * face:
 * - every table of the decoded copy equals the encoded font's, but glyf and
 *   loca, which the WOFF2 transform lays out again (each glyph padded to four
 *   bytes), and head.checkSumAdjustment; encoding the decoded copy again gives
 *   the same WOFF2 bytes;
 * - every code point keeps the source's outline and advance at the default
 *   instance and at wght 400, 500, 600 and 700;
 * - hangulFaceProblems (font-files.mts) finds nothing: the cmap is the face's
 *   code points, the line box is the source's (HANGUL_LINE_BOX of
 *   src/i18n/font-metrics.ts, USE_TYPO_METRICS set), no MVAR, the wght axis
 *   is the source's, no layout feature, valid checksums, no name naming
 *   Pretendard and the copyright and license records as in the source.
 * A run that finds a problem in any face writes nothing.
 *
 * fonts/hangul-faces.json records each face's code points and digest, the
 * source and the tool versions. The default mode keeps a face whose record
 * entry, source digest, tool versions and committed file still match. A face
 * it subsets again with its recorded source and code points must give its
 * recorded bytes, under the recorded tools or new ones (new ones that do are
 * recorded); otherwise the run writes nothing and stops, so a tool update
 * cannot change the faces, and with them their URLs, unnoticed. --record
 * accepts the new bytes after review.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as hb from 'harfbuzzjs';
import subsetFont from 'subset-font';

import { HANGUL_LINE_BOX } from '../../src/i18n/font-metrics.ts';
import { sfntTables } from './app-face-metrics.mts';
import {
  HANGUL_FACES_DIRECTORY,
  HANGUL_FACES_PATH,
  HANGUL_FAMILY,
  HANGUL_POSTSCRIPT_NAME,
  HANGUL_SOURCE_LICENSE,
  HANGUL_SOURCE_NAME_IDS,
  HANGUL_SOURCE_PATH,
  HANGUL_TOOLS,
  decodeFontBytes,
  digestOf,
  encodeWoff2,
  fontCodePoints,
  formatUnicodeRange,
  hangulFaceFile,
  hangulFaceProblems,
  hangulPartition,
  openFontBytes,
  readFontSources,
  readHangulFaces,
  verifyHangulFaces,
  writeHangulFaces,
  type HangulFace,
  type HangulFaces,
} from './font-files.mts';
import { nameText, readNameTable, renameRecords, withNameRecords } from './sfnt-names.mts';

const NOTE =
  'The Hangul faces in fonts/app/hangul/: harfbuzz subsets of fonts/PretendardVariable.woff2 (Pretendard Variable by Kil Hyung-jin, SIL OFL 1.1 with the Reserved Font Name Pretendard), one per Noto Sans KR v40 numbered shard that declares Hangul the source draws, with that Hangul only, and face 0 for the Hangul no shard declares. Each keeps the whole wght axis, the outlines and the line box of the source, and is renamed MUSIXQUARE Hangul as OFL condition 3 asks of a Modified Version. sha256 and bytes are the digests of the WOFF2 files. Written by scripts/fonts/build-hangul-faces.mts; checked by scripts/check-app-font.mts. Do not edit by hand.';
const PARTITION =
  'Noto Sans KR v40 numbered shards of fonts/font-sources.json, each face holding the Hangul (by block or by Unicode Script) its shard declares and the source draws; face 0 holds the Hangul no shard declares.';
const RENAMES = [
  ['Pretendard Variable', HANGUL_FAMILY],
  ['PretendardVariable', HANGUL_POSTSCRIPT_NAME],
] as const;
/** The name records the subsetter keeps: the IDs a font needs and the axis and instance names. */
const PRESERVED_NAME_IDS = [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  13,
  14,
  ...Array.from({ length: 18 }, (_, index) => 256 + index),
];
/** The instances whose outlines and advances must equal the source's: the default and the app's weights. */
const WEIGHTS = [undefined, 400, 500, 600, 700] as const;

type Mode = 'write' | 'record' | 'check';

/** The outline and advance of a code point in one instance of a face. */
class Instance {
  readonly #font: hb.Font;

  constructor(face: hb.Face, weight: number | undefined) {
    this.#font = new hb.Font(face);
    if (weight !== undefined) this.#font.setVariations([new hb.Variation('wght', weight)]);
  }

  glyph(codePoint: number): string | null {
    const glyph = this.#font.nominalGlyph(codePoint);
    if (glyph === undefined) return null;
    return `${this.#font.glyphHAdvance(glyph)} ${this.#font.glyphToPath(glyph)}`;
  }
}

/** The decoded source, its harfbuzz instances and its facts the record keeps. */
export interface HangulSource {
  readonly bytes: Uint8Array;
  readonly sfnt: Uint8Array;
  readonly codePoints: ReadonlySet<number>;
  readonly version: string;
  readonly wght: readonly [number, number];
  readonly instances: readonly Instance[];
}

export async function readHangulSource(repoRoot: string): Promise<HangulSource> {
  const bytes = await readFile(path.join(repoRoot, HANGUL_SOURCE_PATH));
  const sfnt = Uint8Array.from(await decodeFontBytes(bytes));
  const face = await openFontBytes(sfnt);
  const version = /^Version (\S+?);/u.exec(face.getName(5, 'en') ?? '')?.[1];
  if (!version) throw new Error(`${HANGUL_SOURCE_PATH} has no "Version x.y;" name ID 5`);
  const wght = face.getAxisInfos().wght;
  if (!wght) throw new Error(`${HANGUL_SOURCE_PATH} has no wght axis`);
  return {
    bytes,
    sfnt,
    codePoints: fontCodePoints(face),
    version: `${version} (name ID 5)`,
    wght: [wght.min, wght.max],
    instances: WEIGHTS.map((weight) => new Instance(face, weight)),
  };
}

/**
 * The tables a WOFF2 round trip changed, beyond glyf and loca (which the
 * transform lays out again; the outline check covers them) and
 * head.checkSumAdjustment.
 */
function roundTripChanges(before: Uint8Array, after: Uint8Array): string[] {
  const a = sfntTables(before);
  const b = sfntTables(after);
  const differing: string[] = [];
  for (const tag of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(tag);
    const y = b.get(tag);
    if (!x || !y) {
      differing.push(tag);
      continue;
    }
    if (tag === 'glyf' || tag === 'loca') continue;
    const left = Buffer.from(before.subarray(x.offset, x.offset + x.length));
    const right = Buffer.from(after.subarray(y.offset, y.offset + y.length));
    if (tag === 'head' && left.length >= 12 && right.length === left.length) {
      left.fill(0, 8, 12);
      right.fill(0, 8, 12);
    }
    if (!left.equals(right)) differing.push(tag);
  }
  return differing;
}

/** The record fields every face is checked against, for this source. */
function recordFrame(source: HangulSource): Pick<HangulFaces, 'box' | 'names' | 'source'> {
  return {
    box: { ...HANGUL_LINE_BOX },
    names: { family: HANGUL_FAMILY, postscript: HANGUL_POSTSCRIPT_NAME },
    source: {
      file: HANGUL_SOURCE_PATH,
      version: source.version,
      ...digestOf(source.bytes),
      license: HANGUL_SOURCE_LICENSE,
      wght: source.wght,
    },
  };
}

/**
 * One Hangul face: the WOFF2 bytes of the source's subset to these code
 * points, renamed. Throws unless it passes every check of this file's header.
 */
export async function buildHangulFace(
  source: HangulSource,
  codePoints: readonly number[],
): Promise<Uint8Array> {
  const text = codePoints.map((codePoint) => String.fromCodePoint(codePoint)).join('');
  const subset = Uint8Array.from(
    await subsetFont(Buffer.from(source.sfnt), text, {
      targetFormat: 'truetype',
      preserveNameIds: PRESERVED_NAME_IDS,
    }),
  );
  const sourceNames = readNameTable(source.sfnt).records.filter(({ nameId }) =>
    HANGUL_SOURCE_NAME_IDS.includes(nameId),
  );
  const kept = readNameTable(subset).records.filter(
    ({ nameId }) => !HANGUL_SOURCE_NAME_IDS.includes(nameId),
  );
  const named = withNameRecords(subset, [...renameRecords(kept, RENAMES), ...sourceNames]);
  const woff2 = await encodeWoff2(named);
  const sfnt = Uint8Array.from(await decodeFontBytes(woff2));
  const lost = roundTripChanges(named, sfnt);
  if (lost.length) throw new Error(`the WOFF2 round trip changed ${lost.join(', ')}`);
  if (!Buffer.from(await encodeWoff2(sfnt)).equals(Buffer.from(woff2))) {
    throw new Error('encoding the decoded face again gives other WOFF2 bytes');
  }

  const face = await openFontBytes(sfnt);
  for (const [index, weight] of WEIGHTS.entries()) {
    const before = source.instances[index];
    const after = new Instance(face, weight);
    for (const codePoint of codePoints) {
      if (before?.glyph(codePoint) !== after.glyph(codePoint)) {
        throw new Error(
          `U+${codePoint.toString(16).toUpperCase()} differs from the source at ${weight === undefined ? 'the default instance' : `wght ${weight}`}`,
        );
      }
    }
  }
  const problems = await hangulFaceProblems(
    sfnt,
    source.sfnt,
    new Set(codePoints),
    recordFrame(source),
  );
  if (problems.length) throw new Error(problems.join('; '));
  const family = readNameTable(sfnt).records.find(({ nameId }) => nameId === 6);
  if (family && nameText(family) !== `${HANGUL_POSTSCRIPT_NAME}-Regular`) {
    throw new Error(`its PostScript name is ${nameText(family) ?? '?'}`);
  }
  return woff2;
}

async function toolVersions(repoRoot: string): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const name of HANGUL_TOOLS) {
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
  readonly record: HangulFaces;
  /** How many faces this run subset. */
  readonly built: number;
  /** The files this run wrote or removed. */
  readonly changed: readonly string[];
  /** --check: what differs from the committed files and record. */
  readonly problems: readonly string[];
}

/**
 * Build the Hangul faces. 'write' subsets what is new or changed and writes
 * the faces and the record; 'record' subsets and writes every face; 'check'
 * subsets every face in memory and reports what differs from the committed
 * files.
 */
export async function buildHangulFaces(repoRoot: string, mode: Mode): Promise<BuildResult> {
  const previous = await readHangulFaces(repoRoot).catch(() => null);
  const tools = await toolVersions(repoRoot);
  const sameTools =
    previous !== null && HANGUL_TOOLS.every((tool) => previous.tools[tool] === tools[tool]);
  const source = await readHangulSource(repoRoot);
  const frame = recordFrame(source);
  const recordedFrame =
    previous === null
      ? null
      : { box: previous.box, names: previous.names, source: previous.source };
  const sameSource =
    recordedFrame !== null && JSON.stringify(recordedFrame) === JSON.stringify(frame);
  if (mode === 'write' && recordedFrame !== null && !sameSource) {
    const differing = (['box', 'names', 'source'] as const).flatMap((key) =>
      key === 'source'
        ? (Object.keys(frame.source) as (keyof typeof frame.source)[])
            .filter(
              (field) =>
                JSON.stringify(recordedFrame.source[field]) !== JSON.stringify(frame.source[field]),
            )
            .map((field) => `source.${field}`)
        : JSON.stringify(recordedFrame[key]) === JSON.stringify(frame[key])
          ? []
          : [key],
    );
    throw new Error(
      `${HANGUL_SOURCE_PATH} differs from its record in ${HANGUL_FACES_PATH} (${differing.join(', ') || 'source'}). ` +
        'Nothing was written. Rerun with --record after review to cut every face again from it.',
    );
  }
  const partition = hangulPartition(source.codePoints, await readFontSources(repoRoot));

  const faces: HangulFace[] = [];
  const problems: string[] = [];
  const mismatches: string[] = [];
  const writes: { readonly file: string; readonly bytes: Uint8Array }[] = [];
  let built = 0;
  for (const { shard, codePoints } of partition) {
    const file = hangulFaceFile(shard);
    const where = `${HANGUL_FACES_DIRECTORY}/${file}`;
    const unicodeRange = formatUnicodeRange(codePoints);
    const found = previous?.faces.find((face) => face.shard === shard);
    const recorded =
      found !== undefined &&
      sameSource &&
      found.file === file &&
      found.unicodeRange === unicodeRange
        ? found
        : null;
    const committed = await readOptional(path.join(repoRoot, where));
    const committedDigest = committed ? digestOf(committed) : null;
    const matches = (digest: { sha256: string; bytes: number } | null) =>
      digest !== null &&
      recorded !== null &&
      digest.sha256 === recorded.sha256 &&
      digest.bytes === recorded.bytes;
    if (mode === 'write' && recorded && sameTools && matches(committedDigest)) {
      faces.push(recorded);
      continue;
    }
    let woff2: Uint8Array;
    try {
      woff2 = await buildHangulFace(source, codePoints);
    } catch (error) {
      throw new Error(
        `${where}: ${error instanceof Error ? error.message : String(error)}. Nothing was written.`,
        { cause: error },
      );
    }
    built += 1;
    const digest = digestOf(woff2);
    const face: HangulFace = { shard, file, unicodeRange, ...digest };
    if (mode === 'check') {
      if (
        !committedDigest ||
        committedDigest.sha256 !== digest.sha256 ||
        committedDigest.bytes !== digest.bytes
      ) {
        problems.push(`${where} is not the subset of ${HANGUL_SOURCE_PATH} the generator makes`);
      }
      if (!found || found.unicodeRange !== unicodeRange) {
        problems.push(`${HANGUL_FACES_PATH} records other code points for ${where}`);
      } else if (found.sha256 !== digest.sha256 || found.bytes !== digest.bytes) {
        problems.push(`${HANGUL_FACES_PATH} records another digest for ${where}`);
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
      ? 'with the tools that recorded them, so the subsetting itself changed'
      : `with ${HANGUL_TOOLS.map((tool) => `${tool} ${tools[tool]}`).join(', ')}, other versions than recorded`;
    throw new Error(
      `Subsetting again gave other bytes than recorded for ${mismatches.join(', ')} (${cause}). ` +
        'Nothing was written. If the change is intended, rerun with --record to accept the new bytes.',
    );
  }

  const record: HangulFaces = {
    note: NOTE,
    tools,
    ...frame,
    partition: PARTITION,
    directory: HANGUL_FACES_DIRECTORY,
    faces,
  };
  // The key order the record is written in.
  const ordered: HangulFaces = {
    note: record.note,
    tools: record.tools,
    source: record.source,
    partition: record.partition,
    names: record.names,
    box: record.box,
    directory: record.directory,
    faces: record.faces,
  };
  const changed: string[] = [];
  if (mode === 'check') {
    if (JSON.stringify(ordered) !== JSON.stringify(previous)) {
      problems.push(`${HANGUL_FACES_PATH} is not the generator's record`);
    }
    problems.push(...(await verifyHangulFaces(repoRoot)));
    return { record: ordered, built, changed, problems };
  }
  await mkdir(path.join(repoRoot, HANGUL_FACES_DIRECTORY), { recursive: true });
  for (const { file, bytes } of writes) {
    await writeFile(path.join(repoRoot, HANGUL_FACES_DIRECTORY, file), bytes);
    changed.push(`${HANGUL_FACES_DIRECTORY}/${file}`);
  }
  const expected = new Set(faces.map(({ file }) => file));
  for (const file of await readdir(path.join(repoRoot, HANGUL_FACES_DIRECTORY))) {
    if (!expected.has(file)) {
      await rm(path.join(repoRoot, HANGUL_FACES_DIRECTORY, file));
      changed.push(`${HANGUL_FACES_DIRECTORY}/${file} (removed)`);
    }
  }
  if (JSON.stringify(ordered) !== JSON.stringify(previous)) {
    await writeHangulFaces(repoRoot, ordered);
    changed.push(HANGUL_FACES_PATH);
  }
  return { record: ordered, built, changed, problems };
}

function summary(record: HangulFaces): string {
  const bytes = record.faces.reduce((sum, face) => sum + face.bytes, 0);
  return `${record.faces.length} faces, ${bytes} B`;
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
  const result = await buildHangulFaces(repoRoot, mode);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (mode === 'check') {
    if (result.problems.length) {
      console.error(
        `The Hangul faces differ from the generator (run npm run generate:hangul-faces):\n${result.problems.map((line) => `  - ${line}`).join('\n')}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `Subset ${result.built} Hangul faces again in ${seconds} s: every face in ${HANGUL_FACES_DIRECTORY} and ${HANGUL_FACES_PATH} match (${summary(result.record)}).`,
    );
    return;
  }
  for (const line of result.changed) console.log(`wrote ${line}`);
  console.log(
    `Subset ${result.built} Hangul faces in ${seconds} s, ${result.changed.length} files changed (${summary(result.record)}).`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
