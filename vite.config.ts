import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';

import { cloudflare } from "@cloudflare/vite-plugin";

// Emits landing.html at dist root (instead of dist/.workshop/landing/)
// so Netlify can serve it without exposing the dotfolder path.
const flattenLandingHtml = (): Plugin => ({
  name: 'flatten-landing-html',
  enforce: 'post',
  generateBundle(_opts, bundle) {
    for (const key of Object.keys(bundle)) {
      if (key.endsWith('/landing.html') && key.includes('.workshop')) {
        const chunk = bundle[key];
        bundle['landing.html'] = { ...chunk, fileName: 'landing.html' };
        delete bundle[key];
      }
    }
  },
});

// Lets `/landing`, `/landing/`, and `/landing.html` resolve to the page
// in dev the same way Netlify serves it in prod.
const landingDevAlias = (): Plugin => ({
  name: 'landing-dev-alias',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const path = req.url?.split('?')[0];
      if (path === '/landing' || path === '/landing/' || path === '/landing.html') {
        const q = req.url!.includes('?') ? '?' + req.url!.split('?')[1] : '';
        req.url = '/.workshop/landing/landing.html' + q;
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
  plugins: [flattenLandingHtml(), landingDevAlias(), cloudflare()],
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