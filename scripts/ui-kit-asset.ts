import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { transformWithEsbuild, type Plugin } from 'vite';

import { useAsyncConnectMiddleware } from './async-connect-middleware.ts';

export const UI_KIT_SOURCE_DIRECTORY = 'browser/ui-kit/app';
export const UI_KIT_DECLARATION_PATH = `${UI_KIT_SOURCE_DIRECTORY}/globals.d.ts`;
export const UI_KIT_STATIC_DIRECTORY = 'browser/ui-kit/static/app';
export const UI_KIT_HTML_PATH = `${UI_KIT_STATIC_DIRECTORY}/index.html`;
export const UI_KIT_STYLE_PATH = `${UI_KIT_STATIC_DIRECTORY}/app.css`;
export const UI_KIT_README_PATH = `${UI_KIT_STATIC_DIRECTORY}/README.md`;
export const UI_KIT_PUBLIC_APP_PATH = '/designsystem/ui_kits/app';
export const UI_KIT_OUTPUT_PATH = 'designsystem/ui_kits/app/app.js';

export const UI_KIT_SOURCES = [
  `${UI_KIT_SOURCE_DIRECTORY}/icons.tsx`,
  `${UI_KIT_SOURCE_DIRECTORY}/Toast.tsx`,
  `${UI_KIT_SOURCE_DIRECTORY}/Start.tsx`,
  `${UI_KIT_SOURCE_DIRECTORY}/RoleSetup.tsx`,
  `${UI_KIT_SOURCE_DIRECTORY}/Home.tsx`,
  `${UI_KIT_SOURCE_DIRECTORY}/Playlist.tsx`,
  `${UI_KIT_SOURCE_DIRECTORY}/Connect.tsx`,
  `${UI_KIT_SOURCE_DIRECTORY}/Settings.tsx`,
  `${UI_KIT_SOURCE_DIRECTORY}/AppShell.tsx`,
  `${UI_KIT_SOURCE_DIRECTORY}/entry.tsx`,
] as const;

export const UI_KIT_REACT_RUNTIME = Object.freeze({
  src: 'https://unpkg.com/react@18.3.1/umd/react.development.js',
  integrity: 'sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L',
});

export const UI_KIT_REACT_DOM_RUNTIME = Object.freeze({
  src: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js',
  integrity: 'sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm',
});

export interface CompiledUiKitAsset {
  readonly code: string;
  readonly outputPath: typeof UI_KIT_OUTPUT_PATH;
  readonly sourcePaths: typeof UI_KIT_SOURCES;
}

function scriptTagForSource(html: string, source: string): string {
  const matches = [...html.matchAll(/<script\b[^>]*\bsrc=(['"])(.*?)\1[^>]*><\/script\s*>/giu)]
    .filter((match) => match[2] === source)
    .map((match) => match[0]);
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`UI kit HTML must load ${source} exactly once.`);
  }
  return matches[0];
}

function assertExternalRuntimeTag(
  html: string,
  runtime: { readonly src: string; readonly integrity: string },
): void {
  const tag = scriptTagForSource(html, runtime.src);
  if (!tag.includes(`integrity="${runtime.integrity}"`)) {
    throw new Error(`UI kit runtime has an unexpected SRI digest: ${runtime.src}`);
  }
  if (!/\bcrossorigin=["']anonymous["']/iu.test(tag)) {
    throw new Error(`UI kit runtime must use anonymous CORS for SRI: ${runtime.src}`);
  }
}

export function assertUiKitHtmlContract(html: string): void {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)];
  if (scripts.length !== 3) {
    throw new Error('UI kit HTML must load exactly React, ReactDOM, and the compiled app.');
  }
  for (const script of scripts) {
    const attributes = script[1] ?? '';
    const body = script[2] ?? '';
    if (!/\bsrc\s*=/iu.test(attributes) && body.trim().length > 0) {
      throw new Error('UI kit HTML must not contain executable inline JavaScript.');
    }
  }
  assertExternalRuntimeTag(html, UI_KIT_REACT_RUNTIME);
  assertExternalRuntimeTag(html, UI_KIT_REACT_DOM_RUNTIME);
  scriptTagForSource(html, `/${UI_KIT_OUTPUT_PATH}`);
  if (/text\/babel|@babel\/standalone|\.jsx(?:[?"'])/iu.test(html)) {
    throw new Error('UI kit HTML retains Babel or raw JSX execution.');
  }
  const reactIndex = html.indexOf(UI_KIT_REACT_RUNTIME.src);
  const reactDomIndex = html.indexOf(UI_KIT_REACT_DOM_RUNTIME.src);
  const appIndex = html.indexOf(`/${UI_KIT_OUTPUT_PATH}`);
  if (!(reactIndex >= 0 && reactIndex < reactDomIndex && reactDomIndex < appIndex)) {
    throw new Error('UI kit React, ReactDOM, and compiled app load order changed.');
  }
}

export async function assertUiKitSourceCompleteness(repoRoot: string): Promise<void> {
  const expected = new Set([
    path.basename(UI_KIT_DECLARATION_PATH),
    ...UI_KIT_SOURCES.map((sourcePath) => path.basename(sourcePath)),
  ]);
  const sourceDirectory = path.resolve(repoRoot, UI_KIT_SOURCE_DIRECTORY);
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  const unsupported = entries
    .filter((entry) => !entry.isFile() || !expected.has(entry.name))
    .map((entry) => path.posix.join(UI_KIT_SOURCE_DIRECTORY, entry.name));
  const missing = [...expected]
    .filter((name) => !entries.some((entry) => entry.isFile() && entry.name === name))
    .map((name) => path.posix.join(UI_KIT_SOURCE_DIRECTORY, name));
  if (unsupported.length > 0 || missing.length > 0) {
    throw new Error(
      `UI kit source ownership is incomplete:\n${[
        ...unsupported.map((entry) => `  unsupported: ${entry}`),
        ...missing.map((entry) => `  missing: ${entry}`),
      ].join('\n')}`,
    );
  }

  const staticExpected = new Set(['README.md', 'app.css', 'index.html']);
  const staticDirectory = path.resolve(repoRoot, UI_KIT_STATIC_DIRECTORY);
  const staticEntries = await readdir(staticDirectory, { withFileTypes: true });
  const staticUnsupported = staticEntries
    .filter((entry) => !entry.isFile() || !staticExpected.has(entry.name))
    .map((entry) => path.posix.join(UI_KIT_STATIC_DIRECTORY, entry.name));
  const staticMissing = [...staticExpected]
    .filter((name) => !staticEntries.some((entry) => entry.isFile() && entry.name === name))
    .map((name) => path.posix.join(UI_KIT_STATIC_DIRECTORY, name));
  if (staticUnsupported.length > 0 || staticMissing.length > 0) {
    throw new Error(
      `UI kit static ownership is incomplete:\n${[
        ...staticUnsupported.map((entry) => `  unsupported: ${entry}`),
        ...staticMissing.map((entry) => `  missing: ${entry}`),
      ].join('\n')}`,
    );
  }

  const retiredPublicDirectory = path.resolve(repoRoot, 'public/designsystem/ui_kits/app');
  try {
    const publicEntries = await readdir(retiredPublicDirectory, { withFileTypes: true });
    if (publicEntries.length > 0) {
      throw new Error(
        `publicDir must not publish the development-only UI kit:\n${publicEntries
          .map(
            (entry) =>
              `  published: ${path.posix.join('public/designsystem/ui_kits/app', entry.name)}`,
          )
          .join('\n')}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const html = await readFile(path.resolve(repoRoot, UI_KIT_HTML_PATH), 'utf8');
  assertUiKitHtmlContract(html);
}

export function assertUiKitJavaScript(code: string): void {
  if (/\/\/[#@]\s*sourceMappingURL=/u.test(code)) {
    throw new Error('UI kit output contains a sourcemap reference.');
  }
  if (/^\s*(?:import|export)\b/mu.test(code)) {
    throw new Error('UI kit output contains module syntax.');
  }
  if (/text\/babel|@babel\/standalone|\.jsx\b/iu.test(code)) {
    throw new Error('UI kit output retains a Babel or raw JSX dependency.');
  }
  for (const runtimeGuard of [
    'MUSIXQUARE_UI_KIT_REACT_RUNTIME_REQUIRED',
    'MUSIXQUARE_UI_KIT_ROOT_REQUIRED',
  ]) {
    if (!code.includes(runtimeGuard)) throw new Error(`UI kit output lost ${runtimeGuard}.`);
  }
  Function(code);
}

export async function compileUiKitAsset(repoRoot: string): Promise<CompiledUiKitAsset> {
  await assertUiKitSourceCompleteness(repoRoot);
  const entrySource = UI_KIT_SOURCES.at(-1);
  if (!entrySource) throw new Error('UI kit asset manifest has no entry source.');
  const sources = await Promise.all(
    UI_KIT_SOURCES.map(async (sourcePath) => {
      const source = await readFile(path.resolve(repoRoot, sourcePath), 'utf8');
      return `\n// ${sourcePath}\n${source}`;
    }),
  );
  const transformed = await transformWithEsbuild(
    `'use strict';\n${sources.join('\n')}`,
    entrySource,
    {
      loader: 'tsx',
      format: 'iife',
      target: 'es2022',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      sourcemap: false,
      minify: false,
      legalComments: 'inline',
      charset: 'utf8',
    },
  );
  assertUiKitJavaScript(transformed.code);
  return {
    code: transformed.code,
    outputPath: UI_KIT_OUTPUT_PATH,
    sourcePaths: UI_KIT_SOURCES,
  };
}

export function uiKitAsset(): Plugin {
  return {
    name: 'musixquare-ui-kit-asset', // brand-capitalization: allow-technical
    apply: 'serve',
    enforce: 'pre',
    async configureServer(server) {
      await assertUiKitSourceCompleteness(server.config.root);
      useAsyncConnectMiddleware(server.middlewares, async (request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          next();
          return;
        }
        let pathname = '';
        try {
          pathname = new URL(request.url ?? '', 'http://vite.local').pathname;
        } catch {
          next();
          return;
        }
        if (pathname === UI_KIT_PUBLIC_APP_PATH) {
          response.statusCode = 307;
          response.setHeader('Location', `${UI_KIT_PUBLIC_APP_PATH}/`);
          response.setHeader('Cache-Control', 'no-cache');
          response.end();
          return;
        }
        const staticAsset =
          pathname === `${UI_KIT_PUBLIC_APP_PATH}/` ||
          pathname === `${UI_KIT_PUBLIC_APP_PATH}/index.html`
            ? { path: UI_KIT_HTML_PATH, contentType: 'text/html; charset=utf-8' }
            : pathname === `${UI_KIT_PUBLIC_APP_PATH}/app.css`
              ? { path: UI_KIT_STYLE_PATH, contentType: 'text/css; charset=utf-8' }
              : pathname === `${UI_KIT_PUBLIC_APP_PATH}/README.md`
                ? { path: UI_KIT_README_PATH, contentType: 'text/markdown; charset=utf-8' }
                : null;
        if (!staticAsset && pathname !== `/${UI_KIT_OUTPUT_PATH}`) {
          next();
          return;
        }
        try {
          const body = staticAsset
            ? await readFile(path.resolve(server.config.root, staticAsset.path), 'utf8')
            : (await compileUiKitAsset(server.config.root)).code;
          response.statusCode = 200;
          response.setHeader(
            'Content-Type',
            staticAsset?.contentType ?? 'text/javascript; charset=utf-8',
          );
          response.setHeader('Cache-Control', 'no-cache');
          response.end(request.method === 'HEAD' ? undefined : body);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
