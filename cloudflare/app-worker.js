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
// MIN intentionally clamps above the 30s client refresh skew × 4 — a 60s TTL
// leaves only ~30s of usable cache and triggers a fresh Turnstile execution
// every half minute, accumulating bot-score and eventually surfacing the
// challenge UI to legitimate users.
const CAPABILITY_TOKEN_TTL_MIN = 3 * SECONDS_PER_MINUTE;
const CAPABILITY_TOKEN_TTL_MAX = 30 * SECONDS_PER_MINUTE;
const CAPABILITY_SCOPES = new Set(['turn', 'realtime', 'youtube-search', 'remote-share']);
const TURNSTILE_VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SORO_RSS_DEFAULT_URL =
  'https://app.trysoro.com/api/rss/a07c133f-e3b9-401e-a076-ee36124598a7';
const SORO_RSS_BACKUP_KEY = 'soro-rss-latest-good.xml';
const SORO_RSS_BACKUP_META_KEY = 'soro-rss-latest-good.meta.json';
const SORO_RSS_MAX_BYTES = 20 * 1024 * 1024;
const SORO_RSS_FETCH_TIMEOUT_MS = 2500;
const SORO_ARTICLE_HTML_CACHE =
  'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800';
const SORO_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const SORO_IMAGE_FETCH_TIMEOUT_MS = 5000;
const SORO_IMAGE_ROUTE_PREFIX = '/soro-images/';
const SORO_IMAGE_R2_PREFIX = 'featured/';
const SORO_IMAGE_CACHE = 'public, max-age=31536000, immutable';

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com https://challenges.cloudflare.com https://static.cloudflareinsights.com https://app.trysoro.com https://*.trysoro.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://img.youtube.com https://i.ytimg.com https://app.trysoro.com https://*.trysoro.com https://*.supabase.co; media-src 'self' blob: https://demo.musixquare.com; connect-src 'self' blob: wss://0.peerjs.com:443 https://0.peerjs.com:443 wss://*.peerjs.com https://*.peerjs.com https://www.youtube.com https://musixquare.com https://demo.musixquare.com https://*.musixquare.com wss://*.musixquare.com https://*.workers.dev wss://*.workers.dev https://*.r2.cloudflarestorage.com https://challenges.cloudflare.com https://cloudflareinsights.com https://app.trysoro.com https://*.trysoro.com; frame-src https://www.youtube.com https://challenges.cloudflare.com https://app.trysoro.com https://*.trysoro.com; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'",
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
  const contentType = headers.get('Content-Type') || '';
  if (/^text\/html(?:\s*;|$)/i.test(contentType) && !/;\s*charset=/i.test(contentType)) {
    headers.set('Content-Type', `${contentType.trim().replace(/;\s*$/, '')}; charset=utf-8`);
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
  return new Set(
    raw
      .split(/[\s,]+/)
      .map(normalizeCorsOrigin)
      .filter(Boolean),
  );
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
    request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
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
  return env.MXQR_CAPABILITY_SECRET || env.CAPABILITY_HMAC_SECRET || env.CAPABILITY_SECRET || '';
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

function isTurnstileDisabled(env) {
  const raw = String(
    env.MXQR_TURNSTILE_DISABLED ?? env.TURNSTILE_DISABLED ?? env.DISABLE_TURNSTILE ?? 'false',
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function isTurnstileConfigured(env) {
  if (isTurnstileDisabled(env)) return false;
  return !!(getTurnstileSiteKey(env) && getTurnstileSecret(env));
}

function normalizeHostname(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const trimmed = value.trim().toLowerCase();
  try {
    const parsed = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return parsed.hostname.replace(/^\*\./, '');
  } catch {
    return trimmed.replace(/^\*\./, '').replace(/[^a-z0-9.-]/g, '');
  }
}

function configuredTurnstileHostnames(env) {
  const raw = env.MXQR_TURNSTILE_ALLOWED_HOSTNAMES || env.TURNSTILE_ALLOWED_HOSTNAMES || '';
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostnameMatchesRule(hostname, rule) {
  const normalizedHostname = normalizeHostname(hostname);
  const normalizedRule = normalizeHostname(rule);
  if (!normalizedHostname || !normalizedRule) return false;
  if (normalizedHostname === normalizedRule) return true;
  return rule.trim().startsWith('*.') && normalizedHostname.endsWith(`.${normalizedRule}`);
}

function isAllowedTurnstileHostname(hostname, env) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;

  const configured = configuredTurnstileHostnames(env);
  if (configured.length > 0) {
    return configured.some((rule) => hostnameMatchesRule(normalized, rule));
  }

  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === 'musixquare.com' ||
    normalized === 'www.musixquare.com' ||
    normalized.endsWith('.musixquare.com') ||
    normalized === 'toss.im' ||
    normalized.endsWith('.toss.im') ||
    normalized === 'toss-internal.com' ||
    normalized.endsWith('.toss-internal.com') ||
    normalized === 'tossmini.com' ||
    normalized.endsWith('.tossmini.com')
  );
}

function allowInferredCapabilityFallback(env) {
  const raw = String(
    env.MXQR_ALLOW_INFERRED_CAPABILITY_FALLBACK ??
      env.ALLOW_INFERRED_CAPABILITY_FALLBACK ??
      'false',
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function allowTrustedOriginCapabilityFallback(env) {
  const raw = String(
    env.MXQR_ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK ??
      env.MXQR_ALLOW_HEADER_CAPABILITY_FALLBACK ??
      env.ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK ??
      'false',
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function allowUnguardedPaidApis(env) {
  const raw = String(
    env.MXQR_ALLOW_UNGUARDED_PAID_APIS ?? env.ALLOW_UNGUARDED_PAID_APIS ?? 'false',
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
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
  // `method` is kept as a function argument for server-side logging hooks
  // but intentionally NOT embedded in the token payload. Tokens are
  // base64url-encoded (not encrypted) and any client can decode them, so
  // leaking which fallback path issued the token (turnstile / inferred /
  // trusted-origin) hands attackers free reconnaissance about the
  // environment's bypass flags.
  void method;
  const payload = {
    v: 1,
    scopes,
    iat: now,
    exp: now + ttl,
    ip: await capabilityIpHash(secret, request),
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
    return (
      !!payload.success &&
      payload.action === 'mxqr-capability' &&
      isAllowedTurnstileHostname(payload.hostname, env)
    );
  } catch {
    return false;
  }
}

async function guardSensitiveRequest(
  request,
  env,
  trust,
  capabilityScope,
  rateLimitKey,
  rateLimit,
) {
  if (!isCapabilityAuthEnabled(env)) {
    if (!trust.isTrusted) return json({ error: 'Forbidden' }, 403, trust.headers);
    if (!allowUnguardedPaidApis(env)) {
      return json({ error: 'CAPABILITY_NOT_CONFIGURED' }, 503, trust.headers);
    }
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

  const turnstileConfigured = isTurnstileConfigured(env);
  const inferredFallback = allowInferredCapabilityFallback(env);
  const trustedOriginFallback = !turnstileConfigured && allowTrustedOriginCapabilityFallback(env);

  return json(
    {
      capabilityRequired: isCapabilityAuthEnabled(env),
      turnstileSiteKey: isTurnstileConfigured(env) ? getTurnstileSiteKey(env) : '',
      turnstileRequired:
        isCapabilityAuthEnabled(env) && !inferredFallback && !trustedOriginFallback,
      inferredFallback,
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
  } else if (
    !isTurnstileConfigured(env) &&
    trust.isTrusted &&
    allowTrustedOriginCapabilityFallback(env)
  ) {
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

const HTML_ENTITY_RE = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i;
const HTML_ENTITY_RE_G = /&(#\d+|#x[\da-f]+|[a-z][\da-z]+);/gi;
const HTML_ENTITY_FALLBACKS = {
  amp: '&',
  apos: "'",
  bull: '\u2022',
  copy: '\u00a9',
  divide: '\u00f7',
  gt: '>',
  hellip: '\u2026',
  laquo: '\u00ab',
  ldquo: '\u201c',
  lsquo: '\u2018',
  lt: '<',
  mdash: '\u2014',
  middot: '\u00b7',
  nbsp: '\u00a0',
  ndash: '\u2013',
  plusmn: '\u00b1',
  quot: '"',
  raquo: '\u00bb',
  rdquo: '\u201d',
  reg: '\u00ae',
  rsquo: '\u2019',
  times: '\u00d7',
  trade: '\u2122',
};

function decodeNumericEntity(entity) {
  const isHex = entity.slice(0, 2).toLowerCase() === '#x';
  const raw = isHex ? entity.slice(2) : entity.slice(1);
  const codePoint = Number.parseInt(raw, isHex ? 16 : 10);
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return null;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!HTML_ENTITY_RE.test(text)) return text;
  return text.replace(HTML_ENTITY_RE_G, (match, entity) => {
    if (entity[0] === '#') return decodeNumericEntity(entity) || match;
    return HTML_ENTITY_FALLBACKS[entity.toLowerCase()] || match;
  });
}

function normalizeExternalText(value) {
  return typeof value === 'string' ? decodeHtmlEntities(value).trim() : '';
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
        title: normalizeExternalText(snippet.title),
        channelTitle: normalizeExternalText(snippet.channelTitle),
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
  return String(value ?? '')
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

function stripCdata(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return match ? match[1] : text;
}

function decodeXmlText(value) {
  return stripCdata(value)
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readRssTag(xml, tagName) {
  const tag = escapeRegExp(tagName);
  const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXmlText(match[1]) : '';
}

function readRssAttr(xml, tagPattern, attrName) {
  const tagMatch = String(xml).match(new RegExp(`<${tagPattern}\\b[^>]*>`, 'i'));
  if (!tagMatch) return '';
  const attr = escapeRegExp(attrName);
  const attrMatch = tagMatch[0].match(new RegExp(`\\b${attr}=["']([^"']+)["']`, 'i'));
  return attrMatch ? decodeXmlText(attrMatch[1]) : '';
}

function isValidSoroSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 120;
}

function extractSlugFromUrl(link) {
  try {
    const url = new URL(link);
    const post = url.searchParams.get('post') || '';
    if (isValidSoroSlug(post)) return post;
    const parts = url.pathname.split('/').filter(Boolean);
    const slug = parts[parts.length - 1] || '';
    return isValidSoroSlug(slug) ? slug : '';
  } catch {
    return '';
  }
}

function soroArticlePath(slug) {
  return `/blog/${slug}`;
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    /* invalid URL */
  }
  return '';
}

async function fetchWithTimeout(resource, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeSoroImageSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}

function contentTypeToSoroImageExt(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  switch (type) {
    case 'image/avif':
      return 'avif';
    case 'image/gif':
      return 'gif';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return '';
  }
}

function imageExtFromUrl(value) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]+)$/);
    const ext = match ? match[1] : '';
    if (['avif', 'gif', 'jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  } catch {
    /* invalid URL */
  }
  return '';
}

function isAllowedSoroImageContentType(contentType) {
  return Boolean(contentTypeToSoroImageExt(contentType));
}

function soroImageKey(article, contentType = '') {
  if (!article?.slug || !isValidSoroSlug(article.slug)) return '';
  const source = sanitizeSoroImageSource(article.image);
  if (!source) return '';
  const ext = imageExtFromUrl(source) || contentTypeToSoroImageExt(contentType) || 'webp';
  return `${SORO_IMAGE_R2_PREFIX}${article.slug}.${ext}`;
}

function soroImagePublicPath(key) {
  return `${SORO_IMAGE_ROUTE_PREFIX}${key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

function soroImageKeyFromPathname(pathname) {
  if (!pathname.startsWith(SORO_IMAGE_ROUTE_PREFIX)) return '';
  try {
    const key = decodeURIComponent(pathname.slice(SORO_IMAGE_ROUTE_PREFIX.length));
    if (!key.startsWith(SORO_IMAGE_R2_PREFIX)) return '';
    if (key.includes('..') || key.includes('\\')) return '';
    if (!/^featured\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:avif|gif|jpg|png|webp)$/.test(key)) {
      return '';
    }
    return key;
  } catch {
    return '';
  }
}

async function ensureSoroImageMirror(env, article, options = {}) {
  if (!article?.image) return 'none';
  const sourceUrl = sanitizeSoroImageSource(article.image);
  if (!sourceUrl) return 'invalid-source';
  if (!env.SORO_IMAGE_BUCKET) return 'unbound';

  const key = soroImageKey(article);
  if (!key) return 'invalid-key';
  const localPath = soroImagePublicPath(key);

  let existing = null;
  try {
    existing = await env.SORO_IMAGE_BUCKET.head(key);
  } catch {
    existing = null;
  }

  if (existing?.customMetadata?.sourceUrl === sourceUrl) {
    article.localImagePath = localPath;
    return 'cached';
  }
  if (existing && !options.fetchMissing) {
    article.localImagePath = localPath;
    return 'cached';
  }
  if (!options.fetchMissing) return 'source';

  try {
    const response = await fetchWithTimeout(
      sourceUrl,
      {
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.1',
        },
      },
      SORO_IMAGE_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) return existing ? 'cached' : 'fetch-error';

    const contentType = response.headers.get('content-type') || '';
    if (!isAllowedSoroImageContentType(contentType)) return existing ? 'cached' : 'invalid-type';

    const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > SORO_IMAGE_MAX_BYTES) return existing ? 'cached' : 'too-large';

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > SORO_IMAGE_MAX_BYTES) return existing ? 'cached' : 'too-large';

    await env.SORO_IMAGE_BUCKET.put(key, bytes, {
      httpMetadata: {
        contentType: contentType.split(';')[0].trim().toLowerCase(),
        cacheControl: SORO_IMAGE_CACHE,
      },
      customMetadata: {
        sourceUrl,
        slug: article.slug,
        mirroredAt: new Date().toISOString(),
      },
    });
    article.localImagePath = localPath;
    return existing ? 'updated' : 'written';
  } catch {
    if (existing) {
      article.localImagePath = localPath;
      return 'cached';
    }
    return 'error';
  }
}

async function mirrorSoroImages(env, articles, options = {}) {
  if (!env.SORO_IMAGE_BUCKET) return 'unbound';
  const counts = {};
  for (const article of articles) {
    const status = await ensureSoroImageMirror(env, article, options);
    counts[status] = (counts[status] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([status, count]) => `${status}:${count}`)
    .join(',');
}

function sortedSoroArticles(articles) {
  return [...articles].sort((a, b) => {
    const bTime = Date.parse(b.pubDate || '') || 0;
    const aTime = Date.parse(a.pubDate || '') || 0;
    return bTime - aTime;
  });
}

function soroArticleDisplayDate(pubDate) {
  const date = new Date(pubDate || '');
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function soroArticleIsoDate(pubDate) {
  const date = new Date(pubDate || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function soroArticleExcerpt(article) {
  return (
    article.description ||
    String(article.content || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180)
  );
}

function soroArticleImageUrl(article, origin, source) {
  if (article.localImagePath) return new URL(article.localImagePath, origin).href;
  if (source !== 'backup' && article.image) return article.image;
  return `${origin}/og-blog.png`;
}

async function hydrateSoroListImages(env, articles, source) {
  const counts = {};
  const visibleCount = Math.min(articles.length, 12);

  for (let index = 0; index < articles.length; index += 1) {
    const article = articles[index];
    if (!article?.image) {
      counts.none = (counts.none || 0) + 1;
      continue;
    }

    if (index < visibleCount) {
      const status = await ensureSoroImageMirror(env, article, { fetchMissing: source === 'live' });
      counts[status] = (counts[status] || 0) + 1;
      continue;
    }

    const key = soroImageKey(article);
    if (key) {
      article.localImagePath = soroImagePublicPath(key);
      counts.deferred = (counts.deferred || 0) + 1;
    }
  }

  return Object.entries(counts)
    .map(([status, count]) => `${status}:${count}`)
    .join(',');
}

function renderSoroBlogListHtml(articles, origin, source) {
  if (!articles.length) {
    return `<div class="soro-blog"><div class="soro-blog-content"><p class="soro-blog-card-excerpt">No articles are available yet.</p></div></div>`;
  }

  const cards = articles
    .map((article) => {
      const href = soroArticlePath(article.slug);
      const image = soroArticleImageUrl(article, origin, source);
      const displayDate = soroArticleDisplayDate(article.pubDate);
      const isoDate = soroArticleIsoDate(article.pubDate);
      const dateHtml = displayDate
        ? `<time class="soro-blog-card-date" datetime="${esc(isoDate)}">${esc(displayDate)}</time>`
        : '';
      return `<a class="soro-blog-card" href="${esc(href)}">
        <img class="soro-blog-card-image" src="${esc(image)}" alt="${esc(article.title)}" loading="lazy" decoding="async">
        <div class="soro-blog-card-content">
          <h3 class="soro-blog-card-title">${esc(article.title)}</h3>
          <p class="soro-blog-card-excerpt">${esc(soroArticleExcerpt(article))}</p>
          ${dateHtml}
        </div>
      </a>`;
    })
    .join('');

  return `<div class="soro-blog"><div class="soro-blog-content"><div class="soro-blog-list">${cards}</div></div></div>`;
}

function firstImageFromHtml(html) {
  const match = String(html).match(/<img\b[^>]*\bsrc=(["'])(.*?)\1/i);
  return match ? sanitizeUrl(decodeXmlText(match[2])) : '';
}

function sanitizeSoroArticleHtml(html) {
  return String(html)
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, ' $1="#"');
}

function replaceHtmlTag(html, pattern, replacement) {
  return pattern.test(html) ? html.replace(pattern, replacement) : html;
}

function parseSoroRss(xml) {
  const items = [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  return items
    .map((match) => {
      const item = match[1];
      const title = readRssTag(item, 'title');
      const link = readRssTag(item, 'link');
      const slug = extractSlugFromUrl(link);
      const description = readRssTag(item, 'description');
      const pubDate = readRssTag(item, 'pubDate');
      const guid = readRssTag(item, 'guid');
      const content = readRssTag(item, 'content:encoded');
      const mediaImage =
        sanitizeUrl(readRssAttr(item, 'media:(?:content|thumbnail)', 'url')) ||
        sanitizeUrl(readRssAttr(item, 'enclosure', 'url'));
      const image = mediaImage || firstImageFromHtml(content);
      return {
        title,
        slug,
        link,
        description,
        pubDate,
        guid,
        content,
        image,
      };
    })
    .filter((article) => article.title && article.slug && article.content);
}

function isLikelyValidSoroFeed(xml, articles) {
  return (
    typeof xml === 'string' &&
    xml.length > 0 &&
    xml.length <= SORO_RSS_MAX_BYTES &&
    /<rss\b/i.test(xml) &&
    Array.isArray(articles) &&
    articles.length > 0
  );
}

async function readSoroBackup(env) {
  if (!env.SORO_RSS_BACKUP) return { text: '', articles: [] };
  const text = (await env.SORO_RSS_BACKUP.get(SORO_RSS_BACKUP_KEY)) || '';
  const articles = text ? parseSoroRss(text) : [];
  return { text, articles };
}

async function writeSoroBackup(env, text, articles, previousText, previousArticles) {
  if (!env.SORO_RSS_BACKUP) return 'unbound';
  if (text === previousText) return 'unchanged';
  if (previousArticles.length && articles.length < previousArticles.length) return 'skip-smaller';

  const metadata = {
    updatedAt: new Date().toISOString(),
    itemCount: articles.length,
    bytes: text.length,
  };
  const write = Promise.all([
    env.SORO_RSS_BACKUP.put(SORO_RSS_BACKUP_KEY, text),
    env.SORO_RSS_BACKUP.put(SORO_RSS_BACKUP_META_KEY, JSON.stringify(metadata)),
  ]);
  await write;
  return 'written';
}

async function fetchLiveSoroRss(env) {
  const rssUrl = String(env.SORO_RSS_URL || SORO_RSS_DEFAULT_URL).trim();
  const response = await fetchWithTimeout(
    rssUrl,
    {
      headers: {
        Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
      },
    },
    SORO_RSS_FETCH_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`Soro RSS HTTP ${response.status}`);
  const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (contentLength > SORO_RSS_MAX_BYTES) throw new Error('Soro RSS too large');
  const text = await response.text();
  if (text.length > SORO_RSS_MAX_BYTES) throw new Error('Soro RSS too large');
  const articles = parseSoroRss(text);
  if (!isLikelyValidSoroFeed(text, articles)) throw new Error('Soro RSS invalid');
  return { text, articles };
}

async function loadSoroFeeds(env, options = {}) {
  const backup = await readSoroBackup(env);
  try {
    const live = await fetchLiveSoroRss(env);
    const backupStatus = await writeSoroBackup(
      env,
      live.text,
      live.articles,
      backup.text,
      backup.articles,
    );
    const imageStatus = options.mirrorImages
      ? await mirrorSoroImages(env, live.articles, { fetchMissing: true })
      : 'skipped';
    return { live, backup, source: 'live', backupStatus, imageStatus };
  } catch (error) {
    console.warn('[SoroBlog] live RSS unavailable:', error?.message || error);
    const imageStatus = options.mirrorImages
      ? await mirrorSoroImages(env, backup.articles, { fetchMissing: false })
      : 'skipped';
    return {
      live: { text: '', articles: [] },
      backup,
      source: 'backup',
      backupStatus: 'live-error',
      imageStatus,
    };
  }
}

function findSoroArticle(feeds, slug) {
  const liveArticle = feeds.live.articles.find((article) => article.slug === slug);
  if (liveArticle) return { article: liveArticle, source: 'live' };
  const backupArticle = feeds.backup.articles.find((article) => article.slug === slug);
  if (backupArticle) return { article: backupArticle, source: 'backup' };
  return { article: null, source: '' };
}

function isPotentialSoroArticlePath(pathname) {
  const match = pathname.match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  if (!match) return '';
  const slug = match[1];
  const reserved = new Set([
    'about',
    'blog',
    'privacy',
    'terms',
    'faq',
    'history',
    'designsystem',
    'landing',
    'changelog',
    'roadmap',
    'index',
    'robots',
    'sitemap',
  ]);
  return reserved.has(slug) ? '' : slug;
}

function isPotentialSoroBlogArticlePath(pathname) {
  const match = pathname.match(/^\/blog\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  return match ? match[1] : '';
}

function renderSoroArticleBodyHtml(article, image, published, blogUrl, safeContent) {
  return `<div class="soro-blog">
    <article class="soro-blog-article">
      <div class="soro-blog-header">
        <a class="soro-blog-back" href="${esc(blogUrl)}">All articles</a>
      </div>
      <header>
        <h1 class="soro-blog-article-title">${esc(article.title)}</h1>
        ${published ? `<time class="soro-blog-article-date" datetime="${esc(published)}">${esc(article.pubDate)}</time>` : ''}
      </header>
      ${image ? `<img class="soro-blog-article-image" src="${esc(image)}" alt="${esc(article.title)}">` : ''}
      <div class="soro-blog-article-content">${safeContent}</div>
    </article>
  </div>`;
}

function renderSoroArticleInBlogShell(templateHtml, article, requestUrl, source) {
  const url = new URL(requestUrl);
  const pageUrl = `${url.origin}${soroArticlePath(article.slug)}`;
  const blogUrl = `${url.origin}/blog`;
  const title = `${article.title} · MUSIXQUARE`;
  const description = article.description || 'MUSIXQUARE blog article.';
  const image = soroArticleImageUrl(article, url.origin, source);
  const published = article.pubDate ? new Date(article.pubDate).toISOString() : '';
  const safeContent = sanitizeSoroArticleHtml(article.content);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: article.title,
    description,
    datePublished: published || undefined,
    image,
    url: pageUrl,
    mainEntityOfPage: pageUrl,
    publisher: {
      '@type': 'Organization',
      name: 'MUSIXQUARE',
      url: url.origin,
    },
  };
  const articleHtml = renderSoroArticleBodyHtml(article, image, published, blogUrl, safeContent);

  let html = templateHtml
    .replace('<div id="soro-blog"></div>', `<div id="soro-blog">${articleHtml}</div>`)
    .replace(
      /\n?<script src="https:\/\/app\.trysoro\.com\/api\/embed\/a07c133f-e3b9-401e-a076-ee36124598a7" defer><\/script>/,
      '',
    )
    .replace('<body class="editorial-page editorial-blog">', `<body class="editorial-page editorial-blog" data-soro-source="${esc(source)}">`)
    .replace('<h2>Latest articles</h2>', '<h2>Article</h2>');

  html = replaceHtmlTag(html, /<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  html = replaceHtmlTag(html, /<link rel="canonical" href="[^"]*">/i, `<link rel="canonical" href="${esc(pageUrl)}">`);
  html = replaceHtmlTag(html, /<meta name="description" content="[^"]*">/i, `<meta name="description" content="${esc(description)}">`);
  html = replaceHtmlTag(html, /<meta property="og:title" content="[^"]*">/i, `<meta property="og:title" content="${esc(article.title)}">`);
  html = replaceHtmlTag(html, /<meta property="og:description" content="[^"]*">/i, `<meta property="og:description" content="${esc(description)}">`);
  html = replaceHtmlTag(html, /<meta property="og:type" content="[^"]*">/i, '<meta property="og:type" content="article">');
  html = replaceHtmlTag(html, /<meta property="og:url" content="[^"]*">/i, `<meta property="og:url" content="${esc(pageUrl)}">`);
  html = replaceHtmlTag(html, /<meta property="og:image" content="[^"]*">/i, `<meta property="og:image" content="${esc(image)}">`);
  html = replaceHtmlTag(html, /<meta property="og:image:alt" content="[^"]*">/i, `<meta property="og:image:alt" content="${esc(article.title)}">`);
  html = replaceHtmlTag(html, /<meta name="twitter:title" content="[^"]*">/i, `<meta name="twitter:title" content="${esc(article.title)}">`);
  html = replaceHtmlTag(html, /<meta name="twitter:description" content="[^"]*">/i, `<meta name="twitter:description" content="${esc(description)}">`);
  html = replaceHtmlTag(html, /<meta name="twitter:image" content="[^"]*">/i, `<meta name="twitter:image" content="${esc(image)}">`);
  return html.replace('</head>', `  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>\n</head>`);
}

function renderSoroArticleHtml(article, requestUrl, source, templateHtml = '') {
  if (templateHtml) return renderSoroArticleInBlogShell(templateHtml, article, requestUrl, source);

  const url = new URL(requestUrl);
  const pageUrl = `${url.origin}${soroArticlePath(article.slug)}`;
  const blogUrl = `${url.origin}/blog`;
  const title = `${article.title} · MUSIXQUARE`;
  const description = article.description || 'MUSIXQUARE blog article.';
  const image = soroArticleImageUrl(article, url.origin, source);
  const published = article.pubDate ? new Date(article.pubDate).toISOString() : '';
  const safeContent = sanitizeSoroArticleHtml(article.content);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: article.title,
    description,
    datePublished: published || undefined,
    image,
    url: pageUrl,
    mainEntityOfPage: pageUrl,
    publisher: {
      '@type': 'Organization',
      name: 'MUSIXQUARE',
      url: url.origin,
    },
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#1a1a1a">
  <title>${esc(title)}</title>
  <link rel="canonical" href="${esc(pageUrl)}">
  <link rel="alternate" type="application/rss+xml" title="MUSIXQUARE Blog RSS" href="${esc(String(SORO_RSS_DEFAULT_URL))}">
  <meta name="description" content="${esc(description)}">
  <meta property="og:title" content="${esc(article.title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="MUSIXQUARE">
  <meta property="og:locale" content="en_US">
  <meta property="og:url" content="${esc(pageUrl)}">
  <meta property="og:image" content="${esc(image)}">
  <meta property="og:image:alt" content="${esc(article.title)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(article.title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(image)}">
  <link rel="icon" href="/designsystem/assets/favicon.svg">
  <link rel="preload" href="/designsystem/fonts/PretendardVariable.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/designsystem/src_ref/pretendard.css">
  <link rel="stylesheet" href="/designsystem/colors_and_type.css">
  <link rel="stylesheet" href="/editorial-base.css">
  <style>
    .soro-article-page { max-width: 880px; padding-top: 168px; }
    .soro-article-back { display: inline-flex; margin-bottom: 34px; color: #c6cbd6; font-size: 14px; font-weight: 800; }
    .soro-article-title { margin: 0 0 14px; color: var(--text-main); font-size: clamp(38px, 6vw, 72px); line-height: 1.02; letter-spacing: 0; }
    .soro-article-meta { margin: 0 0 32px; color: #9aa3b2; font-size: 14px; font-weight: 800; }
    .soro-article-image { width: 100%; margin: 0 0 38px; display: block; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 8px; background: var(--surface-2); }
    .soro-article-content { color: #d7dbe4; font-size: 18px; line-height: 1.78; }
    .soro-article-content p { margin: 0 0 18px; color: #d7dbe4; }
    .soro-article-content h2, .soro-article-content h3 { color: var(--text-main); letter-spacing: 0; }
    .soro-article-content h2 { margin: 44px 0 16px; font-size: 31px; line-height: 1.18; }
    .soro-article-content h3 { margin: 32px 0 14px; font-size: 23px; line-height: 1.25; }
    .soro-article-content ul, .soro-article-content ol { margin: 0 0 18px; padding-left: 24px; }
    .soro-article-content li { margin-bottom: 8px; }
    .soro-article-content a { color: #86b7ff; text-decoration: underline; text-underline-offset: 3px; }
    .soro-article-content img { max-width: 100%; height: auto; border-radius: 8px; }
    @media (max-width: 720px) {
      .soro-article-page { padding-top: 118px; }
      .soro-article-content { font-size: 16px; }
      .soro-article-content h2 { font-size: 26px; }
    }
  </style>
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body class="editorial-page editorial-blog" data-soro-source="${esc(source)}">
<header class="lp-header">
  <div class="lp-header-progress" aria-hidden="true"></div>
  <a class="lp-logo" href="https://musixquare.com" aria-label="MUSIXQUARE home">
    <span class="editorial-wordmark" aria-hidden="true"></span>
  </a>
  <a class="lp-try" href="https://musixquare.com" aria-label="Try MUSIXQUARE now">
    <span class="lp-try__dot" aria-hidden="true"></span>
    <span>Try it now</span>
  </a>
</header>
<nav class="editorial-site-tabs" aria-label="MUSIXQUARE editorial pages">
  <div class="editorial-site-tabs__inner">
    <a class="editorial-site-tab" href="/about">About</a>
    <a class="editorial-site-tab is-active" href="/blog" aria-current="page">Blog</a>
    <a class="editorial-site-tab" href="/history">History</a>
    <a class="editorial-site-tab" href="/designsystem">Design</a>
  </div>
</nav>
<main class="page soro-article-page">
  <article>
    <a class="soro-article-back" href="${esc(blogUrl)}">All articles</a>
    <header>
      <h1 class="soro-article-title">${esc(article.title)}</h1>
      ${published ? `<time class="soro-article-meta" datetime="${esc(published)}">${esc(article.pubDate)}</time>` : ''}
    </header>
    ${image ? `<img class="soro-article-image" src="${esc(image)}" alt="${esc(article.title)}">` : ''}
    <div class="soro-article-content">${safeContent}</div>
  </article>
</main>
<footer>
  <span>
    © 2026 MUSIXQUARE
    <span aria-hidden="true">·</span>
    <a href="mailto:contact@musixquare.com">contact@musixquare.com</a>
  </span>
  <span>
    <a href="https://musixquare.com" target="_blank" rel="noopener noreferrer">App</a>
    <a href="https://github.com/hiefny/MUSIXQUARE" target="_blank" rel="noopener noreferrer">GitHub</a>
    <a href="https://discord.gg/PmmFhGTBsX" target="_blank" rel="noopener noreferrer">Discord</a>
  </span>
</footer>
</body>
</html>`;
}

async function serveSoroArticlePage(request, env, slug) {
  const feeds = await loadSoroFeeds(env);
  const { article, source } = findSoroArticle(feeds, slug);
  if (!article) return null;
  const imageStatus = await ensureSoroImageMirror(env, article, { fetchMissing: source === 'live' });

  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': SORO_ARTICLE_HTML_CACHE,
    'X-Soro-Article-Source': source,
    'X-Soro-Backup-Status': feeds.backupStatus || 'unknown',
    'X-Soro-Image-Status': imageStatus,
  };
  if (request.method === 'HEAD') {
    return withSecurityHeaders(new Response(null, { status: 200, headers }), headers);
  }

  const shellResponse = await fetchAsset(env, request, '/blog/index.html');
  const shellContentType = shellResponse.headers.get('content-type') || '';
  const shellHtml = shellContentType.includes('text/html') ? await shellResponse.text() : '';
  return withSecurityHeaders(
    new Response(renderSoroArticleHtml(article, request.url, source, shellHtml), {
      status: 200,
      headers,
    }),
    headers,
  );
}

async function hasSoroArticle(env, slug) {
  const feeds = await loadSoroFeeds(env);
  const { article } = findSoroArticle(feeds, slug);
  return Boolean(article);
}

async function serveSoroBlogIndex(request, env) {
  const response = await fetchAsset(env, request, '/blog/index.html');
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return withSecurityHeaders(response);

  const feeds = await loadSoroFeeds(env);
  const source = feeds.source === 'live' ? 'live' : 'backup';
  const articles = sortedSoroArticles(
    source === 'live' ? feeds.live.articles : feeds.backup.articles,
  );
  const imageStatus = await hydrateSoroListImages(env, articles, source);
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': SORO_ARTICLE_HTML_CACHE,
    'X-Soro-Index-Source': source,
    'X-Soro-Backup-Status': feeds.backupStatus || 'unknown',
    'X-Soro-Image-Status': imageStatus || 'none',
  };

  if (request.method === 'HEAD') {
    return withSecurityHeaders(
      new Response(null, { status: response.status, headers: response.headers }),
      headers,
    );
  }

  const origin = new URL(request.url).origin;
  const blogHtml = renderSoroBlogListHtml(articles, origin, source);
  let html = await response.text();
  html = html
    .replace('<div id="soro-blog"></div>', `<div id="soro-blog">${blogHtml}</div>`)
    .replace(
      /\n?<script src="https:\/\/app\.trysoro\.com\/api\/embed\/a07c133f-e3b9-401e-a076-ee36124598a7" defer><\/script>/,
      '',
    );

  return withSecurityHeaders(
    new Response(html, { status: response.status, headers: response.headers }),
    headers,
  );
}

async function serveSoroImage(request, env, key) {
  if (!env.SORO_IMAGE_BUCKET) {
    return withSecurityHeaders(new Response('Not found', { status: 404 }));
  }

  const object = await env.SORO_IMAGE_BUCKET.get(key);
  if (!object) return withSecurityHeaders(new Response('Not found', { status: 404 }));

  const headers = {
    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
    'Cache-Control': object.httpMetadata?.cacheControl || SORO_IMAGE_CACHE,
  };
  if (object.httpEtag) headers.ETag = object.httpEtag;

  if (request.method === 'HEAD') {
    return withSecurityHeaders(new Response(null, { status: 200, headers }), headers);
  }

  return withSecurityHeaders(new Response(object.body, { status: 200, headers }), headers);
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
    ['/blog', '/blog'],
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
  if (path === '/blog' || path === '/blog/') return '/blog/index.html';
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
    ['/about', '/blog', '/privacy', '/terms', '/faq', '/history', '/designsystem'].includes(
      pathname.toLowerCase().replace(/\/$/, ''),
    )
  ) {
    return {
      'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
    };
  }
  return {};
}

function isLocalHttpHost(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
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

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (url.pathname === '/blog' || url.pathname === '/blog/') {
      const post = url.searchParams.get('post') || '';
      if (isValidSoroSlug(post)) return Response.redirect(new URL(soroArticlePath(post), url), 301);
      return serveSoroBlogIndex(request, env);
    }

    const soroBlogSlug = isPotentialSoroBlogArticlePath(url.pathname);
    if (soroBlogSlug) {
      const canonicalPath = soroArticlePath(soroBlogSlug);
      if (url.pathname !== canonicalPath) return Response.redirect(new URL(canonicalPath, url), 301);
      const articleResponse = await serveSoroArticlePage(request, env, soroBlogSlug);
      return articleResponse || withSecurityHeaders(new Response('Not found', { status: 404 }));
    }

    const soroImageKey = soroImageKeyFromPathname(url.pathname);
    if (soroImageKey) return serveSoroImage(request, env, soroImageKey);

    const soroSlug = isPotentialSoroArticlePath(url.pathname);
    if (soroSlug) {
      if (await hasSoroArticle(env, soroSlug)) {
        return Response.redirect(new URL(soroArticlePath(soroSlug), url), 301);
      }
    }
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
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(loadSoroFeeds(env, { mirrorImages: true }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && !isLocalHttpHost(url.hostname)) {
      url.protocol = 'https:';
      return withSecurityHeaders(Response.redirect(url, 308));
    }

    switch (url.pathname) {
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
