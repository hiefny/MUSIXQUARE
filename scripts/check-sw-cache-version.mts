#!/usr/bin/env node
/**
 * Fail when committed PWA runtime changes are newer than the latest
 * CACHE_VERSION bump in the service-worker compiler manifest.
 *
 * A runtime change and the bump may live in the same commit, or the bump may
 * follow in its own commit. Back-end, documentation, and test-only commits do
 * not require a PWA cache migration.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '..');
const serviceWorkerPath = 'scripts/service-worker-asset.ts';
const legacyServiceWorkerPath = 'public/service-worker.js';
const packageJsonPath = 'package.json';
const previousBuildCommand = 'vite build';
const staticHeaderBuildCommand = 'vite build && node scripts/materialize-app-static-headers.mts';

interface GuardOptions {
  repoRoot: string;
  head: string;
}

interface CacheVersionBump {
  commit: string;
  version: string;
  previousVersion: string | null;
}

interface InspectionResult {
  headCommit: string;
  latestBump: CacheVersionBump;
  runtimePaths: string[];
}

interface GitOptions {
  allowFailure?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandStderr(error: unknown): string {
  if (!isRecord(error)) return '';
  const stderr = error.stderr;
  if (typeof stderr === 'string') return stderr.trim();
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf8').trim();
  return '';
}

class GuardError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'GuardError';
    this.exitCode = exitCode;
  }
}

function git(repoRoot: string, args: string[], options: { allowFailure: true }): string | null;
function git(repoRoot: string, args: string[], options?: { allowFailure?: false }): string;
function git(
  repoRoot: string,
  args: string[],
  { allowFailure = false }: GitOptions = {},
): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail = commandStderr(error);
    throw new GuardError(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function parseArguments(argv: readonly string[]): GuardOptions {
  const result: GuardOptions = { repoRoot: defaultRepoRoot, head: 'HEAD' };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) throw new GuardError('Missing command-line argument.');
    if (argument === '--repo' || argument === '--head') {
      const value = argv[index + 1];
      if (!value) throw new GuardError(`${argument} requires a value.`);
      if (argument === '--repo') result.repoRoot = path.resolve(value);
      else result.head = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--repo=')) {
      result.repoRoot = path.resolve(argument.slice('--repo='.length));
      continue;
    }
    if (argument.startsWith('--head=')) {
      result.head = argument.slice('--head='.length);
      continue;
    }
    throw new GuardError(`Unknown argument: ${argument}`);
  }

  return result;
}

function parseCacheVersion(source: string, revision: string, sourcePath: string): string {
  const matches = [
    ...source.matchAll(
      /\b(?:export\s+)?const\s+(?:SERVICE_WORKER_CACHE_VERSION|CACHE_VERSION)\s*=\s*['"](v\d+)['"]\s*;/gu,
    ),
  ];
  if (matches.length !== 1) {
    throw new GuardError(
      `${sourcePath} at ${revision} must declare exactly one numeric CACHE_VERSION.`,
    );
  }
  const version = matches[0]?.[1];
  if (version === undefined) {
    throw new GuardError(
      `${sourcePath} at ${revision} must declare exactly one numeric CACHE_VERSION.`,
    );
  }
  return version;
}

function readVersionAt(
  repoRoot: string,
  revision: string,
  { allowMissing = false }: { allowMissing?: boolean } = {},
): string | null {
  const compilerSource = git(repoRoot, ['show', `${revision}:${serviceWorkerPath}`], {
    allowFailure: true,
  });
  if (compilerSource !== null) {
    return parseCacheVersion(compilerSource, revision, serviceWorkerPath);
  }
  const legacyArguments = ['show', `${revision}:${legacyServiceWorkerPath}`];
  const legacySource = allowMissing
    ? git(repoRoot, legacyArguments, { allowFailure: true })
    : git(repoRoot, legacyArguments);
  if (legacySource === null) return null;
  return parseCacheVersion(legacySource, revision, legacyServiceWorkerPath);
}

function isTestOnlySourcePath(filePath: string): boolean {
  return (
    filePath.includes('/__tests__/') ||
    /(?:^|\/)__tests__(?:\/|$)/u.test(filePath) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filePath)
  );
}

function isRuntimeAppPath(rawPath: string): boolean {
  const filePath = rawPath.replaceAll('\\', '/').replace(/^\.\//u, '');

  if (filePath.startsWith('src/')) return !isTestOnlySourcePath(filePath);
  if (filePath.startsWith('browser/')) return !isTestOnlySourcePath(filePath);
  if (filePath.startsWith('css/')) return true;
  if (filePath.startsWith('fonts/noto/')) return true;
  if (filePath.startsWith('public/')) return true;

  if (
    filePath.startsWith('.workshop/landing/') ||
    filePath.startsWith('.workshop/privacy/') ||
    filePath.startsWith('.workshop/terms/') ||
    filePath.startsWith('.workshop/faq/') ||
    filePath.startsWith('.workshop/developers/')
  ) {
    return true;
  }

  return new Set([
    'index.html',
    'scripts/classic-runtime-assets.ts',
    'scripts/service-worker-asset.ts',
    'scripts/service-worker-app-shell-guard-lib.mts',
    'scripts/materialize-localized-html.mts',
    'scripts/localized-html-lib.mts',
    'scripts/locale-seo-metadata.mts',
    'scripts/ui-kit-asset.ts',
    'vite.config.ts',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.service-worker.json',
    'tsconfig.ui-kit.json',
  ]).has(filePath);
}

function findLatestVersionBump(repoRoot: string, headCommit: string): CacheVersionBump {
  const commits = git(repoRoot, ['rev-list', '--first-parent', headCommit])
    .split(/\r?\n/u)
    .filter(Boolean);

  for (const commit of commits) {
    const currentVersion = readVersionAt(repoRoot, commit, { allowMissing: true });
    if (currentVersion === null) continue;

    const parent = git(repoRoot, ['rev-parse', '--verify', `${commit}^`], {
      allowFailure: true,
    });
    const previousVersion = parent ? readVersionAt(repoRoot, parent, { allowMissing: true }) : null;

    if (currentVersion !== previousVersion) {
      return { commit, version: currentVersion, previousVersion };
    }
  }

  throw new GuardError(
    `No CACHE_VERSION introduction or bump was found on the first-parent history of ${headCommit}.`,
  );
}

function changedPathsSince(repoRoot: string, fromCommit: string, toCommit: string): string[] {
  const output = execFileSync(
    'git',
    [
      'diff',
      '--no-renames',
      '--name-only',
      '--diff-filter=ACDMRTUXB',
      '-z',
      `${fromCommit}..${toCommit}`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return output.split('\0').filter(Boolean);
}

function readJsonAt(repoRoot: string, revision: string, filePath: string): unknown {
  const source = git(repoRoot, ['show', `${revision}:${filePath}`]);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new GuardError(`${filePath} at ${revision} is not valid JSON: ${errorMessage(error)}`);
  }
}

function isStaticHeaderBuildPolicyOnlyPackageChange(
  repoRoot: string,
  fromCommit: string,
  toCommit: string,
): boolean {
  const before = readJsonAt(repoRoot, fromCommit, packageJsonPath);
  const after = readJsonAt(repoRoot, toCommit, packageJsonPath);
  if (!isRecord(before) || !isRecord(after)) return false;
  const beforeScripts = before.scripts;
  const afterScripts = after.scripts;
  if (
    !isRecord(beforeScripts) ||
    !isRecord(afterScripts) ||
    beforeScripts.build !== previousBuildCommand ||
    afterScripts.build !== staticHeaderBuildCommand
  ) {
    return false;
  }

  // Compare parsed manifests so formatting and key order are irrelevant, but
  // fail closed when any dependency, metadata, or other script changed beside
  // the one explicitly reviewed build-artifact policy transition.
  const normalizedAfter = structuredClone(after);
  const normalizedScripts = normalizedAfter.scripts;
  if (!isRecord(normalizedScripts)) return false;
  normalizedScripts.build = previousBuildCommand;
  return isDeepStrictEqual(before, normalizedAfter);
}

function inspect({ repoRoot, head }: GuardOptions): InspectionResult {
  const isShallow = git(repoRoot, ['rev-parse', '--is-shallow-repository']);
  if (isShallow !== 'false') {
    throw new GuardError(
      'Cannot prove the latest CACHE_VERSION boundary from shallow history. ' +
        'Fetch full history (`git fetch --unshallow`) or use actions/checkout with `fetch-depth: 0`.',
    );
  }

  const headCommit = git(repoRoot, ['rev-parse', '--verify', `${head}^{commit}`]);
  const headVersion = readVersionAt(repoRoot, headCommit);
  const latestBump = findLatestVersionBump(repoRoot, headCommit);
  if (
    latestBump.previousVersion !== null &&
    Number.parseInt(latestBump.version.slice(1), 10) <=
      Number.parseInt(latestBump.previousVersion.slice(1), 10)
  ) {
    throw new GuardError(
      `CACHE_VERSION must increase monotonically; ${latestBump.previousVersion} became ${latestBump.version}.`,
      1,
    );
  }
  const changedPaths = changedPathsSince(repoRoot, latestBump.commit, headCommit);
  const allowStaticHeaderBuildPolicy =
    changedPaths.includes(packageJsonPath) &&
    isStaticHeaderBuildPolicyOnlyPackageChange(repoRoot, latestBump.commit, headCommit);
  const runtimePaths = changedPaths.filter(
    (filePath) =>
      !(filePath === packageJsonPath && allowStaticHeaderBuildPolicy) && isRuntimeAppPath(filePath),
  );

  if (headVersion !== latestBump.version) {
    throw new GuardError(
      `Internal guard error: ${headCommit} reports ${headVersion}, but the latest bump reports ${latestBump.version}.`,
    );
  }

  return { headCommit, latestBump, runtimePaths };
}

function shortCommit(commit: string): string {
  return commit.slice(0, 8);
}

function main(): void {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = inspect(options);
    const { latestBump, runtimePaths } = result;

    if (runtimePaths.length > 0) {
      console.error(
        `[sw-cache-version] FAIL: committed PWA runtime changes are newer than ` +
          `${latestBump.version} (${shortCommit(latestBump.commit)}).`,
      );
      for (const filePath of runtimePaths) console.error(`  - ${filePath}`);
      console.error(
        `Bump CACHE_VERSION in ${serviceWorkerPath} after these changes, then commit the bump.`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `[sw-cache-version] PASS: ${latestBump.version} ` +
        `(${shortCommit(latestBump.commit)}) covers all committed PWA runtime changes.`,
    );
  } catch (error) {
    const guardError = error instanceof GuardError ? error : new GuardError(errorMessage(error));
    console.error(`[sw-cache-version] ERROR: ${guardError.message}`);
    process.exitCode = guardError.exitCode;
  }
}

main();
