/**
 * The public pages' font sheets: dist/web-fonts/first.css and rest.css, the
 * byte concatenations of the app's processed font sheets in the groups of
 * src/i18n/public-font-contract.ts. Their root-relative /assets/*.woff2 URLs
 * are the very files the app uses, so every page outside the app declares the
 * app's faces with the same descriptors, line boxes and unicode-ranges, and
 * shares the app's HTTP cache. The stack properties live in the authored
 * public/web-fonts/stacks.css. The dev server serves the same two paths from
 * the source sheets.
 *
 * The plugin only adds the two files: it reads the app's bundle and never
 * changes it. It fails the build when an app sheet is missing, duplicated or
 * names a font file the build lacks, when the app entry is missing, when an
 * app sheet reaches the app entry's initial CSS graph, and when the app
 * document links either public sheet.
 */
import { readFileSync } from 'node:fs';
import { posix as posixPath, resolve } from 'node:path';
import type { Plugin } from 'vite';

import { APP_FONT_SHEETS, type AppFontSheetId } from '../src/i18n/app-font-contract.ts';
import { PUBLIC_FONT_SHEET_GROUPS } from '../src/i18n/public-font-contract.ts';
import { PUBLIC_FONT_SHEET_URLS } from '../src/i18n/public-font-urls.ts';

type PublicFontSheetGroup = keyof typeof PUBLIC_FONT_SHEET_GROUPS;

/** The built files, at the URLs the pages link (src/i18n/public-font-urls.ts). */
export const PUBLIC_FONT_SHEET_FILES: Readonly<Record<PublicFontSheetGroup, string>> = {
  first: PUBLIC_FONT_SHEET_URLS.first.slice(1),
  rest: PUBLIC_FONT_SHEET_URLS.rest.slice(1),
};

const GROUPS: readonly PublicFontSheetGroup[] = ['first', 'rest'];

/** One public font sheet: its member sheets in order, each ending in one newline. */
export function concatenateFontSheets(sheets: readonly string[]): string {
  return sheets.map((sheet) => `${sheet.replace(/\n+$/u, '')}\n`).join('');
}

/** A built asset's name without Vite's content hash: 'font-inter-AbC12_-9.css' -> 'font-inter'. */
function hashedAssetStem(fileName: string): string {
  const name = fileName.replace(/\\/gu, '/').split('/').pop() ?? fileName;
  return name.replace(/-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/u, '');
}

function outputText(source: string | Uint8Array): string {
  return typeof source === 'string' ? source : new TextDecoder().decode(source);
}

const FONT_SHEET_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gu;

function woff2Urls(css: string): string[] {
  return [...css.matchAll(FONT_SHEET_URL)].flatMap((match) =>
    match[2]?.endsWith('.woff2') ? [match[2]] : [],
  );
}

function declaresFamily(css: string, family: string): boolean {
  return [...css.matchAll(/font-family\s*:\s*(['"]?)([^'";}]+)\1/giu)].some(
    (match) => match[2]?.trim() === family,
  );
}

/**
 * The dev server's copy of a public font sheet: the source sheets of its
 * group, with each sheet-relative font URL made root-relative so it resolves
 * from /web-fonts/ (the dev server serves the committed fonts/ files).
 */
export function publicFontSheetSource(repoRoot: string, group: PublicFontSheetGroup): string {
  return concatenateFontSheets(
    PUBLIC_FONT_SHEET_GROUPS[group].map((id) => {
      const sheet = APP_FONT_SHEETS.find((candidate) => candidate.id === id);
      if (!sheet) throw new Error(`Unknown app font sheet: ${id}`);
      const css = readFileSync(resolve(repoRoot, sheet.path), 'utf8');
      return css.replace(FONT_SHEET_URL, (match, quote: string, url: string) =>
        /^(?:[a-z][a-z\d+.-]*:|\/)/iu.test(url)
          ? match
          : `url(${quote}/${posixPath.normalize(posixPath.join(posixPath.dirname(sheet.path), url))}${quote})`,
      );
    }),
  );
}

/**
 * Emits dist/web-fonts/first.css and rest.css for every page outside the
 * app. vite.config.ts registers it after About's font binding, whose raw
 * locale sheet copies share a name stem with the app's script sheets until
 * that binding removes them.
 */
export const publicFontSheets = (): Plugin => ({
  name: 'public-font-sheets',
  enforce: 'post',
  configureServer(server) {
    const paths = new Map<string, PublicFontSheetGroup>(
      GROUPS.map((group) => [`/${PUBLIC_FONT_SHEET_FILES[group]}`, group]),
    );
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url ?? '/', 'http://vite.local').pathname;
      const group = paths.get(pathname);
      if (!group || (request.method !== 'GET' && request.method !== 'HEAD')) {
        next();
        return;
      }
      response.setHeader('Content-Type', 'text/css; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(
        request.method === 'HEAD' ? undefined : publicFontSheetSource(server.config.root, group),
      );
    });
  },
  generateBundle(_options, bundle) {
    const outputs = Object.values(bundle);

    const processed = new Map<AppFontSheetId, string>();
    const processedFiles = new Set<string>();
    for (const sheet of APP_FONT_SHEETS) {
      const matches = outputs.flatMap((output) =>
        output.type === 'asset' &&
        output.fileName.endsWith('.css') &&
        hashedAssetStem(output.fileName) === sheet.id
          ? [output]
          : [],
      );
      if (matches.length !== 1) {
        this.error(
          `The app font sheet ${sheet.id} should be exactly one built CSS asset (found ${matches.length}).`,
        );
      }
      const [output] = matches;
      if (!output) continue;
      const css = outputText(output.source);
      if (!declaresFamily(css, sheet.family)) {
        this.error(`The app font sheet ${sheet.id} declares no ${sheet.family} face.`);
      }
      const fontUrls = woff2Urls(css);
      if (fontUrls.length === 0) this.error(`The app font sheet ${sheet.id} names no WOFF2 file.`);
      for (const fontUrl of fontUrls) {
        const fontPath = fontUrl.startsWith('/') ? fontUrl.slice(1) : null;
        if (!fontPath || bundle[fontPath]?.type !== 'asset') {
          this.error(
            `The app font sheet ${sheet.id} names a font file the build does not hold: ${fontUrl}.`,
          );
        }
      }
      processed.set(sheet.id, css);
      processedFiles.add(output.fileName);
    }

    // The app declares its sheets lazily (src/i18n/locale-fonts.ts): none may
    // reach the static CSS graph of the app entry.
    const chunks = new Map(
      outputs.flatMap((output) =>
        output.type === 'chunk' ? [[output.fileName, output] as const] : [],
      ),
    );
    const appEntry = [...chunks.values()].find(
      (chunk) =>
        chunk.isEntry &&
        Object.keys(chunk.modules).some((id) => id.replace(/\\/gu, '/').endsWith('/src/app.ts')),
    );
    if (!appEntry) this.error('Could not locate the MUSIXQUARE app entry chunk.');
    const pending = [appEntry.fileName];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const fileName = pending.pop();
      if (!fileName || visited.has(fileName)) continue;
      visited.add(fileName);
      const chunk = chunks.get(fileName);
      if (!chunk) continue;
      for (const css of chunk.viteMetadata?.importedCss ?? []) {
        if (processedFiles.has(css)) {
          this.error(`An app font sheet leaked into the initial app CSS graph: ${css}`);
        }
      }
      pending.push(...chunk.imports);
    }

    // The app document never links the public pages' sheets.
    const appDocument = bundle['index.html'];
    if (appDocument?.type !== 'asset') this.error('Could not locate the app document index.html.');
    const appHtml = outputText(appDocument.source);
    const linked = Object.values(PUBLIC_FONT_SHEET_URLS).filter((url) => appHtml.includes(url));
    if (linked.length > 0) {
      this.error(`The app document links the public pages' font sheets: ${linked.join(', ')}`);
    }

    for (const group of GROUPS) {
      const fileName = PUBLIC_FONT_SHEET_FILES[group];
      if (bundle[fileName]) this.error(`${fileName} is emitted twice.`);
      this.emitFile({
        type: 'asset',
        fileName,
        source: concatenateFontSheets(
          PUBLIC_FONT_SHEET_GROUPS[group].map((id) => processed.get(id) ?? ''),
        ),
      });
    }
  },
});
