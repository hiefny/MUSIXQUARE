/* service-worker.js
 * MUSIXQUARE PWA Service Worker (App Shell Cache)
 * - Caches core static assets for faster loads + basic offline support
 * - Avoids caching large media downloads and dynamic endpoints
 */

'use strict';

// Bump this whenever a stable-path app-shell asset changes so existing clients
// migrate to a fresh cache.
const CACHE_VERSION = 'v172';
const STATIC_CACHE = `musixquare-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `musixquare-runtime-${CACHE_VERSION}`;
const CACHE_STATUS_REQUEST = 'MXQR_CACHE_STATUS_REQUEST';
const CACHE_CLIENT_STATUS = 'MXQR_CACHE_CLIENT_STATUS';
const CACHE_STATUS_PROBE = 'MXQR_CACHE_STATUS_PROBE';
const cacheReadyClientIds = new Set();

// Only list assets that keep stable paths after Vite build.
// Vite-hashed assets (CSS, JS bundles, icons, fonts, manifest) are cached
// at runtime via the stale-while-revalidate fetch handler below.
const APP_SHELL = [
  './',
  './index.html',
  './dummy_audio.mp3',
  './designsystem/fonts/PretendardVariable.woff2',
  './icons/icon-512.png',
  './favicon.ico',
  './favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);

      // Core shell failures abort installation. Fonts and any future
      // cross-origin extras are best-effort so an optional asset cannot strand
      // clients on an older worker.
      const core = [];
      const optional = [];

      for (const asset of APP_SHELL) {
        try {
          const url = new URL(asset, self.location.href);
          if (url.origin === self.location.origin) {
            // A missing font should not prevent the functional shell from updating.
            if (url.pathname.includes('/fonts/') || /\.(?:woff2?|ttf|otf)$/i.test(url.pathname)) {
              optional.push(asset);
            } else {
              core.push(asset);
            }
          } else {
            optional.push(asset);
          }
        } catch (_) {
          // Preserve fail-fast behavior for an invalid core entry.
          core.push(asset);
        }
      }

      // Core app shell: must succeed.
      await cache.addAll(core);

      // Optional assets: best-effort.
      await Promise.allSettled(
        optional.map(async (assetUrl) => {
          try {
            const req = new Request(assetUrl, { mode: 'no-cors' });
            const res = await fetch(req);
            if (res && (res.ok || res.type === 'opaque')) {
              await cache.put(req, res);
            }
          } catch (_) {
            // Optional fetch failure.
          }
        }),
      );
    })(),
  );
});

// The page may opt into immediate activation after presenting its update UI.
self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (event && event.data && event.data.type === CACHE_STATUS_PROBE) {
    try {
      event.source?.postMessage({
        type: CACHE_STATUS_REQUEST,
        cacheVersion: CACHE_VERSION,
        proactive: true,
      });
    } catch (_) {
      /* the probing page disappeared */
    }
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
        return key.startsWith('musixquare-') && ![STATIC_CACHE, RUNTIME_CACHE].includes(key);
      })
      .map((key) => caches.delete(key)),
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
  // Range responses are not safe Cache.put candidates across Safari and
  // embedded WebViews.
  if (request.headers && request.headers.has('range')) return false;
  const url = new URL(request.url);

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
  if (path.endsWith('dummy_audio.mp3')) return true;

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

// Network-first for navigations, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isCacheableRequest(request)) return;

  // Navigation (HTML): network-first, fallback to cached index
  if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok && fresh.status !== 206) {
            const cache = await caches.open(RUNTIME_CACHE);
            // Populate the fallback without delaying the network response.
            cache.put(request, fresh.clone()).catch(() => {
              /* ignore */
            });
          }
          return fresh;
        } catch (_) {
          // Fallback to cached index or cached navigation
          const cached = await caches.match(request, { cacheName: RUNTIME_CACHE });
          return (
            cached ||
            (await caches.match('./index.html', { cacheName: STATIC_CACHE })) ||
            new Response('Offline', { status: 503, statusText: 'Service Unavailable' })
          );
        }
      })(),
    );
    return;
  }

  // Same-origin static: cache-first with background update
  event.respondWith(
    (async () => {
      // Prefer the active generation for stable paths. If it misses, keep
      // searching retired caches so an intentionally non-reloaded tab can
      // still import its old Vite-hashed lazy chunks.
      const cached =
        (await caches.match(request, { cacheName: STATIC_CACHE })) ||
        (await caches.match(request, { cacheName: RUNTIME_CACHE })) ||
        (await caches.match(request));
      const fetchAndUpdate = (async () => {
        try {
          const response = await fetch(request);
          // Partial responses must never enter the static cache.
          if (response && response.status !== 206 && (response.ok || response.type === 'opaque')) {
            const cache = await caches.open(STATIC_CACHE);
            // Cache without surfacing a background-write rejection.
            cache.put(request, response.clone()).catch(() => {
              /* ignore */
            });
          }
          return response;
        } catch (_) {
          return null;
        }
      })();

      if (cached) {
        // Revalidate a cache hit in the background.
        event.waitUntil(fetchAndUpdate);
        return cached;
      }

      const fresh = await fetchAndUpdate;
      return fresh || new Response('Offline', { status: 503, statusText: 'Offline' });
    })(),
  );
});
