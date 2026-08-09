#!/usr/bin/env node
/** Verify every same-origin service-worker app-shell entry exists in the built artifact. */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectActiveStartupAssets,
  collectRenderedWorkerAssets,
  parseServiceWorkerAppShell,
} from './service-worker-app-shell-guard-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.resolve(repoRoot, process.argv[2] || 'dist');
const serviceWorkerPath = path.join(distDirectory, 'service-worker.js');
const serviceWorker = await readFile(serviceWorkerPath, 'utf8');
let entries;
let buildEntries;
try {
  ({ entries, buildEntries } = parseServiceWorkerAppShell(serviceWorker));
} catch (error) {
  console.error(`[sw-app-shell-guard] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const deploymentOrigin = new URL('https://musixquare.invalid/service-worker.js');
const missing = [];

for (const entry of entries) {
  const url = new URL(entry, deploymentOrigin);
  if (url.origin !== deploymentOrigin.origin) continue;

  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname.replace(/^\/+/u, '');
  const target = path.resolve(distDirectory, ...relativePath.split('/'));
  const relativeTarget = path.relative(distDirectory, target);
  if (
    !relativeTarget ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    missing.push(`${entry} (invalid built path)`);
    continue;
  }

  try {
    if (!(await stat(target)).isFile()) missing.push(`${entry} (not a file)`);
  } catch {
    missing.push(entry);
  }
}

if (missing.length > 0) {
  console.error(
    `[sw-app-shell-guard] APP_SHELL references missing built assets:\n${missing
      .map((entry) => `  - ${entry}`)
      .join('\n')}`,
  );
  process.exit(1);
}

const indexHtml = await readFile(path.join(distDirectory, 'index.html'), 'utf8');
const startupAssets = collectActiveStartupAssets(indexHtml);
const cacheIdentity = (asset) => {
  const url = new URL(asset, deploymentOrigin);
  return `${url.pathname}${url.search}`;
};
const cachedAssets = new Set(entries.map(cacheIdentity));
const uncachedStartupAssets = startupAssets.filter((asset) => {
  const url = new URL(asset, deploymentOrigin);
  return url.origin === deploymentOrigin.origin && !cachedAssets.has(cacheIdentity(asset));
});
if (uncachedStartupAssets.length > 0) {
  console.error(
    `[sw-app-shell-guard] index.html startup assets are absent from the injected manifest:\n${uncachedStartupAssets
      .map((entry) => `  - ${entry}`)
      .join('\n')}`,
  );
  process.exit(1);
}

const renderedWorkerAssets = new Set();
try {
  for (const entry of buildEntries) {
    const url = new URL(entry, deploymentOrigin);
    if (url.origin !== deploymentOrigin.origin || !url.pathname.endsWith('.js')) continue;
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const javascript = await readFile(path.join(distDirectory, ...relativePath.split('/')), 'utf8');
    for (const workerAsset of collectRenderedWorkerAssets(javascript)) {
      renderedWorkerAssets.add(workerAsset);
    }
  }
} catch (error) {
  console.error(
    `[sw-app-shell-guard] Could not inspect rendered startup Worker references: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

if (renderedWorkerAssets.size === 0) {
  console.error('[sw-app-shell-guard] Built app entry has no rendered startup Worker asset.');
  process.exit(1);
}
const uncachedWorkerAssets = [...renderedWorkerAssets].filter(
  (workerAsset) => !cachedAssets.has(cacheIdentity(workerAsset)),
);
if (uncachedWorkerAssets.length > 0) {
  console.error(
    `[sw-app-shell-guard] rendered startup Worker assets are absent from the injected manifest:\n${uncachedWorkerAssets
      .map((entry) => `  - ${entry}`)
      .join('\n')}`,
  );
  process.exit(1);
}

console.log(
  `[sw-app-shell-guard] OK: ${entries.length} app-shell assets verified (${buildEntries.length} injected entry assets, ${renderedWorkerAssets.size} startup Worker assets).`,
);
