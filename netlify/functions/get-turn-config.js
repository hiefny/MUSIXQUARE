/**
 * Netlify Function: get-turn-config
 *
 * Returns expiring TURN ICE servers to the client for WebRTC relay.
 *
 * Primary provider: Cloudflare Realtime TURN
 *   CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN, CLOUDFLARE_TURN_TTL
 *
 * Fallback provider: Metered.ca Open Relay
 *   TURN_USER, TURN_PASS
 *
 * CORS: same-origin, local dev, and trusted cross-origin (Toss in-app etc.)
 */

const CLOUDFLARE_TURN_TTL_DEFAULT = 172800; // 48 hours, Cloudflare's documented max.
const CLOUDFLARE_TURN_TTL_MIN = 60;
const CLOUDFLARE_TURN_TTL_MAX = 172800;

function jsonResponse(statusCode, body, headers) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function parseTurnTtl() {
  const raw = process.env.CLOUDFLARE_TURN_TTL || process.env.CF_TURN_TTL || '';
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return CLOUDFLARE_TURN_TTL_DEFAULT;
  return Math.min(CLOUDFLARE_TURN_TTL_MAX, Math.max(CLOUDFLARE_TURN_TTL_MIN, parsed));
}

function normalizeUrls(value) {
  const urls = Array.isArray(value) ? value : [value];
  return urls.filter((url) => {
    if (typeof url !== 'string') return false;
    if (!/^(stun|turn|turns):/i.test(url)) return false;
    // Chromium blocks some low-numbered ports from web content. Prefer the
    // standard Cloudflare 3478/5349 entries when the API includes :53 URLs.
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

    const server = {
      urls: urls.length === 1 ? urls[0] : urls,
    };
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

async function getCloudflareIceServers() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID || process.env.CF_TURN_KEY_ID || '';
  const apiToken =
    process.env.CLOUDFLARE_TURN_API_TOKEN ||
    process.env.CF_TURN_API_TOKEN ||
    process.env.CLOUDFLARE_API_TOKEN ||
    '';

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
    body: JSON.stringify({ ttl: parseTurnTtl() }),
  });

  if (!response.ok) {
    throw new Error(`Cloudflare TURN HTTP ${response.status}`);
  }

  const payload = await response.json();
  const iceServers = normalizeIceServers(payload?.iceServers);
  const hasTurn = iceServers.some((server) =>
    normalizeUrls(server.urls).some((url) => /^turns?:/i.test(url)),
  );
  if (!hasTurn) throw new Error('Cloudflare TURN returned no usable TURN servers');

  return {
    provider: 'cloudflare',
    ttl: parseTurnTtl(),
    iceServers,
  };
}

function getMeteredFallbackIceServers() {
  const username = process.env.TURN_USER || '';
  const credential = process.env.TURN_PASS || '';
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

exports.handler = async (event) => {
  const origin = event?.headers?.origin || event?.headers?.Origin || '';
  const host = event?.headers?.host || '';

  // Trusted origins for cross-origin TURN credential requests
  const trustedPatterns = [
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i, // local dev
    /^https:\/\/[^/]*\.toss\.im$/i, // Toss in-app
    /^https:\/\/[^/]*\.toss-internal\.com$/i, // Toss internal
    /^https:\/\/[^/]*\.tossmini\.com$/i, // Apps in Toss WebView (e.g. musixquare.apps.tossmini.com)
    /^https:\/\/musixquare\.netlify\.app$/i, // production
  ];

  const sameOrigin = origin && (origin === `https://${host}` || origin === `http://${host}`);

  // Sec-Fetch-Site is browser-attached (curl / server-side fetchers don't
  // emit it by default), so it's a stronger same-origin signal than Origin
  // alone. Browsers don't always include the Origin header on same-origin
  // GET requests — without this fallback the credential gate would 403
  // legitimate page loads from musixquare.com. The threat model (curl /
  // scraper exfiltrating long-lived TURN creds) stays addressed because
  // those callers don't set Sec-Fetch-Site.
  const fetchSite = (
    event?.headers?.['sec-fetch-site'] ||
    event?.headers?.['Sec-Fetch-Site'] ||
    ''
  ).toLowerCase();
  const browserSameOrigin = fetchSite === 'same-origin';

  const isTrusted = sameOrigin || browserSameOrigin || trustedPatterns.some((p) => p.test(origin));
  const allowOrigin = isTrusted ? origin : '';

  const corsHeaders = allowOrigin
    ? {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        Vary: 'Origin',
      }
    : {};

  if (event?.httpMethod === 'OPTIONS') {
    // Preflight: trusted-origin responses get CORS headers; everything else
    // gets a bare 204 (no Allow-Origin → browser blocks the actual request).
    return { statusCode: 204, headers: { ...corsHeaders, 'Cache-Control': 'no-store' }, body: '' };
  }

  // Gate the credential body on origin trust. CORS alone doesn't stop
  // server-side / curl callers from scraping long-lived TURN credentials.
  if (!isTrusted) {
    return jsonResponse(403, { error: 'Forbidden' });
  }

  try {
    const cloudflareConfig = await getCloudflareIceServers();
    if (cloudflareConfig) return jsonResponse(200, cloudflareConfig, corsHeaders);
  } catch (error) {
    console.warn('[TURN] Cloudflare config failed:', error?.message || error);
  }

  const meteredFallback = getMeteredFallbackIceServers();
  if (meteredFallback) return jsonResponse(200, meteredFallback, corsHeaders);

  return jsonResponse(503, { error: 'TURN_CONFIG_UNAVAILABLE' }, corsHeaders);
};
