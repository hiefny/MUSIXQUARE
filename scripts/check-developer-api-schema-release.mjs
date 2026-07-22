import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  D1_MIGRATION_MANIFEST_PATH,
  assertD1MigrationManifestAppendOnly,
  assertD1MigrationContract,
  loadD1MigrationManifest,
  trackedD1PathsForDatabase,
} from './check-d1-migration-contract.mjs';

const manifest = loadD1MigrationManifest();
assertD1MigrationContract({ manifest });
const DEVELOPER_API_DATABASE = 'musixquare-developer-api';
const DEVELOPER_API_BASELINE_PATH = 'cloudflare/developer-api.schema.sql';

export const TRACKED_SCHEMA_PATHS = Object.freeze([
  ...trackedD1PathsForDatabase(manifest, DEVELOPER_API_DATABASE),
  'scripts/developer-api-effects-scope-migration.mjs',
]);

export function releaseCommitFromDeployment(deployment) {
  const message = deployment?.annotations?.['workers/message'];
  if (typeof message !== 'string') return null;
  return message.match(/(?:^|\s)git:([0-9a-f]{40})(?:\s|$)/u)?.[1] ?? null;
}

function changedSchemaPaths(previousCommit, currentCommit, trackedPaths, runner = execFileSync) {
  const stdout = runner(
    'git',
    ['diff', '--name-only', previousCommit, currentCommit, '--', ...trackedPaths],
    { encoding: 'utf8' },
  );
  return String(stdout)
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function databaseContract(value, databaseName) {
  if (!Array.isArray(value?.databases)) return null;
  return value.databases.find((entry) => entry?.database === databaseName) ?? null;
}

function previousMigrationManifest(previousCommit, runner) {
  const object = `${previousCommit}:${D1_MIGRATION_MANIFEST_PATH}`;
  try {
    runner('git', ['cat-file', '-e', `${previousCommit}^{commit}`], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`Cannot verify the deployed git commit ${previousCommit}.`, { cause: error });
  }

  let manifestPath;
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

  let stdout;
  try {
    stdout = runner('git', ['show', object], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`Cannot read the deployed commit's D1 migration contract.`, { cause: error });
  }
  try {
    return JSON.parse(String(stdout));
  } catch {
    throw new Error('The deployed commit contains an invalid D1 migration manifest.');
  }
}

function assertBaselineContractChangedFromManifest(previousManifest) {
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

export function assertBaselineContractChanged({ previousCommit, runner = execFileSync }) {
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
  runner = execFileSync,
}) {
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

function main() {
  const [deploymentPath, currentCommit, applyValue] = process.argv.slice(2);
  if (!deploymentPath || !currentCommit || !['true', 'false'].includes(applyValue)) {
    throw new Error(
      'Usage: node scripts/check-developer-api-schema-release.mjs ' +
        '<deployment-status.json> <current-git-sha> <true|false>',
    );
  }
  const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
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
