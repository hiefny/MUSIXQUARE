import { describe, expect, it, vi } from 'vitest';

import {
  PRODUCTION_API_PROXY_PATHS,
  createViteConfig,
  isExpectedPlaylistImportOverlapWarning,
  productionApiProxyEnabled,
} from '../../../vite.config.ts';

type DevMiddleware = (
  request: { method?: string; url?: string },
  response: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  },
  next: () => void,
) => void;

function failClosedMiddleware(env: Record<string, string | undefined>): DevMiddleware | null {
  const config = createViteConfig(env);
  const plugin = (config.plugins || []).find(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      'name' in candidate &&
      candidate.name === 'fail-closed-dev-api',
  ) as { configureServer?: unknown } | undefined;
  if (!plugin) {
    throw new Error('fail-closed-dev-api plugin is missing');
  }

  let middleware: DevMiddleware | null = null;
  const configure = plugin.configureServer as unknown as (server: {
    middlewares: { use(value: DevMiddleware): void };
  }) => void;
  configure({ middlewares: { use: (value) => (middleware = value) } });
  return middleware;
}

function invoke(middleware: DevMiddleware, url: string, method = 'GET') {
  const headers = new Map<string, string>();
  let body: string | undefined;
  const next = vi.fn();
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(value?: string) {
      body = value;
    },
  };
  middleware({ method, url }, response, next);
  return { body, headers, next, response };
}

describe('Vite local API safety', () => {
  it('keeps production API proxying disabled unless the exact opt-in is true', () => {
    expect(productionApiProxyEnabled({})).toBe(false);
    expect(productionApiProxyEnabled({ MUSIXQUARE_DEV_PROXY_PRODUCTION_API: 'false' })).toBe(false);
    expect(productionApiProxyEnabled({ MUSIXQUARE_DEV_PROXY_PRODUCTION_API: '1' })).toBe(false);
    expect(productionApiProxyEnabled({ MUSIXQUARE_DEV_PROXY_PRODUCTION_API: ' TRUE ' })).toBe(true);
    expect(createViteConfig({}).server?.proxy).toBeUndefined();
  });

  it.each(PRODUCTION_API_PROXY_PATHS)('fails closed before SPA fallback for %s', (pathname) => {
    const middleware = failClosedMiddleware({});
    expect(middleware).not.toBeNull();
    const result = invoke(middleware!, `${pathname}?local-safety=1`);

    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.statusCode).toBe(503);
    expect(result.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(result.body || '{}')).toMatchObject({
      error: 'LOCAL_API_PROXY_DISABLED',
    });
  });

  it('leaves unrelated local routes to the Vite middleware chain', () => {
    const middleware = failClosedMiddleware({});
    expect(middleware).not.toBeNull();
    const result = invoke(middleware!, '/about?local=1');

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.response.statusCode).toBe(200);
    expect(result.body).toBeUndefined();
  });

  it('fails closed for unconfigured local API routes instead of serving the SPA', () => {
    const middleware = failClosedMiddleware({});
    expect(middleware).not.toBeNull();
    const result = invoke(middleware!, '/api/announcement/current');

    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.statusCode).toBe(503);
    expect(JSON.parse(result.body || '{}')).toMatchObject({
      error: 'LOCAL_API_NOT_CONFIGURED',
    });
  });

  it('installs the six production proxies only after explicit opt-in', () => {
    const config = createViteConfig({ MUSIXQUARE_DEV_PROXY_PRODUCTION_API: 'true' });
    const proxy = config.server?.proxy;

    expect(Object.keys(proxy || {})).toEqual(PRODUCTION_API_PROXY_PATHS);
    for (const pathname of PRODUCTION_API_PROXY_PATHS) {
      expect(proxy?.[pathname]).toMatchObject({
        target: 'https://musixquare.com',
        changeOrigin: true,
        secure: true,
      });
    }
    const middleware = failClosedMiddleware({ MUSIXQUARE_DEV_PROXY_PRODUCTION_API: 'true' });
    expect(middleware).not.toBeNull();
    const proxied = invoke(middleware!, '/api/security-config');
    expect(proxied.next).toHaveBeenCalledOnce();

    const playlistManifest = invoke(
      middleware!,
      '/api/youtube-playlist-manifest?playlistId=PL_VALID_01',
    );
    expect(playlistManifest.next).toHaveBeenCalledOnce();

    const siblingPrefix = invoke(middleware!, '/api/security-config-backup');
    expect(siblingPrefix.next).not.toHaveBeenCalled();
    expect(siblingPrefix.response.statusCode).toBe(503);
    expect(JSON.parse(siblingPrefix.body || '{}')).toMatchObject({
      error: 'LOCAL_API_NOT_CONFIGURED',
    });

    const localOnly = invoke(middleware!, '/api/announcement/current');
    expect(localOnly.next).not.toHaveBeenCalled();
    expect(localOnly.response.statusCode).toBe(503);
  });
});

describe('Vite dynamic/static overlap policy', () => {
  const reviewedWarning = `[plugin vite:reporter]
(!) C:/repo/src/player/playlist.ts is dynamically imported by C:/repo/src/player/playlist-loader.ts, C:/repo/src/storage/preload.ts but also statically imported by C:/repo/src/app.ts, C:/repo/src/pro-room/runtime.ts, C:/repo/src/ui/player-controls.ts, dynamic import will not move module into another chunk.`;

  it('allows only the reviewed playlist importer multiset', () => {
    expect(isExpectedPlaylistImportOverlapWarning(reviewedWarning)).toBe(true);
  });

  it('accepts the same reviewed multiset from a raw Rollup warning message', () => {
    const rawWarning = reviewedWarning.replace('[plugin vite:reporter]\n', '');
    expect(isExpectedPlaylistImportOverlapWarning(rawWarning)).toBe(true);
  });

  it('rejects a synthetic importer even when the warning still targets playlist.ts', () => {
    const changedWarning = reviewedWarning.replace(
      ' but also statically imported by',
      ', C:/repo/src/youtube/player.ts but also statically imported by',
    );
    expect(isExpectedPlaylistImportOverlapWarning(changedWarning)).toBe(false);

    const onwarn = createViteConfig({}).build?.rollupOptions?.onwarn;
    expect(typeof onwarn).toBe('function');
    expect(() =>
      (onwarn as unknown as (warning: { message: string }, warn: () => void) => void)(
        { message: changedWarning },
        vi.fn(),
      ),
    ).toThrow('Unreviewed static/dynamic import overlap');
  });

  it('rejects a missing reviewed importer occurrence', () => {
    const changedWarning = reviewedWarning.replace('C:/repo/src/player/playlist-loader.ts, ', '');
    expect(isExpectedPlaylistImportOverlapWarning(changedWarning)).toBe(false);
  });
});
