import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { transformWithEsbuild, type Plugin } from 'vite';

import { useAsyncConnectMiddleware } from './async-connect-middleware.ts';

export interface ClassicRuntimeAsset {
  readonly sourcePath: string;
  readonly outputPath: string;
  /** Compact an early synchronous runtime without obscuring its audited identifiers. */
  readonly minify?: boolean;
  /** Preserve an older execution floor when the historic runtime requires it. */
  readonly target?: 'es2018' | 'es2022';
}

export interface CompiledClassicRuntimeAsset extends ClassicRuntimeAsset {
  readonly code: string;
}

/**
 * The single source of truth for synchronous, non-module browser runtimes.
 * Output paths deliberately match their historic public URLs byte-for-byte.
 */
export const CLASSIC_RUNTIME_ASSETS = [
  {
    sourcePath: 'browser/classic-runtime/account-complete.ts',
    outputPath: 'account-complete.js',
    target: 'es2018',
  },
  {
    sourcePath: 'browser/classic-runtime/admin.ts',
    outputPath: 'admin.js',
  },
  {
    sourcePath: 'browser/classic-runtime/analytics-bootstrap.ts',
    outputPath: 'analytics-bootstrap.js',
  },
  {
    sourcePath: 'browser/classic-runtime/blog-pagination.ts',
    outputPath: 'blog-pagination.js',
  },
  {
    sourcePath: 'browser/classic-runtime/clearable-editors.ts',
    outputPath: 'clearable-editors.js',
  },
  {
    sourcePath: 'browser/classic-runtime/bootstrap.ts',
    outputPath: 'bootstrap.js',
    minify: true,
    target: 'es2018',
  },
  {
    sourcePath: 'browser/classic-runtime/editorial-pages.ts',
    outputPath: 'editorial-pages.js',
  },
  {
    sourcePath: 'browser/classic-runtime/events/event.ts',
    outputPath: 'events/event.js',
  },
  {
    sourcePath: 'browser/classic-runtime/events/theme.ts',
    outputPath: 'events/theme.js',
  },
  {
    sourcePath: 'browser/classic-runtime/fouc-cleanup.ts',
    outputPath: 'fouc-cleanup.js',
    target: 'es2018',
  },
  {
    sourcePath: 'browser/classic-runtime/landing-bootstrap.ts',
    outputPath: 'landing-bootstrap.js',
  },
  {
    sourcePath: 'browser/classic-runtime/landing-i18n.ts',
    outputPath: 'landing-i18n.js',
  },
  {
    sourcePath: 'browser/classic-runtime/policy-accordion.ts',
    outputPath: 'policy-accordion.js',
  },
  {
    sourcePath: 'browser/classic-runtime/primary-font-loader.ts',
    outputPath: 'primary-font-loader.js',
    target: 'es2018',
  },
  {
    sourcePath: 'browser/classic-runtime/static-language.ts',
    outputPath: 'static-language.js',
  },
  {
    sourcePath: 'browser/classic-runtime/wordmark-anim.ts',
    outputPath: 'wordmark-anim.js',
    target: 'es2018',
  },
] as const satisfies readonly ClassicRuntimeAsset[];

const CLASSIC_RUNTIME_SOURCE_DIRECTORY = 'browser/classic-runtime';

function toPosixPath(value: string): string {
  return value.replace(/\\/gu, '/');
}

function assertRelativeManifestPath(value: string, extension: '.ts' | '.js'): void {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    path.posix.normalize(value) !== value ||
    value.split('/').includes('..') ||
    path.posix.extname(value) !== extension
  ) {
    throw new Error(`Invalid classic-runtime ${extension} manifest path: ${value}`);
  }
}

export function assertClassicRuntimeManifest(
  entries: readonly ClassicRuntimeAsset[] = CLASSIC_RUNTIME_ASSETS,
): void {
  if (entries.length === 0) throw new Error('Classic-runtime manifest is empty.');

  const sourcePaths = new Set<string>();
  const outputPaths = new Set<string>();
  for (const entry of entries) {
    assertRelativeManifestPath(entry.sourcePath, '.ts');
    assertRelativeManifestPath(entry.outputPath, '.js');
    if (!entry.sourcePath.startsWith(`${CLASSIC_RUNTIME_SOURCE_DIRECTORY}/`)) {
      throw new Error(`Classic-runtime source is outside its owned directory: ${entry.sourcePath}`);
    }
    if (sourcePaths.has(entry.sourcePath)) {
      throw new Error(`Duplicate classic-runtime source: ${entry.sourcePath}`);
    }
    if (outputPaths.has(entry.outputPath)) {
      throw new Error(`Duplicate classic-runtime output: ${entry.outputPath}`);
    }
    sourcePaths.add(entry.sourcePath);
    outputPaths.add(entry.outputPath);
  }
}

async function filesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    } else {
      throw new Error(`Classic-runtime ownership contains an unsupported entry: ${absolutePath}`);
    }
  }
  return files;
}

function sortedDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

/**
 * Fail closed when a TS source is not in the manifest, a manifest source is
 * absent, or publicDir contains raw/generated copies that could bypass Vite.
 */
export async function assertClassicRuntimeSourceCompleteness(
  repoRoot: string,
  entries: readonly ClassicRuntimeAsset[] = CLASSIC_RUNTIME_ASSETS,
): Promise<void> {
  assertClassicRuntimeManifest(entries);

  const ownedDirectory = path.resolve(repoRoot, CLASSIC_RUNTIME_SOURCE_DIRECTORY);
  const ownedStat = await stat(ownedDirectory);
  if (!ownedStat.isDirectory()) {
    throw new Error(`Classic-runtime source directory is missing: ${ownedDirectory}`);
  }

  const ownedFiles = await filesBelow(ownedDirectory);
  const unsupportedSources = ownedFiles
    .filter((file) => path.extname(file) !== '.ts')
    .map((file) => toPosixPath(path.relative(repoRoot, file)))
    .sort();
  if (unsupportedSources.length > 0) {
    throw new Error(
      `Classic-runtime source ownership contains unsupported files:\n${unsupportedSources
        .map((sourcePath) => `  unsupported: ${sourcePath}`)
        .join('\n')}`,
    );
  }

  const discoveredSources = new Set(
    ownedFiles.map((file) => toPosixPath(path.relative(repoRoot, file))),
  );
  const manifestSources = new Set(entries.map((entry) => entry.sourcePath));
  const unmanaged = sortedDifference(discoveredSources, manifestSources);
  const missing = sortedDifference(manifestSources, discoveredSources);
  if (unmanaged.length > 0 || missing.length > 0) {
    const details = [
      ...unmanaged.map((sourcePath) => `  unmanaged: ${sourcePath}`),
      ...missing.map((sourcePath) => `  missing: ${sourcePath}`),
    ];
    throw new Error(`Classic-runtime source/manifest mismatch:\n${details.join('\n')}`);
  }

  const publicDirectory = path.resolve(repoRoot, 'public');
  const publicFiles = new Set(
    (await filesBelow(publicDirectory)).map((file) =>
      toPosixPath(path.relative(publicDirectory, file)),
    ),
  );
  const rawTypeScript = [...publicFiles].filter((file) => path.posix.extname(file) === '.ts');
  const shadowedOutputs = entries
    .map((entry) => entry.outputPath)
    .filter((outputPath) => publicFiles.has(outputPath));
  if (rawTypeScript.length > 0 || shadowedOutputs.length > 0) {
    const details = [
      ...rawTypeScript.sort().map((file) => `  raw TypeScript: public/${file}`),
      ...shadowedOutputs.sort().map((file) => `  shadowed output: public/${file}`),
    ];
    throw new Error(`publicDir bypasses the classic-runtime compiler:\n${details.join('\n')}`);
  }
}

export function assertClassicRuntimeJavaScript(asset: ClassicRuntimeAsset, code: string): void {
  if (/\/\/[#@]\s*sourceMappingURL=/u.test(code)) {
    throw new Error(`Classic-runtime output contains a sourcemap reference: ${asset.outputPath}`);
  }
  if (/^\s*(?:import|export)\b/mu.test(code)) {
    throw new Error(`Classic-runtime output contains module syntax: ${asset.outputPath}`);
  }
  // Compilation is also a syntax check for execution as an ordinary classic script.
  Function(code);
}

export async function compileClassicRuntimeAsset(
  repoRoot: string,
  asset: ClassicRuntimeAsset,
): Promise<CompiledClassicRuntimeAsset> {
  const source = await readFile(path.resolve(repoRoot, asset.sourcePath), 'utf8');
  const transformed = await transformWithEsbuild(source, asset.sourcePath, {
    loader: 'ts',
    format: 'iife',
    target: asset.target ?? 'es2022',
    sourcemap: false,
    minifyWhitespace: asset.minify ?? false,
    minifySyntax: asset.minify ?? false,
    minifyIdentifiers: false,
    legalComments: 'inline',
    charset: 'utf8',
  });
  assertClassicRuntimeJavaScript(asset, transformed.code);
  return { ...asset, code: transformed.code };
}

export async function compileClassicRuntimeAssets(
  repoRoot: string,
  entries: readonly ClassicRuntimeAsset[] = CLASSIC_RUNTIME_ASSETS,
): Promise<CompiledClassicRuntimeAsset[]> {
  await assertClassicRuntimeSourceCompleteness(repoRoot, entries);
  return Promise.all(entries.map((entry) => compileClassicRuntimeAsset(repoRoot, entry)));
}

export function classicRuntimeAssetForRequestUrl(
  rawUrl: string,
  entries: readonly ClassicRuntimeAsset[] = CLASSIC_RUNTIME_ASSETS,
): ClassicRuntimeAsset | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, 'http://vite.local').pathname;
  } catch {
    return null;
  }
  return entries.find((entry) => pathname === `/${entry.outputPath}`) ?? null;
}

function assetSourceText(source: string | Uint8Array): string {
  return typeof source === 'string' ? source : new TextDecoder().decode(source);
}

/**
 * Serve TS-backed classic scripts in development and emit the same stable URLs
 * as exact Rollup assets in production. No source map or tracked generated JS
 * is involved in either path.
 */
export function classicRuntimeAssets(): Plugin {
  let repoRoot = '';
  let productionBuild = false;
  let compiledAssets: CompiledClassicRuntimeAsset[] = [];

  return {
    name: 'musixquare-classic-runtime-assets', // brand-capitalization: allow-technical
    enforce: 'pre',
    configResolved(config) {
      repoRoot = config.root;
      productionBuild = config.command === 'build';
    },
    async configureServer(server) {
      await assertClassicRuntimeSourceCompleteness(server.config.root);
      useAsyncConnectMiddleware(server.middlewares, async (request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          next();
          return;
        }
        const asset = classicRuntimeAssetForRequestUrl(request.url ?? '');
        if (!asset) {
          next();
          return;
        }
        try {
          const { code } = await compileClassicRuntimeAsset(server.config.root, asset);
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          response.setHeader('Cache-Control', 'no-cache');
          response.end(request.method === 'HEAD' ? undefined : code);
        } catch (error) {
          next(error);
        }
      });
    },
    async buildStart() {
      if (!productionBuild) return;
      compiledAssets = await compileClassicRuntimeAssets(repoRoot);
      for (const asset of compiledAssets) {
        this.emitFile({ type: 'asset', fileName: asset.outputPath, source: asset.code });
      }
    },
    generateBundle(_options, bundle) {
      for (const expected of compiledAssets) {
        const output = bundle[expected.outputPath];
        if (!output || output.type !== 'asset') {
          this.error(`Classic-runtime build output is missing: ${expected.outputPath}`);
        }
        if (assetSourceText(output.source) !== expected.code) {
          this.error(
            `Classic-runtime build output drifted after compilation: ${expected.outputPath}`,
          );
        }
        assertClassicRuntimeJavaScript(expected, expected.code);
        if (bundle[`${expected.outputPath}.map`]) {
          this.error(`Classic-runtime sourcemap must not be emitted: ${expected.outputPath}.map`);
        }
      }
    },
  };
}
