/* service-worker.js
 * MUSIXQUARE PWA Service Worker (App Shell Cache)
 * - Caches core static assets for faster loads + basic offline support
 * - Avoids caching large media downloads and dynamic endpoints
 */

'use strict';

// IMPORTANT: bump this when deploying changes to app shell assets
// so existing clients don't stay pinned to stale cached JS/CSS.
const CACHE_VERSION = "v123";
const STATIC_CACHE = `musixquare-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `musixquare-runtime-${CACHE_VERSION}`;

// Only list assets that keep stable paths after Vite build.
// Vite-hashed assets (CSS, JS bundles, icons, fonts, manifest) are cached
// at runtime via the stale-while-revalidate fetch handler below.
const APP_SHELL = [
  "./",
  "./index.html",
  "./dummy_audio.mp3",
  "./icons/icon-512.png",
  "./favicon.ico",
  "./favicon.svg"
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);

    // cache.addAll() fails the *entire* install if any request fails.
    // That is desirable for core app shell assets, but NOT for optional
    // cross-origin assets (e.g., CDN webfonts) which may be blocked by
    // CSP / captive portals / in-app WebView policies.
    const core = [];
    const optional = [];

    for (const asset of APP_SHELL) {
      try {
        const url = new URL(asset, self.location.href);
        if (url.origin === self.location.origin) {
          // Font files are nice-to-have; don't fail SW install if they're missing.
          if (url.pathname.includes('/fonts/') || /\.(?:woff2?|ttf|otf)$/i.test(url.pathname)) {
            optional.push(asset);
          } else {
            core.push(asset);
          }
        } else {
          optional.push(asset);
        }
      } catch (_) {
        // Relative URLs like './' end up here in some browsers; treat as core.
        core.push(asset);
      }
    }

    // 1) Core app shell (same-origin): must succeed
    await cache.addAll(core);

    // 2) Optional (cross-origin): best-effort, never fail install
    await Promise.allSettled(optional.map(async (assetUrl) => {
      try {
        const req = new Request(assetUrl, { mode: 'no-cors' });
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          await cache.put(req, res);
        }
      } catch (_) {
        // ignore
      }
    }));
  })());
});

// Allow the page to trigger immediate activation after an update
self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('musixquare-') && ![STATIC_CACHE, RUNTIME_CACHE].includes(k))
        .map((k) => caches.delete(k))
    );
    self.clients.claim();
  })());
});

function isCacheableRequest(request) {
  if (request.method !== 'GET') return false;
  // Range 요청(Partial Content 206)은 Cache.put 지원이 제한적이라 캐싱하지 않음
  // (iOS/인앱 웹뷰에서 특히 자주 발생)
  if (request.headers && request.headers.has('range')) return false;
  const url = new URL(request.url);

  // Don't intercept cross-origin requests at all. Opaque responses
  // returned from the SW for cross-origin assets render as broken-image
  // icons on some WebView/Safari builds (launch-day report: YouTube
  // paste-preview thumbnail from i.ytimg.com working in dev — no SW —
  // but breaking in prod). We get no real cache-hit benefit for assets
  // that are already CDN-cached at origin, so just stay out of the way.
  if (url.origin !== self.location.origin) return false;

  // Never cache dynamic endpoints (app is fully self-contained)
  // Avoid caching large media downloads (demo media / user content)
  const path = url.pathname || '';

  // Never cache backend functions — they return per-request data (e.g.
  // TURN credentials). CacheStorage doesn't honour Cache-Control: no-store,
  // so the only safe move is to skip them entirely from the SW pipeline.
  if (path.startsWith('/api/')) return false;

  // Always allow the tiny built-in dummy audio used for iOS/AudioContext keep-alive.
  // (If we block all .mp3, offline mode would fail even though it's in APP_SHELL.)
  if (path.endsWith('dummy_audio.mp3')) return true;

  const ext = path.split('.').pop().toLowerCase();
  // NOTE: Range requests are already excluded above.
  // Exclude common audio/video containers to prevent storage bloat.
  if (['mp4', 'webm', 'mkv', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return false;

  return true;
}

// Network-first for navigations, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isCacheableRequest(request)) return;

  const url = new URL(request.url);

  // Navigation (HTML): network-first, fallback to cached index
  if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(RUNTIME_CACHE);
        // Cache in background (don't block response, avoid unhandled rejections)
        cache.put(request, fresh.clone()).catch(() => { /* ignore */ });
        return fresh;
      } catch (_) {
        // Fallback to cached index or cached navigation
        const cached = await caches.match(request);
        return cached || await caches.match('./index.html') || new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      }
    })());
    return;
  }

  // Same-origin static: cache-first with background update
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const fetchAndUpdate = (async () => {
      try {
        const response = await fetch(request);
        // Cache opaque + basic responses
        // NOTE: status 206(Partial Content)은 Cache.put에서 예외가 날 수 있으므로 제외
        if (response && response.status !== 206 && (response.ok || response.type === 'opaque')) {
          const cache = await caches.open(url.origin === self.location.origin ? STATIC_CACHE : RUNTIME_CACHE);
          // Cache in background (avoid unhandled rejections)
          cache.put(request, response.clone()).catch(() => { /* ignore */ });
        }
        return response;
      } catch (_) {
        return null;
      }
    })();

    if (cached) {
      // update in background
      event.waitUntil(fetchAndUpdate);
      return cached;
    }

    const fresh = await fetchAndUpdate;
    return fresh || new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
