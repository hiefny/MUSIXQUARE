import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';

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
      if (normalizedPath === '/about' || normalizedPath === '/about.html' || normalizedPath === '/landing') {
        target = '/.workshop/landing/landing.html';
      } else if (normalizedPath === '/privacy' || normalizedPath === '/privacy.html') {
        target = '/.workshop/privacy/privacy.html';
      } else if (normalizedPath === '/terms' || normalizedPath === '/terms.html') {
        target = '/.workshop/terms/terms.html';
      } else if (normalizedPath === '/faq' || normalizedPath === '/faq.html') {
        target = '/.workshop/faq/faq.html';
      } else if (
        normalizedPath === '/history' ||
        normalizedPath === '/changelog' ||
        normalizedPath === '/roadmap'
      ) {
        target = '/history/index.html';
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

export default defineConfig({
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  plugins: [flattenWorkshopHtml(), devPageAliases()],
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
    allowedHosts: true,
  },
  worker: {
    format: 'es',
  },
});
