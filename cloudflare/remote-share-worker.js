/**
 * MUSIXQUARE whole-object file-share Worker.
 *
 * Required bindings:
 * - REMOTE_SHARE_BUCKET: R2 bucket
 * - REMOTE_SHARE_QUOTA: per-room Durable Object namespace when quota is enabled
 * - MUSIXQUARE_SERVICE_CONTROL: shared Durable Object namespace for maintenance
 *   state and atomic abuse-rate counters
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

import {
  consumeAbuseRateLimit,
  gateServiceMaintenance,
  readServiceMaintenance,
} from './service-maintenance.js';

// Cross-layer contract: client selection, protocol descriptors, and
// stored-object validation all use this fixed 200 MiB whole-object ceiling.
const REMOTE_SHARE_MAX_BYTES = 200 * 1024 * 1024;
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
const JSON_BODY_TIMEOUT_MS = 10_000;
const QUOTA_RESPONSE_TIMEOUT_MS = 5_000;
const HMAC_SECRET_MIN_LENGTH = 32;
const QUOTA_STATE_KEY = 'quota-state';
const QUOTA_STATE_VERSION = 2;
const QUOTA_STATE_MAX_ENTRIES = ROOM_STORAGE_SCAN_MAX_OBJECTS;
const QUOTA_STATE_MAX_SERIALIZED_BYTES = 1_500_000;
const QUOTA_ALARM_RETRY_MS = 60 * 1000;
const EXPIRY_TOMBSTONE_SWEEP_MS = 60 * 1000;
const EXPIRY_TOMBSTONE_QUIET_MS = 60 * 60 * 1000;
const WHOLE_OBJECT_VERSION = 1;
const DOWNLOAD_AUTHORIZATION_VERSION = 1;
// Storage/token format name. The peer descriptor deliberately calls the same
// downloaded bytes `whole-v1`; the distinct names identify the storage and wire layers.
const WHOLE_OBJECT_STORAGE_FORMAT = 'whole-object-v1';
const DOWNLOAD_TOKEN_KIND = 'download';
const DOWNLOAD_TOKEN_AUDIENCE = 'musixquare-remote-share';
const DOWNLOAD_TOKEN_METHOD = 'GET';
const DOWNLOAD_SIGNING_PURPOSE = 'MUSIXQUARE\0REMOTE-SHARE\0DOWNLOAD\0V1';
const DOWNLOAD_TOKEN_MAX_LENGTH = 2048;
const CLEANUP_TOKEN_KIND = 'cleanup';
const CLEANUP_TOKEN_AUDIENCE = 'musixquare-remote-share';
const CLEANUP_TOKEN_METHOD = 'DELETE';
const CLEANUP_SIGNING_PURPOSE = 'MUSIXQUARE\0REMOTE-SHARE\0CLEANUP\0V1';
const CLEANUP_TOKEN_MAX_LENGTH = 2048;
const SIGNED_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const DOWNLOAD_TOKEN_KEYS = Object.freeze([
  'aud',
  'exp',
  'iat',
  'key',
  'kind',
  'method',
  'objectId',
  'roomId',
  'storageFormat',
  'storedSize',
  'v',
]);
const CLEANUP_TOKEN_KEYS = Object.freeze([
  'aud',
  'exp',
  'iat',
  'key',
  'kind',
  'method',
  'nonce',
  'objectId',
  'roomId',
  'v',
]);
const COMPLETE_TOKEN_KEYS = Object.freeze([
  'cleanupToken',
  'exp',
  'expiresAt',
  'iat',
  'kind',
  'nonce',
  'objectId',
  'objectKey',
  'queueItemId',
  'roomId',
  'sessionId',
  'storageFormat',
  'storedSize',
  'v',
]);
// Standard ephemeral rooms are generated only in the 100000-999999 range.
// The complete 0xxxxx namespace belongs to persistent PRO rooms and must never
// share this temporary whole-object bucket or its per-room quota keys.
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

function withRemoteShareHeaders(request, env, response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...corsHeaders(request, env) })) {
    if (name.toLowerCase() === 'vary' && headers.has(name)) {
      headers.set(name, `${headers.get(name)}, ${value}`);
    } else {
      headers.set(name, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cancelBodyReader(reader, reason) {
  try {
    Promise.resolve(reader?.cancel(reason)).catch(() => {});
  } catch {
    // Cancellation is best-effort and must not delay the bounded response.
  }
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
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const timeout = setTimeout(() => {
    stop({ kind: 'timeout' });
    cancelBodyReader(reader, 'JSON_BODY_TIMEOUT');
  }, JSON_BODY_TIMEOUT_MS);
  const abort = () => {
    stop({ kind: 'aborted' });
    cancelBodyReader(reader, request.signal.reason);
  };
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const outcome = await Promise.race([
        reader.read().then(
          (value) => ({ kind: 'read', value }),
          () => ({ kind: 'invalid' }),
        ),
        stopped,
      ]);
      if (outcome.kind !== 'read') return { error: outcome.kind };
      if (outcome.value.done) break;
      const value = outcome.value.value;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        cancelBodyReader(reader, 'JSON_BODY_TOO_LARGE');
        return { error: 'too-large' };
      }
      chunks.push(bytes);
    }
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abort);
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative stream may still own the timed-out read.
    }
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
  if (result.error === 'timeout') {
    return json(request, env, { error: 'request body timed out' }, 408);
  }
  return json(request, env, { error: 'invalid json' }, 400);
}

async function readJsonResponseLimited(response, maxBytes, registerReader = () => {}) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    return null;
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    cancelBodyReader(response.body, 'RESPONSE_BODY_TOO_LARGE');
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  registerReader(reader);
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (bytes.byteLength > maxBytes - totalBytes) {
        cancelBodyReader(reader, 'RESPONSE_BODY_TOO_LARGE');
        return null;
      }
      chunks.push(bytes);
      totalBytes += bytes.byteLength;
    }
  } catch {
    return null;
  } finally {
    registerReader(null);
    try {
      reader.releaseLock();
    } catch {
      // A timed-out non-cooperative stream may still own its pending read.
    }
  }
  if (totalBytes === 0) return null;
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return null;
  }
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

function configuredCapabilitySecret(env) {
  return String(
    env.REMOTE_SHARE_CAPABILITY_SECRET ||
      env.MXQR_CAPABILITY_SECRET ||
      env.CAPABILITY_HMAC_SECRET ||
      env.CAPABILITY_SECRET ||
      '',
  ).trim();
}

function getCapabilitySecret(env) {
  const secret = configuredCapabilitySecret(env);
  return secret.length >= HMAC_SECRET_MIN_LENGTH ? secret : '';
}

function hasInvalidCapabilitySecret(env) {
  const secret = configuredCapabilitySecret(env);
  return secret.length > 0 && secret.length < HMAC_SECRET_MIN_LENGTH;
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
  if (hasInvalidCapabilitySecret(env)) {
    return json(request, env, { error: 'CAPABILITY_SECRET_INVALID' }, 503);
  }
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
  if (hasInvalidCapabilitySecret(env)) {
    return json(request, env, { error: 'CAPABILITY_SECRET_INVALID' }, 503);
  }
  return json(request, env, {
    capabilityRequired: isCapabilityRequired(env),
    scope: CAPABILITY_SCOPE,
    ttl: CAPABILITY_TOKEN_TTL_DEFAULT,
    workerContractVersion: 1,
    wholeObjectVersion: WHOLE_OBJECT_VERSION,
    downloadAuthorizationVersion: DOWNLOAD_AUTHORIZATION_VERSION,
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

async function downloadSigningSecret(signingSecret) {
  // Keep download bearers cryptographically separate from upload-completion
  // authorities even though production provisions one root signing secret.
  return hmacSha256(signingSecret, DOWNLOAD_SIGNING_PURPOSE);
}

async function createDownloadToken(payload, signingSecret) {
  return createSignedToken(payload, await downloadSigningSecret(signingSecret));
}

async function verifyDownloadToken(token, signingSecret) {
  if (typeof token !== 'string' || token.length === 0 || token.length > DOWNLOAD_TOKEN_MAX_LENGTH) {
    return null;
  }
  return verifySignedToken(token, await downloadSigningSecret(signingSecret));
}

async function cleanupSigningSecret(signingSecret) {
  // Cleanup authority has a distinct cryptographic purpose so neither an
  // upload-completion token nor a download bearer can be replayed as DELETE
  // authority.
  return hmacSha256(signingSecret, CLEANUP_SIGNING_PURPOSE);
}

async function createCleanupToken(payload, signingSecret) {
  return createSignedToken(payload, await cleanupSigningSecret(signingSecret));
}

async function verifyCleanupToken(token, signingSecret) {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > CLEANUP_TOKEN_MAX_LENGTH ||
    !SIGNED_TOKEN_RE.test(token)
  ) {
    return null;
  }
  return verifySignedToken(token, await cleanupSigningSecret(signingSecret));
}

function cleanupPayloadMatches(payload, { roomId, objectId, key, expiresAt, now = Date.now() }) {
  return (
    payload &&
    hasExactOwnKeys(payload, CLEANUP_TOKEN_KEYS) &&
    payload.v === WHOLE_OBJECT_VERSION &&
    payload.kind === CLEANUP_TOKEN_KIND &&
    payload.aud === CLEANUP_TOKEN_AUDIENCE &&
    payload.method === CLEANUP_TOKEN_METHOD &&
    payload.roomId === roomId &&
    payload.objectId === objectId &&
    payload.key === key &&
    UUID_V4_RE.test(String(payload.nonce || '')) &&
    Number.isSafeInteger(payload.iat) &&
    payload.iat > 0 &&
    payload.iat <= now + 60_000 &&
    Number.isSafeInteger(payload.exp) &&
    payload.exp === expiresAt &&
    payload.exp >= payload.iat &&
    payload.exp > now
  );
}

function readDownloadBearer(request) {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
  return match && match[1].length <= DOWNLOAD_TOKEN_MAX_LENGTH ? match[1] : '';
}

function standardRoomId(value) {
  return typeof value === 'string' && STANDARD_ROOM_CODE_RE.test(value) ? value : null;
}

function hasExactOwnKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && keys.every((key) => expectedKeys.includes(key));
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (env.MUSIXQUARE_SERVICE_CONTROL) {
    const result = await consumeAbuseRateLimit(env, {
      scope: 'remote-share-upload',
      identity: key,
      limit,
      windowMs: ttlSeconds * 1_000,
    });
    if (result.status !== 'ok') return 'unavailable';
    return result.allowed ? 'allowed' : 'limited';
  }

  // Direct unit tests invoke the Worker without Cloudflare globals. Production
  // fails closed if the shared atomic limiter binding is removed.
  return typeof caches === 'undefined' ? 'allowed' : 'unavailable';
}

function roomStorageQuotaBytes(env) {
  return parseOptionalLimit(env.ROOM_STORAGE_QUOTA_BYTES, DEFAULT_ROOM_STORAGE_QUOTA_BYTES);
}

function roomStorageQuotaEnabled(env) {
  return roomStorageQuotaBytes(env) > 0;
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
  const prefixes = [`room/${roomId}/`];
  const staleKeys = [];
  const observedKeys = new Set();
  const activeKeys = new Set();
  let scannedObjects = 0;
  let totalBytes = 0;
  let saturated = false;

  for (const prefix of prefixes) {
    let cursor;
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
    if (saturated) break;
  }

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
  let activeReader = null;
  let timedOut = false;
  let timeoutId = null;
  const outcome = Promise.resolve()
    .then(() =>
      stub.fetch(
        new Request(`https://remote-share-quota.internal/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ roomId, ...body }),
        }),
      ),
    )
    .then(
      async (response) => {
        if (timedOut) {
          cancelBodyReader(response.body, 'QUOTA_RESPONSE_TIMEOUT');
          return null;
        }
        const payload = await readJsonResponseLimited(
          response,
          QUOTA_JSON_BODY_MAX_BYTES,
          (reader) => {
            activeReader = reader;
          },
        );
        return timedOut ? null : { response, payload };
      },
      () => null,
    );
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      cancelBodyReader(activeReader, 'QUOTA_RESPONSE_TIMEOUT');
      resolve(null);
    }, QUOTA_RESPONSE_TIMEOUT_MS);
  });
  let result;
  try {
    result = await Promise.race([outcome, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
  if (!result || !result.payload) {
    throw new Error('invalid room storage quota response');
  }
  return { payload: result.payload, status: result.response.status };
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

async function consumeUploadSessionRateLimits(request, env, secret, roomId) {
  const rateWindowSeconds = parseLimit(
    env.RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  );
  const ipUploadLimit = parseLimit(env.IP_UPLOADS_PER_WINDOW, DEFAULT_IP_UPLOADS_PER_WINDOW);
  const roomUploadLimit = parseOptionalLimit(
    env.ROOM_UPLOADS_PER_WINDOW,
    DEFAULT_ROOM_UPLOADS_PER_WINDOW,
  );
  const ipRate = await consumeLimit(
    env,
    await rateLimitIpKey(secret, request),
    ipUploadLimit,
    rateWindowSeconds,
  );
  if (ipRate === 'unavailable') {
    return json(request, env, { error: 'rate limit unavailable' }, 503);
  }
  if (ipRate === 'limited') {
    return rateLimited(request, env, 'rate limited', rateWindowSeconds);
  }
  if (roomUploadLimit > 0) {
    const roomRate = await consumeLimit(
      env,
      `session-room:${roomId}`,
      roomUploadLimit,
      rateWindowSeconds,
    );
    if (roomRate === 'unavailable') {
      return json(request, env, { error: 'rate limit unavailable' }, 503);
    }
    if (roomRate === 'limited') {
      return rateLimited(request, env, 'room rate limited', rateWindowSeconds);
    }
  }
  return null;
}

async function handleSession(request, env) {
  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);

  const capabilityError = await requireSessionCapability(request, env);
  if (capabilityError) return capabilityError;

  const parsedBody = await readJsonBodyLimited(request, SESSION_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(request, env, parsedBody);
  const body = parsedBody.value;

  if (!hasExactOwnKeys(body, ['roomId', 'sessionId', 'queueItemId', 'name', 'mime', 'size'])) {
    return json(request, env, { error: 'invalid upload session request' }, 400);
  }

  const roomId = standardRoomId(body?.roomId);
  const sessionId = Number(body?.sessionId);
  const queueItemId = safeQueueItemId(body?.queueItemId);
  const storedSize = Number(body?.size);
  if (
    !roomId ||
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    !queueItemId ||
    !Number.isSafeInteger(storedSize) ||
    storedSize <= 0 ||
    storedSize > REMOTE_SHARE_MAX_BYTES
  ) {
    return json(request, env, { error: 'invalid upload session request' }, 400);
  }

  const rateLimitError = await consumeUploadSessionRateLimits(request, env, secret, roomId);
  if (rateLimitError) return rateLimitError;

  const ttlSeconds = parseLimit(env.UPLOAD_TOKEN_TTL_SECONDS, DEFAULT_UPLOAD_TOKEN_TTL_SECONDS);
  const now = Date.now();
  const uploadUrlExpiresAt = now + ttlSeconds * 1000;
  const objectTtlSeconds = parseLimit(env.OBJECT_TTL_SECONDS, DEFAULT_TTL_SECONDS);
  const expiresAt = now + objectTtlSeconds * 1000;
  const objectId = crypto.randomUUID();
  const objectKeyValue = objectKey(roomId, objectId);
  const cleanupToken = await createCleanupToken(
    {
      v: WHOLE_OBJECT_VERSION,
      kind: CLEANUP_TOKEN_KIND,
      aud: CLEANUP_TOKEN_AUDIENCE,
      method: CLEANUP_TOKEN_METHOD,
      roomId,
      objectId,
      key: objectKeyValue,
      iat: now,
      exp: expiresAt,
      nonce: crypto.randomUUID(),
    },
    secret,
  );
  const name = metadataString(body?.name, 'track');
  const mime = metadataString(body?.mime, 'application/octet-stream');
  const quotaEnabled = roomStorageQuotaEnabled(env);
  let quotaReserved = false;

  try {
    if (quotaEnabled) {
      let reserved;
      try {
        reserved = await reserveRoomStorage(env, {
          cleanupToken,
          storedSize,
          expiresAt,
          objectId,
          objectKey: objectKeyValue,
          roomId,
        });
      } catch (error) {
        console.warn('remote share room storage quota unavailable', error);
        await releaseRoomStorageReservationBestEffort(env, roomId, objectId, cleanupToken);
        return json(request, env, { error: 'room storage quota unavailable' }, 503);
      }
      if (!reserved) return roomStorageQuotaExceeded(request, env);
      quotaReserved = true;
    }

    const uploadHeaders = {
      'content-type': 'application/octet-stream',
      'x-amz-meta-cleanup-token': cleanupToken,
      'x-amz-meta-expires-at': String(expiresAt),
      'x-amz-meta-format-version': WHOLE_OBJECT_STORAGE_FORMAT,
      'x-amz-meta-mime': mime,
      'x-amz-meta-name': name,
      'x-amz-meta-object-id': objectId,
      'x-amz-meta-room-id': roomId,
      'x-amz-meta-stored-size': String(storedSize),
    };
    const uploadUrl = await createR2PresignedPutUrl({
      env,
      objectKey: objectKeyValue,
      headers: {
        ...uploadHeaders,
        'content-length': String(storedSize),
      },
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

    const completePayload = {
      v: WHOLE_OBJECT_VERSION,
      ...(quotaEnabled ? { quotaReservationVersion: 1 } : {}),
      kind: 'complete',
      storageFormat: WHOLE_OBJECT_STORAGE_FORMAT,
      roomId,
      objectId,
      objectKey: objectKeyValue,
      sessionId,
      queueItemId,
      storedSize,
      expiresAt,
      cleanupToken,
      iat: now,
      exp: expiresAt,
      nonce: crypto.randomUUID(),
    };
    const completeToken = await createSignedToken(completePayload, secret);
    const response = json(request, env, {
      uploadUrl,
      uploadHeaders,
      uploadUrlExpiresAt,
      completeToken,
      objectId,
      expiresAt,
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
  if (!hasExactOwnKeys(body, ['roomId', 'objectId', 'completeToken'])) {
    return json(request, env, { error: 'invalid upload completion' }, 400);
  }

  const payload = await verifySignedToken(body.completeToken, secret);
  const roomId = standardRoomId(body.roomId);
  const objectId = String(body.objectId || '');
  const now = Date.now();
  const issuedAt = Number(payload?.iat);
  const tokenExpiresAt = Number(payload?.exp);
  const objectExpiresAt = Number(payload?.expiresAt);
  const expectedTokenKeys =
    payload?.quotaReservationVersion === undefined
      ? COMPLETE_TOKEN_KEYS
      : [...COMPLETE_TOKEN_KEYS, 'quotaReservationVersion'];
  if (
    !roomId ||
    !payload ||
    !hasExactOwnKeys(payload, expectedTokenKeys) ||
    payload.v !== WHOLE_OBJECT_VERSION ||
    (payload.quotaReservationVersion !== undefined && payload.quotaReservationVersion !== 1) ||
    payload.kind !== 'complete' ||
    payload.storageFormat !== WHOLE_OBJECT_STORAGE_FORMAT ||
    payload.roomId !== roomId ||
    payload.objectId !== objectId ||
    !Number.isSafeInteger(payload.sessionId) ||
    payload.sessionId <= 0 ||
    !safeQueueItemId(payload.queueItemId) ||
    !Number.isSafeInteger(payload.storedSize) ||
    payload.storedSize <= 0 ||
    payload.storedSize > REMOTE_SHARE_MAX_BYTES ||
    typeof payload.cleanupToken !== 'string' ||
    payload.cleanupToken.length === 0 ||
    payload.cleanupToken.length > CLEANUP_TOKEN_MAX_LENGTH ||
    !UUID_V4_RE.test(String(payload.nonce || '')) ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(tokenExpiresAt) ||
    !Number.isSafeInteger(objectExpiresAt) ||
    issuedAt > tokenExpiresAt ||
    issuedAt > now + 60_000 ||
    tokenExpiresAt !== objectExpiresAt ||
    tokenExpiresAt <= now
  ) {
    return json(request, env, { error: 'invalid upload completion' }, 403);
  }

  const key = objectKey(roomId, objectId);
  if (!key || key !== payload.objectKey) return json(request, env, { error: 'not found' }, 404);

  const cleanupPayload = await verifyCleanupToken(payload.cleanupToken, secret);
  if (
    !cleanupPayloadMatches(cleanupPayload, {
      roomId,
      objectId,
      key,
      expiresAt: objectExpiresAt,
      now,
    })
  ) {
    return json(request, env, { error: 'invalid upload completion' }, 403);
  }

  const object = await env.REMOTE_SHARE_BUCKET.head(key);
  if (!object) return json(request, env, { error: 'not found' }, 404);

  const storedSize = Number(payload.storedSize);
  const metadataStoredSize = Number(
    readMetadata(object, 'storedSize', 'stored-size', 'storedsize'),
  );
  const storedFormat = String(
    readMetadata(object, 'formatVersion', 'format-version', 'formatversion') || '',
  );
  const storedRoomId = String(readMetadata(object, 'roomId', 'room-id', 'roomid') || '');
  const storedObjectId = String(readMetadata(object, 'objectId', 'object-id', 'objectid') || '');
  const storedCleanupToken = String(
    readMetadata(object, 'cleanupToken', 'cleanup-token', 'cleanuptoken') || '',
  );
  const storedExpiresAt = Number(readMetadata(object, 'expiresAt', 'expires-at', 'expiresat'));
  const storedCleanupPayload = await verifyCleanupToken(storedCleanupToken, secret);
  if (
    object.size !== storedSize ||
    object.size > REMOTE_SHARE_MAX_BYTES ||
    metadataStoredSize !== storedSize ||
    storedFormat !== WHOLE_OBJECT_STORAGE_FORMAT ||
    storedRoomId !== roomId ||
    storedObjectId !== objectId ||
    !constantTimeEqual(storedCleanupToken, payload.cleanupToken) ||
    storedExpiresAt !== objectExpiresAt ||
    !cleanupPayloadMatches(storedCleanupPayload, {
      roomId,
      objectId,
      key,
      expiresAt: storedExpiresAt,
      now,
    })
  ) {
    await deleteObjectAndRetainReservation(env, roomId, objectId, key, payload.cleanupToken);
    return json(request, env, { error: 'invalid uploaded object' }, 403);
  }

  if (objectExpiresAt <= Date.now()) {
    await deleteObjectAndRetainReservation(env, roomId, objectId, key, payload.cleanupToken);
    return json(request, env, { error: 'expired' }, 404);
  }

  const quotaSettlementRequired = roomStorageQuotaBytes(env) > 0 || Boolean(env.REMOTE_SHARE_QUOTA);
  if (payload.quotaReservationVersion === 1 && quotaSettlementRequired) {
    try {
      const completion = await completeRoomStorageReservation(env, {
        cleanupToken: payload.cleanupToken,
        storedSize,
        expiresAt: objectExpiresAt,
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
      console.warn('remote share completion quota validation unavailable', error);
      return json(request, env, { error: 'room storage quota unavailable' }, 503);
    }
  } else {
    try {
      if (!(await roomHasStorageCapacity(env, roomId, 0))) {
        await env.REMOTE_SHARE_BUCKET.delete(key);
        return roomStorageQuotaExceeded(request, env);
      }
    } catch (error) {
      console.warn('remote share completion quota validation unavailable', error);
      await env.REMOTE_SHARE_BUCKET.delete(key);
      return json(request, env, { error: 'room storage quota unavailable' }, 503);
    }
  }

  const tokenIssuedAt = Date.now();
  if (objectExpiresAt <= tokenIssuedAt) {
    await deleteObjectAndRetainReservation(env, roomId, objectId, key, payload.cleanupToken);
    return json(request, env, { error: 'expired' }, 404);
  }
  const downloadToken = await createDownloadToken(
    {
      v: DOWNLOAD_AUTHORIZATION_VERSION,
      kind: DOWNLOAD_TOKEN_KIND,
      aud: DOWNLOAD_TOKEN_AUDIENCE,
      method: DOWNLOAD_TOKEN_METHOD,
      roomId,
      objectId,
      key,
      storedSize,
      storageFormat: WHOLE_OBJECT_STORAGE_FORMAT,
      iat: tokenIssuedAt,
      exp: objectExpiresAt,
    },
    secret,
  );
  const url = new URL(request.url);
  return json(request, env, {
    downloadToken,
    downloadUrl: `${url.origin}/download/${roomId}/${objectId}`,
    objectId,
    storedSize,
    expiresAt: objectExpiresAt,
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

function downloadUnauthorized(request, env) {
  return json(
    request,
    env,
    { error: 'download authorization required', code: 'DOWNLOAD_AUTHORIZATION_REQUIRED' },
    401,
    { 'www-authenticate': 'Bearer' },
  );
}

async function handleDownload(request, env, roomId, objectId) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);
  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);

  const key = objectKey(roomId, objectId);
  if (!key) return json(request, env, { error: 'not found' }, 404);
  if (new URL(request.url).search !== '') {
    return json(request, env, { error: 'download query parameters are not allowed' }, 400);
  }

  const token = readDownloadBearer(request);
  const payload = token ? await verifyDownloadToken(token, secret) : null;
  const now = Date.now();
  if (
    !payload ||
    !hasExactOwnKeys(payload, DOWNLOAD_TOKEN_KEYS) ||
    payload.v !== DOWNLOAD_AUTHORIZATION_VERSION ||
    payload.kind !== DOWNLOAD_TOKEN_KIND ||
    payload.aud !== DOWNLOAD_TOKEN_AUDIENCE ||
    payload.method !== request.method ||
    payload.method !== DOWNLOAD_TOKEN_METHOD ||
    payload.roomId !== roomId ||
    payload.objectId !== objectId ||
    payload.key !== key ||
    payload.storageFormat !== WHOLE_OBJECT_STORAGE_FORMAT ||
    !Number.isSafeInteger(payload.storedSize) ||
    payload.storedSize <= 0 ||
    payload.storedSize > REMOTE_SHARE_MAX_BYTES ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat <= 0 ||
    payload.iat > now + 60_000 ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp < payload.iat ||
    payload.exp <= now
  ) {
    return downloadUnauthorized(request, env);
  }

  if (request.headers.has('range')) {
    return json(
      request,
      env,
      { error: 'range requests are not supported', code: 'RANGE_NOT_SUPPORTED' },
      416,
      {
        'accept-ranges': 'none',
        'content-range': `bytes */${payload.storedSize}`,
      },
    );
  }

  // Authentication deliberately precedes the R2 read so random object IDs or
  // leaked clean URLs cannot be converted into Class B operations.
  const object = await env.REMOTE_SHARE_BUCKET.get(key);
  if (!object) return json(request, env, { error: 'not found' }, 404);

  const storedCleanupToken = String(
    readMetadata(object, 'cleanupToken', 'cleanup-token', 'cleanuptoken') || '',
  );
  const metadataStoredSize = Number(
    readMetadata(object, 'storedSize', 'stored-size', 'storedsize'),
  );
  const storedFormat = String(
    readMetadata(object, 'formatVersion', 'format-version', 'formatversion') || '',
  );
  const storedRoomId = String(readMetadata(object, 'roomId', 'room-id', 'roomid') || '');
  const storedObjectId = String(readMetadata(object, 'objectId', 'object-id', 'objectid') || '');
  const storedExpiresAt = Number(readMetadata(object, 'expiresAt', 'expires-at', 'expiresat'));
  const storedCleanupPayload = await verifyCleanupToken(storedCleanupToken, secret);
  if (
    object.size !== payload.storedSize ||
    object.size > REMOTE_SHARE_MAX_BYTES ||
    metadataStoredSize !== payload.storedSize ||
    storedFormat !== payload.storageFormat ||
    storedRoomId !== roomId ||
    storedObjectId !== objectId ||
    storedExpiresAt !== payload.exp ||
    !cleanupPayloadMatches(storedCleanupPayload, {
      roomId,
      objectId,
      key,
      expiresAt: storedExpiresAt,
    })
  ) {
    await deleteObjectAndRetainReservation(env, roomId, objectId, key, storedCleanupToken);
    return json(request, env, { error: 'invalid stored object' }, 404);
  }
  if (storedExpiresAt <= Date.now()) {
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
      'accept-ranges': 'none',
    },
  });
}

async function handleDelete(request, env, roomId, objectId) {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);
  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);

  const key = objectKey(roomId, objectId);
  if (!key) return json(request, env, { ok: true });

  const supplied = request.headers.get('x-mxqr-cleanup-token') || '';
  const cleanupPayload = await verifyCleanupToken(supplied, secret);
  if (
    !cleanupPayloadMatches(cleanupPayload, {
      roomId,
      objectId,
      key,
      expiresAt: cleanupPayload?.exp,
    })
  ) {
    return json(request, env, { error: 'forbidden' }, 403);
  }

  // Signed cleanup authority is verified before HEAD so random object IDs or
  // UUID-shaped header values cannot be amplified into public R2 Class B work.
  const object = await env.REMOTE_SHARE_BUCKET.head(key);
  if (!object) return json(request, env, { ok: true });

  const expected = String(
    readMetadata(object, 'cleanupToken', 'cleanup-token', 'cleanuptoken') || '',
  );
  const storedExpiresAt = Number(readMetadata(object, 'expiresAt', 'expires-at', 'expiresat'));
  if (!constantTimeEqual(supplied, expected) || storedExpiresAt !== cleanupPayload.exp) {
    return json(request, env, { error: 'forbidden' }, 403);
  }

  await env.REMOTE_SHARE_BUCKET.delete(key);
  // The exact-byte quota reservation remains until immutable expiry because a
  // previously issued PUT can still be replayed.
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

function validQuotaReservation(objectId, value, roomId) {
  const hasTombstoneFields =
    value?.tombstoneQuietSince !== undefined || value?.tombstoneNextSweepAt !== undefined;
  const validTombstoneFields =
    !hasTombstoneFields ||
    (Number.isSafeInteger(value?.tombstoneQuietSince) &&
      value.tombstoneQuietSince >= value.expiresAt &&
      Number.isSafeInteger(value?.tombstoneNextSweepAt) &&
      value.tombstoneNextSweepAt > value.tombstoneQuietSince);
  const key = objectKey(roomId, objectId);
  return (
    value &&
    typeof value === 'object' &&
    Boolean(key) &&
    value.objectId === objectId &&
    value.objectKey === key &&
    Number.isSafeInteger(value.storedSize) &&
    value.storedSize > 0 &&
    value.storedSize <= REMOTE_SHARE_MAX_BYTES &&
    Number.isSafeInteger(value.expiresAt) &&
    typeof value.cleanupToken === 'string' &&
    value.cleanupToken.length <= CLEANUP_TOKEN_MAX_LENGTH &&
    SIGNED_TOKEN_RE.test(value.cleanupToken) &&
    (value.status === 'reserved' || value.status === 'completed') &&
    validTombstoneFields
  );
}

function normalizeQuotaReservation(objectId, value, roomId) {
  if (!validQuotaReservation(objectId, value, roomId)) return null;
  return {
    cleanupToken: value.cleanupToken,
    storedSize: value.storedSize,
    expiresAt: value.expiresAt,
    objectId,
    objectKey: value.objectKey,
    status: value.status,
    ...(value.tombstoneQuietSince === undefined
      ? {}
      : { tombstoneQuietSince: value.tombstoneQuietSince }),
    ...(value.tombstoneNextSweepAt === undefined
      ? {}
      : { tombstoneNextSweepAt: value.tombstoneNextSweepAt }),
  };
}

function parseQuotaReservation(body) {
  if (body?.tombstoneQuietSince !== undefined || body?.tombstoneNextSweepAt !== undefined) {
    return null;
  }
  const roomId = standardRoomId(body?.roomId);
  const objectId = String(body?.objectId || '');
  const storedSize = Number(body?.storedSize);
  const expiresAt = Number(body?.expiresAt);
  const cleanupToken = String(body?.cleanupToken || '');
  const key = objectKey(roomId, objectId);
  if (
    !roomId ||
    !key ||
    body?.objectKey !== key ||
    !Number.isSafeInteger(storedSize) ||
    storedSize <= 0 ||
    storedSize > REMOTE_SHARE_MAX_BYTES ||
    !Number.isSafeInteger(expiresAt) ||
    cleanupToken.length > CLEANUP_TOKEN_MAX_LENGTH ||
    !SIGNED_TOKEN_RE.test(cleanupToken)
  ) {
    return null;
  }
  return {
    cleanupToken,
    storedSize,
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
    left.storedSize === right.storedSize &&
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
      const maintenanceResponse = await gateServiceMaintenance(request, this.env, {
        format: 'json',
      });
      if (maintenanceResponse) return maintenanceResponse;
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
    if (stored?.v === 1 && stored?.roomId === roomId) {
      // This deployment is an explicit no-active-session hard cutover. Drop the
      // obsolete reservation schema; the immediately following R2 scan remains
      // authoritative for every physical object that still exists.
      await this.storage.delete(QUOTA_STATE_KEY);
      if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
      return emptyQuotaState(roomId);
    }
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
      const normalized = normalizeQuotaReservation(objectId, reservation, roomId);
      if (!normalized) throw new Error('invalid room storage reservation state');
      reservations[objectId] = normalized;
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
      if (reservation.expiresAt <= now) continue;
      if (!snapshot.activeKeys.has(reservation.objectKey)) {
        totalBytes += reservation.storedSize;
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
    const accountedBytes = this.accountedBytes(state, snapshot, now);
    if (accountedBytes + reservation.storedSize > quotaBytes) {
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
    if (
      !objectKey(roomId, objectId) ||
      cleanupToken.length > CLEANUP_TOKEN_MAX_LENGTH ||
      !SIGNED_TOKEN_RE.test(cleanupToken)
    ) {
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
        if ((await readServiceMaintenance(this.env)).enabled) {
          if (typeof this.storage.setAlarm === 'function') {
            await this.storage.setAlarm(Date.now() + QUOTA_ALARM_RETRY_MS);
          }
          return;
        }
        const stored = await this.storage.get(QUOTA_STATE_KEY);
        if (stored === undefined || stored === null) {
          if (typeof this.storage.deleteAll === 'function') await this.storage.deleteAll();
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

    const isReadinessRequest = request.method === 'GET' && path === '/security-config';
    if (!isReadinessRequest) {
      const maintenanceResponse = await gateServiceMaintenance(request, env, { format: 'json' });
      if (maintenanceResponse) return withRemoteShareHeaders(request, env, maintenanceResponse);
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
