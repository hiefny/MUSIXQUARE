/**
 * MUSIXQUARE temporary encrypted file-share Worker.
 *
 * Required bindings:
 * - REMOTE_SHARE_BUCKET: R2 bucket
 * - REMOTE_SHARE_RATE_LIMIT: KV namespace
 *
 * Optional env:
 * - MAX_UPLOAD_BYTES: default 209715200
 * - OBJECT_TTL_SECONDS: default 3600
 * - RATE_LIMIT_WINDOW_SECONDS: default 3600
 * - IP_UPLOADS_PER_WINDOW: default 120
 * - ROOM_UPLOADS_PER_WINDOW: default 60
 * - ALLOWED_ORIGINS: comma-separated origins
 */

const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const DEFAULT_IP_UPLOADS_PER_WINDOW = 120;
const DEFAULT_ROOM_UPLOADS_PER_WINDOW = 60;
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://musixquare.com',
  'https://www.musixquare.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = configured.length > 0 ? new Set(configured) : DEFAULT_ALLOWED_ORIGINS;
  const allowOrigin = allowed.has(origin) ? origin : 'https://musixquare.com';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'POST,GET,DELETE,OPTIONS',
    'access-control-allow-headers':
      'content-type,x-mxqr-name,x-mxqr-mime,x-mxqr-size,x-mxqr-cleanup-token',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(request, env, body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request, env),
      ...extraHeaders,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function parseLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeRoomId(value) {
  const raw = String(value || 'room').slice(0, 64);
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_') || 'room';
}

function decodeHeaderValue(value, fallback = '') {
  if (!value) return fallback;
  try {
    return decodeURIComponent(value);
  } catch {
    return fallback;
  }
}

async function consumeLimit(env, key, limit, ttlSeconds) {
  if (!env.REMOTE_SHARE_RATE_LIMIT) return true;
  const current = Number((await env.REMOTE_SHARE_RATE_LIMIT.get(key)) || '0');
  if (current >= limit) return false;
  await env.REMOTE_SHARE_RATE_LIMIT.put(key, String(current + 1), {
    expirationTtl: ttlSeconds,
  });
  return true;
}

function rateLimited(request, env, message, retryAfterSeconds) {
  return json(
    request,
    env,
    { error: message, retryAfterSeconds },
    429,
    { 'retry-after': String(retryAfterSeconds) },
  );
}

async function handleUpload(request, env) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);

  const maxBytes = parseLimit(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES);
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return json(request, env, { error: 'missing body' }, 400);
  }
  if (contentLength > maxBytes) {
    return json(request, env, { error: 'file too large', maxBytes }, 413);
  }

  const url = new URL(request.url);
  const roomId = safeRoomId(url.searchParams.get('roomId'));
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown';

  const rateWindowSeconds = parseLimit(
    env.RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  );
  const ipUploadLimit = parseLimit(env.IP_UPLOADS_PER_WINDOW, DEFAULT_IP_UPLOADS_PER_WINDOW);
  const roomUploadLimit = parseLimit(env.ROOM_UPLOADS_PER_WINDOW, DEFAULT_ROOM_UPLOADS_PER_WINDOW);

  const ipAllowed = await consumeLimit(env, `ip:${ip}`, ipUploadLimit, rateWindowSeconds);
  if (!ipAllowed) return rateLimited(request, env, 'rate limited', rateWindowSeconds);

  const roomAllowed = await consumeLimit(
    env,
    `room:${roomId}`,
    roomUploadLimit,
    rateWindowSeconds,
  );
  if (!roomAllowed) return rateLimited(request, env, 'room rate limited', rateWindowSeconds);

  const ttlSeconds = parseLimit(env.OBJECT_TTL_SECONDS, DEFAULT_TTL_SECONDS);
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const objectId = crypto.randomUUID();
  const key = `room/${roomId}/${objectId}`;
  const cleanupToken = crypto.randomUUID();
  const name = decodeHeaderValue(request.headers.get('x-mxqr-name'), 'track');
  const mime = request.headers.get('x-mxqr-mime') || 'application/octet-stream';
  const declaredSize = request.headers.get('x-mxqr-size') || '';

  await env.REMOTE_SHARE_BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType: 'application/octet-stream',
      cacheControl: 'no-store',
    },
    customMetadata: {
      roomId,
      name: name.slice(0, 240),
      mime: mime.slice(0, 120),
      sizeBytes: declaredSize,
      expiresAt: String(expiresAt),
      cleanupToken,
    },
  });

  return json(request, env, {
    objectId,
    expiresAt,
    downloadUrl: `${url.origin}/download/${roomId}/${objectId}`,
    cleanupToken,
  });
}

function objectKey(roomId, objectId) {
  const room = safeRoomId(roomId);
  if (!/^[0-9a-f-]{36}$/i.test(objectId)) return null;
  return `room/${room}/${objectId}`;
}

async function handleDownload(request, env, roomId, objectId) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);

  const key = objectKey(roomId, objectId);
  if (!key) return json(request, env, { error: 'not found' }, 404);

  const object = await env.REMOTE_SHARE_BUCKET.get(key);
  if (!object) return json(request, env, { error: 'not found' }, 404);

  const expiresAt = Number(object.customMetadata?.expiresAt || '0');
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    await env.REMOTE_SHARE_BUCKET.delete(key);
    return json(request, env, { error: 'expired' }, 404);
  }

  return new Response(object.body, {
    headers: {
      ...corsHeaders(request, env),
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': String(object.size),
    },
  });
}

async function handleDelete(request, env, roomId, objectId) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);

  const key = objectKey(roomId, objectId);
  if (!key) return json(request, env, { ok: true });

  const object = await env.REMOTE_SHARE_BUCKET.head(key);
  const expected = object?.customMetadata?.cleanupToken;
  const supplied = request.headers.get('x-mxqr-cleanup-token') || '';
  if (expected && supplied && supplied !== expected) {
    return json(request, env, { error: 'forbidden' }, 403);
  }

  await env.REMOTE_SHARE_BUCKET.delete(key);
  return json(request, env, { ok: true });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (request.method === 'POST' && path === '/upload') {
        return handleUpload(request, env);
      }
      const download = path.match(/^\/download\/([^/]+)\/([^/]+)$/);
      if (request.method === 'GET' && download) {
        return handleDownload(request, env, download[1], download[2]);
      }
      const object = path.match(/^\/object\/([^/]+)\/([^/]+)$/);
      if (request.method === 'DELETE' && object) {
        return handleDelete(request, env, object[1], object[2]);
      }
      return json(request, env, { error: 'not found' }, 404);
    } catch (error) {
      return json(
        request,
        env,
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
};
