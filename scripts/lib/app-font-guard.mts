/**
 * Pure helpers of the app font guard (scripts/check-app-font.mts): HTML and
 * CSS readers for the initial graph and the built font sheets.
 */

import path from 'node:path';

import { parseFontFaceRules } from '../fonts/font-files.mts';

/** The four metric descriptors a face carries, in percent. */
export interface FaceMetricValues {
  readonly sizeAdjust: number;
  readonly ascentOverride: number;
  readonly descentOverride: number;
  readonly lineGapOverride: number;
}

const METRIC_DESCRIPTORS = [
  ['size-adjust', 'sizeAdjust'],
  ['ascent-override', 'ascentOverride'],
  ['descent-override', 'descentOverride'],
  ['line-gap-override', 'lineGapOverride'],
] as const;

function linkTags(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*>/giu)].map((match) => match[0]);
}

function attribute(tag: string, name: string): string | null {
  return new RegExp(`\\b${name}=["']([^"']*)["']`, 'iu').exec(tag)?.[1] ?? null;
}

function hasRelToken(tag: string, token: string): boolean {
  return (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/u).includes(token);
}

/** The href of every font preload in a document, whatever font it names. */
export function fontPreloadHrefs(html: string): string[] {
  return linkTags(html)
    .filter((tag) => hasRelToken(tag, 'preload') && attribute(tag, 'as')?.toLowerCase() === 'font')
    .map((tag) => attribute(tag, 'href'))
    .filter((href): href is string => Boolean(href));
}

/** Every script src and link href of a document, in order: its initial graph. */
export function initialAssetUrls(html: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/<(?:link|script)\b[^>]*>/giu)) {
    const url = /\b(?:href|src)=["']([^"']+)["']/iu.exec(match[0])?.[1];
    if (url) urls.push(url);
  }
  return urls;
}

/** The build-output file of a root-relative URL, or null for any other URL. */
export function localDistAssetPath(distDirectory: string, assetUrl: string): string | null {
  if (!assetUrl.startsWith('/') || assetUrl.startsWith('//')) return null;
  const [rawPathname] = assetUrl.split(/[?#]/u, 1);
  if (rawPathname === undefined) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname).replace(/^\/+/u, '');
  } catch {
    return null;
  }
  if (!pathname || pathname.split('/').includes('..')) return null;
  return path.join(distDirectory, ...pathname.split('/'));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Whether a stylesheet declares an @font-face, for one family when given. */
export function declaresFontFace(css: string, family?: string): boolean {
  if (family === undefined) return /@font-face\s*\{/iu.test(css);
  return new RegExp(
    `@font-face\\s*\\{[^}]*font-family\\s*:\\s*["']?${escapeRegExp(family)}["']?\\s*[;}]`,
    'iu',
  ).test(css);
}

/** Every WOFF2 url() in a stylesheet, as written. */
export function woff2Urls(css: string): string[] {
  return [...css.matchAll(/url\(\s*["']?([^)"']+\.woff2)["']?\s*\)/giu)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

/** A built asset's name without Vite's content hash: 'font-inter-AbC12_-9.css' -> 'font-inter'. */
export function builtAssetStem(file: string): string {
  const name = file.replace(/\\/gu, '/').split('/').pop() ?? file;
  return name.replace(/-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/u, '');
}

/** How a face addresses its file: relative to the source sheet, or root-relative in the build. */
export type FaceUrlForm = 'relative' | 'root';

/**
 * Faces that are not self-hosted the one way the app serves fonts: a single
 * url() of a WOFF2 file with format('woff2'), relative to the sheet in the
 * source and root-relative in the build. A device face (local()), a remote,
 * protocol-relative or data: URL, a second source and a sheet that imports
 * another sheet are reported.
 */
export function faceSourceProblems(css: string, urlForm: FaceUrlForm): string[] {
  const problems: string[] = [];
  if (/@import\b/iu.test(css)) problems.push('the sheet imports another sheet with @import');
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/giu)) {
    const body = match[1] ?? '';
    const family = (/font-family\s*:\s*([^;]+)/iu.exec(body)?.[1] ?? '?')
      .trim()
      .replace(/^(['"])(.*)\1$/su, '$2');
    // A url() may hold a ';' (a data: URL), so the value runs to the first ';' outside one.
    const src = /(?:^|[;{\s])src\s*:\s*((?:[^;()]|\([^)]*\))+)/iu.exec(body)?.[1] ?? '';
    const urls = [...src.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/giu)].map((url) => url[2] ?? '');
    const [url] = urls;
    const where = `${family} ${url ?? '(no url)'}`;
    if (/\blocal\(/iu.test(src)) problems.push(`${where}: names a device face with local()`);
    if (urls.length !== 1) {
      problems.push(`${where}: has ${urls.length} url() sources, not one`);
      continue;
    }
    if (url === undefined) continue;
    if (/^[a-z][a-z\d+.-]*:/iu.test(url) || url.startsWith('//')) {
      problems.push(`${where}: is not a self-hosted file`);
      continue;
    }
    if (urlForm === 'relative' && url.startsWith('/')) {
      problems.push(
        `${where}: is root-relative; a source sheet points at its files relative to itself`,
      );
    }
    if (urlForm === 'root' && !url.startsWith('/')) {
      problems.push(`${where}: is not root-relative in the build`);
    }
    if (!/\.woff2(?:[?#]|$)/iu.test(url)) problems.push(`${where}: is not a WOFF2 file`);
    if (!/format\(\s*(['"]?)woff2\1\s*\)/iu.test(src)) {
      problems.push(`${where}: does not declare format('woff2')`);
    }
  }
  return problems;
}

/** A list of code points, one U+XXXX per line, as scripts/fonts/uncovered-code-points.txt keeps them. */
export interface CodePointList {
  readonly codePoints: readonly number[];
  readonly problems: readonly string[];
}

const hexCodePoint = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Reads a code point list: one U+XXXX (four to six upper-case hex digits) per
 * line, in code point order, with '#' comments and blank lines. A malformed,
 * repeated or unordered line is a problem, never skipped silently.
 */
export function parseCodePointList(text: string): CodePointList {
  const codePoints: number[] = [];
  const problems: string[] = [];
  const seen = new Set<number>();
  let previous = -1;
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.replace(/#.*$/u, '').trim();
    if (!line) continue;
    const where = `line ${index + 1}`;
    const match = /^U\+([0-9A-F]{4,6})$/u.exec(line);
    if (!match?.[1]) {
      problems.push(`${where}: "${line}" is not a U+XXXX code point`);
      continue;
    }
    const codePoint = Number.parseInt(match[1], 16);
    if (seen.has(codePoint)) {
      problems.push(`${where}: ${hexCodePoint(codePoint)} is listed twice`);
      continue;
    }
    if (codePoint < previous) {
      problems.push(
        `${where}: ${hexCodePoint(codePoint)} comes after ${hexCodePoint(previous)}; keep the list in code point order`,
      );
    }
    seen.add(codePoint);
    previous = Math.max(previous, codePoint);
    codePoints.push(codePoint);
  }
  return { codePoints, problems };
}

/** What a coverage check over the app's stacks finds against the recorded gaps. */
export interface StackCoverage {
  /** Per stack, the required characters it draws with no face and the list does not name. */
  readonly unlisted: ReadonlyMap<string, readonly number[]>;
  /** Listed characters that every stack now draws, or that nothing requires any more. */
  readonly stale: readonly number[];
}

/**
 * Checks every stack against the required characters: each one must draw
 * every required character with a self-hosted face, except the listed gaps,
 * and the list must name only characters some stack still misses.
 */
export function stackCoverageGaps(
  stacks: ReadonlyMap<string, readonly string[]>,
  required: Iterable<number>,
  hasFace: (families: readonly string[], codePoint: number) => boolean,
  listed: ReadonlySet<number>,
): StackCoverage {
  const requiredCodePoints = [...new Set(required)].sort((left, right) => left - right);
  const unlisted = new Map<string, number[]>();
  const gaps = new Set<number>();
  for (const [label, families] of stacks) {
    const missing: number[] = [];
    for (const codePoint of requiredCodePoints) {
      if (hasFace(families, codePoint)) continue;
      gaps.add(codePoint);
      if (!listed.has(codePoint)) missing.push(codePoint);
    }
    if (missing.length > 0) unlisted.set(label, missing);
  }
  const stale = [...listed].filter((codePoint) => !gaps.has(codePoint)).sort((a, b) => a - b);
  return { unlisted, stale };
}

/**
 * Faces whose metric descriptors differ from the expected values: the four
 * descriptors for a family with metrics, none for a family mapped to null.
 */
export function faceDescriptorMismatches(
  css: string,
  expected: ReadonlyMap<string, FaceMetricValues | null>,
): string[] {
  const mismatches: string[] = [];
  for (const rule of parseFontFaceRules(css)) {
    const where = `${rule.family} ${rule.file}`;
    if (!expected.has(rule.family)) {
      mismatches.push(`${where}: not an app font family`);
      continue;
    }
    const metrics = expected.get(rule.family) ?? null;
    for (const [descriptor, key] of METRIC_DESCRIPTORS) {
      const actual = rule.declarations.get(descriptor) ?? null;
      const wanted = metrics === null ? null : `${metrics[key]}%`;
      if (actual === wanted) continue;
      mismatches.push(
        `${where}: ${descriptor} is ${actual ?? 'missing'}, not ${wanted ?? 'unset'}`,
      );
    }
  }
  return mismatches;
}
