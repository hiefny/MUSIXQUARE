/**
 * MUSIXQUARE persistent PRO room service.
 *
 * The public bootstrap endpoint intentionally exposes only room status. Owner
 * claim credentials are issued offline with `issueProRoomActivationClaim` and
 * are never returned by this Worker. Persistent room state is serialized by a
 * per-room Durable Object; private media bytes live in a dedicated R2 bucket.
 */

const ROOM_CODES = new Set(['000000', '000001']);
const PIN_RE = /^\d{8}$/;
const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const SHA256_RE = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const SCHEMA_VERSION = 1;
const STORAGE_KEY = 'pro-room:v1';
const ROOM_QUOTA_BYTES = 1024 * 1024 * 1024;
const ASSET_MAX_BYTES = 200 * 1024 * 1024;
const PLAYLIST_MAX_ITEMS = 1000;
const PRESENCE_MAX_ITEMS = 256;
const REQUEST_MAX_BYTES = 4 * 1024 * 1024;
const SMALL_REQUEST_MAX_BYTES = 16 * 1024;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const PRESENCE_TTL_SECONDS = 45;
const RESERVATION_TTL_SECONDS = 15 * 60;
const PRESIGN_TTL_SECONDS = 10 * 60;
const SIGNALING_TICKET_TTL_SECONDS = 90;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 210_000;
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_MEDIA_NAME_LENGTH = 2048;
const MAX_TEXT_LENGTH = 2048;
const SESSION_COOKIE = '__Host-mxqr_pro_session';
const OWNER_COOKIE = '__Host-mxqr_pro_owner';
const OWNER_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

const OWNER_CAPABILITIES = [
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'coordinator.eligible',
  'members.manage',
  'room.configure',
];
const CONTROLLER_CAPABILITIES = OWNER_CAPABILITIES.slice(0, 5);

const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://musixquare.com',
  'https://www.musixquare.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function configuredNumber(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function configuredRoomCodes(env) {
  const configured = String(env.PRO_ROOM_CODES || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => ROOM_CODES.has(value));
  return new Set(configured.length > 0 ? configured : ROOM_CODES);
}

function configuredAllowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length > 0 ? new Set(configured) : DEFAULT_ALLOWED_ORIGINS;
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('origin') || '';
  return configuredAllowedOrigins(env).has(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,idempotency-key,authorization',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...extraHeaders,
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function errorResponse(error, status, extraHeaders = {}) {
  return jsonResponse({ error }, status, extraHeaders);
}

function withPublicHeaders(response, origin) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  for (const [name, value] of Object.entries(corsHeaders(origin))) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function hasExactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function boundedString(value, maxLength, allowEmpty = false) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  if ((!allowEmpty && result.length === 0) || result.length > maxLength) return null;
  return result;
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomToken(bytes = 24) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64UrlEncode(value);
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

async function sha256Bytes(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function sha256Base64Url(value) {
  return base64UrlEncode(await sha256Bytes(value));
}

async function hmacBytes(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    typeof secret === 'string' ? encoder.encode(secret) : secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      typeof value === 'string' ? encoder.encode(value) : value,
    ),
  );
}

async function hmacBase64Url(secret, value) {
  return base64UrlEncode(await hmacBytes(secret, value));
}

async function createSignedToken(payload, secret) {
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `v1.${encoded}.${await hmacBase64Url(secret, `v1.${encoded}`)}`;
}

async function createProSignalingTicket(payload, secret) {
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmacBase64Url(secret, encoded)}`;
}

async function verifySignedToken(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null;
    const expected = await hmacBase64Url(secret, `${parts[0]}.${parts[1]}`);
    if (!constantTimeEqual(expected, parts[2])) return null;
    return JSON.parse(decoder.decode(base64UrlDecode(parts[1])));
  } catch {
    return null;
  }
}

async function createOpaqueCredential(secret) {
  const random = randomToken(32);
  return `v1.${random}.${await hmacBase64Url(secret, `v1.${random}`)}`;
}

async function verifyOpaqueCredential(token, secret) {
  if (!token || typeof secret !== 'string' || secret.length < 32) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return false;
  return constantTimeEqual(await hmacBase64Url(secret, `${parts[0]}.${parts[1]}`), parts[2]);
}

/**
 * Offline owner-claim issuer. Call from an operator-only script/console; there
 * is deliberately no HTTP route that invokes this helper.
 */
export async function issueProRoomActivationClaim(roomCode, secret, options = {}) {
  if (!ROOM_CODES.has(roomCode)) throw new Error('Unsupported PRO room code');
  if (typeof secret !== 'string' || secret.length < 32)
    throw new Error('Activation secret too short');
  const nowMs = options.nowMs ?? Date.now();
  const expiresAtMs = options.expiresAtMs ?? nowMs + 7 * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) throw new Error('Invalid expiry');
  const nonce = options.nonce ?? randomToken(18);
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new Error('Invalid nonce');
  }
  return createSignedToken(
    {
      v: 1,
      purpose: 'pro-room-activation',
      roomCode,
      iat: nowMs,
      exp: expiresAtMs,
      nonce,
    },
    secret,
  );
}

async function verifyActivationClaim(token, roomCode, secret, nowMs) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const payload = await verifySignedToken(token, secret);
  return !!(
    payload &&
    payload.v === 1 &&
    payload.purpose === 'pro-room-activation' &&
    payload.roomCode === roomCode &&
    Number.isSafeInteger(payload.iat) &&
    payload.iat <= nowMs + 60_000 &&
    Number.isSafeInteger(payload.exp) &&
    payload.exp > nowMs &&
    typeof payload.nonce === 'string' &&
    payload.nonce.length >= 16
  );
}

async function derivePinHash(pin, salt, pepper, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${pin}\u0000${pepper}`),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return base64UrlEncode(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: base64UrlDecode(salt), iterations },
        material,
        256,
      ),
    ),
  );
}

async function createPinRecord(pin, pepper) {
  const salt = randomToken(16);
  return { salt, iterations: PBKDF2_ITERATIONS, hash: await derivePinHash(pin, salt, pepper) };
}

async function verifyPin(pin, record, pepper) {
  if (!record || typeof pepper !== 'string' || pepper.length < 32) return false;
  const actual = await derivePinHash(pin, record.salt, pepper, record.iterations);
  return constantTimeEqual(actual, record.hash);
}

async function readJsonBody(request, maxBytes) {
  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) return { error: 'INVALID_REQUEST' };
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    return { error: 'REQUEST_TOO_LARGE', status: 413 };
  }
  if (!request.body) return { error: 'INVALID_REQUEST' };
  const reader = request.body.getReader();
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
        return { error: 'REQUEST_TOO_LARGE', status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { error: 'INVALID_REQUEST' };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return { error: 'INVALID_REQUEST' };
  }
}

function cookieValue(request, name) {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

function requestSessionToken(request) {
  const authorization = request.headers.get('authorization') || '';
  const bearer = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return bearer ? bearer[1] : cookieValue(request, SESSION_COOKIE);
}

function requestOwnerToken(request) {
  return cookieValue(request, OWNER_COOKIE);
}

function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function ownerCookie(token) {
  return `${OWNER_COOKIE}=${token}; Path=/; Max-Age=${OWNER_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function initialRoomState(roomCode) {
  return {
    v: 1,
    roomCode,
    status: 'unactivated',
    runtime: 'sleeping',
    revision: 0,
    playlistRevision: 0,
    playlist: [],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 0,
      revision: 0,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      updatedAtMs: 0,
    },
    presence: {
      coordinatorEpoch: 0,
      revision: 0,
      coordinatorParticipantId: null,
      participants: {},
    },
    quota: {
      limitBytes: ROOM_QUOTA_BYTES,
      perAssetLimitBytes: ASSET_MAX_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    pin: null,
    authEpoch: 0,
    ownerMemberId: null,
    ownerCredentialHash: null,
    sessions: {},
    assets: {},
    idempotency: {},
    rateLimits: {},
  };
}

function publicAsset(asset) {
  return {
    kind: 'pro-r2',
    assetId: asset.assetId,
    version: asset.version,
    byteLength: asset.byteLength,
    mime: asset.mime,
    ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
  };
}

function publicSnapshot(room, session = null) {
  const participants = Object.values(room.presence.participants)
    .sort(
      (left, right) =>
        left.joinedAtMs - right.joinedAtMs || left.participantId.localeCompare(right.participantId),
    )
    .map(({ participantId, displayName, role, joinedAtMs }) => ({
      participantId,
      displayName,
      role,
      joinedAtMs,
    }));
  const participant = session ? room.presence.participants[session.participantId] : null;
  const viewer = session
    ? {
        memberId: session.memberId,
        participantId: session.participantId,
        displayName: session.displayName,
        role: session.role,
        capabilities:
          room.status === 'active'
            ? [...(session.role === 'owner' ? OWNER_CAPABILITIES : CONTROLLER_CAPABILITIES)]
            : [],
        coordinatorEligible: room.status === 'active',
      }
    : null;
  // An awake snapshot may only advertise a viewer currently in presence.
  const safeViewer = room.runtime === 'awake' && !participant ? null : viewer;
  return {
    schemaVersion: SCHEMA_VERSION,
    roomCode: room.roomCode,
    status: room.status,
    runtime: room.runtime,
    revision: room.revision,
    playlistRevision: room.playlistRevision,
    playlist: structuredClone(room.playlist),
    currentQueueItemId: room.currentQueueItemId,
    playback: structuredClone(room.playback),
    presence: {
      coordinatorEpoch: room.presence.coordinatorEpoch,
      revision: room.presence.revision,
      coordinatorParticipantId: room.presence.coordinatorParticipantId,
      participants,
    },
    quota: { ...room.quota },
    viewer: safeViewer,
  };
}

function parsePlaylistItem(value) {
  if (!hasExactKeys(value, ['queueItemId', 'source', 'name'], ['title', 'artist', 'thumbnail']))
    return null;
  if (!QUEUE_ITEM_ID_RE.test(value.queueItemId)) return null;
  const name = boundedString(value.name, MAX_TEXT_LENGTH);
  if (!name) return null;
  const optional = {};
  for (const key of ['title', 'artist', 'thumbnail']) {
    if (value[key] !== undefined) {
      if (
        typeof value[key] !== 'string' ||
        value[key].length === 0 ||
        value[key].length > MAX_TEXT_LENGTH
      )
        return null;
      optional[key] = value[key];
    }
  }
  const source = value.source;
  if (hasExactKeys(source, ['kind', 'videoId'], ['playlistId']) && source.kind === 'youtube') {
    if (!YOUTUBE_VIDEO_ID_RE.test(source.videoId)) return null;
    if (source.playlistId !== undefined && !YOUTUBE_PLAYLIST_ID_RE.test(source.playlistId))
      return null;
    return {
      queueItemId: value.queueItemId,
      name: value.name,
      ...optional,
      source: {
        kind: 'youtube',
        videoId: source.videoId,
        ...(source.playlistId === undefined ? {} : { playlistId: source.playlistId }),
      },
    };
  }
  if (
    hasExactKeys(source, ['kind', 'assetId', 'version', 'byteLength', 'mime'], ['sha256']) &&
    source.kind === 'pro-r2'
  ) {
    if (
      !OPAQUE_ID_RE.test(source.assetId) ||
      !Number.isSafeInteger(source.version) ||
      source.version <= 0 ||
      !Number.isSafeInteger(source.byteLength) ||
      source.byteLength <= 0 ||
      source.byteLength > ASSET_MAX_BYTES ||
      !MIME_RE.test(source.mime) ||
      (source.sha256 !== undefined && !SHA256_RE.test(source.sha256))
    ) {
      return null;
    }
    return {
      queueItemId: value.queueItemId,
      name: value.name,
      ...optional,
      source: {
        kind: 'pro-r2',
        assetId: source.assetId,
        version: source.version,
        byteLength: source.byteLength,
        mime: source.mime,
        ...(source.sha256 === undefined ? {} : { sha256: source.sha256 }),
      },
    };
  }
  return null;
}

function parsePlaylist(value) {
  if (!Array.isArray(value) || value.length > PLAYLIST_MAX_ITEMS) return null;
  const result = [];
  const ids = new Set();
  for (const raw of value) {
    const item = parsePlaylistItem(raw);
    if (!item || ids.has(item.queueItemId)) return null;
    ids.add(item.queueItemId);
    result.push(item);
  }
  return result;
}

function parsePlayback(value, queueIds, currentQueueItemId, coordinatorEpoch) {
  if (
    !hasExactKeys(value, [
      'coordinatorEpoch',
      'revision',
      'state',
      'queueItemId',
      'positionSeconds',
      'updatedAtMs',
    ]) ||
    value.coordinatorEpoch !== coordinatorEpoch ||
    !isSafeNonNegativeInteger(value.revision) ||
    typeof value.positionSeconds !== 'number' ||
    !Number.isFinite(value.positionSeconds) ||
    value.positionSeconds < 0 ||
    !isSafeNonNegativeInteger(value.updatedAtMs)
  ) {
    return null;
  }
  if (value.state === 'idle') {
    if (value.queueItemId !== null || currentQueueItemId !== null || value.positionSeconds !== 0)
      return null;
  } else {
    if (
      (value.state !== 'playing' && value.state !== 'paused') ||
      !QUEUE_ITEM_ID_RE.test(value.queueItemId) ||
      value.queueItemId !== currentQueueItemId ||
      !queueIds.has(value.queueItemId)
    ) {
      return null;
    }
  }
  return structuredClone(value);
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  return hex(await sha256Bytes(value));
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeObjectPath(path) {
  return path.split('/').map(awsEncode).join('/');
}

function canonicalQuery(parameters) {
  return [...parameters]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join('&');
}

function amzDateParts(now) {
  const value = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: value, dateStamp: value.slice(0, 8) };
}

function r2S3Config(env) {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucketName = String(env.R2_BUCKET_NAME || 'musixquare-pro-media').trim();
  return accountId && accessKeyId && secretAccessKey && bucketName
    ? { accountId, accessKeyId, secretAccessKey, bucketName }
    : null;
}

async function createR2PresignedUrl({
  env,
  method,
  objectKey,
  headers = {},
  expiresInSeconds,
  now,
}) {
  const config = r2S3Config(env);
  if (!config) return null;
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = amzDateParts(now);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const canonicalUri = `/${awsEncode(config.bucketName)}/${encodeObjectPath(objectKey)}`;
  const normalizedHeaders = { ...headers, host };
  const signedHeaderNames = Object.keys(normalizedHeaders)
    .map((name) => name.toLowerCase())
    .sort();
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(normalizedHeaders[name]).trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const queryParameters = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
    ['X-Amz-Credential', `${config.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresInSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ];
  const query = canonicalQuery(queryParameters);
  const canonicalRequest = [
    method,
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join(
    '\n',
  );
  const dateKey = await hmacBytes(encoder.encode(`AWS4${config.secretAccessKey}`), dateStamp);
  const regionKey = await hmacBytes(dateKey, 'auto');
  const serviceKey = await hmacBytes(regionKey, 's3');
  const signingKey = await hmacBytes(serviceKey, 'aws4_request');
  const signature = hex(await hmacBytes(signingKey, stringToSign));
  return `https://${host}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ ok: true, service: 'musixquare-pro-room' });
    }
    const origin = allowedOrigin(request, env);
    if (request.method === 'OPTIONS') {
      return origin
        ? new Response(null, {
            status: 204,
            headers: { ...SECURITY_HEADERS, ...corsHeaders(origin) },
          })
        : errorResponse('FORBIDDEN_ORIGIN', 403);
    }
    if (!origin) return errorResponse('FORBIDDEN_ORIGIN', 403);
    if (url.search || url.hash || request.url.length > 8192) {
      return withPublicHeaders(errorResponse('INVALID_REQUEST', 400), origin);
    }
    const match = url.pathname.match(/^\/v1\/rooms\/(\d{6})(?:\/|$)/);
    if (!match || !configuredRoomCodes(env).has(match[1])) {
      return withPublicHeaders(errorResponse('ROOM_NOT_FOUND', 404), origin);
    }
    if (!env.PRO_ROOMS || typeof env.PRO_ROOMS.idFromName !== 'function') {
      return withPublicHeaders(errorResponse('SERVICE_NOT_CONFIGURED', 503), origin);
    }
    const rateSecret = String(env.PRO_ROOM_RATE_LIMIT_SECRET || env.PRO_ROOM_SESSION_SECRET || '');
    if (rateSecret.length < 32) {
      return withPublicHeaders(errorResponse('SERVICE_NOT_CONFIGURED', 503), origin);
    }
    const rawIp =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      'unknown';
    const ipHash = await hmacBase64Url(rateSecret, `pro-room-rate:${rawIp}`);
    const headers = new Headers(request.headers);
    headers.set('x-mxqr-pro-room-code', match[1]);
    headers.set('x-mxqr-pro-ip-hash', ipHash);
    headers.delete('cf-connecting-ip');
    headers.delete('x-forwarded-for');
    const stub = env.PRO_ROOMS.get(env.PRO_ROOMS.idFromName(match[1]));
    const response = await stub.fetch(new Request(request, { headers }));
    return withPublicHeaders(response, origin);
  },
};

export class MusixquareProRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.room = null;
    this.mutationTail = Promise.resolve();
    const load = async () => {
      this.room = (await this.storage.get(STORAGE_KEY)) || null;
    };
    if (typeof state.blockConcurrencyWhile === 'function') state.blockConcurrencyWhile(load);
    else this.ready = load();
  }

  async ensureReady(request) {
    if (this.ready) await this.ready;
    const roomCode =
      request.headers.get('x-mxqr-pro-room-code') ||
      new URL(request.url).pathname.split('/')[3] ||
      '';
    if (!ROOM_CODES.has(roomCode)) return false;
    if (!this.room) this.room = initialRoomState(roomCode);
    return this.room.roomCode === roomCode;
  }

  async withMutation(callback) {
    let release;
    const previous = this.mutationTail;
    this.mutationTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async persist() {
    await this.storage.put(STORAGE_KEY, this.room);
    await this.scheduleAlarm();
  }

  async scheduleAlarm() {
    if (typeof this.storage.setAlarm !== 'function') return;
    const candidates = [];
    for (const session of Object.values(this.room.sessions)) candidates.push(session.expiresAtMs);
    for (const participant of Object.values(this.room.presence.participants)) {
      candidates.push(participant.lastSeenAtMs + this.presenceTtlMs());
    }
    for (const asset of Object.values(this.room.assets)) {
      if (asset.status === 'reserved') candidates.push(asset.expiresAtMs);
    }
    const next = candidates
      .filter((value) => Number.isSafeInteger(value) && value > Date.now())
      .sort((a, b) => a - b)[0];
    if (next) await this.storage.setAlarm(next);
    else if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
  }

  presenceTtlMs() {
    return configuredNumber(this.env.PRESENCE_TTL_SECONDS, PRESENCE_TTL_SECONDS, 15, 300) * 1000;
  }

  sessionTtlSeconds() {
    return configuredNumber(
      this.env.SESSION_TTL_SECONDS,
      SESSION_TTL_SECONDS,
      300,
      90 * 24 * 60 * 60,
    );
  }

  reservationTtlSeconds() {
    return configuredNumber(this.env.RESERVATION_TTL_SECONDS, RESERVATION_TTL_SECONDS, 60, 3600);
  }

  async fetch(request) {
    if (!(await this.ensureReady(request))) return errorResponse('ROOM_NOT_FOUND', 404);
    const url = new URL(request.url);
    const prefix = `/v1/rooms/${this.room.roomCode}`;
    if (!url.pathname.startsWith(`${prefix}/`)) return errorResponse('ROOM_NOT_FOUND', 404);
    if (request.method === 'GET' && url.pathname === `${prefix}/bootstrap`) {
      return this.handleBootstrap();
    }
    return this.withMutation(async () => {
      await this.prune(Date.now());
      if (request.method === 'POST' && url.pathname === `${prefix}/activation`)
        return this.handleActivation(request);
      if (request.method === 'POST' && url.pathname === `${prefix}/sessions`)
        return this.handleCreateSession(request);
      if (request.method === 'GET' && url.pathname === `${prefix}/snapshot`)
        return this.handleGetSnapshot(request);
      if (request.method === 'DELETE' && url.pathname === `${prefix}/sessions/current`)
        return this.handleCloseSession(request);
      if (request.method === 'POST' && url.pathname === `${prefix}/pin`)
        return this.handleChangePin(request);
      if (request.method === 'POST' && url.pathname === `${prefix}/presence/heartbeat`)
        return this.handleHeartbeat(request);
      if (request.method === 'DELETE' && url.pathname === `${prefix}/presence/current`)
        return this.handleLeavePresence(request);
      if (request.method === 'POST' && url.pathname === `${prefix}/signaling-tickets`)
        return this.handleSignalingTicket(request);
      if (request.method === 'PUT' && url.pathname === `${prefix}/snapshot`)
        return this.handleUpdateSnapshot(request);
      if (request.method === 'POST' && url.pathname === `${prefix}/media/reservations`)
        return this.handleCreateReservation(request);
      const complete = url.pathname.match(
        new RegExp(`^${prefix}/media/([A-Za-z0-9_-]{16,128})/complete$`),
      );
      if (request.method === 'POST' && complete)
        return this.handleCompleteMedia(request, complete[1]);
      const download = url.pathname.match(
        new RegExp(`^${prefix}/media/([A-Za-z0-9_-]{16,128})/download$`),
      );
      if (request.method === 'GET' && download)
        return this.handleDownloadMedia(request, download[1]);
      const media = url.pathname.match(new RegExp(`^${prefix}/media/([A-Za-z0-9_-]{16,128})$`));
      if (request.method === 'DELETE' && media) return this.handleDeleteMedia(request, media[1]);
      return errorResponse('NOT_FOUND', 404);
    });
  }

  handleBootstrap() {
    const status =
      this.room.status === 'unactivated'
        ? 'activation_required'
        : this.room.status === 'suspended'
          ? 'suspended'
          : 'pin_required';
    return jsonResponse({ roomCode: this.room.roomCode, status });
  }

  async parseBody(request, maxBytes = SMALL_REQUEST_MAX_BYTES) {
    const parsed = await readJsonBody(request, maxBytes);
    return parsed.error
      ? { response: errorResponse(parsed.error, parsed.status || 400) }
      : { value: parsed.value };
  }

  async applyRateLimit(request, kind, limit, windowMs) {
    const ipHash = request.headers.get('x-mxqr-pro-ip-hash') || 'internal-test';
    const now = Date.now();
    const key = `${kind}:${ipHash}`;
    const current = this.room.rateLimits[key];
    if (!current || current.resetAtMs <= now) {
      this.room.rateLimits[key] = { count: 1, resetAtMs: now + windowMs };
      await this.storage.put(STORAGE_KEY, this.room);
      return null;
    }
    if (current.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAtMs - now) / 1000));
      return errorResponse('RATE_LIMITED', 429, { 'retry-after': String(retryAfterSeconds) });
    }
    current.count += 1;
    await this.storage.put(STORAGE_KEY, this.room);
    return null;
  }

  async createSessionRecord(role, displayName, nowMs, memberId = null) {
    const secret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    if (secret.length < 32) return null;
    const token = await createOpaqueCredential(secret);
    const tokenHash = await sha256Base64Url(token);
    const session = {
      memberId:
        memberId || (role === 'owner' ? `owner_${randomToken(18)}` : `member_${randomToken(18)}`),
      participantId: `participant_${randomToken(18)}`,
      displayName,
      role,
      authEpoch: this.room.authEpoch,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.sessionTtlSeconds() * 1000,
    };
    this.room.sessions[tokenHash] = session;
    return { token, tokenHash, session };
  }

  async createOwnerCredential() {
    const secret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    if (secret.length < 32) return null;
    const token = await createOpaqueCredential(secret);
    return { token, hash: await sha256Base64Url(token) };
  }

  async hasOwnerCredential(request) {
    const token = requestOwnerToken(request);
    const secret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    if (!(await verifyOpaqueCredential(token, secret))) return false;
    const hash = await sha256Base64Url(token);
    return constantTimeEqual(hash, this.room.ownerCredentialHash || '');
  }

  async authenticate(request) {
    const token = requestSessionToken(request);
    const secret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    if (!token || secret.length < 32) return null;
    if (!(await verifyOpaqueCredential(token, secret))) return null;
    const tokenHash = await sha256Base64Url(token);
    const session = this.room.sessions[tokenHash];
    if (
      !session ||
      session.expiresAtMs <= Date.now() ||
      session.authEpoch !== this.room.authEpoch
    ) {
      if (session) delete this.room.sessions[tokenHash];
      return null;
    }
    return { tokenHash, session };
  }

  async requireSession(request, options = {}) {
    const auth = await this.authenticate(request);
    if (!auth) return { response: errorResponse('SESSION_REQUIRED', 401) };
    if (this.room.status === 'suspended') return { response: errorResponse('ROOM_SUSPENDED', 423) };
    if (options.owner && auth.session.role !== 'owner')
      return { response: errorResponse('OWNER_REQUIRED', 403) };
    return auth;
  }

  joinPresence(session, tokenHash, nowMs) {
    const existing = this.room.presence.participants[session.participantId];
    if (existing) {
      existing.lastSeenAtMs = nowMs;
      return false;
    }
    if (Object.keys(this.room.presence.participants).length >= PRESENCE_MAX_ITEMS) return null;
    const wasSleeping = this.room.runtime === 'sleeping';
    this.room.presence.participants[session.participantId] = {
      participantId: session.participantId,
      memberId: session.memberId,
      sessionHash: tokenHash,
      displayName: session.displayName,
      role: session.role,
      joinedAtMs: nowMs,
      lastSeenAtMs: nowMs,
    };
    this.room.runtime = 'awake';
    this.room.presence.revision += 1;
    if (!this.room.presence.coordinatorParticipantId) {
      this.room.presence.coordinatorParticipantId = session.participantId;
      this.bumpCoordinatorEpoch(nowMs, wasSleeping);
    }
    this.room.revision += 1;
    return true;
  }

  bumpCoordinatorEpoch(nowMs, waking = false) {
    this.room.presence.coordinatorEpoch += 1;
    this.room.playback.coordinatorEpoch = this.room.presence.coordinatorEpoch;
    this.room.playback.revision += 1;
    if (this.room.playback.state === 'playing' && waking) this.room.playback.updatedAtMs = nowMs;
  }

  freezePlayback(nowMs) {
    if (this.room.playback.state === 'playing' && this.room.playback.updatedAtMs > 0) {
      this.room.playback.positionSeconds += Math.max(
        0,
        (nowMs - this.room.playback.updatedAtMs) / 1000,
      );
      this.room.playback.updatedAtMs = nowMs;
      this.room.playback.revision += 1;
    }
  }

  removePresence(participantId, nowMs) {
    if (!this.room.presence.participants[participantId]) return false;
    const wasCoordinator = this.room.presence.coordinatorParticipantId === participantId;
    delete this.room.presence.participants[participantId];
    const remaining = Object.values(this.room.presence.participants).sort(
      (left, right) =>
        left.joinedAtMs - right.joinedAtMs || left.participantId.localeCompare(right.participantId),
    );
    this.room.presence.revision += 1;
    if (remaining.length === 0) {
      this.freezePlayback(nowMs);
      this.room.runtime = 'sleeping';
      this.room.presence.coordinatorParticipantId = null;
      if (wasCoordinator) this.bumpCoordinatorEpoch(nowMs);
    } else if (wasCoordinator) {
      this.room.presence.coordinatorParticipantId = remaining[0].participantId;
      this.bumpCoordinatorEpoch(nowMs);
    }
    this.room.revision += 1;
    return true;
  }

  async handleActivation(request) {
    if (this.room.status !== 'unactivated') return errorResponse('ACTIVATION_UNAVAILABLE', 409);
    const rateError = await this.applyRateLimit(request, 'activation', 10, 60 * 60 * 1000);
    if (rateError) return rateError;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!hasExactKeys(body, ['claimToken', 'temporaryPin', 'newPin'], ['ownerName'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const ownerName =
      body.ownerName === undefined
        ? 'Owner'
        : boundedString(body.ownerName, MAX_DISPLAY_NAME_LENGTH);
    if (!ownerName || !PIN_RE.test(body.newPin) || body.newPin === body.temporaryPin) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const activationSecret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    const pepper = String(this.env.PRO_ROOM_PIN_PEPPER || '');
    if (
      activationSecret.length < 32 ||
      pepper.length < 32 ||
      String(this.env.PRO_ROOM_SESSION_SECRET || '').length < 32
    ) {
      return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    }
    const nowMs = Date.now();
    const [claimValid] = await Promise.all([
      verifyActivationClaim(body.claimToken, this.room.roomCode, activationSecret, nowMs),
      // Always perform a digest for the temporary PIN branch so invalid claim
      // and invalid temporary PIN share one externally uniform failure path.
      sha256Bytes(String(body.temporaryPin || '')),
    ]);
    const expectedTemporaryPin = this.room.roomCode.padStart(8, '0');
    const temporaryPinValid =
      PIN_RE.test(body.temporaryPin) && constantTimeEqual(body.temporaryPin, expectedTemporaryPin);
    if (!claimValid || !temporaryPinValid) return errorResponse('ACTIVATION_INVALID', 401);

    const pin = await createPinRecord(body.newPin, pepper);
    this.room.status = 'active';
    this.room.authEpoch = 1;
    this.room.pin = pin;
    const ownerCredential = await this.createOwnerCredential();
    const created = await this.createSessionRecord('owner', ownerName, nowMs);
    if (!created || !ownerCredential) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    this.room.ownerMemberId = created.session.memberId;
    this.room.ownerCredentialHash = ownerCredential.hash;
    this.joinPresence(created.session, created.tokenHash, nowMs);
    await this.persist();
    const response = jsonResponse({ snapshot: publicSnapshot(this.room, created.session) }, 200, {
      'set-cookie': sessionCookie(created.token, this.sessionTtlSeconds()),
    });
    response.headers.append('set-cookie', ownerCookie(ownerCredential.token));
    return response;
  }

  async handleCreateSession(request) {
    if (this.room.status === 'unactivated') return errorResponse('ACTIVATION_REQUIRED', 409);
    if (this.room.status === 'suspended') return errorResponse('ROOM_SUSPENDED', 423);
    const rateError = await this.applyRateLimit(request, 'session', 30, 60 * 60 * 1000);
    if (rateError) return rateError;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!hasExactKeys(body, ['pin', 'displayName'])) return errorResponse('INVALID_REQUEST', 400);
    const displayName = boundedString(body.displayName, MAX_DISPLAY_NAME_LENGTH);
    if (!displayName || !PIN_RE.test(body.pin)) return errorResponse('INVALID_REQUEST', 400);
    const pepper = String(this.env.PRO_ROOM_PIN_PEPPER || '');
    if (pepper.length < 32 || String(this.env.PRO_ROOM_SESSION_SECRET || '').length < 32) {
      return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    }
    if (!(await verifyPin(body.pin, this.room.pin, pepper)))
      return errorResponse('PIN_INVALID', 401);
    const nowMs = Date.now();
    const role = (await this.hasOwnerCredential(request)) ? 'owner' : 'controller';
    const created = await this.createSessionRecord(
      role,
      displayName,
      nowMs,
      role === 'owner' ? this.room.ownerMemberId : null,
    );
    if (!created) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    if (this.joinPresence(created.session, created.tokenHash, nowMs) === null) {
      delete this.room.sessions[created.tokenHash];
      return errorResponse('ROOM_FULL', 409);
    }
    await this.persist();
    return jsonResponse(
      {
        snapshot: publicSnapshot(this.room, created.session),
        session: { expiresAtMs: created.session.expiresAtMs },
      },
      200,
      { 'set-cookie': sessionCookie(created.token, this.sessionTtlSeconds()) },
    );
  }

  async handleGetSnapshot(request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    if (!this.room.presence.participants[auth.session.participantId]) {
      const joined = this.joinPresence(auth.session, auth.tokenHash, Date.now());
      if (joined === null) return errorResponse('ROOM_FULL', 409);
      await this.persist();
    }
    return jsonResponse({ snapshot: publicSnapshot(this.room, auth.session) });
  }

  async handleCloseSession(request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    this.removePresence(auth.session.participantId, Date.now());
    delete this.room.sessions[auth.tokenHash];
    await this.persist();
    return jsonResponse({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
  }

  async handleChangePin(request) {
    const auth = await this.requireSession(request, { owner: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, ['pin']) || !PIN_RE.test(parsed.value.pin)) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const pepper = String(this.env.PRO_ROOM_PIN_PEPPER || '');
    if (pepper.length < 32) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    const nextPin = await createPinRecord(parsed.value.pin, pepper);
    this.room.authEpoch += 1;
    this.room.pin = nextPin;
    const ownerSession = auth.session;
    ownerSession.authEpoch = this.room.authEpoch;
    for (const [tokenHash, session] of Object.entries(this.room.sessions)) {
      if (tokenHash === auth.tokenHash) continue;
      this.removePresence(session.participantId, Date.now());
      delete this.room.sessions[tokenHash];
    }
    this.room.revision += 1;
    await this.persist();
    return jsonResponse({ ok: true });
  }

  async handleHeartbeat(request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const nowMs = Date.now();
    const participant = this.room.presence.participants[auth.session.participantId];
    if (participant) participant.lastSeenAtMs = nowMs;
    else if (this.joinPresence(auth.session, auth.tokenHash, nowMs) === null)
      return errorResponse('ROOM_FULL', 409);
    await this.persist();
    return jsonResponse({ snapshot: publicSnapshot(this.room, auth.session) });
  }

  async handleLeavePresence(request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    // The v1 client contract requires an awake snapshot's viewer to remain in
    // its presence list. When other peers remain, return the last internally
    // consistent departing snapshot while persisting the newer server state;
    // the caller is leaving and must not apply a phantom post-leave viewer.
    const departingSnapshot = publicSnapshot(this.room, auth.session);
    const hadOtherParticipants = Object.keys(this.room.presence.participants).length > 1;
    this.removePresence(auth.session.participantId, Date.now());
    await this.persist();
    return jsonResponse({
      snapshot: hadOtherParticipants ? departingSnapshot : publicSnapshot(this.room, auth.session),
    });
  }

  async handleSignalingTicket(request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    if (request.body && (request.headers.get('content-length') || '') !== '0')
      return errorResponse('INVALID_REQUEST', 400);
    const secret = String(this.env.PRO_SIGNALING_SECRET || '');
    if (secret.length < 32) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    const nowMs = Date.now();
    if (!this.room.presence.participants[auth.session.participantId]) {
      if (this.joinPresence(auth.session, auth.tokenHash, nowMs) === null)
        return errorResponse('ROOM_FULL', 409);
    }
    const role =
      this.room.presence.coordinatorParticipantId === auth.session.participantId
        ? 'coordinator'
        : 'member';
    const issuedAtSeconds = Math.floor(nowMs / 1000);
    const expiresAtSeconds = issuedAtSeconds + SIGNALING_TICKET_TTL_SECONDS;
    const expiresAtMs = expiresAtSeconds * 1000;
    const ticket = await createProSignalingTicket(
      {
        v: 1,
        kind: 'pro-signaling',
        roomCode: this.room.roomCode,
        participantId: auth.session.participantId,
        role,
        coordinatorEpoch: this.room.presence.coordinatorEpoch,
        jti: randomToken(18),
        iat: issuedAtSeconds,
        exp: expiresAtSeconds,
      },
      secret,
    );
    await this.persist();
    return jsonResponse({
      ticket,
      expiresAtMs,
      role,
      coordinatorEpoch: this.room.presence.coordinatorEpoch,
    });
  }

  readIdempotencyKey(request) {
    const key = request.headers.get('idempotency-key') || '';
    return IDEMPOTENCY_KEY_RE.test(key) ? key : null;
  }

  async idempotencyFingerprint(scope, body) {
    return sha256Base64Url(`${scope}\n${JSON.stringify(body)}`);
  }

  replayIdempotency(scope, key, fingerprint) {
    const record = this.room.idempotency[`${scope}:${key}`];
    if (!record) return null;
    if (!constantTimeEqual(record.fingerprint, fingerprint)) {
      return errorResponse('IDEMPOTENCY_CONFLICT', 409);
    }
    return jsonResponse(record.body, record.status);
  }

  storeIdempotency(
    scope,
    key,
    fingerprint,
    body,
    status = 200,
    expiresAtMs = Date.now() + IDEMPOTENCY_TTL_MS,
  ) {
    const records = this.room.idempotency;
    records[`${scope}:${key}`] = { fingerprint, body: structuredClone(body), status, expiresAtMs };
    const keys = Object.keys(records);
    if (keys.length > 256) {
      keys
        .sort((left, right) => records[left].expiresAtMs - records[right].expiresAtMs)
        .slice(0, keys.length - 256)
        .forEach((oldKey) => delete records[oldKey]);
    }
  }

  validatePlaylistAssets(playlist) {
    for (const item of playlist) {
      if (item.source.kind !== 'pro-r2') continue;
      const asset = this.room.assets[item.source.assetId];
      if (
        !asset ||
        asset.status !== 'ready' ||
        asset.version !== item.source.version ||
        asset.byteLength !== item.source.byteLength ||
        asset.mime !== item.source.mime ||
        (asset.sha256 || undefined) !== (item.source.sha256 || undefined)
      ) {
        return false;
      }
    }
    return true;
  }

  async handleUpdateSnapshot(request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const key = this.readIdempotencyKey(request);
    if (!key) return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400);
    const parsed = await this.parseBody(request, REQUEST_MAX_BYTES);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!hasExactKeys(body, ['baseRevision', 'playlist', 'currentQueueItemId', 'playback'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const scope = `participant:${auth.session.participantId}:snapshot`;
    const fingerprint = await this.idempotencyFingerprint(scope, body);
    const replay = this.replayIdempotency(scope, key, fingerprint);
    if (replay) return replay;
    if (!isSafeNonNegativeInteger(body.baseRevision)) return errorResponse('INVALID_REVISION', 400);
    if (body.baseRevision !== this.room.revision) {
      return jsonResponse(
        { error: 'REVISION_CONFLICT', snapshot: publicSnapshot(this.room, auth.session) },
        409,
      );
    }
    const playlist = parsePlaylist(body.playlist);
    if (!playlist) return errorResponse('INVALID_PLAYLIST', 400);
    const queueIds = new Set(playlist.map((item) => item.queueItemId));
    if (
      body.currentQueueItemId !== null &&
      (!QUEUE_ITEM_ID_RE.test(body.currentQueueItemId) || !queueIds.has(body.currentQueueItemId))
    ) {
      return errorResponse('INVALID_QUEUE_ITEM_ID', 400);
    }
    const playback = parsePlayback(
      body.playback,
      queueIds,
      body.currentQueueItemId,
      this.room.presence.coordinatorEpoch,
    );
    if (!playback || playback.revision < this.room.playback.revision) {
      return errorResponse('INVALID_PLAYBACK', 400);
    }
    if (!this.validatePlaylistAssets(playlist)) return errorResponse('ASSET_NOT_READY', 409);

    const playlistChanged = JSON.stringify(playlist) !== JSON.stringify(this.room.playlist);
    this.room.playlist = playlist;
    this.room.currentQueueItemId = body.currentQueueItemId;
    this.room.playback = playback;
    if (playlistChanged) this.room.playlistRevision += 1;
    this.room.revision += 1;
    const responseBody = { snapshot: publicSnapshot(this.room, auth.session) };
    this.storeIdempotency(scope, key, fingerprint, responseBody);
    await this.persist();
    return jsonResponse(responseBody);
  }

  async handleCreateReservation(request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const key = this.readIdempotencyKey(request);
    if (!key) return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400);
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (!hasExactKeys(body, ['byteLength', 'name', 'mime'], ['sha256'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const name = boundedString(body.name, MAX_MEDIA_NAME_LENGTH);
    if (
      !name ||
      !Number.isSafeInteger(body.byteLength) ||
      body.byteLength <= 0 ||
      body.byteLength > ASSET_MAX_BYTES ||
      typeof body.mime !== 'string' ||
      !MIME_RE.test(body.mime) ||
      (body.sha256 !== undefined &&
        (typeof body.sha256 !== 'string' || !SHA256_RE.test(body.sha256)))
    ) {
      return errorResponse('INVALID_MEDIA', 400);
    }
    const normalizedBody = {
      byteLength: body.byteLength,
      name,
      mime: body.mime,
      ...(body.sha256 === undefined ? {} : { sha256: body.sha256 }),
    };
    const scope = `participant:${auth.session.participantId}:reserve`;
    const fingerprint = await this.idempotencyFingerprint(scope, normalizedBody);
    const replay = this.replayIdempotency(scope, key, fingerprint);
    if (replay) return replay;
    if (!this.env.PRO_MEDIA_BUCKET || !r2S3Config(this.env)) {
      return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    }
    if (
      this.room.quota.usedBytes + this.room.quota.reservedBytes + body.byteLength >
      ROOM_QUOTA_BYTES
    ) {
      return errorResponse('ROOM_QUOTA_EXCEEDED', 409);
    }
    const nowMs = Date.now();
    const assetId = `asset_${randomToken(24)}`;
    const version = 1;
    const objectKey = `rooms/${this.room.roomCode}/assets/${assetId}/v${version}`;
    const expiresAtMs = nowMs + this.reservationTtlSeconds() * 1000;
    const uploadHeaders = {
      'content-type': body.mime,
      'x-amz-meta-mxqr-room': this.room.roomCode,
      'x-amz-meta-mxqr-asset': assetId,
      'x-amz-meta-mxqr-version': String(version),
      'x-amz-meta-mxqr-bytes': String(body.byteLength),
      ...(body.sha256 === undefined ? {} : { 'x-amz-meta-mxqr-sha256': body.sha256 }),
    };
    const presignTtl = Math.min(
      this.reservationTtlSeconds(),
      configuredNumber(this.env.PRESIGN_TTL_SECONDS, PRESIGN_TTL_SECONDS, 60, 3600),
    );
    const uploadUrl = await createR2PresignedUrl({
      env: this.env,
      method: 'PUT',
      objectKey,
      headers: uploadHeaders,
      expiresInSeconds: presignTtl,
      now: new Date(nowMs),
    });
    if (!uploadUrl) return errorResponse('MEDIA_NOT_CONFIGURED', 503);

    this.room.assets[assetId] = {
      status: 'reserved',
      assetId,
      version,
      objectKey,
      byteLength: body.byteLength,
      name,
      mime: body.mime,
      ...(body.sha256 === undefined ? {} : { sha256: body.sha256 }),
      createdAtMs: nowMs,
      expiresAtMs,
    };
    this.room.quota.reservedBytes += body.byteLength;
    this.room.revision += 1;
    const responseBody = {
      reservation: {
        assetId,
        version,
        byteLength: body.byteLength,
        expiresAtMs,
        upload: { method: 'PUT', url: uploadUrl, headers: uploadHeaders },
      },
      quota: { ...this.room.quota },
    };
    this.storeIdempotency(scope, key, fingerprint, responseBody, 200, expiresAtMs);
    await this.persist();
    return jsonResponse(responseBody);
  }

  async handleCompleteMedia(request, assetId) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const key = this.readIdempotencyKey(request);
    if (!key) return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400);
    if (!OPAQUE_ID_RE.test(assetId)) return errorResponse('INVALID_ASSET_ID', 400);
    if (request.body && (request.headers.get('content-length') || '') !== '0')
      return errorResponse('INVALID_REQUEST', 400);
    const scope = `participant:${auth.session.participantId}:complete`;
    const fingerprint = await this.idempotencyFingerprint(scope, { assetId });
    const replay = this.replayIdempotency(scope, key, fingerprint);
    if (replay) return replay;
    const asset = this.room.assets[assetId];
    if (!asset || asset.status !== 'reserved') return errorResponse('ASSET_NOT_FOUND', 404);
    if (!this.env.PRO_MEDIA_BUCKET) return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    let object;
    try {
      object = await this.env.PRO_MEDIA_BUCKET.head(asset.objectKey);
    } catch {
      return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
    }
    if (!object) return errorResponse('UPLOAD_INCOMPLETE', 409);
    const metadata = object.customMetadata || {};
    const contentType = object.httpMetadata?.contentType || '';
    const metadataMatches =
      metadata['mxqr-room'] === this.room.roomCode &&
      metadata['mxqr-asset'] === asset.assetId &&
      metadata['mxqr-version'] === String(asset.version) &&
      metadata['mxqr-bytes'] === String(asset.byteLength) &&
      (asset.sha256
        ? metadata['mxqr-sha256'] === asset.sha256
        : metadata['mxqr-sha256'] === undefined);
    if (object.size !== asset.byteLength || contentType !== asset.mime || !metadataMatches) {
      try {
        await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey);
      } catch {
        asset.expiresAtMs = Date.now() + 60_000;
        await this.persist();
        return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
      }
      this.room.quota.reservedBytes -= asset.byteLength;
      delete this.room.assets[assetId];
      this.room.revision += 1;
      await this.persist();
      return errorResponse('UPLOAD_MISMATCH', 409);
    }
    asset.status = 'ready';
    delete asset.expiresAtMs;
    asset.completedAtMs = Date.now();
    this.room.quota.reservedBytes -= asset.byteLength;
    this.room.quota.usedBytes += asset.byteLength;
    this.room.revision += 1;
    const responseBody = { asset: publicAsset(asset), quota: { ...this.room.quota } };
    this.storeIdempotency(scope, key, fingerprint, responseBody);
    await this.persist();
    return jsonResponse(responseBody);
  }

  async handleDownloadMedia(request, assetId) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    if (!OPAQUE_ID_RE.test(assetId)) return errorResponse('INVALID_ASSET_ID', 400);
    const asset = this.room.assets[assetId];
    if (!asset || asset.status !== 'ready') return errorResponse('ASSET_NOT_FOUND', 404);
    const nowMs = Date.now();
    const ttl = configuredNumber(this.env.PRESIGN_TTL_SECONDS, PRESIGN_TTL_SECONDS, 60, 3600);
    const url = await createR2PresignedUrl({
      env: this.env,
      method: 'GET',
      objectKey: asset.objectKey,
      expiresInSeconds: ttl,
      now: new Date(nowMs),
    });
    if (!url) return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    return jsonResponse({
      asset: publicAsset(asset),
      download: { url, expiresAtMs: nowMs + ttl * 1000 },
    });
  }

  async handleDeleteMedia(request, assetId) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const key = this.readIdempotencyKey(request);
    if (!key) return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400);
    if (!OPAQUE_ID_RE.test(assetId)) return errorResponse('INVALID_ASSET_ID', 400);
    if (request.body && (request.headers.get('content-length') || '') !== '0')
      return errorResponse('INVALID_REQUEST', 400);
    const scope = `participant:${auth.session.participantId}:delete`;
    const fingerprint = await this.idempotencyFingerprint(scope, { assetId });
    const replay = this.replayIdempotency(scope, key, fingerprint);
    if (replay) return replay;
    const asset = this.room.assets[assetId];
    if (!asset || asset.status !== 'ready') return errorResponse('ASSET_NOT_FOUND', 404);
    if (
      this.room.playlist.some(
        (item) => item.source.kind === 'pro-r2' && item.source.assetId === assetId,
      )
    ) {
      return errorResponse('ASSET_IN_USE', 409);
    }
    if (!this.env.PRO_MEDIA_BUCKET) return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    try {
      await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey);
    } catch {
      return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
    }
    this.room.quota.usedBytes -= asset.byteLength;
    delete this.room.assets[assetId];
    this.room.revision += 1;
    const responseBody = { ok: true, assetId, quota: { ...this.room.quota } };
    this.storeIdempotency(scope, key, fingerprint, responseBody);
    await this.persist();
    return jsonResponse(responseBody);
  }

  async prune(nowMs) {
    let changed = false;
    for (const [tokenHash, session] of Object.entries(this.room.sessions)) {
      if (session.expiresAtMs <= nowMs || session.authEpoch !== this.room.authEpoch) {
        changed = this.removePresence(session.participantId, nowMs) || changed;
        delete this.room.sessions[tokenHash];
        changed = true;
      }
    }
    for (const participant of Object.values(this.room.presence.participants)) {
      if (participant.lastSeenAtMs + this.presenceTtlMs() <= nowMs) {
        changed = this.removePresence(participant.participantId, nowMs) || changed;
      }
    }
    for (const [key, record] of Object.entries(this.room.idempotency)) {
      if (record.expiresAtMs <= nowMs) {
        delete this.room.idempotency[key];
        changed = true;
      }
    }
    for (const [assetId, asset] of Object.entries(this.room.assets)) {
      if (asset.status === 'reserved' && asset.expiresAtMs <= nowMs) {
        if (!this.env.PRO_MEDIA_BUCKET) {
          asset.expiresAtMs = nowMs + 60_000;
          changed = true;
          continue;
        }
        try {
          await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey);
        } catch {
          asset.expiresAtMs = nowMs + 60_000;
          changed = true;
          continue;
        }
        this.room.quota.reservedBytes -= asset.byteLength;
        delete this.room.assets[assetId];
        changed = true;
      }
    }
    for (const [key, value] of Object.entries(this.room.rateLimits)) {
      if (value.resetAtMs <= nowMs) delete this.room.rateLimits[key];
    }
    if (changed) await this.persist();
    return changed;
  }

  async alarm() {
    await this.withMutation(async () => {
      if (!this.room) this.room = (await this.storage.get(STORAGE_KEY)) || null;
      if (!this.room) return;
      await this.prune(Date.now());
      await this.scheduleAlarm();
    });
  }
}
