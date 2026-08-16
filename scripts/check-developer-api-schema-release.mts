import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  D1_MIGRATION_MANIFEST_PATH,
  assertD1MigrationManifestAppendOnly,
  assertD1MigrationContract,
  loadD1MigrationManifest,
  trackedD1PathsForDatabase,
  type D1DatabaseContract,
  type D1MigrationManifest,
} from './check-d1-migration-contract.mts';

export interface DeveloperApiDeployment {
  annotations?: Record<string, string | undefined>;
}

export type DeveloperApiSchemaGitRunner = (
  command: string,
  args: string[],
  options?: { encoding: 'utf8' },
) => string | Buffer;

export interface DeveloperApiSchemaReleaseResult {
  previousCommit: string | null;
  changed: string[];
}

const manifest = loadD1MigrationManifest();
assertD1MigrationContract({ manifest });
const DEVELOPER_API_DATABASE = 'musixquare-developer-api';
const DEVELOPER_API_BASELINE_PATH = 'cloudflare/developer-api.schema.sql';

export const TRACKED_SCHEMA_PATHS = Object.freeze(
  trackedD1PathsForDatabase(manifest, DEVELOPER_API_DATABASE),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAnnotationRecord(value: unknown): value is Record<string, string | undefined> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => entry === undefined || typeof entry === 'string')
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRecoveryContract(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.strategy === 'string' &&
    typeof value.runbook === 'string' &&
    typeof value.note === 'string'
  );
}

function isMigrationContract(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.forward === 'string' &&
    typeof value.forwardSha256 === 'string' &&
    typeof value.reversibility === 'string' &&
    isNullableString(value.rollback) &&
    isNullableString(value.rollbackSha256) &&
    isRecoveryContract(value.recovery)
  );
}

function isDatabaseContract(value: unknown): value is D1DatabaseContract {
  return (
    isRecord(value) &&
    typeof value.database === 'string' &&
    typeof value.baseline === 'string' &&
    typeof value.baselineRevision === 'number' &&
    typeof value.baselineSha256 === 'string' &&
    isNullableString(value.baselineMigration) &&
    isRecoveryContract(value.baselineRecovery) &&
    Array.isArray(value.migrations) &&
    value.migrations.every(isMigrationContract)
  );
}

function isD1MigrationManifest(value: unknown): value is D1MigrationManifest {
  return (
    isRecord(value) &&
    typeof value.schemaVersion === 'number' &&
    Array.isArray(value.databases) &&
    value.databases.every(isDatabaseContract)
  );
}

const defaultGitRunner: DeveloperApiSchemaGitRunner = (command, args, options) =>
  execFileSync(command, args, { encoding: options?.encoding ?? 'utf8' });

export function releaseCommitFromDeployment(
  deployment: DeveloperApiDeployment | null | undefined,
): string | null {
  const message = deployment?.annotations?.['workers/message'];
  if (typeof message !== 'string') return null;
  return message.match(/(?:^|\s)git:([0-9a-f]{40})(?:\s|$)/u)?.[1] ?? null;
}

function changedSchemaPaths(
  previousCommit: string,
  currentCommit: string,
  trackedPaths: readonly string[],
  runner: DeveloperApiSchemaGitRunner = defaultGitRunner,
): string[] {
  const stdout = runner(
    'git',
    ['diff', '--name-only', previousCommit, currentCommit, '--', ...trackedPaths],
    { encoding: 'utf8' },
  );
  return String(stdout)
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry): entry is string => Boolean(entry));
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

function databaseContract(
  value: D1MigrationManifest,
  databaseName: string,
): D1DatabaseContract | null {
  return value.databases.find((entry) => entry?.database === databaseName) ?? null;
}

function previousMigrationManifest(
  previousCommit: string,
  runner: DeveloperApiSchemaGitRunner,
): D1MigrationManifest | null {
  const object = `${previousCommit}:${D1_MIGRATION_MANIFEST_PATH}`;
  try {
    runner('git', ['cat-file', '-e', `${previousCommit}^{commit}`], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`Cannot verify the deployed git commit ${previousCommit}.`, { cause: error });
  }

  let manifestPath: string | Buffer;
  try {
    manifestPath = runner(
      'git',
      ['ls-tree', '--name-only', previousCommit, '--', D1_MIGRATION_MANIFEST_PATH],
      { encoding: 'utf8' },
    );
  } catch (error) {
    throw new Error(`Cannot inspect the deployed commit's D1 migration contract.`, {
      cause: error,
    });
  }
  if (String(manifestPath).trim() !== D1_MIGRATION_MANIFEST_PATH) {
    // The manifest was introduced after legacy deployments. Its first checked-in
    // contract is itself the required recovery metadata for that transition.
    return null;
  }

  let stdout: string | Buffer;
  try {
    stdout = runner('git', ['show', object], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`Cannot read the deployed commit's D1 migration contract.`, { cause: error });
  }
  try {
    const parsed: unknown = JSON.parse(String(stdout));
    if (!isD1MigrationManifest(parsed)) {
      throw new Error('The deployed commit contains an invalid D1 migration manifest.');
    }
    return parsed;
  } catch {
    throw new Error('The deployed commit contains an invalid D1 migration manifest.');
  }
}

function assertBaselineContractChangedFromManifest(previousManifest: D1MigrationManifest | null): {
  adopted: boolean;
} {
  if (previousManifest === null) return { adopted: true };
  const previous = databaseContract(previousManifest, DEVELOPER_API_DATABASE);
  const current = databaseContract(manifest, DEVELOPER_API_DATABASE);
  if (previous === null || stableJson(previous) !== stableJson(current)) {
    return { adopted: previous === null };
  }
  throw new Error(
    'Developer API baseline schema changed without a changed migration/recovery contract in ' +
      `${D1_MIGRATION_MANIFEST_PATH}. Add a paired migration or update the explicit forward-only/baseline recovery boundary.`,
  );
}

export function assertBaselineContractChanged({
  previousCommit,
  runner = defaultGitRunner,
}: {
  previousCommit: string;
  runner?: DeveloperApiSchemaGitRunner;
}): { adopted: boolean } {
  const previousManifest = previousMigrationManifest(previousCommit, runner);
  if (previousManifest !== null) {
    assertD1MigrationManifestAppendOnly({ previousManifest, currentManifest: manifest });
  }
  return assertBaselineContractChangedFromManifest(previousManifest);
}

export function assertDeveloperApiSchemaRelease({
  deployment,
  currentCommit,
  applyRequested,
  runner = defaultGitRunner,
}: {
  deployment: DeveloperApiDeployment;
  currentCommit: string;
  applyRequested: boolean;
  runner?: DeveloperApiSchemaGitRunner;
}): DeveloperApiSchemaReleaseResult {
  const previousCommit = releaseCommitFromDeployment(deployment);
  if (!previousCommit) {
    if (applyRequested) return { previousCommit: null, changed: [] };
    throw new Error(
      'The current Developer API deployment has no traceable git SHA. Re-run with ' +
        'Apply Developer API D1 schema and one-time migrations enabled.',
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(currentCommit)) {
    throw new Error('The release commit must be a full lowercase git SHA.');
  }

  const previousManifest = previousMigrationManifest(previousCommit, runner);
  if (previousManifest !== null) {
    assertD1MigrationManifestAppendOnly({ previousManifest, currentManifest: manifest });
  }
  const previousTrackedPaths =
    previousManifest === null || databaseContract(previousManifest, DEVELOPER_API_DATABASE) === null
      ? []
      : trackedD1PathsForDatabase(previousManifest, DEVELOPER_API_DATABASE);
  const trackedPaths = [...new Set([...TRACKED_SCHEMA_PATHS, ...previousTrackedPaths])].sort();
  const changed = changedSchemaPaths(previousCommit, currentCommit, trackedPaths, runner);
  if (applyRequested) {
    if (changed.includes(DEVELOPER_API_BASELINE_PATH)) {
      assertBaselineContractChangedFromManifest(previousManifest);
    }
    return { previousCommit, changed: [] };
  }
  if (changed.length > 0) {
    throw new Error(
      'Developer API schema or migration files changed since the deployed Worker: ' +
        `${changed.join(', ')}. Enable the D1 migration release option.`,
    );
  }
  return { previousCommit, changed };
}

function main(): void {
  const [deploymentPath, currentCommit, applyValue] = process.argv.slice(2);
  if (!deploymentPath || !currentCommit || (applyValue !== 'true' && applyValue !== 'false')) {
    throw new Error(
      'Usage: node scripts/check-developer-api-schema-release.mts ' +
        '<deployment-status.json> <current-git-sha> <true|false>',
    );
  }
  const parsedDeployment: unknown = JSON.parse(readFileSync(deploymentPath, 'utf8'));
  if (!isRecord(parsedDeployment)) {
    throw new Error('The deployment status must be a JSON object.');
  }
  const annotations = parsedDeployment.annotations;
  if (annotations !== undefined && !isAnnotationRecord(annotations)) {
    throw new Error('The deployment status annotations must contain only string values.');
  }
  const deployment: DeveloperApiDeployment = annotations === undefined ? {} : { annotations };
  const result = assertDeveloperApiSchemaRelease({
    deployment,
    currentCommit,
    applyRequested: applyValue === 'true',
  });
  process.stdout.write(
    `Developer API schema release intent verified from ${result.previousCommit ?? 'explicit override'}.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
