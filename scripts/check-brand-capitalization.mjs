#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const COPY_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.css',
  '.md',
  '.mdx',
  '.mjs',
  '.svg',
  '.ts',
  '.tsx',
  '.webmanifest',
  '.yaml',
  '.yml',
]);
const COPY_ROOTS = ['.workshop/', 'cloudflare/', 'docs/', 'public/', 'scripts/', 'src/'];
const PRODUCT_NAME_PATTERN = /(?<![A-Za-z0-9_])musixquare(?![A-Za-z0-9_])/giu;
const TECHNICAL_ESCAPE = 'brand-capitalization: allow-technical';
const FIXED_LOWERCASE_HYPHEN_TOKEN =
  /^musixquare-(?:abuse-rate(?:-pair)?-v\d+|admin-metrics|api-smoke\.wav|app(?:-used-v\d+)?|auth|control|data|demo-(?:prompt-seen-v\d+|track-read|tracks)|design|developer-api(?:-facade)?|global-(?:admin-announcement|service-control)-v\d+|hero-(?:4k|8k|fhd)-|lang|live-smoke-(?:answer|offer)|ops-drift-audit|optional-(?:v)?|pro-(?:media|room(?:-tab-handoff-v\d+)?)|remote-share(?:-endpoint|-session-actor-v\d+|-upload)?|runtime-|settings-sync|signaling(?:-rate-v\d+)?|soro-images|standard-ws-open-rate-v\d+|static-|theme|ui-sounds-enabled|viz-mode|worker-bundles-|yt-play-latency)(?![A-Za-z0-9_-])/u;

function isTestOrSnapshot(path) {
  return (
    path.includes('/__tests__/') ||
    path.startsWith('e2e/') ||
    /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(path) ||
    path.startsWith('src_ref/')
  );
}

export function isBrandCopySource(path) {
  const normalized = path.replaceAll('\\', '/');
  const extension = extname(normalized).toLowerCase();
  if (normalized === 'scripts/check-brand-capitalization.mjs') return false;
  if (isTestOrSnapshot(normalized)) return false;
  const isRootCopyFile = !normalized.includes('/') && ['.html', '.md', '.mdx'].includes(extension);
  if (
    !isRootCopyFile &&
    !COPY_ROOTS.some((root) => normalized.startsWith(root)) &&
    !normalized.startsWith('css/')
  ) {
    return false;
  }
  return COPY_EXTENSIONS.has(extension);
}

function lineAt(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = source.indexOf('\n', index);
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
}

function isFixedTechnicalSpelling(source, match) {
  const index = match.index ?? 0;
  const spelling = match[0];
  const before = source.slice(Math.max(0, index - 32), index);
  const after = source.slice(index + spelling.length, index + spelling.length + 64);
  const line = lineAt(source, index);

  if (line.includes(TECHNICAL_ESCAPE)) return true;

  // Domains, email addresses, escaped host matchers, and technical dotted names.
  if (/^(?:\\?\.)[a-z0-9]/iu.test(after)) return true;
  if (/@[a-z0-9.-]*$/iu.test(before) && /^(?:\\?\.)[a-z0-9]/iu.test(after)) return true;

  if (spelling === 'musixquare' && FIXED_LOWERCASE_HYPHEN_TOKEN.test(source.slice(index))) {
    return true;
  }

  // Existing protocol headers are fixed mixed-case identifiers, not brand copy.
  if (/X-$/u.test(before) && /^-[A-Za-z0-9]/u.test(after)) return true;

  return false;
}

export function findBrandCapitalizationViolations(path, source) {
  const violations = [];

  for (const match of source.matchAll(PRODUCT_NAME_PATTERN)) {
    if (match[0] === 'MUSIXQUARE' || isFixedTechnicalSpelling(source, match)) continue;
    const line = source.slice(0, match.index).split('\n').length;
    violations.push({
      path,
      line,
      spelling: match[0],
      message: `${path}:${line}: use MUSIXQUARE, found ${JSON.stringify(match[0])}`,
    });
  }

  return violations;
}

export function listBrandCopySources(repository = process.cwd()) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repository,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter(isBrandCopySource)
    .filter((path) => {
      const absolutePath = resolve(repository, path);
      return existsSync(absolutePath) && statSync(absolutePath).isFile();
    });
}

export function checkBrandCapitalization(repository = process.cwd()) {
  return listBrandCopySources(repository).flatMap((path) =>
    findBrandCapitalizationViolations(path, readFileSync(resolve(repository, path), 'utf8')),
  );
}

function runCli() {
  const sources = listBrandCopySources();
  const violations = sources.flatMap((path) =>
    findBrandCapitalizationViolations(path, readFileSync(path, 'utf8')),
  );

  if (violations.length > 0) {
    console.error('[brand-capitalization] FAIL');
    for (const violation of violations) console.error(`- ${violation.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[brand-capitalization] PASS: checked ${sources.length} copy sources.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) runCli();
