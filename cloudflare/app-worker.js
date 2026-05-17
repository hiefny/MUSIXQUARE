const YOUTUBE_SEARCH_API = 'https://www.googleapis.com/youtube/v3/search';
const REALTIME_API_BASE = 'https://rtc.live.cloudflare.com/v1';
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_LIMIT = 12;
const QUERY_MAX_LENGTH = 120;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const CLOUDFLARE_TURN_TTL_DEFAULT = 48 * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
const CLOUDFLARE_TURN_TTL_MIN = 60;
const CLOUDFLARE_TURN_TTL_MAX = CLOUDFLARE_TURN_TTL_DEFAULT;
const CAPABILITY_TOKEN_TTL_DEFAULT = 10 * SECONDS_PER_MINUTE;
const CAPABILITY_TOKEN_TTL_MIN = 60;
const CAPABILITY_TOKEN_TTL_MAX = 30 * SECONDS_PER_MINUTE;
const CAPABILITY_SCOPES = new Set(['turn', 'realtime', 'youtube-search']);
const TURNSTILE_VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://img.youtube.com https://i.ytimg.com; media-src 'self' blob: https://demo.musixquare.com; connect-src 'self' blob: wss://0.peerjs.com:443 https://0.peerjs.com:443 wss://*.peerjs.com https://*.peerjs.com https://www.youtube.com https://musixquare.com https://demo.musixquare.com https://*.musixquare.com wss://*.musixquare.com https://*.workers.dev wss://*.workers.dev https://*.r2.cloudflarestorage.com https://challenges.cloudflare.com; frame-src https://www.youtube.com https://challenges.cloudflare.com; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'",
};

function json(body, status = 200, headers = {}) {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        ...headers,
      },
    }),
  );
}

function withSecurityHeaders(response, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  headers.delete('Content-Length');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizeCorsOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function configuredTrustedOrigins(env) {
  const raw = env.TRUSTED_CORS_ORIGINS || env.CORS_ALLOWED_ORIGINS || '';
  if (typeof raw !== 'string' || !raw.trim()) return new Set();
  return new Set(raw.split(/[\s,]+/).map(normalizeCorsOrigin).filter(Boolean));
}

function isConfiguredTrustedOrigin(origin, env) {
  const normalizedOrigin = normalizeCorsOrigin(origin);
  if (!normalizedOrigin) return false;
  return configuredTrustedOrigins(env).has(normalizedOrigin);
}

function trustedCors(request, methods, env = {}, options = {}) {
  const origin = request.headers.get('Origin') || '';
  const host = request.headers.get('Host') || '';
  const fetchSite = (request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  const trustedPatterns = [
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i,
    /^https:\/\/(?:[^/]+\.)?toss\.im$/i,
    /^https:\/\/(?:[^/]+\.)?toss-internal\.com$/i,
    /^https:\/\/(?:[^/]+\.)?tossmini\.com$/i,
    /^https:\/\/musixquare\.com$/i,
    /^https:\/\/[^/]*\.musixquare\.com$/i,
  ];

  const sameOrigin = origin && (origin === `https://${host}` || origin === `http://${host}`);
  const browserSameOrigin = fetchSite === 'same-origin';
  const sameOriginInferred =
    !origin &&
    !fetchSite &&
    (host === 'musixquare.com' || host.endsWith('.musixquare.com') || host.startsWith('localhost'));
  // Host-only inference is intentionally opt-in. It is too weak to authorize
  // paid-resource endpoints directly, but it keeps a legacy WebView fallback
  // available for minting short-lived capability tokens when explicitly allowed.
  const isTrusted =
    sameOrigin ||
    browserSameOrigin ||
    (options.allowInferred && sameOriginInferred) ||
    trustedPatterns.some((pattern) => pattern.test(origin)) ||
    isConfiguredTrustedOrigin(origin, env);
  const allowOrigin = isTrusted ? origin : '';

  return {
    isTrusted,
    sameOriginInferred,
    headers: allowOrigin
      ? {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Methods': methods,
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-MXQR-Capability',
          Vary: 'Origin',
        }
      : {},
  };
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown'
  );
}

// Per-IP rate limit for sensitive endpoints (paid Cloudflare TURN/SFU /
// YouTube quota). 13차 audit finding 1: header-based CORS is bypassable by
// curl spoofing Origin or Sec-Fetch-Site, so paid-resource endpoints need
// a separate defense layer. Uses Cache API (no extra binding needed) keyed
// on CF-Connecting-IP + endpoint + window minute. Atomicity is best-effort
// — concurrent requests within the same minute can each pass with a stale
// count, but the worst-case overshoot is bounded by edge node concurrency
// per IP. Adequate for paid-resource leak prevention; not for strict abuse
// quotas.
async function checkRateLimit(request, endpoint, limit = 60, windowSec = 60) {
  // Graceful bypass if the runtime doesn't expose Cache API (e.g. jsdom unit
  // tests that invoke the worker directly). Production Cloudflare workers
  // always have `caches.default`.
  if (typeof caches === 'undefined' || !caches?.default) return true;

  const ip = getClientIp(request);
  const window = Math.floor(Date.now() / (windowSec * 1000));
  // Use a synthetic cache URL so the key is opaque to upstream caches.
  const cacheKey = new Request(
    `https://ratelimit.internal/${encodeURIComponent(endpoint)}/${encodeURIComponent(ip)}/${window}`,
    { method: 'GET' },
  );
  const cache = caches.default;

  let count = 0;
  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const txt = await cached.text();
      const n = Number.parseInt(txt, 10);
      if (Number.isFinite(n) && n >= 0) count = n;
    }
  } catch {
    /* cache miss treated as 0 */
  }

  if (count >= limit) return false;

  try {
    await cache.put(
      cacheKey,
      new Response(String(count + 1), {
        headers: { 'Cache-Control': `public, max-age=${windowSec * 2}` },
      }),
    );
  } catch {
    /* best-effort */
  }
  return true;
}

function rateLimitResponse(headers) {
  return json({ error: 'Too Many Requests' }, 429, {
    ...headers,
    'Retry-After': '60',
  });
}

function getCapabilitySecret(env) {
  return (
    env.MXQR_CAPABILITY_SECRET ||
    env.CAPABILITY_HMAC_SECRET ||
    env.CAPABILITY_SECRET ||
    ''
  );
}

function isCapabilityAuthEnabled(env) {
  return !!getCapabilitySecret(env);
}

function getTurnstileSiteKey(env) {
  return env.TURNSTILE_SITE_KEY || env.CLOUDFLARE_TURNSTILE_SITE_KEY || '';
}

function getTurnstileSecret(env) {
  return env.TURNSTILE_SECRET_KEY || env.CLOUDFLARE_TURNSTILE_SECRET_KEY || '';
}

function isTurnstileConfigured(env) {
  return !!(getTurnstileSiteKey(env) && getTurnstileSecret(env));
}

function allowInferredCapabilityFallback(env) {
  const raw = String(
    env.MXQR_ALLOW_INFERRED_CAPABILITY_FALLBACK ??
      env.ALLOW_INFERRED_CAPABILITY_FALLBACK ??
      'true',
  ).toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

function parseCapabilityTtl(env) {
  const parsed = Number.parseInt(env.MXQR_CAPABILITY_TTL || env.CAPABILITY_TTL || '', 10);
  if (!Number.isFinite(parsed)) return CAPABILITY_TOKEN_TTL_DEFAULT;
  return Math.min(CAPABILITY_TOKEN_TTL_MAX, Math.max(CAPABILITY_TOKEN_TTL_MIN, parsed));
}

function parseRequestedScopes(value) {
  if (!Array.isArray(value)) return [];
  const scopes = [];
  for (const scope of value) {
    if (typeof scope === 'string' && CAPABILITY_SCOPES.has(scope) && !scopes.includes(scope)) {
      scopes.push(scope);
    }
  }
  return scopes;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function stringToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToString(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function capabilityIpHash(secret, request) {
  return hmacSha256(secret, `ip:${getClientIp(request)}`);
}

function readCapabilityToken(request) {
  const headerToken = request.headers.get('X-MXQR-Capability') || '';
  if (headerToken) return headerToken.trim();
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function createCapabilityToken(scopes, request, env, method) {
  const secret = getCapabilitySecret(env);
  const ttl = parseCapabilityTtl(env);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    scopes,
    iat: now,
    exp: now + ttl,
    ip: await capabilityIpHash(secret, request),
    method,
  };
  const payloadPart = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(secret, payloadPart);
  return {
    token: `${payloadPart}.${signature}`,
    expiresAt: payload.exp,
    scopes,
  };
}

async function verifyCapabilityToken(token, request, env, requiredScope) {
  const secret = getCapabilitySecret(env);
  if (!secret || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

  const expectedSignature = await hmacSha256(secret, parts[0]);
  if (!constantTimeEqual(expectedSignature, parts[1])) return false;

  let payload;
  try {
    payload = JSON.parse(base64UrlToString(parts[0]));
  } catch {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload?.v !== 1) return false;
  if (!Array.isArray(payload.scopes) || !payload.scopes.includes(requiredScope)) return false;
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return false;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return false;

  const expectedIp = await capabilityIpHash(secret, request);
  return constantTimeEqual(String(payload.ip || ''), expectedIp);
}

async function verifyTurnstileToken(turnstileToken, request, env) {
  if (!isTurnstileConfigured(env) || typeof turnstileToken !== 'string' || !turnstileToken) {
    return false;
  }

  const body = new URLSearchParams();
  body.set('secret', getTurnstileSecret(env));
  body.set('response', turnstileToken);
  const ip = getClientIp(request);
  if (ip !== 'unknown') body.set('remoteip', ip);

  try {
    const response = await fetch(TURNSTILE_VERIFY_ENDPOINT, {
      method: 'POST',
      body,
    });
    const payload = await response.json().catch(() => ({}));
    return !!payload.success && (!payload.action || payload.action === 'mxqr-capability');
  } catch {
    return false;
  }
}

async function guardSensitiveRequest(request, env, trust, capabilityScope, rateLimitKey, rateLimit) {
  if (!isCapabilityAuthEnabled(env)) {
    if (!trust.isTrusted) return json({ error: 'Forbidden' }, 403, trust.headers);
    if (!(await checkRateLimit(request, rateLimitKey, rateLimit, 60))) {
      return rateLimitResponse(trust.headers);
    }
    return null;
  }

  if (!(await checkRateLimit(request, rateLimitKey, rateLimit, 60))) {
    return rateLimitResponse(trust.headers);
  }

  const token = readCapabilityToken(request);
  if (await verifyCapabilityToken(token, request, env, capabilityScope)) return null;
  return json({ error: 'CAPABILITY_REQUIRED' }, 401, trust.headers);
}

async function handleSecurityConfig(request, env) {
  const trust = trustedCors(request, 'GET, OPTIONS', env, { allowInferred: true });
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  if (!trust.isTrusted) return json({ error: 'Forbidden' }, 403, headers);

  return json(
    {
      capabilityRequired: isCapabilityAuthEnabled(env),
      turnstileSiteKey: getTurnstileSiteKey(env),
      turnstileRequired: isCapabilityAuthEnabled(env) && isTurnstileConfigured(env),
      inferredFallback: allowInferredCapabilityFallback(env),
      ttl: parseCapabilityTtl(env),
    },
    200,
    headers,
  );
}

async function handleCapabilityToken(request, env) {
  const trust = trustedCors(request, 'POST, OPTIONS', env, { allowInferred: true });
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
  if (!isCapabilityAuthEnabled(env)) {
    return json({ capabilityRequired: false }, 200, headers);
  }
  if (!trust.isTrusted) return json({ error: 'Forbidden' }, 403, headers);
  if (!(await checkRateLimit(request, 'capability-token', 30, 60))) {
    return rateLimitResponse(headers);
  }

  const body = await request.json().catch(() => null);
  const scopes = parseRequestedScopes(body?.scopes);
  if (scopes.length === 0) return json({ error: 'Invalid scopes' }, 400, headers);

  let method = '';
  if (isTurnstileConfigured(env) && typeof body?.turnstileToken === 'string') {
    if (!(await verifyTurnstileToken(body.turnstileToken, request, env))) {
      return json({ error: 'TURNSTILE_FAILED' }, 403, headers);
    }
    method = 'turnstile';
  } else if (trust.sameOriginInferred && allowInferredCapabilityFallback(env)) {
    method = 'same-origin-inferred';
  } else if (!isTurnstileConfigured(env) && trust.isTrusted) {
    method = 'trusted-origin';
  } else {
    return json({ error: 'TURNSTILE_REQUIRED' }, 403, headers);
  }

  return json(await createCapabilityToken(scopes, request, env, method), 200, headers);
}

function clampMaxResults(raw, env) {
  const envDefault = Number.parseInt(env.YOUTUBE_SEARCH_MAX_RESULTS || '', 10);
  const fallback = Number.isFinite(envDefault) ? envDefault : DEFAULT_MAX_RESULTS;
  const parsed = Number.parseInt(raw || String(fallback), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_RESULTS_LIMIT, Math.max(1, parsed));
}

function getBestThumbnail(thumbnails) {
  if (!thumbnails || typeof thumbnails !== 'object') return '';
  return (
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    thumbnails.standard?.url ||
    thumbnails.maxres?.url ||
    ''
  );
}

function normalizeResults(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const videoId = item?.id?.videoId;
      const snippet = item?.snippet || {};
      if (typeof videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;
      return {
        videoId,
        title: typeof snippet.title === 'string' ? snippet.title : '',
        channelTitle: typeof snippet.channelTitle === 'string' ? snippet.channelTitle : '',
        thumbnailUrl: getBestThumbnail(snippet.thumbnails),
        publishedAt: typeof snippet.publishedAt === 'string' ? snippet.publishedAt : '',
        url: `https://www.youtube.com/watch?v=${videoId}`,
      };
    })
    .filter(Boolean);
}

function normalizeUpstreamError(payload) {
  const firstError = payload?.error?.errors?.[0] || {};
  return {
    reason: firstError.reason || payload?.error?.status || 'unknown',
    message: firstError.message || payload?.error?.message || '',
  };
}

function getClientStatusForUpstreamError(status, reason) {
  const quotaReasons = new Set([
    'quotaExceeded',
    'dailyLimitExceeded',
    'rateLimitExceeded',
    'userRateLimitExceeded',
  ]);
  if (quotaReasons.has(reason)) return 429;
  if (status === 400 || status === 401 || status === 403) return 403;
  return 502;
}

async function handleYoutubeSearch(request, env) {
  const trust = trustedCors(request, 'GET, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  const guard = await guardSensitiveRequest(request, env, trust, 'youtube-search', 'yt-search', 30);
  if (guard) return guard;

  const apiKey = env.YOUTUBE_API_KEY || env.YOUTUBE_DATA_API_KEY || '';
  if (!apiKey) return json({ error: 'YOUTUBE_SEARCH_UNAVAILABLE' }, 503, headers);

  const url = new URL(request.url);
  const query = String(url.searchParams.get('q') || '')
    .trim()
    .slice(0, QUERY_MAX_LENGTH);
  if (!query) return json({ error: 'Missing query' }, 400, headers);

  const params = new URLSearchParams({
    key: apiKey,
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    safeSearch: env.YOUTUBE_SAFE_SEARCH || 'moderate',
    maxResults: String(clampMaxResults(url.searchParams.get('maxResults'), env)),
    q: query,
    fields:
      'items(id/videoId,snippet/title,snippet/channelTitle,snippet/publishedAt,snippet/thumbnails)',
  });
  if (/^[A-Za-z]{2}$/.test(env.YOUTUBE_REGION_CODE || '')) {
    params.set('regionCode', env.YOUTUBE_REGION_CODE.toUpperCase());
  }
  if (/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(env.YOUTUBE_RELEVANCE_LANGUAGE || '')) {
    params.set('relevanceLanguage', env.YOUTUBE_RELEVANCE_LANGUAGE);
  }

  try {
    const response = await fetch(`${YOUTUBE_SEARCH_API}?${params.toString()}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const upstreamError = normalizeUpstreamError(payload);
      return json(
        {
          error: 'YOUTUBE_SEARCH_FAILED',
          upstreamStatus: response.status,
          reason: upstreamError.reason,
          message: upstreamError.message,
        },
        getClientStatusForUpstreamError(response.status, upstreamError.reason),
        headers,
      );
    }
    return json({ query, results: normalizeResults(payload.items) }, 200, headers);
  } catch (error) {
    return json(
      { error: 'YOUTUBE_SEARCH_PROXY_FAILED', message: error?.message || String(error) },
      502,
      headers,
    );
  }
}

function parseTurnTtl(env) {
  const parsed = Number.parseInt(env.CLOUDFLARE_TURN_TTL || env.CF_TURN_TTL || '', 10);
  if (!Number.isFinite(parsed)) return CLOUDFLARE_TURN_TTL_DEFAULT;
  return Math.min(CLOUDFLARE_TURN_TTL_MAX, Math.max(CLOUDFLARE_TURN_TTL_MIN, parsed));
}

function normalizeUrls(value) {
  const urls = Array.isArray(value) ? value : [value];
  return urls.filter((url) => {
    if (typeof url !== 'string') return false;
    if (!/^(stun|turn|turns):/i.test(url)) return false;
    return !/^turns?:turn\.cloudflare\.com:53(?:[/?]|$)/i.test(url);
  });
}

function normalizeIceServers(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const urls = normalizeUrls(item.urls);
    if (urls.length === 0) continue;
    const hasTurn = urls.some((url) => /^turns?:/i.test(url));
    if (hasTurn && (!item.username || !item.credential)) continue;
    const server = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof item.username === 'string' && item.username) server.username = item.username;
    if (typeof item.credential === 'string' && item.credential) {
      server.credential = item.credential;
    }
    if (item.credentialType === 'password' || item.credentialType === 'oauth') {
      server.credentialType = item.credentialType;
    }
    result.push(server);
  }
  return result;
}

async function getCloudflareIceServers(env) {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID || env.CF_TURN_KEY_ID || '';
  const apiToken =
    env.CLOUDFLARE_TURN_API_TOKEN || env.CF_TURN_API_TOKEN || env.CLOUDFLARE_API_TOKEN || '';
  if (!keyId || !apiToken) return null;

  const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
    keyId,
  )}/credentials/generate-ice-servers`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: parseTurnTtl(env) }),
  });
  if (!response.ok) throw new Error(`Cloudflare TURN HTTP ${response.status}`);

  const payload = await response.json();
  const iceServers = normalizeIceServers(payload?.iceServers);
  const hasTurn = iceServers.some((server) =>
    normalizeUrls(server.urls).some((url) => /^turns?:/i.test(url)),
  );
  if (!hasTurn) throw new Error('Cloudflare TURN returned no usable TURN servers');
  return { provider: 'cloudflare', ttl: parseTurnTtl(env), iceServers };
}

function getMeteredFallbackIceServers(env) {
  const username = env.TURN_USER || '';
  const credential = env.TURN_PASS || '';
  if (!username || !credential) return null;
  return {
    provider: 'metered-fallback',
    username,
    credential,
    iceServers: [
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'turn:standard.relay.metered.ca:443', username, credential },
      { urls: 'turn:standard.relay.metered.ca:443?transport=tcp', username, credential },
      { urls: 'turns:standard.relay.metered.ca:443?transport=tcp', username, credential },
    ],
  };
}

async function handleTurnConfig(request, env) {
  const trust = trustedCors(request, 'GET, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  const guard = await guardSensitiveRequest(request, env, trust, 'turn', 'turn-config', 60);
  if (guard) return guard;

  try {
    const cloudflareConfig = await getCloudflareIceServers(env);
    if (cloudflareConfig) return json(cloudflareConfig, 200, headers);
  } catch (error) {
    console.warn('[TURN] Cloudflare config failed:', error?.message || error);
  }
  const fallback = getMeteredFallbackIceServers(env);
  if (fallback) return json(fallback, 200, headers);
  return json({ error: 'TURN_CONFIG_UNAVAILABLE' }, 503, headers);
}

function getRealtimeEnv(env) {
  return {
    appId:
      env.CLOUDFLARE_REALTIME_APP_ID ||
      env.CLOUDFLARE_CALLS_APP_ID ||
      env.CLOUDFLARE_SFU_APP_ID ||
      '',
    appSecret:
      env.CLOUDFLARE_REALTIME_APP_SECRET ||
      env.CLOUDFLARE_REALTIME_API_TOKEN ||
      env.CLOUDFLARE_CALLS_APP_SECRET ||
      env.CLOUDFLARE_CALLS_API_TOKEN ||
      env.CLOUDFLARE_SFU_APP_SECRET ||
      env.CLOUDFLARE_SFU_API_TOKEN ||
      '',
  };
}

function buildRealtimeRequest(action, appId, sessionId, correlationId) {
  const encodedAppId = encodeURIComponent(appId);
  const encodedSessionId = sessionId ? encodeURIComponent(sessionId) : '';
  const query =
    typeof correlationId === 'string' && correlationId
      ? `?correlationId=${encodeURIComponent(correlationId.slice(0, 128))}`
      : '';
  switch (action) {
    case 'new-session':
      return {
        method: 'POST',
        url: `${REALTIME_API_BASE}/apps/${encodedAppId}/sessions/new${query}`,
      };
    case 'tracks-new':
      return {
        method: 'POST',
        url: `${REALTIME_API_BASE}/apps/${encodedAppId}/sessions/${encodedSessionId}/tracks/new`,
      };
    case 'renegotiate':
      return {
        method: 'PUT',
        url: `${REALTIME_API_BASE}/apps/${encodedAppId}/sessions/${encodedSessionId}/renegotiate`,
      };
    case 'tracks-close':
      return {
        method: 'PUT',
        url: `${REALTIME_API_BASE}/apps/${encodedAppId}/sessions/${encodedSessionId}/tracks/close`,
      };
    default:
      return null;
  }
}

function shouldSendPayloadBody(action, payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (action !== 'new-session') return true;
  return Object.keys(payload).length > 0;
}

async function handleRealtime(request, env) {
  const trust = trustedCors(request, 'POST, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
  const guard = await guardSensitiveRequest(request, env, trust, 'realtime', 'realtime', 30);
  if (guard) return guard;

  const { appId, appSecret } = getRealtimeEnv(env);
  if (!appId || !appSecret) return json({ error: 'REALTIME_SFU_UNAVAILABLE' }, 503, headers);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid JSON body' }, 400, headers);

  const action = typeof body.action === 'string' ? body.action : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const realtimeRequest = buildRealtimeRequest(action, appId, sessionId, body.correlationId);
  if (!realtimeRequest) return json({ error: 'Unsupported action' }, 400, headers);
  if (action !== 'new-session' && !sessionId)
    return json({ error: 'Missing sessionId' }, 400, headers);

  try {
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const requestBody = shouldSendPayloadBody(action, payload)
      ? JSON.stringify(payload)
      : undefined;
    const cfResponse = await fetch(realtimeRequest.url, {
      method: realtimeRequest.method,
      headers: {
        Authorization: `Bearer ${appSecret}`,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
    const text = await cfResponse.text();
    let responseBody;
    try {
      responseBody = text ? JSON.parse(text) : {};
    } catch {
      responseBody = { raw: text };
    }
    return json(responseBody, cfResponse.status, headers);
  } catch (error) {
    return json(
      { error: 'CLOUDFLARE_REALTIME_PROXY_FAILED', message: error?.message || String(error) },
      502,
      headers,
    );
  }
}

function esc(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function replaceMetaProperty(html, property, content) {
  return html.replace(
    new RegExp(`<meta\\b(?=[^>]*\\bproperty=["']${property}["'])[^>]*>`, 'i'),
    `<meta property="${property}" content="${esc(content)}" />`,
  );
}

function replaceMetaName(html, name, content) {
  return html.replace(
    new RegExp(`<meta\\b(?=[^>]*\\bname=["']${name}["'])[^>]*>`, 'i'),
    `<meta name="${name}" content="${esc(content)}" />`,
  );
}

function rewriteInviteMeta(html, code, origin) {
  const imageUrl = `${origin}/og-invite.png`;
  const pageUrl = `${origin}/${code}`;
  const title = `Session ${code} - MUSIXQUARE`;
  const description = `Join a MUSIXQUARE session with code ${code}.`;
  const alt = `MUSIXQUARE - Session ${code}`;

  let rewritten = html;
  rewritten = replaceMetaProperty(rewritten, 'og:url', pageUrl);
  rewritten = replaceMetaProperty(rewritten, 'og:title', title);
  rewritten = replaceMetaProperty(rewritten, 'og:description', description);
  rewritten = replaceMetaProperty(rewritten, 'og:image', imageUrl);
  rewritten = replaceMetaProperty(rewritten, 'og:image:alt', alt);
  rewritten = replaceMetaName(rewritten, 'twitter:title', title);
  rewritten = replaceMetaName(rewritten, 'twitter:description', description);
  rewritten = replaceMetaName(rewritten, 'twitter:image', imageUrl);
  return rewritten;
}

async function fetchAsset(env, request, pathname = null) {
  const assetUrl = new URL(request.url);
  if (pathname) assetUrl.pathname = pathname;
  assetUrl.search = pathname ? '' : assetUrl.search;
  return env.ASSETS.fetch(new Request(assetUrl, request));
}

async function serveInvitePage(request, env, code) {
  const response = await fetchAsset(env, request, '/index.html');
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return withSecurityHeaders(response);
  const inviteHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Invite-Rewrite': code,
  };
  if (request.method === 'HEAD') {
    return withSecurityHeaders(
      new Response(null, { status: response.status, headers: response.headers }),
      inviteHeaders,
    );
  }
  const html = rewriteInviteMeta(await response.text(), code, new URL(request.url).origin);
  return withSecurityHeaders(
    new Response(html, { status: response.status, headers: response.headers }),
    inviteHeaders,
  );
}

function redirectTarget(pathname) {
  const lower = pathname.toLowerCase();
  if (['/landing', '/landing/'].includes(lower)) return '/about';
  if (['/changelog', '/changelog/', '/roadmap', '/roadmap/'].includes(lower)) return '/history';
  const canonical = new Map([
    ['/about', '/about'],
    ['/privacy', '/privacy'],
    ['/terms', '/terms'],
    ['/faq', '/faq'],
    ['/history', '/history'],
    ['/designsystem', '/designsystem'],
  ]);
  if (pathname !== lower && canonical.has(lower.replace(/\/$/, ''))) {
    return canonical.get(lower.replace(/\/$/, ''));
  }
  return null;
}

function routeStaticPath(pathname) {
  const path = pathname.toLowerCase();
  if (path === '/about' || path === '/about/') return '/about.html';
  if (path === '/privacy' || path === '/privacy/') return '/privacy.html';
  if (path === '/terms' || path === '/terms/') return '/terms.html';
  if (path === '/faq' || path === '/faq/') return '/faq.html';
  if (path === '/history' || path === '/history/') return '/history/index.html';
  if (path === '/designsystem' || path === '/designsystem/') return '/designsystem/index.html';
  return null;
}

function cacheHeadersForPath(pathname, assetPathname = pathname) {
  if (assetPathname === '/service-worker.js') return { 'Cache-Control': 'no-cache' };
  if (/^\/og-.+\.png$/.test(assetPathname)) {
    return { 'Cache-Control': 'public, max-age=86400, s-maxage=604800' };
  }
  if (
    assetPathname.startsWith('/assets/') ||
    assetPathname.startsWith('/fonts/') ||
    assetPathname.startsWith('/landing/') ||
    assetPathname.startsWith('/designsystem/fonts/') ||
    assetPathname.startsWith('/designsystem/assets/')
  ) {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  if (
    ['/about', '/privacy', '/terms', '/faq', '/history', '/designsystem'].includes(
      pathname.toLowerCase().replace(/\/$/, ''),
    )
  ) {
    return {
      'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
    };
  }
  return {};
}

async function serveStatic(request, env) {
  const url = new URL(request.url);
  const redirect = redirectTarget(url.pathname);
  if (redirect) return Response.redirect(new URL(redirect, url), 301);

  if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
    return withSecurityHeaders(await fetchAsset(env, request, '/index.html'), {
      'Cache-Control': 'no-cache',
    });
  }

  const inviteMatch = url.pathname.match(/^\/(\d{6})\/?$/);
  if (inviteMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    return serveInvitePage(request, env, inviteMatch[1]);
  }

  if (/^\/og\/invite\/\d{6}\.png$/.test(url.pathname)) {
    const response = await fetchAsset(env, request, '/og-invite.png');
    return withSecurityHeaders(response, {
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
      'X-OG-Source': 'static',
    });
  }

  const assetPathname = routeStaticPath(url.pathname);
  const response = assetPathname
    ? await fetchAsset(env, request, assetPathname)
    : await fetchAsset(env, request);

  // Allow HEAD alongside GET so link unfurlers (Slack/Discord/iMessage) that
  // HEAD-probe before fetching don't see a broken-link 404 for SPA routes.
  // Mirrors the GET+HEAD pairing at the invite path (76f114ed).
  // (10차 audit Phase 1 finding.)
  if (
    response.status === 404 &&
    (request.method === 'GET' || request.method === 'HEAD') &&
    (request.headers.get('Accept') || '').includes('text/html')
  ) {
    return withSecurityHeaders(await fetchAsset(env, request, '/index.html'), {
      'Cache-Control': 'no-cache',
    });
  }

  return withSecurityHeaders(response, {
    ...cacheHeadersForPath(url.pathname, assetPathname || url.pathname),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/__health':
        return json({ ok: true, service: 'musixquare-app' });
      case '/api/security-config':
        return handleSecurityConfig(request, env);
      case '/api/capability-token':
        return handleCapabilityToken(request, env);
      case '/api/youtube-search':
        return handleYoutubeSearch(request, env);
      case '/api/get-turn-config':
        return handleTurnConfig(request, env);
      case '/api/cloudflare-realtime':
        return handleRealtime(request, env);
      default:
        return serveStatic(request, env);
    }
  },
};
