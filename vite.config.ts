import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';

// Keep DNS rebinding protection enabled for local development. Vite always
// accepts IP literals, so LAN/device testing through --host still works. A
// one-off trusted tunnel can be added without weakening the global policy by
// setting __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS to its exact hostname.
const DEV_ALLOWED_HOSTS = ['localhost', '.localhost', '.musixquare.com'];

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
