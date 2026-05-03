/**
 * Netlify Function: cloudflare-realtime
 *
 * Minimal same-origin proxy for Cloudflare Realtime SFU. The browser sends
 * SDP/session operations here; the Cloudflare App Secret stays server-side.
 */

const REALTIME_API_BASE = 'https://rtc.live.cloudflare.com/v1';

function jsonResponse(statusCode, body, headers = {}) {
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

function getCorsHeaders(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || '';
  const host = event?.headers?.host || '';
  const fetchSite = (
    event?.headers?.['sec-fetch-site'] ||
    event?.headers?.['Sec-Fetch-Site'] ||
    ''
  ).toLowerCase();

  const trustedPatterns = [
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i,
    /^https:\/\/[^/]*\.toss\.im$/i,
    /^https:\/\/[^/]*\.toss-internal\.com$/i,
    /^https:\/\/[^/]*\.tossmini\.com$/i,
    /^https:\/\/musixquare\.netlify\.app$/i,
  ];

  const sameOrigin = origin && (origin === `https://${host}` || origin === `http://${host}`);
  const browserSameOrigin = fetchSite === 'same-origin';
  const isTrusted = sameOrigin || browserSameOrigin || trustedPatterns.some((p) => p.test(origin));
  const allowOrigin = isTrusted ? origin : '';

  return {
    isTrusted,
    headers: allowOrigin
      ? {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          Vary: 'Origin',
        }
      : {},
  };
}

function getRealtimeEnv() {
  return {
    appId:
      process.env.CLOUDFLARE_REALTIME_APP_ID ||
      process.env.CLOUDFLARE_CALLS_APP_ID ||
      process.env.CLOUDFLARE_SFU_APP_ID ||
      '',
    appSecret:
      process.env.CLOUDFLARE_REALTIME_APP_SECRET ||
      process.env.CLOUDFLARE_REALTIME_API_TOKEN ||
      process.env.CLOUDFLARE_CALLS_APP_SECRET ||
      process.env.CLOUDFLARE_CALLS_API_TOKEN ||
      process.env.CLOUDFLARE_SFU_APP_SECRET ||
      process.env.CLOUDFLARE_SFU_API_TOKEN ||
      '',
  };
}

function parseBody(event) {
  if (!event?.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
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

exports.handler = async (event) => {
  const { isTrusted, headers } = getCorsHeaders(event);

  if (event?.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...headers, 'Cache-Control': 'no-store' }, body: '' };
  }

  if (event?.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, headers);
  }

  if (!isTrusted) {
    return jsonResponse(403, { error: 'Forbidden' }, headers);
  }

  const { appId, appSecret } = getRealtimeEnv();
  if (!appId || !appSecret) {
    return jsonResponse(503, { error: 'REALTIME_SFU_UNAVAILABLE' }, headers);
  }

  const body = parseBody(event);
  if (!body || typeof body !== 'object') {
    return jsonResponse(400, { error: 'Invalid JSON body' }, headers);
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const request = buildRealtimeRequest(action, appId, sessionId, body.correlationId);
  if (!request) {
    return jsonResponse(400, { error: 'Unsupported action' }, headers);
  }
  if (action !== 'new-session' && !sessionId) {
    return jsonResponse(400, { error: 'Missing sessionId' }, headers);
  }

  try {
    const outboundPayload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const requestBody = shouldSendPayloadBody(action, outboundPayload)
      ? JSON.stringify(outboundPayload)
      : undefined;
    const cfResponse = await fetch(request.url, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${appSecret}`,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });

    const text = await cfResponse.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    return jsonResponse(cfResponse.status, payload, headers);
  } catch (error) {
    return jsonResponse(
      502,
      { error: 'CLOUDFLARE_REALTIME_PROXY_FAILED', message: error?.message || String(error) },
      headers,
    );
  }
};
