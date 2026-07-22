import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TRACKED_SCHEMA_PATHS = Object.freeze([
  'cloudflare/developer-api.schema.sql',
  'cloudflare/developer-api.effects-scopes.migration.sql',
  'cloudflare/developer-api.effects-scopes.rollback.sql',
  'scripts/developer-api-effects-scope-migration.mjs',
]);

export function releaseCommitFromDeployment(deployment) {
  const message = deployment?.annotations?.['workers/message'];
  if (typeof message !== 'string') return null;
  return message.match(/(?:^|\s)git:([0-9a-f]{40})(?:\s|$)/u)?.[1] ?? null;
}

function changedSchemaPaths(previousCommit, currentCommit, runner = execFileSync) {
  const stdout = runner(
    'git',
    ['diff', '--name-only', previousCommit, currentCommit, '--', ...TRACKED_SCHEMA_PATHS],
    { encoding: 'utf8' },
  );
  return String(stdout)
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function assertDeveloperApiSchemaRelease({
  deployment,
  currentCommit,
  applyRequested,
  runner = execFileSync,
}) {
  if (applyRequested) return { previousCommit: releaseCommitFromDeployment(deployment), changed: [] };

  const previousCommit = releaseCommitFromDeployment(deployment);
  if (!previousCommit) {
    throw new Error(
      'The current Developer API deployment has no traceable git SHA. Re-run with ' +
        'Apply Developer API D1 schema and one-time migrations enabled.',
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(currentCommit)) {
    throw new Error('The release commit must be a full lowercase git SHA.');
  }

  const changed = changedSchemaPaths(previousCommit, currentCommit, runner);
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
