import { describe, expect, it } from 'vitest';
import {
  compareRuntimeExports,
  declaredRuntimeNames,
  runDeclarationExportChecks,
  runtimeNameForDeclaration,
  runtimeSourceNames,
} from '../../../scripts/check-script-module-exports.mjs';

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

  it('keeps every repository script and Cloudflare declaration aligned with runtime exports', async () => {
    const result = await runDeclarationExportChecks();

    expect(result.failures).toEqual([]);
    expect(result.results.map(({ label }) => label)).toEqual(['script', 'Cloudflare']);
    expect(result.results.every(({ count }) => count > 0)).toBe(true);
  });
});
