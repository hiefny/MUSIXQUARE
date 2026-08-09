import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertDurableObjectMigrationContract,
  assertDurableObjectMigrationRepositoryHistory,
} from './check-durable-object-migration-contract.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const PRODUCTION_WRANGLER_CONFIGS = Object.freeze([
  'cloudflare/wrangler.app.toml',
  'cloudflare/wrangler.developer-api-facade.toml',
  'cloudflare/wrangler.developer-api.toml',
  'cloudflare/wrangler.pro-room.toml',
  'cloudflare/wrangler.remote-share.toml',
  'cloudflare/wrangler.signaling.toml',
]);

const CLOUDFLARE_CREDENTIAL_ENV_KEYS = Object.freeze([
  'CF_API_KEY',
  'CF_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_EMAIL',
]);

function parseJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${path}`, { cause: error });
  }
}

function normalizeRepositoryPath(root, path) {
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Worker bundle path escapes the repository: ${path}`);
  }
  return fromRoot.split(sep).join('/');
}

export function discoverProductionWranglerConfigs(root = repositoryRoot) {
  return readdirSync(resolve(root, 'cloudflare'), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^wrangler(?:\..+)?\.toml$/u.test(entry.name) &&
        !/\.example\.toml$/u.test(entry.name),
    )
    .map((entry) => `cloudflare/${entry.name}`)
    .sort();
}

export function assertProductionWranglerConfigCoverage(root = repositoryRoot) {
  const discovered = discoverProductionWranglerConfigs(root);
  const expected = [...PRODUCTION_WRANGLER_CONFIGS].sort();
  if (JSON.stringify(discovered) !== JSON.stringify(expected)) {
    throw new Error(
      [
        'Production Wrangler dry-run coverage is incomplete.',
        `Expected: ${expected.join(', ')}`,
        `Found: ${discovered.join(', ')}`,
        'Update PRODUCTION_WRANGLER_CONFIGS whenever a production Worker config changes.',
      ].join('\n'),
    );
  }
  return expected;
}

export function readPinnedWranglerToolchain(root = repositoryRoot) {
  const packageJson = parseJsonFile(resolve(root, 'package.json'), 'package.json');
  const pinnedVersion = packageJson.devDependencies?.wrangler;
  if (
    typeof pinnedVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(pinnedVersion)
  ) {
    throw new Error('package.json devDependencies.wrangler must be pinned to an exact version.');
  }

  const installedPackagePath = resolve(root, 'node_modules', 'wrangler', 'package.json');
  const installedPackage = parseJsonFile(installedPackagePath, 'the installed Wrangler package');
  if (installedPackage.version !== pinnedVersion) {
    throw new Error(
      `Installed Wrangler ${String(installedPackage.version)} does not match pinned ${pinnedVersion}. Run npm ci.`,
    );
  }
  const binaryPath = installedPackage.bin?.wrangler;
  if (typeof binaryPath !== 'string' || !binaryPath) {
    throw new Error('The pinned Wrangler package does not expose its expected CLI binary.');
  }

  const wranglerRoot = resolve(root, 'node_modules', 'wrangler');
  const binary = resolve(wranglerRoot, binaryPath);
  if (normalizeRepositoryPath(wranglerRoot, binary).startsWith('../') || !existsSync(binary)) {
    throw new Error(`The pinned Wrangler CLI binary is missing: ${binary}`);
  }
  return { version: pinnedVersion, binary };
}

export function workerBundleDryRunArgs(config, outdir) {
  if (!PRODUCTION_WRANGLER_CONFIGS.includes(config)) {
    throw new Error(`Unknown production Wrangler config: ${config}`);
  }
  if (typeof outdir !== 'string' || outdir.length === 0) {
    throw new Error('A temporary Wrangler output directory is required.');
  }
  return ['deploy', '--dry-run', '--config', config, '--outdir', outdir];
}

export function workerBundleDryRunEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  for (const key of CLOUDFLARE_CREDENTIAL_ENV_KEYS) delete sanitized[key];
  sanitized.CI = 'true';
  sanitized.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  sanitized.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  sanitized.NO_COLOR = '1';
  // Hiding the banner also disables Wrangler's npm update check, keeping this
  // compile-only validation entirely off the network.
  sanitized.WRANGLER_HIDE_BANNER = 'true';
  sanitized.WRANGLER_SEND_ERROR_REPORTS = 'false';
  sanitized.WRANGLER_SEND_METRICS = 'false';
  return sanitized;
}

export function runWorkerBundleDryRuns(root = repositoryRoot) {
  const migrationContract = assertDurableObjectMigrationContract({ root });
  const migrationHistory = assertDurableObjectMigrationRepositoryHistory({ root });
  const configs = assertProductionWranglerConfigCoverage(root);
  const { version, binary } = readPinnedWranglerToolchain(root);
  if (!existsSync(resolve(root, 'dist'))) {
    throw new Error(
      'dist/ is required for the App Worker dry-run. Run npm run build:checked first.',
    );
  }

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'musixquare-worker-bundles-'));
  process.stdout.write(
    `[worker-bundles] Wrangler ${version}; validating ${configs.length} production configs, ` +
      `${migrationContract.migrationCount} Durable Object migrations, and ` +
      `${migrationHistory.visibleRevisionCount} committed manifest revisions.\n`,
  );
  try {
    for (const config of configs) {
      const outputName = basename(config, '.toml').replace(/^wrangler\./u, '');
      const outdir = resolve(temporaryRoot, outputName);
      process.stdout.write(`[worker-bundles] dry-run ${config}\n`);
      const result = spawnSync(
        process.execPath,
        [binary, ...workerBundleDryRunArgs(config, outdir)],
        {
          cwd: root,
          env: workerBundleDryRunEnvironment(),
          stdio: 'inherit',
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Wrangler dry-run failed for ${config} (exit ${String(result.status)}).`);
      }
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write('[worker-bundles] OK: every production Worker bundled without deploying.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runWorkerBundleDryRuns();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
