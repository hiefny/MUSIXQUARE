import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_BUDGETS = Object.freeze([
  { path: 'cloudflare/pro-room-worker.js', maxLines: 13_300 },
  { path: 'cloudflare/service-control-object.js', maxLines: 1_175 },
  { path: 'cloudflare/pro-room-body.js', maxLines: 100 },
  { path: 'cloudflare/app-worker.js', maxLines: 13_100 },
  { path: 'cloudflare/signaling-worker.js', maxLines: 5_000 },
  { path: 'cloudflare/signaling-protocol.js', maxLines: 625 },
  { path: 'src/pro-room/runtime.ts', maxLines: 5_225 },
  { path: 'public/admin.js', maxLines: 5_350 },
  { path: '.github/workflows/release.yml', maxLines: 1_450, maxRunLines: 100 },
  { path: '.github/workflows/release-recovery.yml', maxLines: 500, maxRunLines: 100 },
]);

function sourceLineCount(source) {
  if (!source) return 0;
  const lines = source.split(/\r?\n/u);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function leadingSpaces(value) {
  return /^ */u.exec(value)?.[0].length ?? 0;
}

function largestYamlRunBlock(source) {
  const lines = source.split(/\r?\n/u);
  let largest = { startLine: 0, lines: 0 };
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*[|>][-+]?\s*$/u.exec(lines[index]);
    if (!match) continue;
    const parentIndent = match[1].length;
    let blockLines = 0;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() && leadingSpaces(line) <= parentIndent) break;
      blockLines += 1;
    }
    if (blockLines > largest.lines) largest = { startLine: index + 1, lines: blockLines };
  }
  return largest;
}

function parseBudgetOverride(value) {
  const match = /^([^:]+):(\d+)(?::(\d+))?$/u.exec(value);
  if (!match || match[1].includes('..')) {
    throw new Error(`Invalid --budget value: ${value}`);
  }
  const maxLines = Number(match[2]);
  const maxRunLines = match[3] ? Number(match[3]) : undefined;
  if (!Number.isSafeInteger(maxLines) || maxLines < 1) {
    throw new Error(`Invalid line budget: ${value}`);
  }
  return { path: match[1].replace(/\\/gu, '/'), maxLines, maxRunLines };
}

function selectedBudgets(argv) {
  const overrides = argv
    .filter((argument) => argument.startsWith('--budget='))
    .map((argument) => parseBudgetOverride(argument.slice('--budget='.length)));
  return overrides.length > 0 ? overrides : DEFAULT_BUDGETS;
}

function main() {
  const failures = [];
  const observations = [];
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
      `Source complexity ratchet failed:\n- ${failures.join('\n- ')}\n` +
        'Extract a cohesive module or release helper. Do not raise a budget without an accepted ADR.',
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
