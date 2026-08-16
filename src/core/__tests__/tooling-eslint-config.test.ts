import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfigFile: 'eslint.tooling.config.ts',
});

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

  it('keeps the complete authored tooling scope warning-free', async () => {
    const results = await eslint.lintFiles([
      '.workshop',
      'browser',
      'cloudflare',
      'scripts',
      'e2e',
      '*.config.ts',
      'eslint*.config.ts',
    ]);
    const identities = results.flatMap((result) =>
      result.messages
        .filter(({ severity }) => severity === 1)
        .map((message) => {
          const file = relative(process.cwd(), result.filePath).replaceAll('\\', '/');
          const subject = message.message.match(/^'([^']+)'/u)?.[1] ?? message.message;
          return `${file}|${message.ruleId ?? 'directive'}|${subject}`;
        }),
    );

    expect(identities).toEqual([]);
  }, 60_000);
});
