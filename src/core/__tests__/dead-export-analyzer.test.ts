import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface BindingResult {
  readonly name: string;
  readonly kind: 'value' | 'type';
  readonly sites: ReadonlyArray<{ readonly file: string; readonly name: string }>;
}

interface AnalyzerResult {
  readonly fullyDead: readonly BindingResult[];
  readonly testOnly: readonly BindingResult[];
  readonly selfOnly: readonly BindingResult[];
  readonly live: readonly BindingResult[];
  readonly sanctionedSeams: readonly BindingResult[];
  readonly ignoredDefaultExports: ReadonlyArray<{
    readonly file: string;
    readonly name: 'default';
  }>;
  readonly moduleReachability: {
    readonly total: number;
    readonly reachable: number;
    readonly unreachable: number;
    readonly unreachableFiles: readonly string[];
  };
}

const script = fileURLToPath(new URL('../../../scripts/check-dead-exports.mts', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('./fixtures/dead-export-analyzer/', import.meta.url));
let fixtureAnalysisJson = '';
let fixtureAnalysis!: AnalyzerResult;
let analyzerSubprocessRuns = 0;

function analyzeFixture(): AnalyzerResult {
  return fixtureAnalysis;
}

beforeAll(() => {
  analyzerSubprocessRuns += 1;
  fixtureAnalysisJson = execFileSync('node', [script, '--analyze-json', fixtureRoot], {
    encoding: 'utf8',
  });
  fixtureAnalysis = JSON.parse(fixtureAnalysisJson) as AnalyzerResult;
}, 120_000);

function hasSite(binding: BindingResult, file: string, name: string): boolean {
  return binding.sites.some((site) => site.file === file && site.name === name);
}

describe('Binding-aware dead-export analyzer', () => {
  it('does not let an imported same-name binding keep another module alive', () => {
    const result = analyzeFixture();

    expect(
      result.fullyDead.some((binding) => hasSite(binding, 'src/feature-a.ts', 'collision')),
    ).toBe(true);
    expect(
      result.testOnly.some((binding) => hasSite(binding, 'src/feature-b.ts', 'collision')),
    ).toBe(true);
  });

  it('separates type/value evidence and sanctioned test seams', () => {
    const result = analyzeFixture();
    const testType = result.testOnly.find((binding) => binding.name === 'TestType');

    expect(testType?.kind).toBe('type');
    expect(result.selfOnly.some((binding) => binding.name === 'selfValue')).toBe(true);
    expect(result.sanctionedSeams.some((binding) => binding.name === 'resetForTests')).toBe(true);
  });

  it('reports type, dynamic import, and worker URL module edges without enforcing them', () => {
    const result = analyzeFixture();

    expect(result.moduleReachability).toMatchObject({
      total: 13,
      reachable: 11,
      unreachable: 2,
    });
    expect(result.moduleReachability.unreachableFiles).toEqual(['src/feature-b.ts', 'src/self.ts']);
    expect(
      result.live.some((binding) => binding.name === 'ReachableType' && binding.kind === 'type'),
    ).toBe(true);
  });

  it('resolves namespace imports and coalesces re-export sites by declaration binding', () => {
    const result = analyzeFixture();
    const namespaced = result.live.find((binding) => binding.name === 'namespaced');
    const reexported = result.live.find((binding) => binding.name === 'reexported');

    expect(namespaced?.sites).toEqual([{ file: 'src/namespace.ts', name: 'namespaced' }]);
    expect(reexported?.sites).toEqual([
      { file: 'src/barrel.ts', name: 'reexported' },
      { file: 'src/origin.ts', name: 'reexported' },
    ]);
  });

  it('treats overload declarations as one binding and reports default exports as excluded', () => {
    const result = analyzeFixture();

    expect(result.live.filter((binding) => binding.name === 'overloaded')).toHaveLength(1);
    expect(result.ignoredDefaultExports).toEqual([{ file: 'src/default.ts', name: 'default' }]);
  });

  it('caches one analyzer subprocess and emits canonical binding and reachability order', () => {
    const result = analyzeFixture();

    expect(analyzerSubprocessRuns).toBe(1);
    expect(fixtureAnalysisJson.trim()).toBe(JSON.stringify(result));
    expect(result.fullyDead.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      'value:collision',
    ]);
    expect(result.testOnly.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      'value:collision',
      'type:TestType',
    ]);
    expect(result.selfOnly.map(({ kind, name }) => `${kind}:${name}`)).toEqual(['value:selfValue']);
    expect(result.live.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      'value:used',
      'value:namespaced',
      'value:reexported',
      'value:overloaded',
      'type:ReachableType',
    ]);
    expect(result.sanctionedSeams.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      'value:resetForTests',
    ]);
    expect(result.moduleReachability.unreachableFiles).toEqual(['src/feature-b.ts', 'src/self.ts']);
  });
});
