/* service-worker.js
 * MUSIXQUARE PWA Service Worker (App Shell Cache)
 * - Caches core static assets for faster loads + basic offline support
 * - Avoids caching large media downloads and dynamic endpoints
 */

'use strict';

// Bump this whenever a stable-path app-shell asset changes so existing clients
// migrate to a fresh cache.
const CACHE_VERSION = 'v442';
const STATIC_CACHE = `musixquare-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `musixquare-runtime-${CACHE_VERSION}`;
const OPTIONAL_CACHE = `musixquare-optional-${CACHE_VERSION}`;
const BOOTSTRAP_CACHE_KEY = `./bootstrap.js?cache=${CACHE_VERSION}`;
// iOS can resume a standalone app with a half-open radio path where fetch()
// neither succeeds nor rejects for a long time. A navigation must reach the
// active cached shell instead of leaving WebKit on its blank provisional page.
const NAVIGATION_NETWORK_TIMEOUT_MS = 3_000;
// The optional full font is useful after an interrupted reopen, but it must
// never keep a new worker in `installing` indefinitely on a half-open radio.
const OPTIONAL_ASSET_GROUP_TIMEOUT_MS = 6_000;
const OPTIONAL_CACHE_READY_KEY = `./.mxqr-optional-ready?cache=${CACHE_VERSION}`;
const CACHE_STATUS_REQUEST = 'MXQR_CACHE_STATUS_REQUEST';
const CACHE_CLIENT_STATUS = 'MXQR_CACHE_CLIENT_STATUS';
const CACHE_STATUS_PROBE = 'MXQR_CACHE_STATUS_PROBE';
const ACCOUNT_COMPLETION_PATH = '/account-complete.html';
const ACCOUNT_COMPLETION_SHELL = './account-complete.html';
const cacheReadyClientIds = new Set();
const cachedNavigationClientIds = new Set();
const clearedNavigationClientIds = new Set();

// CacheStorage keys retain the full query string. Authentication completion
// markers, client correlation IDs, and credential-like values are one-time or
// sensitive navigation state and must never become persistent runtime keys.
// Keep this fail-closed list aligned with the return-URL sanitizer in
// src/account/login-return.ts.
const SENSITIVE_NAVIGATION_QUERY_PARAMETER =
  /^(?:account[-_]?auth|account[-_]?client|pin|pro[-_]?pin|password|passcode|token|access[-_]?token|refresh[-_]?token|id[-_]?token|claim(?:[-_]?token)?|pro[-_]?claim|pro[-_]?recovery|pro[-_]?transfer|session(?:[-_]?(?:id|secret|token))?|secret|credential|authorization|auth[-_]?code|oauth[-_]?code|code|state|nonce|api[-_]?key|jwt)$/i;

// Only list assets that keep stable paths after Vite build. index.html is the
// canonical navigation shell; caching './' as well would store the same body
// twice under different keys.
// Vite injects the canonical app entry plus reviewed deferred roots and their
// static JS/CSS closure at build time.
// Keeping this manifest deterministic makes a first successful install usable
// offline, rather than depending on each hashed asset having been requested.
const BUILD_ENTRY_ASSETS = [
  /* __MUSIXQUARE_BUILD_ENTRY_ASSETS__ */
];

// Vite injects the lazy Pretendard CSS closure here. The canonical 2 MiB font
// is included in the same optional group, never in core APP_SHELL/addAll.
const OPTIONAL_PRIMARY_FONT_ASSETS = [
  /* __MUSIXQUARE_OPTIONAL_PRIMARY_FONT_ASSETS__ */
];

const APP_SHELL = [
  './index.html',
  './account-complete.html',
  './account-complete.js',
  './account-complete.css',
  BOOTSTRAP_CACHE_KEY,
  './fouc-cleanup.js',
  './wordmark-anim.js',
  './dummy_audio.mp3',
  './icons/icon-512.png',
  './favicon.ico',
  './favicon.svg',
  ...BUILD_ENTRY_ASSETS,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);

      // A partial core shell must never activate. Cache.addAll is the
      // fail-closed boundary for the functional generation.
      await cache.addAll(APP_SHELL);

      // Font CSS + body are staged behind a readiness marker in their own
      // cache. Failure or timeout is non-fatal and leaves partial entries
      // invisible; the page-level font loader will retry after recovery.
      await stageOptionalPrimaryFontAssets();
    })(),
  );
});

function responseWithBodyCopy(response, body) {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function stageOptionalPrimaryFontAssets() {
  if (OPTIONAL_PRIMARY_FONT_ASSETS.length === 0) return;

  let expired = false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      expired = true;
      try {
        controller?.abort();
      } catch (_) {
        /* already settled */
      }
      reject(new Error('OPTIONAL_ASSET_GROUP_TIMEOUT'));
    }, OPTIONAL_ASSET_GROUP_TIMEOUT_MS);
  });

  const staging = (async () => {
    const optionalCache = await caches.open(OPTIONAL_CACHE);
    // A prior abandoned install may have left bodies behind. Removing the
    // marker first keeps every incomplete generation invisible.
    await optionalCache.delete(OPTIONAL_CACHE_READY_KEY);
    const entries = await Promise.all(
      OPTIONAL_PRIMARY_FONT_ASSETS.map(async (asset) => {
        const request = new Request(new URL(asset, self.location.href));
        const response = controller
          ? await fetch(request, { signal: controller.signal })
          : await fetch(request);
        if (!response || response.status === 206 || !response.ok) {
          throw new Error(`OPTIONAL_ASSET_FETCH_FAILED:${request.url}`);
        }
        const body = await response.arrayBuffer();
        return { request, response: responseWithBodyCopy(response, body) };
      }),
    );
    if (expired) return;
    for (const entry of entries) {
      await optionalCache.put(entry.request, entry.response);
      if (expired) return;
    }
    await optionalCache.put(
      OPTIONAL_CACHE_READY_KEY,
      new Response(CACHE_VERSION, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }),
    );
  })();

  try {
    await Promise.race([staging, timeout]);
  } catch (_) {
    // Optional prefetch failure must not block the functional app generation.
  } finally {
    clearTimeout(timeoutId);
    try {
      controller?.abort();
    } catch (_) {
      /* already settled */
    }
  }
}

// The page may opt into immediate activation after presenting its update UI.
self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') {
    const activation = self.skipWaiting();
    if (typeof event.waitUntil === 'function') event.waitUntil(activation);
    return;
  }

  if (event && event.data && event.data.type === CACHE_STATUS_PROBE) {
    const work = (async () => {
      const clientId = event.source && event.source.id;
      const navigationFallback = clientId ? await readCachedNavigationState(clientId) : false;
      try {
        event.source?.postMessage({
          type: CACHE_STATUS_REQUEST,
          cacheVersion: CACHE_VERSION,
          proactive: true,
          navigationFallback,
        });
      } catch (_) {
        /* the probing page disappeared */
      }
    })();
    if (typeof event.waitUntil === 'function') event.waitUntil(work);
    return;
  }

  if (
    !event ||
    !event.data ||
    event.data.type !== CACHE_CLIENT_STATUS ||
    event.data.cacheVersion !== CACHE_VERSION
  ) {
    return;
  }

  const clientId = event.source && event.source.id;
  if (!clientId) return;
  if (event.data.ready === true) cacheReadyClientIds.add(clientId);
  else cacheReadyClientIds.delete(clientId);

  const work = (async () => {
    const retired = await retireOldCachesIfSafe();
    // A proactive status from a freshly loaded page also recovers the
    // handshake after the service worker was suspended and lost its in-memory
    // ready set. Query every remaining client once; replies are marked so they
    // do not trigger another broadcast loop.
    if (!retired && event.data.replyToRequest !== true) {
      await requestClientCacheStatuses();
    }
  })();
  if (typeof event.waitUntil === 'function') event.waitUntil(work);
});

async function getWindowClients() {
  if (!self.clients || typeof self.clients.matchAll !== 'function') return [];
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

async function deleteRetiredCaches() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => {
        return (
          key.startsWith('musixquare-') && // brand-capitalization: allow-technical
          ![STATIC_CACHE, RUNTIME_CACHE, OPTIONAL_CACHE].includes(key)
        );
      })
      .map((key) => caches.delete(key)),
  );
}

function cachedNavigationStateRequest(clientId) {
  const encodedClientId = encodeURIComponent(String(clientId));
  return new Request(
    new URL(`/.mxqr-navigation-fallback/${encodedClientId}`, self.location.origin),
  );
}

async function recordCachedNavigationState(clientId) {
  if (!clientId) return;
  // Set memory first so an immediate page probe cannot race CacheStorage.
  clearedNavigationClientIds.delete(clientId);
  cachedNavigationClientIds.add(clientId);
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(
      cachedNavigationStateRequest(clientId),
      new Response(CACHE_VERSION, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }),
    );
  } catch (_) {
    // The in-memory marker still covers the ordinary uninterrupted worker
    // lifetime; persistence is a reliability enhancement, not a boot gate.
  }
}

async function clearCachedNavigationState(clientId) {
  if (!clientId) return;
  // Tombstone memory first so a page probe cannot observe the old persistent
  // marker while its deletion is still queued under waitUntil.
  cachedNavigationClientIds.delete(clientId);
  clearedNavigationClientIds.add(clientId);
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.delete(cachedNavigationStateRequest(clientId));
  } catch (_) {
    // The in-memory tombstone remains authoritative for this worker lifetime.
  }
}

async function readCachedNavigationState(clientId) {
  if (!clientId) return false;
  if (clearedNavigationClientIds.has(clientId)) return false;
  const stateRequest = cachedNavigationStateRequest(clientId);
  let found = cachedNavigationClientIds.has(clientId);
  try {
    const persisted = await caches.match(stateRequest, { cacheName: RUNTIME_CACHE });
    if (persisted) found = true;
  } catch (_) {
    // Preserve the in-memory result when CacheStorage is unavailable.
  }
  return found;
}

async function scrubSensitiveRetiredRuntimeEntries() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter(
        (key) =>
          key.startsWith('musixquare-runtime-') && // brand-capitalization: allow-technical
          key !== RUNTIME_CACHE,
      )
      .map(async (key) => {
        try {
          const cache = await caches.open(key);
          const requests = await cache.keys();
          await Promise.all(
            requests
              .filter((request) => hasSensitiveNavigationQuery(request))
              .map((request) => cache.delete(request)),
          );
        } catch (_) {
          // Preserve the old cache for live tabs if it cannot be inspected;
          // the ordinary ready handshake will retire it later.
        }
      }),
  );
}

async function retireOldCachesIfSafe() {
  const clients = await getWindowClients();
  const liveClientIds = new Set(clients.map((client) => client.id).filter(Boolean));
  for (const clientId of cacheReadyClientIds) {
    if (!liveClientIds.has(clientId)) cacheReadyClientIds.delete(clientId);
  }

  if (clients.length > 0 && !clients.every((client) => cacheReadyClientIds.has(client.id))) {
    return false;
  }
  await deleteRetiredCaches();
  return true;
}

async function requestClientCacheStatuses(clients) {
  const targets = clients || (await getWindowClients());
  for (const client of targets) {
    try {
      client.postMessage({ type: CACHE_STATUS_REQUEST, cacheVersion: CACHE_VERSION });
    } catch (_) {
      // A client may disappear between matchAll() and postMessage(). Its stale
      // cache remains until the next handshake, which is the safe failure mode.
    }
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Claim first so each existing tab can compare the active controller
      // with the controller under which its current JS was loaded.
      await self.clients.claim();
      // Old room tabs may deliberately retain their hashed-asset cache, but
      // one-time auth callback URLs from a previous runtime cache have no
      // legitimate offline use and must not survive the security update.
      await scrubSensitiveRetiredRuntimeEntries();
      const clients = await getWindowClients();
      if (clients.length === 0) {
        await deleteRetiredCaches();
        return;
      }

      // Do not delete old hashed chunks while a live room tab is deliberately
      // deferring reload. Cache retirement happens only after every live tab
      // confirms it was loaded under this controller generation.
      await requestClientCacheStatuses(clients);
    })(),
  );
});

function isCacheableRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);

  // Range responses are not safe Cache.put candidates across Safari and
  // embedded WebViews. The one exception is the canonical, install-owned
  // 2.4 KiB iOS primer, whose full body is already in APP_SHELL and is served
  // by the dedicated range path below.
  if (request.headers && request.headers.has('range') && !isCanonicalAudioPrimerUrl(url)) {
    return false;
  }

  // Leave cross-origin assets to their own HTTP caches. Returning opaque
  // responses through this worker has broken media previews on Safari and
  // embedded WebViews.
  if (url.origin !== self.location.origin) return false;

  const path = url.pathname || '';

  // Never cache backend functions — they return per-request data (e.g.
  // TURN credentials). CacheStorage doesn't honour Cache-Control: no-store,
  // so the only safe move is to skip them entirely from the SW pipeline.
  if (path.startsWith('/api/')) return false;

  // Keep the tiny iOS AudioContext primer available offline despite the media
  // extension exclusion below.
  if (isCanonicalAudioPrimerUrl(url)) return true;

  const ext = path.split('.').pop().toLowerCase();
  // Exclude common audio/video containers to prevent storage bloat.
  if (
    [
      'mp4',
      'webm',
      'mkv',
      'mp3',
      'wav',
      'ogg',
      'm4a',
      'aac',
      'flac',
      'opus',
      'aif',
      'aiff',
      'caf',
    ].includes(ext)
  )
    return false;

  return true;
}

function isCanonicalAudioPrimerUrl(url) {
  return (
    url.origin === self.location.origin && url.pathname === '/dummy_audio.mp3' && url.search === ''
  );
}

function isAudioPrimerRangeRequest(request) {
  return (
    request.method === 'GET' &&
    request.headers &&
    request.headers.has('range') &&
    isCanonicalAudioPrimerUrl(new URL(request.url))
  );
}

function primerRangeHeaders(sourceHeaders, contentLength) {
  const headers = new Headers();
  sourceHeaders.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (
      normalized === 'content-encoding' ||
      normalized === 'transfer-encoding' ||
      normalized === 'content-length' ||
      normalized === 'content-range'
    ) {
      return;
    }
    headers.set(name, value);
  });
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(contentLength));
  return headers;
}

function parseSingleByteRange(value, totalLength) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value || '').trim());
  if (!match || (!match[1] && !match[2]) || totalLength <= 0) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, totalLength - suffixLength),
      end: totalLength - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalLength - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= totalLength ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, totalLength - 1) };
}

async function serveAudioPrimerRange(request) {
  let cached;
  try {
    cached = await caches.match('./dummy_audio.mp3', { cacheName: STATIC_CACHE });
  } catch (_) {
    cached = null;
  }

  if (!cached || cached.status !== 200) {
    try {
      return await fetch(request);
    } catch (_) {
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  }

  let fullBody;
  try {
    fullBody = await cached.arrayBuffer();
  } catch (_) {
    try {
      return await fetch(request);
    } catch (_) {
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  }

  const range = parseSingleByteRange(request.headers.get('range'), fullBody.byteLength);
  if (!range) {
    const headers = primerRangeHeaders(cached.headers, 0);
    headers.set('Content-Range', `bytes */${fullBody.byteLength}`);
    return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers });
  }

  const body = fullBody.slice(range.start, range.end + 1);
  const headers = primerRangeHeaders(cached.headers, body.byteLength);
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${fullBody.byteLength}`);
  return new Response(body, { status: 206, statusText: 'Partial Content', headers });
}

function isRoomNavigation(request) {
  const url = new URL(request.url);
  return url.origin === self.location.origin && /^\/\d{6}\/?$/.test(url.pathname);
}

function hasSensitiveNavigationQuery(request) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;

  for (const parameter of url.searchParams.keys()) {
    if (SENSITIVE_NAVIGATION_QUERY_PARAMETER.test(parameter)) return true;
  }
  return false;
}

function canonicalNavigationShell(request) {
  const url = new URL(request.url);
  return url.origin === self.location.origin && url.pathname === ACCOUNT_COMPLETION_PATH
    ? ACCOUNT_COMPLETION_SHELL
    : './index.html';
}

function isImmutableHashedAsset(request) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/assets/')) return false;

  // Vite content hashes are eight URL-safe characters. Require the final
  // filename segment so stable files under /assets keep revalidation.
  return /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(url.pathname);
}

function isOptionalPrimaryFontAsset(request) {
  const requestUrl = new URL(request.url);
  return OPTIONAL_PRIMARY_FONT_ASSETS.some((asset) => {
    try {
      return new URL(asset, self.location.href).href === requestUrl.href;
    } catch (_) {
      return false;
    }
  });
}

async function matchActiveOptionalAsset(request) {
  if (!isOptionalPrimaryFontAsset(request)) return null;
  try {
    const ready = await caches.match(OPTIONAL_CACHE_READY_KEY, { cacheName: OPTIONAL_CACHE });
    if (!ready) return null;
    return (await caches.match(request, { cacheName: OPTIONAL_CACHE })) || null;
  } catch (_) {
    return null;
  }
}

async function matchRetiredAsset(request) {
  // Optional loader/CSS/font files form one atomic group. Never mix one of
  // them from retired static/runtime caches or a markerless optional cache:
  // the safer fallback is the system font until a complete generation exists.
  if (isOptionalPrimaryFontAsset(request)) {
    try {
      const keys = await caches.keys();
      for (const key of keys) {
        if (key === OPTIONAL_CACHE) continue;
        const retiredMatch = /^musixquare-optional-v(\d+)$/.exec(key); // brand-capitalization: allow-technical
        const currentMatch = /^v(\d+)$/.exec(CACHE_VERSION);
        if (!retiredMatch || !currentMatch || Number(retiredMatch[1]) >= Number(currentMatch[1])) {
          continue;
        }
        const retiredVersion = `v${retiredMatch[1]}`;
        const readyKey = `./.mxqr-optional-ready?cache=${retiredVersion}`;
        const ready = await caches.match(readyKey, { cacheName: key });
        if (!ready) continue;
        const cached = await caches.match(request, { cacheName: key });
        if (cached) return cached;
      }
      return null;
    } catch (_) {
      return null;
    }
  }
  try {
    return (await caches.match(request)) || null;
  } catch (_) {
    return null;
  }
}

async function cacheResponse(cacheName, request, response) {
  try {
    // Clone before the first await. The response may be returned to and
    // consumed by the page while CacheStorage.open() is still pending.
    const cacheCopy = response.clone();
    const cache = await caches.open(cacheName);
    await cache.put(request, cacheCopy);
  } catch (_) {
    // Cache writes are best-effort, but the promise is still kept alive by
    // the fetch event so a successful write cannot be abandoned mid-flight.
  }
}

function fetchNavigationWithTimeout(request) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timeoutId;
  let removeRequestAbortListener = () => undefined;

  if (controller && request.signal) {
    // Avoid AbortSignal.reason here: older WebKit releases support aborting a
    // fetch but do not expose the reason property consistently.
    const abortFromRequest = () => controller.abort();
    if (request.signal.aborted) abortFromRequest();
    else {
      request.signal.addEventListener('abort', abortFromRequest, { once: true });
      removeRequestAbortListener = () =>
        request.signal.removeEventListener('abort', abortFromRequest);
    }
  }

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch (_) {
        /* an already-settled fetch needs no further cancellation */
      }
      reject(new Error('NAVIGATION_NETWORK_TIMEOUT'));
    }, NAVIGATION_NETWORK_TIMEOUT_MS);
  });
  const network = controller ? fetch(request, { signal: controller.signal }) : fetch(request);

  return Promise.race([network, timeout]).finally(() => {
    clearTimeout(timeoutId);
    removeRequestAbortListener();
  });
}

async function matchActiveNavigationShell(request) {
  try {
    // Only the active cache generation is safe for HTML. Falling through to an
    // unrestricted caches.match() can combine a retired index with current
    // stable assets while an update-aware room tab is still alive.
    if (!isRoomNavigation(request) && !hasSensitiveNavigationQuery(request)) {
      const cachedNavigation = await caches.match(request, { cacheName: RUNTIME_CACHE });
      if (cachedNavigation) return cachedNavigation;
    }
    return (
      (await caches.match(canonicalNavigationShell(request), { cacheName: STATIC_CACHE })) || null
    );
  } catch (_) {
    return null;
  }
}

function markCachedNavigationResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Musixquare-Navigation-Source', 'cache-fallback');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Network-first for navigations, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isCacheableRequest(request)) return;

  if (isAudioPrimerRangeRequest(request)) {
    event.respondWith(serveAudioPrimerRange(request));
    return;
  }

  // Navigation (HTML): network-first, fallback to cached index
  if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
    const networkResponse = fetchNavigationWithTimeout(request);
    // Start CacheStorage lookup while the radio fetch is in flight. If the
    // timeout wins, the already-resolved active shell can paint immediately.
    const cachedShell = matchActiveNavigationShell(request);
    // Six-digit room URLs all execute the installed SPA shell. Their online
    // responses differ only in invite metadata, so storing each URL creates
    // duplicate cache entries. index.html is already the canonical offline
    // shell in APP_SHELL.
    const cacheUpdate =
      isRoomNavigation(request) || hasSensitiveNavigationQuery(request)
        ? networkResponse.then(
            () => undefined,
            () => undefined,
          )
        : networkResponse
            .then((fresh) => {
              if (!fresh.ok || fresh.status === 206) return undefined;
              return cacheResponse(RUNTIME_CACHE, request, fresh);
            })
            .catch(() => undefined);

    // Register background work while the fetch event is still dispatching.
    // Calling waitUntil only after an awaited cache/network lookup is not
    // portable, and leaving Cache.put unchained lets the worker be suspended
    // before the offline fallback is actually written.
    const navigationStateUpdate = networkResponse.then(
      async () => {
        const resultingClientId = event.resultingClientId || event.clientId;
        if (resultingClientId) await clearCachedNavigationState(resultingClientId);
      },
      async () => {
        const fallback = await cachedShell;
        const resultingClientId = event.resultingClientId || event.clientId;
        if (fallback && resultingClientId) {
          await recordCachedNavigationState(resultingClientId);
        }
      },
    );
    event.waitUntil(Promise.all([cacheUpdate, navigationStateUpdate]));
    event.respondWith(
      (async () => {
        try {
          // Cache population runs under waitUntil and does not delay the
          // network response returned to the navigation.
          return await networkResponse;
        } catch (_) {
          const fallback = await cachedShell;
          return fallback
            ? markCachedNavigationResponse(fallback)
            : new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        }
      })(),
    );
    return;
  }

  // The optional Pretendard group is already validated by its readiness
  // marker. Serve it cache-first without launching a duplicate 2 MiB font
  // revalidation; a failed/partial install falls through to network and the
  // successful retry is promoted into the active static cache.
  if (isOptionalPrimaryFontAsset(request)) {
    const cachedResponse = (async () => {
      return (
        (await caches.match(request, { cacheName: STATIC_CACHE })) ||
        (await caches.match(request, { cacheName: RUNTIME_CACHE })) ||
        (await matchActiveOptionalAsset(request)) ||
        null
      );
    })();
    const networkResponse = cachedResponse.then((cached) => {
      if (cached) return null;
      return fetch(request).catch(() => null);
    });
    const cacheUpdate = networkResponse.then((response) => {
      if (!response || response.status === 206 || (!response.ok && response.type !== 'opaque')) {
        return undefined;
      }
      return cacheResponse(STATIC_CACHE, request, response);
    });
    event.waitUntil(cacheUpdate);
    event.respondWith(
      (async () => {
        const cached = await cachedResponse;
        if (cached) return cached;
        const fresh = await networkResponse;
        return (
          fresh ||
          (await matchRetiredAsset(request)) ||
          new Response('Offline', { status: 503, statusText: 'Offline' })
        );
      })(),
    );
    return;
  }

  // Content-hashed assets are immutable. Do not re-fetch and rewrite them on
  // every hit. Search retired generations as a final fallback so a room tab
  // that deliberately deferred reload can still import its old lazy chunks.
  if (isImmutableHashedAsset(request)) {
    const cachedResponse = (async () => {
      return (
        (await caches.match(request, { cacheName: STATIC_CACHE })) ||
        (await caches.match(request, { cacheName: RUNTIME_CACHE })) ||
        (await matchActiveOptionalAsset(request)) ||
        (await matchRetiredAsset(request)) ||
        null
      );
    })();
    const networkResponse = cachedResponse.then((cached) => {
      if (cached) return null;
      return fetch(request).catch(() => null);
    });
    const cacheUpdate = networkResponse.then((response) => {
      if (!response || response.status === 206 || (!response.ok && response.type !== 'opaque')) {
        return undefined;
      }
      return cacheResponse(STATIC_CACHE, request, response);
    });
    event.waitUntil(cacheUpdate);
    event.respondWith(
      (async () => {
        const cached = await cachedResponse;
        if (cached) return cached;
        const fresh = await networkResponse;
        return fresh || new Response('Offline', { status: 503, statusText: 'Offline' });
      })(),
    );
    return;
  }

  // Stable same-origin static: use only the active generation cache before
  // revalidating. A retired cache is a last-resort offline fallback, never a
  // normal cache miss response: otherwise the first request after an update
  // can combine the new HTML/JS generation with an old stable CSS or icon.
  const networkResponse = fetch(request).catch(() => null);
  const cacheUpdate = networkResponse.then((response) => {
    // Partial responses must never enter the static cache.
    if (!response || response.status === 206 || (!response.ok && response.type !== 'opaque')) {
      return undefined;
    }
    return cacheResponse(STATIC_CACHE, request, response);
  });
  event.waitUntil(cacheUpdate);
  event.respondWith(
    (async () => {
      const activeCached =
        (await caches.match(request, { cacheName: STATIC_CACHE })) ||
        (await caches.match(request, { cacheName: RUNTIME_CACHE })) ||
        (await matchActiveOptionalAsset(request));

      if (activeCached) return activeCached;

      const fresh = await networkResponse;
      if (fresh) return fresh;

      // A live tab that deliberately deferred reload may still need a stable
      // asset from its retired generation while truly offline. Restrict this
      // unrestricted lookup to network failure so it cannot win online.
      return (
        (await matchRetiredAsset(request)) ||
        new Response('Offline', { status: 503, statusText: 'Offline' })
      );
    })(),
  );
});
