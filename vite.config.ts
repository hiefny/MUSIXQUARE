import { defineConfig, loadEnv, type Plugin, type UserConfig } from 'vite';
import { resolve } from 'path';

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
  return {
    name: 'fail-closed-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let pathname = '';
        try {
          pathname = new URL(req.url || '/', 'http://localhost').pathname;
        } catch {
          next();
          return;
        }
        const isApiPath = pathname === '/api' || pathname.startsWith('/api/');
        if (!isApiPath || (proxyEnabled && matchesProductionProxy(pathname))) {
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
      });
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

function pageAliasTarget(rawUrl: string): string | null {
  const queryStart = rawUrl.indexOf('?');
  const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const query = queryStart === -1 ? '' : rawUrl.slice(queryStart);
  const normalizedPath = (pathname.replace(/\/+$/, '') || '/').toLowerCase();

  let target: string | null = null;
  if (eventCampaignSlugFromPath(normalizedPath)) {
    target = '/events/index.html';
  } else if (
    normalizedPath === '/about' ||
    normalizedPath === '/about.html' ||
    normalizedPath === '/landing'
  ) {
    target = '/.workshop/landing/landing.html';
  } else if (normalizedPath === '/privacy' || normalizedPath === '/privacy.html') {
    target = '/.workshop/privacy/privacy.html';
  } else if (normalizedPath === '/terms' || normalizedPath === '/terms.html') {
    target = '/.workshop/terms/terms.html';
  } else if (normalizedPath === '/faq' || normalizedPath === '/faq.html') {
    target = '/.workshop/faq/faq.html';
  } else if (normalizedPath === '/developers' || normalizedPath === '/developers.html') {
    target = '/.workshop/developers/developers.html';
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
      const target = pageAliasTarget(req.url ?? '');
      if (target) req.url = target;
      next();
    });
  },
});

const prioritizeStylesheetsInHtml = (): Plugin => ({
  name: 'prioritize-stylesheets-in-html',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      const stylesheetPattern = /\s*<link\b[^>]*\brel=(["'])stylesheet\1[^>]*>\s*/gi;
      const stylesheets = html.match(stylesheetPattern);
      if (!stylesheets?.length) return html;

      const firstModuleScript = html.search(/<script\b[^>]*\btype=(["'])module\1[^>]*>/i);
      if (firstModuleScript === -1) return html;

      const withoutStylesheets = html.replace(stylesheetPattern, '\n');
      const insertAt = withoutStylesheets.search(/<script\b[^>]*\btype=(["'])module\1[^>]*>/i);
      if (insertAt === -1) return html;

      const block = stylesheets.map((tag) => tag.trim()).join('\n    ');
      return `${withoutStylesheets.slice(0, insertAt)}${block}\n    ${withoutStylesheets.slice(insertAt)}`;
    },
  },
});

// QR encoding and PeerJS are needed only after session actions. Fail the build
// if either dependency accidentally re-enters the static closure of app.ts.
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
  },
});

const EXPECTED_PLAYLIST_DYNAMIC_IMPORTERS = [
  'src/player/decode.ts',
  'src/player/playback.ts',
  'src/player/transport.ts',
  'src/player/transport.ts',
  'src/player/transport.ts',
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
      flattenWorkshopHtml(),
      devPageAliases(),
      failClosedDevApi(proxyProductionApi),
      prioritizeStylesheetsInHtml(),
      guardInitialAppBundleGraph(),
    ],
    build: {
      outDir: 'dist',
      target: 'es2022',
      sourcemap: false,
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
