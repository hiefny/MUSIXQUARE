/**
 * Netlify Function: youtube-search
 *
 * Same-origin YouTube Data API search proxy. Keeps the API key server-side
 * and only exposes the compact fields the client needs for queue selection.
 */

const YOUTUBE_SEARCH_API = 'https://www.googleapis.com/youtube/v3/search';
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_LIMIT = 12;
const QUERY_MAX_LENGTH = 120;

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
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          Vary: 'Origin',
        }
      : {},
  };
}

function clampMaxResults(raw) {
  const envDefault = Number.parseInt(process.env.YOUTUBE_SEARCH_MAX_RESULTS || '', 10);
  const fallback = Number.isFinite(envDefault) ? envDefault : DEFAULT_MAX_RESULTS;
  const parsed = Number.parseInt(raw || String(fallback), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_RESULTS_LIMIT, Math.max(1, parsed));
}

function getApiKey() {
  return process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_DATA_API_KEY || '';
}

function normalizeUpstreamError(payload) {
  const firstError = payload?.error?.errors?.[0] || {};
  const reason = firstError.reason || payload?.error?.status || 'unknown';
  const message = firstError.message || payload?.error?.message || '';
  return { reason, message };
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

      const title = typeof snippet.title === 'string' ? snippet.title : '';
      const channelTitle = typeof snippet.channelTitle === 'string' ? snippet.channelTitle : '';
      const publishedAt = typeof snippet.publishedAt === 'string' ? snippet.publishedAt : '';
      const thumbnailUrl = getBestThumbnail(snippet.thumbnails);

      return {
        videoId,
        title,
        channelTitle,
        thumbnailUrl,
        publishedAt,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      };
    })
    .filter(Boolean);
}

exports.handler = async (event) => {
  const { isTrusted, headers } = getCorsHeaders(event);

  if (event?.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...headers, 'Cache-Control': 'no-store' }, body: '' };
  }

  if (event?.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' }, headers);
  }

  if (!isTrusted) {
    return jsonResponse(403, { error: 'Forbidden' }, headers);
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return jsonResponse(503, { error: 'YOUTUBE_SEARCH_UNAVAILABLE' }, headers);
  }

  const query = String(event?.queryStringParameters?.q || '').trim().slice(0, QUERY_MAX_LENGTH);
  if (!query) {
    return jsonResponse(400, { error: 'Missing query' }, headers);
  }

  const params = new URLSearchParams({
    key: apiKey,
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    safeSearch: process.env.YOUTUBE_SAFE_SEARCH || 'moderate',
    maxResults: String(clampMaxResults(event?.queryStringParameters?.maxResults)),
    q: query,
    fields:
      'items(id/videoId,snippet/title,snippet/channelTitle,snippet/publishedAt,snippet/thumbnails)',
  });

  const regionCode = process.env.YOUTUBE_REGION_CODE || '';
  const relevanceLanguage = process.env.YOUTUBE_RELEVANCE_LANGUAGE || '';
  if (/^[A-Za-z]{2}$/.test(regionCode)) params.set('regionCode', regionCode.toUpperCase());
  if (/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(relevanceLanguage)) {
    params.set('relevanceLanguage', relevanceLanguage);
  }

  try {
    const response = await fetch(`${YOUTUBE_SEARCH_API}?${params.toString()}`);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const upstreamError = normalizeUpstreamError(payload);
      return jsonResponse(
        getClientStatusForUpstreamError(response.status, upstreamError.reason),
        {
          error: 'YOUTUBE_SEARCH_FAILED',
          upstreamStatus: response.status,
          reason: upstreamError.reason,
          message: upstreamError.message,
        },
        headers,
      );
    }

    return jsonResponse(
      200,
      {
        query,
        results: normalizeResults(payload.items),
      },
      headers,
    );
  } catch (error) {
    return jsonResponse(
      502,
      { error: 'YOUTUBE_SEARCH_PROXY_FAILED', message: error?.message || String(error) },
      headers,
    );
  }
};
