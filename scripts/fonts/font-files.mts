/**
 * Shared helpers for the app's self-hosted font files and their provenance
 * record, fonts/font-sources.json.
 *
 * The record lists every Inter and Noto Sans KR file the repository ships:
 * the Google URL it came from, Google's unicode-range for it, and the sha256
 * and size of both the downloaded bytes ("source") and the committed bytes
 * ("shipped"). Inter ships the downloaded bytes. Noto Sans KR ships copies
 * without the Korean locl lookup (scripts/fonts/build-noto-kr-nolocl.mts).
 *
 * The record is written only by scripts/fonts/record-font-sources.mts and
 * scripts/fonts/build-noto-kr-nolocl.mts. scripts/check-app-font.mts and the
 * unit tests verify the shipped files against it.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as hb from 'harfbuzzjs';

type DecompressWoff2 = (data: Uint8Array) => Promise<Uint8Array>;

const decompressWoff2 = createRequire(import.meta.url)('wawoff2/decompress.js') as DecompressWoff2;

export const FONT_SOURCES_PATH = 'fonts/font-sources.json';

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

function readString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${FONT_SOURCES_PATH}: ${where}.${key} must be a non-empty string`);
  }
  return value;
}

function readDigest(value: unknown, where: string): FileDigest {
  if (
    !isRecord(value) ||
    typeof value.sha256 !== 'string' ||
    !SHA256_RE.test(value.sha256) ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0
  ) {
    throw new TypeError(`${FONT_SOURCES_PATH}: ${where} must be { sha256, bytes }`);
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

function readTools(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new TypeError(`${FONT_SOURCES_PATH}: tools must be an object`);
  const tools: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== 'string') {
      throw new TypeError(`${FONT_SOURCES_PATH}: tools.${name} must be a string`);
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

// The WOFF2 decoder shares one WebAssembly instance and is not reentrant:
// overlapping calls return each other's bytes. Run them one at a time.
let decodeQueue: Promise<unknown> = Promise.resolve();

/** The sfnt (TrueType or CFF) bytes of a WOFF2 file, or the bytes themselves. */
export async function decodeFontBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isWoff2(bytes)) return bytes;
  const decoded = decodeQueue.then(() => decompressWoff2(bytes));
  decodeQueue = decoded.catch(() => undefined);
  return decoded;
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
