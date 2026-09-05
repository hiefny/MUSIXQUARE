import vm from 'node:vm';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import {
  SERVICE_WORKER_CACHE_VERSION,
  compileServiceWorkerAsset,
} from '../../../scripts/service-worker-asset.ts';

const BOOTSTRAP_ASSET = CLASSIC_RUNTIME_ASSETS.find(
  (candidate) => candidate.outputPath === 'bootstrap.js',
);
if (!BOOTSTRAP_ASSET) throw new Error('Classic bootstrap runtime is missing from the manifest.');
const BOOTSTRAP_SOURCE = (await compileClassicRuntimeAsset(process.cwd(), BOOTSTRAP_ASSET)).code;
const TEST_OPTIONAL_FONT_RUNTIME = './primary-font-loader.js';
const TEST_OPTIONAL_FONT_CSS = './primary-font.css';
const TEST_OPTIONAL_FONT_BODY = './designsystem/fonts/PretendardVariable.woff2';
const [SERVICE_WORKER_SOURCE, EXECUTABLE_SERVICE_WORKER_SOURCE] = await Promise.all([
  compileServiceWorkerAsset(process.cwd()).then(({ code }) => code),
  compileServiceWorkerAsset(process.cwd(), {
    buildEntryAssets: [],
    optionalPrimaryFontAssets: [
      TEST_OPTIONAL_FONT_RUNTIME,
      TEST_OPTIONAL_FONT_CSS,
      TEST_OPTIONAL_FONT_BODY,
    ],
  }).then(({ code }) => code),
]);
const ACTIVE_CACHE_VERSION = SERVICE_WORKER_CACHE_VERSION;
const NAVIGATION_NETWORK_TIMEOUT_MS = Number(
  /^\s*const NAVIGATION_NETWORK_TIMEOUT_MS = ([\de_+.]+);$/mu
    .exec(SERVICE_WORKER_SOURCE)?.[1]
    ?.replaceAll('_', ''),
);
const NAVIGATION_STATE_CLIENT_LOOKUP_TIMEOUT_MS = Number(
  /^\s*const NAVIGATION_STATE_CLIENT_LOOKUP_TIMEOUT_MS = ([\de_+.]+);$/mu
    .exec(SERVICE_WORKER_SOURCE)?.[1]
    ?.replaceAll('_', ''),
);
const OPTIONAL_ASSET_GROUP_TIMEOUT_MS = Number(
  /^\s*const OPTIONAL_ASSET_GROUP_TIMEOUT_MS = ([\de_+.]+);$/mu
    .exec(SERVICE_WORKER_SOURCE)?.[1]
    ?.replaceAll('_', ''),
);
if (!Number.isFinite(OPTIONAL_ASSET_GROUP_TIMEOUT_MS)) {
  throw new Error('Unable to resolve the service worker optional-asset timeout');
}
if (!Number.isFinite(NAVIGATION_NETWORK_TIMEOUT_MS)) {
  throw new Error('Unable to resolve the service worker navigation timeout');
}
if (!Number.isFinite(NAVIGATION_STATE_CLIENT_LOOKUP_TIMEOUT_MS)) {
  throw new Error('Unable to resolve the service worker navigation-client lookup timeout');
}
const APP_SHELL_SOURCE = /\bconst\s+APP_SHELL\s*=\s*\[([\s\S]*?)\]\s*;/u.exec(
  SERVICE_WORKER_SOURCE,
)?.[1];
if (!APP_SHELL_SOURCE) {
  throw new Error('Unable to resolve the service worker app shell');
}
const RETIRED_CACHE_VERSION = 'v194';

type FetchListener = (event: {
  request: Request;
  clientId?: string;
  resultingClientId?: string;
  respondWith: (response: Promise<Response>) => void;
  waitUntil: (work: Promise<unknown>) => void;
}) => void;

type ExtendableListener = (event: { waitUntil: (work: Promise<unknown>) => void }) => void;

type MessageListener = (event: {
  data: Record<string, unknown>;
  source?: { id: string; postMessage: ReturnType<typeof vi.fn> };
  waitUntil: (work: Promise<unknown>) => void;
}) => void;

type CacheMatchMock = Mock<
  (request: Request, options?: { cacheName?: string }) => Promise<Response | undefined>
>;
type FetchMock = Mock<(request: Request, init?: RequestInit) => Promise<Response>>;
type TestClient = { id: string; postMessage: ReturnType<typeof vi.fn> };
type ClientsGetMock = Mock<(clientId: string) => Promise<TestClient | undefined>>;

describe('service worker cache policy', () => {
  let fetchListener: FetchListener;
  let installListener: ExtendableListener;
  let activateListener: ExtendableListener;
  let messageListener: MessageListener;
  let cachePut: Mock<(request: Request, response: Response) => Promise<void>>;
  let cacheAddAll: ReturnType<typeof vi.fn>;
  let cacheEntryKeys: ReturnType<typeof vi.fn>;
  let cacheEntryDelete: ReturnType<typeof vi.fn>;
  let cacheOpen: ReturnType<typeof vi.fn>;
  let cacheMatch: CacheMatchMock;
  let cacheKeys: ReturnType<typeof vi.fn>;
  let cacheDelete: ReturnType<typeof vi.fn>;
  let fetchMock: FetchMock;
  let clientsClaim: ReturnType<typeof vi.fn>;
  let clientsGet: ClientsGetMock;
  let skipWaiting: ReturnType<typeof vi.fn>;
  let windowClients: TestClient[];

  it('precaches both stable first-paint scripts with the navigation shell', () => {
    expect(APP_SHELL_SOURCE).toContain('./fouc-cleanup.js');
    expect(APP_SHELL_SOURCE).toContain('./noscript.css');
    expect(APP_SHELL_SOURCE).toContain('./wordmark-anim.js');
  });

  it('precaches the queryless account-completion document and its stable assets', () => {
    expect(APP_SHELL_SOURCE).toContain('./account-complete.html');
    expect(APP_SHELL_SOURCE).toContain('./account-complete.js');
    expect(APP_SHELL_SOURCE).toContain('./account-complete.css');
  });

  it('does not spend the first service-worker install on the optional 2 MiB app font', () => {
    expect(APP_SHELL_SOURCE).not.toContain('PretendardVariable.woff2');
  });

  it('spreads the build-injected app entry closure into the install shell', () => {
    expect(SERVICE_WORKER_SOURCE).toContain('const BUILD_ENTRY_ASSETS = [');
    expect(APP_SHELL_SOURCE).toContain('...BUILD_ENTRY_ASSETS');
  });

  it('probes cached-navigation state in the early bootstrap before the app module runs', () => {
    expect(BOOTSTRAP_SOURCE).toContain('MXQR_CACHE_STATUS_REQUEST');
    expect(BOOTSTRAP_SOURCE).toContain('data-mxqr-navigation-source');
    expect(BOOTSTRAP_SOURCE).toContain('MXQR_CACHE_STATUS_PROBE');
  });

  beforeEach(async () => {
    const listeners = new Map<string, (event: never) => void>();
    cachePut = vi.fn(async () => undefined);
    cacheAddAll = vi.fn(async () => undefined);
    cacheEntryKeys = vi.fn(async () => []);
    cacheEntryDelete = vi.fn(async () => true);
    cacheOpen = vi.fn(async () => ({
      addAll: cacheAddAll,
      put: cachePut,
      keys: cacheEntryKeys,
      delete: cacheEntryDelete,
    }));
    cacheMatch = vi.fn(async () => undefined);
    cacheKeys = vi.fn(async () => []);
    cacheDelete = vi.fn(async () => true);
    fetchMock = vi.fn<(request: Request, init?: RequestInit) => Promise<Response>>();
    clientsClaim = vi.fn(async () => undefined);
    clientsGet = vi.fn(async (clientId: string) =>
      windowClients.find((client) => client.id === clientId),
    );
    skipWaiting = vi.fn(async () => undefined);
    windowClients = [];

    const self = {
      location: {
        href: 'https://musixquare.com/service-worker.js',
        origin: 'https://musixquare.com',
      },
      addEventListener: (type: string, listener: (event: never) => void) => {
        listeners.set(type, listener);
      },
      skipWaiting,
      registration: {},
      clients: {
        claim: clientsClaim,
        get: clientsGet,
        matchAll: vi.fn(async () => windowClients),
      },
    };
    const caches = {
      open: cacheOpen,
      match: cacheMatch,
      keys: cacheKeys,
      delete: cacheDelete,
    };
    vm.runInNewContext(EXECUTABLE_SERVICE_WORKER_SOURCE, {
      self,
      caches,
      fetch: fetchMock,
      AbortController,
      setTimeout: (callback: (...args: unknown[]) => void, delay?: number) =>
        setTimeout(callback, delay),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
      URL,
      Request,
      Response,
      Headers,
      console,
    });
    fetchListener = listeners.get('fetch') as FetchListener;
    installListener = listeners.get('install') as ExtendableListener;
    activateListener = listeners.get('activate') as ExtendableListener;
    messageListener = listeners.get('message') as MessageListener;
  });

  async function dispatch(
    request: Request,
    client: { clientId?: string; resultingClientId?: string } = {},
  ): Promise<Response> {
    const { response, work } = await dispatchWithWork(request, client);
    await Promise.all(work);
    return response;
  }

  async function dispatchWithWork(
    request: Request,
    client: { clientId?: string; resultingClientId?: string } = {},
  ): Promise<{
    response: Response;
    work: Array<Promise<unknown>>;
    waitUntilWasSynchronous: boolean;
  }> {
    let responsePromise: Promise<Response> | undefined;
    const work: Array<Promise<unknown>> = [];
    let listenerReturned = false;
    let waitUntilWasSynchronous = true;
    fetchListener({
      request,
      ...client,
      respondWith: (response) => {
        responsePromise = response;
      },
      waitUntil: (promise) => {
        if (listenerReturned) waitUntilWasSynchronous = false;
        work.push(promise);
      },
    });
    listenerReturned = true;
    expect(responsePromise).toBeDefined();
    return { response: await responsePromise!, work, waitUntilWasSynchronous };
  }

  function expectIgnored(request: Request): void {
    const respondWith = vi.fn();
    fetchListener({ request, respondWith, waitUntil: vi.fn() });
    expect(respondWith).not.toHaveBeenCalled();
  }

  async function dispatchExtendable(listener: ExtendableListener): Promise<void> {
    const work: Array<Promise<unknown>> = [];
    listener({ waitUntil: (promise) => work.push(promise) });
    await Promise.all(work);
  }

  async function dispatchMessage(
    client: { id: string; postMessage: ReturnType<typeof vi.fn> },
    data: Record<string, unknown>,
  ): Promise<void> {
    const work: Array<Promise<unknown>> = [];
    messageListener({ data, source: client, waitUntil: (promise) => work.push(promise) });
    await Promise.all(work);
  }

  it('installs the core shell fail-closed and marks the complete optional font group ready', async () => {
    fetchMock.mockImplementation(async (request: Request) => {
      if (request.url.endsWith('.css')) {
        return new Response('@font-face{font-family:Pretendard}', {
          status: 200,
          headers: { 'Content-Type': 'text/css' },
        });
      }
      return new Response(Uint8Array.from([119, 79, 70, 50]), {
        status: 200,
        headers: { 'Content-Type': 'font/woff2' },
      });
    });

    await dispatchExtendable(installListener);

    expect(cacheAddAll).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-optional-${ACTIVE_CACHE_VERSION}`);
    expect(cachePut).toHaveBeenCalledTimes(4);
    const cachedUrls = cachePut.mock.calls.slice(0, 3).map(([request]) => (request as Request).url);
    expect(cachedUrls).toEqual([
      'https://musixquare.com/primary-font-loader.js',
      'https://musixquare.com/primary-font.css',
      'https://musixquare.com/designsystem/fonts/PretendardVariable.woff2',
    ]);
    expect(String(cachePut.mock.calls[3]?.[0])).toContain('.mxqr-optional-ready');
  });

  it('does not activate a partial core shell', async () => {
    cacheAddAll.mockRejectedValueOnce(new Error('missing core asset'));

    await expect(dispatchExtendable(installListener)).rejects.toThrow('missing core asset');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('abandons an incomplete optional font group without publishing its ready marker', async () => {
    fetchMock.mockImplementation(async (request: Request) =>
      request.url.endsWith('.css')
        ? new Response('font css', { status: 200 })
        : new Response('font unavailable', { status: 503 }),
    );

    await dispatchExtendable(installListener);

    expect(cacheAddAll).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('does not stage no-store optional assets or purge another worker generation', async () => {
    const retiredOptionalCache = `musixquare-optional-${RETIRED_CACHE_VERSION}`;
    const futureOptionalCache = `musixquare-optional-v${Number(ACTIVE_CACHE_VERSION.slice(1)) + 1}`;
    cacheKeys.mockResolvedValue([retiredOptionalCache, futureOptionalCache]);
    fetchMock.mockResolvedValue(
      new Response('private optional asset', {
        status: 200,
        headers: { 'Cache-Control': 'public, no-store' },
      }),
    );

    await dispatchExtendable(installListener);

    expect(cacheAddAll).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cachePut).not.toHaveBeenCalled();
    expect(cacheKeys).not.toHaveBeenCalled();
    expect(cacheOpen).not.toHaveBeenCalledWith(retiredOptionalCache);
    expect(cacheOpen).not.toHaveBeenCalledWith(futureOptionalCache);
    expect(cacheEntryDelete).toHaveBeenCalledTimes(2);
    expect(cacheEntryDelete.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        url: 'https://musixquare.com/primary-font-loader.js',
      }),
    );
    expect(cacheEntryDelete.mock.calls[1]?.[1]).toEqual({ ignoreVary: true });
  });

  it('streams optional font assets into CacheStorage sequentially', async () => {
    let finishFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      finishFirstWrite = resolve;
    });
    cachePut.mockReturnValueOnce(firstWrite);
    fetchMock.mockResolvedValue(new Response('optional asset', { status: 200 }));

    const install = dispatchExtendable(installListener);
    await vi.waitFor(() => expect(cachePut).toHaveBeenCalledOnce());

    expect(fetchMock).toHaveBeenCalledOnce();
    finishFirstWrite?.();
    await install;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cachePut).toHaveBeenCalledTimes(4);
  });

  it('bounds a stalled optional font prefetch without failing the core install', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_request: Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('optional prefetch timed out', 'AbortError')),
            { once: true },
          );
        }),
    );

    try {
      const install = dispatchExtendable(installListener);
      await vi.advanceTimersByTimeAsync(OPTIONAL_ASSET_GROUP_TIMEOUT_MS - 1);
      expect(cachePut).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await install;

      expect(cacheAddAll).toHaveBeenCalledOnce();
      expect(cachePut).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns but never caches a failed navigation response', async () => {
    fetchMock.mockResolvedValue(new Response('upstream failure', { status: 503 }));

    const response = await dispatch(
      new Request('https://musixquare.com/session', { headers: { accept: 'text/html' } }),
    );

    expect(response.status).toBe(503);
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('keeps an approved skipWaiting activation alive through the message event', async () => {
    let finishActivation: (() => void) | undefined;
    const activation = new Promise<void>((resolve) => {
      finishActivation = resolve;
    });
    skipWaiting.mockReturnValueOnce(activation);
    const work: Array<Promise<unknown>> = [];

    messageListener({
      data: { type: 'SKIP_WAITING' },
      waitUntil: (promise) => work.push(promise),
    });

    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(work).toEqual([activation]);

    finishActivation?.();
    await Promise.all(work);
  });

  it('reports its exact cache generation to a controlled client', async () => {
    const client = { id: 'generation-client', postMessage: vi.fn() };

    await dispatchMessage(client, {
      type: 'MXQR_SW_GENERATION_REQUEST',
      requestId: 'request-1',
    });

    expect(client.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_SW_GENERATION_RESPONSE',
      requestId: 'request-1',
      cacheVersion: ACTIVE_CACHE_VERSION,
    });
  });

  it('caches a successful navigation in the runtime cache', async () => {
    fetchMock.mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    await dispatch(
      new Request('https://musixquare.com/session', { headers: { accept: 'text/html' } }),
    );

    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-runtime-${ACTIVE_CACHE_VERSION}`);
    expect(cachePut).toHaveBeenCalledOnce();
  });

  it.each(['no-store', 'public, NO-STORE, max-age=0'])(
    'returns but never persists a navigation forbidden by Cache-Control: %s',
    async (cacheControl) => {
      const request = new Request('https://musixquare.com/admin', {
        headers: { accept: 'text/html' },
      });
      fetchMock.mockResolvedValueOnce(
        new Response('<!doctype html><title>Admin</title>', {
          status: 200,
          headers: { 'Cache-Control': cacheControl },
        }),
      );

      const online = await dispatch(request);

      expect(online.status).toBe(200);
      expect(await online.text()).toContain('Admin');
      expect(cacheOpen).toHaveBeenCalledWith(`musixquare-runtime-${ACTIVE_CACHE_VERSION}`);
      expect(cacheEntryDelete).toHaveBeenCalledWith(request, { ignoreVary: true });
      expect(cachePut).not.toHaveBeenCalled();

      fetchMock.mockRejectedValueOnce(new Error('offline'));
      const offline = await dispatch(request);
      expect(offline.status).toBe(503);
    },
  );

  it('preserves the install-owned index shell while purging no-store runtime variants', async () => {
    const request = new Request('https://musixquare.com/index.html', {
      headers: { accept: 'text/html' },
    });
    cacheKeys.mockResolvedValue([
      `musixquare-static-${ACTIVE_CACHE_VERSION}`,
      `musixquare-runtime-${ACTIVE_CACHE_VERSION}`,
      'unrelated-product-cache-v1',
    ]);
    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        const url =
          typeof candidate === 'string'
            ? new URL(candidate, 'https://musixquare.com/service-worker.js').href
            : candidate.url;
        return options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
          url === request.url
          ? new Response('installed public app shell', { status: 200 })
          : undefined;
      },
    );
    fetchMock.mockResolvedValueOnce(
      new Response('fresh public app shell', {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }),
    );

    const online = await dispatch(request);
    expect(await online.text()).toBe('fresh public app shell');
    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-runtime-${ACTIVE_CACHE_VERSION}`);
    expect(cacheOpen).not.toHaveBeenCalledWith(`musixquare-static-${ACTIVE_CACHE_VERSION}`);
    expect(cacheOpen).not.toHaveBeenCalledWith('unrelated-product-cache-v1');

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offline = await dispatch(request);
    expect(await offline.text()).toBe('installed public app shell');
  });

  it.each([
    'https://musixquare.com/account-complete.html?accountClient=tab-12345678',
    'https://musixquare.com/?accountAuth=error',
    'https://musixquare.com/?state=oauth-correlation&code=one-time-code',
    'https://musixquare.com/session?access_token=account-secret',
  ])('returns but never caches a navigation with sensitive query state: %s', async (url) => {
    fetchMock.mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    const response = await dispatch(new Request(url, { headers: { accept: 'text/html' } }));

    expect(response.status).toBe(200);
    expect(cacheOpen).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('uses the queryless completion document for an offline account callback', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    cacheMatch.mockImplementation(
      async (request: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        return options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.endsWith('account-complete.html')
          ? new Response('canonical completion fallback', { status: 200 })
          : undefined;
      },
    );

    const response = await dispatch(
      new Request('https://musixquare.com/account-complete.html?accountClient=tab-12345678', {
        headers: { accept: 'text/html' },
      }),
    );

    expect(await response.text()).toBe('canonical completion fallback');
    expect(cacheMatch).toHaveBeenCalledOnce();
    expect(cacheMatch).toHaveBeenCalledWith('./account-complete.html', {
      cacheName: `musixquare-static-${ACTIVE_CACHE_VERSION}`,
    });
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('uses the canonical SPA shell for another offline authentication navigation', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    cacheMatch.mockImplementation(
      async (request: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        return options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.endsWith('index.html')
          ? new Response('canonical authentication fallback', { status: 200 })
          : undefined;
      },
    );

    const response = await dispatch(
      new Request('https://musixquare.com/?accountAuth=error', {
        headers: { accept: 'text/html' },
      }),
    );

    expect(await response.text()).toBe('canonical authentication fallback');
    expect(cacheMatch).toHaveBeenCalledOnce();
    expect(cacheMatch).toHaveBeenCalledWith('./index.html', {
      cacheName: `musixquare-static-${ACTIVE_CACHE_VERSION}`,
    });
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('keeps a navigation cache write alive without delaying the response', async () => {
    let finishCacheWrite: (() => void) | undefined;
    cachePut.mockReturnValue(
      new Promise<void>((resolve) => {
        finishCacheWrite = resolve;
      }),
    );
    fetchMock.mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    const { response, work, waitUntilWasSynchronous } = await dispatchWithWork(
      new Request('https://musixquare.com/session', { headers: { accept: 'text/html' } }),
    );

    expect(response.status).toBe(200);
    expect(waitUntilWasSynchronous).toBe(true);
    expect(work).toHaveLength(1);
    expect(cachePut).toHaveBeenCalledOnce();

    let completed = false;
    const completion = Promise.all(work).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    finishCacheWrite?.();
    await completion;
    expect(completed).toBe(true);
  });

  it('clones a navigation response before an asynchronous cache open', async () => {
    let finishCacheOpen: ((cache: { put: typeof cachePut }) => void) | undefined;
    cacheOpen.mockReturnValue(
      new Promise((resolve) => {
        finishCacheOpen = resolve;
      }),
    );
    fetchMock.mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    const { response, work } = await dispatchWithWork(
      new Request('https://musixquare.com/session', { headers: { accept: 'text/html' } }),
    );
    expect(await response.text()).toBe('<!doctype html>');

    finishCacheOpen?.({ put: cachePut });
    await Promise.all(work);
    expect(cachePut).toHaveBeenCalledOnce();
  });

  it.each([
    'https://musixquare.com/bootstrap.js',
    'https://musixquare.com/assets/main-ABC12345.js',
    'https://musixquare.com/primary-font-loader.js',
  ])('uses the online response when active CacheStorage reads fail for %s', async (url) => {
    const denied = new DOMException('CacheStorage access denied', 'SecurityError');
    cacheMatch.mockRejectedValue(denied);
    cacheOpen.mockRejectedValue(denied);
    fetchMock.mockResolvedValue(new Response('online asset', { status: 200 }));
    const request = new Request(url);

    const response = await dispatch(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('online asset');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(request);
  });

  it.each([
    'https://musixquare.com/bootstrap.js',
    'https://musixquare.com/assets/main-ABC12345.js',
    'https://musixquare.com/primary-font-loader.js',
  ])('returns the offline response when CacheStorage and the network fail for %s', async (url) => {
    const denied = new DOMException('CacheStorage access denied', 'SecurityError');
    cacheMatch.mockRejectedValue(denied);
    cacheKeys.mockRejectedValue(denied);
    cacheOpen.mockRejectedValue(denied);
    fetchMock.mockRejectedValue(new TypeError('Network unavailable'));
    const request = new Request(url);

    const response = await dispatch(request);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Offline');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('uses the static cache for same-origin assets', async () => {
    fetchMock.mockResolvedValue(new Response('asset', { status: 200 }));

    await dispatch(new Request('https://musixquare.com/assets/app.js'));

    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-static-${ACTIVE_CACHE_VERSION}`);
    expect(cachePut).toHaveBeenCalledOnce();
  });

  it('does not intercept an extensionless same-origin no-store request for CacheStorage', () => {
    const request = new Request('https://musixquare.com/runtime-config', {
      cache: 'no-store',
    });
    cacheMatch.mockResolvedValue(new Response('stale cached configuration', { status: 200 }));
    fetchMock.mockResolvedValue(new Response('fresh network configuration', { status: 200 }));

    expectIgnored(request);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cacheOpen).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('returns but never persists a no-store stable asset', async () => {
    const request = new Request('https://musixquare.com/admin.js?v=release');
    fetchMock.mockResolvedValueOnce(
      new Response('window.__ADMIN__ = true;', {
        status: 200,
        headers: { 'Cache-Control': 'max-age=0, No-Store, must-revalidate' },
      }),
    );

    const online = await dispatch(request);

    expect(online.status).toBe(200);
    expect(await online.text()).toContain('__ADMIN__');
    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-static-${ACTIVE_CACHE_VERSION}`);
    expect(cacheEntryDelete).toHaveBeenCalledWith(request, { ignoreVary: true });
    expect(cachePut).not.toHaveBeenCalled();

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offline = await dispatch(request);
    expect(offline.status).toBe(503);
  });

  it('does not let an older delayed cache put resurrect after a newer no-store response', async () => {
    const request = new Request('https://musixquare.com/runtime-config');
    let cachedBody: string | null = null;
    let finishOlderPut: (() => void) | undefined;

    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        const url = typeof candidate === 'string' ? candidate : candidate.url;
        return cachedBody !== null &&
          url === request.url &&
          (options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` ||
            options?.cacheName === `musixquare-runtime-${ACTIVE_CACHE_VERSION}`)
          ? new Response(cachedBody, { status: 200 })
          : undefined;
      },
    );
    const delayedOlderPut = new Promise<void>((resolve) => {
      finishOlderPut = () => {
        cachedBody = 'older cacheable configuration';
        resolve();
      };
    });
    cachePut.mockReturnValue(delayedOlderPut);
    cacheEntryDelete.mockImplementation(() => {
      cachedBody = null;
      return true;
    });
    fetchMock
      .mockResolvedValueOnce(new Response('older cacheable configuration', { status: 200 }))
      .mockResolvedValueOnce(
        new Response('newer private configuration', {
          status: 200,
          headers: { 'Cache-Control': 'no-store' },
        }),
      );

    const older = await dispatchWithWork(request);
    expect(await older.response.text()).toBe('older cacheable configuration');
    expect(cachePut).toHaveBeenCalledOnce();
    expect(finishOlderPut).toBeTypeOf('function');

    const newer = await dispatchWithWork(request);
    expect(await newer.response.text()).toBe('newer private configuration');

    // Let both fetch-event lifetimes settle only after the newer revocation has
    // raced the already-started older write. The final state must follow the
    // newer response regardless of whether the worker serializes or invalidates
    // the in-flight write.
    finishOlderPut?.();
    await Promise.all([...older.work, ...newer.work]);

    expect(cacheEntryDelete).toHaveBeenCalledWith(request, { ignoreVary: true });
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offline = await dispatch(request);
    expect(offline.status).toBe(503);
    expect(await offline.text()).toBe('Offline');
  });

  it('does not cache an older response that arrives after a newer no-store invalidation', async () => {
    const request = new Request('https://musixquare.com/runtime-config');
    let resolveOlderNetwork: ((response: Response) => void) | undefined;
    const olderNetwork = new Promise<Response>((resolve) => {
      resolveOlderNetwork = resolve;
    });
    fetchMock.mockReturnValueOnce(olderNetwork).mockResolvedValueOnce(
      new Response('newer private configuration', {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }),
    );

    let olderResponse: Promise<Response> | undefined;
    const olderWork: Array<Promise<unknown>> = [];
    fetchListener({
      request,
      respondWith: (response) => {
        olderResponse = response;
      },
      waitUntil: (work) => olderWork.push(work),
    });
    expect(olderResponse).toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();

    const newer = await dispatchWithWork(request);
    expect(await newer.response.text()).toBe('newer private configuration');
    await Promise.all(newer.work);

    expect(cacheEntryDelete).toHaveBeenCalledWith(request, { ignoreVary: true });
    expect(cachePut).not.toHaveBeenCalled();

    resolveOlderNetwork?.(new Response('older cacheable configuration', { status: 200 }));
    expect(await olderResponse!.then((response) => response.text())).toBe(
      'older cacheable configuration',
    );
    await Promise.all(olderWork);

    expect(cachePut).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offline = await dispatch(request);
    expect(offline.status).toBe(503);
    expect(await offline.text()).toBe('Offline');
  });

  it.each([false, true])(
    'keeps the newest successful stable-asset cache when responses finish out of order (new put fails: %s)',
    async (newPutFails) => {
      const request = new Request('https://musixquare.com/editorial-base.css');
      let cachedBody: string | null = null;
      let resolveOlderNetwork: (response: Response) => void = () => {};
      const olderNetwork = new Promise<Response>((resolve) => {
        resolveOlderNetwork = resolve;
      });
      cacheMatch.mockImplementation(async (candidate) =>
        candidate.url === request.url && cachedBody !== null ? new Response(cachedBody) : undefined,
      );
      cachePut.mockImplementation(async (_request: Request, response: Response) => {
        const body = await response.text();
        if (newPutFails && body === 'new stylesheet') throw new Error('quota exceeded');
        cachedBody = body;
      });
      fetchMock
        .mockReturnValueOnce(olderNetwork)
        .mockResolvedValueOnce(new Response('new stylesheet'));

      const olderPending = dispatchWithWork(request);
      const newer = await dispatchWithWork(request);
      expect(await newer.response.text()).toBe('new stylesheet');
      await Promise.all(newer.work);
      expect(cachedBody).toBe(newPutFails ? null : 'new stylesheet');

      resolveOlderNetwork(new Response('old stylesheet'));
      const older = await olderPending;
      expect(await older.response.text()).toBe('old stylesheet');
      await Promise.all(older.work);

      fetchMock.mockRejectedValueOnce(new Error('offline'));
      const offline = await dispatch(request);
      expect(await offline.text()).toBe(newPutFails ? 'old stylesheet' : 'new stylesheet');
    },
  );

  it('does not let an older delayed no-store response delete a newer cached response', async () => {
    const request = new Request('https://musixquare.com/runtime-config');
    let cachedBody: string | null = null;
    let resolveOlderNetwork: ((response: Response) => void) | undefined;
    const olderNetwork = new Promise<Response>((resolve) => {
      resolveOlderNetwork = resolve;
    });

    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        const url = typeof candidate === 'string' ? candidate : candidate.url;
        return cachedBody !== null &&
          url === request.url &&
          (options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` ||
            options?.cacheName === `musixquare-runtime-${ACTIVE_CACHE_VERSION}`)
          ? new Response(cachedBody, { status: 200 })
          : undefined;
      },
    );
    cachePut.mockImplementation(async () => {
      cachedBody = 'newer cacheable configuration';
    });
    cacheEntryDelete.mockImplementation(() => {
      cachedBody = null;
      return true;
    });
    fetchMock
      .mockReturnValueOnce(olderNetwork)
      .mockResolvedValueOnce(new Response('newer cacheable configuration', { status: 200 }));

    let olderResponse: Promise<Response> | undefined;
    const olderWork: Array<Promise<unknown>> = [];
    fetchListener({
      request,
      respondWith: (response) => {
        olderResponse = response;
      },
      waitUntil: (work) => olderWork.push(work),
    });
    expect(olderResponse).toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();

    const newer = await dispatchWithWork(request);
    expect(await newer.response.text()).toBe('newer cacheable configuration');
    await Promise.all(newer.work);
    expect(cachedBody).toBe('newer cacheable configuration');

    resolveOlderNetwork?.(
      new Response('older private configuration', {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }),
    );
    expect(await olderResponse!.then((response) => response.text())).toBe(
      'older private configuration',
    );
    await Promise.all(olderWork);

    expect(cacheEntryDelete).not.toHaveBeenCalled();
    expect(cachedBody).toBe('newer cacheable configuration');

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offline = await dispatch(request);
    expect(offline.status).toBe(200);
    expect(await offline.text()).toBe('newer cacheable configuration');
  });

  it('keeps an older no-store revocation authoritative when the newer cache put fails', async () => {
    const request = new Request('https://musixquare.com/runtime-config');
    let cachedBody: string | null = 'stale cached configuration';
    let resolveOlderNetwork: ((response: Response) => void) | undefined;
    const olderNetwork = new Promise<Response>((resolve) => {
      resolveOlderNetwork = resolve;
    });

    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        const url = typeof candidate === 'string' ? candidate : candidate.url;
        return cachedBody !== null &&
          url === request.url &&
          (options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` ||
            options?.cacheName === `musixquare-runtime-${ACTIVE_CACHE_VERSION}`)
          ? new Response(cachedBody, { status: 200 })
          : undefined;
      },
    );
    cachePut.mockRejectedValueOnce(new Error('quota exceeded'));
    cacheEntryDelete.mockImplementation(() => {
      cachedBody = null;
      return true;
    });
    fetchMock
      .mockReturnValueOnce(olderNetwork)
      .mockResolvedValueOnce(new Response('newer cacheable configuration', { status: 200 }));

    let olderResponse: Promise<Response> | undefined;
    const olderWork: Array<Promise<unknown>> = [];
    fetchListener({
      request,
      respondWith: (response) => {
        olderResponse = response;
      },
      waitUntil: (work) => olderWork.push(work),
    });

    const newer = await dispatchWithWork(request);
    expect(await newer.response.text()).toBe('stale cached configuration');
    await Promise.all(newer.work);
    expect(cachedBody).toBe('stale cached configuration');

    resolveOlderNetwork?.(
      new Response('older private configuration', {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }),
    );
    expect(await olderResponse!.then((response) => response.text())).toBe(
      'stale cached configuration',
    );
    await Promise.all(olderWork);

    expect(cacheEntryDelete).toHaveBeenCalledWith(request, { ignoreVary: true });
    expect(cachedBody).toBeNull();

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offline = await dispatch(request);
    expect(offline.status).toBe(503);
  });

  it('caches a cacheable response requested after a no-store invalidation', async () => {
    const request = new Request('https://musixquare.com/runtime-config');
    fetchMock.mockResolvedValueOnce(
      new Response('private configuration', {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }),
    );

    const invalidating = await dispatch(request);
    expect(await invalidating.text()).toBe('private configuration');
    expect(cacheEntryDelete).toHaveBeenCalledWith(request, { ignoreVary: true });
    expect(cachePut).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(new Response('new cacheable configuration', { status: 200 }));
    const refreshed = await dispatch(request);
    expect(await refreshed.text()).toBe('new cacheable configuration');
    expect(cachePut).toHaveBeenCalledOnce();

    const cachedCopy = cachePut.mock.calls[0]?.[1] as Response | undefined;
    expect(cachedCopy).toBeDefined();
    expect(await cachedCopy!.text()).toBe('new cacheable configuration');

    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        const url = typeof candidate === 'string' ? candidate : candidate.url;
        return url === request.url &&
          options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}`
          ? new Response('new cacheable configuration', { status: 200 })
          : undefined;
      },
    );
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    const offline = await dispatch(request);
    expect(offline.status).toBe(200);
    expect(await offline.text()).toBe('new cacheable configuration');
  });

  it('purges every Vary variant only from Musixquare-owned cache families', async () => {
    const request = new Request('https://musixquare.com/admin.js?v=release', {
      headers: { 'accept-language': 'ko-KR' },
    });
    const futureEpoch = Number(ACTIVE_CACHE_VERSION.slice(1)) + 1;
    const futureStaticCache = `musixquare-static-v${futureEpoch}`;
    const futureRuntimeCache = `musixquare-runtime-v${futureEpoch}`;
    cacheKeys.mockResolvedValue([
      `musixquare-static-${RETIRED_CACHE_VERSION}`,
      `musixquare-runtime-${RETIRED_CACHE_VERSION}`,
      futureStaticCache,
      futureRuntimeCache,
      'unrelated-product-cache-v1',
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response('asset removed', {
        status: 410,
        headers: { 'Cache-Control': 'no-store', Vary: 'Accept-Language' },
      }),
    );

    const response = await dispatch(request);

    expect(response.status).toBe(410);
    expect(cacheEntryDelete).toHaveBeenCalledWith(request, { ignoreVary: true });
    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-static-${RETIRED_CACHE_VERSION}`);
    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-runtime-${RETIRED_CACHE_VERSION}`);
    expect(cacheOpen).not.toHaveBeenCalledWith(futureStaticCache);
    expect(cacheOpen).not.toHaveBeenCalledWith(futureRuntimeCache);
    expect(cacheOpen).not.toHaveBeenCalledWith('unrelated-product-cache-v1');
  });

  it('evicts a previously cached navigation when its fresh response becomes no-store', async () => {
    const request = new Request('https://musixquare.com/admin', {
      headers: { accept: 'text/html' },
    });
    let staleEntryExists = true;
    cacheEntryDelete.mockImplementation(() => {
      staleEntryExists = false;
      return true;
    });
    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        const url = typeof candidate === 'string' ? candidate : candidate.url;
        return staleEntryExists &&
          options?.cacheName === `musixquare-runtime-${ACTIVE_CACHE_VERSION}` &&
          url === request.url
          ? new Response('stale admin shell', { status: 200 })
          : undefined;
      },
    );
    fetchMock.mockResolvedValueOnce(
      new Response('fresh private admin shell', {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }),
    );

    const online = await dispatch(request);
    expect(await online.text()).toBe('fresh private admin shell');
    expect(cacheEntryDelete).toHaveBeenCalledWith(request, { ignoreVary: true });

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offline = await dispatch(request);
    expect(offline.status).toBe(503);
  });

  it('evicts a cached navigation when a fresh denial response forbids storage', async () => {
    const request = new Request('https://musixquare.com/admin', {
      headers: { accept: 'text/html' },
    });
    let staleEntryExists = true;
    cacheEntryDelete.mockImplementation(() => {
      staleEntryExists = false;
      return true;
    });
    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        const url = typeof candidate === 'string' ? candidate : candidate.url;
        return staleEntryExists &&
          options?.cacheName === `musixquare-runtime-${ACTIVE_CACHE_VERSION}` &&
          url === request.url
          ? new Response('stale privileged shell', { status: 200 })
          : undefined;
      },
    );
    fetchMock.mockResolvedValueOnce(
      new Response('authorization required', {
        status: 401,
        headers: { 'Cache-Control': 'private, no-store' },
      }),
    );

    const online = await dispatch(request);
    expect(online.status).toBe(401);
    expect(cacheEntryDelete).toHaveBeenCalledWith(request, { ignoreVary: true });
    expect(cachePut).not.toHaveBeenCalled();

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offline = await dispatch(request);
    expect(offline.status).toBe(503);
  });

  it('evicts a previously cached stable asset after a no-store revalidation', async () => {
    const request = new Request('https://musixquare.com/admin.js?v=release');
    let staleEntryExists = true;
    cacheEntryDelete.mockImplementation(() => {
      staleEntryExists = false;
      return true;
    });
    cacheKeys.mockResolvedValue([
      `musixquare-static-${ACTIVE_CACHE_VERSION}`,
      `musixquare-static-${RETIRED_CACHE_VERSION}`,
      `musixquare-runtime-${RETIRED_CACHE_VERSION}`,
    ]);
    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        const url = typeof candidate === 'string' ? candidate : candidate.url;
        return staleEntryExists &&
          options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
          url === request.url
          ? new Response('stale admin asset', { status: 200 })
          : undefined;
      },
    );
    fetchMock.mockResolvedValueOnce(
      new Response('fresh private admin asset', {
        status: 200,
        headers: { 'Cache-Control': 'NO-STORE, max-age=0' },
      }),
    );

    // The cache-first request may finish with its incumbent body, but the
    // background revalidation must retire it before any later request.
    const online = await dispatch(request);
    expect(await online.text()).toBe('stale admin asset');
    expect(cacheEntryDelete).toHaveBeenCalledWith(request, { ignoreVary: true });
    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-static-${RETIRED_CACHE_VERSION}`);
    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-runtime-${RETIRED_CACHE_VERSION}`);

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offline = await dispatch(request);
    expect(offline.status).toBe(503);
  });

  it('evicts a cached stable asset when a fresh removal response forbids storage', async () => {
    const request = new Request('https://musixquare.com/admin.js?v=release');
    let staleEntryExists = true;
    cacheEntryDelete.mockImplementation(() => {
      staleEntryExists = false;
      return true;
    });
    cacheKeys.mockResolvedValue([
      `musixquare-static-${ACTIVE_CACHE_VERSION}`,
      `musixquare-static-${RETIRED_CACHE_VERSION}`,
    ]);
    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        const url = typeof candidate === 'string' ? candidate : candidate.url;
        return staleEntryExists &&
          options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
          url === request.url
          ? new Response('stale privileged asset', { status: 200 })
          : undefined;
      },
    );
    fetchMock.mockResolvedValueOnce(
      new Response('asset removed', {
        status: 410,
        headers: { 'Cache-Control': 'no-store' },
      }),
    );

    const online = await dispatch(request);
    expect(await online.text()).toBe('stale privileged asset');
    expect(cacheEntryDelete).toHaveBeenCalledWith(request, { ignoreVary: true });
    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-static-${RETIRED_CACHE_VERSION}`);
    expect(cachePut).not.toHaveBeenCalled();

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offline = await dispatch(request);
    expect(offline.status).toBe(503);
  });

  it('serves the precached wordmark timing script during a cold-offline launch', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    cacheMatch.mockImplementation(async (request: Request, options?: { cacheName?: string }) => {
      return options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
        request.url.endsWith('/wordmark-anim.js')
        ? new Response('cached wordmark timing', { status: 200 })
        : undefined;
    });

    const response = await dispatch(new Request('https://musixquare.com/wordmark-anim.js'));

    expect(await response.text()).toBe('cached wordmark timing');
    expect(cacheMatch).toHaveBeenCalledWith(expect.any(Request), {
      cacheName: `musixquare-static-${ACTIVE_CACHE_VERSION}`,
    });
  });

  it('serves a ready optional full font without launching a duplicate revalidation', async () => {
    cacheMatch.mockImplementation(
      async (request: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        if (
          options?.cacheName === `musixquare-optional-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.includes('.mxqr-optional-ready')
        ) {
          return new Response(ACTIVE_CACHE_VERSION, { status: 200 });
        }
        if (
          options?.cacheName === `musixquare-optional-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.endsWith('PretendardVariable.woff2')
        ) {
          return new Response('cached full font', { status: 200 });
        }
        return undefined;
      },
    );

    const response = await dispatch(
      new Request('https://musixquare.com/designsystem/fonts/PretendardVariable.woff2'),
    );

    expect(await response.text()).toBe('cached full font');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('does not expose a partially staged optional font cache', async () => {
    cacheMatch.mockImplementation(
      async (request: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        if (
          options?.cacheName === `musixquare-optional-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.endsWith('PretendardVariable.woff2')
        ) {
          return new Response('partial staged font', { status: 200 });
        }
        return undefined;
      },
    );
    fetchMock.mockResolvedValue(new Response('recovered network font', { status: 200 }));

    const response = await dispatch(
      new Request('https://musixquare.com/designsystem/fonts/PretendardVariable.woff2'),
    );

    expect(await response.text()).toBe('recovered network font');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cachePut).toHaveBeenCalledOnce();
  });

  it('purges a complete retired optional group after a no-store network response', async () => {
    const request = new Request(
      'https://musixquare.com/designsystem/fonts/PretendardVariable.woff2',
    );
    const retiredOptionalCache = `musixquare-optional-${RETIRED_CACHE_VERSION}`;
    const futureOptionalCache = `musixquare-optional-v${Number(ACTIVE_CACHE_VERSION.slice(1)) + 1}`;
    const retiredReadyKey = `./.mxqr-optional-ready?cache=${RETIRED_CACHE_VERSION}`;
    let retiredMarkerExists = true;
    let retiredFontExists = true;
    let retiredCssExists = true;
    cacheKeys.mockResolvedValue([retiredOptionalCache, futureOptionalCache]);
    cacheEntryDelete.mockImplementation((candidate: RequestInfo) => {
      const url = typeof candidate === 'string' ? candidate : candidate.url;
      if (url.endsWith('PretendardVariable.woff2')) retiredFontExists = false;
      if (url.includes(retiredReadyKey)) retiredMarkerExists = false;
      return true;
    });
    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        if (options?.cacheName !== retiredOptionalCache) return undefined;
        const url = typeof candidate === 'string' ? candidate : candidate.url;
        if (url.includes(retiredReadyKey) && retiredMarkerExists) {
          return new Response(RETIRED_CACHE_VERSION, { status: 200 });
        }
        if (url.endsWith('PretendardVariable.woff2') && retiredFontExists) {
          return new Response('retired optional font', { status: 200 });
        }
        if (url.endsWith('primary-font.css') && retiredCssExists) {
          return new Response('retired optional css', { status: 200 });
        }
        return undefined;
      },
    );
    fetchMock.mockResolvedValueOnce(
      new Response('font revoked', {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }),
    );

    const online = await dispatch(request);
    expect(await online.text()).toBe('font revoked');
    expect(cacheOpen).toHaveBeenCalledWith(retiredOptionalCache);
    expect(cacheOpen).not.toHaveBeenCalledWith(futureOptionalCache);
    expect(cacheEntryDelete).toHaveBeenCalledWith(request, { ignoreVary: true });
    expect(cacheEntryDelete).toHaveBeenCalledWith(retiredReadyKey);

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offline = await dispatch(new Request('https://musixquare.com/primary-font.css'));
    expect(offline.status).toBe(503);
    expect(retiredCssExists).toBe(true);
  });

  it('rejects markerless retired optional and static font fragments while offline', async () => {
    cacheKeys.mockResolvedValue([
      `musixquare-static-${RETIRED_CACHE_VERSION}`,
      `musixquare-runtime-${RETIRED_CACHE_VERSION}`,
      `musixquare-optional-${RETIRED_CACHE_VERSION}`,
    ]);
    cacheMatch.mockImplementation(
      async (request: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        if (
          options?.cacheName?.endsWith(RETIRED_CACHE_VERSION) &&
          requestUrl.endsWith('PretendardVariable.woff2')
        ) {
          return new Response('partial retired font', { status: 200 });
        }
        return undefined;
      },
    );
    fetchMock.mockRejectedValue(new Error('offline'));

    const response = await dispatch(
      new Request('https://musixquare.com/designsystem/fonts/PretendardVariable.woff2'),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Offline');
    expect(cacheMatch).not.toHaveBeenCalledWith(expect.any(Request), {
      cacheName: `musixquare-static-${RETIRED_CACHE_VERSION}`,
    });
    expect(cacheMatch).not.toHaveBeenCalledWith(expect.any(Request), {
      cacheName: `musixquare-runtime-${RETIRED_CACHE_VERSION}`,
    });
    expect(cacheMatch).not.toHaveBeenCalledWith(expect.any(Request), {
      cacheName: `musixquare-optional-${RETIRED_CACHE_VERSION}`,
    });
  });

  it('accepts a complete retired optional font group while offline', async () => {
    const retiredOptionalCache = `musixquare-optional-${RETIRED_CACHE_VERSION}`;
    cacheKeys.mockResolvedValue([retiredOptionalCache]);
    cacheMatch.mockImplementation(
      async (request: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        if (
          options?.cacheName === retiredOptionalCache &&
          requestUrl.includes(`.mxqr-optional-ready?cache=${RETIRED_CACHE_VERSION}`)
        ) {
          return new Response(RETIRED_CACHE_VERSION, { status: 200 });
        }
        if (
          options?.cacheName === retiredOptionalCache &&
          requestUrl.endsWith('PretendardVariable.woff2')
        ) {
          return new Response('complete retired font', { status: 200 });
        }
        return undefined;
      },
    );
    fetchMock.mockRejectedValue(new Error('offline'));

    const response = await dispatch(
      new Request('https://musixquare.com/designsystem/fonts/PretendardVariable.woff2'),
    );

    expect(await response.text()).toBe('complete retired font');
    expect(cacheMatch).toHaveBeenCalledWith(
      `./.mxqr-optional-ready?cache=${RETIRED_CACHE_VERSION}`,
      { cacheName: retiredOptionalCache },
    );
    expect(cacheMatch).toHaveBeenCalledWith(expect.any(Request), {
      cacheName: retiredOptionalCache,
    });
  });

  it('does not treat a ready future optional generation as retired', async () => {
    const activeEpoch = Number(ACTIVE_CACHE_VERSION.replace(/^v/u, ''));
    const futureVersion = `v${activeEpoch + 1}`;
    const futureOptionalCache = `musixquare-optional-${futureVersion}`;
    cacheKeys.mockResolvedValue([futureOptionalCache]);
    cacheMatch.mockImplementation(
      async (request: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        if (options?.cacheName === futureOptionalCache && requestUrl.includes('primary-font')) {
          return new Response('future optional fragment', { status: 200 });
        }
        return undefined;
      },
    );
    fetchMock.mockRejectedValue(new Error('offline'));

    const response = await dispatch(new Request('https://musixquare.com/primary-font-loader.js'));

    expect(response.status).toBe(503);
    expect(cacheMatch).not.toHaveBeenCalledWith(expect.anything(), {
      cacheName: futureOptionalCache,
    });
  });

  it('serves an offline byte range from the canonical precached audio primer', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    cacheMatch.mockImplementation(
      async (request: Request | string, options?: { cacheName?: string }) =>
        options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
        String(request).endsWith('dummy_audio.mp3')
          ? new Response(Uint8Array.from([0, 1, 2, 3, 4]), {
              status: 200,
              headers: {
                'Content-Type': 'audio/mpeg',
                'Content-Encoding': 'gzip',
                'Transfer-Encoding': 'chunked',
              },
            })
          : undefined,
    );

    const response = await dispatch(
      new Request('https://musixquare.com/dummy_audio.mp3', {
        headers: { Range: 'bytes=1-3' },
      }),
    );

    expect(response.status).toBe(206);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(response.headers.get('Content-Range')).toBe('bytes 1-3/5');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Length')).toBe('3');
    expect(response.headers.has('Content-Encoding')).toBe(false);
    expect(response.headers.has('Transfer-Encoding')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves suffix audio-primer ranges and clamps them to the cached body', async () => {
    cacheMatch.mockResolvedValue(
      new Response(Uint8Array.from([0, 1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
    );

    const response = await dispatch(
      new Request('https://musixquare.com/dummy_audio.mp3', {
        headers: { Range: 'bytes=-2' },
      }),
    );

    expect(response.status).toBe(206);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([3, 4]);
    expect(response.headers.get('Content-Range')).toBe('bytes 3-4/5');
    expect(response.headers.get('Content-Length')).toBe('2');
  });

  it.each(['bytes=5-', 'bytes=3-1', 'bytes=-0', 'bytes=0-1,3-4', 'items=0-1'])(
    'returns 416 for an invalid or unsatisfiable audio-primer range: %s',
    async (range) => {
      cacheMatch.mockResolvedValue(
        new Response(Uint8Array.from([0, 1, 2, 3, 4]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        }),
      );

      const response = await dispatch(
        new Request('https://musixquare.com/dummy_audio.mp3', {
          headers: { Range: range },
        }),
      );

      expect(response.status).toBe(416);
      expect(response.headers.get('Content-Range')).toBe('bytes */5');
      expect(response.headers.get('Accept-Ranges')).toBe('bytes');
      expect(response.headers.get('Content-Length')).toBe('0');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('keeps non-primer and HEAD range requests outside the service-worker media pipeline', () => {
    expectIgnored(
      new Request('https://musixquare.com/uploads/track.mp3', {
        headers: { Range: 'bytes=0-' },
      }),
    );
    expectIgnored(
      new Request('https://musixquare.com/dummy_audio.mp3', {
        method: 'HEAD',
        headers: { Range: 'bytes=0-' },
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it('keeps the canonical full audio-primer request on the normal stable-asset path', async () => {
    cacheMatch.mockImplementation(async (request: Request, options?: { cacheName?: string }) =>
      options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
      request.url.endsWith('/dummy_audio.mp3')
        ? new Response('full primer', { status: 200 })
        : undefined,
    );
    fetchMock.mockRejectedValue(new Error('offline'));

    const response = await dispatch(new Request('https://musixquare.com/dummy_audio.mp3'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('full primer');
  });

  it('registers static revalidation work before the fetch listener returns', async () => {
    cacheMatch.mockResolvedValue(new Response('cached asset', { status: 200 }));
    fetchMock.mockResolvedValue(new Response('fresh asset', { status: 200 }));

    const { response, work, waitUntilWasSynchronous } = await dispatchWithWork(
      new Request('https://musixquare.com/assets/app.js'),
    );
    await Promise.all(work);

    expect(await response.text()).toBe('cached asset');
    expect(waitUntilWasSynchronous).toBe(true);
    expect(work).toHaveLength(1);
    expect(cachePut).toHaveBeenCalledOnce();
  });

  it('serves an immutable hashed asset without re-fetching or rewriting it', async () => {
    cacheMatch.mockImplementation(async (_request: Request, options?: { cacheName?: string }) => {
      return options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}`
        ? new Response('cached immutable asset', { status: 200 })
        : undefined;
    });

    const response = await dispatch(new Request('https://musixquare.com/assets/main-BGnE1MXw.js'));

    expect(await response.text()).toBe('cached immutable asset');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('fetches and stores an immutable hashed asset on its first cache miss', async () => {
    fetchMock.mockResolvedValue(new Response('new immutable asset', { status: 200 }));

    const response = await dispatch(new Request('https://musixquare.com/assets/main-BGnE1MXw.js'));

    expect(await response.text()).toBe('new immutable asset');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-static-${ACTIVE_CACHE_VERSION}`);
    expect(cachePut).toHaveBeenCalledOnce();
  });

  it('does not duplicate the installed SPA shell under each room URL', async () => {
    fetchMock.mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    await dispatch(
      new Request('https://musixquare.com/000001', { headers: { accept: 'text/html' } }),
    );
    await dispatch(
      new Request('https://musixquare.com/123456', { headers: { accept: 'text/html' } }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('uses the canonical installed shell for an offline room navigation', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    cacheMatch.mockImplementation(
      async (request: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        return options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.endsWith('index.html')
          ? new Response('canonical room shell', { status: 200 })
          : undefined;
      },
    );

    const response = await dispatch(
      new Request('https://musixquare.com/000001', { headers: { accept: 'text/html' } }),
    );

    expect(await response.text()).toBe('canonical room shell');
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('marks a cached navigation and reports the degraded source on the page probe', async () => {
    fetchMock.mockRejectedValue(new Error('radio path interrupted'));
    cacheMatch.mockImplementation(
      async (request: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        if (
          options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.endsWith('index.html')
        ) {
          return new Response('cached shell', { status: 200 });
        }
        if (
          options?.cacheName === `musixquare-runtime-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.includes('.mxqr-navigation-fallback/client-reopen')
        ) {
          return new Response(ACTIVE_CACHE_VERSION, { status: 200 });
        }
        return undefined;
      },
    );

    const response = await dispatch(
      new Request('https://musixquare.com/123456', { headers: { accept: 'text/html' } }),
      { resultingClientId: 'client-reopen' },
    );

    expect(await response.text()).toBe('cached shell');
    expect(response.headers.get('X-Musixquare-Navigation-Source')).toBe('cache-fallback');
    expect(cachePut).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://musixquare.com/.mxqr-navigation-fallback/client-reopen',
      }),
      expect.any(Response),
    );

    const client = { id: 'client-reopen', postMessage: vi.fn() };
    await dispatchMessage(client, { type: 'MXQR_CACHE_STATUS_PROBE' });
    expect(client.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_STATUS_REQUEST',
      cacheVersion: ACTIVE_CACHE_VERSION,
      proactive: true,
      navigationFallback: true,
    });
    // The early bootstrap and the later module registration both probe. Keep
    // the marker for this document lifetime so the second probe cannot erase
    // the degraded result set before app readiness observes it.
    expect(cacheEntryDelete).not.toHaveBeenCalled();
  });

  it('preserves a fallback marker when a redirect hop succeeds before the final navigation fails', async () => {
    cacheMatch.mockImplementation(
      async (request: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        if (
          options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.endsWith('index.html')
        ) {
          return new Response('cached shell', { status: 200 });
        }
        return undefined;
      },
    );
    const navigationRequest = new Request('https://musixquare.com/start', {
      headers: { accept: 'text/html' },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://musixquare.com/final' },
      }),
    );

    await dispatch(navigationRequest, {
      resultingClientId: 'redirect-client',
    });
    expect(cacheEntryDelete).not.toHaveBeenCalled();

    fetchMock.mockRejectedValueOnce(new Error('final redirect hop interrupted'));
    const response = await dispatch(
      new Request('https://musixquare.com/final', { headers: { accept: 'text/html' } }),
      { resultingClientId: 'redirect-client' },
    );
    expect(await response.text()).toBe('cached shell');
    expect(cachePut).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://musixquare.com/.mxqr-navigation-fallback/redirect-client',
      }),
      expect.any(Response),
    );

    const client = { id: 'redirect-client', postMessage: vi.fn() };
    await dispatchMessage(client, { type: 'MXQR_CACHE_STATUS_PROBE' });
    expect(client.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_STATUS_REQUEST',
      cacheVersion: ACTIVE_CACHE_VERSION,
      proactive: true,
      navigationFallback: true,
    });
    expect(cacheEntryDelete).not.toHaveBeenCalled();
  });

  it('scrubs only a proven orphan marker and preserves the current and another live tab', async () => {
    const currentMarker = new Request(
      'https://musixquare.com/.mxqr-navigation-fallback/current-client',
    );
    const liveMarker = new Request(
      'https://musixquare.com/.mxqr-navigation-fallback/other-live-client',
    );
    const orphanMarker = new Request(
      'https://musixquare.com/.mxqr-navigation-fallback/orphan-client',
    );
    const ordinaryRuntimeEntry = new Request('https://musixquare.com/session');
    cacheEntryKeys.mockResolvedValue([
      currentMarker,
      liveMarker,
      orphanMarker,
      ordinaryRuntimeEntry,
    ]);
    const liveClient = { id: 'other-live-client', postMessage: vi.fn() };
    clientsGet.mockImplementation(async (clientId: string) =>
      clientId === liveClient.id ? liveClient : undefined,
    );

    const currentClient = { id: 'current-client', postMessage: vi.fn() };
    await dispatchMessage(currentClient, { type: 'MXQR_CACHE_STATUS_PROBE' });

    expect(currentClient.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_STATUS_REQUEST',
      cacheVersion: ACTIVE_CACHE_VERSION,
      proactive: true,
      navigationFallback: false,
    });
    expect(clientsGet.mock.calls.map(([clientId]) => clientId).sort()).toEqual([
      'orphan-client',
      'other-live-client',
    ]);
    expect(cacheEntryDelete).toHaveBeenCalledOnce();
    expect(cacheEntryDelete).toHaveBeenCalledWith(orphanMarker);
  });

  it('preserves a fallback marker when the client lookup rejects', async () => {
    const uncertainMarker = new Request(
      'https://musixquare.com/.mxqr-navigation-fallback/uncertain-client',
    );
    cacheEntryKeys.mockResolvedValue([uncertainMarker]);
    clientsGet.mockRejectedValueOnce(new Error('client registry unavailable'));

    await dispatchMessage(
      { id: 'current-client', postMessage: vi.fn() },
      { type: 'MXQR_CACHE_STATUS_PROBE' },
    );

    expect(cacheEntryDelete).not.toHaveBeenCalled();
  });

  it('preserves in-memory fallback state when orphan-marker deletion is not confirmed', async () => {
    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof candidate === 'string' ? candidate : candidate.url;
        return options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.endsWith('index.html')
          ? new Response('cached shell', { status: 200 })
          : undefined;
      },
    );
    fetchMock.mockRejectedValueOnce(new Error('radio path interrupted'));
    await dispatch(new Request('https://musixquare.com/', { headers: { accept: 'text/html' } }), {
      resultingClientId: 'orphan-client',
    });

    const orphanMarker = new Request(
      'https://musixquare.com/.mxqr-navigation-fallback/orphan-client',
    );
    cacheEntryKeys.mockResolvedValue([orphanMarker]);
    cacheEntryDelete.mockResolvedValueOnce(false);
    clientsGet.mockResolvedValueOnce(undefined);

    const currentClient = { id: 'current-client', postMessage: vi.fn() };
    await dispatchMessage(currentClient, { type: 'MXQR_CACHE_STATUS_PROBE' });
    expect(cacheEntryDelete).toHaveBeenCalledWith(orphanMarker);

    cacheEntryKeys.mockResolvedValue([]);
    cacheMatch.mockResolvedValue(undefined);
    const orphanClient = { id: 'orphan-client', postMessage: vi.fn() };
    await dispatchMessage(orphanClient, { type: 'MXQR_CACHE_STATUS_PROBE' });
    expect(orphanClient.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_STATUS_REQUEST',
      cacheVersion: ACTIVE_CACHE_VERSION,
      proactive: true,
      navigationFallback: true,
    });
  });

  it('preserves a provisional fallback marker when the client lookup times out', async () => {
    vi.useFakeTimers();
    const provisionalMarker = new Request(
      'https://musixquare.com/.mxqr-navigation-fallback/provisional-client',
    );
    cacheEntryKeys.mockResolvedValue([provisionalMarker]);
    clientsGet.mockImplementation(() => new Promise(() => undefined));

    try {
      const probe = dispatchMessage(
        { id: 'current-client', postMessage: vi.fn() },
        { type: 'MXQR_CACHE_STATUS_PROBE' },
      );
      await vi.advanceTimersByTimeAsync(NAVIGATION_STATE_CLIENT_LOOKUP_TIMEOUT_MS);
      await probe;

      expect(cacheEntryDelete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a provisional fallback marker when the client becomes ready before timeout', async () => {
    vi.useFakeTimers();
    const provisionalMarker = new Request(
      'https://musixquare.com/.mxqr-navigation-fallback/provisional-client',
    );
    cacheEntryKeys.mockResolvedValue([provisionalMarker]);
    const provisionalClient = { id: 'provisional-client', postMessage: vi.fn() };
    clientsGet.mockImplementation(
      async () =>
        new Promise<TestClient>((resolve) => {
          setTimeout(() => resolve(provisionalClient), 1_000);
        }),
    );

    try {
      const probe = dispatchMessage(
        { id: 'current-client', postMessage: vi.fn() },
        { type: 'MXQR_CACHE_STATUS_PROBE' },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await probe;

      expect(cacheEntryDelete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never transfers navigation state from an initiating client to the resulting document', async () => {
    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof candidate === 'string' ? candidate : candidate.url;
        return options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.endsWith('index.html')
          ? new Response('cached shell', { status: 200 })
          : undefined;
      },
    );
    fetchMock.mockRejectedValueOnce(new Error('radio path interrupted'));
    const navigationRequest = new Request('https://musixquare.com/', {
      headers: { accept: 'text/html' },
    });
    await dispatch(navigationRequest, { resultingClientId: 'opener-client' });

    cacheEntryDelete.mockClear();
    fetchMock.mockResolvedValueOnce(new Response('<!doctype html>', { status: 200 }));
    await dispatch(navigationRequest, {
      clientId: 'opener-client',
      resultingClientId: 'new-document',
    });

    expect(cacheEntryDelete).not.toHaveBeenCalled();
    const opener = { id: 'opener-client', postMessage: vi.fn() };
    await dispatchMessage(opener, { type: 'MXQR_CACHE_STATUS_PROBE' });
    expect(opener.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_STATUS_REQUEST',
      cacheVersion: ACTIVE_CACHE_VERSION,
      proactive: true,
      navigationFallback: true,
    });

    const resultingDocument = { id: 'new-document', postMessage: vi.fn() };
    await dispatchMessage(resultingDocument, { type: 'MXQR_CACHE_STATUS_PROBE' });
    expect(resultingDocument.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_STATUS_REQUEST',
      cacheVersion: ACTIVE_CACHE_VERSION,
      proactive: true,
      navigationFallback: false,
    });
  });

  it('does not infer navigation-state ownership when resultingClientId is absent', async () => {
    cacheMatch.mockImplementation(
      async (candidate: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof candidate === 'string' ? candidate : candidate.url;
        return options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.endsWith('index.html')
          ? new Response('cached shell', { status: 200 })
          : undefined;
      },
    );
    const navigationRequest = new Request('https://musixquare.com/', {
      headers: { accept: 'text/html' },
    });
    fetchMock.mockRejectedValueOnce(new Error('radio path interrupted'));
    await dispatch(navigationRequest, { clientId: 'initiating-client' });
    expect(cachePut).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(new Response('<!doctype html>', { status: 200 }));
    await dispatch(navigationRequest, { clientId: 'initiating-client' });
    expect(cacheEntryDelete).not.toHaveBeenCalled();
  });

  it('bounds a stalled navigation and falls back only to the active canonical shell', async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_request: Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined;
          fetchSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('navigation timed out', 'AbortError')),
            { once: true },
          );
        }),
    );
    cacheMatch.mockImplementation(
      async (request: RequestInfo, options?: { cacheName?: string }) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        return options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}` &&
          requestUrl.endsWith('index.html')
          ? new Response('bounded cached shell', { status: 200 })
          : undefined;
      },
    );

    try {
      const responsePromise = dispatch(
        new Request('https://musixquare.com/123456', { headers: { accept: 'text/html' } }),
      );
      await vi.advanceTimersByTimeAsync(NAVIGATION_NETWORK_TIMEOUT_MS - 1);
      expect(fetchSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const response = await responsePromise;

      expect(fetchSignal?.aborted).toBe(true);
      expect(await response.text()).toBe('bounded cached shell');
      expect(cacheMatch).toHaveBeenCalledTimes(1);
      expect(cacheMatch).toHaveBeenCalledWith('./index.html', {
        cacheName: `musixquare-static-${ACTIVE_CACHE_VERSION}`,
      });
      expect(cachePut).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'aif', 'aiff', 'caf'])(
    'does not intercept local .%s media files for CacheStorage',
    (extension) => {
      expectIgnored(new Request(`https://musixquare.com/uploads/track.${extension}`));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(cacheOpen).not.toHaveBeenCalled();
    },
  );

  it('keeps retired caches while any live tab has not approved the new controller', async () => {
    const oldTab = { id: 'old-tab', postMessage: vi.fn() };
    const newTab = { id: 'new-tab', postMessage: vi.fn() };
    windowClients = [oldTab, newTab];
    cacheKeys.mockResolvedValue([
      `musixquare-static-${RETIRED_CACHE_VERSION}`,
      `musixquare-runtime-${RETIRED_CACHE_VERSION}`,
      `musixquare-static-${ACTIVE_CACHE_VERSION}`,
      `musixquare-runtime-${ACTIVE_CACHE_VERSION}`,
    ]);

    await dispatchExtendable(activateListener);

    expect(clientsClaim).toHaveBeenCalledOnce();
    expect(oldTab.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_STATUS_REQUEST',
      cacheVersion: ACTIVE_CACHE_VERSION,
    });
    expect(cacheDelete).not.toHaveBeenCalled();

    await dispatchMessage(newTab, {
      type: 'MXQR_CACHE_CLIENT_STATUS',
      cacheVersion: ACTIVE_CACHE_VERSION,
      ready: true,
      replyToRequest: true,
    });
    expect(cacheDelete).not.toHaveBeenCalled();

    await dispatchMessage(oldTab, {
      type: 'MXQR_CACHE_CLIENT_STATUS',
      cacheVersion: ACTIVE_CACHE_VERSION,
      ready: false,
      replyToRequest: true,
    });
    expect(cacheDelete).not.toHaveBeenCalled();
  });

  it('keeps only the exact retired generation reported by a mixed-version live tab', async () => {
    const oldTab = { id: 'old-tab', postMessage: vi.fn() };
    const newTab = { id: 'new-tab', postMessage: vi.fn() };
    const olderVersion = 'v193';
    windowClients = [oldTab, newTab];
    cacheKeys.mockResolvedValue([
      `musixquare-static-${olderVersion}`,
      `musixquare-runtime-${olderVersion}`,
      `musixquare-static-${RETIRED_CACHE_VERSION}`,
      `musixquare-runtime-${RETIRED_CACHE_VERSION}`,
      `musixquare-static-${ACTIVE_CACHE_VERSION}`,
      `musixquare-runtime-${ACTIVE_CACHE_VERSION}`,
    ]);

    await dispatchExtendable(activateListener);
    await dispatchMessage(newTab, {
      type: 'MXQR_CACHE_CLIENT_STATUS',
      cacheVersion: ACTIVE_CACHE_VERSION,
      ready: true,
      pageCacheVersion: ACTIVE_CACHE_VERSION,
      replyToRequest: true,
    });
    await dispatchMessage(oldTab, {
      type: 'MXQR_CACHE_CLIENT_STATUS',
      cacheVersion: ACTIVE_CACHE_VERSION,
      ready: false,
      pageCacheVersion: RETIRED_CACHE_VERSION,
      replyToRequest: true,
    });

    expect(cacheDelete).toHaveBeenCalledWith(`musixquare-static-${olderVersion}`);
    expect(cacheDelete).toHaveBeenCalledWith(`musixquare-runtime-${olderVersion}`);
    expect(cacheDelete).not.toHaveBeenCalledWith(`musixquare-static-${RETIRED_CACHE_VERSION}`);
    expect(cacheDelete).not.toHaveBeenCalledWith(`musixquare-runtime-${RETIRED_CACHE_VERSION}`);
  });

  it('scrubs sensitive query entries from a retained runtime cache on activation', async () => {
    const oldTab = { id: 'old-tab', postMessage: vi.fn() };
    windowClients = [oldTab];
    const sensitive = new Request(
      'https://musixquare.com/?code=one-time-code&state=oauth-correlation',
    );
    const accountClient = new Request(
      'https://musixquare.com/account-complete.html?accountClient=tab-12345678',
    );
    const ordinary = new Request('https://musixquare.com/session?view=setup');
    cacheKeys.mockResolvedValue([
      `musixquare-runtime-${RETIRED_CACHE_VERSION}`,
      `musixquare-runtime-${ACTIVE_CACHE_VERSION}`,
    ]);
    cacheEntryKeys.mockResolvedValue([sensitive, accountClient, ordinary]);

    await dispatchExtendable(activateListener);

    expect(cacheOpen).toHaveBeenCalledOnce();
    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-runtime-${RETIRED_CACHE_VERSION}`);
    expect(cacheEntryDelete).toHaveBeenCalledTimes(2);
    expect(cacheEntryDelete.mock.calls.map(([request]) => request.url)).toEqual([
      sensitive.url,
      accountClient.url,
    ]);
    // The old tab still needs its retired hashed assets, so only sensitive
    // entries are removed until it approves the active generation.
    expect(cacheDelete).not.toHaveBeenCalled();
  });

  it('retires old caches only after every live tab approves the active generation', async () => {
    const first = { id: 'first', postMessage: vi.fn() };
    const second = { id: 'second', postMessage: vi.fn() };
    const futureVersion = `v${Number(ACTIVE_CACHE_VERSION.slice(1)) + 1}`;
    const futureCaches = [
      `musixquare-static-${futureVersion}`,
      `musixquare-runtime-${futureVersion}`,
      `musixquare-optional-${futureVersion}`,
    ];
    windowClients = [first, second];
    cacheKeys.mockResolvedValue([
      `musixquare-static-${RETIRED_CACHE_VERSION}`,
      `musixquare-runtime-${RETIRED_CACHE_VERSION}`,
      `musixquare-static-${ACTIVE_CACHE_VERSION}`,
      `musixquare-runtime-${ACTIVE_CACHE_VERSION}`,
      ...futureCaches,
      'unrelated-cache',
    ]);

    await dispatchExtendable(activateListener);
    await dispatchMessage(first, {
      type: 'MXQR_CACHE_CLIENT_STATUS',
      cacheVersion: ACTIVE_CACHE_VERSION,
      ready: true,
      replyToRequest: true,
    });
    await dispatchMessage(second, {
      type: 'MXQR_CACHE_CLIENT_STATUS',
      cacheVersion: ACTIVE_CACHE_VERSION,
      ready: true,
      replyToRequest: true,
    });

    expect(cacheDelete).toHaveBeenCalledTimes(2);
    expect(cacheDelete).toHaveBeenCalledWith(`musixquare-static-${RETIRED_CACHE_VERSION}`);
    expect(cacheDelete).toHaveBeenCalledWith(`musixquare-runtime-${RETIRED_CACHE_VERSION}`);
    for (const futureCache of futureCaches) {
      expect(cacheDelete).not.toHaveBeenCalledWith(futureCache);
    }
    expect(cacheOpen).not.toHaveBeenCalledWith(`musixquare-runtime-${futureVersion}`);
    expect(cacheDelete).not.toHaveBeenCalledWith('unrelated-cache');
  });

  it('rebuilds a lost ready set by querying all tabs after a fresh-page probe', async () => {
    const fresh = { id: 'fresh', postMessage: vi.fn() };
    const deferred = { id: 'deferred', postMessage: vi.fn() };
    windowClients = [fresh, deferred];

    // A restarted worker has an empty in-memory ready set. The freshly loaded
    // page probes it, receives the current generation, and proactively reports
    // ready (replyToRequest=false).
    await dispatchMessage(fresh, { type: 'MXQR_CACHE_STATUS_PROBE' });
    expect(fresh.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_STATUS_REQUEST',
      cacheVersion: ACTIVE_CACHE_VERSION,
      proactive: true,
      navigationFallback: false,
    });

    await dispatchMessage(fresh, {
      type: 'MXQR_CACHE_CLIENT_STATUS',
      cacheVersion: ACTIVE_CACHE_VERSION,
      ready: true,
      replyToRequest: false,
    });

    expect(fresh.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_STATUS_REQUEST',
      cacheVersion: ACTIVE_CACHE_VERSION,
    });
    expect(deferred.postMessage).toHaveBeenCalledWith({
      type: 'MXQR_CACHE_STATUS_REQUEST',
      cacheVersion: ACTIVE_CACHE_VERSION,
    });
    expect(cacheDelete).not.toHaveBeenCalled();
  });

  it('serves an old hashed lazy chunk while a live tab defers reload', async () => {
    const retiredStaticCache = `musixquare-static-${RETIRED_CACHE_VERSION}`;
    cacheKeys.mockResolvedValue([
      'unrelated-product-cache-v999',
      `musixquare-static-v${Number(ACTIVE_CACHE_VERSION.slice(1)) + 1}`,
      retiredStaticCache,
    ]);
    cacheMatch.mockImplementation(async (request: Request, options?: { cacheName?: string }) => {
      if (
        options?.cacheName === retiredStaticCache &&
        String(request.url).endsWith('/assets/locale-OldHash1.js')
      ) {
        return new Response('old lazy chunk', { status: 200 });
      }
      return undefined;
    });
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

    const response = await dispatch(
      new Request('https://musixquare.com/assets/locale-OldHash1.js'),
    );

    expect(await response.text()).toBe('old lazy chunk');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheMatch).toHaveBeenNthCalledWith(1, expect.any(Request), {
      cacheName: `musixquare-static-${ACTIVE_CACHE_VERSION}`,
    });
    expect(cacheMatch).toHaveBeenCalledWith(expect.any(Request), {
      cacheName: retiredStaticCache,
    });
    expect(cacheMatch).not.toHaveBeenCalledWith(expect.any(Request), {
      cacheName: 'unrelated-product-cache-v999',
    });
  });

  it('prefers the active cache generation for stable paths', async () => {
    cacheMatch.mockImplementation(async (_request: Request, options?: { cacheName?: string }) => {
      if (options?.cacheName === `musixquare-static-${ACTIVE_CACHE_VERSION}`) {
        return new Response('current asset', { status: 200 });
      }
      return new Response('retired asset', { status: 200 });
    });
    fetchMock.mockResolvedValue(new Response('network asset', { status: 200 }));

    const response = await dispatch(new Request('https://musixquare.com/favicon.svg'));

    expect(await response.text()).toBe('current asset');
  });

  it('uses the network before a retired generation for stable paths', async () => {
    cacheMatch.mockImplementation(async (_request: Request, options?: { cacheName?: string }) => {
      if (options?.cacheName) return undefined;
      return new Response('retired asset', { status: 200 });
    });
    fetchMock.mockResolvedValue(new Response('network asset', { status: 200 }));

    const response = await dispatch(new Request('https://musixquare.com/css/style.css'));

    expect(await response.text()).toBe('network asset');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cacheMatch).toHaveBeenCalledTimes(2);
  });

  it('falls back to a retired stable asset only when the network fails', async () => {
    const retiredRuntimeCache = `musixquare-runtime-${RETIRED_CACHE_VERSION}`;
    const futureStaticCache = `musixquare-static-v${Number(ACTIVE_CACHE_VERSION.slice(1)) + 1}`;
    cacheKeys.mockResolvedValue([
      'unrelated-product-cache-v999',
      futureStaticCache,
      retiredRuntimeCache,
    ]);
    cacheMatch.mockImplementation(async (_request: Request, options?: { cacheName?: string }) => {
      if (!options?.cacheName) {
        return new Response('untrusted cache asset', { status: 200 });
      }
      if (options?.cacheName === retiredRuntimeCache) {
        return new Response('retired offline asset', { status: 200 });
      }
      if (
        options?.cacheName === 'unrelated-product-cache-v999' ||
        options?.cacheName === futureStaticCache
      ) {
        return new Response('untrusted cache asset', { status: 200 });
      }
      return undefined;
    });
    fetchMock.mockRejectedValue(new Error('offline'));

    const response = await dispatch(new Request('https://musixquare.com/css/style.css'));

    expect(await response.text()).toBe('retired offline asset');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cacheMatch).toHaveBeenNthCalledWith(3, expect.any(Request), {
      cacheName: retiredRuntimeCache,
    });
    expect(cacheMatch).not.toHaveBeenCalledWith(expect.any(Request), {
      cacheName: 'unrelated-product-cache-v999',
    });
    expect(cacheMatch).not.toHaveBeenCalledWith(expect.any(Request), {
      cacheName: futureStaticCache,
    });
  });

  it('does not use unrelated or future caches as an offline stable-asset fallback', async () => {
    const futureRuntimeCache = `musixquare-runtime-v${Number(ACTIVE_CACHE_VERSION.slice(1)) + 1}`;
    cacheKeys.mockResolvedValue(['unrelated-product-cache-v999', futureRuntimeCache]);
    cacheMatch.mockImplementation(async (_request: Request, options?: { cacheName?: string }) => {
      if (!options?.cacheName) {
        return new Response('untrusted cache asset', { status: 200 });
      }
      if (
        options?.cacheName === 'unrelated-product-cache-v999' ||
        options?.cacheName === futureRuntimeCache
      ) {
        return new Response('untrusted cache asset', { status: 200 });
      }
      return undefined;
    });
    fetchMock.mockRejectedValue(new Error('offline'));

    const response = await dispatch(new Request('https://musixquare.com/css/style.css'));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Offline');
    expect(cacheMatch).not.toHaveBeenCalledWith(expect.any(Request), {
      cacheName: 'unrelated-product-cache-v999',
    });
    expect(cacheMatch).not.toHaveBeenCalledWith(expect.any(Request), {
      cacheName: futureRuntimeCache,
    });
  });
});
