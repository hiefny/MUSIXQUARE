#!/usr/bin/env node
/**
 * Bake the app's line box into its Inter and CJK faces: fonts/app/.
 *
 *   npm run generate:app-faces              bake new or changed faces, keep the rest
 *   npm run generate:app-faces -- --record  bake every face and accept new bytes
 *   npm run generate:app-faces -- --check   bake every face in memory and compare (slow)
 *
 * npm run generate:font-sheets runs the default mode first, so the documented
 * refresh (record-font-sources, generate:noto-kr, generate:font-sheets) bakes
 * again whatever changed.
 *
 * Safari applies size-adjust but not the ascent, descent and line-gap
 * overrides of the app sheets, so it would take the line box from each file's
 * own metrics. Each copy therefore carries the box of src/i18n/font-metrics.ts
 * in hhea and the OS/2 typo metrics, with USE_TYPO_METRICS set
 * (scripts/fonts/app-face-metrics.mts). The sheets keep the descriptors for
 * the browsers that apply them. Those are two-decimal percentages within half
 * a unit of the baked box, not equal to it, so the two give the same line
 * boxes except at sizes next to a pixel rounding boundary, where a line can
 * differ by 1 px (see src/i18n/font-metrics.ts).
 *
 * Inputs: the faces the app sheets keep, as scripts/fonts/build-font-sheets.mts
 * computes them from the input cmaps: Inter from fonts/inter/ (Google's
 * bytes), Noto Sans KR from fonts/noto/noto-sans-kr/ (the copies without
 * locl), Noto Sans JP, SC and TC from fonts/noto/noto-sans-{jp,sc,tc}/
 * (Google's shards, which the static pages keep using unchanged).
 *
 * Each face is decoded, patched, encoded with the wawoff2 encoder and decoded
 * again, one at a time (the WOFF2 encoder and decoder are not reentrant).
 * Before a copy is written:
 * - every table of the decoded copy equals the patched font;
 * - it differs from the decoded input only in head.checkSumAdjustment, the
 *   hhea line metrics, OS/2 fsSelection and the OS/2 typo metrics;
 * - its checksums are valid, its cmap is the input's, and it holds the box
 *   with USE_TYPO_METRICS and the input's win metrics, which hold the box.
 * The copy keeps the input's file name in fonts/app/<family>/, and
 * fonts/app-faces.json records the digests of the input and the copy and the
 * wawoff2 version. The default mode keeps a face whose record entry, input
 * digest, line box and wawoff2 version still match. A face it bakes again
 * with its recorded input and box must give its recorded bytes, under the
 * recorded wawoff2 version or a new one (a new version that does only
 * replaces the recorded version); otherwise the run writes nothing and stops,
 * so a wawoff2 update cannot change the copies, and with them every font URL,
 * unnoticed. --record accepts the new bytes after review.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  bakeLineMetrics,
  readLineMetrics,
  sfntChecksumsValid,
  sfntTables,
  unpatchedDifferences,
  type BakedLineBox,
} from './app-face-metrics.mts';
import { appFaceInputs } from './build-font-sheets.mts';
import {
  APP_FACES_DIRECTORY,
  APP_FACES_PATH,
  APP_FACE_FAMILIES,
  decodeFontBytes,
  digestOf,
  encodeWoff2,
  fontCodePoints,
  openFontBytes,
  parseAppFaces,
  verifyAppFaces,
  writeAppFaces,
  type AppFace,
  type AppFaceFamily,
  type AppFaces,
  type FileDigest,
} from './font-files.mts';

const NOTE =
  'The app faces in fonts/app/: each Inter and CJK face of the app sheets is a copy of its input file with the line box of src/i18n/font-metrics.ts baked into hhea and the OS/2 typo metrics (USE_TYPO_METRICS set; descender and winDescent are below the baseline, positive). input and output are the digests of the input file and of the copy. Written by scripts/fonts/build-app-faces.mts; checked by scripts/check-app-font.mts. Do not edit by hand.';
const TOOL = 'wawoff2';

type Mode = 'write' | 'record' | 'check';

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
 * One face's baked copy: the WOFF2 bytes and their decoded sfnt. Throws
 * unless the copy passes every check in this file's header.
 */
export async function bakeFace(
  input: Uint8Array,
  box: BakedLineBox,
): Promise<{ woff2: Uint8Array; sfnt: Uint8Array }> {
  const decoded = await decodeFontBytes(input);
  const patched = bakeLineMetrics(decoded, box);
  const woff2 = await encodeWoff2(patched);
  const sfnt = await decodeFontBytes(woff2);
  const lost = tablesEqual(patched, sfnt);
  if (lost.length) throw new Error(`the WOFF2 round trip changed ${lost.join(', ')}`);
  const changed = unpatchedDifferences(decoded, sfnt);
  if (changed.length)
    throw new Error(`the copy differs beyond the line box: ${changed.join(', ')}`);
  if (!sfntChecksumsValid(sfnt)) throw new Error('the copy has a wrong checksum');
  const before = readLineMetrics(decoded);
  const after = readLineMetrics(sfnt);
  const lineBox = { ascender: box.ascender, descender: box.descender, lineGap: box.lineGap };
  const wanted = {
    unitsPerEm: box.unitsPerEm,
    hhea: lineBox,
    typo: lineBox,
    useTypoMetrics: true,
    winAscent: before.winAscent,
    winDescent: before.winDescent,
  };
  if (JSON.stringify(after) !== JSON.stringify(wanted)) {
    throw new Error(`the copy holds ${JSON.stringify(after)}, not ${JSON.stringify(wanted)}`);
  }
  if (after.winAscent < box.ascender || after.winDescent < box.descender) {
    throw new Error(`the win metrics ${after.winAscent}/${after.winDescent} do not hold the box`);
  }
  const [inputCmap, copyCmap] = [
    fontCodePoints(await openFontBytes(decoded)),
    fontCodePoints(await openFontBytes(sfnt)),
  ];
  if (inputCmap.size !== copyCmap.size || [...inputCmap].some((code) => !copyCmap.has(code))) {
    throw new Error('the copy changed the cmap');
  }
  return { woff2, sfnt };
}

async function toolVersion(repoRoot: string): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(repoRoot, 'node_modules', TOOL, 'package.json'), 'utf8'),
  );
  const version =
    typeof manifest === 'object' && manifest !== null && 'version' in manifest
      ? manifest.version
      : undefined;
  if (typeof version !== 'string') throw new Error(`Cannot read the ${TOOL} version`);
  return version;
}

async function readRecord(repoRoot: string): Promise<AppFaces | null> {
  try {
    return parseAppFaces(await readFile(path.join(repoRoot, APP_FACES_PATH), 'utf8'));
  } catch {
    return null;
  }
}

const sameDigest = (left: FileDigest, right: FileDigest | undefined): boolean =>
  right !== undefined && left.sha256 === right.sha256 && left.bytes === right.bytes;

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

interface BuildResult {
  readonly record: AppFaces;
  /** How many faces this run baked. */
  readonly baked: number;
  /** The copies this run wrote or removed. */
  readonly changed: readonly string[];
  /** --check: what differs from the committed files and record. */
  readonly problems: readonly string[];
}

/** The input files of the faces to bake, by app sheet id, as appFaceInputs gives them. */
type AppFaceInputs = readonly {
  readonly sheet: string;
  readonly files: readonly string[];
}[];

/**
 * Bake the app faces. 'write' bakes what is new or changed and writes the
 * copies and the record; 'record' bakes and writes every face; 'check' bakes
 * every face in memory and reports what differs from the committed files.
 * The faces are the ones the app sheets keep (appFaceInputs) unless the
 * caller passes its own list.
 */
export async function buildAppFaces(
  repoRoot: string,
  mode: Mode,
  faceInputs?: AppFaceInputs,
): Promise<BuildResult> {
  const previous = await readRecord(repoRoot);
  const tool = await toolVersion(repoRoot);
  const recordedTool = previous?.tools[TOOL];
  const inputs = new Map(
    (faceInputs ?? (await appFaceInputs(repoRoot))).map(({ sheet, files }) => [sheet, files]),
  );
  const families: AppFaceFamily[] = [];
  const changed: string[] = [];
  const problems: string[] = [];
  const mismatches: string[] = [];
  // Copies to write, held until every face has passed, so a refused run writes nothing.
  const writes: {
    readonly folder: string;
    readonly outputPath: string;
    readonly bytes: Uint8Array;
  }[] = [];
  let baked = 0;

  for (const spec of APP_FACE_FAMILIES) {
    const files = inputs.get(spec.sheet);
    if (!files?.length) throw new Error(`the app sheets keep no ${spec.family} face`);
    const before = previous?.families.find((family) => family.family === spec.family);
    const sameBox =
      before !== undefined &&
      before.input === spec.input &&
      before.output === spec.output &&
      before.unitsPerEm === spec.box.unitsPerEm &&
      before.ascender === spec.box.ascender &&
      before.descender === spec.box.descender &&
      before.lineGap === spec.box.lineGap;
    const faces: AppFace[] = [];
    let win: [number, number] | null = null;
    for (const inputPath of files) {
      const file = path.posix.basename(inputPath);
      if (`${spec.input}/${file}` !== inputPath) {
        throw new Error(`${inputPath} is not in ${spec.input}, the ${spec.family} input folder`);
      }
      const outputPath = `${spec.output}/${file}`;
      const input = await readFile(path.join(repoRoot, inputPath));
      const inputDigest = digestOf(input);
      const committed = await readOptional(path.join(repoRoot, outputPath));
      const committedDigest = committed ? digestOf(committed) : null;
      // The recorded face, when its input and box are the ones of this run,
      // whichever wawoff2 version recorded it.
      const found = before?.faces.find((face) => face.file === file);
      const recorded =
        found !== undefined && sameBox && sameDigest(inputDigest, found.input) ? found : null;
      const faceWin = readLineMetrics(await decodeFontBytes(input));
      if (win === null) win = [faceWin.winAscent, faceWin.winDescent];
      else if (win[0] !== faceWin.winAscent || win[1] !== faceWin.winDescent) {
        throw new Error(`${inputPath} has other win metrics than the family's first face`);
      }

      if (
        mode === 'write' &&
        recorded &&
        recordedTool === tool &&
        committedDigest !== null &&
        sameDigest(committedDigest, recorded.output)
      ) {
        faces.push(recorded);
        continue;
      }
      const copy = await bakeFace(input, spec.box);
      baked += 1;
      const outputDigest = digestOf(copy.woff2);
      if (mode === 'check') {
        if (!committedDigest || !sameDigest(outputDigest, committedDigest)) {
          problems.push(`${outputPath} is not the baked copy of ${inputPath}`);
        }
        if (!found || !sameDigest(inputDigest, found.input)) {
          problems.push(`${APP_FACES_PATH} records another input for ${outputPath}`);
        } else if (!sameDigest(outputDigest, found.output)) {
          problems.push(`${APP_FACES_PATH} records another output for ${outputPath}`);
        }
      } else {
        // The same input and box must give the recorded bytes, under the
        // recorded wawoff2 version or a new one, unless --record accepts them.
        if (mode === 'write' && recorded && !sameDigest(outputDigest, recorded.output)) {
          mismatches.push(outputPath);
          faces.push(recorded);
          continue;
        }
        if (!committedDigest || !sameDigest(outputDigest, committedDigest)) {
          writes.push({ folder: spec.output, outputPath, bytes: copy.woff2 });
        }
      }
      faces.push({ file, input: inputDigest, output: outputDigest });
    }
    families.push({
      family: spec.family,
      input: spec.input,
      output: spec.output,
      ...spec.box,
      winAscent: win?.[0] ?? 0,
      winDescent: win?.[1] ?? 0,
      faces,
    });
  }
  if (mismatches.length) {
    const cause =
      recordedTool === tool
        ? `with ${TOOL} ${tool}, which recorded them, so the baking itself changed`
        : `with ${TOOL} ${tool}; ${recordedTool === undefined ? 'no version' : recordedTool} recorded them`;
    throw new Error(
      `Baking again gave other bytes than recorded for ${mismatches.join(', ')} (${cause}). ` +
        'Nothing was written. If the change is intended, rerun with --record to accept the new bytes.',
    );
  }
  for (const { folder, outputPath, bytes } of writes) {
    await mkdir(path.join(repoRoot, folder), { recursive: true });
    await writeFile(path.join(repoRoot, outputPath), bytes);
    changed.push(outputPath);
  }

  const record: AppFaces = { note: NOTE, tools: { [TOOL]: tool }, families };
  const expectedFiles = new Set(
    families.flatMap((family) => family.faces.map(({ file }) => `${family.output}/${file}`)),
  );
  if (mode === 'check') {
    if (JSON.stringify(record) !== JSON.stringify(previous)) {
      problems.push(`${APP_FACES_PATH} is not the generator's record`);
    }
    problems.push(...(await verifyAppFaces(repoRoot)));
  } else {
    // Copies of faces the sheets no longer keep go.
    for (const spec of APP_FACE_FAMILIES) {
      let present: string[] = [];
      try {
        present = await readdir(path.join(repoRoot, spec.output));
      } catch {
        present = [];
      }
      for (const file of present) {
        const outputPath = `${spec.output}/${file}`;
        if (!expectedFiles.has(outputPath)) {
          await rm(path.join(repoRoot, outputPath));
          changed.push(`${outputPath} (removed)`);
        }
      }
    }
    if (JSON.stringify(record) !== JSON.stringify(previous)) await writeAppFaces(repoRoot, record);
  }
  return { record, baked, changed, problems };
}

function summary(record: AppFaces): string {
  return record.families
    .map(
      ({ family, faces }) =>
        `${family} ${faces.length} faces, ${faces.reduce((sum, face) => sum + face.output.bytes, 0)} B`,
    )
    .join('; ');
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
  const result = await buildAppFaces(repoRoot, mode);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (mode === 'check') {
    if (result.problems.length) {
      console.error(
        `The baked app faces differ from the generator (run npm run generate:app-faces):\n${result.problems.map((line) => `  - ${line}`).join('\n')}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `Baked ${result.baked} app faces again in ${seconds} s: every copy in ${APP_FACES_DIRECTORY} and ${APP_FACES_PATH} match (${summary(result.record)}).`,
    );
    return;
  }
  for (const line of result.changed) console.log(`wrote ${line}`);
  console.log(
    `Baked ${result.baked} app faces in ${seconds} s, ${result.changed.length} files changed (${summary(result.record)}).`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
