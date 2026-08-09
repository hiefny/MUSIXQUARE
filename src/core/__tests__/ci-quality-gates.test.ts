import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
      'eslint --config eslint.tooling.config.js cloudflare scripts e2e "*.config.{js,mjs,ts}" "eslint*.config.js" --max-warnings=0',
    );
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

  it('typechecks every Vitest configuration used by the quality gates', () => {
    expect(toolingTsconfig.include).toEqual(
      expect.arrayContaining([
        'vitest.config.ts',
        'vitest.critical.config.ts',
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
