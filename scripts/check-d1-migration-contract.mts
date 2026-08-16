import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const D1_MIGRATION_MANIFEST_PATH = 'cloudflare/d1-migrations.manifest.json';

const CONTRACT_VERSION = 1;
const REVERSIBILITY_VALUES = new Set(['paired', 'forward-only']);
const RECOVERY_STRATEGIES = new Set([
  'paired-sql-before-worker-rollback',
  'roll-forward-or-provider-restore',
  'matched-worker-floor-and-roll-forward-or-provider-restore',
]);

export interface D1RecoveryContract {
  strategy: string;
  runbook: string;
  note: string;
}

export interface D1MigrationContract {
  id: string;
  forward: string;
  forwardSha256: string;
  reversibility: string;
  rollback: string | null;
  rollbackSha256: string | null;
  recovery: D1RecoveryContract;
}

export interface D1DatabaseContract {
  database: string;
  baseline: string;
  baselineRevision: number;
  baselineSha256: string;
  baselineMigration: string | null;
  baselineRecovery: D1RecoveryContract;
  migrations: D1MigrationContract[];
}

export interface D1MigrationManifest {
  schemaVersion: number;
  databases: D1DatabaseContract[];
}

export interface GitRunnerOptions {
  cwd?: string;
  encoding?: BufferEncoding;
}

export type GitRunner = (
  command: string,
  args: string[],
  options?: GitRunnerOptions,
) => string | Buffer;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    keys
      .slice()
      .sort()
      .every((key, index) => key === actual[index])
  );
}

function isRepoPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}

function assertFile(
  root: string,
  path: unknown,
  label: string,
  suffix = '',
): asserts path is string {
  if (!isRepoPath(path) || (suffix && !path.endsWith(suffix))) {
    throw new Error(`${label} must be a repository-relative ${suffix || 'file'} path.`);
  }
  const absolute = resolve(root, path);
  const relativePath = relative(root, absolute);
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || !existsSync(absolute)) {
    throw new Error(`${label} does not exist inside the repository: ${path}`);
  }
}

function sha256File(root: string, path: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(root, path)))
    .digest('hex');
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertFileDigest(root: string, path: string, digest: unknown, label: string): void {
  assertSha256(digest, label);
  if (sha256File(root, path) !== digest) {
    throw new Error(`${label} does not match the checked-in file: ${path}.`);
  }
}

function assertRecovery(root: string, value: unknown, label: string): void {
  if (!hasExactKeys(value, ['strategy', 'runbook', 'note'])) {
    throw new Error(`${label} must contain exactly strategy, runbook, and note.`);
  }
  if (typeof value.strategy !== 'string' || !RECOVERY_STRATEGIES.has(value.strategy)) {
    throw new Error(`${label} has an unsupported recovery strategy: ${value.strategy}`);
  }
  assertFile(root, value.runbook, `${label}.runbook`);
  if (typeof value.note !== 'string' || value.note.trim().length < 24 || value.note.length > 500) {
    throw new Error(`${label}.note must explain the recovery boundary in 24-500 characters.`);
  }
}

function discoverSqlContracts(root: string): {
  baselines: string[];
  forwards: string[];
  rollbacks: string[];
} {
  const directory = resolve(root, 'cloudflare');
  const paths: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) paths.push(relative(root, absolute).split(sep).join('/'));
    }
  };
  visit(directory);
  return {
    baselines: paths.filter((path) => path.endsWith('.schema.sql')),
    forwards: paths.filter((path) => path.endsWith('.migration.sql')),
    rollbacks: paths.filter((path) => path.endsWith('.rollback.sql')),
  };
}

function assertSameInventory(label: string, discovered: string[], declared: string[]): void {
  const expected = [...new Set(discovered)].sort();
  const actual = [...new Set(declared)].sort();
  const missing = expected.filter((path) => !actual.includes(path));
  const stale = actual.filter((path) => !expected.includes(path));
  if (missing.length > 0 || stale.length > 0 || actual.length !== declared.length) {
    throw new Error(
      `${label} inventory mismatch` +
        `${missing.length ? `; unregistered: ${missing.join(', ')}` : ''}` +
        `${stale.length ? `; stale: ${stale.join(', ')}` : ''}` +
        `${actual.length !== declared.length ? '; duplicate manifest path' : ''}.`,
    );
  }
}

export function loadD1MigrationManifest(
  root = resolve(fileURLToPath(new URL('..', import.meta.url))),
): D1MigrationManifest {
  const path = resolve(root, D1_MIGRATION_MANIFEST_PATH);
  return JSON.parse(readFileSync(path, 'utf8')) as D1MigrationManifest;
}

export function assertD1MigrationContract({
  root = resolve(fileURLToPath(new URL('..', import.meta.url))),
  manifest = loadD1MigrationManifest(root),
}: { root?: string; manifest?: D1MigrationManifest } = {}): {
  schemaVersion: number;
  databaseCount: number;
  migrationCount: number;
  pairedMigrationCount: number;
  forwardOnlyMigrationCount: number;
} {
  if (
    !hasExactKeys(manifest, ['schemaVersion', 'databases']) ||
    manifest.schemaVersion !== CONTRACT_VERSION
  ) {
    throw new Error(`D1 migration manifest must use schemaVersion ${CONTRACT_VERSION}.`);
  }
  if (!Array.isArray(manifest.databases) || manifest.databases.length === 0) {
    throw new Error('D1 migration manifest must declare at least one database.');
  }

  const databaseNames = new Set<string>();
  const migrationIds = new Set<string>();
  const baselines: string[] = [];
  const forwards: string[] = [];
  const rollbacks: string[] = [];

  for (const database of manifest.databases) {
    if (
      !hasExactKeys(database, [
        'database',
        'baseline',
        'baselineRevision',
        'baselineSha256',
        'baselineMigration',
        'baselineRecovery',
        'migrations',
      ])
    ) {
      throw new Error(
        'Each D1 database entry must declare the exact baseline and migration contract.',
      );
    }
    if (
      typeof database.database !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(database.database) ||
      databaseNames.has(database.database)
    ) {
      throw new Error(`Invalid or duplicate D1 database name: ${database.database}`);
    }
    databaseNames.add(database.database);
    assertFile(root, database.baseline, `${database.database}.baseline`, '.schema.sql');
    if (!Number.isSafeInteger(database.baselineRevision) || database.baselineRevision < 1) {
      throw new Error(`${database.database}.baselineRevision must be a positive integer.`);
    }
    assertFileDigest(
      root,
      database.baseline,
      database.baselineSha256,
      `${database.database}.baselineSha256`,
    );
    assertRecovery(root, database.baselineRecovery, `${database.database}.baselineRecovery`);
    baselines.push(database.baseline);

    if (!Array.isArray(database.migrations)) {
      throw new Error(`${database.database}.migrations must be an array.`);
    }
    const databaseMigrationIds = new Set<string>();
    for (const migration of database.migrations) {
      if (
        !hasExactKeys(migration, [
          'id',
          'forward',
          'forwardSha256',
          'reversibility',
          'rollback',
          'rollbackSha256',
          'recovery',
        ])
      ) {
        throw new Error(
          `Every migration in ${database.database} must declare the exact migration contract.`,
        );
      }
      if (
        typeof migration.id !== 'string' ||
        !/^[a-z0-9][a-z0-9-]{2,80}$/u.test(migration.id) ||
        migrationIds.has(migration.id)
      ) {
        throw new Error(`Invalid or duplicate D1 migration id: ${migration.id}`);
      }
      migrationIds.add(migration.id);
      databaseMigrationIds.add(migration.id);
      assertFile(root, migration.forward, `${migration.id}.forward`, '.migration.sql');
      assertFileDigest(
        root,
        migration.forward,
        migration.forwardSha256,
        `${migration.id}.forwardSha256`,
      );
      assertRecovery(root, migration.recovery, `${migration.id}.recovery`);
      if (!REVERSIBILITY_VALUES.has(migration.reversibility)) {
        throw new Error(`${migration.id} must explicitly be paired or forward-only.`);
      }

      if (migration.reversibility === 'paired') {
        assertFile(root, migration.rollback, `${migration.id}.rollback`, '.rollback.sql');
        const expectedRollback = migration.forward.replace(/\.migration\.sql$/u, '.rollback.sql');
        if (migration.rollback !== expectedRollback) {
          throw new Error(`${migration.id} rollback must use the matching .rollback.sql path.`);
        }
        assertFileDigest(
          root,
          migration.rollback,
          migration.rollbackSha256,
          `${migration.id}.rollbackSha256`,
        );
        if (migration.recovery.strategy !== 'paired-sql-before-worker-rollback') {
          throw new Error(
            `${migration.id} paired migration must declare paired SQL recovery ordering.`,
          );
        }
        rollbacks.push(migration.rollback);
      } else {
        if (migration.rollback !== null) {
          throw new Error(`${migration.id} forward-only migration must use rollback: null.`);
        }
        if (migration.rollbackSha256 !== null) {
          throw new Error(`${migration.id} forward-only migration must use rollbackSha256: null.`);
        }
        if (migration.recovery.strategy === 'paired-sql-before-worker-rollback') {
          throw new Error(
            `${migration.id} forward-only migration cannot claim paired SQL recovery.`,
          );
        }
      }
      forwards.push(migration.forward);
    }
    if (database.baselineRevision === 1) {
      if (database.baselineMigration !== null) {
        throw new Error(
          `${database.database} baseline revision 1 must use baselineMigration: null.`,
        );
      }
    } else if (
      database.baselineMigration === null ||
      !databaseMigrationIds.has(database.baselineMigration)
    ) {
      throw new Error(
        `${database.database}.baselineMigration must reference a migration in the same database.`,
      );
    }
  }

  const discovered = discoverSqlContracts(root);
  assertSameInventory('D1 baseline', discovered.baselines, baselines);
  assertSameInventory('D1 forward migration', discovered.forwards, forwards);
  assertSameInventory('D1 rollback', discovered.rollbacks, rollbacks);

  return {
    schemaVersion: CONTRACT_VERSION,
    databaseCount: databaseNames.size,
    migrationCount: migrationIds.size,
    pairedMigrationCount: rollbacks.length,
    forwardOnlyMigrationCount: forwards.length - rollbacks.length,
  };
}

function stableJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function assertD1MigrationManifestAppendOnly({
  previousManifest,
  currentManifest,
}: {
  previousManifest: D1MigrationManifest;
  currentManifest: D1MigrationManifest;
}): { previousDatabaseCount: number } {
  if (!previousManifest || !currentManifest) {
    throw new Error('Both previous and current D1 migration manifests are required.');
  }
  const previousDatabases = new Map(
    previousManifest.databases?.map((database) => [database.database, database]) ?? [],
  );
  const currentDatabases = new Map(
    currentManifest.databases?.map((database) => [database.database, database]) ?? [],
  );

  for (const [databaseName, previous] of previousDatabases) {
    const current = currentDatabases.get(databaseName);
    if (!current) throw new Error(`D1 database contract cannot be removed: ${databaseName}.`);
    if (current.baseline !== previous.baseline) {
      throw new Error(`${databaseName} baseline path is immutable.`);
    }
    if (!Array.isArray(previous.migrations) || !Array.isArray(current.migrations)) {
      throw new Error(`${databaseName} has an invalid migration history.`);
    }
    if (current.migrations.length < previous.migrations.length) {
      throw new Error(`${databaseName} migration history cannot be truncated.`);
    }
    for (let index = 0; index < previous.migrations.length; index += 1) {
      if (stableJson(previous.migrations[index]) !== stableJson(current.migrations[index])) {
        throw new Error(
          `${databaseName} migration history is append-only; existing migration ${previous.migrations[index]?.id ?? index} changed.`,
        );
      }
    }

    const baselineChanged = current.baselineSha256 !== previous.baselineSha256;
    if (!baselineChanged) {
      if (
        current.baselineRevision !== previous.baselineRevision ||
        current.baselineMigration !== previous.baselineMigration
      ) {
        throw new Error(`${databaseName} baseline revision changed without new baseline content.`);
      }
      continue;
    }
    if (current.baselineRevision !== previous.baselineRevision + 1) {
      throw new Error(
        `${databaseName} baseline changes must increment baselineRevision by exactly one.`,
      );
    }
    const appended = current.migrations.slice(previous.migrations.length);
    if (!appended.some((migration) => migration.id === current.baselineMigration)) {
      throw new Error(
        `${databaseName} baseline change must reference a newly appended migration in baselineMigration.`,
      );
    }
  }
  return { previousDatabaseCount: previousDatabases.size };
}

function parseHistoricalManifest(raw: string | Buffer, commit: string): D1MigrationManifest {
  try {
    return JSON.parse(String(raw)) as D1MigrationManifest;
  } catch (error) {
    throw new Error(`Commit ${commit} contains an invalid D1 migration manifest.`, {
      cause: error,
    });
  }
}

export function assertD1MigrationRepositoryHistory({
  root = resolve(fileURLToPath(new URL('..', import.meta.url))),
  currentManifest = loadD1MigrationManifest(root),
  runner = execFileSync,
}: {
  root?: string;
  currentManifest?: D1MigrationManifest;
  runner?: GitRunner;
} = {}): { visibleRevisionCount: number } {
  let output;
  try {
    output = runner(
      'git',
      ['log', '--first-parent', '--format=%H', '--reverse', '--', D1_MIGRATION_MANIFEST_PATH],
      { cwd: root, encoding: 'utf8' },
    );
  } catch (error) {
    throw new Error('Cannot inspect the repository D1 migration manifest history.', {
      cause: error,
    });
  }
  const commits = String(output)
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (commits.some((commit) => !/^[0-9a-f]{40}$/u.test(commit))) {
    throw new Error('Git returned an invalid commit while reading D1 migration history.');
  }

  let previousManifest: D1MigrationManifest | null = null;
  for (const commit of commits) {
    let raw;
    try {
      raw = runner('git', ['show', `${commit}:${D1_MIGRATION_MANIFEST_PATH}`], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch (error) {
      throw new Error(`Cannot read the D1 migration manifest from commit ${commit}.`, {
        cause: error,
      });
    }
    const historicalManifest = parseHistoricalManifest(raw, commit);
    if (previousManifest !== null) {
      assertD1MigrationManifestAppendOnly({
        previousManifest,
        currentManifest: historicalManifest,
      });
    }
    previousManifest = historicalManifest;
  }
  if (previousManifest !== null) {
    assertD1MigrationManifestAppendOnly({ previousManifest, currentManifest });
  }
  return { visibleRevisionCount: commits.length };
}

export function trackedD1PathsForDatabase(
  manifest: D1MigrationManifest,
  databaseName: string,
): string[] {
  const database = manifest?.databases?.find((entry) => entry.database === databaseName);
  if (!database) throw new Error(`D1 migration manifest has no database named ${databaseName}.`);
  return [
    database.baseline,
    ...database.migrations.flatMap((migration) =>
      migration.rollback === null ? [migration.forward] : [migration.forward, migration.rollback],
    ),
  ];
}

function main() {
  const result = assertD1MigrationContract();
  const history = assertD1MigrationRepositoryHistory();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result, ...history })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
