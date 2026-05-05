import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';

// Emits about.html at dist root (instead of dist/.workshop/landing/)
// so Netlify can serve it without exposing the dotfolder path.
const flattenLandingHtml = (): Plugin => ({
  name: 'flatten-landing-html',
  enforce: 'post',
  generateBundle(_opts, bundle) {
    for (const key of Object.keys(bundle)) {
      if (key.endsWith('/landing.html') && key.includes('.workshop')) {
        const chunk = bundle[key];
        bundle['about.html'] = { ...chunk, fileName: 'about.html' };
        delete bundle[key];
      }
    }
  },
});

// Lets local dev resolve public/canonical pages the same way Netlify does.
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
  plugins: [flattenLandingHtml(), devPageAliases()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        landing: resolve(__dirname, '.workshop/landing/landing.html'),
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
