import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertCoverageShardReports } from '../../../scripts/check-coverage-shards.mts';
import broadConfig from '../../../vitest.config.ts';
import shardConfig from '../../../vitest.ci-shard.config.ts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scratchRoot = resolve(repositoryRoot, 'scratch');
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(resolve(scratchRoot, 'coverage-shard-contract-'));
  temporaryRoots.push(root);
  return root;
}

function removeFixture(path: string): void {
  const insideScratch = relative(scratchRoot, resolve(path));
  if (!insideScratch || insideScratch === '..' || insideScratch.startsWith(`..${sep}`)) {
    throw new Error(`Refusing to remove a fixture outside ${scratchRoot}`);
  }
  rmSync(path, { recursive: true, force: true });
}

afterAll(() => {
  for (const root of temporaryRoots) removeFixture(root);
});

function blob(testPath: string, withCoverage = true): string {
  // The production reader inspects this envelope; Vitest owns full decoding.
  return JSON.stringify([
    ['1', '2', '3', '4', 1, '5'],
    '5.0.0',
    ['6'],
    [],
    withCoverage ? { '/src/example.ts': '7' } : {},
    {},
    { filepath: '8' },
    { s: { 0: 1 } },
    testPath,
  ]);
}

function reports(): string {
  const root = temporaryRoot();
  writeFileSync(resolve(root, 'blob-1-2.json'), blob('/src/a.test.ts'));
  writeFileSync(resolve(root, 'blob-2-2.json'), blob('/src/b.test.ts'));
  return root;
}

describe('coverage shard artifact contract', () => {
  it('preserves the broad profile while deferring its thresholds only in shard runs', () => {
    expect(shardConfig.test?.include).toEqual(broadConfig.test?.include);
    expect(shardConfig.test?.exclude).toEqual(broadConfig.test?.exclude);
    expect(shardConfig.test?.setupFiles).toEqual(broadConfig.test?.setupFiles);
    expect(shardConfig.test?.coverage?.include).toEqual(broadConfig.test?.coverage?.include);
    expect(shardConfig.test?.coverage?.exclude).toEqual(broadConfig.test?.coverage?.exclude);
    expect(shardConfig.test?.coverage?.thresholds).toBeUndefined();
    expect(broadConfig.test?.coverage?.thresholds).toEqual({
      lines: 81,
      functions: 85,
      branches: 71,
      statements: 78,
    });
  });

  it('accepts the exact pair of nonempty, disjoint coverage reports', () => {
    expect(assertCoverageShardReports(reports())).toEqual(['blob-1-2.json', 'blob-2-2.json']);
  });

  it('rejects a missing sibling rather than merging partial coverage', () => {
    const root = reports();
    rmSync(resolve(root, 'blob-2-2.json'));
    expect(() => assertCoverageShardReports(root)).toThrow('Expected exactly');
  });

  it('rejects stale additional reports', () => {
    const root = reports();
    writeFileSync(resolve(root, 'blob-3-3.json'), blob('/src/stale.test.ts'));
    expect(() => assertCoverageShardReports(root)).toThrow('Expected exactly');
  });

  it.each(['empty', 'invalid-json', 'no-coverage', 'duplicate'] as const)(
    'rejects an %s report before merging',
    (failure) => {
      const root = reports();
      const content = {
        empty: '',
        'invalid-json': '{broken',
        'no-coverage': blob('/src/b.test.ts', false),
        duplicate: blob('/src/a.test.ts'),
      }[failure];
      writeFileSync(resolve(root, 'blob-2-2.json'), content);
      expect(() => assertCoverageShardReports(root)).toThrow();
    },
  );
});

function runVitest(args: string[], cwd: string) {
  return spawnSync(
    process.execPath,
    [resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs'), ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    },
  );
}

interface PreparedFixture {
  mergeRoot: string;
  markerPath: string;
}

function prepareFixture(coverBothBranches: boolean): PreparedFixture {
  const root = temporaryRoot();
  const shardRoot = resolve(root, 'shards');
  const mergeRoot = resolve(root, 'merge-checkout');
  const markerPath = resolve(root, 'executions.txt');
  const artifactDirectory = resolve(mergeRoot, 'blobs');
  mkdirSync(shardRoot);
  mkdirSync(artifactDirectory, { recursive: true });
  const source = 'export function choose(flag: boolean) { return flag ? 1 : 2; }\n';
  writeFileSync(resolve(shardRoot, 'math.ts'), source);
  writeFileSync(resolve(mergeRoot, 'math.ts'), source);
  for (const [name, flag] of [
    ['a', true],
    ['b', !coverBothBranches],
  ] as const) {
    const test = `import { test, expect } from 'vitest';
import { appendFileSync } from 'node:fs';
import { choose } from './math.ts';
test('${name}', () => {
  appendFileSync(${JSON.stringify(markerPath)}, '${name}');
  expect(choose(${flag})).toBe(${flag ? 1 : 2});
});\n`;
    writeFileSync(resolve(shardRoot, `${name}.test.ts`), test);
    writeFileSync(resolve(mergeRoot, `${name}.test.ts`), test);
  }
  const config = (
    filename: string,
  ) => `import base from ${JSON.stringify(resolve(repositoryRoot, filename).replaceAll('\\', '/'))};
export default {
  ...base, root: import.meta.dirname,
  test: {
    ...base.test, setupFiles: [], include: ['*.test.ts'],
    coverage: { ...base.test?.coverage, include: ['math.ts'], exclude: [] }
  }
};\n`;
  writeFileSync(resolve(shardRoot, 'vitest.config.ts'), config('vitest.ci-shard.config.ts'));
  writeFileSync(resolve(mergeRoot, 'vitest.config.ts'), config('vitest.config.ts'));
  for (const shard of [1, 2]) {
    const report = `blob-${shard}-2.json`;
    const result = runVitest(
      [
        'run',
        '--config',
        'vitest.config.ts',
        `--shard=${shard}/2`,
        '--maxWorkers=1',
        `--outputFile.blob=${report}`,
      ],
      shardRoot,
    );
    expect(result.error ?? result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    // Only the declared blob artifact crosses into the fresh checkout.
    copyFileSync(resolve(shardRoot, report), resolve(artifactDirectory, report));
  }
  expect(readFileSync(markerPath, 'utf8').split('').sort()).toEqual(['a', 'b']);
  removeFixture(shardRoot);
  expect(assertCoverageShardReports(artifactDirectory)).toHaveLength(2);
  return { mergeRoot, markerPath };
}

describe('real Vitest coverage-only merge', () => {
  let complete: PreparedFixture;
  let insufficient: PreparedFixture;

  beforeAll(() => {
    complete = prepareFixture(true);
    insufficient = prepareFixture(false);
  }, 90_000);

  it('merges only copied blobs after shard workspaces are removed, without rerunning tests', () => {
    const result = runVitest(
      ['run', '--config', 'vitest.config.ts', '--coverage', '--merge-reports=blobs'],
      complete.mergeRoot,
    );
    expect(result.error ?? result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(complete.markerPath, 'utf8').split('').sort()).toEqual(['a', 'b']);
    expect(readFileSync(resolve(complete.mergeRoot, 'coverage/lcov.info'), 'utf8')).toContain(
      'BRH:2',
    );
  });

  it('fails the unchanged broad threshold on insufficient merged coverage without rerunning tests', () => {
    const result = runVitest(
      ['run', '--config', 'vitest.config.ts', '--coverage', '--merge-reports=blobs'],
      insufficient.mergeRoot,
    );
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/branches \(50%\).*threshold \(71%\)/u);
    expect(readFileSync(insufficient.markerPath, 'utf8').split('').sort()).toEqual(['a', 'b']);
  });
});
