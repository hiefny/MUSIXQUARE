/**
 * MUSIXQUARE temporary encrypted file-share Worker.
 *
 * Required bindings:
 * - REMOTE_SHARE_BUCKET: R2 bucket
 * - REMOTE_SHARE_RATE_LIMIT: KV namespace
 * - REMOTE_SHARE_SIGNING_SECRET: HMAC secret for upload session tokens
 * - R2_ACCOUNT_ID: Cloudflare account ID for S3 presigned URLs
 * - R2_ACCESS_KEY_ID: R2 S3 API access key ID
 * - R2_SECRET_ACCESS_KEY: R2 S3 API secret access key
 *
 * Optional env:
 * - R2_BUCKET_NAME: default musixquare-remote-share
 * - MAX_UPLOAD_BYTES: default 209715200
 * - OBJECT_TTL_SECONDS: default 3600
 * - UPLOAD_TOKEN_TTL_SECONDS: default 600
 * - RATE_LIMIT_WINDOW_SECONDS: default 3600
 * - IP_UPLOADS_PER_WINDOW: default 60
 * - ROOM_UPLOADS_PER_WINDOW: default 0 (disabled)
 * - ALLOWED_ORIGINS: comma-separated origins
 */

const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_UPLOAD_TOKEN_TTL_SECONDS = 10 * 60;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const DEFAULT_IP_UPLOADS_PER_WINDOW = 60;
const DEFAULT_ROOM_UPLOADS_PER_WINDOW = 0;
const DEFAULT_R2_BUCKET_NAME = 'musixquare-remote-share';
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://musixquare.com',
  'https://www.musixquare.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function configuredAllowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return configured.length > 0 ? new Set(configured) : DEFAULT_ALLOWED_ORIGINS;
}

function allowedRequestOrigin(request, env) {
  const origin = request.headers.get('origin') || '';
  if (!origin) return null;
  const allowed = configuredAllowedOrigins(env);
  return allowed.has(origin) ? origin : null;
}

function corsHeaders(request, env) {
  const allowOrigin = allowedRequestOrigin(request, env) || 'https://musixquare.com';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'POST,GET,DELETE,OPTIONS',
    'access-control-allow-headers':
      'content-type,x-mxqr-name,x-mxqr-mime,x-mxqr-size,x-mxqr-cleanup-token,x-mxqr-session-token',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function originError(request, env) {
  if (allowedRequestOrigin(request, env)) return null;
  return json(request, env, { error: 'forbidden origin' }, 403);
}

function requiresAllowedOrigin(path) {
  return (
    path === '/session' ||
    path === '/complete' ||
    path === '/upload' ||
    /^\/download\/[^/]+\/[^/]+$/.test(path) ||
    /^\/object\/[^/]+\/[^/]+$/.test(path)
  );
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

function parseOptionalLimit(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getSigningSecret(env) {
  const secret = String(env.REMOTE_SHARE_SIGNING_SECRET || '').trim();
  return secret.length >= 32 ? secret : null;
}

function getR2S3Config(env) {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucketName = String(env.R2_BUCKET_NAME || DEFAULT_R2_BUCKET_NAME).trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) return null;
  return { accountId, accessKeyId, secretAccessKey, bucketName };
}

function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(value.length / 4) * 4,
    '=',
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importSigningKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function hmacBytes(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      typeof data === 'string' ? new TextEncoder().encode(data) : data,
    ),
  );
}

async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return hex(new Uint8Array(hash));
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeObjectPath(path) {
  return path.split('/').map(awsEncode).join('/');
}

function amzDateParts(now) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function canonicalQuery(params) {
  return [...params]
    .sort(([keyA, valueA], [keyB, valueB]) =>
      keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB),
    )
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join('&');
}

function canonicalHeaderValue(value) {
  return String(value).trim().replace(/\s+/g, ' ');
}

async function createR2PresignedPutUrl({ env, objectKey: key, headers, expiresInSeconds, now }) {
  const config = getR2S3Config(env);
  if (!config) return null;

  const { accountId, accessKeyId, secretAccessKey, bucketName } = config;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = amzDateParts(now);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const canonicalUri = `/${awsEncode(bucketName)}/${encodeObjectPath(key)}`;
  const signedHeaderEntries = {
    ...headers,
    host,
  };
  const signedHeaderNames = Object.keys(signedHeaderEntries)
    .map((header) => header.toLowerCase())
    .sort();
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalHeaders = signedHeaderNames
    .map((header) => `${header}:${canonicalHeaderValue(signedHeaderEntries[header])}\n`)
    .join('');
  const queryParams = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresInSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ];
  const query = canonicalQuery(queryParams);
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const encoder = new TextEncoder();
  const dateKey = await hmacBytes(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
  const regionKey = await hmacBytes(dateKey, 'auto');
  const serviceKey = await hmacBytes(regionKey, 's3');
  const signingKey = await hmacBytes(serviceKey, 'aws4_request');
  const signature = hex(await hmacBytes(signingKey, stringToSign));

  return `https://${host}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}

async function createSignedToken(payload, secret) {
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(encodedPayload),
  );
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

async function verifySignedToken(token, secret) {
  try {
    const [encodedPayload, encodedSignature] = String(token || '').split('.');
    if (!encodedPayload || !encodedSignature) return null;

    const key = await importSigningKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(encodedSignature),
      new TextEncoder().encode(encodedPayload),
    );
    if (!valid) return null;

    return JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
  } catch {
    return null;
  }
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

function metadataString(value, fallback = '') {
  const raw = String(value || fallback).replace(/[\r\n]/g, ' ').trim();
  return encodeURIComponent(raw).slice(0, 512) || fallback;
}

function readMetadata(object, ...keys) {
  const metadata = object?.customMetadata || {};
  for (const key of keys) {
    if (metadata[key] !== undefined) return metadata[key];
  }
  return undefined;
}

async function consumeLimit(env, key, limit, ttlSeconds) {
  if (!env.REMOTE_SHARE_RATE_LIMIT) return true;
  try {
    const current = Number((await env.REMOTE_SHARE_RATE_LIMIT.get(key)) || '0');
    if (current >= limit) return false;
    await env.REMOTE_SHARE_RATE_LIMIT.put(key, String(current + 1), {
      expirationTtl: ttlSeconds,
    });
    return true;
  } catch (error) {
    console.warn('remote share rate-limit storage unavailable', error);
    return false;
  }
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

async function handleSession(request, env) {
  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json(request, env, { error: 'invalid json' }, 400);
  }

  const roomId = safeRoomId(body?.roomId);
  const sessionId = Number(body?.sessionId);
  const index = Number(body?.index);
  const size = Number(body?.size);
  const encryptedSize = Number(body?.encryptedSize);
  const maxBytes = parseLimit(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES);
  const maxEncryptedBytes = maxBytes + 4096;

  if (
    !Number.isFinite(sessionId) ||
    !Number.isFinite(index) ||
    index < 0 ||
    !Number.isFinite(size) ||
    size <= 0 ||
    size > maxBytes ||
    !Number.isFinite(encryptedSize) ||
    encryptedSize <= 0 ||
    encryptedSize > maxEncryptedBytes
  ) {
    return json(request, env, { error: 'invalid upload session request' }, 400);
  }

  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown';
  const rateWindowSeconds = parseLimit(
    env.RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  );
  const ipUploadLimit = parseLimit(env.IP_UPLOADS_PER_WINDOW, DEFAULT_IP_UPLOADS_PER_WINDOW);
  const roomUploadLimit = parseOptionalLimit(
    env.ROOM_UPLOADS_PER_WINDOW,
    DEFAULT_ROOM_UPLOADS_PER_WINDOW,
  );

  const ipAllowed = await consumeLimit(env, `session-ip:${ip}`, ipUploadLimit, rateWindowSeconds);
  if (!ipAllowed) return rateLimited(request, env, 'rate limited', rateWindowSeconds);

  if (roomUploadLimit > 0) {
    const roomAllowed = await consumeLimit(
      env,
      `session-room:${roomId}`,
      roomUploadLimit,
      rateWindowSeconds,
    );
    if (!roomAllowed) return rateLimited(request, env, 'room rate limited', rateWindowSeconds);
  }

  const ttlSeconds = parseLimit(env.UPLOAD_TOKEN_TTL_SECONDS, DEFAULT_UPLOAD_TOKEN_TTL_SECONDS);
  const now = Date.now();
  const uploadUrlExpiresAt = now + ttlSeconds * 1000;
  const objectTtlSeconds = parseLimit(env.OBJECT_TTL_SECONDS, DEFAULT_TTL_SECONDS);
  const expiresAt = now + objectTtlSeconds * 1000;
  const objectId = crypto.randomUUID();
  const objectKeyValue = `room/${roomId}/${objectId}`;
  const cleanupToken = crypto.randomUUID();
  const name = metadataString(body?.name, 'track');
  const mime = metadataString(body?.mime, 'application/octet-stream');
  const uploadHeaders = {
    'content-type': 'application/octet-stream',
    'x-amz-meta-cleanup-token': cleanupToken,
    'x-amz-meta-expires-at': String(expiresAt),
    'x-amz-meta-mime': mime,
    'x-amz-meta-name': name,
    'x-amz-meta-room-id': roomId,
    'x-amz-meta-size-bytes': String(size),
  };
  const uploadUrl = await createR2PresignedPutUrl({
    env,
    objectKey: objectKeyValue,
    headers: uploadHeaders,
    expiresInSeconds: ttlSeconds,
    now: new Date(now),
  });
  if (!uploadUrl) return json(request, env, { error: 'r2 s3 config missing' }, 500);

  const legacyToken = await createSignedToken(
    {
      v: 1,
      roomId,
      sessionId,
      index,
      size,
      encryptedSize,
      iat: now,
      exp: uploadUrlExpiresAt,
      nonce: crypto.randomUUID(),
    },
    secret,
  );
  const completeToken = await createSignedToken(
    {
      v: 2,
      kind: 'complete',
      roomId,
      objectId,
      objectKey: objectKeyValue,
      sessionId,
      index,
      size,
      encryptedSize,
      expiresAt,
      cleanupToken,
      iat: now,
      exp: uploadUrlExpiresAt,
      nonce: crypto.randomUUID(),
    },
    secret,
  );

  const url = new URL(request.url);
  return json(request, env, {
    token: legacyToken,
    uploadUrl,
    uploadHeaders,
    uploadUrlExpiresAt,
    completeToken,
    objectId,
    expiresAt,
    downloadUrl: `${url.origin}/download/${roomId}/${objectId}`,
    cleanupToken,
  });
}

async function handleComplete(request, env) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);

  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json(request, env, { error: 'invalid json' }, 400);
  }

  const payload = await verifySignedToken(body?.completeToken, secret);
  const roomId = safeRoomId(body?.roomId);
  const objectId = String(body?.objectId || '');
  const now = Date.now();
  if (
    !payload ||
    payload.v !== 2 ||
    payload.kind !== 'complete' ||
    payload.roomId !== roomId ||
    payload.objectId !== objectId ||
    !Number.isFinite(Number(payload.exp)) ||
    Number(payload.exp) < now
  ) {
    return json(request, env, { error: 'invalid upload completion' }, 403);
  }

  const key = objectKey(roomId, objectId);
  if (!key || key !== payload.objectKey) return json(request, env, { error: 'not found' }, 404);

  const object = await env.REMOTE_SHARE_BUCKET.head(key);
  if (!object) return json(request, env, { error: 'not found' }, 404);

  const expectedSize = Number(payload.encryptedSize);
  const maxBytes = parseLimit(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES);
  const maxEncryptedBytes = maxBytes + 4096;
  if (
    !Number.isFinite(expectedSize) ||
    object.size !== expectedSize ||
    object.size > maxEncryptedBytes
  ) {
    await env.REMOTE_SHARE_BUCKET.delete(key);
    return json(request, env, { error: 'invalid uploaded object' }, 403);
  }

  const expiresAt = Number(payload.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < now) {
    await env.REMOTE_SHARE_BUCKET.delete(key);
    return json(request, env, { error: 'expired' }, 404);
  }

  const url = new URL(request.url);
  return json(request, env, {
    objectId,
    expiresAt,
    downloadUrl: `${url.origin}/download/${roomId}/${objectId}`,
    cleanupToken: payload.cleanupToken,
  });
}

async function validateUploadSession(request, env, roomId, contentLength, maxEncryptedBytes) {
  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);

  const token = request.headers.get('x-mxqr-session-token') || '';
  const payload = await verifySignedToken(token, secret);
  if (!payload || payload.v !== 1) {
    return json(request, env, { error: 'invalid upload session' }, 403);
  }

  const now = Date.now();
  const encryptedSize = Number(payload.encryptedSize);
  if (
    payload.roomId !== roomId ||
    !Number.isFinite(Number(payload.sessionId)) ||
    !Number.isFinite(Number(payload.index)) ||
    !Number.isFinite(encryptedSize) ||
    encryptedSize !== contentLength ||
    encryptedSize > maxEncryptedBytes ||
    !Number.isFinite(Number(payload.exp)) ||
    Number(payload.exp) < now ||
    typeof payload.nonce !== 'string'
  ) {
    return json(request, env, { error: 'invalid upload session' }, 403);
  }

  if (env.REMOTE_SHARE_RATE_LIMIT) {
    const replayKey = `upload-token:${payload.nonce}`;
    const used = await env.REMOTE_SHARE_RATE_LIMIT.get(replayKey);
    if (used) return json(request, env, { error: 'upload session already used' }, 403);
    const replayTtlSeconds = Math.max(60, Math.ceil((Number(payload.exp) - now) / 1000));
    await env.REMOTE_SHARE_RATE_LIMIT.put(replayKey, '1', {
      expirationTtl: replayTtlSeconds,
    });
  }

  return null;
}

async function handleUpload(request, env) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);

  const maxBytes = parseLimit(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES);
  const maxEncryptedBytes = maxBytes + 4096;
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return json(request, env, { error: 'missing body' }, 400);
  }
  if (contentLength > maxEncryptedBytes) {
    return json(request, env, { error: 'file too large', maxBytes }, 413);
  }

  const url = new URL(request.url);
  const roomId = safeRoomId(url.searchParams.get('roomId'));
  const invalidSession = await validateUploadSession(
    request,
    env,
    roomId,
    contentLength,
    maxEncryptedBytes,
  );
  if (invalidSession) return invalidSession;

  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown';

  const rateWindowSeconds = parseLimit(
    env.RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  );
  const ipUploadLimit = parseLimit(env.IP_UPLOADS_PER_WINDOW, DEFAULT_IP_UPLOADS_PER_WINDOW);
  const roomUploadLimit = parseOptionalLimit(
    env.ROOM_UPLOADS_PER_WINDOW,
    DEFAULT_ROOM_UPLOADS_PER_WINDOW,
  );

  const ipAllowed = await consumeLimit(env, `ip:${ip}`, ipUploadLimit, rateWindowSeconds);
  if (!ipAllowed) return rateLimited(request, env, 'rate limited', rateWindowSeconds);

  if (roomUploadLimit > 0) {
    const roomAllowed = await consumeLimit(
      env,
      `room:${roomId}`,
      roomUploadLimit,
      rateWindowSeconds,
    );
    if (!roomAllowed) return rateLimited(request, env, 'room rate limited', rateWindowSeconds);
  }

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

  const maxBytes = parseLimit(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES);
  if (object.size > maxBytes + 4096) {
    await env.REMOTE_SHARE_BUCKET.delete(key);
    return json(request, env, { error: 'file too large', maxBytes }, 413);
  }

  const expiresAt = Number(
    readMetadata(object, 'expiresAt', 'expires-at', 'expiresat') || '0',
  );
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
  const expected = readMetadata(object, 'cleanupToken', 'cleanup-token', 'cleanuptoken');
  const supplied = request.headers.get('x-mxqr-cleanup-token') || '';
  if (expected && supplied && supplied !== expected) {
    return json(request, env, { error: 'forbidden' }, 403);
  }

  await env.REMOTE_SHARE_BUCKET.delete(key);
  return json(request, env, { ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      if (requiresAllowedOrigin(path)) {
        const badOrigin = originError(request, env);
        if (badOrigin) return badOrigin;
      }
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (requiresAllowedOrigin(path)) {
        const badOrigin = originError(request, env);
        if (badOrigin) return badOrigin;
      }

      if (request.method === 'POST' && path === '/session') {
        return handleSession(request, env);
      }
      if (request.method === 'POST' && path === '/complete') {
        return handleComplete(request, env);
      }
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
