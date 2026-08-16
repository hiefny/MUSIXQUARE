import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PRODUCTION_WRANGLER_CONFIGS,
  assertProductionWranglerConfigCoverage,
  readPinnedWranglerToolchain,
  workerBundleDryRunArgs,
  workerBundleDryRunEnvironment,
} from '../../../scripts/check-worker-bundles.mts';

const expectedConfigs = [
  'cloudflare/wrangler.app.toml',
  'cloudflare/wrangler.developer-api-facade.toml',
  'cloudflare/wrangler.developer-api.toml',
  'cloudflare/wrangler.pro-room.toml',
  'cloudflare/wrangler.remote-share.toml',
  'cloudflare/wrangler.signaling.toml',
];

describe('production Worker bundle dry-run contract', () => {
  it('covers every production Wrangler config and excludes examples', () => {
    expect(PRODUCTION_WRANGLER_CONFIGS).toEqual(expectedConfigs);
    expect(assertProductionWranglerConfigCoverage()).toEqual([...expectedConfigs].sort());
    expect(PRODUCTION_WRANGLER_CONFIGS).not.toContain(
      'cloudflare/wrangler.remote-share.example.toml',
    );
  });

  it('uses the exact repository-pinned Wrangler installation', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const packageLock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; devDependencies?: Record<string, string> }>;
    };
    const toolchain = readPinnedWranglerToolchain();

    expect(packageJson.devDependencies.wrangler).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(packageLock.packages['']?.devDependencies?.wrangler).toBe(
      packageJson.devDependencies.wrangler,
    );
    expect(packageLock.packages['node_modules/wrangler']?.version).toBe(toolchain.version);
    expect(toolchain.version).toBe(packageJson.devDependencies.wrangler);
    expect(toolchain.binary.replaceAll('\\', '/')).toMatch(
      /node_modules\/wrangler\/bin\/wrangler\.js$/u,
    );
  });

  it('constructs only local dry-run commands and strips deployment credentials', () => {
    for (const config of PRODUCTION_WRANGLER_CONFIGS) {
      const args = workerBundleDryRunArgs(config, '/tmp/worker-bundle');
      expect(args).toEqual([
        'deploy',
        '--dry-run',
        '--config',
        config,
        '--outdir',
        '/tmp/worker-bundle',
      ]);
      expect(args).not.toContain('--remote');
    }

    const environment = workerBundleDryRunEnvironment({
      CLOUDFLARE_API_TOKEN: 'secret',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      PATH: 'test-path',
    });
    expect(environment.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(environment.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
    expect(environment.PATH).toBe('test-path');
    expect(environment.CI).toBe('true');
    expect(environment.CLOUDFLARE_INCLUDE_PROCESS_ENV).toBe('false');
    expect(environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV).toBe('false');
    expect(environment.WRANGLER_HIDE_BANNER).toBe('true');
    expect(environment.WRANGLER_SEND_ERROR_REPORTS).toBe('false');
    expect(environment.WRANGLER_SEND_METRICS).toBe('false');
  });

  it('runs after the production build in CI and before credentials in release', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const ci = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    const release = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const bundleGuard = readFileSync(resolve('scripts/check-worker-bundles.mts'), 'utf8');

    expect(packageJson.scripts['check:worker-bundles']).toBe(
      'node scripts/check-worker-bundles.mts',
    );
    expect(ci.indexOf('npm run check:worker-bundles')).toBeGreaterThan(
      ci.indexOf('npm run build:checked'),
    );
    expect(release.indexOf('npm run check:worker-bundles')).toBeGreaterThan(
      release.indexOf('npm run release:verify'),
    );
    expect(release.indexOf('npm run check:worker-bundles')).toBeLessThan(
      release.indexOf('npm run --silent wrangler -- whoami'),
    );
    expect(bundleGuard).toContain('assertDurableObjectMigrationContract({ root })');
    expect(bundleGuard).toContain('assertDurableObjectMigrationRepositoryHistory({ root })');
  });
});
