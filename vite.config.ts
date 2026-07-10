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

let foundationChunkIds: Set<string> | undefined;

export default defineConfig({
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  plugins: [flattenWorkshopHtml(), devPageAliases(), prioritizeStylesheetsInHtml()],
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
        // Build one dependency-closed foundation chunk from the static source
        // DAG. A prefix of a dependencies-first topological order cannot form
        // a chunk cycle with the remaining entry graph. Dynamic entries (demo,
        // debug tools, locale dictionaries) retain their natural lazy chunks.
        onlyExplicitManualChunks: true,
        manualChunks(id, { getModuleIds, getModuleInfo }) {
          const normalized = id.replace(/\\/g, '/');
          if (normalized.includes('vite/preload-helper')) return 'app-foundation';
          if (normalized.includes('commonjsHelpers')) return 'vendor';
          if (normalized.includes('/node_modules/peerjs/')) return 'peerjs';
          if (normalized.includes('/node_modules/')) return 'vendor';

          if (!foundationChunkIds) {
            const candidates = new Set(
              [...getModuleIds()].filter((moduleId) => {
                const modulePath = moduleId.replace(/\\/g, '/');
                const info = getModuleInfo(moduleId);
                return (
                  modulePath.includes('/src/') &&
                  modulePath.endsWith('.ts') &&
                  !modulePath.includes('/src/workers/') &&
                  !info?.isDynamicEntry
                );
              }),
            );
            const ordered: string[] = [];
            const visiting = new Set<string>();
            const visited = new Set<string>();
            const visit = (moduleId: string): void => {
              if (visited.has(moduleId) || visiting.has(moduleId)) return;
              visiting.add(moduleId);
              const dependencies = (getModuleInfo(moduleId)?.importedIds ?? [])
                .filter((dependency) => candidates.has(dependency))
                .sort();
              for (const dependency of dependencies) visit(dependency);
              visiting.delete(moduleId);
              visited.add(moduleId);
              ordered.push(moduleId);
            };
            for (const moduleId of [...candidates].sort()) visit(moduleId);

            const totalCodeSize = ordered.reduce(
              (sum, moduleId) => sum + (getModuleInfo(moduleId)?.code?.length ?? 0),
              0,
            );
            // Leave headroom under the 500 kB minified warning as the project
            // grows; the entry chunk is intentionally the larger remainder.
            const targetSize = totalCodeSize * 0.42;
            let foundationSize = 0;
            foundationChunkIds = new Set<string>();
            for (const moduleId of ordered) {
              if (foundationSize >= targetSize) break;
              foundationChunkIds.add(moduleId);
              foundationSize += getModuleInfo(moduleId)?.code?.length ?? 0;
            }
          }

          if (foundationChunkIds.has(id)) return 'app-foundation';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 3000,
    open: true,
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
    },
  },
  worker: {
    format: 'es',
  },
});
