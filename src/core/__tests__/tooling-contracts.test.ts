import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageManifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  packageManager: string;
  engines: { node: string };
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<
    string,
    {
      version?: string;
      engines?: { node?: string };
      devDependencies?: Record<string, string>;
    }
  >;
};

describe('tooling reproducibility contracts', () => {
  it('uses one exact Node runtime across engines, types, docs, and workflows', () => {
    const nodeVersion = readFileSync('.node-version', 'utf8').trim();
    const nodeMajor = nodeVersion.split('.')[0];

    expect(packageManifest.engines.node).toBe(nodeVersion);
    expect(packageLock.packages[''].engines?.node).toBe(nodeVersion);
    expect(packageManifest.devDependencies['@types/node']).toMatch(new RegExp(`^${nodeMajor}\\.`));
    expect(packageManifest.packageManager).toMatch(/^npm@\d+\.\d+\.\d+$/u);

    for (const workflowPath of [
      '.github/workflows/ci.yml',
      '.github/workflows/e2e.yml',
      '.github/workflows/ops-drift-audit.yml',
      '.github/workflows/release.yml',
    ]) {
      expect(readFileSync(workflowPath, 'utf8'), workflowPath).toContain(
        'node-version-file: .node-version',
      );
    }

    expect(readFileSync('CONTRIBUTING.md', 'utf8')).toContain('same single supported Node runtime');
    expect(readFileSync('README.md', 'utf8')).toContain(`(\`${nodeVersion}\`)`);
  });

  it('typechecks release smoke and Vite/Vitest configuration in CI', () => {
    const toolingConfig = JSON.parse(readFileSync('tsconfig.tooling.json', 'utf8')) as {
      compilerOptions: { types: string[] };
      include: string[];
    };

    expect(toolingConfig.compilerOptions.types).toContain('node');
    expect([...toolingConfig.include].sort()).toEqual(
      [
        'scripts/live-remote-share-smoke.ts',
        'vite.config.ts',
        'vitest.config.ts',
        'vitest.critical.config.ts',
        'vitest.tooling.config.ts',
        'vitest.workers.config.ts',
      ].sort(),
    );
    expect(packageManifest.scripts.typecheck).toContain('tsc -p tsconfig.tooling.json');
  });

  it('runs the report viewer from the exact lockfile dependency', () => {
    expect(packageManifest.scripts['test:report-viewer']).toBe('serve . -p 3333 -s');
    expect(packageManifest.devDependencies.serve).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(packageLock.packages[''].devDependencies?.serve).toBe(
      packageManifest.devDependencies.serve,
    );
    expect(packageLock.packages['node_modules/serve'].version).toBe(
      packageManifest.devDependencies.serve,
    );
  });
});
