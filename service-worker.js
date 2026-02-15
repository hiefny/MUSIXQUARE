/* service-worker.js
 * MUSIXQUARE PWA Service Worker (App Shell Cache)
 * - Caches core static assets for faster loads + basic offline support
 * - Avoids caching large media downloads and dynamic endpoints
 */

'use strict';

// IMPORTANT: bump this when deploying changes to app shell assets
// so existing clients don't stay pinned to stale cached JS/CSS.
// NOTE: Bump this when app shell assets change.
// v7: minor robustness fixes (Tone.js load guards, theme storage guard, YouTube pause capture)
// v9: exclude large media (mp3/wav/..) from runtime caching + demo filename hardening
const CACHE_VERSION = "v16";
const STATIC_CACHE = `musixquare-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `musixquare-runtime-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/sync.worker.js',
  './js/transfer.worker.js',
  './favicon.svg',
  './manifest.webmanifest',
  './dummy_audio.mp3',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(APP_SHELL);
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

  // Never cache dynamic endpoints (app is fully self-contained)
  // Avoid caching large media downloads (demo media / user content)
  const path = url.pathname || '';

  // Always allow the tiny built-in dummy audio used for iOS/AudioContext keep-alive.
  // (If we block all .mp3, offline mode would fail even though it's in APP_SHELL.)
  if (path.endsWith('/dummy_audio.mp3') || path.endsWith('dummy_audio.mp3')) return true;

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
        return cached || caches.match('./index.html');
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
