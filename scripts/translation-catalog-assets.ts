import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import { useAsyncConnectMiddleware } from './async-connect-middleware.ts';
import { loadCatalogs, type Catalog } from './translation-catalog.ts';

export const TRANSLATION_CATALOG_MANIFEST = 'translation-catalogs.json';

export function createTranslationCatalogAssets(
  catalogs: ReadonlyMap<string, Catalog>,
): Map<string, string> {
  const assets = new Map<string, string>();
  const locales: Record<string, string> = Object.create(null);
  for (const [code, catalog] of catalogs) {
    const source = `${JSON.stringify(catalog)}\n`;
    // Match the existing eight-character URL-safe immutable asset convention.
    const hash = createHash('sha256').update(source).digest('base64url').slice(0, 8);
    const fileName = `assets/translation-catalog-${code}-${hash}.json`;
    assets.set(fileName, source);
    locales[code] = `/${fileName}`;
  }
  assets.set(TRANSLATION_CATALOG_MANIFEST, `${JSON.stringify({ version: 1, locales })}\n`);
  return assets;
}

/** Emit public read-only copy data. TypeScript AST processing stays entirely in Node at build time. */
export function translationCatalogAssets(): Plugin {
  let repositoryRoot = '';
  let productionBuild = false;
  return {
    name: 'MUSIXQUARE-translation-catalog-assets',
    configResolved(config) {
      repositoryRoot = config.root;
      productionBuild = config.command === 'build';
    },
    async buildStart() {
      if (!productionBuild) return;
      const assets = createTranslationCatalogAssets(await loadCatalogs(repositoryRoot));
      for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source });
    },
    configureServer(server) {
      let assetsFlight: Promise<Map<string, string>> | null = null;
      useAsyncConnectMiddleware(server.middlewares, async (request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://vite.local').pathname;
        if (
          pathname !== `/${TRANSLATION_CATALOG_MANIFEST}` &&
          !/^\/assets\/translation-catalog-[a-z]{2,3}(?:-[a-z]+)?-[A-Za-z0-9_-]{8}\.json$/u.test(
            pathname,
          )
        ) {
          next();
          return;
        }
        // Share one snapshot on demand; unrelated app dev requests never parse translations.
        assetsFlight ??= loadCatalogs(server.config.root)
          .then(createTranslationCatalogAssets)
          .catch((error: unknown) => {
            assetsFlight = null;
            throw error;
          });
        const assets = await assetsFlight;
        const source = assets.get(pathname.slice(1));
        if (source === undefined) {
          next();
          return;
        }
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405;
          response.setHeader('Allow', 'GET, HEAD');
          response.end();
          return;
        }
        response.end(request.method === 'HEAD' ? undefined : source);
      });
    },
  };
}
