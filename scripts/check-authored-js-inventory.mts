#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_INVENTORY_PATH =
  'docs/typescript-migration/authored-js-baseline.json' as const;

const AUTHORED_JAVASCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx']);
const SOURCE_STATUSES = new Set(['remaining', 'retired']);
const INLINE_NODE_JAVASCRIPT_PATTERN =
  /(?:^|[\s;&|()"'`])node(?:\.exe)?\s+(?:(?:--input-type(?:=|\s+)\S+|--[a-z][a-z0-9-]*(?:=\S+)?)\s+)*(?:-e|--eval|-p|--print)(?=\s|=)/u;

export type AuthoredJavaScriptStatus = 'remaining' | 'retired';

export interface AuthoredJavaScriptSource {
  path: string;
  baselineLines: number;
  status: AuthoredJavaScriptStatus;
}

export interface AuthoredJavaScriptSummary {
  totalFiles: number;
  totalLines: number;
  jsMjsFiles: number;
  jsMjsLines: number;
  jsxFiles: number;
  jsxLines: number;
}

export interface AuthoredJavaScriptManifest {
  schemaVersion: number;
  capturedAt: string;
  policy: string;
  lineCountMethod: string;
  extensions: string[];
  historical: AuthoredJavaScriptSummary;
  remaining: AuthoredJavaScriptSummary;
  sources: AuthoredJavaScriptSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRepositoryPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

export function isAuthoredJavaScriptPath(path: string): boolean {
  return AUTHORED_JAVASCRIPT_EXTENSIONS.has(extname(normalizeRepositoryPath(path)).toLowerCase());
}

function emptySummary(): AuthoredJavaScriptSummary {
  return {
    totalFiles: 0,
    totalLines: 0,
    jsMjsFiles: 0,
    jsMjsLines: 0,
    jsxFiles: 0,
    jsxLines: 0,
  };
}

export function summarizeSources(
  sources: readonly AuthoredJavaScriptSource[],
): AuthoredJavaScriptSummary {
  return sources.reduce<AuthoredJavaScriptSummary>((summary, source) => {
    const extension = extname(source.path).toLowerCase();
    summary.totalFiles += 1;
    summary.totalLines += source.baselineLines;
    if (extension === '.jsx') {
      summary.jsxFiles += 1;
      summary.jsxLines += source.baselineLines;
    } else {
      summary.jsMjsFiles += 1;
      summary.jsMjsLines += source.baselineLines;
    }
    return summary;
  }, emptySummary());
}

function summaryDifferences(
  label: string,
  expected: AuthoredJavaScriptSummary,
  actual: AuthoredJavaScriptSummary,
): string[] {
  const keys = [
    'totalFiles',
    'totalLines',
    'jsMjsFiles',
    'jsMjsLines',
    'jsxFiles',
    'jsxLines',
  ] as const;
  return keys.flatMap((key) =>
    expected[key] === actual[key]
      ? []
      : [`${label}.${key} is ${expected[key]}; the source inventory derives ${actual[key]}.`],
  );
}

function hasSummaryShape(value: unknown): value is AuthoredJavaScriptSummary {
  if (!isRecord(value)) return false;
  return ['totalFiles', 'totalLines', 'jsMjsFiles', 'jsMjsLines', 'jsxFiles', 'jsxLines'].every(
    (key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
  );
}

export function validateManifest(value: unknown): string[] {
  if (!isRecord(value)) return ['Inventory manifest must be a JSON object.'];

  const errors: string[] = [];
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (value.policy !== 'authored-js-family-shrink-only') {
    errors.push('policy must be "authored-js-family-shrink-only".');
  }
  if (value.lineCountMethod !== 'LF characters (wc -l semantics)') {
    errors.push('lineCountMethod must preserve the LF-based historical measurement.');
  }
  if (typeof value.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.capturedAt)) {
    errors.push('capturedAt must be an ISO calendar date.');
  }

  const extensions = Array.isArray(value.extensions) ? value.extensions : [];
  const expectedExtensions = [...AUTHORED_JAVASCRIPT_EXTENSIONS].sort();
  const actualExtensions = extensions
    .filter((extension): extension is string => typeof extension === 'string')
    .sort();
  if (JSON.stringify(actualExtensions) !== JSON.stringify(expectedExtensions)) {
    errors.push(`extensions must be exactly ${expectedExtensions.join(', ')}.`);
  }

  if (!Array.isArray(value.sources)) {
    errors.push('sources must be an array.');
    return errors;
  }

  const sources: AuthoredJavaScriptSource[] = [];
  const seen = new Set<string>();
  let previousPath = '';
  for (const [index, candidate] of value.sources.entries()) {
    if (!isRecord(candidate)) {
      errors.push(`sources[${index}] must be an object.`);
      continue;
    }
    const path = typeof candidate.path === 'string' ? normalizeRepositoryPath(candidate.path) : '';
    const baselineLines = candidate.baselineLines;
    const status = candidate.status;
    if (!path || path.startsWith('/') || path.includes('../')) {
      errors.push(`sources[${index}].path must be a normalized repository-relative path.`);
    } else if (!isAuthoredJavaScriptPath(path)) {
      errors.push(`${path} does not use an authored JavaScript-family extension.`);
    }
    if (!Number.isSafeInteger(baselineLines) || Number(baselineLines) < 0) {
      errors.push(`${path || `sources[${index}]`}.baselineLines must be a non-negative integer.`);
    }
    if (typeof status !== 'string' || !SOURCE_STATUSES.has(status)) {
      errors.push(`${path || `sources[${index}]`}.status must be remaining or retired.`);
    }
    if (seen.has(path)) errors.push(`Duplicate source path: ${path}.`);
    if (previousPath && path.localeCompare(previousPath, 'en') <= 0) {
      errors.push(`sources must be sorted by path: ${path} follows ${previousPath}.`);
    }
    seen.add(path);
    previousPath = path;
    if (
      path &&
      Number.isSafeInteger(baselineLines) &&
      Number(baselineLines) >= 0 &&
      typeof status === 'string' &&
      SOURCE_STATUSES.has(status)
    ) {
      sources.push({
        path,
        baselineLines: Number(baselineLines),
        status: status as AuthoredJavaScriptStatus,
      });
    }
  }

  if (!hasSummaryShape(value.historical)) {
    errors.push('historical must contain the six non-negative integer summary fields.');
  } else {
    errors.push(...summaryDifferences('historical', value.historical, summarizeSources(sources)));
  }

  const remainingSources = sources.filter((source) => source.status === 'remaining');
  if (!hasSummaryShape(value.remaining)) {
    errors.push('remaining must contain the six non-negative integer summary fields.');
  } else {
    errors.push(
      ...summaryDifferences('remaining', value.remaining, summarizeSources(remainingSources)),
    );
  }

  return errors;
}

export function checkCurrentInventory(
  manifest: AuthoredJavaScriptManifest,
  currentPaths: readonly string[],
): string[] {
  const current = new Set(
    currentPaths.map(normalizeRepositoryPath).filter(isAuthoredJavaScriptPath),
  );
  const known = new Map(manifest.sources.map((source) => [source.path, source]));
  const errors: string[] = [];

  for (const path of [...current].sort()) {
    const source = known.get(path);
    if (!source) {
      errors.push(`New authored JavaScript-family source is outside the baseline: ${path}.`);
    } else if (source.status === 'retired') {
      errors.push(`Retired authored JavaScript-family source was restored: ${path}.`);
    }
  }

  for (const source of manifest.sources) {
    if (source.status === 'remaining' && !current.has(source.path)) {
      errors.push(
        `Remaining baseline path is absent: ${source.path}. Mark it retired in the same conversion PR.`,
      );
    }
  }

  const expectedCount = manifest.remaining.totalFiles;
  if (current.size !== expectedCount) {
    errors.push(
      `Current authored JavaScript-family count is ${current.size}; remaining baseline is ${expectedCount}.`,
    );
  }
  return errors;
}

export function checkMonotonicProgress(
  previous: AuthoredJavaScriptManifest,
  current: AuthoredJavaScriptManifest,
): string[] {
  const errors: string[] = [];
  if (JSON.stringify(previous.historical) !== JSON.stringify(current.historical)) {
    errors.push('Historical inventory summary is immutable.');
  }
  if (previous.capturedAt !== current.capturedAt) errors.push('capturedAt is immutable.');

  const previousSources = new Map(previous.sources.map((source) => [source.path, source]));
  const currentSources = new Map(current.sources.map((source) => [source.path, source]));
  for (const [path, source] of previousSources) {
    const next = currentSources.get(path);
    if (!next) {
      errors.push(`Historical source entry was deleted instead of retired: ${path}.`);
      continue;
    }
    if (source.baselineLines !== next.baselineLines) {
      errors.push(`Historical baselineLines changed for ${path}.`);
    }
    if (source.status === 'retired' && next.status === 'remaining') {
      errors.push(`Shrink-only baseline regressed from retired to remaining: ${path}.`);
    }
  }
  for (const path of currentSources.keys()) {
    if (!previousSources.has(path)) errors.push(`Historical source entry was added: ${path}.`);
  }
  return errors;
}

export function listCurrentAuthoredJavaScriptSources(repository = process.cwd()): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repository,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map(normalizeRepositoryPath)
    .filter(isAuthoredJavaScriptPath)
    .filter((path) => {
      const absolutePath = resolve(repository, path);
      return existsSync(absolutePath) && statSync(absolutePath).isFile();
    })
    .sort((left, right) => left.localeCompare(right, 'en'));
}

export function checkInlineNodeJavaScript(label: string, source: string): string[] {
  return INLINE_NODE_JAVASCRIPT_PATTERN.test(source)
    ? [`Inline Node.js JavaScript is forbidden in ${label}; use a typed script file.`]
    : [];
}

export function checkRepositoryInlineNodeJavaScript(repository = process.cwd()): string[] {
  const repositoryFiles = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: repository,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter(Boolean)
    .map(normalizeRepositoryPath);
  const policyFiles = repositoryFiles
    .filter((path) => {
      const absolutePath = resolve(repository, path);
      return existsSync(absolutePath) && statSync(absolutePath).isFile();
    })
    .filter(
      (path) =>
        path === 'package.json' || (/^\.github\/workflows\//u.test(path) && /\.ya?ml$/u.test(path)),
    )
    .sort((left, right) => left.localeCompare(right, 'en'));

  return policyFiles.flatMap((path) =>
    checkInlineNodeJavaScript(path, readFileSync(resolve(repository, path), 'utf8')),
  );
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function optionalGitText(repository: string, args: readonly string[]): string | null {
  try {
    return String(
      execFileSync('git', [...args], {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
}

function readPreviousManifest(
  repository: string,
  inventoryPath: string,
): AuthoredJavaScriptManifest | null {
  const repositoryPath = normalizeRepositoryPath(relative(repository, inventoryPath));
  const status = optionalGitText(repository, ['status', '--porcelain', '--', repositoryPath]);
  let source: string | null;

  if (status?.trim()) {
    source = optionalGitText(repository, ['show', `HEAD:${repositoryPath}`]);
  } else {
    const lastChange = optionalGitText(repository, [
      'log',
      '-1',
      '--format=%H',
      '--',
      repositoryPath,
    ])?.trim();
    source = lastChange
      ? optionalGitText(repository, ['show', `${lastChange}^:${repositoryPath}`])
      : null;
  }

  if (!source) return null;
  const value = JSON.parse(source) as unknown;
  const errors = validateManifest(value);
  if (errors.length > 0) {
    throw new Error(`Previous inventory manifest is invalid:\n- ${errors.join('\n- ')}`);
  }
  return value as AuthoredJavaScriptManifest;
}

export function runInventoryGuard(
  repository = process.cwd(),
  inventoryPath = resolve(repository, DEFAULT_INVENTORY_PATH),
): { errors: string[]; currentPaths: string[]; manifest: AuthoredJavaScriptManifest | null } {
  const value = readJson(inventoryPath);
  const errors = validateManifest(value);
  if (errors.length > 0) return { errors, currentPaths: [], manifest: null };

  const manifest = value as AuthoredJavaScriptManifest;
  const currentPaths = listCurrentAuthoredJavaScriptSources(repository);
  errors.push(...checkCurrentInventory(manifest, currentPaths));
  errors.push(...checkRepositoryInlineNodeJavaScript(repository));
  const previous = readPreviousManifest(repository, inventoryPath);
  if (previous) errors.push(...checkMonotonicProgress(previous, manifest));
  return { errors, currentPaths, manifest };
}

function runCli(): void {
  const manifestArgument = process.argv.find((argument) => argument.startsWith('--manifest='));
  const repository = process.cwd();
  const inventoryPath = manifestArgument
    ? resolve(repository, manifestArgument.slice('--manifest='.length))
    : resolve(repository, DEFAULT_INVENTORY_PATH);

  try {
    const result = runInventoryGuard(repository, inventoryPath);
    if (result.errors.length > 0) {
      console.error('[authored-js-inventory] FAIL');
      for (const error of result.errors) console.error(`- ${error}`);
      process.exitCode = 1;
      return;
    }

    const retired = (result.manifest?.historical.totalFiles ?? 0) - result.currentPaths.length;
    console.log(
      `[authored-js-inventory] PASS: ${result.currentPaths.length} remaining, ${retired} retired.`,
    );
  } catch (error) {
    console.error('[authored-js-inventory] FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) runCli();
