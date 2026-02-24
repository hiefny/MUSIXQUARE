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
// v24: Android UI consistency fixes (doctype/typography/slider), paused-video UI fix, Host code toast
// v25: Invite code copy toast wording + fix stylesheet cache mismatch (remove ?v= param)
// v28: Portrait lock UX + mobile overscroll fix + media select icon bg + vBass routing fix
// v29: Remove portrait lock, tweak UI strings/layout, improve shuffle preload, and cache Pretendard webfont assets
// v40: Viewport fix finalized, debug overlay removed, desktop play area scroll+spacing
// v42: Slider thumbs updated, padding adjusted, proper progress tracking for demo media
// v44: SW install no longer fails when optional cross-origin assets (e.g., webfonts) are blocked
// v50: Mobile/PWA scrollbar contrast + scroll container ends above bottom nav
// v51: Remove bottom-nav drop shadow (light mode + base)
// v52: Add third-party license files + :has() fallbacks + small a11y/theme preflight fixes
// v55: Refine chat input area / drawer bottom positioning with safe-nav-bottom.
// v56: iOS PWA chat drawer safe-area fix (no peek strip + reduce bottom gap)
// v57: Responsive visualizer (160-320px), divider styling, layout centering fixes
// v58: Height-responsive visualizer (calc-based), nav-height fix, play controls spacing
// v59: Elastic scroll (contain), dotted help dividers, visualizer 512px calc
// v62: Update Demo Track info translation string
// v63: Refine Virtual Bass distortion translation (Higher = More Distortion)
// v64: Setup panel UI polish (surface-1 depth, remove border) + Firefox slider compatibility
// v65: Improve file transfer & preload logic (activation token, redundant clear-state guard, decode failure recovery)
// v88: Final cleanup: timers, memory, CSS dedup, dead code
// v89: Unified button styling (tint/glow), 'Reset' -> '초기화' (i18n), EQ value colors, YouTube preview cleanup
// v91: Adapt APP_SHELL for Vite build — CSS/fonts/icons are now hashed in /assets/
const CACHE_VERSION = "v91";
const STATIC_CACHE = `musixquare-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `musixquare-runtime-${CACHE_VERSION}`;

// Only list assets that keep stable paths after Vite build.
// Vite-hashed assets (CSS, JS bundles, icons, fonts, manifest) are cached
// at runtime via the stale-while-revalidate fetch handler below.
const APP_SHELL = [
  "./",
  "./index.html",
  "./vendor/Tone.js",
  "./vendor/Tone.js.LICENSE.txt",
  "./vendor/peerjs.min.js",
  "./vendor/peerjs.LICENSE.txt",
  "./dummy_audio.mp3",
  "./icons/icon-512.png"
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

  // Never cache dynamic endpoints (app is fully self-contained)
  // Avoid caching large media downloads (demo media / user content)
  const path = url.pathname || '';

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
