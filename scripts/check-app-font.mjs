#!/usr/bin/env node
/** Guard the complete Pretendard app font, fallback stacks, and built artifact. */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const failures = [];
const lazyFontShards = [
  { label: 'Japanese', family: 'Noto Sans JP', source: 'noto-jp.css' },
  { label: 'Simplified Chinese', family: 'Noto Sans SC', source: 'noto-sc.css' },
  { label: 'Traditional Chinese', family: 'Noto Sans TC', source: 'noto-tc.css' },
  { label: 'Thai', family: 'Noto Sans Thai', source: 'noto-thai.css' },
  { label: 'Cyrillic', family: 'Noto Sans', source: 'noto-cyrillic.css' },
];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function hasFontPreload(html) {
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function hasFontFace(css, family) {
  return new RegExp(
    `@font-face\\s*\\{[^}]*font-family\\s*:\\s*["']?${escapeRegExp(family)}["']?\\s*;`,
    'iu',
  ).test(css);
}

function collectInitialAssetUrls(html) {
  const urls = [];
  for (const match of html.matchAll(/<(?:link|script)\b[^>]*>/giu)) {
    const url = /\b(?:href|src)=["']([^"']+)["']/iu.exec(match[0])?.[1];
    if (url) urls.push(url);
  }
  return urls;
}

function collectStylesheetUrls(html) {
  return [...html.matchAll(/<link\b[^>]*>/giu)]
    .map((match) => match[0])
    .filter((tag) => /\brel=["']stylesheet["']/iu.test(tag))
    .map((tag) => /\bhref=["']([^"']+)["']/iu.exec(tag)?.[1] || '')
    .filter(Boolean);
}

function localDistAssetPath(distDirectory, url) {
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  const pathname = decodeURIComponent(url.split(/[?#]/u, 1)[0]).replace(/^\/+/, '');
  if (!pathname || pathname.includes('..')) return null;
  return path.join(distDirectory, ...pathname.split('/'));
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(target)));
    else files.push(target);
  }
  return files;
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
  serviceWorker,
  packageJson,
] = await Promise.all([
  readFile(sourceFontPath),
  readFile(publicFontPath),
  readFile(path.join(repoRoot, 'css', 'pretendard.css'), 'utf8'),
  readFile(path.join(repoRoot, 'public', 'primary-font.css'), 'utf8'),
  readFile(path.join(repoRoot, 'public', 'primary-font-loader.js'), 'utf8'),
  readFile(path.join(repoRoot, 'css', 'style.css'), 'utf8'),
  readFile(path.join(repoRoot, 'public', 'bootstrap.js'), 'utf8'),
  readFile(path.join(repoRoot, 'index.html'), 'utf8'),
  readFile(path.join(repoRoot, '.workshop', 'landing', 'landing.html'), 'utf8'),
  readFile(path.join(repoRoot, 'public', 'blog', 'index.html'), 'utf8'),
  readFile(path.join(repoRoot, 'public', 'history', 'index.html'), 'utf8'),
  readFile(path.join(repoRoot, 'public', 'designsystem', 'index.html'), 'utf8'),
  readFile(path.join(repoRoot, 'public', 'service-worker.js'), 'utf8'),
  readFile(path.join(repoRoot, 'package.json'), 'utf8'),
]);

const lazyFontSourceCss = await Promise.all(
  lazyFontShards.map(({ source }) => readFile(path.join(repoRoot, 'css', 'fonts', source), 'utf8')),
);
const lazyFontAssetStems = [
  ...new Set(
    lazyFontSourceCss.flatMap((css) =>
      [...css.matchAll(/url\((?:["']?)([^)"']+\.woff2)(?:["']?)\)/giu)].map((match) =>
        path.basename(match[1], '.woff2'),
      ),
    ),
  ),
];

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
  bootstrapSource.includes("var RUNTIME_URL = '/primary-font-loader.js'") &&
    /RUNTIME_TIMEOUT_MS/u.test(bootstrapSource) &&
    /retryTimer\s*=\s*window\.setTimeout/u.test(bootstrapSource) &&
    /Math\.min\(30000/u.test(bootstrapSource),
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
  primaryFontRuntime.includes(`var FONT_URL = '${fontUrl}'`) &&
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
  'Noto Sans JP',
  'Noto Sans SC',
  'Noto Sans TC',
  'Noto Sans Thai',
  'Noto Sans',
]) {
  const escaped = fallback.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  check(
    new RegExp(`var\\(--font-primary\\)[^;]*'${escaped}'`, 'u').test(styleCss),
    `${fallback} is not retained after Pretendard in a locale fallback stack`,
  );
}

for (const [label, html] of [
  ['app', appHtml],
  ['landing', landingHtml],
  ['blog', blogHtml],
  ['history', historyHtml],
  ['design-system', designSystemHtml],
]) {
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
  serviceWorker.includes('__MUSIXQUARE_OPTIONAL_PRIMARY_FONT_ASSETS__') &&
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
    distServiceWorker,
    distPrimaryFontCss,
    distPrimaryFontRuntime,
    distFiles,
  ] = await Promise.all([
    readFile(distFontPath),
    readFile(path.join(distDirectory, 'index.html'), 'utf8'),
    readFile(path.join(distDirectory, 'service-worker.js'), 'utf8'),
    readFile(path.join(distDirectory, 'primary-font.css'), 'utf8'),
    readFile(path.join(distDirectory, 'primary-font-loader.js'), 'utf8'),
    collectFiles(distDirectory),
  ]);
  check(distFont.equals(sourceFont), 'built Pretendard asset differs from the canonical source');
  check(distPrimaryFontCss === primaryFontCss, 'built lazy primary-font CSS differs from source');
  check(
    distPrimaryFontRuntime === primaryFontRuntime,
    'built lazy primary-font runtime differs from source',
  );
  check(!hasFontPreload(distHtml), 'built app HTML eagerly preloads the 2 MiB Pretendard face');

  const builtHtmlFiles = distFiles.filter((file) => file.endsWith('.html'));
  const builtHtml = await Promise.all(builtHtmlFiles.map((file) => readFile(file, 'utf8')));
  const builtPreloaders = builtHtmlFiles.filter((_, index) => hasFontPreload(builtHtml[index]));
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
  const builtCss = await Promise.all(builtCssFiles.map((file) => readFile(file, 'utf8')));
  const primaryFontCssIndexes = builtCssFiles
    .map((file, index) => ({ file, index }))
    .filter(
      ({ file, index }) =>
        path.relative(distDirectory, file).replace(/\\/gu, '/') === 'primary-font.css' &&
        hasFontFace(builtCss[index], 'Pretendard') &&
        builtCss[index].includes(fontUrl),
    );
  check(
    primaryFontCssIndexes.length === 1,
    `built lazy Pretendard CSS should be one stable optional asset (found ${primaryFontCssIndexes.length})`,
  );
  if (primaryFontCssIndexes.length === 1) {
    const primaryCss = builtCss[primaryFontCssIndexes[0].index];
    check(
      primaryCss.split(fontUrl).length - 1 === 1,
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
  if (primaryFontCssIndexes.length === 1) {
    check(
      builtOptionalFontManifest.includes(
        `./${path.relative(distDirectory, primaryFontCssIndexes[0].file).replace(/\\/gu, '/')}`,
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

  // Vite must keep the five locale faces behind their dynamic CSS imports.
  // Inspect content rather than hashes: output filenames are intentionally
  // unstable, while an @font-face family uniquely identifies each shard.
  const lazyShardFiles = [];
  lazyFontShards.forEach(({ label, family }) => {
    const matchingFiles = builtCssFiles.filter((_, index) => hasFontFace(builtCss[index], family));
    check(
      matchingFiles.length === 1,
      `${label} font should exist in exactly one built lazy CSS shard (found ${matchingFiles.length})`,
    );
    if (matchingFiles.length === 1) lazyShardFiles.push(matchingFiles[0]);
  });
  check(
    new Set(lazyShardFiles).size === lazyFontShards.length,
    'locale fonts must remain five independent lazy CSS shards',
  );

  const initialAssetUrls = collectInitialAssetUrls(distHtml);
  const initialAssetFiles = initialAssetUrls
    .filter((url) => /\.(?:css|m?js)(?:[?#]|$)/iu.test(url))
    .map((url) => localDistAssetPath(distDirectory, url))
    .filter(Boolean);
  const initialAssetContents = await Promise.all(
    initialAssetFiles.map((file) => readFile(file, 'utf8')),
  );
  const initialAssetSet = new Set(initialAssetFiles.map((file) => path.resolve(file)));

  for (const { file } of primaryFontCssIndexes) {
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
      lazyFontAssetStems.some((stem) => content.includes(stem)),
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
