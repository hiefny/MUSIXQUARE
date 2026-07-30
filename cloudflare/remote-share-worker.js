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
 * - RECORD_SET_TTL_SECONDS: default 21600; an explicitly configured legacy
 *     OBJECT_TTL_SECONDS remains the fallback when this is absent
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
const DEFAULT_RECORD_SET_TTL_SECONDS = 6 * 60 * 60;
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
const QUOTA_BATCH_JSON_BODY_MAX_BYTES = 32 * 1024;
const QUOTA_STATE_KEY = 'quota-state';
const QUOTA_STATE_VERSION = 1;
const QUOTA_STATE_MAX_ENTRIES = ROOM_STORAGE_SCAN_MAX_OBJECTS;
const QUOTA_STATE_MAX_SERIALIZED_BYTES = 1_500_000;
const IDEMPOTENT_RATE_STATE_KEY = 'idempotent-rate-state';
const IDEMPOTENT_RATE_STATE_VERSION = 1;
const IDEMPOTENT_RATE_MAX_MARKERS = 4096;
const QUOTA_ALARM_RETRY_MS = 60 * 1000;
const EXPIRY_TOMBSTONE_SWEEP_MS = 60 * 1000;
const EXPIRY_TOMBSTONE_QUIET_MS = 60 * 60 * 1000;
const RECORD_SET_FORMAT_VERSION = 2;
const RECORD_SET_CREATE_IDEMPOTENCY_VERSION = 1;
const RECORD_SET_PLAINTEXT_BYTES = 8 * 1024 * 1024;
const RECORD_SET_MAX_RECORDS = Math.ceil(REMOTE_SHARE_MAX_BYTES / RECORD_SET_PLAINTEXT_BYTES);
const RECORD_SET_MAX_IDENTIFIER_LENGTH = 256;
const RECORD_SET_MAX_NAME_LENGTH = 512;
const RECORD_SET_MAX_MIME_LENGTH = 128;
const RECORD_SET_TOKEN_KEYS = Object.freeze([
  'cleanupToken',
  'exp',
  'expiresAt',
  'iat',
  'kind',
  'mime',
  'name',
  'nonce',
  'queueItemId',
  'recordCount',
  'recordSize',
  'roomId',
  'sessionId',
  'setId',
  'size',
  'sourceIdentity',
  'v',
]);
const RECORD_SET_CREATE_KEYS = Object.freeze([
  'mime',
  'name',
  'queueItemId',
  'recordCount',
  'recordSize',
  'roomId',
  'sessionId',
  'size',
  'sourceIdentity',
]);
const RECORD_SET_AUTHORITY_KEYS = Object.freeze(['setToken']);
const RECORD_SET_RESERVATION_KEYS = Object.freeze([
  'cleanupToken',
  'encryptedSize',
  'expiresAt',
  'objectId',
  'objectKey',
  'recordCount',
  'recordIndex',
  'roomId',
  'setId',
]);
const RECORD_SET_MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const HMAC_SHA256_BASE64URL_RE = /^[A-Za-z0-9_-]{43}$/;
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
      'content-type,authorization,x-mxqr-capability,x-mxqr-cleanup-token,x-mxqr-idempotency-key',
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
    /^\/v2\/sets(?:\/|$)/.test(path) ||
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

function recordSetTtlSeconds(env) {
  // Preserve the original OBJECT_TTL_SECONDS override for staging and focused
  // expiry tests while allowing record streaming to outlive V1's one-hour
  // whole-object window. Production config sets the record value explicitly.
  return parseLimit(
    env.RECORD_SET_TTL_SECONDS ?? env.OBJECT_TTL_SECONDS,
    DEFAULT_RECORD_SET_TTL_SECONDS,
  );
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

function recordSetAdmissionReady(env) {
  return Boolean(
    getSigningSecret(env) &&
    (isCapabilityRequired(env) || allowUnguardedRemoteShare(env)) &&
    atomicRoomStorageQuotaEnabled(env) &&
    env.REMOTE_SHARE_BUCKET &&
    env.REMOTE_SHARE_QUOTA &&
    getR2S3Config(env),
  );
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
  const recordSetReady = recordSetAdmissionReady(env);
  return json(request, env, {
    capabilityRequired: isCapabilityRequired(env),
    scope: CAPABILITY_SCOPE,
    ttl: CAPABILITY_TOKEN_TTL_DEFAULT,
    workerContractVersion: RECORD_SET_FORMAT_VERSION,
    ...(recordSetReady
      ? {
          recordSetVersion: RECORD_SET_FORMAT_VERSION,
          recordSetCreateIdempotency: true,
        }
      : {}),
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
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [encodedPayload, encodedSignature] = parts;

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

function hasExactOwnKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && keys.every((key) => expectedKeys.includes(key));
}

function containsControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function safeRecordSetIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= RECORD_SET_MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value) &&
    !hasUnpairedSurrogate(value)
  );
}

function safeRecordSetName(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= RECORD_SET_MAX_NAME_LENGTH &&
    !containsControlCharacter(value) &&
    !hasUnpairedSurrogate(value)
  );
}

function safeRecordSetMime(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= RECORD_SET_MAX_MIME_LENGTH &&
    value === value.trim() &&
    RECORD_SET_MIME_RE.test(value)
  );
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V8_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validRecordSetId(value) {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

function formatUuid(bytes) {
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(
    16,
    20,
  )}-${value.slice(20, 32)}`;
}

async function recordObjectId(setId, recordIndex) {
  if (!validRecordSetId(setId) || !Number.isSafeInteger(recordIndex) || recordIndex < 0) {
    return null;
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`MXQR\0R2-RECORD-OBJECT\0${setId}\0${recordIndex}`),
    ),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return formatUuid(digest);
}

function recordSetCount(size, recordSize = RECORD_SET_PLAINTEXT_BYTES) {
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > REMOTE_SHARE_MAX_BYTES ||
    recordSize !== RECORD_SET_PLAINTEXT_BYTES
  ) {
    return null;
  }
  const count = Math.ceil(size / recordSize);
  return count > 0 && count <= RECORD_SET_MAX_RECORDS ? count : null;
}

function recordSetLayout(size, recordSize, recordCount, recordIndex) {
  if (
    recordSize !== RECORD_SET_PLAINTEXT_BYTES ||
    recordSetCount(size, recordSize) !== recordCount ||
    !Number.isSafeInteger(recordIndex) ||
    recordIndex < 0 ||
    recordIndex >= recordCount
  ) {
    return null;
  }
  const plaintextSize =
    recordIndex === recordCount - 1 ? size - recordIndex * recordSize : recordSize;
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize <= 0) return null;
  return {
    encryptedSize: plaintextSize + AES_GCM_TAG_BYTES,
    plaintextSize,
  };
}

function parseRecordSetCreate(body) {
  if (!hasExactOwnKeys(body, RECORD_SET_CREATE_KEYS)) return null;
  const roomId = standardRoomId(body.roomId);
  const size = body.size;
  const recordSize = body.recordSize;
  const recordCount = body.recordCount;
  if (
    !roomId ||
    !safeRecordSetIdentifier(body.sessionId) ||
    !safeQueueItemId(body.queueItemId) ||
    !safeRecordSetIdentifier(body.sourceIdentity) ||
    !safeRecordSetName(body.name) ||
    !safeRecordSetMime(body.mime) ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    typeof recordSize !== 'number' ||
    recordSize !== RECORD_SET_PLAINTEXT_BYTES ||
    typeof recordCount !== 'number' ||
    !Number.isSafeInteger(recordCount) ||
    recordSetCount(size, recordSize) !== recordCount
  ) {
    return null;
  }
  return {
    mime: body.mime,
    name: body.name,
    queueItemId: body.queueItemId,
    recordCount,
    recordSize,
    roomId,
    sessionId: body.sessionId,
    size,
    sourceIdentity: body.sourceIdentity,
  };
}

function readRecordSetIdempotencyKey(request) {
  const raw = request.headers.get('x-mxqr-idempotency-key');
  if (raw === null) return null;
  return raw === raw.trim() && UUID_V4_RE.test(raw) ? raw : '';
}

function recordSetCreateCanonicalValue(create) {
  return JSON.stringify({
    v: RECORD_SET_CREATE_IDEMPOTENCY_VERSION,
    mime: create.mime,
    name: create.name,
    queueItemId: create.queueItemId,
    recordCount: create.recordCount,
    recordSize: create.recordSize,
    roomId: create.roomId,
    sessionId: create.sessionId,
    size: create.size,
    sourceIdentity: create.sourceIdentity,
  });
}

async function recordSetCreateFingerprint(create) {
  return sha256Hex(recordSetCreateCanonicalValue(create));
}

async function recordSetCreateIdempotencyDigest(roomId, idempotencyKey) {
  return base64UrlEncode(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`MXQR\0R2-RECORD-SET-CREATE\0${roomId}\0${idempotencyKey}`),
      ),
    ),
  );
}

function createRecordSetTokenPayload(create, now, expiresAt) {
  return {
    v: RECORD_SET_FORMAT_VERSION,
    kind: 'record-set',
    roomId: create.roomId,
    setId: crypto.randomUUID(),
    sessionId: create.sessionId,
    queueItemId: create.queueItemId,
    sourceIdentity: create.sourceIdentity,
    name: create.name,
    mime: create.mime,
    size: create.size,
    recordSize: create.recordSize,
    recordCount: create.recordCount,
    expiresAt,
    cleanupToken: crypto.randomUUID(),
    iat: now,
    exp: expiresAt,
    nonce: crypto.randomUUID(),
  };
}

function recordSetCreateFromTokenPayload(payload) {
  return {
    mime: payload.mime,
    name: payload.name,
    queueItemId: payload.queueItemId,
    recordCount: payload.recordCount,
    recordSize: payload.recordSize,
    roomId: payload.roomId,
    sessionId: payload.sessionId,
    size: payload.size,
    sourceIdentity: payload.sourceIdentity,
  };
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
  const observedKeys = new Set();
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
      observedKeys.add(object.key);
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
    observedKeys,
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

function quotaNamespace(env) {
  const namespace = env.REMOTE_SHARE_QUOTA;
  if (
    !namespace ||
    typeof namespace.idFromName !== 'function' ||
    typeof namespace.get !== 'function'
  ) {
    throw new Error('room storage quota Durable Object missing');
  }
  return namespace;
}

function quotaStub(env, name) {
  const namespace = quotaNamespace(env);
  return namespace.get(namespace.idFromName(name));
}

function roomQuotaStub(env, roomId) {
  return quotaStub(env, roomId);
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

async function consumeIdempotentLimit(
  env,
  key,
  limit,
  windowSeconds,
  idempotencyDigest,
  markerTtlSeconds,
) {
  const keyDigest = await sha256Hex(key);
  const response = await quotaStub(env, `rate:${keyDigest}`).fetch(
    new Request('https://remote-share-quota.internal/consume-idempotent-rate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyDigest,
        keyDigest,
        limit,
        markerTtlSeconds,
        windowSeconds,
      }),
    }),
  );
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('invalid idempotent rate-limit response');
  }
  if (response.status === 200 && (payload?.allowed === true || payload?.allowed === false)) {
    return payload.allowed;
  }
  throw new Error('idempotent rate-limit unavailable');
}

async function reserveRoomStorage(env, reservation) {
  const result = await callRoomQuota(env, reservation.roomId, 'reserve', reservation);
  if (result.status === 200 && result.payload?.reserved === true) return true;
  if (result.status === 409 && result.payload?.code === 'ROOM_STORAGE_QUOTA_EXCEEDED') {
    return false;
  }
  throw new Error('room storage quota unavailable');
}

async function reserveRecordSetStorage(env, roomId, setId, reservations) {
  const result = await callRoomQuota(env, roomId, 'reserve-batch', {
    reservations,
    setId,
  });
  if (result.status === 200 && result.payload?.reserved === true) return true;
  if (result.status === 409 && result.payload?.code === 'ROOM_STORAGE_QUOTA_EXCEEDED') {
    return false;
  }
  throw new Error('room storage quota unavailable');
}

async function createIdempotentRecordSetStorage(
  env,
  roomId,
  idempotencyKeyDigest,
  requestFingerprint,
  tokenPayload,
  reservations,
) {
  const result = await callRoomQuota(env, roomId, 'create-set', {
    idempotencyKeyDigest,
    requestFingerprint,
    reservations,
    setId: tokenPayload.setId,
    tokenPayload,
  });
  if (
    result.status === 200 &&
    (result.payload?.kind === 'created' || result.payload?.kind === 'replayed') &&
    validRecordSetTokenPayload(
      result.payload.tokenPayload,
      roomId,
      result.payload.tokenPayload?.setId,
    )
  ) {
    return {
      kind: result.payload.kind,
      tokenPayload: result.payload.tokenPayload,
    };
  }
  if (result.status === 409 && result.payload?.code === 'ROOM_STORAGE_QUOTA_EXCEEDED') {
    return { kind: 'quota-exceeded' };
  }
  if (result.status === 409 && result.payload?.code === 'IDEMPOTENCY_CONFLICT') {
    return { kind: 'conflict' };
  }
  if (result.status === 410 && result.payload?.code === 'CREATE_INTENT_CANCELED') {
    return { kind: 'canceled' };
  }
  throw new Error('room storage quota unavailable');
}

async function cancelIdempotentRecordSetStorage(
  env,
  roomId,
  idempotencyKeyDigest,
  requestFingerprint,
  tokenPayload,
  reservations,
) {
  const result = await callRoomQuota(env, roomId, 'cancel-create', {
    idempotencyKeyDigest,
    requestFingerprint,
    reservations,
    setId: tokenPayload.setId,
    tokenPayload,
  });
  if (result.status === 200 && result.payload?.canceled === true) {
    const setId = result.payload.setId;
    const objectIds = result.payload.objectIds;
    if (
      !validRecordSetId(setId) ||
      !Array.isArray(objectIds) ||
      objectIds.length === 0 ||
      objectIds.length > RECORD_SET_MAX_RECORDS ||
      objectIds.some((objectId) => typeof objectId !== 'string' || !UUID_V8_RE.test(objectId))
    ) {
      throw new Error('invalid room storage quota response');
    }
    for (let index = 0; index < objectIds.length; index += 1) {
      if (objectIds[index] !== (await recordObjectId(setId, index))) {
        throw new Error('invalid room storage quota response');
      }
    }
    return { kind: 'canceled', objectIds };
  }
  if (result.status === 409 && result.payload?.code === 'IDEMPOTENCY_CONFLICT') {
    return { kind: 'conflict' };
  }
  throw new Error('room storage quota unavailable');
}

async function authorizeRecordSetUpload(env, reservation) {
  const result = await callRoomQuota(env, reservation.roomId, 'authorize-record', reservation);
  if (result.status === 200 && result.payload?.authorized === true) return 'authorized';
  if (result.status === 410 && result.payload?.code === 'RECORD_SET_REVOKED') return 'revoked';
  if (result.status === 404) return 'missing';
  throw new Error('room storage quota unavailable');
}

async function completeRecordSetStorageReservation(env, reservation) {
  const result = await callRoomQuota(env, reservation.roomId, 'complete', reservation);
  if (result.status === 200 && result.payload?.completed === true) {
    const readyRecordCount = Number(result.payload.readyRecordCount);
    const recordCount = Number(result.payload.recordCount);
    if (
      !Number.isSafeInteger(readyRecordCount) ||
      readyRecordCount < 0 ||
      !Number.isSafeInteger(recordCount) ||
      recordCount <= 0 ||
      readyRecordCount > recordCount
    ) {
      throw new Error('invalid room storage quota response');
    }
    return {
      complete: readyRecordCount === recordCount,
      readyRecordCount,
      recordCount,
    };
  }
  if (result.status === 409 && result.payload?.code === 'ROOM_STORAGE_QUOTA_EXCEEDED') {
    return 'quota-exceeded';
  }
  if (result.status === 404) return 'missing';
  if (result.status === 410 && result.payload?.code === 'RECORD_SET_REVOKED') return 'revoked';
  throw new Error('room storage quota unavailable');
}

async function releaseRecordSetStorageBestEffort(env, roomId, setId, reservations) {
  try {
    const result = await callRoomQuota(env, roomId, 'release-batch', {
      reservations,
      setId,
    });
    if (
      result.status !== 200 ||
      (result.payload?.released !== true && result.payload?.released !== false)
    ) {
      throw new Error('room storage quota unavailable');
    }
  } catch (error) {
    // Creation has not exposed a PUT URL yet. A failed release remains a
    // conservative all-record reservation until fixed expiry.
    console.warn('remote share record-set reservation release failed', error);
  }
}

async function revokeRecordSetStorage(env, roomId, setId, cleanupToken) {
  const result = await callRoomQuota(env, roomId, 'revoke-set', {
    cleanupToken,
    setId,
  });
  if (result.status === 200 && result.payload?.revoked === true) {
    const objectIds = result.payload.objectIds;
    if (
      !Array.isArray(objectIds) ||
      objectIds.length === 0 ||
      objectIds.length > RECORD_SET_MAX_RECORDS ||
      objectIds.some((objectId) => typeof objectId !== 'string' || !UUID_V8_RE.test(objectId))
    ) {
      throw new Error('invalid room storage quota response');
    }
    for (let index = 0; index < objectIds.length; index += 1) {
      if (objectIds[index] !== (await recordObjectId(setId, index))) {
        throw new Error('invalid room storage quota response');
      }
    }
    return objectIds;
  }
  if (result.status === 404) return null;
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

async function consumeUploadSessionRateLimits(
  request,
  env,
  secret,
  roomId,
  idempotencyDigest = null,
) {
  const rateWindowSeconds = parseLimit(
    env.RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  );
  const ipUploadLimit = parseLimit(env.IP_UPLOADS_PER_WINDOW, DEFAULT_IP_UPLOADS_PER_WINDOW);
  const roomUploadLimit = parseOptionalLimit(
    env.ROOM_UPLOADS_PER_WINDOW,
    DEFAULT_ROOM_UPLOADS_PER_WINDOW,
  );
  const markerTtlSeconds = Math.max(
    rateWindowSeconds,
    recordSetTtlSeconds(env) + Math.ceil(EXPIRY_TOMBSTONE_QUIET_MS / 1000),
  );
  const consume = async (key, limit) =>
    idempotencyDigest
      ? consumeIdempotentLimit(
          env,
          key,
          limit,
          rateWindowSeconds,
          idempotencyDigest,
          markerTtlSeconds,
        )
      : consumeLimit(env, key, limit, rateWindowSeconds);
  let ipAllowed;
  try {
    ipAllowed = await consume(await rateLimitIpKey(secret, request), ipUploadLimit);
  } catch (error) {
    console.warn('remote share idempotent rate-limit unavailable', error);
    return json(request, env, { error: 'rate limit unavailable' }, 503);
  }
  if (!ipAllowed) {
    return rateLimited(request, env, 'rate limited', rateWindowSeconds);
  }
  if (roomUploadLimit > 0) {
    let roomAllowed;
    try {
      roomAllowed = await consume(`session-room:${roomId}`, roomUploadLimit);
    } catch (error) {
      console.warn('remote share idempotent room rate-limit unavailable', error);
      return json(request, env, { error: 'rate limit unavailable' }, 503);
    }
    if (!roomAllowed) {
      return rateLimited(request, env, 'room rate limited', rateWindowSeconds);
    }
  }
  return null;
}

async function recordSetReservation(payload, recordIndex) {
  const layout = recordSetLayout(
    Number(payload.size),
    Number(payload.recordSize),
    Number(payload.recordCount),
    recordIndex,
  );
  const objectId = await recordObjectId(payload.setId, recordIndex);
  const key = objectId ? objectKey(payload.roomId, objectId) : null;
  if (!layout || !objectId || !key) return null;
  return {
    cleanupToken: payload.cleanupToken,
    encryptedSize: layout.encryptedSize,
    expiresAt: payload.expiresAt,
    objectId,
    objectKey: key,
    recordCount: payload.recordCount,
    recordIndex,
    roomId: payload.roomId,
    setId: payload.setId,
  };
}

async function recordSetReservations(payload) {
  const reservations = await Promise.all(
    Array.from({ length: payload.recordCount }, (_, recordIndex) =>
      recordSetReservation(payload, recordIndex),
    ),
  );
  return reservations.every(Boolean) ? reservations : null;
}

function validRecordSetTokenPayload(payload, expectedRoomId, expectedSetId) {
  return !(
    !hasExactOwnKeys(payload, RECORD_SET_TOKEN_KEYS) ||
    payload.v !== RECORD_SET_FORMAT_VERSION ||
    payload.kind !== 'record-set' ||
    payload.roomId !== standardRoomId(expectedRoomId) ||
    payload.setId !== expectedSetId ||
    !validRecordSetId(payload.setId) ||
    !safeRecordSetIdentifier(payload.sessionId) ||
    !safeQueueItemId(payload.queueItemId) ||
    !safeRecordSetIdentifier(payload.sourceIdentity) ||
    !safeRecordSetName(payload.name) ||
    !safeRecordSetMime(payload.mime) ||
    !Number.isSafeInteger(payload.size) ||
    payload.recordSize !== RECORD_SET_PLAINTEXT_BYTES ||
    !Number.isSafeInteger(payload.recordCount) ||
    recordSetCount(payload.size, payload.recordSize) !== payload.recordCount ||
    !UUID_V4_RE.test(String(payload.cleanupToken || '')) ||
    !UUID_V4_RE.test(String(payload.nonce || '')) ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.iat > payload.exp ||
    payload.exp !== payload.expiresAt
  );
}

async function verifyRecordSetToken(token, secret, expectedRoomId, expectedSetId) {
  const payload = await verifySignedToken(token, secret);
  const now = Date.now();
  if (
    !validRecordSetTokenPayload(payload, expectedRoomId, expectedSetId) ||
    payload.iat > now + 60_000 ||
    payload.exp <= now
  ) {
    return null;
  }
  return payload;
}

async function recordSetCreateResponse(request, env, secret, tokenPayload) {
  const create = recordSetCreateFromTokenPayload(tokenPayload);
  const reservations = await recordSetReservations(tokenPayload);
  if (!reservations) throw new Error('invalid room storage quota response');
  const setToken = await createSignedToken(tokenPayload, secret);
  const url = new URL(request.url);
  const records = reservations.map((reservation) => {
    const layout = recordSetLayout(
      create.size,
      create.recordSize,
      create.recordCount,
      reservation.recordIndex,
    );
    return {
      index: reservation.recordIndex,
      objectId: reservation.objectId,
      plaintextSize: layout.plaintextSize,
      encryptedSize: layout.encryptedSize,
      downloadUrl: `${url.origin}/download/${create.roomId}/${reservation.objectId}`,
    };
  });
  return json(request, env, {
    v: RECORD_SET_FORMAT_VERSION,
    setId: tokenPayload.setId,
    recordSize: create.recordSize,
    recordCount: create.recordCount,
    expiresAt: tokenPayload.expiresAt,
    setToken,
    cleanupToken: tokenPayload.cleanupToken,
    records,
  });
}

function recordSetIdempotencyConflict(request, env) {
  return json(
    request,
    env,
    {
      error: 'idempotency key already used for a different request',
      code: 'IDEMPOTENCY_CONFLICT',
    },
    409,
  );
}

function recordSetCreateCanceled(request, env) {
  return json(
    request,
    env,
    {
      error: 'record set create intent canceled',
      code: 'CREATE_INTENT_CANCELED',
    },
    410,
  );
}

async function handleRecordSetCreate(request, env, idempotencyRequired = false) {
  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);
  const capabilityError = await requireSessionCapability(request, env);
  if (capabilityError) return capabilityError;

  const parsedBody = await readJsonBodyLimited(request, SESSION_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(request, env, parsedBody);
  const create = parseRecordSetCreate(parsedBody.value);
  if (!create) {
    return json(request, env, { error: 'invalid record set request' }, 400);
  }
  if (!atomicRoomStorageQuotaEnabled(env) || !env.REMOTE_SHARE_BUCKET || !getR2S3Config(env)) {
    return json(request, env, { error: 'record set storage unavailable' }, 503);
  }

  const idempotencyKey = readRecordSetIdempotencyKey(request);
  if (idempotencyKey === '') {
    return json(request, env, { error: 'invalid idempotency key' }, 400);
  }
  if (idempotencyRequired !== (idempotencyKey !== null)) {
    return json(request, env, { error: 'invalid idempotency route' }, 400);
  }
  const idempotencyKeyDigest =
    idempotencyKey === null
      ? null
      : await recordSetCreateIdempotencyDigest(create.roomId, idempotencyKey);
  const requestFingerprint =
    idempotencyKey === null ? null : await recordSetCreateFingerprint(create);
  const rateError = await consumeUploadSessionRateLimits(
    request,
    env,
    secret,
    create.roomId,
    idempotencyKeyDigest,
  );
  if (rateError) return rateError;

  const now = Date.now();
  const objectTtlSeconds = recordSetTtlSeconds(env);
  const expiresAt = now + objectTtlSeconds * 1000;
  const tokenPayload = createRecordSetTokenPayload(create, now, expiresAt);
  const reservations = await recordSetReservations(tokenPayload);
  if (!reservations) {
    return json(request, env, { error: 'invalid record set request' }, 400);
  }

  if (idempotencyKey !== null) {
    let result;
    try {
      result = await createIdempotentRecordSetStorage(
        env,
        create.roomId,
        idempotencyKeyDigest,
        requestFingerprint,
        tokenPayload,
        reservations,
      );
    } catch (error) {
      // The Durable Object persists before it schedules its alarm. A transport
      // or alarm failure can therefore be an acknowledged commit whose exact
      // authority must remain recoverable by the same idempotency key.
      console.warn('remote share idempotent record-set quota unavailable', error);
      return json(request, env, { error: 'room storage quota unavailable' }, 503);
    }
    if (result.kind === 'quota-exceeded') return roomStorageQuotaExceeded(request, env);
    if (result.kind === 'conflict') return recordSetIdempotencyConflict(request, env);
    if (result.kind === 'canceled') return recordSetCreateCanceled(request, env);
    return recordSetCreateResponse(request, env, secret, result.tokenPayload);
  }

  const setId = tokenPayload.setId;
  let quotaReserved = false;
  try {
    let reserved;
    try {
      reserved = await reserveRecordSetStorage(env, create.roomId, setId, reservations);
    } catch (error) {
      console.warn('remote share record-set quota unavailable', error);
      await releaseRecordSetStorageBestEffort(env, create.roomId, setId, reservations);
      return json(request, env, { error: 'room storage quota unavailable' }, 503);
    }
    if (!reserved) return roomStorageQuotaExceeded(request, env);
    quotaReserved = true;

    const response = await recordSetCreateResponse(request, env, secret, tokenPayload);
    quotaReserved = false;
    return response;
  } catch (error) {
    if (quotaReserved) {
      await releaseRecordSetStorageBestEffort(env, create.roomId, setId, reservations);
    }
    throw error;
  }
}

async function handleRecordSetCreateIntentCancel(request, env) {
  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);
  const capabilityError = await requireSessionCapability(request, env);
  if (capabilityError) return capabilityError;

  const parsedBody = await readJsonBodyLimited(request, SESSION_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(request, env, parsedBody);
  const create = parseRecordSetCreate(parsedBody.value);
  if (!create) return json(request, env, { error: 'invalid record set request' }, 400);
  const idempotencyKey = readRecordSetIdempotencyKey(request);
  if (!idempotencyKey) return json(request, env, { error: 'invalid idempotency key' }, 400);
  if (!atomicRoomStorageQuotaEnabled(env) || !env.REMOTE_SHARE_BUCKET || !getR2S3Config(env)) {
    return json(request, env, { error: 'record set storage unavailable' }, 503);
  }

  const now = Date.now();
  const expiresAt = now + recordSetTtlSeconds(env) * 1000;
  const tokenPayload = createRecordSetTokenPayload(create, now, expiresAt);
  const reservations = await recordSetReservations(tokenPayload);
  if (!reservations) return json(request, env, { error: 'invalid record set request' }, 400);
  const idempotencyKeyDigest = await recordSetCreateIdempotencyDigest(
    create.roomId,
    idempotencyKey,
  );
  const requestFingerprint = await recordSetCreateFingerprint(create);
  const rateError = await consumeUploadSessionRateLimits(
    request,
    env,
    secret,
    create.roomId,
    idempotencyKeyDigest,
  );
  if (rateError) return rateError;
  try {
    const result = await cancelIdempotentRecordSetStorage(
      env,
      create.roomId,
      idempotencyKeyDigest,
      requestFingerprint,
      tokenPayload,
      reservations,
    );
    if (result.kind === 'conflict') return recordSetIdempotencyConflict(request, env);
    const keys = result.objectIds
      .map((objectId) => objectKey(create.roomId, objectId))
      .filter(Boolean);
    await deleteBucketKeysInChunks(env.REMOTE_SHARE_BUCKET, keys);
    return json(request, env, { ok: true });
  } catch (error) {
    console.warn('remote share record-set create cancellation unavailable', error);
    return json(request, env, { error: 'room storage quota unavailable' }, 503);
  }
}

async function parseRecordSetAuthority(request, env, roomId, setId) {
  const secret = getSigningSecret(env);
  if (!secret) {
    return { response: json(request, env, { error: 'signing secret missing' }, 500) };
  }
  const parsedBody = await readJsonBodyLimited(request, COMPLETE_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return { response: jsonBodyError(request, env, parsedBody) };
  if (!hasExactOwnKeys(parsedBody.value, RECORD_SET_AUTHORITY_KEYS)) {
    return {
      response: json(request, env, { error: 'invalid record set authority' }, 400),
    };
  }
  if (typeof parsedBody.value.setToken !== 'string') {
    return {
      response: json(request, env, { error: 'invalid record set authority' }, 400),
    };
  }
  const payload = await verifyRecordSetToken(parsedBody.value.setToken, secret, roomId, setId);
  if (!payload) {
    return {
      response: json(request, env, { error: 'invalid record set authority' }, 403),
    };
  }
  return { payload };
}

function recordSetUploadMetadata(payload, reservation, layout, identityHashes) {
  return {
    'content-type': 'application/octet-stream',
    'x-amz-meta-cleanup-token': payload.cleanupToken,
    'x-amz-meta-encrypted-size': String(layout.encryptedSize),
    'x-amz-meta-expires-at': String(payload.expiresAt),
    'x-amz-meta-format-version': String(RECORD_SET_FORMAT_VERSION),
    'x-amz-meta-mime': metadataString(payload.mime, 'application/octet-stream'),
    'x-amz-meta-name': metadataString(payload.name, 'track'),
    'x-amz-meta-object-id': reservation.objectId,
    'x-amz-meta-queue-item-id': payload.queueItemId,
    'x-amz-meta-record-count': String(payload.recordCount),
    'x-amz-meta-record-index': String(reservation.recordIndex),
    'x-amz-meta-record-size': String(payload.recordSize),
    'x-amz-meta-room-id': payload.roomId,
    'x-amz-meta-session-id-sha256': identityHashes.sessionId,
    'x-amz-meta-set-id': payload.setId,
    'x-amz-meta-size-bytes': String(layout.plaintextSize),
    'x-amz-meta-source-identity-sha256': identityHashes.sourceIdentity,
    'x-amz-meta-total-size-bytes': String(payload.size),
  };
}

async function handleRecordUploadUrl(request, env, roomId, setId, recordIndex) {
  if (!getR2S3Config(env)) {
    return json(request, env, { error: 'r2 s3 config missing' }, 500);
  }
  const authority = await parseRecordSetAuthority(request, env, roomId, setId);
  if (authority.response) return authority.response;
  const payload = authority.payload;
  const reservation = await recordSetReservation(payload, recordIndex);
  const layout = recordSetLayout(
    payload.size,
    payload.recordSize,
    payload.recordCount,
    recordIndex,
  );
  if (!reservation || !layout) return json(request, env, { error: 'not found' }, 404);

  let authorization;
  try {
    authorization = await authorizeRecordSetUpload(env, reservation);
  } catch (error) {
    console.warn('remote share record-set authorization unavailable', error);
    return json(request, env, { error: 'room storage quota unavailable' }, 503);
  }
  if (authorization === 'revoked') {
    return json(request, env, { error: 'record set revoked', code: 'RECORD_SET_REVOKED' }, 410);
  }
  if (authorization !== 'authorized') {
    return json(request, env, { error: 'record set unavailable' }, 404);
  }

  const now = Date.now();
  const remainingSeconds = Math.floor((payload.expiresAt - now) / 1000);
  if (remainingSeconds < 1) {
    return json(request, env, { error: 'record set unavailable' }, 404);
  }
  const configuredTtlSeconds = parseLimit(
    env.UPLOAD_TOKEN_TTL_SECONDS,
    DEFAULT_UPLOAD_TOKEN_TTL_SECONDS,
  );
  const ttlSeconds = Math.min(configuredTtlSeconds, remainingSeconds);
  const identityHashes = {
    sessionId: await sha256Hex(payload.sessionId),
    sourceIdentity: await sha256Hex(payload.sourceIdentity),
  };
  const uploadHeaders = recordSetUploadMetadata(payload, reservation, layout, identityHashes);
  const uploadUrl = await createR2PresignedPutUrl({
    env,
    objectKey: reservation.objectKey,
    headers: {
      ...uploadHeaders,
      'content-length': String(layout.encryptedSize),
    },
    expiresInSeconds: ttlSeconds,
    now: new Date(now),
  });
  if (!uploadUrl) return json(request, env, { error: 'r2 s3 config missing' }, 500);
  // Re-check after the asynchronous signer. Durable Object mutation order now
  // establishes a clean boundary: a cleanup that committed first suppresses
  // this URL; a cleanup that commits later is revoking already-issued
  // authority, whose bytes remain reserved until expiry.
  try {
    authorization = await authorizeRecordSetUpload(env, reservation);
  } catch (error) {
    console.warn('remote share record-set authorization unavailable', error);
    return json(request, env, { error: 'room storage quota unavailable' }, 503);
  }
  if (authorization === 'revoked') {
    return json(request, env, { error: 'record set revoked', code: 'RECORD_SET_REVOKED' }, 410);
  }
  if (authorization !== 'authorized') {
    return json(request, env, { error: 'record set unavailable' }, 404);
  }

  const url = new URL(request.url);
  return json(request, env, {
    v: RECORD_SET_FORMAT_VERSION,
    setId,
    index: recordIndex,
    objectId: reservation.objectId,
    plaintextSize: layout.plaintextSize,
    encryptedSize: layout.encryptedSize,
    uploadUrl,
    uploadHeaders,
    uploadUrlExpiresAt: now + ttlSeconds * 1000,
    expiresAt: payload.expiresAt,
    downloadUrl: `${url.origin}/download/${roomId}/${reservation.objectId}`,
  });
}

async function recordSetObjectMetadataMatches(object, payload, reservation, layout) {
  const sessionIdHash = await sha256Hex(payload.sessionId);
  const sourceIdentityHash = await sha256Hex(payload.sourceIdentity);
  return (
    object.size === layout.encryptedSize &&
    Number(readMetadata(object, 'sizeBytes', 'size-bytes', 'sizebytes')) === layout.plaintextSize &&
    Number(readMetadata(object, 'encryptedSize', 'encrypted-size', 'encryptedsize')) ===
      layout.encryptedSize &&
    Number(readMetadata(object, 'totalSizeBytes', 'total-size-bytes', 'totalsizebytes')) ===
      payload.size &&
    Number(readMetadata(object, 'formatVersion', 'format-version', 'formatversion')) ===
      RECORD_SET_FORMAT_VERSION &&
    Number(readMetadata(object, 'recordSize', 'record-size', 'recordsize')) ===
      payload.recordSize &&
    Number(readMetadata(object, 'recordCount', 'record-count', 'recordcount')) ===
      payload.recordCount &&
    Number(readMetadata(object, 'recordIndex', 'record-index', 'recordindex')) ===
      reservation.recordIndex &&
    String(readMetadata(object, 'roomId', 'room-id', 'roomid') || '') === payload.roomId &&
    String(readMetadata(object, 'setId', 'set-id', 'setid') || '') === payload.setId &&
    String(readMetadata(object, 'objectId', 'object-id', 'objectid') || '') ===
      reservation.objectId &&
    String(readMetadata(object, 'queueItemId', 'queue-item-id', 'queueitemid') || '') ===
      payload.queueItemId &&
    constantTimeEqual(
      String(readMetadata(object, 'cleanupToken', 'cleanup-token', 'cleanuptoken') || ''),
      payload.cleanupToken,
    ) &&
    Number(readMetadata(object, 'expiresAt', 'expires-at', 'expiresat')) === payload.expiresAt &&
    constantTimeEqual(
      String(readMetadata(object, 'sessionIdSha256', 'session-id-sha256', 'sessionidsha256') || ''),
      sessionIdHash,
    ) &&
    constantTimeEqual(
      String(
        readMetadata(
          object,
          'sourceIdentitySha256',
          'source-identity-sha256',
          'sourceidentitysha256',
        ) || '',
      ),
      sourceIdentityHash,
    ) &&
    String(readMetadata(object, 'name') || '') === metadataString(payload.name, 'track') &&
    String(readMetadata(object, 'mime') || '') ===
      metadataString(payload.mime, 'application/octet-stream')
  );
}

async function handleRecordComplete(request, env, roomId, setId, recordIndex) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);
  const authority = await parseRecordSetAuthority(request, env, roomId, setId);
  if (authority.response) return authority.response;
  const payload = authority.payload;
  const reservation = await recordSetReservation(payload, recordIndex);
  const layout = recordSetLayout(
    payload.size,
    payload.recordSize,
    payload.recordCount,
    recordIndex,
  );
  if (!reservation || !layout) return json(request, env, { error: 'not found' }, 404);

  const object = await env.REMOTE_SHARE_BUCKET.head(reservation.objectKey);
  if (!object) return json(request, env, { error: 'not found' }, 404);
  if (!(await recordSetObjectMetadataMatches(object, payload, reservation, layout))) {
    await deleteObjectAndRetainReservation(
      env,
      roomId,
      reservation.objectId,
      reservation.objectKey,
      payload.cleanupToken,
    );
    return json(request, env, { error: 'invalid uploaded record' }, 403);
  }
  if (payload.expiresAt <= Date.now()) {
    await deleteObjectAndRetainReservation(
      env,
      roomId,
      reservation.objectId,
      reservation.objectKey,
      payload.cleanupToken,
    );
    return json(request, env, { error: 'expired' }, 404);
  }

  let completion;
  try {
    completion = await completeRecordSetStorageReservation(env, reservation);
  } catch (error) {
    console.warn('remote share record-set completion unavailable', error);
    return json(request, env, { error: 'room storage quota unavailable' }, 503);
  }
  if (completion === 'quota-exceeded') {
    await deleteObjectAndRetainReservation(
      env,
      roomId,
      reservation.objectId,
      reservation.objectKey,
      payload.cleanupToken,
    );
    return roomStorageQuotaExceeded(request, env);
  }
  if (completion === 'revoked') {
    await deleteObjectAndRetainReservation(
      env,
      roomId,
      reservation.objectId,
      reservation.objectKey,
      payload.cleanupToken,
    );
    return json(request, env, { error: 'record set revoked', code: 'RECORD_SET_REVOKED' }, 410);
  }
  if (!completion || completion === 'missing') {
    return json(request, env, { error: 'record set unavailable' }, 404);
  }
  if (payload.expiresAt <= Date.now()) {
    await deleteObjectAndRetainReservation(
      env,
      roomId,
      reservation.objectId,
      reservation.objectKey,
      payload.cleanupToken,
    );
    return json(request, env, { error: 'expired' }, 404);
  }

  const url = new URL(request.url);
  return json(request, env, {
    v: RECORD_SET_FORMAT_VERSION,
    setId,
    index: recordIndex,
    objectId: reservation.objectId,
    expiresAt: payload.expiresAt,
    readyRecordCount: completion.readyRecordCount,
    recordCount: completion.recordCount,
    complete: completion.complete,
    downloadUrl: `${url.origin}/download/${roomId}/${reservation.objectId}`,
  });
}

async function handleRecordSetDelete(request, env, roomId, setId) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);
  const room = standardRoomId(roomId);
  if (!room || !validRecordSetId(setId)) return json(request, env, { error: 'not found' }, 404);
  const cleanupToken = request.headers.get('x-mxqr-cleanup-token') || '';
  if (!UUID_V4_RE.test(cleanupToken)) {
    return json(request, env, { error: 'forbidden' }, 403);
  }

  let objectIds;
  try {
    objectIds = await revokeRecordSetStorage(env, room, setId, cleanupToken);
  } catch (error) {
    console.warn('remote share record-set cleanup unavailable', error);
    return json(request, env, { error: 'room storage quota unavailable' }, 503);
  }
  // Match V1 cleanup's idempotent, non-enumerating response. A missing or
  // unauthorized set is not mutated.
  if (!objectIds) return json(request, env, { ok: true });
  const keys = objectIds.map((objectId) => objectKey(room, objectId)).filter(Boolean);
  await deleteBucketKeysInChunks(env.REMOTE_SHARE_BUCKET, keys);
  // Reservations remain charged and revoked until fixed expiry. Any already
  // issued direct PUT that lands late is then removed by the existing alarm.
  return json(request, env, { ok: true });
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

  const storedFormatVersion = readMetadata(
    object,
    'formatVersion',
    'format-version',
    'formatversion',
  );
  if (storedFormatVersion !== undefined) {
    const setId = String(readMetadata(object, 'setId', 'set-id', 'setid') || '');
    const totalSize = Number(
      readMetadata(object, 'totalSizeBytes', 'total-size-bytes', 'totalsizebytes'),
    );
    const recordSize = Number(readMetadata(object, 'recordSize', 'record-size', 'recordsize'));
    const recordCount = Number(readMetadata(object, 'recordCount', 'record-count', 'recordcount'));
    const recordIndex = Number(readMetadata(object, 'recordIndex', 'record-index', 'recordindex'));
    const layout = recordSetLayout(totalSize, recordSize, recordCount, recordIndex);
    const derivedObjectId = await recordObjectId(setId, recordIndex);
    const queueItemId = String(
      readMetadata(object, 'queueItemId', 'queue-item-id', 'queueitemid') || '',
    );
    const sessionIdHash = String(
      readMetadata(object, 'sessionIdSha256', 'session-id-sha256', 'sessionidsha256') || '',
    );
    const sourceIdentityHash = String(
      readMetadata(
        object,
        'sourceIdentitySha256',
        'source-identity-sha256',
        'sourceidentitysha256',
      ) || '',
    );
    if (
      Number(storedFormatVersion) !== RECORD_SET_FORMAT_VERSION ||
      !validRecordSetId(setId) ||
      !layout ||
      layout.plaintextSize !== plaintextSize ||
      layout.encryptedSize !== encryptedSize ||
      derivedObjectId !== objectId ||
      !safeQueueItemId(queueItemId) ||
      !/^[0-9a-f]{64}$/i.test(sessionIdHash) ||
      !/^[0-9a-f]{64}$/i.test(sourceIdentityHash) ||
      !UUID_V4_RE.test(storedCleanupToken)
    ) {
      await deleteObjectAndRetainReservation(env, roomId, objectId, key, storedCleanupToken);
      return json(request, env, { error: 'invalid stored object' }, 404);
    }
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

function quotaStateWithinSerializedLimit(state) {
  try {
    return (
      new TextEncoder().encode(JSON.stringify(state)).byteLength <= QUOTA_STATE_MAX_SERIALIZED_BYTES
    );
  } catch {
    return false;
  }
}

function reservationRetentionDeadline(reservation) {
  // A presigned PUT is validated when the request starts, not when its body
  // finishes arriving. There is no provider-backed completion bound that
  // permits quota to be released at "URL TTL + skew". Keep the exact-byte
  // reservation through the immutable object expiry instead. After expiry the
  // record becomes a non-charging tombstone which repeatedly sweeps its exact
  // incarnation key. The same fence applies to natural expiry: an upload
  // started before its URL expired can finish after the media lifetime. This
  // is cleanup defense-in-depth, not a claimed PUT completion bound.
  return reservation.tombstoneNextSweepAt ?? reservation.expiresAt;
}

function validCreateIntentReservationMetadata(value) {
  const hasMetadata =
    value?.createIntentVersion !== undefined ||
    value?.createIntentKeyDigest !== undefined ||
    value?.createIntentFingerprint !== undefined ||
    value?.createIntentIat !== undefined ||
    value?.createIntentNonce !== undefined ||
    value?.createIntentCanceledWithoutAuthority !== undefined;
  if (!hasMetadata) return true;
  if (
    value.createIntentVersion !== RECORD_SET_CREATE_IDEMPOTENCY_VERSION ||
    !HMAC_SHA256_BASE64URL_RE.test(String(value.createIntentKeyDigest || '')) ||
    !SHA256_HEX_RE.test(String(value.createIntentFingerprint || '')) ||
    (value.createIntentCanceledWithoutAuthority !== undefined &&
      value.createIntentCanceledWithoutAuthority !== true)
  ) {
    return false;
  }
  if (value.createIntentCanceledWithoutAuthority === true) {
    return (
      value.createIntentIat === undefined &&
      value.createIntentNonce === undefined &&
      Number.isSafeInteger(value.revokedAt) &&
      value.revokedAt === value.expiresAt
    );
  }
  if (value.recordIndex === 0) {
    return (
      Number.isSafeInteger(value.createIntentIat) &&
      value.createIntentIat > 0 &&
      value.createIntentIat <= value.expiresAt &&
      UUID_V4_RE.test(String(value.createIntentNonce || ''))
    );
  }
  return value.createIntentIat === undefined && value.createIntentNonce === undefined;
}

function validQuotaReservation(objectId, value, roomId) {
  const hasTombstoneFields =
    value?.tombstoneQuietSince !== undefined || value?.tombstoneNextSweepAt !== undefined;
  const validTombstoneFields =
    !hasTombstoneFields ||
    (Number.isSafeInteger(value?.tombstoneQuietSince) &&
      value.tombstoneQuietSince >= value.expiresAt &&
      Number.isSafeInteger(value?.tombstoneNextSweepAt) &&
      value.tombstoneNextSweepAt > value.tombstoneQuietSince);
  const hasRecordSetFields =
    value?.setId !== undefined ||
    value?.recordIndex !== undefined ||
    value?.recordCount !== undefined ||
    value?.revokedAt !== undefined;
  const validRecordSetFields =
    !hasRecordSetFields ||
    (validRecordSetId(value?.setId) &&
      Number.isSafeInteger(value?.recordIndex) &&
      value.recordIndex >= 0 &&
      Number.isSafeInteger(value?.recordCount) &&
      value.recordCount > 0 &&
      value.recordCount <= RECORD_SET_MAX_RECORDS &&
      value.recordIndex < value.recordCount &&
      (value.revokedAt === undefined ||
        (Number.isSafeInteger(value.revokedAt) &&
          value.revokedAt > 0 &&
          value.revokedAt <= value.expiresAt)));
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
    (value.status === 'reserved' || value.status === 'completed') &&
    validRecordSetFields &&
    validTombstoneFields &&
    validCreateIntentReservationMetadata(value)
  );
}

function parseQuotaReservation(body) {
  if (body?.tombstoneQuietSince !== undefined || body?.tombstoneNextSweepAt !== undefined) {
    return null;
  }
  const roomId = standardRoomId(body?.roomId);
  const objectId = String(body?.objectId || '');
  const key = objectKey(roomId, objectId);
  const encryptedSize = Number(body?.encryptedSize);
  const expiresAt = Number(body?.expiresAt);
  const cleanupToken = String(body?.cleanupToken || '');
  const hasRecordSetFields =
    body?.setId !== undefined ||
    body?.recordIndex !== undefined ||
    body?.recordCount !== undefined ||
    body?.revokedAt !== undefined;
  const setId = hasRecordSetFields ? String(body?.setId || '') : undefined;
  const recordIndex = hasRecordSetFields ? Number(body?.recordIndex) : undefined;
  const recordCount = hasRecordSetFields ? Number(body?.recordCount) : undefined;
  const revokedAt =
    hasRecordSetFields && body?.revokedAt !== undefined ? Number(body.revokedAt) : undefined;
  if (
    !roomId ||
    !key ||
    body?.objectKey !== key ||
    !Number.isSafeInteger(encryptedSize) ||
    encryptedSize <= AES_GCM_TAG_BYTES ||
    encryptedSize > REMOTE_SHARE_MAX_ENCRYPTED_BYTES ||
    !Number.isSafeInteger(expiresAt) ||
    cleanupToken.length < 16 ||
    (hasRecordSetFields &&
      (!validRecordSetId(setId) ||
        !Number.isSafeInteger(recordIndex) ||
        recordIndex < 0 ||
        !Number.isSafeInteger(recordCount) ||
        recordCount <= 0 ||
        recordCount > RECORD_SET_MAX_RECORDS ||
        recordIndex >= recordCount ||
        (revokedAt !== undefined &&
          (!Number.isSafeInteger(revokedAt) || revokedAt <= 0 || revokedAt > expiresAt))))
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
    ...(hasRecordSetFields
      ? {
          recordCount,
          recordIndex,
          setId,
          ...(revokedAt === undefined ? {} : { revokedAt }),
        }
      : {}),
  };
}

function reservationsMatch(left, right) {
  return (
    left.objectId === right.objectId &&
    left.objectKey === right.objectKey &&
    left.encryptedSize === right.encryptedSize &&
    left.expiresAt === right.expiresAt &&
    constantTimeEqual(left.cleanupToken, right.cleanupToken) &&
    (left.setId ?? null) === (right.setId ?? null) &&
    (left.recordIndex ?? null) === (right.recordIndex ?? null) &&
    (left.recordCount ?? null) === (right.recordCount ?? null)
  );
}

async function parseRecordSetQuotaBatch(body) {
  if (
    !hasExactOwnKeys(body, ['roomId', 'reservations', 'setId']) ||
    !standardRoomId(body.roomId) ||
    !validRecordSetId(body.setId) ||
    !Array.isArray(body.reservations) ||
    body.reservations.length === 0 ||
    body.reservations.length > RECORD_SET_MAX_RECORDS
  ) {
    return null;
  }
  const reservations = [];
  for (const raw of body.reservations) {
    if (!hasExactOwnKeys(raw, RECORD_SET_RESERVATION_KEYS)) return null;
    const reservation = parseQuotaReservation(raw);
    if (
      !reservation ||
      reservation.roomId !== body.roomId ||
      reservation.setId !== body.setId ||
      reservation.recordCount !== body.reservations.length
    ) {
      return null;
    }
    const expectedObjectId = await recordObjectId(body.setId, reservation.recordIndex);
    if (reservation.objectId !== expectedObjectId) return null;
    reservations.push(reservation);
  }
  reservations.sort((left, right) => left.recordIndex - right.recordIndex);
  for (let index = 0; index < reservations.length; index += 1) {
    if (reservations[index].recordIndex !== index) return null;
    if (
      reservations[index].expiresAt !== reservations[0].expiresAt ||
      !constantTimeEqual(reservations[index].cleanupToken, reservations[0].cleanupToken)
    ) {
      return null;
    }
  }
  return {
    reservations,
    roomId: body.roomId,
    setId: body.setId,
  };
}

async function parseIdempotentRecordSetQuotaBatch(body) {
  if (
    !hasExactOwnKeys(body, [
      'idempotencyKeyDigest',
      'requestFingerprint',
      'reservations',
      'roomId',
      'setId',
      'tokenPayload',
    ]) ||
    !HMAC_SHA256_BASE64URL_RE.test(String(body.idempotencyKeyDigest || '')) ||
    !SHA256_HEX_RE.test(String(body.requestFingerprint || ''))
  ) {
    return null;
  }
  const batch = await parseRecordSetQuotaBatch({
    roomId: body.roomId,
    reservations: body.reservations,
    setId: body.setId,
  });
  if (
    !batch ||
    !validRecordSetTokenPayload(body.tokenPayload, batch.roomId, batch.setId) ||
    body.tokenPayload.expiresAt !== batch.reservations[0].expiresAt ||
    body.tokenPayload.cleanupToken !== batch.reservations[0].cleanupToken ||
    body.tokenPayload.recordCount !== batch.reservations.length ||
    (await recordSetCreateFingerprint(recordSetCreateFromTokenPayload(body.tokenPayload))) !==
      body.requestFingerprint
  ) {
    return null;
  }
  return {
    ...batch,
    idempotencyKeyDigest: body.idempotencyKeyDigest,
    requestFingerprint: body.requestFingerprint,
    tokenPayload: body.tokenPayload,
  };
}

function parseIdempotentRateRequest(body) {
  if (
    !hasExactOwnKeys(body, [
      'idempotencyDigest',
      'keyDigest',
      'limit',
      'markerTtlSeconds',
      'windowSeconds',
    ]) ||
    !HMAC_SHA256_BASE64URL_RE.test(String(body.idempotencyDigest || '')) ||
    !SHA256_HEX_RE.test(String(body.keyDigest || '')) ||
    !Number.isFinite(body.limit) ||
    body.limit <= 0 ||
    !Number.isFinite(body.markerTtlSeconds) ||
    body.markerTtlSeconds <= 0 ||
    !Number.isFinite(body.windowSeconds) ||
    body.windowSeconds <= 0
  ) {
    return null;
  }
  const limit = Math.ceil(body.limit);
  const markerTtlMs = Math.ceil(body.markerTtlSeconds * 1000);
  const windowMs = Math.ceil(body.windowSeconds * 1000);
  if (
    !Number.isSafeInteger(limit) ||
    !Number.isSafeInteger(markerTtlMs) ||
    !Number.isSafeInteger(windowMs)
  ) {
    return null;
  }
  return {
    idempotencyDigest: body.idempotencyDigest,
    keyDigest: body.keyDigest,
    limit,
    markerTtlMs,
    windowMs,
  };
}

function emptyIdempotentRateState(keyDigest) {
  return {
    v: IDEMPOTENT_RATE_STATE_VERSION,
    keyDigest,
    count: 0,
    windowExpiresAt: 0,
    markers: {},
  };
}

function validIdempotentRateState(value, keyDigest) {
  return (
    value &&
    typeof value === 'object' &&
    value.v === IDEMPOTENT_RATE_STATE_VERSION &&
    value.keyDigest === keyDigest &&
    SHA256_HEX_RE.test(String(value.keyDigest || '')) &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    Number.isSafeInteger(value.windowExpiresAt) &&
    value.windowExpiresAt >= 0 &&
    value.markers &&
    typeof value.markers === 'object' &&
    !Array.isArray(value.markers) &&
    Object.keys(value.markers).length <= IDEMPOTENT_RATE_MAX_MARKERS &&
    Object.entries(value.markers).every(
      ([digest, expiresAt]) =>
        HMAC_SHA256_BASE64URL_RE.test(digest) && Number.isSafeInteger(expiresAt) && expiresAt > 0,
    )
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
      if (
        reservation.setId !== undefined &&
        (await recordObjectId(reservation.setId, reservation.recordIndex)) !== objectId
      ) {
        throw new Error('invalid room storage reservation state');
      }
      reservations[objectId] = { ...reservation };
    }
    const createIntents = new Map();
    for (const reservation of Object.values(reservations)) {
      if (reservation.createIntentKeyDigest === undefined) continue;
      const existing = createIntents.get(reservation.createIntentKeyDigest) || [];
      existing.push(reservation);
      createIntents.set(reservation.createIntentKeyDigest, existing);
    }
    for (const records of createIntents.values()) {
      const first = records[0];
      if (
        records.some(
          (record) =>
            record.setId !== first.setId ||
            record.createIntentFingerprint !== first.createIntentFingerprint ||
            record.createIntentCanceledWithoutAuthority !==
              first.createIntentCanceledWithoutAuthority,
        )
      ) {
        throw new Error('invalid room storage create intent state');
      }
      const recordZero = records.find((record) => record.recordIndex === 0);
      if (first.createIntentCanceledWithoutAuthority === true) {
        if (records.length !== 1 || !recordZero) {
          throw new Error('invalid room storage create intent state');
        }
        continue;
      }
      if (!recordZero) {
        if (records.some((record) => record.expiresAt > Date.now())) {
          throw new Error('invalid room storage create intent state');
        }
        continue;
      }
    }
    return {
      v: QUOTA_STATE_VERSION,
      roomId,
      reservations,
    };
  }

  async scheduleAlarm(state) {
    const expiries = Object.values(state.reservations).map(reservationRetentionDeadline);
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
    const expiredReservationKeys = Object.values(state.reservations)
      .filter((reservation) => reservation.expiresAt <= now)
      .map((reservation) => reservation.objectKey);
    if (expiredReservationKeys.length > 0) {
      // The prefix scan removes correctly tagged expired objects. Delete the
      // exact incarnation keys as well so malformed or very late arrivals are
      // swept without ever being adopted by a successor set.
      await deleteBucketKeysInChunks(this.env.REMOTE_SHARE_BUCKET, expiredReservationKeys);
    }
    let changed = false;
    for (const [objectId, reservation] of Object.entries(state.reservations)) {
      if (reservation.expiresAt > now) continue;

      const observed = snapshot.observedKeys.has(reservation.objectKey);
      const priorQuietSince = reservation.tombstoneQuietSince;
      const quietSince = observed || !Number.isSafeInteger(priorQuietSince) ? now : priorQuietSince;
      if (
        !observed &&
        Number.isSafeInteger(priorQuietSince) &&
        now - priorQuietSince >= EXPIRY_TOMBSTONE_QUIET_MS
      ) {
        delete state.reservations[objectId];
        changed = true;
        continue;
      }
      const tombstoneNextSweepAt = now + EXPIRY_TOMBSTONE_SWEEP_MS;
      if (
        reservation.tombstoneQuietSince !== quietSince ||
        reservation.tombstoneNextSweepAt !== tombstoneNextSweepAt
      ) {
        state.reservations[objectId] = {
          ...reservation,
          tombstoneQuietSince: quietSince,
          tombstoneNextSweepAt,
        };
        changed = true;
      }
    }
    return { changed, snapshot };
  }

  accountedBytes(state, snapshot, now) {
    let totalBytes = snapshot.totalBytes;
    for (const reservation of Object.values(state.reservations)) {
      // Every expired object is unusable at the download boundary. Its exact
      // key remains in repeated-sweep tombstone state, but it no longer
      // consumes active media quota.
      if (reservation.expiresAt <= now) continue;
      // A cancel that won before any create authority was exposed is retained
      // only as an idempotency tombstone. It has no reusable presigned PUT and
      // therefore must not consume active media quota.
      if (reservation.createIntentCanceledWithoutAuthority === true) continue;
      if (!snapshot.activeKeys.has(reservation.objectKey)) {
        totalBytes += reservation.encryptedSize;
      }
    }
    return Number.isSafeInteger(totalBytes) ? totalBytes : Number.POSITIVE_INFINITY;
  }

  async handleFetch(request) {
    if (request.method !== 'POST') return quotaJson({ error: 'NOT_FOUND' }, 404);
    const url = new URL(request.url);
    const isBatchOperation =
      url.pathname === '/reserve-batch' ||
      url.pathname === '/release-batch' ||
      url.pathname === '/create-set' ||
      url.pathname === '/cancel-create';
    const parsedBody = await readJsonBodyLimited(
      request,
      isBatchOperation ? QUOTA_BATCH_JSON_BODY_MAX_BYTES : QUOTA_JSON_BODY_MAX_BYTES,
    );
    if (parsedBody.error) return quotaJson({ error: 'INVALID_REQUEST' }, 400);
    const body = parsedBody.value;
    if (url.pathname === '/consume-idempotent-rate') {
      const rateRequest = parseIdempotentRateRequest(body);
      if (!rateRequest) return quotaJson({ error: 'INVALID_REQUEST' }, 400);
      return this.handleIdempotentRate(rateRequest);
    }
    const roomId = standardRoomId(body?.roomId);
    if (!roomId) return quotaJson({ error: 'INVALID_REQUEST' }, 400);

    if (url.pathname === '/create-set' || url.pathname === '/cancel-create') {
      const batch = await parseIdempotentRecordSetQuotaBatch(body);
      if (!batch || batch.roomId !== roomId) {
        return quotaJson({ error: 'INVALID_REQUEST' }, 400);
      }
      return url.pathname === '/create-set'
        ? this.handleIdempotentCreate(batch)
        : this.handleIdempotentCancel(batch);
    }
    if (isBatchOperation) {
      const batch = await parseRecordSetQuotaBatch(body);
      if (!batch || batch.roomId !== roomId) {
        return quotaJson({ error: 'INVALID_REQUEST' }, 400);
      }
      return url.pathname === '/reserve-batch'
        ? this.handleReserveBatch(batch)
        : this.handleReleaseBatch(batch);
    }
    if (url.pathname === '/authorize-record') {
      const reservation = parseQuotaReservation(body);
      if (!reservation || !reservation.setId || reservation.roomId !== roomId) {
        return quotaJson({ error: 'INVALID_REQUEST' }, 400);
      }
      return this.handleAuthorizeRecord(reservation);
    }
    if (url.pathname === '/revoke-set') {
      if (
        !hasExactOwnKeys(body, ['cleanupToken', 'roomId', 'setId']) ||
        !validRecordSetId(body.setId) ||
        !UUID_V4_RE.test(String(body.cleanupToken || ''))
      ) {
        return quotaJson({ error: 'INVALID_REQUEST' }, 400);
      }
      return this.handleRevokeSet(roomId, body.setId, body.cleanupToken);
    }
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

  async handleIdempotentRate(rateRequest) {
    const now = Date.now();
    const stored = await this.storage.get(IDEMPOTENT_RATE_STATE_KEY);
    const state =
      stored === undefined || stored === null
        ? emptyIdempotentRateState(rateRequest.keyDigest)
        : stored;
    if (!validIdempotentRateState(state, rateRequest.keyDigest)) {
      throw new Error('invalid idempotent rate-limit state');
    }

    let changed = false;
    for (const [digest, expiresAt] of Object.entries(state.markers)) {
      if (expiresAt > now) continue;
      delete state.markers[digest];
      changed = true;
    }
    if (state.windowExpiresAt <= now) {
      state.count = 0;
      state.windowExpiresAt = 0;
      changed = true;
    }

    if (state.markers[rateRequest.idempotencyDigest] > now) {
      await this.persistIdempotentRateState(state, changed, now);
      return quotaJson({ allowed: true, replayed: true });
    }
    if (state.count >= rateRequest.limit) {
      await this.persistIdempotentRateState(state, changed, now);
      return quotaJson({ allowed: false, replayed: false });
    }
    if (Object.keys(state.markers).length >= IDEMPOTENT_RATE_MAX_MARKERS) {
      await this.persistIdempotentRateState(state, changed, now);
      return quotaJson({ error: 'RATE_LIMIT_STATE_SATURATED' }, 503);
    }

    state.count += 1;
    state.windowExpiresAt = now + rateRequest.windowMs;
    state.markers[rateRequest.idempotencyDigest] = now + rateRequest.markerTtlMs;
    await this.persistIdempotentRateState(state, true, now);
    return quotaJson({ allowed: true, replayed: false });
  }

  async persistIdempotentRateState(state, changed, now) {
    const deadlines = [
      ...(state.windowExpiresAt > now ? [state.windowExpiresAt] : []),
      ...Object.values(state.markers).filter((expiresAt) => expiresAt > now),
    ];
    if (deadlines.length === 0) {
      await this.storage.delete(IDEMPOTENT_RATE_STATE_KEY);
      if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
      return;
    }
    if (changed) await this.storage.put(IDEMPOTENT_RATE_STATE_KEY, state);
    if (typeof this.storage.setAlarm === 'function') {
      await this.storage.setAlarm(Math.max(now + 1, Math.min(...deadlines)));
    }
  }

  async maintainIdempotentRateState(state, now) {
    let changed = false;
    for (const [digest, expiresAt] of Object.entries(state.markers)) {
      if (expiresAt > now) continue;
      delete state.markers[digest];
      changed = true;
    }
    if (state.windowExpiresAt <= now && (state.count !== 0 || state.windowExpiresAt !== 0)) {
      state.count = 0;
      state.windowExpiresAt = 0;
      changed = true;
    }
    await this.persistIdempotentRateState(state, changed, now);
  }

  findCreateIntent(state, batch, now) {
    const records = Object.values(state.reservations)
      .filter((reservation) =>
        constantTimeEqual(
          String(reservation.createIntentKeyDigest || ''),
          batch.idempotencyKeyDigest,
        ),
      )
      .sort((left, right) => left.recordIndex - right.recordIndex);
    if (records.length === 0) return { kind: 'missing' };
    if (
      records.some(
        (reservation) => reservation.createIntentFingerprint !== batch.requestFingerprint,
      )
    ) {
      return { kind: 'conflict' };
    }
    if (records.some((reservation) => reservation.setId !== records[0].setId)) {
      throw new Error('invalid room storage create intent state');
    }
    if (
      records.some((reservation) => reservation.revokedAt !== undefined) ||
      records.some((reservation) => reservation.expiresAt <= now)
    ) {
      return { kind: 'canceled', records };
    }
    if (
      records.length !== records[0].recordCount ||
      records.some(
        (reservation, index) =>
          reservation.recordIndex !== index ||
          reservation.recordCount !== records.length ||
          reservation.createIntentVersion !== RECORD_SET_CREATE_IDEMPOTENCY_VERSION,
      )
    ) {
      throw new Error('invalid room storage create intent state');
    }
    const authority = records[0];
    const tokenPayload = {
      ...batch.tokenPayload,
      setId: authority.setId,
      cleanupToken: authority.cleanupToken,
      expiresAt: authority.expiresAt,
      iat: authority.createIntentIat,
      exp: authority.expiresAt,
      nonce: authority.createIntentNonce,
    };
    if (!validRecordSetTokenPayload(tokenPayload, records[0].roomId, records[0].setId)) {
      throw new Error('invalid room storage create intent state');
    }
    return { kind: 'replayed', records, tokenPayload };
  }

  createIntentReservation(batch, reservation) {
    return {
      ...reservation,
      status: 'reserved',
      createIntentVersion: RECORD_SET_CREATE_IDEMPOTENCY_VERSION,
      createIntentKeyDigest: batch.idempotencyKeyDigest,
      createIntentFingerprint: batch.requestFingerprint,
      ...(reservation.recordIndex === 0
        ? {
            createIntentIat: batch.tokenPayload.iat,
            createIntentNonce: batch.tokenPayload.nonce,
          }
        : {}),
    };
  }

  async handleIdempotentCreate(batch) {
    const quotaBytes = roomStorageQuotaBytes(this.env);
    if (quotaBytes <= 0) return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    const now = Date.now();
    if (batch.tokenPayload.expiresAt <= now) {
      return quotaJson({ error: 'INVALID_REQUEST' }, 400);
    }

    const state = await this.readState(batch.roomId);
    const { changed, snapshot } = await this.reconcile(state, now);
    const existingIntent = this.findCreateIntent(state, batch, now);
    if (existingIntent.kind === 'conflict') {
      await this.maintainState(state, changed);
      return quotaJson({ code: 'IDEMPOTENCY_CONFLICT' }, 409);
    }
    if (existingIntent.kind === 'canceled') {
      await this.maintainState(state, changed);
      return quotaJson({ code: 'CREATE_INTENT_CANCELED' }, 410);
    }
    if (existingIntent.kind === 'replayed') {
      await this.maintainState(state, changed);
      return quotaJson({
        kind: 'replayed',
        tokenPayload: existingIntent.tokenPayload,
      });
    }

    for (const reservation of batch.reservations) {
      const existing = state.reservations[reservation.objectId];
      if (existing || snapshot.activeKeys.has(reservation.objectKey)) {
        await this.maintainState(state, changed);
        return quotaJson({ error: 'RESERVATION_CONFLICT' }, 409);
      }
    }
    if (
      Object.keys(state.reservations).length + batch.reservations.length >
      QUOTA_STATE_MAX_ENTRIES
    ) {
      await this.maintainState(state, changed);
      return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    }
    const additionalBytes = batch.reservations.reduce(
      (total, reservation) => total + reservation.encryptedSize,
      0,
    );
    const accountedBytes = this.accountedBytes(state, snapshot, now);
    if (!Number.isSafeInteger(additionalBytes) || accountedBytes + additionalBytes > quotaBytes) {
      await this.maintainState(state, changed);
      return quotaJson(
        {
          code: 'ROOM_STORAGE_QUOTA_EXCEEDED',
          maxBytes: quotaBytes,
        },
        409,
      );
    }

    for (const reservation of batch.reservations) {
      state.reservations[reservation.objectId] = this.createIntentReservation(batch, reservation);
    }
    if (!quotaStateWithinSerializedLimit(state)) {
      for (const reservation of batch.reservations) {
        delete state.reservations[reservation.objectId];
      }
      await this.maintainState(state, changed);
      return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    }
    await this.persistState(state);
    return quotaJson({
      kind: 'created',
      tokenPayload: batch.tokenPayload,
    });
  }

  async handleIdempotentCancel(batch) {
    const now = Date.now();
    if (batch.tokenPayload.expiresAt <= now) {
      return quotaJson({ error: 'INVALID_REQUEST' }, 400);
    }
    const state = await this.readState(batch.roomId);
    const { changed, snapshot } = await this.reconcile(state, now);
    const existingIntent = this.findCreateIntent(state, batch, now);
    if (existingIntent.kind === 'conflict') {
      await this.maintainState(state, changed);
      return quotaJson({ code: 'IDEMPOTENCY_CONFLICT' }, 409);
    }
    if (existingIntent.kind === 'canceled') {
      await this.maintainState(state, changed);
      return quotaJson({
        canceled: true,
        setId: existingIntent.records[0].setId,
        objectIds: existingIntent.records.map((reservation) => reservation.objectId),
      });
    }
    if (existingIntent.kind === 'replayed') {
      for (const reservation of existingIntent.records) {
        state.reservations[reservation.objectId] = {
          ...reservation,
          revokedAt: now,
        };
      }
      await this.persistState(state);
      return quotaJson({
        canceled: true,
        setId: existingIntent.records[0].setId,
        objectIds: existingIntent.records.map((reservation) => reservation.objectId),
      });
    }

    if (Object.keys(state.reservations).length + 1 > QUOTA_STATE_MAX_ENTRIES) {
      await this.maintainState(state, changed);
      return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    }
    const tombstoneReservation = batch.reservations[0];
    if (snapshot.activeKeys.has(tombstoneReservation.objectKey)) {
      await this.maintainState(state, changed);
      return quotaJson({ error: 'RESERVATION_CONFLICT' }, 409);
    }
    state.reservations[tombstoneReservation.objectId] = {
      ...tombstoneReservation,
      expiresAt: now,
      status: 'reserved',
      revokedAt: now,
      createIntentVersion: RECORD_SET_CREATE_IDEMPOTENCY_VERSION,
      createIntentKeyDigest: batch.idempotencyKeyDigest,
      createIntentFingerprint: batch.requestFingerprint,
      createIntentCanceledWithoutAuthority: true,
    };
    if (!quotaStateWithinSerializedLimit(state)) {
      delete state.reservations[tombstoneReservation.objectId];
      await this.maintainState(state, changed);
      return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    }
    await this.persistState(state);
    return quotaJson({
      canceled: true,
      setId: tombstoneReservation.setId,
      objectIds: [tombstoneReservation.objectId],
    });
  }

  async handleReserveBatch(batch) {
    const quotaBytes = roomStorageQuotaBytes(this.env);
    if (quotaBytes <= 0) return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    const now = Date.now();
    if (batch.reservations[0].expiresAt <= now) {
      return quotaJson({ error: 'INVALID_REQUEST' }, 400);
    }

    const state = await this.readState(batch.roomId);
    const { changed, snapshot } = await this.reconcile(state, now);
    const missing = [];
    for (const reservation of batch.reservations) {
      const existing = state.reservations[reservation.objectId];
      if (existing) {
        if (!reservationsMatch(existing, reservation) || existing.revokedAt !== undefined) {
          await this.maintainState(state, changed);
          return quotaJson({ error: 'RESERVATION_CONFLICT' }, 409);
        }
        continue;
      }
      // A deterministic record identifier is never shared by two sets. An
      // untracked physical object at this exact key is therefore an ambiguous
      // stale write, not capacity that a new reservation may adopt.
      if (snapshot.activeKeys.has(reservation.objectKey)) {
        await this.maintainState(state, changed);
        return quotaJson({ error: 'RESERVATION_CONFLICT' }, 409);
      }
      missing.push(reservation);
    }

    if (Object.keys(state.reservations).length + missing.length > QUOTA_STATE_MAX_ENTRIES) {
      await this.maintainState(state, changed);
      return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    }
    const additionalBytes = missing.reduce(
      (total, reservation) => total + reservation.encryptedSize,
      0,
    );
    const accountedBytes = this.accountedBytes(state, snapshot, now);
    if (!Number.isSafeInteger(additionalBytes) || accountedBytes + additionalBytes > quotaBytes) {
      await this.maintainState(state, changed);
      return quotaJson(
        {
          code: 'ROOM_STORAGE_QUOTA_EXCEEDED',
          maxBytes: quotaBytes,
        },
        409,
      );
    }

    if (missing.length === 0) {
      await this.maintainState(state, changed);
      return quotaJson({ reserved: true });
    }
    for (const reservation of missing) {
      state.reservations[reservation.objectId] = {
        ...reservation,
        status: 'reserved',
      };
    }
    if (!quotaStateWithinSerializedLimit(state)) {
      for (const reservation of missing) {
        delete state.reservations[reservation.objectId];
      }
      await this.maintainState(state, changed);
      return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    }
    await this.persistState(state);
    return quotaJson({ reserved: true });
  }

  async handleReleaseBatch(batch) {
    const state = await this.readState(batch.roomId);
    const existing = batch.reservations.map(
      (reservation) => state.reservations[reservation.objectId],
    );
    if (existing.every((reservation) => !reservation)) {
      await this.scheduleAlarm(state);
      return quotaJson({ released: false });
    }
    if (
      existing.some(
        (reservation, index) =>
          !reservation ||
          reservation.revokedAt !== undefined ||
          !reservationsMatch(reservation, batch.reservations[index]),
      )
    ) {
      await this.scheduleAlarm(state);
      return quotaJson({ error: 'RESERVATION_CONFLICT' }, 409);
    }
    for (const reservation of batch.reservations) {
      delete state.reservations[reservation.objectId];
    }
    await this.persistState(state);
    return quotaJson({ released: true });
  }

  async handleAuthorizeRecord(reservation) {
    if (reservation.expiresAt <= Date.now()) {
      return quotaJson({ error: 'RESERVATION_MISSING' }, 404);
    }
    const state = await this.readState(reservation.roomId);
    const existing = state.reservations[reservation.objectId];
    if (!existing || !reservationsMatch(existing, reservation)) {
      await this.scheduleAlarm(state);
      return quotaJson({ error: 'RESERVATION_MISSING' }, 404);
    }
    if (existing.revokedAt !== undefined) {
      await this.scheduleAlarm(state);
      return quotaJson({ code: 'RECORD_SET_REVOKED' }, 410);
    }
    await this.scheduleAlarm(state);
    return quotaJson({ authorized: true });
  }

  async handleRevokeSet(roomId, setId, cleanupToken) {
    const state = await this.readState(roomId);
    const records = Object.values(state.reservations)
      .filter((reservation) => reservation.setId === setId)
      .sort((left, right) => left.recordIndex - right.recordIndex);
    if (
      records.length === 0 ||
      records.length !== records[0].recordCount ||
      records.some(
        (reservation, index) =>
          reservation.recordIndex !== index ||
          reservation.recordCount !== records.length ||
          reservation.expiresAt <= Date.now() ||
          !constantTimeEqual(reservation.cleanupToken, cleanupToken),
      )
    ) {
      await this.scheduleAlarm(state);
      return quotaJson({ error: 'RESERVATION_MISSING' }, 404);
    }
    const revokedAt = Date.now();
    if (records.some((reservation) => reservation.expiresAt <= revokedAt)) {
      await this.scheduleAlarm(state);
      return quotaJson({ error: 'RESERVATION_MISSING' }, 404);
    }
    let changed = false;
    for (const reservation of records) {
      if (reservation.revokedAt === undefined) {
        state.reservations[reservation.objectId] = {
          ...reservation,
          revokedAt,
        };
        changed = true;
      }
    }
    await this.maintainState(state, changed);
    return quotaJson({
      revoked: true,
      objectIds: records.map((reservation) => reservation.objectId),
    });
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
    const accountedBytes = this.accountedBytes(state, snapshot, now);
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
    if (!quotaStateWithinSerializedLimit(state)) {
      delete state.reservations[reservation.objectId];
      await this.maintainState(state, changed);
      return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    }
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
    if (existing.revokedAt !== undefined) {
      await this.maintainState(state, changed);
      return quotaJson({ code: 'RECORD_SET_REVOKED' }, 410);
    }

    // Disabling new quota admission must not strand reservations already
    // issued by the previous configuration. They still settle through this
    // Durable Object; only the over-limit decision is disabled.
    if (quotaBytes > 0 && this.accountedBytes(state, snapshot, now) > quotaBytes) {
      await this.maintainState(state, changed);
      return quotaJson(
        {
          code: 'ROOM_STORAGE_QUOTA_EXCEEDED',
          maxBytes: quotaBytes,
        },
        409,
      );
    }

    if (!reservation.setId) {
      state.reservations[reservation.objectId] = {
        ...existing,
        status: 'completed',
      };
      await this.persistState(state);
      return quotaJson({ completed: true });
    }
    const records = Object.values(state.reservations)
      .filter((candidate) => candidate.setId === reservation.setId)
      .sort((left, right) => left.recordIndex - right.recordIndex);
    if (
      records.length !== reservation.recordCount ||
      records.some(
        (candidate, index) =>
          candidate.recordIndex !== index ||
          candidate.recordCount !== reservation.recordCount ||
          candidate.revokedAt !== undefined,
      )
    ) {
      await this.maintainState(state, changed);
      return quotaJson({ error: 'RESERVATION_MISSING' }, 404);
    }
    state.reservations[reservation.objectId] = {
      ...existing,
      status: 'completed',
    };
    const readyRecordCount = records.findIndex(
      (candidate) =>
        candidate.objectId !== reservation.objectId && candidate.status !== 'completed',
    );
    const contiguousReadyRecordCount = readyRecordCount === -1 ? records.length : readyRecordCount;
    await this.persistState(state);
    return quotaJson({
      completed: true,
      readyRecordCount: contiguousReadyRecordCount,
      recordCount: reservation.recordCount,
    });
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
        const rateStored = await this.storage.get(IDEMPOTENT_RATE_STATE_KEY);
        if (rateStored !== undefined && rateStored !== null) {
          if (!validIdempotentRateState(rateStored, rateStored?.keyDigest)) {
            throw new Error('invalid idempotent rate-limit state');
          }
          await this.maintainIdempotentRateState(rateStored, Date.now());
          return;
        }
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
      if (request.method === 'POST' && path === '/v2/sets') {
        return handleRecordSetCreate(request, env);
      }
      if (request.method === 'POST' && path === '/v2/sets/idempotent') {
        return handleRecordSetCreate(request, env, true);
      }
      if (request.method === 'POST' && path === '/v2/sets/intents/cancel') {
        return handleRecordSetCreateIntentCancel(request, env);
      }
      const recordOperation = path.match(
        /^\/v2\/sets\/([^/]+)\/([^/]+)\/records\/(\d+)\/(upload|complete)$/,
      );
      if (request.method === 'POST' && recordOperation) {
        const recordIndex = Number(recordOperation[3]);
        return recordOperation[4] === 'upload'
          ? handleRecordUploadUrl(request, env, recordOperation[1], recordOperation[2], recordIndex)
          : handleRecordComplete(request, env, recordOperation[1], recordOperation[2], recordIndex);
      }
      const recordSet = path.match(/^\/v2\/sets\/([^/]+)\/([^/]+)$/);
      if (request.method === 'DELETE' && recordSet) {
        return handleRecordSetDelete(request, env, recordSet[1], recordSet[2]);
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
