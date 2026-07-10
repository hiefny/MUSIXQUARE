import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const roots = ['src', 'public', 'cloudflare'].map((entry) => resolve(root, entry));
const persistentMediaRoots = ['src/share', 'src/player', 'src/storage'].map((entry) =>
  resolve(root, entry),
);
const extensions = new Set(['.ts', '.js', '.mjs', '.html']);
const forbidden = [
  ['StorageManager.getDirectory', /\bnavigator\s*\.\s*storage\s*\.\s*getDirectory\s*\(/],
  ['FileSystemFileHandle', /\bFileSystemFileHandle\b/],
  ['FileSystemDirectoryHandle', /\bFileSystemDirectoryHandle\b/],
  ['FileSystemSyncAccessHandle', /\bFileSystemSyncAccessHandle\b/],
  ['createSyncAccessHandle', /\bcreateSyncAccessHandle\s*\(/],
  ['IndexedDB', /\b(?:indexedDB\s*(?:\.|\[)|IDBDatabase\b|IDBObjectStore\b)/],
  ['retired temporary-file module', /(?:from\s*|import\s*\()['"][^'"]*\/temp-file(?:\.ts)?['"]/],
];
const persistentMediaForbidden = [
  ['CacheStorage media persistence', /\bcaches\s*\./],
  ['Cache media persistence', /\bCacheStorage\b|\bCache\s*<|\bCache\s*\|/],
];

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await filesBelow(path)));
    else if (entry.isFile() && extensions.has(extname(entry.name))) output.push(path);
  }
  return output;
}

for (const directory of persistentMediaRoots) {
  if (!(await stat(directory)).isDirectory()) continue;
  for (const path of await filesBelow(directory)) {
    const source = await readFile(path, 'utf8');
    for (const [label, pattern] of persistentMediaForbidden) {
      if (pattern.test(source)) violations.push(`${relative(root, path)}: ${label}`);
    }
  }
}

const violations = [];
for (const directory of roots) {
  if (!(await stat(directory)).isDirectory()) continue;
  for (const path of await filesBelow(directory)) {
    const source = await readFile(path, 'utf8');
    for (const [label, pattern] of forbidden) {
      if (pattern.test(source)) violations.push(`${relative(root, path)}: ${label}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Persistent browser-media storage APIs are forbidden in the runtime:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log('No persistent browser-media storage path found.');
}
