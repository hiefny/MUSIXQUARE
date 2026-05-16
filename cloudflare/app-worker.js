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

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://img.youtube.com https://i.ytimg.com; media-src 'self' blob: https://demo.musixquare.com; connect-src 'self' blob: wss://0.peerjs.com:443 https://0.peerjs.com:443 wss://*.peerjs.com https://*.peerjs.com https://www.youtube.com https://musixquare.com https://demo.musixquare.com https://*.musixquare.com wss://*.musixquare.com https://*.workers.dev wss://*.workers.dev https://*.r2.cloudflarestorage.com; frame-src https://www.youtube.com; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'",
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

function trustedCors(request, methods) {
  const origin = request.headers.get('Origin') || '';
  const host = request.headers.get('Host') || '';
  const fetchSite = (request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  const trustedPatterns = [
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i,
    /^https:\/\/[^/]*\.toss\.im$/i,
    /^https:\/\/[^/]*\.toss-internal\.com$/i,
    /^https:\/\/[^/]*\.tossmini\.com$/i,
    /^https:\/\/musixquare\.netlify\.app$/i,
    /^https:\/\/musixquare\.com$/i,
    /^https:\/\/[^/]*\.musixquare\.com$/i,
    /^https:\/\/[^/]*\.workers\.dev$/i,
    /^https:\/\/[^/]*\.pages\.dev$/i,
  ];

  const sameOrigin = origin && (origin === `https://${host}` || origin === `http://${host}`);
  const browserSameOrigin = fetchSite === 'same-origin';
  const isTrusted =
    sameOrigin || browserSameOrigin || trustedPatterns.some((pattern) => pattern.test(origin));
  const allowOrigin = isTrusted ? origin : '';

  return {
    isTrusted,
    headers: allowOrigin
      ? {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Methods': methods,
          'Access-Control-Allow-Headers': 'Content-Type',
          Vary: 'Origin',
        }
      : {},
  };
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
  const { isTrusted, headers } = trustedCors(request, 'GET, OPTIONS');
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  if (!isTrusted) return json({ error: 'Forbidden' }, 403, headers);

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
  const { isTrusted, headers } = trustedCors(request, 'GET, OPTIONS');
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  if (!isTrusted) return json({ error: 'Forbidden' }, 403, headers);

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
  const { isTrusted, headers } = trustedCors(request, 'POST, OPTIONS');
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
  if (!isTrusted) return json({ error: 'Forbidden' }, 403, headers);

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
  const html = rewriteInviteMeta(await response.text(), code, new URL(request.url).origin);
  return withSecurityHeaders(
    new Response(html, { status: response.status, headers: response.headers }),
    {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60, s-maxage=900',
      'X-Invite-Rewrite': code,
    },
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
  if (inviteMatch && request.method === 'GET') {
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

  if (
    response.status === 404 &&
    request.method === 'GET' &&
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
      case '/.netlify/functions/youtube-search':
      case '/api/youtube-search':
        return handleYoutubeSearch(request, env);
      case '/.netlify/functions/get-turn-config':
      case '/api/get-turn-config':
        return handleTurnConfig(request, env);
      case '/.netlify/functions/cloudflare-realtime':
      case '/api/cloudflare-realtime':
        return handleRealtime(request, env);
      default:
        return serveStatic(request, env);
    }
  },
};
