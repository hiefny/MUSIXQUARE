import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');
const TYPE_ESCAPE_PATTERN = /\bas any\b|@ts-ignore|@ts-expect-error/;

function listProductionTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === '__tests__') continue;
      files.push(...listProductionTypeScriptFiles(fullPath));
      continue;
    }

    if (entry.endsWith('.ts')) files.push(fullPath);
  }

  return files;
}

function toRepoPath(path: string): string {
  return relative(process.cwd(), path).replace(/\\/g, '/');
}

describe('type escape holdouts', () => {
  it('keeps production TypeScript free of broad type escapes', () => {
    const offenders = listProductionTypeScriptFiles(SRC_ROOT)
      .filter((file) => TYPE_ESCAPE_PATTERN.test(readFileSync(file, 'utf8')))
      .map(toRepoPath)
      .sort();

    expect(offenders).toEqual([]);
  });
});
