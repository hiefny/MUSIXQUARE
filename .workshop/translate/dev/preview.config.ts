import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { translationCatalogAssets } from '../../../scripts/translation-catalog-assets.ts';
import { handleCatalogRequest, isLocalPreviewRequest, loadCatalogs, sendJson } from './catalog.ts';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const previewDirectory = path.join(repositoryRoot, 'scratch/translate-preview-2026-09-08');

export default defineConfig(({ command, isPreview }) => {
  if (command !== 'serve' || isPreview) {
    throw new Error('This configuration is only for the local translation development preview.');
  }
  return {
    root: repositoryRoot,
    publicDir: path.join(repositoryRoot, 'public'),
    cacheDir: path.join(previewDirectory, '.vite'),
    envDir: previewDirectory,
    envPrefix: 'TRANSLATION_PREVIEW_',
    appType: 'mpa',
    server: {
      host: '127.0.0.1',
      port: 4317,
      strictPort: true,
      open: false,
      allowedHosts: ['localhost'],
      cors: false,
      fs: { strict: true, allow: [repositoryRoot] },
    },
    plugins: [
      {
        name: 'translation-editor-local-preview',
        apply: 'serve',
        async configureServer(server) {
          // Validate the full literal catalog once at startup. Restart after source copy changes.
          const catalogs = await loadCatalogs(repositoryRoot);
          server.middlewares.use((request, response, next) => {
            if (!isLocalPreviewRequest(request)) {
              sendJson(response, 403, { error: 'Local preview requests only.' });
              return;
            }
            response.setHeader('X-Robots-Tag', 'noindex, nofollow');
            if (handleCatalogRequest(request, response, catalogs)) return;
            const rawUrl = request.url ?? '/';
            if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
              sendJson(response, 400, { error: 'Invalid local path.' });
              return;
            }
            const url = new URL(rawUrl, 'http://127.0.0.1:4317');
            if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
              sendJson(response, 404, {
                error: 'Production APIs are not connected to this preview.',
              });
              return;
            }
            if (url.pathname === '/translate' || url.pathname === '/translate/') {
              request.url = `/.workshop/translate/translate.html${url.search}`;
            }
            // /css/pretendard.css is a repository-root source. Its existing font URL,
            // /designsystem/fonts/PretendardVariable.woff2, is served from publicDir.
            next();
          });
        },
      },
      translationCatalogAssets(),
    ],
  };
});
