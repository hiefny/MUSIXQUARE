import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import criticalCoverageConfig from '../../../vitest.critical.config.ts';
import toolingCoverageConfig from '../../../vitest.tooling.config.ts';

const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
  engines: Record<string, string>;
  scripts: Record<string, string>;
};
const toolingTsconfig = JSON.parse(readFileSync(resolve('tsconfig.tooling.json'), 'utf8')) as {
  include?: string[];
};
const ciWorkflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');

describe('CI quality and supply-chain gates', () => {
  it('fails both application and tooling lint on the first warning', () => {
    expect(packageJson.scripts['lint:app']).toBe('eslint src/ --max-warnings=0');
    expect(packageJson.scripts['lint:tooling']).toBe(
      'eslint --config eslint.tooling.config.ts .workshop browser cloudflare scripts e2e "*.config.ts" "eslint*.config.ts" --ignore-pattern "cloudflare/types/**" --max-warnings=0',
    );
  });

  it('lints application tests through their dedicated TypeScript profile', () => {
    const appLintConfig = readFileSync(resolve('eslint.config.ts'), 'utf8');
    expect(appLintConfig).toContain("files: ['src/**/__tests__/**/*.{cts,mts,ts,tsx}']");
    expect(appLintConfig).toContain("project: './tsconfig.test.json'");
    expect(appLintConfig).not.toContain("'src/**/__tests__/'");
  });

  it('loads both strict TypeScript ESLint configs through the pinned Node contract', () => {
    expect(packageJson.engines.node).toBe('24.13.1');
    expect(packageJson.devDependencies.eslint).toBe('^10.0.2');
    expect(packageJson.devDependencies.jiti).toBe('2.7.0');
    expect(toolingTsconfig.include).toEqual(
      expect.arrayContaining([
        '.workshop/promo/render.ts',
        'eslint.config.ts',
        'eslint.tooling.config.ts',
      ]),
    );
    expect(toolingTsconfig.include).not.toContain('.workshop/landing/main.ts');
    expect(packageJson.scripts['typecheck:workshop-landing']).toBe(
      'tsc -p tsconfig.workshop-landing.json',
    );
    expect(packageJson.scripts.typecheck).toContain('npm run typecheck:workshop-landing');
    expect(packageJson.scripts['format:tooling']).toContain('".workshop/**/*.{ts,tsx}"');
    expect(packageJson.scripts['format:check:tooling']).toContain('".workshop/**/*.{ts,tsx}"');
    expect(packageJson.scripts['format:tooling']).toContain('"*.{mts,ts,json}"');
    expect(packageJson.scripts['format:check:tooling']).toContain('"*.{mts,ts,json}"');
    expect(packageJson.scripts['format:app']).toBe('prettier --write "src/**/*.{cts,mts,ts,tsx}"');
    expect(packageJson.scripts['format:check:app']).toBe(
      'prettier --check "src/**/*.{cts,mts,ts,tsx}"',
    );
    expect(packageJson.scripts['format:tooling']).not.toContain('js,mjs');
    expect(packageJson.scripts['format:check:tooling']).not.toContain('js,mjs');
  });

  it('keeps the permanent zero-JavaScript guards in checked builds and typechecks', () => {
    expect(packageJson.scripts['guard:authored-js-inventory']).toBe(
      'node scripts/check-authored-js-inventory.mts',
    );
    expect(packageJson.scripts['guard:authored-inline-js']).toBe(
      'node scripts/check-authored-inline-js-inventory.mts',
    );
    expect(packageJson.scripts['guard:typescript-diagnostics']).toBeUndefined();
    expect(packageJson.scripts['guard:declaration-ownership']).toBe(
      'node scripts/check-typescript-declaration-ownership.mts',
    );
    expect(packageJson.scripts['guard:typescript-project-coverage']).toBe(
      'node scripts/check-typescript-project-coverage.mts',
    );
    expect(packageJson.scripts['guard:script-module-exports']).toBeUndefined();
    for (const scriptName of ['build:checked', 'typecheck']) {
      const command = packageJson.scripts[scriptName];
      expect(command).toContain('npm run guard:authored-js-inventory');
      expect(command).toContain('npm run guard:authored-inline-js');
      expect(command).not.toContain('guard:typescript-diagnostics');
      expect(command).toContain('npm run guard:declaration-ownership');
      expect(command).toContain('npm run guard:typescript-project-coverage');
    }
  });

  it('guards and typechecks TS-backed classic browser runtime assets', () => {
    expect(packageJson.scripts['guard:classic-runtime']).toBe(
      'node scripts/check-classic-runtime-assets.mts',
    );
    expect(packageJson.scripts['typecheck:browser-classic']).toBe(
      'tsc -p tsconfig.browser-classic.json',
    );
    for (const scriptName of ['build:checked', 'typecheck']) {
      expect(packageJson.scripts[scriptName]).toContain('npm run guard:classic-runtime');
    }
    expect(packageJson.scripts.typecheck).toContain('npm run typecheck:browser-classic');
    expect(packageJson.scripts['check:public-runtime']).toBeUndefined();
    expect(ciWorkflow).not.toContain('check:public-runtime');
  });

  it('guards and typechecks the TS-backed stable service-worker asset', () => {
    expect(packageJson.scripts['guard:service-worker']).toBe(
      'node scripts/check-service-worker-asset.mts',
    );
    expect(packageJson.scripts['guard:service-worker-build']).toBe(
      'node scripts/check-service-worker-asset.mts --dist',
    );
    expect(packageJson.scripts['typecheck:service-worker']).toBe(
      'tsc -p tsconfig.service-worker.json',
    );
    expect(packageJson.scripts['build:checked']).toContain('npm run guard:service-worker');
    expect(packageJson.scripts['build:checked']).toContain('npm run guard:service-worker-build');
    expect(packageJson.scripts.typecheck).toContain('npm run guard:service-worker');
    expect(packageJson.scripts.typecheck).toContain('npm run typecheck:service-worker');
  });

  it('guards and typechecks the TSX-backed stable UI kit asset', () => {
    expect(packageJson.scripts['guard:ui-kit']).toBe('node scripts/check-ui-kit-asset.mts');
    expect(packageJson.scripts['guard:ui-kit-build']).toBe(
      'node scripts/check-ui-kit-asset.mts --dist',
    );
    expect(packageJson.scripts['typecheck:ui-kit']).toBe('tsc -p tsconfig.ui-kit.json');
    expect(packageJson.scripts['build:checked']).toContain('npm run guard:ui-kit');
    expect(packageJson.scripts['build:checked']).toContain('npm run guard:ui-kit-build');
    expect(packageJson.scripts.typecheck).toContain('npm run guard:ui-kit');
    expect(packageJson.scripts.typecheck).toContain('npm run typecheck:ui-kit');
    expect(packageJson.scripts['format:tooling']).toContain('browser/**/*.{ts,tsx}');
    expect(packageJson.scripts['format:check:tooling']).toContain('browser/**/*.{ts,tsx}');
  });

  it('verifies registry signatures independently of the vulnerability audit', () => {
    expect(packageJson.scripts['security:signatures']).toBe('npm audit signatures');
    expect(ciWorkflow).toContain('run: npm run security:audit');
    expect(ciWorkflow).toContain('run: npm run security:signatures');
  });

  it('keeps production Worker runtime modules inside a dedicated coverage ratchet', () => {
    expect(packageJson.scripts['test:coverage:workers']).toBe(
      'vitest run --coverage --config vitest.workers.config.ts',
    );
    expect(ciWorkflow).toContain('name: Worker runtime coverage');
    expect(ciWorkflow).toContain('run: npm run test:coverage:workers');

    const workerCoverage = readFileSync(resolve('vitest.workers.config.ts'), 'utf8');
    expect(workerCoverage).toContain("include: ['cloudflare/**/*.ts']");
    expect(workerCoverage).not.toContain('{js,ts}');
    expect(workerCoverage).toContain(
      "exclude: ['cloudflare/**/*.d.ts', 'cloudflare/**/*.contract.ts']",
    );
    expect(workerCoverage).toContain("'cloudflare/app-worker.ts'");
    expect(workerCoverage).toContain("'cloudflare/pro-room-worker.ts'");
    expect(workerCoverage).toContain("'cloudflare/signaling-worker.ts'");
  });

  it('keeps extracted PRO playback authority inside the critical coverage ratchet', () => {
    const coverage = criticalCoverageConfig.test?.coverage as {
      include?: string[];
      thresholds?: Record<
        string,
        number | { statements: number; branches: number; functions: number; lines: number }
      >;
    };

    expect(coverage.include).toContain('src/pro-room/playback-controller.ts');
    expect(coverage.thresholds?.['src/pro-room/{runtime,playback-controller}.ts']).toEqual({
      statements: 66,
      branches: 58,
      functions: 69,
      lines: 70,
    });
    expect(coverage.thresholds?.['src/pro-room/playback-controller.ts']).toEqual({
      statements: 80,
      branches: 72,
      functions: 87,
      lines: 85,
    });
  });

  it('keeps high-risk release tooling inside an independent read-only coverage ratchet', () => {
    expect(packageJson.scripts['test:coverage:tooling']).toBe(
      'vitest run --coverage --config vitest.tooling.config.ts',
    );
    const jobStart = ciWorkflow.indexOf('\n  release-tooling-coverage:');
    const jobEnd = ciWorkflow.indexOf('\n  candidate:', jobStart);
    expect(jobStart).toBeGreaterThan(-1);
    expect(jobEnd).toBeGreaterThan(jobStart);
    const job = ciWorkflow.slice(jobStart, jobEnd);
    expect(job).toContain('name: Release tooling coverage');
    expect(job).toContain('fetch-depth: 0');
    expect(job).toContain('run: npm run test:coverage:tooling');
    expect(job).not.toContain('needs:');
    expect(job).not.toContain('environment:');
    expect(job).not.toContain('secrets.');

    expect(toolingCoverageConfig.test?.include).toEqual([
      'src/core/__tests__/d1-migration-contract.test.ts',
      'src/core/__tests__/durable-object-migration-contract.test.ts',
      'src/core/__tests__/emergency-deploy-guard.test.ts',
      'src/core/__tests__/emergency-deploy-orchestrator.test.ts',
      'src/core/__tests__/ops-drift-audit.test.ts',
      'src/core/__tests__/release-deployment-state.test.ts',
      'src/core/__tests__/release-identity.test.ts',
      'src/core/__tests__/release-manifest.test.ts',
      'src/core/__tests__/release-r2-policy-state.test.ts',
      'src/core/__tests__/release-worker-floor-state.test.ts',
    ]);
    const coverage = toolingCoverageConfig.test?.coverage as {
      include?: string[];
      thresholds?: Record<
        string,
        number | { statements: number; branches: number; functions: number; lines: number }
      >;
    };
    const coveredScripts = [
      'scripts/audit-ops-drift.mts',
      'scripts/check-d1-migration-contract.mts',
      'scripts/check-durable-object-migration-contract.mts',
      'scripts/emergency-deploy.mts',
      'scripts/guard-emergency-deploy.mts',
      'scripts/release-deployment-state.mts',
      'scripts/release-identity.mts',
      'scripts/release-manifest.mts',
      'scripts/release-r2-policy-state.mts',
      'scripts/release-worker-floor-state.mts',
    ];
    expect(coverage.include).toEqual(coveredScripts);
    expect(coverage.thresholds).toEqual({
      statements: 74,
      branches: 68,
      functions: 85,
      lines: 75,
      'scripts/audit-ops-drift.mts': {
        statements: 72,
        branches: 71,
        functions: 82,
        lines: 73,
      },
      'scripts/check-d1-migration-contract.mts': {
        statements: 79,
        branches: 74,
        functions: 95,
        lines: 80,
      },
      'scripts/check-durable-object-migration-contract.mts': {
        statements: 80,
        branches: 77,
        functions: 95,
        lines: 82,
      },
      'scripts/emergency-deploy.mts': {
        statements: 81,
        branches: 82,
        functions: 82,
        lines: 81,
      },
      'scripts/guard-emergency-deploy.mts': {
        statements: 70,
        branches: 57,
        functions: 65,
        lines: 72,
      },
      'scripts/release-deployment-state.mts': {
        statements: 70,
        branches: 60,
        functions: 83,
        lines: 71,
      },
      'scripts/release-identity.mts': {
        statements: 77,
        branches: 78,
        functions: 74,
        lines: 80,
      },
      'scripts/release-manifest.mts': {
        statements: 69,
        branches: 68,
        functions: 79,
        lines: 70,
      },
      'scripts/release-r2-policy-state.mts': {
        statements: 74,
        branches: 61,
        functions: 87,
        lines: 75,
      },
      'scripts/release-worker-floor-state.mts': {
        statements: 81,
        branches: 74,
        functions: 83,
        lines: 81,
      },
    });
  });

  it('typechecks every Vitest configuration used by the quality gates', () => {
    expect(toolingTsconfig.include).toEqual(
      expect.arrayContaining([
        'vitest.config.ts',
        'vitest.critical.config.ts',
        'vitest.tooling.config.ts',
        'vitest.workers.config.ts',
      ]),
    );
  });

  it('does not relabel the installed Wrangler version with a CI constant', () => {
    const releaseManifest = readFileSync(resolve('scripts/release-manifest.mts'), 'utf8');
    const releaseWorkflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    expect(ciWorkflow).not.toContain('WRANGLER_VERSION:');
    expect(releaseManifest).toContain('wrangler: installedWranglerVersion()');
    expect(releaseManifest).not.toContain('DEFAULT_WRANGLER_VERSION');
    expect(releaseWorkflow).toContain(
      'wrangler_version="$(node scripts/print-wrangler-version.mts)"',
    );
    expect(releaseWorkflow).not.toContain('node -p');
  });
});
