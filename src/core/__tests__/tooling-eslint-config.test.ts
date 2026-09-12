import { existsSync, readFileSync } from 'node:fs';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfigFile: 'eslint.tooling.config.ts',
});

interface ResolvedLintConfig {
  rules?: Record<string, unknown>;
  languageOptions?: {
    parserOptions?: {
      project?: string | string[];
      tsconfigRootDir?: string;
    };
  };
}

interface TypeScriptConfigShape {
  compilerOptions: {
    lib?: string[];
    types?: string[];
  };
}

function readTypeScriptConfig(path: string): TypeScriptConfigShape {
  return JSON.parse(readFileSync(path, 'utf8')) as TypeScriptConfigShape;
}

describe('tooling ESLint and runtime TypeScript profiles', () => {
  it('keeps Worker, Node, browser, and Service Worker ambient types isolated', () => {
    const worker = readTypeScriptConfig('cloudflare/tsconfig.worker.base.json');
    const node = readTypeScriptConfig('tsconfig.node-scripts.json');
    const browser = readTypeScriptConfig('tsconfig.browser-classic.json');
    const serviceWorker = readTypeScriptConfig('tsconfig.service-worker.json');

    expect(worker.compilerOptions.types).toEqual([]);
    expect(worker.compilerOptions.lib).toEqual(['ES2022']);
    expect(node.compilerOptions.types).toEqual(['node']);
    expect(browser.compilerOptions.lib).toContain('DOM');
    expect(browser.compilerOptions.lib).not.toContain('WebWorker');
    expect(serviceWorker.compilerOptions.lib).toContain('WebWorker');
    expect(serviceWorker.compilerOptions.lib).not.toContain('DOM');
  });

  it.each([
    ['browser/classic-runtime/admin.ts', './tsconfig.browser-classic.json', 2],
    [
      'browser/auxiliary-runtime/report-viewer.ts',
      ['./tsconfig.auxiliary-browser.json', './tsconfig.auxiliary-browser-remote.json'],
      2,
    ],
    ['browser/service-worker.ts', './tsconfig.service-worker.json', 2],
    ['browser/ui-kit/app/entry.tsx', './tsconfig.ui-kit.json', 2],
    [
      'cloudflare/app-worker.ts',
      [
        './tsconfig.cloudflare-leaves.json',
        './cloudflare/tsconfig.app.json',
        './cloudflare/tsconfig.pro-room.json',
        './cloudflare/tsconfig.remote-share.json',
        './cloudflare/tsconfig.developer-api.json',
        './cloudflare/tsconfig.developer-api-facade.json',
        './cloudflare/tsconfig.signaling.json',
      ],
      2,
    ],
    ['scripts/check-coverage-shards.mts', './tsconfig.node-scripts.json', 2],
    ['scripts/service-worker-asset.ts', './tsconfig.tooling.json', 2],
    ['.workshop/promo/render.ts', './tsconfig.tooling.json', 2],
    ['.workshop/translate/dev/catalog.ts', './tsconfig.tooling.json', 2],
    ['.workshop/landing/main.ts', './tsconfig.workshop-landing.json', 2],
    ['.workshop/translate/main.ts', './tsconfig.workshop-landing.json', 2],
    ['vite.config.ts', './tsconfig.tooling.json', 2],
    ['vitest.ci-shard.config.ts', './tsconfig.tooling.json', 2],
    ['eslint.tooling.config.ts', './tsconfig.tooling.json', 2],
    ['e2e/release-smoke.test.ts', './tsconfig.e2e.json', 0],
    ['playwright.config.ts', './tsconfig.e2e.json', 2],
  ] as const)('applies the expected type-aware rules to %s', async (file, project, explicitAny) => {
    expect(existsSync(file)).toBe(true);
    // Resolve the actual flat-config cascade without parsing/typechecking every
    // authored file. The CI lint command below owns that whole-scope check.
    const config = (await eslint.calculateConfigForFile(file)) as ResolvedLintConfig | undefined;
    expect(config?.languageOptions?.parserOptions?.project).toEqual(project);
    expect(config?.languageOptions?.parserOptions?.tsconfigRootDir?.replaceAll('\\', '/')).toBe(
      process.cwd().replaceAll('\\', '/'),
    );
    expect(config?.rules?.['@typescript-eslint/no-floating-promises']).toEqual([
      2,
      { ignoreVoid: false },
    ]);
    expect(config?.rules?.['@typescript-eslint/no-misused-promises']).toEqual([2]);
    expect(config?.rules?.['@typescript-eslint/no-unused-vars']).toEqual([
      1,
      { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ]);
    expect(config?.rules?.['@typescript-eslint/no-explicit-any']).toEqual([explicitAny]);
  });

  it('keeps full-scope warning rejection in the tooling lint command', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.lint).toContain('npm run lint:tooling');
    expect(manifest.scripts['lint:tooling']).toBe(
      'eslint --config eslint.tooling.config.ts .workshop browser cloudflare scripts e2e "*.config.ts" "eslint*.config.ts" --ignore-pattern "cloudflare/types/**" --max-warnings=0',
    );
  });
});
