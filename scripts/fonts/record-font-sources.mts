#!/usr/bin/env node
/**
 * Record downloaded Inter and Noto Sans KR files in fonts/font-sources.json
 * and copy the Inter subsets into fonts/inter/ and the full Inter into
 * fonts/inter-full.ttf.
 *
 * Run it once per upstream refresh, on files downloaded into a new empty
 * folder outside the repository:
 *
 *   node scripts/fonts/record-font-sources.mts \
 *     --google-css <dir with inter.css and noto-kr.css> \
 *     --inter <dir with inter-<subset>.woff2> \
 *     --noto-kr <dir with Google's numbered shard files> \
 *     [--inter-full <the full Inter, Inter[opsz,wght].ttf>] \
 *     [--head-sizes <JSON object of shard URL to Content-Length>]
 *
 * or, to record the full Inter alone against the committed subsets:
 *
 *   node scripts/fonts/record-font-sources.mts --inter-full <file>
 *
 * - inter.css is Google's CSS for
 *   https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,100..900&display=swap
 *   and noto-kr.css for
 *   https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@100..900&display=swap,
 *   both fetched with a current Chrome User-Agent so Google serves WOFF2.
 * - Noto Sans KR keeps only Google's numbered shards (#0-#119); Inter draws
 *   the Latin, Cyrillic and Vietnamese ranges of its four unnumbered shards.
 * - A SHA256SUMS file in the --noto-kr folder ("<sha256>  <file>" lines) and
 *   the --head-sizes record are checked when present.
 * - The full Inter is google/fonts' ofl/inter/Inter[opsz,wght].ttf
 *   (INTER_FULL_URL), the file Google cuts the subsets from, which Inter's
 *   symbol faces are cut from (scripts/fonts/build-inter-symbol-faces.mts).
 *   It must be the subsets' build: the same name ID 5 and, for every code
 *   point a subset maps, the same outline and advance at the default
 *   instance and every corner of opsz 14 and 32 with wght 100, 400, 700 and
 *   900. A refresh without --inter-full checks the new subsets against the
 *   committed full Inter the same way and stops if they differ, so the
 *   subsets cannot move to a new build alone. Its record keeps the URL, the
 *   upstream path and the Git blob id of the bytes (which pins them, as the
 *   URL on main does not); the file keeps a name without [ ] and a comma,
 *   which shells expand.
 *
 * Noto Sans KR is shipped as processed copies: run
 * `npm run generate:noto-kr -- --source <the same --noto-kr folder> --record`
 * next, then `npm run generate:font-sheets`.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type * as hb from 'harfbuzzjs';

import {
  FONT_SOURCES_PATH,
  INTER_AXES,
  INTER_FULL_PATH,
  digestOf,
  gitBlobId,
  interBuild,
  interBuildProblems,
  isWoff2,
  openFontBytes,
  parseFontFaceRules,
  parseFontSources,
  parseFontSourcesDraft,
  writeFontSources,
  type FontSources,
  type RecordedFontFace,
  type RecordedSourceFont,
} from './font-files.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INTER_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,100..900&display=swap';
const NOTO_SANS_KR_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@100..900&display=swap';
const INTER_DIRECTORY = 'fonts/inter';
const INTER_LICENSE = 'fonts/INTER_LICENSE.txt';
/** Where the full Inter is downloaded from: google/fonts on main, so its record keeps the Git blob id too. */
const INTER_FULL_URL =
  'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf';
const INTER_FULL_UPSTREAM = 'github.com/google/fonts ofl/inter/Inter[opsz,wght].ttf';
const INTER_FULL_PROCESSING =
  "None. The committed file is the downloaded file, under a name without [ ] and a comma, which shells expand. Nothing serves it: scripts/fonts/build-inter-symbol-faces.mts cuts Inter's symbol faces from it.";
const NOTO_SANS_KR_DIRECTORY = 'fonts/noto/noto-sans-kr';
const NOTE =
  "Provenance of the self-hosted Inter and Noto Sans KR files, and of the full Inter that Inter's symbol faces are cut from (interFull). source is the downloaded file, shipped is the committed file. Written by scripts/fonts/record-font-sources.mts and scripts/fonts/build-noto-kr-nolocl.mts; checked by scripts/check-app-font.mts. Do not edit by hand.";

function requireOption(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing --${name}`);
  return path.resolve(value);
}

function googleVersion(url: string): string {
  const version = /^https:\/\/fonts\.gstatic\.com\/s\/[a-z]+\/(v\d+)\//u.exec(url)?.[1];
  if (!version) throw new Error(`Not a Google Fonts file URL: ${url}`);
  return version;
}

async function readChecksums(folder: string): Promise<Map<string, string> | null> {
  let text: string;
  try {
    text = await readFile(path.join(folder, 'SHA256SUMS'), 'utf8');
  } catch {
    return null;
  }
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/u.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2], match[1]);
  }
  return sums;
}

async function readHeadSizes(file: string | undefined): Promise<Map<string, number> | null> {
  if (!file) return null;
  const value: unknown = JSON.parse(await readFile(path.resolve(file), 'utf8'));
  if (typeof value !== 'object' || value === null)
    throw new Error('--head-sizes is not a JSON object');
  const sizes = new Map<string, number>();
  for (const [url, bytes] of Object.entries(value)) {
    if (typeof bytes === 'number') sizes.set(url, bytes);
  }
  return sizes;
}

async function versionName(bytes: Uint8Array): Promise<string> {
  const name = (await openFontBytes(bytes)).getName(5, 'en');
  return name.replace(/^Version\s+/u, '').split(';')[0] ?? name;
}

type InterSubsets = readonly { readonly file: string; readonly face: hb.Face }[];

/**
 * The record of a downloaded full Inter, after checking that it is a
 * TrueType Inter with Inter's axes and the build of the subsets.
 */
async function readInterFull(
  file: string,
  subsets: InterSubsets,
): Promise<{ record: RecordedSourceFont; bytes: Uint8Array }> {
  const bytes = Uint8Array.from(await readFile(file));
  if (isWoff2(bytes)) throw new Error(`${file} is WOFF2, not google/fonts' TrueType file`);
  const face = await openFontBytes(bytes);
  if (face.getName(1, 'en') !== 'Inter') throw new Error(`${file} is not named Inter`);
  const axes = face.getAxisInfos();
  for (const [tag, [min, max]] of Object.entries(INTER_AXES)) {
    if (axes[tag]?.min !== min || axes[tag]?.max !== max) {
      throw new Error(`${file}: axis ${tag} does not span ${min}-${max}`);
    }
  }
  const problems = interBuildProblems(face, subsets);
  if (problems.length) {
    throw new Error(`${file} is not the build of the Inter subsets: ${problems.join('; ')}`);
  }
  const digest = digestOf(bytes);
  return {
    record: {
      family: 'Inter',
      version: interBuild(face),
      url: INTER_FULL_URL,
      upstream: INTER_FULL_UPSTREAM,
      gitBlob: gitBlobId(bytes),
      license: INTER_LICENSE,
      file: INTER_FULL_PATH,
      processing: INTER_FULL_PROCESSING,
      source: digest,
      shipped: digest,
    },
    bytes,
  };
}

async function openSubsets(
  files: readonly { file: string; bytes: Uint8Array }[],
): Promise<InterSubsets> {
  const subsets: { file: string; face: hb.Face }[] = [];
  for (const { file, bytes } of files) subsets.push({ file, face: await openFontBytes(bytes) });
  return subsets;
}

async function readPrevious(): Promise<ReturnType<typeof parseFontSourcesDraft> | null> {
  try {
    return parseFontSourcesDraft(await readFile(path.join(repoRoot, FONT_SOURCES_PATH), 'utf8'));
  } catch {
    return null;
  }
}

/** Record the full Inter alone, against the committed subsets, and copy it to INTER_FULL_PATH. */
async function recordInterFullOnly(file: string): Promise<void> {
  const previous = await readPrevious();
  if (!previous) throw new Error(`${FONT_SOURCES_PATH} cannot be read; record the subsets first`);
  const committed: { file: string; bytes: Uint8Array }[] = [];
  for (const face of previous.inter.faces) {
    const where = `${previous.inter.directory}/${face.file}`;
    committed.push({ file: where, bytes: await readFile(path.join(repoRoot, where)) });
  }
  const { record, bytes } = await readInterFull(file, await openSubsets(committed));
  // Validated as the guard reads it, in the record's key order.
  const sources: FontSources = parseFontSources(
    JSON.stringify({
      note: NOTE,
      tools: previous.tools,
      inter: previous.inter,
      interFull: record,
      notoSansKr: previous.notoSansKr,
    }),
  );
  await writeFile(path.join(repoRoot, INTER_FULL_PATH), bytes);
  await writeFontSources(repoRoot, sources);
  console.log(
    `Recorded the full Inter ${record.version} (${record.source.bytes} B, Git blob ${record.gitBlob}) and copied it to ${INTER_FULL_PATH}.`,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'google-css': { type: 'string' },
      inter: { type: 'string' },
      'noto-kr': { type: 'string' },
      'head-sizes': { type: 'string' },
      'inter-full': { type: 'string' },
    },
  });
  const fullFile = values['inter-full'] ? path.resolve(values['inter-full']) : null;
  if (!values['google-css'] && !values.inter && !values['noto-kr'] && fullFile) {
    await recordInterFullOnly(fullFile);
    return;
  }
  const cssFolder = requireOption(values['google-css'], 'google-css');
  const interFolder = requireOption(values.inter, 'inter');
  const notoFolder = requireOption(values['noto-kr'], 'noto-kr');
  const headSizes = await readHeadSizes(values['head-sizes']);
  const checksums = await readChecksums(notoFolder);
  const previous = await readPrevious();

  const interRules = parseFontFaceRules(await readFile(path.join(cssFolder, 'inter.css'), 'utf8'));
  const interFaces: RecordedFontFace[] = [];
  const interBytes = new Map<string, Uint8Array>();
  for (const rule of interRules) {
    if (rule.family !== 'Inter' || !rule.comment || !rule.unicodeRange) {
      throw new Error(`Unexpected Inter rule: ${rule.url}`);
    }
    const file = `inter-${rule.comment}.woff2`;
    const bytes = await readFile(path.join(interFolder, file));
    if (!isWoff2(bytes)) throw new Error(`${file} is not WOFF2`);
    googleVersion(rule.url);
    const digest = digestOf(bytes);
    interBytes.set(file, bytes);
    interFaces.push({
      subset: rule.comment,
      file,
      url: rule.url,
      unicodeRange: rule.unicodeRange,
      source: digest,
      shipped: digest,
    });
  }

  const notoRules = parseFontFaceRules(await readFile(path.join(cssFolder, 'noto-kr.css'), 'utf8'))
    .map((rule) => ({ rule, shard: /\.(\d+)\.woff2$/u.exec(rule.url)?.[1] }))
    .filter((entry): entry is { rule: (typeof entry)['rule']; shard: string } => !!entry.shard)
    .sort((left, right) => Number(left.shard) - Number(right.shard));
  const notoFaces: RecordedFontFace[] = [];
  let firstShard: Uint8Array | null = null;
  for (const { rule, shard } of notoRules) {
    if (rule.family !== 'Noto Sans KR' || !rule.unicodeRange) {
      throw new Error(`Unexpected Noto Sans KR rule: ${rule.url}`);
    }
    const bytes = await readFile(path.join(notoFolder, rule.file));
    if (!isWoff2(bytes)) throw new Error(`${rule.file} is not WOFF2`);
    const digest = digestOf(bytes);
    const expectedSum = checksums?.get(rule.file);
    if (checksums && expectedSum !== digest.sha256) {
      throw new Error(`${rule.file}: sha256 ${digest.sha256} differs from SHA256SUMS`);
    }
    const expectedSize = headSizes?.get(rule.url);
    if (headSizes && expectedSize !== digest.bytes) {
      throw new Error(`${rule.file}: ${digest.bytes} B differs from the HEAD size ${expectedSize}`);
    }
    firstShard ??= bytes;
    const kept = previous?.notoSansKr.faces.find(
      (face) => face.file === rule.file && face.source.sha256 === digest.sha256,
    );
    notoFaces.push({
      subset: shard,
      file: rule.file,
      url: rule.url,
      unicodeRange: rule.unicodeRange,
      source: digest,
      shipped: kept?.shipped ?? null,
    });
  }
  const [latin] = interFaces.filter(({ subset }) => subset === 'latin');
  const latinBytes = latin ? interBytes.get(latin.file) : undefined;
  if (!latin || !latinBytes || !firstShard || !notoFaces[0]) {
    throw new Error('The downloads lack the Inter Latin subset or the Noto Sans KR shards');
  }

  // The full Inter: the one downloaded with the subsets, or the committed
  // one, either of which must be the subsets' build.
  const subsets = await openSubsets(
    [...interBytes].map(([file, bytes]) => ({ file: path.join(interFolder, file), bytes })),
  );
  let interFull: RecordedSourceFont;
  let fullBytes: Uint8Array | null = null;
  if (fullFile) {
    ({ record: interFull, bytes: fullBytes } = await readInterFull(fullFile, subsets));
  } else {
    if (!previous?.interFull) {
      throw new Error(`${FONT_SOURCES_PATH} records no full Inter; pass --inter-full`);
    }
    const committed = await readFile(path.join(repoRoot, INTER_FULL_PATH));
    const problems = interBuildProblems(await openFontBytes(committed), subsets);
    if (problems.length) {
      throw new Error(
        `The downloaded Inter subsets are not the build of ${INTER_FULL_PATH}: ${problems.join('; ')}. Download the full Inter of their build (${INTER_FULL_URL}) and pass it with --inter-full.`,
      );
    }
    interFull = previous.interFull;
  }

  const sources: FontSources = {
    note: NOTE,
    tools: previous?.tools ?? {},
    inter: {
      family: 'Inter',
      version: `${await versionName(latinBytes)} (Google Fonts ${googleVersion(latin.url)})`,
      sourceCss: INTER_CSS_URL,
      license: INTER_LICENSE,
      directory: INTER_DIRECTORY,
      processing: 'None. The shipped files are the downloaded files.',
      faces: interFaces,
    },
    interFull,
    notoSansKr: {
      family: 'Noto Sans KR',
      version: `${await versionName(firstShard)} (Google Fonts ${googleVersion(notoFaces[0].url)})`,
      sourceCss: NOTO_SANS_KR_CSS_URL,
      license: 'fonts/NOTO_CJK_LICENSE.txt',
      directory: NOTO_SANS_KR_DIRECTORY,
      processing:
        'scripts/fonts/build-noto-kr-nolocl.mts re-encodes each shard with its whole cmap and every GSUB and GPOS feature except locl, so the Korean and English UIs shape every mark alike.',
      faces: notoFaces,
    },
  };

  await mkdir(path.join(repoRoot, INTER_DIRECTORY), { recursive: true });
  for (const face of interFaces) {
    await copyFile(
      path.join(interFolder, face.file),
      path.join(repoRoot, INTER_DIRECTORY, face.file),
    );
  }
  if (fullBytes) await writeFile(path.join(repoRoot, INTER_FULL_PATH), fullBytes);
  await writeFontSources(repoRoot, sources);
  const pending = notoFaces.filter(({ shipped }) => !shipped).length;
  console.log(
    `Recorded ${interFaces.length} Inter subsets (copied to ${INTER_DIRECTORY}) and ${notoFaces.length} Noto Sans KR shards in ${FONT_SOURCES_PATH}.` +
      (pending ? ` ${pending} Noto Sans KR shards still need npm run generate:noto-kr.` : ''),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
