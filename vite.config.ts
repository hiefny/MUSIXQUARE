import { defineConfig, loadEnv, type Connect, type Plugin, type UserConfig } from 'vite';
import { resolve } from 'path';
import postcss, { type Plugin as PostCssPlugin } from 'postcss';
import postcssCascadeLayers from '@csstools/postcss-cascade-layers';
import postcssIsPseudoClass from '@csstools/postcss-is-pseudo-class';
import { INITIAL_TRANSFER_BUDGET } from './scripts/initial-transfer-budget-config.mts';
import { collectRenderedWorkerAssets } from './scripts/service-worker-app-shell-guard-lib.mts';
import { classicRuntimeAssets } from './scripts/classic-runtime-assets.ts';
import {
  SERVICE_WORKER_OUTPUT_PATH,
  assertServiceWorkerJavaScript,
  assertServiceWorkerSourceCompleteness,
  compileServiceWorkerAsset,
  injectServiceWorkerSource,
} from './scripts/service-worker-asset.ts';
import { uiKitAsset } from './scripts/ui-kit-asset.ts';
import { auxiliaryBrowserAssets } from './scripts/auxiliary-browser-assets.ts';
import { useAsyncConnectMiddleware } from './scripts/async-connect-middleware.ts';
import { LANGUAGE_OPTIONS } from './src/i18n/locales.ts';

export const SECONDARY_JAVASCRIPT_CHUNK_RAW_LIMIT_BYTES = 500_000;
export const LEGACY_APP_BROWSER_TARGET = 'chrome79';

/**
 * Locale font stylesheets contain relative WOFF2 references and are toggled by
 * the static-page language runtime. Inlining one as a data: URL would change
 * the reference base and make every relative font URL inside it unusable.
 * Keep the WOFF2 shards external too so unicode-range remains genuinely lazy
 * instead of folding uncommon glyph shards into the stylesheet transfer.
 */
export function localeFontAssetInlineLimit(filePath: string): boolean | undefined {
  const normalized = filePath.replaceAll('\\', '/');
  return /(?:^|\/)(?:css\/fonts\/[^/]+\.css|fonts\/noto\/.+\.woff2)$/u.test(normalized)
    ? false
    : undefined;
}

const LEGACY_CSS_OPTIONS = {
  onRevertLayerKeyword: 'warn',
  onConditionalRulesChangingLayerOrder: 'warn',
  onImportLayerRule: 'warn',
} as const;

function legacyCssPlugins() {
  return [
    {
      postcssPlugin: 'musixquare-guard-legacy-layer-contract',
      Once(root) {
        root.walkAtRules('layer', (layer) => {
          if (layer.params.trim() !== 'desktop') return;
          layer.walkDecls((declaration) => {
            if (declaration.important) {
              throw new Error(
                `Legacy CSS desktop layer cannot contain !important: ${declaration.prop}`,
              );
            }
          });
        });
      },
    } satisfies PostCssPlugin,
    postcssCascadeLayers(LEGACY_CSS_OPTIONS),
    postcssIsPseudoClass({ preserve: false }),
    {
      postcssPlugin: 'musixquare-fail-closed-legacy-css',
      OnceExit(root, { result }) {
        const warnings = result.warnings();
        if (warnings.length > 0) {
          throw new Error(
            `Legacy CSS transform warning(s): ${warnings.map((warning) => warning.toString()).join('; ')}`,
          );
        }
        let hasLayerRule = false;
        let hasIsSelector = false;
        root.walkAtRules('layer', () => {
          hasLayerRule = true;
        });
        root.walkRules((rule) => {
          if (/:is\(/u.test(rule.selector)) hasIsSelector = true;
        });
        if (hasLayerRule || hasIsSelector) {
          throw new Error('Legacy CSS transform left an unsupported construct in the app bundle.');
        }
      },
    } satisfies PostCssPlugin,
  ];
}

export async function transformAppCssForLegacyBrowsers(css: string): Promise<string> {
  const result = await postcss(legacyCssPlugins()).process(css, {
    from: undefined,
  });

  const warnings = result.warnings();
  if (warnings.length > 0) {
    throw new Error(
      `Legacy CSS transform warning(s): ${warnings.map((warning) => warning.toString()).join('; ')}`,
    );
  }
  let hasLayerRule = false;
  let hasIsSelector = false;
  result.root.walkAtRules('layer', () => {
    hasLayerRule = true;
  });
  result.root.walkRules((rule) => {
    if (/:is\(/u.test(rule.selector)) hasIsSelector = true;
  });
  if (hasLayerRule || hasIsSelector) {
    throw new Error('Legacy CSS transform left an unsupported construct in the app bundle.');
  }
  return result.css;
}

interface JavaScriptChunkSize {
  readonly fileName: string;
  readonly name: string;
  readonly isEntry: boolean;
  readonly rawBytes: number;
}

export function oversizedSecondaryJavaScriptChunks(
  chunks: readonly JavaScriptChunkSize[],
  limit = SECONDARY_JAVASCRIPT_CHUNK_RAW_LIMIT_BYTES,
): JavaScriptChunkSize[] {
  return chunks.filter(
    (chunk) => !(chunk.isEntry && chunk.name === 'main') && chunk.rawBytes > limit,
  );
}

function guardSecondaryJavaScriptChunkSizes(): Plugin {
  return {
    name: 'musixquare-secondary-javascript-chunk-size',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk'
          ? [
              {
                fileName: output.fileName,
                name: output.name,
                isEntry: output.isEntry,
                rawBytes: Buffer.byteLength(output.code, 'utf8'),
              },
            ]
          : [],
      );
      const oversized = oversizedSecondaryJavaScriptChunks(chunks);
      if (oversized.length === 0) return;
      this.error(
        `Secondary JavaScript chunk limit exceeded (${SECONDARY_JAVASCRIPT_CHUNK_RAW_LIMIT_BYTES} B): ` +
          oversized.map(({ fileName, rawBytes }) => `${fileName}=${rawBytes} B`).join(', '),
      );
    },
  };
}

// Keep DNS rebinding protection enabled for local development. Vite always
// accepts IP literals, so LAN/device testing through --host still works. A
// one-off trusted tunnel can be added without weakening the global policy by
// setting __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS to its exact hostname.
const DEV_ALLOWED_HOSTS = ['localhost', '.localhost', '.musixquare.com'];

const PRODUCTION_API_ORIGIN = 'https://musixquare.com';
const PRODUCTION_API_PROXY_FLAG = 'MUSIXQUARE_DEV_PROXY_PRODUCTION_API';
const EVENT_CAMPAIGN_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const PRODUCTION_API_PROXY_PATHS = [
  '/api/security-config',
  '/api/capability-token',
  '/api/capability-challenge',
  '/api/youtube-search',
  '/api/youtube-playlist-entry',
  '/api/youtube-playlist-manifest',
] as const;

type DevEnvironment = Record<string, string | undefined>;

function eventCampaignSlugFromPath(pathname: string): string | null {
  const path = pathname.replace(/\/$/u, '');
  const direct = /^\/events\/([^/]+)$/u.exec(path);
  if (direct && EVENT_CAMPAIGN_SLUG_RE.test(direct[1])) return direct[1];
  const edition = /^\/events\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d+)$/u.exec(path);
  if (!edition) return null;
  const slug = `${edition[1]}-${edition[2]}`;
  return EVENT_CAMPAIGN_SLUG_RE.test(slug) ? slug : null;
}

export function productionApiProxyEnabled(env: DevEnvironment): boolean {
  return (
    String(env[PRODUCTION_API_PROXY_FLAG] || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

function failClosedDevApi(proxyEnabled: boolean): Plugin {
  const matchesProductionProxy = (pathname: string) =>
    PRODUCTION_API_PROXY_PATHS.some((candidate) => pathname === candidate);
  const middleware =
    (productionProxyAvailable: boolean): Connect.NextHandleFunction =>
    (req, res, next) => {
      let pathname = '';
      try {
        pathname = new URL(req.url || '/', 'http://localhost').pathname;
      } catch {
        next();
        return;
      }
      const isApiPath = pathname === '/api' || pathname.startsWith('/api/');
      if (!isApiPath || (productionProxyAvailable && matchesProductionProxy(pathname))) {
        next();
        return;
      }

      const productionProxyDisabled = matchesProductionProxy(pathname);
      const body = JSON.stringify({
        error: productionProxyDisabled ? 'LOCAL_API_PROXY_DISABLED' : 'LOCAL_API_NOT_CONFIGURED',
        message: productionProxyDisabled
          ? 'Local Vite does not proxy MUSIXQUARE production APIs unless explicitly enabled.'
          : 'This API route needs an explicit local mock or Worker backend.',
      });
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(req.method === 'HEAD' ? undefined : body);
    };
  return {
    name: 'fail-closed-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(middleware(proxyEnabled));
    },
    configurePreviewServer(server) {
      // `server.proxy` is a dev-server facility. Preview must stay fail-closed
      // even if the dev-only proxy flag is present in the shell environment.
      server.middlewares.use(middleware(false));
    },
  };
}

function productionApiProxy() {
  return Object.fromEntries(
    PRODUCTION_API_PROXY_PATHS.map((pathname) => [
      pathname,
      {
        target: PRODUCTION_API_ORIGIN,
        changeOrigin: true,
        secure: true,
      },
    ]),
  );
}

// Emits static workshop pages at dist root (instead of dist/.workshop/**/)
// so the static host can serve them without exposing dotfolder paths.
const flattenWorkshopHtml = (): Plugin => ({
  name: 'flatten-workshop-html',
  enforce: 'post',
  generateBundle(_opts, bundle) {
    const outputs: Record<string, string> = {
      '.workshop/landing/landing.html': 'about.html',
      '.workshop/privacy/privacy.html': 'privacy.html',
      '.workshop/terms/terms.html': 'terms.html',
      '.workshop/faq/faq.html': 'faq.html',
      '.workshop/developers/developers.html': 'developers.html',
    };
    for (const key of Object.keys(bundle)) {
      const normalized = key.replace(/\\/g, '/');
      const outputName = outputs[normalized];
      if (outputName) {
        const chunk = bundle[key];
        bundle[outputName] = { ...chunk, fileName: outputName };
        delete bundle[key];
      }
    }
  },
});

const STATIC_LOCALE_FONT_STYLESHEETS = [
  'noto-arabic.css',
  'noto-bengali.css',
  'noto-cyrillic.css',
  'noto-devanagari.css',
  'noto-greek.css',
  'noto-gujarati.css',
  'noto-gurmukhi.css',
  'noto-hebrew.css',
  'noto-jp.css',
  'noto-kannada.css',
  'noto-malayalam.css',
  'noto-sc.css',
  'noto-tamil.css',
  'noto-tc.css',
  'noto-telugu.css',
  'noto-thai.css',
] as const;

interface ViteCssMetadata {
  readonly importedCss?: ReadonlySet<string>;
}

function outputText(source: string | Uint8Array): string {
  return typeof source === 'string' ? source : new TextDecoder().decode(source);
}

function localeFontStylesheetFromOutputPath(outputPath: string): string | null {
  const baseName = outputPath.replace(/\\/gu, '/').split('/').pop() || '';
  const matches = STATIC_LOCALE_FONT_STYLESHEETS.filter((sourceName) => {
    const stem = sourceName.slice(0, -'.css'.length);
    return (
      baseName === sourceName || (baseName.startsWith(`${stem}-`) && baseName.endsWith('.css'))
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

function resolveBundleAssetPath(stylesheetPath: string, rawUrl: string): string | null {
  if (/^(?:data|https?):/iu.test(rawUrl)) return null;
  try {
    return new URL(rawUrl, `https://musixquare.invalid/${stylesheetPath}`).pathname.replace(
      /^\/+/,
      '',
    );
  } catch {
    return null;
  }
}

function stylesheetWoff2Urls(css: string): string[] {
  return [...css.matchAll(/url\((?:["']?)([^)"']+\.woff2)(?:["']?)\)/giu)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

/**
 * About keeps locale font links disabled until the language bootstrap selects
 * one. Vite consequently treats those authored links as raw assets, while the
 * app's dynamic CSS imports produce the correctly rewritten CSS/WOFF2 graph.
 * Repoint the disabled links at that processed graph and remove the orphan raw
 * copies without making any locale stylesheet part of the initial app graph.
 */
export const bindStaticLocaleFontAssets = (): Plugin => ({
  name: 'bind-static-locale-font-assets',
  apply: 'build',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const chunks = new Map(
      Object.values(bundle)
        .filter((output) => output.type === 'chunk')
        .map((chunk) => [chunk.fileName, chunk]),
    );
    const processedCssBySource = new Map<string, string>();

    for (const output of Object.values(bundle)) {
      if (output.type !== 'asset' || !output.fileName.endsWith('.css')) continue;
      const sourceName = localeFontStylesheetFromOutputPath(output.fileName);
      if (!sourceName) continue;
      const fontUrls = stylesheetWoff2Urls(outputText(output.source));
      if (fontUrls.length === 0) continue;
      const isProcessed = fontUrls.every((fontUrl) => {
        const fontPath = resolveBundleAssetPath(output.fileName, fontUrl);
        return Boolean(fontPath && bundle[fontPath]?.type === 'asset');
      });
      if (!isProcessed) continue;
      if (processedCssBySource.has(sourceName)) {
        this.error(`Duplicate processed locale font CSS mapping for ${sourceName}.`);
      }
      processedCssBySource.set(sourceName, output.fileName);
    }

    if (processedCssBySource.size !== STATIC_LOCALE_FONT_STYLESHEETS.length) {
      const missing = STATIC_LOCALE_FONT_STYLESHEETS.filter(
        (sourceName) => !processedCssBySource.has(sourceName),
      );
      this.error(`Processed locale font CSS mapping is incomplete: ${missing.join(', ')}`);
    }

    const aboutOutput = bundle['about.html'];
    if (!aboutOutput || aboutOutput.type !== 'asset') {
      this.error('Could not locate the flattened About HTML output.');
    }
    const authoredHtml = outputText(aboutOutput.source);
    const rawCssAssets = new Set<string>();
    const linkedSources = new Set<string>();
    const linkedProcessedCss = new Set<string>();
    let linkCount = 0;
    const rewrittenHtml = authoredHtml.replace(
      /<link\b(?=[^>]*\bdata-static-lang-font-codes=["'][^"']+["'])[^>]*>/giu,
      (tag) => {
        linkCount += 1;
        const hrefMatch = /\bhref=(["'])([^"']+)\1/iu.exec(tag);
        const href = hrefMatch?.[2] || '';
        if (!href || href.startsWith('data:')) {
          this.error(`About locale font link has an invalid build href: ${href || '(missing)'}`);
        }
        const rawOutputPath = href.replace(/^\/+/, '');
        const sourceName = localeFontStylesheetFromOutputPath(rawOutputPath);
        if (!sourceName) {
          this.error(`Could not identify About locale font source from ${href}.`);
        }
        const processedCss = processedCssBySource.get(sourceName);
        if (!processedCss || bundle[processedCss]?.type !== 'asset') {
          this.error(`Processed About locale font CSS is missing for ${sourceName}.`);
        }
        if (linkedSources.has(sourceName) || linkedProcessedCss.has(processedCss)) {
          this.error(`Duplicate About locale font link mapping for ${sourceName}.`);
        }
        linkedSources.add(sourceName);
        linkedProcessedCss.add(processedCss);
        rawCssAssets.add(rawOutputPath);
        return tag.replace(href, `/${processedCss}`);
      },
    );

    if (
      linkCount !== STATIC_LOCALE_FONT_STYLESHEETS.length ||
      linkedSources.size !== STATIC_LOCALE_FONT_STYLESHEETS.length
    ) {
      this.error(
        `About must map exactly ${STATIC_LOCALE_FONT_STYLESHEETS.length} locale font links (found ${linkCount}).`,
      );
    }
    aboutOutput.source = rewrittenHtml;

    for (const processedCss of linkedProcessedCss) {
      const cssOutput = bundle[processedCss];
      if (!cssOutput || cssOutput.type !== 'asset') {
        this.error(`Linked processed locale font CSS is missing: ${processedCss}.`);
      }
      const css = outputText(cssOutput.source);
      const fontUrls = stylesheetWoff2Urls(css);
      if (fontUrls.length === 0) {
        this.error(`Linked locale font CSS has no WOFF2 assets: ${processedCss}.`);
      }
      for (const fontUrl of fontUrls) {
        const fontPath = fontUrl ? resolveBundleAssetPath(processedCss, fontUrl) : null;
        if (!fontPath || bundle[fontPath]?.type !== 'asset') {
          this.error(
            `Linked locale font CSS has an unresolved WOFF2 URL: ${processedCss} -> ${fontUrl || '(missing)'}.`,
          );
        }
      }
    }

    const appEntry = [...chunks.values()].find(
      (chunk) =>
        chunk.isEntry &&
        Object.keys(chunk.modules).some((id) => id.replace(/\\/gu, '/').endsWith('/src/app.ts')),
    );
    if (!appEntry) this.error('Could not locate the MUSIXQUARE app entry chunk.');
    const initialCss = new Set<string>();
    const visited = new Set<string>();
    const pending = [appEntry.fileName];
    while (pending.length > 0) {
      const fileName = pending.pop();
      if (!fileName || visited.has(fileName)) continue;
      visited.add(fileName);
      const chunk = chunks.get(fileName);
      if (!chunk) continue;
      const metadata = (chunk as typeof chunk & { viteMetadata?: ViteCssMetadata }).viteMetadata;
      for (const css of metadata?.importedCss ?? []) initialCss.add(css);
      pending.push(...chunk.imports);
    }
    const eagerLocaleCss = [...linkedProcessedCss].filter((fileName) => initialCss.has(fileName));
    if (eagerLocaleCss.length > 0) {
      this.error(
        `Locale fonts leaked into the initial app CSS graph: ${eagerLocaleCss.join(', ')}`,
      );
    }

    const initialAppHtml = bundle['index.html'];
    if (!initialAppHtml || initialAppHtml.type !== 'asset') {
      this.error('Could not locate the canonical app HTML output.');
    }
    const initialAppSource = outputText(initialAppHtml.source);
    const eagerHtmlLinks = [...linkedProcessedCss].filter((fileName) =>
      initialAppSource.includes(`/${fileName}`),
    );
    if (eagerHtmlLinks.length > 0) {
      this.error(`Locale fonts leaked into the initial app HTML: ${eagerHtmlLinks.join(', ')}`);
    }

    for (const rawCss of rawCssAssets) {
      const stillReferenced = Object.values(bundle).some(
        (output) =>
          output.type === 'asset' &&
          output.fileName.endsWith('.html') &&
          outputText(output.source).includes(`/${rawCss}`),
      );
      if (stillReferenced) {
        this.error(`Raw locale font CSS is still referenced after rebinding: ${rawCss}.`);
      }
      const rawOutput = bundle[rawCss];
      if (!rawOutput || rawOutput.type !== 'asset') {
        this.error(`Expected orphan raw locale font CSS is missing: ${rawCss}.`);
      }
      delete bundle[rawCss];
    }
  },
});

const LOCALIZED_PAGE_CODES = new Set<string>(LANGUAGE_OPTIONS.map(({ code }) => code));

export function pageAliasTarget(rawUrl: string, built = false): string | null {
  const queryStart = rawUrl.indexOf('?');
  const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const query = queryStart === -1 ? '' : rawUrl.slice(queryStart);
  const normalizedPath = (pathname.replace(/\/+$/, '') || '/').toLowerCase();
  const localizedAboutMatch = /^\/([^/]+)\/about(?:\.html)?$/u.exec(normalizedPath);
  const localizedAppMatch = /^\/([^/]+)(?:\/index\.html)?$/u.exec(normalizedPath);

  let target: string | null = null;
  if (localizedAboutMatch && LOCALIZED_PAGE_CODES.has(localizedAboutMatch[1] || '')) {
    const code = localizedAboutMatch[1] || 'en';
    target = built
      ? code === 'en'
        ? '/about.html'
        : `/${code}/about.html`
      : '/.workshop/landing/landing.html';
  } else if (localizedAppMatch && LOCALIZED_PAGE_CODES.has(localizedAppMatch[1] || '')) {
    const code = localizedAppMatch[1] || 'en';
    target = built && code !== 'en' ? `/${code}/index.html` : '/index.html';
  } else if (eventCampaignSlugFromPath(normalizedPath)) {
    target = '/events/index.html';
  } else if (
    normalizedPath === '/about' ||
    normalizedPath === '/about.html' ||
    normalizedPath === '/landing'
  ) {
    target = built ? '/about.html' : '/.workshop/landing/landing.html';
  } else if (normalizedPath === '/privacy' || normalizedPath === '/privacy.html') {
    target = built ? '/privacy.html' : '/.workshop/privacy/privacy.html';
  } else if (normalizedPath === '/terms' || normalizedPath === '/terms.html') {
    target = built ? '/terms.html' : '/.workshop/terms/terms.html';
  } else if (normalizedPath === '/faq' || normalizedPath === '/faq.html') {
    target = built ? '/faq.html' : '/.workshop/faq/faq.html';
  } else if (normalizedPath === '/developers' || normalizedPath === '/developers.html') {
    target = built ? '/developers.html' : '/.workshop/developers/developers.html';
  } else if (
    normalizedPath === '/history' ||
    normalizedPath === '/changelog' ||
    normalizedPath === '/roadmap'
  ) {
    target = '/history/index.html';
  } else if (normalizedPath === '/blog') {
    target = '/blog/index.html';
  } else if (normalizedPath === '/designsystem') {
    target = '/designsystem/index.html';
  }
  return target ? target + query : null;
}

// Lets local development and the E2E preview resolve canonical pages the same
// way the production Worker does.
const devPageAliases = (): Plugin => ({
  name: 'dev-page-aliases',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const target = pageAliasTarget(req.url ?? '');
      if (target) req.url = target;
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, _res, next) => {
      const target = pageAliasTarget(req.url ?? '', true);
      if (target) req.url = target;
      next();
    });
  },
});

export function prioritizeActiveStylesheetsInHtml(html: string): string {
  const inertBlocks: string[] = [];
  const inertBlockPattern = /<(noscript|template)\b[^>]*>[\s\S]*?<\/\1>/giu;
  const maskedHtml = html.replace(inertBlockPattern, (block) => {
    const placeholder = `<!--__MUSIXQUARE_INERT_BLOCK_${inertBlocks.length}__-->`;
    inertBlocks.push(block);
    return placeholder;
  });
  const restoreInertBlocks = (value: string): string =>
    value.replace(/<!--__MUSIXQUARE_INERT_BLOCK_(\d+)__-->/gu, (_match, index: string) => {
      const block = inertBlocks[Number(index)];
      if (block === undefined) throw new Error(`Missing inert HTML block ${index}.`);
      return block;
    });

  const stylesheetPattern = /\s*<link\b[^>]*\brel=(["'])stylesheet\1[^>]*>\s*/gi;
  const stylesheets = maskedHtml.match(stylesheetPattern);
  if (!stylesheets?.length) return html;

  const firstModuleScript = maskedHtml.search(/<script\b[^>]*\btype=(["'])module\1[^>]*>/i);
  if (firstModuleScript === -1) return html;

  const withoutStylesheets = maskedHtml.replace(stylesheetPattern, '\n');
  const insertAt = withoutStylesheets.search(/<script\b[^>]*\btype=(["'])module\1[^>]*>/i);
  if (insertAt === -1) return html;

  const block = stylesheets.map((tag) => tag.trim()).join('\n    ');
  return restoreInertBlocks(
    `${withoutStylesheets.slice(0, insertAt)}${block}\n    ${withoutStylesheets.slice(insertAt)}`,
  );
}

const prioritizeStylesheetsInHtml = (): Plugin => ({
  name: 'prioritize-stylesheets-in-html',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler: prioritizeActiveStylesheetsInHtml,
  },
});

const REVIEWED_DEFERRED_APP_SHELL_ROOTS = [
  '/src/core/sw-hard-reset.ts',
  '/src/demo/mode.ts',
  '/src/i18n/localized-app-head.ts',
  '/src/network/room-session-feature-runtime.ts',
  '/src/player/media-session.ts',
  '/src/ui/announcement.ts',
  '/src/ui/connect-session-runtime.ts',
  '/src/ui/manual-sync-overlay-runtime.ts',
  '/src/youtube/standard-host-manual-offset-runtime.ts',
] as const;

const DEFERRED_ENTRY_MODULES = [
  ...REVIEWED_DEFERRED_APP_SHELL_ROOTS,
  '/src/network/system-audio-host.ts',
  '/src/network/system-audio-guest.ts',
  '/src/network/system-audio-sfu.ts',
  '/src/pro-room/system-audio-service.ts',
  '/src/player/media-session.ts',
  '/src/player/local-output-rejoin.ts',
  '/src/ui/connect.ts',
] as const;

// QR encoding, PeerJS, Connect, and room-only listeners are needed only after
// explicit user/session actions. Fail the build if any reviewed deferred
// dependency accidentally re-enters the static closure of app.ts.
const guardInitialAppBundleGraph = (): Plugin => ({
  name: 'guard-initial-app-bundle-graph',
  apply: 'build',
  generateBundle(_options, bundle) {
    const chunks = new Map(
      Object.values(bundle)
        .filter((output) => output.type === 'chunk')
        .map((chunk) => [chunk.fileName, chunk]),
    );
    const appEntry = [...chunks.values()].find(
      (chunk) =>
        chunk.isEntry &&
        Object.keys(chunk.modules).some((id) => id.replace(/\\/g, '/').endsWith('/src/app.ts')),
    );
    if (!appEntry) this.error('Could not locate the MUSIXQUARE app entry chunk.');

    const staticClosure = new Set<string>();
    const pending = [appEntry.fileName];
    while (pending.length > 0) {
      const fileName = pending.pop();
      if (!fileName || staticClosure.has(fileName)) continue;
      staticClosure.add(fileName);
      const chunk = chunks.get(fileName);
      if (chunk) pending.push(...chunk.imports);
    }

    const forbidden = [...staticClosure].flatMap((fileName) => {
      const chunk = chunks.get(fileName);
      if (!chunk) return [];
      return Object.keys(chunk.modules)
        .map((id) => id.replace(/\\/g, '/'))
        .filter((id) => /\/node_modules\/(?:peerjs|qrcode)\//.test(id));
    });
    if (forbidden.length > 0) {
      this.error(
        `PeerJS/QRCode leaked into the initial app graph:\n${forbidden
          .map((id) => `  - ${id}`)
          .join('\n')}`,
      );
    }

    const deferredLeaks = [...staticClosure].flatMap((fileName) => {
      const chunk = chunks.get(fileName);
      if (!chunk) return [];
      return Object.keys(chunk.modules)
        .map((id) => id.replace(/\\/g, '/'))
        .filter((id) => DEFERRED_ENTRY_MODULES.some((suffix) => id.endsWith(suffix)));
    });
    if (deferredLeaks.length > 0) {
      this.error(
        `Reviewed deferred modules leaked into the initial app graph:\n${deferredLeaks
          .map((id) => `  - ${id}`)
          .join('\n')}`,
      );
    }
  },
});

const OPTIONAL_PRIMARY_FONT_ASSETS = [
  './primary-font-loader.js',
  './primary-font.css',
  './designsystem/fonts/PretendardVariable.woff2',
] as const;

function serviceWorkerAssetPath(fileName: string): string {
  return `./${fileName.replace(/^\/+/, '')}`;
}

interface StaticBuildChunk {
  type: 'chunk';
  fileName: string;
  isEntry: boolean;
  imports: string[];
  referencedFiles?: string[];
  code?: string;
  modules: Record<string, unknown>;
  viteMetadata?: { importedCss?: Set<string> };
}

/**
 * Collect the complete JS/CSS closure required to execute the canonical app
 * entry plus reviewed deferred roots that must survive a cold-offline update.
 */
export function collectStaticAppEntryAssets(bundle: Record<string, unknown>): string[] {
  const chunks = new Map(
    Object.values(bundle)
      .filter((output): output is StaticBuildChunk => {
        return Boolean(
          output && typeof output === 'object' && (output as { type?: string }).type === 'chunk',
        );
      })
      .map((chunk) => [chunk.fileName, chunk]),
  );
  const appEntry = [...chunks.values()].find(
    (chunk) =>
      chunk.isEntry &&
      Object.keys(chunk.modules).some((id) => id.replace(/\\/gu, '/').endsWith('/src/app.ts')),
  );
  if (!appEntry) return [];

  const deferredRoots = REVIEWED_DEFERRED_APP_SHELL_ROOTS.map((moduleSuffix) => {
    const chunk = [...chunks.values()].find((candidate) =>
      Object.keys(candidate.modules).some((id) => id.replace(/\\/gu, '/').endsWith(moduleSuffix)),
    );
    if (!chunk) {
      throw new Error(`Could not locate reviewed deferred app-shell root ${moduleSuffix}.`);
    }
    return chunk.fileName;
  });

  const assets = new Set<string>();
  const visited = new Set<string>();
  const pending = [appEntry.fileName, ...deferredRoots];
  while (pending.length > 0) {
    const fileName = pending.pop();
    if (!fileName || visited.has(fileName)) continue;
    visited.add(fileName);
    const chunk = chunks.get(fileName);
    if (!chunk) continue;
    assets.add(serviceWorkerAssetPath(chunk.fileName));
    for (const css of chunk.viteMetadata?.importedCss ?? []) {
      assets.add(serviceWorkerAssetPath(css));
    }
    // Vite emits `new Worker(new URL(..., import.meta.url))` as a referenced
    // Rollup file rather than a static JS import. It is nevertheless created
    // during app bootstrap, before service-worker registration, so it belongs
    // to the deterministic cold-offline closure of the entry chunk.
    for (const referencedFile of chunk.referencedFiles ?? []) {
      if (typeof referencedFile === 'string' && bundle[referencedFile]) {
        assets.add(serviceWorkerAssetPath(referencedFile));
      }
    }
    for (const renderedWorkerPath of collectRenderedWorkerAssets(chunk.code || '')) {
      const fileName = renderedWorkerPath.replace(/^\/+/, '');
      const output = Object.values(bundle).find(
        (candidate) =>
          candidate &&
          typeof candidate === 'object' &&
          (candidate as { fileName?: unknown }).fileName === fileName,
      );
      if (output) assets.add(serviceWorkerAssetPath(fileName));
    }
    pending.push(...chunk.imports);
  }
  return [...assets].sort();
}

/**
 * Return the stable lazy Pretendard runtime closure. These publicDir assets are
 * deliberately absent from the page's initial script/stylesheet graph.
 */
export function collectOptionalPrimaryFontAssets(_bundle: Record<string, unknown>): string[] {
  return [...OPTIONAL_PRIMARY_FONT_ASSETS];
}

export function injectBuildEntryAssets(
  serviceWorker: string,
  assets: readonly string[],
  optionalPrimaryFontAssets: readonly string[],
): string {
  if (assets.length === 0) throw new Error('Canonical app entry manifest is empty.');
  if (optionalPrimaryFontAssets.length !== OPTIONAL_PRIMARY_FONT_ASSETS.length) {
    throw new Error('Optional primary-font manifest is incomplete.');
  }
  return injectServiceWorkerSource(serviceWorker, {
    buildEntryAssets: assets,
    optionalPrimaryFontAssets,
  });
}

export const serviceWorkerAsset = (): Plugin => {
  let repoRoot = '';
  let productionBuild = false;
  let emittedReferenceId = '';
  return {
    name: 'musixquare-service-worker-asset',
    configResolved(config) {
      repoRoot = config.root;
      productionBuild = config.command === 'build';
    },
    async configureServer(server) {
      await assertServiceWorkerSourceCompleteness(server.config.root);
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
        if (pathname !== `/${SERVICE_WORKER_OUTPUT_PATH}`) {
          next();
          return;
        }
        try {
          const { code } = await compileServiceWorkerAsset(server.config.root);
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
      await assertServiceWorkerSourceCompleteness(repoRoot);
      emittedReferenceId = this.emitFile({
        type: 'asset',
        fileName: SERVICE_WORKER_OUTPUT_PATH,
      });
    },
    async generateBundle(_options, bundle) {
      if (!productionBuild) return;
      const assets = collectStaticAppEntryAssets(bundle);
      if (assets.length === 0) this.error('Could not collect the MUSIXQUARE app entry manifest.');
      const optionalPrimaryFontAssets = collectOptionalPrimaryFontAssets(bundle);
      if (optionalPrimaryFontAssets.length !== OPTIONAL_PRIMARY_FONT_ASSETS.length) {
        this.error('Could not collect the MUSIXQUARE optional primary-font manifest.');
      }
      const compiled = await compileServiceWorkerAsset(repoRoot, {
        buildEntryAssets: assets,
        optionalPrimaryFontAssets,
      });
      if (!emittedReferenceId) this.error('Service-worker output reference was not emitted.');
      this.setAssetSource(emittedReferenceId, compiled.code);
      const output = bundle[SERVICE_WORKER_OUTPUT_PATH];
      if (!output || output.type !== 'asset') {
        this.error(`Service-worker build output is missing: ${SERVICE_WORKER_OUTPUT_PATH}`);
      }
      output.source = compiled.code;
      assertServiceWorkerJavaScript(compiled.code);
      if (bundle[`${SERVICE_WORKER_OUTPUT_PATH}.map`]) {
        this.error(
          `Service-worker sourcemap must not be emitted: ${SERVICE_WORKER_OUTPUT_PATH}.map`,
        );
      }
    },
  };
};

const EXPECTED_PLAYLIST_DYNAMIC_IMPORTERS = [
  'src/player/playlist-loader.ts',
  'src/storage/preload.ts',
] as const;
const EXPECTED_PLAYLIST_STATIC_IMPORTERS = [
  'src/app.ts',
  'src/pro-room/runtime.ts',
  'src/ui/player-controls.ts',
] as const;

function repositoryModulePath(moduleId: string): string {
  const normalized = moduleId.trim().replace(/\\/gu, '/');
  const sourceIndex = normalized.lastIndexOf('/src/');
  return sourceIndex === -1 ? normalized.replace(/^\.\//u, '') : normalized.slice(sourceIndex + 1);
}

function hasExactMultiset(actual: string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const remaining = new Map<string, number>();
  for (const value of expected) remaining.set(value, (remaining.get(value) || 0) + 1);
  for (const value of actual) {
    const count = remaining.get(value) || 0;
    if (count === 0) return false;
    if (count === 1) remaining.delete(value);
    else remaining.set(value, count - 1);
  }
  return remaining.size === 0;
}

export function isExpectedPlaylistImportOverlapWarning(message: string): boolean {
  const match =
    /^(?:\[plugin vite:reporter\]\s+)?\(!\)\s+(.+?) is dynamically imported by (.+?) but also statically imported by (.+?), dynamic import will not move module into another chunk\.$/u.exec(
      message.trim(),
    );
  if (!match) return false;

  const [, target, dynamicImporters, staticImporters] = match;
  return (
    repositoryModulePath(target) === 'src/player/playlist.ts' &&
    hasExactMultiset(
      dynamicImporters.split(', ').map(repositoryModulePath),
      EXPECTED_PLAYLIST_DYNAMIC_IMPORTERS,
    ) &&
    hasExactMultiset(
      staticImporters.split(', ').map(repositoryModulePath),
      EXPECTED_PLAYLIST_STATIC_IMPORTERS,
    )
  );
}

export function createViteConfig(env: DevEnvironment = {}): UserConfig {
  const proxyProductionApi = productionApiProxyEnabled(env);
  return {
    root: '.',
    publicDir: 'public',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    plugins: [
      serviceWorkerAsset(),
      classicRuntimeAssets(),
      uiKitAsset(),
      auxiliaryBrowserAssets(),
      flattenWorkshopHtml(),
      bindStaticLocaleFontAssets(),
      devPageAliases(),
      failClosedDevApi(proxyProductionApi),
      prioritizeStylesheetsInHtml(),
      guardInitialAppBundleGraph(),
      guardSecondaryJavaScriptChunkSizes(),
    ],
    css: {
      // css/app.css imports the complete base + desktop cascade. Vite runs its
      // internal postcss-import pass before this plugin, so layer lowering sees
      // the whole ordered cascade before Rollup computes the immutable asset hash.
      postcss: {
        plugins: legacyCssPlugins(),
      },
    },
    build: {
      outDir: 'dist',
      target: LEGACY_APP_BROWSER_TARGET,
      cssTarget: LEGACY_APP_BROWSER_TARGET,
      assetsInlineLimit: localeFontAssetInlineLimit,
      sourcemap: false,
      // Vite's built-in threshold is global. Suppress the known main-entry
      // warning at its architectural ceiling; the build plugin above retains a
      // strict 500 kB raw limit for every other emitted JavaScript chunk.
      chunkSizeWarningLimit: INITIAL_TRANSFER_BUDGET.entryScriptRawBytes / 1_000,
      rollupOptions: {
        onwarn(warning, warn) {
          // playlist.ts is already part of the startup graph, but its reviewed
          // dynamic imports deliberately defer calls across player/preload
          // cycles. Permit only the exact current importer multiset (including
          // transport.ts's three distinct call sites); any graph drift fails.
          if (isExpectedPlaylistImportOverlapWarning(warning.message)) {
            return;
          }
          if (
            warning.message.includes('is dynamically imported by') &&
            warning.message.includes('but also statically imported by')
          ) {
            throw new Error(`Unreviewed static/dynamic import overlap: ${warning.message}`);
          }
          warn(warning);
        },
        input: {
          main: resolve(__dirname, 'index.html'),
          landing: resolve(__dirname, '.workshop/landing/landing.html'),
          privacy: resolve(__dirname, '.workshop/privacy/privacy.html'),
          terms: resolve(__dirname, '.workshop/terms/terms.html'),
          faq: resolve(__dirname, '.workshop/faq/faq.html'),
          developers: resolve(__dirname, '.workshop/developers/developers.html'),
        },
        output: {
          manualChunks: {
            peerjs: ['peerjs'],
          },
        },
      },
    },
    server: {
      port: 3000,
      open: true,
      allowedHosts: DEV_ALLOWED_HOSTS,
      proxy: proxyProductionApi ? productionApiProxy() : undefined,
    },
    worker: {
      format: 'es',
    },
  };
}

export default defineConfig(({ mode }) => {
  const fileEnvironment = loadEnv(mode, process.cwd(), '');
  return createViteConfig({ ...fileEnvironment, ...process.env });
});
