import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { loadAppLocaleRecoveryData } from './translation-catalog.ts';

export function createLocaleRecoveryAssets(modules: ReadonlyMap<string, unknown>): {
  assets: Map<string, string>;
  urls: Record<string, string>;
} {
  const assets = new Map<string, string>();
  const urls: Record<string, string> = Object.create(null);
  for (const [code, payload] of modules) {
    const source = `${JSON.stringify(payload)}\n`;
    const hash = createHash('sha256').update(source).digest('base64url').slice(0, 8);
    const fileName = `assets/locale-recovery-${code}-${hash}.json`;
    assets.set(fileName, source);
    urls[code] = `/${fileName}`;
  }
  return { assets, urls };
}

/** Immutable data fallback, selected by this document's build rather than a mutable manifest. */
export function localeRecoveryAssets(): Plugin {
  let assets = new Map<string, string>();
  return {
    name: 'MUSIXQUARE-locale-recovery-assets',
    async config(config) {
      const generated = createLocaleRecoveryAssets(
        await loadAppLocaleRecoveryData(resolve(config.root || '.')),
      );
      assets = generated.assets;
      return { define: { __MXQR_LOCALE_RECOVERY_URLS__: JSON.stringify(generated.urls) } };
    },
    buildStart() {
      for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://vite.local').pathname;
        const source = assets.get(pathname.slice(1));
        if (source === undefined) return next();
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
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
