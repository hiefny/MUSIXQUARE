/* service-worker.js
 * MUSIXQUARE PWA Service Worker (App Shell Cache)
 * - Caches core static assets for faster loads + basic offline support
 * - Avoids caching large media downloads and dynamic endpoints
 */

'use strict';

// IMPORTANT: bump this when deploying changes to app shell assets
// so existing clients don't stay pinned to stale cached JS/CSS.
const CACHE_VERSION = "v130";
const STATIC_CACHE = `musixquare-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `musixquare-runtime-${CACHE_VERSION}`;

const REMOTE_MEDIA_PROTOCOL_VERSION = 1;
const REMOTE_MEDIA_ROUTE = '/__mxqr_media/';
const REMOTE_MEDIA_CHUNK_BYTES = 8 * 1024 * 1024;
const REMOTE_MEDIA_TAG_BYTES = 16;
const REMOTE_MEDIA_RESOLVE_TIMEOUT_MS = 3_000;
const REMOTE_MEDIA_AAD_MAGIC = 0x4d585132; // "MXQ2"
const remoteMediaSessions = new Map();
const remoteMediaPending = new Map();
const remoteMediaResolutions = new Map();
const remoteMediaOwners = new Map();

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

class RemoteMediaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isSafePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function asNoncePrefix(value) {
  let bytes;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    return null;
  }
  if (bytes.byteLength !== 8) return null;
  const copy = new Uint8Array(8);
  copy.set(bytes);
  return copy;
}

function validateRemoteMediaDownloadUrl(value, roomId, objectId) {
  if (
    typeof value !== 'string' ||
    typeof roomId !== 'string' ||
    roomId.length < 1 ||
    roomId.length > 128 ||
    typeof objectId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(objectId)
  ) {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return null;
  }
  const localHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.hash) {
    return null;
  }
  const workerPath = `/download/${encodeURIComponent(roomId)}/${encodeURIComponent(objectId)}`;
  if (url.pathname === workerPath) return url.toString();
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.r2.cloudflarestorage.com')) {
    return null;
  }
  let segments;
  try {
    segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch (_) {
    return null;
  }
  return segments.includes(roomId) && segments.includes(objectId) ? url.toString() : null;
}

function validateRemoteMediaSession(raw, ownerClientId, opaqueId) {
  if (!raw || typeof raw !== 'object') return null;
  const key = raw.key;
  const algorithmName = key && key.algorithm && key.algorithm.name;
  const usages = key && key.usages;
  if (
    !key ||
    key.type !== 'secret' ||
    key.extractable !== false ||
    algorithmName !== 'AES-GCM' ||
    key.algorithm.length !== 256 ||
    !usages ||
    Array.from(usages).length !== 1 ||
    !Array.from(usages).includes('decrypt')
  ) {
    return null;
  }
  const noncePrefix = asNoncePrefix(raw.noncePrefix);
  if (!noncePrefix) return null;
  if (
    !isSafePositiveInteger(raw.plainSize) ||
    !isSafePositiveInteger(raw.encryptedSize) ||
    raw.chunkSize !== REMOTE_MEDIA_CHUNK_BYTES ||
    !isSafePositiveInteger(raw.chunkCount) ||
    raw.chunkCount > 10_000 ||
    raw.tagBytes !== REMOTE_MEDIA_TAG_BYTES ||
    raw.chunkCount !== Math.ceil(raw.plainSize / raw.chunkSize) ||
    raw.encryptedSize !== raw.plainSize + raw.chunkCount * raw.tagBytes
  ) {
    noncePrefix.fill(0);
    return null;
  }
  const downloadUrl = validateRemoteMediaDownloadUrl(raw.downloadUrl, raw.roomId, raw.objectId);
  if (!downloadUrl) {
    noncePrefix.fill(0);
    return null;
  }
  const rawMime = typeof raw.mime === 'string' ? raw.mime.trim() : '';
  const mime =
    rawMime.length <= 200 && /^audio\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(rawMime)
      ? rawMime.toLowerCase()
      : 'application/octet-stream';
  return {
    opaqueId,
    ownerClientId,
    key,
    noncePrefix,
    downloadUrl,
    roomId: raw.roomId,
    objectId: raw.objectId,
    plainSize: raw.plainSize,
    encryptedSize: raw.encryptedSize,
    chunkSize: raw.chunkSize,
    chunkCount: raw.chunkCount,
    tagBytes: raw.tagBytes,
    mime,
    activeControllers: new Set(),
  };
}

function settleRemoteMediaPending(requestId, action, value) {
  const pending = remoteMediaPending.get(requestId);
  if (!pending) return;
  remoteMediaPending.delete(requestId);
  remoteMediaResolutions.delete(pending.resolutionKey);
  clearTimeout(pending.timeoutId);
  if (
    action === 'reject' &&
    !remoteMediaSessions.has(pending.opaqueId) &&
    remoteMediaOwners.get(pending.opaqueId) === pending.clientId
  ) {
    remoteMediaOwners.delete(pending.opaqueId);
  }
  pending[action](value);
}

function handleRemoteMediaSessionMessage(event) {
  const data = event && event.data;
  if (
    !data ||
    data.type !== 'MXQR_REMOTE_MEDIA_SESSION' ||
    data.protocolVersion !== REMOTE_MEDIA_PROTOCOL_VERSION ||
    typeof data.requestId !== 'string' ||
    typeof data.opaqueId !== 'string'
  ) {
    return;
  }
  const pending = remoteMediaPending.get(data.requestId);
  const sourceClientId = event.source && event.source.id;
  if (
    !pending ||
    sourceClientId !== pending.clientId ||
    data.opaqueId !== pending.opaqueId
  ) {
    return;
  }
  const session = validateRemoteMediaSession(data.session, pending.clientId, pending.opaqueId);
  if (!session) {
    settleRemoteMediaPending(
      data.requestId,
      'reject',
      new RemoteMediaError(503, 'REMOTE_MEDIA_SESSION_INVALID'),
    );
    return;
  }
  remoteMediaOwners.set(pending.opaqueId, pending.clientId);
  remoteMediaSessions.set(pending.opaqueId, session);
  settleRemoteMediaPending(data.requestId, 'resolve', session);
}

function releaseRemoteMediaSession(opaqueId, ownerClientId) {
  if (remoteMediaOwners.get(opaqueId) !== ownerClientId) return;
  remoteMediaOwners.delete(opaqueId);
  const session = remoteMediaSessions.get(opaqueId);
  if (session && session.ownerClientId === ownerClientId) {
    remoteMediaSessions.delete(opaqueId);
    for (const controller of session.activeControllers) {
      controller.abort(new Error('REMOTE_MEDIA_RELEASED'));
    }
    session.activeControllers.clear();
    session.noncePrefix.fill(0);
  }
  for (const [requestId, pending] of remoteMediaPending) {
    if (pending.opaqueId === opaqueId && pending.clientId === ownerClientId) {
      settleRemoteMediaPending(
        requestId,
        'reject',
        new RemoteMediaError(503, 'REMOTE_MEDIA_RELEASED'),
      );
    }
  }
}

// Allow the page to trigger immediate activation and handle the ephemeral
// page <-> worker key-vault protocol.
self.addEventListener('message', (event) => {
  const data = event && event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (
    data.type === 'MXQR_REMOTE_MEDIA_PING' &&
    data.protocolVersion === REMOTE_MEDIA_PROTOCOL_VERSION
  ) {
    const port = event.ports && event.ports[0];
    if (port) {
      port.postMessage({
        type: 'MXQR_REMOTE_MEDIA_PONG',
        protocolVersion: REMOTE_MEDIA_PROTOCOL_VERSION,
      });
    }
    return;
  }
  if (data.type === 'MXQR_REMOTE_MEDIA_SESSION') {
    handleRemoteMediaSessionMessage(event);
    return;
  }
  if (
    data.type === 'MXQR_REMOTE_MEDIA_RELEASE' &&
    data.protocolVersion === REMOTE_MEDIA_PROTOCOL_VERSION &&
    typeof data.opaqueId === 'string'
  ) {
    const sourceClientId = event.source && event.source.id;
    if (sourceClientId) releaseRemoteMediaSession(data.opaqueId, sourceClientId);
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

function parseRemoteMediaPath(url) {
  if (url.origin !== self.location.origin || !url.pathname.startsWith(REMOTE_MEDIA_ROUTE)) {
    return null;
  }
  const tail = url.pathname.slice(REMOTE_MEDIA_ROUTE.length);
  const slash = tail.indexOf('/');
  if (slash <= 0 || tail.indexOf('/', slash + 1) !== -1) return false;
  const opaqueId = tail.slice(0, slash);
  const encodedName = tail.slice(slash + 1);
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(opaqueId) || !encodedName) return false;
  try {
    const fileName = decodeURIComponent(encodedName);
    if (!fileName || /[\u0000-\u001f\u007f/\\]/.test(fileName)) return false;
  } catch (_) {
    return false;
  }
  return opaqueId;
}

function remoteMediaHeaders(session, selection) {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Length': String(selection.end - selection.start + 1),
    'Content-Type': session.mime,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  if (selection.status === 206) {
    headers.set(
      'Content-Range',
      `bytes ${selection.start}-${selection.end}/${session.plainSize}`,
    );
  }
  return headers;
}

function remoteMediaErrorResponse(status, plainSize, message) {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  if (status === 416 && isSafePositiveInteger(plainSize)) {
    headers.set('Content-Range', `bytes */${plainSize}`);
  }
  if (status === 405) headers.set('Allow', 'GET, HEAD');
  return new Response(message, { status, headers });
}

function parseRemoteMediaRange(value, size) {
  if (value === null) return { status: 200, start: 0, end: size - 1 };
  if (value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { status: 206, start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;
  if (!match[2]) return { status: 206, start, end: size - 1 };
  const requestedEnd = Number(match[2]);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  return { status: 206, start, end: Math.min(requestedEnd, size - 1) };
}

function remoteMediaRequestId() {
  if (self.crypto && typeof self.crypto.randomUUID === 'function') {
    return self.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  self.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function resolveRemoteMediaSession(opaqueId, clientId) {
  const ownerClientId = remoteMediaOwners.get(opaqueId);
  if (ownerClientId && ownerClientId !== clientId) {
    throw new RemoteMediaError(403, 'REMOTE_MEDIA_CLIENT_FORBIDDEN');
  }
  const cached = remoteMediaSessions.get(opaqueId);
  if (cached) {
    if (cached.ownerClientId !== clientId) {
      throw new RemoteMediaError(403, 'REMOTE_MEDIA_CLIENT_FORBIDDEN');
    }
    return cached;
  }

  const resolutionKey = `${clientId}:${opaqueId}`;
  const existing = remoteMediaResolutions.get(resolutionKey);
  if (existing) return existing;
  remoteMediaOwners.set(opaqueId, clientId);
  const promise = new Promise((resolve, reject) => {
    const requestId = remoteMediaRequestId();
    const timeoutId = setTimeout(() => {
      settleRemoteMediaPending(
        requestId,
        'reject',
        new RemoteMediaError(503, 'REMOTE_MEDIA_SESSION_TIMEOUT'),
      );
    }, REMOTE_MEDIA_RESOLVE_TIMEOUT_MS);
    remoteMediaPending.set(requestId, {
      requestId,
      opaqueId,
      clientId,
      resolutionKey,
      timeoutId,
      resolve,
      reject,
    });
    self.clients
      .get(clientId)
      .then((client) => {
        if (!client) {
          settleRemoteMediaPending(
            requestId,
            'reject',
            new RemoteMediaError(503, 'REMOTE_MEDIA_CLIENT_MISSING'),
          );
          return;
        }
        client.postMessage({
          type: 'MXQR_REMOTE_MEDIA_RESOLVE',
          protocolVersion: REMOTE_MEDIA_PROTOCOL_VERSION,
          requestId,
          opaqueId,
        });
      })
      .catch(() => {
        settleRemoteMediaPending(
          requestId,
          'reject',
          new RemoteMediaError(503, 'REMOTE_MEDIA_CLIENT_MISSING'),
        );
      });
  });
  remoteMediaResolutions.set(resolutionKey, promise);
  return promise;
}

function remoteMediaChunkIv(prefix, index) {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, index, false);
  return iv;
}

function remoteMediaChunkAad(session, index) {
  const aad = new Uint8Array(28);
  const view = new DataView(aad.buffer);
  view.setUint32(0, REMOTE_MEDIA_AAD_MAGIC, false);
  view.setUint32(4, 2, false);
  view.setUint32(8, Math.floor(session.plainSize / 0x1_0000_0000), false);
  view.setUint32(12, session.plainSize >>> 0, false);
  view.setUint32(16, session.chunkSize, false);
  view.setUint32(20, session.chunkCount, false);
  view.setUint32(24, index, false);
  return aad;
}

async function readExactRemoteMediaBody(response, expectedBytes, signal) {
  if (!response.body) throw new Error('REMOTE_MEDIA_CHUNK_BODY_MISSING');
  const output = new Uint8Array(expectedBytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (offset < expectedBytes) {
      if (signal.aborted) throw signal.reason || new Error('REMOTE_MEDIA_ABORTED');
      const { done, value } = await reader.read();
      if (done) throw new Error('REMOTE_MEDIA_CHUNK_SIZE_MISMATCH');
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (offset + bytes.byteLength > expectedBytes) {
        throw new Error('REMOTE_MEDIA_CHUNK_SIZE_MISMATCH');
      }
      output.set(bytes, offset);
      offset += bytes.byteLength;
    }
    const trailing = await reader.read();
    if (!trailing.done || (trailing.value && trailing.value.byteLength > 0)) {
      throw new Error('REMOTE_MEDIA_CHUNK_SIZE_MISMATCH');
    }
    return output;
  } catch (error) {
    output.fill(0);
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch (_) {
      // Cancellation may already have detached the reader.
    }
  }
}

async function decryptRemoteMediaChunk(session, index, signal) {
  const plainBytes = Math.min(
    session.chunkSize,
    session.plainSize - index * session.chunkSize,
  );
  const cipherBytes = plainBytes + session.tagBytes;
  const cipherStart = index * (session.chunkSize + session.tagBytes);
  const cipherEnd = cipherStart + cipherBytes - 1;
  const response = await fetch(session.downloadUrl, {
    method: 'GET',
    headers: { Range: `bytes=${cipherStart}-${cipherEnd}` },
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal,
  });
  if (
    response.status !== 206 ||
    response.headers.get('content-range') !==
      `bytes ${cipherStart}-${cipherEnd}/${session.encryptedSize}` ||
    Number(response.headers.get('content-length')) !== cipherBytes ||
    response.headers.get('content-encoding')
  ) {
    await response.body?.cancel('invalid encrypted range').catch(() => undefined);
    throw new Error('REMOTE_MEDIA_CHUNK_RESPONSE_INVALID');
  }
  const cipher = await readExactRemoteMediaBody(response, cipherBytes, signal);
  try {
    const plain = await self.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: remoteMediaChunkIv(session.noncePrefix, index),
        additionalData: remoteMediaChunkAad(session, index),
        tagLength: session.tagBytes * 8,
      },
      session.key,
      cipher,
    );
    const bytes = new Uint8Array(plain);
    if (bytes.byteLength !== plainBytes) {
      bytes.fill(0);
      throw new Error('REMOTE_MEDIA_PLAINTEXT_SIZE_MISMATCH');
    }
    return bytes;
  } finally {
    cipher.fill(0);
  }
}

function createRemoteMediaStream(session, selection, request) {
  const abortController = new AbortController();
  session.activeControllers.add(abortController);
  let chunkIndex = Math.floor(selection.start / session.chunkSize);
  const finalChunkIndex = Math.floor(selection.end / session.chunkSize);
  let finished = false;
  const abortFromRequest = () => abortController.abort(request.signal.reason);
  request.signal.addEventListener('abort', abortFromRequest, { once: true });
  if (request.signal.aborted) abortFromRequest();

  const cleanup = () => {
    if (finished) return;
    finished = true;
    request.signal.removeEventListener('abort', abortFromRequest);
    session.activeControllers.delete(abortController);
  };

  return new ReadableStream({
    async pull(controller) {
      if (finished) return;
      if (abortController.signal.aborted) {
        cleanup();
        controller.error(abortController.signal.reason || new Error('REMOTE_MEDIA_ABORTED'));
        return;
      }
      try {
        const currentIndex = chunkIndex;
        const plain = await decryptRemoteMediaChunk(
          session,
          currentIndex,
          abortController.signal,
        );
        if (abortController.signal.aborted) {
          plain.fill(0);
          throw abortController.signal.reason || new Error('REMOTE_MEDIA_ABORTED');
        }
        const chunkPlainStart = currentIndex * session.chunkSize;
        const sliceStart = Math.max(0, selection.start - chunkPlainStart);
        const sliceEnd = Math.min(plain.byteLength, selection.end - chunkPlainStart + 1);
        const output = plain.slice(sliceStart, sliceEnd);
        plain.fill(0);
        controller.enqueue(output);
        if (currentIndex >= finalChunkIndex) {
          cleanup();
          controller.close();
        } else {
          chunkIndex += 1;
        }
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    cancel(reason) {
      abortController.abort(reason);
      cleanup();
    },
  });
}

async function handleRemoteMediaFetch(event, opaqueId) {
  const request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return remoteMediaErrorResponse(405, 0, 'Method Not Allowed');
  }
  if (!event.clientId) {
    return remoteMediaErrorResponse(403, 0, 'Forbidden');
  }
  let session;
  try {
    session = await resolveRemoteMediaSession(opaqueId, event.clientId);
  } catch (error) {
    const status = error instanceof RemoteMediaError ? error.status : 503;
    return remoteMediaErrorResponse(status, 0, status === 403 ? 'Forbidden' : 'Unavailable');
  }
  const selection = parseRemoteMediaRange(request.headers.get('range'), session.plainSize);
  if (!selection) {
    return remoteMediaErrorResponse(416, session.plainSize, 'Range Not Satisfiable');
  }
  const headers = remoteMediaHeaders(session, selection);
  if (request.method === 'HEAD') {
    return new Response(null, { status: selection.status, headers });
  }
  const body = createRemoteMediaStream(session, selection, request);
  return new Response(body, { status: selection.status, headers });
}

// Network-first for navigations, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const requestUrl = new URL(request.url);
  const remoteMediaPath = parseRemoteMediaPath(requestUrl);
  if (remoteMediaPath !== null) {
    if (remoteMediaPath === false) {
      event.respondWith(remoteMediaErrorResponse(404, 0, 'Not Found'));
    } else {
      event.respondWith(handleRemoteMediaFetch(event, remoteMediaPath));
    }
    return;
  }
  if (!isCacheableRequest(request)) return;

  const url = requestUrl;

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
