#!/usr/bin/env node
/** Verify every same-origin service-worker app-shell entry exists in the built artifact. */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.resolve(repoRoot, process.argv[2] || 'dist');
const serviceWorkerPath = path.join(distDirectory, 'service-worker.js');
const serviceWorker = await readFile(serviceWorkerPath, 'utf8');
const appShellMatch = /\bconst\s+APP_SHELL\s*=\s*\[([\s\S]*?)\]\s*;/u.exec(serviceWorker);

if (!appShellMatch) {
  console.error('[sw-app-shell-guard] Built service worker does not declare APP_SHELL.');
  process.exit(1);
}

const entries = [...appShellMatch[1].matchAll(/(['"])(.*?)\1/gu)].map((match) => match[2]);
if (entries.length === 0) {
  console.error('[sw-app-shell-guard] Built service worker APP_SHELL is empty.');
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

console.log(`[sw-app-shell-guard] OK: ${entries.length} built app-shell assets verified.`);
