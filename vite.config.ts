import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED } from './src/player/file-playback-production-release-latch.ts';
import { LEGACY_BOUNDED_FILE_PRODUCTION_RELEASE_ENABLED } from './src/player/legacy-bounded-file-production-latch.ts';

const APP_ENTRY_MODULE = '/src/app.ts';
const LEGACY_BOUNDED_PRODUCTION_ARTIFACT_DEFINE = '__MXQR_LEGACY_BOUNDED_PRODUCTION_ARTIFACT__';
const LEGACY_BOUNDED_PRODUCTION_ARTIFACT_MARKER =
  '__MXQR_PRODUCTION_LEGACY_BOUNDED_GATE_MATCHES_LATCH_V2_FALSE__';
const LEGACY_BOUNDED_GATE_IMPORT =
  "import { isLegacyBoundedFileEnabled as isProductionLegacyBoundedFileEnabled } from './player/legacy-bounded-file-gate.ts';";
const V2_GATE_IMPORT =
  "import { isFilePlaybackEngineV2Enabled as isProductionFilePlaybackV2Enabled } from './player/file-playback-engine-gate.ts';";

// Keep DNS rebinding protection enabled for local development. Vite always
// accepts IP literals, so LAN/device testing through --host still works. A
// one-off trusted tunnel can be added without weakening the global policy by
// setting __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS to its exact hostname.
const DEV_ALLOWED_HOSTS = ['localhost', '.localhost', '.musixquare.com'];

/**
 * Gives exact production builds a non-spoofable artifact identity. When the
 * release environment requests the redesigned bounded V1 route, it also
 * rejects every old-V2 flag/latch combination and embeds a bootstrap
 * assertion that the two immutable gate decisions match the tracked latches.
 */
const installLegacyBoundedProductionArtifact = (): Plugin => {
  let productionArtifact = false;
  let productionGateRequested = false;
  let transformedEntries = 0;

  return {
    name: 'install-legacy-bounded-production-artifact',
    apply: 'build',
    enforce: 'pre',
    config(_config, environment) {
      productionArtifact = environment.mode === 'production';
      return {
        define: {
          [LEGACY_BOUNDED_PRODUCTION_ARTIFACT_DEFINE]: JSON.stringify(productionArtifact),
        },
      };
    },
    configResolved(config) {
      const effectiveEnvironmentValue = (name: string): unknown => {
        const defined = config.define?.[`import.meta.env.${name}`];
        if (defined !== undefined) {
          try {
            return JSON.parse(defined);
          } catch {
            return undefined;
          }
        }
        return config.env[name];
      };

      productionGateRequested =
        productionArtifact && effectiveEnvironmentValue('VITE_MUSIXQUARE_LEGACY_BOUNDED') === '1';
      if (!productionGateRequested) return;

      if (
        config.mode !== 'production' ||
        config.define?.[LEGACY_BOUNDED_PRODUCTION_ARTIFACT_DEFINE] !== 'true'
      ) {
        throw new Error('Bounded V1 production release requires exact production identity');
      }
      if (
        effectiveEnvironmentValue('VITE_MUSIXQUARE_FILE_ENGINE_V2') !== '0' ||
        effectiveEnvironmentValue('VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1') !== '0' ||
        FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED
      ) {
        throw new Error('Bounded V1 production release requires the retired V2 engine OFF');
      }
    },
    transform(source, rawId) {
      if (!productionGateRequested) return null;
      const id = rawId.replace(/\\/g, '/').split('?', 1)[0];
      if (!id?.endsWith(APP_ENTRY_MODULE)) return null;

      transformedEntries += 1;
      const invariant = `const productionLegacyBoundedFileEnabled = isProductionLegacyBoundedFileEnabled();
const productionFilePlaybackV2Enabled = isProductionFilePlaybackV2Enabled();
if (
  productionLegacyBoundedFileEnabled !== ${String(LEGACY_BOUNDED_FILE_PRODUCTION_RELEASE_ENABLED)} ||
  productionFilePlaybackV2Enabled
) {
  throw new Error('${LEGACY_BOUNDED_PRODUCTION_ARTIFACT_MARKER}');
}`;
      return {
        code: `${LEGACY_BOUNDED_GATE_IMPORT}\n${V2_GATE_IMPORT}\n${invariant}\n${source}`,
        map: null,
      };
    },
    buildEnd(error) {
      if (!error && productionGateRequested && transformedEntries !== 1) {
        throw new Error(
          `Bounded V1 production build transformed ${transformedEntries} app entries; expected exactly one`,
        );
      }
    },
    generateBundle(_options, bundle) {
      if (!productionGateRequested) return;
      let markerOccurrences = 0;
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        markerOccurrences +=
          output.code.split(LEGACY_BOUNDED_PRODUCTION_ARTIFACT_MARKER).length - 1;
      }
      if (markerOccurrences !== 1) {
        throw new Error(
          `Bounded V1 production artifact contains ${markerOccurrences} gate markers; expected exactly one`,
        );
      }
    },
  };
};

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

// Lets local dev resolve public/canonical pages the same way the prod host does.
const devPageAliases = (): Plugin => ({
  name: 'dev-page-aliases',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const rawUrl = req.url ?? '';
      const queryStart = rawUrl.indexOf('?');
      const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
      const query = queryStart === -1 ? '' : rawUrl.slice(queryStart);
      const normalizedPath = (pathname.replace(/\/+$/, '') || '/').toLowerCase();

      let target: string | null = null;
      if (
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

      if (target) {
        req.url = target + query;
      }
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

export default defineConfig({
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  plugins: [
    installLegacyBoundedProductionArtifact(),
    flattenWorkshopHtml(),
    devPageAliases(),
    prioritizeStylesheetsInHtml(),
    guardInitialAppBundleGraph(),
  ],
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
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
    proxy: {
      '/api/security-config': {
        target: 'https://musixquare.com',
        changeOrigin: true,
        secure: true,
      },
      '/api/capability-token': {
        target: 'https://musixquare.com',
        changeOrigin: true,
        secure: true,
      },
      '/api/capability-challenge': {
        target: 'https://musixquare.com',
        changeOrigin: true,
        secure: true,
      },
      '/api/youtube-search': {
        target: 'https://musixquare.com',
        changeOrigin: true,
        secure: true,
      },
      '/api/youtube-playlist-entry': {
        target: 'https://musixquare.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  worker: {
    format: 'es',
  },
});
