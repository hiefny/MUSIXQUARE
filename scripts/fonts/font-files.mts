/**
 * Shared helpers for the app's self-hosted font files and their two records.
 *
 * fonts/font-sources.json lists every Inter and Noto Sans KR file the
 * repository keeps from Google: the Google URL it came from, Google's
 * unicode-range for it, and the sha256 and size of both the downloaded bytes
 * ("source") and the committed bytes ("shipped"). Inter keeps the downloaded
 * bytes. Noto Sans KR keeps copies without the Korean locl lookup
 * (scripts/fonts/build-noto-kr-nolocl.mts). It is written only by
 * scripts/fonts/record-font-sources.mts and that builder.
 *
 * fonts/app-faces.json lists the faces the app serves: for each Inter and CJK
 * face of the app sheets, the copy in fonts/app/ with the line box of
 * src/i18n/font-metrics.ts baked in, and the digests of that copy and of its
 * input (a file of fonts/inter/ or fonts/noto/). It is written only by
 * scripts/fonts/build-app-faces.mts.
 *
 * fonts/hangul-faces.json lists the Hangul faces in fonts/app/hangul/: the
 * subsets of fonts/PretendardVariable.woff2 with their code points and
 * digests, the source's digest and the tool versions. It is written only by
 * scripts/fonts/build-hangul-faces.mts.
 *
 * scripts/check-app-font.mts and the unit tests verify the files against all
 * three.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as hb from 'harfbuzzjs';

import {
  CJK_FACE_METRICS,
  HANGUL_LINE_BOX,
  INTER_FACE_METRICS,
} from '../../src/i18n/font-metrics.ts';
import {
  readLineMetrics,
  sfntChecksumsValid,
  sfntTables,
  unpatchedDifferences,
  type BakedLineBox,
} from './app-face-metrics.mts';
import { nameText, readNameTable, type SfntNameRecord } from './sfnt-names.mts';

type Woff2Codec = (data: Uint8Array) => Promise<Uint8Array>;

const requireCodec = createRequire(import.meta.url);
const decompressWoff2 = requireCodec('wawoff2/decompress.js') as Woff2Codec;
const compressWoff2 = requireCodec('wawoff2/compress.js') as Woff2Codec;

export const FONT_SOURCES_PATH = 'fonts/font-sources.json';
export const APP_FACES_PATH = 'fonts/app-faces.json';
/** The directory of the baked app faces, one folder per family. */
export const APP_FACES_DIRECTORY = 'fonts/app';

export interface FileDigest {
  readonly sha256: string;
  readonly bytes: number;
}

export interface RecordedFontFace {
  /** Google's subset name (Inter) or shard number (Noto Sans KR). */
  readonly subset: string;
  /** File name in the family directory, Google's own name for Noto Sans KR. */
  readonly file: string;
  readonly url: string;
  /** Google's unicode-range for the file, as Google's CSS wrote it. */
  readonly unicodeRange: string;
  readonly source: FileDigest;
  readonly shipped: FileDigest | null;
}

export interface RecordedFontFamily {
  readonly family: string;
  readonly version: string;
  readonly sourceCss: string;
  readonly license: string;
  readonly directory: string;
  readonly processing: string;
  readonly faces: readonly RecordedFontFace[];
}

export interface FontSources {
  readonly note: string;
  readonly tools: Readonly<Record<string, string>>;
  readonly inter: RecordedFontFamily;
  readonly notoSansKr: RecordedFontFamily;
}

export interface FontFaceRule {
  /** The comment right before the rule, such as Google's subset name. */
  readonly comment: string | null;
  readonly family: string;
  /** The src url as written, relative to the sheet. */
  readonly url: string;
  readonly file: string;
  readonly unicodeRange: string | null;
  /** Every declaration in source order, names lower-cased. */
  readonly declarations: ReadonlyMap<string, string>;
}

const SHA256_RE = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
  where: string,
  file = FONT_SOURCES_PATH,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${file}: ${where}.${key} must be a non-empty string`);
  }
  return value;
}

function readDigest(value: unknown, where: string, file = FONT_SOURCES_PATH): FileDigest {
  if (
    !isRecord(value) ||
    typeof value.sha256 !== 'string' ||
    !SHA256_RE.test(value.sha256) ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0
  ) {
    throw new TypeError(`${file}: ${where} must be { sha256, bytes }`);
  }
  return { sha256: value.sha256, bytes: value.bytes };
}

function readFace(value: unknown, where: string): RecordedFontFace {
  if (!isRecord(value)) throw new TypeError(`${FONT_SOURCES_PATH}: ${where} must be an object`);
  return {
    subset: readString(value, 'subset', where),
    file: readString(value, 'file', where),
    url: readString(value, 'url', where),
    unicodeRange: readString(value, 'unicodeRange', where),
    source: readDigest(value.source, `${where}.source`),
    shipped: value.shipped === null ? null : readDigest(value.shipped, `${where}.shipped`),
  };
}

function readFamily(value: unknown, where: string): RecordedFontFamily {
  if (!isRecord(value) || !Array.isArray(value.faces)) {
    throw new TypeError(`${FONT_SOURCES_PATH}: ${where} must be a family with faces`);
  }
  return {
    family: readString(value, 'family', where),
    version: readString(value, 'version', where),
    sourceCss: readString(value, 'sourceCss', where),
    license: readString(value, 'license', where),
    directory: readString(value, 'directory', where),
    processing: readString(value, 'processing', where),
    faces: value.faces.map((face: unknown, index) => readFace(face, `${where}.faces[${index}]`)),
  };
}

function readTools(value: unknown, file = FONT_SOURCES_PATH): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new TypeError(`${file}: tools must be an object`);
  const tools: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== 'string') {
      throw new TypeError(`${file}: tools.${name} must be a string`);
    }
    tools[name] = version;
  }
  return tools;
}

export function parseFontSources(text: string): FontSources {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new TypeError(`${FONT_SOURCES_PATH} must hold an object`);
  return {
    note: readString(value, 'note', 'root'),
    tools: readTools(value.tools),
    inter: readFamily(value.inter, 'inter'),
    notoSansKr: readFamily(value.notoSansKr, 'notoSansKr'),
  };
}

export async function readFontSources(repoRoot: string): Promise<FontSources> {
  return parseFontSources(await readFile(path.join(repoRoot, FONT_SOURCES_PATH), 'utf8'));
}

export async function writeFontSources(repoRoot: string, sources: FontSources): Promise<void> {
  await writeFile(
    path.join(repoRoot, FONT_SOURCES_PATH),
    `${JSON.stringify(sources, null, 2)}\n`,
    'utf8',
  );
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function digestOf(bytes: Uint8Array): FileDigest {
  return { sha256: sha256Hex(bytes), bytes: bytes.byteLength };
}

export function isWoff2(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 4)).toString('latin1') === 'wOF2';
}

// The WOFF2 decoder and encoder each share one WebAssembly instance and are
// not reentrant: overlapping calls return each other's bytes. Run them one at
// a time. Each returns a view into its instance's memory, which the next call
// overwrites, so the results are copied out.
let decodeQueue: Promise<unknown> = Promise.resolve();
let encodeQueue: Promise<unknown> = Promise.resolve();

/** The sfnt (TrueType or CFF) bytes of a WOFF2 file, or the bytes themselves. */
export async function decodeFontBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isWoff2(bytes)) return bytes;
  const decoded = decodeQueue.then(async () => Uint8Array.from(await decompressWoff2(bytes)));
  decodeQueue = decoded.catch(() => undefined);
  return decoded;
}

/** The WOFF2 bytes of an sfnt font, with the reference encoder's defaults. */
export async function encodeWoff2(sfnt: Uint8Array): Promise<Uint8Array> {
  const encoded = encodeQueue.then(async () => Uint8Array.from(await compressWoff2(sfnt)));
  encodeQueue = encoded.catch(() => undefined);
  return encoded;
}

export async function openFontBytes(bytes: Uint8Array): Promise<hb.Face> {
  return new hb.Face(new hb.Blob(await decodeFontBytes(bytes)), 0);
}

export async function openFontFile(file: string): Promise<hb.Face> {
  return openFontBytes(await readFile(file));
}

export function fontCodePoints(face: hb.Face): Set<number> {
  return new Set(face.collectUnicodes());
}

/** Every GSUB and GPOS feature tag of the face. */
export function fontLayoutFeatures(face: hb.Face): Set<string> {
  return new Set([...face.getTableFeatureTags('GSUB'), ...face.getTableFeatureTags('GPOS')]);
}

/** Code points of a CSS unicode-range value such as "U+0000-00FF, U+0131". */
export function parseUnicodeRange(text: string): Set<number> {
  const codePoints = new Set<number>();
  for (const part of text.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const match = /^U\+([0-9a-f]{1,6})(?:-([0-9a-f]{1,6}))?$/iu.exec(token);
    if (!match?.[1]) throw new SyntaxError(`Unsupported unicode-range token: ${token}`);
    const start = Number.parseInt(match[1], 16);
    const end = match[2] ? Number.parseInt(match[2], 16) : start;
    if (end < start) throw new SyntaxError(`Reversed unicode-range token: ${token}`);
    for (let codePoint = start; codePoint <= end; codePoint += 1) codePoints.add(codePoint);
  }
  return codePoints;
}

function hex(codePoint: number): string {
  return codePoint.toString(16).toUpperCase().padStart(4, '0');
}

/** A canonical unicode-range value: sorted, merged runs, upper-case hex. */
export function formatUnicodeRange(codePoints: Iterable<number>): string {
  const sorted = [...new Set(codePoints)].sort((left, right) => left - right);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length;) {
    const start = sorted[index];
    if (start === undefined) break;
    let end = start;
    while (sorted[index + 1] === end + 1) {
      end += 1;
      index += 1;
    }
    index += 1;
    parts.push(end === start ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`);
  }
  return parts.join(', ');
}

function unquote(value: string): string {
  return value.replace(/^(['"])(.*)\1$/su, '$2');
}

/** The @font-face rules of a stylesheet, with the comment right before each. */
export function parseFontFaceRules(css: string): FontFaceRule[] {
  const rules: FontFaceRule[] = [];
  const rulePattern = /(?:\/\*([^*]*(?:\*(?!\/)[^*]*)*)\*\/\s*)?@font-face\s*\{([^}]*)\}/gu;
  for (const match of css.matchAll(rulePattern)) {
    const body = match[2] ?? '';
    const declarations = new Map<string, string>();
    for (const declaration of body.matchAll(/([a-z-]+)\s*:\s*([^;]+?)\s*(?:;|$)/giu)) {
      const [, name, value] = declaration;
      if (name && value) declarations.set(name.toLowerCase(), value);
    }
    const src = declarations.get('src') ?? '';
    const url = /url\(\s*(['"]?)([^'")]+)\1\s*\)/u.exec(src)?.[2];
    const family = declarations.get('font-family');
    if (!url || !family) throw new SyntaxError(`@font-face without a url or a family: ${body}`);
    rules.push({
      comment: match[1]?.trim() || null,
      family: unquote(family),
      url,
      file: url.slice(url.lastIndexOf('/') + 1),
      unicodeRange: declarations.get('unicode-range') ?? null,
      declarations,
    });
  }
  return rules;
}

const INTER_AXES = { opsz: [14, 32], wght: [100, 900] } as const;
const INTER_FACE_COUNT = 7;
const NOTO_SANS_KR_FACE_COUNT = 120;

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

async function verifyFamily(
  repoRoot: string,
  family: RecordedFontFamily,
  expectedFaces: number,
  checkFace: (face: hb.Face, recorded: RecordedFontFace) => string[],
): Promise<string[]> {
  const failures: string[] = [];
  if (family.faces.length !== expectedFaces) {
    failures.push(
      `${family.family}: the record lists ${family.faces.length} files, expected ${expectedFaces}`,
    );
  }
  const license = await readOptional(path.join(repoRoot, family.license));
  if (!license?.toString('utf8').includes('SIL OPEN FONT LICENSE Version 1.1')) {
    failures.push(`${family.family}: ${family.license} is missing or is not the OFL 1.1 text`);
  }
  const listed = new Set(family.faces.map(({ file }) => file));
  let present: string[] = [];
  try {
    present = await readdir(path.join(repoRoot, family.directory));
  } catch {
    failures.push(`${family.family}: ${family.directory} is missing`);
  }
  for (const file of present) {
    if (!listed.has(file)) failures.push(`${family.directory}/${file} is not in the record`);
  }
  for (const recorded of family.faces) {
    const where = `${family.directory}/${recorded.file}`;
    const bytes = await readOptional(path.join(repoRoot, where));
    if (!bytes) {
      failures.push(`${where} is missing`);
      continue;
    }
    if (!recorded.shipped) {
      failures.push(`${where} has no shipped digest in ${FONT_SOURCES_PATH}`);
      continue;
    }
    if (!isWoff2(bytes)) {
      failures.push(`${where} is not WOFF2`);
      continue;
    }
    const digest = digestOf(bytes);
    if (digest.sha256 !== recorded.shipped.sha256 || digest.bytes !== recorded.shipped.bytes) {
      failures.push(
        `${where} (${digest.bytes} B, sha256 ${digest.sha256}) differs from its record (${recorded.shipped.bytes} B, sha256 ${recorded.shipped.sha256})`,
      );
      continue;
    }
    failures.push(
      ...checkFace(await openFontBytes(bytes), recorded).map((line) => `${where}: ${line}`),
    );
  }
  return failures;
}

/**
 * Check every shipped Inter and Noto Sans KR file against the record: present,
 * WOFF2, the recorded sha256 and size, nothing unrecorded in their folders,
 * Inter unchanged from its download with its opsz and wght axes and its Latin
 * contextual alternates, and no locl lookup left in Noto Sans KR.
 */
export async function verifyShippedFontFiles(
  repoRoot: string,
  sources?: FontSources,
  families: readonly ('inter' | 'notoSansKr')[] = ['inter', 'notoSansKr'],
): Promise<string[]> {
  const record = sources ?? (await readFontSources(repoRoot));
  const failures: string[] = [];
  if (families.includes('inter')) failures.push(...(await verifyInter(repoRoot, record.inter)));
  if (families.includes('notoSansKr')) {
    failures.push(...(await verifyNotoSansKr(repoRoot, record.notoSansKr)));
  }
  return failures;
}

function verifyInter(repoRoot: string, family: RecordedFontFamily): Promise<string[]> {
  return verifyFamily(repoRoot, family, INTER_FACE_COUNT, (face, recorded) => {
    const failures: string[] = [];
    if (
      recorded.shipped?.sha256 !== recorded.source.sha256 ||
      recorded.shipped.bytes !== recorded.source.bytes
    ) {
      failures.push('Inter must ship the downloaded bytes unchanged');
    }
    const axes = face.getAxisInfos();
    for (const [tag, [min, max]] of Object.entries(INTER_AXES)) {
      const axis = axes[tag];
      if (axis?.min !== min || axis.max !== max) {
        failures.push(`axis ${tag} must span ${min}-${max}`);
      }
    }
    if (recorded.subset === 'latin' && !fontLayoutFeatures(face).has('calt')) {
      failures.push('the Latin subset lost its contextual alternates (calt)');
    }
    return failures;
  });
}

function verifyNotoSansKr(repoRoot: string, family: RecordedFontFamily): Promise<string[]> {
  return verifyFamily(repoRoot, family, NOTO_SANS_KR_FACE_COUNT, (face) =>
    fontLayoutFeatures(face).has('locl') ? ['the Korean locl lookup is still present'] : [],
  );
}

// ── The baked app faces: fonts/app/ and fonts/app-faces.json ───────

/** A family the app serves with its line box baked in. */
export interface AppFaceFamilySpec {
  readonly family: string;
  /** The app sheet that names the family's faces (APP_FONT_SHEETS id). */
  readonly sheet: string;
  /** Where the input files live. */
  readonly input: string;
  /** Where the baked copies go, under fonts/app/. */
  readonly output: string;
  readonly box: BakedLineBox;
}

function boxOf(metrics: typeof INTER_FACE_METRICS): BakedLineBox {
  const { unitsPerEm, ascender, descender, lineGap } = metrics;
  return { unitsPerEm, ascender, descender, lineGap };
}

/**
 * The baked families in sheet order. JP, SC and TC take Google's shards from
 * the folders the static pages also use, which keep them unchanged.
 */
export const APP_FACE_FAMILIES: readonly AppFaceFamilySpec[] = [
  {
    family: 'Inter',
    sheet: 'font-inter',
    input: 'fonts/inter',
    output: `${APP_FACES_DIRECTORY}/inter`,
    box: boxOf(INTER_FACE_METRICS),
  },
  ...(['KR', 'JP', 'SC', 'TC'] as const).map((script) => ({
    family: `Noto Sans ${script}`,
    sheet: `font-noto-${script.toLowerCase()}`,
    input: `fonts/noto/noto-sans-${script.toLowerCase()}`,
    output: `${APP_FACES_DIRECTORY}/noto-sans-${script.toLowerCase()}`,
    box: boxOf(CJK_FACE_METRICS),
  })),
];

export interface AppFace {
  /** The file name, the same in the input and the output folder. */
  readonly file: string;
  readonly input: FileDigest;
  readonly output: FileDigest;
}

export interface AppFaceFamily extends BakedLineBox {
  readonly family: string;
  readonly input: string;
  readonly output: string;
  /** The input's usWinAscent and usWinDescent, which the copies keep. */
  readonly winAscent: number;
  readonly winDescent: number;
  readonly faces: readonly AppFace[];
}

export interface AppFaces {
  readonly note: string;
  readonly tools: Readonly<Record<string, string>>;
  readonly families: readonly AppFaceFamily[];
}

function readCount(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${APP_FACES_PATH}: ${where}.${key} must be a whole number`);
  }
  return value;
}

function readAppFaceFamily(value: unknown, where: string): AppFaceFamily {
  if (!isRecord(value) || !Array.isArray(value.faces)) {
    throw new TypeError(`${APP_FACES_PATH}: ${where} must be a family with faces`);
  }
  return {
    family: readString(value, 'family', where, APP_FACES_PATH),
    input: readString(value, 'input', where, APP_FACES_PATH),
    output: readString(value, 'output', where, APP_FACES_PATH),
    unitsPerEm: readCount(value, 'unitsPerEm', where),
    ascender: readCount(value, 'ascender', where),
    descender: readCount(value, 'descender', where),
    lineGap: readCount(value, 'lineGap', where),
    winAscent: readCount(value, 'winAscent', where),
    winDescent: readCount(value, 'winDescent', where),
    faces: value.faces.map((face: unknown, index) => {
      const at = `${where}.faces[${index}]`;
      if (!isRecord(face)) throw new TypeError(`${APP_FACES_PATH}: ${at} must be an object`);
      return {
        file: readString(face, 'file', at, APP_FACES_PATH),
        input: readDigest(face.input, `${at}.input`, APP_FACES_PATH),
        output: readDigest(face.output, `${at}.output`, APP_FACES_PATH),
      };
    }),
  };
}

export function parseAppFaces(text: string): AppFaces {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.families)) {
    throw new TypeError(`${APP_FACES_PATH} must hold an object with families`);
  }
  return {
    note: readString(value, 'note', 'root', APP_FACES_PATH),
    tools: readTools(value.tools, APP_FACES_PATH),
    families: value.families.map((family: unknown, index) =>
      readAppFaceFamily(family, `families[${index}]`),
    ),
  };
}

export async function readAppFaces(repoRoot: string): Promise<AppFaces> {
  return parseAppFaces(await readFile(path.join(repoRoot, APP_FACES_PATH), 'utf8'));
}

export async function writeAppFaces(repoRoot: string, record: AppFaces): Promise<void> {
  await writeFile(
    path.join(repoRoot, APP_FACES_PATH),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
}

/** Each recorded input path (family input folder and file) with its baked copy's path. */
export function appFaceOutputs(record: AppFaces): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const family of record.families) {
    for (const { file } of family.faces) {
      outputs.set(`${family.input}/${file}`, `${family.output}/${file}`);
    }
  }
  return outputs;
}

async function listRepoFiles(repoRoot: string, directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(repoRoot, directory), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listRepoFiles(repoRoot, child)));
    else files.push(child);
  }
  return files;
}

const sameDigest = (left: FileDigest, right: FileDigest): boolean =>
  left.sha256 === right.sha256 && left.bytes === right.bytes;

/**
 * Check the baked app faces against fonts/app-faces.json without baking them
 * again (a few seconds): the record lists the families of APP_FACE_FAMILIES
 * with the line box of src/i18n/font-metrics.ts; fonts/app/ holds exactly the
 * recorded copies; every input and copy has its recorded digest (the Inter
 * and Noto Sans KR inputs also the shipped digest of fonts/font-sources.json);
 * every copy holds the box in hhea and the OS/2 typo metrics with
 * USE_TYPO_METRICS, keeps its input's win metrics, which hold the box, has
 * valid checksums, and differs from its input only in the patched fields.
 * `npm run generate:app-faces -- --check` also bakes every face again.
 */
export async function verifyAppFaces(
  repoRoot: string,
  record?: AppFaces,
  sources?: FontSources,
): Promise<string[]> {
  const failures: string[] = [];
  let faces: AppFaces;
  try {
    faces = record ?? (await readAppFaces(repoRoot));
  } catch (error) {
    return [
      `${APP_FACES_PATH} cannot be read (run npm run generate:app-faces): ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (typeof faces.tools.wawoff2 !== 'string') {
    failures.push(`${APP_FACES_PATH} does not record the wawoff2 version`);
  }
  const expected = APP_FACE_FAMILIES.map(({ family, input, output, box }) => ({
    family,
    input,
    output,
    ...box,
  }));
  const actual = faces.families.map(
    ({ family, input, output, unitsPerEm, ascender, descender, lineGap }) => ({
      family,
      input,
      output,
      unitsPerEm,
      ascender,
      descender,
      lineGap,
    }),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${APP_FACES_PATH} families ${JSON.stringify(actual)} differ from the line box of src/i18n/font-metrics.ts and APP_FACE_FAMILIES ${JSON.stringify(expected)}`,
    );
  }

  // fonts/app/hangul/ holds the Hangul faces, which verifyHangulFaces checks.
  const recordedOutputs = new Set(appFaceOutputs(faces).values());
  for (const file of await listRepoFiles(repoRoot, APP_FACES_DIRECTORY)) {
    if (file.startsWith(`${HANGUL_FACES_DIRECTORY}/`)) continue;
    if (!recordedOutputs.has(file)) failures.push(`${file} is not in ${APP_FACES_PATH}`);
  }

  const fontSources = sources ?? (await readFontSources(repoRoot).catch(() => null));
  const keptBytes = new Map<string, FileDigest>();
  for (const family of [fontSources?.inter, fontSources?.notoSansKr]) {
    for (const face of family?.faces ?? []) {
      if (face.shipped) keptBytes.set(`${family?.directory}/${face.file}`, face.shipped);
    }
  }

  for (const family of faces.families) {
    const box: BakedLineBox = family;
    for (const face of family.faces) {
      const inputPath = `${family.input}/${face.file}`;
      const outputPath = `${family.output}/${face.file}`;
      const [input, output] = await Promise.all([
        readOptional(path.join(repoRoot, inputPath)),
        readOptional(path.join(repoRoot, outputPath)),
      ]);
      if (!input || !output) {
        failures.push(`${!input ? inputPath : outputPath} is missing`);
        continue;
      }
      if (!sameDigest(digestOf(input), face.input)) {
        failures.push(`${inputPath} differs from its digest in ${APP_FACES_PATH}`);
        continue;
      }
      const kept = keptBytes.get(inputPath);
      if (kept && !sameDigest(kept, face.input)) {
        failures.push(`${inputPath} is recorded with other bytes in ${FONT_SOURCES_PATH}`);
      }
      if (!sameDigest(digestOf(output), face.output)) {
        failures.push(
          `${outputPath} differs from its digest in ${APP_FACES_PATH} (run npm run generate:app-faces)`,
        );
        continue;
      }
      if (!isWoff2(output)) {
        failures.push(`${outputPath} is not WOFF2`);
        continue;
      }
      const before = await decodeFontBytes(input);
      const after = await decodeFontBytes(output);
      let metrics;
      let inputMetrics;
      try {
        metrics = readLineMetrics(after);
        inputMetrics = readLineMetrics(before);
      } catch (error) {
        failures.push(`${outputPath}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const lineBox = { ascender: box.ascender, descender: box.descender, lineGap: box.lineGap };
      const wanted = {
        unitsPerEm: box.unitsPerEm,
        hhea: lineBox,
        typo: lineBox,
        useTypoMetrics: true,
        winAscent: inputMetrics.winAscent,
        winDescent: inputMetrics.winDescent,
      };
      if (JSON.stringify(metrics) !== JSON.stringify(wanted)) {
        failures.push(
          `${outputPath} holds ${JSON.stringify(metrics)}, not the baked box ${JSON.stringify(wanted)}`,
        );
      }
      if (metrics.winAscent !== family.winAscent || metrics.winDescent !== family.winDescent) {
        failures.push(
          `${outputPath} has win metrics ${metrics.winAscent}/${metrics.winDescent}, the record ${family.winAscent}/${family.winDescent}`,
        );
      }
      if (metrics.winAscent < box.ascender || metrics.winDescent < box.descender) {
        failures.push(`${outputPath}: the win metrics do not hold the baked box`);
      }
      if (!sfntChecksumsValid(after)) failures.push(`${outputPath} has a wrong checksum`);
      const changed = unpatchedDifferences(before, after);
      if (changed.length) {
        failures.push(
          `${outputPath} differs from ${inputPath} beyond the line box: ${changed.join(', ')}`,
        );
      }
    }
  }
  return failures;
}

// ── The Hangul faces: fonts/app/hangul/ and fonts/hangul-faces.json ─

export const HANGUL_FACES_PATH = 'fonts/hangul-faces.json';
/** The directory of the Hangul faces, which verifyHangulFaces owns inside fonts/app/. */
export const HANGUL_FACES_DIRECTORY = `${APP_FACES_DIRECTORY}/hangul`;
/** The file the Hangul faces are cut from. */
export const HANGUL_SOURCE_PATH = 'fonts/PretendardVariable.woff2';
export const HANGUL_SOURCE_LICENSE = 'fonts/PRETENDARD_LICENSE.txt';
/** The faces' own family name: the source's Reserved Font Name may not name a subset. */
export const HANGUL_FAMILY = 'MUSIXQUARE Hangul';
export const HANGUL_POSTSCRIPT_NAME = 'MUSIXQUAREHangul';
/** The name records each face keeps exactly as in the source: copyright, license and license URL. */
export const HANGUL_SOURCE_NAME_IDS: readonly number[] = [0, 13, 14];
/** The tools whose versions the Hangul face record keeps. */
export const HANGUL_TOOLS = ['subset-font', 'harfbuzzjs', 'fontverter', 'wawoff2'] as const;

type CodePointRange = readonly [number, number];
const HANGUL_BLOCKS: readonly CodePointRange[] = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xd7b0, 0xd7ff],
];

/**
 * Hangul by block or by Unicode Script, as the sheet generator cuts it:
 * ㈜ and ㉠ sit outside the Hangul blocks, and so do the halfwidth jamo.
 */
export function isHangul(codePoint: number): boolean {
  return (
    HANGUL_BLOCKS.some(([start, end]) => codePoint >= start && codePoint <= end) ||
    /\p{Script=Hangul}/u.test(String.fromCodePoint(codePoint))
  );
}

export interface HangulFace {
  /** The Noto Sans KR shard number whose Hangul this face draws; 0 for what no shard declares. */
  readonly shard: number;
  readonly file: string;
  /** The face's code points, which are its cmap. */
  readonly unicodeRange: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface HangulFaces {
  readonly note: string;
  readonly tools: Readonly<Record<string, string>>;
  readonly source: {
    readonly file: string;
    /** The source's own version, from its name ID 5. */
    readonly version: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly license: string;
    /** The wght axis the faces keep, as the source's fvar declares it. */
    readonly wght: readonly [number, number];
  };
  readonly partition: string;
  readonly names: { readonly family: string; readonly postscript: string };
  /** The line box the faces hold in hhea and the OS/2 typo metrics: the source's own. */
  readonly box: BakedLineBox;
  readonly directory: string;
  readonly faces: readonly HangulFace[];
}

function readNumberPair(value: unknown, where: string): readonly [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  ) {
    throw new TypeError(`${HANGUL_FACES_PATH}: ${where} must be [min, max]`);
  }
  return [value[0] as number, value[1] as number];
}

export function parseHangulFaces(text: string): HangulFaces {
  const value: unknown = JSON.parse(text);
  const file = HANGUL_FACES_PATH;
  if (
    !isRecord(value) ||
    !isRecord(value.source) ||
    !isRecord(value.names) ||
    !isRecord(value.box) ||
    !Array.isArray(value.faces)
  ) {
    throw new TypeError(`${file} must hold an object with source, names, box and faces`);
  }
  const { source, names, box } = value;
  const count = (record: Record<string, unknown>, key: string, where: string): number => {
    const entry = record[key];
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) {
      throw new TypeError(`${file}: ${where}.${key} must be a whole number`);
    }
    return entry;
  };
  return {
    note: readString(value, 'note', 'root', file),
    tools: readTools(value.tools, file),
    source: {
      file: readString(source, 'file', 'source', file),
      version: readString(source, 'version', 'source', file),
      ...readDigest(source, 'source', file),
      license: readString(source, 'license', 'source', file),
      wght: readNumberPair(source.wght, 'source.wght'),
    },
    partition: readString(value, 'partition', 'root', file),
    names: {
      family: readString(names, 'family', 'names', file),
      postscript: readString(names, 'postscript', 'names', file),
    },
    box: {
      unitsPerEm: count(box, 'unitsPerEm', 'box'),
      ascender: count(box, 'ascender', 'box'),
      descender: count(box, 'descender', 'box'),
      lineGap: count(box, 'lineGap', 'box'),
    },
    directory: readString(value, 'directory', 'root', file),
    faces: value.faces.map((face: unknown, index) => {
      const at = `faces[${index}]`;
      if (!isRecord(face)) throw new TypeError(`${file}: ${at} must be an object`);
      return {
        shard: count(face, 'shard', at),
        file: readString(face, 'file', at, file),
        unicodeRange: readString(face, 'unicodeRange', at, file),
        ...readDigest(face, at, file),
      };
    }),
  };
}

export async function readHangulFaces(repoRoot: string): Promise<HangulFaces> {
  return parseHangulFaces(await readFile(path.join(repoRoot, HANGUL_FACES_PATH), 'utf8'));
}

export async function writeHangulFaces(repoRoot: string, record: HangulFaces): Promise<void> {
  await writeFile(
    path.join(repoRoot, HANGUL_FACES_PATH),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
}

/** The file name of a Hangul face. */
export const hangulFaceFile = (shard: number): string => `hangul.${shard}.woff2`;

/**
 * The Hangul faces' partition of the source's Hangul: one face per Noto Sans
 * KR v40 numbered shard (fonts/font-sources.json) that declares any of it,
 * with the same number, holding the Hangul that shard declares and the source
 * draws; then a face numbered 0 for the Hangul no shard declares (the
 * halfwidth jamo). In shard number order.
 */
export function hangulPartition(
  sourceCodePoints: ReadonlySet<number>,
  sources: FontSources,
): { readonly shard: number; readonly codePoints: readonly number[] }[] {
  const hangul = [...sourceCodePoints].filter(isHangul).sort((left, right) => left - right);
  const assigned = new Set<number>();
  const shards: { shard: number; codePoints: number[] }[] = [];
  for (const face of sources.notoSansKr.faces) {
    if (!/^\d+$/u.test(face.subset)) continue;
    const declared = parseUnicodeRange(face.unicodeRange);
    const codePoints = hangul.filter((codePoint) => declared.has(codePoint));
    if (codePoints.length === 0) continue;
    for (const codePoint of codePoints) {
      if (assigned.has(codePoint)) {
        throw new Error(`U+${hex(codePoint)} is in two Noto Sans KR shards`);
      }
      assigned.add(codePoint);
    }
    shards.push({ shard: Number(face.subset), codePoints });
  }
  const rest = hangul.filter((codePoint) => !assigned.has(codePoint));
  if (rest.length) {
    if (shards.some(({ shard }) => shard === 0)) {
      throw new Error('Noto Sans KR shard 0 declares Hangul, so the rest has no number of its own');
    }
    shards.push({ shard: 0, codePoints: rest });
  }
  return shards.sort((left, right) => left.shard - right.shard);
}

/** Whether two faces hold the same records of one name ID, on every platform and language. */
function sameNameRecords(
  left: readonly SfntNameRecord[],
  right: readonly SfntNameRecord[],
  nameId: number,
): boolean {
  const key = (records: readonly SfntNameRecord[]) =>
    JSON.stringify(
      records
        .filter((record) => record.nameId === nameId)
        .map((record) => [
          record.platformId,
          record.encodingId,
          record.languageId,
          Buffer.from(record.bytes).toString('hex'),
        ]),
    );
  return key(left) === key(right);
}

/**
 * What is wrong with one Hangul face's decoded sfnt, given the source's
 * decoded sfnt and the face's code points: an empty list when its cmap is the
 * code points (Hangul only), it holds the box in hhea and the OS/2 typo
 * metrics with USE_TYPO_METRICS and the source's win metrics, has no MVAR,
 * keeps the wght axis, has no layout feature and valid checksums, no name
 * record names the source's Reserved Font Name, its family is the record's,
 * and its copyright and license records equal the source's.
 */
export async function hangulFaceProblems(
  sfnt: Uint8Array,
  source: Uint8Array,
  codePoints: ReadonlySet<number>,
  record: Pick<HangulFaces, 'box' | 'names' | 'source'>,
): Promise<string[]> {
  const problems: string[] = [];
  const face = await openFontBytes(sfnt);
  const cmap = fontCodePoints(face);
  if (cmap.size !== codePoints.size || [...cmap].some((codePoint) => !codePoints.has(codePoint))) {
    problems.push(`its cmap (${cmap.size} code points) is not its range (${codePoints.size})`);
  }
  const strays = [...cmap].filter((codePoint) => !isHangul(codePoint));
  if (strays.length) {
    problems.push(
      `it maps non-Hangul ${strays
        .slice(0, 4)
        .map((codePoint) => `U+${hex(codePoint)}`)
        .join(', ')}`,
    );
  }
  const metrics = readLineMetrics(sfnt);
  const sourceMetrics = readLineMetrics(source);
  const { unitsPerEm, ascender, descender, lineGap } = record.box;
  const box = { ascender, descender, lineGap };
  const wanted = {
    unitsPerEm,
    hhea: box,
    typo: box,
    useTypoMetrics: true,
    winAscent: sourceMetrics.winAscent,
    winDescent: sourceMetrics.winDescent,
  };
  if (JSON.stringify(metrics) !== JSON.stringify(wanted)) {
    problems.push(`it holds ${JSON.stringify(metrics)}, not ${JSON.stringify(wanted)}`);
  }
  if (sfntTables(sfnt).has('MVAR')) problems.push('it has an MVAR table');
  const wght = face.getAxisInfos().wght;
  const [min, max] = record.source.wght;
  if (wght?.min !== min || wght.max !== max) {
    problems.push(`its wght axis is ${wght?.min}-${wght?.max}, not ${min}-${max}`);
  }
  const features = [...fontLayoutFeatures(face)];
  if (features.length) problems.push(`it keeps layout features: ${features.join(', ')}`);
  if (!sfntChecksumsValid(sfnt)) problems.push('it has a wrong checksum');
  const names = readNameTable(sfnt).records;
  const sourceNames = readNameTable(source).records;
  for (const nameId of HANGUL_SOURCE_NAME_IDS) {
    if (!sameNameRecords(names, sourceNames, nameId)) {
      problems.push(`its name ID ${nameId} differs from the source's`);
    }
  }
  const named = names.filter((entry) => /pretendard/iu.test(nameText(entry) ?? ''));
  if (named.length) {
    problems.push(`name IDs ${named.map(({ nameId }) => nameId).join(', ')} still name Pretendard`);
  }
  const families = names.filter(({ nameId }) => nameId === 1).map(nameText);
  if (!families.length || families.some((family) => family !== record.names.family)) {
    problems.push(`its family name is ${families.join(', ')}, not ${record.names.family}`);
  }
  return problems;
}

/**
 * Check the Hangul faces against fonts/hangul-faces.json without subsetting
 * again (a few seconds): the source has its recorded digest and its OFL text
 * beside it, the record's names, folder, box and partition are the ones of
 * this module and src/i18n/font-metrics.ts, fonts/app/hangul/ holds exactly
 * the recorded files with their digests, and every face passes
 * hangulFaceProblems. `npm run generate:hangul-faces -- --check` also subsets
 * every face again and compares its outlines with the source's.
 */
export async function verifyHangulFaces(
  repoRoot: string,
  record?: HangulFaces,
  sources?: FontSources,
): Promise<string[]> {
  const failures: string[] = [];
  let faces: HangulFaces;
  try {
    faces = record ?? (await readHangulFaces(repoRoot));
  } catch (error) {
    return [
      `${HANGUL_FACES_PATH} cannot be read (run npm run generate:hangul-faces): ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  for (const tool of HANGUL_TOOLS) {
    if (typeof faces.tools[tool] !== 'string') {
      failures.push(`${HANGUL_FACES_PATH} does not record the ${tool} version`);
    }
  }
  const sourceBytes = await readOptional(path.join(repoRoot, HANGUL_SOURCE_PATH));
  if (!sourceBytes) return [...failures, `${HANGUL_SOURCE_PATH} is missing`];
  if (
    faces.source.file !== HANGUL_SOURCE_PATH ||
    !sameDigest(digestOf(sourceBytes), faces.source)
  ) {
    failures.push(`${HANGUL_SOURCE_PATH} differs from its digest in ${HANGUL_FACES_PATH}`);
  }
  const license = await readOptional(path.join(repoRoot, HANGUL_SOURCE_LICENSE));
  if (
    faces.source.license !== HANGUL_SOURCE_LICENSE ||
    !license?.toString('utf8').includes('SIL OPEN FONT LICENSE Version 1.1')
  ) {
    failures.push(`${HANGUL_SOURCE_LICENSE} is missing or is not the OFL 1.1 text`);
  }
  if (
    faces.names.family !== HANGUL_FAMILY ||
    faces.names.postscript !== HANGUL_POSTSCRIPT_NAME ||
    faces.directory !== HANGUL_FACES_DIRECTORY
  ) {
    failures.push(`${HANGUL_FACES_PATH} names another family or folder than font-files.mts`);
  }
  if (JSON.stringify(faces.box) !== JSON.stringify({ ...HANGUL_LINE_BOX })) {
    failures.push(
      `${HANGUL_FACES_PATH} box ${JSON.stringify(faces.box)} is not HANGUL_LINE_BOX of src/i18n/font-metrics.ts`,
    );
  }
  const source = Uint8Array.from(await decodeFontBytes(sourceBytes));
  const fontSources = sources ?? (await readFontSources(repoRoot));
  const partition = hangulPartition(fontCodePoints(await openFontBytes(source)), fontSources);
  const expected = partition.map(({ shard, codePoints }) => ({
    shard,
    file: hangulFaceFile(shard),
    unicodeRange: formatUnicodeRange(codePoints),
  }));
  const actual = faces.faces.map(({ shard, file, unicodeRange }) => ({
    shard,
    file,
    unicodeRange,
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${HANGUL_FACES_PATH} faces are not the partition of the source's Hangul by the Noto Sans KR shards`,
    );
  }

  const listed = new Set(faces.faces.map(({ file }) => `${HANGUL_FACES_DIRECTORY}/${file}`));
  for (const file of await listRepoFiles(repoRoot, HANGUL_FACES_DIRECTORY)) {
    if (!listed.has(file)) failures.push(`${file} is not in ${HANGUL_FACES_PATH}`);
  }
  for (const face of faces.faces) {
    const where = `${HANGUL_FACES_DIRECTORY}/${face.file}`;
    const bytes = await readOptional(path.join(repoRoot, where));
    if (!bytes) {
      failures.push(`${where} is missing`);
      continue;
    }
    if (!sameDigest(digestOf(bytes), face)) {
      failures.push(
        `${where} differs from its digest in ${HANGUL_FACES_PATH} (run npm run generate:hangul-faces)`,
      );
      continue;
    }
    if (!isWoff2(bytes)) {
      failures.push(`${where} is not WOFF2`);
      continue;
    }
    const sfnt = Uint8Array.from(await decodeFontBytes(bytes));
    const problems = await hangulFaceProblems(
      sfnt,
      source,
      parseUnicodeRange(face.unicodeRange),
      faces,
    ).catch((error: unknown) => [error instanceof Error ? error.message : String(error)]);
    failures.push(...problems.map((problem) => `${where}: ${problem}`));
  }
  return failures;
}
