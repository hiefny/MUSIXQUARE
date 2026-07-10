/**
 * MUSIXQUARE temporary encrypted file-share Worker.
 *
 * Required bindings:
 * - REMOTE_SHARE_BUCKET: R2 bucket
 * - REMOTE_SHARE_RATE_LIMITER: Durable Object namespace
 * - REMOTE_SHARE_SIGNING_SECRET: HMAC secret for upload session tokens
 * - R2_ACCOUNT_ID: Cloudflare account ID for S3 presigned URLs
 * - R2_ACCESS_KEY_ID: bucket-scoped R2 S3 API access key ID
 * - R2_SECRET_ACCESS_KEY: bucket-scoped R2 S3 API secret access key
 *
 * Optional env:
 * - R2_BUCKET_NAME: default musixquare-remote-share
 * - MAX_UPLOAD_BYTES: default 5363466224 (R2's safe single-PUT ceiling minus
 *     the 16-byte AES-GCM tag). Direct v3 uploads do not traverse the Worker.
 * - MAX_MULTIPART_UPLOAD_BYTES: default 5368709120 (5 GiB plaintext). V4 maps
 *     each 8 MiB plaintext AES-GCM record to one direct R2 multipart part.
 * - MULTIPART_PART_URL_BATCH_SIZE: maximum v4 presigned URLs per /parts call,
 *     default 64.
 * - OBJECT_TTL_SECONDS: default 43200 (12 hours) after the v3/v4 transfer allowance
 * - UPLOAD_TOKEN_TTL_SECONDS: default v2 TTL and v3 minimum, 600
 * - RATE_LIMIT_WINDOW_SECONDS: default 3600
 * - IP_SESSIONS_PER_WINDOW: default 60
 * - IP_UPLOADS_PER_WINDOW: default 60
 * - IP_UPLOAD_BYTES_PER_WINDOW: default 20 GiB reserved direct-upload bytes
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

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
// R2 documents the maximum single-request upload as 5 MiB less than 5 GiB.
const R2_SINGLE_PUT_MAX_ENCRYPTED_BYTES = 5 * 1024 * 1024 * 1024 - 5 * MIB;
const AES_GCM_TAG_BYTES = 16;
const DEFAULT_MAX_UPLOAD_BYTES = R2_SINGLE_PUT_MAX_ENCRYPTED_BYTES - AES_GCM_TAG_BYTES;
const LEGACY_PROXY_MAX_UPLOAD_BYTES = 64 * MIB;
const LEGACY_PROXY_ENCRYPTED_HEADROOM_BYTES = 4096;
const MULTIPART_PLAINTEXT_PART_BYTES = 8 * MIB;
const MULTIPART_GCM_TAG_BYTES = 16;
const MULTIPART_MAX_PARTS = 640;
const MULTIPART_MAX_PLAINTEXT_BYTES = 5 * GIB;
const MULTIPART_MAX_ENCRYPTED_BYTES =
  MULTIPART_MAX_PLAINTEXT_BYTES + MULTIPART_MAX_PARTS * MULTIPART_GCM_TAG_BYTES;
const DEFAULT_MULTIPART_PART_URL_BATCH_SIZE = 64;
const MAX_MULTIPART_PART_URL_BATCH_SIZE = 128;
const MULTIPART_PART_URL_TTL_SECONDS = 15 * 60;
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_UPLOAD_TOKEN_TTL_SECONDS = 10 * 60;
const DIRECT_UPLOAD_MIN_BYTES_PER_SECOND = 1024 * 1024;
const DIRECT_UPLOAD_TTL_GRACE_SECONDS = 2 * 60;
const DIRECT_UPLOAD_MAX_TRANSFER_SECONDS = 2 * 60 * 60;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const DEFAULT_IP_SESSIONS_PER_WINDOW = 60;
const DEFAULT_IP_UPLOADS_PER_WINDOW = 60;
const DEFAULT_IP_UPLOAD_BYTES_PER_WINDOW = 20 * 1024 * 1024 * 1024;
const CAPABILITY_SCOPE = 'remote-share';
const CAPABILITY_TOKEN_TTL_DEFAULT = 600;
const REMOTE_SHARE_PROTOCOL_VERSION = 3;
const MULTIPART_PROTOCOL_VERSION = 4;
const LEGACY_PROXY_PROTOCOL_VERSION = 2;
const SESSION_JSON_MAX_BYTES = 8 * 1024;
const PARTS_JSON_MAX_BYTES = 8 * 1024;
const COMPLETE_JSON_MAX_BYTES = 64 * 1024;
const ABORT_JSON_MAX_BYTES = 4 * 1024;
const MIN_HMAC_SECRET_BYTES = 32;
const DEFAULT_R2_BUCKET_NAME = 'musixquare-remote-share';
const UPLOAD_STATE_PENDING = 'pending';
const UPLOAD_STATE_UPLOADED = 'uploaded';
const UPLOAD_STATE_MULTIPART = 'multipart';
const READY_STATE = 'ready';
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://musixquare.com',
  'https://www.musixquare.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
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
    'access-control-allow-methods': 'POST,PUT,GET,DELETE,OPTIONS',
    'access-control-allow-headers':
      'content-type,content-md5,authorization,range,if-range,x-mxqr-capability,x-mxqr-name,x-mxqr-mime,x-mxqr-size,x-mxqr-cleanup-token,x-mxqr-session-token',
    'access-control-expose-headers': 'accept-ranges,content-length,content-range,etag',
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
    path === '/upload' ||
    path === '/parts' ||
    path === '/complete' ||
    path === '/abort' ||
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

async function readBoundedJson(request, maxBytes) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0) return { invalid: true };
    if (declared > maxBytes) return { tooLarge: true };
  }
  if (!request.body) return { invalid: true };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += bytes.byteLength;
      if (total > maxBytes) {
        await reader.cancel('request body too large').catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(bytes);
    }
  } catch {
    return { invalid: true };
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return { invalid: true };
  }
}

function parseLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maxDirectPlaintextBytes(env) {
  return Math.min(
    Math.floor(parseLimit(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES)),
    DEFAULT_MAX_UPLOAD_BYTES,
  );
}

function maxMultipartPlaintextBytes(env) {
  return Math.min(
    Math.floor(parseLimit(env.MAX_MULTIPART_UPLOAD_BYTES, MULTIPART_MAX_PLAINTEXT_BYTES)),
    MULTIPART_MAX_PLAINTEXT_BYTES,
  );
}

function multipartPartUrlBatchSize(env) {
  return Math.min(
    MAX_MULTIPART_PART_URL_BATCH_SIZE,
    Math.floor(
      parseLimit(env.MULTIPART_PART_URL_BATCH_SIZE, DEFAULT_MULTIPART_PART_URL_BATCH_SIZE),
    ),
  );
}

function multipartEncryptedSize(plainSize, chunkCount) {
  return plainSize + chunkCount * MULTIPART_GCM_TAG_BYTES;
}

function multipartPartLength(payload, partNumber) {
  if (partNumber < Number(payload.chunkCount)) {
    return Number(payload.chunkSize) + Number(payload.tagBytes);
  }
  const finalPlainBytes =
    Number(payload.size) - (Number(payload.chunkCount) - 1) * Number(payload.chunkSize);
  return finalPlainBytes + Number(payload.tagBytes);
}

function canonicalContentMd5(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(value)) return null;
  try {
    const decoded = atob(value);
    if (decoded.length !== 16 || btoa(decoded) !== value) return null;
    return value;
  } catch {
    return null;
  }
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function directUploadTtlSeconds(encryptedSize, configuredMinimumSeconds) {
  const estimatedTransferSeconds = Math.ceil(encryptedSize / DIRECT_UPLOAD_MIN_BYTES_PER_SECOND);
  return Math.min(
    DIRECT_UPLOAD_MAX_TRANSFER_SECONDS + DIRECT_UPLOAD_TTL_GRACE_SECONDS,
    Math.max(
      Math.ceil(configuredMinimumSeconds),
      estimatedTransferSeconds + DIRECT_UPLOAD_TTL_GRACE_SECONDS,
    ),
  );
}

function getSigningSecret(env) {
  const secret = String(env.REMOTE_SHARE_SIGNING_SECRET || '').trim();
  return secret.length >= 32 ? secret : null;
}

function getCapabilitySecret(env) {
  const secret = String(
    env.REMOTE_SHARE_CAPABILITY_SECRET ||
      env.MXQR_CAPABILITY_SECRET ||
      env.CAPABILITY_HMAC_SECRET ||
      env.CAPABILITY_SECRET ||
      '',
  ).trim();
  return new TextEncoder().encode(secret).byteLength >= MIN_HMAC_SECRET_BYTES ? secret : '';
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
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error('invalid base64url');
  }
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (base64UrlEncode(bytes) !== value) throw new Error('non-canonical base64url');
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
  if (
    !Array.isArray(payload.scopes) ||
    payload.scopes.length !== 1 ||
    payload.scopes[0] !== CAPABILITY_SCOPE
  ) {
    return false;
  }
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
    protocolVersion: REMOTE_SHARE_PROTOCOL_VERSION,
    multipartProtocolVersion: MULTIPART_PROTOCOL_VERSION,
    maxUploadBytes: maxDirectPlaintextBytes(env),
    maxEncryptedBytes: R2_SINGLE_PUT_MAX_ENCRYPTED_BYTES,
    maxMultipartUploadBytes: maxMultipartPlaintextBytes(env),
    maxMultipartEncryptedBytes: MULTIPART_MAX_ENCRYPTED_BYTES,
    multipartChunkSize: MULTIPART_PLAINTEXT_PART_BYTES,
    multipartMaxParts: MULTIPART_MAX_PARTS,
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
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(([keyA, valueA], [keyB, valueB]) => {
      if (keyA < keyB) return -1;
      if (keyA > keyB) return 1;
      if (valueA < valueB) return -1;
      if (valueA > valueB) return 1;
      return 0;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function canonicalHeaderValue(value) {
  return String(value).trim().replace(/\s+/g, ' ');
}

async function createR2PresignedPutUrl({
  env,
  objectKey: key,
  headers,
  expiresInSeconds,
  now,
  operationQuery = [],
}) {
  const config = getR2S3Config(env);
  if (!config) return null;

  const { accountId, accessKeyId, secretAccessKey, bucketName } = config;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = amzDateParts(now);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const canonicalUri = `/${awsEncode(bucketName)}/${encodeObjectPath(key)}`;
  const signedHeaderEntries = { ...headers, host };
  const signedHeaderNames = Object.keys(signedHeaderEntries)
    .map((header) => header.toLowerCase())
    .sort();
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalHeaders = signedHeaderNames
    .map((header) => `${header}:${canonicalHeaderValue(signedHeaderEntries[header])}\n`)
    .join('');
  const queryParams = [
    ...operationQuery,
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
    const tokenParts = String(token || '').split('.');
    if (tokenParts.length !== 2) return null;
    const [encodedPayload, encodedSignature] = tokenParts;
    if (!encodedPayload || !encodedSignature) return null;
    const signature = base64UrlDecode(encodedSignature);
    if (signature.byteLength !== 32) return null;

    const key = await importSigningKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
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
  const raw = String(value || fallback)
    .replace(/[\r\n]/g, ' ')
    .trim();
  return encodeURIComponent(raw).slice(0, 512) || fallback;
}

function readMetadata(object, ...keys) {
  const metadata = object?.customMetadata || {};
  for (const key of keys) {
    if (metadata[key] !== undefined) return metadata[key];
  }
  return undefined;
}

function objectHttpEtag(object) {
  const httpEtag = String(object?.httpEtag || '').trim();
  if (/^"[^"\r\n]+"$/.test(httpEtag)) return httpEtag;
  const etag = String(object?.etag || '')
    .trim()
    .replace(/^"|"$/g, '');
  return etag && !/["\r\n]/.test(etag) ? `"${etag}"` : null;
}

function metadataEquals(object, value, ...keys) {
  return String(readMetadata(object, ...keys) ?? '') === String(value);
}

function readyObjectKey(key) {
  return `${key}.ready`;
}

async function consumeIpLimit(env, ip, scope, limit, windowSeconds, amount = 1) {
  const namespace = env.REMOTE_SHARE_RATE_LIMITER;
  if (
    !namespace ||
    typeof namespace.idFromName !== 'function' ||
    typeof namespace.get !== 'function'
  ) {
    console.warn('remote share rate-limit Durable Object binding missing');
    return { unavailable: true };
  }

  try {
    const id = namespace.idFromName(`ip:${ip}`);
    const stub = namespace.get(id);
    const response = await stub.fetch('https://remote-share-rate-limit.internal/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, limit, windowSeconds, amount }),
    });
    if (!response.ok) throw new Error(`RATE_LIMITER_HTTP_${response.status}`);
    const result = await response.json();
    if (
      typeof result?.allowed !== 'boolean' ||
      !Number.isFinite(Number(result?.retryAfterSeconds)) ||
      Number(result.retryAfterSeconds) < 1
    ) {
      throw new Error('RATE_LIMITER_INVALID_RESPONSE');
    }
    return {
      allowed: result.allowed,
      retryAfterSeconds: Math.ceil(Number(result.retryAfterSeconds)),
    };
  } catch (error) {
    console.warn('remote share rate-limit storage unavailable', error);
    return { unavailable: true };
  }
}

function rateLimited(request, env, message, retryAfterSeconds) {
  return json(request, env, { error: message, retryAfterSeconds }, 429, {
    'retry-after': String(retryAfterSeconds),
  });
}

function rateLimiterUnavailable(request, env) {
  return json(request, env, { error: 'rate limiter unavailable' }, 503);
}

async function handleSession(request, env) {
  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);

  const capabilityError = await requireSessionCapability(request, env);
  if (capabilityError) return capabilityError;

  const parsedBody = await readBoundedJson(request, SESSION_JSON_MAX_BYTES);
  if (parsedBody.tooLarge) return json(request, env, { error: 'request body too large' }, 413);
  if (parsedBody.invalid) return json(request, env, { error: 'invalid json' }, 400);
  const body = parsedBody.value;

  const roomId = safeRoomId(body?.roomId);
  const sessionId = Number(body?.sessionId);
  const index = Number(body?.index);
  const size = Number(body?.size);
  const encryptedSize = Number(body?.encryptedSize);
  // The production client immediately before v3 did not send a protocol
  // field, but already understood the direct-R2 response shape. Preserve its
  // 200 MiB rolling behavior by mapping only an absent/null version to v3.
  // Explicit v2 remains the bounded Worker-proxy compatibility route.
  const unversionedDirectUpload = body?.protocolVersion == null;
  const requestedProtocol = unversionedDirectUpload
    ? REMOTE_SHARE_PROTOCOL_VERSION
    : Number(body.protocolVersion);
  const directUpload = requestedProtocol === REMOTE_SHARE_PROTOCOL_VERSION;
  const multipartUpload = requestedProtocol === MULTIPART_PROTOCOL_VERSION;
  const chunkSize = Number(body?.chunkSize);
  const chunkCount = Number(body?.chunkCount);
  const tagBytes = Number(body?.tagBytes);
  const maxBytes = multipartUpload
    ? maxMultipartPlaintextBytes(env)
    : directUpload
      ? maxDirectPlaintextBytes(env)
      : LEGACY_PROXY_MAX_UPLOAD_BYTES;
  const maxEncryptedBytes = multipartUpload
    ? MULTIPART_MAX_ENCRYPTED_BYTES
    : directUpload
      ? R2_SINGLE_PUT_MAX_ENCRYPTED_BYTES
      : LEGACY_PROXY_MAX_UPLOAD_BYTES + LEGACY_PROXY_ENCRYPTED_HEADROOM_BYTES;
  const multipartShapeValid =
    !multipartUpload ||
    (chunkSize === MULTIPART_PLAINTEXT_PART_BYTES &&
      tagBytes === MULTIPART_GCM_TAG_BYTES &&
      Number.isSafeInteger(chunkCount) &&
      chunkCount >= 1 &&
      chunkCount <= MULTIPART_MAX_PARTS &&
      chunkCount === Math.ceil(size / chunkSize) &&
      encryptedSize === multipartEncryptedSize(size, chunkCount));

  if (
    !Number.isSafeInteger(sessionId) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !isPositiveSafeInteger(size) ||
    size > maxBytes ||
    !isPositiveSafeInteger(encryptedSize) ||
    encryptedSize > maxEncryptedBytes ||
    !multipartShapeValid
  ) {
    return json(request, env, { error: 'invalid upload session request' }, 400);
  }
  if ((directUpload || multipartUpload) && (!env.REMOTE_SHARE_BUCKET || !getR2S3Config(env))) {
    return json(request, env, { error: 'r2 s3 config missing' }, 500);
  }

  const ip = getClientIp(request);
  const rateWindowSeconds = parseLimit(
    env.RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  );
  const ipSessionLimit = parseLimit(env.IP_SESSIONS_PER_WINDOW, DEFAULT_IP_SESSIONS_PER_WINDOW);
  const sessionLimit = await consumeIpLimit(env, ip, 'session', ipSessionLimit, rateWindowSeconds);
  if (sessionLimit.unavailable) return rateLimiterUnavailable(request, env);
  if (!sessionLimit.allowed) {
    return rateLimited(request, env, 'rate limited', sessionLimit.retryAfterSeconds);
  }
  if (directUpload || multipartUpload) {
    const byteLimit = Math.floor(
      parseLimit(env.IP_UPLOAD_BYTES_PER_WINDOW, DEFAULT_IP_UPLOAD_BYTES_PER_WINDOW),
    );
    const byteReservation = await consumeIpLimit(
      env,
      ip,
      'bytes',
      byteLimit,
      rateWindowSeconds,
      encryptedSize,
    );
    if (byteReservation.unavailable) return rateLimiterUnavailable(request, env);
    if (!byteReservation.allowed) {
      return rateLimited(
        request,
        env,
        'upload byte rate limited',
        byteReservation.retryAfterSeconds,
      );
    }
  }

  const configuredTtlSeconds = parseLimit(
    env.UPLOAD_TOKEN_TTL_SECONDS,
    DEFAULT_UPLOAD_TOKEN_TTL_SECONDS,
  );
  const ttlSeconds =
    directUpload || multipartUpload
      ? directUploadTtlSeconds(encryptedSize, configuredTtlSeconds)
      : configuredTtlSeconds;
  const now = Date.now();
  const uploadUrlExpiresAt = now + ttlSeconds * 1000;
  const objectTtlSeconds = parseLimit(env.OBJECT_TTL_SECONDS, DEFAULT_TTL_SECONDS);
  // Direct and multipart uploads can legitimately spend most of their presigned window in
  // flight. Add the sharing TTL after that allowance so /complete cannot
  // expire before the largest supported transfer has a chance to finish.
  const expiresAt =
    now + (objectTtlSeconds + (directUpload || multipartUpload ? ttlSeconds : 0)) * 1000;
  const objectId = crypto.randomUUID();
  const objectKeyValue = `room/${roomId}/${objectId}`;
  const cleanupToken = crypto.randomUUID();
  const name = metadataString(body?.name, 'track');
  const mime = metadataString(body?.mime, 'application/octet-stream');

  if (multipartUpload) {
    if (typeof env.REMOTE_SHARE_BUCKET.createMultipartUpload !== 'function') {
      return json(request, env, { error: 'multipart upload unavailable' }, 503);
    }
    const uploadNonce = crypto.randomUUID();
    let multipart;
    try {
      multipart = await env.REMOTE_SHARE_BUCKET.createMultipartUpload(objectKeyValue, {
        httpMetadata: {
          contentType: 'application/octet-stream',
          cacheControl: 'no-store',
        },
        customMetadata: {
          uploadState: UPLOAD_STATE_MULTIPART,
          protocolVersion: String(MULTIPART_PROTOCOL_VERSION),
          roomId,
          objectId,
          name,
          mime,
          sizeBytes: String(size),
          encryptedSize: String(encryptedSize),
          expiresAt: String(expiresAt),
          cleanupToken,
          uploadNonce,
          chunkSize: String(chunkSize),
          chunkCount: String(chunkCount),
          tagBytes: String(tagBytes),
        },
      });
    } catch {
      return json(request, env, { error: 'multipart upload initialization failed' }, 502);
    }
    const uploadId = String(multipart?.uploadId || '');
    if (!uploadId || uploadId.length > 512 || /[\u0000-\u001f\u007f]/.test(uploadId)) {
      try {
        await multipart?.abort?.();
      } catch {
        /* lifecycle cleanup is the final fallback */
      }
      return json(request, env, { error: 'invalid multipart upload id' }, 502);
    }

    const controlToken = await createSignedToken(
      {
        v: 5,
        kind: 'multipart',
        protocolVersion: MULTIPART_PROTOCOL_VERSION,
        roomId,
        objectId,
        objectKey: objectKeyValue,
        uploadId,
        sessionId,
        index,
        size,
        encryptedSize,
        expiresAt,
        partUrlExpiresAt: uploadUrlExpiresAt,
        cleanupToken,
        name,
        mime,
        uploadNonce,
        chunkSize,
        chunkCount,
        tagBytes,
        iat: now,
        exp: expiresAt,
      },
      secret,
    );
    const url = new URL(request.url);
    return json(request, env, {
      protocolVersion: MULTIPART_PROTOCOL_VERSION,
      objectId,
      controlToken,
      expiresAt,
      partUrlExpiresAt: uploadUrlExpiresAt,
      uploadUrlExpiresAt,
      downloadUrl: `${url.origin}/download/${roomId}/${objectId}`,
      cleanupToken,
    });
  }

  if (directUpload) {
    const uploadNonce = crypto.randomUUID();
    const conditionalCreate = new Headers({ 'if-none-match': '*' });
    const placeholder = await env.REMOTE_SHARE_BUCKET.put(objectKeyValue, null, {
      onlyIf: conditionalCreate,
      httpMetadata: {
        contentType: 'application/octet-stream',
        cacheControl: 'no-store',
      },
      customMetadata: {
        uploadState: UPLOAD_STATE_PENDING,
        roomId,
        objectId,
        name,
        mime,
        sizeBytes: String(size),
        encryptedSize: String(encryptedSize),
        expiresAt: String(expiresAt),
        cleanupToken,
        uploadNonce,
      },
    });
    if (!placeholder) {
      return json(request, env, { error: 'upload reservation conflict' }, 409);
    }

    const placeholderEtag = objectHttpEtag(placeholder);
    if (!placeholderEtag) {
      await env.REMOTE_SHARE_BUCKET.delete(objectKeyValue);
      return json(request, env, { error: 'upload reservation failed' }, 500);
    }

    const signedUploadHeaders = {
      'cache-control': 'no-store',
      'content-length': String(encryptedSize),
      'content-type': 'application/octet-stream',
      'if-match': placeholderEtag,
      'x-amz-meta-cleanup-token': cleanupToken,
      'x-amz-meta-encrypted-size': String(encryptedSize),
      'x-amz-meta-expires-at': String(expiresAt),
      'x-amz-meta-mime': mime,
      'x-amz-meta-name': name,
      'x-amz-meta-object-id': objectId,
      'x-amz-meta-room-id': roomId,
      'x-amz-meta-size-bytes': String(size),
      'x-amz-meta-upload-nonce': uploadNonce,
      'x-amz-meta-upload-state': UPLOAD_STATE_UPLOADED,
    };
    const uploadUrl = await createR2PresignedPutUrl({
      env,
      objectKey: objectKeyValue,
      headers: signedUploadHeaders,
      expiresInSeconds: ttlSeconds,
      now: new Date(now),
    });
    if (!uploadUrl) {
      await env.REMOTE_SHARE_BUCKET.delete(objectKeyValue);
      return json(request, env, { error: 'r2 s3 config missing' }, 500);
    }

    const completeToken = await createSignedToken(
      {
        v: 4,
        kind: 'complete',
        protocolVersion: REMOTE_SHARE_PROTOCOL_VERSION,
        roomId,
        objectId,
        objectKey: objectKeyValue,
        sessionId,
        index,
        size,
        encryptedSize,
        expiresAt,
        cleanupToken,
        name,
        mime,
        uploadNonce,
        placeholderEtag,
        iat: now,
        // Completion may happen well after a large upload starts. It remains
        // valid only while the resulting object itself is valid.
        exp: expiresAt,
      },
      secret,
    );
    const url = new URL(request.url);
    const uploadHeaders = { ...signedUploadHeaders };
    // Browsers own this forbidden request header. XHR/fetch will derive the
    // same signed value from the Blob body, so do not ask application code to
    // set it explicitly.
    delete uploadHeaders['content-length'];
    return json(request, env, {
      protocolVersion: REMOTE_SHARE_PROTOCOL_VERSION,
      uploadMethod: 'PUT',
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

  const uploadToken = await createSignedToken(
    {
      v: LEGACY_PROXY_PROTOCOL_VERSION,
      kind: 'upload',
      roomId,
      objectId,
      objectKey: objectKeyValue,
      sessionId,
      index,
      size,
      encryptedSize,
      expiresAt,
      cleanupToken,
      name,
      mime,
      iat: now,
      exp: uploadUrlExpiresAt,
      nonce: crypto.randomUUID(),
    },
    secret,
  );
  // Rolling compatibility token for protocol-v2 clients. Their body stays on
  // the bounded Worker endpoint; /complete remains idempotent for older direct
  // fallback behavior as well.
  const completeToken = await createSignedToken(
    {
      v: 3,
      kind: 'complete',
      roomId,
      objectId,
      objectKey: objectKeyValue,
      encryptedSize,
      expiresAt,
      cleanupToken,
      iat: now,
      exp: uploadUrlExpiresAt,
    },
    secret,
  );
  const url = new URL(request.url);
  const uploadUrl = new URL('/upload', url.origin);
  uploadUrl.searchParams.set('roomId', roomId);
  uploadUrl.searchParams.set('objectId', objectId);
  return json(request, env, {
    protocolVersion: LEGACY_PROXY_PROTOCOL_VERSION,
    uploadMethod: 'POST',
    uploadUrl: uploadUrl.toString(),
    uploadHeaders: {
      'content-type': 'application/octet-stream',
      'x-mxqr-session-token': uploadToken,
    },
    uploadUrlExpiresAt,
    completeToken,
    objectId,
    expiresAt,
    downloadUrl: `${url.origin}/download/${roomId}/${objectId}`,
    cleanupToken,
  });
}

function completionResponse(request, env, payload) {
  const url = new URL(request.url);
  return json(request, env, {
    objectId: payload.objectId,
    expiresAt: Number(payload.expiresAt),
    downloadUrl: `${url.origin}/download/${payload.roomId}/${payload.objectId}`,
    cleanupToken: payload.cleanupToken,
  });
}

function validMultipartUploadId(value) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validateMultipartControlPayload(payload, body, now = Date.now()) {
  const roomId = body?.roomId === undefined ? payload?.roomId : safeRoomId(body.roomId);
  const objectId = String(body?.objectId || '');
  const size = Number(payload?.size);
  const encryptedSize = Number(payload?.encryptedSize);
  const chunkSize = Number(payload?.chunkSize);
  const chunkCount = Number(payload?.chunkCount);
  const tagBytes = Number(payload?.tagBytes);
  if (
    !payload ||
    payload.v !== 5 ||
    payload.kind !== 'multipart' ||
    payload.protocolVersion !== MULTIPART_PROTOCOL_VERSION ||
    payload.roomId !== roomId ||
    payload.objectId !== objectId ||
    payload.objectKey !== objectKey(roomId, objectId) ||
    !validMultipartUploadId(payload.uploadId) ||
    !Number.isSafeInteger(Number(payload.sessionId)) ||
    !Number.isSafeInteger(Number(payload.index)) ||
    Number(payload.index) < 0 ||
    !isPositiveSafeInteger(size) ||
    size > MULTIPART_MAX_PLAINTEXT_BYTES ||
    chunkSize !== MULTIPART_PLAINTEXT_PART_BYTES ||
    tagBytes !== MULTIPART_GCM_TAG_BYTES ||
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount > MULTIPART_MAX_PARTS ||
    chunkCount !== Math.ceil(size / chunkSize) ||
    encryptedSize !== multipartEncryptedSize(size, chunkCount) ||
    encryptedSize > MULTIPART_MAX_ENCRYPTED_BYTES ||
    !Number.isFinite(Number(payload.iat)) ||
    Number(payload.iat) > now + 60_000 ||
    !Number.isFinite(Number(payload.exp)) ||
    Number(payload.exp) !== Number(payload.expiresAt) ||
    Number(payload.exp) <= now ||
    !Number.isFinite(Number(payload.expiresAt)) ||
    Number(payload.expiresAt) <= now ||
    !Number.isFinite(Number(payload.partUrlExpiresAt)) ||
    Number(payload.partUrlExpiresAt) <= Number(payload.iat) ||
    Number(payload.partUrlExpiresAt) > Number(payload.expiresAt) ||
    typeof payload.cleanupToken !== 'string' ||
    typeof payload.name !== 'string' ||
    typeof payload.mime !== 'string' ||
    typeof payload.uploadNonce !== 'string'
  ) {
    return null;
  }
  return payload;
}

async function readMultipartControlPayload(body, env) {
  const secret = getSigningSecret(env);
  if (!secret) return null;
  const payload = await verifySignedToken(body?.controlToken, secret);
  return validateMultipartControlPayload(payload, body);
}

async function handleMultipartParts(request, env) {
  if (!env.REMOTE_SHARE_BUCKET || !getR2S3Config(env)) {
    return json(request, env, { error: 'r2 s3 config missing' }, 500);
  }
  const parsedBody = await readBoundedJson(request, PARTS_JSON_MAX_BYTES);
  if (parsedBody.tooLarge) return json(request, env, { error: 'request body too large' }, 413);
  if (parsedBody.invalid) return json(request, env, { error: 'invalid json' }, 400);
  const body = parsedBody.value;
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 3 ||
    Object.keys(body).some((key) => key !== 'objectId' && key !== 'controlToken' && key !== 'parts')
  ) {
    return json(request, env, { error: 'invalid multipart part request' }, 400);
  }
  const payload = await readMultipartControlPayload(body, env);
  if (!payload) return json(request, env, { error: 'invalid multipart control token' }, 403);

  const requestedParts = body.parts;
  const batchLimit = multipartPartUrlBatchSize(env);
  if (
    !Array.isArray(requestedParts) ||
    requestedParts.length < 1 ||
    requestedParts.length > batchLimit
  ) {
    return json(request, env, { error: 'invalid multipart part list' }, 400);
  }
  const validatedParts = [];
  let previous = 0;
  for (const item of requestedParts) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).length !== 2 ||
      Object.keys(item).some((key) => key !== 'partNumber' && key !== 'contentMd5')
    ) {
      return json(request, env, { error: 'invalid multipart part list' }, 400);
    }
    const partNumber = item.partNumber;
    const contentMd5 = canonicalContentMd5(item.contentMd5);
    if (
      !Number.isSafeInteger(partNumber) ||
      partNumber <= previous ||
      partNumber < 1 ||
      partNumber > Number(payload.chunkCount) ||
      !contentMd5
    ) {
      return json(request, env, { error: 'invalid multipart part list' }, 400);
    }
    validatedParts.push({ partNumber, contentMd5 });
    previous = partNumber;
  }

  const nowMs = Date.now();
  const remainingSeconds = Math.floor((Number(payload.partUrlExpiresAt) - nowMs) / 1000);
  if (remainingSeconds <= 0) {
    return json(request, env, { error: 'multipart part URL window expired' }, 403);
  }
  // UploadPart URLs are bearer capabilities. Keep each just-in-time batch short-lived
  // even when the signed multipart session itself needs a multi-hour transfer window.
  const expiresInSeconds = Math.min(MULTIPART_PART_URL_TTL_SECONDS, remainingSeconds);
  const expiresAt = nowMs + expiresInSeconds * 1000;
  const now = new Date(nowMs);
  const parts = [];
  for (const { partNumber, contentMd5 } of validatedParts) {
    const contentLength = multipartPartLength(payload, partNumber);
    const signedHeaders = {
      'content-length': String(contentLength),
      'content-md5': contentMd5,
      'content-type': 'application/octet-stream',
    };
    const uploadUrl = await createR2PresignedPutUrl({
      env,
      objectKey: payload.objectKey,
      headers: signedHeaders,
      expiresInSeconds,
      now,
      operationQuery: [
        ['partNumber', String(partNumber)],
        ['uploadId', payload.uploadId],
      ],
    });
    if (!uploadUrl) return json(request, env, { error: 'r2 s3 config missing' }, 500);
    parts.push({
      partNumber,
      uploadUrl,
      uploadHeaders: {
        'content-md5': contentMd5,
        'content-type': 'application/octet-stream',
      },
    });
  }
  return json(request, env, { parts, expiresAt });
}

function normalizeMultipartPartEtag(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^"|"$/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : null;
}

function validateMultipartCompletionParts(value, expectedCount) {
  if (!Array.isArray(value) || value.length !== expectedCount) return null;
  const parts = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (Object.keys(item).some((key) => key !== 'partNumber' && key !== 'etag')) return null;
    if (item.partNumber !== index + 1) return null;
    const etag = normalizeMultipartPartEtag(item.etag);
    if (!etag) return null;
    parts.push({ partNumber: item.partNumber, etag });
  }
  return parts;
}

function multipartUploadedObjectMatches(object, payload) {
  return (
    !!object &&
    object.size === Number(payload.encryptedSize) &&
    metadataEquals(object, UPLOAD_STATE_MULTIPART, 'uploadState', 'upload-state') &&
    metadataEquals(object, MULTIPART_PROTOCOL_VERSION, 'protocolVersion', 'protocol-version') &&
    metadataEquals(object, payload.roomId, 'roomId', 'room-id') &&
    metadataEquals(object, payload.objectId, 'objectId', 'object-id') &&
    metadataEquals(object, payload.name, 'name') &&
    metadataEquals(object, payload.mime, 'mime') &&
    metadataEquals(object, payload.size, 'sizeBytes', 'size-bytes') &&
    metadataEquals(object, payload.encryptedSize, 'encryptedSize', 'encrypted-size') &&
    metadataEquals(object, payload.expiresAt, 'expiresAt', 'expires-at') &&
    metadataEquals(object, payload.cleanupToken, 'cleanupToken', 'cleanup-token') &&
    metadataEquals(object, payload.uploadNonce, 'uploadNonce', 'upload-nonce') &&
    metadataEquals(object, payload.chunkSize, 'chunkSize', 'chunk-size') &&
    metadataEquals(object, payload.chunkCount, 'chunkCount', 'chunk-count') &&
    metadataEquals(object, payload.tagBytes, 'tagBytes', 'tag-bytes')
  );
}

async function finishMultipartCompletion(request, env, payload, object) {
  if (!multipartUploadedObjectMatches(object, payload)) {
    await env.REMOTE_SHARE_BUCKET.delete([payload.objectKey, readyObjectKey(payload.objectKey)]);
    return json(request, env, { error: 'invalid uploaded object' }, 403);
  }
  if (!(await publishReadyMarker(env, payload, object))) {
    return json(request, env, { error: 'upload readiness conflict' }, 409);
  }
  return completionResponse(request, env, payload);
}

async function handleMultipartComplete(request, env, body, payload) {
  const parts = validateMultipartCompletionParts(body?.parts, Number(payload.chunkCount));
  if (!parts) return json(request, env, { error: 'invalid multipart completion parts' }, 400);

  const existing = await env.REMOTE_SHARE_BUCKET.head(payload.objectKey);
  if (existing) return finishMultipartCompletion(request, env, payload, existing);
  if (typeof env.REMOTE_SHARE_BUCKET.resumeMultipartUpload !== 'function') {
    return json(request, env, { error: 'multipart upload unavailable' }, 503);
  }

  const multipart = env.REMOTE_SHARE_BUCKET.resumeMultipartUpload(
    payload.objectKey,
    payload.uploadId,
  );
  try {
    await multipart.complete(parts);
  } catch {
    // R2 completion is atomic, but the successful response can be lost after
    // the object was committed. HEAD is the idempotency oracle in that case.
    const recovered = await env.REMOTE_SHARE_BUCKET.head(payload.objectKey);
    if (recovered) return finishMultipartCompletion(request, env, payload, recovered);
    return json(request, env, { error: 'multipart completion failed' }, 409);
  }
  const completed = await env.REMOTE_SHARE_BUCKET.head(payload.objectKey);
  if (!completed) return json(request, env, { error: 'multipart completion failed' }, 409);
  return finishMultipartCompletion(request, env, payload, completed);
}

async function handleMultipartAbort(request, env) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);
  const parsedBody = await readBoundedJson(request, ABORT_JSON_MAX_BYTES);
  if (parsedBody.tooLarge) return json(request, env, { error: 'request body too large' }, 413);
  if (parsedBody.invalid) return json(request, env, { error: 'invalid json' }, 400);
  const body = parsedBody.value;
  const payload = await readMultipartControlPayload(body, env);
  if (!payload) return json(request, env, { error: 'invalid multipart control token' }, 403);

  const existing = await env.REMOTE_SHARE_BUCKET.head(payload.objectKey);
  if (existing) {
    if (!multipartUploadedObjectMatches(existing, payload)) {
      await env.REMOTE_SHARE_BUCKET.delete([payload.objectKey, readyObjectKey(payload.objectKey)]);
      return json(request, env, { error: 'invalid uploaded object' }, 403);
    }
    await publishReadyMarker(env, payload, existing);
    return json(request, env, { ok: true, completed: true });
  }

  if (typeof env.REMOTE_SHARE_BUCKET.resumeMultipartUpload === 'function') {
    try {
      await env.REMOTE_SHARE_BUCKET.resumeMultipartUpload(
        payload.objectKey,
        payload.uploadId,
      ).abort();
    } catch {
      // NoSuchUpload is the expected result for an idempotent repeated abort.
    }
  }
  // Complete and abort can cross between the first HEAD and the R2 operation.
  // A successful completion wins: restore its ready marker instead of letting
  // a stale abort hide a committed object.
  const completedDuringAbort = await env.REMOTE_SHARE_BUCKET.head(payload.objectKey);
  if (completedDuringAbort) {
    if (!multipartUploadedObjectMatches(completedDuringAbort, payload)) {
      await env.REMOTE_SHARE_BUCKET.delete([payload.objectKey, readyObjectKey(payload.objectKey)]);
      return json(request, env, { error: 'invalid uploaded object' }, 403);
    }
    await publishReadyMarker(env, payload, completedDuringAbort);
    return json(request, env, { ok: true, completed: true });
  }
  await env.REMOTE_SHARE_BUCKET.delete(readyObjectKey(payload.objectKey));
  return json(request, env, { ok: true });
}

function readyMarkerMatches(marker, payload, objectEtag) {
  return (
    !!marker &&
    metadataEquals(marker, READY_STATE, 'readyState', 'ready-state') &&
    metadataEquals(marker, payload.roomId, 'roomId', 'room-id') &&
    metadataEquals(marker, payload.objectId, 'objectId', 'object-id') &&
    metadataEquals(marker, payload.encryptedSize, 'encryptedSize', 'encrypted-size') &&
    metadataEquals(marker, payload.expiresAt, 'expiresAt', 'expires-at') &&
    metadataEquals(marker, payload.cleanupToken, 'cleanupToken', 'cleanup-token') &&
    metadataEquals(marker, objectEtag, 'objectEtag', 'object-etag')
  );
}

async function publishReadyMarker(env, payload, object) {
  const objectEtag = objectHttpEtag(object);
  if (!objectEtag) return false;
  const key = readyObjectKey(payload.objectKey);
  const marker = await env.REMOTE_SHARE_BUCKET.put(key, null, {
    onlyIf: new Headers({ 'if-none-match': '*' }),
    httpMetadata: { cacheControl: 'no-store' },
    customMetadata: {
      readyState: READY_STATE,
      roomId: payload.roomId,
      objectId: payload.objectId,
      encryptedSize: String(payload.encryptedSize),
      expiresAt: String(payload.expiresAt),
      cleanupToken: payload.cleanupToken,
      objectEtag,
    },
  });
  if (marker) return true;
  return readyMarkerMatches(await env.REMOTE_SHARE_BUCKET.head(key), payload, objectEtag);
}

function directUploadedObjectMatches(object, payload) {
  return (
    object.size === Number(payload.encryptedSize) &&
    objectHttpEtag(object) !== payload.placeholderEtag &&
    metadataEquals(object, UPLOAD_STATE_UPLOADED, 'uploadState', 'upload-state') &&
    metadataEquals(object, payload.roomId, 'roomId', 'room-id') &&
    metadataEquals(object, payload.objectId, 'objectId', 'object-id') &&
    metadataEquals(object, payload.name, 'name') &&
    metadataEquals(object, payload.mime, 'mime') &&
    metadataEquals(object, payload.size, 'sizeBytes', 'size-bytes') &&
    metadataEquals(object, payload.encryptedSize, 'encryptedSize', 'encrypted-size') &&
    metadataEquals(object, payload.expiresAt, 'expiresAt', 'expires-at') &&
    metadataEquals(object, payload.cleanupToken, 'cleanupToken', 'cleanup-token') &&
    metadataEquals(object, payload.uploadNonce, 'uploadNonce', 'upload-nonce')
  );
}

async function handleComplete(request, env) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);
  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);

  const parsedBody = await readBoundedJson(request, COMPLETE_JSON_MAX_BYTES);
  if (parsedBody.tooLarge) return json(request, env, { error: 'request body too large' }, 413);
  if (parsedBody.invalid) return json(request, env, { error: 'invalid json' }, 400);
  const body = parsedBody.value;
  const payload = await verifySignedToken(body?.controlToken || body?.completeToken, secret);
  const roomId = safeRoomId(body?.roomId);
  const objectId = String(body?.objectId || '');
  const now = Date.now();
  if (payload?.v === 5 && payload?.kind === 'multipart') {
    const multipartPayload = validateMultipartControlPayload(payload, body, now);
    if (!multipartPayload) {
      return json(request, env, { error: 'invalid multipart control token' }, 403);
    }
    return handleMultipartComplete(request, env, body, multipartPayload);
  }
  if (
    !payload ||
    (payload.v !== 3 && payload.v !== 4) ||
    payload.kind !== 'complete' ||
    payload.roomId !== roomId ||
    payload.objectId !== objectId ||
    payload.objectKey !== objectKey(roomId, objectId) ||
    !Number.isFinite(Number(payload.exp)) ||
    Number(payload.exp) < now ||
    !Number.isFinite(Number(payload.expiresAt)) ||
    Number(payload.expiresAt) <= now ||
    typeof payload.cleanupToken !== 'string' ||
    !isPositiveSafeInteger(Number(payload.encryptedSize))
  ) {
    return json(request, env, { error: 'invalid upload completion' }, 403);
  }

  const object = await env.REMOTE_SHARE_BUCKET.head(payload.objectKey);
  if (!object) return json(request, env, { error: 'invalid uploaded object' }, 403);

  if (payload.v === 4) {
    if (
      typeof payload.placeholderEtag !== 'string' ||
      typeof payload.uploadNonce !== 'string' ||
      typeof payload.name !== 'string' ||
      typeof payload.mime !== 'string' ||
      !isPositiveSafeInteger(Number(payload.size))
    ) {
      return json(request, env, { error: 'invalid upload completion' }, 403);
    }
    if (
      objectHttpEtag(object) === payload.placeholderEtag &&
      metadataEquals(object, UPLOAD_STATE_PENDING, 'uploadState', 'upload-state')
    ) {
      return json(request, env, { error: 'upload not complete' }, 409);
    }
    if (!directUploadedObjectMatches(object, payload)) {
      await env.REMOTE_SHARE_BUCKET.delete([payload.objectKey, readyObjectKey(payload.objectKey)]);
      return json(request, env, { error: 'invalid uploaded object' }, 403);
    }
  } else if (
    object.size !== Number(payload.encryptedSize) ||
    !metadataEquals(object, payload.cleanupToken, 'cleanupToken', 'cleanup-token', 'cleanuptoken')
  ) {
    return json(request, env, { error: 'invalid uploaded object' }, 403);
  }

  if (!(await publishReadyMarker(env, payload, object))) {
    return json(request, env, { error: 'upload readiness conflict' }, 409);
  }
  return completionResponse(request, env, payload);
}

async function validateUploadSession(request, env, roomId, objectId, maxEncryptedBytes) {
  const secret = getSigningSecret(env);
  if (!secret) {
    return { error: json(request, env, { error: 'signing secret missing' }, 500) };
  }

  const token = request.headers.get('x-mxqr-session-token') || '';
  const payload = await verifySignedToken(token, secret);
  if (!payload || payload.v !== 2 || payload.kind !== 'upload') {
    return { error: json(request, env, { error: 'invalid upload session' }, 403) };
  }

  const now = Date.now();
  const encryptedSize = Number(payload.encryptedSize);
  if (
    payload.roomId !== roomId ||
    payload.objectId !== objectId ||
    payload.objectKey !== objectKey(roomId, objectId) ||
    !Number.isFinite(Number(payload.sessionId)) ||
    !Number.isFinite(Number(payload.index)) ||
    !Number.isFinite(encryptedSize) ||
    encryptedSize <= 0 ||
    encryptedSize > maxEncryptedBytes ||
    !Number.isFinite(Number(payload.exp)) ||
    Number(payload.exp) < now ||
    typeof payload.nonce !== 'string' ||
    typeof payload.cleanupToken !== 'string' ||
    !Number.isFinite(Number(payload.expiresAt)) ||
    Number(payload.expiresAt) <= now
  ) {
    return { error: json(request, env, { error: 'invalid upload session' }, 403) };
  }
  return { payload };
}

function byteLimitedBody(body, expectedBytes, maxBytes) {
  if (!body) throw new Error('UPLOAD_BODY_MISSING');
  let receivedBytes = 0;
  const limiter = {
    violation: null,
    stream: null,
    completion: Promise.resolve(),
    pipeError: null,
    abortError: null,
    abort: () => undefined,
  };
  const validatedStream = body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        receivedBytes += bytes.byteLength;
        if (receivedBytes > maxBytes) {
          limiter.violation = 'limit';
          controller.error(new Error('UPLOAD_SIZE_LIMIT_EXCEEDED'));
          return;
        }
        if (receivedBytes > expectedBytes) {
          limiter.violation = 'mismatch';
          controller.error(new Error('UPLOAD_SIZE_MISMATCH'));
          return;
        }
        controller.enqueue(bytes);
      },
      flush(controller) {
        if (receivedBytes !== expectedBytes) {
          limiter.violation = 'mismatch';
          controller.error(new Error('UPLOAD_SIZE_MISMATCH'));
        }
      },
    }),
  );

  // R2 requires a request-derived stream with a known length. Passing the
  // readable returned by pipeThrough() loses that Cloudflare runtime metadata,
  // so bridge the validated stream through a FixedLengthStream. Keep the
  // fallback for Node-based tests and other standards-only runtimes.
  const FixedLengthStreamImpl = globalThis.FixedLengthStream;
  if (typeof FixedLengthStreamImpl !== 'function') {
    limiter.stream = validatedStream;
    return limiter;
  }

  const fixedLengthStream = new FixedLengthStreamImpl(expectedBytes);
  const abortController = new AbortController();
  limiter.stream = fixedLengthStream.readable;
  limiter.abort = () => {
    if (abortController.signal.aborted) return;
    limiter.abortError = new Error('UPLOAD_PIPE_ABORTED_AFTER_STORE_FAILURE');
    abortController.abort(limiter.abortError);
  };
  limiter.completion = validatedStream
    .pipeTo(fixedLengthStream.writable, { signal: abortController.signal })
    .catch((error) => {
      limiter.pipeError = error;
      throw error;
    });
  return limiter;
}

async function handleUpload(request, env) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);
  if (!request.body) return json(request, env, { error: 'missing body' }, 400);

  const maxBytes = LEGACY_PROXY_MAX_UPLOAD_BYTES;
  const maxEncryptedBytes = maxBytes + LEGACY_PROXY_ENCRYPTED_HEADROOM_BYTES;
  const contentLengthHeader = request.headers.get('content-length');
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (contentLength !== null && (!Number.isFinite(contentLength) || contentLength <= 0)) {
    return json(request, env, { error: 'invalid content length' }, 400);
  }
  if (contentLength !== null && contentLength > maxEncryptedBytes) {
    return json(request, env, { error: 'file too large', maxBytes }, 413);
  }

  const url = new URL(request.url);
  const roomId = safeRoomId(url.searchParams.get('roomId'));
  const objectId = String(url.searchParams.get('objectId') || '');
  const session = await validateUploadSession(request, env, roomId, objectId, maxEncryptedBytes);
  if (session.error) return session.error;
  const payload = session.payload;
  const expectedBytes = Number(payload.encryptedSize);
  if (contentLength !== null && contentLength !== expectedBytes) {
    return json(request, env, { error: 'invalid upload size' }, 403);
  }

  const ip = getClientIp(request);

  const rateWindowSeconds = parseLimit(
    env.RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  );
  const ipUploadLimit = parseLimit(env.IP_UPLOADS_PER_WINDOW, DEFAULT_IP_UPLOADS_PER_WINDOW);
  const uploadLimit = await consumeIpLimit(env, ip, 'upload', ipUploadLimit, rateWindowSeconds);
  if (uploadLimit.unavailable) return rateLimiterUnavailable(request, env);
  if (!uploadLimit.allowed) {
    return rateLimited(request, env, 'rate limited', uploadLimit.retryAfterSeconds);
  }

  const expiresAt = Number(payload.expiresAt);
  const key = payload.objectKey;
  const cleanupToken = payload.cleanupToken;
  const conditionalCreate = new Headers({ 'if-none-match': '*' });

  // Consume the nonce in strongly-consistent R2 before reading the body. A
  // separate marker survives deletion of the uploaded object, so a cleanup
  // token cannot make the upload token reusable during its validity window.
  const consumed = await env.REMOTE_SHARE_BUCKET.put(`upload-session/${payload.nonce}`, null, {
    onlyIf: conditionalCreate,
    httpMetadata: { cacheControl: 'no-store' },
    customMetadata: {
      kind: 'upload-session',
      expiresAt: String(payload.exp),
    },
  });
  if (!consumed) return json(request, env, { error: 'upload session already used' }, 409);

  let stored;
  let limiter;
  try {
    limiter = byteLimitedBody(request.body, expectedBytes, maxEncryptedBytes);
    const putPromise = Promise.resolve().then(() =>
      env.REMOTE_SHARE_BUCKET.put(key, limiter.stream, {
        // R2 conditional writes are strongly consistent. The session's fixed
        // object key therefore makes the signed upload token single-consumption
        // without KV's non-atomic get -> put replay race.
        onlyIf: conditionalCreate,
        httpMetadata: {
          contentType: 'application/octet-stream',
          cacheControl: 'no-store',
        },
        customMetadata: {
          roomId,
          name: decodeHeaderValue(payload.name, 'track').slice(0, 240),
          mime: decodeHeaderValue(payload.mime, 'application/octet-stream').slice(0, 120),
          sizeBytes: String(payload.size),
          expiresAt: String(expiresAt),
          cleanupToken,
        },
      }),
    );
    [stored] = await Promise.all([putPromise, limiter.completion]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const pipeFailedBeforeAbort = limiter?.pipeError !== null;
    limiter?.abort();
    await limiter?.completion.catch(() => undefined);
    const pipeFailed =
      pipeFailedBeforeAbort ||
      (limiter?.pipeError !== null && limiter?.pipeError !== limiter?.abortError);
    if (limiter?.violation === 'limit' || message === 'UPLOAD_SIZE_LIMIT_EXCEEDED') {
      return json(request, env, { error: 'file too large', maxBytes }, 413);
    }
    if (limiter?.violation === 'mismatch' || message === 'UPLOAD_SIZE_MISMATCH' || pipeFailed) {
      return json(request, env, { error: 'invalid upload size' }, 403);
    }
    throw error;
  }
  if (!stored) return json(request, env, { error: 'upload session already used' }, 409);
  if (!(await publishReadyMarker(env, payload, stored))) {
    await env.REMOTE_SHARE_BUCKET.delete(key);
    return json(request, env, { error: 'upload readiness conflict' }, 409);
  }

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

function parseDownloadRange(value, size) {
  if (!value) return null;
  if (typeof value !== 'string' || value.includes(',')) return { invalid: true };
  const match = value.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    const length = Math.min(size, suffix);
    return { start: size - length, end: size - 1, length };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return { invalid: true };
  }
  const end = Math.min(size - 1, requestedEnd);
  return { start, end, length: end - start + 1 };
}

function invalidRangeResponse(request, env, size) {
  return new Response(null, {
    status: 416,
    headers: {
      ...SECURITY_HEADERS,
      ...corsHeaders(request, env),
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
      'content-range': `bytes */${size}`,
    },
  });
}

async function handleDownload(request, env, roomId, objectId) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);

  const key = objectKey(roomId, objectId);
  if (!key) return json(request, env, { error: 'not found' }, 404);

  const ready = await env.REMOTE_SHARE_BUCKET.head(readyObjectKey(key));
  if (!ready || !metadataEquals(ready, READY_STATE, 'readyState', 'ready-state')) {
    return json(request, env, { error: 'not found' }, 404);
  }

  const objectHead = await env.REMOTE_SHARE_BUCKET.head(key);
  if (!objectHead) return json(request, env, { error: 'not found' }, 404);

  const multipartObject =
    metadataEquals(objectHead, UPLOAD_STATE_MULTIPART, 'uploadState', 'upload-state') &&
    metadataEquals(objectHead, MULTIPART_PROTOCOL_VERSION, 'protocolVersion', 'protocol-version');
  const maxObjectBytes = multipartObject
    ? MULTIPART_MAX_ENCRYPTED_BYTES
    : R2_SINGLE_PUT_MAX_ENCRYPTED_BYTES;
  if (objectHead.size > maxObjectBytes) {
    await env.REMOTE_SHARE_BUCKET.delete([key, readyObjectKey(key)]);
    return json(request, env, { error: 'file too large', maxBytes: maxObjectBytes }, 413);
  }
  const objectEtag = objectHttpEtag(objectHead);
  if (
    !objectEtag ||
    !metadataEquals(ready, objectHead.size, 'encryptedSize', 'encrypted-size') ||
    !metadataEquals(ready, objectEtag, 'objectEtag', 'object-etag')
  ) {
    await env.REMOTE_SHARE_BUCKET.delete([key, readyObjectKey(key)]);
    return json(request, env, { error: 'invalid uploaded object' }, 403);
  }

  const expiresAt = Number(readMetadata(objectHead, 'expiresAt', 'expires-at', 'expiresat') || '0');
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt < Date.now() ||
    !metadataEquals(ready, expiresAt, 'expiresAt', 'expires-at')
  ) {
    await env.REMOTE_SHARE_BUCKET.delete([key, readyObjectKey(key)]);
    return json(request, env, { error: 'expired' }, 404);
  }

  const range = parseDownloadRange(request.headers.get('range'), objectHead.size);
  if (range?.invalid) return invalidRangeResponse(request, env, objectHead.size);
  const getOptions = {
    onlyIf: new Headers({ 'if-match': objectEtag }),
    ...(range ? { range: { offset: range.start, length: range.length } } : {}),
  };
  const object = await env.REMOTE_SHARE_BUCKET.get(key, getOptions);
  if (!object?.body) {
    const current = await env.REMOTE_SHARE_BUCKET.head(key);
    if (!current) return json(request, env, { error: 'not found' }, 404);
    return new Response(null, {
      status: 412,
      headers: { ...SECURITY_HEADERS, ...corsHeaders(request, env), 'cache-control': 'no-store' },
    });
  }

  return new Response(object.body, {
    status: range ? 206 : 200,
    headers: {
      ...SECURITY_HEADERS,
      ...corsHeaders(request, env),
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
      etag: objectEtag,
      'content-length': String(range ? range.length : objectHead.size),
      ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${objectHead.size}` } : {}),
    },
  });
}

async function handleDelete(request, env, roomId, objectId) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);

  const key = objectKey(roomId, objectId);
  if (!key) return json(request, env, { ok: true });

  const object = await env.REMOTE_SHARE_BUCKET.head(key);
  const readyKey = readyObjectKey(key);
  const ready = await env.REMOTE_SHARE_BUCKET.head(readyKey);
  if (!object && !ready) return json(request, env, { ok: true });

  const expected = readMetadata(object || ready, 'cleanupToken', 'cleanup-token', 'cleanuptoken');
  const supplied = request.headers.get('x-mxqr-cleanup-token') || '';
  // Existing objects must always carry the unguessable cleanup token written
  // by handleUpload. Missing metadata indicates an unexpected/legacy object;
  // fail closed instead of turning that corruption into unauthenticated delete.
  if (!expected || supplied !== expected) {
    return json(request, env, { error: 'forbidden' }, 403);
  }

  await env.REMOTE_SHARE_BUCKET.delete([key, readyKey]);
  return json(request, env, { ok: true });
}

export class RemoteShareRateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/consume') {
      return new Response('not found', { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('invalid request', { status: 400 });
    }

    const scope = body?.scope;
    const limit = Math.floor(Number(body?.limit));
    const windowSeconds = Math.floor(Number(body?.windowSeconds));
    const amount = Math.floor(Number(body?.amount ?? 1));
    if (
      (scope !== 'session' && scope !== 'upload' && scope !== 'bytes') ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(windowSeconds) ||
      windowSeconds < 1 ||
      !Number.isSafeInteger(amount) ||
      amount < 1
    ) {
      return new Response('invalid request', { status: 400 });
    }

    const now = Date.now();
    const storageKey = `counter:${scope}`;
    const result = await this.state.storage.transaction(async (transaction) => {
      const current = await transaction.get(storageKey);
      const resetAt = Number(current?.resetAt);
      const count = Number(current?.count);
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        !Number.isFinite(resetAt) ||
        resetAt <= now
      ) {
        const nextResetAt = now + windowSeconds * 1000;
        if (amount > limit) return { allowed: false, resetAt: nextResetAt };
        await transaction.put(storageKey, { count: amount, resetAt: nextResetAt });
        return { allowed: true, resetAt: nextResetAt };
      }
      if (count > limit - amount) return { allowed: false, resetAt };
      await transaction.put(storageKey, { count: count + amount, resetAt });
      return { allowed: true, resetAt };
    });

    const currentAlarm = await this.state.storage.getAlarm();
    if (currentAlarm === null || result.resetAt < currentAlarm) {
      await this.state.storage.setAlarm(result.resetAt);
    }

    return Response.json({
      allowed: result.allowed,
      retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt - now) / 1000)),
    });
  }

  async alarm() {
    const now = Date.now();
    const counters = await this.state.storage.list({ prefix: 'counter:' });
    const expiredKeys = [];
    let nextAlarm = null;
    for (const [key, value] of counters) {
      const resetAt = Number(value?.resetAt);
      if (!Number.isFinite(resetAt) || resetAt <= now) expiredKeys.push(key);
      else if (nextAlarm === null || resetAt < nextAlarm) nextAlarm = resetAt;
    }
    if (expiredKeys.length > 0) await this.state.storage.delete(expiredKeys);
    if (nextAlarm === null) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(nextAlarm);
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
        return await handleSession(request, env);
      }
      if (request.method === 'POST' && path === '/parts') {
        return await handleMultipartParts(request, env);
      }
      if (request.method === 'POST' && path === '/complete') {
        return await handleComplete(request, env);
      }
      if (request.method === 'POST' && path === '/abort') {
        return await handleMultipartAbort(request, env);
      }
      if ((request.method === 'POST' || request.method === 'PUT') && path === '/upload') {
        return await handleUpload(request, env);
      }
      const download = path.match(/^\/download\/([^/]+)\/([^/]+)$/);
      if (request.method === 'GET' && download) {
        return await handleDownload(request, env, download[1], download[2]);
      }
      const object = path.match(/^\/object\/([^/]+)\/([^/]+)$/);
      if (request.method === 'DELETE' && object) {
        return await handleDelete(request, env, object[1], object[2]);
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
