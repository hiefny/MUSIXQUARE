import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import './check-classic-runtime-assets.mts';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const publicRoot = path.join(repoRoot, 'public');

function collectJavaScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(absolutePath);
    }
  }
  return files;
}

const runtimeFiles = collectJavaScriptFiles(publicRoot).sort((left, right) =>
  left.localeCompare(right),
);

for (const runtimeFile of runtimeFiles) {
  const result = spawnSync(process.execPath, ['--check', runtimeFile], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(
  `[public-runtime] OK: ${runtimeFiles.length} legacy public JavaScript file${runtimeFiles.length === 1 ? '' : 's'} passed syntax validation.`,
);
