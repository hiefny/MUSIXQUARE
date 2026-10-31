#!/usr/bin/env node
/**
 * Record downloaded Inter and Noto Sans KR files in fonts/font-sources.json
 * and copy the Inter subsets into fonts/inter/.
 *
 * Run it once per upstream refresh, on files downloaded into a new empty
 * folder outside the repository:
 *
 *   node scripts/fonts/record-font-sources.mts \
 *     --google-css <dir with inter.css and noto-kr.css> \
 *     --inter <dir with inter-<subset>.woff2> \
 *     --noto-kr <dir with Google's numbered shard files> \
 *     [--head-sizes <JSON object of shard URL to Content-Length>]
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
 *
 * Noto Sans KR is shipped as processed copies: run
 * `npm run generate:noto-kr -- --source <the same --noto-kr folder> --record`
 * next, then `npm run generate:font-sheets`.
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  FONT_SOURCES_PATH,
  digestOf,
  isWoff2,
  openFontBytes,
  parseFontFaceRules,
  readFontSources,
  writeFontSources,
  type FontSources,
  type RecordedFontFace,
} from './font-files.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INTER_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,100..900&display=swap';
const NOTO_SANS_KR_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@100..900&display=swap';
const INTER_DIRECTORY = 'fonts/inter';
const NOTO_SANS_KR_DIRECTORY = 'fonts/noto/noto-sans-kr';
const NOTE =
  'Provenance of the self-hosted Inter and Noto Sans KR files. source is the downloaded file, shipped is the committed file. Written by scripts/fonts/record-font-sources.mts and scripts/fonts/build-noto-kr-nolocl.mts; checked by scripts/check-app-font.mts. Do not edit by hand.';

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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'google-css': { type: 'string' },
      inter: { type: 'string' },
      'noto-kr': { type: 'string' },
      'head-sizes': { type: 'string' },
    },
  });
  const cssFolder = requireOption(values['google-css'], 'google-css');
  const interFolder = requireOption(values.inter, 'inter');
  const notoFolder = requireOption(values['noto-kr'], 'noto-kr');
  const headSizes = await readHeadSizes(values['head-sizes']);
  const checksums = await readChecksums(notoFolder);
  let previous: FontSources | null = null;
  try {
    previous = await readFontSources(repoRoot);
  } catch {
    previous = null;
  }

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

  const sources: FontSources = {
    note: NOTE,
    tools: previous?.tools ?? {},
    inter: {
      family: 'Inter',
      version: `${await versionName(latinBytes)} (Google Fonts ${googleVersion(latin.url)})`,
      sourceCss: INTER_CSS_URL,
      license: 'fonts/INTER_LICENSE.txt',
      directory: INTER_DIRECTORY,
      processing: 'None. The shipped files are the downloaded files.',
      faces: interFaces,
    },
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
