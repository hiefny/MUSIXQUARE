import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const { scripts } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const artifactDirectory = 'test-results/unit-coverage';
const artifactPrefix = 'unit-coverage-${{ github.sha }}-${{ github.run_id }}';

function job(id: string): string {
  const source = ciWorkflow.split(new RegExp(`^  ${id}:\\n`, 'm'))[1];
  if (!source) throw new Error(`Missing CI job: ${id}`);
  return source.split(/^ {2}[\w-]+:\n/m)[0]!;
}

function runCommands(source: string): string[] {
  const lines = source.split('\n');
  const commands: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const run = /^ {8}run: (.+)$/.exec(lines[index]!);
    if (!run) continue;
    const value = run[1]!;
    if (value !== '|' && value !== '>-' && value !== '>') {
      commands.push(value);
      continue;
    }
    const body: string[] = [];
    while (lines[index + 1]?.startsWith('          ')) {
      const line = lines[++index]!.trim();
      if (!line.startsWith('#')) body.push(line);
    }
    commands.push(body.join(value === '|' ? '\n' : ' '));
  }
  return commands;
}

// Expand the actual npm graph so a new nested Worker policy check cannot silently
// disappear from CI when the standalone check:workers command gains another leaf.
function expandCommands(source: string, ancestors: string[] = []): string[] {
  return source.split(/\s*&&\s*|\n/u).flatMap((command) => {
    const normalized = command.trim().replace(/\s+/g, ' ');
    const invocation = /^npm (?:run ([\w:-]+)|test)(?: -- (.+))?$/u.exec(normalized);
    if (!invocation) return normalized ? [normalized] : [];
    const script = invocation[1] ?? 'test';
    if (ancestors.includes(script)) throw new Error(`Circular npm script: ${script}`);
    const definition = scripts[script];
    if (!definition) throw new Error(`Missing npm script: ${script}`);
    const withArguments = invocation[2] ? `${definition} ${invocation[2]}` : definition;
    return expandCommands(withArguments, [...ancestors, script]);
  });
}

describe('CI sharding and parallel static gate contracts', () => {
  it('requires explicit success from both independent static lanes under the stable check name', () => {
    const types = job('static-types');
    const style = job('static-style');
    const aggregate = job('static');

    expect(types).toContain('name: Types and source guards');
    expect(types).toContain('fetch-depth: 0');
    expect(runCommands(types)).toContain('npm run typecheck');
    expect(style).toContain('name: Lint and formatting');
    expect(runCommands(style)).toEqual(['corepack npm ci', 'npm run lint', 'npm run format:check']);
    for (const lane of [types, style]) {
      expect(lane).not.toMatch(/^ {4}(?:needs|if):/m);
      expect(lane).not.toContain('continue-on-error:');
    }

    expect(aggregate).toContain('name: Static checks');
    expect(aggregate).toContain('needs: [static-types, static-style]');
    expect(aggregate).toContain('if: always()');
    expect(aggregate).toContain('TYPES_RESULT: ${{ needs.static-types.result }}');
    expect(aggregate).toContain('STYLE_RESULT: ${{ needs.static-style.result }}');
    expect(runCommands(aggregate).flatMap((command) => command.split('\n'))).toEqual([
      'test "$TYPES_RESULT" = success',
      'test "$STYLE_RESULT" = success',
    ]);
    // The default bash -e runner must fail on either assertion, including a
    // cancelled or skipped dependency, instead of reporting a green aggregate.
    expect(aggregate).not.toMatch(/(?:continue-on-error|shell):/u);
  });

  it('retains every Worker compiler and policy leaf without repeating Worker typechecks', () => {
    const commands = runCommands(job('static-types'));
    const executed = commands.flatMap((command) => expandCommands(command));
    const required = new Set(expandCommands('npm run check:workers'));

    expect(commands).not.toContain('npm run check:workers');
    expect(required.size).toBeGreaterThan(0);
    for (const command of required) {
      expect(executed, `Missing Worker check: ${command}`).toContain(command);
      if (/^tsc(?: |$)/u.test(command)) {
        expect(
          executed.filter((candidate) => candidate === command),
          command,
        ).toHaveLength(1);
      }
    }
  });

  it('executes the broad suite once through two coverage-enabled blob shards', () => {
    const shards = job('tests');
    expect(shards).toContain('name: Unit tests (${{ matrix.shard }}/2)');
    expect(shards).toContain('fail-fast: false');
    expect(shards).toMatch(/shard:\n {10}- 1\n {10}- 2\n/u);
    expect(shards).toContain('fetch-depth: 0');
    expect(shards).not.toContain('continue-on-error:');
    expect(runCommands(shards)).toEqual([
      'corepack npm ci',
      'node node_modules/vitest/vitest.mjs run --coverage --config vitest.ci-shard.config.ts ' +
        '--shard=${{ matrix.shard }}/2 ' +
        `--outputFile.blob=${artifactDirectory}/blob-` +
        '${{ matrix.shard }}-2.json',
    ]);
  });

  it('retains complete same-SHA sibling artifacts when only failed shards are rerun', () => {
    const shards = job('tests');
    const merge = job('broad-coverage');
    expect(shards).toContain('uses: actions/upload-artifact@');
    expect(shards).toContain(`name: ${artifactPrefix}-` + '${{ matrix.shard }}');
    expect(shards).toContain(`path: ${artifactDirectory}/`);
    expect(shards).toContain('if-no-files-found: error');
    expect(shards).toContain('retention-days: 30');
    expect(shards).toContain('overwrite: true');
    expect(shards).not.toContain('github.run_attempt');
    expect(merge).toContain('uses: actions/download-artifact@');
    expect(merge).toContain(`pattern: ${artifactPrefix}-*`);
    expect(merge).toContain(`path: ${artifactDirectory}/`);
    expect(merge).toContain('merge-multiple: true');
    expect(merge).not.toContain('github.run_attempt');
    // Omitted cross-run selectors bind artifact download to the current run.
    expect(merge).not.toMatch(/^\s+(?:run-id|repository|github-token):/m);
  });

  it('validates both reports before enforcing the original thresholds without rerunning tests', () => {
    const merge = job('broad-coverage');
    expect(merge).toContain('name: Broad unit coverage');
    expect(merge).toContain('needs: tests');
    expect(merge).toContain('fetch-depth: 0');
    expect(merge).not.toMatch(/^ {4}if:/m);
    expect(merge).not.toContain('continue-on-error:');
    expect(runCommands(merge)).toEqual([
      'corepack npm ci',
      `node scripts/check-coverage-shards.mts ${artifactDirectory} 2`,
      'node node_modules/vitest/vitest.mjs run --coverage --config vitest.config.ts ' +
        `--merge-reports=${artifactDirectory}`,
    ]);
    expect(merge.indexOf('uses: actions/download-artifact@')).toBeLessThan(
      merge.indexOf('run: node scripts/check-coverage-shards.mts'),
    );
  });

  it.each([
    ['coverage', 'Critical runtime coverage', 'critical'],
    ['worker-coverage', 'Worker runtime coverage', 'workers'],
    ['release-tooling-coverage', 'Release tooling coverage', 'tooling'],
  ])('preserves the independent focused %s lane', (id, name, config) => {
    const focused = job(id);
    expect(focused).toContain(`name: ${name}`);
    expect(focused).toContain('fetch-depth: 0');
    expect(focused).not.toMatch(/^ {4}(?:needs|if):/m);
    expect(focused).not.toContain('continue-on-error:');
    expect(runCommands(focused)).toEqual(['corepack npm ci', `npm run test:coverage:${config}`]);
    expect(scripts[`test:coverage:${config}`]).toBe(
      `vitest run --coverage --config vitest.${config}.config.ts`,
    );
  });

  it('has no additional plain or full-coverage broad unit execution anywhere in CI', () => {
    const unitCommands = runCommands(ciWorkflow)
      .flatMap((command) => expandCommands(command))
      .filter((command) =>
        /(?:^| )vitest run\b|node_modules\/vitest\/vitest\.mjs run\b/u.test(command),
      );
    expect(unitCommands).toHaveLength(5);
    expect(unitCommands.filter((command) => command.includes('--shard='))).toHaveLength(1);
    expect(unitCommands.filter((command) => command.includes('--merge-reports='))).toHaveLength(1);
    expect(
      unitCommands.filter((command) =>
        /--config vitest\.(?:critical|workers|tooling)\.config\.ts/u.test(command),
      ),
    ).toHaveLength(3);
  });
});
