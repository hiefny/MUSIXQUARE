#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const DEFAULT_DIAGNOSTIC_BASELINE_PATH =
  'docs/typescript-migration/strict-js-diagnostics-baseline.json' as const;

const AUTHORED_JAVASCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx']);
const POLICY = 'strict-typescript-diagnostics-shrink-only' as const;
const IDENTITY_ALGORITHM = 'repository path + TypeScript diagnostic code' as const;

const SERIALIZED_COMPILER_OPTIONS = Object.freeze({
  allowImportingTsExtensions: true,
  allowJs: true,
  checkJs: true,
  forceConsistentCasingInFileNames: true,
  jsx: 'preserve',
  lib: ['ES2023', 'DOM', 'DOM.Iterable', 'WebWorker'],
  module: 'ESNext',
  moduleDetection: 'force',
  moduleResolution: 'bundler',
  noEmit: true,
  noErrorTruncation: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  strict: true,
  target: 'ES2023',
  types: ['node'],
} as const);

const parsedCompilerOptions = ts.convertCompilerOptionsFromJson(
  SERIALIZED_COMPILER_OPTIONS,
  process.cwd(),
  'strict-js-diagnostic-ratchet.json',
);
if (parsedCompilerOptions.errors.length > 0) {
  throw new Error(
    `Invalid strict diagnostic compiler profile: ${parsedCompilerOptions.errors
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
      .join('; ')}`,
  );
}
const COMPILER_OPTIONS: ts.CompilerOptions = parsedCompilerOptions.options;

export interface StrictDiagnosticAllowance {
  path: string;
  code: number;
  count: number;
}

export interface StrictDiagnosticBaseline {
  schemaVersion: 2;
  policy: typeof POLICY;
  capturedAt: string;
  updatedAt: string;
  compiler: {
    typescriptVersion: string;
    optionsHash: string;
  };
  identity: {
    algorithm: typeof IDENTITY_ALGORITHM;
    aggregatesCount: true;
    storesMessageText: false;
    storesSourceText: false;
    storesLocation: false;
  };
  scope: {
    extensions: string[];
    sourceCount: number;
    sources: string[];
  };
  totalDiagnostics: number;
  diagnostics: StrictDiagnosticAllowance[];
}

export interface DiagnosticComparison {
  errors: string[];
  reducedDiagnostics: number;
  retiredSources: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedRepositoryPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function canonicalAbsolutePath(path: string): string {
  const normalized = normalizedRepositoryPath(resolve(path));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isAuthoredJavaScriptPath(path: string): boolean {
  return AUTHORED_JAVASCRIPT_EXTENSIONS.has(extname(path).toLowerCase());
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compilerOptionsHash(): string {
  return sha256(JSON.stringify(SERIALIZED_COMPILER_OPTIONS));
}

function allowanceIdentity(allowance: StrictDiagnosticAllowance): string {
  return `${allowance.path}\u0000${allowance.code}`;
}

function compareAllowances(
  left: StrictDiagnosticAllowance,
  right: StrictDiagnosticAllowance,
): number {
  return left.path.localeCompare(right.path, 'en') || left.code - right.code;
}

export function listAuthoredJavaScriptSources(repository = process.cwd()): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repository,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map(normalizedRepositoryPath)
    .filter(isAuthoredJavaScriptPath)
    .filter((path) => {
      const absolutePath = resolve(repository, path);
      return existsSync(absolutePath) && statSync(absolutePath).isFile();
    })
    .sort((left, right) => left.localeCompare(right, 'en'));
}

export function collectStrictDiagnostics(
  repository = process.cwd(),
  sourcePaths = listAuthoredJavaScriptSources(repository),
): StrictDiagnosticAllowance[] {
  const sourcePathByAbsolutePath = new Map(
    sourcePaths.map((path) => [canonicalAbsolutePath(resolve(repository, path)), path]),
  );
  const rootNames = sourcePaths.map((path) => resolve(repository, path));
  const program = ts.createProgram({ rootNames, options: COMPILER_OPTIONS });
  const counts = new Map<string, StrictDiagnosticAllowance>();

  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error || !diagnostic.file) continue;
    const path = sourcePathByAbsolutePath.get(canonicalAbsolutePath(diagnostic.file.fileName));
    if (!path) continue;

    const allowance: StrictDiagnosticAllowance = {
      path,
      code: diagnostic.code,
      count: 1,
    };
    const identity = allowanceIdentity(allowance);
    const existing = counts.get(identity);
    if (existing) existing.count += 1;
    else counts.set(identity, allowance);
  }

  return [...counts.values()].sort(compareAllowances);
}

function today(): string {
  const date = new Date();
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function createDiagnosticBaseline(
  sources: readonly string[],
  diagnostics: readonly StrictDiagnosticAllowance[],
  capturedAt = today(),
): StrictDiagnosticBaseline {
  const sortedSources = [...sources].sort((left, right) => left.localeCompare(right, 'en'));
  const sortedDiagnostics = diagnostics.map((entry) => ({ ...entry })).sort(compareAllowances);
  return {
    schemaVersion: 2,
    policy: POLICY,
    capturedAt,
    updatedAt: today(),
    compiler: {
      typescriptVersion: ts.version,
      optionsHash: compilerOptionsHash(),
    },
    identity: {
      algorithm: IDENTITY_ALGORITHM,
      aggregatesCount: true,
      storesMessageText: false,
      storesSourceText: false,
      storesLocation: false,
    },
    scope: {
      extensions: [...AUTHORED_JAVASCRIPT_EXTENSIONS].sort(),
      sourceCount: sortedSources.length,
      sources: sortedSources,
    },
    totalDiagnostics: sortedDiagnostics.reduce((total, entry) => total + entry.count, 0),
    diagnostics: sortedDiagnostics,
  };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function validateDiagnosticBaseline(value: unknown): string[] {
  if (!isRecord(value)) return ['Diagnostic baseline must be a JSON object.'];

  const errors: string[] = [];
  if (
    !exactKeys(value, [
      'schemaVersion',
      'policy',
      'capturedAt',
      'updatedAt',
      'compiler',
      'identity',
      'scope',
      'totalDiagnostics',
      'diagnostics',
    ])
  ) {
    errors.push('Diagnostic baseline contains fields outside the privacy-preserving schema.');
  }
  if (value.schemaVersion !== 2) errors.push('schemaVersion must be 2.');
  if (value.policy !== POLICY) errors.push(`policy must be "${POLICY}".`);
  for (const field of ['capturedAt', 'updatedAt'] as const) {
    if (typeof value[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value[field])) {
      errors.push(`${field} must be an ISO calendar date.`);
    }
  }

  if (!isRecord(value.compiler)) {
    errors.push('compiler must be an object.');
  } else {
    if (!exactKeys(value.compiler, ['typescriptVersion', 'optionsHash'])) {
      errors.push('compiler contains unsupported fields.');
    }
    if (typeof value.compiler.typescriptVersion !== 'string') {
      errors.push('compiler.typescriptVersion must be a string.');
    }
    if (!/^[a-f0-9]{64}$/u.test(String(value.compiler.optionsHash))) {
      errors.push('compiler.optionsHash must be a SHA-256 digest.');
    }
  }

  if (!isRecord(value.identity)) {
    errors.push('identity must be an object.');
  } else {
    if (
      !exactKeys(value.identity, [
        'algorithm',
        'aggregatesCount',
        'storesMessageText',
        'storesSourceText',
        'storesLocation',
      ])
    ) {
      errors.push('identity contains unsupported fields.');
    }
    if (value.identity.algorithm !== IDENTITY_ALGORITHM) {
      errors.push(`identity.algorithm must be "${IDENTITY_ALGORITHM}".`);
    }
    if (value.identity.aggregatesCount !== true)
      errors.push('identity.aggregatesCount must be true.');
    if (value.identity.storesMessageText !== false || value.identity.storesSourceText !== false) {
      errors.push('The baseline must not store diagnostic messages or source text.');
    }
    if (value.identity.storesLocation !== false) {
      errors.push('identity.storesLocation must be false.');
    }
  }

  if (!isRecord(value.scope)) {
    errors.push('scope must be an object.');
  } else {
    if (!exactKeys(value.scope, ['extensions', 'sourceCount', 'sources'])) {
      errors.push('scope contains unsupported fields.');
    }
    const extensions = Array.isArray(value.scope.extensions) ? value.scope.extensions : [];
    const expectedExtensions = [...AUTHORED_JAVASCRIPT_EXTENSIONS].sort();
    if (JSON.stringify(extensions) !== JSON.stringify(expectedExtensions)) {
      errors.push(`scope.extensions must be exactly ${expectedExtensions.join(', ')}.`);
    }
    if (!Array.isArray(value.scope.sources)) {
      errors.push('scope.sources must be an array.');
    } else {
      const sources = value.scope.sources;
      const sortedSources = sources
        .filter((path): path is string => typeof path === 'string')
        .slice()
        .sort((left, right) => left.localeCompare(right, 'en'));
      if (sources.some((path) => typeof path !== 'string' || !isAuthoredJavaScriptPath(path))) {
        errors.push('Every scope source must be an authored JavaScript-family path.');
      }
      if (JSON.stringify(sources) !== JSON.stringify(sortedSources)) {
        errors.push('scope.sources must be unique and sorted.');
      }
      if (new Set(sources).size !== sources.length) {
        errors.push('scope.sources must not contain duplicates.');
      }
      if (value.scope.sourceCount !== sources.length) {
        errors.push('scope.sourceCount must equal scope.sources.length.');
      }
    }
  }

  if (!Array.isArray(value.diagnostics)) {
    errors.push('diagnostics must be an array.');
    return errors;
  }

  const sourceSet = new Set(
    isRecord(value.scope) && Array.isArray(value.scope.sources)
      ? value.scope.sources.filter((path): path is string => typeof path === 'string')
      : [],
  );
  const allowances: StrictDiagnosticAllowance[] = [];
  const identities = new Set<string>();
  for (const [index, candidate] of value.diagnostics.entries()) {
    if (!isRecord(candidate)) {
      errors.push(`diagnostics[${index}] must be an object.`);
      continue;
    }
    if (!exactKeys(candidate, ['path', 'code', 'count'])) {
      errors.push(
        `diagnostics[${index}] may contain only path, code, and count; ` +
          'message text, source text, and locations are forbidden.',
      );
    }
    const path = candidate.path;
    const code = candidate.code;
    const count = candidate.count;
    if (typeof path !== 'string' || !sourceSet.has(path)) {
      errors.push(`diagnostics[${index}].path must name a source in scope.`);
    }
    if (!Number.isSafeInteger(code) || Number(code) <= 0) {
      errors.push(`diagnostics[${index}].code must be a positive TypeScript diagnostic code.`);
    }
    if (!Number.isSafeInteger(count) || Number(count) <= 0) {
      errors.push(`diagnostics[${index}].count must be a positive integer.`);
    }
    if (typeof path === 'string' && Number.isSafeInteger(code) && Number.isSafeInteger(count)) {
      const allowance = {
        path,
        code: Number(code),
        count: Number(count),
      };
      const identity = allowanceIdentity(allowance);
      if (identities.has(identity)) errors.push(`Duplicate diagnostic identity at index ${index}.`);
      identities.add(identity);
      allowances.push(allowance);
    }
  }

  const sortedAllowances = allowances.slice().sort(compareAllowances);
  if (JSON.stringify(allowances) !== JSON.stringify(sortedAllowances)) {
    errors.push('diagnostics must be sorted by path and code.');
  }
  const total = allowances.reduce((sum, allowance) => sum + allowance.count, 0);
  if (value.totalDiagnostics !== total) {
    errors.push(`totalDiagnostics is ${String(value.totalDiagnostics)}; entries sum to ${total}.`);
  }
  return errors;
}

function asBaseline(value: unknown, label: string): StrictDiagnosticBaseline {
  const errors = validateDiagnosticBaseline(value);
  if (errors.length > 0) throw new Error(`${label} is invalid:\n- ${errors.join('\n- ')}`);
  return value as StrictDiagnosticBaseline;
}

export function compareDiagnosticsToBaseline(
  baseline: StrictDiagnosticBaseline,
  currentSources: readonly string[],
  currentDiagnostics: readonly StrictDiagnosticAllowance[],
  requireCompilerMatch = true,
): DiagnosticComparison {
  const errors: string[] = [];
  if (requireCompilerMatch && baseline.compiler.typescriptVersion !== ts.version) {
    errors.push(
      `TypeScript version changed from ${baseline.compiler.typescriptVersion} to ${ts.version}. ` +
        'Ratchet the baseline only after the new compiler introduces no diagnostic identity or count increase.',
    );
  }
  if (requireCompilerMatch && baseline.compiler.optionsHash !== compilerOptionsHash()) {
    errors.push(
      'Strict diagnostic compiler options changed. Ratchet the baseline only after the new profile ' +
        'introduces no diagnostic identity or count increase.',
    );
  }

  const baselineSources = new Set(baseline.scope.sources);
  for (const path of currentSources) {
    if (!baselineSources.has(path)) errors.push(`New authored JavaScript source: ${path}.`);
  }

  const baselineByIdentity = new Map(
    baseline.diagnostics.map((allowance) => [allowanceIdentity(allowance), allowance]),
  );
  const currentByIdentity = new Map(
    currentDiagnostics.map((allowance) => [allowanceIdentity(allowance), allowance]),
  );
  for (const allowance of currentDiagnostics) {
    const previous = baselineByIdentity.get(allowanceIdentity(allowance));
    const safeIdentity = `${allowance.path} TS${allowance.code}`;
    if (!previous) {
      errors.push(`New strict diagnostic identity: ${safeIdentity}.`);
    } else if (allowance.count > previous.count) {
      errors.push(
        `Strict diagnostic count increased: ${safeIdentity} ` +
          `${previous.count} -> ${allowance.count}.`,
      );
    }
  }

  let reducedDiagnostics = 0;
  for (const allowance of baseline.diagnostics) {
    const currentCount = currentByIdentity.get(allowanceIdentity(allowance))?.count ?? 0;
    reducedDiagnostics += Math.max(allowance.count - currentCount, 0);
  }
  const retiredSources = baseline.scope.sources.filter(
    (path) => !currentSources.includes(path),
  ).length;
  return { errors, reducedDiagnostics, retiredSources };
}

export function checkBaselineMonotonicProgress(
  previous: StrictDiagnosticBaseline,
  current: StrictDiagnosticBaseline,
): string[] {
  const errors: string[] = [];
  if (current.capturedAt !== previous.capturedAt) errors.push('capturedAt is immutable.');
  if (current.updatedAt < previous.updatedAt) errors.push('updatedAt must not move backwards.');

  const previousSources = new Set(previous.scope.sources);
  for (const path of current.scope.sources) {
    if (!previousSources.has(path)) errors.push(`Diagnostic scope increased with source: ${path}.`);
  }

  const previousByIdentity = new Map(
    previous.diagnostics.map((allowance) => [allowanceIdentity(allowance), allowance]),
  );
  for (const allowance of current.diagnostics) {
    const prior = previousByIdentity.get(allowanceIdentity(allowance));
    const safeIdentity = `${allowance.path} TS${allowance.code}`;
    if (!prior) errors.push(`Diagnostic baseline added a new identity: ${safeIdentity}.`);
    else if (allowance.count > prior.count) {
      errors.push(
        `Diagnostic baseline count increased: ${safeIdentity} ${prior.count} -> ${allowance.count}.`,
      );
    }
  }
  return errors;
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

function readPreviousBaseline(
  repository: string,
  baselinePath: string,
): StrictDiagnosticBaseline | null {
  const repositoryPath = normalizedRepositoryPath(relative(repository, baselinePath));
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

  return source ? asBaseline(JSON.parse(source) as unknown, 'Previous diagnostic baseline') : null;
}

export function runDiagnosticRatchet(
  repository = process.cwd(),
  baselinePath = resolve(repository, DEFAULT_DIAGNOSTIC_BASELINE_PATH),
): {
  baseline: StrictDiagnosticBaseline;
  currentSources: string[];
  currentDiagnostics: StrictDiagnosticAllowance[];
  comparison: DiagnosticComparison;
  errors: string[];
} {
  const baseline = asBaseline(readJson(baselinePath), 'Diagnostic baseline');
  const errors: string[] = [];
  const previous = readPreviousBaseline(repository, baselinePath);
  if (previous) errors.push(...checkBaselineMonotonicProgress(previous, baseline));

  const currentSources = listAuthoredJavaScriptSources(repository);
  const currentDiagnostics = collectStrictDiagnostics(repository, currentSources);
  const comparison = compareDiagnosticsToBaseline(baseline, currentSources, currentDiagnostics);
  errors.push(...comparison.errors);
  return { baseline, currentSources, currentDiagnostics, comparison, errors };
}

function writeCurrentBaseline(repository: string, baselinePath: string): void {
  const workingBaseline = existsSync(baselinePath)
    ? asBaseline(readJson(baselinePath), 'Diagnostic baseline')
    : null;
  const previousBaseline = readPreviousBaseline(repository, baselinePath);
  if (workingBaseline && previousBaseline) {
    const historicalErrors = checkBaselineMonotonicProgress(previousBaseline, workingBaseline);
    if (historicalErrors.length > 0) {
      throw new Error(`Existing baseline is not shrink-only:\n- ${historicalErrors.join('\n- ')}`);
    }
  }

  const allowedBaseline = workingBaseline ?? previousBaseline;
  const currentSources = listAuthoredJavaScriptSources(repository);
  const currentDiagnostics = collectStrictDiagnostics(repository, currentSources);
  if (allowedBaseline) {
    const comparison = compareDiagnosticsToBaseline(
      allowedBaseline,
      currentSources,
      currentDiagnostics,
      false,
    );
    if (comparison.errors.length > 0) {
      throw new Error(
        `Refusing to widen the strict diagnostic baseline:\n- ${comparison.errors.join('\n- ')}`,
      );
    }
  }

  const baseline = createDiagnosticBaseline(
    currentSources,
    currentDiagnostics,
    allowedBaseline?.capturedAt,
  );
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  console.log(
    `[typescript-diagnostic-ratchet] WROTE ${currentDiagnostics.length} identities, ` +
      `${baseline.totalDiagnostics} diagnostics across ${currentSources.length} sources.`,
  );
}

function runCli(): void {
  const args = process.argv.slice(2);
  const unknownArguments = args.filter(
    (argument) => argument !== '--write' && !argument.startsWith('--baseline='),
  );
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument: ${unknownArguments.join(', ')}`);
  }
  const baselineArgument = args.find((argument) => argument.startsWith('--baseline='));
  const repository = process.cwd();
  const baselinePath = baselineArgument
    ? resolve(repository, baselineArgument.slice('--baseline='.length))
    : resolve(repository, DEFAULT_DIAGNOSTIC_BASELINE_PATH);

  if (args.includes('--write')) {
    writeCurrentBaseline(repository, baselinePath);
    return;
  }
  if (!existsSync(baselinePath)) {
    throw new Error(
      `Diagnostic baseline is missing: ${normalizedRepositoryPath(relative(repository, baselinePath))}.`,
    );
  }

  const result = runDiagnosticRatchet(repository, baselinePath);
  if (result.errors.length > 0) {
    throw new Error(`Strict diagnostic ratchet failed:\n- ${result.errors.join('\n- ')}`);
  }
  const reduction = result.comparison.reducedDiagnostics;
  const reductionNotice =
    reduction > 0 || result.comparison.retiredSources > 0
      ? ` ${reduction} diagnostics and ${result.comparison.retiredSources} sources are eligible ` +
        'to be locked in with --write.'
      : '';
  console.log(
    `[typescript-diagnostic-ratchet] PASS: ${result.currentDiagnostics.length} identities, ` +
      `${result.currentDiagnostics.reduce((sum, entry) => sum + entry.count, 0)} diagnostics ` +
      `across ${result.currentSources.length} sources.${reductionNotice}`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error('[typescript-diagnostic-ratchet] FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
