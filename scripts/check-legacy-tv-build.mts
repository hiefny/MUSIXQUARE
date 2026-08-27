import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import postcss from 'postcss';

import { collectActiveStartupAssets } from './service-worker-app-shell-guard-lib.mts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const distDirectory = path.join(repoRoot, 'dist');

function localAssetPath(url: string): string {
  const parsed = new URL(url, 'https://musixquare.invalid/');
  if (parsed.origin !== 'https://musixquare.invalid') {
    throw new Error(`Legacy TV build references a cross-origin initial asset: ${url}`);
  }
  const relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  const target = path.resolve(distDirectory, ...relative.split('/'));
  const prefix = `${distDirectory}${path.sep}`;
  if (!target.startsWith(prefix)) throw new Error(`Legacy TV asset escapes dist/: ${url}`);
  return target;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'iu').exec(tag);
  return match?.[2] ?? null;
}

function appAssetUrls(html: string): { cssUrl: string; mainUrl: string } {
  const activeStartupAssets = collectActiveStartupAssets(html);
  if (activeStartupAssets.includes('/noscript.css')) {
    throw new Error('Legacy no-script stylesheet escaped its inert <noscript> owner.');
  }
  const noScriptBlocks = html.match(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu) ?? [];
  if (noScriptBlocks.filter((block) => /href=(["'])\/noscript\.css\1/iu.test(block)).length !== 1) {
    throw new Error('Expected exactly one inert /noscript.css reference in the built document.');
  }

  const stylesheetTags = html.match(/<link\b[^>]*\brel=(["'])stylesheet\1[^>]*>/giu) ?? [];
  const localStylesheets = stylesheetTags
    .map((tag) => attribute(tag, 'href'))
    .filter((value): value is string => value !== null && value.startsWith('/assets/main-'));
  if (localStylesheets.length !== 1) {
    throw new Error(`Expected one hashed app stylesheet, found ${localStylesheets.length}.`);
  }

  const moduleTags = html.match(/<script\b[^>]*\btype=(["'])module\1[^>]*>/giu) ?? [];
  const mainScripts = moduleTags
    .map((tag) => attribute(tag, 'src'))
    .filter((value): value is string => value !== null && value.startsWith('/assets/main-'));
  if (mainScripts.length !== 1) {
    throw new Error(`Expected one hashed app module entry, found ${mainScripts.length}.`);
  }
  return { cssUrl: localStylesheets[0]!, mainUrl: mainScripts[0]! };
}

function assertLegacyCss(css: string): void {
  const root = postcss.parse(css);
  const layers: string[] = [];
  root.walkAtRules('layer', (rule) => {
    layers.push(rule.params);
  });
  if (layers.length > 0) throw new Error(`Built CSS still contains @layer: ${layers.join(', ')}`);
  if (/\brevert-layer\b/u.test(css))
    throw new Error('Built CSS contains unsupported revert-layer.');
  if (/:is\(/u.test(css)) throw new Error('Built CSS contains unsupported :is().');
  if (/:not\([^)]*,/u.test(css)) {
    throw new Error('Built CSS contains a selector-list :not() unsupported by Chromium 79.');
  }

  let hasLegacyBootBodyFallback = false;
  let hasLegacyBootFailureFallback = false;
  root.walkRules((rule) => {
    if (
      rule.selector.includes('html.setup-boot-block body') &&
      !rule.selector.includes(':has(') &&
      rule.nodes.some((node) => node.type === 'decl' && node.prop === 'animation')
    ) {
      hasLegacyBootBodyFallback = true;
    }
    if (
      /body\s*>\s*\.bootstrap-failure/u.test(rule.selector) &&
      !rule.selector.includes(':has(') &&
      rule.nodes.some((node) => node.type === 'decl' && node.prop === 'display')
    ) {
      hasLegacyBootFailureFallback = true;
    }
  });
  if (!hasLegacyBootBodyFallback || !hasLegacyBootFailureFallback) {
    throw new Error('Built CSS lost the selector-safe delayed boot failure surface.');
  }

  for (const sentinel of [
    '--bg:',
    '.onboarding-overlay',
    'body.fouc-loaded',
    'body.overlay-open .bottom-nav',
    'top:0;right:0;bottom:0;left:0',
  ]) {
    if (!css.includes(sentinel)) throw new Error(`Built CSS lost legacy sentinel: ${sentinel}`);
  }
}

async function assertLegacyJavaScript(mainPath: string): Promise<void> {
  const assetsDirectory = path.dirname(mainPath);
  const javaScriptFiles = (await readdir(assetsDirectory))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(assetsDirectory, name));
  javaScriptFiles.push(
    path.join(distDirectory, 'bootstrap.js'),
    path.join(distDirectory, 'fouc-cleanup.js'),
    path.join(distDirectory, 'primary-font-loader.js'),
    path.join(distDirectory, 'wordmark-anim.js'),
    path.join(distDirectory, 'account-complete.js'),
    path.join(distDirectory, 'service-worker.js'),
  );

  for (const file of javaScriptFiles) {
    const source = await readFile(file, 'utf8');
    for (const unsupportedRuntimeCall of [
      '.replaceAll(',
      '.at(',
      '.findLast(',
      '.findLastIndex(',
      '.toReversed(',
      '.toSorted(',
      '.toSpliced(',
      'Object.hasOwn(',
      'Promise.any(',
    ]) {
      if (source.includes(unsupportedRuntimeCall)) {
        throw new Error(
          `${path.relative(repoRoot, file)} contains unpolyfilled ${unsupportedRuntimeCall}`,
        );
      }
    }
  }

  const bootstrap = await readFile(path.join(distDirectory, 'bootstrap.js'), 'utf8');
  for (const requiredPrimitive of [
    'replaceChildren',
    'randomUUID',
    'throwIfAborted',
    'mxqr-signal-probe',
  ]) {
    if (!bootstrap.includes(requiredPrimitive)) {
      throw new Error(
        `Early bootstrap lost the Chromium 79 ${requiredPrimitive} compatibility shim.`,
      );
    }
  }
}

async function assertNoScriptFallback(): Promise<void> {
  const source = await readFile(path.join(distDirectory, 'noscript.css'), 'utf8');
  if (!/body\s*\{[^}]*opacity:\s*1\s*!important/isu.test(source)) {
    throw new Error('Legacy no-script stylesheet does not reveal the document body.');
  }
  if (/@layer\b|:(?:has|is|where)\(/u.test(source)) {
    throw new Error('Legacy no-script stylesheet contains an unsupported CSS construct.');
  }
}

async function main(): Promise<void> {
  const html = await readFile(path.join(distDirectory, 'index.html'), 'utf8');
  const { cssUrl, mainUrl } = appAssetUrls(html);
  const cssPath = localAssetPath(cssUrl);
  const mainPath = localAssetPath(mainUrl);
  const css = await readFile(cssPath, 'utf8');
  await assertLegacyJavaScript(mainPath);
  await assertNoScriptFallback();
  assertLegacyCss(css);
  process.stdout.write(
    `[legacy-tv-build] Chromium 79 static compatibility checks passed: ${path.basename(mainPath)}, ${path.basename(cssPath)}\n`,
  );
}

await main();
