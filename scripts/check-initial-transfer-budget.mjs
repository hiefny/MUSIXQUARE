#!/usr/bin/env node
/**
 * Ratchet the production app's HTML-declared eager transfer graph.
 *
 * The graph includes index.html plus same-origin script, stylesheet,
 * modulepreload, preload, default-eager images (including responsive picture
 * candidates), video posters, and eager media references emitted into that
 * document. Media is eager when preload is in the HTML automatic state (empty
 * or `auto`) or autoplay overrides the preload hint. Runtime imports, locale
 * shards, diagnostics, and CSS-discovered fonts are excluded.
 * Raw bytes protect low-end parse/compile cost; deterministic level-9 gzip
 * bytes approximate a conservative HTTP transfer encoding in CI.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const INITIAL_TRANSFER_BUDGET = Object.freeze({
  // Controlled onboarding rotation adds pause/resume, visibility, hover,
  // touch, and reduced-motion lifecycle guards across the entry raw/gzip,
  // eager-JS gzip, and eager-total gzip metrics below. Keep that first-screen
  // interaction eager rather than creating an asynchronous initialization seam.
  // Rounded limits retain a small maintenance reserve for harmless follow-up
  // fixes while still rejecting material growth in the eager graph.
  // Bubble copy is also a core keyboard/click/hold action, so it stays in the
  // offline app shell instead of becoming a fallible lazy accessibility seam.
  entryScriptRawBytes: 1_330_000,
  entryScriptGzipBytes: 400_000,
  eagerJavaScriptGzipBytes: 400_000,
  eagerTotalRawBytes: 1_700_000,
  eagerTotalGzipBytes: 460_000,
  eagerFontBytes: 0,
});

const EAGER_LINK_RELATIONS = new Set(['modulepreload', 'preload', 'stylesheet']);
const FONT_EXTENSION = /\.(?:woff2?|ttf|otf)$/iu;
const JAVASCRIPT_EXTENSION = /\.(?:m?js)$/iu;

function attributes(tag) {
  const result = new Map();
  for (const match of tag.matchAll(/\b([\w:-]+)(?:\s*=\s*(?:(["'])(.*?)\2|([^\s"'=<>`]+)))?/gsu)) {
    result.set(match[1].toLowerCase(), match[3] ?? match[4] ?? '');
  }
  return result;
}

function srcsetUrls(value) {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/u, 1)[0])
    .filter(Boolean);
}

export function collectEagerAssetUrls(html) {
  const urls = [];
  let entryScriptUrl = null;

  for (const match of html.matchAll(/<(script|link|source|img|audio|video)\b[^>]*>/giu)) {
    const tagName = match[1].toLowerCase();
    const attrs = attributes(match[0]);

    if (tagName === 'script') {
      const url = attrs.get('src');
      if (!url) continue;
      urls.push(url);
      if ((attrs.get('type') ?? '').toLowerCase() === 'module') {
        if (entryScriptUrl !== null) {
          throw new Error('dist/index.html declares more than one module entry script.');
        }
        entryScriptUrl = url;
      }
      continue;
    }

    if (tagName === 'link') {
      const relations = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
      if (!relations.some((relation) => EAGER_LINK_RELATIONS.has(relation))) continue;
      const url = attrs.get('href');
      if (url) urls.push(url);
      urls.push(...srcsetUrls(attrs.get('imagesrcset') ?? ''));
      continue;
    }

    if (tagName === 'source') {
      // `srcset` belongs to responsive pictures. Counting every candidate is
      // intentionally conservative because CI has no browser viewport/DPR.
      urls.push(...srcsetUrls(attrs.get('srcset') ?? ''));
      continue;
    }

    if (tagName === 'img') {
      if ((attrs.get('loading') ?? '').trim().toLowerCase() === 'lazy') continue;
      const url = attrs.get('src');
      if (url) urls.push(url);
      const candidates = srcsetUrls(attrs.get('srcset') ?? '');
      urls.push(...candidates);
      continue;
    }

    if (tagName === 'video') {
      const poster = attrs.get('poster');
      if (poster) urls.push(poster);
    }

    const preload = attrs.get('preload');
    const hasAutomaticPreload =
      attrs.has('preload') && ['', 'auto'].includes((preload ?? '').trim().toLowerCase());
    if (!attrs.has('autoplay') && !hasAutomaticPreload) continue;
    const url = attrs.get('src');
    if (!url) {
      throw new Error(`Eager ${tagName} media must declare a directly measurable src.`);
    }
    urls.push(url);
  }

  if (entryScriptUrl === null) {
    throw new Error('dist/index.html does not declare a module entry script.');
  }
  return { urls: [...new Set(urls)], entryScriptUrl };
}

function localAssetPath(distDirectory, assetUrl) {
  const trimmedUrl = assetUrl.trim();
  if (/^[a-z][a-z\d+.-]*:/iu.test(trimmedUrl) || trimmedUrl.startsWith('//')) {
    throw new Error(`Cross-origin/data eager asset cannot be budgeted: ${assetUrl}`);
  }
  const parsed = new URL(assetUrl, 'https://musixquare.invalid/');
  if (parsed.origin !== 'https://musixquare.invalid') {
    throw new Error(`Cross-origin/data eager asset cannot be budgeted: ${assetUrl}`);
  }

  const relativePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  if (!relativePath) return null;
  const target = path.resolve(distDirectory, ...relativePath.split('/'));
  const distPrefix = `${path.resolve(distDirectory)}${path.sep}`;
  if (!target.startsWith(distPrefix)) {
    throw new Error(`Eager asset escapes dist/: ${assetUrl}`);
  }
  return target;
}

function gzipBytes(contents) {
  return gzipSync(contents, { level: 9 }).byteLength;
}

export async function measureInitialTransfer(distDirectory = path.join(repoRoot, 'dist')) {
  const htmlPath = path.join(distDirectory, 'index.html');
  const html = await readFile(htmlPath);
  const { urls, entryScriptUrl } = collectEagerAssetUrls(html.toString('utf8'));
  const entries = [
    {
      url: '/index.html',
      file: htmlPath,
      rawBytes: html.byteLength,
      gzipBytes: gzipBytes(html),
    },
  ];

  for (const url of urls) {
    const file = localAssetPath(distDirectory, url);
    if (!file) throw new Error(`Eager asset does not resolve to a file: ${url}`);
    let contents;
    try {
      contents = await readFile(file);
    } catch (error) {
      throw new Error(`Eager asset is missing from dist/: ${url}`, { cause: error });
    }
    entries.push({ url, file, rawBytes: contents.byteLength, gzipBytes: gzipBytes(contents) });
  }

  const entry = entries.find(({ url }) => url === entryScriptUrl);
  if (!entry) throw new Error(`Module entry is not measurable: ${entryScriptUrl}`);

  const javaScriptEntries = entries.filter(({ file }) => JAVASCRIPT_EXTENSION.test(file));
  const fontEntries = entries.filter(({ file }) => FONT_EXTENSION.test(file));

  return {
    entryScriptUrl,
    entryScriptRawBytes: entry.rawBytes,
    entryScriptGzipBytes: entry.gzipBytes,
    eagerJavaScriptGzipBytes: javaScriptEntries.reduce((sum, item) => sum + item.gzipBytes, 0),
    eagerTotalRawBytes: entries.reduce((sum, item) => sum + item.rawBytes, 0),
    eagerTotalGzipBytes: entries.reduce((sum, item) => sum + item.gzipBytes, 0),
    eagerFontBytes: fontEntries.reduce((sum, item) => sum + item.rawBytes, 0),
    entries,
  };
}

export function assertInitialTransferBudget(measurement, budget = INITIAL_TRANSFER_BUDGET) {
  const failures = [];
  for (const [metric, limit] of Object.entries(budget)) {
    const actual = measurement[metric];
    if (!Number.isFinite(actual)) failures.push(`${metric} was not measured`);
    else if (actual > limit) failures.push(`${metric}: ${actual} B > ${limit} B`);
  }
  if (failures.length > 0) {
    throw new Error(
      `Initial transfer budget exceeded:\n${failures.map((line) => `  - ${line}`).join('\n')}`,
    );
  }
}

function kib(value) {
  return `${(value / 1024).toFixed(1)} KiB`;
}

async function main() {
  const measurement = await measureInitialTransfer();
  assertInitialTransferBudget(measurement);
  console.log(
    [
      'Initial transfer budget passed:',
      `entry ${kib(measurement.entryScriptRawBytes)} raw / ${kib(measurement.entryScriptGzipBytes)} gzip`,
      `eager JS ${kib(measurement.eagerJavaScriptGzipBytes)} gzip`,
      `eager total ${kib(measurement.eagerTotalRawBytes)} raw / ${kib(measurement.eagerTotalGzipBytes)} gzip`,
      `eager fonts ${kib(measurement.eagerFontBytes)}`,
    ].join('\n  '),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
