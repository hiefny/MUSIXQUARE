#!/usr/bin/env node
/**
 * Fail when committed PWA runtime changes are newer than the latest
 * CACHE_VERSION bump in the service-worker compiler manifest.
 *
 * A runtime change and the bump may live in the same commit, or the bump may
 * follow in its own commit. Back-end, documentation, and test-only commits do
 * not require a PWA cache migration.
 *
 * Back-end files outside the runtime trees still count when browser code
 * imports them: a Worker module that src/ or browser/ imports (for example a
 * shared timing or contract module under cloudflare/) is compiled into the App
 * bundle. Those files come from the import graph at both ends of the checked
 * range, not from a hand list.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';

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

function normalizePath(rawPath: string): string {
  return rawPath.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function isPublicWorkshopPath(filePath: string): boolean {
  if (
    filePath.startsWith('.workshop/landing/') ||
    filePath.startsWith('.workshop/privacy/') ||
    filePath.startsWith('.workshop/terms/') ||
    filePath.startsWith('.workshop/faq/') ||
    filePath.startsWith('.workshop/sitemap/') ||
    filePath.startsWith('.workshop/developers/')
  ) {
    return true;
  }
  return (
    filePath.startsWith('.workshop/translate/') && !filePath.startsWith('.workshop/translate/dev/')
  );
}

function isRuntimeAppPath(rawPath: string): boolean {
  const filePath = normalizePath(rawPath);

  if (filePath.startsWith('src/')) return !isTestOnlySourcePath(filePath);
  // Retired local promo studies were never emitted into the hosted App bundle.
  if (filePath.startsWith('browser/auxiliary-runtime/promo/')) return false;
  if (filePath.startsWith('browser/')) return !isTestOnlySourcePath(filePath);
  if (filePath.startsWith('css/')) return true;
  if (filePath.startsWith('fonts/noto/')) return true;
  if (filePath.startsWith('fonts/inter/')) return true;
  if (filePath.startsWith('fonts/app/')) return true;
  if (filePath.startsWith('public/')) return true;
  if (isPublicWorkshopPath(filePath)) return true;

  return new Set([
    'index.html',
    // vite.config.ts build helpers whose values reach the emitted App: the
    // JavaScript and CSS browser targets and the locale recovery assets. The
    // config's dev-server, chunk-warning, and auxiliary-asset helpers are not
    // listed, matching the App release paths in release-deployment-state.
    'scripts/browser-target.ts',
    'scripts/locale-recovery-assets.ts',
    'scripts/classic-runtime-assets.ts',
    'scripts/translation-catalog.ts',
    'scripts/translation-catalog-assets.ts',
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

const scriptModulePattern = /\.[cm]?[jt]sx?$/u;
const declarationFilePattern = /\.d\.[cm]?ts$/u;
const resolvableSuffixes = ['.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts'] as const;

function isScriptModule(filePath: string): boolean {
  return scriptModulePattern.test(filePath) && !declarationFilePattern.test(filePath);
}

// Every authored browser source the App build can bundle. Seeding the graph
// from all of them, not only from the build entries, matches how the guard
// already counts every non-test src/ and browser/ file as runtime, and it does
// not depend on this script knowing every Vite, classic-runtime, or UI-kit
// entry.
function isBundledSourceRoot(filePath: string): boolean {
  if (filePath === 'index.html') return true;
  if (!isScriptModule(filePath) && !filePath.endsWith('.html')) return false;
  if (isTestOnlySourcePath(filePath)) return false;
  if (filePath.startsWith('src/')) return true;
  if (filePath.startsWith('browser/auxiliary-runtime/promo/')) return false;
  if (filePath.startsWith('browser/')) return true;
  return isPublicWorkshopPath(filePath);
}

function isImportMetaUrl(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'url' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === 'meta'
  );
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/u.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

// Specifiers whose target the bundler emits: value imports and re-exports,
// side-effect imports, import() calls, and new URL(..., import.meta.url)
// assets. Whole-statement type-only imports and re-exports emit nothing.
// Comments never count: the TypeScript AST has no nodes for them, and HTML
// comments are removed before script sources are read.
function moduleReferences(filePath: string, source: string): string[] {
  if (filePath.endsWith('.html')) {
    const markup = source.replace(/<!--[\s\S]*?-->/gu, '');
    return [...markup.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/giu)].flatMap(
      (match) => (match[1] === undefined ? [] : [match[1]]),
    );
  }

  const references: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const typeOnly = node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
      if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        references.push(node.moduleSpecifier.text);
      }
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        references.push(node.moduleSpecifier.text);
      }
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier)) references.push(specifier.text);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL'
    ) {
      const [specifier, base] = node.arguments ?? [];
      if (specifier && base && ts.isStringLiteralLike(specifier) && isImportMetaUrl(base)) {
        references.push(specifier.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(
    ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, false, scriptKindFor(filePath)),
  );
  return references;
}

function resolveReference(
  importer: string,
  specifier: string,
  trackedFiles: ReadonlySet<string>,
): string | null {
  const bare = specifier.replace(/[?#].*$/su, '');
  let candidate: string;
  if (bare.startsWith('./') || bare.startsWith('../')) {
    candidate = path.posix.normalize(path.posix.join(path.posix.dirname(importer), bare));
  } else if (importer.endsWith('.html') && bare.startsWith('/') && !bare.startsWith('//')) {
    // Vite resolves root-relative HTML script sources from the project root.
    candidate = bare.slice(1);
  } else {
    // Packages, absolute URLs, and runtime paths are not repository files.
    return null;
  }
  if (candidate.startsWith('../')) return null;

  const options = [
    candidate,
    ...resolvableSuffixes.map((suffix) => `${candidate}${suffix}`),
    candidate.replace(/\.js$/u, '.ts'),
  ];
  return options.find((option) => trackedFiles.has(option)) ?? null;
}

function readBlobs(
  repoRoot: string,
  commit: string,
  filePaths: readonly string[],
): Map<string, string> {
  const blobs = new Map<string, string>();
  if (filePaths.length === 0) return blobs;

  let output: Buffer;
  try {
    output = execFileSync('git', ['cat-file', '--batch'], {
      cwd: repoRoot,
      input: filePaths.map((filePath) => `${commit}:${filePath}\n`).join(''),
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = commandStderr(error);
    throw new GuardError(`git cat-file --batch failed${detail ? `: ${detail}` : ''}`);
  }

  let offset = 0;
  for (const filePath of filePaths) {
    const headerEnd = output.indexOf(0x0a, offset);
    const header = headerEnd < 0 ? '' : output.toString('utf8', offset, headerEnd);
    const size = /^[0-9a-f]+ blob (\d+)$/u.exec(header)?.[1];
    if (size === undefined) {
      throw new GuardError(`Cannot read ${filePath} at ${commit} (git cat-file: "${header}").`);
    }
    const start = headerEnd + 1;
    const end = start + Number(size);
    blobs.set(filePath, output.toString('utf8', start, end));
    offset = end + 1;
  }
  return blobs;
}

/**
 * Files outside the runtime trees that the App bundle compiles in at a
 * revision: every repository file the browser sources reach through value
 * imports, transitively, which the path rules above do not already count.
 */
export function bundledSupportPathsAt(repoRoot: string, revision: string): string[] {
  const commit = git(repoRoot, ['rev-parse', '--verify', `${revision}^{commit}`]);
  const trackedFiles = new Set(
    git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit])
      .split('\0')
      .filter(Boolean),
  );

  let frontier = [...trackedFiles].filter(isBundledSourceRoot);
  const visited = new Set(frontier);
  const supportPaths = new Set<string>();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const [importer, source] of readBlobs(repoRoot, commit, frontier)) {
      for (const specifier of moduleReferences(importer, source)) {
        const target = resolveReference(importer, specifier, trackedFiles);
        if (target === null || visited.has(target)) continue;
        visited.add(target);
        if (!isRuntimeAppPath(target)) supportPaths.add(target);
        if (isScriptModule(target)) next.push(target);
      }
    }
    frontier = next;
  }
  return [...supportPaths].sort();
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
  // A file the bundle compiled in at either end of the range changed the
  // cached assets, or stopped being one of them.
  const bundledSupportPaths = changedPaths.some((filePath) => !isRuntimeAppPath(filePath))
    ? new Set([
        ...bundledSupportPathsAt(repoRoot, latestBump.commit),
        ...bundledSupportPathsAt(repoRoot, headCommit),
      ])
    : new Set<string>();
  const runtimePaths = changedPaths.filter(
    (filePath) =>
      !(filePath === packageJsonPath && allowStaticHeaderBuildPolicy) &&
      (isRuntimeAppPath(filePath) || bundledSupportPaths.has(filePath)),
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
