import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface SourceBudget {
  readonly path: string;
  readonly maxLines: number;
  readonly maxRunLines?: number;
}

interface YamlRunBlock {
  readonly startLine: number;
  readonly lines: number;
}

const DEFAULT_BUDGETS = Object.freeze([
  { path: 'cloudflare/pro-room-worker.ts', maxLines: 20_000 },
  { path: 'cloudflare/service-control-object.ts', maxLines: 2_000 },
  { path: 'cloudflare/pro-room-body.ts', maxLines: 500 },
  { path: 'cloudflare/app-worker.ts', maxLines: 20_000 },
  { path: 'cloudflare/signaling-worker.ts', maxLines: 10_000 },
  { path: 'cloudflare/signaling-protocol.ts', maxLines: 1_000 },
  { path: 'src/pro-room/runtime.ts', maxLines: 10_000 },
  { path: 'browser/classic-runtime/admin.ts', maxLines: 10_000 },
  { path: '.github/workflows/release.yml', maxLines: 2_000, maxRunLines: 200 },
  { path: '.github/workflows/release-recovery.yml', maxLines: 1_000, maxRunLines: 200 },
] satisfies readonly SourceBudget[]);

function sourceLineCount(source: string): number {
  if (!source) return 0;
  const lines = source.split(/\r?\n/u);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function leadingSpaces(value: string): number {
  return /^ */u.exec(value)?.[0].length ?? 0;
}

function largestYamlRunBlock(source: string): YamlRunBlock {
  const lines = source.split(/\r?\n/u);
  let largest = { startLine: 0, lines: 0 };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const match = /^(\s*)run:\s*[|>][-+]?\s*$/u.exec(line);
    if (!match) continue;
    const indentation = match[1];
    if (indentation === undefined) continue;
    const parentIndent = indentation.length;
    let blockLines = 0;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const blockLine = lines[cursor];
      if (blockLine === undefined) break;
      if (blockLine.trim() && leadingSpaces(blockLine) <= parentIndent) break;
      blockLines += 1;
    }
    if (blockLines > largest.lines) largest = { startLine: index + 1, lines: blockLines };
  }
  return largest;
}

function parseBudgetOverride(value: string): SourceBudget {
  const match = /^([^:]+):(\d+)(?::(\d+))?$/u.exec(value);
  const sourcePath = match?.[1];
  const maxLinesText = match?.[2];
  if (!sourcePath || !maxLinesText || sourcePath.includes('..')) {
    throw new Error(`Invalid --budget value: ${value}`);
  }
  const maxLines = Number(maxLinesText);
  const maxRunLines = match[3] ? Number(match[3]) : undefined;
  if (!Number.isSafeInteger(maxLines) || maxLines < 1) {
    throw new Error(`Invalid line budget: ${value}`);
  }
  const budget = { path: sourcePath.replace(/\\/gu, '/'), maxLines };
  return maxRunLines === undefined ? budget : { ...budget, maxRunLines };
}

function selectedBudgets(argv: readonly string[]): readonly SourceBudget[] {
  const overrides = argv
    .filter((argument) => argument.startsWith('--budget='))
    .map((argument) => parseBudgetOverride(argument.slice('--budget='.length)));
  return overrides.length > 0 ? overrides : DEFAULT_BUDGETS;
}

function main(): void {
  const failures: string[] = [];
  const observations: string[] = [];
  for (const budget of selectedBudgets(process.argv.slice(2))) {
    const source = readFileSync(resolve(process.cwd(), budget.path), 'utf8');
    const lines = sourceLineCount(source);
    observations.push(`${budget.path}: ${lines}/${budget.maxLines} lines`);
    if (lines > budget.maxLines) {
      failures.push(`${budget.path} has ${lines} lines (budget ${budget.maxLines}).`);
    }
    if (budget.maxRunLines !== undefined) {
      const run = largestYamlRunBlock(source);
      observations.push(
        `${budget.path}: largest inline run block ${run.lines}/${budget.maxRunLines} lines`,
      );
      if (run.lines > budget.maxRunLines) {
        failures.push(
          `${budget.path}:${run.startLine} has a ${run.lines}-line inline run block ` +
            `(budget ${budget.maxRunLines}).`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Source complexity safety limit failed:\n- ${failures.join('\n- ')}\n` +
        'Review whether the growth is intentional. Keep tightly coupled state and lifecycle ' +
        'co-located; split only when the new boundary reduces dependencies or owns an ' +
        'independent lifecycle. Update the documented safety limit when co-location is simpler.',
    );
  }
  console.log(`[source-complexity] ${observations.join('; ')}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
