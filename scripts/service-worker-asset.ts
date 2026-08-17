import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { transformWithEsbuild } from 'vite';

export const SERVICE_WORKER_SOURCE_PATH = 'browser/service-worker.ts';
export const SERVICE_WORKER_OUTPUT_PATH = 'service-worker.js';
export const SERVICE_WORKER_CACHE_VERSION = 'v450';
export const CLASSIC_BOOTSTRAP_CACHE_VERSION = 'v449';
export const SERVICE_WORKER_CACHE_VERSION_SENTINEL = '__MUSIXQUARE_CACHE_VERSION__';
export const BUILD_ENTRY_ASSETS_MARKER = '/* __MUSIXQUARE_BUILD_ENTRY_ASSETS__ */';
export const OPTIONAL_PRIMARY_FONT_ASSETS_MARKER =
  '/* __MUSIXQUARE_OPTIONAL_PRIMARY_FONT_ASSETS__ */';

const CLASSIC_BOOTSTRAP_PUBLIC_URL = `/bootstrap.js?cache=${CLASSIC_BOOTSTRAP_CACHE_VERSION}`;
const CLASSIC_BOOTSTRAP_CACHE_KEY = `.${CLASSIC_BOOTSTRAP_PUBLIC_URL}`;
const CLASSIC_BOOTSTRAP_SOURCE_DECLARATION =
  `const BOOTSTRAP_CACHE_KEY = '${CLASSIC_BOOTSTRAP_CACHE_KEY}';`;
const COMPILED_BOOTSTRAP_DECLARATION =
  'const BOOTSTRAP_CACHE_KEY = `./bootstrap.js?cache=${CACHE_VERSION}`;';

export interface ServiceWorkerAssetManifest {
  readonly buildEntryAssets: readonly string[];
  readonly optionalPrimaryFontAssets: readonly string[];
}

export interface CompiledServiceWorkerAsset extends ServiceWorkerAssetManifest {
  readonly sourcePath: typeof SERVICE_WORKER_SOURCE_PATH;
  readonly outputPath: typeof SERVICE_WORKER_OUTPUT_PATH;
  readonly cacheVersion: typeof SERVICE_WORKER_CACHE_VERSION;
  readonly bootstrapCacheVersion: typeof CLASSIC_BOOTSTRAP_CACHE_VERSION;
  readonly bootstrapCacheKey: typeof CLASSIC_BOOTSTRAP_CACHE_KEY;
  readonly code: string;
}

function markerCount(source: string, marker: string): number {
  return source.split(marker).length - 1;
}

function assertSingleMarker(source: string, marker: string, label: string): void {
  const count = markerCount(source, marker);
  if (count !== 1) throw new Error(`Expected one service-worker ${label}, found ${count}.`);
}

function assertAssetManifest(assets: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const asset of assets) {
    if (
      !asset.startsWith('./') ||
      asset.startsWith('./../') ||
      asset.includes('\\') ||
      asset.includes('\0') ||
      asset.endsWith('.map')
    ) {
      throw new Error(`Invalid service-worker ${label} asset: ${asset}`);
    }
    if (seen.has(asset)) throw new Error(`Duplicate service-worker ${label} asset: ${asset}`);
    seen.add(asset);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertClassicBootstrapBoundary(source: string, appHtml: string): void {
  assertSingleMarker(
    source,
    CLASSIC_BOOTSTRAP_SOURCE_DECLARATION,
    'classic-bootstrap cache declaration',
  );
  assertSingleMarker(
    appHtml,
    `<script src="${CLASSIC_BOOTSTRAP_PUBLIC_URL}"></script>`,
    'classic-bootstrap HTML reference',
  );
}

export async function assertServiceWorkerSourceCompleteness(repoRoot: string): Promise<void> {
  const sourcePath = path.resolve(repoRoot, SERVICE_WORKER_SOURCE_PATH);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error(`Service-worker source is not a file: ${sourcePath}`);

  const publicJavaScript = path.resolve(repoRoot, 'public', SERVICE_WORKER_OUTPUT_PATH);
  const publicTypeScript = path.resolve(repoRoot, 'public', 'service-worker.ts');
  const shadowedPaths = (
    await Promise.all(
      [publicJavaScript, publicTypeScript].map(async (candidate) => ({
        candidate,
        exists: await pathExists(candidate),
      })),
    )
  ).filter(({ exists }) => exists);
  if (shadowedPaths.length > 0) {
    throw new Error(
      `publicDir bypasses the service-worker compiler:\n${shadowedPaths
        .map(({ candidate }) => `  shadowed: ${path.relative(repoRoot, candidate)}`)
        .join('\n')}`,
    );
  }

  const [source, appHtml] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readFile(path.resolve(repoRoot, 'index.html'), 'utf8'),
  ]);
  assertSingleMarker(source, SERVICE_WORKER_CACHE_VERSION_SENTINEL, 'cache-version sentinel');
  assertSingleMarker(source, BUILD_ENTRY_ASSETS_MARKER, 'build manifest marker');
  assertSingleMarker(source, OPTIONAL_PRIMARY_FONT_ASSETS_MARKER, 'optional font manifest marker');
  assertClassicBootstrapBoundary(source, appHtml);
}

function projectIndependentCacheIdentifiers(source: string): string {
  const appCacheSource = source.replace(/\bCACHE_VERSION\b/gu, 'SERVICE_WORKER_CACHE_VERSION');
  assertSingleMarker(
    appCacheSource,
    CLASSIC_BOOTSTRAP_SOURCE_DECLARATION,
    'classic-bootstrap cache declaration',
  );

  return appCacheSource.replace(
    CLASSIC_BOOTSTRAP_SOURCE_DECLARATION,
    `const CACHE_VERSION = '${CLASSIC_BOOTSTRAP_CACHE_VERSION}';\n${COMPILED_BOOTSTRAP_DECLARATION}`,
  );
}

export function injectServiceWorkerSource(
  source: string,
  manifest: ServiceWorkerAssetManifest,
): string {
  assertSingleMarker(source, SERVICE_WORKER_CACHE_VERSION_SENTINEL, 'cache-version sentinel');
  assertSingleMarker(source, BUILD_ENTRY_ASSETS_MARKER, 'build manifest marker');
  assertSingleMarker(source, OPTIONAL_PRIMARY_FONT_ASSETS_MARKER, 'optional font manifest marker');
  assertAssetManifest(manifest.buildEntryAssets, 'build manifest');
  assertAssetManifest(manifest.optionalPrimaryFontAssets, 'optional font manifest');

  const buildManifest = manifest.buildEntryAssets
    .map((asset) => JSON.stringify(asset))
    .join(',\n  ');
  const optionalManifest = manifest.optionalPrimaryFontAssets
    .map((asset) => JSON.stringify(asset))
    .join(',\n  ');
  return projectIndependentCacheIdentifiers(source)
    .replace(SERVICE_WORKER_CACHE_VERSION_SENTINEL, SERVICE_WORKER_CACHE_VERSION)
    .replace(BUILD_ENTRY_ASSETS_MARKER, buildManifest)
    .replace(OPTIONAL_PRIMARY_FONT_ASSETS_MARKER, optionalManifest);
}

export function assertServiceWorkerJavaScript(code: string): void {
  if (/\/\/[#@]\s*sourceMappingURL=/u.test(code)) {
    throw new Error('Service-worker output contains a sourcemap reference.');
  }
  if (/^\s*(?:import|export)\b/mu.test(code)) {
    throw new Error('Service-worker output contains module syntax.');
  }
  for (const marker of [
    SERVICE_WORKER_CACHE_VERSION_SENTINEL,
    BUILD_ENTRY_ASSETS_MARKER,
    OPTIONAL_PRIMARY_FONT_ASSETS_MARKER,
  ]) {
    if (code.includes(marker)) throw new Error(`Service-worker output retains sentinel: ${marker}`);
  }

  const appCacheVersionMatches = [
    ...code.matchAll(
      /\bconst\s+SERVICE_WORKER_CACHE_VERSION\s*=\s*['"](v\d+)['"]\s*;/gu,
    ),
  ];
  if (
    appCacheVersionMatches.length !== 1 ||
    appCacheVersionMatches[0]?.[1] !== SERVICE_WORKER_CACHE_VERSION
  ) {
    throw new Error('Service-worker output does not contain the canonical app-shell cache version.');
  }

  const bootstrapVersionMatches = [
    ...code.matchAll(/\bconst\s+CACHE_VERSION\s*=\s*['"](v\d+)['"]\s*;/gu),
  ];
  if (
    bootstrapVersionMatches.length !== 1 ||
    bootstrapVersionMatches[0]?.[1] !== CLASSIC_BOOTSTRAP_CACHE_VERSION ||
    !code.includes(COMPILED_BOOTSTRAP_DECLARATION)
  ) {
    throw new Error(
      'Service-worker output does not contain the canonical classic-bootstrap cache boundary.',
    );
  }
  Function(code);
}

export async function compileServiceWorkerAsset(
  repoRoot: string,
  manifest: ServiceWorkerAssetManifest = {
    buildEntryAssets: [],
    optionalPrimaryFontAssets: [],
  },
): Promise<CompiledServiceWorkerAsset> {
  await assertServiceWorkerSourceCompleteness(repoRoot);
  const source = await readFile(path.resolve(repoRoot, SERVICE_WORKER_SOURCE_PATH), 'utf8');
  const injectedSource = injectServiceWorkerSource(source, manifest);
  const transformed = await transformWithEsbuild(injectedSource, SERVICE_WORKER_SOURCE_PATH, {
    loader: 'ts',
    format: 'iife',
    target: 'es2022',
    sourcemap: false,
    minify: false,
    legalComments: 'inline',
    charset: 'utf8',
  });
  assertServiceWorkerJavaScript(transformed.code);
  return {
    sourcePath: SERVICE_WORKER_SOURCE_PATH,
    outputPath: SERVICE_WORKER_OUTPUT_PATH,
    cacheVersion: SERVICE_WORKER_CACHE_VERSION,
    bootstrapCacheVersion: CLASSIC_BOOTSTRAP_CACHE_VERSION,
    bootstrapCacheKey: CLASSIC_BOOTSTRAP_CACHE_KEY,
    buildEntryAssets: manifest.buildEntryAssets,
    optionalPrimaryFontAssets: manifest.optionalPrimaryFontAssets,
    code: transformed.code,
  };
}
