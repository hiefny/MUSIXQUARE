import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkDeclarationTarget,
  compareRuntimeExports,
  declaredRuntimeNames,
  runDeclarationExportChecks,
  runtimeNameForDeclaration,
  runtimeSourceNames,
} from '../../../scripts/check-script-module-exports.mts';

describe('runtime declaration export guard', () => {
  it('collects named value exports and default exports without treating types as runtime', () => {
    const declared = declaredRuntimeNames(`
      export interface Shape { value: string }
      export type Alias = string;
      export declare const VALUE: string;
      export function parse(value: unknown): string;
      declare const worker: { fetch(): Promise<Response> };
      export default worker;
    `);

    expect([...declared].sort()).toEqual(['VALUE', 'default', 'parse']);
  });

  it('reports stale declarations and undeclared runtime values independently', () => {
    expect(
      compareRuntimeExports(
        'cloudflare/example.d.ts',
        new Set(['declaredOnly', 'shared']),
        new Set(['runtimeOnly', 'shared']),
      ),
    ).toEqual([
      'cloudflare/example.d.ts: stale declaration export declaredOnly',
      'cloudflare/example.d.ts: undeclared runtime export runtimeOnly',
    ]);
  });

  it('reads named, default, and re-exported runtime values without executing a Worker', () => {
    expect(
      [
        ...runtimeSourceNames(`
        export type Shape = { value: string };
        export const VALUE = 1;
        export function parse() {}
        export { shared as renamed } from './shared.js';
        export default { fetch() {} };
      `),
      ].sort(),
    ).toEqual(['VALUE', 'default', 'parse', 'renamed']);
  });

  it('maps both declaration suffixes without relying on a hard-coded directory', () => {
    expect(runtimeNameForDeclaration('worker.d.ts', '.d.ts', '.js')).toBe('worker.js');
    expect(runtimeNameForDeclaration('tool.d.mts', '.d.mts', '.mjs')).toBe('tool.mjs');
    expect(() => runtimeNameForDeclaration('worker.ts', '.d.ts', '.js')).toThrow(
      'expected declaration suffix',
    );
  });

  it('checks only legacy declaration/runtime pairs and ignores native TypeScript owners', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'musixquare-export-pairs-'));
    try {
      writeFileSync(join(directory, 'legacy.d.mts'), 'export declare const VALUE: string;\n');
      writeFileSync(join(directory, 'legacy.mjs'), "export const VALUE = 'legacy';\n");
      writeFileSync(join(directory, 'native.d.mts'), 'export declare const VALUE: string;\n');
      writeFileSync(join(directory, 'native.mts'), "export const VALUE: string = 'native';\n");

      await expect(
        checkDeclarationTarget({
          label: 'fixture',
          directory,
          declarationSuffix: '.d.mts',
          runtimeSuffix: '.mjs',
          nativeSourceSuffix: '.mts',
        }),
      ).resolves.toEqual({ count: 1, failures: [] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps every repository script and Cloudflare declaration aligned with runtime exports', async () => {
    const result = await runDeclarationExportChecks();

    expect(result.failures).toEqual([]);
    expect(result.results).toEqual([
      { label: 'script', count: 0 },
      { label: 'Cloudflare', count: 0 },
    ]);
  });
});
