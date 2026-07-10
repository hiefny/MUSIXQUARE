#!/usr/bin/env node
/** Ratchet the raw byte size of production JavaScript chunks. */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDirectory = path.join(repoRoot, 'dist', 'assets');
const kib = 1024;
const budgets = [
  { label: 'app-foundation', pattern: /^app-foundation-.*\.js$/, maxBytes: 450 * kib },
  { label: 'main', pattern: /^main-.*\.js$/, maxBytes: 220 * kib },
  { label: 'vendor', pattern: /^vendor-.*\.js$/, maxBytes: 140 * kib },
  { label: 'peerjs', pattern: /^peerjs-.*\.js$/, maxBytes: 140 * kib },
];
const absoluteMaximum = 450 * kib;

const names = (await readdir(assetsDirectory)).filter((name) => name.endsWith('.js'));
const sizes = new Map();
for (const name of names) sizes.set(name, (await stat(path.join(assetsDirectory, name))).size);

const failures = [];
for (const budget of budgets) {
  const matches = names.filter((name) => budget.pattern.test(name));
  if (matches.length !== 1) {
    failures.push(`${budget.label}: expected one chunk, found ${matches.length}`);
    continue;
  }
  const name = matches[0];
  const bytes = sizes.get(name);
  console.log(`${budget.label}: ${(bytes / kib).toFixed(1)} KiB / ${budget.maxBytes / kib} KiB`);
  if (bytes > budget.maxBytes) failures.push(`${name}: ${bytes} > ${budget.maxBytes} bytes`);
}

for (const [name, bytes] of sizes) {
  if (bytes > absoluteMaximum) failures.push(`${name}: ${bytes} > ${absoluteMaximum} byte ceiling`);
}

if (failures.length > 0) {
  console.error(
    `Production JS chunk size guard failed:\n${failures.map((line) => `  - ${line}`).join('\n')}`,
  );
  process.exitCode = 1;
} else {
  console.log(`Production JS chunk sizes are within budget (${names.length} chunks checked).`);
}
