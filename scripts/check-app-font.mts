#!/usr/bin/env node
/** Guard the complete Pretendard app font, fallback stacks, and built artifact. */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASSIC_RUNTIME_ASSETS, compileClassicRuntimeAsset } from './classic-runtime-assets.ts';
import {
  OPTIONAL_PRIMARY_FONT_ASSETS_MARKER,
  SERVICE_WORKER_SOURCE_PATH,
  compileServiceWorkerAsset,
} from './service-worker-asset.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distMode = process.argv.includes('--dist');
const fontUrl = '/designsystem/fonts/PretendardVariable.woff2';
const sourceFontPath = path.join(repoRoot, 'fonts', 'PretendardVariable.woff2');
const publicFontPath = path.join(
  repoRoot,
  'public',
  'designsystem',
  'fonts',
  'PretendardVariable.woff2',
);
const failures: string[] = [];
const lazyFontShards = [
  { label: 'Arabic', family: 'Noto Sans Arabic', source: 'noto-arabic.css' },
  { label: 'Bengali', family: 'Noto Sans Bengali', source: 'noto-bengali.css' },
  { label: 'Cyrillic', family: 'Noto Sans', source: 'noto-cyrillic.css' },
  { label: 'Devanagari', family: 'Noto Sans Devanagari', source: 'noto-devanagari.css' },
  { label: 'Greek', family: 'Noto Sans', source: 'noto-greek.css' },
  { label: 'Gujarati', family: 'Noto Sans Gujarati', source: 'noto-gujarati.css' },
  { label: 'Gurmukhi', family: 'Noto Sans Gurmukhi', source: 'noto-gurmukhi.css' },
  { label: 'Hebrew', family: 'Noto Sans Hebrew', source: 'noto-hebrew.css' },
  { label: 'Japanese', family: 'Noto Sans JP', source: 'noto-jp.css' },
  { label: 'Kannada', family: 'Noto Sans Kannada', source: 'noto-kannada.css' },
  { label: 'Malayalam', family: 'Noto Sans Malayalam', source: 'noto-malayalam.css' },
  { label: 'Simplified Chinese', family: 'Noto Sans SC', source: 'noto-sc.css' },
  { label: 'Tamil', family: 'Noto Sans Tamil', source: 'noto-tamil.css' },
  { label: 'Traditional Chinese', family: 'Noto Sans TC', source: 'noto-tc.css' },
  { label: 'Telugu', family: 'Noto Sans Telugu', source: 'noto-telugu.css' },
  { label: 'Thai', family: 'Noto Sans Thai', source: 'noto-thai.css' },
] as const;

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function hasFontPreload(html: string): boolean {
  return [...html.matchAll(/<link\b[^>]*>/giu)].some((match) => {
    const tag = match[0];
    return (
      /\brel=["']preload["']/iu.test(tag) &&
      tag.includes(`href="${fontUrl}"`) &&
      /\bas=["']font["']/iu.test(tag) &&
      /\btype=["']font\/woff2["']/iu.test(tag) &&
      /\bcrossorigin(?:\s|=|>)/iu.test(tag)
    );
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function hasFontFace(css: string, family: string): boolean {
  return new RegExp(
    `@font-face\\s*\\{[^}]*font-family\\s*:\\s*["']?${escapeRegExp(family)}["']?\\s*;`,
    'iu',
  ).test(css);
}

function collectInitialAssetUrls(html: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/<(?:link|script)\b[^>]*>/giu)) {
    const url = /\b(?:href|src)=["']([^"']+)["']/iu.exec(match[0])?.[1];
    if (url) urls.push(url);
  }
  return urls;
}

function collectStylesheetUrls(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*>/giu)]
    .map((match) => match[0])
    .filter((tag) => /\brel=["']stylesheet["']/iu.test(tag))
    .map((tag) => /\bhref=["']([^"']+)["']/iu.exec(tag)?.[1] || '')
    .filter(Boolean);
}

function localDistAssetPath(distDirectory: string, assetUrl: string): string | null {
  if (!assetUrl.startsWith('/') || assetUrl.startsWith('//')) return null;
  const [rawPathname] = assetUrl.split(/[?#]/u, 1);
  if (rawPathname === undefined) return null;
  const pathname = decodeURIComponent(rawPathname).replace(/^\/+/, '');
  if (!pathname || pathname.includes('..')) return null;
  return path.join(distDirectory, ...pathname.split('/'));
}

function localCssAssetPath(
  distDirectory: string,
  stylesheetPath: string,
  assetUrl: string,
): string | null {
  if (/^(?:data|https?):/iu.test(assetUrl)) return null;
  const [rawPathname] = assetUrl.split(/[?#]/u, 1);
  if (!rawPathname) return null;
  let target: string;
  try {
    target = rawPathname.startsWith('/')
      ? path.join(distDirectory, ...decodeURIComponent(rawPathname).replace(/^\/+/, '').split('/'))
      : path.resolve(path.dirname(stylesheetPath), decodeURIComponent(rawPathname));
  } catch {
    return null;
  }
  const relative = path.relative(distDirectory, target);
  return relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? null
    : target;
}

async function collectFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(target)));
    else files.push(target);
  }
  return files;
}

const primaryFontRuntimeAsset = CLASSIC_RUNTIME_ASSETS.find(
  ({ outputPath }) => outputPath === 'primary-font-loader.js',
);
if (!primaryFontRuntimeAsset) {
  throw new Error('Classic-runtime manifest omits primary-font-loader.js');
}
const bootstrapRuntimeAsset = CLASSIC_RUNTIME_ASSETS.find(
  ({ outputPath }) => outputPath === 'bootstrap.js',
);
if (!bootstrapRuntimeAsset) {
  throw new Error('Classic-runtime manifest omits bootstrap.js');
}

const [
  sourceFont,
  publicFont,
  fontCss,
  primaryFontCss,
  primaryFontRuntime,
  styleCss,
  bootstrapSource,
  appHtml,
  landingHtml,
  blogHtml,
  historyHtml,
  designSystemHtml,
  serviceWorkerSource,
  serviceWorker,
  packageJson,
] = await Promise.all([
  readFile(sourceFontPath),
  readFile(publicFontPath),
  readFile(path.join(repoRoot, 'css', 'pretendard.css'), 'utf8'),
  readFile(path.join(repoRoot, 'public', 'primary-font.css'), 'utf8'),
  compileClassicRuntimeAsset(repoRoot, primaryFontRuntimeAsset).then(({ code }) => code),
  readFile(path.join(repoRoot, 'css', 'style.css'), 'utf8'),
  compileClassicRuntimeAsset(repoRoot, bootstrapRuntimeAsset).then(({ code }) => code),
  readFile(path.join(repoRoot, 'index.html'), 'utf8'),
  readFile(path.join(repoRoot, '.workshop', 'landing', 'landing.html'), 'utf8'),
  readFile(path.join(repoRoot, 'public', 'blog', 'index.html'), 'utf8'),
  readFile(path.join(repoRoot, 'public', 'history', 'index.html'), 'utf8'),
  readFile(path.join(repoRoot, 'public', 'designsystem', 'index.html'), 'utf8'),
  readFile(path.join(repoRoot, SERVICE_WORKER_SOURCE_PATH), 'utf8'),
  compileServiceWorkerAsset(repoRoot).then(({ code }) => code),
  readFile(path.join(repoRoot, 'package.json'), 'utf8'),
]);

const lazyFontSourceCss = await Promise.all(
  lazyFontShards.map(({ source }) => readFile(path.join(repoRoot, 'css', 'fonts', source), 'utf8')),
);
const lazyFontAssetStemsBySource = new Map(
  lazyFontShards.map(({ source }, index) => [
    source,
    [
      ...new Set(
        [
          ...(lazyFontSourceCss[index]?.matchAll(/url\((?:["']?)([^)"']+\.woff2)(?:["']?)\)/giu) ??
            []),
        ]
          .map((match) => match[1])
          .filter((fontAssetUrl): fontAssetUrl is string => Boolean(fontAssetUrl))
          .map((fontAssetUrl) => path.basename(fontAssetUrl, '.woff2')),
      ),
    ],
  ]),
);

check(sourceFont.subarray(0, 4).toString('ascii') === 'wOF2', 'source font is not WOFF2');
check(sourceFont.byteLength >= 1_500_000, 'source font looks like a subset, not the complete face');
check(sourceFont.equals(publicFont), 'public Pretendard copy differs from the canonical source');
check(fontCss.includes(`url("${fontUrl}")`), 'font CSS does not use the canonical full font URL');
check(!/unicode-range\s*:/iu.test(fontCss), 'font CSS must not restrict the complete face');
check(/font-display\s*:\s*swap\s*;/iu.test(fontCss), 'font CSS must retain font-display: swap');
check(
  hasFontFace(primaryFontCss, 'Pretendard') &&
    primaryFontCss.includes(fontUrl) &&
    /font-display\s*:\s*swap\s*;/iu.test(primaryFontCss),
  'lazy primary-font CSS does not register the canonical complete face',
);
check(
  !/Pretendard(?:UiCore|Korean)|Pretendard UI Core/u.test(fontCss),
  'font CSS names a retired subset',
);
check(!/Pretendard UI Core/u.test(styleCss), 'style font stacks still name the retired UI subset');
check(
  !collectStylesheetUrls(appHtml).some((url) =>
    /(?:^|\/)(?:pretendard|primary-font)\.css(?:[?#]|$)/iu.test(url),
  ),
  'app HTML links Pretendard CSS in the initial graph',
);
check(
  bootstrapSource.includes('/primary-font-loader.js') &&
    /RUNTIME_TIMEOUT_MS/u.test(bootstrapSource) &&
    /retryTimer\s*=\s*window\.setTimeout/u.test(bootstrapSource) &&
    /Math\.min\((?:30000|3e4)/u.test(bootstrapSource),
  'bootstrap font scheduler lacks bounded retryable loading for the lazy font runtime',
);
check(
  /addEventListener\(['"]load['"]/u.test(bootstrapSource) &&
    /requestIdleCallback/u.test(bootstrapSource) &&
    /addEventListener\(['"]online['"],\s*retryNow\)/u.test(bootstrapSource) &&
    /document\.addEventListener\(['"]visibilitychange/u.test(bootstrapSource),
  'bootstrap font scheduler must wait for load/idle and recover on connectivity or visibility',
);
check(
  new RegExp(`\\b(?:var|const)\\s+FONT_URL\\s*=\\s*['"]${escapeRegExp(fontUrl)}['"]`, 'u').test(
    primaryFontRuntime,
  ) &&
    /new FontFace\(RECOVERY_FAMILY/u.test(primaryFontRuntime) &&
    /data-mxqr-font-recovery/u.test(primaryFontRuntime) &&
    /ATTEMPT_TIMEOUT_MS/u.test(primaryFontRuntime) &&
    /RETRY_DELAYS_MS/u.test(primaryFontRuntime),
  'lazy font runtime lacks bounded separate-family recovery after a CSS failure',
);
check(
  /--font-primary\s*:\s*'Pretendard'/u.test(styleCss) &&
    /data-mxqr-font-recovery=['"]true['"][^{]*\{[^}]*--font-primary\s*:\s*'MUSIXQUARE Pretendard Recovery'/u.test(
      styleCss,
    ),
  'app font variables do not switch inherited UI text to the recovery family',
);
check(
  (styleCss.match(/['"]Pretendard['"]/gu) || []).length === 1 &&
    /\.user-text-font\.user-text-font\s*\{[^}]*var\(--font-primary\)/su.test(styleCss) &&
    /\.language-option-native:lang\(ja\)\s*\{[^}]*var\(--font-primary\)/su.test(styleCss),
  'an explicit UI text boundary can bypass the root recovery-family switch',
);

for (const fallback of [
  'Noto Sans Arabic',
  'Noto Sans Bengali',
  'Noto Sans Devanagari',
  'Noto Sans Gujarati',
  'Noto Sans Gurmukhi',
  'Noto Sans Hebrew',
  'Noto Sans JP',
  'Noto Sans Kannada',
  'Noto Sans Malayalam',
  'Noto Sans SC',
  'Noto Sans Tamil',
  'Noto Sans TC',
  'Noto Sans Telugu',
  'Noto Sans Thai',
  'Noto Sans',
]) {
  const escaped = fallback.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  check(
    new RegExp(
      `(?:var\\(--font-primary\\)[^;]*'${escaped}'|'${escaped}'[^;]*var\\(--font-primary\\))`,
      'u',
    ).test(styleCss),
    `${fallback} is not paired with Pretendard in a locale fallback stack`,
  );
}

for (const [label, html] of [
  ['app', appHtml],
  ['landing', landingHtml],
  ['blog', blogHtml],
  ['history', historyHtml],
  ['design-system', designSystemHtml],
] as const) {
  check(!hasFontPreload(html), `${label} HTML eagerly preloads the 2 MiB Pretendard face`);
}
const serviceWorkerFontUrl = `.${fontUrl}`;
const sourceAppShell =
  /\bconst\s+APP_SHELL\s*=\s*\[([\s\S]*?)\]\s*;/u.exec(serviceWorker)?.[1] || '';
check(
  !sourceAppShell.includes(`"${serviceWorkerFontUrl}"`) &&
    !sourceAppShell.includes(`'${serviceWorkerFontUrl}'`),
  'service worker app shell eagerly downloads the 2 MiB Pretendard face',
);
check(
  serviceWorkerSource.includes(OPTIONAL_PRIMARY_FONT_ASSETS_MARKER) &&
    /OPTIONAL_ASSET_GROUP_TIMEOUT_MS/u.test(serviceWorker) &&
    /OPTIONAL_CACHE_READY_KEY/u.test(serviceWorker),
  'service worker lacks the bounded optional primary-font cache contract',
);
check(
  !/font:subset|guard:font-subsets|subset-app-font/u.test(packageJson),
  'package scripts still expose app font subsetting',
);

if (distMode) {
  const distDirectory = path.join(repoRoot, 'dist');
  const distFontPath = path.join(
    distDirectory,
    'designsystem',
    'fonts',
    'PretendardVariable.woff2',
  );
  const [
    distFont,
    distHtml,
    distAboutHtml,
    distServiceWorker,
    distPrimaryFontCss,
    distPrimaryFontRuntime,
    distBootstrapRuntime,
    distFiles,
  ] = await Promise.all([
    readFile(distFontPath),
    readFile(path.join(distDirectory, 'index.html'), 'utf8'),
    readFile(path.join(distDirectory, 'about.html'), 'utf8'),
    readFile(path.join(distDirectory, 'service-worker.js'), 'utf8'),
    readFile(path.join(distDirectory, 'primary-font.css'), 'utf8'),
    readFile(path.join(distDirectory, 'primary-font-loader.js'), 'utf8'),
    readFile(path.join(distDirectory, 'bootstrap.js'), 'utf8'),
    collectFiles(distDirectory),
  ]);
  check(distFont.equals(sourceFont), 'built Pretendard asset differs from the canonical source');
  check(distPrimaryFontCss === primaryFontCss, 'built lazy primary-font CSS differs from source');
  check(
    distPrimaryFontRuntime === primaryFontRuntime,
    'built lazy primary-font runtime differs from source',
  );
  check(
    distBootstrapRuntime === bootstrapSource,
    'built early bootstrap runtime differs from the classic-runtime compiler output',
  );
  check(!hasFontPreload(distHtml), 'built app HTML eagerly preloads the 2 MiB Pretendard face');

  const builtHtmlFiles = distFiles.filter((file) => file.endsWith('.html'));
  const builtHtmlEntries = await Promise.all(
    builtHtmlFiles.map(async (file) => ({ file, html: await readFile(file, 'utf8') })),
  );
  const builtPreloaders = builtHtmlEntries
    .filter(({ html }) => hasFontPreload(html))
    .map(({ file }) => file);
  check(
    builtPreloaders.length === 0,
    `built HTML eagerly preloads the 2 MiB Pretendard face: ${builtPreloaders
      .map((file) => path.relative(distDirectory, file))
      .join(', ')}`,
  );

  const oldSubsetArtifacts = distFiles.filter((file) =>
    /Pretendard(?:UiCore|Korean)\.woff2$/u.test(path.basename(file)),
  );
  check(oldSubsetArtifacts.length === 0, 'built output still contains retired Pretendard subsets');

  const deployedFullFonts = distFiles.filter(
    (file) => path.basename(file) === 'PretendardVariable.woff2',
  );
  check(
    deployedFullFonts.length === 1,
    'built output should contain one canonical full font asset',
  );

  const builtCssFiles = distFiles.filter((file) => file.endsWith('.css'));
  const builtCssEntries = await Promise.all(
    builtCssFiles.map(async (file) => ({ file, css: await readFile(file, 'utf8') })),
  );
  const primaryFontCssEntries = builtCssEntries.filter(
    ({ file, css }) =>
      path.relative(distDirectory, file).replace(/\\/gu, '/') === 'primary-font.css' &&
      hasFontFace(css, 'Pretendard') &&
      css.includes(fontUrl),
  );
  check(
    primaryFontCssEntries.length === 1,
    `built lazy Pretendard CSS should be one stable optional asset (found ${primaryFontCssEntries.length})`,
  );
  const [primaryFontCssEntry] = primaryFontCssEntries;
  if (primaryFontCssEntry) {
    check(
      primaryFontCssEntry.css.split(fontUrl).length - 1 === 1,
      'built lazy Pretendard CSS must reference the canonical font URL exactly once',
    );
  }

  const builtOptionalFontManifest =
    /\bconst\s+OPTIONAL_PRIMARY_FONT_ASSETS\s*=\s*\[([\s\S]*?)\]\s*;/u.exec(
      distServiceWorker,
    )?.[1] || '';
  const builtAppShell =
    /\bconst\s+APP_SHELL\s*=\s*\[([\s\S]*?)\]\s*;/u.exec(distServiceWorker)?.[1] || '';
  check(
    !distServiceWorker.includes('__MUSIXQUARE_OPTIONAL_PRIMARY_FONT_ASSETS__'),
    'built service worker optional font manifest was not injected',
  );
  check(
    builtOptionalFontManifest.includes(serviceWorkerFontUrl),
    'built optional font manifest omits the canonical full font',
  );
  check(
    builtOptionalFontManifest.includes('./primary-font-loader.js'),
    'built optional font manifest omits the retryable font runtime',
  );
  if (primaryFontCssEntry) {
    check(
      builtOptionalFontManifest.includes(
        `./${path.relative(distDirectory, primaryFontCssEntry.file).replace(/\\/gu, '/')}`,
      ),
      'built optional font manifest omits the lazy Pretendard stylesheet',
    );
  }
  check(
    !builtAppShell.includes(serviceWorkerFontUrl) &&
      !builtAppShell.includes('./primary-font-loader.js') &&
      !builtAppShell.includes('./primary-font.css'),
    'built core app shell contains an optional Pretendard asset',
  );

  // Vite must keep every locale face behind its dynamic CSS import.
  // Inspect content rather than hashes: output filenames are intentionally
  // unstable, while an @font-face family uniquely identifies each shard.
  const lazyShardFiles: string[] = [];
  lazyFontShards.forEach(({ label, family, source }) => {
    const assetStems = lazyFontAssetStemsBySource.get(source) ?? [];
    const matchingFiles = builtCssEntries
      .filter(
        ({ css }) => hasFontFace(css, family) && assetStems.some((stem) => css.includes(stem)),
      )
      .map(({ file }) => file);
    check(
      matchingFiles.length === 1,
      `${label} font should exist in exactly one built lazy CSS shard (found ${matchingFiles.length})`,
    );
    const [matchingFile] = matchingFiles;
    if (matchingFile) lazyShardFiles.push(matchingFile);
  });
  check(
    new Set(lazyShardFiles).size === lazyFontShards.length,
    `locale fonts must remain ${lazyFontShards.length} independent lazy CSS shards`,
  );

  const distFileSet = new Set(distFiles.map((file) => path.resolve(file)));
  const aboutLocaleFontTags = [...distAboutHtml.matchAll(/<link\b[^>]*>/giu)]
    .map((match) => match[0])
    .filter((tag) => /\bdata-static-lang-font-codes=["'][^"']+["']/iu.test(tag));
  check(
    aboutLocaleFontTags.length === lazyFontShards.length,
    `built About HTML must expose ${lazyFontShards.length} lazy locale font links (found ${aboutLocaleFontTags.length})`,
  );
  const aboutLocaleCssFiles = aboutLocaleFontTags.flatMap((tag) => {
    const href = /\bhref=["']([^"']+)["']/iu.exec(tag)?.[1] || '';
    check(
      Boolean(href) && !href.startsWith('data:'),
      `built About locale font href is invalid: ${href}`,
    );
    const file = localDistAssetPath(distDirectory, href);
    check(
      Boolean(file) && distFileSet.has(path.resolve(file || '')),
      `built About locale font CSS is missing: ${href}`,
    );
    return file ? [file] : [];
  });
  check(
    new Set(aboutLocaleCssFiles.map((file) => path.resolve(file))).size === lazyFontShards.length,
    'built About locale font links must resolve to distinct CSS shards',
  );
  const lazyShardSet = new Set(lazyShardFiles.map((file) => path.resolve(file)));
  for (const file of aboutLocaleCssFiles) {
    check(
      lazyShardSet.has(path.resolve(file)),
      `built About HTML references raw rather than processed locale CSS: ${path.relative(distDirectory, file)}`,
    );
    const css = await readFile(file, 'utf8');
    const fontUrls = [...css.matchAll(/url\((?:["']?)([^)"']+\.woff2)(?:["']?)\)/giu)].map(
      (match) => match[1],
    );
    check(
      fontUrls.length > 0,
      `built About locale font CSS has no WOFF2 references: ${path.relative(distDirectory, file)}`,
    );
    for (const fontUrl of fontUrls) {
      const fontFile = fontUrl ? localCssAssetPath(distDirectory, file, fontUrl) : null;
      check(
        Boolean(fontFile) && distFileSet.has(path.resolve(fontFile || '')),
        `built About locale font WOFF2 is unresolved: ${path.relative(distDirectory, file)} -> ${fontUrl || '(missing)'}`,
      );
    }
  }

  const initialAssetUrls = collectInitialAssetUrls(distHtml);
  const initialAssetFiles = initialAssetUrls
    .filter((url) => /\.(?:css|m?js)(?:[?#]|$)/iu.test(url))
    .map((url) => localDistAssetPath(distDirectory, url))
    .filter((file): file is string => file !== null);
  const initialAssetContents = await Promise.all(
    initialAssetFiles.map((file) => readFile(file, 'utf8')),
  );
  const initialAssetSet = new Set(initialAssetFiles.map((file) => path.resolve(file)));
  const builtNotoFontAssetNames = distFiles
    .filter((file) => file.endsWith('.woff2') && path.basename(file) !== 'PretendardVariable.woff2')
    .map((file) => path.basename(file));

  for (const { file } of primaryFontCssEntries) {
    check(
      !initialAssetSet.has(path.resolve(file)),
      `${path.basename(file)} is linked by the initial app document instead of loading lazily`,
    );
  }
  check(
    !initialAssetContents.some((content) => hasFontFace(content, 'Pretendard')),
    'Pretendard font CSS was absorbed into an initial app CSS/JS asset',
  );

  for (const shardFile of lazyShardFiles) {
    check(
      !initialAssetSet.has(path.resolve(shardFile)),
      `${path.basename(shardFile)} is linked by the initial document instead of loading lazily`,
    );
  }
  for (const { label, family } of lazyFontShards) {
    check(
      !initialAssetContents.some((content) => hasFontFace(content, family)),
      `${label} @font-face was absorbed into an initial CSS/JS asset`,
    );
  }
  check(
    !initialAssetContents.some((content) =>
      builtNotoFontAssetNames.some((assetName) => content.includes(assetName)),
    ),
    'a Noto font asset URL was absorbed into an initial CSS/JS asset',
  );

  const initialFontPreloads = [...distHtml.matchAll(/<link\b[^>]*>/giu)]
    .map((match) => match[0])
    .filter((tag) => /\brel=["']preload["']/iu.test(tag) && /\bas=["']font["']/iu.test(tag))
    .map((tag) => /\bhref=["']([^"']+)["']/iu.exec(tag)?.[1] || '');
  check(
    initialFontPreloads.length === 0,
    `the initial document eagerly preloads fonts: ${initialFontPreloads.join(', ')}`,
  );
}

if (failures.length > 0) {
  console.error(
    `Pretendard asset guard failed:\n${failures.map((line) => `  - ${line}`).join('\n')}`,
  );
  process.exitCode = 1;
} else {
  const sizeKib = (sourceFont.byteLength / 1024).toFixed(1);
  console.log(
    `Pretendard full-font guard passed (${sizeKib} KiB${distMode ? ', built artifact and lazy Noto shards checked' : ''}).`,
  );
}
