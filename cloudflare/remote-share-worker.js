/**
 * MUSIXQUARE encrypted file-share Worker.
 *
 * Required bindings:
 * - REMOTE_SHARE_BUCKET: R2 bucket
 * - REMOTE_SHARE_RATE_LIMIT: KV namespace
 * - REMOTE_SHARE_QUOTA: per-room Durable Object namespace when quota is enabled
 * - REMOTE_SHARE_SIGNING_SECRET: HMAC secret for upload session tokens
 * - R2_ACCOUNT_ID: Cloudflare account ID for S3 presigned URLs
 * - R2_ACCESS_KEY_ID: R2 S3 API access key ID
 * - R2_SECRET_ACCESS_KEY: R2 S3 API secret access key
 *
 * Optional env:
 * - R2_BUCKET_NAME: default musixquare-remote-share
 * - OBJECT_TTL_SECONDS: default 3600
 * - UPLOAD_TOKEN_TTL_SECONDS: presigned PUT start window, default 600
 * - RATE_LIMIT_WINDOW_SECONDS: default 3600
 * - IP_UPLOADS_PER_WINDOW: default 60
 * - ROOM_UPLOADS_PER_WINDOW: default 0 (disabled)
 * - ROOM_STORAGE_QUOTA_BYTES: default 0 (disabled). Production uses 1 GiB.
 * - ALLOWED_ORIGINS: comma-separated origins
 * - MXQR_CAPABILITY_SECRET: required for /session in production. When unset
 *     /session returns 503 CAPABILITY_NOT_CONFIGURED unless the dangerous
 *     MXQR_ALLOW_UNGUARDED_REMOTE_SHARE override is set.
 * - REMOTE_SHARE_CAPABILITY_SECRET: optional override for /session capability HMAC
 *
 * Dangerous bypass flags (asserted by scripts/assert-production-security-config.mjs):
 * - MXQR_ALLOW_UNGUARDED_REMOTE_SHARE: permit /session without capability when
 *     no secret is configured. Local/emergency only.
 */

// Cross-layer contract: client selection, protocol descriptors, AES-GCM output,
// and stored-object validation all use this fixed 200 MiB plaintext ceiling.
const REMOTE_SHARE_MAX_BYTES = 200 * 1024 * 1024;
const AES_GCM_TAG_BYTES = 16;
const REMOTE_SHARE_MAX_ENCRYPTED_BYTES = REMOTE_SHARE_MAX_BYTES + AES_GCM_TAG_BYTES;
const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_UPLOAD_TOKEN_TTL_SECONDS = 10 * 60;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const DEFAULT_IP_UPLOADS_PER_WINDOW = 60;
const DEFAULT_ROOM_UPLOADS_PER_WINDOW = 0;
const DEFAULT_ROOM_STORAGE_QUOTA_BYTES = 0;
const ROOM_STORAGE_LIST_PAGE_SIZE = 1000;
const ROOM_STORAGE_SCAN_MAX_OBJECTS = 2000;
const DEFAULT_R2_BUCKET_NAME = 'musixquare-remote-share';
const CAPABILITY_SCOPE = 'remote-share';
const CAPABILITY_TOKEN_TTL_DEFAULT = 600;
const SESSION_JSON_BODY_MAX_BYTES = 8 * 1024;
const COMPLETE_JSON_BODY_MAX_BYTES = 8 * 1024;
const QUOTA_JSON_BODY_MAX_BYTES = 4 * 1024;
const QUOTA_STATE_KEY = 'quota-state';
const QUOTA_STATE_VERSION = 1;
const QUOTA_STATE_MAX_ENTRIES = ROOM_STORAGE_SCAN_MAX_OBJECTS;
const QUOTA_ALARM_RETRY_MS = 60 * 1000;
// Standard ephemeral rooms are generated only in the 100000-999999 range.
// The complete 0xxxxx namespace belongs to persistent PRO rooms and must never
// share this temporary encrypted-object bucket or its per-room quota keys.
const STANDARD_ROOM_CODE_RE = /^[1-9]\d{5}$/;
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://musixquare.com',
  'https://www.musixquare.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

const DEFAULT_ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/(?:[^/]+\.)?tossmini\.com$/i,
  /^https:\/\/(?:[^/]+\.)?toss\.im$/i,
  /^https:\/\/(?:[^/]+\.)?toss-internal\.com$/i,
];
const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

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
  if (allowed.has(origin)) return origin;
  return DEFAULT_ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin)) ? origin : null;
}

function corsHeaders(request, env) {
  const allowOrigin = allowedRequestOrigin(request, env) || 'https://musixquare.com';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'POST,GET,DELETE,OPTIONS',
    'access-control-allow-headers':
      'content-type,authorization,x-mxqr-capability,x-mxqr-cleanup-token',
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
    path === '/security-config' ||
    path === '/complete' ||
    /^\/download\/[^/]+\/[^/]+$/.test(path) ||
    /^\/object\/[^/]+\/[^/]+$/.test(path)
  );
}

function json(request, env, body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...corsHeaders(request, env),
      ...extraHeaders,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function readJsonBodyLimited(request, maxBytes) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!/^\d+$/.test(normalized)) return { error: 'invalid' };
    if (Number(normalized) > maxBytes) return { error: 'too-large' };
  }

  if (!request.body) return { error: 'invalid' };
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('JSON_BODY_TOO_LARGE').catch(() => {});
        return { error: 'too-large' };
      }
      chunks.push(bytes);
    }
  } catch {
    return { error: 'invalid' };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) return { error: 'invalid' };
  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes)) };
  } catch {
    return { error: 'invalid' };
  }
}

function jsonBodyError(request, env, result) {
  if (result.error === 'too-large') {
    return json(request, env, { error: 'request body too large' }, 413);
  }
  return json(request, env, { error: 'invalid json' }, 400);
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

function getCapabilitySecret(env) {
  return String(
    env.REMOTE_SHARE_CAPABILITY_SECRET ||
      env.MXQR_CAPABILITY_SECRET ||
      env.CAPABILITY_HMAC_SECRET ||
      env.CAPABILITY_SECRET ||
      '',
  ).trim();
}

function isCapabilityRequired(env) {
  return !!getCapabilitySecret(env);
}

function allowUnguardedRemoteShare(env) {
  const raw = String(
    env.MXQR_ALLOW_UNGUARDED_REMOTE_SHARE ?? env.ALLOW_UNGUARDED_REMOTE_SHARE ?? 'false',
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
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
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlToString(value) {
  return new TextDecoder().decode(base64UrlDecode(value));
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

async function hmacSha256(secret, value) {
  return base64UrlEncode(await hmacBytes(new TextEncoder().encode(secret), value));
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

function getClientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown'
  );
}

async function capabilityIpHash(secret, request) {
  return hmacSha256(secret, `ip:${getClientIp(request)}`);
}

async function rateLimitIpKey(secret, request) {
  const digest = await hmacSha256(secret, `rate-limit-ip:${getClientIp(request)}`);
  return `session-ip:${digest}`;
}

function readCapabilityToken(request) {
  const headerToken =
    request.headers.get('x-mxqr-capability') || request.headers.get('X-MXQR-Capability') || '';
  if (headerToken) return headerToken.trim();
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function verifyCapabilityToken(token, request, env) {
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
  if (!Array.isArray(payload.scopes) || !payload.scopes.includes(CAPABILITY_SCOPE)) return false;
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return false;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return false;

  const expectedIp = await capabilityIpHash(secret, request);
  return constantTimeEqual(String(payload.ip || ''), expectedIp);
}

async function requireSessionCapability(request, env) {
  if (!isCapabilityRequired(env)) {
    // Parity with app-worker.guardSensitiveRequest: a missing capability
    // secret is a production-config error, not a license to bypass. Run-mode
    // override is the only escape so operators don't silently ship an
    // unguarded /session endpoint.
    if (allowUnguardedRemoteShare(env)) return null;
    return json(request, env, { error: 'CAPABILITY_NOT_CONFIGURED' }, 503);
  }
  if (await verifyCapabilityToken(readCapabilityToken(request), request, env)) return null;
  return json(request, env, { error: 'CAPABILITY_REQUIRED' }, 401);
}

function handleSecurityConfig(request, env) {
  return json(request, env, {
    capabilityRequired: isCapabilityRequired(env),
    scope: CAPABILITY_SCOPE,
    ttl: CAPABILITY_TOKEN_TTL_DEFAULT,
  });
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
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
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
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join(
    '\n',
  );

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
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload));
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

function standardRoomId(value) {
  return typeof value === 'string' && STANDARD_ROOM_CODE_RE.test(value) ? value : null;
}

function metadataString(value, fallback = '') {
  const raw = String(value || fallback)
    .replace(/[\r\n]/g, ' ')
    .trim();
  return encodeURIComponent(raw).slice(0, 512) || fallback;
}

const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeQueueItemId(value) {
  const queueItemId = String(value || '');
  return QUEUE_ITEM_ID_RE.test(queueItemId) ? queueItemId : '';
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

function roomStorageQuotaBytes(env) {
  return parseOptionalLimit(env.ROOM_STORAGE_QUOTA_BYTES, DEFAULT_ROOM_STORAGE_QUOTA_BYTES);
}

function atomicRoomStorageQuotaEnabled(env) {
  return (
    roomStorageQuotaBytes(env) > 0 &&
    String(env.REMOTE_SHARE_ATOMIC_QUOTA_ENABLED ?? 'true').toLowerCase() !== 'false'
  );
}

async function deleteBucketKeysInChunks(bucket, keys) {
  for (let offset = 0; offset < keys.length; offset += ROOM_STORAGE_LIST_PAGE_SIZE) {
    const chunk = keys.slice(offset, offset + ROOM_STORAGE_LIST_PAGE_SIZE);
    try {
      await bucket.delete(chunk);
    } catch (error) {
      console.warn('remote share stale object cleanup failed', error);
      // Do not admit another upload while expired objects still consume real
      // R2 storage. The caller converts this into a temporary 503 response.
      throw error;
    }
  }
}

async function inspectRoomStorage(bucket, roomId, now) {
  const prefix = `room/${roomId}/`;
  const staleKeys = [];
  const activeKeys = new Set();
  let cursor;
  let scannedObjects = 0;
  let totalBytes = 0;
  let saturated = false;

  do {
    const page = await bucket.list({
      prefix,
      limit: ROOM_STORAGE_LIST_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      include: ['customMetadata'],
    });
    for (const object of page?.objects || []) {
      scannedObjects += 1;
      if (scannedObjects > ROOM_STORAGE_SCAN_MAX_OBJECTS) {
        saturated = true;
        break;
      }
      const expiresAt = Number(readMetadata(object, 'expiresAt', 'expires-at', 'expiresat'));
      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        staleKeys.push(object.key);
        continue;
      }
      const size = Number(object?.size);
      if (Number.isSafeInteger(size) && size > 0) {
        totalBytes += size;
        activeKeys.add(object.key);
      }
    }
    if (saturated) break;
    cursor = page?.truncated ? page.cursor : undefined;
  } while (cursor);

  if (staleKeys.length > 0) await deleteBucketKeysInChunks(bucket, staleKeys);
  return {
    activeKeys,
    totalBytes: saturated ? Number.POSITIVE_INFINITY : totalBytes,
  };
}

async function calculateRoomStorageBytes(bucket, roomId, now) {
  return (await inspectRoomStorage(bucket, roomId, now)).totalBytes;
}

async function roomHasStorageCapacity(env, roomId, additionalBytes) {
  const quotaBytes = roomStorageQuotaBytes(env);
  if (quotaBytes <= 0) return true;
  if (!env.REMOTE_SHARE_BUCKET) throw new Error('room storage quota bucket missing');
  const storedBytes = await calculateRoomStorageBytes(env.REMOTE_SHARE_BUCKET, roomId, Date.now());
  return storedBytes + additionalBytes <= quotaBytes;
}

function roomStorageQuotaExceeded(request, env) {
  return json(
    request,
    env,
    {
      error: 'room storage quota exceeded',
      code: 'ROOM_STORAGE_QUOTA_EXCEEDED',
      maxBytes: roomStorageQuotaBytes(env),
    },
    409,
  );
}

function roomQuotaStub(env, roomId) {
  const namespace = env.REMOTE_SHARE_QUOTA;
  if (
    !namespace ||
    typeof namespace.idFromName !== 'function' ||
    typeof namespace.get !== 'function'
  ) {
    throw new Error('room storage quota Durable Object missing');
  }
  return namespace.get(namespace.idFromName(roomId));
}

async function callRoomQuota(env, roomId, operation, body) {
  const stub = roomQuotaStub(env, roomId);
  const response = await stub.fetch(
    new Request(`https://remote-share-quota.internal/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, ...body }),
    }),
  );
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('invalid room storage quota response');
  }
  return { payload, status: response.status };
}

async function reserveRoomStorage(env, reservation) {
  const result = await callRoomQuota(env, reservation.roomId, 'reserve', reservation);
  if (result.status === 200 && result.payload?.reserved === true) return true;
  if (result.status === 409 && result.payload?.code === 'ROOM_STORAGE_QUOTA_EXCEEDED') {
    return false;
  }
  throw new Error('room storage quota unavailable');
}

async function completeRoomStorageReservation(env, reservation) {
  const result = await callRoomQuota(env, reservation.roomId, 'complete', reservation);
  if (result.status === 200 && result.payload?.completed === true) return 'completed';
  if (result.status === 409 && result.payload?.code === 'ROOM_STORAGE_QUOTA_EXCEEDED') {
    return 'quota-exceeded';
  }
  if (result.status === 404) return 'missing';
  throw new Error('room storage quota unavailable');
}

async function releaseRoomStorageReservation(env, roomId, objectId, cleanupToken) {
  if (roomStorageQuotaBytes(env) <= 0 || !cleanupToken) return false;
  const result = await callRoomQuota(env, roomId, 'release', {
    cleanupToken,
    objectId,
  });
  if (result.status === 200 && typeof result.payload?.released === 'boolean') {
    return result.payload.released;
  }
  throw new Error('room storage quota unavailable');
}

async function releaseRoomStorageReservationBestEffort(env, roomId, objectId, cleanupToken) {
  try {
    await releaseRoomStorageReservation(env, roomId, objectId, cleanupToken);
  } catch (error) {
    // A failed release leaves a conservative reservation until expiry. It can
    // temporarily deny capacity, but can never admit an over-quota upload.
    console.warn('remote share room storage reservation release failed', error);
  }
}

function rateLimited(request, env, message, retryAfterSeconds) {
  return json(request, env, { error: message, retryAfterSeconds }, 429, {
    'retry-after': String(retryAfterSeconds),
  });
}

async function handleSession(request, env) {
  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);

  const capabilityError = await requireSessionCapability(request, env);
  if (capabilityError) return capabilityError;

  const parsedBody = await readJsonBodyLimited(request, SESSION_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(request, env, parsedBody);
  const body = parsedBody.value;

  const roomId = standardRoomId(body?.roomId);
  const sessionId = Number(body?.sessionId);
  const queueItemId = safeQueueItemId(body?.queueItemId);
  const size = Number(body?.size);
  const encryptedSize = Number(body?.encryptedSize);

  if (
    !roomId ||
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    !queueItemId ||
    !Number.isFinite(size) ||
    size <= 0 ||
    !Number.isSafeInteger(size) ||
    size > REMOTE_SHARE_MAX_BYTES ||
    !Number.isFinite(encryptedSize) ||
    !Number.isSafeInteger(encryptedSize) ||
    encryptedSize !== size + AES_GCM_TAG_BYTES
  ) {
    return json(request, env, { error: 'invalid upload session request' }, 400);
  }

  const rateWindowSeconds = parseLimit(
    env.RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  );
  const ipUploadLimit = parseLimit(env.IP_UPLOADS_PER_WINDOW, DEFAULT_IP_UPLOADS_PER_WINDOW);
  const roomUploadLimit = parseOptionalLimit(
    env.ROOM_UPLOADS_PER_WINDOW,
    DEFAULT_ROOM_UPLOADS_PER_WINDOW,
  );

  const ipAllowed = await consumeLimit(
    env,
    await rateLimitIpKey(secret, request),
    ipUploadLimit,
    rateWindowSeconds,
  );
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
  const quotaEnabled = atomicRoomStorageQuotaEnabled(env);
  let quotaReserved = false;
  try {
    // The migration bridge keeps the previous bounded LIST admission behavior
    // while establishing the Durable Object namespace as a rollback baseline.
    if (!quotaEnabled && roomStorageQuotaBytes(env) > 0) {
      try {
        if (!(await roomHasStorageCapacity(env, roomId, encryptedSize))) {
          return roomStorageQuotaExceeded(request, env);
        }
      } catch (error) {
        console.warn('remote share room storage quota unavailable', error);
        return json(request, env, { error: 'room storage quota unavailable' }, 503);
      }
    }
    if (quotaEnabled) {
      let reserved;
      try {
        reserved = await reserveRoomStorage(env, {
          cleanupToken,
          encryptedSize,
          expiresAt,
          objectId,
          objectKey: objectKeyValue,
          roomId,
        });
      } catch (error) {
        console.warn('remote share room storage quota unavailable', error);
        // The Durable Object may have persisted the reservation and then lost
        // its alarm/response. No presigned URL has been exposed yet, so an
        // idempotent release with the same identity safely resolves that
        // ambiguous partial commit. A failed release remains conservative.
        await releaseRoomStorageReservationBestEffort(env, roomId, objectId, cleanupToken);
        return json(request, env, { error: 'room storage quota unavailable' }, 503);
      }
      if (!reserved) return roomStorageQuotaExceeded(request, env);
      quotaReserved = true;
    }

    const uploadHeaders = {
      'content-type': 'application/octet-stream',
      'x-amz-meta-cleanup-token': cleanupToken,
      'x-amz-meta-encrypted-size': String(encryptedSize),
      'x-amz-meta-expires-at': String(expiresAt),
      'x-amz-meta-mime': mime,
      'x-amz-meta-name': name,
      'x-amz-meta-object-id': objectId,
      'x-amz-meta-room-id': roomId,
      'x-amz-meta-size-bytes': String(size),
    };
    // Content-Length is a forbidden browser header, so the client must not set
    // it itself. The user agent still sends the real request length. Include
    // the declared ciphertext length only in SigV4's signed headers so R2
    // rejects an oversized/undersized PUT before it can become an orphan.
    const signedUploadHeaders = {
      ...uploadHeaders,
      'content-length': String(encryptedSize),
    };
    const uploadUrl = await createR2PresignedPutUrl({
      env,
      objectKey: objectKeyValue,
      headers: signedUploadHeaders,
      expiresInSeconds: ttlSeconds,
      now: new Date(now),
    });
    if (!uploadUrl) {
      if (quotaReserved) {
        await releaseRoomStorageReservationBestEffort(env, roomId, objectId, cleanupToken);
        quotaReserved = false;
      }
      return json(request, env, { error: 'r2 s3 config missing' }, 500);
    }

    // The presigned URL only governs when R2 accepts the PUT request. A slow,
    // steadily progressing PUT may finish after that start window, so its
    // completion capability remains valid only until the already-fixed object
    // expiry. Neither the PUT URL nor the object's usable lifetime is extended.
    // Keep the established v2 envelope across the migration bridge and later
    // same-lifecycle rollbacks. The signed marker opts the new Worker into
    // Durable Object settlement; old Workers ignore the extra field and
    // retain their bounded LIST validation.
    const completeToken = await createSignedToken(
      {
        v: 2,
        ...(quotaEnabled ? { quotaReservationVersion: 1 } : {}),
        kind: 'complete',
        roomId,
        objectId,
        objectKey: objectKeyValue,
        sessionId,
        queueItemId,
        size,
        encryptedSize,
        expiresAt,
        cleanupToken,
        iat: now,
        exp: expiresAt,
        nonce: crypto.randomUUID(),
      },
      secret,
    );

    const url = new URL(request.url);
    const response = json(request, env, {
      uploadUrl,
      uploadHeaders,
      uploadUrlExpiresAt,
      completeToken,
      objectId,
      expiresAt,
      downloadUrl: `${url.origin}/download/${roomId}/${objectId}`,
      cleanupToken,
    });
    quotaReserved = false;
    return response;
  } catch (error) {
    if (quotaReserved) {
      await releaseRoomStorageReservationBestEffort(env, roomId, objectId, cleanupToken);
    }
    throw error;
  }
}

async function deleteObjectAndRetainReservation(env, _roomId, _objectId, key, _cleanupToken) {
  await env.REMOTE_SHARE_BUCKET.delete(key);
  // Once a presigned PUT URL has been returned, deleting its current object
  // does not revoke that write authority. Keep the exact-byte reservation
  // until fixed expiry so a late or replayed PUT cannot arrive after another
  // session consumed the same capacity.
}

async function handleComplete(request, env) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);

  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);

  const parsedBody = await readJsonBodyLimited(request, COMPLETE_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(request, env, parsedBody);
  const body = parsedBody.value;

  const payload = await verifySignedToken(body?.completeToken, secret);
  const roomId = standardRoomId(body?.roomId);
  const objectId = String(body?.objectId || '');
  const now = Date.now();
  const issuedAt = Number(payload?.iat);
  const tokenExpiresAt = Number(payload?.exp);
  const objectExpiresAt = Number(payload?.expiresAt);
  if (
    !roomId ||
    !payload ||
    payload.v !== 2 ||
    (payload.quotaReservationVersion !== undefined && payload.quotaReservationVersion !== 1) ||
    payload.kind !== 'complete' ||
    payload.roomId !== roomId ||
    payload.objectId !== objectId ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(tokenExpiresAt) ||
    !Number.isSafeInteger(objectExpiresAt) ||
    issuedAt > tokenExpiresAt ||
    issuedAt > now + 60_000 ||
    tokenExpiresAt !== objectExpiresAt ||
    tokenExpiresAt < now
  ) {
    return json(request, env, { error: 'invalid upload completion' }, 403);
  }

  const key = objectKey(roomId, objectId);
  if (!key || key !== payload.objectKey) return json(request, env, { error: 'not found' }, 404);

  const object = await env.REMOTE_SHARE_BUCKET.head(key);
  if (!object) return json(request, env, { error: 'not found' }, 404);

  const expectedSize = Number(payload.encryptedSize);
  const plaintextSize = Number(payload.size);
  if (
    !Number.isSafeInteger(plaintextSize) ||
    plaintextSize <= 0 ||
    plaintextSize > REMOTE_SHARE_MAX_BYTES ||
    !Number.isFinite(expectedSize) ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize !== plaintextSize + AES_GCM_TAG_BYTES ||
    object.size !== expectedSize ||
    object.size > REMOTE_SHARE_MAX_ENCRYPTED_BYTES
  ) {
    await deleteObjectAndRetainReservation(env, roomId, objectId, key, payload.cleanupToken);
    return json(request, env, { error: 'invalid uploaded object' }, 403);
  }

  const storedPlaintextSize = Number(readMetadata(object, 'sizeBytes', 'size-bytes', 'sizebytes'));
  const storedEncryptedSize = Number(
    readMetadata(object, 'encryptedSize', 'encrypted-size', 'encryptedsize'),
  );
  const storedRoomId = String(readMetadata(object, 'roomId', 'room-id', 'roomid') || '');
  const storedObjectId = String(readMetadata(object, 'objectId', 'object-id', 'objectid') || '');
  const storedCleanupToken = String(
    readMetadata(object, 'cleanupToken', 'cleanup-token', 'cleanuptoken') || '',
  );
  const storedExpiresAt = Number(readMetadata(object, 'expiresAt', 'expires-at', 'expiresat'));
  if (
    storedPlaintextSize !== plaintextSize ||
    storedEncryptedSize !== expectedSize ||
    storedRoomId !== roomId ||
    storedObjectId !== objectId ||
    storedCleanupToken !== payload.cleanupToken ||
    storedExpiresAt !== Number(payload.expiresAt)
  ) {
    await deleteObjectAndRetainReservation(env, roomId, objectId, key, payload.cleanupToken);
    return json(request, env, { error: 'invalid uploaded object metadata' }, 403);
  }

  const expiresAt = Number(payload.expiresAt);
  // HEAD is an awaited network boundary. Re-read the clock so a completion
  // that crossed object expiry while R2 was responding cannot publish an
  // already-stale descriptor.
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await deleteObjectAndRetainReservation(env, roomId, objectId, key, payload.cleanupToken);
    return json(request, env, { error: 'expired' }, 404);
  }

  const quotaSettlementRequired = roomStorageQuotaBytes(env) > 0 || Boolean(env.REMOTE_SHARE_QUOTA);
  if (payload.quotaReservationVersion === 1 && quotaSettlementRequired) {
    try {
      const completion = await completeRoomStorageReservation(env, {
        cleanupToken: payload.cleanupToken,
        encryptedSize: expectedSize,
        expiresAt,
        objectId,
        objectKey: key,
        roomId,
      });
      if (completion === 'quota-exceeded') {
        await deleteObjectAndRetainReservation(env, roomId, objectId, key, payload.cleanupToken);
        return roomStorageQuotaExceeded(request, env);
      }
      if (completion !== 'completed') {
        return json(request, env, { error: 'room storage quota unavailable' }, 503);
      }
    } catch (error) {
      console.warn('remote share completed-object quota validation unavailable', error);
      // Preserve the already-validated object and reservation so the caller
      // can retry after a transient binding/DO outage. Deleting here would not
      // revoke the still-live direct PUT URL anyway.
      return json(request, env, { error: 'room storage quota unavailable' }, 503);
    }
  } else {
    // Deployment/rollback compatibility for unmarked v2 tokens. A marked
    // token also reaches this path only when admission was explicitly disabled
    // and the quota binding was removed; its valid object can remain usable
    // without destructive settlement because no new reservations are admitted.
    try {
      if (!(await roomHasStorageCapacity(env, roomId, 0))) {
        await env.REMOTE_SHARE_BUCKET.delete(key);
        return roomStorageQuotaExceeded(request, env);
      }
    } catch (error) {
      console.warn('remote share completed-object quota validation unavailable', error);
      await env.REMOTE_SHARE_BUCKET.delete(key);
      return json(request, env, { error: 'room storage quota unavailable' }, 503);
    }
  }

  // The quota LIST is another network boundary and may cross object expiry.
  // Never publish a descriptor for an object that cleanup just expired.
  if (expiresAt <= Date.now()) {
    await deleteObjectAndRetainReservation(env, roomId, objectId, key, payload.cleanupToken);
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

function objectKey(roomId, objectId) {
  const room = standardRoomId(roomId);
  if (
    !room ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(objectId)
  ) {
    return null;
  }
  return `room/${room}/${objectId}`;
}

async function handleDownload(request, env, roomId, objectId) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);

  const key = objectKey(roomId, objectId);
  if (!key) return json(request, env, { error: 'not found' }, 404);

  const object = await env.REMOTE_SHARE_BUCKET.get(key);
  if (!object) return json(request, env, { error: 'not found' }, 404);

  const storedCleanupToken = String(
    readMetadata(object, 'cleanupToken', 'cleanup-token', 'cleanuptoken') || '',
  );
  if (object.size > REMOTE_SHARE_MAX_ENCRYPTED_BYTES) {
    await deleteObjectAndRetainReservation(env, roomId, objectId, key, storedCleanupToken);
    return json(request, env, { error: 'file too large', maxBytes: REMOTE_SHARE_MAX_BYTES }, 413);
  }

  const plaintextSize = Number(readMetadata(object, 'sizeBytes', 'size-bytes', 'sizebytes'));
  const encryptedSize = Number(
    readMetadata(object, 'encryptedSize', 'encrypted-size', 'encryptedsize'),
  );
  const storedRoomId = String(readMetadata(object, 'roomId', 'room-id', 'roomid') || '');
  const storedObjectId = String(readMetadata(object, 'objectId', 'object-id', 'objectid') || '');
  if (
    !Number.isSafeInteger(plaintextSize) ||
    plaintextSize <= 0 ||
    plaintextSize > REMOTE_SHARE_MAX_BYTES ||
    !Number.isSafeInteger(encryptedSize) ||
    encryptedSize !== plaintextSize + AES_GCM_TAG_BYTES ||
    object.size !== encryptedSize ||
    storedRoomId !== standardRoomId(roomId) ||
    storedObjectId !== objectId
  ) {
    await deleteObjectAndRetainReservation(env, roomId, objectId, key, storedCleanupToken);
    return json(request, env, { error: 'invalid stored object' }, 404);
  }

  const expiresAt = Number(readMetadata(object, 'expiresAt', 'expires-at', 'expiresat') || '0');
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    await deleteObjectAndRetainReservation(env, roomId, objectId, key, storedCleanupToken);
    return json(request, env, { error: 'expired' }, 404);
  }

  return new Response(object.body, {
    headers: {
      ...SECURITY_HEADERS,
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

  const supplied = request.headers.get('x-mxqr-cleanup-token') || '';
  const object = await env.REMOTE_SHARE_BUCKET.head(key);
  if (!object) {
    // A presigned PUT can still be in flight (or be started with the already
    // issued URL) even though HEAD currently sees no object. Releasing here
    // would let another session consume the same bytes before that PUT lands.
    // Keep the reservation fail-closed until its expiry alarm reconciles it.
    return json(request, env, { ok: true });
  }
  const expected = readMetadata(object, 'cleanupToken', 'cleanup-token', 'cleanuptoken');
  if (!expected || supplied !== expected) {
    return json(request, env, { error: 'forbidden' }, 403);
  }

  await env.REMOTE_SHARE_BUCKET.delete(key);
  // The presigned PUT remains reusable until its fixed authority window. The
  // reservation therefore stays charged until expiry even after a successful
  // authenticated physical delete.
  return json(request, env, { ok: true });
}

function quotaJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function emptyQuotaState(roomId) {
  return {
    v: QUOTA_STATE_VERSION,
    roomId,
    reservations: {},
  };
}

function validQuotaReservation(objectId, value, roomId) {
  return (
    value &&
    typeof value === 'object' &&
    value.objectId === objectId &&
    value.objectKey === objectKey(roomId, objectId) &&
    Number.isSafeInteger(value.encryptedSize) &&
    value.encryptedSize > AES_GCM_TAG_BYTES &&
    value.encryptedSize <= REMOTE_SHARE_MAX_ENCRYPTED_BYTES &&
    Number.isSafeInteger(value.expiresAt) &&
    typeof value.cleanupToken === 'string' &&
    value.cleanupToken.length >= 16 &&
    (value.status === 'reserved' || value.status === 'completed')
  );
}

function parseQuotaReservation(body) {
  const roomId = standardRoomId(body?.roomId);
  const objectId = String(body?.objectId || '');
  const key = objectKey(roomId, objectId);
  const encryptedSize = Number(body?.encryptedSize);
  const expiresAt = Number(body?.expiresAt);
  const cleanupToken = String(body?.cleanupToken || '');
  if (
    !roomId ||
    !key ||
    body?.objectKey !== key ||
    !Number.isSafeInteger(encryptedSize) ||
    encryptedSize <= AES_GCM_TAG_BYTES ||
    encryptedSize > REMOTE_SHARE_MAX_ENCRYPTED_BYTES ||
    !Number.isSafeInteger(expiresAt) ||
    cleanupToken.length < 16
  ) {
    return null;
  }
  return {
    cleanupToken,
    encryptedSize,
    expiresAt,
    objectId,
    objectKey: key,
    roomId,
  };
}

function reservationsMatch(left, right) {
  return (
    left.objectId === right.objectId &&
    left.objectKey === right.objectKey &&
    left.encryptedSize === right.encryptedSize &&
    left.expiresAt === right.expiresAt &&
    constantTimeEqual(left.cleanupToken, right.cleanupToken)
  );
}

export class RemoteShareQuota {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.mutationTail = Promise.resolve();
  }

  enqueueMutation(task) {
    const run = this.mutationTail.then(task, task);
    this.mutationTail = run.catch(() => {});
    return run;
  }

  fetch(request) {
    return this.enqueueMutation(async () => {
      try {
        return await this.handleFetch(request);
      } catch (error) {
        console.warn('remote share quota Durable Object unavailable', error);
        return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
      }
    });
  }

  async readState(roomId) {
    const stored = await this.storage.get(QUOTA_STATE_KEY);
    if (stored === undefined || stored === null) return emptyQuotaState(roomId);
    if (
      !stored ||
      typeof stored !== 'object' ||
      stored.v !== QUOTA_STATE_VERSION ||
      stored.roomId !== roomId ||
      !stored.reservations ||
      typeof stored.reservations !== 'object' ||
      Array.isArray(stored.reservations)
    ) {
      throw new Error('invalid room storage quota state');
    }
    const reservations = {};
    for (const [objectId, reservation] of Object.entries(stored.reservations)) {
      if (!validQuotaReservation(objectId, reservation, roomId)) {
        throw new Error('invalid room storage reservation state');
      }
      reservations[objectId] = { ...reservation };
    }
    return {
      v: QUOTA_STATE_VERSION,
      roomId,
      reservations,
    };
  }

  async scheduleAlarm(state) {
    const expiries = Object.values(state.reservations).map((reservation) => reservation.expiresAt);
    if (expiries.length === 0) {
      if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
      return;
    }
    if (typeof this.storage.setAlarm === 'function') {
      await this.storage.setAlarm(Math.min(...expiries));
    }
  }

  async persistState(state) {
    if (Object.keys(state.reservations).length === 0) {
      if (typeof this.storage.delete === 'function') await this.storage.delete(QUOTA_STATE_KEY);
    } else {
      await this.storage.put(QUOTA_STATE_KEY, state);
    }
    await this.scheduleAlarm(state);
  }

  async maintainState(state, changed) {
    if (changed) await this.persistState(state);
    else await this.scheduleAlarm(state);
  }

  async reconcile(state, now) {
    if (!this.env.REMOTE_SHARE_BUCKET) {
      throw new Error('room storage quota bucket missing');
    }
    const snapshot = await inspectRoomStorage(this.env.REMOTE_SHARE_BUCKET, state.roomId, now);
    let changed = false;
    for (const [objectId, reservation] of Object.entries(state.reservations)) {
      if (reservation.expiresAt <= now) {
        delete state.reservations[objectId];
        changed = true;
      }
    }
    return { changed, snapshot };
  }

  accountedBytes(state, snapshot) {
    let totalBytes = snapshot.totalBytes;
    for (const reservation of Object.values(state.reservations)) {
      if (!snapshot.activeKeys.has(reservation.objectKey)) {
        totalBytes += reservation.encryptedSize;
      }
    }
    return Number.isSafeInteger(totalBytes) ? totalBytes : Number.POSITIVE_INFINITY;
  }

  async handleFetch(request) {
    if (request.method !== 'POST') return quotaJson({ error: 'NOT_FOUND' }, 404);
    const url = new URL(request.url);
    const parsedBody = await readJsonBodyLimited(request, QUOTA_JSON_BODY_MAX_BYTES);
    if (parsedBody.error) return quotaJson({ error: 'INVALID_REQUEST' }, 400);
    const body = parsedBody.value;
    const roomId = standardRoomId(body?.roomId);
    if (!roomId) return quotaJson({ error: 'INVALID_REQUEST' }, 400);

    if (url.pathname === '/release') return this.handleRelease(roomId, body);
    if (url.pathname !== '/reserve' && url.pathname !== '/complete') {
      return quotaJson({ error: 'NOT_FOUND' }, 404);
    }
    const reservation = parseQuotaReservation(body);
    if (!reservation || reservation.roomId !== roomId) {
      return quotaJson({ error: 'INVALID_REQUEST' }, 400);
    }
    return url.pathname === '/reserve'
      ? this.handleReserve(reservation)
      : this.handleComplete(reservation);
  }

  async handleReserve(reservation) {
    const quotaBytes = roomStorageQuotaBytes(this.env);
    if (quotaBytes <= 0) return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    const now = Date.now();
    if (reservation.expiresAt <= now) return quotaJson({ error: 'INVALID_REQUEST' }, 400);

    const state = await this.readState(reservation.roomId);
    const { changed, snapshot } = await this.reconcile(state, now);
    const existing = state.reservations[reservation.objectId];
    if (existing) {
      if (!reservationsMatch(existing, reservation)) {
        await this.maintainState(state, changed);
        return quotaJson({ error: 'RESERVATION_CONFLICT' }, 409);
      }
      await this.maintainState(state, changed);
      return quotaJson({ reserved: true });
    }

    if (Object.keys(state.reservations).length >= QUOTA_STATE_MAX_ENTRIES) {
      await this.maintainState(state, changed);
      return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    }
    const accountedBytes = this.accountedBytes(state, snapshot);
    if (accountedBytes + reservation.encryptedSize > quotaBytes) {
      await this.maintainState(state, changed);
      return quotaJson(
        {
          code: 'ROOM_STORAGE_QUOTA_EXCEEDED',
          maxBytes: quotaBytes,
        },
        409,
      );
    }

    state.reservations[reservation.objectId] = {
      ...reservation,
      status: 'reserved',
    };
    await this.persistState(state);
    return quotaJson({ reserved: true });
  }

  async handleComplete(reservation) {
    const quotaBytes = roomStorageQuotaBytes(this.env);
    const now = Date.now();
    if (reservation.expiresAt <= now) return quotaJson({ error: 'RESERVATION_MISSING' }, 404);

    const state = await this.readState(reservation.roomId);
    const { changed, snapshot } = await this.reconcile(state, now);
    const existing = state.reservations[reservation.objectId];
    if (
      !existing ||
      !reservationsMatch(existing, reservation) ||
      !snapshot.activeKeys.has(reservation.objectKey)
    ) {
      await this.maintainState(state, changed);
      return quotaJson({ error: 'RESERVATION_MISSING' }, 404);
    }

    // Disabling new quota admission must not strand reservations already
    // issued by the previous configuration. They still settle through this
    // Durable Object; only the over-limit decision is disabled.
    if (quotaBytes > 0 && this.accountedBytes(state, snapshot) > quotaBytes) {
      await this.maintainState(state, changed);
      return quotaJson(
        {
          code: 'ROOM_STORAGE_QUOTA_EXCEEDED',
          maxBytes: quotaBytes,
        },
        409,
      );
    }

    state.reservations[reservation.objectId] = {
      ...existing,
      status: 'completed',
    };
    await this.persistState(state);
    return quotaJson({ completed: true });
  }

  async handleRelease(roomId, body) {
    const objectId = String(body?.objectId || '');
    const cleanupToken = String(body?.cleanupToken || '');
    if (!objectKey(roomId, objectId) || cleanupToken.length < 16) {
      return quotaJson({ error: 'INVALID_REQUEST' }, 400);
    }

    const state = await this.readState(roomId);
    const existing = state.reservations[objectId];
    if (!existing || !constantTimeEqual(existing.cleanupToken, cleanupToken)) {
      await this.scheduleAlarm(state);
      return quotaJson({ released: false });
    }
    delete state.reservations[objectId];
    await this.persistState(state);
    return quotaJson({ released: true });
  }

  alarm() {
    return this.enqueueMutation(async () => {
      try {
        const stored = await this.storage.get(QUOTA_STATE_KEY);
        if (stored === undefined || stored === null) {
          if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
          return;
        }
        const roomId = standardRoomId(stored?.roomId);
        if (!roomId) throw new Error('invalid room storage quota state');
        const state = await this.readState(roomId);
        await this.reconcile(state, Date.now());
        await this.persistState(state);
      } catch (error) {
        console.warn('remote share quota alarm failed', error);
        if (typeof this.storage.setAlarm === 'function') {
          await this.storage.setAlarm(Date.now() + QUOTA_ALARM_RETRY_MS);
          return;
        }
        throw error;
      }
    });
  }
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
      return new Response(null, {
        status: 204,
        headers: { ...SECURITY_HEADERS, ...corsHeaders(request, env) },
      });
    }

    try {
      if (requiresAllowedOrigin(path)) {
        const badOrigin = originError(request, env);
        if (badOrigin) return badOrigin;
      }

      if (request.method === 'GET' && path === '/security-config') {
        return handleSecurityConfig(request, env);
      }
      if (request.method === 'POST' && path === '/session') {
        return handleSession(request, env);
      }
      if (request.method === 'POST' && path === '/complete') {
        return handleComplete(request, env);
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
      // Public 5xx bodies are a stable protocol surface, not a diagnostic
      // channel. Internal exception text may contain provider/configuration
      // detail and must stay in redacted Worker logs.
      console.error(
        'remote share request failed',
        error instanceof Error ? error.name : 'UnknownError',
      );
      return json(request, env, { error: 'internal server error' }, 500);
    }
  },
};
