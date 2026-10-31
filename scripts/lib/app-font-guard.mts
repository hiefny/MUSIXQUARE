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
