import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  analyzeFilePlaybackSemanticCohort,
  collectFilePlaybackRuntimeEdgesForTests,
  normalizeSemanticSource,
  type FilePlaybackSemanticCohortConfiguration,
} from '../../../scripts/lib/file-playback-semantic-cohort-analyzer.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TARGET_EXPORT = 'FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID';
const PLACEHOLDER_DIGEST = 'A'.repeat(43);
const FIXTURE_PREFIX =
  'file-playback;session=v2;route=universal-v1;flac=wasm-1.2.3;' +
  'linear-pcm=worker-v1;mp3=mpg123-4.5.6;adts-aac=webcodecs-v1;' +
  'm4a-aac=webcodecs-v1;semrev=';
const temporaryRoots = new Set<string>();

interface SemanticFixture {
  baselineDigest: string;
  configuration: FilePlaybackSemanticCohortConfiguration;
  declaration: string;
  root: string;
}

function writeFixtureFile(root: string, file: string, text: string): void {
  const absolute = join(root, ...file.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, 'utf8');
}

function declarationSource(cohortId: string): string {
  return `export const ${TARGET_EXPORT} =
  '${cohortId}' as const;

const FILE_PLAYBACK_SEMANTIC_COHORT_MAX_LENGTH = 256;
const SEMANTIC_COHORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+;=:-]*$/u;

export function isFilePlaybackSemanticCohortId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FILE_PLAYBACK_SEMANTIC_COHORT_MAX_LENGTH &&
    SEMANTIC_COHORT_ID_PATTERN.test(value)
  );
}
`;
}

function createSemanticFixture(): SemanticFixture {
  const root = mkdtempSync(join(tmpdir(), 'musixquare-semantic-cohort-'));
  temporaryRoots.add(root);
  const declaration = 'src/player/file-playback-semantic-cohort.ts';
  const configuration: FilePlaybackSemanticCohortConfiguration = {
    bareSupportAllowlist: [],
    cohortDeclaration: declaration,
    cohortExport: TARGET_EXPORT,
    criticalEntryFiles: ['src/core.ts'],
    flacPackageRoot: 'flac-runtime',
    integrationFiles: ['src/app.ts'],
    mp3PackageRoot: 'mp3-runtime',
    packageRoots: ['flac-runtime', 'mp3-runtime'],
    relativeSupportAllowlist: [],
    schema: 's1',
    surfaceFiles: ['src/core.ts', declaration],
  };

  writeFixtureFile(root, 'src/core.ts', 'export const core =\n  1;\n');
  writeFixtureFile(
    root,
    'src/app.ts',
    "import { core } from './core.ts';\nexport const start = () => core;\n",
  );
  writeFixtureFile(
    root,
    declaration,
    declarationSource(`${FIXTURE_PREFIX}s1-${PLACEHOLDER_DIGEST}`),
  );
  writeFixtureFile(
    root,
    'package-lock.json',
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        name: 'semantic-fixture',
        packages: {
          '': { name: 'semantic-fixture', version: '0.0.0' },
          'node_modules/flac-runtime': {
            integrity: 'sha512-flac-fixture',
            version: '1.2.3',
          },
          'node_modules/mp3-runtime': {
            integrity: 'sha512-mp3-fixture',
            version: '4.5.6',
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const unstamped = analyzeFilePlaybackSemanticCohort({ root, configuration });
  expect(unstamped.violations).toEqual([expect.stringContaining('Cohort ID mismatch:')]);
  const declarationText = readFileSync(join(root, ...declaration.split('/')), 'utf8');
  writeFixtureFile(
    root,
    declaration,
    declarationText.replace(`s1-${PLACEHOLDER_DIGEST}`, unstamped.suffix.slice(';semrev='.length)),
  );
  const stamped = analyzeFilePlaybackSemanticCohort({ root, configuration });
  expect(stamped.violations).toEqual([]);
  return { baselineDigest: stamped.digest, configuration, declaration, root };
}

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
  temporaryRoots.clear();
});

describe('universal file-playback semantic cohort guard', () => {
  it('keeps the explicit runtime surface closed and its full digest declared', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/check-file-playback-semantic-cohort.mjs'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      'OK - semantic surface is closed and the cohort suffix matches.',
    );
  });
});

describe('semantic cohort analyzer hardening', () => {
  it('normalizes only a leading BOM and newline encoding, preserving ASI boundaries', () => {
    expect(normalizeSemanticSource('fixture.ts', '\uFEFFreturn value\r\n')).toBe('return value\n');
    expect(normalizeSemanticSource('fixture.ts', 'return value\r')).toBe('return value\n');
    expect(normalizeSemanticSource('fixture.ts', 'return value\n')).not.toBe(
      normalizeSemanticSource('fixture.ts', 'return\nvalue\n'),
    );
    expect(normalizeSemanticSource('fixture.ts', 'const value = 1;\n')).not.toBe(
      normalizeSemanticSource('fixture.ts', 'const value=1;\n'),
    );
  });

  it('produces the same digest for BOM/CRLF and LF source encodings', () => {
    const fixture = createSemanticFixture();
    const core = join(fixture.root, 'src', 'core.ts');
    const lf = readFileSync(core, 'utf8');
    writeFileSync(core, `\uFEFF${lf.replaceAll('\n', '\r\n')}`, 'utf8');

    const result = analyzeFilePlaybackSemanticCohort({
      root: fixture.root,
      configuration: fixture.configuration,
    });

    expect(result.digest).toBe(fixture.baselineDigest);
    expect(result.violations).toEqual([]);
  });

  it.each([
    ['maximum length', '256', '257'],
    ['validator regex', 'A-Za-z0-9._+;=:-', 'A-Za-z0-9._;=:-'],
  ])('hashes declaration %s changes', (_label, before, after) => {
    const fixture = createSemanticFixture();
    const declaration = join(fixture.root, ...fixture.declaration.split('/'));
    writeFileSync(declaration, readFileSync(declaration, 'utf8').replace(before, after), 'utf8');

    const result = analyzeFilePlaybackSemanticCohort({
      root: fixture.root,
      configuration: fixture.configuration,
    });

    expect(result.digest).not.toBe(fixture.baselineDigest);
    expect(result.violations).toContainEqual(expect.stringContaining('Cohort ID mismatch:'));
  });

  it('derives and validates the complete cohort prefix from locked decoder versions', () => {
    const fixture = createSemanticFixture();
    const lockFile = join(fixture.root, 'package-lock.json');
    writeFileSync(
      lockFile,
      readFileSync(lockFile, 'utf8').replace('"version": "1.2.3"', '"version": "9.8.7"'),
      'utf8',
    );

    const result = analyzeFilePlaybackSemanticCohort({
      root: fixture.root,
      configuration: fixture.configuration,
    });

    expect(result.canonicalPrefix).toContain('flac=wasm-9.8.7');
    expect(result.digest).not.toBe(fixture.baselineDigest);
    expect(result.violations).toContainEqual(
      expect.stringContaining('must use the canonical package-derived prefix'),
    );
  });

  it('rejects an edited cohort prefix even though only the semrev payload is masked', () => {
    const fixture = createSemanticFixture();
    const declaration = join(fixture.root, ...fixture.declaration.split('/'));
    writeFileSync(
      declaration,
      readFileSync(declaration, 'utf8').replace('linear-pcm=worker-v1', 'linear-pcm=worker-v2'),
      'utf8',
    );

    const result = analyzeFilePlaybackSemanticCohort({
      root: fixture.root,
      configuration: fixture.configuration,
    });

    expect(result.digest).not.toBe(fixture.baselineDigest);
    expect(result.violations).toContainEqual(
      expect.stringContaining('must use the canonical package-derived prefix'),
    );
  });

  it.each([
    [
      'alias export',
      (id: string) =>
        `const INTERNAL = '${id}' as const;\nexport { INTERNAL as ${TARGET_EXPORT} };\n`,
    ],
    [
      'duplicate direct binding',
      (id: string) =>
        `export const ${TARGET_EXPORT} = '${id}' as const;\nexport const ${TARGET_EXPORT} = '${id}' as const;\n`,
    ],
  ])('rejects a %s instead of one direct export const', (_label, source) => {
    const fixture = createSemanticFixture();
    writeFixtureFile(
      fixture.root,
      fixture.declaration,
      source(`${FIXTURE_PREFIX}s1-${PLACEHOLDER_DIGEST}`),
    );

    const result = analyzeFilePlaybackSemanticCohort({
      root: fixture.root,
      configuration: fixture.configuration,
    });

    expect(result.violations).toContainEqual(
      expect.stringContaining('must contain exactly one direct export const'),
    );
  });

  it.each([
    ["const dep = require('./outside.ts');\nexport { dep };", 'unclassified require'],
    [
      "import dep = require('./outside.ts');\nexport { dep };",
      'unclassified import-equals require',
    ],
    ["importScripts('./outside.ts');\nexport const core = 1;", 'unclassified importScripts asset'],
    ["new Worker('./outside.ts');\nexport const core = 1;", 'direct Worker loader'],
    [
      "audioWorklet.addModule('./outside.ts');\nexport const core = 1;",
      'AudioWorklet addModule loader',
    ],
    ["fetch('./outside.wasm');\nexport const core = 1;", 'fetch asset loader'],
    [
      'WebAssembly.instantiate(bytes);\nexport const core = 1;',
      'direct WebAssembly.instantiate loader',
    ],
    ["const modules = import.meta.glob('./*.ts');\nexport { modules };", 'import.meta.glob loader'],
    [
      "const path = './outside.ts';\nvoid import(path);\nexport const core = 1;",
      'computed dynamic import',
    ],
  ])('fails closed for unclassified loader source: %s', (source, expectedFinding) => {
    const fixture = createSemanticFixture();
    writeFixtureFile(fixture.root, 'src/outside.ts', 'export const outside = 1;\n');
    writeFixtureFile(fixture.root, 'src/core.ts', source);

    const result = analyzeFilePlaybackSemanticCohort({
      root: fixture.root,
      configuration: fixture.configuration,
    });

    expect(result.violations).toContainEqual(expect.stringContaining(expectedFinding));
  });

  it('classifies a literal import.meta worker URL and still closes its asset edge', () => {
    const classified = collectFilePlaybackRuntimeEdgesForTests(
      'src/core.ts',
      "const url = new URL('./worker.ts', import.meta.url);\nnew Worker(url);\n",
    );

    expect(classified.violations).toEqual([]);
    expect(classified.edges).toContainEqual(
      expect.objectContaining({ kind: 'import.meta URL', specifier: './worker.ts' }),
    );
  });

  it.each([
    ['relative path', './core.ts'],
    ['Vite alias', '@/core.ts'],
  ])('rejects a new production reverse caller through a %s', (_label, specifier) => {
    const fixture = createSemanticFixture();
    writeFixtureFile(
      fixture.root,
      'src/outsider.ts',
      `import { core } from '${specifier}';\nexport const outsider = core;\n`,
    );

    const rejected = analyzeFilePlaybackSemanticCohort({
      root: fixture.root,
      configuration: fixture.configuration,
    });
    expect(rejected.violations).toContainEqual(
      expect.stringContaining('unclassified reverse caller of critical entry src/core.ts'),
    );

    const admitted = analyzeFilePlaybackSemanticCohort({
      root: fixture.root,
      configuration: {
        ...fixture.configuration,
        integrationFiles: ['src/app.ts', 'src/outsider.ts'],
      },
    });
    expect(admitted.violations).not.toContainEqual(
      expect.stringContaining('unclassified reverse caller'),
    );
    expect(admitted.digest).not.toBe(fixture.baselineDigest);
  });

  it('rejects a stale integration root that no longer calls a critical entry', () => {
    const fixture = createSemanticFixture();
    writeFixtureFile(fixture.root, 'src/app.ts', 'export const start = () => 1;\n');

    const result = analyzeFilePlaybackSemanticCohort({
      root: fixture.root,
      configuration: fixture.configuration,
    });

    expect(result.violations).toContainEqual(
      expect.stringContaining('Stale semantic integration root has no critical edge: src/app.ts'),
    );
  });

  it('hashes complete integration-root control flow without closing the whole app graph', () => {
    const fixture = createSemanticFixture();
    writeFixtureFile(fixture.root, 'src/support.ts', 'export const support = 2;\n');
    writeFixtureFile(
      fixture.root,
      'src/app.ts',
      "import { core } from './core.ts';\nimport { support } from './support.ts';\nexport const start = () => core + support;\n",
    );

    const result = analyzeFilePlaybackSemanticCohort({
      root: fixture.root,
      configuration: fixture.configuration,
    });

    expect(result.digest).not.toBe(fixture.baselineDigest);
    expect(result.integrationBoundaryEdgeCount).toBe(1);
    expect(result.violations).not.toContainEqual(expect.stringContaining('src/support.ts'));
  });
});
