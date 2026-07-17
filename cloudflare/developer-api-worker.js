/**
 * MUSIXQUARE Developer API public edge Worker.
 *
 * This Worker intentionally has no binding to PRO room Durable Objects, R2,
 * signaling, or the browser-facing PRO Worker. It authenticates a room-bound
 * API key, applies ingress and room-serial limits, then sends one allowlisted
 * intent to the private Developer API Facade service binding.
 */

const API_KEY_RE = /^mxqr_live_([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
const ROOM_CODE_RE = /^0\d{5}$/;
const REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{22}$/;
const DIGEST_RE = /^[A-Za-z0-9_-]{43}$/;
const AUTHORIZATION_MAX_BYTES = 128;
const URL_MAX_BYTES = 2_048;
const ETAG_HEADER_MAX_BYTES = 128;
// PRO room state is itself capped at 1.2 MiB. Leave bounded framing room for
// the projection envelope so every valid 1,000-item queue remains readable.
const FACADE_RESPONSE_MAX_BYTES = 1_500 * 1024;
const RATE_REQUEST_MAX_BYTES = 4 * 1024;
const RATE_STATE_MAX_ITEMS = 256;
const INGRESS_LIMIT_PER_MINUTE = 120;
const KEY_READ_LIMIT_PER_MINUTE = 60;
const ROOM_READ_LIMIT_PER_MINUTE = 180;
const SCOPE_ROOM_READ = 1;
const SCOPE_PLAYBACK_READ = 2;
const SCOPE_PLAYBACK_CONTROL = 4;
const SCOPE_QUEUE_READ = 8;
const SCOPE_QUEUE_WRITE = 16;
const SCOPE_MEDIA_UPLOAD = 32;
const ALL_SCOPE_BITS =
  SCOPE_ROOM_READ |
  SCOPE_PLAYBACK_READ |
  SCOPE_PLAYBACK_CONTROL |
  SCOPE_QUEUE_READ |
  SCOPE_QUEUE_WRITE |
  SCOPE_MEDIA_UPLOAD;
const SECURITY_HEADERS = Object.freeze({
  'content-security-policy':
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});
const ERROR_MESSAGES = Object.freeze({
  API_DISABLED: 'The Developer API is not enabled.',
  API_NOT_CONFIGURED: 'The Developer API is temporarily unavailable.',
  BACKEND_UNAVAILABLE: 'The Developer API backend is temporarily unavailable.',
  BROWSER_ORIGIN_FORBIDDEN: 'Browser-origin requests are not accepted.',
  FORBIDDEN: 'This API key does not have the required scope.',
  INTERNAL_RESPONSE_INVALID: 'The Developer API backend returned an invalid response.',
  NOT_FOUND: 'The requested resource was not found.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  UNAUTHORIZED: 'A valid Developer API key is required.',
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function hasExactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function boundedString(value, maxLength, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maxLength) return null;
  if (!allowEmpty && value.length === 0) return null;
  return value;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomRequestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `req_${base64UrlEncode(bytes)}`;
}

async function hmacBase64Url(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))),
  );
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function parseDeveloperApiKey(value) {
  if (typeof value !== 'string' || value.length > AUTHORIZATION_MAX_BYTES) return null;
  const match = value.match(API_KEY_RE);
  return match ? { keyId: match[1], secret: match[2] } : null;
}

export async function deriveDeveloperApiKeyDigest(pepper, keyId, secret) {
  if (
    typeof pepper !== 'string' ||
    pepper.length < 32 ||
    !/^[A-Za-z0-9_-]{16}$/.test(keyId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret)
  ) {
    throw new Error('Invalid Developer API key material');
  }
  return hmacBase64Url(pepper, `mxqr-developer-api-key:v1\u0000${keyId}\u0000${secret}`);
}

function apiHeaders(requestId, extraHeaders = {}, cacheControl = 'no-store') {
  return {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'cache-control': cacheControl,
    'x-request-id': requestId,
  };
}

function jsonResponse(body, status, requestId, extraHeaders = {}, cacheControl = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...apiHeaders(requestId, extraHeaders, cacheControl),
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function emptyResponse(status, requestId, extraHeaders = {}, cacheControl = 'private, no-cache') {
  return new Response(null, {
    status,
    headers: apiHeaders(requestId, extraHeaders, cacheControl),
  });
}

function errorResponse(code, status, requestId, options = {}) {
  return jsonResponse(
    {
      error: {
        code,
        message: ERROR_MESSAGES[code] || 'The request could not be completed.',
        requestId,
        retryable: options.retryable === true,
      },
    },
    status,
    requestId,
    options.headers || {},
  );
}

function configuredMode(env) {
  const mode = String(env.DEVELOPER_API_MODE || 'off')
    .trim()
    .toLowerCase();
  return ['off', 'read-only', 'canary', 'enabled'].includes(mode) ? mode : 'off';
}

function configuredCanaryRooms(env) {
  return new Set(
    String(env.DEVELOPER_API_CANARY_ROOMS || '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => ROOM_CODE_RE.test(value)),
  );
}

function readBearer(request) {
  const authorization = request.headers.get('authorization') || '';
  if (
    authorization.length === 0 ||
    encoder.encode(authorization).byteLength > AUTHORIZATION_MAX_BYTES ||
    /[\u0000-\u001f\u007f,]/.test(authorization)
  ) {
    return null;
  }
  const match = authorization.match(/^Bearer ([^\s]+)$/i);
  return match ? parseDeveloperApiKey(match[1]) : null;
}

function validScopeMask(value) {
  return (
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= ALL_SCOPE_BITS &&
    (value & ~ALL_SCOPE_BITS) === 0
  );
}

function normalizeKeyRow(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !/^[A-Za-z0-9_-]{16}$/.test(String(value.key_id || '')) ||
    !ROOM_CODE_RE.test(String(value.room_code || '')) ||
    !DIGEST_RE.test(String(value.secret_digest || '')) ||
    value.digest_version !== 1 ||
    !validScopeMask(value.scope_mask) ||
    (value.status !== 'active' && value.status !== 'revoked') ||
    !isSafeNonNegativeInteger(value.created_at) ||
    !isSafeNonNegativeInteger(value.updated_at) ||
    value.updated_at < value.created_at ||
    !isSafeNonNegativeInteger(value.expires_at) ||
    value.expires_at <= value.created_at ||
    ((value.status === 'active' && value.revoked_at !== null) ||
      (value.status === 'revoked' &&
        (!isSafeNonNegativeInteger(value.revoked_at) || value.revoked_at < value.created_at)))
  ) {
    return null;
  }
  return {
    keyId: value.key_id,
    roomCode: value.room_code,
    digest: value.secret_digest,
    scopeMask: value.scope_mask,
    status: value.status,
    expiresAt: value.expires_at,
  };
}

async function lookupKey(env, keyId) {
  if (!env.DEVELOPER_API_DB?.prepare) throw new Error('Developer API D1 binding unavailable');
  return env.DEVELOPER_API_DB.prepare(
    `SELECT key_id, room_code, secret_digest, digest_version, scope_mask,
            status, created_at, updated_at, expires_at, revoked_at
     FROM mxqr_developer_api_keys
     WHERE key_id = ?1
     LIMIT 1`,
  )
    .bind(keyId)
    .first();
}

function updateLastUsedBestEffort(env, context, keyId, nowMs) {
  if (!context?.waitUntil || !env.DEVELOPER_API_DB?.prepare) return;
  const hour = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const update = env.DEVELOPER_API_DB.prepare(
    `UPDATE mxqr_developer_api_keys
     SET last_used_hour = ?2
     WHERE key_id = ?1 AND (last_used_hour IS NULL OR last_used_hour < ?2)`,
  )
    .bind(keyId, hour)
    .run()
    .catch(() => {});
  context.waitUntil(update);
}

async function authenticate(request, env, context, nowMs) {
  const pepper = String(env.MXQR_DEVELOPER_API_KEY_PEPPER || '');
  if (pepper.length < 32) return { configurationError: true };
  const parsed = readBearer(request);
  if (!parsed) {
    await hmacBase64Url(pepper, 'mxqr-developer-api-key:v1\u0000invalid\u0000invalid');
    return { unauthorized: true };
  }
  let rawRow;
  try {
    rawRow = await lookupKey(env, parsed.keyId);
  } catch {
    return { backendError: true };
  }
  const row = normalizeKeyRow(rawRow);
  const actual = await deriveDeveloperApiKeyDigest(pepper, parsed.keyId, parsed.secret);
  const matches = constantTimeEqual(actual, row?.digest || 'A'.repeat(43));
  if (
    !matches ||
    !row ||
    row.keyId !== parsed.keyId ||
    row.status !== 'active' ||
    row.expiresAt <= nowMs
  ) {
    return { unauthorized: true };
  }
  updateLastUsedBestEffort(env, context, row.keyId, nowMs);
  return { principal: row };
}

async function readJsonLimited(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    return null;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
}

function validQueueItem(value) {
  if (
    !hasExactKeys(value, ['queueItemId', 'kind', 'name'], [
      'title',
      'artist',
      'thumbnail',
      'byteLength',
    ]) ||
    typeof value.queueItemId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.queueItemId) ||
    (value.kind !== 'youtube' && value.kind !== 'audio') ||
    boundedString(value.name, 512) === null
  ) {
    return false;
  }
  for (const key of ['title', 'artist']) {
    if (value[key] !== undefined && boundedString(value[key], 512) === null) return false;
  }
  if (value.thumbnail !== undefined && boundedString(value.thumbnail, 2_048) === null) return false;
  if (value.kind === 'audio') {
    return Number.isSafeInteger(value.byteLength) && value.byteLength > 0;
  }
  return value.byteLength === undefined;
}

function validateFacadePayload(value, expectedView, roomCode) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) return null;
  if (value.view !== expectedView || value.roomCode !== roomCode) return null;
  if (expectedView === 'room') {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'view',
        'roomCode',
        'status',
        'runtime',
        'revision',
        'participantCount',
        'controlAvailable',
        'quota',
      ]) ||
      !['unactivated', 'active', 'suspended'].includes(value.status) ||
      (value.runtime !== 'awake' && value.runtime !== 'sleeping') ||
      !isSafeNonNegativeInteger(value.revision) ||
      !isSafeNonNegativeInteger(value.participantCount) ||
      typeof value.controlAvailable !== 'boolean' ||
      !hasExactKeys(value.quota, [
        'limitBytes',
        'perAssetLimitBytes',
        'usedBytes',
        'reservedBytes',
      ]) ||
      !Object.values(value.quota).every(isSafeNonNegativeInteger)
    ) {
      return null;
    }
    return value;
  }
  if (expectedView === 'playback') {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'view',
        'roomCode',
        'revision',
        'playlistRevision',
        'state',
        'queueItemId',
        'positionSeconds',
        'observedAtMs',
        'item',
      ]) ||
      !isSafeNonNegativeInteger(value.revision) ||
      !isSafeNonNegativeInteger(value.playlistRevision) ||
      !['idle', 'playing', 'paused'].includes(value.state) ||
      !isFiniteNonNegative(value.positionSeconds) ||
      !isSafeNonNegativeInteger(value.observedAtMs) ||
      (value.queueItemId !== null &&
        (typeof value.queueItemId !== 'string' ||
          !/^[A-Za-z0-9_-]{16,128}$/.test(value.queueItemId))) ||
      (value.item !== null && !validQueueItem(value.item)) ||
      (value.item === null) !== (value.queueItemId === null) ||
      (value.item && value.item.queueItemId !== value.queueItemId) ||
      (value.state === 'idle' &&
        (value.queueItemId !== null || value.item !== null || value.positionSeconds !== 0)) ||
      (value.state !== 'idle' && (value.queueItemId === null || value.item === null))
    ) {
      return null;
    }
    return value;
  }
  if (expectedView === 'queue') {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'view',
        'roomCode',
        'playlistRevision',
        'currentQueueItemId',
        'items',
      ]) ||
      !isSafeNonNegativeInteger(value.playlistRevision) ||
      (value.currentQueueItemId !== null &&
        (typeof value.currentQueueItemId !== 'string' ||
          !/^[A-Za-z0-9_-]{16,128}$/.test(value.currentQueueItemId))) ||
      !Array.isArray(value.items) ||
      value.items.length > 1_000 ||
      !value.items.every(validQueueItem) ||
      new Set(value.items.map((item) => item.queueItemId)).size !== value.items.length ||
      (value.currentQueueItemId !== null &&
        !value.items.some((item) => item.queueItemId === value.currentQueueItemId))
    ) {
      return null;
    }
    return value;
  }
  return null;
}

function parseRoute(url) {
  const match = url.pathname.match(/^\/v1\/rooms\/(0\d{5})(?:\/(playback|queue))?$/);
  if (!match) return null;
  const view = match[2] || 'room';
  return {
    roomCode: match[1],
    view,
    requiredScope:
      view === 'room'
        ? SCOPE_ROOM_READ
        : view === 'playback'
          ? SCOPE_PLAYBACK_READ
          : SCOPE_QUEUE_READ,
  };
}

async function callLimiter(env, objectName, operation, keyId = null) {
  const namespace = env.DEVELOPER_API_LIMITERS;
  if (!namespace?.idFromName || !namespace?.get) return null;
  try {
    const stub = namespace.get(namespace.idFromName(objectName));
    const response = await stub.fetch('https://developer-api-rate.internal/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation, ...(keyId === null ? {} : { keyId }) }),
    });
    const value = await readJsonLimited(response, RATE_REQUEST_MAX_BYTES);
    if (
      response.status !== 200 ||
      !hasExactKeys(value, ['allowed', 'limit', 'remaining', 'resetAtMs', 'retryAfterSeconds']) ||
      typeof value.allowed !== 'boolean' ||
      !Number.isSafeInteger(value.limit) ||
      !Number.isSafeInteger(value.remaining) ||
      !Number.isSafeInteger(value.resetAtMs) ||
      !Number.isSafeInteger(value.retryAfterSeconds)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function rateHeaders(result) {
  return {
    'ratelimit-limit': String(result.limit),
    'ratelimit-remaining': String(Math.max(0, result.remaining)),
    'ratelimit-reset': String(Math.max(0, Math.ceil((result.resetAtMs - Date.now()) / 1_000))),
  };
}

async function ingressLimit(request, env) {
  const secret = String(env.MXQR_DEVELOPER_API_RATE_SECRET || '');
  if (secret.length < 32) return null;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipHash = await hmacBase64Url(secret, `developer-api-ingress:v1\u0000${ip}`);
  return callLimiter(env, `ingress:${ipHash}`, 'ingress-read');
}

async function authenticatedReadLimit(env, principal) {
  return callLimiter(
    env,
    `room:${principal.roomCode}`,
    'authenticated-read',
    principal.keyId,
  );
}

async function facadeRead(env, route) {
  if (!env.DEVELOPER_API_FACADE?.fetch) return { configurationError: true };
  let response;
  try {
    response = await env.DEVELOPER_API_FACADE.fetch(
      'https://developer-api-facade.internal/internal/v1/read',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomCode: route.roomCode, projection: route.view }),
      },
    );
  } catch {
    return { backendError: true };
  }
  const value = await readJsonLimited(response, FACADE_RESPONSE_MAX_BYTES);
  if (!response.ok) {
    return response.status === 404 ? { notFound: true } : { backendError: true };
  }
  const payload = validateFacadePayload(value, route.view, route.roomCode);
  return payload ? { payload } : { invalidResponse: true };
}

async function etagFor(view, payload) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(payload))),
  );
  return `"mxqr-${view}-${base64UrlEncode(digest)}"`;
}

async function handleApiRequest(request, env, context, requestId) {
  const mode = configuredMode(env);
  if (mode === 'off') return errorResponse('API_DISABLED', 503, requestId, { retryable: true });
  if (request.headers.has('origin')) {
    return errorResponse('BROWSER_ORIGIN_FORBIDDEN', 403, requestId);
  }
  if (request.method !== 'GET') return errorResponse('NOT_FOUND', 404, requestId);
  const url = new URL(request.url);
  if (
    encoder.encode(request.url).byteLength > URL_MAX_BYTES ||
    url.search ||
    url.hash ||
    request.body
  ) {
    return errorResponse('NOT_FOUND', 404, requestId);
  }
  const route = parseRoute(url);
  if (!route) return errorResponse('NOT_FOUND', 404, requestId);

  const ingress = await ingressLimit(request, env);
  if (!ingress) return errorResponse('API_NOT_CONFIGURED', 503, requestId, { retryable: true });
  if (!ingress.allowed) {
    return errorResponse('RATE_LIMITED', 429, requestId, {
      retryable: true,
      headers: {
        ...rateHeaders(ingress),
        'retry-after': String(Math.max(1, ingress.retryAfterSeconds)),
      },
    });
  }

  const nowMs = Date.now();
  const authentication = await authenticate(request, env, context, nowMs);
  if (authentication.configurationError) {
    return errorResponse('API_NOT_CONFIGURED', 503, requestId, { retryable: true });
  }
  if (authentication.backendError) {
    return errorResponse('BACKEND_UNAVAILABLE', 503, requestId, { retryable: true });
  }
  if (!authentication.principal) return errorResponse('UNAUTHORIZED', 401, requestId);
  const principal = authentication.principal;
  const limiter = await authenticatedReadLimit(env, principal);
  if (!limiter) return errorResponse('BACKEND_UNAVAILABLE', 503, requestId, { retryable: true });
  const limiterHeaders = rateHeaders(limiter);
  if (!limiter.allowed) {
    return errorResponse('RATE_LIMITED', 429, requestId, {
      retryable: true,
      headers: {
        ...limiterHeaders,
        'retry-after': String(Math.max(1, limiter.retryAfterSeconds)),
      },
    });
  }
  if (principal.roomCode !== route.roomCode) return errorResponse('NOT_FOUND', 404, requestId);
  if (mode === 'canary' && !configuredCanaryRooms(env).has(route.roomCode)) {
    return errorResponse('NOT_FOUND', 404, requestId);
  }
  if ((principal.scopeMask & route.requiredScope) !== route.requiredScope) {
    return errorResponse('FORBIDDEN', 403, requestId);
  }

  const facade = await facadeRead(env, route);
  if (facade.configurationError) {
    return errorResponse('API_NOT_CONFIGURED', 503, requestId, { retryable: true });
  }
  if (facade.notFound) return errorResponse('NOT_FOUND', 404, requestId);
  if (facade.backendError) {
    return errorResponse('BACKEND_UNAVAILABLE', 503, requestId, { retryable: true });
  }
  if (!facade.payload) {
    return errorResponse('INTERNAL_RESPONSE_INVALID', 503, requestId, { retryable: true });
  }

  const etag = await etagFor(route.view, facade.payload);
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch !== null && encoder.encode(ifNoneMatch).byteLength > ETAG_HEADER_MAX_BYTES) {
    return errorResponse('NOT_FOUND', 404, requestId);
  }
  if (ifNoneMatch === etag || ifNoneMatch === '*') {
    return emptyResponse(304, requestId, { ...limiterHeaders, etag });
  }
  return jsonResponse(
    facade.payload,
    200,
    requestId,
    { ...limiterHeaders, etag },
    'private, no-cache',
  );
}

export default {
  async fetch(request, env, context = {}) {
    const requestId = randomRequestId();
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health' && !url.search && !url.hash) {
      const workerVersionId = env?.CF_VERSION_METADATA?.id;
      return jsonResponse(
        {
          ok: true,
          service: 'musixquare-developer-api',
          ...(typeof workerVersionId === 'string' && workerVersionId
            ? { workerVersionId }
            : {}),
        },
        200,
        requestId,
      );
    }
    try {
      return await handleApiRequest(request, env, context, requestId);
    } catch {
      return errorResponse('BACKEND_UNAVAILABLE', 503, requestId, { retryable: true });
    }
  },
};

async function readRateRequest(request) {
  if (
    request.method !== 'POST' ||
    new URL(request.url).pathname !== '/check' ||
    !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') ||
    !request.body
  ) {
    return null;
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > RATE_REQUEST_MAX_BYTES)) {
    return null;
  }
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > RATE_REQUEST_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
}

function rateBucketsForRequest(value) {
  if (hasExactKeys(value, ['operation']) && value.operation === 'ingress-read') {
    return [
      { id: 'ingress', limit: INGRESS_LIMIT_PER_MINUTE, windowMs: 60_000, cost: 1 },
    ];
  }
  if (
    hasExactKeys(value, ['operation', 'keyId']) &&
    value.operation === 'authenticated-read' &&
    typeof value.keyId === 'string' &&
    /^[A-Za-z0-9_-]{16}$/.test(value.keyId)
  ) {
    return [
      {
        id: `key:${value.keyId}:read`,
        limit: KEY_READ_LIMIT_PER_MINUTE,
        windowMs: 60_000,
        cost: 1,
      },
      { id: 'room:read', limit: ROOM_READ_LIMIT_PER_MINUTE, windowMs: 60_000, cost: 1 },
    ];
  }
  return null;
}

export class DeveloperApiRateLimiter {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const body = await readRateRequest(request);
    const requested = rateBucketsForRequest(body);
    if (!requested) return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    const nowMs = Date.now();
    const stored = (await this.storage.get('buckets')) || {};
    for (const [id, bucket] of Object.entries(stored)) {
      if (!bucket || !Number.isSafeInteger(bucket.resetAtMs) || bucket.resetAtMs <= nowMs) {
        delete stored[id];
      }
    }
    const evaluated = requested.map((requestBucket) => {
      const windowStartMs = Math.floor(nowMs / requestBucket.windowMs) * requestBucket.windowMs;
      const resetAtMs = windowStartMs + requestBucket.windowMs;
      const current = stored[requestBucket.id];
      const count =
        current && current.windowStartMs === windowStartMs && current.limit === requestBucket.limit
          ? current.count
          : 0;
      return { ...requestBucket, windowStartMs, resetAtMs, count };
    });
    const blocked = evaluated.filter((bucket) => bucket.count + bucket.cost > bucket.limit);
    if (blocked.length > 0) {
      const retryAtMs = Math.max(...blocked.map((bucket) => bucket.resetAtMs));
      const narrowest = blocked.sort((left, right) => left.limit - right.limit)[0];
      return Response.json({
        allowed: false,
        limit: narrowest.limit,
        remaining: Math.max(0, narrowest.limit - narrowest.count),
        resetAtMs: retryAtMs,
        retryAfterSeconds: Math.max(1, Math.ceil((retryAtMs - nowMs) / 1_000)),
      });
    }
    for (const bucket of evaluated) {
      stored[bucket.id] = {
        limit: bucket.limit,
        count: bucket.count + bucket.cost,
        windowStartMs: bucket.windowStartMs,
        resetAtMs: bucket.resetAtMs,
      };
    }
    if (Object.keys(stored).length > RATE_STATE_MAX_ITEMS) {
      return Response.json({ error: 'RATE_STATE_CAPACITY_EXCEEDED' }, { status: 503 });
    }
    await this.storage.put('buckets', stored);
    if (typeof this.storage.setAlarm === 'function') {
      await this.storage.setAlarm(Math.min(...evaluated.map((bucket) => bucket.resetAtMs)));
    }
    const narrowest = evaluated.sort((left, right) => left.limit - right.limit)[0];
    return Response.json({
      allowed: true,
      limit: narrowest.limit,
      remaining: Math.max(0, narrowest.limit - narrowest.count - narrowest.cost),
      resetAtMs: narrowest.resetAtMs,
      retryAfterSeconds: 0,
    });
  }

  async alarm() {
    const nowMs = Date.now();
    const stored = (await this.storage.get('buckets')) || {};
    for (const [id, bucket] of Object.entries(stored)) {
      if (!bucket || !Number.isSafeInteger(bucket.resetAtMs) || bucket.resetAtMs <= nowMs) {
        delete stored[id];
      }
    }
    const remaining = Object.values(stored);
    if (remaining.length === 0) {
      if (typeof this.storage.deleteAll === 'function') await this.storage.deleteAll();
      if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
      return;
    }
    await this.storage.put('buckets', stored);
    if (typeof this.storage.setAlarm === 'function') {
      await this.storage.setAlarm(Math.min(...remaining.map((bucket) => bucket.resetAtMs)));
    }
  }
}

export const developerApiScopes = Object.freeze({
  'room:read': SCOPE_ROOM_READ,
  'playback:read': SCOPE_PLAYBACK_READ,
  'playback:control': SCOPE_PLAYBACK_CONTROL,
  'queue:read': SCOPE_QUEUE_READ,
  'queue:write': SCOPE_QUEUE_WRITE,
  'media:upload': SCOPE_MEDIA_UPLOAD,
});

export function isDeveloperApiRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}
