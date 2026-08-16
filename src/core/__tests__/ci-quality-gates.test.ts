import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import criticalCoverageConfig from '../../../vitest.critical.config.ts';
import toolingCoverageConfig from '../../../vitest.tooling.config.ts';

const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
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
      'eslint --config eslint.tooling.config.js cloudflare scripts e2e "public/*.js" "*.config.{js,mjs,ts}" "eslint*.config.js" --max-warnings=0',
    );
  });

  it('lints application tests through their dedicated TypeScript profile', () => {
    const appLintConfig = readFileSync(resolve('eslint.config.js'), 'utf8');
    expect(appLintConfig).toContain("files: ['src/**/__tests__/**/*.ts']");
    expect(appLintConfig).toContain("project: './tsconfig.test.json'");
    expect(appLintConfig).not.toContain("'src/**/__tests__/'");
  });

  it('verifies registry signatures independently of the vulnerability audit', () => {
    expect(packageJson.scripts['security:signatures']).toBe('npm audit signatures');
    expect(ciWorkflow).toContain('run: npm run security:audit');
    expect(ciWorkflow).toContain('run: npm run security:signatures');
  });

  it('keeps production Worker JavaScript inside a dedicated coverage ratchet', () => {
    expect(packageJson.scripts['test:coverage:workers']).toBe(
      'vitest run --coverage --config vitest.workers.config.ts',
    );
    expect(ciWorkflow).toContain('name: Worker runtime coverage');
    expect(ciWorkflow).toContain('run: npm run test:coverage:workers');

    const workerCoverage = readFileSync(resolve('vitest.workers.config.ts'), 'utf8');
    expect(workerCoverage).toContain("include: ['cloudflare/**/*.js']");
    expect(workerCoverage).toContain("'cloudflare/app-worker.js'");
    expect(workerCoverage).toContain("'cloudflare/pro-room-worker.js'");
    expect(workerCoverage).toContain("'cloudflare/signaling-worker.js'");
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
      'scripts/audit-ops-drift.mjs',
      'scripts/check-d1-migration-contract.mjs',
      'scripts/check-durable-object-migration-contract.mjs',
      'scripts/emergency-deploy.mjs',
      'scripts/guard-emergency-deploy.mjs',
      'scripts/release-deployment-state.mjs',
      'scripts/release-identity.mjs',
      'scripts/release-manifest.mjs',
      'scripts/release-r2-policy-state.mjs',
      'scripts/release-worker-floor-state.mjs',
    ];
    expect(coverage.include).toEqual(coveredScripts);
    expect(coverage.thresholds).toEqual({
      statements: 74,
      branches: 68,
      functions: 85,
      lines: 75,
      'scripts/audit-ops-drift.mjs': {
        statements: 72,
        branches: 71,
        functions: 82,
        lines: 73,
      },
      'scripts/check-d1-migration-contract.mjs': {
        statements: 79,
        branches: 74,
        functions: 95,
        lines: 80,
      },
      'scripts/check-durable-object-migration-contract.mjs': {
        statements: 80,
        branches: 77,
        functions: 95,
        lines: 82,
      },
      'scripts/emergency-deploy.mjs': {
        statements: 81,
        branches: 82,
        functions: 82,
        lines: 81,
      },
      'scripts/guard-emergency-deploy.mjs': {
        statements: 70,
        branches: 57,
        functions: 65,
        lines: 72,
      },
      'scripts/release-deployment-state.mjs': {
        statements: 70,
        branches: 60,
        functions: 83,
        lines: 71,
      },
      'scripts/release-identity.mjs': {
        statements: 77,
        branches: 78,
        functions: 74,
        lines: 80,
      },
      'scripts/release-manifest.mjs': {
        statements: 69,
        branches: 68,
        functions: 79,
        lines: 70,
      },
      'scripts/release-r2-policy-state.mjs': {
        statements: 74,
        branches: 61,
        functions: 87,
        lines: 75,
      },
      'scripts/release-worker-floor-state.mjs': {
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
    const releaseManifest = readFileSync(resolve('scripts/release-manifest.mjs'), 'utf8');
    expect(ciWorkflow).not.toContain('WRANGLER_VERSION:');
    expect(releaseManifest).toContain('wrangler: installedWranglerVersion()');
    expect(releaseManifest).not.toContain('DEFAULT_WRANGLER_VERSION');
  });
});
