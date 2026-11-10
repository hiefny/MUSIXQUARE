/**
 * RO-01: the AudioContext owner's one test seam, `ownerSubStepsForTests` in
 * src/audio/context-recovery.ts (Phase 7 7C-4), carries the owner's
 * sub-steps that no public route reproduces, for test files only. No
 * production file but the owner may name it: not in an import specifier, a
 * namespace member read or a dynamic import. Test files are those under a
 * __tests__ folder and *.test.ts or *.spec.ts files, as the dead-export
 * analyzer classifies them (scripts/lib/dead-export-analyzer.mts). Other
 * modules' seams are not this row's: a /ForTests$/ name passes the
 * dead-export check whoever imports it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SEAM = 'ownerSubStepsForTests';
const OWNER = 'src/audio/context-recovery.ts';
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE = /\.(?:ts|tsx|mts|cts)$/u;

const portable = (path: string): string => path.replace(/\\/gu, '/');
const isTestPath = (path: string): boolean =>
  path.includes('/__tests__/') || path.endsWith('.test.ts') || path.endsWith('.spec.ts');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && SOURCE.test(entry.name) ? [portable(relative(REPO, path))] : [];
  });
}

describe("the AudioContext owner's test seam (RO-01, Phase 7 7C-4)", () => {
  it('is declared by the owner and named by no other production file', () => {
    const production = sourceFiles(join(REPO, 'src')).filter((file) => !isTestPath(file));
    const names = new RegExp(`\\b${SEAM}\\b`, 'u');

    expect(production).toContain(OWNER);
    expect(readFileSync(join(REPO, OWNER), 'utf8')).toMatch(
      new RegExp(`^export const ${SEAM} = \\{$`, 'mu'),
    );
    expect(
      production.filter(
        (file) => file !== OWNER && names.test(readFileSync(join(REPO, file), 'utf8')),
      ),
    ).toEqual([]);
  });
});
