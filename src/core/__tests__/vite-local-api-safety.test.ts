import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  PRODUCTION_API_PROXY_PATHS,
  collectOptionalPrimaryFontAssets,
  collectStaticAppEntryAssets,
  createViteConfig,
  injectBuildEntryAssets,
  isExpectedPlaylistImportOverlapWarning,
  pageAliasTarget,
  productionApiProxyEnabled,
} from '../../../vite.config.ts';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import {
  collectActiveStartupAssets,
  collectRenderedWorkerAssets,
  parseServiceWorkerAppShell,
} from '../../../scripts/service-worker-app-shell-guard-lib.mts';
import { SERVICE_WORKER_CACHE_VERSION } from '../../../scripts/service-worker-asset.ts';

type DevMiddleware = (
  request: { method?: string; url?: string },
  response: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  },
  next: () => void,
) => void;

function failClosedMiddleware(
  env: Record<string, string | undefined>,
  surface: 'dev' | 'preview' = 'dev',
): DevMiddleware | null {
  const config = createViteConfig(env);
  const plugin = (config.plugins || []).find(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      'name' in candidate &&
      candidate.name === 'fail-closed-dev-api',
  ) as { configureServer?: unknown; configurePreviewServer?: unknown } | undefined;
  if (!plugin) {
    throw new Error('fail-closed-dev-api plugin is missing');
  }

  let middleware: DevMiddleware | null = null;
  const configure = (surface === 'preview'
    ? plugin.configurePreviewServer
    : plugin.configureServer) as unknown as (server: {
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
  it('maps localized app and About routes to source and built counterparts', () => {
    expect(pageAliasTarget('/ko/?campaign=launch')).toBe('/index.html?campaign=launch');
    expect(pageAliasTarget('/ko/about?campaign=launch')).toBe(
      '/.workshop/landing/landing.html?campaign=launch',
    );
    expect(pageAliasTarget('/ko/?campaign=launch', true)).toBe('/ko/index.html?campaign=launch');
    expect(pageAliasTarget('/ko/about?campaign=launch', true)).toBe(
      '/ko/about.html?campaign=launch',
    );
    expect(pageAliasTarget('/about', true)).toBe('/about.html');
    expect(pageAliasTarget('/123456')).toBeNull();
  });

  it('keeps the local Worker guide aligned with the loopback fail-closed contract', async () => {
    const guide = (await readFile(resolve('docs/local-worker-integration.md'), 'utf8')).replace(
      /\s+/g,
      ' ',
    );

    expect(guide).toContain('browser API clients also fail closed on loopback by default');
    expect(guide).toContain(
      'VITE_MUSIXQUARE_ALLOW_LOCAL_PRODUCTION_API_FALLBACK` resolves to the exact `true` string after trim/case normalization',
    );
    expect(guide).toContain('E2E builds ignore that implicit fallback flag');
    expect(guide).toContain(
      'Public production and staging origins retain their canonical fallback',
    );
    expect(guide).not.toContain(
      'In every build mode, the PRO facade uses its canonical production endpoint',
    );
    expect(guide).not.toContain(
      'TURN and Realtime paths try the local relative route first and then',
    );
  });

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

  it.each([
    '/api/get-turn-config',
    '/api/cloudflare-realtime',
    '/api/pro-room/v1/rooms/000001/bootstrap',
  ])('keeps the loopback network fallback boundary on a same-origin 503 for %s', (pathname) => {
    const middleware = failClosedMiddleware({});
    expect(middleware).not.toBeNull();
    const result = invoke(middleware!, `${pathname}?local-safety=1`);

    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.statusCode).toBe(503);
    expect(result.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(result.body || '{}')).toEqual({
      error: 'LOCAL_API_NOT_CONFIGURED',
      message: 'This API route needs an explicit local mock or Worker backend.',
    });
  });

  it('installs the same fail-closed API boundary on Vite preview', () => {
    const middleware = failClosedMiddleware(
      { MUSIXQUARE_DEV_PROXY_PRODUCTION_API: 'true' },
      'preview',
    );
    expect(middleware).not.toBeNull();

    const unconfigured = invoke(middleware!, '/api/pro-room/v1/rooms/000001/bootstrap');
    expect(unconfigured.next).not.toHaveBeenCalled();
    expect(unconfigured.response.statusCode).toBe(503);
    expect(JSON.parse(unconfigured.body || '{}')).toMatchObject({
      error: 'LOCAL_API_NOT_CONFIGURED',
    });

    const devProxyOnly = invoke(middleware!, '/api/security-config');
    expect(devProxyOnly.next).not.toHaveBeenCalled();
    expect(devProxyOnly.response.statusCode).toBe(503);
    expect(JSON.parse(devProxyOnly.body || '{}')).toMatchObject({
      error: 'LOCAL_API_PROXY_DISABLED',
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

describe('service-worker build entry manifest', () => {
  it('minifies the readable early bootstrap before release output', async () => {
    const asset = CLASSIC_RUNTIME_ASSETS.find(
      (candidate) => candidate.outputPath === 'bootstrap.js',
    );
    if (!asset) throw new Error('Classic bootstrap runtime is missing from the manifest.');
    const source = await readFile(resolve(asset.sourcePath), 'utf8');
    const minified = (await compileClassicRuntimeAsset(resolve('.'), asset)).code;

    expect(minified.length).toBeLessThan(source.length);
    expect(minified).toContain('/primary-font-loader.js');
    expect(minified).not.toContain('Synchronous setup that must run before first paint');
  });

  it('collects the canonical entry JS/CSS and emitted Worker/file closure', () => {
    const bundle = {
      'assets/app.js': {
        type: 'chunk',
        fileName: 'assets/app.js',
        isEntry: true,
        imports: ['assets/vendor.js'],
        referencedFiles: ['assets/static-runtime.bin'],
        code: 'new Worker(new URL("/assets/sync.worker.js", import.meta.url), { type: "module" });',
        modules: { 'C:/repo/src/app.ts': {} },
        viteMetadata: { importedCss: new Set(['assets/app.css']) },
      },
      'assets/vendor.js': {
        type: 'chunk',
        fileName: 'assets/vendor.js',
        isEntry: false,
        imports: [],
        modules: { 'C:/repo/src/vendor.ts': {} },
        viteMetadata: { importedCss: new Set(['assets/vendor.css']) },
      },
      'assets/lazy.js': {
        type: 'chunk',
        fileName: 'assets/lazy.js',
        isEntry: false,
        imports: [],
        modules: { 'C:/repo/src/lazy.ts': {} },
      },
      'assets/connect.js': {
        type: 'chunk',
        fileName: 'assets/connect.js',
        isEntry: false,
        imports: ['assets/vendor.js'],
        modules: { 'C:/repo/src/ui/connect-session-runtime.ts': {} },
      },
      'assets/demo-mode.js': {
        type: 'chunk',
        fileName: 'assets/demo-mode.js',
        isEntry: false,
        imports: ['assets/vendor.js'],
        modules: { 'C:/repo/src/demo/mode.ts': {} },
      },
      'assets/room-features.js': {
        type: 'chunk',
        fileName: 'assets/room-features.js',
        isEntry: false,
        imports: ['assets/room-audio.js'],
        modules: { 'C:/repo/src/network/room-session-feature-runtime.ts': {} },
      },
      'assets/room-audio.js': {
        type: 'chunk',
        fileName: 'assets/room-audio.js',
        isEntry: false,
        imports: [],
        modules: { 'C:/repo/src/network/system-audio-host.ts': {} },
      },
      'assets/media-session.js': {
        type: 'chunk',
        fileName: 'assets/media-session.js',
        isEntry: false,
        imports: ['assets/vendor.js'],
        modules: { 'C:/repo/src/player/media-session.ts': {} },
      },
      'assets/manual-sync-overlay.js': {
        type: 'chunk',
        fileName: 'assets/manual-sync-overlay.js',
        isEntry: false,
        imports: ['assets/vendor.js'],
        modules: { 'C:/repo/src/ui/manual-sync-overlay-runtime.ts': {} },
      },
      'assets/standard-host-manual-offset.js': {
        type: 'chunk',
        fileName: 'assets/standard-host-manual-offset.js',
        isEntry: false,
        imports: ['assets/vendor.js'],
        modules: {
          'C:/repo/src/youtube/standard-host-manual-offset-runtime.ts': {},
        },
      },
      'assets/sync.worker.js': {
        type: 'asset',
        fileName: 'assets/sync.worker.js',
        source: 'self.onmessage = () => undefined;',
      },
      'assets/static-runtime.bin': {
        type: 'asset',
        fileName: 'assets/static-runtime.bin',
        source: 'runtime',
      },
    };

    expect(collectStaticAppEntryAssets(bundle)).toEqual([
      './assets/app.css',
      './assets/app.js',
      './assets/connect.js',
      './assets/demo-mode.js',
      './assets/manual-sync-overlay.js',
      './assets/media-session.js',
      './assets/room-audio.js',
      './assets/room-features.js',
      './assets/standard-host-manual-offset.js',
      './assets/static-runtime.bin',
      './assets/sync.worker.js',
      './assets/vendor.css',
      './assets/vendor.js',
    ]);
    expect(collectOptionalPrimaryFontAssets(bundle)).toEqual([
      './primary-font-loader.js',
      './primary-font.css',
      './designsystem/fonts/PretendardVariable.woff2',
    ]);
  });

  it('discovers only same-origin rendered Worker URL module expressions', () => {
    const source = `
      const primary = new Worker(new URL('/assets/sync.worker-hash.js', import.meta.url), { type: 'module' });
      const shared = new SharedWorker(new URL('./assets/shared.worker.js', import.meta.url));
      new Worker('/assets/string-worker.js');
      new Worker(new URL('https://cdn.example/foreign-worker.js', import.meta.url));
      const inert = "new Worker(new URL('/assets/not-code.js', import.meta.url))";
    `;

    expect(collectRenderedWorkerAssets(source)).toEqual([
      '/assets/shared.worker.js',
      '/assets/sync.worker-hash.js',
    ]);
  });

  it('injects exactly one non-empty manifest and rejects missing contracts', () => {
    const source = `
      const CACHE_VERSION = '__MUSIXQUARE_CACHE_VERSION__';
      const BUILD_ENTRY_ASSETS = [/* __MUSIXQUARE_BUILD_ENTRY_ASSETS__ */];
      const OPTIONAL_PRIMARY_FONT_ASSETS = [/* __MUSIXQUARE_OPTIONAL_PRIMARY_FONT_ASSETS__ */];
    `;
    const optional = [
      './primary-font-loader.js',
      './primary-font.css',
      './designsystem/fonts/PretendardVariable.woff2',
    ];
    const injected = injectBuildEntryAssets(
      source,
      ['./assets/app.js', './assets/app.css'],
      optional,
    );

    expect(injected).toContain('"./assets/app.js"');
    expect(injected).toContain('"./assets/app.css"');
    expect(injected).toContain('"./primary-font-loader.js"');
    expect(injected).toContain('"./primary-font.css"');
    expect(injected).toContain('"./designsystem/fonts/PretendardVariable.woff2"');
    expect(injected).toContain(`const CACHE_VERSION = '${SERVICE_WORKER_CACHE_VERSION}';`);
    expect(injected).not.toContain('__MUSIXQUARE_CACHE_VERSION__');
    expect(injected).not.toContain('__MUSIXQUARE_BUILD_ENTRY_ASSETS__');
    expect(injected).not.toContain('__MUSIXQUARE_OPTIONAL_PRIMARY_FONT_ASSETS__');
    expect(() => injectBuildEntryAssets(source, [], optional)).toThrow('manifest is empty');
    expect(() => injectBuildEntryAssets(source, ['./app.js'], [])).toThrow(
      'font manifest is incomplete',
    );
    expect(() =>
      injectBuildEntryAssets('const BUILD_ENTRY_ASSETS = [];', ['./app.js'], optional),
    ).toThrow('Expected one');
  });

  it('finds module and classic startup scripts while excluding inert or non-cacheable sources', () => {
    const html = `<!doctype html><html><head>
      <script src="/assets/app.js" crossorigin type="module"></script>
      <link href="/assets/app.css" media="screen" rel="preload stylesheet">
      <script src="/classic.js"></script>
      <script defer src="/deferred.js"></script>
      <script src="/typed-classic.js" type="text/javascript; charset=utf-8"></script>
      <script src="/data-block.js" type="application/json"></script>
      <script src="https://cdn.example/external.js"></script>
      <script src="data:text/javascript,void 0"></script>
      <script src="blob:https://musixquare.invalid/not-cacheable"></script>
      <script>window.inlineStartup = true;</script>
      <template><script src="/template.js" type="module"></script></template>
      <noscript><link href="/noscript.css" rel="stylesheet"></noscript>
      <svg><script href="/foreign.js" type="module"></script></svg>
    </head></html>`;

    expect(collectActiveStartupAssets(html)).toEqual([
      '/assets/app.js',
      '/assets/app.css',
      '/classic.js',
      '/deferred.js',
      '/typed-classic.js',
    ]);
  });

  it('resolves the symbolic bootstrap cache key with the built cache epoch', () => {
    const worker = `
      const CACHE_VERSION = 'v401';
      const BOOTSTRAP_CACHE_KEY = \`./bootstrap.js?cache=\${CACHE_VERSION}\`;
      const BUILD_ENTRY_ASSETS = ['./assets/app.js'];
      const APP_SHELL = ['./index.html', BOOTSTRAP_CACHE_KEY, ...BUILD_ENTRY_ASSETS];
    `;

    expect(parseServiceWorkerAppShell(worker)).toEqual({
      entries: ['./index.html', './bootstrap.js?cache=v401', './assets/app.js'],
      buildEntries: ['./assets/app.js'],
    });
    expect(() =>
      parseServiceWorkerAppShell(worker.replace('?cache=${CACHE_VERSION}', '?v=${CACHE_VERSION}')),
    ).toThrow('Could not resolve BOOTSTRAP_CACHE_KEY');
  });
});
