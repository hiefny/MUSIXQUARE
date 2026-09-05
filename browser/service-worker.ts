// MUSIXQUARE-authored file: AGPLv3 section 7 terms are in ADDITIONAL_TERMS.md; trademark use is addressed separately in TRADEMARKS.md.
/* service-worker.js
 * MUSIXQUARE PWA Service Worker (App Shell Cache)
 * - Caches core static assets for faster loads + basic offline support
 * - Avoids caching large media downloads and dynamic endpoints
 */

'use strict';

function isServiceWorkerScope(scope: WorkerGlobalScope): scope is ServiceWorkerGlobalScope {
  return 'clients' in scope && 'skipWaiting' in scope && 'registration' in scope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isClientMessageSource(
  source: Client | ServiceWorker | MessagePort | null,
): source is Client {
  return source !== null && 'id' in source && typeof source.id === 'string';
}

if (!isServiceWorkerScope(self)) {
  throw new Error('MUSIXQUARE_SERVICE_WORKER_SCOPE_REQUIRED');
}
const serviceWorker: ServiceWorkerGlobalScope = self;

// Bump this whenever a stable-path app-shell asset changes so existing clients
// migrate to a fresh cache.
const CACHE_VERSION = '__MUSIXQUARE_CACHE_VERSION__';
const STATIC_CACHE = `musixquare-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `musixquare-runtime-${CACHE_VERSION}`;
const OPTIONAL_CACHE = `musixquare-optional-${CACHE_VERSION}`;
const BOOTSTRAP_CACHE_KEY = `./bootstrap.js?cache=${CACHE_VERSION}`;
// iOS can resume a standalone app with a half-open radio path where fetch()
// neither succeeds nor rejects for a long time. A navigation must reach the
// active cached shell instead of leaving WebKit on its blank provisional page.
const NAVIGATION_NETWORK_TIMEOUT_MS = 3_000;
const NAVIGATION_STATE_CLIENT_LOOKUP_TIMEOUT_MS = 2_000;
const NAVIGATION_STATE_PATH_PREFIX = '/.mxqr-navigation-fallback/';
// The optional full font is useful after an interrupted reopen, but it must
// never keep a new worker in `installing` indefinitely on a half-open radio.
const OPTIONAL_ASSET_GROUP_TIMEOUT_MS = 6_000;
const OPTIONAL_CACHE_READY_KEY = `./.mxqr-optional-ready?cache=${CACHE_VERSION}`;
const CACHE_STATUS_REQUEST = 'MXQR_CACHE_STATUS_REQUEST';
const CACHE_CLIENT_STATUS = 'MXQR_CACHE_CLIENT_STATUS';
const CACHE_STATUS_PROBE = 'MXQR_CACHE_STATUS_PROBE';
const SW_GENERATION_REQUEST = 'MXQR_SW_GENERATION_REQUEST';
const SW_GENERATION_RESPONSE = 'MXQR_SW_GENERATION_RESPONSE';
const ACCOUNT_COMPLETION_PATH = '/account-complete.html';
const ACCOUNT_COMPLETION_SHELL = './account-complete.html';
const cacheReadyClientIds = new Set<string>();
const cacheStatusClientIds = new Set<string>();
const retainedCacheVersionsByClientId = new Map<string, string>();
const cachedNavigationClientIds = new Set<string>();

interface CacheMutationState {
  nextRequestSequence: number;
  latestNoStoreSequence: number;
  latestCommittedCacheSequence: number;
  activeTickets: number;
  pendingMutations: number;
  tail: Promise<void>;
}

interface CacheMutationTicket {
  readonly key: string;
  readonly sequence: number;
  readonly state: CacheMutationState;
  finished: boolean;
}

const cacheMutationStatesByUrl = new Map<string, CacheMutationState>();

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
const BUILD_ENTRY_ASSETS: readonly string[] = [
  /* __MUSIXQUARE_BUILD_ENTRY_ASSETS__ */
];

// Vite injects the lazy Pretendard CSS closure here. The canonical 2 MiB font
// is included in the same optional group, never in core APP_SHELL/addAll.
const OPTIONAL_PRIMARY_FONT_ASSETS: readonly string[] = [
  /* __MUSIXQUARE_OPTIONAL_PRIMARY_FONT_ASSETS__ */
];

const APP_SHELL = [
  './index.html',
  './account-complete.html',
  './account-complete.js',
  './account-complete.css',
  BOOTSTRAP_CACHE_KEY,
  './fouc-cleanup.js',
  './noscript.css',
  './wordmark-anim.js',
  './dummy_audio.mp3',
  './icons/icon-512.png',
  './favicon.ico',
  './favicon.svg',
  './manifest.webmanifest',
  './manifests/en.webmanifest',
  './manifests/ko.webmanifest',
  './manifests/ja.webmanifest',
  './manifests/zh-hans.webmanifest',
  './manifests/zh-hant.webmanifest',
  './manifests/es.webmanifest',
  './manifests/pt-br.webmanifest',
  './manifests/fr.webmanifest',
  './manifests/de.webmanifest',
  './manifests/nl.webmanifest',
  './manifests/it.webmanifest',
  './manifests/pl.webmanifest',
  './manifests/ru.webmanifest',
  './manifests/tr.webmanifest',
  './manifests/id.webmanifest',
  './manifests/vi.webmanifest',
  './manifests/th.webmanifest',
  './manifests/hi.webmanifest',
  './manifests/bn.webmanifest',
  './manifests/ta.webmanifest',
  './manifests/te.webmanifest',
  './manifests/ms.webmanifest',
  './manifests/fil.webmanifest',
  './manifests/ar.webmanifest',
  './manifests/ur.webmanifest',
  './manifests/he.webmanifest',
  './manifests/uk.webmanifest',
  './manifests/ro.webmanifest',
  './manifests/cs.webmanifest',
  './manifests/el.webmanifest',
  './manifests/fa.webmanifest',
  './manifests/mr.webmanifest',
  './manifests/gu.webmanifest',
  './manifests/kn.webmanifest',
  './manifests/ml.webmanifest',
  './manifests/pa.webmanifest',
  './manifests/sv.webmanifest',
  './manifests/da.webmanifest',
  './manifests/nb.webmanifest',
  './manifests/fi.webmanifest',
  './manifests/hu.webmanifest',
  './manifests/bg.webmanifest',
  ...BUILD_ENTRY_ASSETS,
];

serviceWorker.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);

      // APP_SHELL is a build-owned allowlist of public boot assets, not a
      // response-discovered runtime cache. Its atomic snapshot deliberately
      // survives the origin's no-store HTTP policy for index.html so an
      // installed generation can boot offline; dynamic responses still honor
      // no-store below before entering CacheStorage.
      await cache.addAll(APP_SHELL);

      // Font CSS + body are staged behind a readiness marker in their own
      // cache. Failure or timeout is non-fatal and leaves partial entries
      // invisible; the page-level font loader will retry after recovery.
      await stageOptionalPrimaryFontAssets();
    })(),
  );
});

async function stageOptionalPrimaryFontAssets(): Promise<void> {
  if (OPTIONAL_PRIMARY_FONT_ASSETS.length === 0) return;

  let expired = false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
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
    // Stream one response into CacheStorage at a time. The previous parallel
    // arrayBuffer staging held the full 2 MiB font plus the loader/CSS bodies
    // in JS memory during every install, amplifying WebKit CPU and memory use.
    // Partial entries stay invisible until the final readiness marker exists.
    for (const asset of OPTIONAL_PRIMARY_FONT_ASSETS) {
      const request = new Request(new URL(asset, serviceWorker.location.href));
      const response = controller
        ? await fetch(request, { signal: controller.signal })
        : await fetch(request);
      if (
        !response ||
        response.status === 206 ||
        !response.ok ||
        !responseAllowsCacheStorage(response)
      ) {
        if (response && !responseAllowsCacheStorage(response)) {
          // An installing worker does not control the origin yet. Clean only
          // its incomplete staging generation; mutating an older controller's
          // ready optional group would break live/offline tabs if install fails.
          await optionalCache.delete(request, { ignoreVary: true });
        }
        throw new Error(`OPTIONAL_ASSET_FETCH_FAILED:${request.url}`);
      }
      await optionalCache.put(request, response);
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

/** Honor an origin's explicit prohibition before writing into CacheStorage. */
function responseAllowsCacheStorage(response: Response): boolean {
  const cacheControl = response.headers.get('cache-control');
  if (!cacheControl) return true;

  return !cacheControl.split(',').some((rawDirective) => {
    const [rawName] = rawDirective.trim().split('=', 1);
    return rawName?.trim().toLowerCase() === 'no-store';
  });
}

// The page may opt into immediate activation after presenting its update UI.
serviceWorker.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (!isRecord(data)) return;

  if (data.type === SW_GENERATION_REQUEST) {
    if (typeof data.requestId !== 'string' || data.requestId.length > 128) return;
    try {
      event.source?.postMessage({
        type: SW_GENERATION_RESPONSE,
        requestId: data.requestId,
        cacheVersion: CACHE_VERSION,
      });
    } catch (_) {
      /* the requesting page disappeared before the version reply */
    }
    return;
  }

  if (data.type === 'SKIP_WAITING') {
    const activation = serviceWorker.skipWaiting();
    if (typeof event.waitUntil === 'function') event.waitUntil(activation);
    return;
  }

  if (data.type === CACHE_STATUS_PROBE) {
    const work = (async () => {
      const clientId = isClientMessageSource(event.source) ? event.source.id : '';
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
      await scrubOrphanedCachedNavigationStates(clientId);
    })();
    if (typeof event.waitUntil === 'function') event.waitUntil(work);
    return;
  }

  if (data.type !== CACHE_CLIENT_STATUS || data.cacheVersion !== CACHE_VERSION) {
    return;
  }

  const clientId = isClientMessageSource(event.source) ? event.source.id : '';
  if (!clientId) return;
  cacheStatusClientIds.add(clientId);
  if (data.ready === true) {
    cacheReadyClientIds.add(clientId);
    retainedCacheVersionsByClientId.delete(clientId);
  } else {
    cacheReadyClientIds.delete(clientId);
    if (
      typeof data.pageCacheVersion === 'string' &&
      /^v[1-9]\d*$/.test(data.pageCacheVersion) &&
      data.pageCacheVersion !== CACHE_VERSION
    ) {
      retainedCacheVersionsByClientId.set(clientId, data.pageCacheVersion);
    } else {
      retainedCacheVersionsByClientId.delete(clientId);
    }
  }
  const repliesToRequest = data.replyToRequest === true;

  const work = (async () => {
    const retired = await retireOldCachesIfSafe();
    // A proactive status from a freshly loaded page also recovers the
    // handshake after the service worker was suspended and lost its in-memory
    // ready set. Query every remaining client once; replies are marked so they
    // do not trigger another broadcast loop.
    if (!retired && !repliesToRequest) {
      await requestClientCacheStatuses();
    }
  })();
  if (typeof event.waitUntil === 'function') event.waitUntil(work);
});

async function getWindowClients(): Promise<readonly Client[]> {
  if (!serviceWorker.clients || typeof serviceWorker.clients.matchAll !== 'function') return [];
  return serviceWorker.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

function cacheVersionFromName(cacheName: string): string | null {
  return /^musixquare-(?:static|runtime|optional)-(v[1-9]\d*)$/.exec(cacheName)?.[1] || null; // brand-capitalization: allow-technical
}

async function deleteRetiredCaches(
  preservedVersions: ReadonlySet<string> = new Set(),
): Promise<void> {
  const keys = await caches.keys();
  const currentEpoch = cacheVersionEpoch(CACHE_VERSION);
  await Promise.all(
    keys
      .filter((key) => {
        const keyVersion = cacheVersionFromName(key);
        const identity = ownedCacheIdentity(key);
        // A controlling worker must never mutate a newer generation that is
        // installing or waiting in the same origin-wide CacheStorage.
        if (identity && (currentEpoch === null || identity.epoch > currentEpoch)) return false;
        return (
          key.startsWith('musixquare-') && // brand-capitalization: allow-technical
          ![STATIC_CACHE, RUNTIME_CACHE, OPTIONAL_CACHE].includes(key) &&
          (!keyVersion || !preservedVersions.has(keyVersion))
        );
      })
      .map((key) => caches.delete(key)),
  );
}

function cachedNavigationStateRequest(clientId: string): Request {
  const encodedClientId = encodeURIComponent(String(clientId));
  return new Request(
    new URL(`${NAVIGATION_STATE_PATH_PREFIX}${encodedClientId}`, serviceWorker.location.origin),
  );
}

async function recordCachedNavigationState(clientId: string): Promise<void> {
  if (!clientId) return;
  // Set memory first so an immediate page probe cannot race CacheStorage.
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

async function readCachedNavigationState(clientId: string): Promise<boolean> {
  if (!clientId) return false;
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

function cachedNavigationStateClientId(request: Request): string | null {
  try {
    const url = new URL(request.url);
    if (
      url.origin !== serviceWorker.location.origin ||
      !url.pathname.startsWith(NAVIGATION_STATE_PATH_PREFIX)
    ) {
      return null;
    }
    const encodedClientId = url.pathname.slice(NAVIGATION_STATE_PATH_PREFIX.length);
    if (!encodedClientId || encodedClientId.includes('/') || url.search) return null;
    return decodeURIComponent(encodedClientId) || null;
  } catch (_) {
    return null;
  }
}

async function lookupNavigationClient(clientId: string): Promise<Client | null | undefined> {
  if (!serviceWorker.clients || typeof serviceWorker.clients.get !== 'function') return null;
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      serviceWorker.clients.get(clientId),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), NAVIGATION_STATE_CLIENT_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function scrubOrphanedCachedNavigationStates(protectedClientId: string): Promise<void> {
  let cache: Cache;
  let requests: readonly Request[];
  try {
    cache = await caches.open(RUNTIME_CACHE);
    requests = await cache.keys();
  } catch (_) {
    return;
  }

  await Promise.all(
    requests.map(async (request) => {
      const clientId = cachedNavigationStateClientId(request);
      if (!clientId || clientId === protectedClientId) return;
      const client = await lookupNavigationClient(clientId);
      // null means the lookup was unavailable, rejected, or timed out. Preserve
      // the marker and retry on a later probe; only undefined proves an orphan.
      if (client !== undefined) {
        if (client) cachedNavigationClientIds.add(clientId);
        return;
      }
      try {
        const deleted = await cache.delete(request);
        if (!deleted) return;
        cachedNavigationClientIds.delete(clientId);
      } catch (_) {
        // A failed delete is fail-closed: retain in-memory state for a retry.
      }
    }),
  );
}

async function scrubSensitiveRetiredRuntimeEntries(): Promise<void> {
  const keys = await caches.keys();
  const currentEpoch = cacheVersionEpoch(CACHE_VERSION);
  await Promise.all(
    keys
      .filter((key) => {
        if (
          !key.startsWith('musixquare-runtime-') || // brand-capitalization: allow-technical
          key === RUNTIME_CACHE
        ) {
          return false;
        }
        const identity = ownedCacheIdentity(key);
        return !identity || (currentEpoch !== null && identity.epoch < currentEpoch);
      })
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

async function retireOldCachesIfSafe(): Promise<boolean> {
  const clients = await getWindowClients();
  const liveClientIds = new Set<string>();
  for (const client of clients) {
    if (client.id) liveClientIds.add(client.id);
  }
  for (const clientId of cacheReadyClientIds) {
    if (!liveClientIds.has(clientId)) cacheReadyClientIds.delete(clientId);
  }
  for (const clientId of cacheStatusClientIds) {
    if (!liveClientIds.has(clientId)) cacheStatusClientIds.delete(clientId);
  }
  for (const clientId of retainedCacheVersionsByClientId.keys()) {
    if (!liveClientIds.has(clientId)) retainedCacheVersionsByClientId.delete(clientId);
  }

  if (clients.length > 0) {
    const allClientsReported = clients.every((client) => cacheStatusClientIds.has(client.id));
    if (!allClientsReported) return false;

    const hasUnknownRetainedGeneration = clients.some(
      (client) =>
        !cacheReadyClientIds.has(client.id) && !retainedCacheVersionsByClientId.has(client.id),
    );
    if (hasUnknownRetainedGeneration) return false;
  }

  await deleteRetiredCaches(new Set(retainedCacheVersionsByClientId.values()));
  return true;
}

async function requestClientCacheStatuses(clients?: readonly Client[]): Promise<void> {
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

serviceWorker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Claim first so each existing tab can compare the active controller
      // with the controller under which its current JS was loaded.
      await serviceWorker.clients.claim();
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

function isCacheableRequest(request: Request): boolean {
  if (request.method !== 'GET') return false;

  // Callers use Request.cache=no-store for private/capability-backed media
  // whose URL shape is not guaranteed to live under /api/ or carry a media
  // extension. Bypass the Service Worker entirely so neither an incumbent
  // CacheStorage body nor a new write can weaken that freshness contract.
  if (request.cache === 'no-store') return false;

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
  if (url.origin !== serviceWorker.location.origin) return false;

  const path = url.pathname || '';

  // Never cache backend functions — they return per-request data (e.g.
  // TURN credentials). CacheStorage doesn't honour Cache-Control: no-store,
  // so the only safe move is to skip them entirely from the SW pipeline.
  if (path.startsWith('/api/')) return false;

  // Keep the tiny iOS AudioContext primer available offline despite the media
  // extension exclusion below.
  if (isCanonicalAudioPrimerUrl(url)) return true;

  const ext = path.split('.').pop()?.toLowerCase() ?? '';
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

function isCanonicalAudioPrimerUrl(url: URL): boolean {
  return (
    url.origin === serviceWorker.location.origin &&
    url.pathname === '/dummy_audio.mp3' &&
    url.search === ''
  );
}

function isAudioPrimerRangeRequest(request: Request): boolean {
  return (
    request.method === 'GET' &&
    request.headers &&
    request.headers.has('range') &&
    isCanonicalAudioPrimerUrl(new URL(request.url))
  );
}

function primerRangeHeaders(sourceHeaders: Headers, contentLength: number): Headers {
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

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

function parseSingleByteRange(
  value: string | null | undefined,
  totalLength: number,
): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(String(value || '').trim());
  if (!match || totalLength <= 0) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return null;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, totalLength - suffixLength),
      end: totalLength - 1,
    };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : totalLength - 1;
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

async function serveAudioPrimerRange(request: Request): Promise<Response> {
  let cached: Response | null | undefined;
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

  let fullBody: ArrayBuffer;
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

function isRoomNavigation(request: Request): boolean {
  const url = new URL(request.url);
  return url.origin === serviceWorker.location.origin && /^\/\d{6}\/?$/u.test(url.pathname);
}

function hasSensitiveNavigationQuery(request: Request): boolean {
  const url = new URL(request.url);
  if (url.origin !== serviceWorker.location.origin) return false;

  for (const parameter of url.searchParams.keys()) {
    if (SENSITIVE_NAVIGATION_QUERY_PARAMETER.test(parameter)) return true;
  }
  return false;
}

function canonicalNavigationShell(request: Request): string {
  const url = new URL(request.url);
  return url.origin === serviceWorker.location.origin && url.pathname === ACCOUNT_COMPLETION_PATH
    ? ACCOUNT_COMPLETION_SHELL
    : './index.html';
}

function isImmutableHashedAsset(request: Request): boolean {
  const url = new URL(request.url);
  if (url.origin !== serviceWorker.location.origin || !url.pathname.startsWith('/assets/')) {
    return false;
  }

  // Vite content hashes are eight URL-safe characters. Require the final
  // filename segment so stable files under /assets keep revalidation.
  return /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(url.pathname);
}

function isOptionalPrimaryFontAsset(request: Request): boolean {
  const requestUrl = new URL(request.url);
  return OPTIONAL_PRIMARY_FONT_ASSETS.some((asset) => {
    try {
      return new URL(asset, serviceWorker.location.href).href === requestUrl.href;
    } catch (_) {
      return false;
    }
  });
}

async function matchActiveOptionalAsset(request: Request): Promise<Response | null> {
  if (!isOptionalPrimaryFontAsset(request)) return null;
  try {
    const ready = await caches.match(OPTIONAL_CACHE_READY_KEY, { cacheName: OPTIONAL_CACHE });
    if (!ready) return null;
    return (await caches.match(request, { cacheName: OPTIONAL_CACHE })) || null;
  } catch (_) {
    return null;
  }
}

async function matchRetiredAsset(request: Request): Promise<Response | null> {
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
    const currentMatch = /^v(\d+)$/.exec(CACHE_VERSION);
    if (!currentMatch) return null;
    const currentEpoch = Number(currentMatch[1]);
    const keys = await caches.keys();
    for (const key of keys) {
      const retiredMatch = /^musixquare-(?:static|runtime)-v(\d+)$/.exec(key); // brand-capitalization: allow-technical
      if (!retiredMatch || Number(retiredMatch[1]) >= currentEpoch) continue;
      const cached = await caches.match(request, { cacheName: key });
      if (cached) return cached;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function beginCacheMutation(request: Request): CacheMutationTicket {
  const url = new URL(request.url);
  url.hash = '';
  const key = `GET ${url.href}`;
  let state = cacheMutationStatesByUrl.get(key);
  if (!state) {
    state = {
      nextRequestSequence: 1,
      latestNoStoreSequence: 0,
      latestCommittedCacheSequence: 0,
      activeTickets: 0,
      pendingMutations: 0,
      tail: Promise.resolve(),
    };
    cacheMutationStatesByUrl.set(key, state);
  }
  const ticket: CacheMutationTicket = {
    key,
    sequence: state.nextRequestSequence,
    state,
    finished: false,
  };
  state.nextRequestSequence += 1;
  state.activeTickets += 1;
  return ticket;
}

function queueCacheMutation(
  ticket: CacheMutationTicket,
  mutation: () => Promise<void>,
): Promise<void> {
  let mutationResult: Promise<void>;
  if (ticket.state.pendingMutations === 0) {
    // Preserve the existing eager first-write behavior: invoking an async
    // mutation directly lets CacheStorage.open() start before the page begins
    // consuming the returned response. Later mutations still join the lane.
    try {
      mutationResult = mutation();
    } catch (error) {
      mutationResult = Promise.reject(error);
    }
  } else {
    mutationResult = ticket.state.tail.then(mutation);
  }
  ticket.state.pendingMutations += 1;
  // A failed best-effort cache operation must not poison later mutations for
  // this URL. The caller still observes the original result at its existing
  // error boundary, while subsequent work follows a fulfilled lane tail.
  ticket.state.tail = mutationResult
    .catch(() => undefined)
    .then(() => {
      ticket.state.pendingMutations = Math.max(0, ticket.state.pendingMutations - 1);
    });
  return mutationResult;
}

function finishCacheMutation(ticket: CacheMutationTicket): void {
  if (ticket.finished) return;
  ticket.finished = true;
  ticket.state.activeTickets = Math.max(0, ticket.state.activeTickets - 1);
  if (ticket.state.activeTickets !== 0) return;

  const settledTail = ticket.state.tail;
  void settledTail.then(
    () => {
      if (
        ticket.state.activeTickets === 0 &&
        ticket.state.tail === settledTail &&
        cacheMutationStatesByUrl.get(ticket.key) === ticket.state
      ) {
        cacheMutationStatesByUrl.delete(ticket.key);
      }
    },
    () => undefined,
  );
}

async function cacheResponse(
  cacheName: string,
  request: Request,
  response: Response,
  ticket: CacheMutationTicket,
): Promise<void> {
  try {
    const allowsStorage = responseAllowsCacheStorage(response);
    // Clone before the first await. The response may be returned to and
    // consumed by the page while CacheStorage.open() is still pending.
    const cacheCopy = allowsStorage ? response.clone() : null;
    if (!allowsStorage) {
      ticket.state.latestNoStoreSequence = Math.max(
        ticket.state.latestNoStoreSequence,
        ticket.sequence,
      );
    }
    await queueCacheMutation(ticket, async () => {
      if (!allowsStorage) {
        // A newer request may already have committed a cacheable replacement
        // while this older no-store response was still in flight. Preserve
        // request order: the older revocation must not delete newer state.
        // Failed cache puts never advance this fence, so no-store remains the
        // fail-closed winner when the newer response was not persisted.
        if (ticket.sequence < ticket.state.latestCommittedCacheSequence) return;
        // A URL can change from cacheable to no-store without changing its
        // identity. Retire the prior body so cache-first assets and offline
        // navigation fallback cannot keep exposing the superseded response.
        await deleteCachedResponseEverywhere(cacheName, request);
        return;
      }
      // A later request for this URL has already observed a revoking no-store
      // response. An older response that arrived late must not resurrect it.
      if (
        ticket.sequence <= ticket.state.latestNoStoreSequence ||
        ticket.sequence < ticket.state.latestCommittedCacheSequence
      )
        return;
      const cache = await caches.open(cacheName);
      await cache.put(request, cacheCopy!);
      ticket.state.latestCommittedCacheSequence = Math.max(
        ticket.state.latestCommittedCacheSequence,
        ticket.sequence,
      );
    });
  } catch (_) {
    // Cache writes are best-effort, but the promise is still kept alive by
    // the fetch event so a successful write cannot be abandoned mid-flight.
  }
}

async function updateCacheFromNetworkResponse(
  cacheName: string,
  request: Request,
  response: Response | null,
  ticket: CacheMutationTicket,
): Promise<void> {
  try {
    // Partial responses must never replace a complete cached body.
    if (!response || response.status === 206) return;

    // A denial/removal response can carry no-store as the origin revokes a URL.
    // Purge the former body before the normal success/cacheability gate so a
    // cached 200 cannot survive a fresh 401/404/410 response.
    if (!responseAllowsCacheStorage(response)) {
      await cacheResponse(cacheName, request, response, ticket);
      return;
    }

    if (!response.ok && response.type !== 'opaque') return;
    await cacheResponse(cacheName, request, response, ticket);
  } finally {
    finishCacheMutation(ticket);
  }
}

function scheduleNetworkCacheUpdate(
  cacheName: string,
  request: Request,
  networkResponse: Promise<Response | null>,
): Promise<void> {
  // Reserve the sequence synchronously, before the network settles, so a late
  // response from an older request cannot be mistaken for newer cache state.
  const ticket = beginCacheMutation(request);
  return networkResponse.then(
    (response) => updateCacheFromNetworkResponse(cacheName, request, response, ticket),
    () => updateCacheFromNetworkResponse(cacheName, request, null, ticket),
  );
}

async function deleteCachedResponseEverywhere(
  primaryCacheName: string,
  request: Request,
): Promise<void> {
  let knownCacheNames: string[] = [];
  try {
    knownCacheNames = await caches.keys();
  } catch (_) {
    // Still attempt the active cache below.
  }

  const primaryFamily = ownedCacheFamily(primaryCacheName);
  if (!primaryFamily) return;
  const currentEpoch = cacheVersionEpoch(CACHE_VERSION);
  if (currentEpoch === null) return;

  const installOwned = isInstallOwnedAppShellRequest(request);
  const optionalAsset = isOptionalPrimaryFontAsset(request);
  const families = new Set<'static' | 'runtime' | 'optional'>(
    installOwned
      ? ['runtime']
      : primaryFamily === 'optional' || optionalAsset
        ? ['static', 'runtime', 'optional']
        : ['static', 'runtime'],
  );
  const currentCacheNames = [STATIC_CACHE, RUNTIME_CACHE, OPTIONAL_CACHE];
  const cacheNames = new Set(
    [...currentCacheNames, ...knownCacheNames].filter((cacheName) => {
      const identity = ownedCacheIdentity(cacheName);
      return identity !== null && identity.epoch <= currentEpoch && families.has(identity.family);
    }),
  );
  await Promise.all(
    [...cacheNames].map(async (cacheName) => {
      try {
        const cache = await caches.open(cacheName);
        // A revocation applies to every stored Vary variant of this URL, not
        // only the request headers that happened to receive the no-store reply.
        await cache.delete(request, { ignoreVary: true });
        if (primaryFamily === 'optional' || optionalAsset) {
          const readyKey = optionalCacheReadyKey(cacheName);
          if (readyKey) await cache.delete(readyKey);
        }
      } catch (_) {
        // Try every generation even if one retired cache is unavailable.
      }
    }),
  );
}

type OwnedCacheFamily = 'static' | 'runtime' | 'optional';

function cacheVersionEpoch(version: string): number | null {
  const match = /^v(\d+)$/u.exec(version);
  if (!match) return null;
  const epoch = Number(match[1]);
  return Number.isSafeInteger(epoch) ? epoch : null;
}

function ownedCacheIdentity(cacheName: string): { family: OwnedCacheFamily; epoch: number } | null {
  const match = /^musixquare-(static|runtime|optional)-(v\d+)$/u.exec(cacheName); // brand-capitalization: allow-technical
  if (!match) return null;
  const epoch = cacheVersionEpoch(match[2]!);
  if (epoch === null) return null;
  return { family: match[1] as OwnedCacheFamily, epoch };
}

function ownedCacheFamily(cacheName: string): OwnedCacheFamily | null {
  return ownedCacheIdentity(cacheName)?.family ?? null;
}

function optionalCacheReadyKey(cacheName: string): string | null {
  const match = /^musixquare-optional-(v\d+)$/u.exec(cacheName); // brand-capitalization: allow-technical
  return match ? `./.mxqr-optional-ready?cache=${match[1]}` : null;
}

function isInstallOwnedAppShellRequest(request: Request): boolean {
  const requestUrl = new URL(request.url).href;
  return APP_SHELL.some((asset) => {
    try {
      return new URL(asset, serviceWorker.location.href).href === requestUrl;
    } catch (_) {
      return false;
    }
  });
}

function fetchNavigationWithTimeout(request: Request): Promise<Response> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timeoutId: number | undefined;
  let removeRequestAbortListener: () => void = () => undefined;

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

  const timeout = new Promise<never>((_resolve, reject) => {
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

async function matchActiveNavigationShell(request: Request): Promise<Response | null> {
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

function markCachedNavigationResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Musixquare-Navigation-Source', 'cache-fallback');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function matchActiveStaticAsset(request: Request): Promise<Response | null> {
  try {
    return (
      (await caches.match(request, { cacheName: STATIC_CACHE })) ||
      (await caches.match(request, { cacheName: RUNTIME_CACHE })) ||
      (await matchActiveOptionalAsset(request)) ||
      null
    );
  } catch (_) {
    // A browser can deny CacheStorage after this worker was installed. Keep
    // public static assets reachable through the ordinary network fallback.
    return null;
  }
}

// Network-first for navigations, cache-first for static assets
serviceWorker.addEventListener('fetch', (event) => {
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
        : scheduleNetworkCacheUpdate(RUNTIME_CACHE, request, networkResponse);

    // Register background work while the fetch event is still dispatching.
    // Calling waitUntil only after an awaited cache/network lookup is not
    // portable, and leaving Cache.put unchained lets the worker be suspended
    // before the offline fallback is actually written.
    const navigationStateUpdate = networkResponse.then(
      () => undefined,
      async () => {
        const fallback = await cachedShell;
        const resultingClientId = event.resultingClientId;
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
    const cachedResponse = matchActiveStaticAsset(request);
    const networkResponse = cachedResponse.then((cached) => {
      if (cached) return null;
      return fetch(request).catch(() => null);
    });
    const cacheUpdate = scheduleNetworkCacheUpdate(STATIC_CACHE, request, networkResponse);
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
      return (await matchActiveStaticAsset(request)) || (await matchRetiredAsset(request)) || null;
    })();
    const networkResponse = cachedResponse.then((cached) => {
      if (cached) return null;
      return fetch(request).catch(() => null);
    });
    const cacheUpdate = scheduleNetworkCacheUpdate(STATIC_CACHE, request, networkResponse);
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
  const cacheUpdate = scheduleNetworkCacheUpdate(STATIC_CACHE, request, networkResponse);
  event.waitUntil(cacheUpdate);
  event.respondWith(
    (async () => {
      const activeCached = await matchActiveStaticAsset(request);

      if (activeCached) return activeCached;

      const fresh = await networkResponse;
      if (fresh) return fresh;

      // A live tab that deliberately deferred reload may still need a stable
      // asset from its retired generation while truly offline. The helper
      // restricts lookup to owned generations older than this worker.
      return (
        (await matchRetiredAsset(request)) ||
        new Response('Offline', { status: 503, statusText: 'Offline' })
      );
    })(),
  );
});
