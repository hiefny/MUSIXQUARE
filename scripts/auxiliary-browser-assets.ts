import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';
import type { Plugin } from 'vite';

import { useAsyncConnectMiddleware } from './async-connect-middleware.ts';

export const AUXILIARY_BROWSER_SOURCE_DIRECTORY = 'browser/auxiliary-runtime';
export const AUXILIARY_BROWSER_DECLARATION_PATH = `${AUXILIARY_BROWSER_SOURCE_DIRECTORY}/remote-modules.d.ts`;
export const AUXILIARY_BROWSER_SUPPORT_SOURCES = [
  `${AUXILIARY_BROWSER_SOURCE_DIRECTORY}/promo/product-hero-runtime.ts`,
] as const;

export interface AuxiliaryBrowserAsset {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly htmlPath: string;
  readonly scriptType: 'classic' | 'module';
  readonly materializeForFileUrl?: boolean;
}

export interface CompiledAuxiliaryBrowserAsset extends AuxiliaryBrowserAsset {
  readonly code: string;
}

export const AUXILIARY_BROWSER_ASSETS = [
  {
    sourcePath: 'browser/auxiliary-runtime/promo/logo-animation.ts',
    outputPath: '.workshop/promo/scenes/logo-animation.js',
    htmlPath: '.workshop/promo/scenes/logo-animation.html',
    scriptType: 'classic',
  },
  {
    sourcePath: 'browser/auxiliary-runtime/promo/music-note-3d.ts',
    outputPath: '.workshop/promo/scenes/music-note-3d.js',
    htmlPath: '.workshop/promo/scenes/music-note-3d.html',
    scriptType: 'module',
  },
  {
    sourcePath: 'browser/auxiliary-runtime/promo/product-hero-2.ts',
    outputPath: '.workshop/promo/scenes/product-hero-2.js',
    htmlPath: '.workshop/promo/scenes/product-hero-2.html',
    scriptType: 'module',
  },
  {
    sourcePath: 'browser/auxiliary-runtime/promo/product-hero.ts',
    outputPath: '.workshop/promo/scenes/product-hero.js',
    htmlPath: '.workshop/promo/scenes/product-hero.html',
    scriptType: 'module',
  },
  {
    sourcePath: 'browser/auxiliary-runtime/promo/ui-showcase-2.ts',
    outputPath: '.workshop/promo/scenes/ui-showcase-2.js',
    htmlPath: '.workshop/promo/scenes/ui-showcase-2.html',
    scriptType: 'module',
  },
  {
    sourcePath: 'browser/auxiliary-runtime/promo/ui-showcase.ts',
    outputPath: '.workshop/promo/scenes/ui-showcase.js',
    htmlPath: '.workshop/promo/scenes/ui-showcase.html',
    scriptType: 'classic',
  },
  {
    sourcePath: 'browser/auxiliary-runtime/report-viewer.ts',
    outputPath: 'e2e/report-viewer.js',
    htmlPath: 'e2e/report-viewer.html',
    scriptType: 'classic',
    materializeForFileUrl: true,
  },
] as const satisfies readonly AuxiliaryBrowserAsset[];

const NON_EXECUTABLE_SCRIPT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'importmap',
  'speculationrules',
]);

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function assertRelativePath(value: string, extension: '.html' | '.js' | '.ts'): void {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    path.posix.normalize(value) !== value ||
    value.split('/').includes('..') ||
    path.posix.extname(value) !== extension
  ) {
    throw new Error(`Invalid auxiliary-browser ${extension} path: ${value}`);
  }
}

function scriptType(attributes: string): string {
  const match = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(attributes);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim().toLowerCase();
}

function executableInlineScriptCount(html: string): number {
  let count = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    if (body.trim().length === 0 || /\bsrc\s*=/iu.test(attributes)) continue;
    if (NON_EXECUTABLE_SCRIPT_TYPES.has(scriptType(attributes))) continue;
    count += 1;
  }
  return count;
}

function expectedScriptSource(asset: AuxiliaryBrowserAsset): string {
  return `./${path.posix.basename(asset.outputPath)}`;
}

export function assertAuxiliaryBrowserHtmlContract(
  asset: AuxiliaryBrowserAsset,
  html: string,
): void {
  if (executableInlineScriptCount(html) !== 0) {
    throw new Error(`${asset.htmlPath} retains executable inline JavaScript.`);
  }
  const source = expectedScriptSource(asset);
  const matches = [
    ...html.matchAll(/<script\b([^>]*)\bsrc=(['"])(.*?)\2([^>]*)><\/script\s*>/giu),
  ].filter((match) => match[3] === source);
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`${asset.htmlPath} must load ${source} exactly once.`);
  }
  const attributes = `${matches[0][1] ?? ''} ${matches[0][4] ?? ''}`;
  const actualType = scriptType(attributes);
  if (asset.scriptType === 'module' && actualType !== 'module') {
    throw new Error(`${asset.htmlPath} must load ${source} as type=module.`);
  }
  if (asset.scriptType === 'classic' && actualType !== '') {
    throw new Error(`${asset.htmlPath} must load ${source} as a classic script.`);
  }
}

async function filesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(absolutePath)));
    else if (entry.isFile()) files.push(absolutePath);
    else throw new Error(`Auxiliary-browser ownership contains unsupported entry: ${absolutePath}`);
  }
  return files;
}

function sortedDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

export function assertAuxiliaryBrowserManifest(
  entries: readonly AuxiliaryBrowserAsset[] = AUXILIARY_BROWSER_ASSETS,
): void {
  if (entries.length === 0) throw new Error('Auxiliary-browser manifest is empty.');
  const sources = new Set<string>();
  const outputs = new Set<string>();
  const htmlPaths = new Set<string>();
  for (const entry of entries) {
    assertRelativePath(entry.sourcePath, '.ts');
    assertRelativePath(entry.outputPath, '.js');
    assertRelativePath(entry.htmlPath, '.html');
    if (!entry.sourcePath.startsWith(`${AUXILIARY_BROWSER_SOURCE_DIRECTORY}/`)) {
      throw new Error(
        `Auxiliary-browser source is outside its owned directory: ${entry.sourcePath}`,
      );
    }
    if (sources.has(entry.sourcePath)) throw new Error(`Duplicate source: ${entry.sourcePath}`);
    if (outputs.has(entry.outputPath)) throw new Error(`Duplicate output: ${entry.outputPath}`);
    if (htmlPaths.has(entry.htmlPath)) throw new Error(`Duplicate HTML owner: ${entry.htmlPath}`);
    sources.add(entry.sourcePath);
    outputs.add(entry.outputPath);
    htmlPaths.add(entry.htmlPath);
  }
}

export async function assertAuxiliaryBrowserSourceCompleteness(
  repoRoot: string,
  entries: readonly AuxiliaryBrowserAsset[] = AUXILIARY_BROWSER_ASSETS,
): Promise<void> {
  assertAuxiliaryBrowserManifest(entries);
  const ownedDirectory = path.resolve(repoRoot, AUXILIARY_BROWSER_SOURCE_DIRECTORY);
  const ownedStat = await stat(ownedDirectory);
  if (!ownedStat.isDirectory()) throw new Error(`Missing source directory: ${ownedDirectory}`);
  const ownedFiles = await filesBelow(ownedDirectory);
  const ownedPaths = ownedFiles.map((file) => toPosixPath(path.relative(repoRoot, file)));
  const discovered = new Set(
    ownedPaths.filter((file) => file !== AUXILIARY_BROWSER_DECLARATION_PATH),
  );
  const unsupported = [...discovered].filter((file) => path.posix.extname(file) !== '.ts').sort();
  const expected = new Set([
    ...entries.map((entry) => entry.sourcePath),
    ...AUXILIARY_BROWSER_SUPPORT_SOURCES,
  ]);
  const unmanaged = sortedDifference(discovered, expected);
  const missing = sortedDifference(expected, discovered);
  const declarations = ownedPaths.filter((file) => file.endsWith('.d.ts'));
  if (
    unsupported.length > 0 ||
    unmanaged.length > 0 ||
    missing.length > 0 ||
    declarations.length !== 1 ||
    declarations[0] !== AUXILIARY_BROWSER_DECLARATION_PATH
  ) {
    throw new Error(
      `Auxiliary-browser source/manifest mismatch:\n${[
        ...unsupported.map((file) => `  unsupported: ${file}`),
        ...unmanaged.map((file) => `  unmanaged: ${file}`),
        ...missing.map((file) => `  missing: ${file}`),
        ...(declarations.length === 1 && declarations[0] === AUXILIARY_BROWSER_DECLARATION_PATH
          ? []
          : [`  declaration ownership: ${declarations.join(', ') || 'missing'}`]),
      ].join('\n')}`,
    );
  }
  await Promise.all(
    entries.map(async (entry) => {
      const html = await readFile(path.resolve(repoRoot, entry.htmlPath), 'utf8');
      assertAuxiliaryBrowserHtmlContract(entry, html);
    }),
  );
}

export function assertAuxiliaryBrowserJavaScript(asset: AuxiliaryBrowserAsset, code: string): void {
  if (/\/\/[#@]\s*sourceMappingURL=/u.test(code)) {
    throw new Error(`Auxiliary-browser output contains a sourcemap: ${asset.outputPath}`);
  }
  if (asset.scriptType === 'classic') {
    if (/^\s*(?:import|export)\b/mu.test(code)) {
      throw new Error(`Classic auxiliary output contains module syntax: ${asset.outputPath}`);
    }
    Function(code);
  }
}

export async function compileAuxiliaryBrowserAsset(
  repoRoot: string,
  asset: AuxiliaryBrowserAsset,
): Promise<CompiledAuxiliaryBrowserAsset> {
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.resolve(repoRoot, asset.sourcePath)],
    bundle: true,
    write: false,
    format: asset.scriptType === 'module' ? 'esm' : 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: false,
    minify: false,
    legalComments: 'inline',
    charset: 'utf8',
    treeShaking: false,
    external: ['https://*'],
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (!output || result.outputFiles.length !== 1) {
    throw new Error(`Expected one compiled output for ${asset.sourcePath}.`);
  }
  const code = output.text;
  assertAuxiliaryBrowserJavaScript(asset, code);
  return { ...asset, code };
}

export async function compileAuxiliaryBrowserAssets(
  repoRoot: string,
  entries: readonly AuxiliaryBrowserAsset[] = AUXILIARY_BROWSER_ASSETS,
): Promise<CompiledAuxiliaryBrowserAsset[]> {
  await assertAuxiliaryBrowserSourceCompleteness(repoRoot, entries);
  return Promise.all(entries.map((entry) => compileAuxiliaryBrowserAsset(repoRoot, entry)));
}

export function auxiliaryBrowserAssetForRequestUrl(
  rawUrl: string,
  entries: readonly AuxiliaryBrowserAsset[] = AUXILIARY_BROWSER_ASSETS,
): AuxiliaryBrowserAsset | null {
  let pathname = '';
  try {
    pathname = new URL(rawUrl, 'http://vite.local').pathname;
  } catch {
    return null;
  }
  return entries.find((entry) => pathname === `/${entry.outputPath}`) ?? null;
}

export async function materializeFileUrlAuxiliaryAssets(repoRoot: string): Promise<string[]> {
  const assets = AUXILIARY_BROWSER_ASSETS.filter(
    (asset) => 'materializeForFileUrl' in asset && asset.materializeForFileUrl,
  );
  await assertAuxiliaryBrowserSourceCompleteness(repoRoot);
  const compiled = await Promise.all(
    assets.map((asset) => compileAuxiliaryBrowserAsset(repoRoot, asset)),
  );
  await Promise.all(
    compiled.map((asset) =>
      writeFile(path.resolve(repoRoot, asset.outputPath), asset.code, 'utf8'),
    ),
  );
  return compiled.map((asset) => asset.outputPath);
}

export function auxiliaryBrowserAssets(): Plugin {
  let repoRoot = '';
  return {
    name: 'musixquare-auxiliary-browser-assets', // brand-capitalization: allow-technical
    enforce: 'pre',
    configResolved(config) {
      repoRoot = config.root;
    },
    async configureServer(server) {
      await assertAuxiliaryBrowserSourceCompleteness(server.config.root);
      useAsyncConnectMiddleware(server.middlewares, async (request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          next();
          return;
        }
        const asset = auxiliaryBrowserAssetForRequestUrl(request.url ?? '');
        if (!asset) {
          next();
          return;
        }
        try {
          const compiled = await compileAuxiliaryBrowserAsset(server.config.root, asset);
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          response.setHeader('Cache-Control', 'no-cache');
          response.end(request.method === 'HEAD' ? undefined : compiled.code);
        } catch (error) {
          next(error);
        }
      });
    },
    async buildStart() {
      await compileAuxiliaryBrowserAssets(repoRoot);
    },
  };
}
