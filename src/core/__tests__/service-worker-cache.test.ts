import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SERVICE_WORKER_SOURCE = readFileSync(
  new URL('../../../public/service-worker.js', import.meta.url),
  'utf8',
);
const ACTIVE_CACHE_VERSION = /^const CACHE_VERSION = '([^']+)';$/mu.exec(
  SERVICE_WORKER_SOURCE,
)?.[1];
if (!ACTIVE_CACHE_VERSION) {
  throw new Error('Unable to resolve the active service worker cache version');
}
const NAVIGATION_NETWORK_TIMEOUT_MS = Number(
  /^const NAVIGATION_NETWORK_TIMEOUT_MS = ([\d_]+);$/mu
    .exec(SERVICE_WORKER_SOURCE)?.[1]
    ?.replaceAll('_', ''),
);
if (!Number.isFinite(NAVIGATION_NETWORK_TIMEOUT_MS)) {
  throw new Error('Unable to resolve the service worker navigation timeout');
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
  respondWith: (response: Promise<Response>) => void;
  waitUntil: (work: Promise<unknown>) => void;
}) => void;

type ExtendableListener = (event: { waitUntil: (work: Promise<unknown>) => void }) => void;

type MessageListener = (event: {
  data: Record<string, unknown>;
  source?: { id: string; postMessage: ReturnType<typeof vi.fn> };
  waitUntil: (work: Promise<unknown>) => void;
}) => void;

describe('service worker cache policy', () => {
  let fetchListener: FetchListener;
  let activateListener: ExtendableListener;
  let messageListener: MessageListener;
  let cachePut: ReturnType<typeof vi.fn>;
  let cacheEntryKeys: ReturnType<typeof vi.fn>;
  let cacheEntryDelete: ReturnType<typeof vi.fn>;
  let cacheOpen: ReturnType<typeof vi.fn>;
  let cacheMatch: ReturnType<typeof vi.fn>;
  let cacheKeys: ReturnType<typeof vi.fn>;
  let cacheDelete: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let clientsClaim: ReturnType<typeof vi.fn>;
  let skipWaiting: ReturnType<typeof vi.fn>;
  let windowClients: Array<{ id: string; postMessage: ReturnType<typeof vi.fn> }>;

  it('precaches both stable first-paint scripts with the navigation shell', () => {
    expect(APP_SHELL_SOURCE).toContain("'./fouc-cleanup.js'");
    expect(APP_SHELL_SOURCE).toContain("'./wordmark-anim.js'");
  });

  it('precaches the queryless account-completion document and its stable assets', () => {
    expect(APP_SHELL_SOURCE).toContain("'./account-complete.html'");
    expect(APP_SHELL_SOURCE).toContain("'./account-complete.js'");
    expect(APP_SHELL_SOURCE).toContain("'./account-complete.css'");
  });

  it('does not spend the first service-worker install on the optional 2 MiB app font', () => {
    expect(APP_SHELL_SOURCE).not.toContain('PretendardVariable.woff2');
  });

  it('spreads the build-injected app entry closure into the install shell', () => {
    expect(SERVICE_WORKER_SOURCE).toContain('const BUILD_ENTRY_ASSETS = [');
    expect(APP_SHELL_SOURCE).toContain('...BUILD_ENTRY_ASSETS');
  });

  beforeEach(async () => {
    const listeners = new Map<string, (event: never) => void>();
    cachePut = vi.fn(async () => undefined);
    cacheEntryKeys = vi.fn(async () => []);
    cacheEntryDelete = vi.fn(async () => true);
    cacheOpen = vi.fn(async () => ({
      addAll: vi.fn(async () => undefined),
      put: cachePut,
      keys: cacheEntryKeys,
      delete: cacheEntryDelete,
    }));
    cacheMatch = vi.fn(async () => undefined);
    cacheKeys = vi.fn(async () => []);
    cacheDelete = vi.fn(async () => true);
    fetchMock = vi.fn();
    clientsClaim = vi.fn(async () => undefined);
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
      clients: {
        claim: clientsClaim,
        matchAll: vi.fn(async () => windowClients),
      },
    };
    const caches = {
      open: cacheOpen,
      match: cacheMatch,
      keys: cacheKeys,
      delete: cacheDelete,
    };
    vm.runInNewContext(SERVICE_WORKER_SOURCE, {
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
    activateListener = listeners.get('activate') as ExtendableListener;
    messageListener = listeners.get('message') as MessageListener;
  });

  async function dispatch(request: Request): Promise<Response> {
    const { response, work } = await dispatchWithWork(request);
    await Promise.all(work);
    return response;
  }

  async function dispatchWithWork(request: Request): Promise<{
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

  it('caches a successful navigation in the runtime cache', async () => {
    fetchMock.mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    await dispatch(
      new Request('https://musixquare.com/session', { headers: { accept: 'text/html' } }),
    );

    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-runtime-${ACTIVE_CACHE_VERSION}`);
    expect(cachePut).toHaveBeenCalledOnce();
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

  it('uses the static cache for same-origin assets', async () => {
    fetchMock.mockResolvedValue(new Response('asset', { status: 200 }));

    await dispatch(new Request('https://musixquare.com/assets/app.js'));

    expect(cacheOpen).toHaveBeenCalledWith(`musixquare-static-${ACTIVE_CACHE_VERSION}`);
    expect(cachePut).toHaveBeenCalledOnce();
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
    windowClients = [first, second];
    cacheKeys.mockResolvedValue([
      `musixquare-static-${RETIRED_CACHE_VERSION}`,
      `musixquare-runtime-${RETIRED_CACHE_VERSION}`,
      `musixquare-static-${ACTIVE_CACHE_VERSION}`,
      `musixquare-runtime-${ACTIVE_CACHE_VERSION}`,
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
    cacheMatch.mockImplementation(async (request: Request, options?: { cacheName?: string }) => {
      if (options?.cacheName) return undefined;
      return String(request.url).endsWith('/assets/locale-OldHash1.js')
        ? new Response('old lazy chunk', { status: 200 })
        : undefined;
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
    cacheMatch.mockImplementation(async (_request: Request, options?: { cacheName?: string }) => {
      if (options?.cacheName) return undefined;
      return new Response('retired offline asset', { status: 200 });
    });
    fetchMock.mockRejectedValue(new Error('offline'));

    const response = await dispatch(new Request('https://musixquare.com/css/style.css'));

    expect(await response.text()).toBe('retired offline asset');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cacheMatch).toHaveBeenNthCalledWith(3, expect.any(Request));
  });
});
