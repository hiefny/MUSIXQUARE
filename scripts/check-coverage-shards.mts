import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read only the top-level references in Vitest 5's flattened blob envelope. */
function reference(table: unknown[], value: unknown): unknown {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/u.test(value)) {
    throw new Error('Invalid Vitest blob reference.');
  }
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index >= table.length) {
    throw new Error('Vitest blob reference is outside its envelope.');
  }
  return table[index];
}

function readReportTests(path: string): string[] {
  const table: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(table) || !Array.isArray(table[0])) {
    throw new Error(`${path} is not a Vitest blob envelope.`);
  }
  const envelope: unknown[] = table[0];
  const files = reference(table, envelope[1]);
  const errors = reference(table, envelope[2]);
  const coverage = reference(table, envelope[3]);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`${path} contains no test files.`);
  }
  if (!Array.isArray(errors) || errors.length !== 0) {
    throw new Error(`${path} contains unhandled test errors.`);
  }
  if (!record(coverage) || Object.keys(coverage).length === 0) {
    throw new Error(`${path} contains no embedded coverage map.`);
  }
  return files.map((entry: unknown) => {
    const file = reference(table, entry);
    if (!record(file)) throw new Error(`${path} contains an invalid test file.`);
    const filepath = reference(table, file.filepath);
    if (typeof filepath !== 'string' || filepath.length === 0) {
      throw new Error(`${path} contains an invalid test path.`);
    }
    return filepath.replaceAll('\\', '/');
  });
}

/** Require every shard, coverage payload, and a disjoint set of test files. */
export function assertCoverageShardReports(directory: string, shardCount = 2): string[] {
  if (!Number.isSafeInteger(shardCount) || shardCount < 2) {
    throw new Error('Coverage merging requires an integer shard count of at least two.');
  }
  const expected = Array.from(
    { length: shardCount },
    (_, index) => `blob-${index + 1}-${shardCount}.json`,
  );
  const actual = readdirSync(directory).sort();
  if (actual.length !== expected.length || expected.some((name) => !actual.includes(name))) {
    throw new Error(
      `Expected exactly ${expected.join(', ')} in ${directory}; found ${actual.join(', ') || 'none'}.`,
    );
  }
  const tests = new Set<string>();
  for (const name of expected) {
    const path = resolve(directory, name);
    const info = statSync(path);
    if (!info.isFile() || info.size === 0)
      throw new Error(`${path} is not a nonempty report file.`);
    for (const test of readReportTests(path)) {
      if (tests.has(test))
        throw new Error(`A test file occurs in multiple coverage shards: ${test}`);
      tests.add(test);
    }
  }
  return expected;
}

function main(): void {
  const [directory = 'test-results/unit-coverage', count = '2', ...extra] = process.argv.slice(2);
  if (extra.length > 0)
    throw new Error('Usage: check-coverage-shards.mts [directory] [shard-count]');
  const reports = assertCoverageShardReports(directory, Number(count));
  console.log(`[coverage-shards] Validated ${reports.length} disjoint test/coverage reports.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) main();
